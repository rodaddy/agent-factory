/**
 * @module tests/fleet/rico-notify-rules
 * @description Pure rules of the notifier: which board rows become
 *   something the owner must see. Fixture objects only, no I/O.
 */
import { describe, expect, test } from "bun:test";
import {
	approvalItems,
	badAgents,
	blockedItems,
	issuesToScan,
	TELL_MARKER,
	tellItems,
} from "../../fleet/notify/rules";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const blocked = (over: Record<string, unknown> = {}) => ({
	id: "i1",
	identifier: "RIC-10",
	title: "Merge the thing",
	status: "blocked",
	blockedTransitionAt: "2026-10-03T10:00:00.000Z",
	unblockDescriptor: {
		owner: "board",
		action: "NEEDS RICO on rodaddy/x#12: https://forge.example.internal/rodaddy/x/pulls/12 then go",
	},
	...over,
});

describe("blockedItems", () => {
	test("blocked with owner board gives one item linking the URL in the action", () => {
		const items = blockedItems([blocked()]);
		expect(items).toHaveLength(1);
		expect(items[0]?.kind).toBe("blocked");
		expect(items[0]?.key).toBe("blocked:i1:2026-10-03T10:00:00.000Z");
		expect(items[0]?.link).toBe("https://forge.example.internal/rodaddy/x/pulls/12");
		expect(items[0]?.line.startsWith("RIC-10: NEEDS RICO on rodaddy/x#12")).toBe(true);
	});

	test("an object owner gives none", () => {
		expect(
			blockedItems([
				blocked({
					unblockDescriptor: { owner: { agentId: "a1" }, action: "wait" },
				}),
			]),
		).toEqual([]);
	});

	test("status todo with owner board gives none", () => {
		expect(blockedItems([blocked({ status: "todo" })])).toEqual([]);
	});

	test("a re-block changes the key", () => {
		const first = blockedItems([blocked()])[0]?.key;
		const second = blockedItems([blocked({ blockedTransitionAt: "2026-10-03T11:00:00.000Z" })])[0]
			?.key;
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(second).not.toBe(first);
	});

	test("an empty action falls back to the title, with no link and no date", () => {
		const items = blockedItems([
			blocked({
				blockedTransitionAt: null,
				unblockDescriptor: { owner: "board", action: "" },
			}),
		]);
		expect(items[0]?.line).toBe("RIC-10: Merge the thing");
		expect(items[0]?.link).toBeNull();
		expect(items[0]?.key).toBe("blocked:i1:");
	});

	test("the line is cut to 200 chars", () => {
		const items = blockedItems([
			blocked({
				unblockDescriptor: { owner: "board", action: "x".repeat(900) },
			}),
		]);
		expect(items[0]?.line).toHaveLength(200);
	});
});

describe("approvalItems", () => {
	const approval = (over: Record<string, unknown> = {}) => ({
		id: "ap1",
		type: "request_board_approval",
		status: "pending",
		payload: { title: "Go on rodaddy/x#12 at abc1234" },
		...over,
	});

	test("a pending go request links to the pull", () => {
		const items = approvalItems([approval()]);
		expect(items).toHaveLength(1);
		expect(items[0]?.kind).toBe("approval");
		expect(items[0]?.key).toBe("approval:ap1");
		expect(items[0]?.line).toBe("Approval waiting: Go on rodaddy/x#12 at abc1234");
		expect(items[0]?.link).toBe("https://forge.example.internal/rodaddy/x/pulls/12");
	});

	test("an approved approval gives none", () => {
		expect(approvalItems([approval({ status: "approved" })])).toEqual([]);
	});

	test("another approval type gives none", () => {
		expect(approvalItems([approval({ type: "hire_agent" })])).toEqual([]);
	});

	test("a title that is not a go request has no link; no title uses the id", () => {
		expect(approvalItems([approval({ payload: { title: "Buy a server" } })])[0]?.link).toBeNull();
		expect(approvalItems([approval({ payload: null })])[0]?.line).toBe("Approval waiting: ap1");
	});
});

describe("badAgents", () => {
	const agent = (over: Record<string, unknown> = {}) => ({
		id: "a1",
		name: "Nagatha",
		status: "idle",
		errorReason: null,
		...over,
	});
	const run = (status: string, msAgo: number, errorCode: string | null) => ({
		agentId: "a1",
		status,
		errorCode,
		createdAt: ago(msAgo),
		finishedAt: ago(msAgo - MIN),
	});

	test("three failed runs give one item naming the error code", () => {
		const out = badAgents(
			[agent()],
			[
				run("failed", 30 * MIN, "older"),
				run("failed", 10 * MIN, "adapter_failed"),
				run("timed_out", 20 * MIN, null),
			],
			{},
			NOW,
		);
		expect(out.items).toHaveLength(1);
		expect(out.items[0]?.kind).toBe("agent");
		expect(out.items[0]?.key).toBe("agent:a1");
		expect(out.items[0]?.link).toBeNull();
		expect(out.items[0]?.line).toBe("Nagatha is failing: last 3 runs failed (adapter_failed)");
		expect(out.errorPasses).toEqual({});
	});

	test("failed, failed, succeeded (newest) gives none", () => {
		const out = badAgents(
			[agent()],
			[
				run("failed", 30 * MIN, "adapter_failed"),
				run("failed", 20 * MIN, "adapter_failed"),
				run("succeeded", 10 * MIN, null),
			],
			{},
			NOW,
		);
		expect(out.items).toEqual([]);
	});

	test("cancelled runs are skipped when picking the 3", () => {
		const out = badAgents(
			[agent()],
			[
				run("cancelled", 5 * MIN, null),
				run("failed", 10 * MIN, "adapter_failed"),
				run("running", 1 * MIN, null),
				run("failed", 20 * MIN, "adapter_failed"),
				run("failed", 30 * MIN, "adapter_failed"),
			],
			{},
			NOW,
		);
		expect(out.items).toHaveLength(1);
	});

	test("only two failed runs give none", () => {
		const out = badAgents(
			[agent()],
			[run("failed", 10 * MIN, "x"), run("failed", 20 * MIN, "x")],
			{},
			NOW,
		);
		expect(out.items).toEqual([]);
	});

	test("three failures 7 h old give none", () => {
		const out = badAgents(
			[agent()],
			[
				run("failed", 7 * HOUR, "adapter_failed"),
				run("failed", 8 * HOUR, "adapter_failed"),
				run("failed", 9 * HOUR, "adapter_failed"),
			],
			{},
			NOW,
		);
		expect(out.items).toEqual([]);
	});

	test("another agent's failures are not counted", () => {
		const out = badAgents(
			[agent({ id: "a2", name: "Scout" })],
			[run("failed", 10 * MIN, "x"), run("failed", 20 * MIN, "x"), run("failed", 30 * MIN, "x")],
			{},
			NOW,
		);
		expect(out.items).toEqual([]);
	});

	test("status error gives none on passes 1 and 2 and one item on pass 3", () => {
		const agents = [agent({ status: "error", errorReason: "adapter gone" })];
		const p1 = badAgents(agents, [], {}, NOW);
		expect(p1.items).toEqual([]);
		expect(p1.errorPasses).toEqual({ a1: 1 });
		const p2 = badAgents(agents, [], p1.errorPasses, NOW);
		expect(p2.items).toEqual([]);
		const p3 = badAgents(agents, [], p2.errorPasses, NOW);
		expect(p3.items).toHaveLength(1);
		expect(p3.items[0]?.key).toBe("agent:a1");
		expect(p3.items[0]?.line).toBe("Nagatha is in error: adapter gone");
		expect(p3.errorPasses).toEqual({ a1: 3 });
	});

	test("an agent no longer in error leaves errorPasses; no reason is said so", () => {
		expect(badAgents([agent()], [], { a1: 2 }, NOW).errorPasses).toEqual({});
		const out = badAgents([agent({ status: "error" })], [], { a1: 2 }, NOW);
		expect(out.items[0]?.line).toBe("Nagatha is in error: no reason given");
	});
});

describe("tellItems", () => {
	const issue = { id: "i9", identifier: "RIC-9" };
	const comment = (over: Record<string, unknown> = {}) => ({
		id: "c1",
		authorAgentId: "a1",
		createdAt: ago(HOUR),
		body: "TELL RICO: council decided X\nsee https://forge.example.internal/rodaddy/x/issues/3",
		...over,
	});

	test("the marker is TELL RICO:", () => {
		expect(TELL_MARKER).toBe("TELL RICO:");
	});

	test("an agent comment starting with the marker gives one item", () => {
		const items = tellItems(issue, [comment()], NOW);
		expect(items).toHaveLength(1);
		expect(items[0]?.kind).toBe("tell");
		expect(items[0]?.key).toBe("tell:c1");
		expect(items[0]?.line).toBe("RIC-9: council decided X");
		expect(items[0]?.link).toBe("https://forge.example.internal/rodaddy/x/issues/3");
	});

	test("the same body with no agent author gives none", () => {
		expect(tellItems(issue, [comment({ authorAgentId: null })], NOW)).toEqual([]);
	});

	test("one 25 h old gives none", () => {
		expect(tellItems(issue, [comment({ createdAt: ago(25 * HOUR) })], NOW)).toEqual([]);
	});

	test("the marker on line 2 gives none", () => {
		expect(
			tellItems(issue, [comment({ body: "Status update\nTELL RICO: council decided X" })], NOW),
		).toEqual([]);
	});

	test("a body with no URL has a null link", () => {
		expect(tellItems(issue, [comment({ body: "TELL RICO: done" })], NOW)[0]?.link).toBeNull();
	});
});

describe("issuesToScan", () => {
	const run = (issueId: string, finishedAt: string | null) => ({
		agentId: "a1",
		status: finishedAt ? "succeeded" : "running",
		createdAt: ago(HOUR),
		finishedAt,
		contextSnapshot: { issueId },
	});

	test("returns the issue of an unfinished run, not of one finished 20 minutes ago", () => {
		expect(
			issuesToScan(
				[
					run("live", null),
					run("old", ago(20 * MIN)),
					run("recent", ago(5 * MIN)),
					run("live", null),
				],
				NOW,
			),
		).toEqual(["live", "recent"]);
	});

	test("returns at most 30 and skips runs without an issue", () => {
		const runs = Array.from({ length: 40 }, (_, i) => run(`i${i}`, null));
		expect(issuesToScan(runs, NOW)).toHaveLength(30);
		expect(
			issuesToScan([{ status: "running", finishedAt: null, contextSnapshot: null }], NOW),
		).toEqual([]);
	});
});
