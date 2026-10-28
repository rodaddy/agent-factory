/**
 * The ABSENT event stream is operator-visible at the INGEST boundary.
 *
 * #219 raised the observer's unusable-stream skip to `info`, but that skip is
 * unreachable for a genuinely absent stream: `observeAttempt` in
 * `src/results/ingest.ts` early-returns when `readEventStream` yields null or
 * whitespace, so `observer.observe` is never called and nothing is logged at any
 * level. The two-day zero-signal outage #219 describes ran through THIS path,
 * not the observer's — the observer's raised skip covers present-but-unusable
 * streams only.
 *
 * `info`, not `debug`, for the reason #219's own comment states one module over:
 * the level is fixed at module init from `LOG_LEVEL`, so a debug line does not
 * exist in the default deployment, which is precisely where "the producer never
 * ran" and "nothing happened" look identical from outside.
 *
 * THE CONTROL CLAUSE IS MANDATORY (done-means rules 3 and 21). A visibility
 * change asserted only by "the bad path is loud" stays green when the signal
 * fires unconditionally — which would emit one line per attempt and bury the
 * signal it exists to surface. So the healthy path (a present, non-empty stream)
 * is asserted to emit NO absent-stream line at all, and that clause is the one
 * the rule-21 mutation (make the signal unconditional) is aimed at.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import {
	type IngestObserver,
	ingestResult,
	type ResultReader,
	type ResultStore,
} from "../../src/results/ingest";

/** The stable event name the absent-stream signal emits. */
const ABSENT_EVENT = "results.ingest.event_stream_absent";

/**
 * Capture the NDJSON lines written to fd 2 while `fn` runs.
 *
 * The same seam `tests/observability/stream-skip-visibility.test.ts` uses: pino
 * is constructed once at module init against `pino.destination({dest: 2, sync:
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

/** A schema-valid, report-only result document — the ordinary ingest path. */
function validResultDocument(): string {
	return JSON.stringify({
		result_version: 1,
		job_id: 240,
		lane: "issue-triage",
		status: "ok",
		host: "runner-1",
		summary: "nothing to report",
	});
}

/**
 * A reader whose event stream is whatever the caller scripts.
 *
 * `readEventStream` is DEFINED here on purpose: the guard one line above the
 * site under test already returns when the method is absent, so a reader without
 * it would exercise a different branch entirely and pass regardless.
 */
function readerWith(eventStream: string | null): ResultReader & { streamReads: number } {
	return {
		streamReads: 0,
		isDone: async () => true,
		readResult: async () => validResultDocument(),
		async readEventStream(this: { streamReads: number }) {
			this.streamReads += 1;
			return eventStream;
		},
	};
}

/** A store that accepts everything; persistence is not what this file asserts. */
const acceptingStore: ResultStore = { persist: async () => undefined };

/**
 * An observer that RECORDS its calls rather than doing anything.
 *
 * `track` is implemented so the detached observation chain has a holder this
 * test can await — untracked, the read+log races the assertion and the suite
 * measures its own timing instead of the code (done-means rule 5).
 */
function recordingObserver(): IngestObserver & { observed: number; drain(): Promise<void> } {
	const inFlight: Promise<void>[] = [];
	return {
		observed: 0,
		track(work: Promise<void>) {
			inFlight.push(work);
		},
		observe(this: { observed: number }) {
			this.observed += 1;
		},
		async drain() {
			await Promise.all(inFlight);
		},
	};
}

/** Drive one ingest to settlement, returning the captured lines and the observer. */
async function ingestAndSettle(eventStream: string | null) {
	const reader = readerWith(eventStream);
	const observer = recordingObserver();
	const { lines } = await withCapturedLogs(async () => {
		await ingestResult({
			reader,
			store: acceptingStore,
			jobRunnerId: "rw-absent-1",
			hostname: "runner-1",
			observer,
		});
		// The observation chain is detached by contract; `track` is the documented
		// way to await it.
		await observer.drain();
	});
	return { lines, reader, observer };
}

describe("the absent event stream is visible at the ingest early-return", () => {
	test("an ABSENT stream (null) emits the signal at INFO, not debug", async () => {
		const { lines } = await ingestAndSettle(null);
		const signal = lines.find((l) => l.msg === ABSENT_EVENT);
		expect(signal).toBeDefined();
		// THE ASSERTION IS THE LEVEL. At `debug` the line does not exist at the
		// default level — which is the defect — so a presence-only assertion would
		// pass under a debug LOG_LEVEL and red under the default one, measuring the
		// environment rather than the code.
		expect(signal?.level).toBe("info");
	});

	test("the signal names the job and attempt so an operator can go look", async () => {
		const { lines } = await ingestAndSettle(null);
		const signal = lines.find((l) => l.msg === ABSENT_EVENT);
		expect(signal?.job_runner_id).toBe("rw-absent-1");
		expect(signal?.host).toBe("runner-1");
	});

	test("an EMPTY stream is signalled too, and distinguishes itself from absent", async () => {
		// Whitespace-only shares the same early-return and the same non-event, but a
		// written-then-empty file and a never-written one are different producer
		// faults; the operator needs to tell them apart from the line alone.
		const absent = (await ingestAndSettle(null)).lines.find((l) => l.msg === ABSENT_EVENT);
		const empty = (await ingestAndSettle("   \n")).lines.find((l) => l.msg === ABSENT_EVENT);
		expect(empty).toBeDefined();
		expect(empty?.level).toBe("info");
		expect(empty?.reason).not.toBe(absent?.reason);
	});

	test("CONTROL: a PRESENT stream emits NO absent-stream line", async () => {
		// The noise regression this clause exists to catch (done-means rule 21):
		// making the signal unconditional passes every clause above while emitting
		// one line per attempt, burying the signal it was added to surface. This is
		// the ONLY clause that reddens under that mutation.
		const { lines, observer } = await ingestAndSettle('{"type":"message_end"}');
		expect(lines.some((l) => l.msg === ABSENT_EVENT)).toBe(false);
		// And the present stream still reaches the observer: a "fix" that signalled
		// correctly by never handing the stream on would satisfy the line above.
		expect(observer.observed).toBe(1);
	});

	test("CONTROL: the read still happens exactly once per attempt", async () => {
		// A short-circuit that moved the signal ABOVE the read would satisfy every
		// clause above while never consulting the share at all (done-means rules 14
		// and 17: assert the boundary draw count, not just the outcome).
		const { reader } = await ingestAndSettle(null);
		expect(reader.streamReads).toBe(1);
	});
});
