/**
 * @module runner/script-bootstrap
 * @description The ONE digest-checking executable bootstrap both `script`-runtime
 *   lanes submit in place of their full body.
 *
 *   THE DUPLICATION THIS OWNS. sf#306 gave the verb lane an executable bootstrap
 *   (`jobs/verb-bootstrap.ts`) and sf#573 converted the pre-push receipt lane to
 *   `runtime: "script"` and gave it its own (`prepush/body.ts`). The two texts
 *   were byte-identical apart from four header comment lines and one stderr
 *   prefix, and each carried its own private `isSha256Hex` and its own copy of
 *   the fail-closed posture. Two copies of a security-bearing render is two
 *   places a future fix can land in only one of.
 *
 *   WHY THE BOOTSTRAP IS SHELL, NOT PROSE. The `script` runtime EXECS the
 *   submitted body (`script) /bin/bash /work/job/job.md` in the rtech-infra
 *   wrapper), so a prose bootstrap would die on its first English line under
 *   `set -e`. Agent lanes keep the prose form (`renderAgentBootstrapJob`); this
 *   module is only for the lanes whose runtime is `script`.
 *
 *   THE DIGEST IS NOT DECORATION. The collab mount is shared and writable by
 *   other principals, so the landed `job.md` could be overwritten between staging
 *   and the box's read. The bootstrap recomputes SHA-256 over the raw landed
 *   bytes and refuses to execute on any mismatch; following a swapped file would
 *   mean arbitrary code execution on the box.
 *
 *   INTERPOLATION DISCIPLINE. The only values spliced in are the runner job id —
 *   and only after `jobBundlePaths` has proven it safe — and a digest validated
 *   as 64 lowercase hex characters. Nothing else caller-controlled reaches a slot.
 *
 *   PER-LANE DIFFERENCES ARE A TABLE, NOT A BRANCH. The four header comment lines
 *   and the stderr message prefix are the whole of what differs between lanes;
 *   they live in {@link LANE_TEXT} so the shared body below has no lane
 *   conditional in it at all.
 *
 * @outputs
 *   - `ScriptBootstrapLane` -- which `script`-runtime lane is being rendered
 *   - `isSha256Hex` -- the single 64-char lowercase-hex digest predicate
 *   - `renderScriptBootstrap` -- the tiny executable digest-bound bootstrap
 *
 * @dependencies
 *   - ../log -- record the fail-closed render refusals
 *   - ../prepush/body-constants -- the transport cap this staging exists to respect
 *   - ../prepush/paths -- the single shared job-scoped path derivation
 */
import { errorMessage, log, traced } from "../log";
import { RUNNER_JOB_TRANSPORT_CAP } from "../prepush/body-constants";
import { jobBundlePaths } from "../prepush/paths";

/** The `script`-runtime lanes that submit a digest-checking executable bootstrap. */
export type ScriptBootstrapLane = "verb" | "prepush";

/** A 64-char lowercase-hex SHA-256 digest, the only digest shape the bootstrap binds. */
export const isSha256Hex = traced(
	"runner.isSha256Hex",
	function isSha256Hex(value: string): boolean {
		return /^[0-9a-f]{64}$/.test(value);
	},
);

/**
 * Everything that differs between the two lanes: the four header comment lines
 * naming the lane's own issue and cap rationale, and the stderr message prefix
 * that tells an operator reading box output which lane refused.
 */
const LANE_TEXT: Record<ScriptBootstrapLane, { header: string[]; stderrPrefix: string }> = {
	verb: {
		header: [
			"# sf#306 bootstrap — the full verb contract is LANDED on the share, not inline.",
			"# mcp2cli caps an inline params.job at 10000 chars and the rendered verb body",
			"# is ~28k, so the box reads the contract from the collab file below. This",
			"# script is executed by the wrapper: script) /bin/bash /work/job/job.md.",
		],
		stderrPrefix: "verb bootstrap:",
	},
	prepush: {
		header: [
			"# sf#573 bootstrap — the full receipt contract is LANDED on the share, not inline.",
			"# mcp2cli caps an inline params.job at 10000 chars, so the box reads the contract",
			"# from the collab file below. This script is executed by the wrapper:",
			"# script) /bin/bash /work/job/job.md.",
		],
		stderrPrefix: "prepush bootstrap:",
	},
};

/**
 * Render the tiny, fixed, EXECUTABLE bootstrap a `script`-runtime lane runs in
 * place of the full body, or `null` when it cannot bind safely.
 *
 * It carries no contract detail. It names the landed `job.md` for THIS job on the
 * fixed runner-visible collab mount, embeds the SHA-256 of that file's exact
 * bytes, recomputes the digest on the box, and `exec`s the file ONLY on a match.
 * Its length depends solely on the safe job id and the fixed 64-char digest —
 * never on the body size — so it is always far under the transport cap.
 *
 * `exec` rather than a nested `bash` call so the staged body's exit status is the
 * process's own: the wrapper reads `${PIPESTATUS[0]}` off this process, and an
 * extra frame would only add a place for a status to be lost.
 *
 * @param lane - which `script`-runtime lane's header and stderr prefix to use
 * @param jobId - the safe runner job id the landed `job.md` path derives from
 * @param bodySha256 - the 64-char lowercase-hex digest of the landed body bytes
 * @returns the executable bootstrap, or `null` when it cannot bind safely
 */
export const renderScriptBootstrap = traced(
	"runner.renderScriptBootstrap",
	function renderScriptBootstrap(
		lane: ScriptBootstrapLane,
		jobId: string,
		bodySha256: string,
	): string | null {
		if (!isSha256Hex(bodySha256)) {
			return null;
		}
		let runnerJobBodyPath: string;
		try {
			// The SAME derivation staging landed the file through. It also re-proves the
			// job id is safe, so the only interpolated path here is one this module has
			// validated rather than accepted.
			runnerJobBodyPath = jobBundlePaths("/", jobId).runnerJobBodyPath;
		} catch (err) {
			log("warn", "runner.script_bootstrap.unsafe_job_id", {
				lane,
				job_id: jobId,
				cause: errorMessage(err),
			});
			return null;
		}
		const { header, stderrPrefix } = LANE_TEXT[lane];
		const script = [
			"#!/usr/bin/env bash",
			...header,
			"set -euo pipefail",
			"",
			`staged_job=${runnerJobBodyPath}`,
			`expected_sha256=${bodySha256}`,
			"",
			"# The collab mount is shared and writable by other principals, so the landed",
			"# file could have been replaced between staging and this read. Executing a",
			"# swapped file would be arbitrary code execution on this box, so the digest is",
			"# verified FIRST and any mismatch stops before a single contract line runs.",
			'if [ ! -f "$staged_job" ]; then',
			`  echo "${stderrPrefix} staged job body missing at $staged_job" >&2`,
			"  exit 1",
			"fi",
			'observed_sha256="$(sha256sum "$staged_job" | cut -d" " -f1)"',
			'if [ "$observed_sha256" != "$expected_sha256" ]; then',
			`  echo "${stderrPrefix} staged job body digest mismatch at $staged_job" >&2`,
			"  exit 1",
			"fi",
			"",
			'exec /bin/bash "$staged_job"',
			"",
		].join("\n");
		// Defence in depth against a future edit: a bootstrap that could not travel is a
		// fail-closed skip, never a doomed submission that costs an allocated box.
		return script.length > RUNNER_JOB_TRANSPORT_CAP ? null : script;
	},
);
