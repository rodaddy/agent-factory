/**
 * The absent/unusable-stream skip is VISIBLE (second finding).
 *
 * `observability.stream.skipped` logged at `debug`, and the level is fixed at
 * module init from `LOG_LEVEL` — so at the default deployment level the line does
 * not exist. Every attempt for two days skipped its stream and produced ZERO
 * operator-visible signal; diagnosing it cost a full job cycle.
 *
 * `info`, not `debug`, is the smallest mechanism consistent with this module's
 * own precedent: `observability.langfuse.flushed` (attempt-observer.ts) is `info`
 * for exactly this reason, and its comment states it — a debug line is invisible
 * in the default deployment AND untestable.
 *
 * THE CONTROL CLAUSE IS MANDATORY (done-means rule 3). A test that only asserts
 * "the skip is loud" cannot tell you the change made every healthy attempt loud
 * too, which would bury the signal it exists to surface. So the healthy path —
 * a parseable stream — is asserted to emit NO skip line at all.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import type { WatcherDb } from "../../src/db/client";
import { AttemptObserver } from "../../src/observability/attempt-observer";

/** The stable event name the skip emits. */
const SKIP_EVENT = "observability.stream.skipped";

/**
 * Capture the NDJSON lines written to fd 2 while `fn` runs.
 *
 * The same seam `tests/observability/shutdown-wiring.test.ts` uses: pino is
 * constructed once at module init against `pino.destination({dest: 2, sync:
 * true})`, so intercepting `fs.writeSync` is the only way to read what a level
 * actually emitted without re-importing the logger under a different env.
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
 * A database stub that THROWS on any use.
 *
 * The skip line is emitted BEFORE any database work, so a real database proves
 * nothing here and a permissive stub would hide a regression that moved the log
 * line below the join (done-means rule 11: the fake throws on an unscripted
 * call). If the skip ever becomes conditional on a successful db round trip,
 * this test fails loudly rather than passing against a silently different code
 * path.
 *
 * sf#183 SHARPENED WHAT THIS GUARDS. The skip used to sit in front of an early
 * `return`, so its independence from the database was incidental — nothing after
 * it ran at all. The durable raw-record copy now continues past it, so the
 * ordering is a deliberate property rather than a side effect, and these clauses
 * are the thing that pins it.
 */
const refusingDb = new Proxy(
	{},
	{
		get(_t, prop) {
			throw new Error(`db was consulted on the skip path: .${String(prop)}()`);
		},
	},
) as unknown as WatcherDb;

/** A parseable stream carrying one attested assistant turn — the healthy control. */
function healthyStream(): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			model: "gpt-5.6-sol",
			provider: "cliproxy",
			content: [{ type: "text", text: "ok" }],
			timestamp: Date.now(),
		},
	});
}

/** Drive one observation to settlement, returning the captured log lines. */
async function observeAndSettle(rawEventStream: string, db: WatcherDb) {
	const { lines } = await withCapturedLogs(async () => {
		const observer = new AttemptObserver(db, null);
		observer.observe({
			jobRunnerId: "rw-skip-1",
			hostname: "runner-1",
			rawEventStream,
			ingested: true,
			schemaValid: true,
		});
		// `observe` is void-returning by contract; `shutdown` drains the detached
		// chain, which is the documented way to await it.
		await observer.shutdown();
	});
	return lines;
}

describe("the unusable-stream skip is operator-visible", () => {
	test("an unparseable stream emits the skip at INFO, not debug", async () => {
		const lines = await observeAndSettle("this is not jsonl at all", refusingDb);
		const skip = lines.find((l) => l.msg === SKIP_EVENT);
		expect(skip).toBeDefined();
		// THE ASSERTION IS THE LEVEL, not merely the line's existence. At `debug`
		// the line is absent entirely at the default level — which is the defect —
		// so a presence-only assertion would pass under a debug LOG_LEVEL and red
		// under the default one, measuring the environment instead of the code.
		expect(skip?.level).toBe("info");
	});

	test("the skip names the attempt so an operator can go look", async () => {
		const lines = await observeAndSettle("{not json", refusingDb);
		const skip = lines.find((l) => l.msg === SKIP_EVENT);
		expect(skip?.job_runner_id).toBe("rw-skip-1");
		expect(skip?.host).toBe("runner-1");
	});

	test("CONTROL: a healthy parseable stream emits NO skip line", async () => {
		// The healthy path reaches the identity join, which the refusing stub turns
		// into a throw the observer catches — so this asserts the ABSENCE of the
		// skip, which is the only thing under test here. Without this clause,
		// raising the level unconditionally (logging on every attempt) would pass
		// the two clauses above while burying the signal in per-attempt noise.
		const lines = await observeAndSettle(healthyStream(), refusingDb);
		expect(lines.some((l) => l.msg === SKIP_EVENT)).toBe(false);
	});
});
