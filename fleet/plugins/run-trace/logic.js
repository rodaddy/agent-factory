// sf#1166: pure functions that turn a heartbeat run and its log into a
// Langfuse ingestion batch. No I/O, no clock, no randomness.

export function parseLogContent(content) {
	const entries = [];
	for (const line of String(content ?? "").split("\n")) {
		if (!line.trim()) continue;
		let env;
		try {
			env = JSON.parse(line);
		} catch {
			continue;
		}
		if (env.stream === "stdout") {
			try {
				entries.push({ ts: env.ts, stream: "stdout", event: JSON.parse(env.chunk) });
			} catch {}
		} else {
			entries.push({ ts: env.ts, stream: env.stream, event: null, text: env.chunk });
		}
	}
	return entries;
}

const textOf = (content) =>
	(Array.isArray(content) ? content : [])
		.filter((b) => b?.type === "text" && typeof b.text === "string")
		.map((b) => b.text)
		.join("\n");

function claudeSteps(entries) {
	const gens = new Map();
	const tools = new Map();
	const order = [];
	for (const { ts, event } of entries) {
		if (!event) continue;
		if (event.type === "assistant") {
			const msg = event.message ?? {};
			let gen = gens.get(msg.id);
			if (!gen) {
				const u = msg.usage ?? {};
				gen = {
					kind: "generation",
					id: msg.id,
					name: "assistant",
					model: msg.model ?? null,
					input: null,
					output: "",
					startTime: ts,
					endTime: ts,
					usage: {
						input: u.input_tokens ?? 0,
						output: u.output_tokens ?? 0,
						cacheRead: u.cache_read_input_tokens ?? 0,
						cacheCreation: u.cache_creation_input_tokens ?? 0,
					},
					isError: false,
				};
				gens.set(msg.id, gen);
				order.push(gen);
			}
			gen.endTime = ts;
			const text = textOf(msg.content);
			if (text) gen.output = gen.output ? `${gen.output}\n${text}` : text;
			for (const b of msg.content ?? []) {
				if (b?.type !== "tool_use") continue;
				const tool = {
					kind: "tool",
					id: b.id,
					name: b.name,
					model: null,
					input: b.input,
					output: null,
					startTime: ts,
					endTime: null,
					usage: null,
					isError: false,
				};
				tools.set(b.id, tool);
				order.push(tool);
			}
		} else if (event.type === "user") {
			for (const b of event.message?.content ?? []) {
				const tool = b?.type === "tool_result" && tools.get(b.tool_use_id);
				if (!tool) continue;
				tool.output = b.content;
				tool.isError = Boolean(b.is_error);
				tool.endTime = ts;
			}
		}
	}
	return order;
}

// Bifrost (v2.0.0) reports prompt_tokens with the cached tokens counted twice
// for claudex models, and pi-ai subtracts them once (openai-completions.js), so
// pi's `input` from provider "bifrost" still carries the cache. Measured on
// a fleet host 2026-10-05: input 88959 with cacheRead 81920, then the next turn read
// 88576 from cache, which only fits a whole prompt of about 89k (SOF-5117).
// Langfuse wants `input` without the cache.
function piUsage(provider, u) {
	const input = u.input ?? 0;
	const cacheRead = u.cacheRead ?? 0;
	const uncached = provider === "bifrost" ? Math.max(0, input - cacheRead) : input;
	return { input: uncached, output: u.output ?? 0, cacheRead, cacheCreation: u.cacheWrite ?? 0 };
}

function piSteps(entries) {
	const tools = new Map();
	const order = [];
	let lastTs = null;
	for (const { ts, event } of entries) {
		if (!event) continue;
		if (event.type === "message_end" && event.message?.role === "assistant") {
			const msg = event.message;
			const u = msg.usage ?? {};
			order.push({
				kind: "generation",
				id: `gen-${order.filter((s) => s.kind === "generation").length}`,
				name: "assistant",
				model: msg.model ?? null,
				provider: msg.provider ?? null,
				input: null,
				output: textOf(msg.content),
				startTime: lastTs ?? ts,
				endTime: ts,
				usage: msg.usage && Object.keys(msg.usage).length ? piUsage(msg.provider, u) : null,
				isError: msg.stopReason === "error",
			});
		} else if (event.type === "tool_execution_start") {
			const tool = {
				kind: "tool",
				id: event.toolCallId,
				name: event.toolName,
				model: null,
				input: event.args,
				output: null,
				startTime: ts,
				endTime: null,
				usage: null,
				isError: false,
			};
			tools.set(event.toolCallId, tool);
			order.push(tool);
		} else if (event.type === "tool_execution_end") {
			const tool = tools.get(event.toolCallId);
			if (tool) {
				tool.output = textOf(event.result?.content);
				tool.isError = Boolean(event.isError);
				tool.endTime = ts;
			}
		}
		if (event.type === "message_start" || event.type === "turn_start") lastTs = ts;
	}
	return order;
}

export function extractSteps(adapterType, entries) {
	if (adapterType === "claude_local") return claudeSteps(entries);
	if (adapterType === "pi_local") return piSteps(entries);
	return [];
}

export function truncate(text, max = 4000) {
	const s = String(text ?? "");
	if (s.length <= max) return s;
	return `${s.slice(0, max)}…[truncated ${s.length - max} chars]`;
}

const SECRET_PATTERNS = [
	/sk-[A-Za-z0-9_-]{16,}/g,
	/pcp_[A-Za-z0-9_]{16,}/g,
	// A bare 40-hex value: Forge tokens are exactly this; full git shas are lost too (PR 1200 round 10).
	/\b[0-9a-f]{40}\b/gi,
	/\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g,
	/eyJ[\w-]+\.[\w-]+\.[\w-]+/g,
];
// Credential-keyed content is withheld WHOLE: a credential key followed by a
// separator anywhere in a step's input or output replaces the entire text. Partial
// redaction leaked through escapes, quotes, spaces and multi-line values in six
// review rounds (PR 1200); withholding the step has no such edge.
const CREDENTIAL_KEYED =
	/(?:token|secret|password|passwd|api[-_]?key|access[-_]?key|private[-_]?key|authorization|cookie)\\*["']?\s*[:=]/i;
// .netrc style: `password <value>` with only whitespace between (PR 1200 round 8).
const PASSWORD_SPACED = /\bpass(?:word|wd)\s+\S/i;
// A URL with a user:secret@ part (PR 1200 round 9).
const URL_USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i;
// A PEM private key block (OpenSSH, RSA, EC, PKCS8): withheld whole too (PR 1200 round 7).
const PRIVATE_KEY_BLOCK = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
// An auth scheme followed by a credential: Forge tokens are bare 40-hex (PR 1200, P1).
const AUTH_SCHEME = /(\b(?:token|bearer|basic)\s+)[A-Za-z0-9._~+/=-]{16,}/gi;

export function redact(text) {
	let s = String(text ?? "");
	for (const re of SECRET_PATTERNS) s = s.replace(re, "REDACTED");
	s = s.replace(AUTH_SCHEME, "$1REDACTED");
	if (
		CREDENTIAL_KEYED.test(s) ||
		PASSWORD_SPACED.test(s) ||
		PRIVATE_KEY_BLOCK.test(s) ||
		URL_USERINFO.test(s)
	)
		return "REDACTED: credential content withheld";
	return s;
}

const clean = (value) => {
	if (value === null || value === undefined) return value;
	const s = typeof value === "string" ? value : JSON.stringify(value);
	return truncate(redact(s));
};

const toolArgs = (input) =>
	input && typeof input === "object" && !Array.isArray(input)
		? { args: Object.keys(input) }
		: { args: [] };

const event = (type, timestamp, body) => ({ id: `${body.id}-event`, type, timestamp, body });

/** One name per model: `bifrost/claudex/gpt-6-luna` and `gpt-6-luna` are one model. */
export function modelName(model) {
	return typeof model === "string" && model ? model.split("/").pop() : model;
}

export function providerFamily(model) {
	const name = modelName(model) ?? "";
	if (/^(gpt-|o[1-9](?:[-.]|$))/.test(name)) return "openai";
	return String(name).startsWith("claude-") ? "anthropic" : "unknown";
}

/**
 * `canonicalDelivery` is trace.js's verdict on the Pi exporter's receipt. Only
 * `canonical_delivery_missing` (no receipt, and this run logged `langfuse_disabled`,
 * so nothing was exported) lets replay price Pi usage. An incomplete direct
 * delivery is never topped up, and `canonical_delivery_unknown` (no receipt, no
 * disabled line) is never priced: either could double count exported usage.
 */
export function buildIngestionBatch(
	run,
	steps,
	{ environment = "software-factory", canonicalDelivery } = {},
) {
	const ctx = run.contextSnapshot ?? {};
	const usage = run.usageJson ?? {};
	const adapterType =
		run.runnerProfileJson?.adapterDispatch?.adapterType ?? run.adapterType ?? null;
	const isPi = adapterType === "pi_local";
	const replayFallback = isPi && canonicalDelivery === "canonical_delivery_missing";
	const batch = [
		event("trace-create", run.startedAt, {
			id: run.id,
			name: `${run.agentName ?? run.agentId} ${ctx.wakeReason ?? ""}`.trim(),
			timestamp: run.startedAt,
			userId: run.agentName ?? run.agentId,
			sessionId: ctx.issueId,
			environment,
			tags: [adapterType, run.status].filter(Boolean),
			metadata: {
				provider_family: providerFamily(usage.model),
				transport_provider: usage.transportProvider ?? null,
				cost_basis:
					typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
						? "api_equivalent_estimate"
						: "unknown",
				api_equivalent_cost_usd:
					typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd >= 0
						? usage.costUsd
						: null,
				billed_cost_usd: null,
				subscription_quota: null,
				agentId: run.agentId,
				issueId: ctx.issueId,
				adapterType,
				status: run.status,
				wakeReason: ctx.wakeReason,
				usageSource: usage.usageSource,
				costUsd: usage.costUsd,
				model: modelName(usage.model),
				inputTokens: usage.inputTokens,
				outputTokens: usage.outputTokens,
				cachedInputTokens: usage.cachedInputTokens,
				...(isPi
					? {
							source: "run-trace",
							canonicalUsage: false,
							paperclip_run_id: run.id,
							costUsd: usage.costUsd ?? null,
							inputTokens: usage.inputTokens ?? null,
							outputTokens: usage.outputTokens ?? null,
							cachedInputTokens: usage.cachedInputTokens ?? null,
						}
					: {}),
				...(canonicalDelivery ? { canonicalDelivery } : {}),
			},
		}),
	];
	const gens = steps.filter((s) => s.kind === "generation");
	const tokens = (s) => (s.usage?.input ?? 0) + (s.usage?.output ?? 0);
	const totalTokens = gens.reduce((n, s) => n + tokens(s), 0);
	const costUsd =
		typeof usage.costUsd === "number" && Number.isFinite(usage.costUsd) && usage.costUsd > 0
			? usage.costUsd
			: 0;
	const costShare = (s) => {
		const share = totalTokens > 0 ? tokens(s) / totalTokens : 1 / gens.length;
		return Math.round(costUsd * share * 1e6) / 1e6;
	};
	for (const step of steps) {
		const body = {
			id: `${run.id}:${step.id}`,
			traceId: run.id,
			name: step.name,
			startTime: step.startTime,
			endTime: step.endTime ?? step.startTime,
			// Tool content never leaves the box: eleven review rounds found a new secret
			// shape in tool I/O each time (PR 1200). A tool span carries the argument
			// names and the output size; the full run log stays on the board.
			input: step.kind === "tool" ? toolArgs(step.input) : clean(step.input),
			output:
				step.kind === "tool" ? { chars: String(step.output ?? "").length } : clean(step.output),
			environment,
		};
		// Pi writes generations directly. Log replay is diagnostic, even if the
		// board reports a cost: a partial log cannot apportion authoritative usage.
		if (step.kind === "generation" && isPi && !replayFallback) {
			body.metadata = {
				source: "run-trace",
				canonicalUsage: false,
				paperclip_run_id: run.id,
				model: modelName(step.model ?? usage.model),
				provider_family: providerFamily(step.model ?? usage.model),
				transport_provider: step.provider ?? null,
				observedLogUsage: step.usage ?? null,
			};
			if (step.isError) body.level = "ERROR";
			batch.push(event("span-create", step.startTime, body));
			continue;
		}
		if (step.kind === "generation") {
			const u = step.usage ?? { input: 0, output: 0 };
			body.model = modelName(step.model ?? usage.model);
			body.metadata = {
				provider_family: providerFamily(body.model),
				transport_provider: step.provider ?? null,
				cost_basis: costUsd > 0 ? "api_equivalent_estimate" : "unknown",
				billed_cost_usd: null,
				subscription_quota: null,
				cost_allocation: "board_run_token_share",
				...(replayFallback
					? { canonicalUsage: true, source: "run-trace", canonicalSource: "replay-fallback" }
					: {}),
			};
			body.usage = { input: u.input, output: u.output, total: u.input + u.output };
			// Langfuse's own names: OpenAI models price `input_cached_tokens`.
			const cacheKey =
				providerFamily(body.model) === "openai" ? "input_cached_tokens" : "cache_read_input_tokens";
			body.usageDetails = {
				input: u.input,
				output: u.output,
				[cacheKey]: u.cacheRead ?? 0,
				cache_creation_input_tokens: u.cacheCreation ?? 0,
			};
			if (costUsd > 0) body.costDetails = { total: costShare(step) };
			batch.push(event("generation-create", step.startTime, body));
		} else {
			if (step.isError) body.level = "ERROR";
			batch.push(event("span-create", step.startTime, body));
		}
	}
	return batch;
}
