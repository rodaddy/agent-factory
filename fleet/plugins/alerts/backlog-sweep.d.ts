export const BACKLOG_ORIGIN: "plugin:rodaddy.alerts:backlog";
export const MOVE_CAP: number;

export interface BacklogIssue {
	id: string;
	identifier?: string;
	title?: string;
	assigneeAgentId?: string | null;
	updatedAt?: string;
	labels?: { name?: string }[];
}

export interface BacklogCtx {
	companies: { list(): Promise<{ id: string }[]> };
	config: { get(companyId: string): Promise<Record<string, unknown> | null | undefined> };
	logger: {
		info(message: string, data?: unknown): void;
		warn(message: string, data?: unknown): void;
	};
	agents: {
		list(q: { companyId: string }): Promise<{ id: string; name?: string; status: string }[]>;
	};
	issues: {
		list(q: {
			companyId: string;
			status?: string;
			originKind?: string;
			originId?: string;
			limit?: number;
			offset?: number;
		}): Promise<BacklogIssue[]>;
		update(issueId: string, patch: { status: "todo" }, companyId: string): Promise<unknown>;
		createComment(issueId: string, body: string, companyId: string): Promise<unknown>;
		create(task: {
			companyId: string;
			title: string;
			description: string;
			assigneeAgentId: string;
			status: "todo";
			priority: string;
			originKind: string;
			originId: string;
		}): Promise<unknown>;
	};
}

export function runBacklogSweep(ctx: BacklogCtx, now: () => number): Promise<void>;
