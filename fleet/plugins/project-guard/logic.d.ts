// Types for logic.js, the plugin's pure functions (plain ESM so Paperclip can
// import it without a build). Kept beside the code so the repo's typecheck
// covers the tests that import it.
export const PLUGIN_KEY: "rodaddy.project-guard";
export const INFRA_PROJECT: "rtech/rtech-infra";
export const TRIAGE_LEAD: "Simms";
export const INFRA_SEAT: "Nagatha";
export const REJECT_COMMENT: string;

export interface Project {
	id: string;
	name: string;
}

export interface Agent {
	id: string;
	name: string;
}

export interface BoardIssue {
	id: string;
	title: string;
	status: string;
	projectId?: string | null;
	parentId?: string | null;
	originKind?: string | null;
	createdByAgentId?: string | null;
	assigneeAgentId?: string | null;
}

export interface IssueEvent {
	eventType?: string;
	entityId?: string;
	actorType?: string;
	payload?: {
		pluginKey?: string;
		sourcePluginKey?: string;
		changes?: Record<string, { from?: unknown; to?: unknown } | undefined>;
		[key: string]: unknown;
	};
}

export type Patch = { projectId: string } | { status: "todo"; assigneeAgentId?: string };

export interface Board {
	getIssue(issueId: string): Promise<BoardIssue | null>;
	listProjects(): Promise<Project[]>;
	listAgents(): Promise<Agent[]>;
	updateIssue(issueId: string, patch: Patch): Promise<unknown>;
	addComment(issueId: string, body: string): Promise<unknown>;
}

export interface Result {
	action: "ignored" | "has-project" | "derived" | "rejected";
	reason?: string;
	why?: "title" | "parent" | "infra";
	projectId?: string;
}

export function projectFromTitle(title: string, projects: Project[]): string | null;
export function isInfra(issue: BoardIssue, infraAgentId: string | undefined): boolean;
export function wants(event: IssueEvent): boolean;
export function handleIssueEvent(input: { event: IssueEvent; board: Board }): Promise<Result>;
