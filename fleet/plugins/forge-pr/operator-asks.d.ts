// Types for operator-asks.js (sf#1375: every ask to the owner is counted and filed).
export const OPERATOR_ASK_RULING: string;
export function isOperatorAsk(approval: unknown): boolean;
export interface OperatorAskDay {
	day: string;
	count: number;
	reasons: string[];
}
export interface OperatorAskCounts {
	last24h: number;
	days: OperatorAskDay[];
}
/** Pure: asks per UTC day with reasons, and the count in the 24 h before now. */
export function operatorAskCounts(approvals: unknown[], now: number): OperatorAskCounts;
export interface OperatorAskIssue {
	title: string;
	description: string;
	assigneeAgentId: string;
	status: "todo";
	priority: "high";
}
export function operatorAskIssue(
	approval: { id: string; payload?: unknown },
	agentName: string | null,
	bishopId: string,
): OperatorAskIssue;
export interface OperatorAskDeps {
	approvals: { list(input: { companyId: string; status?: string | null }): Promise<unknown[]> };
	companyId: string;
	now: () => number;
	stateGet: (key: string) => Promise<unknown>;
	stateSet: (key: string, value: unknown) => Promise<void>;
	createTask: (task: OperatorAskIssue) => Promise<{ id: string }>;
	findAgent: (login: string) => Promise<string | null>;
	agentName?: (id: string | null) => Promise<string | null>;
	log: (line: string) => void;
}
export function fileOperatorAsks(
	deps: OperatorAskDeps,
): Promise<OperatorAskCounts & { filed: number }>;
