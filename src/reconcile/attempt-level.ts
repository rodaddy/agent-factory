/**
 * @module reconcile/attempt-level
 * @description The per-attempt log level (Surface E): a job's FIRST attempt
 *   runs at `info`, any respawn at `debug`.
 *
 *   The decision is DISPATCH-TIME ESCALATION, not tail-based sampling (D15:
 *   "debug until it runs clean, then info"). It is taken where the attempt row is
 *   written and the job's prior attempt count is known, for ANY runtime, then
 *   recorded on `job_attempts.level` and carried on the render context as
 *   `logLevel` so a workflow dispatch can hand it to the lane as `log_level`. The
 *   box lane records it and ignores it. The watcher process keeps its own global
 *   level; this seam is for the lane only.
 *
 * @outputs
 *   - `AttemptLevel` -- the two levels an attempt can run at
 *   - `attemptLevelFor` -- the rule, from the job's prior attempt count
 *   - `decideAttemptLevel` -- the rule applied to the job's recorded attempts
 *
 * @dependencies
 *   - ../db/schema -- job_attempts
 *   - ../log -- `traced`
 */
import { count, eq } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { jobAttempts } from "../db/schema";
import { traced } from "../log";

/** The level an attempt runs at; the column default is `info`. */
export type AttemptLevel = "info" | "debug";

/** First attempt of a job (no prior rows) runs `info`; any respawn runs `debug`. */
export const attemptLevelFor = traced(
	"reconcile.attemptLevelFor",
	function attemptLevelFor(priorAttempts: number): AttemptLevel {
		return priorAttempts === 0 ? "info" : "debug";
	},
);

/**
 * Decide THIS dispatch's level from the attempts the job already recorded. Must run
 * before this dispatch writes its own row, or every attempt would read as a respawn.
 */
export const decideAttemptLevel = traced(
	"reconcile.decideAttemptLevel",
	async function decideAttemptLevel(db: WatcherDb, jobId: number): Promise<AttemptLevel> {
		const [row] = await db
			.select({ n: count() })
			.from(jobAttempts)
			.where(eq(jobAttempts.jobId, jobId));
		return attemptLevelFor(Number(row?.n ?? 0));
	},
);
