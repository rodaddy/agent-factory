/**
 * @module tests/fleet/forge-pr-event-wake
 * @description Real-time seat wakes and superseded-run stops (lane L2).
 *   forge-pr subscribes to run-end events and wakes the ended run's seat at
 *   once; cancelTask cancels through the board route (which stops the live
 *   run) when boardApiKey is set, else through ctx.issues.update.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import manifest from "../../fleet/plugins/forge-pr/manifest.js";

const CO = "co-1";
const KEY = "board-key-123";
const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

type Worker = {
	default: { setup: (ctx: unknown) => Promise<void> };
	settleDeps: (companyId: string) => {
		cancelTask: (id: string, comment: string) => Promise<void>;
	};
};

async function load(cfg: Record<string, unknown>) {
	// Scheduling fixture: the protected host admits this task. Real receipt/refusal
	// behavior is exercised separately in review-round-ledger.test.ts.
	mock.module("../../fleet/plugins/forge-pr/review-admission-client.js", () => ({
		reviewAdmissionFor: () => async () => ({ action: "start" }),
	}));
	mock.module("@paperclipai/plugin-sdk", () => ({
		definePlugin: (p: unknown) => p,
		runWorker: () => {},
	}));
	const workerPath: string = "../../fleet/plugins/forge-pr/worker.js";
	const mod = (await import(workerPath)) as Worker;
	const updates: Array<[string, unknown]> = [];
	const comments: string[] = [];
	const invoked: Array<{ agentId: string; prompt: string }> = [];
	const wakes: Array<{ issueId: string; companyId: string; opts: unknown }> = [];
	const handlers = new Map<string, (e: unknown) => Promise<void>>();
	const logs: string[] = [];
	const state: Record<string, unknown> = {};
	const ctx = {
		companies: { list: async () => [{ id: CO }] },
		config: { get: async () => cfg },
		secrets: { resolve: async () => KEY },
		agents: {
			list: async () => [],
			// The host emits the run event before it sets the seat idle
			// (finalizeAgentStatus), so at delivery the seat still reads running.
			get: async (id: string) => ({ id, name: "Adams", status: "running" }),
			invoke: async (agentId: string, _co: string, opts: { prompt: string }) => {
				invoked.push({ agentId, prompt: opts.prompt });
				return { runId: "new" };
			},
		},
		issues: {
			list: async (q: { status?: string }) =>
				q.status === "todo"
					? [
							{
								id: "i1",
								identifier: "SOF-7",
								title: "t",
								status: "todo",
								createdAt: "2026-10-07T09:00:00Z",
							},
						]
					: [],
			update: async (id: string, patch: unknown) => void updates.push([id, patch]),
			requestWakeup: async (issueId: string, companyId: string, opts: unknown) => {
				wakes.push({ issueId, companyId, opts });
				return { queued: true };
			},
			createComment: async (_id: string, c: string) => void comments.push(c),
		},
		state: {
			get: async (k: { stateKey: string }) => state[k.stateKey],
			set: async (k: { stateKey: string }, v: unknown) => {
				state[k.stateKey] = v;
			},
		},
		jobs: { register: () => {} },
		events: {
			on: (name: string, fn: (e: unknown) => Promise<void>) => void handlers.set(name, fn),
		},
		logger: {
			info: (l: string) => logs.push(l),
			warn: (l: string, meta?: unknown) => logs.push(`${l} ${JSON.stringify(meta ?? {})}`),
		},
	};
	await mod.default.setup(ctx);
	return { mod, updates, comments, invoked, wakes, handlers, logs };
}

function stubFetch(status: number) {
	const calls: Array<{ url: string; init: RequestInit }> = [];
	globalThis.fetch = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		return new Response("", { status });
	}) as unknown as typeof fetch;
	return calls;
}

describe("run-end events wake the seat at once", () => {
	test("setup subscribes to finished, failed and cancelled run events", async () => {
		const w = await load({});
		expect([...w.handlers.keys()].sort()).toEqual([
			"agent.run.cancelled",
			"agent.run.failed",
			"agent.run.finished",
		]);
	});

	// SOF-11432: agents.invoke starts a run with no issue, and the board refuses
	// its cross-issue writes, so the run-end wake goes through requestWakeup.
	test("an agent.run.finished event wakes the seat (still reading running) on its oldest task, once, issue-scoped", async () => {
		const w = await load({});
		const ev = { companyId: CO, payload: { runId: "run-1", agentId: "a1", status: "succeeded" } };
		const handler = w.handlers.get("agent.run.finished");
		await handler?.(ev);
		await handler?.(ev);
		expect(w.wakes).toEqual([
			{
				issueId: "i1",
				companyId: CO,
				opts: { reason: expect.any(String), contextSource: "forge-pr.run-end-wake" },
			},
		]);
		expect(w.invoked).toEqual([]);
	});
});

describe("cancelTask stops the superseded run through the board route", () => {
	test("(e) with boardApiKey set it PATCHes the board with the bearer key and status cancelled", async () => {
		const calls = stubFetch(200);
		const w = await load({ boardApiKey: { type: "secret_ref", secretId: "s" } });
		await w.mod.settleDeps(CO).cancelTask("iss-9", "superseded");
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("http://127.0.0.1:3100/api/issues/iss-9");
		expect(calls[0]?.init.method).toBe("PATCH");
		expect((calls[0]?.init.headers as Record<string, string> | undefined)?.Authorization).toBe(
			`Bearer ${KEY}`,
		);
		expect(JSON.parse(String(calls[0]?.init.body))).toEqual({ status: "cancelled" });
		expect(w.updates).toHaveLength(0);
		expect(w.comments).toEqual(["superseded"]);
	});

	test("(f) with boardApiKey unset it falls back to ctx.issues.update", async () => {
		const calls = stubFetch(200);
		const w = await load({});
		await w.mod.settleDeps(CO).cancelTask("iss-9", "superseded");
		expect(calls).toHaveLength(0);
		expect(w.updates).toEqual([["iss-9", { status: "cancelled" }]]);
		expect(w.comments).toEqual(["superseded"]);
	});

	test("(f) a board PATCH returning 500 falls back to ctx.issues.update and never logs the key", async () => {
		stubFetch(500);
		const w = await load({ boardApiKey: { type: "secret_ref", secretId: "s" } });
		await w.mod.settleDeps(CO).cancelTask("iss-9", "superseded");
		expect(w.updates).toEqual([["iss-9", { status: "cancelled" }]]);
		expect(w.logs.join("\n")).not.toContain(KEY);
	});
});

describe("(g) the manifest", () => {
	test("declares events.subscribe and a boardApiKey secret_ref", () => {
		expect(manifest.capabilities).toContain("events.subscribe");
		const schema = manifest.instanceConfigSchema as {
			properties: Record<string, { properties?: { type?: { const?: string } } }>;
			required: string[];
		};
		expect(schema.properties.boardApiKey?.properties?.type?.const).toBe("secret_ref");
		expect(schema.required).not.toContain("boardApiKey");
	});
});
