// Types for logic.js, the plugin's pure functions (plain ESM so Paperclip can
// import it without a build). Kept beside the code so the repo's typecheck
// covers the tests that import it.
export type Headers = Record<string, string | string[]>;

export type Priority = "critical" | "high" | "medium" | "low";

export interface PullRequestEvent {
	repo: string;
	number: number;
	/** One of opened, reopened, synchronized (Forgejo's spelling). */
	action: string;
	headSha: string;
	url: string;
	title: string;
	author: string;
	/** The PR body, for the preflight. */
	body?: string;
	/** The PR's base branch, when the payload names it. */
	baseRef?: string;
	/** The PR's changed_files count, when the payload carries it. */
	changedFiles?: number;
	/** True for an `edited` event that changed only the body. */
	bodyEdit?: boolean;
	/** Read when the event is parsed: a priority/<x> label, a [blocker] marker, or medium. */
	priority: Priority;
	/** label priority/<x>, [blocker] marker, default, or tier <tier>. */
	priorityWhy: string;
	/** Set by withTier. */
	tier?: Tier;
}

export type Tier = 0 | 1 | 2 | 3 | 4 | 5;
export const TIERS: Tier[];
export const WORK_LABEL: string;
export function tierOf(repo: string, topics: unknown): Tier;
export function withTier<E extends { priority: Priority; priorityWhy: string }>(
	event: E,
	tier: unknown,
): E & { tier: Tier };

export interface ReviewIssue {
	title: string;
	description: string;
	assigneeAgentId: string;
	status: "todo";
	priority: Priority;
}

export function headerValue(headers: Headers | undefined, name: string): string | undefined;
export function verifySignature(
	rawBody: string,
	signatureHeader: string | undefined,
	secret: string,
): boolean;
export function parsePullRequestEvent(
	headers: Headers,
	body: unknown,
	allowedRepos: string[],
): PullRequestEvent | null;
export function priorityOf(item: { labels?: unknown; title?: unknown; body?: unknown }): Priority;
export function dedupeKey(event: PullRequestEvent): string;
export function reviewIssue(event: PullRequestEvent, cfg: { reviewerAgentId: string }): ReviewIssue;

export interface IssueEvent {
	repo: string;
	number: number;
	title: string;
	url: string;
	/** opened or reopened. */
	action: string;
	priority: Priority;
	priorityWhy: string;
}
export interface TriageIssue {
	title: string;
	description: string;
	assigneeAgentId: string;
	status: "todo";
	priority: Priority;
}
export type SweepCandidate =
	| { kind: "pr"; key: string; event: PullRequestEvent }
	| { kind: "issue"; key: string; event: IssueEvent };

export function parseIssueEvent(
	headers: Headers,
	body: unknown,
	allowedRepos: string[],
): IssueEvent | null;
export function issueFromApi(repo: string, issue: unknown, action?: string): IssueEvent | null;
export function issueDedupeKey(event: IssueEvent): string;
export function triageIssue(event: IssueEvent, cfg: { triageAgentId: string }): TriageIssue;
export function prFromApi(repo: string, pr: unknown): PullRequestEvent | null;
export function sweepCandidates(repo: string, pulls: unknown, issues: unknown): SweepCandidate[];
export function taskFor(
	candidate: SweepCandidate,
	cfg: { reviewerAgentId: string; triageAgentId: string },
): ReviewIssue | TriageIssue;

export const REVIEW_ROUND_LIMIT: number;
/** The ROUND LIMIT warning for a PR that has had `rounds` review rounds. */
export function roundLimitText(rounds: number): string;
export function reviewTitlePrefix(repo: string, number: number): string;
export const BASE_MERGE_LINE: string;
/** A board review entry: a bare title (always counted) or a board issue. */
export type ReviewEntry = string | { title?: unknown; status?: unknown; description?: unknown };
/** The PR's review rounds: distinct counted heads. Cancelled and base-merge reviews are not rounds. */
export function reviewRounds(entries: unknown, repo: string, number: number): number;
/** "limit" at REVIEW_ROUND_LIMIT rounds: warn, the review is still created. */
export function roundDecision(entries: unknown, repo: string, number: number): "create" | "limit";
/** sha7 of every head with a review task, any status. */
export function reviewedHeads(entries: unknown, repo: string, number: number): string[];
export function roundLimitKey(event: PullRequestEvent): string;
export function roundLimitComment(author: string, rounds: number): string;
export function pickLinkedTask<T extends { title?: unknown; description?: unknown }>(
	issues: T[] | unknown,
	prUrl: string,
): T | null;
export function reworkTask(
	event: PullRequestEvent,
	assigneeAgentId: string,
	rounds: number,
): ReviewIssue;
/** The Forge login that merges (crew.json milestone-engineer) and the seats whose verdict counts. */
export const MERGER_LOGIN: string;
export const VERDICT_LOGINS: string[];
/** One PR head: what the Merge task routing needs. */
export interface MergeHead {
	repo: string;
	number: number;
	headSha: string;
	url: string;
}
/** The lead verdict in one comment body, by merge-check's VERDICT and review heading; null when none. */
export function verdictOf(
	body: unknown,
	repo: string,
	number: number,
	sha7: string,
): "approve" | "approve-with-fixes" | "fix-first" | null;
export interface HeadVerdict {
	verdict: "approve" | "approve-with-fixes" | "fix-first";
	by: string;
	at: string;
	commentId: string;
	issue: unknown;
}
/** The newest verdict by an author in authorIds on the review task of exactly this head. */
export function headVerdict(
	issue: unknown,
	comments: unknown,
	authorIds: Set<unknown>,
	ev: MergeHead,
): HeadVerdict | null;
export function mergeTitle(ev: MergeHead): string;
export function mergeTask(ev: MergeHead, v: HeadVerdict, assigneeAgentId: string): ReviewIssue;
/** "backlog" when the agent's status is paused, error, terminated or archived; else "todo". */
export function taskStatusFor(agent: { status?: unknown } | null | undefined): "backlog" | "todo";

/** Reviewer seat logins per family of the no-lead pair. */
export const REVIEWER_FAMILIES: { claude: string[]; gpt: string[] };
type HeadRef = { repo: string; number: number; headSha: string };
/** `Review <repo>#<n> @ <sha7> (<Name>)`. */
export function pairTitle(event: HeadRef, name: string): string;
/** docs: non-code paths the reviewer skips; empty or over 200 means a full review. */
export function reviewerTask(
	event: PullRequestEvent,
	agentId: string,
	name: string,
	docs?: string[],
): ReviewIssue;
export function pickSeat(
	family: string,
	load: unknown,
	agents: unknown,
): { agentId: string; name: string } | null;
type PairRecord = {
	verdict: "approve" | "fix-first";
	by: string;
	at: string;
	commentId: unknown;
	issue: unknown;
};
export interface PairVerdict {
	state: "approve" | "fix-first" | "pending" | "escalated";
	claude: PairRecord | null;
	gpt: PairRecord | null;
	missing: ("claude" | "gpt")[];
	escalate: { by: string; at: string; why: string } | null;
}
type Seats = { claude: Set<string> | string[]; gpt: Set<string> | string[]; authorSeat?: string };
export function pairVerdict(tasks: unknown, ev: HeadRef, seats: Seats | undefined): PairVerdict;

/** A board issue as a markdown link: [SOF-7](/SOF/issues/SOF-7), else "board task <id>". */
export function boardRef(
	issue: { id?: string; identifier?: string | null } | null | undefined,
): string;
