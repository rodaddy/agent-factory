/**
 * @module tests/actions/lane-trace-verdict
 * @description Functional tests for the verdict trace a lane WITHOUT an engine
 *   call opens at its start and closes with the status it posts (823a).
 *
 *   The load-bearing properties: open and close run in DIFFERENT workflow
 *   steps (different processes), so they must agree on the trace and span id
 *   from the environment alone; the close carries the verdict the lane posted;
 *   an unconfigured lane touches no client; a client that throws never fails
 *   the lane; and no credential reaches anything the client is handed.
 *
 *   The Langfuse client is INJECTED as a recording fake, so no test touches the
 *   network.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import {
	closeLaneTrace,
	createLaneTracer,
	createRecordingLaneTracer,
	type IngestionEvent,
	type LaneAttempt,
	type LaneTraceSettings,
	laneTraceId,
	openLaneTrace,
	renderCloseBatch,
	renderOpenBatch,
} from "../../scripts/actions/lane-trace";
import { testTmpBase } from "../support/test-temp";

const SECRET = "sk-lf-do-not-log-me-77aa";
const PUBLIC = "pk-lf-public-3c1e";

const SETTINGS: LaneTraceSettings = {
	baseUrl: "http://langfuse",
	publicKey: PUBLIC,
	secretKey: SECRET,
	repository: "rodaddy/software-factory",
	lane: "sop-gate",
	itemNumber: "823",
	sha: "abc123",
	runUrl: "https://forge.example.internal/rodaddy/software-factory/actions/runs/1901",
};

/** A recording fake of the three Langfuse calls and the flush. */
function recordingClient(opts: { throwOn?: string } = {}) {
	const calls: { kind: string; body: Record<string, unknown> }[] = [];
	let flushes = 0;
	const rec = (kind: string) => (body: Record<string, unknown>) => {
		if (opts.throwOn === kind) throw new Error(`${kind} exploded`);
		calls.push({ kind, body });
	};
	return {
		calls,
		flushes: () => flushes,
		client: {
			trace: rec("trace"),
			span: rec("span"),
			_updateSpan: rec("updateSpan"),
			flushAsync: async () => {
				if (opts.throwOn === "flush") throw new Error("flush exploded");
				flushes += 1;
			},
		},
	};
}

describe("laneTraceId", () => {
	test("is derived from the lane, sha and run number alone, so two steps agree", () => {
		expect(laneTraceId(SETTINGS)).toBe("lane-sop-gate-abc123-1901");
		// A second computation from an equal identity (the close step's process)
		// names the SAME trace; nothing time-based is mixed in.
		expect(laneTraceId({ ...SETTINGS })).toBe(laneTraceId(SETTINGS));
	});

	test("absent sha and run url degrade to named placeholders, not a clock", () => {
		expect(laneTraceId({ ...SETTINGS, sha: undefined, runUrl: undefined })).toBe(
			"lane-sop-gate-nosha-norun",
		);
	});
});

describe("openLaneTrace / closeLaneTrace", () => {
	test("close for a trace that was never opened (prepare died first) still closes and flushes", async () => {
		const fake = recordingClient();
		await closeLaneTrace(
			SETTINGS,
			{ state: "cancelled", description: "upstream:prepare=cancelled" },
			{ client: fake.client },
		);
		expect(fake.calls.map((c) => c.kind)).toEqual(["updateSpan", "trace"]);
		expect(fake.calls[1]?.body.id).toBe("lane-sop-gate-abc123-1901");
		expect(fake.flushes()).toBe(1);
	});

	test("open creates the trace and one lane span, and flushes before returning", async () => {
		const fake = recordingClient();
		const id = await openLaneTrace(SETTINGS, { client: fake.client });
		expect(id).toBe("lane-sop-gate-abc123-1901");
		expect(fake.calls.map((c) => c.kind)).toEqual(["trace", "span"]);
		expect(fake.calls[0]?.body.id).toBe(id);
		expect(fake.calls[0]?.body.tags).toEqual(
			expect.arrayContaining(["lane:sop-gate", "repo:rodaddy/software-factory", "item:823"]),
		);
		expect(fake.calls[1]?.body.traceId).toBe(id);
		expect(fake.calls[1]?.body.id).toBe(`${id}-lane`);
		expect(fake.calls[0]?.body.metadata).toMatchObject({ log_level: "info" });
		expect(fake.flushes()).toBe(1);
	});

	test("close ends the SAME span with the verdict the lane posted", async () => {
		const fake = recordingClient();
		await closeLaneTrace(
			SETTINGS,
			{ state: "failure", description: "sop-gate: 2 checks failed" },
			{ client: fake.client },
		);
		const update = fake.calls.find((c) => c.kind === "updateSpan");
		expect(update?.body.id).toBe("lane-sop-gate-abc123-1901-lane");
		expect(update?.body.traceId).toBe("lane-sop-gate-abc123-1901");
		expect(update?.body.endTime).toBeInstanceOf(Date);
		expect(update?.body.output).toEqual({
			state: "failure",
			description: "sop-gate: 2 checks failed",
		});
		expect(update?.body.level).toBe("ERROR");
		const trace = fake.calls.find((c) => c.kind === "trace");
		expect(trace?.body.id).toBe("lane-sop-gate-abc123-1901");
		expect(trace?.body.output).toEqual(update?.body.output);
		expect(trace?.body.tags).toEqual(expect.arrayContaining(["verdict:failure"]));
		expect(fake.flushes()).toBe(1);
	});

	test("a success verdict is not marked as an error", async () => {
		const fake = recordingClient();
		await closeLaneTrace(SETTINGS, { state: "success" }, { client: fake.client });
		expect(fake.calls.find((c) => c.kind === "updateSpan")?.body.level).toBe("DEFAULT");
	});

	test("an unconfigured lane touches no client and returns no trace id", async () => {
		const fake = recordingClient();
		expect(await openLaneTrace(null, { client: fake.client })).toBeNull();
		await closeLaneTrace(null, { state: "success" }, { client: fake.client });
		expect(fake.calls).toEqual([]);
		expect(fake.flushes()).toBe(0);
	});

	test("a client that throws never fails the lane", async () => {
		for (const throwOn of ["trace", "span", "updateSpan", "flush"]) {
			const fake = recordingClient({ throwOn });
			await expect(openLaneTrace(SETTINGS, { client: fake.client })).resolves.toBeDefined();
			await expect(
				closeLaneTrace(SETTINGS, { state: "error" }, { client: fake.client }),
			).resolves.toBeUndefined();
		}
	});

	test("no credential reaches the client, and the description is bounded", async () => {
		const fake = recordingClient();
		await openLaneTrace(SETTINGS, { client: fake.client });
		await closeLaneTrace(
			SETTINGS,
			{ state: "success", description: "x".repeat(5000) },
			{ client: fake.client },
		);
		const all = JSON.stringify(fake.calls);
		expect(all).not.toContain(SECRET);
		expect(all).not.toContain(PUBLIC);
		const output = fake.calls.find((c) => c.kind === "updateSpan")?.body.output as {
			description: string;
		};
		expect(output.description.length).toBeLessThanOrEqual(220);
	});
});

describe("render: the keyless batch is what open and close send", () => {
	const NOW = new Date("2026-10-06T12:00:00.000Z");
	const { baseUrl: _b, publicKey: _p, secretKey: _s, ...IDENTITY } = SETTINGS;
	const wire = (body: unknown) => JSON.parse(JSON.stringify(body));

	test("render open matches the SDK open body for body, with no key", async () => {
		const fake = recordingClient();
		await openLaneTrace(SETTINGS, { client: fake.client, now: () => NOW });
		const { batch } = renderOpenBatch(IDENTITY, NOW);
		expect(batch.map((e) => e.type)).toEqual(["trace-create", "span-create"]);
		expect(batch.map((e) => e.body)).toEqual(fake.calls.map((c) => wire(c.body)));
		expect(batch.every((e) => e.timestamp === NOW.toISOString())).toBe(true);
	});

	test("render close matches the SDK close body for body, with no key", async () => {
		const fake = recordingClient();
		const verdict = { state: "failure", description: "sop-gate: 2 checks failed" };
		await closeLaneTrace(SETTINGS, verdict, { client: fake.client, now: () => NOW });
		const { batch } = renderCloseBatch(IDENTITY, verdict, NOW);
		expect(batch.map((e) => e.type)).toEqual(["span-update", "trace-create"]);
		expect(batch.map((e) => e.body)).toEqual(fake.calls.map((c) => wire(c.body)));
	});
});

describe("recording engine tracer: the keyless file carries what the live tracer sends", () => {
	const NOW = new Date("2026-10-06T12:00:00.000Z");
	const { baseUrl: _b, publicKey: _p, secretKey: _s, ...IDENTITY } = SETTINGS;
	const wire = (body: unknown) => JSON.parse(JSON.stringify(body));
	const attempt = (n: number): LaneAttempt => ({
		attempt: n,
		attempts: 3,
		requestedModel: "gpt-5",
		requestBytes: 1234,
		startedAt: new Date(NOW.getTime() + n * 1000),
		endedAt: new Date(NOW.getTime() + n * 1000 + 500),
		outcome: n === 1 ? "http 503" : "ok",
		ok: n !== 1,
		attestedModel: n === 1 ? undefined : "gpt-5",
		usage: n === 1 ? undefined : { input: 10, output: 5, total: null },
		proxyRequestId: "e40a61b8",
	});

	async function live() {
		const calls: { kind: string; body: object }[] = [];
		const tracer = createLaneTracer(SETTINGS, {
			client: {
				trace: (body) => calls.push({ kind: "trace", body }),
				generation: (body) => calls.push({ kind: "generation", body }),
				flushAsync: async () => {},
			},
			now: () => NOW,
		});
		tracer.attempt(attempt(1));
		tracer.attempt(attempt(2));
		await tracer.flush();
		return calls;
	}

	async function recorded(): Promise<IngestionEvent[]> {
		const dir = join(await mkdtemp(join(testTmpBase(), "lane-trace-rec-")), "out");
		const tracer = createRecordingLaneTracer(IDENTITY, dir, { now: () => NOW });
		tracer.attempt(attempt(1));
		tracer.attempt(attempt(2));
		await tracer.flush();
		const files = readdirSync(dir);
		expect(files).toEqual([`lane-sop-gate-abc123-${NOW.getTime()}.json`]);
		return JSON.parse(readFileSync(join(dir, files[0] ?? ""), "utf8")).batch;
	}

	test("two attempts write one file: trace-create equal to the live client.trace body", async () => {
		const batch = await recorded();
		expect(batch.map((e) => e.type)).toEqual([
			"trace-create",
			"generation-create",
			"generation-create",
		]);
		const calls = await live();
		expect(batch[0]?.body).toEqual(wire(calls[0]?.body));
		expect(JSON.stringify(batch)).not.toContain(SECRET);
	});

	test("each generation-create body equals the live client.generation argument", async () => {
		const batch = await recorded();
		const calls = await live();
		expect(calls.map((c) => c.kind)).toEqual(["trace", "generation", "generation"]);
		expect(batch.slice(1).map((e) => e.body)).toEqual(calls.slice(1).map((c) => wire(c.body)));
		// A curl-posted batch has no SDK to assign ids: each attempt carries its own.
		const traceId = (batch[0]?.body as { id?: string } | undefined)?.id;
		const ids = [`${traceId}-attempt-1`, `${traceId}-attempt-2`];
		expect(batch.slice(1).map((e) => (e.body as { id?: string }).id)).toEqual(ids);
		expect(calls.slice(1).map((c) => (c.body as { id?: string }).id)).toEqual(ids);
	});

	test("an unwritable outDir: flush resolves and a warn is logged", async () => {
		const base = await mkdtemp(join(testTmpBase(), "lane-trace-rec-"));
		const blocker = join(base, "file");
		writeFileSync(blocker, "x");
		const mod = new URL("../../scripts/actions/lane-trace.ts", import.meta.url).pathname;
		const script = `const m = await import(${JSON.stringify(mod)});
const t = m.createRecordingLaneTracer({ repository: "r", lane: "l" }, ${JSON.stringify(join(blocker, "out"))});
await t.flush();
process.stdout.write("resolved");`;
		const proc = Bun.spawn(["bun", "-e", script], {
			stdout: "pipe",
			stderr: "pipe",
			env: { PATH: process.env.PATH ?? "" },
		});
		const [out, err] = [
			await new Response(proc.stdout).text(),
			await new Response(proc.stderr).text(),
		];
		expect(await proc.exited).toBe(0);
		expect(out).toBe("resolved");
		expect(err).toContain("lane.trace.record_failed");
	}, 30_000);
});
