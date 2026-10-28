/**
 * @module infra/dispatch
 * @description The dedicated exact-SHA dispatch path for the rtech-infra
 *   static-validation lane. An `infra-static` job is a SCHEDULED RECONCILE
 *   job, so it flows through `reconcile/dispatch-pass` -> `runner/dispatch`. The
 *   generic `renderJobBody("infra-static", ...)` body is only a short intent stub:
 *   it stages no exact-SHA acquisition and carries no fixed-command sandbox
 *   contract, so a runner would receive neither the exact commit nor the reviewed
 *   execution contract. This module supplies the concrete lane, mirroring the two
 *   PROVEN exact-SHA lanes (pre-push and compat): it renders the concrete
 *   `renderInfraStaticJobBody` (the fixed bwrap launcher + the fixed per-gate
 *   static commands keyed on the resolved gate booleans + the fixed depth-1 fetch
 *   of the exact SHA), LANDS that full contract as the digest-bound `job.md` on
 *   the collab share, and returns the tiny fixed bootstrap the runner runs inline.
 *
 *   It reuses the EXISTING proven machinery: the shared `jobBundlePaths`
 *   derivation and atomic `job.md` write (via `BodyLandingStager.land`) and the
 *   generic, lane-agnostic digest-bound bootstrap (`renderInfraStaticBootstrapJob`
 *   -> `renderPrepushBootstrapJob`). rtech-infra is a foreign repo whose PR-head
 *   SHA is not in the watcher's local object database, so — exactly like the
 *   compat partner services — the exact commit is acquired inside the landed
 *   contract by a fixed depth-1 fetch, not a local candidate bundle; there is no
 *   second staging seam. It fails closed on a null body or a landing fault so the
 *   caller never submits a runner with a missing contract.
 *
 * @outputs
 *   - `InfraStaticDispatch` -- the prepared bootstrap + landed contract, or a fault
 *   - `prepareInfraStaticDispatch` -- render the concrete body, land it, bootstrap
 *
 * @dependencies
 *   - ../prepush/stage -- the shared body-only landing seam (atomic job.md write)
 *   - ./body -- the concrete fixed static-validation body + reused bootstrap
 *   - ./gates -- the resolved gate selection the concrete body enumerates from
 */
import { createHash } from "node:crypto";
import type { Provider } from "../forge/provider";
import { traced } from "../log";
import type { BodyLandingStager } from "../prepush/stage";
import { renderInfraStaticBootstrapJob, renderInfraStaticJobBody } from "./body";
import type { GateSelection } from "./gates";

/**
 * The prepared dispatch for one infra-static job: the tiny fixed bootstrap the
 * runner runs inline (digest-bound to the landed `job.md`), or a bounded fault
 * when the concrete body could not be rendered or landed. A fault means the
 * caller must FAIL CLOSED — release the claim and skip — never submit a runner.
 */
export type InfraStaticDispatch = { ok: true; bootstrap: string } | { ok: false; reason: string };

/**
 * Render the concrete infra-static contract, land it as the digest-bound
 * `job.md`, and return the tiny bootstrap the runner runs inline. Mirrors the
 * pre-push/compat render -> digest -> land -> bootstrap ordering.
 *
 * FAILS CLOSED on every fault: a null body (oversize, unsafe job id, unrecognised
 * repository, or an empty gate set), an unusable bootstrap digest, or a landing
 * I/O error all return `{ ok: false }` so the caller releases the claim and skips
 * rather than dispatching a runner with a missing or unverifiable contract.
 *
 * @param stager - the body-only landing seam (shared atomic job.md write)
 * @param repository - `owner/repo`, already validated at the boundary
 * @param sha - the exact trusted DB-join candidate SHA (never an ambient HEAD)
 * @param runnerJobId - the safe runner job id staging and the runner both use
 * @param selection - the resolved fixed static-gate selection (from infra/gates)
 */
/** Arguments for {@link prepareInfraStaticDispatch}. */
export type PrepareInfraStaticDispatchArgs = {
	stager: BodyLandingStager;
	repository: string;
	provider: Provider;
	sha: string;
	runnerJobId: string;
	selection: GateSelection;
	/** The item the job was dispatched against, so the result can name it. */
	itemNumber?: number | null;
};

export const prepareInfraStaticDispatch = traced(
	"infra.prepareInfraStaticDispatch",
	async function prepareInfraStaticDispatch({
		stager,
		repository,
		provider,
		sha,
		runnerJobId,
		selection,
		itemNumber,
	}: PrepareInfraStaticDispatchArgs): Promise<InfraStaticDispatch> {
		// Render the FULL fixed contract (fetch of the exact SHA + fixed bwrap launcher
		// + the fixed per-gate commands the resolved selection enumerates). A null body
		// is a hard fail-closed: never land or dispatch a missing/oversize contract.
		const body = renderInfraStaticJobBody({
			repository,
			provider,
			sha,
			jobId: runnerJobId,
			selection,
			itemNumber,
		});
		if (body === null) {
			return { ok: false, reason: "fixed infra-static contract unavailable" };
		}

		// Bind the bootstrap to the EXACT job.md bytes: the collab mount is shared and
		// writable by other principals, so an attacker could overwrite job.md between
		// landing and the box read. The digest is computed over the identical string
		// handed to the stager so the runner-side recomputation matches byte-for-byte
		// and a tampered/truncated file fails closed without executing anything.
		const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
		const bootstrap = renderInfraStaticBootstrapJob(runnerJobId, bodySha256);
		if (bootstrap === null) {
			return { ok: false, reason: "fixed infra-static contract unavailable" };
		}

		// Land the full contract as job.md before the runner is submitted. Reuses the
		// shared atomic write over the shared job-scoped path derivation (no second
		// staging seam). A landing fault fails closed.
		try {
			await stager.land(runnerJobId, body);
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : "infra-static landing failed",
			};
		}

		return { ok: true, bootstrap };
	},
);
