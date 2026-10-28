/**
 * @module fleet/notify/rules
 * @description What the owner must see. Pure: board rows in, items out.
 *   No I/O and no imports, so the same file runs under Node 24 type stripping
 *   and under bun. Every rule filters client-side; a query parameter the board
 *   ignores cannot produce a wrong item.
 */

/** First line of a board comment an agent writes to have the owner told once. */
export const TELL_MARKER = "TELL OPERATOR:";

export interface Item {
	key: string;
	kind: "blocked" | "approval" | "tell" | "agent";
	line: string;
	link: string | null;
}

export interface IssueRow {
	id: string;
	identifier?: string | null;
	title?: string | null;
	status?: string | null;
	blockedTransitionAt?: string | null;
	unblockDescriptor?: { owner?: unknown; action?: unknown } | null;
}

export interface ApprovalRow {
	id: string;
	type?: string | null;
	status?: string | null;
	payload?: { title?: unknown; source?: unknown } | null;
}

export interface RunRow {
	agentId?: string | null;
	status?: string | null;
	errorCode?: string | null;
	createdAt?: string | null;
	finishedAt?: string | null;
	contextSnapshot?: { issueId?: unknown } | null;
}

export interface AgentRow {
	id: string;
	name?: string | null;
	status?: string | null;
	errorReason?: string | null;
}

export interface CommentRow {
	id: string;
	body?: string | null;
	authorAgentId?: string | null;
	createdAt?: string | null;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const LINE_MAX = 200;
const REASON_MAX = 120;
const SCAN_WINDOW_MS = 15 * MINUTE_MS;
const SCAN_MAX = 30;
const TELL_WINDOW_MS = 24 * HOUR_MS;
const FAIL_RUNS = 3;
const FAIL_WINDOW_MS = 6 * HOUR_MS;
const ERROR_PASSES = 3;
const FORGE = "https://forge.example.internal";
const URL_RE = /https:\/\/[^\s<>"')\]]+/;
const GO_RE = /^Go on ([\w.-]+\/[\w.-]+)#(\d+) at /;

function firstUrl(text: string): string | null {
	return URL_RE.exec(text)?.[0] ?? null;
}

function str(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function ms(iso: string | null | undefined): number {
	return iso ? Date.parse(iso) : Number.NaN;
}

/** Issues blocked on the board itself: every NEEDS OPERATOR and every question to him. */
export function blockedItems(issues: IssueRow[]): Item[] {
	const items: Item[] = [];
	for (const issue of issues) {
		if (issue.status !== "blocked") continue;
		if (issue.unblockDescriptor?.owner !== "board") continue;
		const action = str(issue.unblockDescriptor.action).trim();
		const what = action === "" ? str(issue.title) : action;
		items.push({
			key: `blocked:${issue.id}:${issue.blockedTransitionAt ?? ""}`,
			kind: "blocked",
			line: `${issue.identifier ?? issue.id}: ${what}`.slice(0, LINE_MAX),
			link: firstUrl(action),
		});
	}
	return items;
}

/** Pending board approvals: a class B go request carries no NEEDS OPERATOR. */
export function approvalItems(approvals: ApprovalRow[]): Item[] {
	const items: Item[] = [];
	for (const approval of approvals) {
		if (approval.status !== "pending") continue;
		const budgetStop =
			["budget_override_required", "request_board_approval"].includes(approval.type ?? "") &&
			approval.payload?.source === "company_daily_budget";
		if (approval.type !== "request_board_approval" && !budgetStop) continue;
		const title = str(approval.payload?.title);
		const go = GO_RE.exec(title);
		items.push({
			key: `${budgetStop ? "company-budget" : "approval"}:${approval.id}`,
			kind: "approval",
			line: `Approval waiting: ${title === "" ? approval.id : title}`.slice(0, LINE_MAX),
			link: go ? `${FORGE}/${go[1]}/pulls/${go[2]}` : null,
		});
	}
	return items;
}

/** Issues whose comments are worth reading this pass: named by a live or just-finished run. */
export function issuesToScan(runs: RunRow[], nowMs: number): string[] {
	const ids: string[] = [];
	for (const run of runs) {
		if (ids.length >= SCAN_MAX) break;
		const live = run.finishedAt == null || nowMs - ms(run.finishedAt) <= SCAN_WINDOW_MS;
		if (!live) continue;
		const id = run.contextSnapshot?.issueId;
		if (typeof id !== "string" || id === "" || ids.includes(id)) continue;
		ids.push(id);
	}
	return ids;
}

/** Agent comments whose first line starts with the marker, from the last 24 h. */
export function tellItems(
	issue: Pick<IssueRow, "id" | "identifier">,
	comments: CommentRow[],
	nowMs: number,
): Item[] {
	const items: Item[] = [];
	for (const comment of comments) {
		if (!comment.authorAgentId) continue;
		const body = str(comment.body);
		const first = body.split("\n", 1)[0] ?? "";
		if (!first.startsWith(TELL_MARKER)) continue;
		if (!(nowMs - ms(comment.createdAt) <= TELL_WINDOW_MS)) continue;
		const rest = first.slice(TELL_MARKER.length).trim();
		items.push({
			key: `tell:${comment.id}`,
			kind: "tell",
			line: `${issue.identifier ?? issue.id}: ${rest}`.slice(0, LINE_MAX),
			link: firstUrl(body),
		});
	}
	return items;
}

const FINISHED = ["failed", "timed_out", "succeeded"];

/**
 * Agents that keep failing: the 3 newest finished runs all failed and the
 * newest is under 6 h old, or `status` is `error` on 3 passes in a row.
 * The returned errorPasses holds only the agents in error now.
 */
export function badAgents(
	agents: AgentRow[],
	runs: RunRow[],
	errorPasses: Record<string, number>,
	nowMs: number,
): { items: Item[]; errorPasses: Record<string, number> } {
	const items: Item[] = [];
	const passes: Record<string, number> = {};
	for (const agent of agents) {
		const name = agent.name ?? agent.id;
		const inError = agent.status === "error";
		const count = inError ? (errorPasses[agent.id] ?? 0) + 1 : 0;
		if (inError) passes[agent.id] = count;

		const newest = runs
			.filter((run) => run.agentId === agent.id && FINISHED.includes(run.status ?? ""))
			.sort((a, b) => ms(b.createdAt) - ms(a.createdAt))
			.slice(0, FAIL_RUNS);
		const failing =
			newest.length === FAIL_RUNS &&
			newest.every((run) => run.status !== "succeeded") &&
			nowMs - ms(newest[0]?.createdAt) < FAIL_WINDOW_MS;

		if (failing) {
			const code = newest[0]?.errorCode || "no code";
			items.push({
				key: `agent:${agent.id}`,
				kind: "agent",
				line: `${name} is failing: last 3 runs failed (${code})`,
				link: null,
			});
		} else if (count >= ERROR_PASSES) {
			const reason = str(agent.errorReason).slice(0, REASON_MAX);
			items.push({
				key: `agent:${agent.id}`,
				kind: "agent",
				line: `${name} is in error: ${reason === "" ? "no reason given" : reason}`,
				link: null,
			});
		}
	}
	return { items, errorPasses: passes };
}
