import { describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { traceRun } from "../../fleet/plugins/run-trace/trace.js";

const dir = join(import.meta.dir, "..", "fixtures", "run-trace");
const load = (name: string) => JSON.parse(readFileSync(join(dir, name), "utf8"));

const run = load("claude_local-run.json");
const log = load("claude_local-log.json");
const config = { boardUrl: "http://board.test", langfuseHost: "https://lf.test" };
const secrets = { boardApiKey: "bk", langfusePublicKey: "pk", langfuseSecretKey: "sk" };

interface Call {
	url: string;
	init: RequestInit | undefined;
}

function fakeFetch(opts: { runOverride?: Record<string, unknown>; lfStatus?: number } = {}) {
	const calls: Call[] = [];
	const impl = async (url: string, init?: RequestInit) => {
		calls.push({ url, init });
		const json = (body: unknown, status = 200) =>
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			});
		if (url === `${config.boardUrl}/api/heartbeat-runs/${run.id}`)
			return json({ ...run, ...opts.runOverride });
		if (url === `${config.boardUrl}/api/heartbeat-runs/${run.id}/log`) return json(log);
		if (url === `${config.boardUrl}/api/agents/${run.agentId}`) return json({ name: "sf-cto" });
		if (url === `${config.langfuseHost}/api/public/ingestion`) {
			const status = opts.lfStatus ?? 207;
			if (status >= 300) return new Response("unauthorized", { status });
			const batch = JSON.parse(String(init?.body)).batch;
			return json(
				{ successes: batch.map((e: { id: string }) => ({ id: e.id, status: 201 })), errors: [] },
				207,
			);
		}
		return new Response("nope", { status: 404 });
	};
	return { calls, impl };
}

const header = (c: Call, name: string) => new Headers(c.init?.headers).get(name);

describe("traceRun", () => {
	test("reads 3 board URLs with bearer, posts once to Langfuse with Basic auth", async () => {
		const f = fakeFetch();
		const out = await traceRun({
			runId: run.id,
			companyId: run.companyId,
			config,
			fetchImpl: f.impl,
			secrets,
		});
		const board = f.calls.filter((c) => c.url.startsWith(config.boardUrl));
		expect(board.map((c) => c.url)).toEqual([
			`${config.boardUrl}/api/heartbeat-runs/${run.id}`,
			`${config.boardUrl}/api/heartbeat-runs/${run.id}/log`,
			`${config.boardUrl}/api/agents/${run.agentId}`,
		]);
		for (const c of board) expect(header(c, "authorization")).toBe("Bearer bk");
		const posts = f.calls.filter((c) => c.url === `${config.langfuseHost}/api/public/ingestion`);
		expect(posts.length).toBe(1);
		expect(posts[0]?.init?.method).toBe("POST");
		expect(header(posts[0] as Call, "authorization")).toBe(
			`Basic ${Buffer.from("pk:sk").toString("base64")}`,
		);
		const batch = JSON.parse(String(posts[0]?.init?.body)).batch;
		const traces = batch.filter((e: { type: string }) => e.type === "trace-create");
		expect(traces.length).toBe(1);
		expect(traces[0].body.id).toBe(run.id);
		expect(out.runId).toBe(run.id);
		expect(out.events).toBe(batch.length);
		expect(out.errors).toBe(0);
	});

	test("a 401 from Langfuse throws with the status and no secret", async () => {
		const f = fakeFetch({ lfStatus: 401 });
		let msg = "";
		try {
			await traceRun({
				runId: run.id,
				companyId: run.companyId,
				config,
				fetchImpl: f.impl,
				secrets,
			});
		} catch (e) {
			msg = (e as Error).message;
		}
		expect(msg).toContain("401");
		expect(msg).not.toContain("sk");
	});

	test("unknown adapterType still posts the trace-create with zero steps", async () => {
		const f = fakeFetch({
			runOverride: { runnerProfileJson: { adapterDispatch: { adapterType: "mystery" } } },
		});
		const out = await traceRun({
			runId: run.id,
			companyId: run.companyId,
			config,
			fetchImpl: f.impl,
			secrets,
		});
		const post = f.calls.find((c) => c.url === `${config.langfuseHost}/api/public/ingestion`);
		const batch = JSON.parse(String(post?.init?.body)).batch;
		expect(batch.length).toBe(1);
		expect(batch[0].type).toBe("trace-create");
		expect(out.events).toBe(1);
	});

	test("unconfirmed 207 events remain failed and response content is never logged in HTTP errors", async () => {
		for (const body of [
			"invalid-json",
			JSON.stringify({ successes: [], errors: [] }),
			JSON.stringify({ successes: [{ id: "foreign" }], errors: [] }),
		]) {
			const f = fakeFetch();
			const out = await traceRun({
				runId: run.id,
				companyId: run.companyId,
				config,
				secrets,
				fetchImpl: async (url, init) =>
					url.endsWith("/ingestion") ? new Response(body, { status: 207 }) : f.impl(url, init),
			});
			expect(out.events).toBeGreaterThan(0);
			expect(out.successes).toBe(0);
			expect(out.errors).toBe(out.events);
		}
		const f = fakeFetch();
		const error = await traceRun({
			runId: run.id,
			companyId: run.companyId,
			config,
			secrets,
			fetchImpl: async (url, init) =>
				url.endsWith("/ingestion")
					? new Response("private-response-content", { status: 400 })
					: f.impl(url, init),
		}).catch((error: unknown) => error);
		expect(error).toBeInstanceOf(Error);
		expect(error instanceof Error ? error.message : "").toBe(
			"run-trace: langfuse ingestion -> 400",
		);
	});

	test("replay receipt size and explicit success status are checked; agent-name fallback is visible", async () => {
		for (const oversized of [false, true]) {
			const f = fakeFetch();
			const out = await traceRun({
				runId: run.id,
				companyId: run.companyId,
				config,
				secrets,
				fetchImpl: async (url, init) => {
					if (url.includes("/api/agents/")) return new Response(null, { status: 404 });
					if (!url.endsWith("/ingestion")) return f.impl(url, init);
					const batch = JSON.parse(String(init?.body)).batch as { id: string }[];
					return Response.json(
						{
							successes: batch.map((e) => ({ id: e.id, ...(oversized ? { status: 201 } : {}) })),
							errors: [],
							...(oversized ? { padding: "x".repeat(65536) } : {}),
						},
						{ status: 207 },
					);
				},
			});
			expect(out.successes).toBe(0);
			expect(out.errors).toBe(out.events);
			expect(out.diagnostics).toEqual(["agent_name_unavailable"]);
		}
	});

	test("replay requests and unfinished response bodies have a finite deadline", async () => {
		for (const hangBody of [false, true]) {
			let requests = 0;
			const fetchImpl = async () => {
				requests++;
				if (!hangBody) return new Promise<Response>(() => {});
				return new Response(
					new ReadableStream({
						start: (controller) => controller.enqueue(new TextEncoder().encode("{")),
					}),
				);
			};
			let guard: ReturnType<typeof setTimeout> | undefined;
			try {
				const attempt = traceRun({
					runId: run.id,
					companyId: run.companyId,
					config,
					secrets,
					fetchImpl,
					requestTimeoutMs: 5,
					sleep: async () => {},
				});
				const bounded = Promise.race([
					attempt,
					new Promise<never>((_resolve, reject) => {
						guard = setTimeout(
							() => reject(new Error("test guard: production request never completed")),
							250,
						);
					}),
				]);
				await expect(bounded).rejects.toThrow("request timeout");
			} finally {
				clearTimeout(guard);
			}
			expect(requests).toBe(4);
		}
	});

	test("Pi canonical delivery verdict is on the trace; only a missing delivery is priced from replay", async () => {
		for (const [receipt, expected, mode] of [
			// This run logged langfuse_disabled and no receipt: nothing was exported, replay prices.
			[null, ["canonical_delivery_missing"], "disabled"],
			// No receipt and no disabled line: Pi may have exported and died, so never priced.
			[null, ["canonical_delivery_unknown"]],
			// Only a nested Pi process logged langfuse_disabled: still unknown.
			[null, ["canonical_delivery_unknown"], "nested"],
			[{ sent: 2, failed: 1, dropped: 0 }, ["canonical_delivery_incomplete"]],
			[{ sent: 2, failed: 0, dropped: 1 }, ["canonical_delivery_incomplete"]],
			[{ sent: 0, failed: 0, dropped: 0 }, ["canonical_delivery_incomplete"]],
			[
				{ sent: 3, failed: 0, dropped: 0, correlation_id: "another-run" },
				["canonical_delivery_unknown"],
			],
			[{ sent: 3, failed: 0, dropped: 0 }, []],
			// The receipt line arrives cut across two stderr chunks.
			[{ sent: 3, failed: 0, dropped: 0 }, [], "split"],
			// A nested Pi process logged langfuse_disabled; this run's receipt still wins.
			[{ sent: 3, failed: 0, dropped: 0 }, [], "nested"],
		] as const) {
			const f = fakeFetch({
				runOverride: {
					status: "failed",
					runnerProfileJson: { adapterDispatch: { adapterType: "pi_local" } },
				},
			});
			const stdout = JSON.stringify({
				stream: "stdout",
				ts: run.startedAt,
				chunk: JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						model: "gpt-6-astra",
						usage: { input: 10, output: 4, cost: { total: 0.25 } },
					},
				}),
			});
			const line = JSON.stringify({
				message: "langfuse_delivery",
				correlation_id: run.id,
				...receipt,
			});
			const entry = (chunk: string) =>
				JSON.stringify({ stream: "stderr", ts: run.startedAt, chunk });
			const disabled = (id: string) =>
				entry(`${JSON.stringify({ message: "langfuse_disabled", correlation_id: id })}\n`);
			const stderr = [
				mode === "disabled" && disabled(run.id),
				mode === "nested" && disabled("child"),
				receipt &&
					(mode === "split"
						? `${entry(line.slice(0, 20))}\n${entry(line.slice(20))}`
						: entry(line)),
			]
				.filter(Boolean)
				.join("\n");
			const fetchImpl = async (url: string, init?: RequestInit) =>
				url.endsWith("/log")
					? Response.json({ content: `${stdout}\n${stderr}` })
					: f.impl(url, init);
			const out = await traceRun({
				runId: run.id,
				companyId: run.companyId,
				config,
				secrets,
				fetchImpl,
			});
			expect(out.diagnostics).toEqual([...expected]);
			const batch = JSON.parse(
				String(f.calls.find((call) => call.url.endsWith("/ingestion"))?.init?.body),
			).batch as { type: string; body: { metadata?: Record<string, unknown> } }[];
			const verdict = expected[0] ?? "canonical_delivery_confirmed";
			expect(batch[0]?.body.metadata?.canonicalDelivery).toBe(verdict);
			// Nothing delivered directly: replay prices the run. Otherwise it stays diagnostic.
			const missing = verdict === "canonical_delivery_missing";
			expect(batch.filter((event) => event.type === "generation-create")).toHaveLength(
				missing ? 1 : 0,
			);
			const spans = batch.filter((event) => event.type === "span-create");
			expect(spans).toHaveLength(missing ? 0 : 1);
			for (const key of ["usage", "usageDetails", "costDetails"])
				expect(spans[0]?.body ?? {}).not.toHaveProperty(key);
		}
	});
});

describe("worker", () => {
	test("secrets are resolved once for two runs of one company", async () => {
		mock.module("@paperclipai/plugin-sdk", () => ({
			definePlugin: (p: unknown) => p,
			runWorker: () => {},
		}));
		// worker.js has no .d.ts; a non-literal specifier keeps tsc from demanding one.
		const workerPath: string = "../../fleet/plugins/run-trace/worker.js";
		const plugin = (await import(workerPath)).default as {
			setup: (c: unknown) => Promise<void>;
		};
		const handlers: Record<string, (e: unknown) => Promise<void>> = {};
		let resolves = 0;
		const ctx = {
			config: { get: async () => ({ ...config, ...secrets }) },
			secrets: {
				resolve: async (ref: string) => {
					resolves++;
					return ref;
				},
			},
			events: { on: (n: string, h: (e: unknown) => Promise<void>) => (handlers[n] = h) },
			logger: { info: () => {}, warn: () => {} },
		};
		const f = fakeFetch();
		const realFetch = globalThis.fetch;
		globalThis.fetch = f.impl as typeof fetch;
		try {
			await plugin.setup(ctx);
			const ev = { companyId: "co-1", payload: { runId: run.id } };
			await handlers["agent.run.finished"]?.(ev);
			await handlers["agent.run.finished"]?.(ev);
		} finally {
			globalThis.fetch = realFetch;
		}
		expect(resolves).toBe(3);
		expect(f.calls.filter((c) => c.url.endsWith("/ingestion"))).toHaveLength(1);
	});

	test("concurrent replays coalesce; partial delivery warns and later events can retry", async () => {
		mock.module("@paperclipai/plugin-sdk", () => ({
			definePlugin: (p: unknown) => p,
			runWorker: () => {},
		}));
		const workerPath: string = "../../fleet/plugins/run-trace/worker.js";
		const plugin = (await import(workerPath)).default as { setup: (c: unknown) => Promise<void> };
		const handlers: Record<string, (e: unknown) => Promise<void>> = {};
		const warnings: string[] = [];
		const infos: string[] = [];
		await plugin.setup({
			config: { get: async () => ({ ...config, ...secrets }) },
			secrets: { resolve: async (ref: string) => ref },
			events: {
				on: (name: string, handler: (e: unknown) => Promise<void>) => (handlers[name] = handler),
			},
			logger: {
				info: (line: string) => infos.push(line),
				warn: (line: string) => warnings.push(line),
			},
		});
		const f = fakeFetch();
		const realFetch = globalThis.fetch;
		let partial = true;
		globalThis.fetch = (async (url: string, init?: RequestInit) =>
			partial && url.endsWith("/ingestion")
				? new Response(JSON.stringify({ successes: [], errors: [] }), { status: 207 })
				: f.impl(url, init)) as typeof fetch;
		try {
			const ev = { companyId: "co-1", payload: { runId: run.id } };
			await Promise.all([
				handlers["agent.run.finished"]?.(ev),
				handlers["agent.run.finished"]?.(ev),
			]);
			expect(warnings).toHaveLength(1);
			expect(infos).toHaveLength(0);
			partial = false;
			await handlers["agent.run.finished"]?.(ev);
			await handlers["agent.run.finished"]?.(ev);
			expect(f.calls.filter((c) => c.url.endsWith("/ingestion"))).toHaveLength(1);
			expect(infos).toHaveLength(1);
		} finally {
			globalThis.fetch = realFetch;
		}
	});
});
