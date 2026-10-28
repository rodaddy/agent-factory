/**
 * @module enroll/resolve
 * @description Map one deployed container image to its Forge source repo and
 *   tag family for `enroll --derive` (lane 831b). Given the image string
 *   a planner row carries (e.g. `10.0.20.58:3000/rtech/web-ops:v0.1.5`), look
 *   the repo up on Forge, read its tags, and name the tag family whose version
 *   shape matches the image tag -- or refuse with one of the three reasons the
 *   fleet inventory (791a) found in practice:
 *
 *   - `no-repo` -- the image is not `<host>/<owner>/<name>`, or Forge answers
 *     404 for that repo (e.g. `rtech/press`).
 *   - `no-tags` -- the repo exists but carries zero tags (browser-pool).
 *   - `stream-mismatch` -- tags exist but none has the image tag's shape
 *     (documenso: image `v2.17.0-sign.1`, tags only `v2.17.0`).
 *
 *   A renamed repo answers `/repos/<old>` with a 301 that fetch follows, so the
 *   canonical name is always the body's `full_name`, never the image path.
 *
 *   A transport or non-404 failure THROWS: it is unknown, not a refusal, and
 *   must never read as "no repo" or "no tags".
 *
 * @outputs
 *   - `ResolveResult` -- found {repo, tagFamily, latestTag} or refused {reason, detail}
 *   - `parseImage` -- split an image ref into owner, name, and tag
 *   - `tagShape` -- a tag's version part with every digit run replaced by `N`
 *   - `resolveSource` -- the resolver over an injected FetchText seam
 *
 * @dependencies
 *   - ../hostedapp/fetch -- the FetchText read seam and the default API base
 *   - ../forgejo/tags -- listForgejoTags, driven through a read-only adapter
 *   - ../log -- the traced() wrapper
 */
import type { ForgeClient } from "../forge/boundary";
import { listForgejoTags } from "../forgejo/tags";
import { DEFAULT_FORGE_API, type FetchText } from "../hostedapp/fetch";
import { traced } from "../log";

export type RefusalReason = "no-repo" | "no-tags" | "stream-mismatch";

export type ResolveResult =
	| { status: "found"; repo: string; tagFamily: string; latestTag: string }
	| { status: "refused"; reason: RefusalReason; detail: string };

/** A tag split at its version: `<prefix>v<version>`; the prefix may be empty. */
const TAG_PARTS = /^(.*?)v(\d+(?:\.\d+)*.*)$/;

/**
 * Split an image ref into owner, name, and tag. The first segment must be a
 * registry host (it carries a `.` or `:`); a digest suffix is dropped.
 *
 * @param image - the image ref, verbatim from a manifest
 * @returns owner/name/tag (tag null when untagged), or null when not `<host>/<owner>/<name>`
 */
export const parseImage = traced("enroll.parseImage", function parseImage(image: string): {
	owner: string;
	name: string;
	tag: string | null;
} | null {
	const ref = image.split("@")[0] ?? "";
	const segments = ref.split("/");
	if (segments.length !== 3 || !/[.:]/.test(segments[0] ?? "")) return null;
	const [owner, last] = [segments[1] ?? "", segments[2] ?? ""];
	const colon = last.indexOf(":");
	const name = colon === -1 ? last : last.slice(0, colon);
	const tag = colon === -1 ? null : last.slice(colon + 1);
	if (owner === "" || name === "") return null;
	return { owner, name, tag: tag === "" ? null : tag };
});

/**
 * The shape of a version: `v` plus the version text with each digit run as `N`,
 * so `v0.1.5` and `web-ops-v0.2.0` share the shape `vN.N.N` while
 * `v2.17.0-sign.1` is `vN.N.N-sign.N`.
 *
 * @param tag - a tag or image tag
 * @returns the family prefix and the version shape, or null when no `v<digit>` version is present
 */
export const tagShape = traced("enroll.tagShape", function tagShape(tag: string): {
	prefix: string;
	shape: string;
} | null {
	const match = TAG_PARTS.exec(tag);
	if (match === null) return null;
	return { prefix: match[1] ?? "", shape: `v${(match[2] ?? "").replace(/\d+/g, "N")}` };
});

/** Only `get` is driven; the other verbs are never reached from a tag read. */
function readOnlyClient(fetchText: FetchText, token: string, api: string): ForgeClient {
	const refuse = (): never => {
		throw new Error("enroll resolver client is read-only");
	};
	return {
		provider: "forgejo",
		async get<T>(path: string) {
			const result = await fetchText(`${api}${path}`, token);
			if (!result.ok) {
				return { status: result.status, data: null as T, link: null, rateRemaining: null };
			}
			return { status: 200, data: JSON.parse(result.text) as T, link: null, rateRemaining: null };
		},
		getPage: refuse,
		paginate: refuse,
		write: refuse,
		postCommitCheck: refuse,
		findCommitCheck: refuse,
	} as ForgeClient;
}

/** Look a repo up: its canonical `full_name`, a no-repo refusal on 404, or a throw. */
async function lookupRepo(
	fetchText: FetchText,
	token: string,
	base: string,
	path: string,
): Promise<string | ResolveResult> {
	const looked = await fetchText(`${base}/repos/${path}`, token);
	if (!looked.ok) {
		if (looked.status === 404) {
			return { status: "refused", reason: "no-repo", detail: `${path} not found on Forge` };
		}
		throw new Error(`repo lookup ${path} failed: ${looked.error}`);
	}
	// After a 301 the body is the renamed repo, so full_name is the canonical name.
	const repo = (JSON.parse(looked.text) as { full_name?: unknown }).full_name;
	if (typeof repo !== "string" || repo === "") {
		throw new Error(`repo lookup ${path} returned no full_name`);
	}
	return repo;
}

/**
 * Pick the tag family whose version shape matches the image tag. Families keep
 * listing order (newest-first); one carrying the image tag's exact version wins.
 */
function pickFamily(repo: string, tags: string[], imageTag: string | null): ResolveResult {
	const imageShape = imageTag === null ? null : tagShape(imageTag);
	if (imageTag === null || imageShape === null) {
		return { status: "refused", reason: "stream-mismatch", detail: "image tag has no version" };
	}
	const families = new Map<string, string[]>();
	for (const tag of tags) {
		const shape = tagShape(tag);
		if (shape === null || shape.shape !== imageShape.shape) continue;
		families.set(shape.prefix, [...(families.get(shape.prefix) ?? []), tag]);
	}
	const entries = [...families.entries()];
	const version = imageTag.slice(imageShape.prefix.length);
	const chosen = entries.find(([p, n]) => n.includes(`${p}${version}`)) ?? entries[0];
	if (chosen === undefined) {
		return {
			status: "refused",
			reason: "stream-mismatch",
			detail: `${repo} has no ${imageShape.shape} tag for image tag ${imageTag}`,
		};
	}
	const [prefix, names] = chosen;
	return {
		status: "found",
		repo,
		tagFamily: `${prefix}${imageShape.shape}`,
		latestTag: names[0] ?? "",
	};
}

/**
 * Resolve an image to its Forge source repo and tag family.
 *
 * @param fetchText - the injected read seam (live: forgeFetchText)
 * @param token - the Forge token, passed through to fetchText
 * @param image - the image ref from a planner row
 * @param api - the Forge API base, trailing slashes ignored
 * @returns found with the canonical repo, the family pattern (`<prefix>vN.N.N`),
 *   and its newest tag; or refused with a reason and a one-line detail
 * @throws when a Forge read fails for any reason other than a 404
 */
async function resolveSourceImpl(
	fetchText: FetchText,
	token: string,
	image: string,
	api: string = DEFAULT_FORGE_API,
): Promise<ResolveResult> {
	const base = api.replace(/\/+$/, "");
	const parsed = parseImage(image);
	if (parsed === null) {
		return {
			status: "refused",
			reason: "no-repo",
			detail: `not a <host>/<owner>/<name> image: ${image}`,
		};
	}
	const repo = await lookupRepo(fetchText, token, base, `${parsed.owner}/${parsed.name}`);
	if (typeof repo !== "string") return repo;
	const tags = await listForgejoTags(readOnlyClient(fetchText, token, base), repo);
	if (tags === null) throw new Error(`tag read for ${repo} failed`);
	if (tags.length === 0) {
		return { status: "refused", reason: "no-tags", detail: `${repo} has no tags` };
	}
	return pickFamily(
		repo,
		tags.map((t) => t.name),
		parsed.tag,
	);
}

/** The traced export; the body is resolveSourceImpl above (documented there). */
export const resolveSource = traced("enroll.resolveSource", resolveSourceImpl, {
	// Arg 0 is the fetch seam (a closure that may hold a client); arg 1 is the bare token.
	redact: { args: [0, 1] },
});
