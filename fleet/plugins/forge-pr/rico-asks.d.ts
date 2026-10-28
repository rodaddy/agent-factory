// Types for rico-asks.js (sf#1375: every ask to the owner is counted and filed).
export const RICO_ASK_RULING: string;
export function isRicoAsk(approval: unknown): boolean;
export interface RicoAskDay {
	day: string;
	count: number;
	reasons: string[];
}
export interface RicoAskCounts {
	last24h: number;
	days: RicoAskDay[];
}
/** Pure: asks per UTC day with reasons, and the count in the 24 h before now. */
export function ricoAskCounts(approvals: unknown[], now: number): RicoAskCounts;
export interface RicoAskIssue {
	title: string;
	description: string;
	assigneeAgentId: string;
	status: "todo";
	priority: "high";
}
export function ricoAskIssue(
	approval: { id: string; payload?: unknown },
	agentName: string | null,
	bishopId: string,
): RicoAskIssue;
export interface RicoAskDeps {
	approvals: { list(input: { companyId: string; status?: string | null }): Promise<unknown[]> };
	companyId: string;
	now: () => number;
	stateGet: (key: string) => Promise<unknown>;
	stateSet: (key: string, value: unknown) => Promise<void>;
	createTask: (task: RicoAskIssue) => Promise<{ id: string }>;
	findAgent: (login: string) => Promise<string | null>;
	agentName?: (id: string | null) => Promise<string | null>;
	log: (line: string) => void;
}
export function fileRicoAsks(deps: RicoAskDeps): Promise<RicoAskCounts & { filed: number }>;
