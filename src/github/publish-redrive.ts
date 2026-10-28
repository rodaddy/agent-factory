/**
 * @module github/publish-redrive
 * @description The explicit operator recovery boundary for one exhausted check
 *   posting. It only re-arms an existing failed normal check row; the existing
 *   publisher remains the sole owner of the remote write.
 */
import { and, eq, ne } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { githubPostings, jobs } from "../db/schema";
import { log, traced } from "../log";
import { CHECK_TARGET } from "./publication";

type WatcherTx = Parameters<Parameters<WatcherDb["transaction"]>[0]>[0];
type LockedPosting = { id: number; status: string; attempts: number };

export type RedriveOutcome =
	| { status: "queued"; jobId: number; postingId: number; previousAttempts: number }
	| { status: "not-found"; jobId: number }
	| { status: "not-failed"; jobId: number; postingId: number; currentStatus: string };

/** A strict positive, safe integer accepted by the operator command. */
export const isPositiveJobId = traced(
	"github.isPositiveJobId",
	function isPositiveJobId(value: string): boolean {
		if (!/^[1-9][0-9]*$/.test(value)) return false;
		const parsed = Number(value);
		return Number.isSafeInteger(parsed) && parsed > 0;
	},
);

function assertPositiveJobId(jobId: number): void {
	if (!Number.isSafeInteger(jobId) || jobId <= 0) {
		throw new Error("job id must be a positive safe integer");
	}
}

async function findNormalCheck(tx: WatcherTx, jobId: number): Promise<LockedPosting | undefined> {
	const [posting] = await tx
		.select({
			id: githubPostings.id,
			status: githubPostings.status,
			attempts: githubPostings.attempts,
		})
		.from(githubPostings)
		.innerJoin(jobs, eq(jobs.id, githubPostings.jobId))
		.where(
			and(
				eq(githubPostings.jobId, jobId),
				eq(githubPostings.kind, "check"),
				eq(githubPostings.target, CHECK_TARGET),
				ne(jobs.sha, ""),
			),
		)
		.for("update")
		.limit(1);
	return posting;
}

async function transitionPosting(
	tx: WatcherTx,
	jobId: number,
	posting: LockedPosting,
	now: Date,
): Promise<RedriveOutcome> {
	if (posting.status !== "failed") {
		return {
			status: "not-failed",
			jobId,
			postingId: posting.id,
			currentStatus: posting.status,
		};
	}

	const [updated] = await tx
		.update(githubPostings)
		.set({
			status: "pending",
			attempts: 0,
			nextAttemptAt: null,
			lastError: null,
			updatedAt: now,
		})
		.where(and(eq(githubPostings.id, posting.id), eq(githubPostings.status, "failed")))
		.returning({ id: githubPostings.id });

	if (!updated) {
		return { status: "not-failed", jobId, postingId: posting.id, currentStatus: "pending" };
	}
	return {
		status: "queued",
		jobId,
		postingId: posting.id,
		previousAttempts: posting.attempts,
	};
}

async function redriveInTransaction(
	tx: WatcherTx,
	jobId: number,
	now: Date,
): Promise<RedriveOutcome> {
	const posting = await findNormalCheck(tx, jobId);
	return posting ? transitionPosting(tx, jobId, posting, now) : { status: "not-found", jobId };
}

/**
 * Re-arm the one normal exact-SHA check posting for a job after its retry budget
 * was spent. A job without a trusted SHA is outside this recovery boundary. The
 * row lock and failed-status update guard make repeated/concurrent calls
 * converge: exactly one caller changes a failed row, and later callers observe
 * the pending state. No row is created and no remote operation occurs.
 */
export const redriveFailedCheck = traced(
	"github.redriveFailedCheck",
	async function redriveFailedCheck(
		db: WatcherDb,
		jobId: number,
		now: Date = new Date(),
	): Promise<RedriveOutcome> {
		assertPositiveJobId(jobId);
		const outcome = await db.transaction((tx) => redriveInTransaction(tx, jobId, now));

		if (outcome.status === "queued") {
			log("info", "publish.redrive_check.queued", {
				job_id: outcome.jobId,
				posting_id: outcome.postingId,
				previous_attempts: outcome.previousAttempts,
			});
		}

		return outcome;
	},
);
