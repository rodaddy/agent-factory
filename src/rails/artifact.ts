/**
 * @module rails/artifact
 * @description Read the changed YAML from a watcher-verified git bundle before
 *   any remote ref is written. The bundle was already confined, ancestry-proved,
 *   and copied into watcher-owned storage by change ingest; this boundary only
 *   materializes its YAML files for rails evaluation.
 */
import type { GitRunner } from "../results/branch-publisher";

const MAX_RAILS_FILES = 500;
const MAX_RAILS_BYTES = 1024 * 1024;

export interface BundleArtifactInput {
	snapshotPath: string;
	scratchRepoDir: string;
	dispatchedBaseSha: string;
	git: GitRunner;
}

export type BundleArtifactOutcome =
	| { status: "ok"; artifact: string }
	| { status: "error"; reason: string };

/** Materialize changed YAML from a verified bundle without pushing any ref. */
export async function readBundleArtifact(
	input: BundleArtifactInput,
): Promise<BundleArtifactOutcome> {
	const fetched = await input.git.run(["fetch", "--no-tags", input.snapshotPath, "HEAD"], {
		cwd: input.scratchRepoDir,
	});
	if (fetched.exitCode !== 0) return { status: "error", reason: "artifact-bundle-unreadable" };

	const head = await input.git.run(["rev-parse", "FETCH_HEAD"], { cwd: input.scratchRepoDir });
	const headSha = head.stdout.trim();
	if (head.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(headSha)) {
		return { status: "error", reason: "artifact-head-unresolvable" };
	}

	const changed = await input.git.run(
		[
			"diff",
			"--name-only",
			"--diff-filter=ACMRT",
			input.dispatchedBaseSha,
			headSha,
			"--",
			"*.yml",
			"*.yaml",
		],
		{ cwd: input.scratchRepoDir },
	);
	if (changed.exitCode !== 0) return { status: "error", reason: "artifact-paths-unreadable" };

	const paths = changed.stdout.split("\n").filter((path) => path !== "");
	if (paths.length > MAX_RAILS_FILES) return { status: "error", reason: "artifact-file-limit" };

	const documents: string[] = [];
	let bytes = 0;
	for (const path of paths) {
		const shown = await input.git.run(["show", `${headSha}:${path}`], {
			cwd: input.scratchRepoDir,
		});
		if (shown.exitCode !== 0) return { status: "error", reason: "artifact-file-unreadable" };
		bytes += Buffer.byteLength(shown.stdout);
		if (bytes > MAX_RAILS_BYTES) return { status: "error", reason: "artifact-byte-limit" };
		documents.push(shown.stdout);
	}
	return { status: "ok", artifact: documents.join("\n---\n") };
}
