// The durable store behind the operation-admission decision: one row
// per company and operation key in `operation_admissions`, written only by
// compare-and-set on the row's version. It knows no driver; the caller supplies
// `query`. No error is caught here: a store failure must never look like an
// absent key, because an absent key means "start".

const SELECT =
	"SELECT record, version FROM operation_admissions WHERE company_id = $1 AND operation_key = $2";
const INSERT =
	"INSERT INTO operation_admissions (company_id, operation_key, record, version) VALUES ($1, $2, $3::text::jsonb, $4) ON CONFLICT (company_id, operation_key) DO NOTHING RETURNING version";
const UPDATE =
	"UPDATE operation_admissions SET record = $3::text::jsonb, version = $4, updated_at = now() WHERE company_id = $1 AND operation_key = $2 AND version = $5 RETURNING version";

/**
 * The store `admit` takes, over the `operation_admissions` table.
 * `query(text, params)` runs one statement with bound parameters and resolves
 * to an array of row objects; whatever it rejects with propagates unchanged.
 * `read` returns undefined for an absent key and throws on a row whose record
 * disagrees with its version column. `compareAndSet` is true only when this
 * caller's write landed: an insert for expectedVersion 0, else an update of the
 * row still at expectedVersion. A `next` that is not the following version of
 * `key` throws: that is a caller bug, never a lost race.
 */
export function createAdmissionStore({ query, companyId } = {}) {
	if (typeof companyId !== "string" || companyId === "") {
		throw new TypeError("operation-admission-store: companyId is required");
	}
	return {
		async read(key) {
			const [row] = await query(SELECT, [companyId, key]);
			if (!row) return undefined;
			if (row.record?.version !== row.version) {
				throw new Error(`operation-admission-store: corrupt row for ${key}`);
			}
			return { ...row.record, version: row.version };
		},
		async compareAndSet(key, expectedVersion, next) {
			if (next?.key !== key || next.version !== expectedVersion + 1) {
				throw new Error(
					`operation-admission-store: next is not version ${expectedVersion + 1} of ${key}`,
				);
			}
			const values = [companyId, key, JSON.stringify(next), next.version];
			const written =
				expectedVersion === 0
					? await query(INSERT, values)
					: await query(UPDATE, [...values, expectedVersion]);
			return written.length === 1;
		},
	};
}

/**
 * Bounded owner lookup for activation recovery. Only the server-authored snapshot
 * of the exact run can own the attempt. Two matches are ambiguity, never a choice.
 * Native coordination must be committed: a failed row alone may resume its session.
 * `executionStopped` reuses host-bound server receipts; absence of PIDs is no proof.
 */
export function createAdmissionEvidenceReader({ query, companyId, executionStopped, isTracked }) {
	return async (record) => {
		const rows = await query(
			`SELECT r.id, r.status, r.runtime_mode AS "runtimeMode",
            r.context_snapshot AS "contextSnapshot", r.error_code AS "errorCode",
            r.result_json AS "resultJson", n.phase AS "coordinatorPhase"
            FROM heartbeat_runs r LEFT JOIN native_run_finalizations n
              ON n.run_id = r.id AND n.company_id = r.company_id
            WHERE r.company_id = $1 AND r.context_snapshot->'admission'->>'key' = $2
              AND r.context_snapshot->'admission'->>'fingerprint' = $3
              AND r.context_snapshot->'admission'->>'attempts' = $4
              AND r.context_snapshot->'admission'->>'runId' = r.id::text LIMIT 2`,
			[companyId, record.key, record.fingerprint, String(record.attempts)],
		);
		if (rows.length !== 1) return rows;
		const run = rows[0];
		const continuation =
			isTracked(run.id) ||
			["queued", "running", "scheduled_retry"].includes(run.status) ||
			(run.runtimeMode === "native" && run.coordinatorPhase !== "committed");
		if (continuation) return [{ ...run, continuation: true }];
		// Written only by the reserving pass when its dispatch gate refuses.
		// A hold's providerDispatched:false describes one pass, not an attempt.
		const refusal = run.contextSnapshot?.admissionNoStart;
		const neverStarted =
			refusal?.runId === run.id &&
			refusal.key === record.key &&
			refusal.fingerprint === record.fingerprint &&
			refusal.attempts === record.attempts;
		const stopped = !neverStarted && (await executionStopped(run));
		return [
			{
				...run,
				continuation: false,
				upstream: neverStarted ? "never_started" : stopped ? "ended" : "unknown",
			},
		];
	};
}
