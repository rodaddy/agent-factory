// Types for question-route.js (sf#1730: seat questions go to Smythe).
export const QUESTION_STATUSES: string[];
export const MAX_IN_FLIGHT: number;
export const ROUTE_ASK: string;
export function isSeatQuestion(interaction: unknown): boolean;
export function mapLimit<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>,
): Promise<R[]>;
export interface QuestionTask {
	title: string;
	description: string;
	assigneeAgentId: string;
	status: "todo";
	priority: "high";
}
export function smytheTask(
	origin: { id?: string; identifier?: string | null },
	card: { createdByAgentId?: string | null; title?: string | null; payload?: unknown },
	askerName: string | null,
	smytheId: string,
): QuestionTask;
export function routedComment(identifier: string): string;
export interface QuestionRouteDeps {
	listIssues: (input: { status: string; limit: number }) => Promise<unknown[]>;
	listInteractions: (issueId: string) => Promise<unknown[]>;
	now: () => number;
	stateGet: (key: string) => Promise<unknown>;
	stateSet: (key: string, value: unknown) => Promise<void>;
	findAgent: (login: string) => Promise<string | null>;
	agentName?: (id: string | null) => Promise<string | null>;
	createTask: (task: QuestionTask) => Promise<{ id: string; identifier?: string | null }>;
	comment: (issueId: string, body: string) => Promise<void>;
	log: (line: string) => void;
}
export function routeQuestions(
	deps: QuestionRouteDeps,
): Promise<{ pending: number; routed: number }>;
