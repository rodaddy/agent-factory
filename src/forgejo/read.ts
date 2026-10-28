/**
 * @module forgejo/read
 * @description Incremental, cursor-aware reads of changed Forgejo items for one
 *   repository, mirroring the GitHub reader's contract (`readChangedIssues`) but
 *   speaking Forgejo's `/api/v1` wire shape and its X-Total-Count pagination. The
 *   durable `reconciliation_cursors` value is the `since` watermark, and the next
 *   cursor is returned for the caller to persist ONLY after a fully successful
 *   read — a failed or TRUNCATED read never advances the cursor.
 *
 *   Forgejo 16 paginates with `page` + `limit` and reports the complete filtered
 *   collection size in `X-Total-Count`. This reader traverses the count-derived
 *   next URLs from the client, capping each request at `limit=50` and the whole
 *   scan at a hard page bound. Missing/invalid counts, malformed pages, count
 *   mismatches, and a remaining page at the bound all FAIL CLOSED (throw).
 *
 * @outputs
 *   - `readChangedForgejoIssues` -- fetch Forgejo issues/PRs updated since a cursor
 *
 * @dependencies
 *   - ../forge/boundary -- the narrow forge contract (getPage) the read drives
 *   - ../forgejo/client -- count-derived Forgejo page traversal
 *   - ../github/read -- the shared NormalizedItem / ReadResult shapes
 */
import type { ForgeClient, ForgePage } from "../forge/boundary";
import type { NormalizedItem, ReadResult } from "../github/read";
import { traced } from "../log";

/** Per-request page size for the Forgejo issue read. Capped at 50 by contract. */
const FORGEJO_PAGE_LIMIT = 50;

/** Hard ceiling on pages traversed in one incremental read (fail closed at it). */
const MAX_PAGES = 50;

/** Raw Forgejo issue shape (the issues endpoint returns PRs too). */
interface RawForgejoIssue {
	number: number;
	state: string;
	title: string;
	updated_at: string;
	labels?: Array<{ name?: unknown } | string> | null;
	/** Present (non-null) only when the entry is a pull request. */
	pull_request?: unknown;
}

/** Raw Forgejo pull-request shape for the head SHA. */
interface RawForgejoPull {
	head?: { sha?: unknown };
}

/** Normalize Forgejo label entries (objects or bare strings) to names. */
function labelNames(labels: RawForgejoIssue["labels"]): string[] {
	if (!Array.isArray(labels)) {
		return [];
	}
	const names: string[] = [];
	for (const label of labels) {
		if (typeof label === "string") {
			names.push(label);
		} else if (label && typeof label.name === "string") {
			names.push(label.name);
		}
	}
	return names;
}

/** True when a raw entry has the minimal fields the reader trusts. */
function isValidIssue(entry: unknown): entry is RawForgejoIssue {
	if (typeof entry !== "object" || entry === null) {
		return false;
	}
	const e = entry as Record<string, unknown>;
	return (
		typeof e.number === "number" &&
		Number.isInteger(e.number) &&
		typeof e.state === "string" &&
		typeof e.title === "string" &&
		typeof e.updated_at === "string"
	);
}

/**
 * Read Forgejo issues and pull requests updated since `cursor` for `owner/repo`.
 *
 * The Forgejo issues endpoint returns both issues and PRs; entries with a
 * non-null `pull_request` are PRs, and their head SHA is fetched from the pulls
 * endpoint. Pagination is traversed through the client's fail-closed `getPage`
 * with a per-request `limit=50` and a hard page bound. A page that is malformed,
 * a scan that stops with pages still remaining, or a count that cannot prove
 * completeness all THROW — a truncated read must never advance the cursor.
 *
 * @param client - the Forgejo forge client
 * @param fullName - `owner/repo`
 * @param cursor - prior watermark (ISO-8601) or null for a first read
 * @param now - current time as ISO-8601, injected for deterministic tests
 */
export const readChangedForgejoIssues = traced(
	"forgejo.readChangedForgejoIssues",
	async function readChangedForgejoIssues(
		client: ForgeClient,
		fullName: string,
		cursor: string | null,
		now: string,
	): Promise<ReadResult> {
		const raw = await readAllIssuePages(client, fullName, cursor);

		const items: NormalizedItem[] = [];
		let newest = cursor;
		for (const issue of raw) {
			const isPull = issue.pull_request !== undefined && issue.pull_request !== null;
			let headSha: string | null = null;
			if (isPull) {
				const pull = await client.get<RawForgejoPull>(`/repos/${fullName}/pulls/${issue.number}`);
				const sha = pull.data.head?.sha;
				headSha = typeof sha === "string" && sha.length > 0 ? sha : null;
			}
			items.push({
				kind: isPull ? "pull" : "issue",
				number: issue.number,
				state: issue.state,
				title: issue.title,
				headSha,
				updatedAt: issue.updated_at,
				labels: labelNames(issue.labels),
			});
			if (newest === null || issue.updated_at > newest) {
				newest = issue.updated_at;
			}
		}

		// Nothing changed keeps the prior cursor; a first-ever empty read anchors at
		// `now`, matching the GitHub reader's watermark semantics.
		const nextCursor = newest ?? now;
		return { items, nextCursor };
	},
);

/**
 * Walk every issue page from the cursor, validating each entry's shape.
 *
 * FAILS CLOSED twice over: an entry that is not a well-formed issue THROWS
 * rather than being skipped (a silently dropped item would let the cursor
 * advance past work nobody saw), and exhausting the page bound with pages still
 * remaining throws rather than returning a partial read as if it were complete.
 */
async function readAllIssuePages(
	client: ForgeClient,
	fullName: string,
	cursor: string | null,
): Promise<RawForgejoIssue[]> {
	const sinceParam = cursor ? `&since=${encodeURIComponent(cursor)}` : "";
	// Forgejo's provider-correct least-update ordering keeps the cursor traversal
	// monotonic without sending GitHub-only direction/per_page parameters.
	let next: string | null =
		`/repos/${fullName}/issues?state=all&sort=leastupdate` +
		`&limit=${FORGEJO_PAGE_LIMIT}&page=1${sinceParam}`;

	const raw: RawForgejoIssue[] = [];
	let pages = 0;
	while (next && pages < MAX_PAGES) {
		const page: ForgePage<unknown> = await client.getPage<unknown>(next);
		if (!Array.isArray(page.body)) {
			throw new Error("Forgejo issue read: page body was not an array");
		}
		for (const entry of page.body) {
			if (!isValidIssue(entry)) {
				throw new Error("Forgejo issue read: issue entry had an invalid shape");
			}
			raw.push(entry);
		}
		next = page.next;
		pages++;
	}
	if (next) {
		throw new Error("Forgejo issue read: page bound reached with pages remaining");
	}
	return raw;
}
