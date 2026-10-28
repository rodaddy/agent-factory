import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { handleIssueEvent } from "./logic.js";

let ctx;

// projectId is not in the SDK's typed update patch, but the worker passes the
// patch through to the host unchanged (worker-rpc-host.js issues.update).
const boardFor = (companyId) => ({
	getIssue: (issueId) => ctx.issues.get(issueId, companyId),
	listProjects: () => ctx.projects.list({ companyId, limit: 500 }),
	listAgents: () => ctx.agents.list({ companyId }),
	updateIssue: (issueId, patch) => ctx.issues.update(issueId, patch, companyId),
	addComment: (issueId, body) => ctx.issues.createComment(issueId, body, companyId),
});

async function onIssue(event) {
	try {
		const result = await handleIssueEvent({ event, board: boardFor(event.companyId) });
		if (result.action === "derived" || result.action === "rejected")
			ctx.logger.info(`project-guard: ${result.action}`, { issueId: event.entityId, ...result });
	} catch (err) {
		ctx.logger.warn("project-guard: event handling failed", {
			issueId: event?.entityId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

const plugin = definePlugin({
	async setup(c) {
		ctx = c;
		ctx.events.on("issue.created", onIssue);
		ctx.events.on("issue.updated", onIssue);
	},
	async onHealth() {
		return { status: "ok", message: "project-guard ready" };
	},
});
export default plugin;
runWorker(plugin, import.meta.url);
