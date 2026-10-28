/**
 * @module tests/fleet/agent-cards-skill-load
 * @description sf#1690 F1: a seat reads each skill once, from the SKILL.md path
 *   its system prompt lists. A card that also says `paperclipai skills file
 *   <name>` makes the run load the same text twice (69 reads + 52 CLI fetches of
 *   company-conduct in one hour), and every copy is re-sent on each later call.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const AGENTS = resolve(import.meta.dir, "../../fleet/agents");
const cards = readdirSync(AGENTS).map((key) => ({
	key,
	text: readFileSync(join(AGENTS, key, "AGENTS.md"), "utf8"),
}));

describe("fleet/agents/*/AGENTS.md skill loading", () => {
	test("there are cards to check", () => {
		expect(cards.length).toBeGreaterThan(10);
	});

	test("no card tells a seat to fetch a skill with `paperclipai skills file`", () => {
		expect(
			cards.filter((c) => c.text.includes("paperclipai skills file")).map((c) => c.key),
		).toEqual([]);
	});
});
