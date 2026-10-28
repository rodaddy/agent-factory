import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { parseReviewCapture, type CaptureExpected } from "../../fleet/review/capture.ts";
import {
	installRuntimeCapture,
	type RuntimeCaptureApi,
} from "../../fleet/review/runtime-capture.ts";

const expected: CaptureExpected = {
	nonce: "b".repeat(64),
	attemptId: "attempt-1",
	childRunId: "child-1",
	provider: "fleet-proxy",
	model: "gpt-6.1-sol",
	api: "openai-completions",
	thinking: "low",
};
const termination = { exitCode: 0, signal: null, timedOut: false, truncated: false };
const report = { verdict: "approve", findings: [], limitations: [] };
const recorded = readFileSync(
	new URL("../fixtures/pi-stream/pi-run.jsonl", import.meta.url),
	"utf8",
)
	.trim()
	.split("\n")
	.map((line) => JSON.parse(line));
const recordedAssistant = recorded
	.filter((e) => e.type === "message_end" && e.message.role === "assistant")
	.at(-1).message;
const assistant = (text = JSON.stringify(report)) => ({
	...recordedAssistant,
	provider: expected.provider,
	model: expected.model,
	api: expected.api,
	thinkingLevel: expected.thinking,
	content: [{ type: "text", text }],
	stopReason: "stop",
});
const runtime = (overrides = {}) => ({
	type: "factory_review_runtime",
	version: 1,
	...expected,
	...overrides,
});
function events(text = JSON.stringify(report)): Array<Record<string, unknown> & { type: string }> {
	const msg = assistant(text);
	return [
		runtime(),
		{ type: "session", version: 3, id: "session-1" },
		{ type: "agent_start" },
		{ type: "turn_start" },
		{ type: "message_start", message: { ...msg, content: [], stopReason: "pending" } },
		{
			type: "message_update",
			usage: msg.usage,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text },
		},
		{ type: "message_end", message: msg },
		{ type: "turn_end", message: msg, toolResults: [] },
		{ type: "agent_end", messages: [msg] },
		{ type: "agent_settled", outcome: "completed" },
	];
}
const jsonl = (es: unknown[]) => `${es.map((e) => JSON.stringify(e)).join("\n")}\n`;
const capture = (es: unknown[] = events(), end = termination) =>
	parseReviewCapture(jsonl(es), expected, end);
const rejects = (es: unknown[], reason?: string) => {
	const r = capture(es);
	assert.equal(r.ok, false);
	if (!r.ok && reason) assert.equal(r.reason, reason);
};

test("recorded Pi event shape captures exact final report, identity, bytes and usage once", () => {
	const bytes = jsonl(events());
	const r = parseReviewCapture(bytes, expected, termination);
	assert.equal(r.ok, true);
	if (!r.ok) return;
	assert.deepEqual(r.capture.report, report);
	assert.deepEqual(r.capture.actualIdentity, expected);
	assert.equal(r.capture.reportText, JSON.stringify(report));
	assert.equal(r.capture.eventsSha256, createHash("sha256").update(bytes).digest("hex"));
	assert.equal(
		r.capture.reportSha256,
		createHash("sha256").update(JSON.stringify(report)).digest("hex"),
	);
	assert.equal(r.capture.usage.input, recordedAssistant.usage.input);
	assert.equal(r.capture.usage.cacheRead, recordedAssistant.usage.cacheRead);
	assert.equal(r.capture.usage.cacheWrite, recordedAssistant.usage.cacheWrite);
	assert.equal(r.capture.usage.output, recordedAssistant.usage.output);
});

for (const [name, change] of Object.entries({
	"no runtime record": (es: ReturnType<typeof events>) =>
		es.filter((e) => e.type !== "factory_review_runtime"),
	"duplicate runtime": (es: ReturnType<typeof events>) => [runtime(), ...es],
	"wrong model": (es: ReturnType<typeof events>) => [
		runtime({ model: "claude-opus-5-5" }),
		...es.slice(1),
	],
	"wrong effort": (es: ReturnType<typeof events>) => [
		runtime({ thinking: "medium" }),
		...es.slice(1),
	],
	"wrong nonce": (es: ReturnType<typeof events>) => [
		runtime({ nonce: "c".repeat(64) }),
		...es.slice(1),
	],
	"wrong child": (es: ReturnType<typeof events>) => [
		runtime({ childRunId: "child-2" }),
		...es.slice(1),
	],
	"wrong attempt": (es: ReturnType<typeof events>) => [
		runtime({ attemptId: "attempt-2" }),
		...es.slice(1),
	],
	"no terminal": (es: ReturnType<typeof events>) =>
		es.filter((e) => !["agent_end", "agent_settled"].includes(e.type)),
	"error-only exit0": () => [runtime(), { type: "error", message: "provider failed" }],
	"runtime drift": (es: ReturnType<typeof events>) => [
		...es,
		{ type: "factory_review_runtime_error", version: 1, code: "identity_changed" },
	],
	"events after terminal": (es: ReturnType<typeof events>) => [...es, { type: "agent_start" }],
}))
	test(`refuses ${name}`, () => rejects(change(events())));

test("refuses malformed, truncated, overbound, invalid UTF8 and blank JSONL", () => {
	for (const data of [
		jsonl(events()).slice(0, -1),
		`${jsonl(events())}{bad}\n`,
		"\n",
		"x".repeat(8_388_609),
		new Uint8Array([255, 10]),
	]) {
		assert.equal(parseReviewCapture(data, expected, termination).ok, false);
	}
});
test("process termination is executor input; nonzero, signal, timeout and truncation refuse", () => {
	for (const end of [
		{ ...termination, exitCode: 1 },
		{ ...termination, exitCode: null },
		{ ...termination, signal: "SIGTERM" },
		{ ...termination, timedOut: true },
		{ ...termination, truncated: true },
	]) {
		assert.equal(parseReviewCapture(jsonl(events()), expected, end).ok, false);
	}
});
test("model output containing a runtime record cannot supply identity", () => {
	rejects(events(JSON.stringify(runtime())).filter((e) => e.type !== "factory_review_runtime"));
	rejects(events(JSON.stringify({ ...report, actualIdentity: expected })));
});
test("message identity, effort, fatal stops and non-normal final stop refuse", () => {
	for (const patch of [
		{ model: "other" },
		{ api: "other" },
		{ provider: "other" },
		{ thinkingLevel: "high" },
		{ stopReason: "error" },
		{ stopReason: "aborted" },
		{ stopReason: "length" },
		{ errorMessage: "fatal" },
	]) {
		const es = events();
		const msg = { ...assistant(), ...patch };
		es[6] = { type: "message_end", message: msg };
		es[7] = { type: "turn_end", message: msg, toolResults: [] };
		es[8] = { type: "agent_end", messages: [msg] };
		rejects(es);
	}
});
test("complete transcript refuses missing message end, unmatched tools or mismatched agent_end", () => {
	const noEnd = events().filter((e) => e.type !== "message_end");
	rejects(noEnd);
	const mismatch = events();
	mismatch[8] = { type: "agent_end", messages: [assistant("{}")] };
	rejects(mismatch);
	const tools = events();
	tools.splice(6, 0, { type: "tool_execution_start", toolCallId: "t1", toolName: "read" });
	rejects(tools);
});
test("strict ChildReport rejects narrative, duplicate finding IDs, invalid paths/lines and inconsistent verdicts", () => {
	const finding = {
		id: "F1",
		severity: "P1",
		path: "src/a.ts",
		line: 1,
		title: "title",
		trigger: "trigger",
		observed: "observed",
		suggestedFix: "fix",
	};
	for (const text of [
		"```json\n{}\n```",
		"approve",
		JSON.stringify({ ...report, findings: [finding] }),
		JSON.stringify({ verdict: "fix-first", findings: [], limitations: [] }),
		JSON.stringify({ verdict: "fix-first", findings: [finding, finding], limitations: [] }),
		JSON.stringify({
			verdict: "fix-first",
			findings: [{ ...finding, path: "../a" }],
			limitations: [],
		}),
		JSON.stringify({ verdict: "fix-first", findings: [{ ...finding, line: 0 }], limitations: [] }),
	])
		rejects(events(text));
	const r = capture(
		events(JSON.stringify({ verdict: "fix-first", findings: [finding], limitations: [] })),
	);
	assert.equal(r.ok, true);
});
test("tool errors fail explicitly, never hidden by a final approving report", () => {
	const es = events();
	es.splice(
		6,
		0,
		{ type: "tool_execution_start", toolCallId: "t1", toolName: "read" },
		{
			type: "tool_execution_end",
			toolCallId: "t1",
			toolName: "read",
			result: { content: [{ type: "text", text: "failed" }] },
			isError: true,
		},
	);
	rejects(es, "tool_error");
});

function extension() {
	const handlers = new Map<
		string,
		(event: unknown, context: { model: { provider: string; id: string; api: string } }) => unknown
	>();
	const emitted: string[] = [];
	let thinking = expected.thinking;
	const pi: RuntimeCaptureApi = {
		on: (name, fn) => {
			handlers.set(name, fn);
		},
		getThinkingLevel: () => thinking,
	};
	installRuntimeCapture(
		pi,
		{ nonce: expected.nonce, attemptId: expected.attemptId, childRunId: expected.childRunId },
		(line) => emitted.push(line),
	);
	const ctx = { model: { provider: expected.provider, id: expected.model, api: expected.api } };
	return {
		emitted,
		ctx,
		fire: (name: string, event: unknown = {}) => handlers.get(name)?.(event, ctx),
		setThinking: (v: "low" | "medium") => {
			thinking = v;
		},
	};
}
test("trusted extension emits one raw machine record with actual ctx identity and effort", () => {
	const ext = extension();
	ext.fire("before_agent_start");
	ext.fire("before_provider_request");
	ext.fire("agent_end");
	assert.equal(ext.emitted.length, 1);
	assert.deepEqual(JSON.parse(ext.emitted[0] ?? ""), runtime());
});
test("extension fails closed on model/effort changes and repeated starts", () => {
	for (const what of ["model", "effort", "reentry"]) {
		const ext = extension();
		ext.fire("before_agent_start");
		if (what === "model") ext.ctx.model.id = "other";
		if (what === "effort") ext.setThinking("medium");
		assert.throws(() =>
			ext.fire(what === "reentry" ? "before_agent_start" : "before_provider_request"),
		);
		assert.equal(JSON.parse(ext.emitted.at(-1) ?? "").type, "factory_review_runtime_error");
	}
});

// The recorded fixture supplies every real event wrapper and message kind. Only
// assistant identity/final report are rebound; transcript text is never copied.
test("complete recorded Pi fixture including system strings and tool turns is compatible", () => {
	const es = structuredClone(recorded);
	const ends = es.filter((e) => e.type === "message_end" && e.message.role === "assistant");
	const finalTimestamp = ends.at(-1).message.timestamp;
	const rebound = (m: Record<string, unknown>) => {
		if (m.role !== "assistant") return m;
		const patch = {
			...m,
			provider: expected.provider,
			model: expected.model,
			api: expected.api,
			thinkingLevel: expected.thinking,
		};
		if (m.timestamp === finalTimestamp && m.stopReason === "stop")
			return { ...patch, content: assistant().content };
		return patch;
	};
	for (const e of es) {
		if (e.message) e.message = rebound(e.message);
		if (e.messages) e.messages = e.messages.map(rebound);
	}
	const r = capture([runtime(), ...es]);
	assert.equal(r.ok, true);
	if (r.ok)
		assert.equal(
			r.capture.usage.output,
			ends.reduce(
				(n: number, e: { message: { usage: { output: number } } }) => n + e.message.usage.output,
				0,
			),
		);
});

test("raw FD1 runtime emission survives installed Pi stdout takeover", () => {
	const extensionUrl = new URL("../../fleet/review/runtime-capture.ts", import.meta.url).href;
	const guardUrl = new URL(
		"../../node_modules/@earendil-works/pi-coding-agent/dist/core/output-guard.js",
		import.meta.url,
	).href;
	const code = `import {takeOverStdout,restoreStdout} from ${JSON.stringify(guardUrl)};
 import {installRuntimeCapture} from ${JSON.stringify(extensionUrl)};
 const handlers=new Map();takeOverStdout();process.stdout.write("ordinary redirected\\n");
 installRuntimeCapture({on:(k,f)=>handlers.set(k,f),getThinkingLevel:()=>"low"},${JSON.stringify({ nonce: expected.nonce, attemptId: expected.attemptId, childRunId: expected.childRunId })});
 handlers.get("before_agent_start")({}, {model:{provider:"fleet-proxy",id:"gpt-6.1-sol",api:"openai-completions"}});restoreStdout();`;
	const child = spawnSync(process.execPath, ["--input-type=module", "-e", code], {
		encoding: "utf8",
		timeout: 5000,
	});
	assert.equal(child.status, 0, child.stderr);
	assert.deepEqual(JSON.parse(child.stdout.trim()), runtime());
	assert.match(child.stderr, /ordinary redirected/);
});

test("dropped non-assistant transcript messages fail even when the final report is intact", () => {
	const es = events();
	const user = { role: "user", content: [{ type: "text", text: "review" }] };
	es[8] = { type: "agent_end", messages: [user, assistant()] };
	rejects(es);
});
test("missing token classes remain unknown while available per-message classes survive", () => {
	const es = events();
	const msg = assistant();
	delete msg.usage.cacheWrite;
	es[6] = { type: "message_end", message: msg };
	es[7] = { type: "turn_end", message: msg, toolResults: [] };
	es[8] = { type: "agent_end", messages: [msg] };
	const r = capture(es);
	assert.equal(r.ok, true);
	if (r.ok) {
		assert.equal(r.capture.usage.cacheWrite, null);
		assert.equal(r.capture.usageByMessage[0]?.output, recordedAssistant.usage.output);
	}
});
test("claudex-proxy Sonnet medium is verified only against protected expected identity", () => {
	const selected: CaptureExpected = {
		...expected,
		provider: "claudex-proxy",
		model: "claude-sonnet-5-5",
		thinking: "medium",
	};
	const es = events();
	es[0] = { ...runtime(), ...selected };
	const msg = {
		...assistant(),
		provider: selected.provider,
		model: selected.model,
		thinkingLevel: selected.thinking,
	};
	es[4] = { type: "message_start", message: { ...msg, content: [], stopReason: "pending" } };
	es[6] = { type: "message_end", message: msg };
	es[7] = { type: "turn_end", message: msg, toolResults: [] };
	es[8] = { type: "agent_end", messages: [msg] };
	assert.equal(parseReviewCapture(jsonl(es), selected, termination).ok, true);
});

test("selection events cannot hide drift behind a stale context", () => {
	for (const [name, event] of [
		["model_select", { model: { provider: expected.provider, id: "other", api: expected.api } }],
		["thinking_level_select", { level: "medium" }],
	] as const) {
		const ext = extension();
		ext.fire("before_agent_start");
		assert.throws(() => ext.fire(name, event));
		assert.equal(JSON.parse(ext.emitted.at(-1) ?? "").code, "identity_changed");
	}
});
test("byte, line-byte and line-count limits are enforced before stream acceptance", () => {
	for (const bytes of [
		`${JSON.stringify({ type: "session", padding: "x".repeat(2_097_152) })}\n`,
		`${Array(20_001).fill('{"type":"session"}').join("\n")}\n`,
	]) {
		const r = parseReviewCapture(bytes, expected, termination);
		assert.equal(r.ok, false);
		if (!r.ok) assert.equal(r.reason, "bounds");
	}
});

test("malformed/fatal provider deltas cannot hide inside a successful final snapshot", () => {
	for (const update of [
		{ type: "error", reason: "error", error: assistant() },
		{ type: "text_delta", contentIndex: 0 },
		{ type: "unknown" },
	]) {
		const es = events();
		es[5] = { type: "message_update", assistantMessageEvent: update };
		rejects(es);
	}
});

test("failed thinking API emits a fatal runtime marker rather than silently losing effort", () => {
	const handlers = new Map<
		string,
		(event: unknown, ctx: { model: { provider: string; id: string; api: string } }) => unknown
	>();
	const emitted: string[] = [];
	installRuntimeCapture(
		{
			on: (k, f) => handlers.set(k, f),
			getThinkingLevel: () => {
				throw new Error("private upstream details");
			},
		},
		{ nonce: expected.nonce, attemptId: expected.attemptId, childRunId: expected.childRunId },
		(line) => emitted.push(line),
	);
	assert.throws(() =>
		handlers.get("before_agent_start")?.(
			{},
			{ model: { provider: expected.provider, id: expected.model, api: expected.api } },
		),
	);
	assert.equal(JSON.parse(emitted[0] ?? "").code, "identity_missing");
	assert.equal(emitted.join("").includes("private upstream"), false);
});
