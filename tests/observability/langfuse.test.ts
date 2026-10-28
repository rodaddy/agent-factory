import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import type { AttemptTrace } from "../../src/observability/event-stream";
import {
	type AttemptTraceIdentity,
	buildClient,
	createLangfuseEmitter,
	emitterOn,
	loadLangfuseSettings,
	traceIdFor,
} from "../../src/observability/langfuse";

/**
 * A PLACEHOLDER key shape, never a real credential. The real keys live in the
 * vault item `Langfuse - software-factory` and must never reach source, a test,
 * a log line, or a PR body.
 */
const FAKE_PUBLIC = "pk-lf-test-placeholder";
const FAKE_SECRET = "sk-lf-test-placeholder";

const identity: AttemptTraceIdentity = {
	attemptId: 1,
	jobId: 2,
	repository: "rodaddy/x",
	jobType: "pr-review",
	sha: "cafe",
	itemNumber: 42,
	vmid: 9001,
	hostname: "runner-1",
};

const trace: AttemptTrace = {
	observedModel: "gpt-5.6-sol",
	provider: "cliproxy",
	generations: [
		{
			name: "turn-1",
			model: "gpt-5.6-sol",
			provider: "cliproxy",
			api: "openai-completions",
			stopReason: "stop",
			startTime: new Date("2026-08-01T20:19:53.026Z"),
			endTime: new Date("2026-08-01T20:19:56.688Z"),
			input: 10,
			output: 5,
			total: 15,
			reasoning: 2,
			cacheRead: 1,
			text: "done",
		},
	],
	toolSpans: [
		{
			name: "write: /work/pilot/hello.txt",
			startTime: new Date("2026-08-01T20:19:54.000Z"),
			endTime: new Date("2026-08-01T20:19:55.000Z"),
			input: '{"path":"/work/pilot/hello.txt"}',
			output: "ok",
			ok: true,
			approxTiming: true,
		},
	],
	startTime: new Date("2026-08-01T20:19:53.026Z"),
	endTime: new Date("2026-08-01T20:20:08.953Z"),
	eventCount: 149,
	truncated: false,
	// Every tool call in this fixture is matched, so nothing is left open. The
	// field exists so the parse's open-span retention is assertable at all, and
	// the emitter forwards it as trace metadata.
	unclosedToolSpans: 0,
	// The pilot stream's stamps are ordered, so the clock-skew clamp never fired.
	clampedTimestamps: 0,
};

describe("loadLangfuseSettings: absent config DISABLES emission", () => {
	test("all three present resolves settings", () => {
		expect(
			loadLangfuseSettings({
				LANGFUSE_BASE_URL: "http://10.0.20.73:3000",
				LANGFUSE_PUBLIC_KEY: FAKE_PUBLIC,
				LANGFUSE_SECRET_KEY: FAKE_SECRET,
			}),
		).toEqual({
			baseUrl: "http://10.0.20.73:3000",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
	});

	test("an empty environment resolves null — the default everywhere", () => {
		expect(loadLangfuseSettings({})).toBeNull();
	});

	test("ANY missing or blank variable resolves null, never a partial config", () => {
		const full = {
			LANGFUSE_BASE_URL: "http://10.0.20.73:3000",
			LANGFUSE_PUBLIC_KEY: FAKE_PUBLIC,
			LANGFUSE_SECRET_KEY: FAKE_SECRET,
		};
		for (const key of Object.keys(full)) {
			const missing = { ...full, [key]: undefined };
			expect(loadLangfuseSettings(missing)).toBeNull();
			const blank = { ...full, [key]: "   " };
			expect(loadLangfuseSettings(blank)).toBeNull();
		}
	});
});

describe("createLangfuseEmitter", () => {
	test("null settings yield NO emitter — emission is simply off", () => {
		expect(createLangfuseEmitter(null)).toBeNull();
	});

	test("THE IMPORTANT ONE: an unreachable base URL never throws out of emit", async () => {
		// A routable-looking but dead address. The SDK queues and flushes on its own
		// timer, so `emit` must return without ever touching the network.
		const emitter = createLangfuseEmitter({
			baseUrl: "http://127.0.0.1:7199",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
		expect(emitter).not.toBeNull();
		const started = Date.now();
		// Returns void, synchronously: nothing here is awaitable, which is exactly
		// the property that keeps ingest off the network.
		const returned = emitter?.emit({
			identity,
			trace,
			scores: { ingestOk: 1, schemaValid: 1 },
			at: new Date(),
		});
		expect(returned).toBeUndefined();
		// Fire-and-forget: no round trip was waited on.
		expect(Date.now() - started).toBeLessThan(1000);
		// Shutdown against a dead host resolves rather than rejecting.
		await emitter?.shutdown();
	});

	test("the SDK's built-in console.error handler is REMOVED, not merely doubled", async () => {
		// The SDK installs its OWN unconditional `console.error` listener on the
		// `error` event at construction, and `on()` ADDS rather than replaces. This
		// repo bans console.* — `log` owns stderr and NDJSON is the contract — so the
		// built-in handler must be gone. Drive the SDK's real error channel and prove
		// nothing reached console.error.
		const client = buildClient({
			baseUrl: "http://127.0.0.1:7199",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
		const original = console.error;
		const captured: unknown[] = [];
		console.error = (...args: unknown[]) => void captured.push(args);
		try {
			(client as unknown as { _events: { emit: (e: string, p: unknown) => void } })._events.emit(
				"error",
				new Error("simulated sdk failure"),
			);
		} finally {
			console.error = original;
		}
		expect(captured).toEqual([]);
		await client.shutdownAsync();
	});

	test("retry and timeout are bounded, so a dead sink cannot stay busy failing", () => {
		const client = buildClient({
			baseUrl: "http://127.0.0.1:7199",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
		const internals = client as unknown as {
			_retryOptions: { retryCount: number; retryDelay: number };
			requestTimeout: number;
		};
		// SDK defaults are 3 retries at 3000ms with a 5000ms timeout — ~18s of
		// background retry per flush against an unreachable host, measured.
		expect(internals._retryOptions.retryCount).toBe(1);
		expect(internals._retryOptions.retryDelay).toBe(1000);
		expect(internals.requestTimeout).toBe(2000);
	});

	test("emit tolerates a trace with no observations and no attested model", async () => {
		const emitter = createLangfuseEmitter({
			baseUrl: "http://127.0.0.1:7199",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
		expect(() =>
			emitter?.emit({
				identity: { ...identity, itemNumber: null, vmid: null },
				trace: { ...trace, observedModel: null, provider: null, generations: [], toolSpans: [] },
				scores: { ingestOk: 0, schemaValid: 0, changeVerified: 0 },
				at: new Date(),
			}),
		).not.toThrow();
		await emitter?.shutdown();
	});
});

/**
 * Run `fn` capturing the NDJSON log lines it emits.
 *
 * Captured at the DESCRIPTOR level (the idiom `tests/kboard/pass.test.ts` uses):
 * post-#88 pino writes synchronously to fd 2 via `fs.writeSync`, NOT through
 * `process.stderr.write`, so a `process.stderr` spy sees nothing and every
 * assertion on log content passes vacuously.
 */
async function withCapturedLogs<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; lines: Record<string, unknown>[] }> {
	const raw: string[] = [];
	const realWriteSync = fs.writeSync;
	(fs as { writeSync: typeof fs.writeSync }).writeSync = ((
		fd: number,
		data: string | NodeJS.ArrayBufferView,
		...rest: unknown[]
	) => {
		if (fd === 2) {
			const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString();
			raw.push(text);
			return typeof data === "string" ? Buffer.byteLength(text) : (data as Uint8Array).length;
		}
		return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
	}) as typeof fs.writeSync;
	try {
		const value = await fn();
		const lines = raw
			.join("")
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		return { value, lines };
	} finally {
		(fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
	}
}

/**
 * Every body the SDK was handed, captured at `enqueue` — the ONE seam every
 * `trace`/`generation`/`span`/`score` call funnels through before batching.
 * Verified against `langfuse-core` 3.38.20 by probe (own property, called with
 * `(type, flatBody)`), not inferred: an interception hung on the wrong method
 * compiles, reads correctly, and captures nothing.
 */
function captureBodies(client: unknown): Array<{ type: string; body: Record<string, unknown> }> {
	const bodies: Array<{ type: string; body: Record<string, unknown> }> = [];
	const target = client as { enqueue: (type: string, body: Record<string, unknown>) => void };
	const real = target.enqueue.bind(target);
	target.enqueue = (type, body) => {
		bodies.push({ type, body });
		real(type, body);
	};
	return bodies;
}

describe("the failure-visibility contract actually fires", () => {
	test("THE IMPORTANT ONE: a BACKGROUND flush failure produces the emit_failed line", async () => {
		// THE REGRESSION: the SDK routes a background flush failure through
		// `warning`, NOT `error`. Subscribing `error` alone meant an unreachable or
		// 401ing Langfuse was COMPLETELY SILENT — measured on langfuse-core 3.38.20
		// as 2 `warning` events and 0 `error` events for 20 queued events.
		//
		// This drives the REAL network path (127.0.0.1:7199 is in this repo's local
		// dev port range and nothing listens on it), not a synthetic event emit, so
		// it fails if the SDK ever moves the channel again.
		const { lines } = await withCapturedLogs(async () => {
			const emitter = createLangfuseEmitter({
				baseUrl: "http://127.0.0.1:7199",
				publicKey: FAKE_PUBLIC,
				secretKey: FAKE_SECRET,
			});
			emitter?.emit({ identity, trace, scores: { ingestOk: 1, schemaValid: 1 }, at: new Date() });
			await emitter?.shutdown();
		});
		const failed = lines.filter((l) => l.msg === "observability.langfuse.emit_failed");
		expect(failed.length).toBeGreaterThan(0);
		// CLASS ONLY, never the message: an SDK error message can quote the request
		// it failed on, which would put the configured credential in a log line.
		expect(failed[0]?.error_class).toBe("LangfuseFetchNetworkError");
		for (const line of failed) {
			const text = JSON.stringify(line);
			expect(text).not.toContain(FAKE_SECRET);
			expect(text).not.toContain(FAKE_PUBLIC);
		}
	});

	test("both channels feed ONE monotonic emit_seq, so N failures are distinguishable", async () => {
		const { lines } = await withCapturedLogs(async () => {
			const client = buildClient({
				baseUrl: "http://127.0.0.1:7199",
				publicKey: FAKE_PUBLIC,
				secretKey: FAKE_SECRET,
			});
			const events = (client as unknown as { _events: { emit: (e: string, p: unknown) => void } })
				._events;
			events.emit("warning", new Error("first"));
			events.emit("error", new Error("second"));
		});
		// `log()` stringifies every field through `bounded()`, so these are strings.
		const seqs = lines
			.filter((l) => l.msg === "observability.langfuse.emit_failed")
			.map((l) => l.emit_seq);
		expect(seqs.slice(0, 2)).toEqual(["1", "2"]);
	});
});

describe("trace id is host-qualified (the #86 shape)", () => {
	test("THE IMPORTANT ONE: two hosts under ONE attempt upsert two DISTINCT traces", () => {
		// THE REGRESSION: `attempt-N` alone made both hosts write the SAME Langfuse
		// trace id, and Langfuse UPSERTS on id — metadata overwritten, generations
		// merged, tokens double-counted. Results are per (job, host); the trace must
		// be too.
		const client = buildClient({
			baseUrl: "http://127.0.0.1:7199",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
		const bodies = captureBodies(client);
		const emitter = emitterOn(client);
		for (const hostname of ["runner-1", "runner-2"]) {
			emitter.emit({
				identity: { ...identity, hostname },
				trace,
				scores: { ingestOk: 1, schemaValid: 1 },
				at: new Date(),
			});
		}
		const traces = bodies.filter((b) => b.type === "trace-create");
		expect(traces.map((t) => t.body.id)).toEqual(["attempt-1-runner-1", "attempt-1-runner-2"]);
		// Grouping is UNCHANGED: one session still collects every host.
		expect(new Set(traces.map((t) => t.body.sessionId))).toEqual(new Set(["job-2"]));
		// Each host's generations bind to ITS OWN trace, never merged onto one.
		const gens = bodies.filter((b) => b.type === "generation-create");
		expect(new Set(gens.map((g) => g.body.traceId)).size).toBe(2);
	});

	test("truncation and unterminated tool calls are recorded on the trace", () => {
		// Truncation: a prefix is never read as the whole run. Unterminated calls: a
		// killed or timed-out attempt ends mid-tool, and without the count the trace
		// shows one fewer span and reads as a run that simply did less work.
		const client = buildClient({
			baseUrl: "http://127.0.0.1:7199",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
		const bodies = captureBodies(client);
		emitterOn(client).emit({
			identity,
			trace: { ...trace, truncated: true, unclosedToolSpans: 3 },
			scores: { ingestOk: 1, schemaValid: 1 },
			at: new Date(),
		});
		const [traceBody] = bodies.filter((b) => b.type === "trace-create");
		const metadata = traceBody?.body.metadata as Record<string, unknown>;
		expect(metadata?.truncated).toBe(true);
		expect(metadata?.unclosed_tool_spans).toBe(3);
	});

	test("the clock-skew clamp count reaches the trace metadata", () => {
		// A clamped interval and a genuinely instantaneous one both render as zero
		// duration, so without this in the metadata a runner with broken NTP is
		// indistinguishable in the UI from a fast turn.
		const client = buildClient({
			baseUrl: "http://127.0.0.1:7199",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
		const bodies = captureBodies(client);
		emitterOn(client).emit({
			identity,
			trace: { ...trace, clampedTimestamps: 7 },
			scores: { ingestOk: 1, schemaValid: 1 },
			at: new Date(),
		});
		const [traceBody] = bodies.filter((b) => b.type === "trace-create");
		expect((traceBody?.body.metadata as Record<string, unknown>)?.clamped_timestamps).toBe(7);
	});

	test("an unusable run timestamp yields null metadata, never a thrown RangeError", () => {
		// `toISOString()` THROWS on an invalid Date, and the call sits inside the
		// trace body — one bad runner timestamp took the whole trace with it.
		const client = buildClient({
			baseUrl: "http://127.0.0.1:7199",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
		const bodies = captureBodies(client);
		expect(() =>
			emitterOn(client).emit({
				identity,
				trace: { ...trace, startTime: new Date(Number.NaN), endTime: new Date(Number.NaN) },
				scores: { ingestOk: 1, schemaValid: 1 },
				at: new Date(),
			}),
		).not.toThrow();
		const [traceBody] = bodies.filter((b) => b.type === "trace-create");
		const metadata = traceBody?.body.metadata as Record<string, unknown>;
		expect(metadata?.run_started_at).toBeNull();
		expect(metadata?.run_ended_at).toBeNull();
		// The trace still went out: a bad stamp costs the timing, not the trace.
		expect(traceBody?.body.id).toBe("attempt-1-runner-1");
	});
});

describe("the cross-link shape is PINNED", () => {
	test("THE IMPORTANT ONE: tags carry lane, repo, sha, host, item, vmid, runtime", () => {
		// #170 spec'd these tags and nothing pinned them, so a tag could be renamed
		// or dropped and every test stayed green — while the Langfuse filter an
		// operator uses to find "every pr-review on rodaddy/x at this sha" silently
		// stopped matching. #184's acceptance is that the ids line up ACROSS
		// surfaces, which is a claim about these exact strings.
		const client = buildClient({
			baseUrl: "http://127.0.0.1:7199",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
		const bodies = captureBodies(client);
		emitterOn(client).emit({
			identity,
			trace,
			scores: { ingestOk: 1, schemaValid: 1 },
			at: new Date(),
		});
		const [traceBody] = bodies.filter((b) => b.type === "trace-create");
		expect(traceBody).toBeDefined();
		expect(new Set(traceBody?.body.tags as string[])).toEqual(
			new Set([
				"lane:pr-review",
				"repo:rodaddy/x",
				"sha:cafe",
				"host:runner-1",
				"item:42",
				"vmid:9001",
				"runtime:cliproxy",
			]),
		);
	});

	test("the id/session pair is `attempt-N-<host>` / `job-N`, the pair every surface joins on", () => {
		// The db column, the forge comment's `job N, attempt M`, and the status page
		// link all resolve through these two strings. Pinned together so a change to
		// either is a change a reader of this test sees as breaking the join.
		const client = buildClient({
			baseUrl: "http://127.0.0.1:7199",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
		const bodies = captureBodies(client);
		emitterOn(client).emit({
			identity,
			trace,
			scores: { ingestOk: 1, schemaValid: 1 },
			at: new Date(),
		});
		const [traceBody] = bodies.filter((b) => b.type === "trace-create");
		expect(traceBody?.body.id).toBe("attempt-1-runner-1");
		expect(traceBody?.body.sessionId).toBe("job-2");
		// And `traceIdFor` — the function the db stamp calls — computes the SAME id
		// the emitter put on the wire. This is the join the #184 column depends on.
		expect(traceBody?.body.id).toBe(traceIdFor(identity));
	});

	test("an itemless, vmid-less, runtime-less attempt drops those tags rather than emitting empties", () => {
		// Guards the assertion above from passing for the wrong reason: a hardcoded
		// tag list would still emit `item:` and `vmid:` with nothing after them, and
		// a Langfuse filter on `item:42` would match a trace with no item.
		const client = buildClient({
			baseUrl: "http://127.0.0.1:7199",
			publicKey: FAKE_PUBLIC,
			secretKey: FAKE_SECRET,
		});
		const bodies = captureBodies(client);
		emitterOn(client).emit({
			identity: { ...identity, itemNumber: null, vmid: null },
			trace: { ...trace, provider: null },
			scores: { ingestOk: 1, schemaValid: 1 },
			at: new Date(),
		});
		const [traceBody] = bodies.filter((b) => b.type === "trace-create");
		expect(new Set(traceBody?.body.tags as string[])).toEqual(
			new Set(["lane:pr-review", "repo:rodaddy/x", "sha:cafe", "host:runner-1"]),
		);
	});
});
