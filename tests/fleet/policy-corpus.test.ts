/**
 * @module tests/fleet/policy-corpus
 * @description The shared guard policy corpus (Development `_ob/policy/`,
 *   DESIGN D2) run through `fleet/hooks/bash-guard`. Every row whose
 *   rule has a `bash-guard` matcher is fed to the real guard as Claude Code
 *   PreToolUse JSON, the way `tests/fleet/bash-guard.test.ts` does: deny is
 *   exit 2 naming the rule, allow is exit 0 and silent on stdout and stderr. `tests/fleet/policy/`
 *   holds byte-identical copies of Development main's files; only rows whose
 *   cwd is under /home/operator/fleet-work/ run here; the prepush
 *   `policy-drift` job proves they still match.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT = resolve(import.meta.dir, "../../fleet/hooks/bash-guard");
const POLICY_DIR = resolve(import.meta.dir, "policy");
/** The employee box layout the rows are written for. */
const BOX_CWD = "/home/operator/fleet-work/reviewer";
/**
 * bash-guard's scope (Development `_ob/policy/README.md`): rows whose cwd is
 * an employee work dir. Development's own corpus test runs the rest.
 */
const BOX_SCOPE = "/home/operator/fleet-work/";
/** The box environment the rows assume: the reviewer seat and its Forge login. */
const BOX_ENV = { FLEET_EMPLOYEE: "reviewer", FORGE_LOGIN: "sf-reviewer", HOME: "/home/operator" };
/** The guard's own refusal name where it differs from the table id. */
const GUARD_RULE: Record<string, string> = {
	cluster: "cluster-write",
	"destructive-sql": "db-drop",
};
/**
 * The table rules bash-guard enforces (round-1 P3-1). Pinned: a rule whose
 * `bash-guard` matcher is dropped from policy.json would otherwise drop its
 * rows from this suite silently and stay green.
 */
const BASH_GUARD_RULES = [
	"ansible-apply",
	"cluster",
	"destructive-sql",
	"forge-api",
	"guard-files",
	"identity",
	"model-gate",
	"no-tmp",
];

type Row = { rule: string; line: string; cwd: string; expect: "deny" | "allow"; why: string };
type Rule = { id: string; matchers: Record<string, string> };

const policy = JSON.parse(readFileSync(join(POLICY_DIR, "policy.json"), "utf8")) as {
	rules: Rule[];
};
const corpus: Row[] = readFileSync(join(POLICY_DIR, "corpus.jsonl"), "utf8")
	.split("\n")
	.filter((l) => l.trim() !== "")
	.map((l) => JSON.parse(l) as Row);
/** The ids of the rules that carry a `bash-guard` matcher, sorted. */
function guardRuleIds(rules: Rule[]): string[] {
	return rules
		.filter((r) => "bash-guard" in r.matchers)
		.map((r) => r.id)
		.sort();
}
const guardRules = guardRuleIds(policy.rules);
const rows = corpus.filter((r) => guardRules.includes(r.rule) && r.cwd.startsWith(BOX_SCOPE));

let scratch = "";
beforeAll(() => {
	scratch = mkdtempSync(join(testTmpBase(), "policy-corpus-"));
});
afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

/** The row's box cwd, mapped onto a real directory under the test scratch. */
function realCwd(cwd: string): string {
	if (!cwd.startsWith(BOX_CWD)) throw new Error(`row cwd ${cwd} is not under ${BOX_CWD}`);
	const dir = join(scratch, "fleet-work", "reviewer", cwd.slice(BOX_CWD.length));
	mkdirSync(dir, { recursive: true });
	return dir;
}

function guard(row: Row): { code: number; stdout: string; stderr: string } {
	const r = Bun.spawnSync(["python3", SCRIPT], {
		stdin: Buffer.from(
			JSON.stringify({
				tool_name: "Bash",
				tool_input: { command: row.line },
				cwd: realCwd(row.cwd),
			}),
		),
		env: { PATH: process.env.PATH ?? "", ...BOX_ENV },
	});
	return { code: r.exitCode ?? -1, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

describe("bash-guard runs the shared policy corpus", () => {
	test("the table names bash-guard rules and the corpus has rows for them", () => {
		expect(guardRules.length).toBeGreaterThan(0);
		expect(rows.length).toBeGreaterThan(0);
	});

	test("every rule bash-guard enforces still has its bash-guard matcher and rows", () => {
		expect(guardRules).toEqual(BASH_GUARD_RULES);
		for (const id of BASH_GUARD_RULES)
			for (const want of ["deny", "allow"] as const)
				expect(
					rows.some((r) => r.rule === id && r.expect === want),
					`${id} has no box ${want} row`,
				).toBe(true);
	});

	for (const row of rows) {
		test(`${row.rule} ${row.expect}s: ${JSON.stringify(row.line)}`, () => {
			const r = guard(row);
			if (row.expect === "deny") {
				expect(r.code).toBe(2);
				expect(r.stderr).toContain(`bash-guard: refused (${GUARD_RULE[row.rule] ?? row.rule}):`);
			} else {
				// Silent is both streams: PreToolUse stdout on exit 0 reaches the harness.
				expect(r.stdout).toBe("");
				expect(r.stderr).toBe("");
				expect(r.code).toBe(0);
			}
		});
	}

	test("every bash-guard rule has a deny and an allow row", () => {
		for (const id of guardRules)
			for (const want of ["deny", "allow"] as const)
				expect(
					rows.some((r) => r.rule === id && r.expect === want),
					`${id} has no ${want} row`,
				).toBe(true);
	});

	test("every corpus row's rule is in the table", () => {
		const ids = new Set(policy.rules.map((r) => r.id));
		for (const r of corpus) expect(ids.has(r.rule), `${r.rule} is not in policy.json`).toBe(true);
	});
});
