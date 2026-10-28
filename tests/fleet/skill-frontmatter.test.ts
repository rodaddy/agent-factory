/**
 * @description Every fleet skill can be created on the board by
 * `fleet/board/apply-agents.sh`: its create path reads the description with
 * `sed -n 's/^description: "\(.*\)"$/\1/p'` and refuses a skill without one.
 * An unquoted `description:` stopped the live apply for SOF-11622 at
 * spawn-helper, after the skills before it were written and before any seat.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");
const skillsDir = join(root, "fleet/skills");
// The exact expression apply-agents.sh uses, run with the same sed.
const applySed = 's/^description: "\\(.*\\)"$/\\1/p';

describe("fleet skill front matter", () => {
	test("apply-agents.sh's sed reads a non-empty description from every SKILL.md", () => {
		const skills = readdirSync(skillsDir).filter((s) => existsSync(join(skillsDir, s, "SKILL.md")));
		expect(skills.length).toBeGreaterThan(0);
		const unreadable = skills.filter((s) => {
			const r = Bun.spawnSync(["sed", "-n", applySed, join(skillsDir, s, "SKILL.md")]);
			return r.exitCode !== 0 || (r.stdout.toString().split("\n")[0] ?? "").trim() === "";
		});
		expect(unreadable).toEqual([]);
	});
});
