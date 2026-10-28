/**
 * @module tests/fleet/project-guard
 * @description The rodaddy.project-guard plugin: every task carries a
 *   project. Pure derivation and the event handler against a fake board.
 *   `PROJECT_GUARD_UNDER_TEST` points the suite at a mutated copy of logic.js
 *   (RED proof).
 */
import { describe, expect, test } from "bun:test";
import type * as Logic from "../../fleet/plugins/project-guard/logic.js";

const target = process.env.PROJECT_GUARD_UNDER_TEST ?? "../../fleet/plugins/project-guard/logic.js";
const { PLUGIN_KEY, REJECT_COMMENT, handleIssueEvent, projectFromTitle } = (await import(
	target
)) as typeof Logic;

const PROJECTS: Logic.Project[] = [
	{ id: "p-sf", name: "rodaddy/software-factory" },
	{ id: "p-infra", name: "rtech/rtech-infra" },
	{ id: "p-whisper", name: "rtech/rtech-whisper-ios" },
	{ id: "p-dev", name: "rodaddy/development" },
	{ id: "p-dev2", name: "client/development" },
];
const AGENTS: Logic.Agent[] = [
	{ id: "a-simms", name: "Simms" },
	{ id: "a-nagatha", name: "Nagatha" },
	{ id: "a-bishop", name: "Bishop" },
];

function fakeBoard(seed: Logic.BoardIssue[], projects: Logic.Project[] = PROJECTS) {
	const issues = seed.map((i) => ({ ...i }));
	const updates: { id: string; patch: Record<string, unknown> }[] = [];
	const comments: { id: string; body: string }[] = [];
	const board: Logic.Board = {
		getIssue: async (id) => issues.find((i) => i.id === id) ?? null,
		listProjects: async () => projects,
		listAgents: async () => AGENTS,
		updateIssue: async (id, patch) => {
			updates.push({ id, patch });
			const i = issues.find((x) => x.id === id);
			if (i) Object.assign(i, patch);
		},
		addComment: async (id, body) => {
			comments.push({ id, body });
		},
	};
	return { issues, updates, comments, board };
}

const created = (id: string, over: Partial<Logic.IssueEvent> = {}): Logic.IssueEvent => ({
	eventType: "issue.created",
	entityId: id,
	actorType: "agent",
	payload: {},
	...over,
});

const issue = (over: Partial<Logic.BoardIssue>): Logic.BoardIssue => ({
	id: "i1",
	title: "Something",
	status: "todo",
	projectId: null,
	parentId: null,
	...over,
});

describe("projectFromTitle", () => {
	test("an owner/repo in the title names its project", () => {
		expect(projectFromTitle("Review rodaddy/software-factory#1690", PROJECTS)).toBe("p-sf");
	});
	test("a 1/2 slice is skipped; the real repo is picked", () => {
		expect(projectFromTitle("Fix 1/2 slice of rtech/rtech-infra#12", PROJECTS)).toBe("p-infra");
	});
	test("a bare repo#n matching one project by suffix", () => {
		expect(projectFromTitle("Triage rtech-whisper-ios#620", PROJECTS)).toBe("p-whisper");
	});
	test("a bare repo#n matching two projects is not derived", () => {
		expect(projectFromTitle("Look at development#9", PROJECTS)).toBeNull();
	});
	test("an unknown owner's owner/repo#n is not matched by its bare repo", () => {
		const projects = [{ id: "rtech-app", name: "rtech/app" }];
		expect(projectFromTitle("Review acme/app#12", projects)).toBeNull();
		expect(projectFromTitle("Review acme/my-app#12", projects)).toBeNull();
		expect(projectFromTitle("Review app#12", projects)).toBe("rtech-app");
	});
	test("nothing that names a project", () => {
		expect(projectFromTitle("Tidy the wiki", PROJECTS)).toBeNull();
	});
});

describe("handleIssueEvent", () => {
	test("an issue with a project is left alone", async () => {
		const f = fakeBoard([issue({ projectId: "p-sf", title: "Tidy" })]);
		const r = await handleIssueEvent({ event: created("i1"), board: f.board });
		expect(r.action).toBe("has-project");
		expect(f.updates).toEqual([]);
		expect(f.comments).toEqual([]);
	});
	test("title-derived project is PATCHed, no comment", async () => {
		const f = fakeBoard([issue({ title: "Review rtech/rtech-whisper-ios#3" })]);
		const r = await handleIssueEvent({ event: created("i1"), board: f.board });
		expect(r).toMatchObject({ action: "derived", why: "title", projectId: "p-whisper" });
		expect(f.updates).toEqual([{ id: "i1", patch: { projectId: "p-whisper" } }]);
		expect(f.comments).toEqual([]);
	});
	test("the parent's project when the title names none", async () => {
		const f = fakeBoard([
			issue({ id: "parent", projectId: "p-sf", title: "Parent" }),
			issue({ id: "i1", parentId: "parent", title: "Child slice" }),
		]);
		const r = await handleIssueEvent({ event: created("i1"), board: f.board });
		expect(r).toMatchObject({ action: "derived", why: "parent", projectId: "p-sf" });
	});
	test("infra: title starts Infra, alerts origin, or created by Nagatha", async () => {
		for (const over of [
			{ title: "Infra: disk full on ct105" },
			{ originKind: "plugin:rodaddy.alerts" },
			{ createdByAgentId: "a-nagatha" },
		]) {
			const f = fakeBoard([issue(over)]);
			const r = await handleIssueEvent({ event: created("i1"), board: f.board });
			expect(r).toMatchObject({ action: "derived", why: "infra", projectId: "p-infra" });
		}
	});
	test("not derivable: todo on Simms with one comment", async () => {
		const f = fakeBoard([issue({ status: "in_progress", assigneeAgentId: "a-bishop" })]);
		const r = await handleIssueEvent({ event: created("i1"), board: f.board });
		expect(r.action).toBe("rejected");
		expect(f.updates).toEqual([
			{ id: "i1", patch: { status: "todo", assigneeAgentId: "a-simms" } },
		]);
		expect(f.comments).toEqual([{ id: "i1", body: REJECT_COMMENT }]);
		expect(REJECT_COMMENT).toBe(
			"No project (Rico 2026-10-07: every task carries a project). Set the right project, then move it back to its owner.",
		);
	});
	test("an unknown owner's owner/repo#n goes to triage, not a same-named project", async () => {
		const f = fakeBoard(
			[issue({ title: "Review acme/app#12" })],
			[{ id: "rtech-app", name: "rtech/app" }],
		);
		const r = await handleIssueEvent({ event: created("i1"), board: f.board });
		expect(r.action).toBe("rejected");
		expect(f.updates.some((u) => "projectId" in u.patch)).toBe(false);
		expect(f.comments).toEqual([{ id: "i1", body: REJECT_COMMENT }]);
	});
	test("an update that clears the project is guarded", async () => {
		const f = fakeBoard([issue({ title: "Review rodaddy/software-factory#1" })]);
		const event = created("i1", {
			eventType: "issue.updated",
			payload: { changes: { projectId: { from: "p-sf", to: null } } },
		});
		const r = await handleIssueEvent({ event, board: f.board });
		expect(r).toMatchObject({ action: "derived", projectId: "p-sf" });
	});
	test("an update that does not clear the project is ignored", async () => {
		const f = fakeBoard([issue({})]);
		const event = created("i1", {
			eventType: "issue.updated",
			payload: { changes: { status: { from: "todo", to: "in_progress" } } },
		});
		const r = await handleIssueEvent({ event, board: f.board });
		expect(r.action).toBe("ignored");
		expect(f.updates).toEqual([]);
	});
	test("no loop: an event caused by this plugin's own write is ignored", async () => {
		const f = fakeBoard([issue({})]);
		const event = created("i1", {
			eventType: "issue.updated",
			actorType: "plugin",
			payload: { pluginKey: PLUGIN_KEY, changes: { projectId: { from: "p-sf", to: null } } },
		});
		const r = await handleIssueEvent({ event, board: f.board });
		expect(r.action).toBe("ignored");
		expect(f.updates).toEqual([]);
		expect(f.comments).toEqual([]);
	});
	test("a closed issue is not reopened", async () => {
		const f = fakeBoard([issue({ status: "done" })]);
		const r = await handleIssueEvent({ event: created("i1"), board: f.board });
		expect(r.action).toBe("ignored");
		expect(f.updates).toEqual([]);
	});
});
