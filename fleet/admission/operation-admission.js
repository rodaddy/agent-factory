// The operation-admission decision. A paid model start for a task
// whose input has not changed buys nothing: the run reads the same input and
// ends the same way. This module is the one decision every caller asks before
// a start. It is keyed on the operation, never on the seat, so a wake, a
// manual run, a recovery and a resume all get the same answer. Pure: no I/O,
// no clock, no module state; the caller owns the store.
import { createHash } from "node:crypto";

/** How an attempt can end. An attempt that ended any of these ways is not retried on unchanged input. */
export const TERMINAL_OUTCOMES = [
	"succeeded",
	"failed",
	"guard_refused",
	"cancelled",
	"paused_409",
	"auth_401",
];

const MAX_ROUNDS = 5;
const filled = (v) => typeof v === "string" && v !== "";
// A request that does not say whether it is paid is refused, never treated as unpaid.
const isPaid = (request) => {
	if (typeof request.paid === "boolean") return request.paid;
	throw new TypeError("operation-admission: paid must be true or false");
};
const requireKeyed = (request) => {
	if (!isPaid(request) || (filled(request.key) && filled(request.fingerprint))) return;
	throw new TypeError("operation-admission: a paid request needs a key and a fingerprint");
};

function canonical(value) {
	if (Array.isArray(value)) return value.map(canonical);
	if (value !== null && typeof value === "object") {
		const out = Object.create(null);
		for (const k of Object.keys(value).sort()) out[k] = canonical(value[k]);
		return out;
	}
	return value;
}

/**
 * sha256 hex of the canonical JSON of `relevant` (object keys sorted at every depth).
 * Pass only verified inputs whose change means a new run could end differently.
 * Never pass: `updatedAt`, comment ids or counts, run ids, the wake reason,
 * labels, or model-authored text. Each of those changes without the input
 * changing, and any one of them turns this guard into a no-op.
 */
export function inputFingerprint(relevant) {
	return createHash("sha256")
		.update(JSON.stringify(canonical(relevant)))
		.digest("hex");
}

const result = (action, cause, announce, next) => ({ action, cause, announce, next });
const restart = (record, change) => ({
	...record,
	...change,
	state: "reserved",
	outcome: null,
	attempts: record.attempts + 1,
	holdAnnounced: false,
	unresolvedAnnouncedCauses: [],
	version: record.version + 1,
});
// Every hold after an ended attempt is announced once per record, then stays quiet.
const holdAnnouncedOnce = (record, cause) => {
	if (record.holdAnnounced) return result("hold", cause, false, record);
	return result("hold", cause, true, {
		...record,
		holdAnnounced: true,
		version: record.version + 1,
	});
};

// Unresolved causes are acknowledged separately from the later terminal hold.
// admit commits this change with its bounded CAS before returning announce=true.
const unresolvedAnnouncedOnce = (record, action, cause) => {
	const announced = record.unresolvedAnnouncedCauses ?? [];
	if (announced.includes(cause)) return result(action, cause, false, record);
	return result(action, cause, true, {
		...record,
		unresolvedAnnouncedCauses: [...announced, cause],
		version: record.version + 1,
	});
};

/**
 * Decides one request against the stored record (null when the key is new).
 * Returns { action, cause, announce, next }; `next` is the record to store and
 * is the same object as `record` when nothing changes. `request.source` and
 * any field other than key, fingerprint, paid and release never change the answer.
 * First match wins: a `paid` that is not a boolean throws; unpaid attaches; a
 * paid request without a key and a fingerprint throws; a new key starts;
 * uncertain reconciles; reserved holds; any other non-terminal state throws.
 * After an ended attempt, a fingerprint never started on before starts once,
 * unless the request is marked `firstAttemptOnly`, which holds with
 * `revision_missing`; one already in `spentFingerprints` starts only on a
 * verified release with an id not yet consumed. Else it holds.
 */
export function decide(record, request) {
	if (!isPaid(request)) return result("attach", "bookkeeping", false, record);
	requireKeyed(request);
	if (!record) {
		return result("start", "first_attempt", false, {
			key: request.key,
			fingerprint: request.fingerprint,
			state: "reserved",
			outcome: null,
			attempts: 1,
			holdAnnounced: false,
			consumedReleases: [],
			spentFingerprints: [request.fingerprint],
			version: 1,
		});
	}
	if (record.state === "uncertain")
		return unresolvedAnnouncedOnce(record, "reconcile", "upstream_uncertain");
	if (record.state === "reserved")
		return unresolvedAnnouncedOnce(record, "hold", "attempt_in_flight");
	if (record.state !== "terminal") throw new Error("operation-admission: unknown record state");
	if (!record.spentFingerprints.includes(request.fingerprint)) {
		if (request.firstAttemptOnly === true) return holdAnnouncedOnce(record, "revision_missing");
		return result(
			"start",
			"input_changed",
			false,
			restart(record, {
				fingerprint: request.fingerprint,
				spentFingerprints: [...record.spentFingerprints, request.fingerprint],
			}),
		);
	}
	const release = request.release;
	const counts = release ? release.verified === true && filled(release.id) : false;
	const consumed = counts && record.consumedReleases.includes(release.id);
	if (counts && !consumed) {
		return result(
			"start",
			"release_consumed",
			false,
			restart(record, {
				fingerprint: request.fingerprint,
				consumedReleases: [...record.consumedReleases, release.id],
			}),
		);
	}
	let cause = "input_already_attempted";
	if (release && !counts) cause = "release_unverified";
	else if (consumed) cause = "release_already_consumed";
	else if (request.fingerprint === record.fingerprint) cause = `unchanged_after_${record.outcome}`;
	return holdAnnouncedOnce(record, cause);
}

/**
 * The record after an attempt reports back. { outcome } with a member of
 * TERMINAL_OUTCOMES ends a reserved attempt; { uncertain: true } marks a
 * reserved attempt whose upstream state is unknown. Anything else throws.
 * An uncertain attempt stays uncertain until something that knows the
 * provider's real result settles it with { outcome, reconciled: true }; a
 * later cancellation or any other run status does not.
 * The caller must settle every reservation: `decide` has no clock and holds a
 * `reserved` record for as long as it is stored. A reservation whose attempt is
 * no longer live is settled { uncertain: true } when its outcome is unknown.
 */
export function settle(record, outcomeOrUncertain) {
	const state = record?.state;
	const outcome = outcomeOrUncertain?.outcome;
	const reconciled = state === "uncertain" && outcomeOrUncertain?.reconciled === true;
	if (TERMINAL_OUTCOMES.includes(outcome) && (state === "reserved" || reconciled)) {
		return { ...record, state: "terminal", outcome, version: record.version + 1 };
	}
	if (outcomeOrUncertain?.uncertain === true && outcome === undefined && state === "reserved") {
		return { ...record, state: "uncertain", outcome: null, version: record.version + 1 };
	}
	throw new Error(`settle: cannot settle a ${state ?? "missing"} record with this result`);
}

/**
 * The atomic reservation: read, decide, and store with compare-and-set so two
 * callers racing on one key cannot both start. A lost race re-reads and
 * re-decides; after 5 lost rounds it holds with cause `store_contention`.
 * store: read(key), compareAndSet(key, expectedVersion, next) -> boolean;
 * expectedVersion is 0 for an absent record. An unpaid request attaches
 * without touching the store.
 */
export async function admit(store, request) {
	if (!isPaid(request)) return decide(null, request);
	requireKeyed(request);
	let record = null;
	for (let round = 0; round < MAX_ROUNDS; round += 1) {
		record = (await store.read(request.key)) ?? null;
		const decided = decide(record, request);
		if (decided.next === record) return decided;
		if (await store.compareAndSet(request.key, record?.version ?? 0, decided.next)) return decided;
	}
	return result("hold", "store_contention", false, record);
}

/**
 * How a stored run ended, as `settle` takes it. A run whose provider may have finished without
 * the server knowing is uncertain. A cancelled run is uncertain too: the board stopped watching,
 * which does not prove the attempt ended (an ssh seat's provider session runs on). It is
 * terminal only when a caller with trusted evidence that it never started or that execution ended
 * settles it. It can never clear an uncertainty, because it never returns `reconciled`.
 */
export function classifyRunEnd({ status, errorCode } = {}) {
	if (status === "queued" || status === "running" || status === "scheduled_retry") {
		return { live: true };
	}
	if (status === "succeeded") return { outcome: "succeeded" };
	if (status === "interrupted" || status === "timed_out" || status === "cancelled") {
		return { uncertain: true };
	}
	if (status === "failed") {
		return errorCode === "process_lost" ? { uncertain: true } : { outcome: "failed" };
	}
	return { uncertain: true };
}

/**
 * The one visible record for a task that could not be mapped to an operation.
 * It always holds, and announces once per cause: on the first hold and again
 * when the cause changes. It never overwrites an admission record.
 */
export async function holdOnce(store, key, cause) {
	if (!filled(key) || !filled(cause)) {
		throw new TypeError("operation-admission: holdOnce needs a key and a cause");
	}
	let record = null;
	for (let round = 0; round < MAX_ROUNDS; round += 1) {
		record = (await store.read(key)) ?? null;
		if (record && (record.state !== "unmapped" || record.cause === cause)) {
			return result("hold", cause, false, record);
		}
		const next = record
			? { ...record, cause, version: record.version + 1 }
			: { key, state: "unmapped", cause, holdAnnounced: true, version: 1 };
		if (await store.compareAndSet(key, record?.version ?? 0, next)) {
			return result("hold", cause, true, next);
		}
	}
	return result("hold", "store_contention", false, record);
}

/** Match the server-written marker to this exact reservation and its own run. */
export function ownsAdmission(record, run) {
	const marker = run?.contextSnapshot?.admission;
	return (
		filled(run?.id) &&
		marker?.runId === run.id &&
		marker.key === record?.key &&
		marker.fingerprint === record.fingerprint &&
		marker.attempts === record.attempts &&
		Number.isSafeInteger(marker.attempts) &&
		marker.attempts > 0
	);
}

/**
 * Activation recovery for one key. Evidence is supplied by a trusted server reader,
 * never a cancellation request or model-authored result. Missing/ambiguous ownership
 * and continuation evidence hold. Each lost CAS re-reads the owner of the current
 * attempt; five losses stop the pass. Store/evidence failures propagate to the caller.
 */
export async function reconcileAdmission(store, key, readEvidence) {
	for (let round = 0; round < MAX_ROUNDS; round += 1) {
		const record = await store.read(key);
		if (!record || !["reserved", "uncertain"].includes(record.state)) return;
		const rows = await readEvidence(record);
		if (!Array.isArray(rows) || rows.length !== 1) return;
		const run = rows[0];
		if (!ownsAdmission(record, run) || run.continuation !== false) return;
		if (!["succeeded", "failed", "cancelled", "interrupted", "timed_out"].includes(run.status))
			return;
		const outcomes = {
			succeeded: "succeeded",
			failed: "failed",
			cancelled: "cancelled",
			interrupted: "failed",
			timed_out: "failed",
		};
		const outcome = run.upstream === "never_started" ? "guard_refused" : outcomes[run.status];
		const proved = run.upstream === "ended" || run.upstream === "never_started";
		if (!proved && record.state === "uncertain") return;
		const next = settle(record, proved ? { outcome, reconciled: true } : { uncertain: true });
		if (await store.compareAndSet(key, record.version, next)) return;
	}
}
