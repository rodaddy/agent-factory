/**
 * @module observability/host-conflicts
 * @description The operator-visible tally behind `observability.model.host_conflict`.
 *  `attempt-observer` stamps `job_attempts.observed_model`
 *   first-writer-wins; when a LATER host attests a different model for the same
 *   attempt the stamp is kept and a warning event is logged. The owner ruled on
 *   2026-08-03 that first-writer-wins stays, so the follow-up is a TRIPWIRE: a
 *   real dual-host interleaving must be NOTICED, not merely exist in journald.
 *
 *   This module is that tripwire's source of truth. It is the SAME call site as
 *   the warning — `recordHostConflict` sits beside the existing `log("warn", ...)`
 *   — so there is exactly one detection path and the counter cannot drift from
 *   the log line. It adds no detection logic of its own and reads nothing.
 *
 *   IN-MEMORY AND PROCESS-LOCAL, DELIBERATELY. The status page's other fields are
 *   DB-derived, but persisting this one would need a migration, and the issue's
 *   ratified scope is a counter with no schema change. The observer and the status
 *   server live in ONE Bun process (`composeService` builds both — src/service.ts),
 *   so a process-local tally is genuinely reachable from the page. The cost is that
 *   a restart zeroes the count; the acceptance property is that an operator sees a
 *   conflict within one day, and the durable record of any conflict remains the
 *   logged warning event. The page says the count is since-start so the zero is
 *   never read as "no conflict ever happened".
 *
 *   NOTHING HERE CAN FAIL AN INGEST. It is a counter and two small fields behind a
 *   synchronous method, on the same best-effort path the observer already promises
 *   cannot throw into ingest.
 *
 *   NOTHING UNBOUNDED REACHES THE STATUS PAGE, and this module is what makes that
 *   true. Only the LAST conflict is retained, so the record cannot grow, and both
 *   fields of both pairs are clipped to `MAX_PAIR_FIELD` on record — see the
 *   constant for why `host` needs it and a caller's bound is not enough.
 *
 * @outputs
 *   - `HostConflictTally` -- the process-local recorder + reader
 *   - `HostConflictStatus` -- the bounded shape the status snapshot carries
 *   - `HostConflictPair` -- one host's attested (host, model) pair
 *
 * @dependencies
 *   - none (deliberately: this is a leaf so the emit site can own it with no cycle)
 */

/**
 * Max characters of either field retained on a recorded pair.
 *
 * The same bound `attempt-observer` applies to a model before it is stamped
 * (`MAX_MODEL`), applied HERE so this module's stated property — that nothing
 * unbounded reaches the status page — is true of this module rather than true
 * only because of what its callers happen to do. `model` arrives already
 * redacted+bounded, so this is a no-op for it; `host` did NOT, and its only
 * ceiling was ~255 held by a distant caller (`isSafeSegment`,
 * `src/results/share-reader.ts`) that this module neither calls nor can see.
 * A tripwire that depends on a bound enforced three modules away is one
 * refactor from being unbounded, so it owns the bound itself.
 */
import { traced } from "../log";

const MAX_PAIR_FIELD = 200;

/** One host's side of a conflict: which host attested which model. */
export interface HostConflictPair {
	/** The runner host that reported this model. Bounded on record (see below). */
	host: string;
	/** The model that host attested. Redacted by the caller; bounded on record. */
	model: string;
}

/** The bounded host-conflict tripwire carried on the status snapshot. */
export interface HostConflictStatus {
	/**
	 * Host conflicts observed SINCE THIS PROCESS STARTED. Zero is the normal
	 * steady state and is also what a fresh restart reports — see the module note.
	 */
	count: number;
	/** The attempt id of the most recent conflict, or null when count is 0. */
	lastAttemptId: string | null;
	/** ISO-8601 time the most recent conflict was recorded, or null. */
	lastAt: string | null;
	/**
	 * The two (host, model) pairs of the most recent conflict: the host whose
	 * attestation is STAMPED first, then the host that disagreed. Empty when no
	 * conflict has been recorded.
	 */
	lastPairs: HostConflictPair[];
}

/** What the emit site hands over when it records a conflict. */
export interface HostConflictRecord {
	attemptId: string;
	/** The host whose value is durably stamped, and that value. */
	stamped: HostConflictPair;
	/** The host that disagreed, and the value it attested. */
	observed: HostConflictPair;
}

/** Bound both fields of a pair at the boundary that stores them. */
function clipPair(pair: HostConflictPair): HostConflictPair {
	return {
		host: pair.host.slice(0, MAX_PAIR_FIELD),
		model: pair.model.slice(0, MAX_PAIR_FIELD),
	};
}

/** The empty tripwire: what a process that has seen no conflict reports. */
export const emptyHostConflictStatus = traced(
	"observability.emptyHostConflictStatus",
	function emptyHostConflictStatus(): HostConflictStatus {
		return { count: 0, lastAttemptId: null, lastAt: null, lastPairs: [] };
	},
);

/**
 * The process-local host-conflict tally.
 *
 * Only the LAST conflict's detail is retained. A list would grow without bound on
 * a watcher that is genuinely misconfigured, and the tripwire's job is to make the
 * operator look — the full history is in the logged warning events, which is where
 * an unbounded record belongs.
 */
export class HostConflictTally {
	private count = 0;
	private last: { attemptId: string; at: string; pairs: HostConflictPair[] } | null = null;
	private readonly now: () => Date;

	/** @param now - clock, injected so a test can assert an exact `lastAt`. */
	constructor(now: () => Date = () => new Date()) {
		this.now = now;
	}

	/**
	 * Record one conflict. Called from the observer's existing warn path, with the
	 * same values that go into the log line, so the counter and the log agree by
	 * construction.
	 */
	record(record: HostConflictRecord): void {
		this.count += 1;
		this.last = {
			attemptId: record.attemptId,
			at: this.now().toISOString(),
			pairs: [clipPair(record.stamped), clipPair(record.observed)],
		};
	}

	/** The current bounded status. Returns a fresh object; callers cannot mutate state. */
	status(): HostConflictStatus {
		if (this.last === null) {
			return emptyHostConflictStatus();
		}
		return {
			count: this.count,
			lastAttemptId: this.last.attemptId,
			lastAt: this.last.at,
			lastPairs: this.last.pairs.map((pair) => ({ host: pair.host, model: pair.model })),
		};
	}
}
