// every task carries a project. An issue that
// arrives without one gets one derived, in this order (the order of the head's
// backfill script): an owner/repo in the title, a bare repo#n matching exactly
// one project, the parent's project, infra. Anything else goes to the triage
// lead with one comment.

export const PLUGIN_KEY = "rodaddy.project-guard";
export const INFRA_PROJECT = "rtech/rtech-infra";
export const TRIAGE_LEAD = "Simms";
// fleet/board/agents.json key `infra`.
export const INFRA_SEAT = "Nagatha";
export const REJECT_COMMENT =
	"No project (Rico 2026-10-07: every task carries a project). Set the right project, then move it back to its owner.";
// A closed issue is not reopened to be triaged.
const CLOSED = new Set(["done", "cancelled"]);

const lower = (s) => String(s ?? "").toLowerCase();

/** The project an issue title names, or null. "1/2" and the like name nothing. */
export function projectFromTitle(title, projects) {
	const byName = new Map(projects.map((p) => [lower(p.name), p.id]));
	const text = String(title ?? "");
	for (const m of text.matchAll(/\b([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)/g)) {
		const id = byName.get(lower(m[1]));
		if (id) return id;
	}
	// Bare repo#n only: the lookbehind refuses a repo that is part of a longer
	// token, so owner/app#12 under an unknown owner never matches rtech/app.
	for (const m of text.matchAll(/(?<![A-Za-z0-9_.\/-])([A-Za-z0-9_.-]+)#\d+/g)) {
		const hits = projects.filter((p) => lower(p.name).endsWith(`/${lower(m[1])}`));
		if (hits.length === 1) return hits[0].id;
	}
	return null;
}

export function isInfra(issue, infraAgentId) {
	return (
		/^Infra\b/i.test(String(issue.title ?? "")) ||
		lower(issue.originKind).includes("alerts") ||
		(!!infraAgentId && issue.createdByAgentId === infraAgentId)
	);
}

/** Only issue.created, or an issue.updated that cleared the project, and never our own write. */
export function wants(event) {
	const p = event?.payload ?? {};
	if (
		event?.actorType === "plugin" &&
		(p.pluginKey === PLUGIN_KEY || p.sourcePluginKey === PLUGIN_KEY)
	)
		return false;
	if (event?.eventType === "issue.created") return true;
	const change = p.changes?.projectId;
	return event?.eventType === "issue.updated" && !!change && !change.to;
}

export async function handleIssueEvent({ event, board }) {
	const issueId = event?.entityId;
	if (!issueId || !wants(event)) return { action: "ignored", reason: "not a guarded event" };
	const issue = await board.getIssue(issueId);
	if (!issue) return { action: "ignored", reason: "issue not found" };
	if (issue.projectId) return { action: "has-project" };
	if (CLOSED.has(issue.status)) return { action: "ignored", reason: "closed" };

	const projects = await board.listProjects();
	let projectId = projectFromTitle(issue.title, projects);
	let why = projectId ? "title" : "";
	if (!projectId && issue.parentId) {
		projectId = (await board.getIssue(issue.parentId))?.projectId ?? null;
		if (projectId) why = "parent";
	}
	const agents = await board.listAgents();
	const agentId = (name) => agents.find((a) => a.name === name)?.id;
	if (!projectId && isInfra(issue, agentId(INFRA_SEAT))) {
		projectId = projects.find((p) => lower(p.name) === INFRA_PROJECT)?.id ?? null;
		if (projectId) why = "infra";
	}
	if (projectId) {
		await board.updateIssue(issueId, { projectId });
		return { action: "derived", why, projectId };
	}
	// `blocked` is refused without a blocker, so a reject is todo on the triage lead.
	const lead = agentId(TRIAGE_LEAD);
	await board.updateIssue(issueId, { status: "todo", ...(lead ? { assigneeAgentId: lead } : {}) });
	await board.addComment(issueId, REJECT_COMMENT);
	return { action: "rejected", ...(lead ? {} : { reason: "triage lead not found" }) };
}
