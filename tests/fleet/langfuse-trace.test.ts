/**
 * @module tests/fleet/langfuse-trace
 * @description The Pi langfuse-trace extension core, driven by a
 *   fake Pi event stream against a `Bun.serve` stub of `/api/public/ingestion`.
 *   Pins the trace identity, one generation per assistant message with Pi's own
 *   cost, names-only tool spans, measured timestamps, the no-keys no-op, and that
 *   the `redact` copy in `batch.ts` agrees with run-trace's over a secret corpus.
 *   `LANGFUSE_TRACE_UNDER_TEST` points the suite at a mutated copy of the extension.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { redact as runTraceRedact } from "../../fleet/plugins/run-trace/logic.js";

type Handler = (event: Record<string, unknown>, ctx?: Record<string, unknown>) => unknown;
type Ev = { id: string; type: string; timestamp: string; body: Record<string, unknown> };
type Env = Record<string, string | undefined>;
type Pi = { on: (n: string, h: Handler) => void };
type Mod = { makeLangfuseTrace: (o: { env: Env; log?: (l: string) => void }) => (pi: Pi) => void };

const DIR = resolve(import.meta.dir, "../../fleet/pi-extensions/langfuse-trace");
const mod = (await import(process.env.LANGFUSE_TRACE_UNDER_TEST ?? `${DIR}/index.ts`)) as Mod;
const { redact, generationCreate } = (await import(
	`${DIR}/batch.ts`
)) as typeof import("../../fleet/pi-extensions/langfuse-trace/batch.ts");

const posts: { auth: string | null; batch: Ev[] }[] = [];
const server = Bun.serve({
	port: 0,
	async fetch(req) {
		const { batch } = (await req.json()) as { batch: Ev[] };
		posts.push({ auth: req.headers.get("authorization"), batch });
		return Response.json(
			{ successes: batch.map((e) => ({ id: e.id, status: 201 })), errors: [] },
			{ status: 207 },
		);
	},
});
afterAll(() => server.stop(true));

const ENV = {
	LANGFUSE_PUBLIC_KEY: "pk-test",
	LANGFUSE_SECRET_KEY: "sk-test",
	LANGFUSE_HOST: `http://127.0.0.1:${server.port}`,
	PAPERCLIP_RUN_ID: "run-1234",
	FLEET_EMPLOYEE: "bishop",
};
const SECRET = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const MODEL = "bifrost/claudex/gpt-6-luna";
const USAGE = { input: 100, output: 20, cacheRead: 30, reasoning: 5, cost: { total: 0.0123 } };
const CONTENT = [{ type: "text", text: `token: ${SECRET}` }, { type: "toolCall" }];
const ASSISTANT = {
	role: "assistant",
	model: MODEL,
	stopReason: "toolUse",
	content: CONTENT,
	usage: USAGE,
};
const TOOL = { toolCallId: "t1", toolName: "bash" };
const RESULT = { content: [{ type: "text", text: "hello" }] };

/** Load the extension with `env`, returning its handlers by event name. */
function load(env: Env, lines: string[] = []) {
	const handlers = new Map<string, Handler>();
	mod.makeLangfuseTrace({ env, log: (l) => lines.push(l) })({ on: (n, h) => handlers.set(n, h) });
	return handlers;
}

async function runSession(isError = true): Promise<Ev[]> {
	const h = load(ENV);
	const fire = async (name: string, e: Record<string, unknown>) =>
		h.get(name)?.(e, { model: { id: MODEL } });
	await fire("session_start", { reason: "startup" });
	await fire("message_start", { message: { role: "user" } });
	await fire("message_start", { message: { role: "assistant" } });
	await fire("message_end", { message: ASSISTANT });
	await fire("tool_execution_start", { ...TOOL, args: { command: `echo ${SECRET}`, timeout: 5 } });
	await fire("tool_execution_end", { ...TOOL, isError, result: RESULT });
	await fire("session_shutdown", { reason: "quit" });
	return posts.at(-1)?.batch ?? [];
}

describe("langfuse-trace core", () => {
	test("one POST carries trace, generation and tool span with Basic auth", async () => {
		const before = posts.length;
		const batch = await runSession();
		expect(posts.length).toBe(before + 1);
		expect(posts.at(-1)?.auth).toBe(`Basic ${Buffer.from("pk-test:sk-test").toString("base64")}`);
		// +2: session_shutdown adds the pi-run span and the run-end trace upsert (E1).
		const types = [
			"trace-create",
			"generation-create",
			"span-create",
			"span-create",
			"trace-create",
		];
		expect(batch.map((e) => e.type)).toEqual(types);
		expect(new Set(batch.map((e) => e.id)).size).toBe(batch.length);
	});

	test("LANGFUSE_BASE_URL is honored without HOST, and off outcomes are queryable", async () => {
		const realFetch = globalThis.fetch;
		const urls: string[] = [];
		globalThis.fetch = (async (url: unknown, init?: RequestInit) => {
			urls.push(String(url));
			const batch = JSON.parse(String(init?.body)).batch as Ev[];
			return Response.json(
				{ successes: batch.map((e) => ({ id: e.id, status: 201 })), errors: [] },
				{ status: 207 },
			);
		}) as typeof fetch;
		try {
			const h = load({
				...ENV,
				LANGFUSE_HOST: undefined,
				LANGFUSE_BASE_URL: "http://base-url.test",
			});
			await h.get("session_start")?.({}, {});
			await h.get("session_shutdown")?.({}, {});
			expect(urls).toEqual(["http://base-url.test/api/public/ingestion"]);
		} finally {
			globalThis.fetch = realFetch;
		}
		const lines: string[] = [];
		expect(load({ PAPERCLIP_RUN_ID: "off-run", FLEET_EMPLOYEE: "bishop" }, lines).size).toBe(0);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
			message: "langfuse_disabled",
			service: "langfuse-trace",
			correlation_id: "off-run",
			seat: "bishop",
			reason: "no_keys",
		});
	});

	test("repeated timestamped message callbacks retain one generation; distinct timestamps remain distinct", async () => {
		const h = load(ENV);
		await h.get("session_start")?.({}, {});
		const message = { ...ASSISTANT, timestamp: 1791450000000 };
		await h.get("message_end")?.({ message });
		await h.get("message_end")?.({ message: { ...message } });
		await h.get("message_end")?.({ message: { ...message, timestamp: message.timestamp + 1 } });
		await h.get("session_shutdown")?.({}, {});
		const generations = posts.at(-1)?.batch.filter((e) => e.type === "generation-create") ?? [];
		expect(generations).toHaveLength(2);
		expect(new Set(generations.map((e) => e.id)).size).toBe(2);
		const firstId = generations[0]?.id;
		// A restarted Pi is a new process: it sees another message first, so neither a
		// counter id nor a process-local cache can reproduce firstId there.
		const child = `
			const { makeLangfuseTrace } = await import(process.env.MOD);
			const message = JSON.parse(process.env.MESSAGE);
			const ids = [];
			globalThis.fetch = async (_url, init) => {
				const batch = JSON.parse(String(init?.body)).batch;
				for (const e of batch) if (e.type === "generation-create") ids.push(e.id);
				return Response.json({ successes: batch.map((e) => ({ id: e.id, status: 201 })), errors: [] }, { status: 207 });
			};
			const h = new Map();
			makeLangfuseTrace({ env: JSON.parse(process.env.TRACE_ENV), log: () => {} })({ on: (n, f) => h.set(n, f) });
			await h.get("message_end")({ message: { ...message, timestamp: message.timestamp + 2 } });
			await h.get("message_end")({ message });
			await h.get("session_shutdown")({}, {});
			console.log(JSON.stringify(ids));
		`;
		const proc = Bun.spawn([process.execPath, "-e", child], {
			env: {
				...process.env,
				MOD: process.env.LANGFUSE_TRACE_UNDER_TEST ?? `${DIR}/index.ts`,
				MESSAGE: JSON.stringify(message),
				TRACE_ENV: JSON.stringify(ENV),
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [out, err, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(err).toBe("");
		expect(code).toBe(0);
		const replayed = JSON.parse(out.trim().split("\n").at(-1) ?? "[]") as string[];
		expect(replayed).toHaveLength(2);
		expect(replayed[1]).toBe(firstId);
	});

	test("a message whose content cannot be digested still queues one generation", async () => {
		const h = load(ENV);
		const content = [{ type: "text", text: "ok", size: 1n }];
		await h.get("message_end")?.({ message: { ...ASSISTANT, timestamp: 1791450000000, content } });
		await h.get("session_shutdown")?.({}, {});
		const generations = posts.at(-1)?.batch.filter((e) => e.type === "generation-create") ?? [];
		expect(generations).toHaveLength(1);
	});

	test("trace carries run id, seat, model and harness pi", async () => {
		const trace = (await runSession())[0]?.body ?? {};
		expect(trace).toMatchObject({ id: "run-1234", name: "bishop", userId: "bishop" });
		const metadata = {
			seat: "bishop",
			model: "gpt-6-luna",
			harness: "pi",
			paperclip_run_id: "run-1234",
		};
		expect(trace.metadata).toEqual(metadata);
		expect(trace.tags).toEqual(["pi_local", "profile:bishop", "model:gpt-6-luna"]);
	});

	test("generation: model without prefix, tokens, cost from usage.cost.total, redacted", async () => {
		const gen = (await runSession())[1]?.body ?? {};
		expect(gen).toMatchObject({ traceId: "run-1234", model: "gpt-6-luna" });
		expect(gen.usage).toEqual({ input: 100, output: 20, total: 150 });
		const details = { input: 100, output: 20, input_cached_tokens: 30 };
		expect(gen.usageDetails).toEqual(details);
		expect(gen.costDetails).toEqual({ total: 0.0123 });
		expect(gen.metadata).toEqual({
			stop_reason: "toolUse",
			source: "pi-direct",
			canonicalUsage: true,
			paperclip_run_id: "run-1234",
			provider_family: "openai",
			transport_provider: null,
			usage_status: "reported",
			reasoning_tokens: 5,
			cost_basis: "api_equivalent_estimate",
			api_equivalent_cost_usd: 0.0123,
			billed_cost_usd: null,
			subscription_quota: null,
		});
		expect(JSON.stringify(gen)).not.toContain(SECRET);
	});

	test("bifrost input carries its cache, so cacheRead is subtracted; other providers keep input", () => {
		const t = { id: "t", seat: "s", environment: "e" };
		const usage = { input: 88959, output: 10, cacheRead: 81920 };
		const gen = (provider: string) =>
			generationCreate(t, 1, { ...ASSISTANT, provider, usage }, "a", "b").body as unknown as {
				usage: { input: number };
				usageDetails: Record<string, number>;
			};
		const bifrost = gen("bifrost");
		expect(bifrost.usage.input).toBe(7039);
		expect(bifrost.usageDetails).toMatchObject({ input: 7039, input_cached_tokens: 81920 });
		expect(gen("openai").usage.input).toBe(88959);
	});

	test("tool span carries argument names and output size only", async () => {
		const span = (await runSession())[2]?.body ?? {};
		expect(span).toMatchObject({ name: "bash", level: "ERROR", output: { chars: 5 } });
		expect(span.input).toEqual({ args: ["command", "timeout"] });
		expect(JSON.stringify(span)).not.toContain(SECRET);
	});

	/** The run-end pair session_shutdown adds: the `pi-run` span and the second trace-create. */
	const runEnd = (batch: Ev[]) => ({
		span: batch.find((e) => e.type === "span-create" && e.body.name === "pi-run"),
		traces: batch.filter((e) => e.type === "trace-create" && e.body.id === "run-1234"),
	});

	test("run end: a failed tool gives an ERROR pi-run span and a trace upsert with peak RSS", async () => {
		const { span, traces } = runEnd(await runSession());
		expect(span?.body.endTime).toBeDefined();
		expect(span?.body.level).toBe("ERROR");
		expect(span?.body.statusMessage).toBe("tools_failed=1 generations_failed=0");
		expect(traces).toHaveLength(2);
		const [first, end] = traces;
		expect(end?.id).not.toBe(first?.id);
		const metadata = (end?.body.metadata ?? {}) as Record<string, unknown>;
		expect(metadata.peak_rss_kb_pi_process).toBeGreaterThan(0);
		expect(metadata).toMatchObject({ seat: "bishop", harness: "pi", status: "error" });
	});

	test("run end: a clean session gives a DEFAULT pi-run span and status ok", async () => {
		const { span, traces } = runEnd(await runSession(false));
		expect(span?.body.level).toBe("DEFAULT");
		expect(traces[1]?.body).toMatchObject({ metadata: { status: "ok" } });
	});

	test("timestamps are measured now, never backdated", async () => {
		const now = Date.now();
		for (const e of await runSession()) {
			for (const t of [e.timestamp, e.body.startTime, e.body.endTime].filter(Boolean)) {
				expect(Math.abs(now - Date.parse(String(t)))).toBeLessThan(5000);
			}
		}
	});

	test("no PAPERCLIP_RUN_ID: trace id is a uuid", async () => {
		const h = load({ ...ENV, PAPERCLIP_RUN_ID: undefined });
		await h.get("session_start")?.({ reason: "startup" }, {});
		await h.get("session_shutdown")?.({ reason: "quit" }, {});
		expect(String(posts.at(-1)?.batch[0]?.body.id)).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
	});

	test.each([
		["LANGFUSE_SECRET_KEY", { LANGFUSE_SECRET_KEY: undefined }],
		["FLEET_EMPLOYEE", { FLEET_EMPLOYEE: undefined }],
		["kill switch", { LANGFUSE_TRACING_ENABLED: "false" }],
	])("missing %s: one stderr line, no handlers, no request", (_n, over) => {
		const lines: string[] = [];
		const before = posts.length;
		expect(load({ ...ENV, ...over }, lines).size).toBe(0);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
			message: "langfuse_disabled",
			service: "langfuse-trace",
			correlation_id: "run-1234",
			seat: _n === "FLEET_EMPLOYEE" ? "unknown" : "bishop",
			reason: _n === "kill switch" ? "disabled" : "missing_configuration",
			missing: _n === "kill switch" ? [] : [_n],
		});
		expect(posts.length).toBe(before);
	});

	test("no Langfuse keys at all (seat not configured, T3): one line, no handlers, no request", () => {
		const lines: string[] = [];
		const before = posts.length;
		const env = { FLEET_EMPLOYEE: "bishop", LANGFUSE_HOST: ENV.LANGFUSE_HOST };
		expect(load(env, lines).size).toBe(0);
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "null")).toMatchObject({
			message: "langfuse_disabled",
			correlation_id: "none",
			seat: "bishop",
			reason: "no_keys",
		});
		expect(posts.length).toBe(before);
	});
});

describe("redact copy", () => {
	const corpus = `plain text|ghp ${SECRET}|sk-abcdefghijklmnop1234|pcp_abcdefghijklmnop1234|${"f".repeat(40)}
		|eyJabc.def.ghi|password: hunter2|password hunter2|https://user:pw@example.com/x
		|-----BEGIN OPENSSH PRIVATE KEY-----|Bearer abcdefghijklmnopqrstuvwxyz|{"api_key": "x"}`;
	test.each(corpus.split(/\s*\|/))("agrees with run-trace on %p", (s) => {
		expect(redact(s)).toBe(runTraceRedact(s));
	});
});

/** A clock the test owns: a timer fires only when the test moves the clock to it. */
function testClock() {
	let now = 0;
	const timers = new Set<{ at: number; ms: number; fn: () => void }>();
	const armed: { ms: number; done: () => void }[] = [];
	const timer = (fn: () => void, ms: number) => {
		const t = { at: now + ms, ms, fn };
		timers.add(t);
		for (const w of armed.filter((w) => w.ms === ms)) {
			armed.splice(armed.indexOf(w), 1);
			w.done();
		}
		return () => void timers.delete(t);
	};
	const pending = (ms: number) => [...timers].find((t) => t.ms === ms);
	/** Waits until a `ms` timer is armed, moves the clock to its deadline, fires everything due. */
	async function fire(ms: number) {
		if (!pending(ms)) await new Promise<void>((done) => armed.push({ ms, done }));
		const target = pending(ms);
		if (!target) throw new Error(`no pending ${ms} ms timer`);
		now = target.at;
		for (const t of [...timers].sort((a, b) => a.at - b.at)) {
			if (t.at > now) break;
			timers.delete(t);
			t.fn();
		}
	}
	return { timer, fire, now: () => now };
}
type Clock = ReturnType<typeof testClock>;

/** One queryable delivery receipt per run, including successful delivery. */
function expectDelivery(lines: string[], sent = 0, failed = 0, dropped = 0) {
	expect(lines).toHaveLength(1);
	const receipt = JSON.parse(lines[0] ?? "null");
	expect(receipt).toMatchObject({
		message: "langfuse_delivery",
		service: "langfuse-trace",
		correlation_id: "run-1234",
		seat: "bishop",
		sent,
		failed,
		dropped,
		level: failed || dropped ? "warn" : "info",
	});
	expect(Number.isFinite(Date.parse(receipt.timestamp))).toBe(true);
}

describe("langfuse-trace delivery (T2)", () => {
	type Reply = (batch: Ev[], n: number) => Response | Promise<Response>;
	const accepted = (batch: Ev[]) =>
		Response.json(
			{ successes: batch.map((e) => ({ id: e.id, status: 201 })), errors: [] },
			{ status: 207 },
		);
	let reply: Reply = (batch) => accepted(batch);
	const got: Ev[][] = [];
	const waits: { n: number; done: () => void }[] = [];
	const stub = Bun.serve({
		port: 0,
		async fetch(req) {
			const { batch } = (await req.json()) as { batch: Ev[] };
			got.push(batch);
			for (const w of waits.filter((w) => got.length >= w.n)) {
				waits.splice(waits.indexOf(w), 1);
				w.done();
			}
			return reply(batch, got.length);
		},
	});
	afterAll(() => stub.stop(true));
	/** Resolves when the stub has received its `n`th POST of this session. */
	const received = (n: number) =>
		new Promise<void>((done) => (got.length >= n ? done() : waits.push({ n, done })));
	const never = () => new Promise<Response>(() => {});
	const env = { ...ENV, LANGFUSE_HOST: `http://127.0.0.1:${stub.port}` };
	const fast = { timeoutMs: 150, retryDelayMs: 10, shutdownBoundMs: 1500 };
	type Hooks = { midway?: () => unknown; during?: (clock: Clock) => unknown };

	/**
	 * A session of `n` events (trace + n-1 tool spans) on a test-owned clock. `midway` runs
	 * before shutdown; `during` runs while shutdown is in progress. Returns stderr lines and the clock.
	 */
	async function session(n: number, over: Record<string, number> = {}, hooks: Hooks = {}) {
		got.length = 0;
		const clock = testClock();
		const lines: string[] = [];
		const h = new Map<string, Handler>();
		const make = mod.makeLangfuseTrace as (o: Record<string, unknown>) => (pi: Pi) => void;
		make({ env, log: (l: string) => lines.push(l), ...fast, ...over, timer: clock.timer })({
			on: (k, f) => h.set(k, f),
		});
		await h.get("session_start")?.({}, {});
		for (let i = 1; i < n; i++)
			h.get("tool_execution_end")?.({ toolCallId: `t${i}`, toolName: "bash" });
		await hooks.midway?.();
		const shutdown = h.get("session_shutdown")?.({}, {});
		await hooks.during?.(clock);
		await shutdown;
		return { lines, clock };
	}

	test("50 events flush mid-session, before shutdown", async () => {
		let before = 0;
		const { lines } = await session(
			50,
			{},
			{
				midway: async () => {
					await received(1);
					before = got.length;
				},
			},
		);
		expect(before).toBe(1);
		// [50, 2]: session_shutdown adds the pi-run span and the run-end trace upsert (E1).
		expect(got.map((b) => b.length)).toEqual([50, 2]);
		expectDelivery(lines, 52);
	});

	test("a timeout is retried once, then succeeds with no summary line", async () => {
		reply = (batch, n) => (n === 1 ? never() : accepted(batch));
		const { lines, clock } = await session(
			3,
			{},
			{
				during: async (c) => {
					await received(1);
					await c.fire(fast.timeoutMs);
					await c.fire(fast.retryDelayMs);
					await received(2);
				},
			},
		);
		expect(got).toHaveLength(2);
		expect(clock.now()).toBe(fast.timeoutMs + fast.retryDelayMs);
		expectDelivery(lines, 5);
	});

	test("429 and 5xx retry once, then count as failed", async () => {
		for (const status of [429, 503]) {
			reply = () => new Response(null, { status });
			const { lines } = await session(
				3,
				{},
				{
					during: async (c) => {
						await received(1);
						await c.fire(fast.retryDelayMs);
					},
				},
			);
			expect(got).toHaveLength(2);
			// 5 = 3 + the two run-end events session_shutdown adds (E1).
			expectDelivery(lines, 0, 5, 0);
		}
	});

	test("a 400 is never retried", async () => {
		reply = () => new Response(null, { status: 400 });
		const { lines, clock } = await session(3);
		expect(got).toHaveLength(1);
		expect(clock.now()).toBe(0);
		// 5 = 3 + the two run-end events session_shutdown adds (E1).
		expectDelivery(lines, 0, 5, 0);
	});

	test("at most 1000 queued: the oldest are dropped and counted", async () => {
		let release = () => {};
		const gate = new Promise<void>((r) => {
			release = r;
		});
		reply = async (batch) => {
			await gate;
			return accepted(batch);
		};
		const { lines } = await session(1200, {}, { midway: release });
		expect(got.flat()).toHaveLength(1050);
		// +2 dropped, last is the trace upsert: session_shutdown adds two run-end events into a full queue (E1).
		expect(got[1]?.[0]?.body.id).toBe("run-1234:pi-tool-t202");
		expect(got.at(-1)?.at(-1)?.body.id).toBe("run-1234");
		expectDelivery(lines, 1050, 0, 152);
	});

	test("shutdown is bounded when ingestion never answers", async () => {
		reply = never;
		const { lines, clock } = await session(
			3,
			{ timeoutMs: 5000, shutdownBoundMs: 300 },
			{
				during: async (c) => {
					await received(1);
					await c.fire(300);
				},
			},
		);
		expect(clock.now()).toBe(300);
		// 5 = 3 + the two run-end events session_shutdown adds (E1).
		expectDelivery(lines, 0, 0, 5);
	});

	test("a 207 whose body never finishes is retried, not counted as sent", async () => {
		const partial = new TextEncoder().encode('{"errors":[');
		const stalled = () =>
			new Response(new ReadableStream({ start: (c) => c.enqueue(partial) }), { status: 207 });
		reply = (batch, n) => (n === 1 ? stalled() : accepted(batch));
		// The event to wait on is the client seeing the 207 headers, not the server's receipt.
		const realFetch = globalThis.fetch;
		let headers = () => {};
		const seen = new Promise<void>((r) => (headers = r));
		globalThis.fetch = ((...a: Parameters<typeof fetch>) =>
			realFetch(...a).then((res) => {
				headers();
				return res;
			})) as typeof fetch;
		try {
			const { lines } = await session(
				3,
				{},
				{
					during: async (c) => {
						await seen;
						await c.fire(fast.timeoutMs);
						await c.fire(fast.retryDelayMs);
						await received(2);
					},
				},
			);
			expect(got).toHaveLength(2);
			expectDelivery(lines, 5);
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	type Send = typeof import("../../fleet/pi-extensions/langfuse-trace/send.ts");
	const sender = async () => ((await import(`${DIR}/send.ts`)) as Send).makeSender;

	test("207 malformed, incomplete, duplicate and foreign acknowledgements never count as full delivery", async () => {
		const makeSender = await sender();
		const realFetch = globalThis.fetch;
		try {
			for (const [body, sent] of [
				["not-json", 0],
				[{ successes: [], errors: [] }, 0],
				[{ successes: [{ id: "a" }], errors: [] }, 0],
				[{ successes: [{ id: "a", status: 201 }], errors: [] }, 1],
				[
					{
						successes: [
							{ id: "a", status: 201 },
							{ id: "a", status: 201 },
						],
						errors: [],
					},
					0,
				],
				[{ successes: [{ id: "foreign" }], errors: [] }, 0],
				[{ successes: [{ id: "a", status: 500 }], errors: [] }, 0],
			] as const) {
				globalThis.fetch = (async (_url: unknown) =>
					new Response(typeof body === "string" ? body : JSON.stringify(body), {
						status: 207,
					})) as typeof fetch;
				const s = makeSender("http://ingest.invalid", "Basic x");
				s.push({ id: "a" } as never);
				s.push({ id: "b" } as never);
				expect(await s.close()).toEqual({ sent, failed: 2 - sent, dropped: 0 });
			}
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("all 2xx receipts require explicit status and fit within 64 KiB", async () => {
		const makeSender = await sender();
		const realFetch = globalThis.fetch;
		try {
			for (const [status, body] of [
				[200, null],
				[204, null],
				[200, { successes: [{ id: "a" }], errors: [] }],
				[207, { successes: [{ id: "a", status: 201 }], errors: [], padding: "x".repeat(65536) }],
			] as const) {
				globalThis.fetch = (async (_url: unknown) =>
					new Response(body === null ? null : JSON.stringify(body), { status })) as typeof fetch;
				const s = makeSender("http://ingest.invalid", "Basic x");
				s.push({ id: "a" } as never);
				expect(await s.close()).toEqual({ sent: 0, failed: 1, dropped: 0 });
			}
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("an oversized receipt is cut off at 64 KiB, declared or chunked, without waiting for the timeout", async () => {
		const makeSender = await sender();
		const realFetch = globalThis.fetch;
		try {
			// The body never ends; only the bound can finish this without the timeout.
			for (const [headers, maxPulls] of [
				[{ "content-length": "1048576" }, 8], // refused on the declared length, body unread
				[{}, 72], // chunked: cancelled once 64 KiB has arrived
			] as const) {
				let pulled = 0;
				globalThis.fetch = (async (_url: unknown) =>
					new Response(
						new ReadableStream({
							pull: (c) => {
								pulled++;
								c.enqueue(new Uint8Array(1024));
							},
						}),
						{ status: 207, headers },
					)) as typeof fetch;
				const s = makeSender("http://ingest.invalid", "Basic x", { timeoutMs: 60_000 });
				s.push({ id: "a" } as never);
				expect(await s.close()).toEqual({ sent: 0, failed: 1, dropped: 0 });
				expect(pulled).toBeLessThan(maxPulls);
			}
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("close() while a mid-session pump is finishing still sends what is queued", async () => {
		const makeSender = await sender();
		const realFetch = globalThis.fetch;
		try {
			for (let depth = 0; depth < 20; depth++) {
				const sizes: number[] = [];
				let answer = () => {};
				globalThis.fetch = (async (_u: unknown, init?: RequestInit) => {
					sizes.push((JSON.parse(String(init?.body)) as { batch: unknown[] }).batch.length);
					if (sizes.length === 1) await new Promise<void>((r) => (answer = r));
					return accepted(JSON.parse(String(init?.body)).batch);
				}) as typeof fetch;
				const s = makeSender("http://ingest.invalid", "Basic x", { timer: testClock().timer });
				for (let i = 0; i < 55; i++) s.push({ id: `e${i}` } as never);
				answer();
				for (let i = 0; i < depth; i++) await Promise.resolve();
				const totals = await s.close();
				const want = { sent: 55, failed: 0, dropped: 0 };
				expect({ depth, sizes, totals }).toEqual({ depth, sizes: [50, 5], totals: want });
			}
		} finally {
			globalThis.fetch = realFetch;
		}
	});

	test("a completed retry delay leaves no abort listener behind", async () => {
		const { getEventListeners } = await import("node:events");
		const makeSender = await sender();
		const Real = globalThis.AbortController;
		let stop: AbortSignal | undefined;
		globalThis.AbortController = class extends Real {
			constructor() {
				super();
				stop ??= this.signal; // the first controller a sender makes is its stop signal
			}
		};
		const clock = testClock();
		let s: ReturnType<typeof makeSender>;
		try {
			s = makeSender(`${env.LANGFUSE_HOST}/api/public/ingestion`, "Basic x", {
				...fast,
				timer: clock.timer,
			});
		} finally {
			globalThis.AbortController = Real;
		}
		got.length = 0;
		reply = () => new Response(null, { status: 503 });
		for (let i = 0; i < 50; i++) s.push({ id: `e${i}` } as never);
		await received(1);
		await clock.fire(fast.retryDelayMs);
		await received(2);
		expect(await s.close()).toEqual({ sent: 0, failed: 50, dropped: 0 });
		expect(getEventListeners(stop as AbortSignal, "abort")).toHaveLength(0);
	});

	test("defaults: 5 s timeout, 500 ms retry delay, 8 s shutdown bound, 50 per POST, 1000 queued", async () => {
		const send = (await import(`${DIR}/send.ts`)) as { DEFAULTS: Record<string, number> };
		expect(send.DEFAULTS).toEqual({
			timeoutMs: 5000,
			retryDelayMs: 500,
			shutdownBoundMs: 8000,
			batchSize: 50,
			maxQueued: 1000,
		});
	});

	test("a 207 counts per-event errors in one stderr summary line, nothing on stdout", async () => {
		reply = (b) =>
			Response.json(
				{
					successes: [{ id: b[0]?.id, status: 201 }],
					errors: b.slice(1).map((e) => ({ id: e.id, status: 400 })),
				},
				{ status: 207 },
			);
		const write = process.stdout.write;
		let out = 0;
		process.stdout.write = ((...a: Parameters<typeof write>) => (
			out++, write.apply(process.stdout, a)
		)) as typeof write;
		try {
			const { lines } = await session(3);
			// failed 4 = 2 + the two run-end events session_shutdown adds (E1).
			expectDelivery(lines, 1, 4, 0);
		} finally {
			process.stdout.write = write;
		}
		expect(out).toBe(0);
	});
});
