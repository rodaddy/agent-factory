import { describe, expect, test } from "bun:test";
import {
	AGENT_LANE_JOB_TYPES,
	isAgentLaneJobType,
	resultArtifactNameFor,
	VERB_LANE_JOB_TYPES,
	WATCHER_RESULT_NAME,
	WATCHER_RESULT_PATH,
} from "../../src/templates/agent-lane";
import { IMPLEMENT_TEMPLATE_ID, isKnownTemplate } from "../../src/templates/registry";

describe("agent-lane named-artifact contract", () => {
	test("the three agent-lane job types are all allowlisted registry templates", () => {
		// agent-lane.ts spells the ids literally (leaf module, no registry import) to
		// avoid a cycle; this pins them to the registry so the two lists cannot drift.
		for (const id of AGENT_LANE_JOB_TYPES) {
			expect(isKnownTemplate(id)).toBe(true);
		}
		// implement-issue is the one whose registry const is the canonical spelling.
		expect(AGENT_LANE_JOB_TYPES).toContain(IMPLEMENT_TEMPLATE_ID);
		expect([...AGENT_LANE_JOB_TYPES].sort()).toEqual([
			"implement-issue",
			"issue-triage",
			"pr-review",
		]);
	});

	/**
	 * sf#301. A verb lane is NOT an agent lane — it runs `runtime: script` with no
	 * agent and no credential — but it writes the same named artifact, because the
	 * wrapper owns `result.json` and overwrites it with its caller envelope on
	 * every terminal path. Same literal-spelling / cycle-avoidance reasoning as
	 * the list above, so it gets the same drift pin.
	 */
	test("the six verb job types are all allowlisted registry templates", () => {
		for (const id of VERB_LANE_JOB_TYPES) {
			expect(isKnownTemplate(id)).toBe(true);
		}
		expect([...VERB_LANE_JOB_TYPES].sort()).toEqual([
			"newapp",
			"newapp-down",
			"newdb",
			"newdb-down",
			"newroute",
			"newroute-down",
		]);
		// The two lists are DISJOINT: a verb lane must never take the agent-lane
		// `classifyMissing` path, which reads an agent log a script job never writes.
		for (const id of VERB_LANE_JOB_TYPES) {
			expect(AGENT_LANE_JOB_TYPES).not.toContain(id);
		}
	});

	test("resultArtifactNameFor names the artifact for both lane families and nothing else", () => {
		for (const id of [...AGENT_LANE_JOB_TYPES, ...VERB_LANE_JOB_TYPES]) {
			expect(resultArtifactNameFor(id)).toBe(WATCHER_RESULT_NAME);
		}
		// Null means "read the wrapper-owned result.json unchanged". A lane that
		// wrongly resolved a name here would read an artifact nothing writes.
		expect(resultArtifactNameFor("repo-validate")).toBeNull();
		expect(resultArtifactNameFor("infra-static")).toBeNull();
	});

	test("isAgentLaneJobType matches exactly the three lanes and nothing else", () => {
		expect(isAgentLaneJobType("pr-review")).toBe(true);
		expect(isAgentLaneJobType("issue-triage")).toBe(true);
		expect(isAgentLaneJobType("implement-issue")).toBe(true);
		// Every other lane names its OWN artifact (or has none); it is not an agent lane.
		expect(isAgentLaneJobType("infra-static")).toBe(false);
		expect(isAgentLaneJobType("audit-rtech-audit")).toBe(false);
		expect(isAgentLaneJobType("repo-validate")).toBe(false);
		expect(isAgentLaneJobType("")).toBe(false);
	});

	test("the named artifact is a distinct filename that is NOT the wrapper-owned result.json", () => {
		expect(WATCHER_RESULT_NAME).toBe("watcher-result.json");
		// It must not collide with the wrapper's mechanical result.json envelope.
		expect(WATCHER_RESULT_NAME).not.toBe("result.json");
		expect(WATCHER_RESULT_PATH).toBe("/work/out/watcher-result.json");
	});
});
