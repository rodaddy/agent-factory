/**
 * @module prepush/paths
 * @description One shared, job-scoped path derivation for the staged candidate
 *   bundle and the landed job body. Staging (host side) and body rendering
 *   (runner side) MUST agree on exactly where these files live, or the runner
 *   clones/reads a path that does not exist. Both derive from the same safe
 *   `jobId`: the host writes beneath the injected collab root, and the runner —
 *   which mounts the collab share at a fixed `/mnt/share` — reads the identical
 *   job subtree there. No arbitrary caller-provided path ever reaches the prompt;
 *   only a validated job id does.
 *
 * @outputs
 *   - `JOB_INPUT_DIR_NAME` -- the job's staging subdirectory name
 *   - `CANDIDATE_BUNDLE_NAME` -- the fixed bundle file name
 *   - `CANDIDATE_DEPS_NAME` -- the fixed offline dependency-store archive name
 *   - `JOB_BODY_NAME` -- the fixed landed job-body file name
 *   - `RUNNER_COLLAB_ROOT` -- the fixed runner-side collab mount point
 *   - `isSafeJobId` -- the single job-id safety predicate
 *   - `jobBundlePaths` -- derive the matching host and runner input paths
 *
 * @dependencies
 *   - node:path -- bounded, traversal-safe join/normalize of the job subtree
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { join, normalize, posix, sep } from "node:path";
import { traced } from "../log";

/**
 * The job's staging subdirectory (`<job>/input/`), written by the watcher before
 * any box exists. It sits beside the runner host directories, so a host listing
 * must skip it: counted as a host it reads as "the box appeared" at once.
 */
export const JOB_INPUT_DIR_NAME = "input";

/** The bundle file name the runner clones. Fixed and author-controlled. */
export const CANDIDATE_BUNDLE_NAME = "candidate.bundle";

/**
 * The fixed, author-controlled registry the RUNNER installs the pinned closure
 * from. Naming it explicitly in the rendered job body (rather than letting the
 * runner take a registry from candidate config) means the fetch host is
 * author-pinned: a candidate `.npmrc`/bunfig cannot redirect the install.
 *
 * Paired with the watcher-side registry-only lockfile guard, which
 * refuses any dependency source that is not a plain registry `name@version`
 * BEFORE a runner is allocated. Those two together are the whole dependency
 * contract: issue #59 retired the staged offline `node_modules` store, because
 * resolving the closure on the macOS watcher for a Linux runner staged only the
 * host platform's `os`/`cpu`-gated binaries, so the runner's frozen install
 * always had packages left to install and the "must report no changes" contract
 * failed every run. The runner installs for its OWN platform instead.
 */
export const DEPS_REGISTRY = "https://registry.npmjs.org/";

/**
 * The landed job-body file name the runner reads and follows. The full rendered
 * contract is written here (instead of inline in `params.job`, which the
 * transport hard-caps at 10000 chars) so a large but bounded body reaches the
 * runner intact. Fixed and author-controlled.
 */
export const JOB_BODY_NAME = "job.md";

/**
 * The runner-side collab mount point. Runner boxes mount the collab share at
 * `/mnt/share` (the host sees the same share at its own root, e.g.
 * `/mnt/share`). This is a fixed author constant, never caller input.
 */
export const RUNNER_COLLAB_ROOT = "/mnt/share";

/** Relative segments of the per-job bundle beneath any collab root. */
const JOB_BUNDLE_SEGMENTS = ["runners", "jobs"] as const;

/**
 * A single job-id safety predicate shared by staging and body rendering. A job
 * id becomes a path segment on both host and runner, so it must not traverse.
 */
export const isSafeJobId = traced(
	"prepush.isSafeJobId",
	function isSafeJobId(jobId: string): boolean {
		return (
			jobId.length > 0 &&
			jobId.length <= 255 &&
			/^[A-Za-z0-9._-]+$/.test(jobId) &&
			jobId !== "." &&
			jobId !== ".."
		);
	},
);

/** The matching host and runner absolute paths of one job's input artifacts. */
export interface JobBundlePaths {
	/** Absolute host path of the candidate bundle beneath the injected collab root. */
	hostBundlePath: string;
	/** Absolute host path of the landed job body beneath the injected collab root. */
	hostJobBodyPath: string;
	/** Absolute host path of the job's `input/` directory (bundle/body parent). */
	hostInputDir: string;
	/** Absolute runner path of the candidate bundle beneath the fixed `/mnt/share` mount. */
	runnerBundlePath: string;
	/** Absolute runner path of the landed job body beneath the fixed `/mnt/share` mount. */
	runnerJobBodyPath: string;
}

/**
 * Derive the host and runner input paths for `jobId` from `collabRoot`. Rejects
 * an unsafe job id and defends in depth against traversal escaping the jobs root
 * on the host side. The runner paths are built with POSIX joins so they are
 * always forward-slash `/mnt/share/...` paths regardless of the host platform.
 */
export const jobBundlePaths = traced(
	"prepush.jobBundlePaths",
	function jobBundlePaths(collabRoot: string, jobId: string): JobBundlePaths {
		if (!isSafeJobId(jobId)) {
			throw new Error("pre-push staging requires a safe runner job id");
		}

		const jobsRoot = join(collabRoot, ...JOB_BUNDLE_SEGMENTS);
		const hostInputDir = join(jobsRoot, jobId, JOB_INPUT_DIR_NAME);
		// Defence-in-depth: the resolved input directory must stay strictly under the
		// jobs root, so a crafted job id can never escape the job subtree.
		const rootPrefix = normalize(jobsRoot) + sep;
		if (!(normalize(hostInputDir) + sep).startsWith(rootPrefix)) {
			throw new Error("pre-push staging resolved outside the job input directory");
		}
		const hostBundlePath = join(hostInputDir, CANDIDATE_BUNDLE_NAME);
		const hostJobBodyPath = join(hostInputDir, JOB_BODY_NAME);

		const runnerBundlePath = posix.join(
			RUNNER_COLLAB_ROOT,
			...JOB_BUNDLE_SEGMENTS,
			jobId,
			JOB_INPUT_DIR_NAME,
			CANDIDATE_BUNDLE_NAME,
		);
		const runnerJobBodyPath = posix.join(
			RUNNER_COLLAB_ROOT,
			...JOB_BUNDLE_SEGMENTS,
			jobId,
			JOB_INPUT_DIR_NAME,
			JOB_BODY_NAME,
		);

		return {
			hostBundlePath,
			hostJobBodyPath,
			hostInputDir,
			runnerBundlePath,
			runnerJobBodyPath,
		};
	},
);
