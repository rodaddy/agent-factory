// Types for logic.js, the plugin's pure functions (plain ESM so Paperclip can
// import it without a build). Kept beside the code so the repo's typecheck
// covers the tests that import it.
export type Headers = Record<string, string | string[]>;

export const ASK_PREFIX: "Ask: ";
export const ANSWER_PREFIX: "ANSWER:";
export const TITLE_MAX: number;
export const QUESTION_MAX: number;
export const ASKER_MAX: number;
export const HITS_MAX: number;
export const SNIPPET_MAX: number;
export const TOKEN_HEADER: "x-ask-token";

export interface Config {
	assigneeAgentId: string;
	callbackHosts?: string[];
}

export interface Hit {
	path: string;
	line?: number;
	snippet?: string;
}

export interface Ask {
	question: string;
	asker: string;
	hits: Hit[];
	callbackUrl?: string;
}

export interface AskTask {
	title: string;
	description: string;
	assigneeAgentId: string;
	status: "todo";
	priority: "medium";
}

export interface BoardIssue {
	id: string;
	identifier?: string | null;
	title: string;
	status: string;
}

export interface BoardComment {
	id: string;
	body: string;
	authorAgentId: string | null;
}

export interface Board {
	createIssue(task: AskTask): Promise<{ id: string; identifier?: string | null }>;
	getIssue(issueId: string): Promise<BoardIssue | null>;
	listComments(issueId: string): Promise<BoardComment[]>;
	updateIssue(issueId: string, patch: { status: "done" }): Promise<unknown>;
}

export interface Stored {
	callbackUrl: string;
	question: string;
}

export interface State {
	get(issueId: string): Promise<Stored | null | undefined>;
	set(issueId: string, value: Stored): Promise<void>;
}

export interface CallbackPayload {
	issueId: string;
	identifier: string | null;
	question: string;
	answer: string;
}

export type Post = (url: string, payload: CallbackPayload) => Promise<{ ok: boolean }>;

export interface CommentEvent {
	entityId?: string;
	payload?: { commentId?: string; issueTitle?: string; [key: string]: unknown };
}

export interface CommentResult {
	action: "answered" | "ignored";
	reason?: string;
	callback?: "sent" | "failed" | "none";
	closed?: boolean;
}

export function headerValue(headers: Headers | undefined, name: string): string | undefined;
export function verifyToken(headerToken: string | undefined, secret: string): boolean;
export function askTitle(question: string): string;
export function parseAsk(body: unknown, allowedHosts?: string[]): Ask;
export function askDescription(ask: Ask): string;
export function askTask(ask: Ask, cfg: { assigneeAgentId: string }): AskTask;
export function isAnswer(text: unknown): boolean;
export function handleAsk(input: {
	headers: Headers | undefined;
	body: unknown;
	secret: string;
	cfg: Config;
	board: Board;
	state: State;
}): Promise<{ id: string; identifier: string | null }>;
export function handleComment(input: {
	event: CommentEvent;
	cfg: Config;
	board: Board;
	state: State;
	post: Post;
}): Promise<CommentResult>;
