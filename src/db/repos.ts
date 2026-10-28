/**
 * @module db/repos
 * @description Transaction-safe repository functions over the watcher schema.
 *   These are the only sanctioned writers for reconciliation state: upsert a
 *   managed repository, upsert an observed GitHub item, create a pending job
 *   idempotently, and read/advance a reconciliation cursor. Idempotency is
 *   enforced by the schema's unique keys (see _DOCS/db-protocol.md); these
 *   helpers rely on `onConflictDoUpdate`/`onConflictDoNothing` rather than
 *   read-then-write races.
 *
 * @outputs
 *   - `upsertRepository`, `getCursor`, `setCursor`
 *   - `upsertGithubItem`, `createPendingJob`, `hasLiveJobForItem`
 *   - `hasLiveJobForKboardTask` -- the #71 ready-station idempotency guard
 *   - `seedRunnerBoxes`, `claimRunnerBox`, `releaseRunnerBox`, `listHeldRunnerBoxes`
 *
 * @dependencies
 *   - drizzle-orm -- query building and conflict clauses
 *   - ./schema -- table definitions
 *   - ./client -- WatcherDb type
 */
import { and, eq, inArray, isNotNull, sql } from "drizzle-orm";
import { traced } from "../log";
import { RUNNER_BOXES } from "../runner/bands";
import type { WatcherDb } from "./client";
import { githubItems, jobs, reconciliationCursors, repositories, runnerBoxes } from "./schema";

/**
 * Insert or update a managed repository by its PROVIDER-QUALIFIED identity
 * (`provider, full_name`); return its id. `provider` defaults to `github` so an
 * existing caller that passes only `full_name` keeps resolving to the same
 * GitHub row it always did (the column default and the backfill both make a
 * bare `owner/repo` a GitHub repository).
 */
async function upsertRepositoryImpl(
	db: WatcherDb,
	fullName: string,
	checks: string,
	provider = "github",
): Promise<number> {
	const [row] = await db
		.insert(repositories)
		.values({ provider, fullName, checks })
		.onConflictDoUpdate({
			target: [repositories.provider, repositories.fullName],
			set: { checks, updatedAt: sql`now()` },
		})
		.returning({ id: repositories.id });
	if (!row) {
		throw new Error(`failed to upsert repository ${provider}:${fullName}`);
	}
	return row.id;
}

export const upsertRepository = traced("db.upsertRepository", upsertRepositoryImpl);

/**
 * Write the runner box inventory into `runner_boxes`, idempotently.
 *
 * The rows come from `src/runner/bands.ts`, which STATES every MAC and IP rather
 * than deriving one. This is the one place the inventory is written; nothing else
 * inserts a box row.
 *
 * `onConflictDoUpdate` refreshes the addressing columns but deliberately does NOT
 * touch `heldByJobId`/`heldAt`: re-seeding on startup must never silently release
 * a box some job is currently holding. A claim is released by `releaseRunnerBox`,
 * never by a seed.
 */
async function seedRunnerBoxesImpl(db: WatcherDb): Promise<number> {
	const rows = RUNNER_BOXES.map((box) => ({
		vmid: box.vmid,
		band: box.band,
		mac: box.mac,
		ip: box.ip,
		allocatable: box.allocatable,
	}));
	await db
		.insert(runnerBoxes)
		.values(rows)
		.onConflictDoUpdate({
			target: runnerBoxes.vmid,
			set: {
				band: sql`excluded.band`,
				mac: sql`excluded.mac`,
				ip: sql`excluded.ip`,
				allocatable: sql`excluded.allocatable`,
				updatedAt: sql`now()`,
			},
		});
	return rows.length;
}

export const seedRunnerBoxes = traced("db.seedRunnerBoxes", seedRunnerBoxesImpl);

/**
 * Record that `jobId` holds `vmid`. Returns false when the VMID is not an
 * allocatable box, so a caller cannot claim a template or an unknown id.
 *
 * Written BEFORE dispatch so a box that is later lost to a transport timeout is
 * still attributable — that is the whole point. A claim on an
 * already-held box overwrites the holder rather than failing: the fleet is the
 * source of truth for what is running, and refusing here would leave a real box
 * unattributed.
 */
async function claimRunnerBoxImpl(db: WatcherDb, vmid: number, jobId: string): Promise<boolean> {
	const updated = await db
		.update(runnerBoxes)
		.set({ heldByJobId: jobId, heldAt: sql`now()`, updatedAt: sql`now()` })
		.where(and(eq(runnerBoxes.vmid, vmid), eq(runnerBoxes.allocatable, true)))
		.returning({ vmid: runnerBoxes.vmid });
	return updated.length > 0;
}

export const claimRunnerBox = traced("db.claimRunnerBox", claimRunnerBoxImpl);

/** Clear the claim on `vmid`. Safe to call for a box that is already free. */
async function releaseRunnerBoxImpl(
	db: WatcherDb,
	vmid: number,
	expectedHolder?: string,
): Promise<boolean> {
	// Scoping to the holder is what stops a LATE attempt from clearing a LIVE
	// one's claim: A times out on 9001, stalls; the fleet recycles the box; B is
	// allocated 9001 and claims it; A finally runs its release. Unscoped, A erases
	// B's claim and the caller then reaps B's running box. Scoped, A matches zero
	// rows and learns it no longer owns the box.
	const where =
		expectedHolder === undefined
			? eq(runnerBoxes.vmid, vmid)
			: and(eq(runnerBoxes.vmid, vmid), eq(runnerBoxes.heldByJobId, expectedHolder));
	const released = await db
		.update(runnerBoxes)
		.set({ heldByJobId: null, heldAt: null, updatedAt: sql`now()` })
		.where(where)
		.returning({ vmid: runnerBoxes.vmid });
	return released.length > 0;
}

export const releaseRunnerBox = traced("db.releaseRunnerBox", releaseRunnerBoxImpl);

/**
 * Every box the watcher believes is held. A row here with no live job is a LEAK
 * the operator can see and reap, which is what nothing could do before.
 */
async function listHeldRunnerBoxesImpl(
	db: WatcherDb,
): Promise<{ vmid: number; heldByJobId: string | null; heldAt: Date | null }[]> {
	return db
		.select({
			vmid: runnerBoxes.vmid,
			heldByJobId: runnerBoxes.heldByJobId,
			heldAt: runnerBoxes.heldAt,
		})
		.from(runnerBoxes)
		.where(isNotNull(runnerBoxes.heldByJobId));
}

export const listHeldRunnerBoxes = traced("db.listHeldRunnerBoxes", listHeldRunnerBoxesImpl);

/** Read the stored cursor for a repository/resource, or null if none yet. */
async function getCursorImpl(
	db: WatcherDb,
	repositoryId: number,
	resource: string,
): Promise<string | null> {
	const [row] = await db
		.select({ cursor: reconciliationCursors.cursor })
		.from(reconciliationCursors)
		.where(
			and(
				eq(reconciliationCursors.repositoryId, repositoryId),
				eq(reconciliationCursors.resource, resource),
			),
		)
		.limit(1);
	return row?.cursor ?? null;
}

export const getCursor = traced("db.getCursor", getCursorImpl);

/** Advance (or create) the cursor for a repository/resource. */
async function setCursorImpl(
	db: WatcherDb,
	repositoryId: number,
	resource: string,
	cursor: string,
): Promise<void> {
	await db
		.insert(reconciliationCursors)
		.values({ repositoryId, resource, cursor, lastSyncedAt: sql`now()` })
		.onConflictDoUpdate({
			target: [reconciliationCursors.repositoryId, reconciliationCursors.resource],
			set: { cursor, lastSyncedAt: sql`now()`, updatedAt: sql`now()` },
		});
}

export const setCursor = traced("db.setCursor", setCursorImpl);

/** A normalized item as produced by the GitHub read layer. */
export interface UpsertItemInput {
	repositoryId: number;
	kind: "issue" | "pull";
	number: number;
	headSha: string | null;
	state: string;
	title: string;
	githubUpdatedAt: string;
}

/** Insert or update an observed GitHub item; return its id. */
async function upsertGithubItemImpl(db: WatcherDb, item: UpsertItemInput): Promise<number> {
	const [row] = await db
		.insert(githubItems)
		.values({
			repositoryId: item.repositoryId,
			kind: item.kind,
			number: item.number,
			headSha: item.headSha,
			state: item.state,
			title: item.title,
			githubUpdatedAt: new Date(item.githubUpdatedAt),
			observedAt: sql`now()`,
		})
		.onConflictDoUpdate({
			target: [githubItems.repositoryId, githubItems.kind, githubItems.number],
			set: {
				headSha: item.headSha,
				state: item.state,
				title: item.title,
				githubUpdatedAt: new Date(item.githubUpdatedAt),
				observedAt: sql`now()`,
			},
		})
		.returning({ id: githubItems.id });
	if (!row) {
		throw new Error(`failed to upsert item ${item.kind}#${item.number}`);
	}
	return row.id;
}

export const upsertGithubItem = traced("db.upsertGithubItem", upsertGithubItemImpl);

/** A pending job to create, keyed for idempotency by (repo, item, sha, type). */
export interface PendingJobInput {
	repositoryId: number;
	itemId: number | null;
	sha: string;
	jobType: string;
	/**
	 * The k-board task this job was claimed from. Omitted by every
	 * label-triggered caller, which leaves the column NULL and the pre-existing
	 * behaviour byte-identical. Set ONLY by the ready-station pass, and only for a
	 * job it is creating right now under a won claim — never back-filled onto a job
	 * that already exists, because a job the board did not claim is not the board's
	 * to report on.
	 */
	kboardTaskId?: string;
	/**
	 * The repository a proposed change must be rooted on, when it differs from
	 * this job's own. Omitted by every caller whose change targets the
	 * repository it was dispatched against, which leaves the column NULL and the
	 * pre-existing behaviour byte-identical.
	 */
	changeBaseRepository?: string;
	/**
	 * The exact commit a proposed change must descend from, when it differs from
	 * `sha`. Deliberately NOT folded into `sha`: `sha` is part of this
	 * function's idempotency key, and overloading it would change dedup semantics.
	 */
	changeBaseSha?: string;
}

/**
 * Statuses in which a job is still LIVE — queued, being handed to a box, or
 * running on one. Anything else is terminal for that attempt.
 */
const LIVE_JOB_STATUSES = ["pending", "dispatching", "running"] as const;

/**
 * True when this item already has a live job of this type, regardless of SHA.
 *
 * The `jobs` unique key is `(repository, item, sha, job_type)`, which is exactly
 * right for the review lane: its `sha` is the PR head, so a new SHA IS new work.
 * It is wrong for the implement lane, whose `sha` is the BASE BRANCH TIP — a
 * value that moves every time anything merges, with no relation to the issue.
 * Keying on it means one unchanged labelled issue queues a fresh job on every
 * base movement, because the conflict target never matches.
 *
 * The item is the unit of work for a lane whose SHA is not item-derived, so the
 * question asked here is "is this ITEM already being worked?" rather than "has
 * this exact key been seen?". SHA-independent by design: the whole defect is
 * that the SHA varies while the work does not.
 *
 * A terminal job is deliberately NOT a bar to re-queueing. A finished attempt
 * against an older base is not the current work, so a still-labelled issue can
 * be picked up again once its previous attempt completes — which is also what
 * lets an operator re-run by removing and re-adding the label.
 */
async function hasLiveJobForItemImpl(
	db: WatcherDb,
	repositoryId: number,
	itemId: number,
	jobType: string,
): Promise<boolean> {
	const rows = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(
			and(
				eq(jobs.repositoryId, repositoryId),
				eq(jobs.itemId, itemId),
				eq(jobs.jobType, jobType),
				inArray(jobs.status, [...LIVE_JOB_STATUSES]),
			),
		)
		.limit(1);
	return rows.length > 0;
}

export const hasLiveJobForItem = traced("db.hasLiveJobForItem", hasLiveJobForItemImpl);

/**
 * Create a pending job if one does not already exist for its uniqueness key.
 *
 * @returns `true` when a new job row was created, `false` when it already
 *   existed (duplicate for the same repo, item, SHA, and type).
 */
async function createPendingJobImpl(db: WatcherDb, job: PendingJobInput): Promise<boolean> {
	const inserted = await db
		.insert(jobs)
		.values({
			repositoryId: job.repositoryId,
			itemId: job.itemId,
			sha: job.sha,
			jobType: job.jobType,
			status: "pending",
			// Undefined for every label-triggered caller, so the column takes its NULL
			// default and the insert is byte-identical to before.
			...(job.kboardTaskId === undefined ? {} : { kboardTaskId: job.kboardTaskId }),
			// Same shape, same reason: omitted by every pre-existing caller,
			// so the columns take their NULL default and the insert is unchanged.
			...(job.changeBaseRepository === undefined
				? {}
				: { changeBaseRepository: job.changeBaseRepository }),
			...(job.changeBaseSha === undefined ? {} : { changeBaseSha: job.changeBaseSha }),
		})
		.onConflictDoNothing({
			target: [jobs.repositoryId, jobs.itemId, jobs.sha, jobs.jobType],
		})
		.returning({ id: jobs.id });
	return inserted.length > 0;
}

export const createPendingJob = traced("db.createPendingJob", createPendingJobImpl);

/**
 * True when a k-board task ALREADY has a live local job.
 *
 * This is the pass's second idempotency guard and it is checked BEFORE any claim
 * is attempted, so a task whose job is already queued or running is skipped
 * without a PATCH ever leaving the process. The board is the work-state
 * authority, but the local `jobs` table is the DISPATCH bookkeeping — if the two
 * disagree (a task back in `ready` while its job still runs), the disagreement is
 * LOGGED and the task is skipped, never silently resolved by re-dispatching.
 *
 * Live-only, mirroring {@link hasLiveJobForItem}: a terminal job is not current
 * work, so a task legitimately re-entering `ready` after its previous run
 * finished can be claimed again. That re-entry is a human/phase-2 act — the
 * watcher itself never moves anything back to `ready`.
 */
async function hasLiveJobForKboardTaskImpl(db: WatcherDb, kboardTaskId: string): Promise<boolean> {
	const rows = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(and(eq(jobs.kboardTaskId, kboardTaskId), inArray(jobs.status, [...LIVE_JOB_STATUSES])))
		.limit(1);
	return rows.length > 0;
}

export const hasLiveJobForKboardTask = traced(
	"db.hasLiveJobForKboardTask",
	hasLiveJobForKboardTaskImpl,
);
