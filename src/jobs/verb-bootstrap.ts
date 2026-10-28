/**
 * @module jobs/verb-bootstrap
 * @description Stage a verb job's rendered body on the collab share and submit a
 *   tiny EXECUTABLE bootstrap in its place.
 *
 *   THE DEFECT THIS OWNS. `runner/transport.ts` submits `runner_run` with the
 *   whole body inline in the `--params` JSON, and mcp2cli hard-caps an inline
 *   `params.job` at `RUNNER_JOB_TRANSPORT_CAP` chars. The rendered hello
 *   verb body is 28,191 bytes, so the call was refused client-side in under a
 *   second — after the box had already been allocated. Two byte-identical live
 *   failures on the first citizenship run (20:14:42Z px05 and
 *   21:14:43Z px06): `vzstart` OK, `runner_run` exit 1, no `push_file` ever
 *   reaching the box, and the watcher reaping it one second later.
 *
 *   THE SEAM IS THE EXISTING ONE. `prepush/stage.ts` already solved this for the
 *   pre-push lane: `landJobBody` / `BodyLandingStager` atomically lands the full
 *   body as `<collab>/runners/jobs/<job-id>/input/job.md` (temp file + rename in
 *   the same directory, so a reader sees either nothing or the complete bytes),
 *   and a tiny fixed bootstrap under the cap points the runner at it. The
 *   infra-static lane reuses that same seam through `infra/dispatch.ts`. This
 *   module is the third consumer, not a second staging seam: it calls the SAME
 *   `BodyLandingStager.land` over the SAME `jobBundlePaths` derivation.
 *
 *   WHY THE BOOTSTRAP IS SHELL, NOT PROSE. Every prior staged lane is an AGENT
 *   lane, so its bootstrap is prose the agent reads (`renderPrepushBootstrapJob`).
 *   The verb lane dispatches `runtime: "script"`, and the wrapper EXECS the body:
 *   `script) /bin/bash /work/job/job.md` (rtech-infra `scripts/runner-job:250`,
 *   read from source this session). Handing that runtime a prose bootstrap would
 *   die on its first English line under `set -e` — the exact class of failure
 *   sf#301 fixed for the body itself. So the bootstrap here is bash: it verifies
 *   the landed file's digest with `sha256sum` and then `exec`s it. Since sf#579
 *   that bootstrap TEXT lives in `runner/script-bootstrap` — the pre-push receipt
 *   lane renders the byte-identical script from the same module, so a fix to the
 *   digest check cannot land in one lane and miss the other. This module keeps
 *   the verb lane's staging orchestration around it.
 *
 *   THE DIGEST IS NOT DECORATION. The collab mount is shared and writable by other
 *   principals, so `job.md` could be overwritten between landing and the box's
 *   read. The bootstrap recomputes SHA-256 over the raw landed bytes and refuses
 *   to execute on any mismatch, exactly as the prose bootstraps instruct an agent
 *   to. Following a swapped file would mean arbitrary code execution on the box.
 *
 *   INTERPOLATION DISCIPLINE. The only value spliced into the bootstrap is the
 *   runner job id, and only after `jobBundlePaths` has proven it safe — the same
 *   allowlist posture `verb-body.ts inputsAreAllowlisted` applies to the body's
 *   own slots. The digest is 64 lowercase hex characters, validated before use.
 *   Nothing caller-controlled beyond those two reaches a slot.
 *
 * @outputs
 *   - `VerbDispatchPreparation` -- the prepared bootstrap, or a bounded fault
 *   - `renderVerbBootstrapScript` -- the tiny executable digest-bound bootstrap
 *   - `prepareVerbDispatch` -- render digest, land the body, return the bootstrap
 *
 * @dependencies
 *   - node:crypto -- the SHA-256 binding the bootstrap to the landed bytes
 *   - ../prepush/stage -- the shared body-only landing seam (atomic job.md write)
 *   - ../runner/script-bootstrap -- the ONE bootstrap text both script lanes render
 */
import { createHash } from "node:crypto";

import { traced } from "../log";
import type { BodyLandingStager } from "../prepush/stage";
import { renderScriptBootstrap } from "../runner/script-bootstrap";

/**
 * The prepared dispatch for one verb job: the tiny executable bootstrap the box
 * runs inline, or a bounded fault. A fault means the caller must FAIL CLOSED —
 * release the claim and skip — rather than submit a runner with no contract.
 */
export type VerbDispatchPreparation =
	| { ok: true; bootstrap: string }
	| { ok: false; reason: string };

/**
 * Render the tiny, fixed, EXECUTABLE bootstrap the `script` runtime runs in place
 * of the full body, or `null` when it cannot bind safely.
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
 * The text itself is `runner/script-bootstrap`'s: this stays the verb
 * lane's named, traced entry point onto the one shared render.
 *
 * @param jobId - the safe runner job id the landed `job.md` path derives from
 * @param bodySha256 - the 64-char lowercase-hex digest of the landed body bytes
 * @returns the executable bootstrap, or `null` when it cannot bind safely
 */
export const renderVerbBootstrapScript = traced(
	"jobs.renderVerbBootstrapScript",
	function renderVerbBootstrapScript(jobId: string, bodySha256: string): string | null {
		return renderScriptBootstrap("verb", jobId, bodySha256);
	},
);

/** Arguments for {@link prepareVerbDispatch}. */
export type PrepareVerbDispatchArgs = {
	/** The shared body-only landing seam (atomic job.md write over the shared paths). */
	stager: BodyLandingStager;
	/** The safe runner job id staging and the runner both use. */
	runnerJobId: string;
	/** The FULL rendered verb body, landed byte-for-byte as job.md. */
	body: string;
};

/**
 * Land the full rendered verb body as the digest-bound `job.md` and return the
 * tiny executable bootstrap the box runs inline.
 *
 * STAGING IS UNCONDITIONAL, not size-gated, and that is a deliberate choice.
 * Size-gating would mean two live code paths that differ only at a 10,000-char
 * boundary nothing tests near, and the inline branch would be the one that never
 * runs in production (every real verb body is ~28k) right up until an unusual
 * render dipped under the cap and took an untravelled path on a live box. One
 * path is also one security posture: every verb body is then digest-bound against
 * share tampering, rather than only the large ones. The pre-flight renders on
 * rtech-infra#806 already proved share access works from the watcher, so there is
 * no availability argument for keeping an inline fallback. The cost is one atomic
 * file write per dispatch, against a box allocation that costs orders of magnitude
 * more.
 *
 * FAILS CLOSED on every fault: an unusable digest, an unsafe job id, or a landing
 * I/O error all return `{ ok: false }` so the caller releases the claim and skips
 * rather than dispatching a runner with a missing or unverifiable contract.
 */
export const prepareVerbDispatch = traced(
	"jobs.prepareVerbDispatch",
	async function prepareVerbDispatch({
		stager,
		runnerJobId,
		body,
	}: PrepareVerbDispatchArgs): Promise<VerbDispatchPreparation> {
		if (body.length === 0) {
			return { ok: false, reason: "verb dispatch requires a rendered job body" };
		}

		// Digest the IDENTICAL string handed to the stager, so the runner-side
		// recomputation over the raw landed bytes matches byte-for-byte.
		const bodySha256 = createHash("sha256").update(body, "utf8").digest("hex");
		const bootstrap = renderVerbBootstrapScript(runnerJobId, bodySha256);
		if (bootstrap === null) {
			return { ok: false, reason: "verb bootstrap could not be bound to the landed body" };
		}

		try {
			await stager.land(runnerJobId, body);
		} catch (error) {
			return {
				ok: false,
				reason: error instanceof Error ? error.message : "verb job body landing failed",
			};
		}

		return { ok: true, bootstrap };
	},
);
