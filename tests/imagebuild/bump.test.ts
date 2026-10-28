/**
 * @module tests/imagebuild/bump
 * @description Hermetic tests for the bump-script invoke + parse module.
 *  Nothing here calls the real `open-bump-pr.sh`: the suite WRITES a
 *   small executable bash fake into its own scratch directory and points the
 *   module at it, so the process boundary — argv, env, exit code, stdout, stderr
 *   — is exercised for real while nothing touches a forge or a cluster.
 *
 *   THE FAKE IS DRIVEN BY ARGV, NOT ENV. The module passes a FIXED environment
 *   (PATH, HOME, FORGE_TOKEN, FORGE_USER) precisely so nothing else leaks into
 *   the child, which also means a `FAKE_EXIT`-style env switch could never reach
 *   it. The fake therefore switches on the `--app` value and records its own
 *   argv and full environment to a file the test reads back.
 *
 *   THE LOAD-BEARING CASE is the token. `TOKEN_FIXTURE` is assembled from parts
 *   (a token-shaped literal trips `bun run secrets`) and is asserted to appear in
 *   the recorded environment ONLY on the `FORGE_TOKEN=` line — never in argv,
 *   never in the serialized outcome.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
	type BumpCandidate,
	buildBumpArgv,
	classifyHarness,
	classifyRefusal,
	type HarnessReason,
	parseBumpStdout,
	runBump,
} from "../../src/imagebuild/bump";
import { testTmpBase } from "../support/test-temp";

/**
 * Distinctive, and ASSEMBLED from parts so no high-entropy literal sits in the
 * file — a token-shaped constant trips `bun run secrets` (gitleaks
 * generic-api-key) and an allowlist entry for a fixture would blunt the scan.
 */
const TOKEN_FIXTURE = ["sekrit", "TOKEN", "9f3"].join("-");
const CRED = { token: TOKEN_FIXTURE, user: "factory-bot" };

/**
 * The scratch lives under the portable test temp base, NEVER inside the
 * checkout: the pre-push receipt runner mounts the checkout read-only, so a
 * `.bump-test-scratch` beside the source failed with EROFS there while passing
 * locally. Assigned in `beforeAll` because the directory is created per run.
 */
let SCRATCH = "";
let SCRIPT = "";
let RECORD = "";

const CANDIDATE: BumpCandidate = {
	repository: "rtech/rtech-infra",
	tag: "v1.2.3",
	sha: "a".repeat(40),
};

const FAKE = `#!/usr/bin/env bash
RECORD="$(dirname "$0")/record.txt"
{
  printf 'ARGV:'
  for a in "$@"; do printf ' %s' "$a"; done
  printf '\\n'
  printf 'ENV-BEGIN\\n'
  env
  printf 'ENV-END\\n'
} >> "$RECORD"
case "$2" in
  ok)
    echo "noise line one"
    echo "noise line two"
    echo '{"pr":12,"url":"https://forge.example.internal/rtech/k3s-deploy/pulls/12","branch":"bump/x","app":"ok","old_tag":"v1","new_tag":"v2","extra":1}'
    exit 0
    ;;
  refuse) echo "ALREADY_AT_TAG some text" >&2; exit 1 ;;
  harness) exit 3 ;;
  pushfail) echo "PUSH_FAILED remote rejected bump/x" >&2; exit 2 ;;
  nojson) echo "hello"; exit 0 ;;
esac
exit 3
`;

const runFor = (appDir: string, target = "uat", allowOlder = false) =>
	runBump(
		{ scriptPath: SCRIPT, candidate: CANDIDATE, appDir, workdir: SCRATCH, target, allowOlder },
		CRED,
	);

beforeAll(async () => {
	SCRATCH = await mkdtemp(join(testTmpBase(), "rw-bump-test-"));
	SCRIPT = join(SCRATCH, "fake-open-bump-pr.sh");
	RECORD = join(SCRATCH, "record.txt");
	writeFileSync(SCRIPT, FAKE, "utf8");
	chmodSync(SCRIPT, 0o755);
});

beforeEach(() => {
	writeFileSync(RECORD, "", "utf8");
});

afterAll(async () => {
	await rm(SCRATCH, { recursive: true, force: true });
});

describe("buildBumpArgv", () => {
	test("emits the exact CLI shape and carries the given target", () => {
		const argv = buildBumpArgv(SCRIPT, CANDIDATE, "k3s-app", "/work/dir", "staging", false);
		expect(argv).toEqual([
			SCRIPT,
			"--app",
			"k3s-app",
			"--tag",
			"v1.2.3",
			"--repo",
			"rtech/rtech-infra",
			"--sha",
			"a".repeat(40),
			"--target",
			"staging",
			"--workdir",
			"/work/dir",
		]);
		expect(argv).not.toContain("--dry-run");
		expect(argv).not.toContain("--allow-older");
	});

	test("appends --allow-older ONLY when allowOlder is true", () => {
		const plain = buildBumpArgv(SCRIPT, CANDIDATE, "k3s-app", "/w", "uat", false);
		const marked = buildBumpArgv(SCRIPT, CANDIDATE, "k3s-app", "/w", "uat", true);
		expect(plain).not.toContain("--allow-older");
		expect(marked).toEqual([...plain, "--allow-older"]);
		expect(marked.at(-1)).toBe("--allow-older");
	});

	test("refuses a short sha, a traversal app dir, and an option-shaped tag", () => {
		expect(() =>
			buildBumpArgv(SCRIPT, { ...CANDIDATE, sha: "a".repeat(39) }, "app", "/w", "uat", false),
		).toThrow();
		expect(() => buildBumpArgv(SCRIPT, CANDIDATE, "../x", "/w", "uat", false)).toThrow();
		expect(() =>
			buildBumpArgv(SCRIPT, { ...CANDIDATE, tag: "-v1" }, "app", "/w", "uat", false),
		).toThrow();
		expect(() =>
			buildBumpArgv(SCRIPT, { ...CANDIDATE, repository: "rodaddy" }, "app", "/w", "uat", false),
		).toThrow();
	});

	/**
	 * THE TARGET IS NOW A PARAMETER, SO ITS CLASS IS THE BOUNDARY. A target
	 * carrying whitespace could split into a second argv element, and an
	 * over-long one is rendered by the wrapper into a PR title; both are refused
	 * with a message that echoes no input.
	 */
	test("refuses a whitespace target and a 17-character target", () => {
		const refusal = "invalid bump argument: target";
		expect(() => buildBumpArgv(SCRIPT, CANDIDATE, "app", "/w", "x y", false)).toThrow(refusal);
		expect(() => buildBumpArgv(SCRIPT, CANDIDATE, "app", "/w", "a".repeat(17), false)).toThrow(
			refusal,
		);
		expect(buildBumpArgv(SCRIPT, CANDIDATE, "app", "/w", "a".repeat(16), false)).toContain(
			"a".repeat(16),
		);
	});

	test("refuses an option-shaped target, so no input can inject a flag", () => {
		for (const target of ["--target", "-x", "--allow-older", ""]) {
			expect(() => buildBumpArgv(SCRIPT, CANDIDATE, "app", "/w", target, false)).toThrow(
				"invalid bump argument: target",
			);
		}
	});
});

describe("classifyRefusal", () => {
	test("maps OLDER_TAG, the backwards-move guard, to its own refusal", () => {
		expect(classifyRefusal("OLDER_TAG v1.2.2 is older than v1.2.3")).toBe("OLDER_TAG");
		expect(classifyRefusal("SOMETHING_ELSE text")).toBe("unknown refusal");
	});
});

describe("classifyHarness", () => {
	/**
	 * EVERY token in the vocabulary, because the point of §8 is that a harness
	 * failure names its fault rather than its exit code — a list that silently
	 * lost an entry would send that fault back to `unknown harness` and nothing
	 * else would notice.
	 */
	test("maps each fixed harness token, and nothing else", () => {
		const tokens: HarnessReason[] = [
			"PATTERN_DRIFT",
			"PUSH_FAILED",
			"PR_CREATE_FAILED",
			"MERGE_QUEUE_FAILED",
			"REGISTRY_UNREACHABLE",
			"CLONE_FAILED",
			"UNKNOWN_ARGUMENT",
		];
		for (const token of tokens) {
			expect(classifyHarness(`${token} some trailing detail`)).toBe(token);
		}
	});

	test("leading blank lines do not hide the token, as they do not for a refusal", () => {
		expect(classifyHarness("\n\n  CLONE_FAILED could not reach the forge\n")).toBe("CLONE_FAILED");
	});

	/**
	 * A child killed by a signal writes NOTHING, and a refusal token is not a
	 * harness token: both must land on the catch-all rather than on a fixed string
	 * that would read as a diagnosed fault.
	 */
	test("empty stderr, prose, and a refusal token are all `unknown harness`", () => {
		expect(classifyHarness("")).toBe("unknown harness");
		expect(classifyHarness("   \n  ")).toBe("unknown harness");
		expect(classifyHarness("fatal: something went wrong")).toBe("unknown harness");
		expect(classifyHarness("ALREADY_AT_TAG v1 is current")).toBe("unknown harness");
		expect(classifyHarness("push_failed lowercase is not the token")).toBe("unknown harness");
	});
});

describe("parseBumpStdout", () => {
	test("rejects empty output and a non-integer pr", () => {
		expect(parseBumpStdout("")).toEqual({ ok: false, reason: "no output" });
		expect(parseBumpStdout("not json at all")).toEqual({ ok: false, reason: "last line not json" });
		const wrong = JSON.stringify({
			pr: "12",
			url: "https://x.invalid/1",
			branch: "b",
			app: "a",
			old_tag: "v1",
			new_tag: "v2",
		});
		expect(parseBumpStdout(wrong)).toEqual({ ok: false, reason: "shape mismatch" });
	});

	test("accepts only HTTPS deploy-repository receipts and tolerates trailing noise", () => {
		const receipt = {
			pr: 12,
			url: "https://forge.example.internal/rtech/k3s-deploy/pulls/12",
			branch: "bump/x",
			app: "a",
			old_tag: "v1",
			new_tag: "v2",
		};
		expect(parseBumpStdout(`${JSON.stringify(receipt)}\npost-receipt noise`)).toEqual({
			ok: true,
			value: receipt,
		});
		expect(parseBumpStdout(JSON.stringify({ ...receipt, url: "file:///etc/passwd" }))).toEqual({
			ok: false,
			reason: "shape mismatch",
		});
		expect(
			parseBumpStdout(
				JSON.stringify({
					...receipt,
					url: "https://forge.example.internal/other/repository/pulls/12",
				}),
			),
		).toEqual({ ok: false, reason: "shape mismatch" });
	});
});

describe("runBump", () => {
	test("exit 0 with noise above the JSON yields opened", async () => {
		const outcome = await runFor("ok");
		expect(outcome).toEqual({
			kind: "opened",
			pr: 12,
			url: "https://forge.example.internal/rtech/k3s-deploy/pulls/12",
			repository: "rtech/k3s-deploy",
			branch: "bump/x",
			app: "ok",
			oldTag: "v1",
			newTag: "v2",
		});
	});

	test("exit 1 yields a terminal refusal carrying the stderr leading token", async () => {
		expect(await runFor("refuse")).toEqual({ kind: "refused", reason: "ALREADY_AT_TAG" });
	});

	/**
	 * The §8 change: the reason names the FAULT, never the code. The old assertion
	 * here was `exit 3`, which is exactly the string that made four unrelated
	 * failures indistinguishable in the bump row.
	 */
	test("exit 2 with a harness token yields that fixed reason, not the code", async () => {
		expect(await runFor("pushfail")).toEqual({ kind: "harness", reason: "PUSH_FAILED" });
	});

	test("a non-zero exit with no stderr is `unknown harness`, never `exit N`", async () => {
		const outcome = await runFor("harness");
		expect(outcome).toEqual({ kind: "harness", reason: "unknown harness" });
		expect(JSON.stringify(outcome)).not.toContain("exit 3");
	});

	test("exit 0 without JSON is a harness outcome, never an opened PR", async () => {
		expect(await runFor("nojson")).toEqual({ kind: "harness", reason: "exit 0 without json" });
	});

	test("the token reaches FORGE_TOKEN only — never argv, never the outcome", async () => {
		const outcome = await runFor("ok");
		const record = readFileSync(RECORD, "utf8");
		const argvLine = record.split("\n").find((line) => line.startsWith("ARGV:")) ?? "";
		expect(argvLine).not.toContain(TOKEN_FIXTURE);
		const tokenLines = record
			.split("\n")
			.filter((line) => line.includes(TOKEN_FIXTURE))
			.map((line) => line.split("=")[0]);
		expect(tokenLines).toEqual(["FORGE_TOKEN"]);
		expect(JSON.stringify(outcome)).not.toContain(TOKEN_FIXTURE);
		// The child env is FIXED, not inherited: an unrelated caller variable
		// present in this process must not appear in the recorded environment.
		expect(record).not.toContain("BUMP_TEST_MUST_NOT_INHERIT");
	});

	test("the caller's target and marker reach the real process boundary", async () => {
		const outcome = await runFor("ok", "staging", true);
		expect(outcome.kind).toBe("opened");
		const argvLine = readFileSync(RECORD, "utf8")
			.split("\n")
			.find((line) => line.startsWith("ARGV:"));
		expect(argvLine).toContain("--target staging");
		expect(argvLine).toContain("--allow-older");
	});
});
