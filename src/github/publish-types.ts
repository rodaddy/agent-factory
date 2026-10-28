/**
 * @module github/publish-types
 * @description Shared boundary types and tuning constants for the GitHub posting
 *   reconciler: the per-pass counters, the publisher's construction options, the
 *   locked-row shape, and the retry/backoff bounds. Split out of
 *   `github/publish.ts` so the orchestrator and the write/decode modules can all
 *   depend on one type surface without an import cycle.
 *
 * @outputs
 *   - `PublishSummary` -- per-pass counters
 *   - `GitHubPublisherOptions` -- publisher construction options
 *   - `PublishRow` -- a locked posting row joined to its authoritative target
 *   - `MAX_POSTINGS_PER_PASS` / `MAX_POSTING_ATTEMPTS` / `POSTING_BACKOFF_MS` /
 *     `MAX_POSTING_BACKOFF_MS` -- the bounds the reconciler clamps to
 */
import type { TriageAllowlistResolver } from "../results/store";

/** Default cap on rows published per pass. */
export const MAX_POSTINGS_PER_PASS = 200;
/** Retry budget: after this many failed attempts a row is marked `failed`. */
export const MAX_POSTING_ATTEMPTS = 5;
/** Base backoff (ms) between posting retries; grows with the attempt count. */
export const POSTING_BACKOFF_MS = 30_000;
/** Hard ceiling (ms) on any single posting-retry backoff, regardless of config. */
export const MAX_POSTING_BACKOFF_MS = 60_000;

export interface PublishSummary {
	scanned: number;
	posted: number;
	deduped: number;
	failed: number;
	retryable: number;
	skipped: number;
	/**
	 * Job ids that had an intended write RECORDED to the shadow ledger this pass
	 * (shadow mode only; empty in real mode). Bounded by `maxPerPass` and carrying
	 * only integers, so it stays log-safe. The one-shot `reconcile once --shadow`
	 * path uses it to scope the operator-facing compare report to exactly the jobs
	 * this pass would have written.
	 */
	shadowJobIds: number[];
}

export interface GitHubPublisherOptions {
	maxPerPass?: number;
	maxAttempts?: number;
	backoffMs?: number;
	now?: () => Date;
	onError?: (error: Error) => void;
	/** Test seam invoked after the posting row lock is held and eligibility rechecked. */
	onRowLocked?: (id: number) => Promise<void>;
	/**
	 * Shadow mode. When true, the publisher runs the FULL pipeline — selection,
	 * row locking, eligibility, target authorization, and the GitHub-side dedupe
	 * READS — but at the write boundary it records the intended write into the
	 * `shadow_publications` ledger INSTEAD of calling the GitHub write APIs. No
	 * label/comment/check is ever POSTed or PATCHed. Dedupe semantics are
	 * preserved: an indeterminate dedupe scan still fails-retryable exactly as the
	 * real path would, so shadow mode never records a would-post it could not prove.
	 */
	shadow?: boolean;
	/**
	 * Resolve a repository's config-declared issue-triage label allowlist (
	 * #124) at PUBLISH time. Threaded so the decoder can re-validate a stored
	 * triage add-label plan against the repository's CURRENT trusted vocabulary —
	 * exactly as `DbResultStore` filters at plan-creation time. A publisher built
	 * WITHOUT a resolver fails every triage label plan closed (never posts), and a
	 * label no longer in the allowlist at publish time fails its plan terminally.
	 * The resolver reads only trusted config keyed by the DB-joined repository and
	 * job type; nothing runner-writable participates.
	 */
	triageAllowlistFor?: TriageAllowlistResolver;
}

/** A locked posting row joined to its authoritative target and item facts. */
export interface PublishRow {
	id: number;
	jobId: number;
	kind: string;
	action: string;
	target: string;
	payload: string;
	dedupeKey: string;
	attempts: number;
	status: string;
	nextAttemptAt: Date | null;
	provider: string;
	repository: string;
	itemNumber: number | null;
	itemKind: string | null;
	itemState: string | null;
	itemHeadSha: string | null;
	sha: string;
	jobType: string;
}
