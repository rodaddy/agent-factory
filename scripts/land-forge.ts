/**
 * @module scripts/land-forge
 * @description The forge boundary the `land` verb writes through, and
 *   its default Forgejo adapter.
 *
 *   `land` takes this interface INJECTED, so the landing sequence is driven end
 *   to end by a fake and never opens a socket. Four methods, each addressing a
 *   repository by the `owner/name` slug the preflight derived from the
 *   worktree's own origin — never from the process working directory.
 *
 *   The adapter lives here rather than in `land.ts` for two reasons: it is the
 *   only code in the verb that holds a credential, and keeping it separate keeps
 *   the sequence module under the repo's per-file ceiling. Nothing in this
 *   module logs, prints, or returns the token; it reaches the client
 *   constructor and stops there.
 */

import { createForgejoClient } from "../src/forgejo/client";
import type { FetchLike } from "../src/forgejo/client";

/** The pull request to open: head branch, base, and the body already read. */
export interface CreatePullRequest {
	readonly head: string;
	readonly base: string;
	readonly title: string;
	readonly body: string;
}

/**
 * The forge operations the landing sequence needs, and nothing else. A merge
 * refusal is a RESULT rather than an exception — "not mergeable" is an ordinary
 * state the sequence stops on, and a caller that had to tell it from a network
 * fault through a try/catch would get that distinction wrong.
 */
export interface LandForge {
	/** The repository's default branch, the base every landing targets. */
	getDefaultBranch(slug: string): Promise<string>;
	createPullRequest(slug: string, pr: CreatePullRequest): Promise<{ number: number; url: string }>;
	mergePullRequest(
		slug: string,
		number: number,
	): Promise<{ merged: true; sha: string } | { merged: false; reason: string }>;
	getPullRequestMergeState(
		slug: string,
		number: number,
	): Promise<{ merged: boolean; mergeCommitSha: string | null }>;
	getIssueState(slug: string, number: number): Promise<{ state: string }>;
}

/** The fields the adapter reads off a created pull request. */
interface RawCreatedPull {
	number?: unknown;
	html_url?: unknown;
}

/** The one field the adapter reads off a repository. */
interface RawRepository {
	default_branch?: unknown;
}

/**
 * One Forgejo owner or repository segment: the characters Forgejo itself allows
 * (alphanumerics, dot, dash, underscore), starting and ending alphanumeric,
 * never `.` or `..`, and none of the URL separators (`?`, `#`, `%`) that
 * would let a crafted origin address a different API path than the slug it
 * prints (PR #690 rounds 1 and 6). The ONE rule, shared with `parseOriginSlug`
 * in `land.ts`, so the adapter refuses exactly what the parser refuses.
 */
export const SLUG_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

/** The slug, or a throw naming the shape it failed — never a request. */
function checkedSlug(slug: string): string {
	const parts = slug.split("/");
	if (parts.length !== 2 || !parts.every((segment) => SLUG_SEGMENT.test(segment))) {
		throw new Error("refusing a malformed repository slug: expected exactly owner/name");
	}
	return slug;
}

/**
 * The API URL the token is sent to: derived from the
 * clone base unless `FORGEJO_API_URL` names one, and either way HTTPS on the
 * clone base's exact host and port, with no embedded credentials. A URL on any
 * other host would push to one forge and open the PR on another; plain HTTP
 * would put the token on the wire in the clear. The refusal never echoes the
 * value, which may carry userinfo.
 */
export function approvedApiUrl(
	cloneBase: string,
	apiUrl: string | undefined,
): { ok: true; url: string } | { ok: false; error: string } {
	let base: URL;
	let api: URL;
	try {
		base = new URL(cloneBase);
		api = new URL(apiUrl ?? `${cloneBase.replace(/\/+$/, "")}/api/v1`);
	} catch {
		return { ok: false, error: "FORGEJO_API_URL or FORGEJO_CLONE_BASE is not an absolute URL" };
	}
	if (base.protocol !== "https:" || api.protocol !== "https:") {
		return { ok: false, error: "FORGEJO_API_URL and FORGEJO_CLONE_BASE must be HTTPS" };
	}
	if (api.username !== "" || api.password !== "") {
		return { ok: false, error: "FORGEJO_API_URL must not carry credentials" };
	}
	if (api.host !== base.host) {
		return {
			ok: false,
			error: `FORGEJO_API_URL must be on the clone base's host (${base.host}), got ${api.host}`,
		};
	}
	return { ok: true, url: api.toString().replace(/\/+$/, "") };
}

/** The one field the adapter reads off an issue. */
interface RawIssue {
	state?: unknown;
}

/**
 * The default adapter: the five operations over a bounded Forgejo client.
 *
 * Every response field is shape-checked rather than trusted. A create whose body
 * carries no integer number would otherwise produce a merge addressed to `NaN`,
 * and a state field that is not a string would compare unequal to `closed` for
 * the wrong reason — the verb must fail on the missing field, naming it, not on
 * a coincidence downstream.
 */
export function forgejoLandForge(
	token: string,
	apiUrl: string,
	options: { fetch?: FetchLike } = {},
): LandForge {
	// The CLI has already pinned the URL to the clone base's host; this guard
	// is the adapter's own floor, so no other caller can hand the token to a
	// plaintext endpoint.
	if (!apiUrl.startsWith("https://")) {
		throw new Error("land-forge: the API URL must be HTTPS; refusing to send the token");
	}
	// The transport is injectable so the adapter's paths, payloads, headers and
	// response mapping are tested against a fetch fake (PR #690 review round 2 P2).
	const client = createForgejoClient(token, { baseUrl: apiUrl, fetch: options.fetch });
	// Every operation passes the slug through ONE check (PR #690 rounds 1 and
	// 4): exactly owner/name, each segment from the character class Forgejo
	// accepts, so a segment can never be read as a separator or a traversal even
	// if parseOriginSlug's validation is bypassed. The two operations that hand
	// the slug to the client rather than building the path here go through the
	// same check, so no endpoint receives a slug the others would refuse.
	const repoPath = (slug: string) => `/repos/${checkedSlug(slug)}`;
	return {
		async getDefaultBranch(slug) {
			const response = await client.get<RawRepository>(repoPath(slug));
			const branch = response.data?.default_branch;
			if (typeof branch !== "string" || branch.length === 0) {
				throw new Error(`the forge returned no default branch for ${slug}`);
			}
			return branch;
		},

		async createPullRequest(slug, pr) {
			const response = await client.write<RawCreatedPull>("POST", `${repoPath(slug)}/pulls`, {
				head: pr.head,
				base: pr.base,
				title: pr.title,
				body: pr.body,
			});
			const number = response.data?.number;
			const url = response.data?.html_url;
			if (typeof number !== "number" || !Number.isInteger(number)) {
				throw new Error(`the forge returned no pull-request number for ${slug}`);
			}
			// A create with no usable link is refused here too,
			// so the verb never sees a landing it cannot name.
			if (typeof url !== "string" || !isHttpsUrl(url)) {
				throw new Error(`the forge returned no pull-request URL for ${slug}#${number}`);
			}
			return { number, url };
		},

		async mergePullRequest(slug, number) {
			// The client already returns the typed outcome, including a refusal
			// classified from the forge's own 405/409. Only the refusal shape is
			// mapped, so the verb's boundary carries one reason string.
			const result = await client.mergePullRequest(checkedSlug(slug), number);
			if (result.merged) return { merged: true, sha: result.sha };
			return { merged: false, reason: result.reason };
		},

		async getPullRequestMergeState(slug, number) {
			return await client.getPullRequestMergeState(checkedSlug(slug), number);
		},

		async getIssueState(slug, number) {
			const response = await client.get<RawIssue>(`${repoPath(slug)}/issues/${number}`);
			const state = response.data?.state;
			return { state: typeof state === "string" ? state : "" };
		},
	};
}

/** True for an absolute https URL, the only shape a PR link is accepted in. */
function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}
