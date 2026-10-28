/**
 * @module github/publish-dedupe
 * @description The bounded GitHub-side dedupe scans the publisher runs before any
 *   create. Split out of `github/publish.ts` as the read-only lookup region: each
 *   scanner walks a hard-bounded number of pages through the forge client's
 *   `getPage` seam and returns a `DedupeLookup` that the publisher turns into a
 *   create / update / stay-retryable decision.
 *
 *   The safety property these carry is unchanged by the move: `absent` is a
 *   PROVEN negative from a fully-consumed, well-formed result set — only then is a
 *   create safe. A truncated scan or a malformed page/entry yields
 *   `indeterminate`, and the caller must refuse to create rather than risk a
 *   duplicate.
 *
 * @outputs
 *   - `DedupeLookup` -- the found / absent / indeterminate lookup outcome
 *   - `findMarkedComment` -- this job's marked comment, newest-first
 *   - `findMarkedIssue` -- an audit finding's issue by marker (open AND closed)
 *   - `findCheckRun` -- this job's check run for the SHA by `external_id`
 *
 * @dependencies
 *   - ../forge/boundary -- the bounded read seam (`getPage`, `provider`)
 *   - ../log -- the one logger, for the traced() wrapper
 */
import type { ForgeClient } from "../forge/boundary";
import { traced } from "../log";
import { isPositiveInteger, isRecord } from "./publish-decode";

/** Hard page bound for the newest-first comment dedupe scan. */
const COMMENT_DEDUPE_MAX_PAGES = 5;
/** Hard page bound for the object-shaped check-run dedupe scan. */
const CHECK_DEDUPE_MAX_PAGES = 10;
/** Hard page bound for the audit-issue marker scan (open + closed issues). */
const ISSUE_DEDUPE_MAX_PAGES = 10;

/**
 * A GitHub-side dedupe lookup outcome. `absent` is a *proven* negative from a
 * fully-consumed, well-formed result set — only then is a create safe. `found`
 * carries the existing id to reuse. `indeterminate` means the scan was truncated
 * or the response shape was invalid, so absence cannot be proven; the caller must
 * refuse to create and stay retryable rather than risk a duplicate.
 */
export type DedupeLookup =
	| { status: "found"; id: number }
	| { status: "absent" }
	| { status: "indeterminate"; reason: string };

/**
 * Look up this job's existing marked comment, newest-first, through a bounded
 * number of pages. A `found` result carries the id to PATCH; `absent` is proven
 * only when the scan reached the end of a well-formed result set; a truncated
 * scan (still a `next` page at the bound) or a malformed page body yields
 * `indeterminate` so the caller refuses to create rather than proving absence.
 */
export const findMarkedComment = traced(
	"github.findMarkedComment",
	async function findMarkedComment(
		client: ForgeClient,
		repository: string,
		itemNumber: number,
		dedupeKey: string,
	): Promise<DedupeLookup> {
		const marker = `<!-- ${dedupeKey} -->`;
		// Newest-first: the watcher's own marked comment, if present, is the most
		// recent write for this job, so it is found on the first page in the common case.
		let next: string | null =
			client.provider === "forgejo"
				? `/repos/${repository}/issues/${itemNumber}/comments?limit=50`
				: `/repos/${repository}/issues/${itemNumber}/comments?per_page=100&sort=created&direction=desc`;
		let pages = 0;
		while (next && pages < COMMENT_DEDUPE_MAX_PAGES) {
			const page: { body: unknown; next: string | null } = await client.getPage<unknown>(next);
			if (!Array.isArray(page.body)) {
				// A successful read whose body is not the expected array (empty/malformed
				// on a 200) cannot prove absence — treat it as indeterminate, not empty.
				return { status: "indeterminate", reason: "comment list body was not an array" };
			}
			const found = scanCommentPage(page.body, marker);
			if (found !== null) {
				return found;
			}
			if (client.provider === "forgejo" && page.next !== null) {
				// Forgejo reports X-Total-Count for this endpoint but does not
				// document a page parameter. A short first response therefore proves
				// only incompleteness, never absence; refuse a duplicate-prone create.
				return {
					status: "indeterminate",
					reason: "comment count exceeds the non-pageable returned set",
				};
			}
			next = page.next;
			pages++;
		}
		if (next) {
			// Hit the page bound with more pages remaining: the scan is truncated, so
			// an older marked comment could exist beyond it. Absence is unproven.
			return { status: "indeterminate", reason: "comment scan truncated at page bound" };
		}
		return { status: "absent" };
	},
);

/**
 * Scan one comment-list page for the marker. Returns the terminal lookup when
 * this page settles the question (a match, or a malformed entry that makes
 * absence unprovable), or `null` when the page was well-formed and carried no
 * match so the caller should continue to the next page.
 *
 * Extracted from `findMarkedComment` purely to keep the loop within the function
 * ceiling; the per-entry rules are unchanged.
 */
function scanCommentPage(body: unknown[], marker: string): DedupeLookup | null {
	for (const c of body as Array<{ id?: unknown; body?: unknown }>) {
		// Every entry must have the required shape (a positive-integer id and a
		// string body). A malformed entry could itself be the marked comment with
		// an unreadable field, so it makes absence indeterminate — we must never
		// skip it and then create, which could duplicate. Refuse and stay retryable.
		if (!isPositiveInteger(c.id) || typeof c.body !== "string") {
			return { status: "indeterminate", reason: "comment entry had an invalid shape" };
		}
		if (c.body.includes(marker)) {
			return { status: "found", id: c.id };
		}
	}
	return null;
}

/**
 * Look up an audit finding's existing issue by its hidden marker across the
 * repository's issues — OPEN and CLOSED — newest-first, through a bounded number
 * of pages. A `found` result carries the issue number to PATCH; `absent` is
 * proven only when a well-formed result set was fully consumed; a truncated scan
 * (still a `next` page at the bound) or a malformed page/entry yields
 * `indeterminate` so the caller refuses to open a duplicate.
 *
 * Closed issues are scanned deliberately: a finding whose issue a fixer PR
 * already closed must NOT be re-opened as a fresh issue — its marker is found on
 * the closed issue, so the finding dedupes onto it rather than duplicating.
 * `/issues` returns pull requests too; entries carrying a `pull_request` field
 * are skipped (a watcher audit issue is never a PR).
 *
 * `openOnly` scans OPEN issues only, for a class whose closed issue
 * means "handled" and must not swallow the next incident.
 */
export const findMarkedIssue = traced(
	"github.findMarkedIssue",
	async function findMarkedIssue(
		client: ForgeClient,
		repository: string,
		dedupeKey: string,
		options: { openOnly?: boolean } = {},
	): Promise<DedupeLookup> {
		const marker = `<!-- ${dedupeKey} -->`;
		const state = options.openOnly === true ? "open" : "all";
		let next: string | null =
			client.provider === "forgejo"
				? `/repos/${repository}/issues?state=${state}&type=issues&limit=50&page=1`
				: `/repos/${repository}/issues?state=${state}&per_page=100&sort=created&direction=desc`;
		let pages = 0;
		while (next && pages < ISSUE_DEDUPE_MAX_PAGES) {
			const page: { body: unknown; next: string | null } = await client.getPage<unknown>(next);
			if (!Array.isArray(page.body)) {
				return { status: "indeterminate", reason: "issue list body was not an array" };
			}
			const found = scanIssuePage(page.body, marker);
			if (found !== null) {
				return found;
			}
			next = page.next;
			pages++;
		}
		if (next) {
			return { status: "indeterminate", reason: "issue scan truncated at page bound" };
		}
		return { status: "absent" };
	},
);

/**
 * Scan one issue-list page for the marker. Returns the terminal lookup when this
 * page settles the question (a match, or a malformed entry that makes absence
 * unprovable), or `null` when the page was well-formed and carried no match so
 * the caller should continue to the next page.
 *
 * Extracted from `findMarkedIssue` purely to keep the loop within the nesting
 * ceiling; the per-entry rules are unchanged.
 */
function scanIssuePage(body: unknown[], marker: string): DedupeLookup | null {
	for (const issue of body as Array<{
		number?: unknown;
		body?: unknown;
		pull_request?: unknown;
	}>) {
		// A pull request surfaced by /issues is never a watcher audit issue; skip it
		// without letting its shape make the scan indeterminate. Only a non-null
		// object marks a PR: Forgejo sends `pull_request: null` on every issue.
		if (typeof issue.pull_request === "object" && issue.pull_request !== null) {
			continue;
		}
		// Every issue entry must carry a positive-integer number. A malformed
		// number could itself be the marked issue with an unreadable field, so it
		// makes absence indeterminate — never skip-then-open.
		if (!isPositiveInteger(issue.number)) {
			return { status: "indeterminate", reason: "issue entry had an invalid shape" };
		}
		// GitHub returns `body: null` for an issue with an EMPTY body (and may omit
		// it entirely). That is a legitimate "no marker here", NOT a malformed shape:
		// treat null/undefined as the empty string so a bodyless issue can never make
		// EVERY scan indeterminate (which would block opening any audit issue). Only a
		// genuinely wrong-typed body (a number/object) stays indeterminate.
		const body_ = issue.body === null || issue.body === undefined ? "" : issue.body;
		if (typeof body_ !== "string") {
			return { status: "indeterminate", reason: "issue entry had an invalid shape" };
		}
		if (body_.includes(marker)) {
			return { status: "found", id: issue.number };
		}
	}
	return null;
}

/**
 * Look up this job's existing check run for the SHA by `external_id`. Uses
 * `filter=all` + `per_page=100` and follows the object-shaped (`{ total_count,
 * check_runs }`) response's `Link` pagination to a hard page bound. `absent` is
 * proven only when every page was well-formed and fully consumed; a truncated
 * scan or a page whose shape is invalid yields `indeterminate` so the caller
 * refuses to create.
 */
/** Arguments for {@link findCheckRun}. */
export type FindCheckRunArgs = {
	client: ForgeClient;
	repository: string;
	sha: string;
	checkName: string;
	dedupeKey: string;
};

export const findCheckRun = traced(
	"github.findCheckRun",
	async function findCheckRun({
		client,
		repository,
		sha,
		checkName,
		dedupeKey,
	}: FindCheckRunArgs): Promise<DedupeLookup> {
		let next: string | null =
			`/repos/${repository}/commits/${sha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=all&per_page=100`;
		let pages = 0;
		while (next && pages < CHECK_DEDUPE_MAX_PAGES) {
			const page: { body: unknown; next: string | null } = await client.getPage<unknown>(next);
			if (!isRecord(page.body) || !Array.isArray(page.body.check_runs)) {
				// A 200 whose body is not the documented `{ check_runs: [...] }` object
				// cannot prove absence — treat it as indeterminate, never as empty.
				return { status: "indeterminate", reason: "check-runs body shape was invalid" };
			}
			for (const run of page.body.check_runs as Array<{ id?: unknown; external_id?: unknown }>) {
				// GitHub documents `external_id` as nullable. Null is a valid non-match;
				// another type or an invalid id makes absence indeterminate because the
				// entry could be this job's own unreadable check run.
				if (
					!isPositiveInteger(run.id) ||
					(run.external_id !== null && typeof run.external_id !== "string")
				) {
					return { status: "indeterminate", reason: "check-run entry had an invalid shape" };
				}
				if (run.external_id === dedupeKey) {
					return { status: "found", id: run.id };
				}
			}
			next = page.next;
			pages++;
		}
		if (next) {
			return { status: "indeterminate", reason: "check-run scan truncated at page bound" };
		}
		return { status: "absent" };
	},
);
