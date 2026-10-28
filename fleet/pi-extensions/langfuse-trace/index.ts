/**
 * @module fleet/pi-extensions/langfuse-trace
 * @description Pi run tracing into Langfuse: one trace per Pi
 *   session, a generation per assistant message (Pi's own `usage.cost.total`), a
 *   span per tool call with argument names and output size only. Plain `fetch` to
 *   `/api/public/ingestion`, no SDK. Delivery (`send.ts`, T2): a POST per 50 events
 *   during the session, 5 s timeout, one retry, at most 1000 queued; on
 *   `session_shutdown` the rest flushes within 8 s, then one structured stderr delivery receipt per run, including failures and drops.
 *
 *   Events (Pi extension docs, `docs/extensions.md`, read from installed 0.86.0;
 *   the fleet pin is 1.0.3): `session_start` (:393), `session_shutdown` (:516),
 *   `message_start`/`message_end` (:618), `tool_execution_start`/`_end` (:654).
 *
 *   Env: `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY`, `LANGFUSE_HOST` / `LANGFUSE_BASE_URL` (default
 *   `https://langfuse.example.internal`), `FLEET_EMPLOYEE` (seat), optional
 *   `PAPERCLIP_RUN_ID` (trace id, else a uuid), `LANGFUSE_TRACING_ENVIRONMENT`,
 *   `LANGFUSE_TRACING_ENABLED=false`. Neither key set (seat not configured, T3: every
 *   profile loads this): one structured disabled receipt with the seat/run and safe
 *   reason, and no handlers. Never writes stdout (it belongs to Pi); failures never throw.
 */
import { randomUUID } from "node:crypto";
import * as b from "./batch.ts";
import { makeSender, type SendOpts } from "./send.ts";

type PiEvent = b.ToolCall & { message?: b.PiAssistant & { role?: string }; toolCallId?: string };
type Handler = (event: PiEvent, ctx?: { model?: { id?: string } }) => unknown;
type PiApi = { on: (name: string, handler: Handler) => void };
type Opts = SendOpts & { env?: Record<string, string | undefined>; log?: (line: string) => void };

const stderr = (line: string) => process.stderr.write(`${line}\n`);

export function makeLangfuseTrace(opts: Opts = {}) {
	const env = opts.env ?? process.env;
	const log = opts.log ?? stderr;
	return (pi: PiApi): void => {
		const missing = ["LANGFUSE_PUBLIC_KEY", "LANGFUSE_SECRET_KEY", "FLEET_EMPLOYEE"].filter(
			(k) => !env[k],
		);
		const off =
			env.LANGFUSE_TRACING_ENABLED === "false"
				? "disabled by LANGFUSE_TRACING_ENABLED"
				: missing.length && `off, missing ${missing.join(", ")}`;
		if (off) {
			// T3: every profile loads this; a seat with no Langfuse key at all is unconfigured, not
			// broken. It still says so, once per run (load is once per Pi process), so Loki can show
			// which seats run untraced. Key presence only, never a value.
			const noKeys = !env.LANGFUSE_PUBLIC_KEY && !env.LANGFUSE_SECRET_KEY;
			log(
				JSON.stringify({
					timestamp: new Date().toISOString(),
					level: noKeys ? "info" : "warn",
					message: "langfuse_disabled",
					service: "langfuse-trace",
					correlation_id: env.PAPERCLIP_RUN_ID || "none",
					seat: env.FLEET_EMPLOYEE || "unknown",
					reason:
						env.LANGFUSE_TRACING_ENABLED === "false"
							? "disabled"
							: noKeys
								? "no_keys"
								: "missing_configuration",
					missing,
				}),
			);
			return;
		}
		const host = (
			env.LANGFUSE_HOST ||
			env.LANGFUSE_BASE_URL ||
			"https://langfuse.example.internal"
		).replace(/\/+$/, "");
		const auth = `Basic ${Buffer.from(`${env.LANGFUSE_PUBLIC_KEY}:${env.LANGFUSE_SECRET_KEY}`).toString("base64")}`;
		const trace: b.TraceInfo = {
			id: env.PAPERCLIP_RUN_ID || randomUUID(),
			seat: String(env.FLEET_EMPLOYEE),
			environment: env.LANGFUSE_TRACING_ENVIRONMENT || "software-factory",
			runId: env.PAPERCLIP_RUN_ID || undefined,
		};
		const queue = makeSender(`${host}/api/public/ingestion`, auth, opts);
		const tools = new Map<string, { args: unknown; start: string }>();
		const now = () => new Date().toISOString();
		let genStart: string | undefined;
		let gens = 0;
		let runStart: string | undefined;
		let toolsFailed = 0;
		let generationsFailed = 0;
		const seenMessages = new WeakSet<object>();
		const seenGenerations = new Set<string>();

		pi.on("session_start", (_e, ctx) => {
			trace.model = b.modelName(ctx?.model?.id);
			runStart = now();
			queue.push(b.traceCreate(trace, runStart));
		});
		pi.on("message_start", (e) => {
			if (e?.message?.role === "assistant") genStart = now();
		});
		pi.on("message_end", (e) => {
			if (e?.message?.role !== "assistant") return;
			if (seenMessages.has(e.message)) return;
			seenMessages.add(e.message);
			const end = now();
			const generation = b.generationCreate(trace, gens + 1, e.message, genStart ?? end, end);
			if (seenGenerations.has(generation.id)) return;
			seenGenerations.add(generation.id);
			// Keep callback suppression bounded; older replays still retain stable wire IDs.
			if (seenGenerations.size > 1000)
				seenGenerations.delete(seenGenerations.values().next().value ?? "");
			gens++;
			if (e.message.stopReason === "error") generationsFailed++;
			queue.push(generation);
			genStart = undefined;
		});
		pi.on("tool_execution_start", (e) => {
			tools.set(String(e?.toolCallId), { args: e?.args, start: now() });
		});
		pi.on("tool_execution_end", (e) => {
			const id = String(e?.toolCallId);
			const end = now();
			const started = tools.get(id);
			tools.delete(id);
			if (e?.isError) toolsFailed++;
			queue.push(b.toolSpan(trace, id, { ...e, args: started?.args }, started?.start ?? end, end));
		});
		pi.on("session_shutdown", async () => {
			// Pushed before close() so the run end rides the final flush. maxRSS is this Pi process only.
			const end = now();
			const run = { toolsFailed, generationsFailed, peakRssKb: process.resourceUsage().maxRSS };
			queue.push(b.runSpan(trace, runStart ?? end, end, run));
			queue.push(b.traceEnd(trace, end, run));
			const t = await queue.close();
			log(
				JSON.stringify({
					timestamp: end,
					level: t.failed || t.dropped ? "warn" : "info",
					message: "langfuse_delivery",
					service: "langfuse-trace",
					correlation_id: trace.id,
					seat: trace.seat,
					...t,
				}),
			);
		});
	};
}

export default makeLangfuseTrace();
