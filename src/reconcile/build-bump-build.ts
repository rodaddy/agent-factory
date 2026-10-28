/**
 * @module reconcile/build-bump-build
 * @description Drive each build-bump candidate through its Kaniko Job (
 *   child of sf#533): render, create or ADOPT, then watch to a terminal state.
 *
 *   ADOPTION IS THE LOST-RESPONSE DEFENCE. Before creating anything, the pass
 *   LISTS Jobs carrying this candidate's owner+app+tag+SHA labels — the commit
 *   is part of the key, because a force-moved tag is a second row with a new
 *   sha and must not adopt the Job that built the old one. A create whose response
 *   was lost — a timed-out verb that succeeded server-side, the trap this repo
 *   has already paid for twice — left a real Job behind, and the row is still
 *   `pending`. Listing first adopts that Job instead of building the same tag a
 *   second time. This is why the render uses `generateName`: the pass cannot
 *   recover by name, only by label.
 *
 *   NOTHING THROWS OUT OF THE PASS. A render refusal, a 404, a network drop —
 *   every per-row problem either fails THAT row or warns and leaves it for the
 *   next pass. One unreachable candidate must not stop its siblings, the same
 *   posture `build-bump-intake.ts` takes for a failed forge read.
 *
 *   `failed` IS TERMINAL. Kaniko runs with `backoffLimit: 0` because its
 *   failures are deterministic; retrying one burns the identical build again and
 *   hides the failure behind a churn loop. A failed candidate produces no bump
 *   and stays visibly failed until a human acts — that is sf#533's acceptance,
 *   not a gap.
 *
 *   EVERY UPDATE IS A COMPARE-AND-SET. Each write carries
 *   `WHERE id = ? AND status = <the status this pass read>`, so a concurrent or
 *   repeated pass cannot regress a row that already moved on. The read and the
 *   write are separated by a network round trip to the API server; without the
 *   guard, a slow pass could overwrite a newer terminal state with a stale one.
 *
 *   THE WATCH IS BOUNDED. Kubernetes enforces `activeDeadlineSeconds` itself and
 *   produces a `Failed` condition with reason `DeadlineExceeded`, so this pass's
 *   own timeout only exists for the case where the CONDITION never arrives (a
 *   Job garbage-collected mid-watch, a cluster that stops answering coherently).
 *   It fires one grace period past the deadline, fails the row, and does not
 *   re-create — a timeout that re-created would be the retry storm the terminal
 *   rule exists to prevent.
 *
 * @outputs
 *   - `MAX_BUILDS_PER_PASS` -- how many candidates one pass may start
 *   - `BuildBumpBuildDeps` -- the injected cluster client, clock, and warning sink
 *   - `runBuildBumpBuild` -- one create/adopt/watch pass over the candidate table
 *
 * @dependencies
 *   - ../db/schema -- build_bump_candidates
 *   - ../imagebuild/job -- renderKanikoJob / jobLabelSelector (pure)
 *   - ../imagebuild/kube -- the namespace-pinned Jobs client
 *   - ../log -- the shared traced() build-phase wrapper
 */
import { and, asc, eq, sql } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { type BuildBumpCandidateRow, buildBumpCandidates } from "../db/schema";
import {
	IMAGE_BUILDS,
	jobLabelSelector,
	type KanikoJobRequest,
	renderKanikoJob,
} from "../imagebuild/job";
import type { KubeJob, KubeJobsClient } from "../imagebuild/kube";
import { log, traced } from "../log";

/**
 * How many candidates one pass may START. The cap bounds cluster pressure: a
 * repository enrolled with a wide `tag_pattern` can produce dozens of candidates
 * in a single intake, and each Job asks for 500m CPU and 1Gi before it schedules.
 * The rest are simply picked up by the next pass — the table is the queue.
 */
export const MAX_BUILDS_PER_PASS = 5;

/**
 * Grace period past `activeDeadlineSeconds` before this pass gives up waiting
 * for a terminal condition Kubernetes should have produced itself.
 */
const WATCH_GRACE_SECONDS = 600;

/** The seams one pass drives; all injected so the pass is hermetic in tests. */
export interface BuildBumpBuildDeps {
	/** The Jobs client, or `null` when no kubeconfig is configured. */
	kube: KubeJobsClient | null;
	/** Clock seam, so the watch bound is testable without sleeping. */
	now?: () => Date;
	/** Bounded warning sink for a skipped row. */
	onWarn?: (message: string) => void;
}

/** Emit one bounded warning through the injected sink and the log. */
function warn(deps: BuildBumpBuildDeps, event: string, message: string): void {
	log("warn", event, { reason: message });
	deps.onWarn?.(message);
}

/**
 * The owner half of `<owner>/<repo>`: what separates `rtech/web` from
 * `acme/web`, whose short names collide. The app half of the adoption key
 * is the row's IMAGE, not the short name: the four rtech-mcps images
 * share owner, tag, and sha and must never adopt each other's Jobs.
 */
function ownerOf(repository: string): string {
	return repository.slice(0, repository.indexOf("/"));
}

/** Find a condition of `type` whose status is exactly `"True"`. */
function trueCondition(job: KubeJob, type: string) {
	return job.status?.conditions?.find((c) => c.type === type && c.status === "True");
}

/**
 * Everything one pass holds constant across its rows. Bundled rather than passed
 * as four arguments so each per-row helper stays inside the repo's parameter
 * ceiling, and so `now` is READ ONCE per pass — every row a pass touches then
 * carries the same timestamp, which is what makes "started this pass" a
 * meaningful comparison later.
 */
interface PassContext {
	db: WatcherDb;
	kube: KubeJobsClient;
	deps: BuildBumpBuildDeps;
	now: Date;
}

/**
 * Move one row, guarded on the status this pass read. The guard is the whole
 * concurrency story: a row someone else already advanced matches nothing.
 */
async function setStatus(
	ctx: PassContext,
	row: BuildBumpCandidateRow,
	next: Partial<typeof buildBumpCandidates.$inferInsert> & { status: string },
): Promise<void> {
	await ctx.db
		.update(buildBumpCandidates)
		.set(next)
		.where(and(eq(buildBumpCandidates.id, row.id), eq(buildBumpCandidates.status, row.status)));
}

/** Fail one row terminally with a bounded reason. */
async function failRow(
	ctx: PassContext,
	row: BuildBumpCandidateRow,
	reason: string,
): Promise<void> {
	await setStatus(ctx, row, { status: "failed", buildReason: reason, buildFinishedAt: ctx.now });
}

/**
 * Claim one pending row for the Job now building it, writing EVERY build field
 * fresh.
 *
 * A `pending` row is not necessarily a NEW row: the bump phase re-queues a
 * `failed` candidate a marker environment needs
 * (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §5), so the row arrives carrying the last
 * attempt's `build_job_name`, `build_finished_at`, and `build_reason`. Setting
 * only the two fields of a first attempt would leave a stale job name beside a
 * live one and a finished-at in the past of a build that just started — the
 * watch would then read the WRONG Job. So the claim writes all four, null where
 * this attempt has no value yet.
 */
async function claimRow(
	ctx: PassContext,
	row: BuildBumpCandidateRow,
	jobName: string,
): Promise<void> {
	await setStatus(ctx, row, {
		status: "building",
		buildJobName: jobName,
		buildStartedAt: ctx.now,
		buildFinishedAt: null,
		buildReason: null,
	});
}

/** The render request one candidate row is: its image and dockerfile ride along. */
function candidateRequest(row: BuildBumpCandidateRow): KanikoJobRequest {
	return {
		repository: row.repository,
		tag: row.tag,
		commitSha: row.sha,
		image: row.image,
		dockerfile: row.dockerfile,
	};
}

async function startCandidate(ctx: PassContext, row: BuildBumpCandidateRow): Promise<void> {
	const { kube, deps } = ctx;
	let body: unknown;
	try {
		body = renderKanikoJob(candidateRequest(row));
	} catch (error) {
		// A render refusal is a DATA error in the factory's own candidate — an
		// unpinned sha, a malformed repository. It cannot become valid by waiting,
		// so the row fails terminally rather than retrying every pass forever. The
		// message is already bounded by src/imagebuild/job.ts.
		await failRow(ctx, row, error instanceof Error ? error.message : "render refused");
		return;
	}

	// LIST BEFORE CREATE. See the module header: this is what makes a lost create
	// response recoverable rather than a duplicate build.
	// The selector carries the SHA and the IMAGE: the candidate table is unique
	// on (repository, tag, sha, image), so a force-moved tag has a second row, an
	// app+tag-only key would adopt the Job that built the old commit, and the
	// sibling images of one tag must never adopt each other's Jobs.
	const existing = await kube.listJobs(
		jobLabelSelector({
			owner: ownerOf(row.repository),
			app: row.image,
			tag: row.tag,
			sha: row.sha,
		}),
	);
	if (!existing.ok) {
		// Unknown whether a Job exists. Creating now could duplicate one; the row
		// stays pending and the next pass asks again.
		warn(deps, "build_bump_build.list_failed", `candidate ${row.id}: ${existing.reason}`);
		return;
	}
	const adopted = existing.job[0];
	if (adopted) {
		await claimRow(ctx, row, adopted.metadata.name);
		return;
	}

	const created = await kube.createJob(body);
	if (created.ok) {
		await claimRow(ctx, row, created.job.metadata.name);
		return;
	}
	if (created.status === 0 && created.reason !== "network error") {
		// Refused BEFORE the request left the process (a body the client would not
		// send). Deterministic, like a render refusal — fail the row.
		await failRow(ctx, row, created.reason);
		return;
	}
	// A network error or a non-2xx: the request MAY have created a Job. Leave the
	// row pending; the next pass's adoption step finds the orphan if there is one.
	warn(deps, "build_bump_build.create_failed", `candidate ${row.id}: ${created.reason}`);
}

/**
 * Apply the verdict read from a Job the API server DID return. Split from the
 * fetch half so each stays inside the repo's function-length bound.
 */
async function applyJobVerdict(
	ctx: PassContext,
	row: BuildBumpCandidateRow,
	job: KubeJob,
): Promise<void> {
	if (trueCondition(job, "Complete")) {
		await setStatus(ctx, row, { status: "built", buildFinishedAt: ctx.now });
		return;
	}
	const failed = trueCondition(job, "Failed");
	if (failed) {
		// The condition REASON only (`BackoffLimitExceeded`, `DeadlineExceeded`).
		// The message is cluster-supplied free text and is never stored.
		await failRow(ctx, row, failed.reason ?? "failed");
		return;
	}

	const startedAt = row.buildStartedAt?.getTime();
	const boundMs = (IMAGE_BUILDS.activeDeadlineSeconds + WATCH_GRACE_SECONDS) * 1000;
	if (startedAt !== undefined && ctx.now.getTime() - startedAt > boundMs) {
		await failRow(ctx, row, "watch timeout");
	}
	// Otherwise the Job is still running: nothing to do this pass.
}

/** Watch one building candidate for a terminal condition. */
async function watchCandidate(ctx: PassContext, row: BuildBumpCandidateRow): Promise<void> {
	if (!row.buildJobName) {
		// Cannot happen through this pass (building is only ever set with a name),
		// but a hand-edited row must not become an unwatchable zombie.
		await failRow(ctx, row, "job missing");
		return;
	}

	const result = await ctx.kube.getJob(row.buildJobName);
	if (!result.ok) {
		if (result.status === 404) {
			// The Job is gone: ttlSecondsAfterFinished reaped it before this pass
			// observed its condition, or something deleted it. Either way there is no
			// verdict to read and re-creating is not this pass's call.
			await failRow(ctx, row, "job missing");
			return;
		}
		warn(ctx.deps, "build_bump_build.get_failed", `candidate ${row.id}: ${result.reason}`);
		return;
	}

	await applyJobVerdict(ctx, row, result.job);
}

/**
 * One build pass: start up to `MAX_BUILDS_PER_PASS` pending candidates and check
 * every building one for a terminal condition.
 *
 * Runs as its own cycle step AFTER `runBuildBumpIntake`, so a tag observed this
 * pass can start building in the same cycle. It dispatches no factory job and
 * advances no cursor.
 *
 * @param db - watcher database
 * @param deps - the injected cluster client, clock, and warning sink
 */
export const runBuildBumpBuild = traced(
	"reconcile.runBuildBumpBuild",
	async function runBuildBumpBuild(db: WatcherDb, deps: BuildBumpBuildDeps): Promise<void> {
		const kube = deps.kube;
		if (kube === null) {
			// Not an error: a factory deployment without the image-builds credential
			// simply does not run this rail. One warning, no row touched.
			warn(deps, "build_bump_build.no_kubeconfig", "build_bump_build.no_kubeconfig");
			return;
		}
		const ctx: PassContext = { db, kube, deps, now: (deps.now ?? (() => new Date()))() };

		// BOTH SETS ARE READ BEFORE EITHER IS DRIVEN. A row this pass starts is
		// `building` by the time the watch loop runs, and getJob-ing a Job created
		// milliseconds ago can only ever say "still running" — a guaranteed-useless
		// round trip per candidate. Reading the watch set first excludes them.
		const pending = await db
			.select()
			.from(buildBumpCandidates)
			.where(eq(buildBumpCandidates.status, "pending"))
			// NEWEST COMMIT DATE FIRST, id only as the tiebreak. Row id is
			// NOT a recency order: it runs in opposite directions for a repository
			// enrolled in one batch and one grown tag by tag. NULL is "unknown", so
			// it sorts LAST rather than reading as old.
			.orderBy(
				sql`${buildBumpCandidates.tagCreatedAt} DESC NULLS LAST`,
				asc(buildBumpCandidates.id),
			)
			.limit(MAX_BUILDS_PER_PASS);
		const building = await db
			.select()
			.from(buildBumpCandidates)
			.where(eq(buildBumpCandidates.status, "building"))
			.orderBy(asc(buildBumpCandidates.id));

		for (const row of pending) {
			await startCandidate(ctx, row);
		}
		for (const row of building) {
			await watchCandidate(ctx, row);
		}
	},
);
