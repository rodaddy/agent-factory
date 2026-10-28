/**
 * @module github/publish
 * @description The GitHub posting reconciler. It scans a bounded number of
 *   pending/retryable `github_postings` rows, resolves each row's authoritative
 *   target (repository / item number / SHA) from the jobs join — never from the
 *   stored payload's runner-derived text — and publishes each plan independently
 *   through the bounded write client. One plan's failure is isolated from the
 *   rest, external references and `posted` state are persisted after a success,
 *   and a spent retry budget moves a row to `failed`.
 *
 *   Concurrency safety: each row is processed inside its own PostgreSQL
 *   transaction that takes a `FOR UPDATE` row lock on the due `pending` row and
 *   holds it across the single remote operation and the terminal state update.
 *   A concurrent publisher racing the same row blocks on the lock, then re-reads
 *   and observes the terminal (or no-longer-due) state and skips it — the same
 *   row is never published twice. There is no time-based lease: the lock's scope
 *   *is* the mutual exclusion, so there is no expiry split-brain to reason about.
 *
 *   Crash safety: a crash mid-operation rolls the transaction back, leaving the
 *   row `pending`, so no local state is half-written. Labels are naturally
 *   idempotent (add/remove of a fixed set). Comments, checks, and audit-finding
 *   issues use GitHub-side deterministic deduplication — a hidden marker in the
 *   comment/issue body and a stable `external_id` on the check run — so a re-post
 *   recognizes its own prior write and records it instead of creating a
 *   user-visible duplicate.
 *
 *   Audit-finding issues are a LEAST-PRIVILEGE write path: the publisher may
 *   only OPEN a new issue (POST /issues) or UPDATE an existing one (PATCH /issues/
 *   {n} with title/body). It NEVER sends an issue `state`, so it can neither close
 *   nor reopen an issue — closure is the fixer-PR `Closes #N` flow — and it never
 *   writes repository code. A found marker (even on a CLOSED issue) dedupes onto
 *   that issue rather than opening a duplicate.
 *
 *   Shadow mode: when constructed with `shadow: true`, the reconciler runs the
 *   entire pipeline unchanged — including the GitHub-side dedupe READS — but at
 *   the write boundary it records the intended write into the `shadow_publications`
 *   ledger through the same row-locked transaction, instead of POSTing/PATCHing
 *   GitHub. This lets a bounded shadow period demonstrate external-check
 *   publication (and prove no duplicate comment would be created) without ever
 *   mutating GitHub; the dedupe semantics are identical, so an indeterminate scan
 *   stays retryable rather than recording an unprovable would-post.
 *
 *   This module is the ORCHESTRATOR and the public surface: it owns the candidate
 *   scan, the row lock, the transaction, target authorization, and the shadow
 *   ledger write. The regions split out of it are the boundary types
 *   (`./publish-types`), the stored-plan decoder (`./publish-decode`), the
 *   bounded GitHub-side dedupe scans (`./publish-dedupe`), the five per-plan
 *   write paths (`./publish-writers`), and the row state transitions
 *   (`./publish-state`) — all of which still run inside this module's
 *   transaction.
 *
 * @outputs
 *   - `GitHubPublisher` -- the bounded, restart-safe posting reconciler
 *   - `PublishSummary` -- per-pass counters
 *   - the `MAX_POSTING*` / `POSTING_BACKOFF_MS` bounds, re-exported at their
 *     original module path
 *
 * @dependencies
 *   - ../db/schema, ../db/client -- github_postings + the authoritative join
 *   - ../jobs/verb-base, ../jobs/verb-dispatch -- the trusted verb change
 *     repository and the allowlisted verb ids
 *   - ./client -- bounded write seam
 *   - ./publication -- plan shapes, caps, and dedupe markers
 *   - ./publish-types, ./publish-decode, ./publish-dedupe, ./publish-writers,
 *     ./publish-state -- the split regions
 */
import { and, asc, eq, isNull, lte, or } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { githubItems, githubPostings, jobs, repositories } from "../db/schema";
import type { ForgeClient } from "../forge/boundary";
import { parseProvider } from "../forge/provider";
import type { ForgeRegistry } from "../forge/registry";
import {
	dispatchedBaseForJob,
	VERB_CHANGE_BASE_REPOSITORY,
	VERB_CHECK_CONTEXT,
} from "../jobs/verb-base";
import { isVerbId } from "../jobs/verb-dispatch";
import { errorMessage, log } from "../log";
import type { TriageAllowlistResolver } from "../results/store";
import { isItemEligible } from "./eligibility";
import {
	ALL_RESULT_LABELS,
	COMMENT_TARGET,
	type PublicationPlan,
	proposalBranchFor,
} from "./publication";
import { decodePlan, UNPUBLISHABLE } from "./publish-decode";
import {
	markPosted,
	markTerminalFailure,
	type PublishClock,
	recordShadow,
	recordUnhandled,
} from "./publish-state";
import {
	type GitHubPublisherOptions,
	MAX_POSTING_ATTEMPTS,
	MAX_POSTING_BACKOFF_MS,
	MAX_POSTINGS_PER_PASS,
	POSTING_BACKOFF_MS,
	type PublishRow,
	type PublishSummary,
} from "./publish-types";
import {
	type PlanWriteOutcome,
	publishCheck,
	publishComment,
	publishIssue,
	publishLabel,
	publishProposal,
	type ResolvedTarget,
	type WriteContext,
} from "./publish-writers";

export {
	type GitHubPublisherOptions,
	MAX_POSTING_ATTEMPTS,
	MAX_POSTING_BACKOFF_MS,
	MAX_POSTINGS_PER_PASS,
	POSTING_BACKOFF_MS,
	type PublishSummary,
};

/** The transaction handle passed to a `db.transaction` callback. */
type WatcherTx = Parameters<Parameters<WatcherDb["transaction"]>[0]>[0];

/** Trusted change-base columns carried by the authoritative jobs join. */
type TrustedChangeBase = {
	changeBaseRepository: string | null;
	changeBaseSha: string | null;
};

type VerbChangeRepositoryArgs = {
	tx: WatcherTx;
	row: PublishRow;
	plan: PublicationPlan;
	target: ResolvedTarget;
	summary: PublishSummary;
	changeBase: TrustedChangeBase;
};

function resolveVerbCheckBase(
	plan: PublicationPlan,
	row: PublishRow,
	changeBase: TrustedChangeBase,
): { repository: string; sha: string } | null | undefined {
	if (plan.kind !== "check") return undefined;
	return dispatchedBaseForJob({
		jobType: row.jobType,
		jobSha: row.sha,
		repositoryFullName: row.repository,
		changeBaseRepository: changeBase.changeBaseRepository,
		changeBaseSha: changeBase.changeBaseSha,
	});
}

/** Restart-safe GitHub posting reconciler. */
export class GitHubPublisher {
	private readonly db: WatcherDb;
	private readonly registry: ForgeRegistry | null;
	private client: ForgeClient | null;
	private readonly maxPerPass: number;
	private readonly now: () => Date;
	private readonly onError?: (error: Error) => void;
	private readonly onRowLocked?: (id: number) => Promise<void>;
	private readonly shadow: boolean;
	private readonly triageAllowlistFor: TriageAllowlistResolver;
	/** The injected clock plus the clamped retry bounds the state writes use. */
	private readonly clock: PublishClock;

	constructor(
		db: WatcherDb,
		registryOrClient: ForgeRegistry | ForgeClient,
		options: GitHubPublisherOptions = {},
	) {
		this.db = db;
		if ("clientFor" in registryOrClient) {
			this.registry = registryOrClient;
			this.client = null;
		} else {
			// Compatibility for focused publisher tests. Production composition
			// always passes the registry and resolves by the durable row provider.
			this.registry = null;
			this.client = registryOrClient;
		}
		this.maxPerPass = Math.max(1, Math.min(options.maxPerPass ?? MAX_POSTINGS_PER_PASS, 5000));
		this.now = options.now ?? (() => new Date());
		this.onError = options.onError;
		this.onRowLocked = options.onRowLocked;
		this.shadow = options.shadow ?? false;
		this.clock = {
			now: this.now,
			maxAttempts: Math.max(1, Math.min(options.maxAttempts ?? MAX_POSTING_ATTEMPTS, 50)),
			// The base backoff is clamped to the hard ceiling so a misconfigured value
			// can never schedule a multi-minute (or multiplied-out) sleep.
			backoffMs: Math.min(
				Math.max(0, options.backoffMs ?? POSTING_BACKOFF_MS),
				MAX_POSTING_BACKOFF_MS,
			),
			shadow: this.shadow,
		};
		// Default to an empty allowlist: a publisher with no resolver knows no triage
		// vocabulary, so every triage add-label plan fails its re-validation closed
		// rather than posting a label it cannot vouch for.
		this.triageAllowlistFor = options.triageAllowlistFor ?? (() => []);
	}

	/** Publish one bounded batch of pending/retryable plans. */
	async run(): Promise<PublishSummary> {
		const at = this.now();
		// Shortlist due `pending` rows. This selection is only a hint — each id is
		// then processed inside its own transaction that re-locks and re-checks the
		// row, so a concurrent pass selecting the same shortlist cannot double-post:
		// the loser blocks on the row lock and then observes terminal/not-due state.
		const candidates = await this.db
			.select({ id: githubPostings.id })
			.from(githubPostings)
			.where(
				and(
					eq(githubPostings.status, "pending"),
					or(isNull(githubPostings.nextAttemptAt), lte(githubPostings.nextAttemptAt, at)),
				),
			)
			.orderBy(asc(githubPostings.id))
			.limit(this.maxPerPass);

		const summary: PublishSummary = {
			scanned: 0,
			posted: 0,
			deduped: 0,
			failed: 0,
			retryable: 0,
			skipped: 0,
			shadowJobIds: [],
		};

		for (const candidate of candidates) {
			try {
				await this.processOne(candidate.id, at, summary);
			} catch (error) {
				// The transaction for this row rolled back (crash/exception mid-flight),
				// leaving it `pending` for a later pass — GitHub-side dedupe recovers any
				// remote write. One plan's failure is isolated: continue the batch.
				this.reportError(error instanceof Error ? error : new Error(UNPUBLISHABLE));
			}
		}

		return summary;
	}

	/**
	 * Invoke the caller's error sink without ever letting it abort the batch. A
	 * monitoring/logging sink is untrusted here: if it throws, that throw must not
	 * escape the per-row loop and take down the rest of the publish batch for this
	 * cycle. Swallow any exception it raises (row state is already committed or
	 * rolled back, and no cursor advances — the next cycle retries).
	 */
	private reportError(error: Error): void {
		try {
			this.onError?.(error);
		} catch (err) {
			// A faulty sink must not abort the batch. Nothing safe to do with a
			// logging-sink failure except record it and drop it.
			log("debug", "publish.error_sink.threw", { cause: errorMessage(err) });
		}
	}

	private requireClient(): ForgeClient {
		if (this.client === null) {
			throw new Error("provider client unavailable");
		}
		return this.client;
	}

	/**
	 * Process one candidate row inside a single transaction that holds a `FOR
	 * UPDATE` row lock across the whole dedupe → remote write → final state update.
	 *
	 * The lock is the mutual exclusion: a concurrent publisher racing the same row
	 * blocks here until this transaction commits, then re-reads under its own lock
	 * and finds the row no longer due (terminal or backed-off) and skips it. No
	 * time-based lease and no `processing` intermediate state are involved, so there
	 * is no expiry split-brain. A crash before commit rolls the transaction back,
	 * leaving the row `pending`; the remote marker / `external_id` makes the retry
	 * idempotent.
	 */
	private async processOne(id: number, at: Date, summary: PublishSummary): Promise<void> {
		await this.db.transaction(async (tx) => {
			// Lock the row and read its authoritative target in one shot. `FOR UPDATE`
			// (`of` the postings row) blocks a concurrent claimer until this tx commits.
			const [row] = await tx
				.select({
					id: githubPostings.id,
					jobId: githubPostings.jobId,
					kind: githubPostings.kind,
					action: githubPostings.action,
					target: githubPostings.target,
					payload: githubPostings.payload,
					dedupeKey: githubPostings.dedupeKey,
					attempts: githubPostings.attempts,
					status: githubPostings.status,
					nextAttemptAt: githubPostings.nextAttemptAt,
					provider: repositories.provider,
					repository: repositories.fullName,
					itemNumber: githubItems.number,
					itemKind: githubItems.kind,
					itemState: githubItems.state,
					itemHeadSha: githubItems.headSha,
					sha: jobs.sha,
					jobType: jobs.jobType,
					changeBaseRepository: jobs.changeBaseRepository,
					changeBaseSha: jobs.changeBaseSha,
				})
				.from(githubPostings)
				.innerJoin(jobs, eq(jobs.id, githubPostings.jobId))
				.innerJoin(repositories, eq(repositories.id, jobs.repositoryId))
				.leftJoin(githubItems, eq(githubItems.id, jobs.itemId))
				.where(eq(githubPostings.id, id))
				.for("update", { of: githubPostings })
				.limit(1);

			// Re-check eligibility under the lock: only a still-`pending` and due row is
			// ours to publish. Anything else means a concurrent pass already terminated
			// or rescheduled it while we blocked — skip without a remote write.
			if (
				row?.status !== "pending" ||
				(row.nextAttemptAt !== null && row.nextAttemptAt.getTime() > at.getTime())
			) {
				return;
			}

			summary.scanned++;
			await this.onRowLocked?.(row.id);
			await this.publishLockedRow(tx, row, summary, {
				changeBaseRepository: row.changeBaseRepository,
				changeBaseSha: row.changeBaseSha,
			});
		});
	}

	/**
	 * Publish one locked, re-verified row against its authoritative target within
	 * the caller's transaction, writing the terminal/retryable state through the
	 * same `tx` so the whole decision commits atomically with the row lock.
	 */
	private async publishLockedRow(
		tx: WatcherTx,
		row: PublishRow,
		summary: PublishSummary,
		changeBase: TrustedChangeBase,
	): Promise<void> {
		const resolved = await this.resolveTarget(tx, row, summary);
		if (resolved === null) {
			return;
		}

		const plan = decodePlan(row, this.triageAllowlistFor);
		if (!plan) {
			// A stored payload we cannot decode is terminal — never retried and
			// never posted. Should not happen (we wrote it), so fail it safe.
			await markTerminalFailure(tx, this.clock, row.id, "unreadable stored publication plan");
			summary.failed++;
			return;
		}

		const target = await this.applyVerbChangeRepository({
			tx,
			row,
			plan,
			target: resolved,
			summary,
			changeBase,
		});
		if (target === null) {
			return;
		}

		if (!(await this.passesPreWriteGates({ tx, row, plan, target, summary }))) {
			return;
		}

		// The single remote operation runs while this transaction still holds the
		// row lock, so no other publisher can act on the same row concurrently. In
		// shadow mode this records the intended write into the ledger via the same
		// `tx` instead of calling GitHub, so the ledger row commits atomically with
		// the terminal state update below.
		const outcome = await this.publishPlan({
			tx,
			row,
			plan,
			target,
			dedupeKey: row.dedupeKey,
		});
		if (outcome.status === "failed") {
			await this.recordWriteFailure(tx, row, outcome, summary);
			return;
		}

		await markPosted({ tx, clock: this.clock, row, outcome, summary });
	}

	/**
	 * Record a failed write's terminal-or-retryable state through the caller's
	 * transaction. Extracted from `publishLockedRow` purely to keep it within the
	 * function ceiling; both arms are the whole of the decision.
	 *
	 * A failure is RETRYABLE by default and always was. `terminal` is the
	 * narrow opposite: the write path PROVED the write can never succeed — a 404
	 * for a (repository, sha) pair the forge does not hold — so retrying only burns
	 * the attempt budget and leaves a permanently-failing row behind (263 such rows
	 * in production before the verb check was redirected to the repo owning the
	 * sha). The classification is made at the boundary that saw the provider's
	 * response; nothing here inspects the reason text.
	 */
	private async recordWriteFailure(
		tx: WatcherTx,
		row: PublishRow,
		outcome: { status: "failed"; reason: string; terminal?: boolean },
		summary: PublishSummary,
	): Promise<void> {
		if (outcome.terminal === true) {
			await markTerminalFailure(tx, this.clock, row.id, outcome.reason);
			summary.failed++;
			return;
		}
		// Retry until the budget is spent, then fail. Written through the same tx so
		// it commits atomically with the (released) lock.
		await recordUnhandled({
			tx,
			clock: this.clock,
			id: row.id,
			attempts: row.attempts,
			summary,
			reason: outcome.reason,
		});
	}

	/**
	 * The two authorization gates a decoded plan must pass before any remote
	 * operation: the job identity must authorize the plan's target, and an
	 * item-level write must still have an eligible item. Returns false once a gate
	 * has recorded its own terminal state. Extracted from `publishLockedRow` purely
	 * to keep it within the function ceiling; both rules are unchanged.
	 */
	private async passesPreWriteGates({
		tx,
		row,
		plan,
		target,
		summary,
	}: {
		tx: WatcherTx;
		row: PublishRow;
		plan: PublicationPlan;
		target: ResolvedTarget;
		summary: PublishSummary;
	}): Promise<boolean> {
		// The join is authoritative. If the plan needs a target the identity does
		// not authorize (item/SHA), it is not publishable — mark it terminally
		// failed rather than inventing a write.
		if (!targetAuthorizes(plan, target)) {
			await markTerminalFailure(
				tx,
				this.clock,
				row.id,
				"plan target not authorized by job identity",
			);
			summary.failed++;
			return false;
		}

		// Item-level writes (labels/comments) are re-checked against the item's
		// *current* live state at publish time — the item may have closed or the PR
		// head may have moved since the plan was queued. A now-ineligible item drops
		// the plan terminally rather than writing to a stale/closed target. (Checks
		// bind to an immutable SHA and are exempt; the SHA match above enforces them.)
		if ((plan.kind === "label" || plan.kind === "comment") && !this.itemEligible(target)) {
			await markTerminalFailure(
				tx,
				this.clock,
				row.id,
				"item no longer eligible for label/comment",
			);
			summary.skipped++;
			return false;
		}

		if (!(await this.receiptAllowsPlan(tx, row, plan))) {
			await recordUnhandled({
				tx,
				clock: this.clock,
				id: row.id,
				attempts: row.attempts,
				summary,
				reason: "receipt comment not posted",
			});
			return false;
		}
		return true;
	}

	/**
	 * A state-label transition is conditional on this job's receipt comment having
	 * reached the forge. Non-state labels and every other plan kind are independent.
	 */
	private async receiptAllowsPlan(
		tx: WatcherTx,
		row: PublishRow,
		plan: PublicationPlan,
	): Promise<boolean> {
		if (plan.kind !== "label" || !ALL_RESULT_LABELS.includes(plan.label)) {
			return true;
		}
		const [receipt] = await tx
			.select({ status: githubPostings.status })
			.from(githubPostings)
			.where(
				and(
					eq(githubPostings.jobId, row.jobId),
					eq(githubPostings.kind, "comment"),
					eq(githubPostings.target, COMMENT_TARGET),
				),
			)
			.limit(1);
		return receipt?.status === "posted";
	}

	/**
	 * Resolve the row's provider client and authoritative target, or record the
	 * failure and return null. Extracted from `publishLockedRow` purely to keep it
	 * within the function ceiling; the provider/registry rules are unchanged.
	 */
	private async resolveTarget(
		tx: WatcherTx,
		row: PublishRow,
		summary: PublishSummary,
	): Promise<ResolvedTarget | null> {
		const provider = parseProvider(row.provider);
		if (provider === null) {
			await markTerminalFailure(tx, this.clock, row.id, "invalid repository provider");
			summary.failed++;
			return null;
		}
		if (this.registry) {
			const resolved = await this.registry.clientFor(provider);
			if (!resolved.ok) {
				await recordUnhandled({
					tx,
					clock: this.clock,
					id: row.id,
					attempts: row.attempts,
					summary,
					reason: resolved.error,
				});
				return null;
			}
			this.client = resolved.client;
		} else if (provider !== "github") {
			await recordUnhandled({
				tx,
				clock: this.clock,
				id: row.id,
				attempts: row.attempts,
				summary,
				reason: "provider client unavailable",
			});
			return null;
		}
		return {
			provider,
			repository: row.repository,
			itemNumber: row.itemNumber,
			sha: row.sha,
			jobType: row.jobType,
			itemKind: row.itemKind,
			itemState: row.itemState,
			itemHeadSha: row.itemHeadSha,
		};
	}

	/**
	 * sf#344 + sf#599 — the TWO cases where the jobs join is not the write target.
	 *
	 * The jobs join resolves the MANAGED repository, and that is right for every
	 * other plan kind and for every other job type: labels, comments, and audit
	 * issues all bind to the managed item, and an implement-lane proposal's change
	 * repository IS the managed repository. A deterministic verb job is the
	 * exception, and it is the exception TWICE:
	 *
	 * 1. The PROPOSAL. Its change is a render against
	 *    `VERB_CHANGE_BASE_REPOSITORY` on Forgejo, which is where the proposal pass
	 *    already pushed the head branch. Aimed at the managed GitHub repo it 422s
	 *    forever against a repo that has never seen the branch (`github_postings`
	 *    row 1117, RUNNING evidence 2026-08-17).
	 *
	 * 2. The CHECK. This comment used to assert that checks "bind to the
	 *    managed item" alongside labels and comments. That is true for every job
	 *    type EXCEPT a verb job, and the exception is exactly the bug. A commit
	 *    status is addressed by (repository, sha), and a verb job's `jobs.sha` is
	 *    the dispatch digest for the change base — it is not a git object in the
	 *    MANAGED repository, so the forge answers 404 on every attempt and the row
	 *    reschedules until its budget is spent. Production 2026-09-03:
	 *    `github_postings` kind='check' 263 failed / 91 posted. So the check is
	 *    redirected to the repository that owns the sha, exactly like the proposal.
	 *
	 *    The redirected check MUST carry a context distinct from the sop-gate
	 *    family (`VERB_CHECK_CONTEXT`), so a factory receipt can never be read as a
	 *    merge judgment on a repo whose main requires sop-gate. No second status is
	 *    posted on the managed repository: the published comment is already the
	 *    human-visible receipt there.
	 *
	 * The repository and check SHA come from the trusted jobs change-base columns
	 * through `dispatchedBaseForJob`, never from the plan row's stored text, so a
	 * tampered payload cannot redirect a write. The proposal authorization gate
	 * (`plan.headBranch` re-derived from the trusted item number) is unchanged and
	 * still runs after this. The check gate continues to compare `target.sha` with
	 * `plan.sha`; that pair remains the job identity and dedupe identity, while the
	 * separate `checkSha` addresses the destination repository's commit status.
	 */
	private async applyVerbChangeRepository(
		args: VerbChangeRepositoryArgs,
	): Promise<ResolvedTarget | null> {
		const { tx, row, plan, target, summary, changeBase } = args;
		if ((plan.kind !== "proposal" && plan.kind !== "check") || !isVerbId(row.jobType)) {
			return target;
		}
		const trustedCheckBase = resolveVerbCheckBase(plan, row, changeBase);
		if (trustedCheckBase === null) {
			await markTerminalFailure(
				tx,
				this.clock,
				row.id,
				"verb check change base is missing or invalid",
			);
			summary.failed++;
			return null;
		}
		const resolved =
			this.registry === null
				? { ok: false as const, error: "provider client unavailable" }
				: await this.registry.clientFor("forgejo");
		if (!resolved.ok) {
			await recordUnhandled({
				tx,
				clock: this.clock,
				id: row.id,
				attempts: row.attempts,
				summary,
				reason: resolved.error,
			});
			return null;
		}
		this.client = resolved.client;
		return {
			...target,
			provider: "forgejo",
			repository: trustedCheckBase?.repository ?? VERB_CHANGE_BASE_REPOSITORY,
			...(trustedCheckBase === undefined
				? {}
				: { checkSha: trustedCheckBase.sha, checkContext: VERB_CHECK_CONTEXT }),
		};
	}

	/** True when the resolved item is still a valid label/comment target. */
	private itemEligible(target: ResolvedTarget): boolean {
		return isItemEligible({
			kind: target.itemKind,
			state: target.itemState,
			headSha: target.itemHeadSha,
			jobSha: target.sha,
		});
	}

	/** Dispatch one plan to the correct bounded write path. */
	private async publishPlan({
		tx,
		row,
		plan,
		target,
		dedupeKey,
	}: {
		tx: WatcherTx;
		row: PublishRow;
		plan: PublicationPlan;
		target: ResolvedTarget;
		dedupeKey: string;
	}): Promise<PlanWriteOutcome> {
		try {
			// `requireClient` throws when no provider client resolved. It stayed inside
			// this try before the split (each write path called it), so the throw must
			// still land on the bounded `failed` outcome below, never escape the row.
			const ctx: WriteContext = {
				client: this.requireClient(),
				shadow: this.shadow,
				recordShadow: (wouldAction) =>
					recordShadow({ tx, clock: this.clock, row, plan, target, wouldAction }),
			};
			if (plan.kind === "label") return await publishLabel(ctx, plan, target);
			if (plan.kind === "comment") return await publishComment(ctx, plan, target, dedupeKey);
			if (plan.kind === "issue") return await publishIssue(ctx, plan, target, dedupeKey);
			if (plan.kind === "proposal") return await publishProposal(ctx, plan, target);
			return await publishCheck(ctx, plan, target, dedupeKey);
		} catch (error) {
			return { status: "failed", reason: error instanceof Error ? error.message : UNPUBLISHABLE };
		}
	}
}

/** True when the resolved identity authorizes the plan's required target. */
function targetAuthorizes(plan: PublicationPlan, target: ResolvedTarget): boolean {
	if (plan.kind === "label" || plan.kind === "comment") {
		// The trusted item number must exist and match the plan's item number.
		return target.itemNumber !== null && target.itemNumber === plan.itemNumber;
	}
	if (plan.kind === "issue") {
		// An issue plan was authorized only for a scheduled-audit job; that lane was
		// retired with sf#830 (D10), so no job authorizes one now (fail closed).
		return false;
	}
	if (plan.kind === "proposal") {
		// A proposal is authorized only when its head branch is EXACTLY the one
		// this watcher derives from the trusted item number and job type. A stored
		// plan whose branch was tampered with — or that names an item other than the one the
		// job resolved to — can never push to a ref of its own choosing.
		if (target.itemNumber === null || target.itemNumber !== plan.itemNumber) {
			return false;
		}
		const derived = proposalBranchFor(target.itemNumber, target.jobType);
		return derived !== null && plan.headBranch === derived && plan.target === derived;
	}
	// Checks must bind to the exact trusted SHA.
	return target.sha !== "" && target.sha === plan.sha;
}
