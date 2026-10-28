import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	createGitRunner,
	type GitRunner,
	pushVerifiedBranch,
} from "../../src/results/branch-publisher";
import { IMPLEMENT_TEMPLATE_ID } from "../../src/templates/registry";
import { testTmpBase } from "../support/test-temp";

const HEAD = "b".repeat(40);
const BASE = "a".repeat(40);

/**
 * A scripted git that records every invocation. Keyed on the subcommand so a
 * test can fail one step without hand-ordering a queue.
 */
function git(
	overrides: Record<string, { exitCode?: number; stdout?: string }> = {},
): GitRunner & { calls: string[][]; credentials: (string | undefined)[] } {
	const calls: string[][] = [];
	const credentials: (string | undefined)[] = [];
	return {
		calls,
		credentials,
		run: async (args, options) => {
			calls.push([...args]);
			credentials.push(options.credential);
			const sub = args[0] ?? "";
			const o = overrides[sub] ?? {};
			return {
				exitCode: o.exitCode ?? 0,
				stdout: o.stdout ?? (sub === "rev-parse" ? `${HEAD}\n` : ""),
				stderr: "",
			};
		},
	};
}

function params(runner: GitRunner, itemNumber = 42, jobType: string = IMPLEMENT_TEMPLATE_ID) {
	return {
		snapshotPath: "/watcher/snapshots/job-1.bundle",
		scratchRepoDir: "/watcher/scratch/repo",
		dispatchedBaseSha: BASE,
		itemNumber,
		jobType,
		remote: "https://github.com/o/r.git",
		credential: "s3cret-token",
		git: runner,
	};
}

describe("pushVerifiedBranch", () => {
	test("pushes exactly one fully-qualified ref, without force", async () => {
		const runner = git();
		const out = await pushVerifiedBranch(params(runner));

		expect(out.status).toBe("pushed");
		if (out.status === "pushed") {
			expect(out.branch).toBe("rw/issue-42");
			expect(out.headSha).toBe(HEAD);
		}
		const push = runner.calls.find((c) => c[0] === "push");
		expect(push).toBeDefined();
		// Fully qualified on both sides, and the SOURCE is the resolved immutable
		// sha rather than the symbolic FETCH_HEAD. FETCH_HEAD is repository-wide and
		// mutable: a concurrent call sharing the scratch repo could move it between
		// the rev-parse and the push, publishing another item's commit under this
		// branch while this call reported the sha it verified.
		expect(push).toContain(`${HEAD}:refs/heads/rw/issue-42`);
		expect(push?.join(" ")).not.toContain("FETCH_HEAD");
		// The properties that keep this lane from rewriting history.
		expect(push?.join(" ")).not.toContain("--force");
		expect(push?.join(" ")).not.toContain("--mirror");
		expect(push?.join(" ")).not.toContain("+refs");
	});

	test("the branch is derived from the item number, not from any supplied string", async () => {
		const runner = git();
		await pushVerifiedBranch(params(runner, 7));
		const push = runner.calls.find((c) => c[0] === "push");
		expect(push).toContain(`${HEAD}:refs/heads/rw/issue-7`);
	});

	test("pushes an allowlisted verb on its fully-qualified verb branch", async () => {
		const runner = git();
		const out = await pushVerifiedBranch(params(runner, 7, "newapp"));

		expect(out.status).toBe("pushed");
		if (out.status === "pushed") expect(out.branch).toBe("verb/newapp-7");
		const push = runner.calls.find((c) => c[0] === "push");
		expect(push).toContain(`${HEAD}:refs/heads/verb/newapp-7`);
	});

	test("REJECTS an item number that cannot yield a branch", async () => {
		const runner = git();
		const out = await pushVerifiedBranch(params(runner, -1));

		expect(out.status).toBe("rejected");
		// Nothing may reach git at all.
		expect(runner.calls).toEqual([]);
	});

	test("REJECTS a change not descended from the dispatched base", async () => {
		// Defence in depth over change-ingest: if the artifact between verification
		// and push is not the one that was verified, the ancestry check catches it.
		const runner = git({ "merge-base": { exitCode: 1 } });
		const out = await pushVerifiedBranch(params(runner));

		expect(out.status).toBe("rejected");
		if (out.status === "rejected") expect(out.reason).toContain("dispatched base");
		// The push must never be attempted.
		expect(runner.calls.some((c) => c[0] === "push")).toBe(false);
	});

	test("REJECTS an unreadable bundle without pushing", async () => {
		const runner = git({ fetch: { exitCode: 128 } });
		const out = await pushVerifiedBranch(params(runner));

		expect(out.status).toBe("rejected");
		expect(runner.calls.some((c) => c[0] === "push")).toBe(false);
	});

	test("REJECTS a head that does not resolve to a sha", async () => {
		const runner = git({ "rev-parse": { stdout: "not-a-sha\n" } });
		const out = await pushVerifiedBranch(params(runner));

		expect(out.status).toBe("rejected");
		expect(runner.calls.some((c) => c[0] === "push")).toBe(false);
	});

	test("a refused push is reported as rejected, never retried as a force", async () => {
		// A non-fast-forward rejection is CORRECT: the branch moved, and rewriting
		// it is exactly what this lane must never do.
		const runner = git({ push: { exitCode: 1 } });
		const out = await pushVerifiedBranch(params(runner));

		expect(out.status).toBe("rejected");
		expect(runner.calls.filter((c) => c[0] === "push")).toHaveLength(1);
	});

	test("the credential is passed only to the push, never to a read", async () => {
		const runner = git();
		await pushVerifiedBranch(params(runner));

		for (const [index, call] of runner.calls.entries()) {
			const expected = call[0] === "push" ? "s3cret-token" : undefined;
			expect(runner.credentials[index]).toBe(expected);
		}
		// And it is never an argv element, where it would land in process listings.
		for (const call of runner.calls) {
			expect(call.join(" ")).not.toContain("s3cret-token");
		}
	});
});

describe("createGitRunner", () => {
	/**
	 * `credential.helper` is MULTI-VALUED: a `-c credential.helper=...` APPENDS to
	 * whatever global/system config already declares, and on success git offers the
	 * approved credential to every helper in the list. An inherited `store`-like
	 * helper would therefore receive and persist the watcher token far outside the
	 * one child process that needed it.
	 *
	 * This drives the real production runner against a real git, with a capture
	 * helper planted in a repo-local config that git genuinely inherits.
	 */
	test("inherited credential helpers are reset, so only the watcher's answers the push", async () => {
		const base = join(testTmpBase(), `cred-${Date.now().toString(36)}`);
		const repo = join(base, "repo");
		mkdirSync(repo, { recursive: true });
		expect(Bun.spawnSync(["git", "init", "-q", repo]).exitCode).toBe(0);
		// Stand in for an operator's global `osxkeychain`/`store`: a helper this repo
		// inherits and that a plain append would leave live.
		expect(
			Bun.spawnSync(["git", "-C", repo, "config", "credential.helper", "!inherited"]).exitCode,
		).toBe(0);

		// Ask the production runner to resolve the helper list it would use, through
		// the same `-c` argv it builds for a push. `config --get-all` prints the list
		// in precedence order, and git treats an EMPTY value as a reset marker that
		// discards everything before it — so what survives after the last empty entry
		// is exactly what would be consulted, and what could be handed the token on
		// credential approval.
		const runner = createGitRunner();
		const resolved = await runner.run(["config", "--get-all", "credential.helper"], {
			cwd: repo,
			credential: "s3cret-token",
		});
		expect(resolved.exitCode).toBe(0);

		// Drop only the trailing newline's empty tail; a genuine reset marker is an
		// empty line WITHIN the list and must be preserved for the search below.
		const entries = resolved.stdout.replace(/\n$/, "").split("\n");
		const lastReset = entries.lastIndexOf("");
		const live = entries.slice(lastReset + 1).filter(Boolean);

		// The inherited helper must not survive the reset...
		expect(live.join("\n")).not.toContain("!inherited");
		// ...and exactly one helper — ours, reading the token from the env — must.
		expect(live).toHaveLength(1);
		expect(live[0]).toContain("GIT_WATCHER_TOKEN");
		// The token is never argv, so it cannot appear in the resolved config either.
		expect(resolved.stdout).not.toContain("s3cret-token");

		rmSync(base, { recursive: true, force: true });
	});
});
