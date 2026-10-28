export const STRANDED_PHRASE: string;
export const RESUME_CAP: number;
export const RESUME_MAX_AGE_MS: number;
export function watchOn(cfg: unknown): string | undefined;
interface Comment {
	authorType?: string;
	body?: string;
	createdAt?: string;
}
interface Issue {
	id: string;
	identifier?: string;
	title?: string;
	status: string;
	assigneeAgentId?: string;
}
export interface SweepCtx {
	companies: { list(): Promise<{ id: string }[]> };
	config: { get(companyId: string): Promise<Record<string, unknown> | null | undefined> };
	logger: { info(message: string, data?: unknown): void };
	agents: {
		list(q: { companyId: string }): Promise<{ id: string; name?: string; status?: string }[]>;
	};
	issues: {
		list(q: { companyId: string; status: string; limit: number; offset: number }): Promise<Issue[]>;
		listComments(issueId: string, companyId: string): Promise<Comment[]>;
		relations: {
			get(issueId: string, companyId: string): Promise<{ blockedBy?: { status: string }[] }>;
		};
		update(issueId: string, patch: { status: "todo" }, companyId: string): Promise<unknown>;
		createComment(issueId: string, body: string, companyId: string): Promise<unknown>;
	};
}
export function runResumeSweep(ctx: SweepCtx, now: () => number): Promise<void>;
export interface FailCtx {
	config: SweepCtx["config"];
	agents: {
		get(agentId: string, companyId: string): Promise<{ id: string; name?: string } | null>;
	};
	issues: {
		list(q: {
			companyId: string;
			originKind: string;
			originId: string;
			limit: number;
		}): Promise<{ id: string }[]>;
		create(
			input: Record<string, unknown> & { companyId: string; title: string },
		): Promise<{ id: string }>;
		createComment(issueId: string, body: string, companyId: string): Promise<unknown>;
	};
}
export interface RunFailedEvent {
	companyId: string;
	payload?: { runId?: string; agentId?: string; error?: string | null };
}
export function onRunFailed(ctx: FailCtx, event: RunFailedEvent, now: () => number): Promise<void>;
