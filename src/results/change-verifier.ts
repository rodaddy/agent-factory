/**
 * @module results/change-verifier
 * @description The production `ChangeVerifier`: the wire between a claimed
 *   change in a runner result and `results/change-ingest`, which proves it.
 *
 *   `change-ingest` was built, tested, and defended in isolation and had NO
 *   production caller — so `result.change` was never read, no bundle was ever
 *   verified, and no snapshot was ever written for the proposal pass to push.
 *   This module is what calls it, and what supplies the three things it needs
 *   that only trusted state can provide:
 *
 *   1. **The job's own output directory** — the confinement root the claimed
 *      bundle path must resolve inside. Derived from the share layout and the
 *      runner job id, never from the result.
 *   2. **The EXACT dispatched base SHA** — read from the `jobs` row, never from
 *      the result. A change is proved to descend from what the watcher actually
 *      dispatched; a bundle that applies to some other commit describes work
 *      against a tree nobody asked for.
 *   3. **A watcher-owned snapshot path** — outside the runner-writable share, so
 *      the artifact that was verified is byte-for-byte the artifact that is later
 *      pushed. `change-ingest` copies with `wx` and every git invocation reads
 *      the snapshot, closing the swap window between verify and use.
 *
 *   SCRATCH REPOSITORY. `git bundle verify` can only confirm a prerequisite that
 *   the inspecting repository already HAS, so the scratch clone is fetched at the
 *   dispatched base before inspection. Without that fetch the prerequisite check
 *   is vacuous and every bundle verifies. The scratch repo is watcher-owned and
 *   per-job: `LocalBundleInspector.changedPaths` writes a ref into whatever
 *   repository it is pointed at, so it must never be the watcher's own checkout.
 *
 * @outputs
 *   - `ShareChangeVerifier` -- the production ChangeVerifier
 *   - `snapshotPathFor` -- the watcher-owned snapshot path for a runner job
 *   - `defaultChangeWorkRoot` -- the watcher-owned work root, outside the share
 *   - `environmentErrnoClass` -- names a deployment-class errno a retry cannot fix
 *
 * @dependencies
 *   - ./change-ingest -- the verification this module exists to invoke
 *   - ./bundle-inspector -- the git-backed inspector it runs
 *   - ../db/schema -- the trusted dispatched base SHA
 */
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { desc, eq } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { jobAttempts, jobs, repositories } from "../db/schema";
import { dispatchedBaseForJob } from "../jobs/verb-base";
import { errorMessage, log, traced } from "../log";
import { LocalBundleInspector } from "./bundle-inspector";
import { quarantinePathFor, verifyChangeBundle } from "./change-ingest";
import { CHECK_TRAIL_REASONS, reconcileCheckTrail } from "./check-trail";
import type { ChangeVerifier } from "./ingest";
import type { RunnerResult } from "./schema";

/**
 * The default watcher-owned work root.
 *
 * Deliberately NOT under the collab share. The runner owns the write side of its
 * own job directory there, and a snapshot the runner could rewrite between
 * verification and push would make the snapshot pointless. `WATCHER_WORK_ROOT`
 * overrides it for a deployment that puts watcher state elsewhere.
 */
export const defaultChangeWorkRoot = traced(
	"results.defaultChangeWorkRoot",
	function defaultChangeWorkRoot(env: NodeJS.ProcessEnv = process.env): string {
		return env.WATCHER_WORK_ROOT ?? "/var/lib/software-factory/work";
	},
	{ redact: { args: [0] } },
);

/**
 * The errno family that describes the DEPLOYMENT, not the job: a read-only
 * filesystem, a permission the service does not hold, a full disk. Retrying the
 * identical job against the identical environment cannot change any of these
 * answers, so they are worth naming separately from a transient infra fault.
 *
 * Matched on the `code` property Node attaches to a `SystemError`, never on the
 * message text — the message is locale- and version-dependent prose.
 */
const ENVIRONMENT_ERRNOS = new Set(["EROFS", "EACCES", "EPERM", "ENOSPC"]);

/**
 * The environment-class errno of a caught value, or `null` if it is not one.
 *
 * @param err - the caught value
 * @returns the errno string (e.g. `"EROFS"`) when it names a deployment defect
 */
export const environmentErrnoClass = traced(
	"results.environmentErrnoClass",
	function environmentErrnoClass(err: unknown): string | null {
		if (typeof err !== "object" || err === null) {
			return null;
		}
		const code = (err as { code?: unknown }).code;
		return typeof code === "string" && ENVIRONMENT_ERRNOS.has(code) ? code : null;
	},
);

/** Where verified snapshots and scratch clones live. Watcher-owned, never runner-writable. */
export interface ChangeVerifierPaths {
	/** The collab share root the runner writes its job output under. */
	shareRoot: string;
	/** A watcher-owned working root. MUST NOT be inside `shareRoot`. */
	workRoot: string;
}

/**
 * The watcher-owned snapshot path for one runner job ON ONE HOST. The proposal
 * pass resolves the SAME path when it pushes, so the bytes that were verified
 * are the bytes that are pushed.
 *
 * KEYED ON (job, host), NOT job alone. Results are per `(jobRunnerId, hostname)`
 * — `result_postings.target` is `runner:<host>:<jobRunnerId>` — and result
 * reconciliation ingests EVERY host directory under an attempt without stopping
 * at the first success. A job-only key therefore let host B's bundle overwrite
 * host A's at a fixed path: verification A could authorize a push of B's bytes,
 * and a report-only result from A could complete the job while B supplied the
 * code. Including the host makes the snapshot correspond exactly to the one
 * result that was accepted.
 *
 * Both segments are validated by the caller before reaching here (the share
 * reader applies `isSafeSegment` to each), so a traversal cannot widen the path.
 */
export const snapshotPathFor = traced(
	"results.snapshotPathFor",
	function snapshotPathFor(workRoot: string, jobRunnerId: string, hostname: string): string {
		return join(workRoot, "verified", `${jobRunnerId}__${hostname}.bundle`);
	},
);

/**
 * A single path segment safe to join: no separator, no traversal, no NUL.
 * Mirrors `share-reader`'s `isSafeSegment`; both sides must agree, and this
 * module re-checks rather than assuming the caller already did.
 */
function isSafePathSegment(segment: string): boolean {
	return (
		segment.length > 0 &&
		segment.length <= 255 &&
		/^[A-Za-z0-9._-]+$/.test(segment) &&
		segment !== "." &&
		segment !== ".."
	);
}

/**
 * The scratch repository one verification inspects in.
 *
 * Keyed by the ATTEMPT id as well as the job, so a retry always initializes a
 * fresh bare repo rather than reusing a half-built one from a failed run — and
 * so nothing here needs a recursive delete to become usable again. Stale scratch
 * directories are operator-reclaimable under the watcher's own work root.
 */
function scratchRepoFor(workRoot: string, jobRunnerId: string, attemptId: number): string {
	return join(workRoot, "scratch", `${jobRunnerId}-${attemptId}`);
}

/** The bounded git surface this module needs, injected so tests need no git. */
export interface VerifierGit {
	run(
		args: string[],
		options: { cwd?: string; credential?: string },
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

/**
 * Verify a claimed change against trusted state before its result is accepted.
 *
 * Every rejection reason is a FIXED author string. `change-ingest` already
 * returns bounded reasons, but this boundary re-states rather than forwards
 * anything that could carry runner-influenced text into an operator-visible
 * field.
 */
/** Construction arguments for {@link ShareChangeVerifier}. */
export type ShareChangeVerifierArgs = {
	db: WatcherDb;
	paths: ChangeVerifierPaths;
	remoteFor: (repository: string) => string | null;
	git: VerifierGit;
	/** Read credential for the base fetch. Private repos cannot verify without it. */
	credentialFor: (repository: string) => Promise<string | null>;
};

export class ShareChangeVerifier implements ChangeVerifier {
	private readonly db: WatcherDb;
	private readonly paths: ChangeVerifierPaths;
	private readonly remoteFor: (repository: string) => string | null;
	private readonly git: VerifierGit;
	private readonly credentialFor: (repository: string) => Promise<string | null>;

	constructor({ db, paths, remoteFor, git, credentialFor }: ShareChangeVerifierArgs) {
		this.db = db;
		this.paths = paths;
		this.remoteFor = remoteFor;
		this.git = git;
		this.credentialFor = credentialFor;
	}

	async verify(
		jobRunnerId: string,
		hostname: string,
		result: RunnerResult,
	): Promise<{ status: "ok" } | { status: "rejected"; reason: string }> {
		const change = result.change;
		if (change === undefined) {
			return { status: "ok" };
		}

		// GATE 0 — the check trail. Run FIRST, before the jobs-row lookup and
		// every filesystem and subprocess gate below: it is a pure comparison over
		// data already in hand, and a result whose own trail contradicts its status
		// or omits a required check should never cost a scratch clone, a base fetch,
		// and four git invocations to refuse. Rejecting here means no branch and no
		// proposal, which is the whole ruling.
		const trailRejection = this.reconcileTrail(jobRunnerId, result);
		if (trailRejection !== null) {
			return trailRejection;
		}

		// The dispatched base comes from the JOBS row, never from the result. This is
		// the whole point of the ancestry check: a runner that could name its own base
		// could prove any tree it liked descends from it.
		const dispatched = await this.dispatchedBase(jobRunnerId);
		if (dispatched === null) {
			return { status: "rejected", reason: "no dispatched base commit for this attempt" };
		}

		// Re-validate both path segments HERE rather than trusting the caller. The
		// share reader already rejects an unsafe segment, but this module builds a
		// filesystem path from them and must not depend on a guarantee established
		// two layers away — a future caller reaching the verifier by another route
		// would silently lose it.
		if (!isSafePathSegment(jobRunnerId) || !isSafePathSegment(hostname)) {
			return { status: "rejected", reason: "unsafe job or host identifier" };
		}

		const snapshotPath = snapshotPathFor(this.paths.workRoot, jobRunnerId, hostname);
		const scratchRepoDir = scratchRepoFor(this.paths.workRoot, jobRunnerId, dispatched.attemptId);
		const jobOutputDir = join(this.paths.shareRoot, "runners", "jobs", jobRunnerId, hostname);

		try {
			return await this.verifyAgainstScratch({
				change,
				dispatched,
				jobRunnerId,
				snapshotPath,
				scratchRepoDir,
				jobOutputDir,
			});
		} catch (err) {
			// An operational fault must not read as a passing change.
			log("error", "change.verify.failed", {
				job_runner_id: jobRunnerId,
				cause: errorMessage(err),
			});
			// NAME an environment-class fault where it is still visible. The
			// infra-requeue will re-pend this job — correctly, by its own ruling — but a
			// retry into the same read-only or full filesystem cannot succeed, so the
			// requeue budget gets spent proving the same deployment defect three times.
			// The warn cannot live at the requeue site: `requeueInfraFailedJobs`
			// classifies on persisted STRUCTURE (whether any attempt reached `completed`)
			// and deliberately never reads the free-text failure prose, and this errno is
			// discarded before then — the rejection reason returned below is fixed text.
			// So the operator is told HERE, at the one place that still holds the errno.
			const errno = environmentErrnoClass(err);
			if (errno !== null) {
				log("warn", "change.verify.environment_defect", {
					job_runner_id: jobRunnerId,
					errno,
					detail: "environment defect — retry cannot succeed until the deployment is fixed",
				});
			}
			return { status: "rejected", reason: "change verification could not be completed" };
		}
	}

	/**
	 * Gate 0 — reconcile the check trail and log the outcome by name.
	 *
	 * Returns the rejection to forward, or `null` when the trail is acceptable.
	 * Every ALLOWANCE USE is logged at warn with the allowance's own name, so a
	 * tolerated hole in the verification trail is visible in the operator's log
	 * rather than silently absorbed — an allowance that stops being needed should
	 * be noticed and deleted, and it cannot be if its use leaves no trace.
	 *
	 * The rejection reason forwarded to the caller is the FIXED reason code, not
	 * the human detail: `detail` is author-written but describes untrusted output,
	 * and the caller's reason string reaches persisted state.
	 */
	private reconcileTrail(
		jobRunnerId: string,
		result: RunnerResult,
	): { status: "rejected"; reason: string } | null {
		const verdict = reconcileCheckTrail(result);
		if (verdict.status === "rejected") {
			log("warn", verdict.reason, {
				job_runner_id: jobRunnerId,
				detail: verdict.detail,
			});
			return { status: "rejected", reason: verdict.reason };
		}
		for (const entry of verdict.degraded) {
			log("warn", CHECK_TRAIL_REASONS.allowed, {
				job_runner_id: jobRunnerId,
				check: entry.check,
				check_status: entry.status,
				allowance: entry.allowance,
			});
		}
		return null;
	}

	/**
	 * Stage a scratch repository containing the dispatched base and run the ingest
	 * gates against it. Throws on an operational fault; the caller converts that
	 * into a rejection, because a fault must never read as a passing change.
	 */
	private async verifyAgainstScratch(args: {
		change: NonNullable<RunnerResult["change"]>;
		dispatched: { repository: string; sha: string; attemptId: number };
		jobRunnerId: string;
		snapshotPath: string;
		scratchRepoDir: string;
		jobOutputDir: string;
	}): Promise<{ status: "ok" } | { status: "rejected"; reason: string }> {
		const { change, dispatched, jobRunnerId, snapshotPath, scratchRepoDir, jobOutputDir } = args;

		// `change-ingest` copies the bundle with `wx` — it REFUSES to overwrite — so
		// a snapshot left by a previous failed attempt would fail every retry
		// forever. Unlink just that one file (never a recursive removal, and never a
		// runner-supplied path: this is derived from the job id under the watcher's
		// own work root).
		await rm(snapshotPath, { force: true });
		await rm(quarantinePathFor(snapshotPath), { force: true });
		await mkdir(join(this.paths.workRoot, "verified"), { recursive: true });
		await mkdir(scratchRepoDir, { recursive: true });

		// The scratch repo must CONTAIN the dispatched base, or `git bundle verify`
		// cannot evaluate the bundle's prerequisites and would accept anything.
		const prepared = await this.prepareScratch(scratchRepoDir, dispatched, jobRunnerId);
		if (!prepared) {
			return { status: "rejected", reason: "could not prepare the verification repository" };
		}

		const verdict = await verifyChangeBundle({
			change,
			jobOutputDir,
			dispatchedBaseSha: dispatched.sha,
			snapshotPath,
			inspector: new LocalBundleInspector(scratchRepoDir),
		});

		if (verdict.status !== "ok") {
			log("warn", "change.verify.rejected", {
				job_runner_id: jobRunnerId,
				// Already a bounded, author-controlled reason from change-ingest.
				reason: verdict.reason,
			});
			return { status: "rejected", reason: verdict.reason };
		}

		log("info", "change.verify.ok", {
			job_runner_id: jobRunnerId,
			files_changed: verdict.changedFiles.length,
		});
		return { status: "ok" };
	}

	/**
	 * The trusted dispatched base for an attempt.
	 *
	 * For nearly every lane this is the job's OWN repository and SHA. A
	 * deterministic k3s verb job breaks that identity: it is dispatched
	 * against a managed repository's issue with the rails-manifest digest in
	 * `jobs.sha`, but the change it returns is a render against `rtech/k3s-deploy`.
	 * `dispatchedBaseForJob` owns that decision and FAILS CLOSED for a verb job
	 * with no usable recorded base, so a missing base rejects rather than silently
	 * comparing a k3s render against a manifest digest.
	 *
	 * The base still comes from the JOBS row and never from the result — that is
	 * unchanged and is the whole point of the ancestry check.
	 */
	private async dispatchedBase(
		jobRunnerId: string,
	): Promise<{ repository: string; sha: string; attemptId: number } | null> {
		const [row] = await this.db
			.select({
				attemptId: jobAttempts.id,
				sha: jobs.sha,
				jobType: jobs.jobType,
				repositoryId: jobs.repositoryId,
				changeBaseRepository: jobs.changeBaseRepository,
				changeBaseSha: jobs.changeBaseSha,
			})
			.from(jobAttempts)
			.innerJoin(jobs, eq(jobs.id, jobAttempts.jobId))
			.where(eq(jobAttempts.runnerJobId, jobRunnerId))
			.orderBy(desc(jobAttempts.id))
			.limit(1);
		if (!row) {
			return null;
		}
		const repository = await this.repositoryName(row.repositoryId);
		if (repository === null) {
			return null;
		}
		const base = dispatchedBaseForJob({
			jobType: row.jobType,
			jobSha: row.sha,
			repositoryFullName: repository,
			changeBaseRepository: row.changeBaseRepository,
			changeBaseSha: row.changeBaseSha,
		});
		if (base === null) {
			return null;
		}
		return { repository: base.repository, sha: base.sha, attemptId: row.attemptId };
	}

	private async repositoryName(repositoryId: number): Promise<string | null> {
		const [row] = await this.db
			.select({ fullName: repositories.fullName })
			.from(repositories)
			.where(eq(repositories.id, repositoryId))
			.limit(1);
		return row?.fullName ?? null;
	}

	/**
	 * Initialize the scratch repository and fetch the dispatched base into it.
	 *
	 * Fetching the single base commit is what gives the prerequisite check meaning.
	 * `--depth 1` keeps it bounded: the ancestry proof only needs the base itself,
	 * because the bundle declares that base as its prerequisite.
	 */
	private async prepareScratch(
		scratchRepoDir: string,
		dispatched: { repository: string; sha: string },
		jobRunnerId: string,
	): Promise<boolean> {
		const remote = this.remoteFor(dispatched.repository);
		if (remote === null) {
			log("warn", "change.verify.no_remote", { job_runner_id: jobRunnerId });
			return false;
		}
		const init = await this.git.run(["init", "--bare", "--quiet"], { cwd: scratchRepoDir });
		if (init.exitCode !== 0) {
			return false;
		}
		// The credential is REQUIRED, not optional: a managed private repository
		// cannot be fetched without it, and every implement result for that
		// repository would otherwise be permanently recorded invalid with
		// "could not prepare the verification repository". Passed through the same
		// non-argv mechanism the push uses, so it never lands in a process listing.
		const credential = await this.credentialFor(dispatched.repository);
		const fetched = await this.git.run(
			["fetch", "--no-tags", "--depth", "1", remote, dispatched.sha],
			{ cwd: scratchRepoDir, ...(credential === null ? {} : { credential }) },
		);
		if (fetched.exitCode !== 0) {
			log("warn", "change.verify.base_fetch_failed", {
				job_runner_id: jobRunnerId,
				exit_code: fetched.exitCode,
			});
			return false;
		}
		return true;
	}
}
