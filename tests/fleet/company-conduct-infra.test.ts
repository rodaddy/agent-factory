/**
 * @module tests/fleet/company-conduct-infra
 * @description company-conduct's "Infrastructure is Nagatha's" section, read as
 *   text. Only a change on a host becomes an `Infra request:`
 *   task; a question goes through ask-nagatha and never as a board task; a red
 *   check goes to Greene and a merge to Chang.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../..");
const PATH = "fleet/skills/company-conduct/SKILL.md";
const HEADING = "## Infrastructure is Nagatha's";

/** The infra section of a skill body, up to the next level-2 heading. */
function sectionOf(body: string): string {
	const start = body.indexOf(HEADING);
	if (start < 0) throw new Error(`no "${HEADING}" heading`);
	const next = body.indexOf("\n## ", start + HEADING.length);
	const end = next < 0 ? body.length : next + 1;
	return body.slice(start, end);
}

const live = readFileSync(resolve(ROOT, PATH), "utf8");
const section = sectionOf(live);
const flat = section.replace(/\s+/g, " ");

describe("company-conduct: Infrastructure is Nagatha's", () => {
	test("an Infra request task is only for a change on a host, and says what does not qualify", () => {
		expect(flat).toContain("`Infra request: <what>`");
		expect(flat).toContain("only for a CHANGE");
		for (const nope of [
			"questions",
			"CI or check failures",
			"merges",
			"signoffs",
			"credential or exposure checks",
			"documentation",
		]) {
			expect(flat).toContain(nope);
		}
	});

	test("an infra question goes through ask-nagatha, never as a board task", () => {
		expect(flat).toContain('`ask-nagatha "<question>"`');
		expect(flat).toContain("never as a board task");
		expect(flat).not.toContain("or assign her a board issue");
	});

	test("a red check goes to Greene, a merge to Chang, an infra PR still to Nagatha", () => {
		expect(flat).toContain("Greene (CI Steward)");
		expect(flat).toContain("`fix-flaky-test`");
		expect(flat).toContain("Chang");
		expect(flat).toContain("`merge-pr`");
		expect(flat).toContain("`rtech/rtech-infra` or `rtech/k3s-deploy` still gets Nagatha's review");
	});
});
