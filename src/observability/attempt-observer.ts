/**
 * @module observability/attempt-observer
 * @description The `IngestObserver` the result reconciler installs. It
 *   turns one attempt's raw `events.jsonl` into two durable-ish facts:
 *
 *     1. `job_attempts.observed_model` — the PROVIDER-ATTESTED model the attempt
 *        actually ran on, stamped from the stream's `message_end` envelope and
 *        NEVER from an agent-authored field. In the #110 pilot the agent wrote
 *        `"observed_model": "ChatGPT"` into its own result while the server
 *        attested `gpt-5.6-sol`; a model's claim about itself is runner output.
 *     2. One Langfuse trace per attempt, when Langfuse is configured.
 *     3. `job_attempts.trace_id` — the id that trace was emitted under,
 *        written from `traceIdFor` so a db row reaches its trace in one query.
 *        Stamped whether or not Langfuse is configured and whether or not the
 *        stream carried an attestation: the id is derived from the trusted
 *        identity, and the attempts most worth reaching a trace for are exactly
 *        the ones missing something else.
 *     4. `attempt_event_streams` — the DURABLE copy of the raw stream itself,
 *       so the record outlives the share's job directory. The share
 *        carries no retention guarantee, so the database is the durable home;
 *        the file is the raw record only while it happens to exist.
 *
 *   ALL ARE BEST-EFFORT AND NONE BLOCKS INGEST. `observe` returns void: it
 *   starts the work and returns immediately, and every failure inside — a parse
 *   that yields nothing, a database write that errors, an unreachable Langfuse —
 *   is caught and reduced to one log line. Nothing here can fail an ingest,
 *   change a publication, or alter a job's state. That is the whole contract:
 *   observability is not a control input, and runner output
 *   stays untrusted.
 *
 *   IDENTITY IS THE TRUSTED DB JOIN. Repository, item number, sha, job type,
 *   vmid, and the attempt/job ids are resolved by joining from the runner job id
 *   through `job_attempts` — the same trusted path the result store uses. Nothing
 *   a runner wrote decides what a trace is tagged with. Results are per
 *   (job, host), so the hostname is carried through and the trace binds to the
 *   attempt whose result was actually ingested, never to `jobRunnerId` alone.
 *
 * @outputs
 *   - `AttemptObserver` -- the reconciler-installed `IngestObserver`
 *   - `safeObservedModel` -- the redact+bound applied before the durable stamp
 *   - `MAX_PERSISTED_EVENT_STREAM_BYTES` -- the durable-copy write cap
 *
 * @dependencies
 *   - drizzle-orm, ../db/schema -- the trusted identity join and the stamp write
 *   - ../results/ingest -- `redactSecrets`, applied again before the durable stamp
 *   - ./event-stream -- the bounded, pure stream mapping
 *   - ./langfuse -- the emission seam (null when Langfuse is unconfigured)
 */
import { and, desc, eq, isNull } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { attemptEventStreams, githubItems, jobAttempts, jobs, repositories } from "../db/schema";
import { errorClass, log, traced } from "../log";
import { type IngestObserver, redactSecrets } from "../results/ingest";
import { type AttemptTrace, parseEventStream } from "./event-stream";
import { HostConflictTally } from "./host-conflicts";
import { type AttemptTraceIdentity, type TraceEmitter, traceIdFor } from "./langfuse";

/** Max characters of an attested model string persisted to the attempt row. */
const MAX_MODEL = 200;

/**
 * Max UTF-8 bytes of a raw event stream written to `attempt_event_streams`.
 * Deliberately ABOVE ingest's own `MAX_EVENT_STREAM_BYTES` (4MB): the
 * read cap is the real bound in normal operation and nothing that reaches here
 * can exceed it, so this is slack that bounds the column against a future read
 * cap being raised without a matching thought about the durable store.
 *
 * A stream above this is SKIPPED, never truncated — see `persistEventStream`.
 */
export const MAX_PERSISTED_EVENT_STREAM_BYTES = 5_000_000;

/**
 * Placeholder for the host that WON the first-writer race. `job_attempts` records
 * the attested model but no companion host column, so which host stamped it is
 * not knowable without a schema change. Shown on the status page
 * as-is, so an operator reads "we do not know" rather than a plausible guess.
 */
const UNKNOWN_STAMPING_HOST = "unknown";

/**
 * The value actually written to `job_attempts.observed_model`: redacted, then
 * bounded. Returns null for an attestation not worth persisting.
 *
 * EXPORTED SO IT IS DIRECTLY TESTABLE. The stamp is only reachable through
 * `parseEventStream`, which redacts these fields itself — so a test driving the
 * observer end to end passes whether or not THIS guard exists, and would have
 * proved the opposite of its name (verified by mutation: removing the redaction
 * here left the end-to-end test green). Hence the direct unit test.
 *
 * WHAT THE TWO GUARDS ACTUALLY BUY, PRECISELY. They are two independently
 * REACHABLE application sites, not two independent redaction implementations:
 * both call the same `redactSecrets`, so they detect exactly the same secret
 * shapes and a pattern that misses a secret in one misses it in the other.
 * Calling them "second, independent" overstated it.
 * What the second site does buy is BOUNDING and REACHABILITY — it is the only
 * guard on the path if a future caller stamps a model from somewhere other than
 * `parseEventStream`, and it is the only place `MAX_MODEL` is applied to the
 * value that outlives the process. Widening `redactSecrets` coverage is a
 * separate concern and is not this function's job.
 *
 * @param observedModel - the attested model off the stream (UNTRUSTED)
 * @returns the safe, bounded value, or null when there is nothing to write
 */
export const safeObservedModel = traced(
	"observability.safeObservedModel",
	function safeObservedModel(observedModel: string | null): string | null {
		if (observedModel === null || observedModel.trim() === "") {
			return null;
		}
		return redactSecrets(observedModel.trim()).slice(0, MAX_MODEL);
	},
);

/**
 * Observes each ingested attempt: stamps the attested model and emits one trace.
 *
 * The emitter is optional. With Langfuse unconfigured the attestation stamp still
 * happens — it is a database write against the watcher's own state and has
 * nothing to do with whether a trace sink exists.
 */
export class AttemptObserver implements IngestObserver {
	private readonly db: WatcherDb;
	private readonly emitter: TraceEmitter | null;
	private readonly now: () => Date;
	/**
	 * Every in-flight observation, so `shutdown` can DRAIN before it flushes.
	 *
	 * Detached is not the same as untracked. `observe` still returns void and
	 * still awaits nothing on the hot path — it registers the promise here and
	 * returns — but the promise now has a holder, so the stop path can wait for
	 * the read/stamp/enqueue to finish before asking the emitter to ship.
	 * Entries remove themselves in a `finally`, so a rejecting observation cannot
	 * leak a set entry and cannot produce an unhandled rejection.
	 */
	private readonly pending = new Set<Promise<void>>();
	/**
	 * True once the drain has COMPLETED — not merely once `shutdown` was entered.
	 *
	 * The distinction is the whole fix: a chain still draining spawns its own
	 * continuation (ingest's read resolves, then calls `observe`), and that
	 * continuation must still be tracked or the flush loses the very trace the
	 * drain was waiting for. Only work arriving after the set has genuinely
	 * emptied is too late to matter.
	 */
	private drained = false;
	/**
	 * The operator-visible host-conflict tripwire. Recorded into from the
	 * SAME warn path that logs `observability.model.host_conflict`, so the status
	 * page's counter and the log line cannot disagree. Optional: a caller that
	 * wants no tripwire (every existing test) passes nothing and gets a private
	 * tally nobody reads, which keeps the record site unconditional.
	 */
	private readonly conflicts: HostConflictTally;

	constructor(
		db: WatcherDb,
		emitter: TraceEmitter | null,
		now: () => Date = () => new Date(),
		conflicts: HostConflictTally = new HostConflictTally(now),
	) {
		this.db = db;
		this.emitter = emitter;
		this.now = now;
		this.conflicts = conflicts;
	}

	/**
	 * VOID-RETURNING BY CONTRACT. Ingest calls this and moves on; the work below
	 * runs detached so no ingest await can ever be joined to a database round trip
	 * or an HTTP flush. Every failure is caught inside `run`.
	 *
	 * DETACHED, BUT TRACKED. The promise goes into `pending` so `shutdown` can
	 * drain it; nothing on this path awaits or throws.
	 */
	observe(args: {
		jobRunnerId: string;
		hostname: string;
		rawEventStream: string;
		ingested: boolean;
		schemaValid: boolean;
		changeVerified?: boolean;
	}): void {
		this.track(this.run(args));
	}

	/**
	 * Register an already-running observation chain in the drain set.
	 *
	 * THE CHAIN STARTS BEFORE `observe` DOES. Ingest reads `events.jsonl` off the
	 * share and only then calls `observe`, and that read is itself detached
	 * (`void observeAttempt(...)`). Tracking only the `run` promise therefore
	 * drains the second half of the chain and races the first: shutdown could
	 * flush an empty queue while a read still in flight was about to enqueue a
	 * trace, which is exactly the P1 the Sol gauntlet reproduced on head d0dd7de.
	 * Ingest hands the WHOLE chain here, so read + stamp + enqueue all complete
	 * before the flush.
	 *
	 * NEVER THROWS AND NEVER REJECTS ONWARD. The stored promise is the caller's
	 * own; failures are swallowed into the drain (`allSettled` in `shutdown`) and
	 * a `catch` is attached so an unobserved rejection cannot reach the process.
	 * After the drain has FINISHED, work is left to run out on its own — refusing
	 * to track it is the point, since the flush it would target has already
	 * happened.
	 *
	 * WHILE A DRAIN IS RUNNING, WORK IS STILL ACCEPTED, and it must be. A tracked
	 * chain is not one promise but a sequence: ingest's read resolves and only
	 * THEN calls `observe`, which starts the parse/stamp/enqueue as a second
	 * promise. Refusing that second registration because `shutdown` had already
	 * been entered dropped the enqueue the drain existed to wait for — the flush
	 * then ran with an empty queue, which is the original defect wearing a drain.
	 * The `while` loop in `shutdown` is what makes this terminate: each wave
	 * settles, any continuation it spawned is already in the set, and the loop
	 * exits only when the set is genuinely empty.
	 */
	track(work: Promise<void>): void {
		if (this.drained) {
			log("debug", "observability.observe.after_shutdown", {});
			void work.catch(() => {});
			return;
		}
		const tracked = work
			.catch(() => {})
			.finally(() => {
				this.pending.delete(tracked);
			});
		this.pending.add(tracked);
	}

	/**
	 * Flush whatever the emitter still holds. Called ONLY from the service's stop
	 * path, never on the hot path.
	 *
	 * The observer owns the emitter, so it owns the seam that reaches its
	 * shutdown: the emitter is constructed inside the ingest wiring and nothing
	 * else has a reference to it. Without this passthrough `TraceEmitter.shutdown`
	 * had no production caller at all and every queued trace in the SDK's 10s
	 * batching window was dropped on each restart.
	 *
	 * Never throws: a stop path that can fail on an observability flush is worse
	 * than a dropped trace.
	 *
	 * DRAIN, THEN FLUSH — in that order, and the order is the contract. Every
	 * observation is detached, so at the moment `stop()` is called the final
	 * pass's traces may not be IN the emitter yet: they are still being read off
	 * the share, joined against the DB, and enqueued. Flushing first ships an
	 * empty queue and the process then exits underneath the work that was about
	 * to fill it — the flush "succeeds" and the traces are gone (Sol gauntlet P1,
	 * head d0dd7de). So: stop accepting new work, wait for everything already in
	 * flight to settle, and only then ask the emitter to ship.
	 *
	 * `allSettled`, not `all`: one failed observation must not skip the flush for
	 * the others. The set is RE-READ after each wave rather than snapshotted
	 * once, because settling one stage of a chain registers the next — ingest's
	 * share read resolving is what calls `observe`, which enqueues. Waiting on a
	 * single snapshot would return before that enqueue and flush without it.
	 */
	async shutdown(): Promise<void> {
		while (this.pending.size > 0) {
			await Promise.allSettled(this.pending);
		}
		// Set only now that the set is genuinely empty: anything arriving after
		// this point has no flush left to reach and is refused rather than queued
		// behind one that already ran.
		this.drained = true;
		if (this.emitter === null) {
			return;
		}
		try {
			await this.emitter.shutdown();
			// Silence means success is this repo's log contract, but a FLUSH is the
			// one place where "nothing happened" and "the flush never ran" look
			// identical from the outside — which is exactly the P1 defect this seam
			// fixes. One line makes the difference observable, in an operator's
			// journal and in the test that proves `stop()` reaches this at all.
			//
			// `info`, not `debug`: the level is fixed at module init from `LOG_LEVEL`,
			// so a debug line is invisible in the default deployment AND untestable.
			// It fires at most once per process shutdown, which is not noise.
			log("info", "observability.langfuse.flushed", {});
		} catch (err) {
			log("warn", "observability.langfuse.emit_failed", { error_class: errorClass(err) });
		}
	}

	/** The detached body. Never throws — every path is caught and logged once. */
	private async run(args: {
		jobRunnerId: string;
		hostname: string;
		rawEventStream: string;
		ingested: boolean;
		schemaValid: boolean;
		changeVerified?: boolean;
	}): Promise<void> {
		try {
			// The parse is pure and bounded; a null means the stream was oversized,
			// unparseable, or carried no assistant turn worth recording. All three are
			// the same non-event: log once and stop.
			//
			// `info`, NOT `debug`. The level is fixed at module init from
			// `LOG_LEVEL`, so a debug line does not exist in the default deployment —
			// and that is not hypothetical: with the producer unwired
			// EVERY attempt skipped its stream for two days across 214 attempt dirs and
			// emitted zero visible signal, so an operator watching a healthy sink with
			// zero traces had nothing to read, and diagnosing it cost a full job cycle.
			// The same reasoning already fixed `observability.langfuse.flushed` one
			// method up: the one place where "nothing happened" and "it never ran" look
			// identical from outside is exactly where the line has to be visible.
			//
			// NOT per-attempt noise once the producer is wired: a lane that writes its
			// stream parses and never reaches this branch — the healthy-path control in
			// `tests/observability/stream-skip-visibility.test.ts` asserts exactly that.
			// A line here means an attempt produced no usable stream, which is the fact
			// worth seeing.
			const trace = parseEventStream(args.rawEventStream);
			// THE #219 LINE IS EMITTED BEFORE ANY DATABASE WORK, and that ordering is
			// load-bearing. It used to sit in front of an early `return`, so it was
			// unreachable-by-construction from a db failure; sf#183 has to continue
			// past it to write the durable copy, so the line is hoisted here rather
			// than left downstream of a join that can throw. An unusable stream is
			// visible even when the identity lookup fails — which is exactly the state
			// describes, where nothing worked and nothing said so.
			if (trace === null) {
				log("info", "observability.stream.skipped", {
					job_runner_id: args.jobRunnerId,
					host: args.hostname,
				});
			}
			const identity = await this.resolveIdentity(args.jobRunnerId, args.hostname);
			if (identity === null) {
				return;
			}
			// PERSISTED WHETHER OR NOT IT PARSED. The durable copy is the RAW
			// RECORD, and a stream this repo's parser cannot use is exactly the one an
			// operator will later need the original bytes of. Persisting only what
			// parsed would make the durable store a mirror of the parser's current
			// capabilities rather than of the file — and the file is the thing the
			// share does not guarantee to keep.
			await this.persistEventStream(identity, args.rawEventStream);
			if (trace === null) {
				return;
			}
			await this.stampObservedModel(identity, trace.observedModel, args.jobRunnerId);
			this.emit(identity, trace, args);
		} catch (err) {
			// Class only: a driver error can quote the connection string, and an SDK
			// error can quote the request it failed on.
			log("warn", "observability.langfuse.emit_failed", {
				job_runner_id: args.jobRunnerId,
				host: args.hostname,
				error_class: errorClass(err),
			});
		}
	}

	/**
	 * Resolve the TRUSTED identity for this attempt by joining from the runner job
	 * id, exactly as the result store does. Ordered newest-first so the lookup is
	 * deterministic even if the runner-job-id uniqueness invariant is violated.
	 * Returns null for an unknown/foreign runner job id — nothing to observe.
	 */
	private async resolveIdentity(
		jobRunnerId: string,
		hostname: string,
	): Promise<AttemptTraceIdentity | null> {
		const [row] = await this.db
			.select({
				attemptId: jobAttempts.id,
				jobId: jobAttempts.jobId,
				vmid: jobAttempts.runnerVmid,
				repository: repositories.fullName,
				jobType: jobs.jobType,
				sha: jobs.sha,
				itemNumber: githubItems.number,
			})
			.from(jobAttempts)
			.innerJoin(jobs, eq(jobs.id, jobAttempts.jobId))
			.innerJoin(repositories, eq(repositories.id, jobs.repositoryId))
			.leftJoin(githubItems, eq(githubItems.id, jobs.itemId))
			.where(eq(jobAttempts.runnerJobId, jobRunnerId))
			.orderBy(desc(jobAttempts.id))
			.limit(1);
		if (row === undefined) {
			return null;
		}
		return {
			attemptId: row.attemptId,
			jobId: row.jobId,
			repository: row.repository,
			jobType: row.jobType,
			sha: row.sha,
			itemNumber: row.itemNumber ?? null,
			vmid: row.vmid,
			hostname,
		};
	}

	/**
	 * Stamp the attested model on the attempt row.
	 *
	 * The value is REDACTED and then bounded before it is written: it came off a
	 * runner box, so neither its content nor its length is to be trusted even
	 * though its SOURCE (the provider's own response envelope, as recorded by the
	 * runtime) is the best attestation available. Length-slicing alone let a
	 * secret-shaped `model` land verbatim in a durable column;
	 * `event-stream` now clips+redacts it too, so this is the second, independent
	 * guard on the one value that persists. A null attestation writes nothing
	 * rather than clearing a value a previous read established.
	 *
	 * FIRST-WRITER-WINS ACROSS HOSTS. Results are per (job, host), so one attempt
	 * can be observed from several hosts, and an unconditional `UPDATE` made the
	 * stamp last-writer-wins — nondeterministic under concurrent ingest, and
	 * silently so. The `observed_model IS NULL` guard makes the first attestation
	 * the durable one; a LATER, DIFFERING attestation is not written but IS made
	 * visible as `observability.model.host_conflict`, because two hosts reporting
	 * two models for one attempt is a fact worth seeing, not a race to discard.
	 */
	private async stampObservedModel(
		identity: AttemptTraceIdentity,
		observedModel: string | null,
		jobRunnerId: string,
	): Promise<void> {
		await this.stampTraceId(identity);
		const value = safeObservedModel(observedModel);
		if (value === null) {
			return;
		}
		const stamped = await this.db
			.update(jobAttempts)
			.set({ observedModel: value })
			.where(and(eq(jobAttempts.id, identity.attemptId), isNull(jobAttempts.observedModel)))
			.returning({ id: jobAttempts.id });
		if (stamped.length > 0) {
			return;
		}
		// The row already carried an attestation. Identical is the ordinary case
		// (the same host re-ingested); DIFFERING means two hosts disagree about what
		// this attempt ran on, which the operator needs to see.
		const [row] = await this.db
			.select({ observedModel: jobAttempts.observedModel })
			.from(jobAttempts)
			.where(eq(jobAttempts.id, identity.attemptId));
		// `!== undefined` is the MISSING-ROW check and is load-bearing: `row` itself
		// being undefined is the only way this is undefined. The additional `!== null`
		// is a TYPE narrowing, not a new behavioral gate — the column is declared
		// nullable, but a null value here is unreachable (see the note below), so this
		// excludes nothing that can actually occur.
		if (
			row?.observedModel !== undefined &&
			row.observedModel !== null &&
			row.observedModel !== value
		) {
			log("warn", "observability.model.host_conflict", {
				job_runner_id: jobRunnerId,
				host: identity.hostname,
				attempt_id: identity.attemptId,
				stamped_model: row.observedModel,
				observed_model: value,
			});
			// The operator-visible half of the same fact. Deliberately in this
			// block and not a second detection path: a journald line nobody greps is
			// not a tripwire, and a counter keyed on its own re-derived condition
			// could disagree with the log. The stamped model came out of our own
			// column and `value` is already redacted+bounded, so nothing unbounded or
			// runner-authored reaches the status page.
			//
			// THE STAMPING HOST IS NOT RECOVERABLE HERE, and the pair says so rather
			// than guessing. `job_attempts` stores `observed_model` and no companion
			// host column (src/db/schema.ts:274), so the host that won the
			// first-writer race is genuinely unknown to this code; naming it would
			// require a migration, which #190 explicitly rules out. The host that
			// DISAGREED is known exactly, and it is the one the operator needs in
			// order to go read the logs.
			//
			// `row.observedModel` IS NON-NULL ON THIS PATH, by construction rather than
			// by check. Reaching here means the `observed_model IS NULL` UPDATE above
			// matched zero rows AND this SELECT found the row — i.e. the row exists and
			// its model is not null, since a null one would have been updated. The
			// column's type stays nullable, so the guard below reads as a null check to
			// a reader; it is the MISSING-ROW check (`row?.observedModel !== undefined`
			// is undefined only when `row` itself is), which is load-bearing and stays.
			// An earlier revision carried a `?? "(none)"` fallback for a null model:
			// that branch was unreachable (probed both ways, PR #208 review) and is gone
			// rather than left as a comment describing a case that cannot occur.
			this.conflicts.record({
				attemptId: String(identity.attemptId),
				stamped: { host: UNKNOWN_STAMPING_HOST, model: row.observedModel },
				observed: { host: identity.hostname, model: value },
			});
		}
	}

	/**
	 * Persist the attempt's raw event stream to its DURABLE home.
	 *
	 * WHY THE DATABASE. The ticket asked for a "durable watcher-owned artifact
	 * path"; there is none. The collab share's per-job directories carry NO
	 * retention guarantee (rtech-infra, 2026-08-17), so a watcher-owned copy on
	 * that same share is the same no-guarantee class plus a second unmanaged
	 * store. Postgres is the store this process already treats as durable. The
	 * file remains the raw record while it lives; this row is what outlives it.
	 *
	 * DEFENCE IN DEPTH, NOT A GATE. Every failure below is caught here and
	 * reduced to one bounded warn: a write that can fail an observation would
	 * make the durable copy cost more than the thing it protects. The caller's
	 * own catch would already swallow a throw, but then the stamp and the emit
	 * that follow this call would be skipped too — so the catch lives HERE, and
	 * a failed copy loses only the copy.
	 *
	 * FIRST-WRITER-WINS via `onConflictDoNothing` on the primary key. Results are
	 * per (job, host) and a restart re-reads the same DONE, so several reads of
	 * one attempt are ordinary; the FIRST is the durable record and a later read
	 * never overwrites it. An UPSERT here would make the stored bytes
	 * last-writer-wins and nondeterministic, which is the exact defect the
	 * `observed_model` stamp one method up already had to fix.
	 *
	 * SKIPPED, NEVER TRUNCATED, above the cap. A truncated stream is a corrupt
	 * record wearing the shape of a good one: it parses, it looks complete, and
	 * nothing downstream can tell it was cut. Refusing it keeps "there is a row"
	 * meaning "these are the exact bytes". The cap is
	 * {@link MAX_PERSISTED_EVENT_STREAM_BYTES} — above ingest's own 4MB read cap,
	 * so under normal operation nothing reaches it; it bounds the column against
	 * a future read cap being raised, and it is measured in UTF-8 BYTES rather
	 * than characters because that is what the column and the ingest cap both
	 * count.
	 */
	private async persistEventStream(
		identity: AttemptTraceIdentity,
		rawEventStream: string,
	): Promise<void> {
		try {
			// AN ABSENT OR EMPTY STREAM IS A CLEAN SILENT SKIP — no row, no log line.
			// Ingest returns before `observe` for a genuinely absent file, so this
			// guard covers the present-but-empty case and any direct caller. It must
			// stay silent: the producer is still unwired, so absence is
			// today's NORMAL case on every attempt the factory runs, and a warn here
			// would be per-attempt noise with nothing to act on. Storing an empty row
			// would be worse — it makes "there is a record" stop meaning "there are
			// bytes to read".
			if (rawEventStream.trim() === "") {
				return;
			}
			const byteLength = Buffer.byteLength(rawEventStream, "utf8");
			if (byteLength > MAX_PERSISTED_EVENT_STREAM_BYTES) {
				log("warn", "observability.event_stream.oversized", {
					attempt_id: identity.attemptId,
					host: identity.hostname,
					byte_length: byteLength,
					limit: MAX_PERSISTED_EVENT_STREAM_BYTES,
				});
				return;
			}
			await this.db
				.insert(attemptEventStreams)
				.values({ attemptId: identity.attemptId, content: rawEventStream, byteLength })
				.onConflictDoNothing({ target: attemptEventStreams.attemptId });
		} catch (err) {
			// Class only, never the message: a driver error can quote the connection
			// string, and a constraint error can quote the row it refused.
			log("warn", "observability.event_stream.persist_failed", {
				attempt_id: identity.attemptId,
				host: identity.hostname,
				error_class: errorClass(err),
			});
		}
	}

	/**
	 * Stamp the Langfuse trace id on the attempt row.
	 *
	 * THE VALUE COMES FROM `traceIdFor`, THE EMITTER'S OWN FUNCTION, never from a
	 * second spelling of the `attempt-N-<host>` format. A duplicated format is a
	 * duplicate that drifts: #176 added the host qualifier in `langfuse.ts`, and a
	 * copy here would still be writing `attempt-N` — a column pointing at a trace
	 * id nothing ever emits, which is worse than an empty column because it looks
	 * answered.
	 *
	 * IDS ONLY. The base URL is not written: the Langfuse host is LAN/tailnet-
	 * internal, and a stored URL puts an internal hostname into a column that
	 * outward-facing code paths read. The operator-facing link is composed at
	 * render time by the one surface allowed to know the host (the status page).
	 *
	 * FIRST-WRITER-WINS, matching `observed_model` above and for the same reason:
	 * results are per (job, host), so two hosts observing one attempt would
	 * otherwise make the stamp last-writer-wins and nondeterministic. Both hosts'
	 * traces exist in Langfuse — this column names the first one observed, which
	 * is a real trace for this attempt, and the session (`job-N`) collects the
	 * rest. No conflict tripwire is warranted here (unlike a model disagreement):
	 * two hosts producing two trace ids is the DESIGNED behavior, not a
	 * discrepancy an operator needs to see.
	 *
	 * SEPARATE FROM THE MODEL STAMP'S UPDATE, deliberately. The model stamp writes
	 * nothing when the stream carried no attestation, and a trace id is always
	 * available because it is derived from the trusted identity alone — folding
	 * them into one statement would make the trace id inherit a guard that has
	 * nothing to do with it, and the attempts most worth reaching a trace for are
	 * exactly the ones whose attestation is missing.
	 */
	private async stampTraceId(identity: AttemptTraceIdentity): Promise<void> {
		await this.db
			.update(jobAttempts)
			.set({ traceId: traceIdFor(identity) })
			.where(and(eq(jobAttempts.id, identity.attemptId), isNull(jobAttempts.traceId)));
	}

	/** Hand the trace to the emitter, if one is configured. */
	private emit(
		identity: AttemptTraceIdentity,
		trace: AttemptTrace,
		outcome: { ingested: boolean; schemaValid: boolean; changeVerified?: boolean },
	): void {
		if (this.emitter === null) {
			return;
		}
		this.emitter.emit({
			identity,
			trace,
			scores: {
				ingestOk: outcome.ingested ? 1 : 0,
				// SCHEMA VALIDATION ONLY, NOT INGEST SUCCESS. This used to be
				// `outcome.ingested`, which scored a change-verifier rejection or a
				// store refusal as a SCHEMA failure — actively false, because the
				// document had parsed and validated and a strictly later boundary
				// refused it. The two scores now answer different questions, so a
				// `result_schema_valid = 0` names the schema and nothing else.
				schemaValid: outcome.schemaValid ? 1 : 0,
				changeVerified:
					outcome.changeVerified === undefined ? undefined : outcome.changeVerified ? 1 : 0,
			},
			// INGEST-observed time, not the run's own start: a backdated trace hides
			// behind the Langfuse UI's default Past-1-day filter (observed 2026-08-03).
			at: this.now(),
		});
	}
}
