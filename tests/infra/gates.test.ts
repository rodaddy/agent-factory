/**
 * @module tests/infra/gates
 * @description Pure-function tests for the fixed static-gate selector: the
 *   path-to-gate map, the narrow-selection paths, and EVERY fail-closed
 *   escalation branch (indeterminate, empty, over-cap, unmapped, cross-cutting /
 *   gate-defining). No I/O, no git, no ambient checkout — purely deterministic.
 */
import { describe, expect, test } from "bun:test";
import { MAX_CHANGED_PATHS, STATIC_GATES, selectGates } from "../../src/infra/gates";

describe("selectGates — narrow mapping", () => {
	test("maps an Ansible-only change to exactly the ansible gate", () => {
		const s = selectGates(["ansible/site.yml", "roles/web/tasks/main.yml"]);
		expect(s.fullEscalation).toBe(false);
		expect(s.gates).toEqual(["ansible"]);
	});

	test("maps a shell-script-only change to exactly the scripts gate", () => {
		const s = selectGates(["scripts/deploy.sh", "bin/run.bash"]);
		expect(s.fullEscalation).toBe(false);
		expect(s.gates).toEqual(["scripts"]);
	});

	test("maps a config-only change to exactly the config gate", () => {
		const s = selectGates(["values.json", "settings.toml"]);
		expect(s.fullEscalation).toBe(false);
		expect(s.gates).toEqual(["config"]);
	});

	test("a mixed change selects the union in fixed order, never all-by-accident", () => {
		const s = selectGates(["roles/db/tasks/main.yml", "scripts/x.sh"]);
		expect(s.fullEscalation).toBe(false);
		// fixed order is ansible, workflows, scripts, config
		expect(s.gates).toEqual(["ansible", "scripts"]);
	});

	test("a leading ./ is normalized before mapping", () => {
		const s = selectGates(["./scripts/x.sh"]);
		expect(s.gates).toEqual(["scripts"]);
	});
});

describe("selectGates — fail-closed escalations", () => {
	const isFull = (s: ReturnType<typeof selectGates>) => {
		expect(s.fullEscalation).toBe(true);
		expect(s.gates).toEqual([...STATIC_GATES]);
	};

	test("indeterminate read escalates to all gates without inspecting paths", () => {
		isFull(selectGates(["scripts/x.sh"], true));
	});

	test("empty change set escalates to all gates", () => {
		isFull(selectGates([]));
	});

	test("a change count over the cap escalates to all gates", () => {
		const many = Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, i) => `scripts/s${i}.sh`);
		isFull(selectGates(many));
	});

	test("an unmapped path escalates to all gates", () => {
		isFull(selectGates(["src/index.ts"]));
	});

	test("an empty-string path escalates to all gates", () => {
		isFull(selectGates([""]));
	});

	test("any .github/ change is cross-cutting and escalates", () => {
		isFull(selectGates([".github/workflows/ci.yml"]));
		isFull(selectGates([".github/dependabot.yml", "scripts/x.sh"]));
	});

	test("the watcher's own gate config escalates", () => {
		isFull(selectGates(["config/repos.yml"]));
		isFull(selectGates(["config/repos.example.yml"]));
	});

	test("a dependency / lock / root manifest escalates by basename", () => {
		for (const p of [
			"requirements.yml",
			"galaxy.yml",
			"Makefile",
			"Dockerfile",
			"package.json",
			"bun.lock",
			"go.mod",
			"go.sum",
			"pyproject.toml",
			"poetry.lock",
			"nested/dir/requirements.yml",
		]) {
			isFull(selectGates([p]));
		}
	});

	test("a cross-cutting path escalates even when other paths would map narrowly", () => {
		isFull(selectGates(["roles/web/tasks/main.yml", "package.json"]));
	});
});

describe("selectGates never invents a base SHA", () => {
	test("its output carries no baseSha field", () => {
		const s = selectGates(["scripts/x.sh"], false);
		expect("baseSha" in s).toBe(false);
	});
});
