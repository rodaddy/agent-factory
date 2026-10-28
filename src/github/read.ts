/**
 * @module github/read
 * @description Incremental, cursor-aware reads of changed GitHub items for one
 *   repository. Uses the durable `reconciliation_cursors` value as the `since`
 *   watermark so a pass reads only what changed, and returns the next cursor
 *   for the caller to persist ONLY after a fully successful pass — a failed
 *   read never advances the cursor. Items are normalized to the shape the
 *   watcher stores; commit head and check state come from the PR payload.
 *
 * @outputs
 *   - `readChangedIssues` -- fetch issues/PRs updated since the cursor
 *   - `NormalizedItem` -- the normalized issue/PR shape
 *   - `ReadResult` -- items plus the next cursor to persist on success
 *
 * @dependencies
 *   - ../forge/boundary -- the narrow forge client (shared read verbs)
 *   - ../log -- the one logger, for the traced() wrapper
 */
import type { ForgeClient } from "../forge/boundary";
import { traced } from "../log";

/** Normalized issue or pull request as the watcher records it. */
export interface NormalizedItem {
	kind: "issue" | "pull";
	number: number;
	state: string;
	title: string;
	/** Head commit SHA for pull requests; null for issues. */
	headSha: string | null;
	/** GitHub's `updated_at`, ISO-8601. */
	updatedAt: string;
	labels: string[];
}

/** Result of an incremental read: items and the cursor to persist on success. */
export interface ReadResult {
	items: NormalizedItem[];
	/** Watermark to store only if the whole pass succeeded. */
	nextCursor: string;
}

/** Raw GitHub issue shape (issues endpoint returns PRs too). */
interface RawIssue {
	number: number;
	state: string;
	title: string;
	updated_at: string;
	labels: Array<{ name: string } | string>;
	pull_request?: { url: string };
}

/** Raw pull-request shape for the head SHA. */
interface RawPull {
	head?: { sha?: string };
}

function labelNames(labels: RawIssue["labels"]): string[] {
	return labels.map((l) => (typeof l === "string" ? l : l.name));
}

/**
 * Read issues and pull requests updated since `cursor` for `owner/repo`.
 *
 * The GitHub issues endpoint returns both issues and PRs; entries with a
 * `pull_request` field are PRs, and their head SHA is fetched from the pulls
 * endpoint. The returned `nextCursor` is the newest `updated_at` seen (or the
 * prior cursor when nothing changed) and must be persisted only on success.
 *
 * @param client - read-only forge client (GitHub)
 * @param fullName - `owner/repo`
 * @param cursor - prior watermark (ISO-8601) or null for a first read
 * @param now - current time as ISO-8601, injected for deterministic tests
 */
export const readChangedIssues = traced(
	"github.readChangedIssues",
	async function readChangedIssues(
		client: ForgeClient,
		fullName: string,
		cursor: string | null,
		now: string,
	): Promise<ReadResult> {
		const sinceParam = cursor ? `&since=${encodeURIComponent(cursor)}` : "";
		const path = `/repos/${fullName}/issues?state=all&sort=updated&direction=asc&per_page=100${sinceParam}`;

		const raw = await client.paginate<RawIssue>(path);

		const items: NormalizedItem[] = [];
		let newest = cursor;

		for (const issue of raw) {
			const isPull = issue.pull_request !== undefined;
			let headSha: string | null = null;
			if (isPull) {
				const pull = await client.get<RawPull>(`/repos/${fullName}/pulls/${issue.number}`);
				headSha = pull.data.head?.sha ?? null;
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

		// When nothing changed, keep the prior cursor; on a first-ever empty read,
		// anchor at `now` so the next pass has a stable watermark.
		const nextCursor = newest ?? now;
		return { items, nextCursor };
	},
	{ redact: { args: [0] } },
);
