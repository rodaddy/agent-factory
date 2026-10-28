/** Isolated Postgres admission, leases, inference reservations and immutable results. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { checkServerIdentity } from "node:tls";
import postgres from "postgres";

export const TERMINAL = new Set(["succeeded", "failed", "uncertain"]);
export function validateDatabaseUrl(value) {
	const url = new URL(value);
	assert.ok(["postgres:", "postgresql:"].includes(url.protocol), "request_database_refused");
	assert.match(
		url.pathname,
		/^\/durable_pi_request_h(?:_test_[a-z0-9_]+)?$/,
		"request_database_refused",
	);
	return value;
}
export function normalizeHost(value) {
	const host =
		{ "durable-pi-pilot-01": "107", "durable-pi-pilot-02": "109", "durable-pi-pilot-03": "113" }[
			value
		] ?? String(value);
	assert.ok(["107", "109", "113"].includes(host), "request_host_refused");
	return host;
}
export function openRequestSql(url) {
	const target = new URL(validateDatabaseUrl(url));
	const mode = target.searchParams.get("sslmode");
	const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(target.hostname);
	assert.ok(mode === "verify-full" || (loopback && mode === null), "request_tls_required");
	return postgres(validateDatabaseUrl(url), {
		ssl:
			mode === "verify-full"
				? {
						rejectUnauthorized: true,
						checkServerIdentity: (_name, certificate) =>
							checkServerIdentity(target.hostname, certificate),
					}
				: false,
		max: 4,
		connect_timeout: 5,
		idle_timeout: 10,
		connection: { statement_timeout: 10000 },
		onnotice: () => {},
	});
}
function tranche(value) {
	assert.match(value, /^[A-Za-z0-9_-]{1,100}$/, "request_tranche_refused");
	return value;
}
function json(value, limit, reason) {
	const encoded = JSON.stringify(value);
	assert.ok(encoded && Buffer.byteLength(encoded) <= limit, reason);
	return JSON.parse(encoded);
}
function job(row) {
	if (!row) return null;
	return {
		id: row.id,
		trancheId: row.tranche_id,
		requestKey: row.request_key,
		packet: row.packet,
		packetHash: row.packet_hash,
		family: row.family,
		targetHost: row.target_host,
		status: row.status,
		claimToken: row.claim_token,
		claimEpoch: row.claim_epoch,
		workerId: row.worker_id,
		host: row.host,
		leaseExpiresAt: row.lease_expires_at,
		attemptId: row.attempt_id,
		result: row.result,
		resultHash: row.result_hash,
		error: row.error,
	};
}
/** Administrative setup is separate; opening a store never creates or resets state. */
export async function initializeStore(sql, { trancheId, maxRequests = 6 }) {
	tranche(trancheId);
	assert.ok(
		Number.isInteger(maxRequests) && maxRequests >= 1 && maxRequests <= 6,
		"request_limit_refused",
	);
	const [database] = await sql`SELECT current_database() AS name`;
	assert.match(
		database.name,
		/^durable_pi_request_h(?:_test_[a-z0-9_]+)?$/,
		"request_database_refused",
	);
	await sql.begin(async (tx) => {
		await tx.unsafe(readFileSync(new URL("./request-schema.sql", import.meta.url), "utf8"));
		await tx`INSERT INTO durable_pi_request.tranches(id,max_requests) VALUES (${trancheId},${maxRequests}) ON CONFLICT DO NOTHING`;
		const [existing] =
			await tx`SELECT max_requests FROM durable_pi_request.tranches WHERE id=${trancheId}`;
		assert.equal(existing.max_requests, maxRequests, "request_limit_conflict");
	});
}
export function createStore({ sql, trancheId }) {
	tranche(trancheId);
	const status = async (id) =>
		job(
			(
				await sql`SELECT * FROM durable_pi_request.jobs WHERE id=${id} AND tranche_id=${trancheId}`
			)[0],
		);
	return {
		status,
		async submit({ requestKey, packet, packetHash, family, targetHost = null }) {
			assert.match(requestKey, /^[A-Za-z0-9_.:-]{1,160}$/, "request_key_refused");
			assert.match(packetHash, /^[a-f0-9]{64}$/, "request_packet_hash_refused");
			assert.ok(["claude", "gpt"].includes(family), "request_family_refused");
			const payload = json(packet, 8192, "request_packet_limit");
			const host = targetHost === null ? null : normalizeHost(targetHost);
			return sql.begin(async (tx) => {
				const [budget] =
					await tx`SELECT * FROM durable_pi_request.tranches WHERE id=${trancheId} FOR UPDATE`;
				assert.ok(budget, "request_tranche_missing");
				const [existing] =
					await tx`SELECT *, packet=${tx.json(payload)}::jsonb AS same_packet FROM durable_pi_request.jobs WHERE tranche_id=${trancheId} AND request_key=${requestKey}`;
				if (existing) {
					assert.ok(
						existing.same_packet &&
							existing.packet_hash === packetHash &&
							existing.family === family &&
							existing.target_host === host,
						"request_replay_conflict",
					);
					return { job: job(existing), created: false };
				}
				assert.ok(budget.admissions < budget.max_requests, "request_admission_limit");
				const id = randomUUID();
				const [row] =
					await tx`INSERT INTO durable_pi_request.jobs(id,tranche_id,request_key,packet,packet_hash,family,target_host) VALUES (${id},${trancheId},${requestKey},${tx.json(payload)},${packetHash},${family},${host}) RETURNING *`;
				await tx`UPDATE durable_pi_request.tranches SET admissions=admissions+1 WHERE id=${trancheId}`;
				await tx`INSERT INTO durable_pi_request.outbox(id,job_id) VALUES (${randomUUID()},${id})`;
				return { job: job(row), created: true };
			});
		},
		async claim(id, workerId, givenHost, { leaseMs = 120000 } = {}) {
			const host = normalizeHost(givenHost);
			assert.match(workerId, /^[A-Za-z0-9_.:-]{1,160}$/, "request_worker_refused");
			assert.ok(
				Number.isInteger(leaseMs) && leaseMs > 0 && leaseMs <= 120000,
				"request_lease_refused",
			);
			const token = randomUUID();
			const [row] =
				await sql`UPDATE durable_pi_request.jobs j SET status='claimed',claim_token=${token},claim_epoch=claim_epoch+1,worker_id=${workerId},host=${host},lease_expires_at=clock_timestamp()+${leaseMs} * interval '1 millisecond' WHERE j.id=${id} AND j.tranche_id=${trancheId} AND j.status='queued' AND (j.target_host IS NULL OR j.target_host=${host}) AND NOT EXISTS (SELECT 1 FROM durable_pi_request.attempts a WHERE a.tranche_id=${trancheId} AND a.host=${host} AND a.family=j.family) RETURNING j.*`;
			return row ? { job: job(row), claimToken: token } : null;
		},
		async reserveAttempt(id, token) {
			return sql.begin(async (tx) => {
				const [budget] =
					await tx`SELECT * FROM durable_pi_request.tranches WHERE id=${trancheId} FOR UPDATE`;
				const [row] =
					await tx`SELECT * FROM durable_pi_request.jobs WHERE id=${id} AND tranche_id=${trancheId} AND claim_token=${token} AND status='claimed' AND lease_expires_at>clock_timestamp() FOR UPDATE`;
				if (!row) return null;
				assert.ok(budget.attempts < budget.max_requests, "request_attempt_limit");
				const used =
					await tx`SELECT id FROM durable_pi_request.attempts WHERE tranche_id=${trancheId} AND host=${row.host} AND family=${row.family}`;
				assert.equal(used.length, 0, "request_host_family_limit");
				const attemptId = randomUUID();
				await tx`INSERT INTO durable_pi_request.attempts(id,tranche_id,job_id,host,family,claim_token) VALUES (${attemptId},${trancheId},${id},${row.host},${row.family},${token})`;
				await tx`UPDATE durable_pi_request.tranches SET attempts=attempts+1 WHERE id=${trancheId}`;
				const [started] =
					await tx`UPDATE durable_pi_request.jobs SET status='started',attempt_id=${attemptId} WHERE id=${id} AND claim_token=${token} AND status='claimed' AND lease_expires_at>clock_timestamp() RETURNING *`;
				// A lease can expire between acquiring the lock and committing the reservation.
				// Throwing rolls back both the ledger insert and the tranche counter.
				assert.ok(started, "request_lease_expired");
				return { attemptId, job: job(started) };
			});
		},
		async complete(id, token, { result, resultHash }) {
			assert.match(resultHash, /^[a-f0-9]{64}$/, "request_result_hash_refused");
			const payload = json(result, 16384, "request_result_limit");
			const rows =
				await sql`UPDATE durable_pi_request.jobs SET status='succeeded',result=${sql.json(payload)},result_hash=${resultHash},completed_at=clock_timestamp() WHERE id=${id} AND tranche_id=${trancheId} AND claim_token=${token} AND status='started' AND lease_expires_at>clock_timestamp() RETURNING id`;
			return rows.length === 1;
		},
		async fail(id, token, { reason, uncertain = false }) {
			assert.ok(
				typeof reason === "string" && reason.length > 0 && reason.length <= 200,
				"request_error_refused",
			);
			const rows =
				await sql`UPDATE durable_pi_request.jobs SET status=${uncertain ? "uncertain" : "failed"},error=${reason},completed_at=clock_timestamp() WHERE id=${id} AND tranche_id=${trancheId} AND claim_token=${token} AND status IN ('claimed','started') AND lease_expires_at>clock_timestamp() RETURNING id`;
			return rows.length === 1;
		},
		async expire() {
			return sql.begin(async (tx) => {
				const uncertain =
					await tx`UPDATE durable_pi_request.jobs SET status='uncertain',error='lease_expired_after_reservation',completed_at=clock_timestamp(),claim_token=NULL WHERE tranche_id=${trancheId} AND status='started' AND lease_expires_at<=clock_timestamp() RETURNING id`;
				const queued =
					await tx`UPDATE durable_pi_request.jobs SET status='queued',claim_token=NULL,worker_id=NULL,host=NULL,lease_expires_at=NULL WHERE tranche_id=${trancheId} AND status='claimed' AND lease_expires_at<=clock_timestamp() RETURNING id`;
				for (const row of queued)
					await tx`INSERT INTO durable_pi_request.outbox(id,job_id) VALUES (${randomUUID()},${row.id})`;
				return { requeued: queued.map((row) => row.id), uncertain: uncertain.map((row) => row.id) };
			});
		},
		async pendingOutbox({ limit = 6 } = {}) {
			assert.ok(Number.isInteger(limit) && limit >= 1 && limit <= 100, "request_outbox_limit");
			return (
				await sql`SELECT o.id,o.job_id FROM durable_pi_request.outbox o JOIN durable_pi_request.jobs j ON j.id=o.job_id WHERE j.tranche_id=${trancheId} AND o.published_at IS NULL ORDER BY o.created_at,o.id LIMIT ${limit}`
			).map((row) => ({ id: row.id, jobId: row.job_id }));
		},
		async markPublished(id) {
			return (
				(
					await sql`UPDATE durable_pi_request.outbox o SET published_at=clock_timestamp() FROM durable_pi_request.jobs j WHERE o.id=${id} AND o.job_id=j.id AND j.tranche_id=${trancheId} AND o.published_at IS NULL RETURNING o.id`
				).length === 1
			);
		},
	};
}
