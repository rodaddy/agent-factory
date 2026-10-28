import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as infraGates from "../../scripts/actions/infra-gates";
import {
	decideInfraVerdict,
	INFRA_GATE_COMMENT_MAX,
	planInfraGates,
	readVerdictInputs,
	renderGateScript,
	renderVerdictComment,
} from "../../scripts/actions/infra-gates";
import { INFRA_STATIC_COMMANDS } from "../../src/infra/body";
import { type GateId, STATIC_GATES } from "../../src/infra/gates";
import { INFRA_RUNNER_LINTRC_ROOT } from "../../src/infra/sandbox-section";
import { testTmpBase } from "../support/test-temp";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const compare = (names: string[]) => ({ files: names.map((filename) => ({ filename })) });

describe("infra-gates plan", () => {
	test("a Forgejo compare escalates to every gate with the fixed command literals", async () => {
		const plan = await planInfraGates(
			compare(["roles/web/tasks/main.yml", "scripts/x.sh"]),
			"rtech/rtech-infra",
			BASE,
			HEAD,
		);
		expect(plan.fullEscalation).toBe(true);
		expect(plan.changedReason).toContain("Forgejo compare completeness is unproven");
		expect(plan.gates.map((g) => g.gate)).toEqual([...STATIC_GATES]);
		for (const entry of plan.gates) {
			expect(entry.commands).toEqual(INFRA_STATIC_COMMANDS[entry.gate].commands);
		}
	});

	test("an unreadable compare body escalates too", async () => {
		const plan = await planInfraGates({}, "rtech/rtech-infra", BASE, HEAD);
		expect(plan.gates.map((g) => g.gate)).toEqual([...STATIC_GATES]);
		expect(plan.changedReason).toContain("missing or non-array files");
	});

	test("the run script carries exactly the planned literals, one report line each", async () => {
		const plan = await planInfraGates(compare(["a.yml"]), "o/r", BASE, HEAD);
		const script = renderGateScript(plan);
		const total = plan.gates.reduce((n, g) => n + g.commands.length, 0) + plan.gates.length;
		expect(script.split("\n").filter((l) => l.includes('>> "$OUT/report.tsv"'))).toHaveLength(
			total,
		);
		for (const entry of plan.gates) {
			for (const command of entry.commands) expect(script).toContain(`( ${command} )`);
		}
		expect(script).not.toContain("a.yml");
	});
});

describe("infra-gates verdict", () => {
	const planFor = async () => planInfraGates(compare(["a.yml"]), "o/r", BASE, HEAD);
	const reportAll = async (exit: (gate: string, i: number) => number) => {
		const plan = await planFor();
		return plan.gates
			.flatMap((g) => g.commands.map((_c, i) => `${g.gate}\t${i}\t${exit(g.gate, i)}`))
			.join("\n");
	};

	test("every command exiting 0 is success", async () => {
		const v = decideInfraVerdict(await planFor(), await reportAll(() => 0));
		expect(v.state).toBe("success");
	});

	test("one non-zero exit is failure naming the gate", async () => {
		const v = decideInfraVerdict(
			await planFor(),
			await reportAll((g) => (g === "scripts" ? 1 : 0)),
		);
		expect(v.state).toBe("failure");
		expect(v.description).toBe("infra-static: gate(s) failed: scripts");
	});

	test("a missing line is failure; a duplicate cannot turn a failure green", async () => {
		const plan = await planFor();
		const partial = (await reportAll(() => 0)).split("\n").slice(1).join("\n");
		expect(decideInfraVerdict(plan, partial).state).toBe("failure");
		const dup = `${await reportAll((g) => (g === "config" ? 2 : 0))}\nconfig\t0\t0\nconfig\t1\t0`;
		expect(decideInfraVerdict(plan, dup).state).toBe("failure");
	});

	test("no report is error, never success", async () => {
		expect(decideInfraVerdict(await planFor(), null).state).toBe("error");
	});

	test("the comment is signed, bounded, and carries no report bytes", async () => {
		const plan = await planFor();
		const v = decideInfraVerdict(plan, `${await reportAll(() => 0)}\n<script>evil</script>`);
		const body = renderVerdictComment(plan, v, HEAD, "https://example.invalid/run/1");
		expect(body.startsWith("**agent:** forgejo-actions")).toBe(true);
		expect(body.length).toBeLessThanOrEqual(INFRA_GATE_COMMENT_MAX);
		expect(body).not.toContain("evil");
		expect(body).toContain("## factory/infra-static: success");
	});
});

describe("infra-gates verdict inputs (the trusted plan never comes from the report)", () => {
	test("a plan.json inside the report dir is ignored; only report.tsv is read there", async () => {
		const root = mkdtempSync(join(testTmpBase(), "sf827-verdict-inputs-"));
		try {
			const planDir = join(root, "in");
			const reportDir = join(root, "rpt");
			mkdirSync(planDir);
			mkdirSync(reportDir);
			const trusted = await planInfraGates({}, "o/r", BASE, HEAD);
			writeFileSync(join(planDir, "plan.json"), JSON.stringify(trusted));
			const forged = { ...trusted, reason: "FORGED", gates: trusted.gates.slice(0, 1) };
			writeFileSync(join(reportDir, "plan.json"), JSON.stringify(forged));
			writeFileSync(join(reportDir, "report.tsv"), "yaml\t0\t0\n");
			const { plan, report } = await readVerdictInputs(planDir, reportDir);
			expect(plan?.gates.map((g) => g.gate)).toEqual(trusted.gates.map((g) => g.gate));
			expect(plan?.reason).not.toBe("FORGED");
			expect(report).toBe("yaml\t0\t0\n");
			expect((await readVerdictInputs(planDir, join(root, "absent"))).report).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("infra-gates plan honors the target repo's factory.yml (827c)", () => {
	// A fake tree reader standing in for `git ls-tree` (mode) and `git show`
	// (text): the plan never reads the target from the filesystem.
	type Entry = { mode: string; text: string };
	const inTarget = async (files: Record<string, string | Entry>, changed = ["a.yml"]) => {
		const tree = new Map<string, Entry>(
			Object.entries(files).map(([p, v]) => [
				p,
				typeof v === "string" ? { mode: "100644", text: v } : v,
			]),
		);
		const reader = {
			mode: async (p: string) => tree.get(p)?.mode ?? null,
			show: async (p: string) => {
				const e = tree.get(p);
				if (!e) throw new Error(`fatal: path '${p}' does not exist`);
				return e.text;
			},
		};
		return planInfraGates(compare(changed), "o/r", BASE, HEAD, reader);
	};

	test("a lintrc that is a symlink (120000) or behind a symlinked dir is not threaded", async () => {
		const plan = await inTarget({
			"factory.yml": "static:\n  yamllint_config: cfg/yamllint.yml\n  shellcheck_rc: rc\n",
			cfg: { mode: "120000", text: "/etc" },
			rc: { mode: "120000", text: "/etc/passwd" },
		});
		const script = renderGateScript(plan);
		expect(script).not.toContain("cfg/yamllint.yml");
		expect(script).not.toContain("--rcfile");
		expect(plan.notes).toHaveLength(2);
	});

	test("a policy that excludes every selected gate is success with nothing run", async () => {
		const plan = await inTarget({ "factory.yml": "static:\n  gates: [scripts]\n" });
		// Force a path-selected set that does not overlap the policy.
		const narrowed = { ...plan, gates: [], excludedByPolicy: ["config" as const] };
		const v = decideInfraVerdict(narrowed, null);
		expect(v.state).toBe("success");
		expect(v.description).toContain("excluded by policy");
		const body = renderVerdictComment(narrowed, v, HEAD, "https://example.invalid/run/1");
		expect(body).toContain("excluded by factory.yml policy: config");
	});

	test("the plan lists the selected gates the policy excluded", async () => {
		const plan = await inTarget({ "factory.yml": "static:\n  gates: [scripts, config]\n" });
		expect(plan.excludedByPolicy).toEqual(["ansible", "workflows"]);
	});

	test("with no policy an empty selection is still the genuine error", () => {
		const v = decideInfraVerdict(
			{
				gates: [],
				fullEscalation: false,
				reason: "r",
				changedReason: "c",
				policy: "default",
				notes: [],
				excludedByPolicy: [],
			},
			null,
		);
		expect(v.state).toBe("error");
		expect(v.description).toContain("selected no gate");
	});

	test("a symlinked factory.yml is a refusal, never followed", async () => {
		const plan = await inTarget({ "factory.yml": { mode: "120000", text: "/etc/passwd" } });
		expect(plan.policyError).toBe("factory.yml (file): is not a regular file");
		expect(plan.gates).toEqual([]);
	});

	test("no factory.yml: policy default, all four gates", async () => {
		const plan = await inTarget({});
		expect(plan.policy).toBe("default");
		expect(plan.gates.map((g) => g.gate)).toEqual([...STATIC_GATES]);
	});

	test("the plan is restricted to the policy's gates and says policy factory.yml", async () => {
		const plan = await inTarget({ "factory.yml": "static:\n  gates: [scripts, config]\n" });
		expect(plan.policy).toBe("factory.yml");
		expect(plan.gates.map((g) => g.gate)).toEqual(["scripts", "config"]);
		const v = decideInfraVerdict(plan, "scripts\t0\t0\nconfig\t0\t0\nconfig\t1\t0");
		expect(v.state).toBe("success");
		const body = renderVerdictComment(plan, v, HEAD, "https://example.invalid/run/1");
		expect(body).toContain("## factory/infra-static: success (policy: factory.yml)");
	});

	test("a lintrc path present in the checkout is threaded into the gate command", async () => {
		const plan = await inTarget({
			"factory.yml":
				"static:\n  yamllint_config: lint/yamllint.yml\n  shellcheck_rc: .shellcheckrc\n  actionlint_config: missing.yml\n",
			"lint/yamllint.yml": "extends: default\n",
			".shellcheckrc": "disable=SC2086\n",
		});
		const script = renderGateScript(plan);
		expect(script).toContain("yamllint -f parsable -c 'lint/yamllint.yml' .");
		expect(script).toContain("YAMLLINT_CONFIG_FILE='lint/yamllint.yml' ansible-lint ");
		expect(script).toContain("shellcheck --rcfile '.shellcheckrc' -f gcc");
		expect(script).not.toContain("missing.yml");
		expect(plan.notes.join("\n")).toContain("actionlint_config missing.yml is not in the checkout");
	});

	test("an invalid factory.yml is an error verdict naming the field, never a default", async () => {
		const plan = await inTarget({ "factory.yml": "static:\n  gates: [docker]\n" });
		expect(plan.gates).toEqual([]);
		const v = decideInfraVerdict(plan, null);
		expect(v.state).toBe("error");
		expect(v.description).toContain("factory.yml static.gates.0");
	});
});

describe("infra-gates verdict when no gate plan arrived", () => {
	test("readVerdictInputs on a plan dir with no plan.json -> plan null", async () => {
		const root = mkdtempSync(join(testTmpBase(), "sf1034-noplan-"));
		try {
			const planDir = join(root, "in");
			mkdirSync(planDir);
			expect((await readVerdictInputs(planDir, join(root, "rpt"))).plan).toBeNull();
			writeFileSync(join(planDir, "plan.json"), '{"reason":"x"}');
			expect((await readVerdictInputs(planDir, join(root, "rpt"))).plan).toBeNull();
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("decideInfraVerdict(null, null) is an error naming the missing plan", () => {
		expect(decideInfraVerdict(null, null)).toEqual({
			state: "error",
			description: "infra-static: no gate plan arrived from the pending job",
			rows: [],
		});
	});

	test("the comment for a null plan has no undefined and names the cause", () => {
		const v = decideInfraVerdict(null, null);
		const body = renderVerdictComment(null, v, HEAD, "https://run");
		expect(body).not.toContain("undefined");
		expect(body).toContain("no gate plan arrived");
	});
});

describe("infra-gates tool probe", () => {
	// Namespace read so the RED run fails per test, not at import.
	const probes = (infraGates as { GATE_TOOL_PROBES?: Record<GateId, string> }).GATE_TOOL_PROBES;
	const probeFor = (g: GateId): string => {
		if (!probes) throw new Error("GATE_TOOL_PROBES is not exported");
		return probes[g];
	};
	const fullPlan = () => planInfraGates({}, "o/r", BASE, HEAD);
	const reportWith = async (ansibleExit: number, tools: Partial<Record<GateId, number>> | null) => {
		const plan = await fullPlan();
		const rows = plan.gates.flatMap((g) =>
			g.commands.map((_c, i) => `${g.gate}\t${i}\t${g.gate === "ansible" ? ansibleExit : 0}`),
		);
		const toolLines = tools ? Object.entries(tools).map(([g, code]) => `tool\t${g}\t${code}`) : [];
		return { plan, report: [...rows, ...toolLines].join("\n") };
	};

	test("the run script probes every planned gate's tool before its first command", async () => {
		const plan = await fullPlan();
		const script = renderGateScript(plan);
		for (const entry of plan.gates) {
			const probe = `( ${probeFor(entry.gate)} ) > "$OUT/logs/${entry.gate}-tool.log" 2>&1 < /dev/null`;
			const printf = `printf 'tool\\t${entry.gate}\\t%s\\n' "$?" >> "$OUT/report.tsv"`;
			expect(script).toContain(probe);
			expect(script).toContain(printf);
			const first = `( ${entry.commands[0]} ) > "$OUT/logs/${entry.gate}-0.log"`;
			expect(script.indexOf(probe)).toBeLessThan(script.indexOf(first));
		}
	});

	test("a dead planned tool is error naming the gate", async () => {
		const { plan, report } = await reportWith(1, {
			ansible: 1,
			workflows: 0,
			scripts: 0,
			config: 0,
		});
		const v = decideInfraVerdict(plan, report);
		expect(v.state).toBe("error");
		expect(v.description).toBe("infra-static: gate tool(s) did not start: ansible");
		expect(v.toolFailed).toEqual(["ansible"]);
	});

	test("a live tool with a non-zero command stays a failure", async () => {
		const { plan, report } = await reportWith(1, {
			ansible: 0,
			workflows: 0,
			scripts: 0,
			config: 0,
		});
		expect(decideInfraVerdict(plan, report).state).toBe("failure");
	});

	test("all rows 0 is success with or without tool lines", async () => {
		const withTools = await reportWith(0, { ansible: 0, workflows: 0, scripts: 0, config: 0 });
		expect(decideInfraVerdict(withTools.plan, withTools.report).state).toBe("success");
		const bare = await reportWith(0, null);
		expect(decideInfraVerdict(bare.plan, bare.report).state).toBe("success");
	});

	test("a tool line for an unplanned gate changes nothing", async () => {
		const { plan, report } = await reportWith(0, null);
		expect(decideInfraVerdict(plan, `${report}\ntool\tdocker\t1`).state).toBe("success");
	});

	test("the comment names the dead tool and carries no report bytes", async () => {
		const { plan, report } = await reportWith(1, {
			ansible: 1,
			workflows: 0,
			scripts: 0,
			config: 0,
		});
		const v = decideInfraVerdict(plan, `${report}\n<script>evil</script>`);
		const body = renderVerdictComment(plan, v, HEAD, "https://example.invalid/run/1");
		expect(body).toContain("tool did not start: ansible");
		expect(body).not.toContain("evil");
		expect(body.length).toBeLessThanOrEqual(INFRA_GATE_COMMENT_MAX);
	});

	test("real bash: a tool that dies on import makes the verdict error", async () => {
		const root = mkdtempSync(join(testTmpBase(), "sf1048-toolprobe-"));
		try {
			const plan = await planInfraGates({}, "o/r", BASE, HEAD);
			const bin = join(root, "bin");
			const src = join(root, "src");
			const out = join(root, "out");
			const lintrc = join(root, "lintrc");
			mkdirSync(bin);
			mkdirSync(src);
			const fake = (name: string, body: string) => {
				writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
				chmodSync(join(bin, name), 0o755);
			};
			fake(
				"ansible-lint",
				"echo \"ModuleNotFoundError: No module named 'ansible.parsing.yaml.constructor'\" >&2; exit 1",
			);
			for (const t of ["yamllint", "yq", "shellcheck", "actionlint"]) fake(t, "exit 0");
			const init = Bun.spawnSync(["git", "init", "-q", src]);
			expect(init.exitCode).toBe(0);
			const script = renderGateScript(plan).replaceAll(INFRA_RUNNER_LINTRC_ROOT, lintrc);
			writeFileSync(join(root, "run-gates.sh"), script);
			const run = Bun.spawnSync(["bash", join(root, "run-gates.sh"), src, out], {
				env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` },
			});
			expect(run.exitCode).toBe(0);
			const report = readFileSync(join(out, "report.tsv"), "utf8");
			expect(report).toContain("tool\tansible\t1");
			expect(decideInfraVerdict(plan, report).state).toBe("error");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
