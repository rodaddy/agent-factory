/**
 * @module fleet/pi-extensions/langfuse-trace/batch
 * @description Pure Langfuse ingestion event builders for the Pi langfuse-trace
 *   extension. No I/O. Same wire shape as run-trace
 *   (`fleet/plugins/run-trace/logic.js`); `redact`/`truncate` are a copy of its
 *   helpers because Pi loads this file on its own (a drift test pins them equal).
 */

import { createHash } from "node:crypto";

type Body = Record<string, unknown>;
export type IngestionEvent = { id: string; type: string; timestamp: string; body: Body };
export type TraceInfo = {
	id: string;
	seat: string;
	environment: string;
	model?: string;
	runId?: string;
};
type PiUsage = {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	reasoning?: number;
	cost?: { total?: number };
};
export type PiAssistant = {
	model?: string;
	provider?: string;
	timestamp?: number;
	stopReason?: string;
	usage?: PiUsage;
	content?: unknown;
};
/** A Pi `tool_execution_end` event with the args from its `tool_execution_start`. */
export type ToolCall = { toolName?: string; args?: unknown; result?: unknown; isError?: boolean };

export function truncate(text: string, max = 4000): string {
	return text.length <= max ? text : `${text.slice(0, max)}…[truncated ${text.length - max} chars]`;
}

// Copied from run-trace `logic.js`; keep in step (tests/fleet/langfuse-trace.test.ts "redact copy").
const SECRET_PATTERNS = [
	/sk-[A-Za-z0-9_-]{16,}/g,
	/pcp_[A-Za-z0-9_]{16,}/g,
	/\b[0-9a-f]{40}\b/gi,
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
	/eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
];
const WITHHOLD_WHOLE = [
	/(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie)\\*["']?\s*[:=]/i,
	/\bpass(?:word|wd)\s+\S/i,
	/-----BEGIN [A-Z ]*PRIVATE KEY-----/,
	/[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i,
];
const AUTH_SCHEME = /(\b(?:token|bearer|basic)\s+)[A-Za-z0-9._~+/=-]{16,}/gi;

export function redact(text: unknown): string {
	let s = String(text ?? "");
	for (const re of SECRET_PATTERNS) s = s.replace(re, "REDACTED");
	s = s.replace(AUTH_SCHEME, "$1REDACTED");
	return WITHHOLD_WHOLE.some((re) => re.test(s)) ? "REDACTED: credential content withheld" : s;
}

/** One name per model: `bifrost/claudex/gpt-6-luna` is `gpt-6-luna`. */
export function modelName(model: unknown): string | undefined {
	return typeof model === "string" && model ? model.split("/").pop() : undefined;
}

/** Model family is independent of transport, authentication and invoice charges. */
export function providerFamily(model: unknown): "openai" | "anthropic" | "unknown" {
	const name = modelName(model) ?? "";
	if (/^(gpt-|o[1-9](?:[-.]|$))/.test(name)) return "openai";
	return name.startsWith("claude-") ? "anthropic" : "unknown";
}

const known = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;

/** The text blocks of a Pi content array (tool calls and thinking are skipped). */
function texts(content: unknown): string[] {
	if (!Array.isArray(content)) return [];
	return content.filter((c) => c?.type === "text").map((c) => String(c.text ?? ""));
}

/** `suffix` keeps the event id unique when a body id is sent twice (the run-end trace upsert). */
const event = (type: string, timestamp: string, body: Body & { id: string }, suffix = "") => ({
	id: `${body.id}-event${suffix}`,
	type,
	timestamp,
	body,
});

const traceMetadata = (t: TraceInfo) => ({
	seat: t.seat,
	model: t.model,
	harness: "pi",
	paperclip_run_id: t.runId,
});

export function traceCreate(t: TraceInfo, at: string): IngestionEvent {
	return event("trace-create", at, {
		id: t.id,
		name: t.seat,
		timestamp: at,
		userId: t.seat,
		sessionId: t.id,
		environment: t.environment,
		tags: ["pi_local", `profile:${t.seat}`, t.model && `model:${t.model}`].filter(Boolean),
		metadata: traceMetadata(t),
	});
}

/**
 * What the run end knows. `peakRssKb` is `process.resourceUsage().maxRSS`: the Pi
 * Node process only, not the bash children Pi spawns.
 */
export type RunEnd = { toolsFailed: number; generationsFailed: number; peakRssKb: number };

const failed = (s: RunEnd) => s.toolsFailed > 0 || s.generationsFailed > 0;

const observation = (t: TraceInfo, id: string, name: string, start: string, end: string) => ({
	id: `${t.id}:${id}`,
	traceId: t.id,
	name,
	startTime: start,
	endTime: end,
	environment: t.environment,
});

/** A generation per assistant message: tokens and Pi's own `usage.cost.total`; text redacted, cut to 4000. */
export function generationCreate(
	t: TraceInfo,
	n: number,
	m: PiAssistant,
	start: string,
	end: string,
) {
	const u = m.usage ?? {};
	// Bifrost counts cached tokens inside input, so subtract them as run-trace logic.js piUsage does (SOF-5117).
	const input =
		m.provider === "bifrost" && known(u.input) && known(u.cacheRead)
			? Math.max(0, u.input - u.cacheRead)
			: u.input;
	const family = providerFamily(m.model ?? t.model);
	const cacheKey = family === "openai" ? "input_cached_tokens" : "cache_read_input_tokens";
	const details = Object.fromEntries(
		Object.entries({
			input,
			output: u.output,
			[cacheKey]: u.cacheRead,
			cache_creation_input_tokens: u.cacheWrite,
		}).filter(([, value]) => known(value)),
	);
	const complete = known(input) && known(u.output);
	const estimate = known(u.cost?.total) ? u.cost.total : null;
	// Pi timestamps survive callback replay and process restart. The digest distinguishes
	// messages sharing a timestamp without exporting private text as an identifier.
	let identity: string | number = n;
	if (known(m.timestamp)) {
		try {
			const digest = JSON.stringify([m.model, m.provider, m.stopReason, m.usage, m.content]);
			identity = `${m.timestamp}-${createHash("sha256").update(digest).digest("hex").slice(0, 20)}`;
		} catch {
			// A BigInt or circular value cannot be digested; the counter id still queues it.
		}
	}
	const body: Body & { id: string } = {
		...observation(t, `pi-gen-${identity}`, "assistant", start, end),
		model: modelName(m.model) ?? t.model,
		output: truncate(redact(texts(m.content).join("\n"))),
		// Exporter ownership only; this is not provider execution or invoice proof.
		metadata: {
			stop_reason: m.stopReason,
			source: "pi-direct",
			canonicalUsage: true,
			paperclip_run_id: t.runId,
			provider_family: family,
			transport_provider: m.provider ?? null,
			usage_status: complete ? "reported" : Object.keys(details).length ? "partial" : "unknown",
			reasoning_tokens: known(u.reasoning) ? u.reasoning : null,
			cost_basis: estimate === null ? "unknown" : "api_equivalent_estimate",
			api_equivalent_cost_usd: estimate,
			billed_cost_usd: null,
			subscription_quota: null,
		},
	};
	// Reasoning is an output subset, not added again.
	if (complete)
		body.usage = {
			input,
			output: u.output,
			total:
				(input ?? 0) +
				(u.output ?? 0) +
				(known(u.cacheRead) ? u.cacheRead : 0) +
				(known(u.cacheWrite) ? u.cacheWrite : 0),
		};
	if (Object.keys(details).length) body.usageDetails = details;
	if (estimate !== null) body.costDetails = { total: estimate };
	if (m.stopReason === "error") body.level = "ERROR";
	return event("generation-create", start, body);
}

/** A tool span: argument NAMES and output size only; tool content never leaves the box (PR 1200). */
export function toolSpan(t: TraceInfo, id: string, call: ToolCall, start: string, end: string) {
	const a = call.args;
	const body: Body & { id: string } = {
		...observation(t, `pi-tool-${id}`, String(call.toolName ?? "tool"), start, end),
		input: { args: a && typeof a === "object" && !Array.isArray(a) ? Object.keys(a) : [] },
		output: {
			chars: texts((call.result as { content?: unknown } | null)?.content).join("").length,
		},
	};
	if (call.isError) body.level = "ERROR";
	return event("span-create", start, body);
}

/** The root `pi-run` span: run start to shutdown, ERROR when any tool or generation failed. */
export function runSpan(t: TraceInfo, start: string, end: string, s: RunEnd): IngestionEvent {
	return event("span-create", start, {
		...observation(t, "pi-run", "pi-run", start, end),
		level: failed(s) ? "ERROR" : "DEFAULT",
		statusMessage: `tools_failed=${s.toolsFailed} generations_failed=${s.generationsFailed}`,
		metadata: { peak_rss_kb_pi_process: s.peakRssKb },
	});
}

/** A second trace-create for the same trace id (Langfuse upserts by id), event id `-end`. */
export function traceEnd(t: TraceInfo, at: string, s: RunEnd): IngestionEvent {
	const body = {
		id: t.id,
		environment: t.environment,
		metadata: {
			...traceMetadata(t),
			status: failed(s) ? "error" : "ok",
			ended_at: at,
			peak_rss_kb_pi_process: s.peakRssKb,
		},
	};
	return event("trace-create", at, body, "-end");
}
