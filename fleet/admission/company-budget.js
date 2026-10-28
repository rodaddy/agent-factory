// Company-wide UTC-day stop. No per-seat allowance, fallback ceiling or automatic reset.
import { createHash } from "node:crypto";

const KEY = "company-daily-budget-stop";
const TOKEN_KEYS = ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens"];
const integer = (n) => Number.isSafeInteger(n) && n >= 0;
const SNAPSHOT = `SELECT
 (SELECT coalesce(jsonb_agg(jsonb_build_object('runId', c.heartbeat_run_id,
 'inputTokens', c.input_tokens, 'outputTokens', c.output_tokens,
 'cachedInputTokens', c.cached_input_tokens, 'costCents', c.cost_cents,
 'costStatus', c.cost_status, 'usage', r.usage_json)), '[]'::jsonb)
 FROM cost_events c LEFT JOIN heartbeat_runs r ON r.id=c.heartbeat_run_id AND r.company_id=c.company_id
 WHERE c.company_id=$1 AND ((r.finished_at >= $2 AND r.finished_at < $3)
 OR (r.finished_at IS NULL AND c.occurred_at >= $2 AND c.occurred_at < $3))) AS events,
 (SELECT coalesce(jsonb_agg(jsonb_build_object('id', id, 'usage', usage_json,
 'result', result_json, 'errorCode', error_code)), '[]'::jsonb)
 FROM heartbeat_runs WHERE company_id=$1 AND finished_at >= $2 AND finished_at < $3) AS runs`;
const STOP = `WITH claimed AS (
 INSERT INTO operation_admissions(company_id, operation_key, record, version)
 VALUES ($1,$2,$3::text::jsonb,1) ON CONFLICT(company_id,operation_key) DO NOTHING)
 INSERT INTO approvals(id,company_id,type,status,payload)
 VALUES ($4,$1,'request_board_approval','pending',$5::text::jsonb)
 ON CONFLICT(id) DO NOTHING`;

/** Parse the required server-owned JSON ceiling; malformed or absent never means disabled. */
export function readCompanyCeiling(raw) {
	try {
		const value = JSON.parse(raw);
		if (!["tokens", "accounted_cost_cents"].includes(value?.metric)) return null;
		if (!integer(value.amount) || value.amount === 0) return null;
		return { metric: value.metric, amount: value.amount };
	} catch {
		return null; // The caller treats invalid configuration as a crossed ceiling.
	}
}

function validateUsage(usage) {
	return usage?.usageStatus === "reported" && TOKEN_KEYS.every((key) => integer(usage[key]));
}

/** Completed usage is authoritative before its ledger insert; both use the run's UTC day. */
export function dailyCompanySpend(snapshot) {
	if (!Array.isArray(snapshot?.events) || !Array.isArray(snapshot?.runs))
		throw new Error("company_budget_usage_unreadable");
	const ledger = new Map();
	for (const row of snapshot.events) {
		const amounts = [row.inputTokens, row.outputTokens, row.cachedInputTokens, row.costCents];
		if (!row.runId || row.costStatus !== "reported" || !amounts.every(integer))
			throw new Error("company_budget_usage_incomplete");
		const prior = ledger.get(row.runId) ?? [0, 0, 0, 0];
		ledger.set(
			row.runId,
			amounts.map((n, i) => n + prior[i]),
		);
	}
	let tokens = 0;
	let cost = 0;
	for (const run of snapshot.runs) {
		if (run.result?.operationAdmission?.providerDispatched === false && !ledger.has(run.id))
			continue;
		const u = run.usage;
		if (
			!validateUsage(u) ||
			u.costStatus !== "reported" ||
			![
				"metered_api",
				"subscription_included",
				"subscription_overage",
				"credits",
				"fixed",
				"unknown",
			].includes(u.billingType)
		)
			throw new Error("company_budget_usage_incomplete");
		// Match resolveCacheAdjustedCostUsd and normalizeBilledCostCents in heartbeat.
		const price = [u.cacheAdjustedCostUsd, u.costUsd].find(
			(n) => typeof n === "number" && Number.isFinite(n) && n >= 0,
		);
		if (price === undefined && TOKEN_KEYS.some((key) => u[key] > 0))
			throw new Error("company_budget_price_incomplete");
		const cents =
			u.billingType === "subscription_included" || price === undefined
				? 0
				: Math.max(0, Math.round(price * 100));
		const expected = [u.inputTokens, u.outputTokens, u.cachedInputTokens, cents];
		if (ledger.has(run.id) && ledger.get(run.id).some((n, i) => n !== expected[i]))
			throw new Error("company_budget_ledger_conflict");
		ledger.delete(run.id);
		tokens += TOKEN_KEYS.reduce((sum, key) => sum + u[key], 0);
		cost += cents;
	}
	if (ledger.size || !integer(tokens) || !integer(cost))
		throw new Error("company_budget_usage_invalid");
	return { tokens, accounted_cost_cents: cost };
}

function approvalId(companyId) {
	const hex = createHash("sha256").update(`${companyId}:${KEY}`).digest("hex").slice(0, 32);
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
}

/**
 * Shared provider-start/run-end/timer guard. All I/O errors refuse starts. The persistent
 * stop is deliberately latched across midnight, restart and manual seat resume; this module
 * exposes no reset. Notifications use the existing approvals -> rico-notify -> imsg rail.
 */
export function createCompanyBudgetGuard({
	query,
	ceiling,
	cancelWork,
	warn,
	now = () => new Date(),
}) {
	const limit = readCompanyCeiling(ceiling);
	async function reason(companyId) {
		if (!limit) return "ceiling_unset_or_invalid";
		const stopped = await query(
			"SELECT record FROM operation_admissions WHERE company_id=$1 AND operation_key=$2",
			[companyId, KEY],
		);
		if (stopped.length) return "latched";
		// A stop whose latch write failed is still held by the company pause it applied.
		const [company] = await query("SELECT pause_reason FROM companies WHERE id=$1", [companyId]);
		if (company?.pause_reason === "company_daily_budget") return "latched";
		const start = new Date(`${now().toISOString().slice(0, 10)}T00:00:00.000Z`);
		const end = new Date(start.getTime() + 86_400_000);
		const [snapshot] = await query(SNAPSHOT, [companyId, start, end]);
		const spend = dailyCompanySpend(snapshot);
		return spend[limit.metric] >= limit.amount ? "ceiling_crossed" : null;
	}
	async function pause(companyId, excludedRunId) {
		const failures = [];
		const attempt = async (step, fn) => {
			try {
				await fn();
			} catch {
				failures.push(step);
				warn({ companyId, step }, "company budget stop action failed; starts remain held");
			}
		};
		await attempt("company_pause", async () => {
			const rows = await query(
				"UPDATE companies SET status='paused',pause_reason='company_daily_budget',paused_at=now(),updated_at=now() WHERE id=$1 RETURNING id",
				[companyId],
			);
			if (rows.length !== 1) throw new Error("company_not_paused");
		});
		await attempt("seat_enumeration", async () => {
			const seats = await query(
				"SELECT id FROM agents WHERE company_id=$1 AND status <> 'terminated'",
				[companyId],
			);
			for (const seat of seats)
				await attempt(`seat_pause:${seat.id}`, async () => {
					const rows = await query(
						"UPDATE agents SET status='paused',pause_reason='company_daily_budget',paused_at=now(),error_reason=null,updated_at=now() WHERE id=$1 AND company_id=$2 AND status <> 'terminated' RETURNING id",
						[seat.id, companyId],
					);
					if (rows.length !== 1) throw new Error("seat_not_paused");
				});
		});
		if (!excludedRunId) await attempt("cancel_work", () => cancelWork(companyId));
		return failures;
	}
	return async (companyId, excludedRunId) => {
		let cause;
		try {
			cause = await reason(companyId);
		} catch {
			cause = "spend_unreadable";
			warn({ companyId }, "company budget usage could not be read; starts remain held");
		}
		if (!cause) return { allowed: true, failures: [] };
		const failures = [];
		const id = approvalId(companyId);
		try {
			await query(STOP, [
				companyId,
				KEY,
				JSON.stringify({ key: KEY, version: 1, cause, stoppedAt: now().toISOString() }),
				id,
				JSON.stringify({
					source: "company_daily_budget",
					title: "Company daily budget STOP: starts held; verify all seats paused.",
					cause,
					ceiling: limit,
					guidance:
						"Ledger cost: included subscriptions count 0; recorded estimates are not invoices. Operator action is required; midnight does not resume seats.",
				}),
			]);
		} catch {
			failures.push("stop_persistence_or_notification");
			warn(
				{ companyId },
				"company budget stop/notification could not be persisted; starts remain held",
			);
			try {
				await query(
					"INSERT INTO approvals(id,company_id,type,status,payload) VALUES($1,$2,'request_board_approval','pending',$3::text::jsonb) ON CONFLICT(id) DO NOTHING",
					[
						id,
						companyId,
						JSON.stringify({
							source: "company_daily_budget",
							title:
								"Company daily budget STOP: stop persistence failed; starts held. Verify all seats paused.",
						}),
					],
				);
			} catch {
				warn({ companyId }, "company budget notification could not be queued");
			}
		}
		failures.push(...(await pause(companyId, excludedRunId)));
		warn({ companyId, cause, failures }, "company daily budget stop held");
		return { allowed: false, cause, failures, approvalId: id };
	};
}
