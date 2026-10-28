/**
 * @module prepush/stage
 * @description Body-only landing seam for runner lanes: atomically writes the
 *   full rendered job body as `job.md` at the job's trusted collab input path
 *   (`<collab>/runners/jobs/<job-id>/input/job.md`, derived once in `./paths`).
 *   A tiny fixed bootstrap job points the runner at it, because the runner
 *   transport hard-caps an inline `params.job`. The candidate-bundle stager the
 *   retired pre-push receipt used is gone (L-114).
 *
 * @outputs
 *   - `landJobBody` -- atomically land ONLY the job.md body
 *   - `LandedJobBody` -- the landed job.md host + runner path pair
 *   - `BodyLandingStager` -- inject a body-only landing for a lane
 *   - `LocalBodyLandingStager` -- production body-only landing over `landJobBody`
 *
 * @dependencies
 *   - node:fs/promises -- create dirs, write + atomically rename job.md
 *   - node:path -- join the sibling temp file path in the job input directory
 *   - ../log -- the traced() wrapper
 *   - ./paths -- the single shared job-scoped path derivation
 */
import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { traced } from "../log";
import { jobBundlePaths } from "./paths";

/** Fixed prefix for the transient job.md temp file, disambiguated per write. */
const JOB_BODY_TEMP_PREFIX = "job.md.";

/**
 * Atomically write `body` to `finalPath` via a sibling temp file + rename. A
 * unique temp name in the SAME directory keeps the write on one filesystem so
 * the rename is a true atomic replace (a cross-device rename would not be), and
 * a runner reading job.md therefore sees either nothing or the complete
 * byte-for-byte body — never a partial/truncated instruction set.
 */
async function writeJobBodyAtomically(
	inputDir: string,
	finalPath: string,
	body: string,
): Promise<void> {
	const tempPath = join(inputDir, `.${JOB_BODY_TEMP_PREFIX}${process.pid}-${Date.now()}.tmp`);
	await writeFile(tempPath, body, { mode: 0o600 });
	await rename(tempPath, finalPath);
}

/** Result of landing ONLY the job body (no candidate bundle). */
export interface LandedJobBody {
	/** Absolute host path of the landed `job.md` on the collab share. */
	jobBodyPath: string;
	/** Absolute runner-side path (`/mnt/share/...`) the fixed body names. */
	runnerJobBodyPath: string;
}

/**
 * Land ONLY the full rendered `body` as `job.md` at the trusted collab input
 * path for `jobId`, without producing a candidate bundle. This is the exact-SHA
 * landing seam for a FOREIGN-repo lane (e.g. rtech-infra static validation),
 * whose exact commit is NOT in the local object database and so is acquired by a
 * fixed author-owned depth-1 fetch inside the landed contract instead of a local
 * bundle. It reuses the SAME shared `jobBundlePaths` derivation and the SAME
 * atomic job.md write the bundle stager uses — it does not invent a second
 * staging seam; it merely omits the bundle. Rejects on an unsafe job id or an
 * empty body so the caller records a bounded error rather than dispatching a
 * runner with no landed contract.
 */
export const landJobBody = traced(
	"prepush.landJobBody",
	async function landJobBody(
		collabRoot: string,
		jobId: string,
		body: string,
	): Promise<LandedJobBody> {
		if (typeof body !== "string" || body.length === 0) {
			throw new Error("job-body landing requires a rendered job body");
		}
		const { hostJobBodyPath, hostInputDir, runnerJobBodyPath } = jobBundlePaths(collabRoot, jobId);
		await mkdir(hostInputDir, { recursive: true, mode: 0o700 });
		await writeJobBodyAtomically(hostInputDir, hostJobBodyPath, body);
		return { jobBodyPath: hostJobBodyPath, runnerJobBodyPath };
	},
	// Argument 2 is the fully rendered job body -- the whole fixed execution contract,
	// hundreds of lines of author-owned script. Redacted for BULK, not secrecy: the
	// landed bytes do not belong on one trace line. The return is two paths.
	{ redact: { args: [2] } },
);

/**
 * Injectable body-only landing seam. It lands only the job.md contract for a foreign-repo exact-SHA lane (the runner acquires the
 * exact commit through the fixed fetch in that contract, not a local bundle).
 * Rejects on any failure so the caller records a bounded error and never
 * dispatches a runner with no landed contract. Tests inject a fake.
 */
export interface BodyLandingStager {
	land(jobId: string, body: string): Promise<LandedJobBody>;
}

/** Production body-only landing over `landJobBody`, bound to a fixed collab root. */
export class LocalBodyLandingStager implements BodyLandingStager {
	private readonly collabRoot: string;

	/** @param collabRoot - the collab share root (e.g. `/mnt/share`). */
	constructor(collabRoot: string) {
		this.collabRoot = collabRoot;
	}

	async land(jobId: string, body: string): Promise<LandedJobBody> {
		return landJobBody(this.collabRoot, jobId, body);
	}
}
