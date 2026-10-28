/**
 * @module tests/fleet/bulk-cancel
 * @description `fleet/bin/bulk-cancel`: park a seat's `todo`
 *   issues in `backlog`, then cancel their queued runs, so recovery has nothing
 *   to re-queue. Run as a child process against a fake board and Forge.
 *   `BULK_CANCEL_UNDER_TEST` points the suite at a mutated copy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { startFakeSeatBoard } from "../support/fake-seat-board";
import { testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.BULK_CANCEL_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/bulk-cancel");
let fake: Awaited<ReturnType<typeof startFakeSeatBoard>>;
let dir = "";

const issue = (id: string, title: string, hoursOld = 1) => ({
	id,
	identifier: `SOF-${id}`,
	title,
	status: "todo",
	assigneeAgentId: "a-1",
	createdAt: new Date(Date.now() - hoursOld * 3_600_000).toISOString(),
});
const queued = (id: string, issueId: string) => ({
	id,
	agentId: "a-1",
	status: "queued",
	contextSnapshot: { issueId },
});
const writes = () => fake.calls.filter((c) => c.method !== "GET");

beforeAll(async () => {
	fake = await startFakeSeatBoard(7190, 7194);
	dir = mkdtempSync(join(testTmpBase(), "bulk-cancel-"));
});
afterAll(() => {
	fake.stop();
	rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
	fake.calls.length = 0;
	fake.state.watch = undefined;
	fake.state.agents = [
		{ id: "a-0", name: "Other" },
		{ id: "a-1", name: "Nagatha" },
	];
	fake.state.issues = [
		issue("1", "Fix the thing"),
		issue("2", "Review o/r#5 @ abc1234"),
		issue("3", "Merge o/r#6 @ def5678"),
		issue("4", "Review o/r#7 @ 0123456"),
	];
	fake.state.runs = [
		queued("r1", "1"),
		queued("r2", "2"),
		queued("r3", "3"),
		queued("r4", "4"),
		{ ...queued("r9", "1"), status: "succeeded" },
	];
	fake.state.prs = { "o/r#5": "open", "o/r#6": "open", "o/r#7": "closed" };
});

describe("bulk-cancel", () => {
	test("a dry run lists what it would do and writes nothing", async () => {
		const r = await fake.run(SCRIPT, ["--seat", "Nagatha"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("park SOF-1 Fix the thing queued=r1");
		expect(r.stdout).toContain("park SOF-4 Review o/r#7 @ 0123456 queued=r4");
		expect(r.stdout).toContain("refuse SOF-2 Review o/r#5 @ abc1234 (PR open)");
		expect(r.stdout).toContain("refuse SOF-3 Merge o/r#6 @ def5678 (PR open)");
		expect(r.stdout).toContain("bulk-cancel: 2 issues, 2 runs, 2 refused (dry run)");
		expect(writes()).toEqual([]);
		expect(
			fake.calls.every((c) => c.authorization === "Bearer k-1" || c.authorization === "token t-1"),
		).toBe(true);
	});

	test("--apply writes the rollback file first, parks each issue, then cancels its runs", async () => {
		const file = join(dir, "rb-1.json");
		fake.state.watch = file;
		const r = await fake.run(SCRIPT, ["--seat", "Nagatha", "--apply", "--rollback-file", file]);
		expect(r.code).toBe(0);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual([
			{ id: "1", status: "todo", assigneeAgentId: "a-1" },
			{ id: "4", status: "todo", assigneeAgentId: "a-1" },
		]);
		expect(writes().map((c) => `${c.method} ${c.path}`)).toEqual([
			"PATCH /api/issues/1",
			"POST /api/heartbeat-runs/r1/cancel",
			"PATCH /api/issues/4",
			"POST /api/heartbeat-runs/r4/cancel",
		]);
		expect(writes()[0]?.body).toEqual({ status: "backlog" });
		// The file was on disk before the first write reached the board.
		expect(writes().every((c) => c.watched)).toBe(true);
		expect(r.stdout).toContain("bulk-cancel: 2 issues, 2 runs, 2 refused (applied)");
	});

	test("--include-open-pr-tasks takes the open-PR tasks too, with a warning", async () => {
		const r = await fake.run(SCRIPT, ["--seat", "Nagatha", "--include-open-pr-tasks"]);
		expect(r.code).toBe(0);
		expect(r.stderr).toContain("warning");
		expect(r.stdout).toContain("park SOF-2 Review o/r#5 @ abc1234 queued=r2");
		expect(r.stdout).toContain("bulk-cancel: 4 issues, 4 runs, 0 refused (dry run)");
	});

	test("--title-prefix and --older-than narrow the set", async () => {
		fake.state.issues.push(issue("5", "Fix old", 48));
		fake.state.runs.push(queued("r5", "5"));
		const r = await fake.run(SCRIPT, [
			"--seat",
			"Nagatha",
			"--title-prefix",
			"Fix",
			"--older-than",
			"24",
		]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("park SOF-5 Fix old queued=r5");
		expect(r.stdout).toContain("bulk-cancel: 1 issues, 1 runs, 0 refused (dry run)");
	});

	test("--apply without --rollback-file is usage, exit 3, no request", async () => {
		const r = await fake.run(SCRIPT, ["--seat", "Nagatha", "--apply"]);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain("usage: bulk-cancel");
		expect(fake.calls).toEqual([]);
	});

	test("an existing rollback file is never overwritten and nothing is written", async () => {
		const file = join(dir, "rb-2.json");
		await Bun.write(file, "keep");
		const r = await fake.run(SCRIPT, ["--seat", "Nagatha", "--apply", "--rollback-file", file]);
		expect(r.code).toBe(1);
		expect(readFileSync(file, "utf8")).toBe("keep");
		expect(writes()).toEqual([]);
	});

	test("an unknown seat is exit 1 and writes nothing", async () => {
		const file = join(dir, "rb-3.json");
		const r = await fake.run(SCRIPT, ["--seat", "Nobody", "--apply", "--rollback-file", file]);
		expect(r.code).toBe(1);
		expect(existsSync(file)).toBe(false);
		expect(writes()).toEqual([]);
	});
});
