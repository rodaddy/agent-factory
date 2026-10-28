/** Executor-only Pi JSONL verification. The launcher must protect the extension,
 * stdout FD, nonce and environment. A report or caller-supplied stream is not an
 * attestation. This inert module never runs a model, signs, stores or publishes. */
import { createHash } from "node:crypto";
import { z } from "zod";

export const CAPTURE_LIMITS = {
	bytes: 8_388_608,
	lines: 20_000,
	lineBytes: 2_097_152,
	reportBytes: 262_144,
} as const;
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const token = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9_.:-]+$/);
const identitySchema = z.strictObject({
	nonce: z.string().regex(/^[a-f0-9]{64}$/),
	attemptId: ref,
	childRunId: ref,
	provider: z.enum(["fleet-proxy", "claudex-proxy"]),
	model: token,
	api: token,
	thinking: z.enum(["low", "medium"]),
});
const expectedSchema = identitySchema.refine(
	(v) =>
		(v.model === "gpt-6.1-sol" && v.thinking === "low") ||
		(v.model === "claude-sonnet-5-5" && v.thinking === "medium"),
);
const runtimeSchema = identitySchema.extend({
	type: z.literal("factory_review_runtime"),
	version: z.literal(1),
});
const terminationSchema = z.strictObject({
	exitCode: z.number().int().nullable(),
	signal: z.string().nullable(),
	timedOut: z.boolean(),
	truncated: z.boolean(),
});
const prose = z.string().trim().min(1).max(4096);
const path = z
	.string()
	.min(1)
	.max(512)
	.refine(
		(p) =>
			!p.startsWith("/") &&
			!p.includes("\\") &&
			!Array.from(p).some((c) => c.charCodeAt(0) <= 31) &&
			p.split("/").every((s) => s !== "" && s !== "." && s !== ".."),
	);
const findingSchema = z.strictObject({
	id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:-]{0,255}$/),
	severity: z.enum(["P0", "P1", "P2", "P3"]),
	path,
	line: z.number().int().positive().max(2_147_483_647),
	title: prose,
	trigger: prose,
	observed: prose,
	suggestedFix: prose,
});
const reportSchema = z
	.strictObject({
		verdict: z.enum(["approve", "fix-first"]),
		findings: z.array(findingSchema).max(256),
		limitations: z.array(prose).max(64),
	})
	.refine((r) => new Set(r.findings.map((f) => f.id)).size === r.findings.length)
	.refine(
		(r) =>
			!r.findings.some((f) => f.severity === "P0" || f.severity === "P1") ||
			r.verdict === "fix-first",
	)
	.refine((r) => r.verdict !== "fix-first" || r.findings.length > 0);

export type CaptureExpected = z.infer<typeof identitySchema>;
export type CaptureTermination = z.infer<typeof terminationSchema>;
export type ChildReport = z.infer<typeof reportSchema>;
export type CaptureFailure =
	| "config"
	| "termination"
	| "bounds"
	| "json"
	| "runtime"
	| "identity"
	| "incomplete"
	| "fatal"
	| "tool_error"
	| "report";
export type TokenUsage = {
	input: number | null;
	output: number | null;
	cacheRead: number | null;
	cacheWrite: number | null;
	reasoning: number | null;
	totalTokens: number | null;
};
export type ReviewCapture = {
	report: ChildReport;
	reportText: string;
	reportSha256: string;
	eventsSha256: string;
	actualIdentity: CaptureExpected;
	usage: TokenUsage;
	usageByMessage: TokenUsage[];
	limitations: string[];
	captureSource: "executor";
	completed: true;
	terminalStatus: "success";
	fatalError: false;
	exitCode: 0;
};
export type CaptureResult =
	| { ok: true; capture: ReviewCapture }
	| { ok: false; reason: CaptureFailure };
type Event = Record<string, unknown> & { type: string };
type Message = Record<string, unknown> & { role: string };
const obj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
class Rejected extends Error {
	reason: CaptureFailure;
	constructor(reason: CaptureFailure) {
		super(reason);
		this.reason = reason;
	}
}
function reject(reason: CaptureFailure): never {
	throw new Rejected(reason);
}
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

function streamLines(bytes: Uint8Array): Event[] {
	if (!bytes.byteLength || bytes.byteLength > CAPTURE_LIMITS.bytes) reject("bounds");
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return reject("json");
	}
	if (!text.endsWith("\n")) reject("incomplete");
	const lines = text.slice(0, -1).split("\n");
	if (lines.length > CAPTURE_LIMITS.lines) reject("bounds");
	return lines.map((line) => {
		if (!line.trim() || Buffer.byteLength(line) > CAPTURE_LIMITS.lineBytes) reject("bounds");
		let e: unknown;
		try {
			e = JSON.parse(line);
		} catch {
			return reject("json");
		}
		if (!obj(e) || typeof e.type !== "string") reject("json");
		return e as Event;
	});
}
function message(v: unknown): Message {
	if (
		!obj(v) ||
		typeof v.role !== "string" ||
		(!Array.isArray(v.content) && !(v.role === "system" && typeof v.content === "string"))
	)
		reject("incomplete");
	return v as Message;
}
function identity(m: Message, expected: CaptureExpected) {
	if (m.provider !== expected.provider || m.model !== expected.model || m.api !== expected.api)
		reject("identity");
	if (m.thinkingLevel !== undefined && m.thinkingLevel !== expected.thinking) reject("identity");
}
function assistant(m: Message, expected: CaptureExpected) {
	identity(m, expected);
	if (m.errorMessage || !["stop", "toolUse"].includes(String(m.stopReason))) reject("fatal");
}
function reportOf(m: Message): { report: ChildReport; reportText: string } {
	if (m.stopReason !== "stop") reject("fatal");
	const content = m.content as unknown[];
	if (content.some((c) => !obj(c) || !["text", "thinking"].includes(String(c.type))))
		reject("report");
	const reportText = content
		.filter((c) => obj(c) && c.type === "text")
		.map((c) => (c as Record<string, unknown>).text)
		.join("\n");
	if (!reportText || Buffer.byteLength(reportText) > CAPTURE_LIMITS.reportBytes) reject("report");
	let value: unknown;
	try {
		value = JSON.parse(reportText);
	} catch {
		return reject("report");
	}
	const parsed = reportSchema.safeParse(value);
	if (!parsed.success) reject("report");
	return { report: parsed.data, reportText };
}
const usageKeys = [
	"input",
	"output",
	"cacheRead",
	"cacheWrite",
	"reasoning",
	"totalTokens",
] as const;
function usageOf(messages: Message[]): { usage: TokenUsage; usageByMessage: TokenUsage[] } {
	const usageByMessage = messages.map(
		(m) =>
			Object.fromEntries(
				usageKeys.map((k) => {
					const value = obj(m.usage) ? m.usage[k] : undefined;
					if (value === undefined) return [k, null];
					if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)
						reject("fatal");
					return [k, value];
				}),
			) as TokenUsage,
	);
	const usage = Object.fromEntries(
		usageKeys.map((k) => {
			const values = usageByMessage.map((u) => u[k]);
			if (values.some((v) => v === null)) return [k, null];
			const sum = (values as number[]).reduce((a, b) => a + b, 0);
			if (!Number.isSafeInteger(sum)) reject("fatal");
			return [k, sum];
		}),
	) as TokenUsage;
	return { usage, usageByMessage };
}

const contentIndex = z.number().int().nonnegative();
const updateSchema = z.discriminatedUnion("type", [
	z.strictObject({ type: z.literal("start") }),
	z.strictObject({ type: z.enum(["text_start", "thinking_start"]), contentIndex }),
	z.strictObject({
		type: z.enum(["text_delta", "thinking_delta", "toolcall_delta"]),
		contentIndex,
		delta: z.string(),
	}),
	z.strictObject({ type: z.enum(["text_end", "thinking_end"]), contentIndex, content: z.string() }),
	z.strictObject({
		type: z.literal("toolcall_start"),
		contentIndex,
		id: z.string().min(1),
		toolName: z.string().min(1),
	}),
	z.strictObject({
		type: z.literal("toolcall_end"),
		contentIndex,
		toolCall: z.object({
			type: z.literal("toolCall"),
			id: z.string().min(1),
			name: z.string().min(1),
			arguments: z.unknown(),
		}),
	}),
	z.strictObject({
		type: z.literal("done"),
		reason: z.enum(["stop", "toolUse"]),
		message: z.unknown(),
	}),
]);
function messageUpdate(e: Event, state: State, expected: CaptureExpected) {
	if (state.openRole !== "assistant") reject("incomplete");
	const parsed = updateSchema.safeParse(e.assistantMessageEvent);
	if (!parsed.success) reject("fatal");
	if (parsed.data.type === "done") assistant(message(parsed.data.message), expected);
}
function messageStart(e: Event, state: State, expected: CaptureExpected) {
	if (!state.turn || state.openRole) reject("incomplete");
	const m = message(e.message);
	if (m.role === "assistant") {
		identity(m, expected);
		if (m.stopReason !== "pending" || m.errorMessage) reject("fatal");
	}
	state.openRole = m.role;
}

type State = {
	started: boolean;
	ended: boolean;
	settled: boolean;
	turn: boolean;
	openRole: string | null;
	runtime: CaptureExpected | null;
	assistants: Message[];
	messages: Message[];
	tools: Map<string, string>;
};
function runtime(e: Event, state: State, expected: CaptureExpected) {
	if (state.runtime || state.started) reject("runtime");
	const parsed = runtimeSchema.safeParse(e);
	if (!parsed.success) reject("runtime");
	const { type: _type, version: _version, ...actual } = parsed.data;
	if (!same(actual, expected)) reject("identity");
	state.runtime = actual;
}
function end(e: Event, state: State) {
	if (
		!state.started ||
		state.ended ||
		state.turn ||
		state.openRole ||
		state.tools.size ||
		!state.assistants.length
	)
		reject("incomplete");
	if (!Array.isArray(e.messages)) reject("incomplete");
	const assistants = e.messages.filter((m) => obj(m) && m.role === "assistant");
	if (
		!same(e.messages, state.messages) ||
		!same(assistants, state.assistants) ||
		!same(e.messages.at(-1), state.assistants.at(-1))
	)
		reject("incomplete");
	state.ended = true;
}
function messageEnd(e: Event, state: State, expected: CaptureExpected) {
	const m = message(e.message);
	if (!state.openRole || state.openRole !== m.role) reject("incomplete");
	state.openRole = null;
	state.messages.push(m);
	if (m.role === "assistant") {
		assistant(m, expected);
		state.assistants.push(m);
	}
	if (m.role === "toolResult" && m.isError === true) reject("tool_error");
}
function tool(e: Event, state: State) {
	if (typeof e.toolCallId !== "string" || typeof e.toolName !== "string") reject("incomplete");
	if (e.type === "tool_execution_start") {
		if (state.tools.has(e.toolCallId)) reject("incomplete");
		state.tools.set(e.toolCallId, e.toolName);
		return;
	}
	if (state.tools.get(e.toolCallId) !== e.toolName) reject("incomplete");
	if (e.type === "tool_execution_end") {
		if (e.isError !== false) reject("tool_error");
		state.tools.delete(e.toolCallId);
	}
}
function event(e: Event, state: State, expected: CaptureExpected) {
	if (
		e.error ||
		e.errorMessage ||
		e.truncated === true ||
		e.type === "factory_review_runtime_error"
	)
		reject("fatal");
	if (state.ended && e.type !== "agent_settled") reject("incomplete");
	switch (e.type) {
		case "factory_review_runtime":
			return runtime(e, state, expected);
		case "session":
			if (state.started) reject("incomplete");
			return;
		case "agent_start":
			if (state.started || !state.runtime) reject("incomplete");
			state.started = true;
			return;
		case "agent_end":
			return end(e, state);
		case "agent_settled":
			if (!state.ended || state.settled || (e.outcome !== undefined && e.outcome !== "completed"))
				reject("fatal");
			state.settled = true;
			return;
		default:
			return activeEvent(e, state, expected);
	}
}
function activeEvent(e: Event, state: State, expected: CaptureExpected) {
	if (!state.started) reject("incomplete");
	switch (e.type) {
		case "turn_start":
			if (state.turn) reject("incomplete");
			state.turn = true;
			return;
		case "turn_end":
			if (
				!state.turn ||
				state.openRole ||
				state.tools.size ||
				!same(e.message, state.assistants.at(-1))
			)
				reject("incomplete");
			state.turn = false;
			return;
		case "message_start":
			return messageStart(e, state, expected);
		case "message_end":
			return messageEnd(e, state, expected);
		case "message_update":
			return messageUpdate(e, state, expected);
		case "tool_execution_start":
		case "tool_execution_update":
		case "tool_execution_end":
			return tool(e, state);
		default:
			return reject("fatal");
	}
}

function captureBytes(bytes: Uint8Array, expected: CaptureExpected): CaptureResult {
	const state: State = {
		started: false,
		ended: false,
		settled: false,
		turn: false,
		openRole: null,
		runtime: null,
		assistants: [],
		messages: [],
		tools: new Map(),
	};
	for (const e of streamLines(bytes)) event(e, state, expected);
	if (!state.ended || !state.runtime) reject("incomplete");
	const last = state.assistants.at(-1);
	if (!last) reject("incomplete");
	const { report, reportText } = reportOf(last);
	return {
		ok: true,
		capture: {
			report,
			reportText,
			reportSha256: hash(reportText),
			eventsSha256: hash(bytes),
			actualIdentity: state.runtime,
			...usageOf(state.assistants),
			limitations: [...report.limitations],
			captureSource: "executor",
			completed: true,
			terminalStatus: "success",
			fatalError: false,
			exitCode: 0,
		},
	};
}

/** Verify executor-captured bytes after process exit. Rejects incomplete/error-only
 * exit0, any tool error, runtime drift, and non-JSON reports. Token counters come
 * from completed messages only; missing classes are null, never inferred or priced.
 * @param events Exact raw UTF8 stdout including its final newline.
 * @param expected Protected fixed-pair identity and opaque per-child binding.
 * @param termination Protected process outcome; never extracted from model text.
 * @returns Verified typed capture or stable redacted refusal category. */
export function parseReviewCapture(
	events: string | Uint8Array,
	expected: CaptureExpected,
	termination: CaptureTermination,
): CaptureResult {
	const config = expectedSchema.safeParse(expected);
	const stopped = terminationSchema.safeParse(termination);
	if (!config.success || !stopped.success) return { ok: false, reason: "config" };
	if (
		stopped.data.exitCode !== 0 ||
		stopped.data.signal !== null ||
		stopped.data.timedOut ||
		stopped.data.truncated
	)
		return { ok: false, reason: "termination" };
	try {
		if (typeof events === "string" && Buffer.byteLength(events) > CAPTURE_LIMITS.bytes)
			reject("bounds");
		const bytes = typeof events === "string" ? Buffer.from(events, "utf8") : events;
		return captureBytes(bytes, config.data);
	} catch (error) {
		return { ok: false, reason: error instanceof Rejected ? error.reason : "json" };
	}
}
