/**
 * @module results/store
 * @description Default `ResultStore` that persists an ingest outcome into the
 *   watcher database idempotently and atomically. It resolves the internal job
 *   from the runner job id (via the recorded job attempt), records a bounded
 *   posting row for the result artifact (`recorded`, promoted to `accepted` for
 *   the ONE posting whose result transitioned the job — #90), marks the attempt
 *   finished ONCE (the
 *   first terminal result per attempt wins; a later per-host result cannot flip
 *   it), and — only when this attempt still OWNS the job (`jobs.active_attempt_id`)
 *   and the job is `running` — advances the job to a terminal state (`completed`
 *   on an ingested pass/skip, `failed` otherwise). A stale result from a superseded
 *   attempt (the job was re-dispatched under a newer attempt after a timeout, so
 *   ownership moved) records its own attempt outcome but never terminates the live
 *   job. All writes run in one transaction
 *   so a crash cannot leave partial state; re-persisting the same DONE converges
 *   rather than duplicating. When an ingested result terminates the job under
 *   its latest attempt, bounded GitHub publication plans are derived from the
 *   *trusted* DB-resolved identity and persisted in the same transaction, so
 *   accepting a result and durably queuing its publication work share one commit
 *   boundary — there is no crash window that can lose the publication work.
 *
 * @outputs
 *   - `DbResultStore` -- database-backed ResultStore
 *
 * @dependencies
 *   - drizzle-orm -- resolve + upsert + status writes
 *   - ../db/schema, ../db/client -- tables and db type
 *   - ../github/publish-plan -- durable publication-plan creation
 *   - ../github/publication -- the trusted JobIdentity shape
 *   - ./ingest -- the ResultStore contract
 */
import { and, desc, eq, notInArray } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import {
	githubItems,
	jobAttempts,
	jobs,
	repositories,
	resultPostings,
	runnerBoxes,
} from "../db/schema";
import { itemIneligibilityReason } from "../github/eligibility";
import type { JobIdentity } from "../github/publication";
import { type PublicationPlanTx, persistPublicationPlans } from "../github/publish-plan";
import { log } from "../log";
import type { PersistDecision, PersistedResult, ResultStore } from "./ingest";

/** Stable, bounded reason for every trusted-identity rejection. */
export const INVALID_RESULT_IDENTITY = "runner result identity is invalid";

/**
 * The `terminal_reason` an identity-rejected job is closed with.
 *
 * An identity rejection is DETERMINISTIC in the payload: the runner did its
 * work and returned a result whose (repository, job_type, sha, item_number)
 * does not match what was dispatched, and a re-run of the same job produces
 * the same payload. Without a reason the row is byte-for-byte the infra-class
 * shape `requeueInfraFailedJobs` revives (terminal `failed`, no attempt
 * `completed`), so the sweep spent the whole `INFRA_REQUEUE_BUDGET` placing
 * boxes for a rejection that could only repeat (measured 2026-08-18: 12 of 12
 * infra-static failures in 55 minutes, every one this string). The reason is
 * what bars the revive; the identity check itself is unchanged.
 */
export const IDENTITY_REJECTED_TERMINAL_REASON =
	"terminal: runner result identity is invalid; deterministic ingest rejection, sf#376";

/**
 * Resolve a repository's config-declared issue-triage label allowlist by
 * its provider-qualified identity, so the publication boundary can filter the
 * runner's chosen labels against trusted config. Returns an empty list for a
 * repository with no vocabulary (or one that resolution cannot find), which
 * safely demotes every runner-named label to a request rather than applying one.
 */
export type TriageAllowlistResolver = (repository: string, jobType: string) => readonly string[];

/** Database-backed, idempotent, atomic result store. */
export class DbResultStore implements ResultStore {
	private readonly db: WatcherDb;
	private readonly now: () => Date;
	private readonly triageAllowlistFor: TriageAllowlistResolver;

	constructor(
		db: WatcherDb,
		now: () => Date = () => new Date(),
		triageAllowlistFor: TriageAllowlistResolver = () => [],
	) {
		this.db = db;
		this.now = now;
		this.triageAllowlistFor = triageAllowlistFor;
	}

	async persist(record: PersistedResult): Promise<PersistDecision | undefined> {
		const at = this.now();

		return this.db.transaction(async (tx) => {
			// Resolve the internal job via the recorded attempt. Order by newest so a
			// lookup is deterministic even if the runner-job-id uniqueness invariant
			// is ever violated. No attempt => unknown/foreign result, nothing to do.
			const attempt = await resolveAttempt(tx, record.jobRunnerId);
			if (!attempt) {
				return;
			}

			// Lock the job row for the rest of the transaction so the latest-attempt
			// read and the terminal-state write cannot race a concurrent re-dispatch
			// (which would otherwise let a stale attempt's result terminate a live
			// re-run under READ COMMITTED). Any concurrent claim/release serializes
			// behind this lock.
			await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, attempt.jobId)).for("update");

			const expected = await resolveExpectedIdentity(tx, attempt.jobId);
			const { identityDecision, persistedRecord } = applyIdentityCheck(record, expected);

			const ingested = persistedRecord.status === "ingested";
			const jobStatus = ingested && isPassing(persistedRecord) ? "completed" : "failed";
			const target = `runner:${persistedRecord.hostname}:${record.jobRunnerId}`;

			// ORDER MATTERS: the posting row is written first so the artifact is
			// recorded even if nothing below it transitions, the attempt is finished
			// next, and only then is its pool claim released — a released claim must
			// never be observable before the attempt that held it is terminal.
			await recordAttemptOutcome(tx, {
				attempt,
				target,
				ingested,
				record: persistedRecord,
				jobRunnerId: record.jobRunnerId,
				at,
			});

			// Only the attempt that OWNS the job may terminate it. A superseded result
			// returns here having recorded its own attempt outcome without touching the
			// live job.
			const jobTransitioned = await terminateJobIfOwned(tx, {
				attemptId: attempt.id,
				jobId: attempt.jobId,
				jobStatus,
				// sf#376: a deterministic rejection closes the row WITH a reason.
				terminalReason: identityDecision === undefined ? null : IDENTITY_REJECTED_TERMINAL_REASON,
				at,
			});
			logDeterministicRejection(attempt, jobTransitioned, identityDecision);
			if (jobTransitioned === null) {
				return identityDecision;
			}

			await acceptWinningPosting(tx, {
				jobId: attempt.jobId,
				target,
				jobTransitioned,
				jobStatus,
			});

			// Only when THIS call transitioned the job (it was still `running`) and
			// the result was accepted as ingested do we durably queue its bounded
			// GitHub publication plans — in the same transaction, so accepting the
			// result and queuing the publication work commit together. Identity is
			// the trusted DB join, never runner-chosen. Re-ingest is idempotent:
			// the running-only guard means the plans are queued at most once, and
			// the (job, kind, target) key converges rather than duplicating.
			if (jobTransitioned && ingested && persistedRecord.result && expected) {
				await this.queuePublicationPlans(tx, {
					jobId: attempt.jobId,
					// The attempt this result was resolved to, carried into the
					// trusted identity so the comment can name the exact run. Same row
					// `resolveAttempt` already produced — no second lookup, and nothing
					// runner-supplied.
					attemptId: attempt.id,
					expected,
					persistedRecord,
					at,
				});
			}

			return identityDecision;
		});
	}

	/**
	 * Queue the bounded publication plans for a result that just transitioned its
	 * job. Runs inside the caller's transaction so accepting the result and
	 * queuing its publication work share one commit boundary.
	 */
	private async queuePublicationPlans(
		tx: StoreTx,
		args: {
			jobId: number;
			/** The internal attempt id this result resolved to. */
			attemptId: number;
			expected: ExpectedIdentity;
			persistedRecord: PersistedResult;
			at: Date;
		},
	): Promise<void> {
		const { expected, persistedRecord, at } = args;
		if (!persistedRecord.result) {
			return;
		}
		const identity: JobIdentity = {
			jobId: args.jobId,
			repository: expected.repository,
			itemNumber: expected.itemNumber ?? null,
			sha: expected.sha,
			jobType: expected.jobType,
			kboardTaskId: expected.kboardTaskId,
			attemptId: args.attemptId,
		};
		// Gate item-level plans on the item's current state: a closed item, or an
		// open PR whose head has moved off this job's SHA, gets no label/comment
		// plan queued. Publish-time re-checks the same rule against live state.
		//
		// The suppression is a DECISION, so it is logged. Without the line
		// a job that dispatched, ran, ingested a valid result and then produced zero
		// item postings is byte-for-byte what a broken publication path looks like
		// from the outside; the 2026-08-18 transport cutover soak lost real time to
		// exactly that misread. INFO, not warn: a closed item is a normal outcome.
		const itemEligible = this.itemEligibleOrLogged(args.jobId, expected);
		// The triage allowlist is resolved from trusted config by the repository's
		// provider-qualified identity — never from runner output — and only ever
		// consulted for the issue-triage lane's label filter. Every other
		// lane resolves an empty list and is unaffected.
		const triageAllowlist = this.triageAllowlistFor(expected.repository, expected.jobType);
		await persistPublicationPlans({
			tx,
			identity,
			result: persistedRecord.result,
			now: at,
			itemEligible,
			triageAllowlist,
		});
	}

	/**
	 * The queue-time eligibility gate, with its refusal LOGGED. Returns
	 * true when item-level plans may be queued; otherwise emits one INFO line
	 * naming the job, the item and the reason, and returns false. An itemless job
	 * has nothing to suppress and emits nothing.
	 */
	private itemEligibleOrLogged(jobId: number, expected: ExpectedIdentity): boolean {
		if (expected.itemNumber === null) return true;
		const reason = itemIneligibilityReason({
			kind: expected.itemKind,
			state: expected.itemState,
			headSha: expected.itemHeadSha,
			jobSha: expected.sha,
		});
		if (reason === null) return true;
		log("info", "publication.item_suppressed", {
			job_id: jobId,
			repository: expected.repository,
			item_number: expected.itemNumber,
			item_kind: expected.itemKind,
			reason,
		});
		return false;
	}
}

/** The transaction seam every step below writes through. */
type StoreTx = PublicationPlanTx;

/** The trusted, DB-resolved identity a runner result is checked against. */
type ExpectedIdentity = {
	repository: string;
	jobType: string;
	sha: string;
	itemNumber: number | null;
	itemKind: string | null;
	itemState: string | null;
	itemHeadSha: string | null;
	/**
	 * The k-board task this job was claimed from, or null for a
	 * label-triggered job. Carried into the trusted `JobIdentity` so the triage
	 * acknowledgment header can name the claim without any runner input.
	 */
	kboardTaskId: string | null;
};

/**
 * Resolve the internal job attempt from the runner job id. Order by newest so a
 * lookup is deterministic even if the runner-job-id uniqueness invariant is ever
 * violated; `undefined` means an unknown/foreign result with nothing to do.
 */
async function resolveAttempt(tx: StoreTx, jobRunnerId: string) {
	const [attempt] = await tx
		.select({
			id: jobAttempts.id,
			jobId: jobAttempts.jobId,
			runnerVmid: jobAttempts.runnerVmid,
		})
		.from(jobAttempts)
		.where(eq(jobAttempts.runnerJobId, jobRunnerId))
		.orderBy(desc(jobAttempts.id))
		.limit(1);
	return attempt;
}

/** The trusted DB join the runner-supplied identity is validated against. */
async function resolveExpectedIdentity(
	tx: StoreTx,
	jobId: number,
): Promise<ExpectedIdentity | undefined> {
	const [expected] = await tx
		.select({
			repository: repositories.fullName,
			jobType: jobs.jobType,
			sha: jobs.sha,
			itemNumber: githubItems.number,
			itemKind: githubItems.kind,
			itemState: githubItems.state,
			itemHeadSha: githubItems.headSha,
			kboardTaskId: jobs.kboardTaskId,
		})
		.from(jobs)
		.innerJoin(repositories, eq(repositories.id, jobs.repositoryId))
		.leftJoin(githubItems, eq(githubItems.id, jobs.itemId))
		.where(eq(jobs.id, jobId))
		.limit(1);
	return expected;
}

/**
 * Replace an identity-mismatched ingest with a bounded `invalid` record, so a
 * runner cannot persist a result under an identity it was not dispatched for.
 */
function applyIdentityCheck(
	record: PersistedResult,
	expected: ExpectedIdentity | undefined,
): { identityDecision: PersistDecision | undefined; persistedRecord: PersistedResult } {
	const identityRejected =
		record.status === "ingested" && !matchesExpectedIdentity(record, expected);
	return {
		identityDecision: identityRejected
			? { status: "invalid" as const, reason: INVALID_RESULT_IDENTITY }
			: undefined,
		persistedRecord: identityRejected
			? {
					jobRunnerId: record.jobRunnerId,
					hostname: record.hostname,
					status: "invalid",
					reason: INVALID_RESULT_IDENTITY,
				}
			: record,
	};
}

/**
 * Idempotent posting per runner job id + reusable hostname. A superseded attempt
 * receives a distinct target and cannot overwrite the live attempt's artifact
 * state, while re-ingest of the same attempt converges.
 */
async function recordPosting(
	tx: StoreTx,
	args: { jobId: number; target: string; ingested: boolean; record: PersistedResult; at: Date },
): Promise<void> {
	const postingStatus = args.ingested ? "recorded" : "invalid";
	const externalRef = args.record.result?.status ?? args.record.reason ?? null;
	const outputPath = args.record.outputPath ?? null;
	// Persist the trail from the result that was ACCEPTED here, in the same
	// transaction that records the posting. The proposal pass reads it back
	// from this row rather than re-reading the share, which stays runner-writable
	// after ingest — so what the PR body displays is what the gate judged.
	const checkTrail = serializeCheckTrail(args.record);
	await tx
		.insert(resultPostings)
		.values({
			jobId: args.jobId,
			target: args.target,
			status: postingStatus,
			externalRef,
			outputPath,
			checkTrail,
			postedAt: args.at,
		})
		.onConflictDoUpdate({
			target: [resultPostings.jobId, resultPostings.target],
			set: { status: postingStatus, externalRef, outputPath, checkTrail, postedAt: args.at },
		});
}

/**
 * The check trail of an ingested result as JSON, or null when there is none.
 *
 * Stores ONLY the validated `checks` array — not the whole result — because the
 * proposal body is the only consumer and a narrower persisted surface cannot
 * later be mistaken for a general-purpose copy of untrusted runner output. The
 * array is already schema-bounded (max 100 entries, each field length-capped),
 * so the stored value has a hard ceiling.
 */
function serializeCheckTrail(record: PersistedResult): string | null {
	const checks = record.result?.checks;
	if (checks === undefined || checks.length === 0) {
		return null;
	}
	return JSON.stringify(checks);
}

/**
 * Finish the attempt ONCE. Results are per (job, host): reconcile ingests every
 * host dir recorded under this attempt's runner job id, so a single attempt can
 * receive more than one result. Without an ownership-of-its-own-terminal-state
 * guard, a later host's result would flip an already-finished attempt's status
 * (e.g. a `completed` attempt turned `failed` by a second host's invalid report)
 * after the fact. Guard on the attempt not already
 * being terminal, so the FIRST terminal result wins and every later one converges
 * rather than overwriting it. Re-ingest of the same result is unaffected: it would
 * rewrite the identical value, and skipping it keeps the row at exactly that value.
 */
async function finishAttemptOnce(
	tx: StoreTx,
	args: { attemptId: number; ingested: boolean; record: PersistedResult; at: Date },
): Promise<void> {
	await tx
		.update(jobAttempts)
		.set({
			status: args.ingested ? "completed" : "failed",
			failureSummary: args.ingested
				? null
				: boundReason(args.record.reason ?? "invalid runner result"),
			finishedAt: args.at,
		})
		.where(
			and(
				eq(jobAttempts.id, args.attemptId),
				notInArray(jobAttempts.status, ["completed", "failed"]),
			),
		);
}

/**
 * The attempt is now terminal, so the box it held is no longer held by this job.
 * Release the pool claim in the SAME transaction that finishes the attempt: the
 * two facts must not be able to disagree, or `runner_boxes` starts reporting a
 * box as held by a job that already finished — a false leak, which is what makes
 * a real leak easy to dismiss.
 *
 * Only clears a claim still attributed to THIS runner job id. A newer attempt may
 * already have claimed the same vmid, and stealing its claim would leave a live
 * box unattributed — the exact harm the claim exists to prevent.
 */
async function releasePoolClaim(
	tx: StoreTx,
	runnerVmid: number | null,
	jobRunnerId: string,
	at: Date,
): Promise<void> {
	if (runnerVmid === null) {
		return;
	}
	await tx
		.update(runnerBoxes)
		.set({ heldByJobId: null, heldAt: null, updatedAt: at })
		.where(and(eq(runnerBoxes.vmid, runnerVmid), eq(runnerBoxes.heldByJobId, jobRunnerId)));
}

/**
 * Record this result against its own attempt: the bounded posting row, the
 * once-only attempt finish, and the release of the pool claim it held.
 *
 * ORDER MATTERS and is the reason these three writes live together: the posting
 * is written first so the artifact is recorded even if nothing below transitions,
 * the attempt is finished next, and the claim is released last — a released claim
 * must never be observable before the attempt that held it is terminal. All three
 * run inside the caller's transaction, so they commit as one fact.
 */
async function recordAttemptOutcome(
	tx: StoreTx,
	args: {
		attempt: { id: number; jobId: number; runnerVmid: number | null };
		target: string;
		ingested: boolean;
		record: PersistedResult;
		jobRunnerId: string;
		at: Date;
	},
): Promise<void> {
	await recordPosting(tx, {
		jobId: args.attempt.jobId,
		target: args.target,
		ingested: args.ingested,
		record: args.record,
		at: args.at,
	});
	await finishAttemptOnce(tx, {
		attemptId: args.attempt.id,
		ingested: args.ingested,
		record: args.record,
		at: args.at,
	});
	await releasePoolClaim(tx, args.attempt.runnerVmid, args.jobRunnerId, args.at);
}

/**
 * NAME THE CLOSE. One INFO line when THIS result terminalized its job
 * for a deterministic ingest rejection, so an operator reading a terminal row
 * with the sf#376 reason can find the ingest that wrote it. Silent for every
 * other outcome, including a superseded attempt that no longer owns the job.
 */
function logDeterministicRejection(
	attempt: { id: number; jobId: number },
	jobTransitioned: boolean | null,
	identityDecision: PersistDecision | undefined,
): void {
	if (jobTransitioned !== true || identityDecision === undefined) return;
	log("info", "results.deterministic_rejection_terminal", {
		job_id: attempt.jobId,
		attempt_id: attempt.id,
		reason: identityDecision.reason,
	});
}

/**
 * Advance the job to its terminal state, but only for the attempt that OWNS it.
 *
 * Only the attempt that OWNS the job may terminate it, and only while the job is
 * the one it dispatched (`running`). Ownership is the persisted
 * `jobs.active_attempt_id` marker, set atomically when an attempt claims
 * the job at dispatch and cleared whenever it is re-pended. It is the direct
 * ownership fact, not the "newest attempt row" heuristic it replaces: the
 * reclaimer can re-pend a stalled attempt's job and a NEWER attempt then
 * owns it, so a stale attempt's result — however recent its own row — must not
 * terminate the live re-run. The `active_attempt_id` guard on the update below
 * matches zero rows for any attempt that no longer owns the job. Reading it first
 * lets a superseded result return without a wasted write.
 *
 * `terminalReason`, when non-null, is written with the status so the two facts
 * commit together: a row closed for a deterministic rejection must never
 * be observable as terminal-`failed` with no reason, because that exact shape is
 * what the infra requeue sweep revives.
 *
 * Returns `null` when this attempt no longer owns the job (the caller returns
 * without transitioning), otherwise whether THIS call transitioned it.
 */
async function terminateJobIfOwned(
	tx: StoreTx,
	args: {
		attemptId: number;
		jobId: number;
		jobStatus: string;
		terminalReason: string | null;
		at: Date;
	},
): Promise<boolean | null> {
	const [owner] = await tx
		.select({ activeAttemptId: jobs.activeAttemptId })
		.from(jobs)
		.where(eq(jobs.id, args.jobId))
		.limit(1);
	if (owner?.activeAttemptId !== args.attemptId) {
		return null;
	}

	const updated = await tx
		.update(jobs)
		.set({
			status: args.jobStatus,
			updatedAt: args.at,
			...(args.terminalReason === null ? {} : { terminalReason: args.terminalReason }),
		})
		.where(
			and(
				eq(jobs.id, args.jobId),
				eq(jobs.status, "running"),
				eq(jobs.activeAttemptId, args.attemptId),
			),
		)
		.returning({ id: jobs.id });

	return updated.length > 0;
}

/**
 * Promote the ONE posting whose result transitioned the job to `accepted`.
 *
 * `jobTransitioned` is true iff the running-only + ownership guard matched a row.
 * That is the ONE signal that distinguishes THE result that completed the job
 * from every OTHER schema-valid, identity-matching result for the same attempt:
 * reconcile ingests every host dir under an attempt (`reconcile.ts`), and
 * hostnames on the share are runner-writable, so a second host can independently
 * pass full verification and land its own `recorded` posting. Only the
 * job-completing host's posting is marked `accepted`, in the SAME transaction
 * that transitions the job, so the candidate loader can bind the pushed bundle to
 * THAT result and never to a merely-recorded one (from PR #86 review finding
 * 1). The runner cannot choose which of two verified trees is proposed, because
 * it does not choose which result wins the `running`-guarded update — the DB
 * does, once.
 *
 * Scoped to a job COMPLETION (`jobStatus === "completed"`, i.e. an ingested
 * pass/skip), which mirrors the loader's `jobs.status = completed` clause. A
 * transition that FAILS the job leaves its posting `invalid`/`recorded`: an
 * accepted change must be a verified pass, never a failure that merely happened
 * to be the one that terminated the job.
 */
async function acceptWinningPosting(
	tx: StoreTx,
	args: { jobId: number; target: string; jobTransitioned: boolean; jobStatus: string },
): Promise<void> {
	const jobCompleted = args.jobTransitioned && args.jobStatus === "completed";
	if (!jobCompleted) {
		return;
	}
	await tx
		.update(resultPostings)
		.set({ status: "accepted" })
		.where(and(eq(resultPostings.jobId, args.jobId), eq(resultPostings.target, args.target)));
}

/** Match every dispatched identity field without echoing mismatches. */
function matchesExpectedIdentity(
	record: PersistedResult,
	expected:
		| { repository: string; jobType: string; sha: string; itemNumber: number | null }
		| undefined,
): boolean {
	const result = record.result;
	const itemMatches =
		expected?.itemNumber === null
			? result?.item_number === undefined
			: result?.item_number === expected?.itemNumber;
	const shaMatches =
		expected?.sha === "" ? result?.sha === undefined : result?.sha === expected?.sha;
	return (
		expected !== undefined &&
		result !== undefined &&
		itemMatches &&
		shaMatches &&
		result.repository === expected.repository &&
		result.job_type === expected.jobType
	);
}

/** Bound store-facing failure text even when called outside the parser. */
function boundReason(reason: string): string {
	return reason.replace(/\s+/g, " ").trim().slice(0, 300);
}

/** A result counts as passing when its overall status is passed or skipped. */
function isPassing(record: PersistedResult): boolean {
	const s = record.result?.status;
	return s === "passed" || s === "skipped";
}
