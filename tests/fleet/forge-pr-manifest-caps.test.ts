/**
 * @module tests/fleet/forge-pr-manifest-caps
 * @description Every host call forge-pr's worker makes (`ctx.<ns>.<method>(`)
 *   needs its capability in the manifest; the host refuses an undeclared one at
 *   runtime. sf#1730 added ctx.issues.listComments without issue.comments.read.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import manifest from "../../fleet/plugins/forge-pr/manifest.js";

const DIR = join(import.meta.dir, "../../fleet/plugins/forge-pr");
// Host call -> the capability it needs; null needs none. An unmapped call fails
// the test, so a new call cannot ship without someone naming its capability.
const NEEDS: Record<string, string | null> = {
	"config.get": null,
	"logger.info": null,
	"logger.warn": null,
	"logger.error": null,
	"companies.list": "companies.read",
	"secrets.resolve": "secrets.read-ref",
	"issues.get": "issues.read",
	"issues.list": "issues.read",
	"issues.create": "issues.create",
	"issues.update": "issues.update",
	"issues.createComment": "issue.comments.create",
	"issues.listComments": "issue.comments.read",
	"issues.listInteractions": "issue.interactions.read",
	"issues.requestWakeup": "issues.wakeup",
	"agents.list": "agents.read",
	"agents.get": "agents.read",
	"events.on": "events.subscribe",
	"agents.invoke": "agents.invoke",
	"projects.list": "projects.read",
	"state.get": "plugin.state.read",
	"state.set": "plugin.state.write",
	"jobs.register": "jobs.schedule",
};

describe("forge-pr manifest declares every capability its worker uses", () => {
	const src = readFileSync(join(DIR, "worker.js"), "utf8");
	const calls = new Set([...src.matchAll(/\bctx\.(\w+)\.(\w+)\(/g)].map((m) => `${m[1]}.${m[2]}`));
	const caps = new Set<string>(manifest.capabilities);
	test("the worker makes host calls (the scan is not empty)", () => {
		expect(calls.has("issues.list")).toBe(true);
	});
	for (const call of calls) {
		test(`ctx.${call}`, () => {
			expect(Object.hasOwn(NEEDS, call)).toBe(true);
			const cap = NEEDS[call];
			if (cap) expect(caps.has(cap)).toBe(true);
		});
	}
});
