/**
 * @module runner/run-timeout
 * @description What a `runner_run` TIMEOUT means, and what may be done about it.
 *
 *   A TIMEOUT IS NOT A FAILED VERB. Live 2026-09-02: `runner_run` timed out
 *   client-side after 90 s while the verb completed server-side; the catch path
 *   in `claimAndSubmit` reaped the box, released the job, and
 *   `releaseAbandonedTake` handed vmid 9001 back to the pass because that reap
 *   "proved" the box gone — so job 11192 was dispatched onto the recycled 9001
 *   in the same pass while 11190's body may still have been running there.
 *
 *   Only `runner_list` can say what a box is doing, so the timeout arm LOOKS
 *   once, read-only, and never calls `done`. This is the same rule the reap
 *   paths already encode (`retakeIfProvenGone`): an ambiguous
 *   destructive verb is resolved by LOOKING, never by retrying it.
 *
 *   Every NON-timeout `runner_run` error keeps the pre-existing reap-and-release
 *   path byte-for-byte. This module widens nothing else.
 *
 * @outputs
 *   - `isRunTimeout` -- is this error a client-side submission timeout?
 *   - `settleRunTimeout` -- ONE read-only `list()` verdict for a timed-out box
 *   - `settleFailedSubmission` -- the WHOLE `runner_run` catch: timeout arm plus
 *     the unchanged reap-and-release arm every other error keeps
 *   - `RunTimeoutVerdict` -- the four answers `list()` can give
 *   - `RunTimeoutSettlement` -- the verdict plus the foreign owner's job id
 *
 * @dependencies
 *   - ../log -- the named warn a failed probe emits
 *   - ./dispatch, ./pass-vmids -- the shared outcome/reap vocabulary
 *   - ./transport -- the read-only `list()` verb
 */
import { eq } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { releaseRunnerBox } from "../db/repos";
import { jobAttempts } from "../db/schema";
import { errorMessage, log, traced } from "../log";
import {
	addMinutes,
	bound,
	type DispatchableJob,
	type DispatchOutcome,
	type ReapOutcome,
	releaseJob,
} from "./dispatch";
import { type ReapSignals, reapReporting } from "./pass-vmids";
import type { RunnerTransport } from "./transport";

/**
 * The four things a read-only `list()` can say about a timed-out submission.
 *
 * `landed` and `unknown` are deliberately the SAME action (hold the box for this
 * attempt) and separate verdicts, because they are different facts and the log
 * line has to name which one held the dispatch.
 */
export type RunTimeoutVerdict = "landed" | "gone" | "foreign" | "unknown";

/**
 * A verdict, plus the one fact the string cannot carry: WHICH job the fleet says
 * now owns the box. Named in the failure summary so an operator can diagnose the
 * hand-off without a second read (sf#454 — a bare "The operation timed out."
 * burned a whole diagnosis session).
 */
export interface RunTimeoutSettlement {
	verdict: RunTimeoutVerdict;
	/** The fleet's stamped owner, present only on `foreign`. */
	foreignOwnerJobId?: string;
}

/**
 * Is `err` a client-side submission timeout rather than a verb that ran and
 * failed?
 *
 * Classified by the TRANSPORTS' OWN timeout shapes, never by free-form text.
 * Two shapes mean the verb's outcome is UNKNOWN: the HTTP
 * transport's `AbortSignal.timeout` rejection (the platform `TimeoutError`) and
 * the CLI transport's own invoke timer ("runner-boxes runner_run timed out after
 * Nms"). Everything else keeps the unchanged reap-and-release path: a verb that
 * genuinely RAN and failed (`runner_run failed (exit N) -- ...`, timeout wording
 * included), AND the CLI client-to-daemon hop fault (`CONNECTION_ERROR`), whose
 * reap-then-hold semantics sf#299/sf#418 already pin in
 * `tests/runner/pass-vmids.test.ts`. Widening this to the daemon hop would
 * change a proven path this slice does not own.
 */
export const isRunTimeout = traced(
	"runner.isRunTimeout",
	function isRunTimeout(err: unknown): boolean {
		if (!(err instanceof Error)) {
			return false;
		}
		return (
			err.name === "TimeoutError" ||
			/^runner-boxes runner_run timed out after \d+ms$/.test(err.message)
		);
	},
);

/**
 * Ask ONCE, read-only, what the box is actually doing after a `runner_run`
 * timed out client-side.
 *
 * Never calls `done`: the whole point is that the verb probably SUCCEEDED
 * server-side, so powering the box off would kill the job's own live work.
 *
 * `list()` THROWS on a read failure rather than returning `[]`, and the two are
 * not interchangeable — `[]` is a real "no boxes" answer that proves the box
 * gone, while a throw proves nothing. That is exactly the `gone` / `unknown`
 * split below. An unattributed row (`jobId === null`) may be this submission's
 * own box mid-stamp, so it holds exactly as a failed probe does.
 */
export const settleRunTimeout = traced(
	"runner.settleRunTimeout",
	async function settleRunTimeout(args: {
		transport: RunnerTransport;
		vmid: number;
		runnerJobId: string;
	}): Promise<RunTimeoutSettlement> {
		const { transport, vmid, runnerJobId } = args;
		try {
			const boxes = await transport.list();
			const row = boxes.find((listed) => listed.vmid === vmid);
			if (row === undefined) {
				return { verdict: "gone" };
			}
			if (row.jobId === runnerJobId) {
				return { verdict: "landed" };
			}
			if (row.jobId === null) {
				return { verdict: "unknown" };
			}
			return { verdict: "foreign", foreignOwnerJobId: row.jobId };
		} catch (probeErr) {
			log("warn", "dispatch.run_timeout_probe_failed", {
				vmid,
				runner_job_id: runnerJobId,
				cause: errorMessage(probeErr),
			});
			return { verdict: "unknown" };
		}
	},
);

/**
 * Act on a `runner_run` that timed out client-side: LOOK once, then do the one
 * thing that verdict permits.
 *
 * Lives here rather than in `dispatch.ts` for the reason `pass-vmids.ts` and
 * `attempt-record.ts` do — this module owns the sf#564 rule end to end, and
 * `dispatch.ts` is at its size ceiling.
 *
 * NOTHING HERE CALLS `done`. Both terminal verdicts have already been settled by
 * the read-only `list()` above: `gone` means the box is proven absent so there is
 * nothing to power off, and `foreign` means another job owns it so powering it
 * off would kill live work. That is the whole difference between this and the
 * reap-and-release path the non-timeout errors keep. The DB claim release is
 * scoped to THIS dispatch's runner job id for the same reason a reap is — the
 * fleet may have recycled the box and a later attempt may already hold the row —
 * and it never throws, because a release failure must not mask the job's real
 * outcome.
 *
 * `landed` / `unknown` HOLD: the box stays claimed by this attempt, so no reap,
 * no failed attempt row, and no job release. Returning `null` sends the caller
 * on to `markJobRunning`, exactly as a normal submission — the result path or
 * the reclaim ceiling settles it later, and the pass ledger keeps the vmid taken
 * so no sibling can get it this pass.
 *
 * `gone` reports `reap: "reaped"`, which here means "PROVEN GONE by `list()`" —
 * precisely what `releaseAbandonedTake` requires before it hands the vmid back,
 * because the number the gateway re-reports then names a FRESH box.
 * `foreign` reports `skipped-identity-mismatch` so the pass HOLDS the vmid: that
 * box has a rightful owner mid-flight.
 */
async function actOnRunTimeout(args: {
	db: WatcherDb;
	transport: RunnerTransport;
	job: DispatchableJob;
	attempt: { id: number };
	vmid: number;
	runnerJobId: string;
	/** The runner job id the pool claim positively recorded, if any. */
	claimedBy?: string;
	reason: string;
	elapsedMs: number;
	retryMinutes: number;
	now: Date;
}): Promise<{ outcome: DispatchOutcome; reap: ReapOutcome; reapSignals: ReapSignals } | null> {
	const { db, transport, job, attempt, vmid, runnerJobId, elapsedMs, retryMinutes, now } = args;
	const { verdict, foreignOwnerJobId } = await settleRunTimeout({ transport, vmid, runnerJobId });
	if (verdict === "landed" || verdict === "unknown") {
		log("info", "dispatch.run_timeout_held", {
			vmid,
			runner_job_id: runnerJobId,
			job_id: job.id,
			verdict,
			elapsed_ms: elapsedMs,
		});
		return null;
	}
	const reason =
		verdict === "foreign"
			? `${args.reason} (box now reports job ${foreignOwnerJobId})`
			: args.reason;
	await db
		.update(jobAttempts)
		.set({ status: "failed", failureSummary: bound(reason), finishedAt: now })
		.where(eq(jobAttempts.id, attempt.id));
	if (args.claimedBy !== undefined) {
		try {
			await releaseRunnerBox(db, vmid, args.claimedBy);
		} catch (releaseErr) {
			log("warn", "runner.claim_release_failed", { vmid, cause: errorMessage(releaseErr) });
		}
	}
	await releaseJob(db, job.id, addMinutes(now, retryMinutes), {
		now,
		expectedActiveAttemptId: attempt.id,
	});
	return {
		outcome: { status: "error", reason, vmid },
		reap: verdict === "gone" ? "reaped" : "skipped-identity-mismatch",
		reapSignals: {},
	};
}

/**
 * The WHOLE `runner_run` catch: pick the arm the error class earns, and do it.
 *
 * Lifted out of `claimAndSubmit` because `dispatch.ts` is at its size
 * ceiling and this module already owns the timeout rule end to end — the same
 * boundary move `pass-vmids.ts` and `attempt-record.ts` made.
 *
 * A TIMEOUT goes to {@link actOnRunTimeout}, which LOOKS before it acts. Every
 * other error — a verb that genuinely ran and failed — keeps the pre-existing
 * reap-and-release path BYTE-FOR-BYTE, including its scoping:
 *
 * The submission may have started server-side (e.g. a >60s CONNECTION_ERROR
 * while work continues), so the box is best-effort reaped before the job is
 * released. The recorded attempt preserves the vmid regardless. The backoff stops
 * a wedged runner causing an allocate/fail/reap churn. The reap is scoped to THIS
 * dispatch's runner job id: the failure may have taken long enough for the fleet
 * to recycle the box and a later attempt to claim it, and reaping that one would
 * kill a live job. The release is scoped to THIS attempt's ownership, so a
 * reclaimer that re-pended the job and a newer attempt that took it over are left
 * untouched.
 */
export const settleFailedSubmission = traced(
	"runner.settleFailedSubmission",
	async function settleFailedSubmission(args: {
		db: WatcherDb;
		transport: RunnerTransport;
		job: DispatchableJob;
		attempt: { id: number };
		vmid: number;
		runnerJobId: string;
		/** The runner job id the pool claim positively recorded, if any. */
		claimedBy?: string;
		err: unknown;
		elapsedMs: number;
		retryMinutes: number;
		now: Date;
	}): Promise<{ outcome: DispatchOutcome; reap: ReapOutcome; reapSignals: ReapSignals } | null> {
		const { db, transport, job, attempt, vmid, err, elapsedMs, retryMinutes, now } = args;
		const message = err instanceof Error ? err.message : "submission error";
		const reason = `runner_run failed after ${elapsedMs} ms: ${message}`;
		if (isRunTimeout(err)) {
			return await actOnRunTimeout({ ...args, reason });
		}
		await db
			.update(jobAttempts)
			.set({ status: "failed", failureSummary: bound(reason), finishedAt: now })
			.where(eq(jobAttempts.id, attempt.id));
		const { reap, reapSignals } = await reapReporting(db, transport, vmid, args.claimedBy);
		await releaseJob(db, job.id, addMinutes(now, retryMinutes), {
			now,
			expectedActiveAttemptId: attempt.id,
		});
		return { outcome: { status: "error", reason, vmid }, reap, reapSignals };
	},
);
