import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { planInfraGates } from "../../scripts/actions/infra-gates";
import { STATIC_GATES } from "../../src/infra/gates";
import { recordedForgeClient } from "../../src/infra/recorded-forge";
import { testTmpBase } from "../support/test-temp";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const PATHS = ["roles/web/tasks/main.yml", "scripts/x.sh"];
const dirs: string[] = [];
afterAll(() => {
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A curl recording of a 2-file PR, as the credential job would write it. */
function recording(head = HEAD, total = "2"): string {
	const dir = mkdtempSync(join(testTmpBase(), "recorded-forge-"));
	dirs.push(dir);
	writeFileSync(
		join(dir, "pull.json"),
		JSON.stringify({ changed_files: 2, head: { sha: head }, base: { sha: BASE } }),
	);
	writeFileSync(join(dir, "files-1.json"), JSON.stringify(PATHS.map((filename) => ({ filename }))));
	writeFileSync(
		join(dir, "files-1.headers"),
		`HTTP/2 200\r\ncontent-type: application/json\r\nX-Total-Count: ${total}\r\n\r\n`,
	);
	return dir;
}

const plan = (dir: string) =>
	planInfraGates({}, "rtech/rtech-infra", BASE, HEAD, undefined, {
		client: recordedForgeClient(dir),
		pullNumber: 7,
	});

describe("recorded Forge client", () => {
	test("a 2-file recording resolves both paths, not indeterminate", async () => {
		const result = await plan(recording());
		expect(result.changedReason).toBe("changed-files read: 2 path(s) resolved");
		expect(result.fullEscalation).toBe(false);
	});

	test("X-Total-Count from the headers file is read: a mismatch escalates", async () => {
		const result = await plan(recording(HEAD, "3"));
		expect(result.changedReason).toContain("X-Total-Count differs");
		expect(result.gates.map((g) => g.gate)).toEqual([...STATIC_GATES]);
	});

	test("a missing files page is indeterminate, never a throw", async () => {
		const dir = recording();
		unlinkSync(join(dir, "files-1.json"));
		const result = await plan(dir);
		expect(result.changedReason).toContain("PR files API or network error");
		expect(result.gates.map((g) => g.gate)).toEqual([...STATIC_GATES]);
	});

	test("the CLI plan replays PR_READ_DIR with FORGE_TOKEN and API unset", () => {
		const root = mkdtempSync(join(testTmpBase(), "recorded-forge-cli-"));
		dirs.push(root);
		const target = join(root, "target");
		const out = join(root, "out");
		mkdirSync(out);
		const git = (...args: string[]) =>
			Bun.spawnSync(["git", "-C", target, ...args], {
				env: {
					...process.env,
					GIT_AUTHOR_NAME: "t",
					GIT_AUTHOR_EMAIL: "t@t",
					GIT_COMMITTER_NAME: "t",
					GIT_COMMITTER_EMAIL: "t@t",
				},
			});
		expect(Bun.spawnSync(["git", "init", "-q", target]).exitCode).toBe(0);
		expect(git("commit", "-q", "--allow-empty", "-m", "x").exitCode).toBe(0);
		const head = git("rev-parse", "HEAD").stdout.toString().trim();
		const env: Record<string, string | undefined> = {
			...process.env,
			PR: "7",
			PR_READ_DIR: recording(head),
			REPO: "rtech/rtech-infra",
			BASE_SHA: BASE,
			HEAD_SHA: head,
		};
		delete env.FORGE_TOKEN;
		delete env.API;
		const run = Bun.spawnSync(
			[
				"bun",
				join(import.meta.dir, "../../scripts/actions/infra-gates.ts"),
				"plan",
				join(root, "none.json"),
				out,
				target,
			],
			{ env },
		);
		expect(run.exitCode).toBe(0);
		expect(existsSync(join(out, "plan.json"))).toBe(true);
		const written = JSON.parse(readFileSync(join(out, "plan.json"), "utf8"));
		expect(written.changedReason).toBe("changed-files read: 2 path(s) resolved");
	});
});
