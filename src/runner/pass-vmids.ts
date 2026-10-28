/**
 * @module runner/pass-vmids
 * @description The vmids one reconcile pass has already handed to a dispatch.
 *
 *   THE DEFECT THIS CLOSES (live 2026-08-16). The gateway's `needed()`
 *   REPORTS a warm box without reserving it, so two dispatches in the SAME pass
 *   can each be told to use the same vmid. On the first `deploy:hello`
 *   citizenship run the `newapp` verb job and a concurrent
 *   `infra-static` job both received VMID 9001; the verb's `run()` hit 9001 while
 *   the infra-static job was mid-claim and got a terminal
 *   `runner_run failed (exit 1)` within ~5s (job_attempts 7721). The durable row
 *   rescheduled correctly, so the run self-healed — but a whole dispatch attempt
 *   was spent on a collision the watcher caused itself.
 *
 *   `claimBox`/`claimRunnerBox` does NOT close this. That claim is a watcher-DB
 *   bookkeeping record written AFTER the allocation, and it is explicitly "not a
 *   lock" (see `dispatch.ts`): a failure to record it must never fail the
 *   dispatch, or a successfully allocated box would strand. So it cannot be the
 *   thing that decides a second job may not use a vmid.
 *
 *   THIS IS A MITIGATION, NOT THE FIX. The authoritative fix is a gateway-side
 *   `needed()`-time lease with a TTL and a job id. All this
 *   does is stop the watcher from being the one that races ITSELF: it cannot see,
 *   and does not try to see, an allocation made by another process or an earlier
 *   pass.
 *
 *   SCOPE IS ONE PASS, DELIBERATELY. A cross-pass ledger would have to answer
 *   when a vmid becomes free again, and the watcher does not own that fact — the
 *   fleet does, and `runner_boxes` already records it durably. A per-pass set
 *   needs no expiry, no reconciliation, and no persistence: it is created by the
 *   pass, discarded with it, and can never strand a box by outliving the truth.
 *
 *   A REFUSAL MUST NEVER REAP. The colliding box is the SIBLING dispatch's box —
 *   powering it off would kill live work, which is the same reasoning `reap`'s
 *   `skipped-unproven-ownership` arm already encodes. The refusing job is
 *   released to `pending` with a bounded backoff instead.
 *
 *   AN ABANDONED TAKE IS GIVEN BACK ONLY WHEN ITS REAP PROVED THE BOX GONE,
 *   which is why `releaseAbandonedTake` exists. This reverses the
 *   original never-release rule, and the reversal was paid for live on
 *   2026-08-26: in every pass the first job took 9001, its box was ALREADY DEAD
 *   box-side ("vmid 9001 not found on any reachable node" after 10 attempts,
 *   sf#397), and `dispatchJob`'s abandon path reaped and released the job while
 *   the ledger kept holding 9001. The gateway then placed a FRESH box that
 *   RECYCLED vmid 9001, and every one of the pass's remaining jobs was refused
 *   "vmid already dispatched this pass" — 28 refusals and 0 dispatches per pass,
 *   104 in three hours. The original reasoning ("holding it costs at most one
 *   deferred job") was wrong about the cost of holding a PROVEN-GONE vmid: a
 *   recycled vmid costs the WHOLE PASS, every pass, indefinitely.
 *
 *   ONLY THE POST-TAKE ABANDON PATHS EVEN ASK. `dispatchJob` calls
 *   `releaseAbandonedTake` after its existing reap and job-release have run, on
 *   exactly two arms: the attempt-record failure and the submission failure. A
 *   box on those arms is one this dispatch has given up and reaped best-effort —
 *   whether it is GONE is what the reap outcome answers, and the gate below is
 *   what reads that answer. The SIBLING refusal in `acquireRunnerBox` never
 *   reaches here at all and still never reaps: that box has a rightful owner
 *   mid-flight.
 *
 *   THE RELEASE IS GATED ON THE REAP OUTCOME, AND THE GATE IS WHERE THE SAFETY
 *   LIVES. `reap` has four outcomes and only `reaped` proves the box is gone;
 *   `reap-failed`, `skipped-unproven-ownership`, and `skipped-identity-mismatch`
 *   each leave a box that may be LIVE, and handing that vmid back puts a second
 *   dispatch onto it. So only `reaped` releases.
 *
 *   The earlier reasoning for an ungated release — "the gateway only re-reports
 *   boxes it considers free" — was FALSE, and this module's own root cause says
 *   so twelve lines up: `needed()` REPORTS a warm box without reserving it, which
 *   is the entire defect sf#299 mitigates. The gateway's report is not a proof of
 *   freedom, so it cannot be the thing that makes an ungated hand-back safe.
 *
 *   THE AVAILABILITY ARGUMENT IS WHAT JUSTIFIES RELEASING AT ALL. A held vmid
 *   refuses every remaining job in the pass (28 per pass, 104 in three hours on
 *   2026-08-26). Gating the release on a PROVEN reap trades that certain
 *   pass-wide outage for nothing, because a box proven gone cannot be
 *   double-dispatched — the vmid the gateway re-reports names a different, fresh
 *   box. The three non-proving outcomes HOLD, and the cost of holding is at worst
 *   one deferred job on a later pass, which is the ordinary bounded-backoff path.
 *
 * @outputs
 *   - `PassVmids` -- the per-pass vmid ledger contract
 *   - `createPassVmids` -- a fresh ledger for one pass
 *   - `refuseVmidCollision` -- what a losing dispatch does about a collision
 *   - `releaseAbandonedTake` -- the reap-gated hand-back of an abandoned take
 *
 * @dependencies
 *   - ../db/client -- the watcher db the release writes to
 *   - ../log -- the named warn a collision emits
 *   - ./dispatch -- the shared release + backoff shapes and the outcome vocabulary
 */
import type { WatcherDb } from "../db/client";
import { errorMessage, log, traced } from "../log";
import { retireAllocationIntent } from "./attempt-record";
import {
	addMinutes,
	type DispatchableJob,
	type DispatchOutcome,
	type ReapOutcome,
	reapInner,
	releaseJob,
} from "./dispatch";
import type { RunnerTransport } from "./transport";

/**
 * Ask ONCE, read-only, whether a held-unproven vmid is actually gone.
 *
 * HELD-UNPROVEN IS NOT HELD-BY-A-SIBLING. An abandon path whose reap TIMED OUT
 * and whose sf#402 re-probe still saw the box holds the vmid — correctly, at that
 * instant, because a destroy in flight is indistinguishable from a survivor. But
 * the gateway then re-reports that same vmid to every later candidate in the
 * pass, and refusing them all without ever re-asking is how one in-flight reap
 * poisoned a whole pass: 88 refusals, 0 dispatched.
 *
 * Absent from `list()` means the destroy finished and the vmid the gateway is
 * offering names a FRESH box, which cannot be double-dispatched. Present, or a
 * probe that throws, keeps the hold exactly as before. Nothing here calls `done`:
 * an ambiguous destructive verb is resolved by LOOKING, never by retrying it.
 *
 * Returns true only when the hold was cleared AND this dispatch retook the vmid.
 */
export const retakeIfProvenGone = traced(
	"runner.retakeIfProvenGone",
	async function retakeIfProvenGone(
		passVmids: PassVmids,
		transport: RunnerTransport,
		vmid: number,
	): Promise<boolean> {
		if (!passVmids.isHeldUnproven(vmid)) {
			return false;
		}
		let gone = false;
		try {
			const boxes = await transport.list();
			gone = !boxes.some((listed) => listed.vmid === vmid);
		} catch (probeErr) {
			// The probe has no opinion, so the hold stands.
			log("warn", "dispatch.vmid_hold_reprobe_failed", { vmid, cause: errorMessage(probeErr) });
			return false;
		}
		if (!gone) {
			return false;
		}
		log("info", "dispatch.vmid_hold_cleared_by_reprobe", { vmid });
		passVmids.release(vmid);
		return passVmids.take(vmid);
	},
);

/**
 * The vmids a single reconcile pass has already handed to a dispatch.
 *
 * An interface rather than a bare `Set<number>` so the intent reads at every call
 * site (`take` is a claim, not an insert) and so a future gateway-backed lease
 * can satisfy the same shape without touching the callers.
 */
export interface PassVmids {
	/**
	 * Claim `vmid` for this pass. Returns TRUE when the claim was taken (the vmid
	 * was free this pass) and FALSE when another dispatch in this same pass already
	 * holds it.
	 *
	 * The take-and-report is one operation on purpose: a separate `has` + `add`
	 * reads as two decisions and invites a caller to check, act, and forget to
	 * record — which is exactly the shape of the defect being closed.
	 */
	take(vmid: number): boolean;
	/**
	 * Forget a vmid this pass took, so a later dispatch in the same pass may take
	 * it again. Idempotent: releasing a vmid this pass never took is a
	 * no-op, so an abandon path may call it without first proving it holds the
	 * take.
	 *
	 * NOT CALLED DIRECTLY FROM AN ABANDON PATH. `releaseAbandonedTake` is the only
	 * caller a dispatch uses, because the decision to give a vmid back belongs to
	 * the reap outcome and this method cannot see one. It is not the inverse of
	 * `take` for general use — a sibling collision refusal must never release,
	 * because that box is another dispatch's live work.
	 */
	release(vmid: number): void;
	/**
	 * Record that this pass holds `vmid` only because an abandon path's reap could
	 * NOT be proven — a `reap-failed` timeout whose re-probe still saw the
	 * box, with the destroy very likely still in flight. It is the ledger's memory
	 * of WHY the number is held, and it is what earns the collision gate ONE
	 * read-only re-probe later in the same pass.
	 *
	 * A vmid held by a LIVE SIBLING dispatch is never marked: that box has a
	 * rightful owner mid-flight, and no probe result may hand it to a second job.
	 */
	markHeldUnproven(vmid: number): void;
	/**
	 * Is `vmid` held ONLY by an unproven-reap hold? False for a free vmid and false
	 * for one a live sibling holds, so the collision gate can never widen past the
	 * sf#418 case.
	 */
	isHeldUnproven(vmid: number): boolean;
}

/**
 * A fresh ledger for one pass. Nothing is shared between calls, so a caller that
 * forgets to thread one through simply gets the pre-sf#299 behaviour for its own
 * dispatch rather than silently inheriting another pass's state.
 */
export const createPassVmids = traced(
	"runner.createPassVmids",
	function createPassVmids(): PassVmids {
		const taken = new Set<number>();
		const heldUnproven = new Set<number>();
		return {
			take(vmid: number): boolean {
				if (taken.has(vmid)) {
					return false;
				}
				taken.add(vmid);
				// A retaken vmid is held by THIS dispatch again, so any earlier
				// unproven-hold marking is spent and must not survive into a later gate.
				heldUnproven.delete(vmid);
				return true;
			},
			release(vmid: number): void {
				taken.delete(vmid);
				heldUnproven.delete(vmid);
			},
			markHeldUnproven(vmid: number): void {
				heldUnproven.add(vmid);
			},
			isHeldUnproven(vmid: number): boolean {
				return heldUnproven.has(vmid);
			},
		};
	},
);

/**
 * Give an abandoned take back to the pass ledger — but ONLY when the abandon
 * path's own reap PROVED the box is gone.
 *
 * THE RULE: `reap === "reaped"` releases; every other outcome HOLDS the vmid for
 * the rest of the pass and logs one `dispatch.vmid_held_after_abandon`.
 * `reap-failed` means `transport.done` threw and the box may still be running
 * this dispatch's work; `skipped-unproven-ownership` and
 * `skipped-identity-mismatch` mean the reap DELIBERATELY left the box running
 * because another job owns it. In all three the vmid may name a LIVE box, and
 * handing it back is how a second dispatch lands on top of live work.
 *
 * Why releasing at all is still right: a held vmid refuses every remaining job in
 * the pass (28 per pass, 104 in three hours on 2026-08-26). Gating on a
 * proven reap trades that certain pass-wide outage for nothing — a box proven
 * gone cannot be double-dispatched, so the vmid the gateway re-reports names a
 * different, fresh box. Holding on the three non-proving outcomes costs at worst
 * one deferred job, taken through the ordinary bounded backoff.
 *
 * `passVmids` is optional so the callers that never thread a ledger (prepush,
 * compat, doctor, and every pre-sf#299 test) call this unconditionally and get a
 * no-op, exactly as they did with `passVmids?.release(...)`.
 */
export const releaseAbandonedTake = traced(
	"runner.releaseAbandonedTake",
	function releaseAbandonedTake(
		passVmids: PassVmids | undefined,
		vmid: number,
		reap: ReapOutcome,
		signals?: ReapSignals,
	): void {
		if (passVmids === undefined) {
			return;
		}
		if (reap === "reaped") {
			passVmids.release(vmid);
			return;
		}
		// WHY it is held is remembered, not just THAT it is, and only the ONE
		// ambiguous reason earns the memory: `reap.timedOutStillPresent` — the
		// destructive verb TIMED OUT and the sf#402 re-probe still saw the box, which on
		// the watcher host meant a destroy in flight rather than a survivor. An ORDINARY
		// `reap-failed` (a transport fault) is not marked: it carries no
		// "probably completed" ambiguity, so re-probing it would be the timeout arm
		// widening to catch plain failures. Neither `skipped-*` outcome is marked
		// either — there the box was deliberately left running for its rightful owner,
		// and no probe answer may hand that number to a second job.
		if (reap === "reap-failed" && signals?.timedOutStillPresent === true) {
			passVmids.markHeldUnproven(vmid);
		}
		log("warn", "dispatch.vmid_held_after_abandon", {
			vmid,
			reap,
			hint: "the abandon path's reap did not prove the box is gone, so the vmid is held for the rest of this pass rather than handed to a job that could land on live work (sf#395)",
		});
	},
);

/**
 * Refuse a dispatch because a SIBLING dispatch in this same pass already holds the
 * vmid `needed()` just re-reported.
 *
 * DELIBERATELY DOES NOT REAP, which is why this is not routed through
 * `acquireRunnerBox`'s own `requeue`. The box belongs to whoever took it first, and
 * powering it off would kill live work — the same rule `reap`'s
 * `skipped-unproven-ownership` arm already encodes. It writes no attempt row
 * either: `recordRefusedPlacement` exists to name a box an operator may have to
 * reap, and this box has a rightful owner who will reap it.
 *
 * The outcome is `queued`, not `error`: the job is released to `pending` with the
 * ordinary bounded backoff and tries again on a later pass, exactly like a
 * capacity refusal. Nothing about this is a job fault, and counting it as an error
 * would put a watcher-side scheduling decision in the column operators read as
 * "something broke".
 *
 * It lives HERE rather than in `dispatch.ts` for the reason `attempt-record.ts`
 * does: this module owns the sf#299 mitigation end to end — the ledger AND what a
 * loser does about it — and `dispatch.ts` was at its 500-line ceiling. Same
 * boundary shape, same back-import of the shared release/backoff helpers.
 */
export const refuseVmidCollision = traced(
	"runner.refuseVmidCollision",
	async function refuseVmidCollision(args: {
		db: WatcherDb;
		job: DispatchableJob;
		runnerJobId: string;
		vmid: number;
		retryMinutes: number;
		now: Date;
	}): Promise<{ status: "refused"; outcome: DispatchOutcome }> {
		const { db, job, runnerJobId, vmid, retryMinutes, now } = args;
		const reason = "vmid already dispatched this pass";
		log("warn", "dispatch.vmid_collision", {
			reason,
			vmid,
			job_id: job.id,
			runner_job_id: runnerJobId,
			hint: "gateway needed() re-reported a warm box a sibling dispatch already holds; deferring rather than racing it (sf#299)",
		});
		await releaseJob(db, job.id, addMinutes(now, retryMinutes), { now });
		return {
			status: "refused",
			// The box exists, but it is the SIBLING's placement, already counted against
			// the pass; this dispatch placed nothing.
			outcome: { status: "queued", retryAfterMinutes: retryMinutes, reason, provenNoBox: true },
		};
	},
);

/**
 * Facts a reap learned that its single-string outcome cannot carry.
 *
 * `timedOutStillPresent` marks the ONE ambiguous hold: `transport.done` timed out
 * AND the sf#402 re-probe still saw the box. The outcome is `reap-failed` either
 * way — this only tells the pass ledger that the hold rests on an unfinished
 * destroy, so a later collision gate may ask `list()` once more. Deliberately an
 * out-param rather than a fourth `ReapOutcome`: the outcome strings are persisted
 * in `failureSummary` and refusal records, and a new one would change what
 * operators read.
 */
export type ReapSignals = { timedOutStillPresent?: boolean };

/**
 * `reap`, plus the one fact the outcome string cannot carry. Lives here
 * because its only consumers are the abandon paths that feed
 * `releaseAbandonedTake` below.
 */
export const reapReporting = traced(
	"runner.reapReporting",
	async function reapReporting(
		db: WatcherDb,
		transport: RunnerTransport,
		vmid: number,
		expectedHolder?: string,
	): Promise<{ reap: ReapOutcome; reapSignals: ReapSignals }> {
		const reapSignals: ReapSignals = {};
		const reap = await reapInner({ db, transport, vmid, expectedHolder, signals: reapSignals });
		return { reap, reapSignals };
	},
);

/**
 * The same-pass vmid gate, lifted out of `acquireRunnerBox`.
 *
 * Returns a refusal when the vmid belongs to a live sibling dispatch, and `null`
 * when this dispatch may keep the box — either because the vmid was free, or
 * because a held-UNPROVEN vmid was re-probed and proven gone.
 */
export const settlePassVmid = traced(
	"runner.settlePassVmid",
	async function settlePassVmid(args: {
		db: WatcherDb;
		transport: RunnerTransport;
		job: DispatchableJob;
		runnerJobId: string;
		vmid: number;
		retryMinutes: number;
		now: Date;
		passVmids?: PassVmids;
		intentAttemptId?: number;
	}): Promise<{ status: "refused"; outcome: DispatchOutcome } | null> {
		const { db, transport, job, runnerJobId, vmid, retryMinutes, now, passVmids } = args;
		if (passVmids === undefined || passVmids.take(vmid)) {
			return null;
		}
		// A vmid held only by an UNPROVEN reap earns ONE read-only re-probe
		// before this job is refused; a vmid a live sibling holds never does.
		if (await retakeIfProvenGone(passVmids, transport, vmid)) {
			return null;
		}
		// This path deliberately writes NO attempt row: the box has a rightful
		// owner who will reap it, so there is nothing for an operator to name. Retire
		// the intent row to keep that contract intact.
		if (args.intentAttemptId !== undefined) {
			await retireAllocationIntent(db, args.intentAttemptId);
		}
		return await refuseVmidCollision({ db, job, runnerJobId, vmid, retryMinutes, now });
	},
);
