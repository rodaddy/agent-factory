import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { handleAsk, handleComment, headerValue } from "./logic.js";

let ctx;

// Config is per company. A webhook carries no company and may not call
// ctx.companies.list, so the caller names it in the x-ask-company header.
function usable(cfg, companyId) {
	return cfg?.token && cfg?.assigneeAgentId
		? { ...cfg, companyId: cfg.companyId || companyId }
		: null;
}

const COMPANY_HEADER = "x-ask-company";
const COMPANY_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The callback URL is stored with the issue it belongs to.
const stateFor = () => {
	const key = (issueId) => ({
		scopeKind: "issue",
		scopeId: issueId,
		namespace: "ask",
		stateKey: "callback",
	});
	return {
		get: (issueId) => ctx.state.get(key(issueId)),
		set: (issueId, value) => ctx.state.set(key(issueId), value),
	};
};

const boardFor = (companyId) => ({
	createIssue: (task) => ctx.issues.create({ companyId, ...task }),
	getIssue: (issueId) => ctx.issues.get(issueId, companyId),
	listComments: (issueId) => ctx.issues.listComments(issueId, companyId),
	updateIssue: (issueId, patch) => ctx.issues.update(issueId, patch, companyId),
});

// Global fetch, not ctx.http.fetch: the host drops private IPs and fleet
// callbacks are on the fleet network. The destination is limited by
// cfg.callbackHosts in logic.js; redirects are refused.
async function post(url, payload) {
	return fetch(url, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
		signal: AbortSignal.timeout(10_000),
		redirect: "error",
	});
}

async function onComment(event) {
	try {
		const cfg = usable(await ctx.config.get(event.companyId), event.companyId);
		if (!cfg) return;
		const result = await handleComment({
			event,
			cfg,
			board: boardFor(cfg.companyId),
			state: stateFor(),
			post,
		});
		if (result.action === "answered")
			ctx.logger.info("ask: answered", { issueId: event.entityId, ...result });
	} catch (err) {
		ctx.logger.warn("ask: comment handling failed", {
			issueId: event?.entityId,
			error: err instanceof Error ? err.message : String(err),
		});
	}
}

const plugin = definePlugin({
	async setup(c) {
		ctx = c;
		ctx.events.on("issue.comment.created", onComment);
	},
	async onHealth() {
		return { status: "ok", message: "ask ready" };
	},
	// The host answers the HTTP caller with only {deliveryId, status}
	// (server routes/plugins.js, POST /plugins/:pluginId/webhooks/:endpointKey):
	// this return value is logged, never sent back. fleet/bin/ask-nagatha finds
	// the new issue by listing the assignee's Ask: issues instead.
	async onWebhook(input) {
		if (input.endpointKey !== "ask") throw new Error(`ask: unknown endpoint ${input.endpointKey}`);
		const companyId = headerValue(input.headers, COMPANY_HEADER);
		if (typeof companyId !== "string" || !COMPANY_ID_RE.test(companyId))
			throw new Error("ask: x-ask-company header missing or not a company id");
		const cfg = usable(await ctx.config.get(companyId), companyId);
		if (!cfg) throw new Error("ask: not configured for this company");
		const secret = await ctx.secrets.resolve(cfg.token, {
			companyId: cfg.companyId,
			configPath: "token",
		});
		const created = await handleAsk({
			headers: input.headers,
			body: input.parsedBody ?? JSON.parse(input.rawBody || "null"),
			secret,
			cfg,
			board: boardFor(cfg.companyId),
			state: stateFor(),
		});
		ctx.logger.info("ask: issue filed", created);
		return created;
	},
});
export default plugin;
runWorker(plugin, import.meta.url);
