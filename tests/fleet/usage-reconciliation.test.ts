import { describe, expect, test } from "bun:test";
import {
	generationCreate,
	type PiAssistant,
	type TraceInfo,
} from "../../fleet/pi-extensions/langfuse-trace/batch.js";
import {
	buildIngestionBatch,
	extractSteps,
	parseLogContent,
} from "../../fleet/plugins/run-trace/logic.js";

const START = "2026-10-08T12:00:00.000Z";
const END = "2026-10-08T12:00:01.000Z";
const MODEL = "bifrost/claudex/gpt-6-luna";
const assistant = (cost: number): PiAssistant => ({
	model: MODEL,
	stopReason: "stop",
	content: [{ type: "text", text: "review complete" }],
	usage: { input: 100, output: 20, cacheRead: 30, cost: { total: cost } },
});

const envelope = (event: unknown, ts = END) =>
	JSON.stringify({ ts, stream: "stdout", chunk: JSON.stringify(event) });
const logMessage = (message: PiAssistant) =>
	envelope({ type: "message_end", message: { ...message, role: "assistant" } });
const run = (id: string, usageJson: Record<string, unknown> | null = null) => ({
	id,
	agentId: "bishop",
	status: "succeeded",
	startedAt: START,
	adapterType: "pi_local",
	contextSnapshot: { issueId: "sf1166" },
	usageJson,
});
const replay = (r: Record<string, unknown>, log: string) =>
	buildIngestionBatch(r, extractSteps("pi_local", parseLogContent(log)));
const traceInfo = (id: string): TraceInfo => ({
	id,
	runId: id,
	seat: "bishop",
	environment: "software-factory",
});

/** Wire-level estimated cost, not invoice charges or unique upstream requests. */
const generationTotal = (events: { type: string; body: Record<string, unknown> }[]) =>
	events
		.filter((e) => e.type === "generation-create")
		.reduce((total, e) => total + ((e.body.costDetails as { total?: number })?.total ?? 0), 0);

const assertDiagnostic = (body: Record<string, unknown>) => {
	for (const field of ["model", "usage", "usageDetails", "costDetails"])
		expect(body).not.toHaveProperty(field);
};

describe("Pi direct and replay usage ownership (sf1166 CUT1)", () => {
	// Modeled duplicate ingestion boundaries using incident IDs and observed board
	// totals. These fixtures are not complete captures of the original traces.
	test.each([
		["83ed9be0-064f-4db9-beca-9524f454a531", 6.6328],
		["4373c775-636c-4bd3-a8e8-222676d119e3", 5.1976],
	])("run %s bills only direct generations at observed estimate %s", (id, estimate) => {
		const messages = [assistant(estimate / 2), assistant(estimate / 2)];
		const direct = messages.map((m, n) => generationCreate(traceInfo(id), n + 1, m, START, END));
		const plugin = replay(
			run(id, { costUsd: estimate, model: MODEL }),
			messages.map(logMessage).join("\n"),
		);
		expect(generationTotal([...direct, ...plugin])).toBeCloseTo(estimate, 8);
		expect(plugin.filter((e) => e.type === "generation-create")).toHaveLength(0);
		expect(plugin.filter((e) => e.type === "span-create")).toHaveLength(2);
		for (const e of plugin.slice(1)) assertDiagnostic(e.body);
	});

	test("partial log keeps board totals as correlation and never allocates them to replay", () => {
		const reported = {
			costUsd: 6.6328,
			inputTokens: 900,
			outputTokens: 180,
			cachedInputTokens: 270,
			usageSource: "session_delta",
		};
		const batch = replay(run("partial", reported), `${logMessage(assistant(0.1))}\n{"truncated":`);
		expect(batch).toHaveLength(2);
		expect(batch[0]?.body.metadata).toMatchObject({
			...reported,
			source: "run-trace",
			canonicalUsage: false,
		});
		assertDiagnostic(batch[1]?.body ?? {});
		expect(batch[1]?.body.metadata).toMatchObject({ observedLogUsage: { input: 100, output: 20 } });
		expect(generationTotal(batch)).toBe(0);
	});

	test("missing direct delivery falls back to a priced replay generation", () => {
		const steps = extractSteps("pi_local", parseLogContent(logMessage(assistant(0.5))));
		const batch = buildIngestionBatch(run("fallback", { costUsd: 0.5 }), steps, {
			canonicalDelivery: "canonical_delivery_missing",
		});
		expect(batch[1]).toMatchObject({
			type: "generation-create",
			body: {
				model: "gpt-6-luna",
				usage: { input: 100, output: 20, total: 120 },
				costDetails: { total: 0.5 },
				metadata: {
					canonicalUsage: true,
					source: "run-trace",
					canonicalSource: "replay-fallback",
				},
			},
		});
	});

	test("confirmed direct delivery keeps replay a diagnostic span", () => {
		const steps = extractSteps("pi_local", parseLogContent(logMessage(assistant(0.5))));
		const batch = buildIngestionBatch(run("confirmed", { costUsd: 0.5 }), steps, {
			canonicalDelivery: "canonical_delivery_confirmed",
		});
		expect(batch.map((e) => e.type)).toEqual(["trace-create", "span-create"]);
		assertDiagnostic(batch[1]?.body ?? {});
		expect(generationTotal(batch)).toBe(0);
	});

	test.each(["claude_local", "codex_local", undefined])(
		"legacy adapter %s still emits priced generations",
		(adapterType) => {
			const steps = extractSteps("pi_local", parseLogContent(logMessage(assistant(0.5))));
			const batch = buildIngestionBatch({ ...run("legacy", { costUsd: 0.5 }), adapterType }, steps);
			expect(batch[1]).toMatchObject({
				type: "generation-create",
				body: {
					model: "gpt-6-luna",
					usage: { input: 100, output: 20, total: 120 },
					costDetails: { total: 0.5 },
				},
			});
			expect(batch[1]?.body.usageDetails).toEqual({
				input: 100,
				output: 20,
				input_cached_tokens: 30,
				cache_creation_input_tokens: 0,
			});
			expect(batch[0]?.body.metadata).not.toHaveProperty("canonicalUsage");
		},
	);

	test("direct exporter without run ID does not fabricate a Paperclip join", () => {
		const t = { id: "fallback-session", seat: "bishop", environment: "software-factory" };
		const e = generationCreate(t, 1, { stopReason: "error" }, START, END);
		expect(e.body.metadata).toMatchObject({
			source: "pi-direct",
			canonicalUsage: true,
			stop_reason: "error",
		});
		expect((e.body.metadata as Record<string, unknown>).paperclip_run_id).toBeUndefined();
		expect(e.body).not.toHaveProperty("costDetails");
	});
});

describe("usage provenance and unknowns", () => {
	test("replay retains unknown usage and model family without adding pricing", () => {
		const message = { model: "claudex/gpt-6-astra", provider: "bifrost", stopReason: "error" };
		const batch = replay(run("unknown-log"), logMessage(message));
		expect(batch[1]?.body.metadata).toMatchObject({
			provider_family: "openai",
			transport_provider: "bifrost",
			observedLogUsage: null,
		});
		expect(batch[1]?.body.level).toBe("ERROR");
		assertDiagnostic(batch[1]?.body ?? {});
	});
});
