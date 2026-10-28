/**
 * The agentless `script` runtime.
 *
 * These tests pin THREE properties, in the order they matter:
 *
 *  1. A script dispatch carries NO agent route — no `model`, no `effort` — and
 *     is refused before a box is allocated if one is present. A script runtime
 *     has no LLM in the loop, so a model id travelling with it is a routing
 *     defect, not a harmless extra key.
 *  2. A script lane renders the EXACT fixed command list from the reviewed
 *     template, fixture-pinned. Repository content never contributes a command.
 *  3. An agent lane is unchanged (the control test): its runtime resolution and
 *     its submitted payload are byte-identical to the pre-#177 shape.
 */
import { describe, expect, test } from "bun:test";
import { SCRIPT_ROUTE } from "../../src/runner/script-route";
import {
	AGENTLESS_TEMPLATE_IDS,
	isAgentlessTemplate,
	renderScriptCommandBlock,
	SCRIPT_RUNTIME,
	scriptCommandSet,
	scriptRouteViolation,
} from "../../src/runner/script-runtime";
import { RUNNER_RUNTIMES } from "../../src/runner/transport";

describe("the script runtime is a first-class, agentless wire runtime", () => {
	test("`script` is a member of the closed runtime union", () => {
		expect(RUNNER_RUNTIMES).toContain(SCRIPT_RUNTIME);
		expect(SCRIPT_RUNTIME).toBe("script");
	});

	test("the agentless template set is exactly the reviewed opt-in list", () => {
		// Deliberately NARROW. Converting a judgment lane (triage, review,
		// implement) is a non-goal of #177, so the membership is asserted exactly
		// rather than by shape — adding a lane here must red this test and be a
		// reviewed decision, never a silent widening.
		expect([...AGENTLESS_TEMPLATE_IDS]).toEqual(["infra-static-agentless"]);
		expect(isAgentlessTemplate("infra-static-agentless")).toBe(true);
		expect(isAgentlessTemplate("infra-static")).toBe(false);
		expect(isAgentlessTemplate("issue-triage")).toBe(false);
		expect(isAgentlessTemplate("pr-review")).toBe(false);
	});
});

describe("a script route may carry no agent route", () => {
	test("a script route MISSING model or effort is a NAMED violation", () => {
		expect(scriptRouteViolation({ runtime: "script" })).toMatch(/model/);
		expect(scriptRouteViolation({ runtime: "script", model: "gpt-6-luna" })).toMatch(/effort/);
		expect(scriptRouteViolation({ runtime: "script", effort: "low" })).toMatch(/model/);
		expect(scriptRouteViolation({ runtime: "script", model: "", effort: "" })).toMatch(/model/);
	});

	test("a script route carrying model and effort is clean", () => {
		expect(
			scriptRouteViolation({ runtime: "script", model: "gpt-6-luna", effort: "max" }),
		).toBeNull();
	});

	test("SCRIPT_ROUTE is the reviewed luna/max route", () => {
		expect(SCRIPT_ROUTE).toEqual({ model: "gpt-6-luna", effort: "max" });
	});

	test("an AGENT runtime carrying model/effort is untouched — the control", () => {
		// The pi route is the reason model/effort exist at all. The script
		// guard must not reach it, or #177 silently breaks #171.
		expect(scriptRouteViolation({ runtime: "pi", model: "gpt-6.1-sol", effort: "low" })).toBeNull();
		expect(scriptRouteViolation({ runtime: "claude" })).toBeNull();
		expect(scriptRouteViolation({ runtime: "codex", model: "x" })).toBeNull();
		expect(scriptRouteViolation({})).toBeNull();
	});
});

describe("a script body is the fixed reviewed command list, fixture-pinned", () => {
	test("infra-static-agentless renders the exact reviewed command block", () => {
		const block = renderScriptCommandBlock("infra-static-agentless");
		expect(block).toBe(
			[
				"#!/usr/bin/env bash",
				"set -euo pipefail",
				"",
				"# Ansible static lint",
				// PINNED lint configs outside the checkout (F1/F9): a candidate
				// `.yamllint`/`.ansible-lint` must not redefine what a check examines,
				// and `rulesdir` in a checked-in config gets candidate Python executed.
				"YAMLLINT_CONFIG_FILE=/work/lintrc/yamllint.yml ansible-lint -f pep8 -c /work/lintrc/ansible-lint.yml --project-dir .",
				"yamllint -f parsable -c /work/lintrc/yamllint.yml .",
				"",
				"# GitHub Actions workflow static lint",
				// GUARDED, not bare `actionlint`: rtech-infra has no `.github/workflows`,
				// so bare actionlint exited 3 on every run (job 11709).
				"if [ -d .github/workflows ]; then actionlint; else echo 'no .github/workflows: nothing to lint'; fi",
				"",
				"# Shell script static lint",
				// The file list is positional and quoted after `--` so a tracked
				// `--help.sh` cannot become an option, with the empty case guarded
				// because shellcheck exits 3 on no operands (F2/F3).
				`set -- $(git ls-files '*.sh' '*.bash'); if [ "$#" -eq 0 ]; then echo 'no tracked shell scripts: nothing to lint'; else shellcheck --norc -f gcc -- "$@"; fi`,
				"",
				"# Configuration static lint",
				"yamllint -f parsable -c /work/lintrc/yamllint.yml .",
				"for f in $(git ls-files '*.yml' '*.yaml'); do yq -e true \"$f\" >/dev/null; done",
			].join("\n"),
		);
	});

	test("the command set is fail-fast and carries no interpolation slot", () => {
		const block = renderScriptCommandBlock("infra-static-agentless");
		expect(block).toContain("set -euo pipefail");
		// A `{{marker}}` in a script body would be a substitution point, and the
		// only safe number of substitution points in an executed command block is
		// zero: the commands come from the reviewed template, never from a render
		// context that repository content could reach.
		expect(block).not.toMatch(/\{\{|\$\{/);
	});

	test("the command set is sourced from the reviewed infra gate literal", () => {
		// Not a second copy of the commands: the agentless lane executes the SAME
		// reviewed literal the agent lane instructs, so the two cannot drift.
		const commands = scriptCommandSet("infra-static-agentless").flatMap((g) => g.commands);
		expect(commands).toContain(
			"if [ -d .github/workflows ]; then actionlint; else echo 'no .github/workflows: nothing to lint'; fi",
		);
		expect(commands).toContain(
			"YAMLLINT_CONFIG_FILE=/work/lintrc/yamllint.yml ansible-lint -f pep8 -c /work/lintrc/ansible-lint.yml --project-dir .",
		);
		expect(commands.length).toBe(6);
	});

	test("an unknown template has no command set", () => {
		expect(renderScriptCommandBlock("infra-static")).toBeNull();
		expect(renderScriptCommandBlock("issue-triage")).toBeNull();
	});

	test("repo-validate composes the fixed pre-push command set", () => {
		// The receipt script and the receipt schema read ONE literal, so the two
		// cannot drift into disagreeing about what was validated.
		expect(scriptCommandSet("repo-validate")).toEqual([
			{
				label: "Exact-SHA pre-push validation",
				commands: ["bun run check", "./specs/software-factory.verify.sh"],
			},
		]);
	});

	test("repo-validate is NOT agentless: the watcher still dispatches it as an agent lane", () => {
		// `service-proposal-deps.ts` dispatches `repo-validate` as an AGENT lane, so
		// adding it to the agentless set would silently reroute that path. Composing
		// its command set here does not opt it in.
		expect(isAgentlessTemplate("repo-validate")).toBe(false);
		expect(renderScriptCommandBlock("repo-validate")).toBeNull();
		expect(AGENTLESS_TEMPLATE_IDS).toEqual(["infra-static-agentless"]);
	});
});
