import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { HttpError, traceRun, withRetry } from "./trace.js";

let ctx;

const EVENTS = ["agent.run.finished", "agent.run.failed", "agent.run.cancelled"];
const SECRET_KEYS = ["boardApiKey", "langfusePublicKey", "langfuseSecretKey"];

const SECRET_TTL_MS = 10 * 60 * 1000;
// companyId -> { secrets, at }: the host rate-limits secret resolution.
const secretCache = new Map();
const inFlight = new Map();
const completed = new Map();
const REPLAY_TTL_MS = 10 * 60 * 1000;
const MAX_REPLAYS = 1000;

async function resolveSecrets(companyId, config) {
	const hit = secretCache.get(companyId);
	if (hit && Date.now() - hit.at < SECRET_TTL_MS) return hit.secrets;
	const secrets = await withRetry(async () => {
		const out = {};
		for (const key of SECRET_KEYS)
			out[key] = await ctx.secrets.resolve(config?.[key], { companyId, configPath: key });
		return out;
	});
	secretCache.set(companyId, { secrets, at: Date.now() });
	return secrets;
}

async function onRunEvent(event) {
	const runId = event.payload?.runId ?? event.entityId;
	const key = JSON.stringify([event.companyId, runId]);
	const at = Date.now();
	for (const [id, expires] of completed) if (expires <= at) completed.delete(id);
	if (completed.has(key)) return;
	if (inFlight.has(key)) return inFlight.get(key);
	if (inFlight.size >= MAX_REPLAYS) {
		ctx.logger.warn(
			JSON.stringify({
				message: "run_trace_replay_limit",
				correlation_id: runId,
				company_id: event.companyId,
			}),
		);
		return;
	}
	const replay = exportRun(event, runId)
		.then((ok) => {
			if (!ok) return;
			completed.set(key, Date.now() + REPLAY_TTL_MS);
			if (completed.size > MAX_REPLAYS) completed.delete(completed.keys().next().value);
		})
		.finally(() => inFlight.delete(key));
	inFlight.set(key, replay);
	return replay;
}

async function exportRun(event, runId) {
	try {
		const config = await ctx.config.get(event.companyId);
		// Global fetch, not ctx.http.fetch: the host drops private IPs and both
		// the board and Langfuse resolve private (sdk-shapes.md section 2).
		const attempt = async () =>
			traceRun({
				runId,
				companyId: event.companyId,
				config,
				fetchImpl: fetch,
				secrets: await resolveSecrets(event.companyId, config),
			});
		let out;
		try {
			out = await attempt();
		} catch (err) {
			if (!(err instanceof Error && err.message.includes(" -> 401"))) throw err;
			secretCache.delete(event.companyId);
			out = await attempt();
		}
		const ok = out.events > 0 && out.errors === 0 && out.successes === out.events;
		ctx.logger[ok && !out.diagnostics.length ? "info" : "warn"](
			JSON.stringify({
				message: "run_trace_delivery",
				company_id: event.companyId,
				correlation_id: runId,
				...out,
			}),
		);
		return ok;
	} catch (err) {
		ctx.logger.warn(
			JSON.stringify({
				message: "run_trace_failed",
				company_id: event.companyId,
				correlation_id: runId,
				reason: err instanceof HttpError ? `http_${err.status}` : "request_or_response_failure",
			}),
		);
		return false;
	}
}

const plugin = definePlugin({
	async setup(c) {
		ctx = c;
		inFlight.clear();
		completed.clear();
		secretCache.clear();
		for (const name of EVENTS) ctx.events.on(name, onRunEvent);
	},
	async onHealth() {
		return { status: "ok", message: "run-trace ready" };
	},
});
export default plugin;
runWorker(plugin, import.meta.url);
