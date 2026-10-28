// Types for sweep.js (plain ESM, injected fetch so tests need no network).
import type {
	MergeHead,
	PullRequestEvent,
	ReviewEntry,
	ReviewIssue,
	TriageIssue,
} from "./logic.js";
import type { ChangedFile } from "./preflight.js";
import type { RicoAskIssue } from "./rico-asks.js";

export interface SweepDeps {
	admitReview?: ReviewOnceDeps["admitReview"];
	fetch: (url: string, init?: RequestInit) => Promise<Response>;
	baseUrl: string;
	token: string;
	repos: string[];
	now: () => number;
	stateGet: (key: string) => Promise<unknown>;
	stateSet: (key: string, value: unknown) => Promise<void>;
	/**
	 * repo is the task's <owner>/<repo>, which names its board project; an owner ask has none.
	 * null: the repo has no project, the task is not filed and the next pass retries.
	 */
	createTask: (
		task: ReviewIssue | TriageIssue | RicoAskIssue,
		repo?: string,
	) => Promise<{ id: string } | null>;
	/** The PR's (repo, number) board issues whose title starts with query (the review-round count). */
	listTitles: (query: string, repo?: string, number?: number) => Promise<ReviewEntry[]>;
	cfg: { reviewerAgentId: string; triageAgentId: string; boardUserId?: string };
	log: (line: string) => void;
	/** Subset of the plugin SDK approvals client; absent means no stale cleanup. */
	approvals?: {
		list(input: { companyId: string; status?: string | null }): Promise<unknown[]>;
		decide(
			approvalId: string,
			input: { action: "approve" | "reject"; actorUserId?: string; decisionNote?: string | null },
			companyId: string,
		): Promise<unknown>;
	};
	companyId?: string;
	/** Board agent id by Forge login; with approvals and companyId it turns on the owner-ask filing. */
	findAgent?: (login: string) => Promise<string | null>;
	agentName?: (id: string | null) => Promise<string | null>;
	/** Both present: the sweep settles the open tasks of merged/closed PRs. */
	listOpenTasks?: () => Promise<Array<{ id: string; title?: string; status?: string }>>;
	settleTask?: (
		id: string,
		patch: { status: "done" | "cancelled"; comment: string },
	) => Promise<void>;
	/** Passed to reviewPrOnce: the checks settle; the sweep counts each read. */
	checksOf?: ReviewOnceDeps["checksOf"];
	listIssues?: ReviewOnceDeps["listIssues"];
	cancelTask?: ReviewOnceDeps["cancelTask"];
	/** The repo's tier, 0-5; absent means tier 5, which the sweep skips. */
	repoTier?: (repo: string) => Promise<number>;
	/** Turn on the mechanical preflight; the sweep reads PR files on its own counted path. */
	preflight?: boolean;
	/** With listIssues and findAgent, turns on the Merge task filing. */
	listComments?: MergeTaskDeps["listComments"];
}
/** Board comments as the plugin reads them: author seat, body, time. */
export interface BoardComment {
	id: string;
	authorAgentId?: string | null;
	body: string;
	createdAt?: string;
}
export interface MergeTaskDeps {
	companyId?: string;
	stateGet: (key: string) => Promise<unknown>;
	stateSet: (key: string, value: unknown) => Promise<void>;
	listIssues?: (
		query: string,
		repo?: string,
		number?: number,
	) => Promise<Array<{ id: string; title: string; status: string }>>;
	listComments?: (issueId: string) => Promise<BoardComment[]>;
	findAgent?: (login: string) => Promise<string | null>;
	createTask: (task: ReviewIssue, repo?: string) => Promise<{ id: string }>;
	log: (line: string) => void;
}
/** Most Merge tasks one sweep tick files. */
export const MERGE_CAP: number;
/** Files the missing Merge task for each approved head, once per head, at most MERGE_CAP; returns how many. */
export function fileMergeTasks(deps: MergeTaskDeps, heads: MergeHead[]): Promise<number>;
/** PR reads per sweep pass for the settle step. */
export const MAX_SETTLE_READS: number;
/** The PR a `Review|Merge <o/r>#<n> @ ` or `Rework <o/r>#<n>:` title names, else null. */
export function settleTarget(title: unknown): { repo: string; number: number } | null;
/**
 * Merged PR -> done, closed -> cancelled, open or failed read -> left; returns the count settled.
 * With stateGet/stateSet each pass resumes where the last stopped, so the read bound rotates.
 */
export function settleFinishedTasks(
	deps: Pick<SweepDeps, "fetch" | "baseUrl" | "token" | "repos" | "log"> &
		Required<Pick<SweepDeps, "listOpenTasks" | "settleTask">> &
		Partial<Pick<SweepDeps, "stateGet" | "stateSet">>,
	counter?: { calls: number },
): Promise<number>;
export interface ApprovalTarget {
	repo: string;
	number: number;
	sha: string;
}
export function approvalTarget(approval: unknown): ApprovalTarget | null;
/** True only for a `request_board_approval` titled `Go on <owner/repo>#<n> at <sha>`. */
export function isMergeApproval(approval: unknown): boolean;
export interface SweepResult {
	repos: number;
	prs: number;
	issues: number;
	created: number;
	calls: number;
	stale: number;
	stopped: boolean;
	took: number;
}
export function runSweep(deps: SweepDeps): Promise<SweepResult>;
/** One Forge GET; throws (with .reason, the status) on a failed call or non-2xx. */
export function getJson(
	deps: Pick<SweepDeps, "fetch" | "baseUrl" | "token">,
	counter: { calls: number },
	path: string,
): Promise<unknown>;
export interface RoundLimitDeps {
	listTitles: (query: string, repo?: string, number?: number) => Promise<ReviewEntry[]>;
	postComment: (repo: string, number: number, body: string) => Promise<void>;
	stateGet: (key: string) => Promise<unknown>;
	stateSet: (key: string, value: unknown) => Promise<void>;
	log: (line: string) => void;
	/** Kick-back (all absent: the @-mention in the comment is the only kick-back). */
	findAgent?: (login: string) => Promise<string | null>;
	findLinkedTask?: (event: PullRequestEvent, agentId: string) => Promise<{ id: string } | null>;
	reopenTask?: (
		id: string,
		patch: { status: "todo"; assigneeAgentId: string; comment: string },
	) => Promise<void>;
	/** Forge: add the author to the PR assignees, add a label by name. */
	assignPr?: (repo: string, number: number, login: string) => Promise<void>;
	addLabel?: (repo: string, number: number, name: string) => Promise<void>;
	createTask?: (task: ReviewIssue | TriageIssue, repo?: string) => Promise<{ id: string } | null>;
}
export const ROUND_LIMIT_LABEL: string;
export type ForgeCall = (method: string, path: string, body?: unknown) => Promise<unknown>;
/** Adds login to the PR assignees, keeping existing ones; no-op when already assigned. */
export function forgeAssign(
	call: ForgeCall,
	repo: string,
	number: number,
	login: string,
): Promise<void>;
/** Adds a label by name; throws (reason "label-missing") when the answer lacks it. */
export function forgeLabel(
	call: ForgeCall,
	repo: string,
	number: number,
	name: string,
): Promise<void>;
/** Past the two review rounds, once per head posts the limit warning and kicks the work back to its author; review still goes on. */
export function warnRoundLimit(
	deps: RoundLimitDeps,
	event: PullRequestEvent,
	entries?: ReviewEntry[],
): Promise<void>;
/** True when the head only merges the base into a reviewed head; any failed read is false. */
export function baseMergeHead(
	call: ForgeCall,
	event: PullRequestEvent,
	reviewed: string[],
): Promise<boolean>;
/** Runs fn with no other holder of key in this worker process (webhook and sweep share it). */
export function withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T>;
export interface ReviewOnceDeps extends RoundLimitDeps {
	admitReview?: (event: PullRequestEvent, prior?: unknown) => Promise<unknown>;
	companyId?: string;
	createTask: (task: ReviewIssue | TriageIssue, repo?: string) => Promise<{ id: string } | null>;
	/** scriptedNonCode: the non-code fast path runs only when true. pairReview: with seatsOf, a new head gets the reviewer pair. codeOnlyReview: each pair task lists the docs to skip. */
	cfg: {
		reviewerAgentId: string;
		triageAgentId: string;
		scriptedNonCode?: boolean;
		pairReview?: boolean;
		codeOnlyReview?: boolean;
	};
	/** Queued+running runs per board agent id: the pair's least-loaded seat. */
	seatLoad?: () => Promise<Map<string, number>>;
	/** Board agent by Forge login; absent means pairReview is off. */
	seatsOf?: () => Promise<
		Map<
			string,
			{
				id: string;
				status?: string;
				adapterType?: string;
				adapterConfig?: { model?: string; thinking?: string };
			}
		>
	>;
	/**
	 * True while the earlier review is still open; enables the reopen recheck.
	 * recorded is the dedupe state of that review ({ issueId }).
	 */
	openTaskExists?: (task: ReviewIssue | TriageIssue, recorded: unknown) => Promise<boolean>;
	/** True marks the review task BASE_MERGE_LINE: reviewed, not a round. */
	isBaseMerge?: (event: PullRequestEvent, reviewedSha7s: string[]) => Promise<boolean>;
	/**
	 * Checks settle: the head's Forge combined status. A head is reviewed once
	 * it is not pending with total_count > 0, or (no checks, or a failed read) once it
	 * has been the head CHECKS_FALLBACK_MS by now(). Absent: no settle.
	 */
	checksOf?: (repo: string, sha: string) => Promise<unknown>;
	now?: () => number;
	/** Board issues matching a title query; with cancelTask, a new head's review cancels older open review parents. */
	listIssues?: (
		query: string,
		repo?: string,
		number?: number,
	) => Promise<Array<{ id: string; title: string; status: string }>>;
	cancelTask?: (id: string, comment: string) => Promise<void>;
	/** The PR's changed files; present turns on the mechanical preflight. */
	listFiles?: (repo: string, number: number) => Promise<ChangedFile[]>;
	/** A Forge GET; with listFiles, findAgent and an event baseRef, turns on the non-code fast path; with listFiles and baseRef, the codeOnlyReview docs list. */
	forgeGet?: (path: string) => Promise<unknown>;
}
/** How long a head with no checks (or an unreadable status) waits before review. */
export const CHECKS_FALLBACK_MS: number;
/** { state, total } of a Forge combined status, or null when it is not one. */
export function checksSummary(status: unknown): { state: string; total: number } | null;
/** The commit sha an Actions-run webhook payload names, or null. */
export function actionRunSha(body: unknown): string | null;
/** Files the repo's waiting heads that are now ready (an Actions run ended); one result per waiting head. */
export function recheckWaiting(
	deps: ReviewOnceDeps & {
		forgeGet: (path: string) => Promise<unknown>;
		repoTier?: (repo: string) => Promise<number>;
	},
	repo: string,
	sha: string | null,
): Promise<ReviewOnceResult[]>;
/** Rejects one PR's stale merge approvals now (a new head); answers how many. Never throws a Forge stop. */
export function rejectStaleApprovalsFor(
	deps: SweepDeps & { classify?: (repo: string, number: number, sha: string) => Promise<unknown> },
	repo: string,
	number: number,
): Promise<number>;
export type ReviewOnceResult =
	| { key: string; outcome: "duplicate" | "settling" | "preflight" | "unfiled" | "admission_hold" }
	| { key: string; outcome: "created" | "scripted"; issueId: string; partial?: true };
/** The one locked path from a PR head to a review task, shared by webhook and sweep. */
export function reviewPrOnce(
	deps: ReviewOnceDeps,
	event: PullRequestEvent,
): Promise<ReviewOnceResult>;
