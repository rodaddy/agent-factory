import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { createKboardClient, type FetchLike } from "../../src/kboard/client";
import type { KboardToken } from "../../src/kboard/config";

/** A token wrapper carrying an arbitrary raw value, for the security test. */
function tokenOf(raw: string): KboardToken {
	return { authorization: () => `Bearer ${raw}` };
}

const TOKEN = tokenOf("test-token");

/** One recorded request the fake fetch saw. */
interface Seen {
	url: string;
	method: string;
	headers: Record<string, string>;
	body: unknown;
}

/** A scripted response the fake fetch returns for the matching call. */
type Reply = { status: number; json: unknown } | { throw: Error };

/**
 * Build an injectable fetch that returns queued replies in order and records
 * every call. A `throw` reply simulates a transport failure.
 */
function fakeFetch(replies: Reply[]): { fetch: FetchLike; seen: Seen[] } {
	const seen: Seen[] = [];
	let i = 0;
	const fetch: FetchLike = async (url, init) => {
		const headers = (init?.headers ?? {}) as Record<string, string>;
		seen.push({
			url,
			method: init?.method ?? "GET",
			headers,
			body: init?.body ? JSON.parse(String(init.body)) : undefined,
		});
		const reply = replies[Math.min(i, replies.length - 1)];
		i++;
		if (reply === undefined) throw new Error("fakeFetch: no reply queued");
		if ("throw" in reply) throw reply.throw;
		return new Response(JSON.stringify(reply.json), {
			status: reply.status,
			headers: { "content-type": "application/json" },
		});
	};
	return { fetch, seen };
}

const noSleep = async () => {};

function task(over: Record<string, unknown> = {}) {
	return {
		task_id: "t_abc123",
		title: "Do the thing",
		status: "ready",
		sync_version: 7,
		assignee: null,
		tenant: "fleet",
		...over,
	};
}

describe("kboard/client", () => {
	test("health returns the parsed ok body", async () => {
		const { fetch } = fakeFetch([{ status: 200, json: { status: "ok", db: "connected" } }]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.health();
		expect(out.kind).toBe("ok");
		if (out.kind !== "ok") return;
		expect(out.value.status).toBe("ok");
		expect(out.value.db).toBe("connected");
	});

	test("listTasks accepts the envelope form and passes the repo filter", async () => {
		const { fetch, seen } = fakeFetch([
			{ status: 200, json: { tasks: [task(), task({ task_id: "t_two" })], count: 2 } },
		]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.listTasks({ repo: "rodaddy/software-factory", status: "ready" });
		expect(out.kind).toBe("ok");
		if (out.kind !== "ok") return;
		expect(out.value).toHaveLength(2);
		expect(seen[0]?.url).toContain("repo=rodaddy%2Fsoftware-factory");
		expect(seen[0]?.url).toContain("status=ready");
	});

	test("listTasks also accepts a bare-array response", async () => {
		const { fetch } = fakeFetch([{ status: 200, json: [task()] }]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.listTasks();
		expect(out.kind).toBe("ok");
		if (out.kind !== "ok") return;
		expect(out.value[0]?.task_id).toBe("t_abc123");
	});

	test("listTasks rejects an unknown status at the boundary (logged shape only)", async () => {
		const { fetch } = fakeFetch([{ status: 200, json: { tasks: [task({ status: "archived" })] } }]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.listTasks();
		expect(out.kind).toBe("rejected");
	});

	test("claim happy path sends expected_sync_version and the factory-watcher assignee", async () => {
		const { fetch, seen } = fakeFetch([
			{ status: 200, json: task({ status: "ready", assignee: null, sync_version: 7 }) },
			{
				status: 200,
				json: task({ status: "running", assignee: "factory-watcher", sync_version: 9 }),
			},
		]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.claimTask("t_abc123");
		expect(out.kind).toBe("ok");
		if (out.kind !== "ok") return;
		expect(out.task.assignee).toBe("factory-watcher");
		// The GET precedes the PATCH; the PATCH echoes the fresh sync_version.
		expect(seen).toHaveLength(2);
		expect(seen[0]?.method).toBe("GET");
		expect(seen[1]?.method).toBe("PATCH");
		expect(seen[1]?.body).toMatchObject({
			assignee: "factory-watcher",
			status: "running",
			expected_sync_version: 7,
		});
	});

	test("claim of an assigned task returns not_claimable WITHOUT a PATCH", async () => {
		const { fetch, seen } = fakeFetch([
			{ status: 200, json: task({ status: "ready", assignee: "someone-else" }) },
		]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.claimTask("t_abc123");
		expect(out.kind).toBe("not_claimable");
		// Exactly one call — the GET. No PATCH was sent.
		expect(seen).toHaveLength(1);
		expect(seen.every((s) => s.method !== "PATCH")).toBe(true);
	});

	test("claim of a non-claimable status returns not_claimable WITHOUT a PATCH", async () => {
		const { fetch, seen } = fakeFetch([
			{ status: 200, json: task({ status: "running", assignee: null }) },
		]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.claimTask("t_abc123");
		expect(out.kind).toBe("not_claimable");
		expect(seen).toHaveLength(1);
	});

	test("a CAS miss (409 on the PATCH) is a typed outcome and is NOT blind-retried", async () => {
		const { fetch, seen } = fakeFetch([
			{ status: 200, json: task({ status: "ready", assignee: null, sync_version: 7 }) },
			{ status: 409, json: { error: "version_conflict", detail: "stale" } },
		]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.claimTask("t_abc123");
		expect(out.kind).toBe("cas_miss");
		// One GET, one PATCH, then STOP — no second PATCH attempt.
		expect(seen).toHaveLength(2);
		expect(seen.filter((s) => s.method === "PATCH")).toHaveLength(1);
	});

	test("a 400 expected_sync_version_required on the PATCH also maps to cas_miss", async () => {
		const { fetch } = fakeFetch([
			{ status: 200, json: task({ status: "ready", assignee: null }) },
			{ status: 400, json: { error: "expected_sync_version_required", detail: "phase-2 CAS" } },
		]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.claimTask("t_abc123");
		expect(out.kind).toBe("cas_miss");
	});

	test("setStatus reads fresh then CAS-patches the requested status", async () => {
		const { fetch, seen } = fakeFetch([
			{
				status: 200,
				json: task({ status: "running", assignee: "factory-watcher", sync_version: 11 }),
			},
			{
				status: 200,
				json: task({ status: "review", assignee: "factory-watcher", sync_version: 12 }),
			},
		]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.setStatus("t_abc123", "review");
		expect(out.kind).toBe("ok");
		expect(seen[1]?.method).toBe("PATCH");
		expect(seen[1]?.body).toMatchObject({ status: "review", expected_sync_version: 11 });
	});

	test("setPrNumber reads fresh then CAS-patches repo_pr_number", async () => {
		const { fetch, seen } = fakeFetch([
			{
				status: 200,
				json: task({ status: "review", assignee: "factory-watcher", sync_version: 3 }),
			},
			{
				status: 200,
				json: task({
					status: "review",
					assignee: "factory-watcher",
					sync_version: 4,
					repo_pr_number: 42,
				}),
			},
		]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.setPrNumber("t_abc123", 42);
		expect(out.kind).toBe("ok");
		expect(seen[1]?.body).toMatchObject({ repo_pr_number: 42, expected_sync_version: 3 });
	});

	test("an ownership 403 on a mutation maps to ownership_refused", async () => {
		const { fetch } = fakeFetch([
			{
				status: 200,
				json: task({ status: "running", assignee: "factory-watcher", sync_version: 1 }),
			},
			{ status: 403, json: { detail: "authenticated actor does not own this task" } },
		]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.setStatus("t_abc123", "review");
		expect(out.kind).toBe("ownership_refused");
	});

	test("postEvent success returns the event id and sends actor + idempotency_key", async () => {
		const { fetch, seen } = fakeFetch([
			{ status: 200, json: { event_id: "e_1", event_type: "dispatched" } },
		]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.postEvent("t_abc123", {
			eventType: "dispatched",
			idempotencyKey: "t_abc123:job-9:dispatched",
		});
		expect(out.kind).toBe("ok");
		if (out.kind !== "ok") return;
		expect(out.eventId).toBe("e_1");
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.body).toMatchObject({
			event_type: "dispatched",
			actor: "factory-watcher",
			idempotency_key: "t_abc123:job-9:dispatched",
		});
	});

	test("a 409 on postEvent is idempotent success, not an error", async () => {
		const { fetch, seen } = fakeFetch([
			{ status: 409, json: { detail: "Event with idempotency_key 'k' already exists" } },
		]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.postEvent("t_abc123", {
			eventType: "dispatched",
			idempotencyKey: "k",
		});
		expect(out.kind).toBe("already_logged");
		// POST is never retried at the transport layer.
		expect(seen).toHaveLength(1);
	});

	test("a transient 500 is retried up to the bound, then reported as a typed failure", async () => {
		const { fetch, seen } = fakeFetch([
			{ status: 500, json: { detail: "boom" } },
			{ status: 500, json: { detail: "boom" } },
			{ status: 500, json: { detail: "boom" } },
			{ status: 500, json: { detail: "boom" } },
		]);
		const client = createKboardClient({
			token: TOKEN,
			fetch,
			sleep: noSleep,
			maxRetries: 2,
		});
		const out = await client.getTask("t_abc123");
		expect(out.kind).toBe("rejected");
		// 1 initial + 2 retries = 3 attempts.
		expect(seen).toHaveLength(3);
	});

	test("a network error is retried then reported as transport_failed", async () => {
		const { fetch, seen } = fakeFetch([
			{ throw: new Error("connection reset") },
			{ throw: new Error("connection reset") },
			{ throw: new Error("connection reset") },
		]);
		const client = createKboardClient({
			token: TOKEN,
			fetch,
			sleep: noSleep,
			maxRetries: 1,
		});
		const out = await client.getTask("t_abc123");
		expect(out.kind).toBe("transport_failed");
		expect(seen).toHaveLength(2);
	});

	test("a 404 on a read is a typed not_found", async () => {
		const { fetch } = fakeFetch([{ status: 404, json: { detail: "Task t_x not found" } }]);
		const client = createKboardClient({ token: TOKEN, fetch, sleep: noSleep });
		const out = await client.getTask("t_x");
		expect(out.kind).toBe("not_found");
	});

	test("SECURITY: the token never reaches a thrown message, outcome field, or log line", async () => {
		const SENTINEL = "SENTINEL_KBOARD_TOKEN";
		// The fake fetch 500s repeatedly (a definitive-then-failing transport) so
		// every error, retry, and log path is exercised while the token is live.
		const { fetch } = fakeFetch([
			{ throw: new Error("network down") },
			{ throw: new Error("network down") },
			{ throw: new Error("network down") },
			{ throw: new Error("network down") },
		]);

		// Capture stderr the way tests/status/server.test.ts does. Post-#88 the
		// logger (src/log.ts, pino) writes NDJSON synchronously to fd 2 via
		// fs.writeSync, NOT through process.stderr.write, so capture at the
		// descriptor level or the log lines are invisible and this assertion
		// passes vacuously.
		const lines: string[] = [];
		const realWriteSync = fs.writeSync;
		(fs as { writeSync: typeof fs.writeSync }).writeSync = ((
			fd: number,
			data: string | NodeJS.ArrayBufferView,
			...rest: unknown[]
		) => {
			if (fd === 2) {
				const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString();
				lines.push(text);
				return typeof data === "string" ? Buffer.byteLength(text) : (data as Uint8Array).length;
			}
			return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
		}) as typeof fs.writeSync;

		let out: unknown;
		let thrownText = "";
		try {
			const client = createKboardClient({
				token: tokenOf(SENTINEL),
				fetch,
				sleep: noSleep,
				maxRetries: 2,
			});
			try {
				out = await client.getTask("t_abc123");
			} catch (err) {
				thrownText = err instanceof Error ? err.message : String(err);
			}
			// Also drive a mutation and an event so every error path runs with the
			// live sentinel token.
			const mutation = await client.setStatus("t_abc123", "review").catch((e) => String(e));
			const event = await client
				.postEvent("t_abc123", { eventType: "dispatched", idempotencyKey: "k" })
				.catch((e) => String(e));
			out = JSON.stringify([out, mutation, event]);
		} finally {
			(fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
		}

		expect(thrownText).not.toContain(SENTINEL);
		expect(JSON.stringify(out)).not.toContain(SENTINEL);
		expect(lines.join("")).not.toContain(SENTINEL);
	});
});
