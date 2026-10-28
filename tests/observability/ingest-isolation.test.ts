import { describe, expect, test } from "bun:test";
import {
	type IngestObserver,
	ingestResult,
	MAX_EVENT_STREAM_BYTES,
	type PersistedResult,
	type ResultReader,
	type ResultStore,
} from "../../src/results/ingest";
import { IMPLEMENT_JOB_TYPE, RESULT_VERSION } from "../../src/results/schema";
import { until } from "../support/wait-until";

/** A schema-valid result document, so ingest reaches its accepted path. */
const validResult = JSON.stringify({
	result_version: RESULT_VERSION,
	repository: "rodaddy/x",
	job_type: "pr-review",
	item_number: 7,
	sha: "deadbeef",
	status: "passed",
	checks: [{ name: "lint", status: "pass" }],
	findings: [],
});

/** A minimal, well-formed one-turn stream. */
const oneTurn = JSON.stringify({
	type: "message_end",
	message: {
		role: "assistant",
		model: "gpt-5.6-sol",
		provider: "cliproxy",
		usage: { input: 1, output: 1, totalTokens: 2 },
		content: [{ type: "text", text: "ok" }],
		timestamp: 1785615593072,
	},
});

/** Reader with an optional event stream and an optionally faulty stream read. */
function reader(opts: {
	result?: string | null;
	stream?: string | null;
	streamThrows?: boolean;
	noStreamSupport?: boolean;
}): ResultReader {
	const base: ResultReader = {
		isDone: async () => true,
		readResult: async () => (opts.result === undefined ? validResult : opts.result),
	};
	if (opts.noStreamSupport === true) {
		return base;
	}
	base.readEventStream = async () => {
		if (opts.streamThrows === true) {
			throw new Error("share read exploded");
		}
		return opts.stream ?? null;
	};
	return base;
}

/** Recording store, so an ingest outcome can be asserted end to end. */
function recordingStore(): ResultStore & { records: PersistedResult[] } {
	const records: PersistedResult[] = [];
	return { records, persist: async (r) => void records.push(r) };
}

/** Observer that records what it saw; `behavior` selects how it misbehaves. */
function fakeObserver(behavior: "record" | "throw" | "hang" = "record"): IngestObserver & {
	seen: Array<{
		ingested: boolean;
		schemaValid: boolean;
		changeVerified?: boolean;
		rawEventStream: string;
	}>;
} {
	const seen: Array<{
		ingested: boolean;
		schemaValid: boolean;
		changeVerified?: boolean;
		rawEventStream: string;
	}> = [];
	return {
		seen,
		observe(args) {
			seen.push({
				ingested: args.ingested,
				schemaValid: args.schemaValid,
				changeVerified: args.changeVerified,
				rawEventStream: args.rawEventStream,
			});
			if (behavior === "throw") {
				throw new Error("langfuse is unreachable");
			}
			if (behavior === "hang") {
				// A sink that never settles. `observe` returns void, so ingest cannot
				// have joined this promise; if it somehow did, the test would time out.
				void new Promise(() => {});
			}
		},
	};
}

/**
 * Hold every observation chain ingest launches, so a test asserting that NOTHING
 * was observed can wait for the chain to FINISH first. Ingest hands the chain to
 * `track` synchronously, so once ingest returns this list is complete.
 */
function tracking(observer: IngestObserver): Promise<void>[] {
	const tracked: Promise<void>[] = [];
	observer.track = (work) => void tracked.push(work);
	return tracked;
}

describe("ingest is isolated from the observability sink", () => {
	test("THE IMPORTANT ONE: an observer that THROWS does not fail the ingest", async () => {
		const store = recordingStore();
		const observer = fakeObserver("throw");
		const out = await ingestResult({
			reader: reader({ stream: oneTurn }),
			store,
			jobRunnerId: "rw-1",
			hostname: "runner-1",
			observer,
		});
		// The ingest outcome is exactly what it would be with no observer at all.
		expect(out.status).toBe("ingested");
		expect(store.records).toHaveLength(1);
		expect(store.records[0]?.status).toBe("ingested");
		// Let the detached observe settle so its rejection cannot leak into a later
		// test as an unhandled rejection.
		await until(() => observer.seen.length > 0, 2_000, "observe called");
		expect(observer.seen).toHaveLength(1);
	});

	test("an observer that never settles does not stall the ingest", async () => {
		const store = recordingStore();
		const out = await ingestResult({
			reader: reader({ stream: oneTurn }),
			store,
			jobRunnerId: "rw-2",
			hostname: "runner-1",
			observer: fakeObserver("hang"),
		});
		expect(out.status).toBe("ingested");
	});

	test("a stream READ that throws does not fail the ingest", async () => {
		const store = recordingStore();
		const out = await ingestResult({
			reader: reader({ streamThrows: true }),
			store,
			jobRunnerId: "rw-3",
			hostname: "runner-1",
			observer: fakeObserver(),
		});
		expect(out.status).toBe("ingested");
		expect(store.records[0]?.status).toBe("ingested");
	});

	test("no observer configured leaves ingest byte-identical", async () => {
		const store = recordingStore();
		const out = await ingestResult({
			reader: reader({ stream: oneTurn }),
			store,
			jobRunnerId: "rw-4",
			hostname: "runner-1",
		});
		expect(out.status).toBe("ingested");
		expect(store.records).toHaveLength(1);
	});

	test("a reader with no stream support is never asked for one", async () => {
		const observer = fakeObserver();
		const tracked = tracking(observer);
		const out = await ingestResult({
			reader: reader({ noStreamSupport: true }),
			store: recordingStore(),
			jobRunnerId: "rw-5",
			hostname: "runner-1",
			observer,
		});
		expect(out.status).toBe("ingested");
		await Promise.all(tracked);
		expect(observer.seen).toEqual([]);
	});

	test("an ABSENT or EMPTY stream produces no observation", async () => {
		for (const stream of [null, "", "   \n  "]) {
			const observer = fakeObserver();
			const tracked = tracking(observer);
			await ingestResult({
				reader: reader({ stream }),
				store: recordingStore(),
				jobRunnerId: "rw-6",
				hostname: "runner-1",
				observer,
			});
			await Promise.all(tracked);
			expect(observer.seen).toEqual([]);
		}
	});
});

describe("the observer sees the terminal outcome, never `pending`", () => {
	test("an INGESTED result observes ingested=true and schemaValid=true with the raw stream", async () => {
		const observer = fakeObserver();
		// `track` is absent on this observer, the pre-#176 shape: the seam is
		// optional and an observer without it keeps working.
		expect(observer.track).toBeUndefined();
		const out = await ingestResult({
			reader: reader({ stream: oneTurn }),
			store: recordingStore(),
			jobRunnerId: "rw-7",
			hostname: "runner-1",
			observer,
		});
		expect(out.status).toBe("ingested");
		await until(() => observer.seen.length > 0, 2_000, "observe called");
		expect(observer.seen).toHaveLength(1);
		expect(observer.seen[0]?.ingested).toBe(true);
		// A clean ingest reports both flags true.
		expect(observer.seen[0]?.schemaValid).toBe(true);
		expect(observer.seen[0]?.rawEventStream).toBe(oneTurn);
		// No change was claimed, so there is no change-verification score to record.
		expect(observer.seen[0]?.changeVerified).toBeUndefined();
	});

	test("an INVALID result still observes, with ingested=false", async () => {
		const observer = fakeObserver();
		const out = await ingestResult({
			reader: reader({ result: "{not json", stream: oneTurn }),
			store: recordingStore(),
			jobRunnerId: "rw-8",
			hostname: "runner-1",
			observer,
		});
		expect(out.status).toBe("invalid");
		await until(() => observer.seen.length > 0, 2_000, "observe called");
		expect(observer.seen[0]?.ingested).toBe(false);
	});

	test("a MISSING artifact still observes, with ingested=false", async () => {
		const observer = fakeObserver();
		const out = await ingestResult({
			reader: reader({ result: null, stream: oneTurn }),
			store: recordingStore(),
			jobRunnerId: "rw-9",
			hostname: "runner-1",
			observer,
		});
		expect(out.status).toBe("missing");
		await until(() => observer.seen.length > 0, 2_000, "observe called");
		expect(observer.seen[0]?.ingested).toBe(false);
	});

	test("a PENDING attempt (no DONE) observes nothing — there is no run to trace", async () => {
		const observer = fakeObserver();
		const tracked = tracking(observer);
		const out = await ingestResult({
			reader: { isDone: async () => false, readResult: async () => null },
			store: recordingStore(),
			jobRunnerId: "rw-10",
			hostname: "runner-1",
			observer,
		});
		expect(out.status).toBe("pending");
		await Promise.all(tracked);
		expect(observer.seen).toEqual([]);
	});

	test("a REJECTED change observes changeVerified=false", async () => {
		const observer = fakeObserver();
		const withChange = JSON.stringify({
			...JSON.parse(validResult),
			// A change block is implement-lane-only and carries exactly one of
			// bundle_path/branch — the schema refuses any other shape.
			job_type: "implement-issue",
			change: { bundle_path: "changes.bundle", base_sha: "a".repeat(40) },
		});
		const out = await ingestResult({
			reader: reader({ result: withChange, stream: oneTurn }),
			store: recordingStore(),
			jobRunnerId: "rw-11",
			hostname: "runner-1",
			// No verifier configured: the claimed change is REFUSED (fail-closed).
			observer,
		});
		expect(out.status).toBe("invalid");
		await until(() => observer.seen.length > 0, 2_000, "observe called");
		expect(observer.seen[0]?.changeVerified).toBe(false);
		expect(observer.seen[0]?.ingested).toBe(false);
	});

	test("a VERIFIED change observes changeVerified=true", async () => {
		const observer = fakeObserver();
		const withChange = JSON.stringify({
			...JSON.parse(validResult),
			// A change block is implement-lane-only and carries exactly one of
			// bundle_path/branch — the schema refuses any other shape.
			job_type: "implement-issue",
			change: { bundle_path: "changes.bundle", base_sha: "a".repeat(40) },
		});
		const out = await ingestResult({
			reader: reader({ result: withChange, stream: oneTurn }),
			store: recordingStore(),
			jobRunnerId: "rw-12",
			hostname: "runner-1",
			changeVerifier: { verify: async () => ({ status: "ok" }) },
			observer,
		});
		expect(out.status).toBe("ingested");
		await until(() => observer.seen.length > 0, 2_000, "observe called");
		expect(observer.seen[0]?.changeVerified).toBe(true);
	});

	test("the stream read is capped at the ingest-boundary byte cap", async () => {
		const seen: number[] = [];
		const capturing: ResultReader = {
			isDone: async () => true,
			readResult: async () => validResult,
			readEventStream: async (_job, _host, maxBytes) => {
				seen.push(maxBytes);
				return oneTurn;
			},
		};
		await ingestResult({
			reader: capturing,
			store: recordingStore(),
			jobRunnerId: "rw-13",
			hostname: "runner-1",
			observer: fakeObserver(),
		});
		await until(() => seen.length > 0, 2_000, "stream read");
		expect(seen).toEqual([MAX_EVENT_STREAM_BYTES]);
	});
});

/**
 * The chain ingest hands to the observer must cover the READ, not just the
 * `observe` call.
 *
 * `AttemptObserver.shutdown` can only drain what it was given. Ingest reads
 * `events.jsonl` off the share BEFORE it calls `observe`, so if ingest tracks
 * nothing — or tracks only the part after the read — the flush still races the
 * read that would have filled the queue (PR #176, Sol gauntlet P1). That makes
 * the tracking a property of the INGEST boundary, testable here without a DB.
 */
describe("ingest hands the WHOLE observation chain to the drain set", () => {
	test("THE IMPORTANT ONE: the tracked promise is still pending while the read is", async () => {
		const tracked: Promise<void>[] = [];
		const observer = fakeObserver();
		observer.track = (work) => void tracked.push(work);

		// The share read is gated open, exactly as it is in flight at stop time.
		let openGate = (): void => {};
		const gate = new Promise<void>((resolve) => {
			openGate = resolve;
		});
		const gatedReader: ResultReader = {
			isDone: async () => true,
			readResult: async () => validResult,
			readEventStream: async () => {
				await gate;
				return oneTurn;
			},
		};

		await ingestResult({
			reader: gatedReader,
			store: recordingStore(),
			jobRunnerId: "rw-track-1",
			hostname: "runner-1",
			observer,
		});

		// Ingest RETURNED without waiting — the non-blocking contract is intact —
		// and it handed over exactly one chain.
		expect(tracked).toHaveLength(1);
		// ...and that chain is still pending, because the read has not finished. A
		// chain tracked only from `observe` would already be absent or settled here,
		// which is the whole defect: a drain over it would wait for nothing.
		expect(observer.seen).toHaveLength(0);
		const settledEarly = await Promise.race([
			(tracked[0] as Promise<void>).then(() => "settled"),
			// fixed-sleep-ok: asserts absence, no completion signal (the read is gated shut)
			Bun.sleep(20).then(() => "pending"),
		]);
		expect(settledEarly).toBe("pending");

		// Release the read: the SAME tracked promise resolves only once `observe`
		// has been called, so awaiting it is awaiting the enqueue.
		openGate();
		await tracked[0];
		expect(observer.seen).toHaveLength(1);
	});
});

describe("ingest reports schema validity independently of ingest success", () => {
	/** A result claiming a change, so the change verifier is the boundary that runs. */
	const resultWithChange = JSON.stringify({
		// A change block is implement-lane-only and version-2-only; the schema
		// refuses it otherwise, so this document must be shaped exactly right for
		// the CHANGE VERIFIER to be the boundary that rejects it.
		result_version: 2,
		repository: "rodaddy/x",
		job_type: IMPLEMENT_JOB_TYPE,
		item_number: 7,
		sha: "d".repeat(40),
		status: "passed",
		checks: [{ name: "lint", status: "pass" }],
		findings: [],
		change: {
			base_sha: "d".repeat(40),
			bundle_path: "changes.bundle",
			files_changed: 1,
		},
	});

	test("THE IMPORTANT ONE: a REJECTED change is reported schema-VALID", async () => {
		// The schema accepted this document; the change verifier refused what it
		// PROPOSED. Deriving the schema score from `ingested` reported this as a
		// schema failure, blaming the wrong boundary entirely.
		const observer = fakeObserver();
		const out = await ingestResult({
			reader: reader({ result: resultWithChange, stream: oneTurn }),
			store: recordingStore(),
			jobRunnerId: "rw-193-a",
			hostname: "runner-1",
			changeVerifier: {
				verify: async () => ({ status: "rejected", reason: "bundle escapes the job directory" }),
			},
			observer,
		});
		expect(out.status).toBe("invalid");
		await until(() => observer.seen.length > 0, 2_000, "observe called");
		expect(observer.seen).toHaveLength(1);
		// The document PARSED and VALIDATED. That is what this flag means now.
		expect(observer.seen[0]?.schemaValid).toBe(true);
		// And ingest still failed, and still says so.
		expect(observer.seen[0]?.ingested).toBe(false);
		expect(observer.seen[0]?.changeVerified).toBe(false);
	});

	test("an UNPARSEABLE document is reported schema-invalid, so the flag is not pinned true", async () => {
		const observer = fakeObserver();
		const out = await ingestResult({
			reader: reader({ result: "}{ not json", stream: oneTurn }),
			store: recordingStore(),
			jobRunnerId: "rw-193-b",
			hostname: "runner-1",
			observer,
		});
		expect(out.status).toBe("invalid");
		await until(() => observer.seen.length > 0, 2_000, "observe called");
		expect(observer.seen[0]?.schemaValid).toBe(false);
		expect(observer.seen[0]?.ingested).toBe(false);
	});

	test("a SCHEMA-violating document is reported schema-invalid", async () => {
		// Parses as JSON, fails `resultSchema` — the other genuine schema failure.
		const observer = fakeObserver();
		await ingestResult({
			reader: reader({
				result: JSON.stringify({ result_version: RESULT_VERSION }),
				stream: oneTurn,
			}),
			store: recordingStore(),
			jobRunnerId: "rw-193-c",
			hostname: "runner-1",
			observer,
		});
		await until(() => observer.seen.length > 0, 2_000, "observe called");
		expect(observer.seen[0]?.schemaValid).toBe(false);
	});

	test("a MISSING artifact is reported schema-invalid: validation never ran", async () => {
		const observer = fakeObserver();
		const out = await ingestResult({
			reader: reader({ result: null, stream: oneTurn }),
			store: recordingStore(),
			jobRunnerId: "rw-193-d",
			hostname: "runner-1",
			observer,
		});
		expect(out.status).toBe("missing");
		await until(() => observer.seen.length > 0, 2_000, "observe called");
		expect(observer.seen[0]?.schemaValid).toBe(false);
	});

	test("a STORE-REFUSED result is reported schema-VALID: the store refused, not the schema", async () => {
		// The last unpinned observe() site: the store rejects a schema-valid document
		// from trusted state (wrong attempt, already-completed job). The schema score
		// must still be true — the boundary that refused is the store, not validation.
		const observer = fakeObserver();
		const store: ResultStore = {
			persist: async () => ({ status: "invalid", reason: "job is not owned by this attempt" }),
		};
		const out = await ingestResult({
			reader: reader({ stream: oneTurn }),
			store,
			jobRunnerId: "rw-193-f",
			hostname: "runner-1",
			observer,
		});
		expect(out.status).toBe("invalid");
		await until(() => observer.seen.length > 0, 2_000, "observe called");
		expect(observer.seen).toHaveLength(1);
		expect(observer.seen[0]?.schemaValid).toBe(true);
		expect(observer.seen[0]?.ingested).toBe(false);
	});
});
