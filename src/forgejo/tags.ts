/**
 * @module forgejo/tags
 * @description Read one repository's newest tags from Forgejo for build-bump
 *   intake. This is the TRUSTED re-read: a webhook payload is never the
 *   input to a candidate, so a spoofed or replayed delivery cannot introduce a
 *   tag the forge does not actually carry.
 *
 *   THE ANNOTATED-TAG TRAP. A Forgejo tag entry carries BOTH `id` — the tag
 *   OBJECT's sha — and `commit.sha`, the sha of the commit the tag resolves to.
 *   For a lightweight tag the two coincide; for an ANNOTATED tag they differ, and
 *   the tag object's sha is not something any later lane can check out or build.
 *   This reader maps `commit.sha` and never `id`.
 *
 *   BOUNDED BY DESIGN. Exactly ONE page of at most 50 tags is fetched. Forgejo
 *   returns tags newest-first, and intake is only ever interested in tags that
 *   have just appeared, so an older tag falling off page one is out of intake's
 *   scope rather than a truncation to fail closed on.
 *
 *   THE LIST IS NOT THE MARKER PATH. That page bound is right for the VERSION
 *   stream, whose newest tags are the whole of intake's interest, and WRONG for
 *   a marker, which is NAMED. A marker is a movable tag whose commit can be
 *   arbitrarily old, so on a repository with more than 50 tags it sits on page
 *   two and absence-from-the-page reads identically to absence-from-the-forge —
 *   which would delete a live marker row every pass. Markers therefore resolve
 *   through `readForgejoTag`, a lookup BY NAME that cannot be affected by how
 *   many tags the repository carries.
 *
 *   FAILS CLOSED WITHOUT THROWING. A non-200, a network error, or a body that
 *   does not match the expected shape all return `null` — the caller SKIPS that
 *   repository for the pass. Returning an empty array instead would be
 *   indistinguishable from "this repository genuinely has no tags", which is the
 *   one thing a failed read must not be allowed to look like.
 *
 * @outputs
 *   - `ForgejoTag` -- one tag's bare name, the COMMIT sha it resolves to, and
 *     the commit's date when the forge sent a parsable one
 *   - `listForgejoTags` -- read page one of a repository's tags, or null
 *   - `readForgejoTag` -- resolve ONE tag by name: the tag, "absent", or null
 *
 * @dependencies
 *   - zod -- boundary validation of the untrusted response body
 *   - ../forge/boundary -- the narrow forge contract (get) the read drives
 *   - ../log -- the shared traced() build-phase wrapper
 */
import { z } from "zod";
import type { ForgeClient } from "../forge/boundary";
import { errorMessage, log, traced } from "../log";

/** Per-request page size. One page only; see the module docstring. */
const FORGEJO_TAG_PAGE_LIMIT = 50;

/**
 * The response shape at the boundary. Only the two fields intake reads are
 * required; every other field Forgejo sends is ignored rather than refused, so a
 * forge upgrade that ADDS a field does not break the read.
 */
const tagResponseSchema = z.object({
	name: z.string().min(1),
	// The COMMIT sha, never the sibling `id` (the tag object's own sha).
	commit: z.object({
		sha: z.string().min(1),
		// The commit's date. UNTYPED at the boundary on purpose: this field is
		// DEGRADABLE, so `null`, `""`, or a number must degrade THAT TAG's date to
		// absent rather than invalidate the whole list (or the named read) and
		// block the repository's intake every pass. `parseCommitDate` is
		// the one place the value is judged.
		created: z.unknown().optional(),
	}),
});

/** The list endpoint's shape: the same entry, repeated. */
const tagsResponseSchema = z.array(tagResponseSchema);

/** One observed tag: its bare name and the COMMIT sha it resolves to. */
export interface ForgejoTag {
	name: string;
	/** `commit.sha` — never the tag object's `id`. */
	commitSha: string;
	/**
	 * The tag's COMMIT DATE (`commit.created`), which is the only honest recency
	 * order downstream. Absent when the forge omitted the field or sent
	 * something unparsable: absence means "unknown", never "old".
	 */
	commitCreatedAt?: Date;
}

/**
 * Parse a forge commit date. Returns `undefined` for absent input, for `null`,
 * for anything that is not a non-empty string, and for a string `Date` cannot
 * make sense of — junk DEGRADES the one field rather than producing an
 * `Invalid Date`, which would compare and serialize as garbage everywhere
 * downstream, and rather than failing the read that carried it.
 */
function parseCommitDate(value: unknown): Date | undefined {
	if (typeof value !== "string" || value === "") return undefined;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? undefined : parsed;
}

/**
 * Read the newest page of `owner/repo`'s tags.
 *
 * @param client - the Forgejo forge client (same seam the issue reader uses, so
 *   the token and API base come from the one existing credential path)
 * @param fullName - `owner/repo`
 * @returns the page's tags, or `null` when the read failed or was malformed
 */
export const listForgejoTags = traced(
	"forgejo.listForgejoTags",
	async function listForgejoTags(
		client: ForgeClient,
		fullName: string,
	): Promise<ForgejoTag[] | null> {
		let body: unknown;
		try {
			const response = await client.get<unknown>(
				`/repos/${fullName}/tags?page=1&limit=${FORGEJO_TAG_PAGE_LIMIT}`,
			);
			// The BOUNDARY TYPE's allowed path, not the deployed one: the production
			// ForgejoClient throws ForgejoHttpError on any non-2xx (see attemptRequest
			// in src/forgejo/client.ts), so a real non-200 lands in the catch below.
			if (response.status !== 200) {
				log("warn", "forgejo.tags.read_failed", {
					repository: fullName,
					status: response.status,
				});
				return null;
			}
			body = response.data;
		} catch (error) {
			// The client already bounds and redacts its own error text.
			log("warn", "forgejo.tags.read_failed", {
				repository: fullName,
				cause: errorMessage(error),
			});
			return null;
		}

		const parsed = tagsResponseSchema.safeParse(body);
		if (!parsed.success) {
			log("warn", "forgejo.tags.invalid_shape", { repository: fullName });
			return null;
		}
		return parsed.data.map(toForgejoTag);
	},
);

/**
 * Map one parsed entry onto a `ForgejoTag`. Shared by the list and the named
 * read so a marker's sha and date are produced by exactly the same code the
 * version stream is — including the annotated-tag rule (`commit.sha`, never
 * `id`).
 */
function toForgejoTag(tag: z.infer<typeof tagResponseSchema>): ForgejoTag {
	const commitCreatedAt = parseCommitDate(tag.commit.created);
	// The key is OMITTED rather than set to undefined when there is no date, so
	// a row's insert carries no column for it at all.
	return commitCreatedAt === undefined
		? { name: tag.name, commitSha: tag.commit.sha }
		: { name: tag.name, commitSha: tag.commit.sha, commitCreatedAt };
}

/**
 * Read ONE tag of `owner/repo` BY NAME.
 *
 * The marker path (see the module docstring). Unlike the list, this cannot be
 * defeated by a repository carrying more tags than one page holds, which is the
 * whole reason it exists: a marker is named, and a named thing is looked up.
 *
 * The three outcomes are deliberately distinct, because a marker's row is
 * DELETED on one of them and must not be deleted on the other:
 *   - a `ForgejoTag` — the forge carries this tag, at this commit;
 *   - `"absent"` — the forge answered 404: the tag genuinely is not there;
 *   - `null` — the read FAILED (any other status, a network error, or a body
 *     that does not parse). Unknown, never "absent".
 *
 * @param client - the Forgejo forge client (the same seam the list read uses)
 * @param fullName - `owner/repo`
 * @param name - the bare tag name, URL-encoded here rather than by the caller
 * @returns the tag, `"absent"` on a 404, or `null` on a failed/malformed read
 */
export const readForgejoTag = traced(
	"forgejo.readForgejoTag",
	async function readForgejoTag(
		client: ForgeClient,
		fullName: string,
		name: string,
	): Promise<ForgejoTag | "absent" | null> {
		let body: unknown;
		try {
			const response = await client.get<unknown>(
				`/repos/${fullName}/tags/${encodeURIComponent(name)}`,
			);
			// The BOUNDARY TYPE's allowed path. The deployed ForgejoClient throws on
			// any non-2xx instead (attemptRequest in src/forgejo/client.ts), so the
			// real 404 lands in the catch below — both paths are handled.
			if (response.status === 404) {
				return "absent";
			}
			if (response.status !== 200) {
				log("warn", "forgejo.tag.read_failed", {
					repository: fullName,
					tag: name,
					status: response.status,
				});
				return null;
			}
			body = response.data;
		} catch (error) {
			const message = errorMessage(error);
			// The deployed client flattens its ForgejoHttpError into this message, so
			// the status is only available as text. A 404 here is the SAME "the forge
			// does not carry this tag" answer as the boundary-type path above; reading
			// it as a failure instead would strand a deleted marker's row forever.
			if (message.includes("HTTP 404")) {
				return "absent";
			}
			// The client already bounds and redacts its own error text.
			log("warn", "forgejo.tag.read_failed", {
				repository: fullName,
				tag: name,
				cause: message,
			});
			return null;
		}

		const parsed = tagResponseSchema.safeParse(body);
		if (!parsed.success) {
			log("warn", "forgejo.tag.invalid_shape", { repository: fullName, tag: name });
			return null;
		}
		return toForgejoTag(parsed.data);
	},
);
