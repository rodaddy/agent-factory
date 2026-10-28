/**
 * @module tests/fleet/operator-notify-files
 * @description The notifier's LaunchAgent file, its README and the employee
 *   rule, read as text. The plist carries absolute paths only and no
 *   token, recipient or address. `OPERATOR_NOTIFY_FILES_ROOT` points the suite at a
 *   mutated copy of the tree.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const ROOT = process.env.OPERATOR_NOTIFY_FILES_ROOT ?? resolve(import.meta.dir, "../..");
const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
const NODE = "/opt/homebrew/opt/node@24/bin/node";

describe("operator-notify files", () => {
	test("the plist names the job, the interval and the Node 24 keg, and nothing private", () => {
		// The keg path is the one place an at-sign is allowed.
		const plist = read("fleet/notify/com.operator.factory-notify.plist");
		expect(plist).toContain("<string>com.operator.factory-notify</string>");
		expect(plist).toContain("<integer>300</integer>");
		const args = plist.slice(plist.indexOf("<key>ProgramArguments</key>"));
		expect(/<string>([^<]*)<\/string>/.exec(args)?.[1]).toBe(NODE);
		const rest = plist.split(NODE).join("");
		for (const banned of ["~", "$", "@", "PAPERCLIP_BOARD_TOKEN", "OPERATOR_NOTIFY_TO"]) {
			expect(rest).not.toContain(banned);
		}
		expect(plist).toContain("/opt/factory-notify/");
	});

	test("company-conduct tells employees how a TELL OPERATOR: line reaches him", () => {
		const skill = read("fleet/skills/company-conduct/SKILL.md");
		expect(skill).toContain("## Reaching the operator");
		expect(skill).toContain("TELL OPERATOR:");
		expect(skill).toContain("direct link");
	});

	test("the README says its state, how to stop the job, and holds no address", () => {
		const readme = read("fleet/notify/README.md");
		expect(readme.split("\n")[0]).toContain("WRITTEN, not installed");
		expect(readme).toContain("launchctl bootout");
		expect(readme).toContain("--service imessage");
		expect(readme.split("node@24").join("")).not.toContain("@");
		expect(readme.split("\n").length).toBeLessThan(80);
	});
});
