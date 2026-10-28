/**
 * The results consumer's wake seam: a stored runner artifact requests
 * an early reconcile pass through the scheduler's coalescing trigger instead of
 * waiting up to `poll_interval_minutes` for the timer.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { startResultsConsumerOrNone, wakePassOnStoredResult } from "../../src/bus/side-channels";
import { withTestDb } from "../db/helpers";
import { until } from "../support/wait-until";

/**
 * Capture NDJSON lines the process logger writes to fd 2 during `fn`; `fn`
 * may read the lines captured so far, to wait on a log line it expects.
 */
async function withCapturedLogs<T>(
	fn: (linesSoFar: () => Array<Record<string, unknown>>) => Promise<T>,
): Promise<{ result: T; lines: Array<Record<string, unknown>> }> {
	const original = fs.writeSync;
	const chunks: string[] = [];
	(fs as { writeSync: typeof fs.writeSync }).writeSync = ((
		fd: number,
		data: string | Uint8Array,
		...rest: unknown[]
	) => {
		if (fd === 2) {
			chunks.push(typeof data === "string" ? data : new TextDecoder().decode(data));
			return typeof data === "string" ? data.length : data.byteLength;
		}
		return (original as (...a: unknown[]) => number)(fd, data, ...rest);
	}) as typeof fs.writeSync;
	try {
		const result = await fn(() => parseLines(chunks));
		return { result, lines: parseLines(chunks) };
	} finally {
		(fs as { writeSync: typeof fs.writeSync }).writeSync = original;
	}
}

function parseLines(chunks: string[]): Array<Record<string, unknown>> {
	return chunks
		.join("")
		.split("\n")
		.filter((l) => l.startsWith("{"))
		.map((l) => JSON.parse(l) as Record<string, unknown>);
}

const GOOD_HEADERS = {
	"Nats-Msg-Id": "rj-9:runner-a:result.json",
	"Factory-Job": "rj-9",
	"Factory-Hostname": "runner-a",
	"Factory-Artifact": "result.json",
};

describe("wakePassOnStoredResult", () => {
	test("rings the scheduler's coalescing trigger exactly once", async () => {
		let triggers = 0;
		wakePassOnStoredResult({
			trigger: async () => {
				triggers += 1;
			},
		});
		await Promise.resolve();
		expect(triggers).toBe(1);
	});

	test("a rejecting trigger is logged at warn and never thrown into the consumer", async () => {
		const { lines } = await withCapturedLogs(async (linesSoFar) => {
			wakePassOnStoredResult({ trigger: () => Promise.reject(new Error("scheduler down")) });
			await until(
				() => linesSoFar().some((l) => l.msg === "bus.results.wake_failed"),
				2_000,
				"wake_failed logged",
			);
		});
		const failed = lines.filter((l) => l.msg === "bus.results.wake_failed");
		expect(failed.length).toBe(1);
		expect(failed[0]?.level).toBe("warn");
		expect(JSON.stringify(failed[0])).not.toContain("scheduler down");
	});
});

describe("startResultsConsumerOrNone forwards the wake", () => {
	test("a fresh stored artifact rings onStored through the OrNone wrapper", async () => {
		await withTestDb(async (db) => {
			const calls: string[] = [];
			const msg = {
				subject: "factory.jobs.rj-9.result",
				data: new TextEncoder().encode("{}"),
				headers: { get: (k: string) => (GOOD_HEADERS as Record<string, string>)[k] ?? "" },
				ack: () => calls.push("ack"),
				nak: () => calls.push("nak"),
				term: () => calls.push("term"),
			};
			let fetches = 0;
			const consumer = {
				fetch: async (opts: { expires: number }) => {
					fetches += 1;
					const batch = fetches === 1 ? [msg] : [];
					if (batch.length === 0) await new Promise((resolve) => setTimeout(resolve, opts.expires)); // fixed-sleep-ok: simulated latency in a fake
					return {
						[Symbol.asyncIterator]: async function* () {
							yield* batch;
						},
					};
				},
			};
			const bus = {
				connection: {
					jetstreamManager: async () => ({
						consumers: {
							add: async (_s: string, cfg: Record<string, unknown>) => ({ config: cfg }),
						},
					}),
					jetstream: () => ({ consumers: { get: async () => consumer } }),
				},
			};
			let rings = 0;
			const { result: handle } = await withCapturedLogs(() =>
				startResultsConsumerOrNone(bus as never, db as never, {
					trigger: async () => {
						rings += 1;
					},
				}),
			);
			expect(handle).toBeDefined();
			await until(() => calls.length > 0, 2_000, "message settled");
			await handle?.stop();
			expect(calls).toEqual(["ack"]);
			expect(rings).toBe(1);
		});
	}, 15_000); // stop() waits out one empty fetch (DEFAULT_EXPIRES_MS = 5s) before it returns
});
