/**
 * @module tests/fleet/pi-check-profiles
 * @description `fleet/pi/check-profiles` as a child process on fixture roots and
 *   on the repo's own profiles. `PI_CHECK_PROFILES_UNDER_TEST` runs a mutated copy instead.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const REPO_FLEET = resolve(import.meta.dir, "../../fleet");
const SCRIPT = process.env.PI_CHECK_PROFILES_UNDER_TEST ?? join(REPO_FLEET, "pi/check-profiles");
const GUARD = "pi-extensions/fleet-guard/index.ts";
const OTHER = "pi-extensions/other/index.ts";
const FAMILY_D = {
	tools: ["read", "bash", "edit", "write", "ls", "board_get", "board_comment"],
	roleTools: ["board_get", "board_comment"],
	models: { families: ["claude-opus"] },
	thinking: { allowed: ["low", "high"] },
	writeRoots: ["~/fleet-work/cto"],
	caps: { maxTurns: 120, maxWallSec: 3600, maxSpendUsd: 10 },
};
const CAPS = { maxTurns: 100, maxWallSec: 1800, maxSpendUsd: 5 };
const v1 = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
	...{ schemaVersion: 1, employee: "cto", family: "D", extensions: [GUARD] },
	...{
		tools: ["read", "bash", "board_get"],
		roleTools: ["board_get"],
		agentDir: "~/.pi/seats/cto",
	},
	...{ models: { families: ["claude-opus"] }, thinking: { allowed: ["high"], default: "high" } },
	...{ writeRoots: ["~/fleet-work/cto"], caps: CAPS },
	...over,
});
const ROUTER = { mode: "advisory", provider: "p", default: { model: "m", thinking: "high" } };

let scratch = "";
let n = 0;
beforeAll(() => {
	scratch = mkdtempSync(join(testTmpBase(), "pi-check-profiles-"));
});
afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const AGENTS = { cto: { timeoutSec: 1800 } };
function fleet(profiles: Record<string, unknown>, agents: unknown = AGENTS) {
	const root = join(scratch, `f${++n}`);
	const dirs = "pi/profiles pi/families pi-extensions/fleet-guard pi-extensions/other board";
	for (const d of dirs.split(" ")) mkdirSync(join(root, d), { recursive: true });
	const put = (p: string, v: unknown) =>
		writeFileSync(join(root, p), typeof v === "string" ? v : JSON.stringify(v));
	put(GUARD, "export {};\n");
	put(OTHER, "export {};\n");
	put("pi/families/D.json", FAMILY_D);
	put("board/agents.json", agents);
	for (const [name, body] of Object.entries(profiles)) put(`pi/profiles/${name}.json`, body);
	return root;
}

function run(root: string): { code: number; out: string } {
	const p = Bun.spawnSync([SCRIPT, "--root", root], { stdout: "pipe", stderr: "pipe" });
	return { code: p.exitCode ?? -1, out: p.stdout.toString() + p.stderr.toString() };
}

describe("pass (exit 0)", () => {
	test("a valid v1 profile passes and the count line is printed", () => {
		const r = run(fleet({ cto: v1({ router: { ...ROUTER, tiers: { deep: ROUTER.default } } }) }));
		expect([r.code, r.out]).toEqual([0, "PASS cto\nprofiles: 1 checked\n"]);
	});
	test("a v0 profile (no schemaVersion) passes on the launcher rules", () => {
		const r = run(
			fleet({ bishop: { tools: ["read"], extensions: [GUARD], models: { families: ["x"] } } }),
		);
		expect([r.code, r.out]).toEqual([0, "PASS bishop (v0)\nprofiles: 1 checked\n"]);
	});
});

const { agentDir: _dir, ...noAgentDir } = v1();
const cto = (over: Record<string, unknown>) => ({ cto: v1(over) });
const FAILS: [RegExp, Record<string, unknown>, unknown?][] = [
	[
		/cto: tools outside family D ceiling: forge_label/,
		cto({ tools: ["forge_label"], roleTools: [] }),
	],
	[/cto: caps\.maxTurns 500 above family D/, cto({ caps: { ...CAPS, maxTurns: 500 } })],
	[/cto: extensions\[0\] must be fleet-guard/, cto({ extensions: [OTHER, GUARD] })],
	[
		/bishop: extensions\[0\] must be fleet-guard/,
		{ bishop: { tools: ["ls"], extensions: [OTHER] } },
	],
	[
		/cto: roleTools not in tools: board_comment/,
		cto({ roleTools: ["board_get", "board_comment"] }),
	],
	[
		/cto: caps\.maxWallSec 2400 exceeds agents\.json timeoutSec 1800/,
		cto({ caps: { ...CAPS, maxWallSec: 2400 } }),
	],
	[/cto: employee 'infra' must equal/, cto({ employee: "infra" })],
	[/cto: missing required field agentDir/, { cto: noAgentDir }],
	[
		/cto: router\.tiers: keys must be/,
		cto({ router: { ...ROUTER, tiers: { huge: ROUTER.default } } }),
	],
	[/cto: agentDir must be a non-empty string/, cto({ agentDir: "" })],
	[/cto: models\.families is required/, cto({ models: {} })],
	[/cto: router needs .* and a provider/, cto({ router: { ...ROUTER, provider: 7 } })],
	[/cto: jev\.decideBudget must be an integer >= 0/, cto({ jev: { decideBudget: -1 } })],
	[/cto: agents\.json entry for .cto. must be an object/, cto({}), { cto: "str" }],
];
describe("fail (exit 1, names the key)", () => {
	// Every row gets an explicit agents.json: a shorter row would hand bun a done callback.
	const rows = FAILS.map(([want, profiles, agents]) => [want, profiles, agents ?? AGENTS] as const);
	test.each(rows)("FAIL %p", (want, profiles, agents) => {
		const r = run(fleet(profiles, agents));
		expect(r.out).toMatch(want);
		expect(r.code).toBe(1);
	});
});

describe("harness errors (exit 3, never 0)", () => {
	test("empty agents.json", () => expect(run(fleet({ cto: v1() }, {})).code).toBe(3));
	test("unreadable agents.json", () => expect(run(fleet({ cto: v1() }, "{not json")).code).toBe(3));
	test("zero profiles found", () => {
		const r = run(fleet({}));
		expect([r.code, r.out]).toEqual([3, expect.stringContaining("no profiles found")]);
	});
});
