/**
 * @module runner/dispatch
 * @description Dispatch an approved, allowlisted watcher job to a runner box
 *   through the runner-box transport. The job is first atomically claimed
 *   (pending -> dispatching) so two concurrent passes can never dispatch the
 *   same job twice; then a runner of the template's size is allocated, a job
 *   attempt is recorded with the returned identity, and the fixed job body is
 *   submitted. A clean capacity refusal releases the claim with a bounded
 *   next-attempt time; network/MCP errors are recorded on the attempt, the box
 *   is best-effort reaped, and the job is released to pending without losing it.
 *   Only fixed job templates are dispatched — never arbitrary commands or
 *   live-infrastructure mutation.
 *
 *   Liveness note: a crash between the claim and any release/complete write
 *   leaves the job in `dispatching`. This slice has no in-process recovery for
 *   that state; the reconcile job selector owns re-pending stale
 *   `dispatching` rows past a threshold. Every other exit path releases or
 *   completes the claim explicitly.
 *
 * @outputs
 *   - `dispatchJob` -- claim + allocate + record + submit one approved job
 *   - `DispatchOutcome` -- discriminated result of a dispatch attempt
 *   - `newRunnerJobId` -- unique, never-reused runner job id
 *
 * @dependencies
 *   - drizzle-orm -- attempt/job writes with a status-guarded claim
 *   - ../db/schema, ../db/client -- tables and db type
 *   - ./transport -- the runner-box verb contract
 *   - ../config/schema -- the allowlisted job template
 */
import { and, eq } from "drizzle-orm";
import type { JobTemplateConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import { claimRunnerBox } from "../db/repos";
import { jobAttempts, jobs } from "../db/schema";
import type { Provider } from "../forge/provider";
import { prepareInfraStaticDispatch } from "../infra/dispatch";
import { type GateSelection, STATIC_GATES } from "../infra/gates";
import { errorMessage, log, traced } from "../log";
import type { BodyLandingStager } from "../prepush/stage";
import { type AttemptLevel, decideAttemptLevel } from "../reconcile/attempt-level";
import { type JobTemplateId, renderJobDispatch, TEMPLATE_MAX_TURNS } from "../templates/registry";
import {
	markJobRunning,
	reapAndRequeue,
	recordAllocationIntent,
	recordAllocationThrow,
	recordSubmittedAttempt,
} from "./attempt-record";
import { type ReapOutcome, reap, reapInner } from "./dispatch-reap";
import { addMinutes, bound, newRunnerJobId } from "./dispatch-util";
import {
	type PassVmids,
	type ReapSignals,
	reapReporting,
	releaseAbandonedTake,
	settlePassVmid,
} from "./pass-vmids";
import { type EngineEndpoint, resolveRuntimeRoute } from "./route";
import { settleFailedSubmission } from "./run-timeout";
import { carriesTraceparent, traceparentFor } from "./trace-context";
import type { RunnerEffort, RunnerRuntime, RunnerTransport } from "./transport";

/**
 * The fail-safe turn budget for a job type absent from TEMPLATE_MAX_TURNS. It
 * matches the harness's own `?? 30` fallback so a dispatch is never sent with an
 * undefined budget: an unmapped type gets a defined 30, not the implicit
 * harness default reached by omission (which is the exact failure #96 fixed).
 */
const FALLBACK_MAX_TURNS = 30;

/**
 * Resolve the fixed reviewed turn budget for a job type. TEMPLATE_MAX_TURNS is
 * keyed by the allowlisted template ids; a job type that is not one of them
 * (impossible on the dispatched path, but this stays total) falls back to a
 * defined value rather than ever passing `undefined` to the harness.
 */
function resolveMaxTurns(jobType: string): number {
	return TEMPLATE_MAX_TURNS[jobType as JobTemplateId] ?? FALLBACK_MAX_TURNS;
}

/** The fixed template id of the dedicated exact-SHA static-validation lane. */
const INFRA_STATIC_JOB_TYPE = "infra-static";

/**
 * The body/route renderer `dispatchJob` calls. It takes everything
 * `renderJobDispatch` takes, plus the minted `runnerJobId`, and may answer
 * asynchronously so a lane that LANDS its body on the share before
 * submitting can do so from here. `renderJobDispatch` itself satisfies this type
 * unchanged: it ignores the extra argument and returns synchronously.
 */
export type DispatchRenderer = (
	jobType: string,
	context: Parameters<typeof renderJobDispatch>[1],
	runnerJobId: string,
) => ReturnType<typeof renderJobDispatch> | Promise<ReturnType<typeof renderJobDispatch>>;

/** What a resolved dispatch submits: body plus any explicit reviewed agent route. */
export type RunnerSubmission = {
	body: string;
	runtime?: RunnerRuntime;
	model?: string;
	effort?: RunnerEffort;
	engineEndpoint?: EngineEndpoint;
};

/**
 * The fixed template id of the deployed-path smoke. It is a DOCTOR-PROBE-ONLY
 * lane: it is dispatched inline by `src/doctor/probe.ts` with the fixed
 * `src/doctor/body.ts` contract and is NEVER created as a persisted `jobs` row. This
 * constant lets `dispatchJob` REFUSE it before the generic template path, so even a
 * stray persisted deploy-smoke row can never send the generic (repo/SHA-bearing)
 * registry body to a runner.
 */
const DEPLOY_SMOKE_JOB_TYPE = "deploy-smoke";

/** Default minutes to wait before retrying a capacity-refused job. */
export const DEFAULT_RETRY_MINUTES = 15;

/** Outcome of one dispatch attempt. */
/**
 * `provenNoBox`: this outcome ended BEFORE any allocation (claim or route
 * refused, a refusal that placed nothing, a warm box a sibling holds), so the
 * sweep's cap was not spent. Absent = a box was placed or the answer is unknown;
 * the pass budget then keeps the slot.
 */
export type DispatchOutcome =
	| { status: "dispatched"; runnerJobId: string; vmid: number }
	| { status: "queued"; retryAfterMinutes: number; reason: string; provenNoBox?: true }
	| { status: "skipped"; reason: string; provenNoBox?: true }
	| { status: "error"; reason: string; vmid?: number; provenNoBox?: true };

/** A job row selected for dispatch, plus the bounded context its body needs. */
export interface DispatchableJob {
	id: number;
	sha: string;
	jobType: string;
	/** `owner/repo`, already validated against the managed-repository allowlist. */
	repository: string;
	/** Durable provider stored with the managed repository. */
	provider: Provider;
	/** The item number the job concerns, when known. */
	itemNumber?: number;
	/** Whether static-only checks apply to the repository. */
	staticOnly?: boolean;
	/**
	 * The resolved fixed static-gate selection for an `infra-static` job.
	 * When present it feeds the reviewed gate BOOLEANS into the fixed body so the
	 * runner enumerates only the applicable static gates; absent, the `infra-static`
	 * body falls back to a full escalation (all gates). It carries no command or
	 * path — only which fixed gates apply.
	 */
	gateSelection?: {
		ansible: boolean;
		workflows: boolean;
		scripts: boolean;
		config: boolean;
		fullEscalation: boolean;
		/** Immutable PR base the verdict is relative to. */
		baseSha?: string;
	};
	/**
	 * The repository's config-declared triage label allowlist, resolved from
	 * config by the dispatch pass and rendered INTO the issue-triage body so the
	 * runner picks its labels from this fixed set. It is author-controlled config,
	 * never repository content or runner output. Only the issue-triage body reads
	 * it; absent/empty tells the runner the repository declares no vocabulary.
	 */
	triageLabels?: readonly string[];
	/**
	 * The bounded reason this job's MOST RECENT terminal attempt failed,
	 * read by the dispatch pass from `job_attempts.failure_summary` and rendered
	 * into the body of a REVIVED attempt so the retry is a correction rather than
	 * an identical cold re-dispatch.
	 *
	 * It is WATCHER-AUTHORED: the string our own ingest/lifecycle classifiers
	 * wrote (`boundReason` in `src/results/store.ts`, the lifecycle summaries in
	 * `src/reconcile/attempt-lifecycle.ts`), never runner-produced text echoed
	 * back into a prompt — that would be a prompt-injection loop. It is sanitized
	 * and re-capped at the render boundary regardless.
	 *
	 * Absent on a first attempt, and absent when the prior attempt recorded no
	 * summary, so the ordinary body is unchanged byte-for-byte.
	 */
	previousFailure?: string;
}

/**
 * The four dependency-free dispatch helpers moved to `./dispatch-util`
 * so this module keeps headroom under the `lint:size` bound. Re-exported so
 * every existing importer of this path is unaffected.
 */
export { addMinutes, bound, newRunnerJobId, type ReapOutcome, reap, reapInner };

/**
 * Reconstruct the resolved `GateSelection` the concrete infra-static body
 * enumerates from, out of the reviewed gate BOOLEANS the dispatch pass already
 * resolved (`infraGateSelector` / the fail-closed full escalation). The gates are
 * emitted in the fixed `STATIC_GATES` order for a stable body. Absent a resolved
 * selection, fall back to a FULL escalation (all gates) — the fail-closed default
 * that never narrows the static checks without a trusted decision. The reason is
 * fixed and log-safe; the concrete body reads only `gates` and `fullEscalation`.
 */
function infraSelection(gate: DispatchableJob["gateSelection"]): GateSelection {
	if (!gate) {
		return {
			gates: [...STATIC_GATES],
			fullEscalation: true,
			reason: "no resolved gate selection: fail-closed to full static escalation",
		};
	}
	const on = {
		ansible: gate.ansible,
		workflows: gate.workflows,
		scripts: gate.scripts,
		config: gate.config,
	} as const;
	const gates = STATIC_GATES.filter((g) => on[g]);
	// Defence-in-depth: an all-false selection is not a valid narrow set (the
	// selector fails closed to all four), so treat it as a full escalation rather
	// than rendering an empty gate set the concrete body would reject as null.
	if (gates.length === 0) {
		return {
			gates: [...STATIC_GATES],
			fullEscalation: true,
			reason: "empty resolved gate selection: fail-closed to full static escalation",
		};
	}
	return {
		gates,
		fullEscalation: gate.fullEscalation,
		reason: gate.fullEscalation
			? "full static escalation"
			: `narrow static gates selected: ${gates.join(", ")}`,
		...(gate.baseSha === undefined ? {} : { baseSha: gate.baseSha }),
	};
}

/**
 * Dispatch one approved job. The job body is the fixed template text; no
 * repository content is executed.
 *
 * The job is claimed atomically first (pending -> dispatching, guarded by the
 * current status) so concurrent passes cannot double-dispatch it. On success
 * the job moves to `running` with a recorded attempt; on refusal it is released
 * to `pending` with a bounded next-attempt time; on error the failure is
 * recorded, the box is best-effort reaped, and the job is released to `pending`
 * for a later pass.
 *
 * @param db - watcher database
 * @param transport - runner-box verb contract
 * @param job - the pending job to dispatch
 * @param template - the allowlisted job template (fixed body + runner size)
 * @param retryMinutes - bounded retry delay when capacity is refused
 * @param now - clock seam for the next-attempt timestamp
 * @param bodyLandingStager - the body-only landing seam the DEDICATED infra-static
 *   exact-SHA lane uses to land its digest-bound `job.md`. Required only for
 *   `infra-static`; every other job type ignores it and keeps the generic path.
 */
export type DispatchJobArgs = {
	db: WatcherDb;
	transport: RunnerTransport;
	job: DispatchableJob;
	template: JobTemplateConfig;
	retryMinutes?: number;
	now?: Date;
	bodyLandingStager?: BodyLandingStager;
	/**
	 * Overrides the body/route renderer. Production leaves it unset for every
	 * generic lane and gets `renderJobDispatch`. It exists so the route-less
	 * refusal branch is REACHABLE from a real dispatch: no packet on disk can
	 * produce a routing-less render (the schema requires the trio), so without this
	 * seam the branch's release-and-skip property could only be asserted through a
	 * proxy job type.
	 *
	 * It receives the minted `runnerJobId` and may return a PROMISE. The
	 * verb lane uses both: it lands its full ~28k body as the job-scoped `job.md`
	 * on the share and returns only the tiny bootstrap, and both the landing path
	 * and the digest the bootstrap binds are derived from that exact id. Widening
	 * this ONE existing seam keeps the staging decision at the call site that owns
	 * knowing the body is a verb body, and leaves the transport contract dumb.
	 */
	renderDispatch?: DispatchRenderer;
	/** Environment the pi-emission flag resolves from; production leaves it unset. */
	env?: NodeJS.ProcessEnv;
	/**
	 * The vmids THIS reconcile pass has already handed to a dispatch.
	 *
	 * The gateway's `needed()` reports a warm box without reserving it, so two
	 * dispatches in one pass can each be told to use the same vmid — observed live
	 * on rtech-infra#795, where the second submission cost a whole attempt. The
	 * ledger is threaded from the SWEEP, not created here, because the colliding
	 * dispatches come from two different call sites (`dispatchPendingJobs` and the
	 * verb lane's `dispatchVerbLive`) that share only the pass. A caller that omits
	 * it keeps the pre-sf#299 behaviour, which is why every existing test and the
	 * one-shot dispatchers (prepush, compat, doctor) need no change.
	 */
	passVmids?: PassVmids;
};

export const dispatchJob = traced(
	"runner.dispatchJob",
	async function dispatchJob({
		db,
		transport,
		job,
		template,
		retryMinutes = DEFAULT_RETRY_MINUTES,
		now = new Date(),
		bodyLandingStager,
		renderDispatch,
		env,
		passVmids,
	}: DispatchJobArgs): Promise<DispatchOutcome> {
		const preflight = await claimJobForDispatch(db, job, now);
		if (preflight.status !== "ok") {
			return preflight.outcome;
		}
		const { runnerJobId, level } = preflight;

		// The invariants every phase below shares. Each phase FAILS CLOSED on its own
		// terms: the body resolver releases the claim, the allocator reaps and requeues,
		// and the submitter reaps its own claimed box.
		const ctx = { db, transport, job, template, runnerJobId, level, retryMinutes, now };

		const resolved = await resolveSubmittedBody({ ...ctx, bodyLandingStager, renderDispatch, env });
		if (!resolved.ok) {
			// A refusal here releases the claim and reports `skipped`, which on its own is
			// indistinguishable from every other skip in a counter. Emit the reason so a
			// packet declaring no route is visible as an operator-fixable defect
			// rather than a job that silently never dispatches.
			log("warn", "dispatch.route_refused", {
				job_type: job.jobType,
				job_id: job.id,
				runner_job_id: runnerJobId,
				cause: resolved.reason,
			});
			await releaseJob(db, job.id, now, { now });
			return { status: "skipped", reason: resolved.reason, provenNoBox: true };
		}
		const submission = resolved.submission;

		const acquired = await acquireRunnerBox({ ...ctx, ...(passVmids ? { passVmids } : {}) });
		if (acquired.status !== "ok") {
			return acquired.outcome;
		}
		const box = acquired.box;

		// NOTE (reversing the original sf#299 note): both abandon paths below
		// offer the vmid back to `passVmids` after their own reap and job release, and
		// `releaseAbandonedTake` gives it back ONLY when that reap returned `reaped`.
		// See `pass-vmids.ts` for both halves — holding a proven-gone vmid killed whole
		// passes live once the gateway recycled the number, and handing back a vmid
		// whose reap did NOT prove the box gone drops a second job onto live work.
		// Decided HERE, not in the helpers, so the sibling refusal in
		// `acquireRunnerBox` (which must never release: that box has a rightful owner)
		// cannot reach it; the helpers only REPORT the outcome they got.
		const recorded = await recordOwnedAttempt({ ...ctx, box });
		if (recorded.status !== "ok") {
			releaseAbandonedTake(passVmids, box.vmid, recorded.reap, recorded.reapSignals);
			return recorded.outcome;
		}
		const attempt = recorded.attempt;

		const submitted = await claimAndSubmit({ ...ctx, box, attempt, submission });
		if (submitted !== null) {
			releaseAbandonedTake(passVmids, box.vmid, submitted.reap, submitted.reapSignals);
			return submitted.outcome;
		}

		// Mark the job running only while THIS attempt still owns it. If the
		// reclaimer re-pended and a newer attempt took over between the ownership-take
		// and here, this write matches zero rows and does not resurrect a stale attempt's
		// claim over the live re-run. The box was submitted, so it is left to run out and
		// be reaped by the reclaimer/result path — never force-terminated from here.
		await markJobRunning(db, job.id, attempt.id, now);
		return { status: "dispatched", runnerJobId, vmid: box.vmid };
	},
);

/**
 * Atomically claim the job for dispatch and mint its runner job id, refusing any
 * job type that must never reach a runner through the persisted path.
 *
 * Only a currently-pending row is claimed, so two concurrent dispatches cannot
 * both proceed for the same job id.
 */
/** A refusal that ends before any allocation: the row is skipped, no box was placed. */
function refusedNoBox(reason: string): { status: "refused"; outcome: DispatchOutcome } {
	return { status: "refused", outcome: { status: "skipped", reason, provenNoBox: true } };
}

async function claimJobForDispatch(
	db: WatcherDb,
	job: DispatchableJob,
	now: Date,
): Promise<
	| { status: "ok"; runnerJobId: string; level: AttemptLevel }
	| { status: "refused"; outcome: DispatchOutcome }
> {
	const claimed = await db
		.update(jobs)
		.set({ status: "dispatching", updatedAt: now })
		.where(and(eq(jobs.id, job.id), eq(jobs.status, "pending")))
		.returning({ id: jobs.id });
	if (claimed.length === 0) {
		return refusedNoBox("job not pending (already claimed)");
	}

	// The one runner job id staging (job.md landing) and the runner both use; it
	// must be generated BEFORE rendering so the dedicated infra-static lane lands
	// the contract under this exact id.
	const runnerJobId = newRunnerJobId(job.jobType);

	// deploy-smoke is a DOCTOR-PROBE-ONLY lane: it is dispatched inline by the
	// doctor probe with the fixed src/doctor/body.ts contract and is never a persisted
	// jobs row. Refuse it here BEFORE the generic renderJobBody path so a stray
	// persisted row can never send the generic (repository/SHA-bearing) template body
	// to a runner. Release the claim so the row is not lost, and skip.
	if (job.jobType === DEPLOY_SMOKE_JOB_TYPE) {
		await releaseJob(db, job.id, now, { now });
		return refusedNoBox(
			"deploy-smoke is a doctor-probe-only lane; not dispatchable as a persisted job",
		);
	}

	// #708: decided BEFORE this dispatch writes its own attempt row, so a job's
	// first attempt reads zero prior rows (info) and any respawn reads more (debug).
	const level = await decideAttemptLevel(db, job.id);
	return { status: "ok", runnerJobId, level };
}

/**
 * Claim the pool box, then submit the body to the runner. Returns `null` when the
 * submission succeeded (the caller marks the job running), or the terminal
 * failure outcome.
 *
 * The claim happens BEFORE submitting, for the same reason the attempt is
 * recorded before firing: a box lost to a transport timeout must still be
 * attributable. `jobAttempts` answers "what did this job do"; `runner_boxes`
 * answers "which boxes are held right now" — and only the latter survives a
 * watcher restart as a live pool view the operator can reap from.
 * Whether the claim POSITIVELY recorded decides how the failure path may reap.
 * A claim that never landed (unseeded inventory, non-allocatable vmid) leaves
 * no row to scope against, so the reap must stay unconditional or the box
 * strands; a claim that did land must only ever reap its own.
 */
async function claimAndSubmit(args: {
	db: WatcherDb;
	transport: RunnerTransport;
	job: DispatchableJob;
	runnerJobId: string;
	box: { vmid: number };
	attempt: { id: number };
	submission: RunnerSubmission;
	retryMinutes: number;
	now: Date;
}): Promise<{ outcome: DispatchOutcome; reap: ReapOutcome; reapSignals: ReapSignals } | null> {
	const { db, transport, job, runnerJobId, box, attempt, submission, retryMinutes, now } = args;

	const claimRecorded = await claimBox(db, box.vmid, runnerJobId);

	// sf#454: the failure summary must name WHICH call was slow and for HOW long.
	// A bare "The operation timed out." burned a whole diagnosis session.
	const runStartedAt = Date.now();

	try {
		await transport.run({
			vmid: box.vmid,
			jobId: runnerJobId,
			job: submission.body,
			// The FIXED reviewed per-template budget. Without it the harness
			// runs at its `?? 30` default, which killed a real pr-review mid-run.
			maxTurns: resolveMaxTurns(job.jobType),
			// Every agent route is explicit; the endpoint object keeps its base URL and
			// auth-header name paired until the transport encodes the wire keys.
			...(submission.runtime !== undefined ? { runtime: submission.runtime } : {}),
			...(submission.model !== undefined ? { model: submission.model } : {}),
			...(submission.effort !== undefined ? { effort: submission.effort } : {}),
			...(submission.engineEndpoint !== undefined
				? { engineEndpoint: submission.engineEndpoint }
				: {}),
		});
	} catch (err) {
		// sf#564: a TIMEOUT is not a failed verb and must not reap. The submission has
		// very likely LANDED server-side, so the arm LOOKS once (read-only `list()`)
		// before deciding anything — reaping on the timer alone recycled vmid 9001 onto
		// live work on 2026-09-02. Both arms (timeout and every other error) live in
		// `run-timeout.ts`; the non-timeout path is unchanged.
		return await settleFailedSubmission({
			db,
			transport,
			job,
			attempt,
			vmid: box.vmid,
			runnerJobId,
			claimedBy: claimRecorded ? runnerJobId : undefined,
			err,
			elapsedMs: Date.now() - runStartedAt,
			retryMinutes,
			now,
		});
	}

	return null;
}

/**
 * Record the attempt and take OWNERSHIP of the job for it, both before the
 * submission fires.
 *
 * The attempt row is written first (with identity) so a leaked box is always
 * traceable back to this dispatch even if submission errors.
 *
 * Ownership is then taken because a status guard is not enough: the
 * reclaimer can re-pend a stalled attempt's job, a newer attempt can then
 * own it, and a late write from THIS attempt would satisfy a status guard
 * perfectly while acting on a job it no longer owns. Marking ownership here — the
 * moment the attempt exists, guarded on the `dispatching` claim the caller made —
 * means every ownership-scoped write afterwards (the running write, and the
 * submission-failure release) can prove it is still the owner. If the guard LOSES
 * (a concurrent reclaim already re-pended this row out of `dispatching`), this
 * attempt was superseded before it ran: reap its box and stop, since the job is
 * pending again for a fresh attempt.
 */
async function recordOwnedAttempt(args: {
	db: WatcherDb;
	transport: RunnerTransport;
	job: DispatchableJob;
	runnerJobId: string;
	box: { vmid: number };
	now: Date;
}): Promise<
	| { status: "ok"; attempt: { id: number } }
	| { status: "refused"; outcome: DispatchOutcome; reap: ReapOutcome; reapSignals: ReapSignals }
> {
	const { db, transport, job, runnerJobId, box, now } = args;

	const attempt = await recordSubmittedAttempt({
		db,
		jobId: job.id,
		runnerJobId,
		vmid: box.vmid,
	});
	if (!attempt) {
		// Could not persist the attempt: reap the box we just took and release. No
		// active-attempt marker was written (there is no attempt id), so this is an
		// unscoped release of the row THIS call is still holding in `dispatching`.
		const { reap: reapOutcome, reapSignals } = await reapReporting(db, transport, box.vmid);
		await releaseJob(db, job.id, now, { now });
		return {
			status: "refused",
			outcome: { status: "error", reason: "failed to record attempt", vmid: box.vmid },
			reap: reapOutcome,
			reapSignals,
		};
	}

	const owned = await db
		.update(jobs)
		.set({ activeAttemptId: attempt.id, updatedAt: now })
		.where(and(eq(jobs.id, job.id), eq(jobs.status, "dispatching")))
		.returning({ id: jobs.id });
	if (owned.length === 0) {
		// The box is placed but not yet claimed in `runner_boxes` (claimBox runs in
		// the caller), so reap it UNCONDITIONALLY — no claim exists for a scoped reap
		// to race, and an unreaped box here is a real leak.
		const { reap: reapOutcome, reapSignals } = await reapReporting(db, transport, box.vmid);
		await db
			.update(jobAttempts)
			.set({ status: "failed", failureSummary: "superseded before submit", finishedAt: now })
			.where(eq(jobAttempts.id, attempt.id));
		return {
			status: "refused",
			outcome: { status: "skipped", reason: "attempt superseded before submit" },
			reap: reapOutcome,
			reapSignals,
		};
	}

	return { status: "ok", attempt };
}

/**
 * Resolve the SUBMITTED job body. Every non-infra-static type keeps the generic
 * fixed template body verbatim (no shared-path blast radius). The DEDICATED
 * infra-static lane instead renders the concrete exact-SHA contract (fixed
 * depth-1 fetch of the exact SHA + fixed bwrap launcher + fixed per-gate
 * commands), LANDS it as the digest-bound job.md, and submits only the tiny
 * bootstrap — the concrete contract the generic stub never carried. Any fault in
 * either path fails closed, so the caller releases the claim and skips before any
 * runner is allocated.
 *
 * The runtime and route are then decided by `resolveRuntimeRoute`, which
 * fails closed on the same release-and-skip path.
 */
async function resolveSubmittedBody(args: {
	job: DispatchableJob;
	template: JobTemplateConfig;
	runnerJobId: string;
	level: AttemptLevel;
	bodyLandingStager?: BodyLandingStager;
	renderDispatch?: DispatchRenderer;
	env?: NodeJS.ProcessEnv;
}): Promise<{ ok: true; submission: RunnerSubmission } | { ok: false; reason: string }> {
	const { job, template, runnerJobId, bodyLandingStager } = args;
	const render: DispatchRenderer = args.renderDispatch ?? renderJobDispatch;

	if (job.jobType === INFRA_STATIC_JOB_TYPE) {
		if (!bodyLandingStager) {
			return { ok: false, reason: "infra-static dispatch requires a body-landing stager" };
		}
		const prepared = await prepareInfraStaticDispatch({
			stager: bodyLandingStager,
			repository: job.repository,
			provider: job.provider,
			sha: job.sha,
			runnerJobId,
			selection: infraSelection(job.gateSelection),
			itemNumber: job.itemNumber,
		});
		if (!prepared.ok) {
			return { ok: false, reason: prepared.reason };
		}
		return resolveRuntimeRoute(job.jobType, { body: prepared.bootstrap }, args.env);
	}

	// Render the fixed body up front. An unknown job type has no allowlisted
	// template and must never be dispatched — the caller releases the claim and
	// skips before any runner is allocated. A renderer that LANDS its body first
	// (the verb lane) answers asynchronously and returns only its
	// bootstrap; a landing fault surfaces here as a null render and takes the same
	// release-and-skip path, so no box is ever allocated for a missing contract.
	const rendered = await render(
		job.jobType,
		{
			repository: job.repository,
			itemNumber: job.itemNumber,
			sha: job.sha || undefined,
			staticOnly: job.staticOnly,
			// The reviewed hand-back mode from the ALLOWLISTED template config —
			// never from repository content or runner output. Only the implement lane
			// reads it; every report-only body ignores it.
			returnMode: template.return_mode,
			// The repository's config-declared triage vocabulary. Only the
			// issue-triage body renders it; every other body ignores it.
			triageLabels: job.triageLabels,
			// The prior terminal attempt's bounded, watcher-authored failure reason,
			// so a revived attempt is CORRECTED rather than cold-restarted.
			// Only a packet lane declaring `accepts_extras: allowed` renders it, as a
			// tier-2 caller-extras block; absent (every first attempt), the body is
			// byte-identical to today's.
			previousFailure: job.previousFailure,
			// The row's durable forge provider, already validated by
			// `parseProvider` upstream. It selects WHICH fixed read/checkout guidance
			// the body carries so a `forgejo` row is not told to read the stale GitHub
			// mirror (proven live, job 9088); a `github` row renders as it does today.
			provider: job.provider,
			// #708: the attempt's level, for a workflow dispatch's `log_level` input.
			logLevel: args.level,
		},
		runnerJobId,
	);
	if (rendered === null) {
		return { ok: false, reason: `no allowlisted template for job type: ${job.jobType}` };
	}

	return resolveRuntimeRoute(job.jobType, rendered, args.env);
}

/**
 * Allocate EXACTLY one runner box, or return the terminal outcome the caller
 * should propagate. Every refusal path releases the job claim with a bounded
 * backoff and best-effort reaps anything the verb placed before refusing, so a
 * refusal can never strand a powered-on box.
 *
 * THE INTENT ROW IS WRITTEN FIRST. Every attribution write #149 added
 * ran after `transport.needed()` answered, so the `runner_job_id` the fleet
 * stamps on the box lived only in memory for the ~60s the verb takes — and a
 * client-side timeout there generally means the verb SUCCEEDED server-side. A
 * crash or restart in that window left a placed box no row could name. Writing
 * the identity before the call closes that window; on success the same row is
 * adopted (vmid filled in), and a clean refusal retires it so the #149 invariant
 * that a placement-free refusal writes no row is preserved.
 */
async function acquireRunnerBox(args: {
	db: WatcherDb;
	transport: RunnerTransport;
	job: DispatchableJob;
	template: JobTemplateConfig;
	runnerJobId: string;
	level: AttemptLevel;
	retryMinutes: number;
	now: Date;
	passVmids?: PassVmids;
}): Promise<
	| { status: "ok"; box: { vmid: number }; intentAttemptId?: number }
	| { status: "refused"; outcome: DispatchOutcome }
> {
	const { db, transport, job, template, runnerJobId, retryMinutes, now } = args;

	// BEFORE the verb: the identity a lost response would otherwise take with it.
	const intent = await recordAllocationIntent({
		db,
		jobId: job.id,
		runnerJobId,
		level: args.level,
	});
	const intentArg = intent ? { intentAttemptId: intent.id } : {};

	// sf#707: the correlator, set BEFORE the verb because the verb is what it
	// correlates. Both guards allow a dispatch to proceed uncorrelated rather
	// than fail: the intent row can be absent, and mcp2cli has no `_meta`.
	if (intent && carriesTraceparent(transport)) {
		transport.setTraceparent(traceparentFor(intent.id));
	}

	// Allocate a runner. A clean refusal releases the claim with a backoff.
	let allocation: Awaited<ReturnType<RunnerTransport["needed"]>>;
	try {
		allocation = await transport.needed(template.runner_size, runnerJobId, 1);
	} catch (err) {
		return await recordAllocationThrow({ db, jobId: job.id, runnerJobId, err, retryMinutes, now });
	}

	const requeue = (boxes: readonly { vmid: number }[], reason: string) =>
		reapAndRequeue({ ...args, boxes, reason, intentArg });

	if (!allocation.ok) {
		// Capacity exhausted: release to pending with a bounded next-attempt time.
		// A refusal can be a PARTIAL PLACEMENT — reap any in-pool boxes the verb
		// powered on before refusing (best-effort) so they do not strand, mirroring
		// the doctor probe's #16 fix. Deeper runner-lifecycle recovery is #17.
		return await requeue(allocation.placed ?? [], allocation.reason);
	}

	// We requested exactly one box and the caller reaps exactly one. Any other
	// count would strand every surplus box, so reap them all best-effort and
	// requeue rather than running on an allocation we cannot fully release —
	// matching prepush/validate.ts, which already fails closed this way.
	if (allocation.boxes.length !== 1) {
		return await requeue(allocation.boxes, "unexpected box count");
	}

	const box = allocation.boxes[0];
	if (!box) {
		return await requeue([], "no box returned");
	}

	// SAME-PASS VMID DE-DUP — the LAST gate before the box is
	// accepted, so every earlier refusal path keeps its reap-and-requeue semantics.
	const collision = await settlePassVmid({ ...args, vmid: box.vmid, intentAttemptId: intent?.id });
	if (collision) return collision;

	return { status: "ok", box, ...intentArg };
}

/**
 * Release a claimed (or skipped) job back to pending, deferring its next attempt.
 * Exported so the dispatch pass reuses this exact `{status:"pending", nextAttemptAt}`
 * update shape to DEFER a skipped-but-still-pending job (de-scoped repo / de-allowlisted
 * template) — a bounded skip-backoff that keeps the job revive-on-re-add while stopping
 * it re-entering the immediate shortlist every pass.
 *
 * `expectedStatus` optionally guards the update so it only releases a row still in a
 * status it is legitimately releasing FROM (mirroring the status-guarded claim above).
 * It defaults to no guard, which keeps the in-flight callers here (capacity refuse,
 * deploy-smoke refuse, submission/attempt failures) byte-behavior-identical: each of
 * those releases a row THIS pass just claimed, so an id-only release is already safe.
 * The skip-defer pass passes `"pending"` so it can never clobber a row another path
 * transitioned out of pending (e.g. revert a freshly `dispatching`/`running` row and
 * risk a duplicate dispatch). The infra-requeue pass passes `"failed"` so it only
 * ever revives a row still in terminal `failed` — the exact same reset (clears
 * `activeAttemptId`, sets a bounded `nextAttemptAt`) rather than a hand-rolled one.
 *
 * `expectedActiveAttemptId` optionally scopes the release to the ATTEMPT that owns
 * the job. Status is not a sufficient guard when the reclaimer can re-pend
 * a stalled attempt's job and a newer attempt can then claim, dispatch, and own it: a
 * late release from the stale attempt satisfies a status guard perfectly while acting
 * on a job it no longer owns. Passed by the submission-failure path (which fires after
 * this attempt took ownership); the older in-flight callers omit it and release the row
 * they still hold in `dispatching` by id, unchanged.
 *
 * Every release CLEARS `activeAttemptId`: a job returning to `pending` has no owner,
 * so the next dispatch pass claims it cleanly and a stale write from the prior owner
 * can never match the (now null) marker.
 *
 * `now` is the release's own write time and is what lands in `updated_at`.
 * Every release passes it, due-now included.
 */
/**
 * The options on a release: the release's own clock (required), plus two optional
 * guards that default to absent (the unguarded id-only release the in-flight
 * callers already relied on).
 */
export type ReleaseJobGuards = {
	/**
	 * When this release is being WRITTEN — the value that lands in `updated_at`.
	 * Distinct from `nextAttemptAt`, which is when the job next becomes
	 * dispatchable; for a deferred release the two differ by the whole backoff.
	 *
	 * REQUIRED so a future deferred-release call site cannot silently revert to the
	 * future-write defect by omission. A due-now release, where the two
	 * instants genuinely coincide, still states `now` explicitly.
	 */
	now: Date;
	expectedStatus?: "pending" | "dispatching" | "running" | "failed";
	expectedActiveAttemptId?: number;
};

export const releaseJob = traced(
	"runner.releaseJob",
	async function releaseJob(
		db: WatcherDb,
		jobId: number,
		nextAttemptAt: Date,
		{ now, expectedStatus, expectedActiveAttemptId }: ReleaseJobGuards,
	): Promise<boolean> {
		const conditions = [eq(jobs.id, jobId)];
		if (expectedStatus !== undefined) {
			conditions.push(eq(jobs.status, expectedStatus));
		}
		if (expectedActiveAttemptId !== undefined) {
			conditions.push(eq(jobs.activeAttemptId, expectedActiveAttemptId));
		}
		// Report whether the guarded transition actually matched. A caller that acts on
		// a release it LOST — the row moved on before this ran — would be operating on
		// another attempt's job: the reclaimer in particular would clear a live box's
		// claim on the strength of a re-pend that never happened.
		const released = await db
			.update(jobs)
			// `updatedAt` is the RELEASE time, never `nextAttemptAt`. Writing the
			// future retry time here made `updated_at` claim the row was written at an
			// instant that had not happened yet, and sent a live investigation of job 715
			// chasing a writer that did not exist. The two columns answer different
			// questions: when was this row last written, and when may it run again.
			.set({
				status: "pending",
				activeAttemptId: null,
				nextAttemptAt,
				updatedAt: now,
			})
			.where(and(...conditions))
			.returning({ id: jobs.id });
		return released.length > 0;
	},
);

/** Best-effort reap a box; a reap failure must not mask the primary outcome. */
/**
 * Record that `runnerJobId` holds `vmid`, before the job is submitted.
 *
 * The claim is BOOKKEEPING, not a lock: the fleet is the authority on what is
 * running, and `runner_needed` has already placed the box by the time we get
 * here. So a failure to record must never fail the dispatch — refusing to run a
 * successfully allocated box would strand it, which is the exact harm the claim
 * exists to make visible. Logged at warn: the box runs unattributed, which is a
 * degraded state worth seeing, not a failure.
 */
async function claimBox(db: WatcherDb, vmid: number, runnerJobId: string): Promise<boolean> {
	try {
		const claimed = await claimRunnerBox(db, vmid, runnerJobId);
		if (!claimed) {
			// claimRunnerBox gates on `allocatable`, so a false here means the fleet
			// handed back a vmid the inventory does not consider allocatable — the #78
			// condition, reached from the dispatch side.
			log("warn", "runner.claim_rejected", {
				vmid,
				runner_job_id: runnerJobId,
				hint: "vmid is not an allocatable box in the inventory; it will run unattributed",
			});
		}
		return claimed;
	} catch (err) {
		log("warn", "runner.claim_failed", { vmid, cause: errorMessage(err) });
		// An ERRORED claim is not a proven absence of one: the write may have landed
		// before the failure. Report it as claimed so the reap path stays scoped
		// rather than falling back to an unconditional release.
		return true;
	}
}
