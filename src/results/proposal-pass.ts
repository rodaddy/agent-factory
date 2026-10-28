/**
 * @module results/proposal-pass
 * @description The missing link in the implement lane: turn an ACCEPTED
 *   change result into a pushed watcher-derived branch and a queued proposal
 *   plan.
 *
 *   Everything either side of this already existed and was tested in isolation —
 *   `verifyChangeBundle` proves a bundle safe, `pushVerifiedBranch` pushes one
 *   non-force ref, `publishProposal` opens the draft PR — and NOTHING called the
 *   first two, so an implement result was ingested, the job was marked completed,
 *   and no branch or proposal ever appeared. Two independent review lanes found
 *   that on PR #83; this module is what closes it.
 *
 *   WHY THIS IS NOT IN THE INGEST TRANSACTION. Pushing a branch is network I/O.
 *   `DbResultStore.persist` holds a `FOR UPDATE` lock on the job row so a stale
 *   attempt cannot terminate a live re-run; doing a git push inside that lock
 *   would block every concurrent dispatch for the duration of a network round
 *   trip and risk a transaction timeout part-way through a push. So the
 *   transaction records the accepted result, and this bounded pass — running in
 *   the same reconciliation cycle, after ingest — performs the push and queues
 *   the plan.
 *
 *   ORDERING IS THE SAFETY PROPERTY. Rails must pass BEFORE any branch push,
 *   and the branch must exist BEFORE a proposal plan is queued: a violating
 *   change must write no remote ref, and a plan whose head branch is absent would
 *   have the publisher open a PR against a nonexistent ref. So rails gate the
 *   push, the plan is persisted only after `pushVerifiedBranch` reports `pushed`.
 *   A rail refusal writes neither remote side effect and stays visible in the
 *   bounded watcher report.
 *
 * @outputs
 *   - `runProposalPass` -- push verified changes and queue their proposal plans
 *   - `ProposalPassSummary` -- bounded per-pass counters, safe to log
 *
 * @dependencies
 *   - ../db/schema -- jobs / job_attempts / repositories / github_items
 *   - ../github/publication -- the watcher-derived branch naming
 *   - ../github/base-branch -- the config-first, forge-fallback base resolution
 *   - ../rails/enforce -- the manifest-driven pre-push HOLD decision
 *   - ./branch-publisher -- the single non-force ref push
 */
import { and, asc, eq, gt, inArray, isNotNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { z } from "zod";
import type { WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import {
	githubItems,
	githubPostings,
	jobAttempts,
	jobs,
	repositories,
	resultPostings,
} from "../db/schema";
import type { ForgeClient } from "../forge/boundary";
import { resolveBaseBranch } from "../github/base-branch";
import { buildProposalPlan, proposalBranchFor } from "../github/publication";
import { persistPublicationPlan } from "../github/publish-plan";
import { dispatchedBaseForJob } from "../jobs/verb-base";
import { VERB_IDS } from "../jobs/verb-dispatch";
import { errorMessage, log, traced } from "../log";
import type { RailsEvaluation, RailsEvaluationInput } from "../rails/enforce";
import { IMPLEMENT_TEMPLATE_ID } from "../templates/registry";
import { type GitRunner, pushVerifiedBranch } from "./branch-publisher";
import { degradedFromTrail } from "./check-trail";
import { type ResultCheck, resultCheckSchema } from "./schema";

/** Cap on changes published per pass, so one cycle stays bounded. */
export const MAX_PROPOSALS_PER_PASS = 10;

/**
 * The job types whose runner output is a PROPOSED CHANGE rather than a report.
 *
 * Spelled as an explicit allowlist, never as "not a report lane": a template
 * added later produces no branch until someone names it here, which is the
 * failure direction that costs nothing. An audit or triage job joined to an item
 * produces findings, and pushing one would publish a proposal for a job that
 * never generated a bundle.
 *
 * The six verbs join the implement lane because `src/results/schema.ts` already
 * declares them change-capable and sf#301 gave them a verified change base — but
 * the loader was still hard-filtered to `implement-issue`, so a verb job that
 * completed with an ACCEPTED posting was invisible to every proposal cycle. Live
 * proof this was reachable, not theoretical: `rw-newapp-90531eaf` was accepted in
 * production on 2026-08-16 and produced no branch and no proposal.
 */
export const CHANGE_PRODUCING_JOB_TYPES: readonly string[] = [IMPLEMENT_TEMPLATE_ID, ...VERB_IDS];

/** Bounded per-pass counters. Safe to log as-is: no secrets, no free text. */
export interface ProposalPassSummary {
	/** Accepted change results considered this pass. */
	candidates: number;
	/** Branches pushed and proposal plans queued. */
	published: number;
	/** Candidates refused before any push (rails, unresolvable base, bad item number). */
	refused: number;
	/** Pushes the forge rejected, left for a later pass. */
	pushFailed: number;
}

/**
 * One accepted change, resolved from TRUSTED database state only.
 *
 * Every field here comes from the dispatch-side join — the repository, the item,
 * and the SHA the watcher itself dispatched. Nothing a runner returned is used
 * to decide what gets pushed or where; the runner's contribution is the verified
 * bundle bytes, and those were already confined and ancestry-proved by
 * `verifyChangeBundle` before this pass can see them.
 */
interface ProposalCandidate {
	jobId: number;
	attemptId: number;
	/**
	 * The DISPATCH identity's own database rows — `jobs.repository_id` and
	 * `jobs.item_id`, carried verbatim.
	 *
	 * Deliberately NOT resolved from `repository` / `itemNumber` above. Those two
	 * are the CHANGE identity, and for a verb candidate the change repository is
	 * `rtech/k3s-deploy` while the job row belongs to the managed repository whose
	 * issue carried the label. A follow-up job must be keyed to the row that
	 * exists — a lookup by change-repository name would either miss or, worse,
	 * find an unrelated repository row and file the job against it.
	 */
	repositoryId: number;
	itemId: number | null;
	repository: string;
	itemNumber: number;
	dispatchedBaseSha: string;
	snapshotPath: string;
	/** Rendered YAML injected by a caller that already owns the render boundary. */
	renderedArtifact?: string;
	/**
	 * The per-check trail of the ACCEPTED result, read back from the posting row
	 * that ingest wrote. Never re-read from the share: the runner owns the
	 * write side of its own output directory, so a re-read could return a trail
	 * that differs from the one gate 0 reconciled, and the PR body would then
	 * advertise verification nobody performed. Empty when the result carried no
	 * trail or the row predates the column.
	 */
	checks: readonly ResultCheck[];
	/**
	 * The job type of the row this candidate came from, read from `jobs.job_type`
	 * — trusted watcher state, never the runner-supplied `result.job_type`.
	 *
	 * Carried because a check allowance is SCOPED to the templates it names, so
	 * the display path cannot resolve one without knowing which template produced
	 * the trail. Resolving it blind rendered the implement lane's gitleaks reason
	 * into a verb proposal, which named a tool that lane never runs.
	 */
	jobType: string;
}

export interface ProposalPassDeps {
	db: WatcherDb;
	/**
	 * The forge client for a repository, used ONLY to read a default branch when
	 * config omits one. Resolved per candidate rather than bound once: a Forgejo
	 * repository and a GitHub repository need different clients and different
	 * credentials, and a deployment may manage both. Returns null when the
	 * provider has no usable token, and the candidate is refused rather than
	 * resolved against the wrong forge.
	 */
	clientFor(repository: string): Promise<ForgeClient | null>;
	/** The managed-repository config, source of the optional `proposal_base_branch`. */
	config: WatcherConfig;
	git: GitRunner;
	/** Resolve the push remote for a managed repository. Watcher-owned, never runner-supplied. */
	remoteFor(repository: string): string | null;
	/**
	 * The push credential for a repository. Never logged, never an argv element.
	 * Resolved per candidate for the same reason as the client: the token that can
	 * push to a Forgejo repo is not the one that can push to a GitHub repo. Null
	 * refuses the candidate rather than attempting an unauthenticated push.
	 */
	credentialFor(repository: string): Promise<string | null>;
	/** A watcher-owned scratch clone per invocation; see the FETCH_HEAD note below. */
	scratchRepoFor(repository: string): string;
	/**
	 * Prepare the scratch repository: create it if absent, and ensure it CONTAINS
	 * the dispatched base commit. Returns false when it cannot be prepared, and
	 * the candidate is refused rather than attempted.
	 *
	 * The base is not optional. A bundle can only be read by a repository that
	 * already has its prerequisites, so a fetch into an empty repo fails with
	 * "could not read the verified bundle" — and the ancestry re-check inside
	 * `pushVerifiedBranch` needs the base object present to resolve at all.
	 */
	ensureScratchRepo(
		dir: string,
		remote: string,
		baseSha: string,
		repository: string,
	): Promise<boolean>;
	/** Load accepted-but-unpublished change candidates. Injected for testability. */
	loadCandidates(limit: number): Promise<ProposalCandidate[]>;
	/** Override the rtech-infra-owned rails manifest path for this pass. */
	railsManifestPath?: string;
	/** Evaluate manifest rails against one rendered candidate artifact. */
	evaluateRails(input: RailsEvaluationInput): Promise<RailsEvaluation>;
	/** Materialize changed YAML from the verified bundle before any remote write. */
	loadRenderedArtifact?(input: {
		snapshotPath: string;
		scratchRepoDir: string;
		dispatchedBaseSha: string;
	}): Promise<string | null>;
	/**
	 * Queue the proposal plan AFTER a successful push.
	 *
	 * Deliberately NOT given the head branch: the plan builder re-derives it from
	 * the candidate's trusted item number and job type, and `publish.ts` re-derives
	 * it again at authorization. Passing a branch string here would invite a future caller to
	 * thread one through from somewhere less trustworthy.
	 *
	 * Returns whether a plan was actually persisted. This is NOT decoration: the
	 * candidate loader selects on the ABSENCE of a proposal posting, so a queuer
	 * that silently wrote nothing leaves the job eligible forever and the pass
	 * re-pushes it every cycle. A false here must be counted as a failure, not a
	 * publication.
	 */
	queueProposal(
		candidate: ProposalCandidate,
		baseBranch: string,
		headSha: string,
	): Promise<boolean>;
	/**
	 * Enqueue a repository-validation job against the PUSHED HEAD.
	 *
	 * The gap this closes: a proposed bundle is verified for provenance and scope
	 * by `verifyChangeBundle` — four fail-closed gates — and is then pushed and
	 * proposed without ever being compiled or tested. The receipt gate protects
	 * OUR pushes; nothing validated the RUNNER'S.
	 *
	 * The verdict does NOT come back through this pass and does NOT edit the
	 * proposal comment (controller ruling, option A, memo 6f2a93a). The enqueued
	 * job runs on the normal cycle and its outcome surfaces through the EXISTING
	 * exact-SHA check-run/report machinery bound to that head — no new publication
	 * kind, and the proposal comment is written once and never updated.
	 *
	 * REPORT-ONLY and NON-FATAL by construction. It is called only AFTER the push
	 * and the proposal plan have both succeeded, so a failure here cannot roll
	 * anything back — the branch exists and the proposal is queued whatever this
	 * returns. `false` is therefore logged and counted as nothing: a missing
	 * validate job is a GAP in the evidence, not a reason to re-push a branch that
	 * is already on the forge. Returning `true` means a new job row was created;
	 * `false` means one already existed for the same (repo, item, sha, type) key
	 * or none could be created.
	 *
	 * OPTIONAL so a caller that does not supply it is byte-identical to the pass
	 * before this ticket.
	 */
	enqueueValidation?(candidate: ProposalCandidate, headSha: string): Promise<boolean>;
	onError?: (error: Error) => void;
}

/**
 * Push every accepted change that has no branch yet, then queue its proposal.
 *
 * Bounded and isolated: one candidate's failure is counted and logged without
 * aborting the pass, matching how result reconciliation already treats a single
 * unreadable output.
 */
async function runProposalPassImpl(deps: ProposalPassDeps): Promise<ProposalPassSummary> {
	const summary: ProposalPassSummary = {
		candidates: 0,
		published: 0,
		refused: 0,
		pushFailed: 0,
	};

	const candidates = await deps.loadCandidates(MAX_PROPOSALS_PER_PASS);
	summary.candidates = candidates.length;

	for (const candidate of candidates) {
		try {
			await publishOneCandidate(deps, candidate, summary);
		} catch (err) {
			summary.pushFailed++;
			log("error", "proposal.failed", {
				job_id: candidate.jobId,
				cause: errorMessage(err),
			});
			reportError(deps.onError);
		}
	}

	return summary;
}

/**
 * `traced()` build-phase wrapper for {@link runProposalPassImpl}.
 *
 * `deps` carries no secret VALUE — `credentialFor` is a function, which
 * `summarize()` reduces to its type — so no argument mask is needed here.
 */
export const runProposalPass = traced(
	"results.runProposalPass",
	runProposalPassImpl,
) as typeof runProposalPassImpl;

/**
 * Prepare, rail-check, push, and queue ONE candidate, tallying its outcome.
 *
 * ORDER MATTERS: rails run before the remote write, and the branch is pushed
 * before a proposal plan is queued. A violation writes neither; a plan against a
 * branch that does not exist would point the publisher at nothing. Throws only on
 * an unexpected fault; the caller isolates it so one candidate cannot abort the
 * pass.
 */
async function publishOneCandidate(
	deps: ProposalPassDeps,
	candidate: ProposalCandidate,
	summary: ProposalPassSummary,
): Promise<void> {
	const prepared = await prepareProposal(deps, candidate);
	if (prepared.status === "refused") {
		summary.refused++;
		log("warn", "proposal.refused", {
			job_id: candidate.jobId,
			reason: prepared.reason,
		});
		return;
	}

	const rails = await evaluateCandidateRails(deps, candidate, prepared);
	if (rails.hold) {
		summary.refused++;
		log("warn", "proposal.rails_held", {
			job_id: candidate.jobId,
			violated: rails.violated,
			report: rails.report,
		});
		return;
	}
	log("info", "proposal.rails_checked", {
		job_id: candidate.jobId,
		examined: rails.examined,
		report: rails.report,
	});
	await pushAndQueueCandidate(deps, candidate, prepared, summary);
}

async function evaluateCandidateRails(
	deps: ProposalPassDeps,
	candidate: ProposalCandidate,
	prepared: ReadyProposal,
): Promise<RailsEvaluation> {
	const renderedArtifact =
		candidate.renderedArtifact ??
		(await deps.loadRenderedArtifact?.({
			snapshotPath: candidate.snapshotPath,
			scratchRepoDir: prepared.scratchRepoDir,
			dispatchedBaseSha: candidate.dispatchedBaseSha,
		}));
	return await deps.evaluateRails({
		manifestPath: deps.railsManifestPath,
		artifact: renderedArtifact ?? undefined,
	});
}

async function pushAndQueueCandidate(
	deps: ProposalPassDeps,
	candidate: ProposalCandidate,
	prepared: ReadyProposal,
	summary: ProposalPassSummary,
): Promise<void> {
	const { headBranch, baseBranch, remote, credential, scratchRepoDir } = prepared;
	const pushed = await pushVerifiedBranch({
		snapshotPath: candidate.snapshotPath,
		scratchRepoDir,
		dispatchedBaseSha: candidate.dispatchedBaseSha,
		itemNumber: candidate.itemNumber,
		jobType: candidate.jobType,
		remote,
		credential,
		git: deps.git,
	});
	if (pushed.status !== "pushed") {
		summary.pushFailed++;
		log("warn", "proposal.push_failed", {
			job_id: candidate.jobId,
			reason: pushed.reason,
		});
		return;
	}
	if (!(await deps.queueProposal(candidate, baseBranch, pushed.headSha))) {
		summary.pushFailed++;
		log("warn", "proposal.queue_failed", {
			job_id: candidate.jobId,
			branch: headBranch,
			reason: "branch was pushed but no proposal plan was persisted",
		});
		return;
	}
	// Validate the PROPOSAL, not the base. AFTER `queueProposal`, never
	// before: the queuer's false is what tells the pass "branch pushed but nothing
	// persisted", and that candidate stays eligible for the next cycle. Enqueuing
	// a validate job for a proposal that did not queue would file work against a
	// head no proposal points at. `summary` is deliberately not passed — this step
	// cannot change any counter.
	await enqueueValidationFor(deps, candidate, pushed.headSha);
	summary.published++;
	log("info", "proposal.queued", {
		job_id: candidate.jobId,
		branch: headBranch,
		base: baseBranch,
		head_sha: pushed.headSha,
	});
}

/**
 * Enqueue the pushed head's validation job, and NEVER fail the pass for it.
 *
 * By the time this runs the branch is on the forge and the proposal plan is
 * persisted — there is nothing left to roll back, and refusing to count the
 * publication would only leave the candidate loader re-pushing a branch that
 * already exists. So both a `false` return and a thrown error resolve to one
 * bounded warning, and no counter moves. A missing validate job is a GAP in the
 * evidence a human reviews, not a reason to undo a proposal.
 *
 * An absent dep is a silent no-op, so a caller that never wires one behaves
 * exactly as the pass did before this ticket.
 */
async function enqueueValidationFor(
	deps: ProposalPassDeps,
	candidate: ProposalCandidate,
	headSha: string,
): Promise<void> {
	if (deps.enqueueValidation === undefined) {
		return;
	}
	try {
		if (await deps.enqueueValidation(candidate, headSha)) {
			return;
		}
		log("warn", "proposal.validation_not_enqueued", {
			job_id: candidate.jobId,
			head_sha: headSha,
			reason: "no validation job row was created for the pushed head",
		});
	} catch (error) {
		log("warn", "proposal.validation_not_enqueued", {
			job_id: candidate.jobId,
			head_sha: headSha,
			reason: errorMessage(error),
		});
	}
}

/** Everything a verified change needs before its branch may be pushed. */
type PreparedProposal =
	| {
			status: "ready";
			headBranch: string;
			baseBranch: string;
			remote: string;
			credential: string;
			scratchRepoDir: string;
	  }
	| { status: "refused"; reason: string };

type ReadyProposal = Extract<PreparedProposal, { status: "ready" }>;

/**
 * Resolve the branch, base, remote, credential, and scratch repository one
 * candidate needs, or refuse with a bounded reason. Every leg FAILS CLOSED —
 * nothing here defaults to a plausible-looking value.
 */
async function prepareProposal(
	deps: ProposalPassDeps,
	candidate: ProposalCandidate,
): Promise<PreparedProposal> {
	// Re-derive the branch from the trusted item number and job type. This is the
	// same derivation `publish.ts` re-runs when it authorizes the plan, so the
	// two cannot disagree about what may be written.
	const headBranch = proposalBranchFor(candidate.itemNumber, candidate.jobType);
	if (headBranch === null) {
		return { status: "refused", reason: "item number does not yield a valid branch" };
	}

	// Config first, forge-read fallback, fail closed. Defaulting to `main`
	// would be a plausible-looking way to target the wrong branch in a
	// repository that uses something else. The configured value is looked up
	// against the trusted repository name, never against anything the runner
	// returned.
	const configured = deps.config.repositories.find(
		(repo) => repo.name === candidate.repository,
	)?.proposal_base_branch;
	const client = await deps.clientFor(candidate.repository);
	if (client === null) {
		return { status: "refused", reason: "no usable forge client for repository" };
	}
	const baseBranch = await resolveBaseBranch(client, candidate.repository, configured);
	if (baseBranch === null) {
		return { status: "refused", reason: "no resolvable proposal base branch" };
	}

	const remote = deps.remoteFor(candidate.repository);
	if (remote === null) {
		return { status: "refused", reason: "no push remote for repository" };
	}

	const credential = await deps.credentialFor(candidate.repository);
	if (credential === null) {
		return { status: "refused", reason: "no push credential for repository" };
	}

	// `pushVerifiedBranch` runs every git invocation IN this directory, and can
	// only READ the bundle from a repository that already holds the bundle's
	// prerequisite — the dispatched base. A missing scratch repo fails as a
	// spawn error and a baseless one as "could not read the verified bundle";
	// neither is the push rejection it looks like.
	const scratchRepoDir = deps.scratchRepoFor(candidate.repository);
	if (
		!(await deps.ensureScratchRepo(
			scratchRepoDir,
			remote,
			candidate.dispatchedBaseSha,
			candidate.repository,
		))
	) {
		return { status: "refused", reason: "could not prepare the publish scratch repository" };
	}

	return { status: "ready", headBranch, baseBranch, remote, credential, scratchRepoDir };
}

/**
 * Report one isolated failure without letting a faulty sink abort the pass.
 *
 * The message is a FIXED author string rather than the caught error's own: the
 * underlying cause is already logged with bounded redaction just above, and an
 * error sink is an operator-facing surface that must not become a path for
 * runner-influenced text.
 */
function reportError(sink: ((error: Error) => void) | undefined): void {
	try {
		sink?.(new Error("proposal publication failed for one change"));
	} catch (err) {
		log("debug", "proposal.sink_failed", { cause: errorMessage(err) });
	}
}

/**
 * The production proposal queuer: build the bounded plan and persist it.
 *
 * Deliberately re-derives the head branch inside `buildProposalPlan` rather than
 * trusting the one passed in, and `publish.ts` re-derives it a THIRD time when
 * it authorizes the row. Three independent derivations from the same trusted
 * trusted inputs cannot disagree about which ref may be written; a plan naming
 * anything else is refused rather than posted.
 *
 * A plan that cannot be built (a base that equals the head, an item number that
 * yields no branch) is dropped with a warning instead of persisting a row the
 * publisher would only refuse later.
 */
function createProposalQueuerImpl(
	db: WatcherDb,
	now: () => Date = () => new Date(),
): ProposalPassDeps["queueProposal"] {
	return async (candidate, baseBranch, headSha) => {
		// Re-derive the allowance uses from the PERSISTED trail with the same pure
		// function gate 0 used. Recomputing rather than persisting the verdict keeps
		// one source of truth for the policy: an allowance edited in source is
		// reflected in the body, and the flags shown can never drift from the rules
		// in force. The candidate only reached this pass because that gate returned
		// `ok`, so this recomputation is a display concern, not a second gate.
		//
		// Scoped by the candidate's `jobs.job_type` for the same reason the gate
		// scopes it: an allowance covers only the templates it names, and the same
		// (check, status) pair carries a DIFFERENT operator-facing reason on a verb
		// than on the implement lane. Passing the trusted job type is what keeps the
		// body's reason text true rather than merely first-in-list.
		const plan = buildProposalPlan(candidate.itemNumber, baseBranch, headSha, {
			jobType: candidate.jobType,
			checks: candidate.checks,
			degraded: degradedFromTrail(candidate.checks, candidate.jobType),
		});
		if (plan === null) {
			log("warn", "proposal.plan_refused", {
				job_id: candidate.jobId,
				reason: "item number and base branch do not yield a publishable proposal",
			});
			return false;
		}
		// Propagate, never swallow: the caller must tell "queued" from "wrote
		// nothing", because the loader's eligibility test is the ABSENCE of a
		// posting.
		//
		// `persistPublicationPlan` also returns false for an existing row that
		// already reached `posted`/`failed` (correctly refusing to re-arm it). That
		// case is UNREACHABLE from this pass — `createCandidateLoader` selects only
		// jobs with no `proposal` posting at all — so a false here means the insert
		// wrote nothing, not that a published proposal was rejected. If that loader
		// predicate is ever relaxed, this must distinguish the two or a converged
		// job will be re-pushed every cycle.
		return await persistPublicationPlan(db, candidate.jobId, plan, now());
	};
}

/** `traced()` build-phase wrapper for {@link createProposalQueuerImpl}. */
export const createProposalQueuer = traced(
	"results.createProposalQueuer",
	createProposalQueuerImpl,
) as typeof createProposalQueuerImpl;

/**
 * The production candidate loader: accepted CHANGE-PRODUCING attempts whose job
 * completed and which have no proposal plan yet.
 *
 * Selection is deliberately narrow, and each clause closes a way this pass could
 * push something it should not:
 *
 * - `jobs.status = completed` and `job_attempts.status = completed` — the result
 *   was accepted, identity-matched, and not superseded by a newer attempt.
 * - `result_postings.status = accepted` — the posting is THE one that transitioned
 *   the job, not merely one recorded under the attempt. Two hosts under one attempt
 *   can each verify and each record a posting; only the job-completing host's is
 *   `accepted`, so the runner cannot pick which verified tree is proposed.
 * - joined to a real item — an itemless job (a scheduled audit slot) has no
 *   proposal branch to derive and must never reach the push.
 * - `jobs.job_type IN (CHANGE_PRODUCING_JOB_TYPES)` — the implement lane and the
 *   six deterministic k3s verbs, the templates whose runner output is a proposed
 *   change rather than a report. An audit job that happens to be joined to an
 *   item produces findings, not a branch, and pushing one would publish a
 *   proposal for a job that never generated a bundle. Widened from
 *   `= implement-issue` by sf#303: a verb job could complete with an ACCEPTED
 *   posting and still never reach a branch or a proposal.
 * - a resolvable CHANGE BASE — enforced in JS by `dispatchedBaseForJob`, not in
 *   SQL, because the rule is per job type. A verb row whose change base is NULL,
 *   names a repository other than `rtech/k3s-deploy`, or carries anything but a
 *   full 40-hex sha is SKIPPED, exactly like a no-bundle implement row.
 * - NO existing `proposal` posting for the job — without this the pass would
 *   re-push every completed change on every cycle forever. The `github_postings`
 *   upsert would keep that idempotent at the plan layer, but the git push and
 *   the bundle read are real work and a re-push of an already-open proposal's
 *   branch is exactly the non-fast-forward rejection the publisher must never
 *   retry as a force.
 * - NOT SUPERSEDED by a newer sibling — a NEWER completed
 *   change-producing job for the same `(repository_id, item_id)` that has
 *   already POSTED its proposal owns the `rw/issue-<n>` ref, so this row's
 *   bundle can never legitimately become that item's proposal. Live: job 5107
 *   (`newapp`, bundle rendered against the pre-#853 base) logged
 *   `proposal.rails_held` on EVERY pass since 04:32Z on 2026-08-17, because the
 *   violation is IN its own proposed content and it therefore holds forever,
 *   while job 5123 — same item, fixed base — passed rails and posted. Two costs
 *   this closes: unbounded re-evaluation of a candidate that can never pass, and
 *   a latent collision, since a held candidate that ever DID pass later would
 *   push a stale tree at the ref the newer job already owns.
 *
 *   The predicate is narrow ON PURPOSE. It keys on a newer sibling's POSTING
 *   EXISTING, never on the held row's own age, backoff, or attempt count,
 *   because a held candidate with NO posted sibling MUST keep being re-selected
 *   every pass — that re-evaluation is how a fixed rails manifest eventually
 *   releases a held change, and it is load-bearing behavior. See
 *   `supersedingJobId` for the clause and its NULL-safety argument.
 *
 * KEYSET PAGINATION. Three of the filters above are enforced in JS, AFTER
 * the SQL page is cut: the accepted-target host parse, the verified-snapshot
 * `snapshotExists` check, and the change-base resolution. None can be a
 * SQL predicate — the target string is matched against the attempt's own
 * `runnerJobId`, the snapshot is a filesystem artifact the DB cannot see, and the
 * base rule branches on job type and on a hex-shape test. A baseless verb row is
 * therefore a PERMANENT JS drop of exactly the #91 shape, which is why it must be
 * seeked past rather than counted against the page. A completed implement job that
 * legitimately produced NO change matches the SQL WHERE forever (it has an
 * `accepted` posting but never a bundle, so `snapshotExists` is false and it is
 * dropped) yet never gets a `proposal` posting. With a single `.limit(limit)`
 * cut ordered by `jobs.id asc`, the oldest `limit` such no-change jobs
 * permanently fill the page and no younger real candidate is ever loaded — the
 * pass reports `candidates: N, published: 0` and looks healthy while starving.
 *
 * So the loader SEEKS past the JS-dropped rows: it pulls pages ordered by
 * `jobs.id asc`, each seeking past the last `jobs.id` it has seen, applying the
 * JS filters to every row, until it has `limit` real candidates or a short page
 * proves the rows are exhausted. `jobs.id` is a unique monotonic key and the
 * WHERE/order are stable within one call, so the cursor advances strictly and
 * cannot loop or re-emit a row. This changes ONLY which rows the loader
 * surfaces; the #90 accepted-posting join and every eligibility clause are
 * untouched.
 */
function createCandidateLoaderImpl(
	db: WatcherDb,
	snapshotPathFor: (jobRunnerId: string, hostname: string) => string,
	snapshotExists: (path: string) => Promise<boolean>,
): (limit: number) => Promise<ProposalCandidate[]> {
	return async (limit: number) => {
		const candidates: ProposalCandidate[] = [];
		if (limit <= 0) {
			return candidates;
		}
		// Page size is `limit`: each page can yield at most `limit` candidates, and
		// starting from a full page keeps the common case (no JS drops) a single
		// query. The seek cursor is the highest `jobs.id` any prior page returned.
		let cursor: number | null = null;

		while (candidates.length < limit) {
			const rows = await selectCandidatePage(db, limit, cursor);

			for (const row of rows) {
				// Advance the cursor for EVERY row the page returned, before any JS
				// filter can `continue` past it — otherwise a dropped row at the tail of
				// a page would be re-fetched by the next page and the loop would spin.
				cursor = row.jobId;

				// SUPERSESSION. A newer completed change-producing job for the
				// same item has already POSTED its proposal, so this older row's bundle
				// can never become the proposal for that item — the ref it would push to
				// is the newer job's. Skip it before any rails evaluation or snapshot
				// probe, and say so once per pass at `debug`.
				//
				// WHY `debug` AND NOT ONCE-ONLY: once-only needs state (a terminal marker
				// or an in-process seen-set), and a schema change was explicitly out of
				// scope while an in-process set is lost on every restart and would go
				// stale against a database another process writes. `debug` is the bounded
				// choice that needs no writer: the line is present when someone is looking
				// at a specific item and silent in normal operation.
				if (row.supersededByJobId !== null) {
					log("debug", "proposal.superseded", {
						job_id: row.jobId,
						superseded_by_job_id: row.supersededByJobId,
						repository_id: row.repositoryId,
						item_id: row.itemId,
					});
					continue;
				}

				const candidate = await candidateFromRow(row, snapshotPathFor, snapshotExists);
				if (candidate === null) {
					continue;
				}
				candidates.push(candidate);
				if (candidates.length >= limit) {
					break;
				}
			}

			// A short page means the WHERE has no more matching rows past the cursor:
			// the rows are exhausted, so stop even if the page under-filled `limit`.
			if (rows.length < limit) {
				break;
			}
		}
		return candidates;
	};
}

/** `traced()` build-phase wrapper for {@link createCandidateLoaderImpl}. */
export const createCandidateLoader = traced(
	"results.createCandidateLoader",
	createCandidateLoaderImpl,
) as typeof createCandidateLoaderImpl;

/**
 * The id of the NEWER change-producing job that has already posted a proposal
 * for this row's item, or NULL when none exists.
 *
 * A candidate is SUPERSEDED when every one of these holds for some other job:
 * it is NEWER by `jobs.id`, it is for the SAME `(repository_id, item_id)`, its
 * type is in `CHANGE_PRODUCING_JOB_TYPES`, its status is `completed`, and a
 * `proposal` row exists in `github_postings` for it. That last clause is the
 * whole point and the reason this is not simply "a newer sibling exists": a
 * held candidate whose newer sibling has NOT posted must keep being re-selected
 * every pass, because re-evaluation against a FIXED rails manifest is exactly
 * how a held change is eventually released. Widening this to any sibling would
 * silently delete that release path.
 *
 * WHY A READ-SIDE PREDICATE AND NOT A TERMINAL WRITE. A terminal marker would
 * need a new column and a new writer, and it would be one-way: an operator who
 * later deleted the newer job's posting could not get the older candidate back.
 * Read-side supersession is derived fresh each pass from rows that already
 * exist, so it is reversible by construction and adds no migration.
 *
 * NULL SAFETY IS LOAD-BEARING. `jobs.item_id` is nullable — a scheduled audit
 * slot carries no item — and SQL `=` answers NULL, not true, when either side is
 * NULL. So an itemless job can never be anybody's sibling, in either direction,
 * and two unrelated itemless jobs can never supersede each other. This is stated
 * rather than assumed because `IS NOT DISTINCT FROM` or a `COALESCE` written for
 * "tidiness" would make every itemless job a sibling of every other. The outer
 * query's inner join to `github_items` already requires a non-null `item_id` on
 * the candidate side; this clause is what closes the sibling side.
 *
 * `ORDER BY id DESC LIMIT 1` over a correlated EXISTS on the posting: what the
 * loader needs is a yes/no, and the id is carried only so the `proposal.superseded`
 * line can NAME what superseded the row. When several newer siblings have posted,
 * the newest is reported — the one that actually owns the ref today.
 */
function supersedingJobId() {
	// `alias()` gives correctly-qualified column references (`"superseding_job"."id"`),
	// but interpolating the aliased TABLE into a raw `sql` FROM emits only the alias
	// name — `from "superseding_job"` — which Postgres rejects with SQLSTATE 42P01
	// (`relation does not exist`; note Bun.sql puts that in `errno`, not `code`). So
	// the FROM names the real table and binds the alias explicitly.
	const newer = alias(jobs, "superseding_job");
	return sql<number | null>`(
		select ${newer.id}
		from ${jobs} as ${sql.identifier("superseding_job")}
		where ${newer.id} > ${jobs.id}
			and ${newer.repositoryId} = ${jobs.repositoryId}
			and ${newer.itemId} = ${jobs.itemId}
			and ${newer.status} = 'completed'
			and ${newer.jobType} in ${CHANGE_PRODUCING_JOB_TYPES}
			and exists (
				select 1
				from ${githubPostings}
				where ${githubPostings.jobId} = ${newer.id}
					and ${githubPostings.kind} = 'proposal'
			)
		order by ${newer.id} desc
		limit 1
	)`;
}

/** One keyset page of proposal-eligible rows, ordered by the seek key `jobs.id`. */
function selectCandidatePage(db: WatcherDb, limit: number, cursor: number | null) {
	return (
		db
			.select({
				// NULL unless a newer completed change-producing job for the same item
				// has already posted its proposal. Selected rather than filtered
				// in the WHERE so the loader can emit one bounded `proposal.superseded`
				// line naming what superseded the row; the row is dropped in JS, and the
				// keyset seek pages past it exactly as it does every other permanent JS
				// drop.
				supersededByJobId: supersedingJobId(),
				jobId: jobs.id,
				attemptId: jobAttempts.id,
				runnerJobId: jobAttempts.runnerJobId,
				// The job row's OWN foreign keys, so a follow-up job can be
				// keyed to rows that exist rather than re-looked-up by name. Both are
				// non-null for every row this query can return — the two inner joins
				// below require them — but they are carried verbatim rather than
				// re-derived, because for a verb candidate `repositories.fullName` is
				// NOT the repository the change is rooted on.
				repositoryId: jobs.repositoryId,
				itemId: jobs.itemId,
				repository: repositories.fullName,
				itemNumber: githubItems.number,
				dispatchedBaseSha: jobs.sha,
				// The sf#301 change base, when the dispatch recorded one. Selected —
				// never assumed — because for a verb job the change identity is NOT the
				// dispatch identity: `repositories.fullName` is the managed repo whose
				// issue carried the `deploy:<app>` label, and `jobs.sha` is a
				// rails-manifest digest, not a git object at all.
				changeBaseRepository: jobs.changeBaseRepository,
				changeBaseSha: jobs.changeBaseSha,
				// Trusted watcher state. The display path resolves the check-trail
				// allowance by template, and only this column says which template ran.
				jobType: jobs.jobType,
				// `runner:<hostname>:<jobRunnerId>` — the ACCEPTED result's host.
				acceptedTarget: resultPostings.target,
				// The trail ingest persisted for THAT accepted result.
				checkTrail: resultPostings.checkTrail,
			})
			.from(jobAttempts)
			.innerJoin(jobs, eq(jobs.id, jobAttempts.jobId))
			.innerJoin(repositories, eq(repositories.id, jobs.repositoryId))
			.innerJoin(githubItems, eq(githubItems.id, jobs.itemId))
			// The result posting is what proves a result was ACCEPTED for this job, and
			// its target names WHICH HOST's result that was. Without this join the pass
			// pushed whatever snapshot happened to sit at a job-keyed path, so a
			// report-only result from host A could complete the job while host B's
			// bundle supplied the pushed bytes.
			//
			// `status = accepted` binds the candidate to THE result that transitioned
			// the job, not merely A result recorded for it. Reconcile ingests
			// every host dir under an attempt and hostnames on the share are
			// runner-writable, so two hosts can each pass full verification and each
			// land a `recorded` posting; the store marks exactly one `accepted` — the
			// one whose persist won the `running`-guarded job transition — in that same
			// transaction. Without this filter the join emits BOTH `recorded` rows, the
			// loader yields two candidates, and the runner (by ordering its host dirs)
			// chooses which verified-but-different tree is proposed.
			.innerJoin(
				resultPostings,
				and(eq(resultPostings.jobId, jobs.id), eq(resultPostings.status, "accepted")),
			)
			.where(
				and(
					eq(jobAttempts.status, "completed"),
					eq(jobs.status, "completed"),
					isNotNull(jobAttempts.runnerJobId),
					inArray(jobs.jobType, CHANGE_PRODUCING_JOB_TYPES),
					notExists(
						db
							.select({ one: sql`1` })
							.from(githubPostings)
							.where(and(eq(githubPostings.jobId, jobs.id), eq(githubPostings.kind, "proposal"))),
					),
					// Seek past every job id an earlier page already surfaced. On the
					// first page `cursor` is null and this clause is absent.
					...(cursor === null ? [] : [gt(jobs.id, cursor)]),
				),
			)
			.orderBy(asc(jobs.id))
			.limit(limit)
	);
}

/** One page row of the candidate query, before the JS-side eligibility filters. */
type CandidateRow = {
	jobId: number;
	attemptId: number;
	runnerJobId: string | null;
	repositoryId: number;
	itemId: number | null;
	repository: string;
	itemNumber: number;
	dispatchedBaseSha: string;
	jobType: string;
	changeBaseRepository: string | null;
	changeBaseSha: string | null;
	acceptedTarget: string;
	checkTrail: string | null;
	/** sf#349: the newer job that already posted a proposal for this item, if any. */
	supersededByJobId: number | null;
};

/**
 * Decode the persisted check trail, re-validating it against the SAME schema
 * that bounded it at ingest.
 *
 * Re-parsing is not paranoia about the database: it is what keeps the display
 * path honest about where its bounds come from. The column is text, the value
 * originated as untrusted runner output, and a caller that trusted the JSON
 * shape would hand unbounded data to the body renderer if the column were ever
 * written by anything but the current ingest path. Anything that does not parse
 * yields an EMPTY trail, so a malformed row degrades to "no trail shown" rather
 * than failing the proposal or rendering junk.
 */
function decodeCheckTrail(raw: string | null): readonly ResultCheck[] {
	if (raw === null || raw === "") {
		return [];
	}
	try {
		const parsed = z.array(resultCheckSchema).max(100).safeParse(JSON.parse(raw));
		return parsed.success ? parsed.data : [];
	} catch {
		return [];
	}
}

/**
 * Turn one page row into a candidate, or `null` when it is not proposable. The
 * caller has already advanced the keyset cursor, so a `null` here is seeked past
 * rather than re-fetched.
 */
async function candidateFromRow(
	row: CandidateRow,
	snapshotPathFor: (jobRunnerId: string, hostname: string) => string,
	snapshotExists: (path: string) => Promise<boolean>,
): Promise<ProposalCandidate | null> {
	if (row.runnerJobId === null) {
		return null;
	}

	// WHICH IDENTITY THIS CHANGE BELONGS TO. One function owns this
	// decision for the whole factory, and it is the SAME one `change-verifier`
	// already used to accept the bundle — so the base this pass pushes against is
	// byte-identical to the base the bundle's ancestry was proved against. Deriving
	// it a second way here would be a second source of truth that could drift, and
	// the drift would look like a forge push rejection rather than a factory bug.
	//
	// For every implement-lane row this answers with the job's own repository and
	// `jobs.sha`, exactly as before this ticket — an empty `jobs.sha` yields null
	// and is skipped, which is the pre-existing `dispatchedBaseSha === ""` guard
	// preserved inside the shared function rather than restated here.
	//
	// For a verb row it answers with `rtech/k3s-deploy` at the recorded change-base
	// sha, and FAILS CLOSED to null when that base is missing, is not the one
	// allowlisted repository, or is not a full 40-hex object id. A verb row with no
	// trustworthy base is NOT a candidate: it is skipped like any other ineligible
	// row (the keyset cursor has already advanced past it), never an error and
	// never a fallback to the dispatch identity — falling back is sf#301 itself,
	// and it would push a k3s render onto the managed repository.
	const base = dispatchedBaseForJob({
		jobType: row.jobType,
		jobSha: row.dispatchedBaseSha,
		repositoryFullName: row.repository,
		changeBaseRepository: row.changeBaseRepository,
		changeBaseSha: row.changeBaseSha,
	});
	if (base === null) {
		return null;
	}
	// Parse the accepting host out of `runner:<hostname>:<jobRunnerId>`. The
	// hostname is a validated path segment (the share reader enforces that
	// before the result is ever read), and the job id may itself contain no
	// colon, so splitting on the FIRST two colons is unambiguous.
	const parts = row.acceptedTarget.split(":");
	if (parts.length < 3 || parts[0] !== "runner") {
		return null;
	}
	const hostname = parts[1] ?? "";
	if (hostname === "" || parts.slice(2).join(":") !== row.runnerJobId) {
		return null;
	}

	// A completed implement job need NOT have produced a change: a runner may
	// legitimately report that it could not implement the issue, and that
	// result carries no bundle and never reaches the verifier. Requiring the
	// verified snapshot to exist is what keeps those jobs out of the pass —
	// otherwise every cycle would re-fetch a scratch repo and re-attempt a read
	// for a change that was never made, forever. These no-change jobs are
	// exactly what keyset pagination seeks past: they match the SQL
	// WHERE forever, so a fixed `.limit` cut would let the oldest of them
	// starve every younger real candidate.
	const snapshotPath = snapshotPathFor(row.runnerJobId, hostname);
	if (!(await snapshotExists(snapshotPath))) {
		return null;
	}

	return {
		jobId: row.jobId,
		attemptId: row.attemptId,
		// The DISPATCH identity's own rows, carried alongside the change identity
		// below. These two are what a follow-up job row is keyed on.
		repositoryId: row.repositoryId,
		itemId: row.itemId,
		// The CHANGE identity, not the dispatch identity. Everything downstream —
		// base-branch resolution, the push remote, the credential, and the scratch
		// repository the ancestry re-check runs in — is keyed on this repository, so
		// a verb candidate resolves all four against `rtech/k3s-deploy`.
		repository: base.repository,
		itemNumber: row.itemNumber,
		dispatchedBaseSha: base.sha,
		jobType: row.jobType,
		snapshotPath,
		checks: decodeCheckTrail(row.checkTrail),
	};
}
