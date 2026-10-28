/**
 * @module results/work-root-preflight
 * @description The BOOT-TIME write probe for the change work root.
 *
 *   WHY THIS EXISTS. `defaultChangeWorkRoot()` falls back to
 *   `/var/lib/software-factory/work`, and a hardened unit (`ProtectSystem=strict`
 *   with `ReadWritePaths=` naming some OTHER directory) makes that path unwritable
 *   even for root. Nothing in the service touched the work root until an implement
 *   result arrived, so the defect stayed invisible: the report-only lanes (triage,
 *   pr-review, checks) never write there, and months of green passes never
 *   exercised it. The first-ever implement ingest on a fleet host — job 715, attempt 180,
 *   2026-08-02 — failed at its very first write with
 *   `EROFS: read-only file system, mkdir '/var/lib/software-factory'`, and the
 *   infra-requeue then correctly re-pended it to burn a SECOND full runner run into
 *   the same wall.
 *
 *   A full runner run is far too expensive a way to discover a missing directory.
 *   The service knows its work root at startup, so it probes it ONCE there and
 *   fails the boot with the path and the env var in the message. This is trap #84's
 *   shape — a gate that is absent looks identical to a gate that passes — so the
 *   probe asserts the property it cares about (the process can CREATE and REMOVE a
 *   file under this root) rather than merely stat-ing the directory: a directory can
 *   exist, be owned by the service user, and still be unwritable under `ProtectSystem`.
 *
 * @outputs
 *   - `assertChangeWorkRootWritable` -- mkdir + write-probe the work root, or throw
 *
 * @dependencies
 *   - ./change-verifier -- `defaultChangeWorkRoot`, the path this probes
 */
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { errorMessage, traced } from "../log";
import { defaultChangeWorkRoot } from "./change-verifier";

/** The seams the probe resolves through; production leaves them all unset. */
export interface WorkRootProbeDeps {
	/** Overrides the resolved root, for tests that must not touch a real path. */
	workRoot?: string;
	mkdir?: typeof mkdir;
	writeFile?: typeof writeFile;
	unlink?: typeof unlink;
}

/**
 * Prove the change work root is writable by THIS process, at boot.
 *
 * Creates the root, writes a probe file INSIDE it, and removes that file again.
 * The probe file is deliberately inside the work root and never under `/tmp`:
 * `/tmp` is sandbox-local and a hardened unit may give the service a private one,
 * so a `/tmp` probe would pass while the root the service actually uses is
 * read-only — proving nothing about the path that matters.
 *
 * @param env - environment the work root is resolved from
 * @param deps - overridable filesystem seams; production leaves them unset
 * @returns the work root that was proved writable
 * @throws when the root cannot be created or written, with the path and
 *   `WATCHER_WORK_ROOT` named — a fail-closed boot error an operator can act on
 */
async function assertChangeWorkRootWritableImpl(
	env: NodeJS.ProcessEnv = process.env,
	deps: WorkRootProbeDeps = {},
): Promise<string> {
	const workRoot = deps.workRoot ?? defaultChangeWorkRoot(env);
	const makeDir = deps.mkdir ?? mkdir;
	const write = deps.writeFile ?? writeFile;
	const remove = deps.unlink ?? unlink;
	const probePath = join(workRoot, ".workroot-probe");

	try {
		await makeDir(workRoot, { recursive: true });
		// `wx` refuses to overwrite, so a probe left by a crashed boot surfaces as a
		// failure to investigate rather than being silently clobbered.
		await write(probePath, "", { flag: "wx" });
		await remove(probePath);
	} catch (err) {
		throw new Error(
			`change work root is not writable: ${workRoot} (${errorMessage(err)}). ` +
				"Set WATCHER_WORK_ROOT to a path this service may write, and ensure the " +
				"unit's ReadWritePaths covers it.",
		);
	}
	return workRoot;
}

/**
 * `traced()` build-phase wrapper for {@link assertChangeWorkRootWritableImpl}.
 * Argument 0 is a raw `NodeJS.ProcessEnv` — every secret the service
 * holds, with no wrapping key for `summarize()` to match — so it is masked.
 */
export const assertChangeWorkRootWritable = traced(
	"results.assertChangeWorkRootWritable",
	assertChangeWorkRootWritableImpl,
	{ redact: { args: [0] } },
) as typeof assertChangeWorkRootWritableImpl;
