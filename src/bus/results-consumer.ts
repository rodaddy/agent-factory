/**
 * @module bus/results-consumer
 * @description The durable pull consumer that drains runner artifacts off the
 *   `FACTORY_JOBS` JetStream stream into `bus_results`, so the
 *   factory can read a result the instant a runner published it instead of
 *   waiting to see a file appear on the collab share.
 *
 *   THE PUBLISH CONTRACT, agreed with rtech-infra and implemented by their
 *   runner-job: one message per artifact, subject
 *   `factory.jobs.<job_runner_id>.result`, headers `Nats-Msg-Id`
 *   (`<job>:<hostname>:<artifact>`), `Factory-Job`, `Factory-Hostname`,
 *   `Factory-Artifact`, and the artifact bytes verbatim as the body.
 *
 *   THE STREAM IS NOT THE RECORD; the row is. That is why this consumer is
 *   DURABLE and its acks are EXPLICIT: an ack is the statement "this artifact is
 *   in Postgres", and nothing acks before the insert returns. A process that
 *   dies mid-message leaves the message unacked, and `ack_wait` redelivers it.
 *
 *   THREE DISPOSITIONS, and which one a message gets is the whole design:
 *     - `ack()`   -- stored, or already stored. Terminal, correct.
 *     - `term()`  -- the message can NEVER become valid: a header is missing, the
 *       claimed job disagrees with the subject it arrived on, a segment is
 *       unsafe, or the body is over the stream's own 1 MiB limit. Redelivering
 *       it would fail identically five times and then dead-letter it anyway, so
 *       it is terminated on the first look and logged by REASON.
 *     - `nak()`   -- the message is fine and the DATABASE failed. Redeliver it;
 *       `max_deliver: 5` bounds how long that can go on.
 *
 *   VALIDATION IS AGAINST THE SUBJECT, not just the headers. `Factory-Job` must
 *   equal the subject's own job token: a runner (or anything else able to
 *   publish under `factory.jobs.>`) could otherwise claim another job's id in a
 *   header and have its artifact ingested as that job's result. The subject is
 *   what the stream routed on, so the subject wins and a disagreement is a
 *   rejection rather than a preference.
 *
 *   `isSafeSegment` is the READERS' guard, imported rather than restated: a
 *   value that stores here but reads as unsafe in `BusResultReader` would be
 *   written and then never served, which is worse than refusing it at the door.
 *
 *   DEDUPE IS THE TABLE'S. `ON CONFLICT (job_runner_id, hostname, artifact) DO
 *   NOTHING` makes redelivery free and makes the FIRST body win — a redelivered
 *   or replayed message never overwrites what was already ingested. Results are
 *   per (job, host), so `hostname` is in the conflict target; without it one
 *   host's artifact would suppress another host's, the shape PR #86 fixed.
 *
 *   NEVER LOGGED: the body, the full message, or the seed. A stored line carries
 *   the job, hostname, artifact and byte COUNT; a rejection carries the reason.
 *
 *   A FRESH ROW WAKES THE PASS. Storing is not reconciling: the pass
 *   that reads `bus_results`, transitions the job and queues its publication
 *   runs on the scheduler, and before this seam nothing here asked for one, so
 *   a result landing seconds after a sweep waited up to `poll_interval_minutes`
 *   (15) to be read — the same number as the kill line for a whole run. The
 *   `onStored` option is rung once per batch that wrote at least one new row;
 *   the service wires it to the scheduler's coalescing `trigger()`, the same
 *   wake the doorbell and the Forge webhook already use. Duplicates never ring
 *   (nothing new to read) and the timer stays as the backstop.
 *
 * @outputs
 *   - `handleResultMessage` -- validate, store, and dispose of one message
 *   - `startResultsConsumer` -- create the durable and run the pull loop
 *
 * @dependencies
 *   - ../db/schema -- the `bus_results` table
 *   - ../log -- structured logging and error classification
 *   - ../results/share-reader -- the shared `isSafeSegment` guard
 */
import type { WatcherDb } from "../db/client";
import { busResults } from "../db/schema";
import { errorClass, log, traced, withLogFields } from "../log";
import { isSafeSegment } from "../results/share-reader";

/** The stream runner artifacts are published to. */
const DEFAULT_STREAM = "FACTORY_JOBS";

/** The watcher's durable consumer name on that stream. */
const DEFAULT_DURABLE = "watcher-ingest";

/** Everything under this prefix is a runner artifact for some job. */
const FILTER_SUBJECT = "factory.jobs.>";

/** The stream's own `max_msg_size`; a larger body could not have been stored. */
const MAX_BODY_BYTES = 1_048_576;

/** Messages requested per pull. */
const DEFAULT_BATCH = 10;

/** How long one pull waits for messages before yielding and being reissued. */
const DEFAULT_EXPIRES_MS = 5_000;

/**
 * How long the loop waits after a failed store before pulling again, in ms.
 *
 * The failed message is NAKed with NO delay so JetStream can redeliver it at the
 * head of the next pull, ahead of the later sequences that were deferred with
 * it. The pause belongs to the LOOP, not the message: pulling immediately would
 * spin against a database that is still down, and delaying the message itself
 * would let a later `DONE` overtake it — the F1 defect.
 */
const DEFAULT_RETRY_DELAY_MS = 2_000;

/** The artifact name whose presence means "this host published everything". */
const DONE_ARTIFACT = "DONE";

/** Attempts before JetStream stops redelivering a message. */
const MAX_DELIVER = 5;

/** Nanoseconds the server waits for an ack before redelivering (30s). */
const ACK_WAIT_NANOS = 30 * 1_000_000_000;

/** The minimal `JsMsg` surface this module uses; keeps the fake in tests honest. */
interface ResultMessage {
	subject: string;
	data: Uint8Array;
	headers?: { get(key: string): string } | undefined;
	ack(): void;
	nak(millis?: number): void;
	term(reason?: string): void;
}

/**
 * The job id encoded in `factory.jobs.<job>.result`, or null when the subject is
 * not that shape.
 *
 * @param subject - the subject the message was delivered on
 */
function jobFromSubject(subject: string): string | null {
	const parts = subject.split(".");
	if (parts.length !== 4) return null;
	if (parts[0] !== "factory" || parts[1] !== "jobs" || parts[3] !== "result") return null;
	const job = parts[2];
	return job === undefined || job.length === 0 ? null : job;
}

/**
 * What one message's handling ended in.
 *
 * `stored` and `rejected` are terminal for that message; the failure form
 * carries the error CLASS (never the error) because the loop logs it once for
 * the whole deferred batch.
 */
export type ResultDisposition = "stored" | "rejected" | { failed: string };

/** A message that passed validation, with the three values it will be stored under. */
interface ValidResult {
	job: string;
	hostname: string;
	artifact: string;
}

/**
 * Validate one message against the contract, or name the reason it can never be
 * valid.
 *
 * Split from the storing half so the whole rejection table is one readable
 * function: every branch here ends in a `term()` at the call site, because none
 * of these failures can be fixed by redelivering the same bytes.
 *
 * @param msg - one delivered JetStream message
 * @returns the validated triple, or the rejection reason
 */
function validateResultMessage(msg: ResultMessage): ValidResult | { reason: string } {
	const subjectJob = jobFromSubject(msg.subject);
	if (subjectJob === null) return { reason: "bad_subject" };

	const job = msg.headers?.get("Factory-Job") ?? "";
	const hostname = msg.headers?.get("Factory-Hostname") ?? "";
	const artifact = msg.headers?.get("Factory-Artifact") ?? "";
	if (job.length === 0 || hostname.length === 0 || artifact.length === 0) {
		return { reason: "missing_header" };
	}
	// The subject is what the stream routed on; a header claiming a different job
	// is an attempt to have this artifact ingested as another job's result.
	if (job !== subjectJob) return { reason: "job_subject_mismatch" };
	// The readers' own guard: anything that would not read back must not store.
	if (!isSafeSegment(job) || !isSafeSegment(hostname) || !isSafeSegment(artifact)) {
		return { reason: "unsafe_segment" };
	}
	if (msg.data.byteLength > MAX_BODY_BYTES) return { reason: "oversize" };

	// `Nats-Msg-Id` is the stream's OWN dedupe key, so a wrong one is not a
	// cosmetic mismatch: two artifacts sharing an id have the second silently
	// dropped by the server before this consumer ever sees it, and an id naming
	// another job makes the stream's dedupe window act on a key this row's own
	// (job, host, artifact) does not match. It was previously unread — absent
	// fell back to a generated value and any value at all was stored verbatim.
	// It is now required to be exactly the triple it claims to describe.
	const msgId = msg.headers?.get("Nats-Msg-Id") ?? "";
	if (msgId.length === 0) return { reason: "msg_id_missing" };
	if (msgId !== `${job}:${hostname}:${artifact}`) return { reason: "msg_id_mismatch" };

	// `DONE` is the runner's end-of-publication marker and carries NO body. Its
	// row is what makes `BusResultReader.isDone` true, so a `DONE` with content
	// is a message whose shape is not the one the completeness rule was written
	// against — refuse it rather than store an artifact named DONE.
	if (artifact === DONE_ARTIFACT && msg.data.byteLength !== 0) {
		return { reason: "done_with_body" };
	}

	return { job, hostname, artifact };
}

/**
 * Insert one validated artifact, reporting whether it was already there.
 *
 * `ON CONFLICT (job_runner_id, hostname, artifact) DO NOTHING` makes redelivery
 * free and makes the FIRST body win. `hostname` is in the conflict target
 * because results are per (job, host): without it one host's artifact would
 * suppress another host's, the shape PR #86 fixed.
 *
 * @param msg - the delivered message whose body is stored verbatim
 * @param db - the watcher database
 * @param valid - the validated job/hostname/artifact triple
 * @returns true when the row already existed
 */
async function storeResult(
	msg: ResultMessage,
	db: WatcherDb,
	valid: ValidResult,
): Promise<boolean> {
	const inserted = await db
		.insert(busResults)
		.values({
			jobRunnerId: valid.job,
			hostname: valid.hostname,
			artifact: valid.artifact,
			body: new TextDecoder().decode(msg.data),
			// Validation already proved the header equals this triple exactly, so it
			// is DERIVED here rather than re-read: there is no longer a path on which
			// the stored id could differ from the values it is stored under.
			msgId: `${valid.job}:${valid.hostname}:${valid.artifact}`,
			subject: msg.subject,
		})
		.onConflictDoNothing({
			target: [busResults.jobRunnerId, busResults.hostname, busResults.artifact],
		})
		.returning({ id: busResults.id });
	return inserted.length === 0;
}

/**
 * Validate, store, and dispose of ONE message.
 *
 * Exported so the decision table in the module doc is testable without a
 * cluster: every disposition here is one a fake message can observe. The
 * consumer loop does nothing but hand messages to this function.
 *
 * The DISPOSITION is returned, not just enacted, because the caller has to make
 * a batch-level decision the message itself cannot see: a failed store means the
 * rest of this batch must be deferred too (see the loop).
 *
 * @param msg - one delivered JetStream message
 * @param db - the watcher database
 * @param emit - log sink; defaults to the process logger
 * @param onStored - told after every `stored` disposition whether the row was
 *   FRESH or a duplicate. The loop uses it to decide whether a batch
 *   left anything new for a reconcile pass to read; it is never told about a
 *   rejection or a failed store, because neither wrote a row.
 * @returns which of the three dispositions the message received
 */
export const handleResultMessage = traced(
	"bus.handleResultMessage",
	async function handleResultMessage(
		msg: ResultMessage,
		db: WatcherDb,
		emit: typeof log = log,
		onStored?: (stored: { duplicate: boolean }) => void,
	): Promise<ResultDisposition> {
		const validated = validateResultMessage(msg);
		if ("reason" in validated) {
			emit("warn", "bus.results.rejected", {
				subject: msg.subject,
				reason: validated.reason,
				bytes: msg.data.byteLength,
			});
			msg.term(validated.reason);
			return "rejected";
		}

		const { job, hostname, artifact } = validated;
		const bytes = msg.data.byteLength;
		try {
			const duplicate = await storeResult(msg, db, validated);
			emit("info", "bus.results.stored", { job, hostname, artifact, bytes, duplicate });
			msg.ack();
			onStored?.({ duplicate });
			return "stored";
		} catch (err) {
			// The message is valid and the DATABASE failed: redeliver it. Class only.
			emit("warn", "bus.results.store_failed", {
				job,
				hostname,
				artifact,
				error_class: errorClass(err),
			});
			// NO delay: the artifact must return AHEAD of the later messages this
			// failure defers, and a delay would hold it back past them.
			msg.nak();
			return { failed: errorClass(err) };
		}
	},
);

/** The subset of the bus this consumer borrows: its live connection. */
interface ConsumerBus {
	connection: {
		jetstreamManager(opts?: { checkAPI?: boolean }): Promise<{
			consumers: {
				add(stream: string, cfg: Record<string, unknown>): Promise<unknown>;
				info?(stream: string, name: string): Promise<unknown>;
			};
		}>;
		jetstream(): {
			consumers: {
				get(
					stream: string,
					name: string,
				): Promise<{
					fetch(opts: {
						max_messages: number;
						expires: number;
					}): Promise<AsyncIterable<ResultMessage>>;
				}>;
			};
		};
	};
}

/**
 * Create the durable consumer, or prove the existing one is really there.
 *
 * A durable that already exists is the STEADY STATE, not a failure — every
 * restart takes that path. `info` is what turns "add refused" into "it is
 * already there": without it, an add refused for any OTHER reason would be
 * swallowed and the loop would bind to a consumer that does not exist.
 *
 * @param bus - the bus whose connection owns the JetStream manager
 * @param stream - the stream the durable is created on
 * @param durable - the durable consumer name
 * @param emit - log sink
 */
async function ensureDurable(
	bus: ConsumerBus,
	stream: string,
	durable: string,
	emit: typeof log,
): Promise<void> {
	// checkAPI=false: the `watcher` nkey is scoped to $JS.API.CONSUMER.* and $JS.ACK.>; the
	// default probe of $JS.API.INFO is a permissions violation under that scope.
	const jsm = await bus.connection.jetstreamManager({ checkAPI: false });
	try {
		await jsm.consumers.add(stream, {
			durable_name: durable,
			ack_policy: "explicit",
			deliver_policy: "all",
			filter_subject: FILTER_SUBJECT,
			max_deliver: MAX_DELIVER,
			ack_wait: ACK_WAIT_NANOS,
		});
	} catch (err) {
		if (jsm.consumers.info === undefined) throw err;
		// An add failure means one of two very different things, and treating them
		// alike is the F2 defect: "the durable is already there" (the steady state
		// every restart takes) versus "the add was REFUSED" (no permission, wrong
		// stream, a malformed config). `info()` is what tells them apart, and a
		// failing `info()` proves the durable is NOT there — so the ORIGINAL add
		// error is the one that explains the failure, not the lookup's.
		let existing: unknown;
		try {
			existing = await jsm.consumers.info(stream, durable);
		} catch {
			throw err;
		}
		// Existing is not the same as CORRECT. A durable created by an older build,
		// by hand, or by another service is bound and silently obeyed: a
		// `max_deliver` of 3 where 5 is intended shortens exactly the redelivery
		// budget the deferred-batch recovery depends on, and a wider
		// `filter_subject` feeds this consumer messages it never validated for.
		// Every field this module states is therefore compared, and a mismatch
		// refuses the start rather than adopting a shape nobody chose.
		const mismatch = durableMismatch(existing);
		if (mismatch !== undefined) {
			throw new Error(
				`durable ${durable} exists with a different config: ${mismatch.field} is ${mismatch.have}, want ${mismatch.want}`,
			);
		}
		emit("info", "bus.results.consumer_exists", { stream, durable });
	}
}

/** The consumer config this module creates, and the one an existing durable must match. */
const INTENDED_CONFIG: Record<string, string | number> = {
	filter_subject: FILTER_SUBJECT,
	ack_policy: "explicit",
	deliver_policy: "all",
	max_deliver: MAX_DELIVER,
	ack_wait: ACK_WAIT_NANOS,
};

/**
 * The first intended field an existing durable disagrees with, or undefined.
 *
 * A MISSING field counts as a mismatch rather than a pass: the server always
 * reports these five, so absent means the response is not the shape this check
 * was written against, and silently accepting it would restore exactly the
 * blind trust F2 removed.
 *
 * @param info - whatever `consumers.info` returned, untrusted in shape
 * @returns the field, its observed value, and the intended one
 */
function durableMismatch(info: unknown): { field: string; have: string; want: string } | undefined {
	const config = (info as { config?: Record<string, unknown> } | null)?.config;
	for (const [field, want] of Object.entries(INTENDED_CONFIG)) {
		const have = config?.[field];
		if (have !== want) {
			return { field, have: String(have), want: String(want) };
		}
	}
	return undefined;
}

/**
 * Hand every message in one pull to the handler, stopping at the first store
 * failure.
 *
 * THE WHOLE POINT (F1): the runner publishes one message per artifact and a
 * final 0-byte `DONE`, and `BusResultReader` calls the job complete the instant
 * the DONE row exists. Continuing past a failed store would let a later DONE be
 * ingested while the artifact it announces is still missing — the reconciler
 * then reads that artifact, finds nothing, and terminalizes the attempt as
 * invalid. So the remaining messages are NAKed UNPROCESSED: not validated, not
 * inserted, just returned to the stream, where JetStream redelivers them in
 * stream order behind the artifact that failed.
 *
 * @param messages - the pull window's messages, in stream order
 * @param db - the watcher database
 * @param emit - log sink
 * @param loop - `running`: whether the loop is still live, a stop ends the
 *   drain; `onStored`: rung ONCE, after the batch, when at least one FRESH row
 *   was written — once per batch rather than per message because the
 *   wake it drives coalesces anyway, and a batch of duplicates rings nothing.
 * @returns true when the batch was deferred by a store failure
 */
async function drainBatch(
	messages: AsyncIterable<ResultMessage>,
	db: WatcherDb,
	emit: typeof log,
	loop: { running: () => boolean; onStored?: () => void },
): Promise<boolean> {
	let failure: string | undefined;
	let remaining = 0;
	let fresh = 0;
	for await (const msg of messages) {
		if (failure !== undefined) {
			// Deferred, not examined: this message's turn comes after the failed one
			// is redelivered and stored.
			remaining += 1;
			msg.nak();
			continue;
		}
		// job_id seeded per message: the handler runs in the scope, the loop does not.
		const job = jobFromSubject(msg.subject);
		const disposition = await withLogFields(job === null ? {} : { job_id: job }, () =>
			handleResultMessage(msg, db, emit, (stored) => {
				if (!stored.duplicate) fresh += 1;
			}),
		);
		if (typeof disposition !== "string") {
			failure = disposition.failed;
			continue;
		}
		if (!loop.running()) break;
	}
	// Ring even when the tail of the batch was deferred: the rows written before
	// the failure are real and a pass can already read them.
	if (fresh > 0) loop.onStored?.();
	if (failure === undefined) return false;
	emit("warn", "bus.results.batch_deferred", { remaining, error_class: failure });
	return true;
}

/**
 * Create the durable (idempotently) and run the pull loop until `stop()`.
 *
 * `fetch()` is used rather than `consume()` because a fetch window ENDS on its
 * own at `expires`: the loop reaches its own top on a bounded schedule, which is
 * what makes `stop()` prompt and unconditional rather than dependent on the
 * client's teardown. `stop()` therefore returns within `expiresMs` plus the time
 * to finish the message in hand.
 *
 * A pull error is logged and the loop backs off rather than exiting — the stream
 * being briefly unreachable must not permanently stop ingest in a process that
 * is otherwise healthy.
 *
 * @param opts - the bus to borrow, the database to write, and the consumer's shape
 * @returns a handle whose `stop()` ends the loop and awaits the in-flight message
 */
export const startResultsConsumer = traced(
	"bus.startResultsConsumer",
	async function startResultsConsumer(opts: {
		bus: ConsumerBus;
		db: WatcherDb;
		log?: typeof log;
		stream?: string;
		durable?: string;
		batch?: number;
		expiresMs?: number;
		/** Loop pause after a deferred batch, in ms. Defaults to 2000. */
		retryDelayMs?: number;
		/**
		 * Rung once per batch that stored at least one fresh row. The
		 * service hands in the scheduler's coalescing trigger, so a result is
		 * reconciled on the next pass rather than up to `poll_interval_minutes`
		 * later. Optional: a consumer without it still stores every row and the
		 * periodic sweep still reads them, as before.
		 */
		onStored?: () => void;
	}): Promise<{ stop(): Promise<void> }> {
		const emit = opts.log ?? log;
		const stream = opts.stream ?? DEFAULT_STREAM;
		const durable = opts.durable ?? DEFAULT_DURABLE;
		const batch = opts.batch ?? DEFAULT_BATCH;
		const expires = opts.expiresMs ?? DEFAULT_EXPIRES_MS;
		const retryDelayMs = opts.retryDelayMs ?? DEFAULT_RETRY_DELAY_MS;

		await ensureDurable(opts.bus, stream, durable, emit);
		const consumer = await opts.bus.connection.jetstream().consumers.get(stream, durable);

		let running = true;
		const loop = (async () => {
			while (running) {
				try {
					const messages = await consumer.fetch({ max_messages: batch, expires });
					const deferred = await drainBatch(messages, opts.db, emit, {
						running: () => running,
						onStored: opts.onStored,
					});
					// A failed store defers the whole batch, so the next pull must not be
					// immediate: the database is still unavailable and the NAKed messages
					// are about to be redelivered into it.
					if (deferred && running) {
						await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
					}
				} catch (err) {
					emit("warn", "bus.results.fetch_failed", {
						stream,
						durable,
						error_class: errorClass(err),
					});
					if (!running) break;
					await new Promise((resolve) => setTimeout(resolve, expires));
				}
			}
		})();

		return {
			stop: async (): Promise<void> => {
				running = false;
				await loop;
			},
		};
	},
);
