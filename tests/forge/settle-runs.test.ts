import { describe, expect, test } from "bun:test";
import type { ForgeRunState } from "../../src/db/schema";
import { type DueRun, type SettleDeps, settleForgeRuns } from "../../src/forge/settle-runs";

/**
 * sf#990: dispatched forge_runs settle from the commit status their workflow
 * posts. The store and status reader are injected fakes; no database is needed.
 */
const SHA = "a".repeat(40);
const DISPATCHED = new Date("2026-09-26T10:00:00Z");

function run(workflow = "prepush.yml", id = 1): DueRun {
	return {
		id,
		repo: "rodaddy/software-factory",
		workflow,
		targetSha: "b".repeat(40),
		inputs: JSON.stringify({ repo: "rodaddy/app", head_sha: SHA }),
		dispatchedAt: DISPATCHED,
	};
}

function status(state: string, at: string, context = "factory/prepush", description = "") {
	return { id: Date.parse(at), context, status: state, created_at: at, description };
}

function fake(runs: DueRun[], statuses: unknown[] | Error) {
	const reads: string[] = [];
	const settled: Array<[number, ForgeRunState]> = [];
	const touched: number[] = [];
	const deps: SettleDeps = {
		touch: async (id) => {
			touched.push(id);
		},
		listDue: async () => runs,
		readStatuses: async (repo, sha) => {
			reads.push(`${repo}@${sha}`);
			if (statuses instanceof Error) throw statuses;
			return statuses;
		},
		settle: async (id, state) => {
			settled.push([id, state]);
			return 1;
		},
	};
	return { deps, reads, settled, touched };
}

describe("settleForgeRuns", () => {
	test("pending and unreadable rows are touched so the next pass rotates; settled rows are not", async () => {
		const pending = fake([run("prepush.yml", 7)], [status("pending", "2026-09-26T10:05:00Z")]);
		await settleForgeRuns(pending.deps);
		expect(pending.touched).toEqual([7]);
		const broken = fake([run("prepush.yml", 8)], new Error("boom"));
		await settleForgeRuns(broken.deps);
		expect(broken.touched).toEqual([8]);
		const done = fake([run("prepush.yml", 9)], [status("success", "2026-09-26T10:05:00Z")]);
		await settleForgeRuns(done.deps);
		expect(done.touched).toEqual([]);
	});

	test("a success status after dispatch settles to success, read on the input repo/sha", async () => {
		const f = fake(
			[run()],
			[status("pending", "2026-09-26T10:01:00Z"), status("success", "2026-09-26T10:05:00Z")],
		);
		const counts = await settleForgeRuns(f.deps);
		expect(f.settled).toEqual([[1, "success"]]);
		expect(f.reads).toEqual([`rodaddy/app@${SHA}`]);
		expect(counts).toEqual({ checked: 1, settled: 1, pending: 0, failed: 0 });
	});

	test("a failure status settles to failure", async () => {
		const f = fake(
			[run("pr-review.yml")],
			[status("failure", "2026-09-26T10:05:00Z", "factory/pr-review")],
		);
		await settleForgeRuns(f.deps);
		expect(f.settled).toEqual([[1, "failure"]]);
	});

	test("error settles cancelled (no verdict); a pr-review skipped warning settles success", async () => {
		const e = fake([run()], [status("error", "2026-09-26T10:05:00Z")]);
		await settleForgeRuns(e.deps);
		expect(e.settled).toEqual([[1, "cancelled"]]);
		const w = fake(
			[run("pr-review.yml")],
			[status("warning", "2026-09-26T10:05:00Z", "factory/pr-review", "pr-review skipped: draft")],
		);
		await settleForgeRuns(w.deps);
		expect(w.settled).toEqual([[1, "success"]]);
	});

	test("sf#1274: an infra-static.yml run settles from factory/infra-static", async () => {
		const f = fake(
			[run("infra-static.yml")],
			[status("success", "2026-09-26T10:05:00Z", "factory/infra-static")],
		);
		await settleForgeRuns(f.deps);
		expect(f.settled).toEqual([[1, "success"]]);
		expect(f.reads).toEqual([`rodaddy/app@${SHA}`]);
	});

	test("a status older than dispatched_at is ignored", async () => {
		const f = fake([run()], [status("success", "2026-09-26T09:59:00Z")]);
		const counts = await settleForgeRuns(f.deps);
		expect(f.settled).toEqual([]);
		expect(counts.pending).toBe(1);
	});

	test("a newest pending status leaves the row dispatched", async () => {
		const f = fake(
			[run()],
			[status("success", "2026-09-26T10:01:00Z"), status("pending", "2026-09-26T10:06:00Z")],
		);
		const counts = await settleForgeRuns(f.deps);
		expect(f.settled).toEqual([]);
		expect(counts).toEqual({ checked: 1, settled: 0, pending: 1, failed: 0 });
	});

	test("a read error is counted failed and does not throw", async () => {
		const f = fake([run(), run("pr-review.yml", 2)], new Error("forge down"));
		const counts = await settleForgeRuns(f.deps);
		expect(counts).toEqual({ checked: 2, settled: 0, pending: 0, failed: 2 });
		expect(f.settled).toEqual([]);
	});

	test("an unmapped workflow is never read", async () => {
		const f = fake(
			[run("issue-triage.yml"), run("verb.yml", 2)],
			[status("success", "2026-09-26T10:05:00Z")],
		);
		const counts = await settleForgeRuns(f.deps);
		expect(f.reads).toEqual([]);
		expect(f.settled).toEqual([]);
		expect(counts.checked).toBe(0);
	});
});

describe("settleForgeRuns reads each sha once per pass", () => {
	test("sf#1636 two runs on one sha cause one statuses read and both settle", async () => {
		const f = fake(
			[run("prepush.yml", 1), run("prepush.yml", 2)],
			[status("success", "2026-09-26T10:05:00Z")],
		);
		await settleForgeRuns(f.deps);
		expect(f.reads).toEqual([`rodaddy/app@${SHA}`]);
		expect(f.settled).toEqual([
			[1, "success"],
			[2, "success"],
		]);
	});
});
