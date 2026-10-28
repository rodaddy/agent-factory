import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { handleResultMessage, startResultsConsumer } from "../../src/bus/results-consumer";
import { busResults } from "../../src/db/schema";
import { withTestDb } from "../db/helpers";
import { until } from "../support/wait-until";

/** A fake `JsMsg` recording which terminal disposition the handler chose. */
function fakeMsg(opts: {
	subject: string;
	headers?: Record<string, string>;
	body?: string | Uint8Array;
}) {
	const map = new Map<string, string>(Object.entries(opts.headers ?? {}));
	const data =
		typeof opts.body === "string"
			? new TextEncoder().encode(opts.body)
			: (opts.body ?? new Uint8Array());
	const calls: string[] = [];
	return {
		subject: opts.subject,
		data,
		headers: {
			get: (k: string) => map.get(k) ?? "",
			has: (k: string) => map.has(k),
		},
		calls,
		ack: () => calls.push("ack"),
		nak: (ms?: number) => calls.push(`nak:${ms ?? ""}`),
		term: (_reason?: string) => calls.push("term"),
	};
}

/** Collect log lines the handler emits. */
function recorder() {
	const lines: Array<{ level: string; message: string; fields: Record<string, unknown> }> = [];
	const emit = ((level: string, message: string, fields: Record<string, unknown> = {}) => {
		lines.push({ level, message, fields });
	}) as never;
	return { lines, emit };
}

const GOOD_HEADERS = {
	"Nats-Msg-Id": "rj-1:runner-a:result.json",
	"Factory-Job": "rj-1",
	"Factory-Hostname": "runner-a",
	"Factory-Artifact": "result.json",
};

describe("handleResultMessage", () => {
	test("stores a valid message byte-identically and acks", async () => {
		await withTestDb(async (db) => {
			const body = '{"result_version":1,"status":"passed"}';
			const { lines, emit } = recorder();
			const msg = fakeMsg({ subject: "factory.jobs.rj-1.result", headers: GOOD_HEADERS, body });

			await handleResultMessage(msg as never, db as never, emit);

			expect(msg.calls).toEqual(["ack"]);
			const rows = await db.select().from(busResults).where(eq(busResults.jobRunnerId, "rj-1"));
			expect(rows.length).toBe(1);
			expect(rows[0]?.body).toBe(body);
			expect(rows[0]?.hostname).toBe("runner-a");
			expect(rows[0]?.artifact).toBe("result.json");
			expect(rows[0]?.msgId).toBe("rj-1:runner-a:result.json");
			expect(rows[0]?.subject).toBe("factory.jobs.rj-1.result");
			const stored = lines.filter((l) => l.message === "bus.results.stored");
			expect(stored.length).toBe(1);
			expect(stored[0]?.fields.duplicate).toBe(false);
			expect(stored[0]?.fields.bytes).toBe(new TextEncoder().encode(body).byteLength);
		});
	});

	test("a duplicate (job, host, artifact) writes no second row, acks, and reports duplicate", async () => {
		await withTestDb(async (db) => {
			const { lines, emit } = recorder();
			const first = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: GOOD_HEADERS,
				body: "first",
			});
			await handleResultMessage(first as never, db as never, emit);
			const second = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: GOOD_HEADERS,
				body: "second-different-body",
			});
			await handleResultMessage(second as never, db as never, emit);

			expect(second.calls).toEqual(["ack"]);
			const rows = await db.select().from(busResults).where(eq(busResults.jobRunnerId, "rj-1"));
			expect(rows.length).toBe(1);
			// First writer wins; the duplicate does NOT overwrite.
			expect(rows[0]?.body).toBe("first");
			const stored = lines.filter((l) => l.message === "bus.results.stored");
			expect(stored.map((l) => l.fields.duplicate)).toEqual([false, true]);
		});
	});

	test("a different host for the same job is its own row, not a duplicate", async () => {
		await withTestDb(async (db) => {
			const { emit } = recorder();
			await handleResultMessage(
				fakeMsg({
					subject: "factory.jobs.rj-1.result",
					headers: GOOD_HEADERS,
					body: "a",
				}) as never,
				db as never,
				emit,
			);
			await handleResultMessage(
				fakeMsg({
					subject: "factory.jobs.rj-1.result",
					// The msg-id moves with the hostname: it is now required to equal the
					// exact triple it describes, so a second host
					// reusing runner-a's id would be rejected rather than stored.
					headers: {
						...GOOD_HEADERS,
						"Factory-Hostname": "runner-b",
						"Nats-Msg-Id": "rj-1:runner-b:result.json",
					},
					body: "b",
				}) as never,
				db as never,
				emit,
			);
			const rows = await db.select().from(busResults).where(eq(busResults.jobRunnerId, "rj-1"));
			expect(rows.length).toBe(2);
			expect(rows.map((r) => r.hostname).sort()).toEqual(["runner-a", "runner-b"]);
		});
	});

	const rejections: Array<{ name: string; reason: string; msg: ReturnType<typeof fakeMsg> }> = [
		{
			name: "missing Factory-Job",
			reason: "missing_header",
			msg: fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: { ...GOOD_HEADERS, "Factory-Job": "" },
				body: "x",
			}),
		},
		{
			name: "missing Factory-Hostname",
			reason: "missing_header",
			msg: fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: { ...GOOD_HEADERS, "Factory-Hostname": "" },
				body: "x",
			}),
		},
		{
			name: "missing Factory-Artifact",
			reason: "missing_header",
			msg: fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: { ...GOOD_HEADERS, "Factory-Artifact": "" },
				body: "x",
			}),
		},
		{
			name: "Factory-Job does not match the subject token",
			reason: "job_subject_mismatch",
			msg: fakeMsg({
				subject: "factory.jobs.rj-OTHER.result",
				headers: GOOD_HEADERS,
				body: "x",
			}),
		},
		{
			name: "subject is not factory.jobs.<job>.result",
			reason: "bad_subject",
			msg: fakeMsg({ subject: "factory.jobs.result", headers: GOOD_HEADERS, body: "x" }),
		},
		{
			name: "unsafe hostname segment",
			reason: "unsafe_segment",
			msg: fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: { ...GOOD_HEADERS, "Factory-Hostname": "../etc" },
				body: "x",
			}),
		},
		{
			name: "unsafe artifact segment",
			reason: "unsafe_segment",
			msg: fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: { ...GOOD_HEADERS, "Factory-Artifact": "a/b" },
				body: "x",
			}),
		},
		{
			name: "oversize body",
			reason: "oversize",
			msg: fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: GOOD_HEADERS,
				body: new Uint8Array(1_048_577),
			}),
		},
	];

	for (const scenario of rejections) {
		test(`terms and stores nothing: ${scenario.name}`, async () => {
			await withTestDb(async (db) => {
				const { lines, emit } = recorder();
				await handleResultMessage(scenario.msg as never, db as never, emit);

				expect(scenario.msg.calls).toEqual(["term"]);
				const rows = await db.select().from(busResults);
				expect(rows.length).toBe(0);
				const rejected = lines.filter((l) => l.message === "bus.results.rejected");
				expect(rejected.length).toBe(1);
				expect(rejected[0]?.fields.reason).toBe(scenario.reason);
				// The body is never logged.
				expect(JSON.stringify(rejected[0]?.fields)).not.toContain("body");
			});
		});
	}

	test("a DB failure naks for redelivery and never acks", async () => {
		const { lines, emit } = recorder();
		const failing = {
			insert: () => {
				throw new TypeError("connection terminated");
			},
		};
		const msg = fakeMsg({
			subject: "factory.jobs.rj-1.result",
			headers: GOOD_HEADERS,
			body: "x",
		});

		await handleResultMessage(msg as never, failing as never, emit);

		expect(msg.calls.length).toBe(1);
		expect(msg.calls[0]?.startsWith("nak")).toBe(true);
		expect(msg.calls).not.toContain("ack");
		const failed = lines.filter((l) => l.message === "bus.results.store_failed");
		expect(failed.length).toBe(1);
		expect(failed[0]?.fields.error_class).toBe("TypeError");
	});
});

describe("startResultsConsumer", () => {
	test("creates the durable idempotently and stop() returns promptly", async () => {
		await withTestDb(async (db) => {
			const added: Array<{ stream: string; cfg: Record<string, unknown> }> = [];
			let fetches = 0;
			const consumer = {
				fetch: async () => {
					fetches += 1;
					// An expired fetch window yields nothing and ends.
					return { [Symbol.asyncIterator]: async function* () {} };
				},
			};
			const jsm = {
				consumers: {
					add: async (stream: string, cfg: Record<string, unknown>) => {
						added.push({ stream, cfg });
						return { config: cfg };
					},
				},
			};
			const bus = {
				connection: {
					jetstreamManager: async () => jsm,
					jetstream: () => ({ consumers: { get: async () => consumer } }),
				},
			};
			const { lines, emit } = recorder();

			const handle = await startResultsConsumer({
				bus: bus as never,
				db: db as never,
				log: emit,
				expiresMs: 1_000,
			});
			const started = Date.now();
			await handle.stop();
			const elapsed = Date.now() - started;

			expect(added.length).toBe(1);
			expect(added[0]?.stream).toBe("FACTORY_JOBS");
			expect(added[0]?.cfg.durable_name).toBe("watcher-ingest");
			expect(added[0]?.cfg.ack_policy).toBe("explicit");
			expect(added[0]?.cfg.filter_subject).toBe("factory.jobs.>");
			expect(added[0]?.cfg.max_deliver).toBe(5);
			// stop() must return within expiresMs + 1s.
			expect(elapsed).toBeLessThan(2_000);
			expect(fetches).toBeGreaterThan(0);
			expect(lines.filter((l) => l.message === "bus.results.consumer_failed")).toEqual([]);
		});
	});

	test("an already-existing durable is reused rather than fatal", async () => {
		await withTestDb(async (db) => {
			const consumer = {
				fetch: async () => ({ [Symbol.asyncIterator]: async function* () {} }),
			};
			let infoCalls = 0;
			const jsm = {
				consumers: {
					add: async () => {
						const err = new Error("consumer already exists");
						(err as unknown as { api_error: unknown }).api_error = { err_code: 10148 };
						throw err;
					},
					info: async () => {
						infoCalls += 1;
						// The MATCHING config: reuse is now conditional on the existing
						// durable actually being the one this module intends (sf#465
						// review F2), so the fixture states every compared field.
						return {
							config: {
								durable_name: "watcher-ingest",
								filter_subject: "factory.jobs.>",
								ack_policy: "explicit",
								deliver_policy: "all",
								max_deliver: 5,
								ack_wait: 30 * 1_000_000_000,
							},
						};
					},
				},
			};
			const bus = {
				connection: {
					jetstreamManager: async () => jsm,
					jetstream: () => ({ consumers: { get: async () => consumer } }),
				},
			};
			const { emit } = recorder();

			const handle = await startResultsConsumer({
				bus: bus as never,
				db: db as never,
				log: emit,
				expiresMs: 1_000,
			});
			await handle.stop();
			expect(infoCalls).toBe(1);
		});
	});
});

/**
 * Review findings F1, F4, F5.
 *
 * F1 is the ordering defect with teeth: the runner publishes one message per
 * artifact and a final 0-byte `Factory-Artifact: DONE`, and `BusResultReader`
 * calls the job complete the instant the DONE row exists. A store failure that
 * NAKed only the failing artifact and let the loop walk on to DONE therefore
 * published completeness for a result that was never stored — the reconciler
 * then reads the named artifact, finds it missing, and terminalizes the attempt
 * as invalid. The fix defers the WHOLE batch behind a failed store.
 */
describe("results consumer review findings (sf#465 F1/F4/F5)", () => {
	test("F1: a failed store defers the rest of the batch, so DONE cannot outrun its artifact", async () => {
		await withTestDb(async (db) => {
			const { lines, emit } = recorder();
			const artifact = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: GOOD_HEADERS,
				body: "{}",
			});
			const done = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: {
					"Nats-Msg-Id": "rj-1:runner-a:DONE",
					"Factory-Job": "rj-1",
					"Factory-Hostname": "runner-a",
					"Factory-Artifact": "DONE",
				},
			});

			// The database accepts the DONE insert and refuses the artifact's: if the
			// loop processed DONE at all, a row would appear and the assertion below
			// would catch it.
			let insertAttempts = 0;
			const flaky = {
				insert: (table: unknown) => {
					insertAttempts += 1;
					throw new TypeError("connection terminated");
					// biome-ignore lint/correctness/noUnreachable: documents the shape.
					return (db as never as { insert(t: unknown): unknown }).insert(table);
				},
			};

			const fetchAt: number[] = [];
			let batchesServed = 0;
			const consumer = {
				fetch: async () => {
					fetchAt.push(Date.now());
					batchesServed += 1;
					if (batchesServed === 1) {
						return {
							[Symbol.asyncIterator]: async function* () {
								yield artifact;
								yield done;
							},
						};
					}
					// BOUNDED ON PURPOSE. Without the fix the loop has no backoff after a
					// failed store, so an always-empty fake spins as fast as the event
					// loop allows and the RED run never terminates (observed: 14 min of
					// CPU, 3.4 GB RSS, no output). Sleeping the later windows makes the
					// unfixed behaviour finish and fail on the assertions instead.
					await new Promise((resolve) => setTimeout(resolve, 20)); // fixed-sleep-ok: simulated latency in a fake
					return { [Symbol.asyncIterator]: async function* () {} };
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

			const handle = await startResultsConsumer({
				bus: bus as never,
				db: flaky as never,
				log: emit,
				expiresMs: 20,
				retryDelayMs: 200,
			});
			// Wait for the deferral, then for the NEXT fetch: a non-backing-off loop
			// issues it at once, so the gap asserted below is what proves the backoff.
			await until(
				() => lines.some((l) => l.message === "bus.results.batch_deferred") && fetchAt.length >= 2,
				2_000,
				"batch deferred and the next fetch issued",
			);
			await handle.stop();

			// The failing artifact is NAKed for redelivery, without a delay: it must
			// come back ahead of DONE, not after a timer.
			expect(artifact.calls.length).toBe(1);
			expect(artifact.calls[0]?.startsWith("nak")).toBe(true);
			expect(artifact.calls[0]).toBe("nak:");
			// DONE is NAKed unprocessed — no validation, no insert, no ack, no term.
			expect(done.calls).toEqual(["nak:"]);
			expect(insertAttempts).toBe(1);
			const rows = await db.select().from(busResults);
			expect(rows.length).toBe(0);

			const deferred = lines.filter((l) => l.message === "bus.results.batch_deferred");
			expect(deferred.length).toBe(1);
			expect(deferred[0]?.fields.remaining).toBe(1);
			expect(deferred[0]?.fields.error_class).toBe("TypeError");

			// And the loop backed off: the next fetch is not issued before retryDelayMs.
			expect(fetchAt.length).toBeGreaterThanOrEqual(1);
			if (fetchAt.length > 1) {
				expect((fetchAt[1] as number) - (fetchAt[0] as number)).toBeGreaterThanOrEqual(190);
			}
		});
	});

	test("F1: a DONE whose artifacts are not stored yet is still stored (the reader owns completeness)", async () => {
		await withTestDb(async (db) => {
			const { emit } = recorder();
			const done = fakeMsg({
				subject: "factory.jobs.rj-9.result",
				headers: {
					"Nats-Msg-Id": "rj-9:runner-a:DONE",
					"Factory-Job": "rj-9",
					"Factory-Hostname": "runner-a",
					"Factory-Artifact": "DONE",
				},
			});
			await handleResultMessage(done as never, db as never, emit);
			expect(done.calls).toEqual(["ack"]);
			const rows = await db.select().from(busResults).where(eq(busResults.jobRunnerId, "rj-9"));
			expect(rows.length).toBe(1);
			expect(rows[0]?.artifact).toBe("DONE");
		});
	});

	test("F4: a missing Nats-Msg-Id is terminated, never stored under a generated id", async () => {
		await withTestDb(async (db) => {
			const { lines, emit } = recorder();
			const msg = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: {
					"Factory-Job": "rj-1",
					"Factory-Hostname": "runner-a",
					"Factory-Artifact": "result.json",
				},
				body: "x",
			});
			await handleResultMessage(msg as never, db as never, emit);
			expect(msg.calls).toEqual(["term"]);
			expect((await db.select().from(busResults)).length).toBe(0);
			const rejected = lines.filter((l) => l.message === "bus.results.rejected");
			expect(rejected[0]?.fields.reason).toBe("msg_id_missing");
		});
	});

	test("F4: a Nats-Msg-Id naming another job is terminated", async () => {
		await withTestDb(async (db) => {
			const { lines, emit } = recorder();
			const msg = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: { ...GOOD_HEADERS, "Nats-Msg-Id": "other:runner-a:result.json" },
				body: "x",
			});
			await handleResultMessage(msg as never, db as never, emit);
			expect(msg.calls).toEqual(["term"]);
			expect((await db.select().from(busResults)).length).toBe(0);
			const rejected = lines.filter((l) => l.message === "bus.results.rejected");
			expect(rejected[0]?.fields.reason).toBe("msg_id_mismatch");
		});
	});

	test("F4: the exact <job>:<hostname>:<artifact> id is stored", async () => {
		await withTestDb(async (db) => {
			const { emit } = recorder();
			const msg = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: GOOD_HEADERS,
				body: "x",
			});
			await handleResultMessage(msg as never, db as never, emit);
			expect(msg.calls).toEqual(["ack"]);
			const rows = await db.select().from(busResults);
			expect(rows.length).toBe(1);
			expect(rows[0]?.msgId).toBe("rj-1:runner-a:result.json");
		});
	});

	test("F5: a DONE carrying a body is terminated and stores nothing", async () => {
		await withTestDb(async (db) => {
			const { lines, emit } = recorder();
			const msg = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: {
					"Nats-Msg-Id": "rj-1:runner-a:DONE",
					"Factory-Job": "rj-1",
					"Factory-Hostname": "runner-a",
					"Factory-Artifact": "DONE",
				},
				body: "x",
			});
			await handleResultMessage(msg as never, db as never, emit);
			expect(msg.calls).toEqual(["term"]);
			expect((await db.select().from(busResults)).length).toBe(0);
			const rejected = lines.filter((l) => l.message === "bus.results.rejected");
			expect(rejected[0]?.fields.reason).toBe("done_with_body");
		});
	});

	test("F5: a 0-byte DONE is stored", async () => {
		await withTestDb(async (db) => {
			const { emit } = recorder();
			const msg = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: {
					"Nats-Msg-Id": "rj-1:runner-a:DONE",
					"Factory-Job": "rj-1",
					"Factory-Hostname": "runner-a",
					"Factory-Artifact": "DONE",
				},
			});
			await handleResultMessage(msg as never, db as never, emit);
			expect(msg.calls).toEqual(["ack"]);
			const rows = await db.select().from(busResults);
			expect(rows.length).toBe(1);
			expect(rows[0]?.body).toBe("");
		});
	});

	/**
	 * F2: `ensureDurable` swallowed EVERY add failure as "already exists". A
	 * durable that exists with a different config is then bound and silently
	 * obeyed — a `max_deliver` of 3 where 5 is intended changes how long a
	 * NAKed artifact keeps coming back, which is exactly the F1 recovery path.
	 */
	test("F2: an existing durable whose config differs refuses the start and never fetches", async () => {
		await withTestDb(async (db) => {
			let fetches = 0;
			const consumer = {
				fetch: async () => {
					fetches += 1;
					return { [Symbol.asyncIterator]: async function* () {} };
				},
			};
			const jsm = {
				consumers: {
					add: async () => {
						throw new Error("consumer already exists");
					},
					info: async () => ({
						config: {
							filter_subject: "factory.jobs.>",
							ack_policy: "explicit",
							deliver_policy: "all",
							max_deliver: 3,
							ack_wait: 30 * 1_000_000_000,
						},
					}),
				},
			};
			const bus = {
				connection: {
					jetstreamManager: async () => jsm,
					jetstream: () => ({ consumers: { get: async () => consumer } }),
				},
			};
			const { emit } = recorder();

			let rejection: unknown;
			// The handle is captured and stopped in `finally`: when the compare is
			// ABSENT this call resolves instead of throwing, and an unstopped loop
			// keeps the test process alive forever. A hang is a useless red signal,
			// so the leak is cleaned up and the assertion below is what fails.
			let leaked: { stop(): Promise<void> } | undefined;
			try {
				leaked = await startResultsConsumer({
					bus: bus as never,
					db: db as never,
					log: emit,
					expiresMs: 20,
				});
			} catch (err) {
				rejection = err;
			} finally {
				await leaked?.stop();
			}
			expect(rejection).toBeInstanceOf(Error);
			expect((rejection as Error).message).toContain("max_deliver");
			expect((rejection as Error).message).toContain("watcher-ingest");
			expect(fetches).toBe(0);
		});
	});

	test("F2: an info() that also fails rethrows the ORIGINAL add error", async () => {
		await withTestDb(async (db) => {
			const addError = new Error("nats: permissions violation on $JS.API.CONSUMER.CREATE");
			const jsm = {
				consumers: {
					add: async () => {
						throw addError;
					},
					info: async () => {
						throw new Error("consumer not found");
					},
				},
			};
			const bus = {
				connection: {
					jetstreamManager: async () => jsm,
					jetstream: () => ({
						consumers: {
							get: async () => ({
								fetch: async () => ({ [Symbol.asyncIterator]: async function* () {} }),
							}),
						},
					}),
				},
			};
			const { emit } = recorder();
			let rejection: unknown;
			let leaked: { stop(): Promise<void> } | undefined;
			try {
				leaked = await startResultsConsumer({
					bus: bus as never,
					db: db as never,
					log: emit,
					expiresMs: 20,
				});
			} catch (err) {
				rejection = err;
			} finally {
				await leaked?.stop();
			}
			expect(rejection).toBe(addError);
		});
	});

	/**
	 * Q3 gap: `stop()` awaits the in-flight handler, not merely the fetch window.
	 * A stop that resolved while an insert was outstanding would let the process
	 * exit between the insert and the ack — the message is redelivered, which is
	 * survivable, but the handle's contract says the loop is quiescent.
	 */
	test("stop() resolves only after an in-flight handler has acked", async () => {
		await withTestDb(async (db) => {
			const { emit } = recorder();
			const msg = fakeMsg({
				subject: "factory.jobs.rj-slow.result",
				headers: {
					"Nats-Msg-Id": "rj-slow:runner-a:result.json",
					"Factory-Job": "rj-slow",
					"Factory-Hostname": "runner-a",
					"Factory-Artifact": "result.json",
				},
				body: "x",
			});
			let entered = false;
			const slow = {
				insert: (table: unknown) => {
					const chain = (db as never as { insert(t: unknown): Record<string, unknown> }).insert(
						table,
					);
					return {
						values: (v: unknown) => {
							const next = (chain.values as (x: unknown) => Record<string, unknown>)(v);
							return {
								onConflictDoNothing: (o: unknown) => {
									const c = (next.onConflictDoNothing as (x: unknown) => Record<string, unknown>)(
										o,
									);
									return {
										returning: async (r: unknown) => {
											entered = true;
											await new Promise((resolve) => setTimeout(resolve, 100)); // fixed-sleep-ok: simulated latency in a fake
											return await (c.returning as (x: unknown) => Promise<unknown>)(r);
										},
									};
								},
							};
						},
					};
				},
			};
			let served = 0;
			const consumer = {
				fetch: async () => {
					served += 1;
					if (served === 1) {
						return {
							[Symbol.asyncIterator]: async function* () {
								yield msg;
							},
						};
					}
					return { [Symbol.asyncIterator]: async function* () {} };
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
			const handle = await startResultsConsumer({
				bus: bus as never,
				db: slow as never,
				log: emit,
				expiresMs: 20,
			});
			// Enter the handler, then stop while the insert is still outstanding.
			await until(() => entered, 2_000, "handler entered the insert");
			await handle.stop();
			expect(msg.calls).toEqual(["ack"]);
		});
	});
});

/**
 * A fake bus whose consumer yields the given messages on the FIRST fetch and
 * nothing afterwards, so one drained batch can be observed and then stopped.
 */
function oneBatchBus(messages: ReturnType<typeof fakeMsg>[]) {
	let fetches = 0;
	const consumer = {
		fetch: async (opts: { expires: number }) => {
			fetches += 1;
			const batch = fetches === 1 ? messages : [];
			// A real fetch window WAITS `expires` when nothing arrives; resolving at
			// once would spin the loop and starve the test's own timers.
			if (batch.length === 0) await new Promise((resolve) => setTimeout(resolve, opts.expires)); // fixed-sleep-ok: simulated latency in a fake
			return {
				[Symbol.asyncIterator]: async function* () {
					yield* batch;
				},
			};
		},
	};
	const jsm = {
		consumers: { add: async (_s: string, cfg: Record<string, unknown>) => ({ config: cfg }) },
	};
	return {
		connection: {
			jetstreamManager: async () => jsm,
			jetstream: () => ({ consumers: { get: async () => consumer } }),
		},
	};
}

describe("a stored result wakes the pass", () => {
	test("handleResultMessage tells onStored whether the row was fresh or a duplicate", async () => {
		await withTestDb(async (db) => {
			const { emit } = recorder();
			const seen: boolean[] = [];
			const onStored = (s: { duplicate: boolean }) => seen.push(s.duplicate);
			const first = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: GOOD_HEADERS,
				body: "{}",
			});
			const again = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: GOOD_HEADERS,
				body: "{}",
			});
			const bad = fakeMsg({ subject: "factory.jobs.rj-1.result", headers: {}, body: "{}" });

			expect(await handleResultMessage(first as never, db as never, emit, onStored)).toBe("stored");
			expect(await handleResultMessage(again as never, db as never, emit, onStored)).toBe("stored");
			expect(await handleResultMessage(bad as never, db as never, emit, onStored)).toBe("rejected");

			expect(seen).toEqual([false, true]);
		});
	});

	test("a batch that stored a NEW row rings onStored once; a duplicate-only batch never rings", async () => {
		await withTestDb(async (db) => {
			const { emit } = recorder();
			const good = () =>
				fakeMsg({ subject: "factory.jobs.rj-1.result", headers: GOOD_HEADERS, body: "{}" });
			const other = fakeMsg({
				subject: "factory.jobs.rj-1.result",
				headers: {
					...GOOD_HEADERS,
					"Nats-Msg-Id": "rj-1:runner-b:result.json",
					"Factory-Hostname": "runner-b",
				},
				body: "{}",
			});

			// Two fresh rows in one batch: the wake coalesces to ONE ring per batch.
			let rings = 0;
			const firstBatch = [good(), other];
			const one = await startResultsConsumer({
				bus: oneBatchBus(firstBatch) as never,
				db: db as never,
				log: emit,
				expiresMs: 200,
				onStored: () => {
					rings += 1;
				},
			});
			await until(() => firstBatch.every((m) => m.calls.length > 0), 2_000, "first batch settled");
			await one.stop();
			expect(firstBatch.map((m) => m.calls)).toEqual([["ack"], ["ack"]]);
			expect(rings).toBe(1);

			// The same artifact redelivered: stored (acked) but nothing new to reconcile.
			rings = 0;
			const replay = [good()];
			const two = await startResultsConsumer({
				bus: oneBatchBus(replay) as never,
				db: db as never,
				log: emit,
				expiresMs: 200,
				onStored: () => {
					rings += 1;
				},
			});
			await until(() => replay.every((m) => m.calls.length > 0), 2_000, "replay settled");
			await two.stop();
			expect(replay[0]?.calls).toEqual(["ack"]);
			expect(rings).toBe(0);
		});
	});
});
