/**
 * @module runner/reap-identity
 * @description The FLEET-side half of the reap ownership question:
 *   does `runner_list`'s own attribution stamp contradict the DB claim we
 *   already proved?
 *
 *   Split out of `runner/dispatch.ts` because that file sits at its 500-line
 *   ceiling, and because this is a genuinely separate concern: `dispatch.ts`
 *   owns the claim/allocate/submit lifecycle, while this asks one read-only
 *   question of the fleet and answers it in one direction only.
 *
 *   THE DIRECTION IS THE WHOLE DESIGN. This can only ever SUBTRACT from a reap
 *   the DB already authorized; it can never authorize one. See
 *   {@link identityDisprovesOwnership} for why every ambiguous answer resolves
 *   to "proceed".
 *
 * @outputs
 *   - `identityDisprovesOwnership` -- is there POSITIVE evidence this box is someone else's
 *
 * @dependencies
 *   - ../log -- the named warns for a mismatch and for an unreadable fleet
 *   - ./transport -- the read-only `list` verb and the `ListedBox` shape
 */
import { errorMessage, log, traced } from "../log";
import type { ListedBox, RunnerTransport } from "./transport";

/**
 * Does the FLEET's own attribution stamp disprove our ownership of this box?
 *
 *
 * Answers only a narrow question: is there POSITIVE evidence the box belongs to
 * someone else. It is consulted after the claim-scoped release has ALREADY
 * proven DB ownership, so it can only ever subtract from a reap, never authorize
 * one.
 *
 * TRUE requires a proven mismatch — the vmid is present in the list AND carries
 * a non-null job id AND that id differs from ours. Everything else is FALSE:
 *
 *  - `jobId === null` — the box carries no stamp (spawned before stamping, or by
 *    another tool), so it disproves nothing.
 *  - the vmid is ABSENT from the list — the fleet does not report it at all,
 *    which is not evidence it belongs to a different job.
 *  - `list()` THREW — the read never happened, so it has no opinion.
 *
 * Every one of those degrades OPEN, and that direction is deliberate. Failing
 * closed on an unreadable fleet would make EVERY reap impossible during a
 * `runner_list` outage, and an unreapable pool is 25 VMIDs wide — the capacity
 * starvation this codebase has already been bitten by twice. The DB claim was a
 * sufficient proof of ownership before this check existed and remains one; this
 * is defence in depth on top of it, not a second gate with a veto.
 */
export const identityDisprovesOwnership = traced(
	"runner.identityDisprovesOwnership",
	async function identityDisprovesOwnership(
		transport: RunnerTransport,
		vmid: number,
		expectedHolder: string,
	): Promise<boolean> {
		let boxes: ListedBox[];
		try {
			boxes = await transport.list();
		} catch (err) {
			// The fleet read is UNAVAILABLE, not contradictory. Named so an operator can
			// see that a reap proceeded on the DB claim alone rather than on a
			// confirmed-clean identity check.
			log("warn", "runner.reap_verify_unavailable", {
				vmid,
				runner_job_id: expectedHolder,
				cause: errorMessage(err),
				hint: "runner_list could not be read; proceeding on the proven DB claim",
			});
			return false;
		}
		const box = boxes.find((candidate) => candidate.vmid === vmid);
		if (!box || box.jobId === null) {
			return false;
		}
		if (box.jobId === expectedHolder) {
			return false;
		}
		log("warn", "runner.reap_skipped_identity_mismatch", {
			vmid,
			runner_job_id: expectedHolder,
			fleet_job_id: box.jobId,
			hint: "the fleet stamp names a DIFFERENT job; powering this box off would kill live work",
		});
		return true;
	},
);
