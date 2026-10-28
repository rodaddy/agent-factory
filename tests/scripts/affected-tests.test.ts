/**
 * @module tests/scripts/affected-tests
 * @description The pre-push selection of the tests a change can reach.
 *   Four cases, one per rule: a FULL trigger, a two-hop import chain, a basename
 *   match on a shell script, and a docs-only change selecting nothing.
 */
import { describe, expect, test } from "bun:test";
import { selectAffected } from "../../scripts/affected-tests";

const FILES: Record<string, string> = {
	"src/leaf.ts": "export const leaf = 1;\n",
	"src/mid.ts": 'import { leaf } from "./leaf";\nexport const mid = leaf;\n',
	"src/other.ts": "export const other = 2;\n",
	"tests/mid.test.ts": 'import { mid } from "../src/mid";\n',
	"tests/other.test.ts": 'import { other } from "../src/other";\n',
	"tests/fleet/post.test.ts": 'const SCRIPT = join(ROOT, "fleet", "bin", "forge-post");\n',
	"src/runner.ts": 'export const run = () => spawn(join("scripts", "deploy.sh"));\n',
	"tests/runner.test.ts": 'import { run } from "../src/runner";\n',
};

describe("selectAffected", () => {
	test("a toolchain file forces the full suite", () => {
		expect(selectAffected(["src/leaf.ts", "package.json"], FILES)).toEqual({
			kind: "full",
			reason: "package.json changed",
		});
	});

	test("a test reaches a changed module through two imports", () => {
		expect(selectAffected(["src/leaf.ts"], FILES)).toEqual({
			kind: "list",
			tests: ["tests/mid.test.ts"],
			changed: 1,
		});
	});

	test("a changed shell script selects every test naming its basename", () => {
		expect(selectAffected(["fleet/bin/forge-post"], FILES)).toEqual({
			kind: "list",
			tests: ["tests/fleet/post.test.ts"],
			changed: 1,
		});
	});

	test("a deleted module forces the full suite (review finding, PR 1655)", () => {
		expect(selectAffected(["src/gone.ts"], FILES)).toEqual({
			kind: "full",
			reason: "src/gone.ts deleted",
		});
	});

	test("a changed script reaches the tests of a module that names it (review finding, PR 1655)", () => {
		expect(selectAffected(["scripts/deploy.sh"], FILES)).toEqual({
			kind: "list",
			tests: ["tests/runner.test.ts"],
			changed: 1,
		});
	});

	test("a docs-only change selects nothing", () => {
		expect(selectAffected(["_DOCS/architecture.md", "README.md"], FILES)).toEqual({
			kind: "none",
			changed: 2,
		});
	});
});
