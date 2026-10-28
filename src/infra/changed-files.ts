/**
 * @module infra/changed-files
 * @description A bounded, boundary-validated reader of a candidate's changed file
 *   PATHS for the rtech-infra static-gate selector, bound to the EXACT
 *   IMMUTABLE pinned SHA. It reads the GitHub COMPARE endpoint
 *   (`/repos/{repo}/compare/{base}...{sha}`) through the read-only `GitHubClient`,
 *   so the change set describes exactly `base..pinnedSHA` — the immutable commit
 *   the runner validates — and can NOT drift with the mutable PR head. A push
 *   after dispatch changes the PR head but not this pinned-SHA compare, so it can
 *   never narrow the gates selected for a pinned job (HIGH-2 / TOCTOU).
 *
 *   It extracts ONLY the `filename` field of each entry (never patch/contents/blob
 *   text), and enforces a hard count cap and a per-path length cap at the
 *   boundary. Repository content is untrusted input; this module treats it as
 *   such — it never returns file contents and never lets any read shape reach the
 *   gate selector as an instruction.
 *
 *   Compare shape note (HIGH-2b). The authoritative GitHub REST contract for
 *   "Compare two commits" (GET /repos/{owner}/{repo}/compare/{basehead}) returns
 *   the changed `files` array ONLY on the FIRST page, capped at 300 files for the
 *   ENTIRE comparison. That array is NOT paginated by the `page` param and carries
 *   NO rel=next Link header and NO total_files field: for changesets larger than
 *   300 files the API simply OMITS the remainder with no next link. So this reader
 *   does a SINGLE first-page read of the `files` array — it does NOT follow a
 *   Link-next loop (which would be wrong here and would read a truncated array as
 *   complete, silently NARROWING gates). It validates the body is an object
 *   carrying an array `files` and reads only each entry's `filename`.
 *
 *   Fail-closed translation. A read that cannot be trusted to be COMPLETE and
 *   well-formed — a returned `files` array at or beyond the documented 300-file
 *   cap (possibly truncated, no way to fetch the remainder), a missing/unreachable
 *   base or SHA (404/ambiguous), any API or network error, a non-object body, a
 *   missing or non-array `files`, or a malformed entry — is translated into an
 *   explicit `indeterminate` result, NOT a throw. The gate selector maps
 *   `indeterminate` to a full escalation, so an ambiguous read can only ever WIDEN
 *   the checks that run, never narrow them. No raw error escapes into the
 *   reconciliation pass.
 *
 *   Forgejo PR reads use `pulls/{n}` and paginated `pulls/{n}/files` instead:
 *   distinct current filenames must equal changed_files and every exposed
 *   X-Total-Count. The head SHA is checked before and after pagination; rename
 *   source paths are added only after counting current filenames. Without a PR
 *   number, Forgejo compare completeness remains unproven and fails closed.
 *
 * @outputs
 *   - `COMPARE_FILES_CAP` -- the documented 300-file first-page cap (>= is truncated)
 *   - `MAX_PATH_LENGTH` -- the per-path length cap (over-length => indeterminate)
 *   - `ChangedFilesResult` -- `{ paths, indeterminate, reason }`, always bounded
 *   - `isExactSha` -- strict lowercase-hex SHA validator (shared with select.ts)
 *   - `readChangedFilesForSha` -- read a pinned SHA's base..sha changed paths,
 *     fail-closed to indeterminate
 *
 * @dependencies
 *   - ../github/client -- the read-only, bounded REST client (injectable)
 */
import type { ForgeClient } from "../forge/boundary";
import type { Provider } from "../forge/provider";
import { readForgejoChangedFiles } from "./forgejo-changed-files";
import { errorClass, log, traced } from "../log";

/**
 * The documented first-page cap on the compare `files` array. The GitHub compare
 * endpoint returns at most 300 changed files for the ENTIRE comparison and does
 * NOT paginate that array (no `page`, no rel=next, no total_files). A returned
 * array whose length is at or beyond this cap MUST be treated as possibly
 * truncated — there is no way to fetch the remainder — hence indeterminate.
 */
export const COMPARE_FILES_CAP = 300;

/** Hard per-path length cap. A longer path is a malformed/hostile entry. */
export const MAX_PATH_LENGTH = 1024;

/** The bounded, log-safe result of a changed-files read. */
export interface ChangedFilesResult {
	/** The changed file paths, bounded in count and per-path length. */
	paths: string[];
	/** True when the read could not be trusted complete; forces full escalation. */
	indeterminate: boolean;
	/** A fixed, bounded, secret-free reason for the outcome. */
	reason: string;
}

/** Only the one field the selector needs. Patch/blob/status are deliberately ignored. */
interface RawCompareFile {
	filename?: unknown;
}

/** The compare endpoint returns an OBJECT carrying a first-page `files` array. */
interface RawCompareBody {
	files?: unknown;
}

/**
 * The exact-SHA shape the compare binding requires: strict lowercase hex, 40–64
 * chars. Shared with `select.ts` so the base-SHA-only fail-closed check there and
 * the pinned-SHA check here validate identically.
 */
export const isExactSha = traced("infra.isExactSha", function isExactSha(value: string): boolean {
	return /^[0-9a-f]{40,64}$/.test(value);
});

/**
 * A base ref accepted for the compare left side. It is either an exact SHA (the
 * immutable `base.sha`, preferred) or a conservative branch-name shape. It must
 * never carry `..`, path traversal, or query/anchor characters that could reshape
 * the compare target — an indeterminate/hostile base fails the caller closed.
 * NOTE (HIGH-2a): `select.ts` now only ever passes a strict-hex `base.sha`; the
 * branch-name arm is retained here purely as defense-in-depth.
 */
function isSafeBaseRef(value: string): boolean {
	if (isExactSha(value)) {
		return true;
	}
	// Conservative branch-name charset: no `..`, no slashes-into-traversal, no
	// query/anchor/spacing characters. GitHub refs allow `/` (e.g. `release/1.2`).
	if (value.length === 0 || value.length > MAX_PATH_LENGTH) {
		return false;
	}
	if (value.includes("..")) {
		return false;
	}
	return /^[A-Za-z0-9._/-]+$/.test(value);
}

/** Produce the fail-closed indeterminate result with a fixed reason. */
function indeterminate(reason: string): ChangedFilesResult {
	return { paths: [], indeterminate: true, reason };
}

/**
 * Read the changed file PATHS of the EXACT `base..sha` range through the compare
 * endpoint, boundary-validated and fail-closed. `repository` is `owner/repo`
 * (already validated upstream), `base` is the PR base ref (an immutable base SHA
 * or a conservative branch name), and `sha` is the job's exact pinned SHA. Because
 * the compare left..right is pinned to that immutable SHA, the change set can NOT
 * change if the PR head advances after dispatch — closing the head-match TOCTOU.
 *
 * The read is a SINGLE first-page read of the compare `files` array (HIGH-2b): the
 * compare endpoint does NOT paginate that array and caps it at 300 files for the
 * whole comparison, so there is no Link-next loop to follow — following one would
 * read a truncated 300-file array as complete and silently NARROW the gates. If
 * the returned array length reaches the documented `COMPARE_FILES_CAP` (300) it is
 * possibly truncated with no way to fetch the remainder — the read returns
 * `indeterminate` (truncated) rather than a partial path list. Any non-object
 * body, missing/non-array `files`, malformed entry, over-length path, empty set,
 * unreachable/ambiguous base or SHA (404), or API/network error likewise returns
 * `indeterminate`. Only `filename` is read; no patch, blob, or content field is
 * ever touched, so no repository file content flows out of this boundary.
 *
 * @param client - the read-only GitHub client
 * @param repository - `owner/repo`
 * @param base - the PR base ref (immutable base SHA or a conservative branch name)
 * @param sha - the job's exact pinned SHA (compare right side)
 */
/** Arguments for {@link readChangedFilesForSha}. */
export type ReadChangedFilesForShaArgs = {
	client: ForgeClient;
	repository: string;
	base: string;
	sha: string;
	provider?: Provider;
	/** PR identity from the trusted event/dispatch; absent for pushes. */
	pullNumber?: number;
};

export const readChangedFilesForSha = traced(
	"infra.readChangedFilesForSha",
	async function readChangedFilesForSha({
		client,
		repository,
		base,
		sha,
		provider = "github",
		pullNumber,
	}: ReadChangedFilesForShaArgs): Promise<ChangedFilesResult> {
		if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
			return indeterminate("changed-files read: invalid repository identity");
		}
		if (!isExactSha(sha)) {
			return indeterminate("changed-files read: invalid pinned SHA");
		}
		if (!isSafeBaseRef(base)) {
			return indeterminate("changed-files read: invalid base ref");
		}

		if (provider === "forgejo" && pullNumber !== undefined) {
			return readForgejoChangedFiles({ client, repository, sha, base, pullNumber });
		}

		const files = await readCompareFiles({ client, repository, base, sha, provider });
		if (!Array.isArray(files)) {
			return files;
		}

		const paths = extractPaths(files);
		if (!Array.isArray(paths)) {
			return paths;
		}

		if (paths.length === 0) {
			// A range with no readable changed files is itself indeterminate: the
			// selector treats an empty set as a full escalation, and so does this reader.
			return indeterminate("changed-files read: no changed files resolved");
		}

		// Without a PR identity, compare alone carries no completeness proof.
		if (provider === "forgejo") {
			return indeterminate("changed-files read: Forgejo compare completeness is unproven");
		}

		return {
			paths,
			indeterminate: false,
			reason: `changed-files read: ${paths.length} path(s) resolved`,
		};
	},
);

/**
 * SINGLE first-page compare read. The compare `files` array is returned in full
 * only on the first page and is NOT paginated by GitHub; it is capped at 300
 * files for the entire comparison with no next link. We must NOT follow a
 * Link-next loop.
 *
 * Returns the raw `files` array, or an `indeterminate` result the caller
 * forwards unchanged. Every failure is indeterminate rather than an empty set,
 * because indeterminate escalates to the FULL gate set while an empty set would
 * silently narrow it.
 */
async function readCompareFiles(args: {
	client: ForgeClient;
	repository: string;
	base: string;
	sha: string;
	provider: Provider;
}): Promise<unknown[] | ChangedFilesResult> {
	const { client, repository, base, sha, provider } = args;
	const path = `/repos/${repository}/compare/${base}...${sha}`;
	let page: { body: unknown; next: string | null };
	try {
		page = await client.getPage<unknown>(path);
	} catch (err) {
		// Any API/network error (including an unreachable/ambiguous base or SHA,
		// i.e. 404) is translated to indeterminate; a raw error must never reach
		// the reconcile pass. Indeterminate escalates to the full gate set, so a
		// persistent read fault looks like ordinary behaviour unless it is recorded.
		// Class only — a client error can quote the Authorization header.
		log("warn", "infra.changed_files.read_failed", {
			repository,
			base,
			sha,
			provider,
			error_class: errorClass(err),
		});
		return indeterminate("changed-files read: API or network error");
	}

	const body = page.body;
	if (body === null || typeof body !== "object" || Array.isArray(body)) {
		// The compare endpoint returns an OBJECT (never a top-level array); a
		// non-object or array body is not the shape we trust.
		return indeterminate("changed-files read: unexpected non-object body");
	}
	const files = (body as RawCompareBody).files;
	if (!Array.isArray(files)) {
		return indeterminate("changed-files read: missing or non-array files");
	}

	// The documented 300-file cap is a TRUNCATION boundary, not a page boundary:
	// at or beyond it the array may be incomplete and there is NO way to fetch the
	// remainder, so the set is indeterminate => full escalation. Never narrow from
	// a possibly-truncated set.
	if (provider === "github" && files.length >= COMPARE_FILES_CAP) {
		return indeterminate("changed-files read: compare files at 300-cap (possibly truncated)");
	}

	return files;
}

/**
 * Pull the bounded filename out of every compare entry. A malformed entry or an
 * out-of-bounds path length is indeterminate for the WHOLE read — never a
 * partial set, which would narrow the gates on incomplete evidence.
 */
function extractPaths(files: readonly unknown[]): string[] | ChangedFilesResult {
	const paths: string[] = [];
	for (const entry of files as RawCompareFile[]) {
		if (entry === null || typeof entry !== "object" || typeof entry.filename !== "string") {
			return indeterminate("changed-files read: malformed file entry");
		}
		const filename = entry.filename;
		if (filename.length === 0 || filename.length > MAX_PATH_LENGTH) {
			return indeterminate("changed-files read: path length out of bounds");
		}
		paths.push(filename);
	}
	return paths;
}
