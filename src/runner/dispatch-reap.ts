/**
 * @module runner/dispatch-reap
 * @description Reap a runner box: clear its pool claim, prove the box is still
 *   ours to power off, and call the destructive verb — or deliberately decline.
 *
 *   Split out of `./dispatch` because reaping is its own concern with
 *   its own safety argument, and because that module is at the 500-code-line
 *   `lint:size` bound. `dispatch.ts` re-exports `reap`, `reapInner`, and
 *   `ReapOutcome`, so every existing importer of that path is unaffected.
 *
 *   The safety property this module owns: a reap NEVER powers off a box whose
 *   ownership is unproven. Ownership comes from the CLAIM FACT and the scoped
 *   release's own row count, never from a follow-up read, because a second read
 *   is not atomic with the release.
 *
 * @outputs
 *   - `reap` -- reap a box, positional signature, for existing callers
 *   - `reapInner` -- the reap body, keyed, carrying the sf#418 ambiguity signal
 *   - `ReapOutcome` -- what the reap actually did
 *
 * @dependencies
 *   - ../db/client, ../db/repos -- the db type and the scoped claim release
 *   - ../log -- the one logger, and the traced() wrapper
 *   - ./dispatch-util -- isTransportTimeout, for the sf#402 re-probe
 *   - ./pass-vmids -- the ReapSignals type
 *   - ./reap-identity -- the fleet-side ownership check
 *   - ./transport -- the runner-box verb contract and done classifier
 */
import type { WatcherDb } from "../db/client";
import { releaseRunnerBox } from "../db/repos";
import { errorMessage, log, traced } from "../log";
import { isTransportTimeout } from "./dispatch-util";
import type { ReapSignals } from "./pass-vmids";
import { identityDisprovesOwnership } from "./reap-identity";
import { classifyDone, type RunnerTransport } from "./transport";

/**
 * Clear the pool claim, returning whether THIS caller's claim was the one cleared.
 *
 * Never throws: a release failure must not mask the reap or the job's real
 * outcome. An errored scoped release returns FALSE — it did not prove ownership,
 * and the caller treats unproven ownership as "do not power this box off".
 */
async function releaseClaim(
	db: WatcherDb,
	vmid: number,
	expectedHolder?: string,
): Promise<boolean> {
	try {
		return await releaseRunnerBox(db, vmid, expectedHolder);
	} catch (err) {
		log("warn", "runner.claim_release_failed", { vmid, cause: errorMessage(err) });
		return false;
	}
}

/**
 * The outcome of a {@link reap}, so a caller can RECORD what happened without a
 * second read. `reaped` = powered off (claim released if one existed).
 * `skipped-unproven-ownership` = a scoped release did not match, so the box was
 * left running on purpose (a newer attempt owns it). `skipped-identity-mismatch`
 * = the DB claim WAS ours but the fleet's stamp names another job (see
 * `./reap-identity`). `reap-failed` = the claim was (or could be) ours but
 * `transport.done` threw AND the box was not proven gone -- a throw that was a
 * TIMEOUT is re-probed once against `list()` first, so a verb that
 * timed out client-side while succeeding server-side reports `reaped`.
 */
export type ReapOutcome = ReapSkip | "reaped" | "reap-failed";

/** The two reasons a reap deliberately leaves a box RUNNING. */
type ReapSkip = "skipped-unproven-ownership" | "skipped-identity-mismatch";

/**
 * Reap a box this dispatch placed.
 *
 * `expectedHolder` is the runner job id that claimed the box, supplied only when
 * `claimBox` positively recorded a claim. When supplied, the release is scoped to
 * it and anything other than a proven match means DO NOT REAP: the vmid may now
 * belong to a live job, and powering it off would kill running work. Without that
 * check a stale timeout could clear a fresh attempt's claim and then reap its box
 * (found by the `gpt-5.6-sol@high` SME lane on PR #83).
 *
 * Ownership is decided by the CLAIM FACT and the scoped release's own row count —
 * never by a follow-up read. A second read is not atomic with the release, so
 * ownership can change between them; and inferring "nobody holds it, so it must
 * still be mine" from a failed read fails OPEN, which the fix-verification lane
 * showed could power off another attempt's box after a transient database error.
 *
 * Callers that never claimed (surplus and partial-allocation paths) omit
 * `expectedHolder` and keep the unconditional reap: no claim exists to race, and
 * an unreaped box there is a real leak.
 *
 * Exported so the reclaimer can reap a box it releases through the SAME
 * scoped path rather than re-deriving one: the reclaimer released a box CLAIM but
 * never powered the LXC off, so three boxes ran orphaned for hours. It passes the
 * attempt's `runnerJobId` as `expectedHolder`, getting the identical claim-scoped
 * reap and skip-on-unproven-ownership semantics dispatch already relies on. The
 * returned outcome lets the reclaimer record what the reap did in its own log line.
 */
export const reap = traced(
	"runner.reap",
	async function reap(
		db: WatcherDb,
		transport: RunnerTransport,
		vmid: number,
		expectedHolder?: string,
	): Promise<ReapOutcome> {
		return await reapInner({ db, transport, vmid, expectedHolder });
	},
);

/**
 * The reap body: `reap`, plus the one fact the outcome string cannot carry.
 * `reap` stays a thin positional wrapper over it so every existing
 * caller's four-argument signature is unchanged.
 */
export const reapInner = traced(
	"runner.reapInner",
	async function reapInner(args: {
		db: WatcherDb;
		transport: RunnerTransport;
		vmid: number;
		expectedHolder?: string;
		signals?: ReapSignals;
	}): Promise<ReapOutcome> {
		const { db, transport, vmid, expectedHolder, signals } = args;
		// Clear the pool claim FIRST. A box whose claim outlives it reads as held
		// forever, which is a false leak report — and a false leak is what makes a real
		// one easy to dismiss. Clearing before the reap means the worst case is a box
		// that looks free while still powering off (transient, self-correcting), never
		// one that looks held after it is gone (permanent, and wrong).
		const stillOurs = await releaseClaim(db, vmid, expectedHolder);
		if (expectedHolder !== undefined && !stillOurs) {
			log("warn", "runner.reap_skipped_unproven_ownership", {
				vmid,
				runner_job_id: expectedHolder,
				hint: "the claim did not match (re-claimed by a newer attempt, or the release failed); reaping could kill a live job",
			});
			return "skipped-unproven-ownership";
		}
		// VERIFY BEFORE KILL. The DB claim above already proves ownership;
		// this asks the FLEET whether its stamp contradicts it. Only a PROVEN mismatch
		// stops the reap; see `./reap-identity` for why ambiguity proceeds. Scoped
		// reaps only — an unscoped caller has no holder to compare against.
		if (expectedHolder && (await identityDisprovesOwnership(transport, vmid, expectedHolder))) {
			return "skipped-identity-mismatch";
		}
		try {
			return classifyDone(await transport.done(vmid, expectedHolder), vmid, expectedHolder);
		} catch (err) {
			const cause = errorMessage(err);
			// A TIMED-OUT VERB PROBABLY COMPLETED. The HTTP transport aborts at
			// 90s, and the gateway routinely finishes destroying the box well after that —
			// so the client sees a throw for work that SUCCEEDED. Treating that as
			// "reap-failed" held the vmid for the rest of the pass and refused every later
			// job with `vmid already dispatched this pass`; live on the watcher host.
			//
			// ONE read-only re-probe settles it, and read-only is what makes it safe: an
			// ambiguous timeout is resolved by asking what is actually there, never by
			// retrying the destructive verb. Only a timeout earns the probe — an ordinary
			// failure carries no such ambiguity, so it keeps the unchanged hold.
			if (isTransportTimeout(err)) {
				try {
					const boxes = await transport.list();
					if (!boxes.some((box) => box.vmid === vmid)) {
						log("info", "runner.reap_proven_by_reprobe", { vmid, cause });
						return "reaped";
					}
					// The verb TIMED OUT and the box is still listed. On the watcher host that is
					// overwhelmingly a destroy still in flight rather than a survivor — but
					// "overwhelmingly" is not proof, so the outcome stays `reap-failed` and the
					// vmid is still held. What this records is the AMBIGUITY: the only hold
					// a later collision gate may re-probe. An ordinary transport
					// fault never sets it, which is why a widened timeout arm would be caught.
					if (signals) signals.timedOutStillPresent = true;
				} catch (probeErr) {
					// The probe never happened, so it has no opinion; fall through to the hold.
					log("warn", "runner.reap_reprobe_failed", { vmid, cause: errorMessage(probeErr) });
					return "reap-failed";
				}
			}
			// Best effort is right — the recorded attempt still carries the vmid for the
			// reaper — but a failed reap LEAKS a pool box, and the pool is 25 VMIDs wide.
			// Enough silent leaks and allocation starts failing with "runner capacity
			// unavailable", whose cause is then invisible at the point it actually
			// happened. That exact confusion cost real time on 2026-07-25.
			log("warn", "runner.reap_failed", { vmid, cause });
			return "reap-failed";
		}
	},
);
