import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { and, eq, notInArray } from "drizzle-orm";
import type { JobTemplateConfig, RepositoryConfig, WatcherConfig } from "../config/schema";
import type { ControlSurfaceDecision } from "../control-surface/pass";
import type { WatcherDb } from "../db/client";
import { createPendingJob, hasLiveJobForItem } from "../db/repos";
import { jobs } from "../db/schema";
import { hasOpenVerbDispatch } from "../forge/actions-store";
import type { ForgeResponse } from "../forge/boundary";
import { log, traced } from "../log";
import type { BodyLandingStager } from "../prepush/stage";
import { type DispatchOutcome, dispatchJob } from "../runner/dispatch";
import { type PassBudget, settleReservation } from "../runner/pass-budget";
import type { PassVmids } from "../runner/pass-vmids";
import type { RenderedDispatch } from "../runner/route";
import { SCRIPT_RUNTIME } from "../runner/script-route";
import type { VerbWorkflowDispatch } from "../hooks/verb";
import type { RunnerTransport } from "../runner/transport";
import { isFullGitSha, VERB_CHANGE_BASE_REPOSITORY } from "./verb-base";
import { renderVerbScriptBody } from "./verb-body";
import { prepareVerbDispatch } from "./verb-bootstrap";
import { isVerbId, VERB_TARGET_REPOSITORY, type VerbId } from "./verb-dispatch";
import type { RedeployConsumption } from "./verb-redeploy";

/** The one bounded forge read this module needs: the k3s-deploy branch head. */
export interface VerbForgeReader {
	get<T>(pathOrUrl: string): Promise<ForgeResponse<T>>;
}

// Re-exported so the verb lane has ONE import surface: the body renderer lives in
// its own module because it is a large fixed literal with its own invariants, but
// a caller reasoning about verb dispatch should not have to know that.
export { renderVerbScriptBody } from "./verb-body";

/** The manifest bytes and digest bound into one runner submission. */
export interface VerbManifest {
	content: string;
	sha256: string;
}

/** The bounded result of loading an operator-configured rails manifest. */
export type VerbManifestLoadResult =
	| { ok: true; manifest: VerbManifest }
	| { ok: false; reason: "manifest contains a NUL byte" };

/** Read the explicitly configured manifest and bind its exact bytes to a digest. */
export const loadVerbManifest = traced(
	"jobs.loadVerbManifest",
	async function loadVerbManifest(path: string): Promise<VerbManifestLoadResult> {
		const bytes = await readFile(path);
		if (bytes.includes(0)) return { ok: false, reason: "manifest contains a NUL byte" };
		return {
			ok: true,
			manifest: {
				content: bytes.toString("utf8"),
				sha256: createHash("sha256").update(bytes).digest("hex"),
			},
		};
	},
	// The result carries the manifest's RAW BYTES under the non-secret key
	// `content`, so summarize() has no key to match on. Rails manifest content is
	// arbitrary operator-authored config; it is not summarized onto the wire.
	{ redact: { result: true } },
);

export interface VerbLiveDispatchArgs {
	db: WatcherDb;
	transport: RunnerTransport;
	config: WatcherConfig;
	repo: RepositoryConfig;
	repositoryId: number;
	itemId: number;
	decision: ControlSurfaceDecision;
	manifest: VerbManifest;
	/** The watcher-resolved verification remote for the fixed k3s-deploy target. */
	targetRemote: string | null;
	/**
	 * The bounded forge read used to resolve the k3s-deploy base at dispatch.
	 * READ-ONLY and deliberately narrowed to `get`: this module still
	 * owns no branch writer and no forge-write credential, and the narrow type is
	 * what makes that visible at the boundary rather than only in prose.
	 */
	forge?: VerbForgeReader;
	/**
	 * The shared body-only landing seam. The rendered verb body is ~28k
	 * and mcp2cli refuses an inline `params.job` over 10,000 chars, so the full
	 * contract is landed as the job-scoped `job.md` on the share and only a tiny
	 * digest-bound bootstrap travels inline. Absent, the lane SKIPS rather than
	 * submitting a body the transport would refuse after allocating a box.
	 */
	bodyLandingStager?: BodyLandingStager;
	/**
	 * The CONSUMED operator re-run signal for this dispatch, when one was
	 * consumed this pass. Present only after `redeploy:<app>` was already REMOVED
	 * from the forge — see `jobs/verb-redeploy.ts` for why consume-before-dispatch
	 * is the ordering and what a crash between the two costs.
	 *
	 * Its whole effect here is to move this dispatch to its own point in the dedup
	 * key space via `dedupSha`. NOTHING about the terminal row it re-runs past is
	 * touched: no sha is rekeyed, no status is rewritten, no row is deleted.
	 */
	redeploy?: RedeployConsumption;
	/** Clock seam shared with pending-row due selection and dispatch timestamps. */
	now?: Date;
	/**
	 * The vmids the SWEEP has already handed to a dispatch.
	 *
	 * This lane is one HALF of the observed collision: on the first `deploy:hello`
	 * citizenship run the `newapp` verb job and a concurrent
	 * `infra-static` job were each handed VMID 9001 by the gateway's `needed()`,
	 * which reports a warm box without reserving it. Sharing ONE ledger with
	 * `dispatchPendingJobs` is what makes the de-dup cover a cross-lane collision
	 * and not just an intra-batch one. Omitted, this lane de-dups nothing, which is
	 * the pre-sf#299 behaviour every existing caller keeps.
	 */
	passVmids?: PassVmids;
	/**
	 * The dispatch slots the SWEEP has left this pass. Spent at the moment
	 * this lane is about to place a box, so the operator's `MAX_DISPATCH_PER_PASS`
	 * bounds the WHOLE pass and not only the generic lane that runs after this one.
	 * A spent budget skips the dispatch and leaves the row pending and due; it is
	 * re-dispatched by the pending-recovery path next pass. Omitted, this lane is
	 * unbounded here — the pre-sf#445 shape a direct caller keeps.
	 */
	passBudget?: PassBudget;
	/**
	 * The verb.yml dispatcher (`src/hooks/verb.ts`). Used ONLY when the
	 * repository sets `verb_runtime: actions`; absent there, the lane skips rather
	 * than falling back to a box. The box path never reads it.
	 */
	verbDispatch?: VerbWorkflowDispatch;
}

/**
 * The sha this dispatch occupies in the `(repository, item, sha, job_type)` dedup
 * key — the manifest digest normally, and a consumed re-run's own run-scoped sha
 * when the operator asked for one.
 *
 * ONE accessor, used at every key site, because the defect this shape prevents is
 * a dispatch that CREATES its row under the run sha and then READS it back under
 * the manifest sha: the read finds nothing, the outcome reports "could not be read
 * back", and the job sits pending forever. Reading the key from two places is how
 * that happens, so there is only one place.
 *
 * It is ALSO the value rendered into the body as `dispatch_sha` and echoed by the
 * box into its result, which `results/store.ts matchesExpectedIdentity` compares
 * against this row's `sha`. Deriving both from this one accessor is what keeps a
 * re-run's identity check self-consistent.
 */
function dedupSha(args: VerbLiveDispatchArgs): string {
	return args.redeploy?.runSha ?? args.manifest.sha256;
}

/** The validated verb decision fields the runner job body carries. */
type ResolvedVerb = {
	verb: VerbId;
	itemNumber: number;
	app: string;
};

function resolvedVerb(decision: ControlSurfaceDecision): ResolvedVerb | null {
	const verb = decision.decision.job;
	const app = decision.decision.parameter;
	if (verb === null || !isVerbId(verb)) return null;
	if (!Number.isInteger(decision.item) || decision.item < 1) return null;
	if (typeof app !== "string" || app.length === 0) return null;
	return { verb, itemNumber: decision.item, app };
}

/**
 * Read the live head commit of `rtech/k3s-deploy`'s default branch.
 *
 * This is the base the rendered change must descend from, and it is resolved
 * HERE — at dispatch, by the watcher, from the forge — so that
 * `change-verifier` compares a returned bundle against a commit the watcher
 * chose rather than one the runner named. A runner that could declare its own
 * base could prove any tree it liked descends from it.
 *
 * Returns `null` on any fault (no client, a non-2xx, an unexpected payload). The
 * caller then SKIPS the dispatch: a verb job with no trustworthy base would have
 * every bundle rejected `base_sha_mismatch`, and that failure would read as a
 * runner defect rather than as the missing precondition it is.
 */
export const resolveK3sBaseSha = traced(
	"jobs.resolveK3sBaseSha",
	async function resolveK3sBaseSha(
		forge: VerbForgeReader | undefined,
		branch = "main",
	): Promise<string | null> {
		if (forge === undefined) return null;
		try {
			// `ForgeResponse` reports `status`, NOT an `ok` boolean — checked against
			// `src/forge/boundary.ts` rather than assumed, because `if (!res.ok)` on a
			// response with no such field is always false and would accept every error
			// body as a base.
			const res = await forge.get<{ commit?: { id?: unknown } }>(
				`/repos/${VERB_TARGET_REPOSITORY}/branches/${branch}`,
			);
			if (res.status < 200 || res.status >= 300) return null;
			const id = res.data?.commit?.id;
			return typeof id === "string" && isFullGitSha(id) ? id : null;
		} catch {
			return null;
		}
	},
	// `forge` is the credentialed forge client; a plain-object implementation
	// would be recursed into, and its bearer token has no guaranteed secret key.
	{ redact: { args: [0] } },
);

interface PendingVerbJob {
	id: number;
	sha: string;
	jobType: string;
	nextAttemptAt: Date | null;
	changeBaseRepository: string | null;
	changeBaseSha: string | null;
}

async function findPendingVerbJob(
	db: WatcherDb,
	args: { repositoryId: number; itemId: number; verb: VerbId },
): Promise<PendingVerbJob | null> {
	const [row] = await db
		.select({
			id: jobs.id,
			sha: jobs.sha,
			jobType: jobs.jobType,
			nextAttemptAt: jobs.nextAttemptAt,
			changeBaseRepository: jobs.changeBaseRepository,
			changeBaseSha: jobs.changeBaseSha,
		})
		.from(jobs)
		.where(
			and(
				eq(jobs.repositoryId, args.repositoryId),
				eq(jobs.itemId, args.itemId),
				eq(jobs.jobType, args.verb),
				eq(jobs.status, "pending"),
			),
		)
		.limit(1);
	return row ?? null;
}

type ReadyVerbBody = { body: string; k3sBaseSha: string } | { skip: string };

/** Render against one watcher-chosen base, failing closed before dispatch. */
function renderVerbBody(
	args: VerbLiveDispatchArgs,
	resolved: ResolvedVerb,
	k3sBaseSha: string,
): ReadyVerbBody {
	const enginePath = args.config.verbEnginePath;
	const k3sCheckoutPath = args.config.verbK3sCheckoutPath;
	if (enginePath === undefined || k3sCheckoutPath === undefined) {
		return { skip: "verb share checkout paths are not configured" };
	}
	const body = renderVerbScriptBody({
		verb: resolved.verb,
		repository: args.repo.name,
		itemNumber: resolved.itemNumber,
		app: resolved.app,
		// The manifest BYTES are the real bytes, always — the body writes them to
		// disk and asserts their on-box digest, which `renderVerbScriptBody`
		// recomputes from the bytes themselves and never from this field. The
		// `sha256` carried here is the DEDUP sha, because it is rendered as the
		// body's `dispatch_sha` and echoed back for the identity check, which
		// compares against this job row's `sha`. A re-run whose row sha and
		// `dispatch_sha` disagreed would file every result `INVALID_RESULT_IDENTITY`.
		manifest: { content: args.manifest.content, sha256: dedupSha(args) },
		k3sBaseSha,
		enginePath,
		k3sCheckoutPath,
	});
	return body === null ? { skip: "verb job body could not be rendered" } : { body, k3sBaseSha };
}

/** Resolve a fresh base, then render before a new row can claim the dedup key. */
async function newVerbBody(
	args: VerbLiveDispatchArgs,
	resolved: ResolvedVerb,
): Promise<ReadyVerbBody> {
	const k3sBaseSha = await resolveK3sBaseSha(args.forge);
	if (k3sBaseSha === null) {
		return { skip: "k3s-deploy base sha could not be resolved" };
	}
	return renderVerbBody(args, resolved, k3sBaseSha);
}

/** The stored base a re-pended verb must keep using, or null on row drift. */
function pendingVerbBase(job: PendingVerbJob): string | null {
	if (job.changeBaseRepository !== VERB_CHANGE_BASE_REPOSITORY) return null;
	return job.changeBaseSha !== null && isFullGitSha(job.changeBaseSha) ? job.changeBaseSha : null;
}

/** Render a persisted pending row against the exact base stored with that row. */
function bodyForPendingVerb(
	args: VerbLiveDispatchArgs,
	resolved: ResolvedVerb,
	job: PendingVerbJob,
): ReadyVerbBody {
	const k3sBaseSha = pendingVerbBase(job);
	if (k3sBaseSha === null) return { skip: "pending verb job has no valid change base" };
	return renderVerbBody(args, resolved, k3sBaseSha);
}

/** Match the generic pass's due predicate exactly: null or at/before this pass. */
function pendingVerbIsDue(job: PendingVerbJob, now: Date): boolean {
	return job.nextAttemptAt === null || job.nextAttemptAt.getTime() <= now.getTime();
}

interface DispatchPendingVerbOptions {
	args: VerbLiveDispatchArgs;
	resolved: ResolvedVerb;
	template: JobTemplateConfig;
	job: PendingVerbJob;
	body: string;
	now: Date;
}

/**
 * Land the full rendered body on the share and answer with the tiny bootstrap.
 *
 * THIS is the boundary that owns knowing the body is a verb job body, which is
 * why the staging call sits here and not inside the transport: the transport's
 * contract stays "submit what you are given". A rendered verb body is ~28k and
 * mcp2cli refuses an inline `params.job` over 10,000 chars, so submitting it
 * inline burned an allocated box twice on the first citizenship run.
 * Staging is UNCONDITIONAL — see `prepareVerbDispatch` for why
 * one path beats a boundary case at the cap.
 *
 * A landing fault returns `null`, which `dispatchJob` treats exactly as an
 * unrenderable body: release the claim and skip, before any box is allocated.
 * That is stricter than the inline path it replaces, which could only fail after
 * a box was already running.
 *
 * The bootstrap declares `runtime: SCRIPT_RUNTIME` and `resolveRuntimeRoute`
 * attaches `SCRIPT_ROUTE` plus the cliproxyapi endpoint, which is what
 * `scriptRouteViolation` now requires — an agentless route is what the box needs
 * to `/bin/bash` the staged contract at all.
 */
function verbRenderDispatch(
	stager: BodyLandingStager,
	body: string,
): (jobType: string, context: unknown, runnerJobId: string) => Promise<RenderedDispatch | null> {
	return async (_jobType, _context, runnerJobId) => {
		const prepared = await prepareVerbDispatch({ stager, runnerJobId, body });
		if (!prepared.ok) {
			log("warn", "verb.dispatch.staging_failed", {
				runner_job_id: runnerJobId,
				cause: prepared.reason,
			});
			return null;
		}
		return { body: prepared.bootstrap, runtime: SCRIPT_RUNTIME };
	};
}

/** Dispatch one due pending row through the one verb-only body/runtime renderer. */
async function dispatchPendingVerb(options: DispatchPendingVerbOptions): Promise<DispatchOutcome> {
	const { args, resolved, template, job, body, now } = options;
	if (!pendingVerbIsDue(job, now)) {
		return { status: "skipped", reason: "pending verb job is not due" };
	}
	// FAIL CLOSED before the claim: a verb lane with no stager cannot land its body
	// and must never fall back to an inline submission the transport would refuse.
	if (args.bodyLandingStager === undefined) {
		return { status: "skipped", reason: "verb dispatch requires a body-landing stager" };
	}
	// The sweep's shared per-pass slot, reserved here because this is the
	// last gate before a box is placed: a skip above this line spent nothing. The
	// reservation is settled against the outcome: refunded only when the dispatch
	// PROVES it placed no box (same-pass vmid refusal, a refusal that placed
	// nothing, a route or claim refusal), kept when a box was placed and kept on a
	// THROW, which cannot prove the box is not running (PR #680 review, round 3).
	if (args.passBudget !== undefined && !args.passBudget.take()) {
		return {
			status: "skipped",
			reason: "pass dispatch budget exhausted (MAX_DISPATCH_PER_PASS); row stays pending and due",
		};
	}
	const outcome = await dispatchJob({
		db: args.db,
		transport: args.transport,
		job: {
			id: job.id,
			sha: job.sha,
			jobType: job.jobType,
			repository: args.repo.name,
			provider: args.repo.provider,
			itemNumber: resolved.itemNumber,
			staticOnly: args.repo.checks === "static-only",
		},
		template,
		now,
		renderDispatch: verbRenderDispatch(args.bodyLandingStager, body),
		// The sweep's same-pass vmid ledger, when the sweep supplied one.
		...(args.passVmids ? { passVmids: args.passVmids } : {}),
	});
	settleReservation(args.passBudget, outcome);
	return outcome;
}

/** Read the one live pending verb row for this item, regardless of manifest revision. */
function matchingPendingVerbJob(
	args: VerbLiveDispatchArgs,
	resolved: ResolvedVerb,
): Promise<PendingVerbJob | null> {
	return findPendingVerbJob(args.db, {
		repositoryId: args.repositoryId,
		itemId: args.itemId,
		verb: resolved.verb,
	});
}

const LIVE_JOB_STATUSES = ["pending", "dispatching", "running"] as const;
const SUPERSEDED_REASON = "superseded by manifest change";
const MISSING_BASE_REASON = "missing change base (pre-migration)";
const TERMINAL_REASON_MAX_CHARS = 300;

function pendingRecoveryFailure(job: PendingVerbJob, manifestSha: string): string | null {
	if (job.sha !== manifestSha) return SUPERSEDED_REASON;
	return pendingVerbBase(job) === null ? MISSING_BASE_REASON : null;
}

/** Keep the failed legacy row while freeing the current manifest's unique tuple. */
function terminalizedSha(job: PendingVerbJob, manifestSha: string): string {
	if (job.sha !== manifestSha) return job.sha;
	return createHash("sha256").update(`${job.sha}:failed:${job.id}`).digest("hex");
}

async function terminalizePendingVerbJob(options: {
	args: VerbLiveDispatchArgs;
	job: PendingVerbJob;
	reason: string;
	now: Date;
}): Promise<void> {
	const { args, job, reason, now } = options;
	const failed = await args.db
		.update(jobs)
		.set({
			sha: terminalizedSha(job, dedupSha(args)),
			status: "failed",
			terminalReason: reason.slice(0, TERMINAL_REASON_MAX_CHARS),
			activeAttemptId: null,
			nextAttemptAt: null,
			updatedAt: now,
		})
		.where(and(eq(jobs.id, job.id), eq(jobs.status, "pending")))
		.returning({ id: jobs.id });
	if (failed.length === 0) return;
	log("warn", "verb.pending_terminalized", { job_id: job.id, cause: reason });
}

/**
 * The terminal statuses that mean this manifest's work actually LANDED.
 *
 * Only a `completed` row proves the verb ran to a real verdict for this exact
 * manifest. Every other terminal status is a row that STOPPED — it never
 * produced the change the item is still asking for, and saying otherwise is the
 * mislabel this constant exists to prevent.
 */
const SUCCEEDED_JOB_STATUSES = ["completed"] as const;

/** The terminal row (if any) occupying this manifest's unique tuple. */
async function terminalVerbTupleRow(
	args: VerbLiveDispatchArgs,
	resolved: ResolvedVerb,
): Promise<{ id: number; status: string } | null> {
	const [row] = await args.db
		.select({ id: jobs.id, status: jobs.status })
		.from(jobs)
		.where(
			and(
				eq(jobs.repositoryId, args.repositoryId),
				eq(jobs.itemId, args.itemId),
				eq(jobs.sha, dedupSha(args)),
				eq(jobs.jobType, resolved.verb),
				notInArray(jobs.status, [...LIVE_JOB_STATUSES]),
			),
		)
		.limit(1);
	return row ?? null;
}

async function recoverPendingVerb(options: {
	args: VerbLiveDispatchArgs;
	resolved: ResolvedVerb;
	template: JobTemplateConfig;
	now: Date;
}): Promise<DispatchOutcome | null> {
	const job = await matchingPendingVerbJob(options.args, options.resolved);
	if (job === null) return null;
	const failure = pendingRecoveryFailure(job, dedupSha(options.args));
	if (failure === null) return redispatchExistingVerb({ ...options, job });
	await terminalizePendingVerbJob({ args: options.args, job, reason: failure, now: options.now });
	return null;
}

/**
 * The outcome for a dispatch whose row could not be read back as pending.
 *
 * THE HONESTY BOUNDARY, and the whole of what sf#302 owes this path. Only a
 * SUCCEEDED row may be reported as "already completed": that status is the one
 * proof this manifest's work actually LANDED. A terminal row in any other state
 * STOPPED without producing the change the item is still asking for, and calling
 * that "completed" tells an operator the verb landed when it failed — the R9-F-B
 * mislabel this function exists to prevent.
 *
 * Both terminal branches are a SKIP, not an error: the tuple is legitimately
 * occupied and this pass has nothing further to do. The non-success branch names
 * the real status so the reason itself carries the diagnosis.
 *
 * NEITHER BRANCH RE-RUNS. A terminal tuple stays terminal here, exactly as on
 * `origin/main`, and `jobs.sha` — which is also the identity anchor
 * `results/store.ts matchesExpectedIdentity` checks a runner's self-reported
 * `dispatch_sha` against — is never mutated. The operator re-run policy is
 * deferred to sf#305 (`_DOCS/decisions-ledger.md` L-017): a genuine reset signal
 * is required, and this boundary carries no flip-vs-refire distinguisher.
 */
function unreadableVerbOutcome(options: {
	created: boolean;
	terminal: { id: number; status: string } | null;
}): DispatchOutcome {
	const { created, terminal } = options;
	if (!created && terminal !== null) {
		if ((SUCCEEDED_JOB_STATUSES as readonly string[]).includes(terminal.status)) {
			return { status: "skipped", reason: "verb already completed for this manifest" };
		}
		// Name the REAL terminal state. Never "already completed" for a row that
		// stopped without landing the change.
		return {
			status: "skipped",
			reason: `verb job for this manifest is terminal (${terminal.status})`,
		};
	}
	const reason = created
		? "created verb job could not be read back"
		: "existing verb job could not be read back";
	return { status: "error", reason };
}

/** Insert the pending row, or name honestly what already holds its tuple. */
async function createVerbJob(options: {
	args: VerbLiveDispatchArgs;
	resolved: ResolvedVerb;
	k3sBaseSha: string;
}): Promise<{ job: PendingVerbJob } | { outcome: DispatchOutcome }> {
	const { args, resolved, k3sBaseSha } = options;
	const created = await createPendingJob(args.db, {
		repositoryId: args.repositoryId,
		itemId: args.itemId,
		sha: dedupSha(args),
		jobType: resolved.verb,
		changeBaseRepository: VERB_CHANGE_BASE_REPOSITORY,
		changeBaseSha: k3sBaseSha,
	});
	const job = await matchingPendingVerbJob(args, resolved);
	if (job !== null) return { job };

	// The tuple is held by something that is not pending. Read the terminal row
	// ONLY to name its real state in the outcome — it is never freed or rekeyed.
	const terminal = await terminalVerbTupleRow(args, resolved);
	return { outcome: unreadableVerbOutcome({ created, terminal }) };
}

/** Dispatch an existing row after re-rendering from its persisted base. */
async function redispatchExistingVerb(options: {
	args: VerbLiveDispatchArgs;
	resolved: ResolvedVerb;
	template: JobTemplateConfig;
	job: PendingVerbJob;
	now: Date;
}): Promise<DispatchOutcome> {
	const ready = bodyForPendingVerb(options.args, options.resolved, options.job);
	if ("skip" in ready) return { status: "skipped", reason: ready.skip };
	return dispatchPendingVerb({ ...options, body: ready.body });
}

/**
 * Hand one verb to the verb.yml Forgejo Actions lane instead of a box.
 * The base is the same watcher-resolved k3s-deploy head the box path uses; no
 * job row is written and no box is placed, so every outcome is `provenNoBox`.
 *
 * Two guards run before the dispatch. A live or pending BOX row for this verb
 * holds the item until it settles (a runtime flip never strands it; its
 * terminalisation is 829d). And the dedup is forge_runs: a non-failed verb.yml
 * record for the same (repo, item, verb, manifest) means this item was already
 * handed over, so a re-surface (the propose comment bumps updated_at) skips.
 * A successful dispatch reports `skipped` with a `dispatched:` reason because
 * the `dispatched` outcome requires a runner job id and vmid this path has not.
 */
async function dispatchVerbActions(
	args: VerbLiveDispatchArgs,
	resolved: ResolvedVerb,
): Promise<DispatchOutcome> {
	if (args.verbDispatch === undefined) {
		return { status: "skipped", reason: "verb actions dispatcher is not wired", provenNoBox: true };
	}
	if (await hasLiveJobForItem(args.db, args.repositoryId, args.itemId, resolved.verb)) {
		return { status: "skipped", reason: "box verb row still live; flip waits", provenNoBox: true };
	}
	const key = {
		repo: args.repo.name,
		item: resolved.itemNumber,
		verb: resolved.verb,
		manifestSha: args.manifest.sha256,
	};
	if (await hasOpenVerbDispatch(args.db, key)) {
		return {
			status: "skipped",
			reason: "verb already dispatched to Actions for this manifest",
			provenNoBox: true,
		};
	}
	const baseSha = await resolveK3sBaseSha(args.forge);
	if (baseSha === null) {
		return { status: "skipped", reason: "verb k3s-deploy base unresolvable", provenNoBox: true };
	}
	const ok = await args.verbDispatch({
		verb: resolved.verb,
		repo: args.repo.name,
		item: resolved.itemNumber,
		app: resolved.app,
		manifestSha: args.manifest.sha256,
		baseSha,
	});
	return ok
		? {
				status: "skipped",
				reason: "dispatched: verb handed to Forgejo Actions (verb.yml)",
				provenNoBox: true,
			}
		: { status: "error", reason: "verb actions dispatch failed", provenNoBox: true };
}

/**
 * Persist and dispatch one allowlisted deterministic verb through the normal
 * runner job path.
 *
 * This module still owns no branch writer and no forge-WRITE credential. sf#301
 * adds exactly one forge READ — the k3s-deploy branch head — because the base a
 * returned change must descend from has to be chosen by the watcher, not named
 * by the runner. Rails evaluation, branch push, and the proposal remain
 * watcher-owned in `results/proposal-pass` and are untouched here.
 */
export const dispatchVerbLive = traced(
	"jobs.dispatchVerbLive",
	async function dispatchVerbLive(args: VerbLiveDispatchArgs): Promise<DispatchOutcome> {
		const resolved = resolvedVerb(args.decision);
		if (resolved === null) return { status: "skipped", reason: "decision is not a verb job" };
		if (args.targetRemote === null) {
			return {
				status: "skipped",
				reason: "verb target remote unresolvable: no forgejo deployment",
			};
		}
		const template = args.config.job_templates.find(({ id }) => id === resolved.verb);
		if (template === undefined) {
			return { status: "skipped", reason: `verb template is not enabled: ${resolved.verb}` };
		}
		if (args.repo.verb_runtime === "actions") return dispatchVerbActions(args, resolved);
		const now = args.now ?? new Date();
		// A CONSUMED re-run checks the live guard FIRST. The ordinary path
		// runs pending-recovery first so a stalled pending row is re-dispatched or
		// honestly terminalized, and that is right when this pass owns the row. It is
		// WRONG for a re-run: `recoverPendingVerb` matches on (repository, item, verb)
		// regardless of sha, so a healthy pending row carrying the manifest sha would
		// read as `job.sha !== dedupSha` — SUPERSEDED — and be terminalized to make way
		// for the re-run. That destroys queued work the operator never asked to cancel.
		//
		// With a live job present the re-run is simply redundant and skips. The signal
		// is already consumed, which is the honest outcome: the operator asked for a run
		// and a run is in flight. Nothing is terminalized and nothing is re-keyed.
		if (
			args.redeploy !== undefined &&
			(await hasLiveJobForItem(args.db, args.repositoryId, args.itemId, resolved.verb))
		) {
			return { status: "skipped", reason: "verb job already live for item" };
		}
		const recovered = await recoverPendingVerb({ args, resolved, template, now });
		if (recovered !== null) return recovered;
		if (await hasLiveJobForItem(args.db, args.repositoryId, args.itemId, resolved.verb)) {
			return { status: "skipped", reason: "verb job already live for item" };
		}
		const ready = await newVerbBody(args, resolved);
		if ("skip" in ready) return { status: "skipped", reason: ready.skip };
		const persisted = await createVerbJob({ args, resolved, k3sBaseSha: ready.k3sBaseSha });
		if ("outcome" in persisted) return persisted.outcome;
		return redispatchExistingVerb({ args, resolved, template, job: persisted.job, now });
	},
	// `args` is one object carrying `config: WatcherConfig` (forge tokens),
	// `transport`, `db`, and `forge` — every credentialed seam this lane holds,
	// several under non-secret keys summarize() cannot match.
	{ redact: { args: [0] } },
);
