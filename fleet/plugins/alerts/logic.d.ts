// Types for logic.js, the plugin's pure functions (plain ESM so Paperclip can
// import it without a build). Kept beside the code so the repo's typecheck
// covers the tests that import it.
export type Headers = Record<string, string | string[]>;
export type Labels = Record<string, string>;

export const MARKER: string;
export const REPEAT_QUIET_MS: number;

export interface Alert {
	key: string;
	title: string;
	status: "firing" | "resolved";
	labels: Labels;
	annotations: Record<string, string>;
	startsAt: string;
	endsAt: string;
	generatorURL: string;
}

export interface AlertTask {
	title: string;
	description: string;
	assigneeAgentId: string;
	status: "todo";
	priority: "high" | "medium";
}

export interface BoardIssue {
	id: string;
	title: string;
	status: string;
}

export interface BoardComment {
	body: string;
	createdAt: string;
}

export type Decision =
	| "create"
	| "comment"
	| "reopen"
	| "resolve-close"
	| "close"
	| "resolve-comment"
	| "skip";

export interface Board {
	listIssues(assigneeAgentId: string): Promise<BoardIssue[]>;
	listComments(issueId: string): Promise<BoardComment[]>;
	createIssue(task: AlertTask): Promise<unknown>;
	addComment(issueId: string, body: string): Promise<unknown>;
	updateIssue(issueId: string, patch: { status: "done" | "todo" }): Promise<unknown>;
}

export function hostGroup(alertname: string, where: string): string;
export function foldTitle(alert: Alert): string;

export function headerValue(headers: Headers | undefined, name: string): string | undefined;
export const TOKEN_HEADER: "x-alerts-token";
export function verifyToken(headerToken: string | undefined, secret: string): boolean;
export function alertKey(labels: Labels | undefined): string;
export function alertTitle(labels: Labels | undefined): string;
export function parseAlerts(body: unknown): Alert[];
export function summaryOf(alert: Alert): string;
export function issueDescription(alert: Alert): string;
export function issueTask(alert: Alert, cfg: { assigneeAgentId: string }): AlertTask;
export interface AlertRoute {
	match: string;
	assigneeAgentId: string;
}
// routes is unknown, not AlertRoute[]: the live config is operator-typed, and a
// malformed value must fall back to the default, never throw.
export interface AlertsCfg {
	assigneeAgentId: string;
	routes?: unknown;
	projectId?: string;
	opsGuard?: { opsAgentId: string; homeAgentId: string };
}
export function assigneeFor(alert: Alert, cfg: AlertsCfg): string;
export function findOpen(issues: BoardIssue[], title: string): BoardIssue | undefined;
export function decide(
	alert: Alert,
	openIssue: BoardIssue | undefined,
	comments: BoardComment[],
	nowMs: number,
): Decision;
export function firingComment(alert: Alert, nowIso: string): string;
export function resolvedComment(alert: Alert): string;
export function handleDelivery(input: {
	headers: Headers;
	body: unknown;
	secret: string;
	cfg: AlertsCfg;
	board: Board;
	now: () => number;
}): Promise<{ key: string; action: Decision }[]>;

export const COMPANY_HEADER: "x-alerts-company";
export const INFRA_PROJECT: "rtech/rtech-infra";
export interface WebhookCtx {
	companies?: unknown;
	/** Read only when cfg.projectId is unset. */
	projects?: {
		list(q: { companyId: string; limit: number; offset: number }): Promise<unknown[]>;
	};
	logger?: { warn(message: string, data?: unknown): void };
	config: { get(companyId: string): Promise<Record<string, unknown> | null | undefined> };
	secrets: {
		resolve(ref: unknown, opts: { companyId: string; configPath: string }): Promise<string>;
	};
	issues: {
		list(q: {
			companyId: string;
			assigneeAgentId: string;
			status: string;
			limit: number;
			offset: number;
		}): Promise<BoardIssue[]>;
		listComments(issueId: string, companyId: string): Promise<BoardComment[]>;
		create(task: AlertTask & { companyId: string; projectId?: string }): Promise<unknown>;
		createComment(issueId: string, body: string, companyId: string): Promise<unknown>;
		update(
			issueId: string,
			patch: { status: "done" | "todo" },
			companyId: string,
		): Promise<unknown>;
	};
}
export function handleWebhook(
	ctx: WebhookCtx,
	input: { endpointKey: string; headers: Headers; parsedBody?: unknown; rawBody: string },
	now: () => number,
): Promise<{ key: string; action: Decision }[]>;

export const OPS_GUARD_CAP: number;
export const ALERTS_ORIGIN: "plugin:rodaddy.alerts";
export interface GuardIssue {
	description?: string;
	id?: string;
	identifier?: string;
	status: string;
	assigneeAgentId?: string;
	originKind?: string;
	title?: string;
}
export function alertOwner(issue: GuardIssue, cfg: AlertsCfg): string | undefined;
export function opsGuardDecision(issue: GuardIssue, cfg: AlertsCfg): "keep" | "hand-back";
export function handBackTo(
	issue: GuardIssue,
	cfg: AlertsCfg & { opsGuard: { homeAgentId: string } },
): string;
export interface OpsGuardCtx {
	companies: { list(): Promise<{ id: string }[]> };
	config: { get(companyId: string): Promise<Record<string, unknown> | null | undefined> };
	logger: {
		info(message: string, data?: unknown): void;
		warn(message: string, data?: unknown): void;
	};
	issues: {
		list(q: {
			companyId: string;
			assigneeAgentId: string;
			status: string;
			limit: number;
			offset: number;
		}): Promise<GuardIssue[]>;
		get(issueId: string, companyId: string): Promise<GuardIssue | null>;
		update(
			issueId: string,
			patch: { assigneeAgentId: string },
			companyId: string,
		): Promise<unknown>;
		createComment?(...args: never[]): Promise<unknown>;
	};
}
export function runOpsGuard(ctx: OpsGuardCtx): Promise<void>;
