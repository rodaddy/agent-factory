/**
 * @module tests/fleet/pause-preview
 * @description `fleet/bin/pause-preview`: what pausing a seat
 *   would strand, read-only, against a fake board.
 *   `PAUSE_PREVIEW_UNDER_TEST` points the suite at a mutated copy.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { resolve } from "node:path";
import { startFakeSeatBoard } from "../support/fake-seat-board";

const SCRIPT =
	process.env.PAUSE_PREVIEW_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/pause-preview");
let fake: Awaited<ReturnType<typeof startFakeSeatBoard>>;

const issue = (id: string, status: string, agent = "a-1") => ({
	id,
	identifier: `SOF-${id}`,
	title: `Task ${id}`,
	status,
	assigneeAgentId: agent,
});
const run = (id: string, status: string, issueId: string, agentId = "a-1") => ({
	id,
	agentId,
	status,
	contextSnapshot: { issueId },
});

beforeAll(async () => {
	fake = await startFakeSeatBoard(7195, 7199);
});
afterAll(() => fake.stop());

test("it lists todo-with-queued-run, in_progress and running, and counts the todo", async () => {
	fake.state.agents = [
		{ id: "a-0", name: "Other" },
		{ id: "a-1", name: "Bishop" },
	];
	fake.state.issues = [
		issue("1", "todo"),
		issue("2", "todo"),
		issue("3", "todo"),
		issue("4", "in_progress"),
		issue("5", "todo", "a-0"),
	];
	fake.state.runs = [
		run("q1", "queued", "1"),
		run("q1b", "queued", "1"),
		run("q3", "queued", "3"),
		run("s2", "succeeded", "2"),
		run("x4", "running", "4"),
		run("q5", "queued", "5", "a-0"),
	];
	const r = await fake.run(SCRIPT, ["Bishop"]);
	expect(r.code).toBe(0);
	expect(r.stdout.trim().split("\n")).toEqual([
		"todo SOF-1 Task 1 queued=q1,q1b",
		"todo SOF-3 Task 3 queued=q3",
		"in_progress SOF-4 Task 4",
		"running x4 issue=4",
		"pausing Bishop strands 2 todo tasks",
	]);
	expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
});

test("a todo with only a scheduled_retry run is at risk and counted", async () => {
	fake.calls.length = 0;
	fake.state.agents = [{ id: "a-1", name: "Bishop" }];
	fake.state.issues = [issue("7", "todo")];
	fake.state.runs = [run("r7", "scheduled_retry", "7")];
	const r = await fake.run(SCRIPT, ["Bishop"]);
	expect(r.code).toBe(0);
	expect(r.stdout.trim().split("\n")).toEqual([
		"todo SOF-7 Task 7 retry=r7",
		"pausing Bishop strands 1 todo tasks",
	]);
	expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
});

test("a todo with queued and scheduled_retry runs is counted once, beside running and in_progress", async () => {
	fake.calls.length = 0;
	fake.state.agents = [{ id: "a-1", name: "Bishop" }];
	fake.state.issues = [issue("8", "todo"), issue("9", "in_progress")];
	fake.state.runs = [
		run("q8", "queued", "8"),
		run("r8", "scheduled_retry", "8"),
		run("x9", "running", "9"),
	];
	const r = await fake.run(SCRIPT, ["Bishop"]);
	expect(r.code).toBe(0);
	expect(r.stdout.trim().split("\n")).toEqual([
		"todo SOF-8 Task 8 queued=q8 retry=r8",
		"in_progress SOF-9 Task 9",
		"running x9 issue=9",
		"pausing Bishop strands 1 todo tasks",
	]);
	expect(fake.calls.every((c) => c.method === "GET")).toBe(true);
});

test("no seat name is usage, exit 3, no request", async () => {
	fake.calls.length = 0;
	const r = await fake.run(SCRIPT, []);
	expect(r.code).toBe(3);
	expect(r.stderr).toContain("usage: pause-preview <seat>");
	expect(fake.calls).toEqual([]);
});
