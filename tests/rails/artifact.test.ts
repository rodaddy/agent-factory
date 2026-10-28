import { describe, expect, test } from "bun:test";
import { readBundleArtifact } from "../../src/rails/artifact";
import type { GitRunner } from "../../src/results/branch-publisher";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);

function git(results: Record<string, { exitCode?: number; stdout?: string }>): GitRunner & {
	calls: string[][];
} {
	const calls: string[][] = [];
	return {
		calls,
		run: async (args) => {
			calls.push([...args]);
			const key =
				args[0] === "show" ? `show:${String(args[1]).split(":").at(-1)}` : (args[0] ?? "");
			const result = results[key] ?? {};
			return { exitCode: result.exitCode ?? 0, stdout: result.stdout ?? "", stderr: "" };
		},
	};
}

describe("readBundleArtifact", () => {
	test("materializes changed YAML from the verified bundle without pushing", async () => {
		const runner = git({
			"rev-parse": { stdout: `${HEAD}\n` },
			diff: { stdout: "apps/api.yaml\napps/db.yml\n" },
			"show:apps/api.yaml": { stdout: "kind: Deployment\n" },
			"show:apps/db.yml": { stdout: "kind: Cluster\n" },
		});

		const outcome = await readBundleArtifact({
			snapshotPath: "/watcher/verified/job.bundle",
			scratchRepoDir: "/watcher/publish/repo",
			dispatchedBaseSha: BASE,
			git: runner,
		});

		expect(outcome).toEqual({
			status: "ok",
			artifact: "kind: Deployment\n\n---\nkind: Cluster\n",
		});
		expect(runner.calls.some((call) => call[0] === "push")).toBe(false);
	});

	test("returns a named failure when the verified bundle cannot be read", async () => {
		const outcome = await readBundleArtifact({
			snapshotPath: "/watcher/verified/job.bundle",
			scratchRepoDir: "/watcher/publish/repo",
			dispatchedBaseSha: BASE,
			git: git({ fetch: { exitCode: 1 } }),
		});

		expect(outcome).toEqual({ status: "error", reason: "artifact-bundle-unreadable" });
	});
});
