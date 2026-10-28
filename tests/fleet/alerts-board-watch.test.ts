import { describe, expect, test } from "bun:test";
import type * as Watch from "../../fleet/plugins/alerts/board-watch.js";

// BOARD_WATCH_UNDER_TEST points the suite at a mutated copy (RED proof).
const target = process.env.BOARD_WATCH_UNDER_TEST ?? "../../fleet/plugins/alerts/board-watch.js";
const { RESUME_CAP, runResumeSweep } = (await import(target)) as typeof Watch;

const NOW = Date.parse("2026-10-07T12:00:00Z");
const HOUR = 3600 * 1000;
const CFG = { boardWatch: { bishopAgentId: "bishop" } };
// The server's literal notices, typed out here and never built from a plugin
// constant, so a drift in the plugin's phrase turns this suite red.
const NOTICE =
	"Paperclip cannot safely continue automatic recovery because the original assignee is not invokable. The source assignment is unchanged and the board must choose the next action.";
const FAILED_RETRY =
	"Paperclip automatically retried dispatch for this assigned `todo` issue during terminal run recovery, but it still has no live execution path. Moving it to `blocked` so it is visible for intervention.";

interface Row {
	id: string;
	identifier: string;
	title: string;
	status: string;
	assigneeAgentId: string;
	comments: { authorType: string; body: string; createdAt: string }[];
	blockedBy: { status: string }[];
}

function fakeCtx(rows: Row[], agents: { id: string; name: string; status: string }[], cfg = CFG) {
	const updates: [string, unknown][] = [];
	const comments: [string, string][] = [];
	const ctx: Watch.SweepCtx = {
		companies: { list: async () => [{ id: "co-1" }] },
		config: { get: async () => cfg },
		logger: { info: () => {} },
		agents: { list: async () => agents },
		issues: {
			// Paperclip 2026.916.1 applies a requested window twice.
			list: async (q) => {
				let matches = rows.filter((r) => r.status === q.status);
				if (q.limit !== undefined) {
					for (let i = 0; i < 2; i++)
						matches = matches.slice(q.offset ?? 0, (q.offset ?? 0) + q.limit);
				}
				return matches.map((r) => ({ ...r }));
			},
			listComments: async (id) => rows.find((r) => r.id === id)?.comments ?? [],
			relations: {
				get: async (id) => ({ blockedBy: rows.find((r) => r.id === id)?.blockedBy ?? [] }),
			},
			update: async (id, patch) => {
				updates.push([id, patch]);
				const r = rows.find((x) => x.id === id);
				if (r) Object.assign(r, patch);
			},
			createComment: async (id, body) => {
				comments.push([id, body]);
				rows
					.find((r) => r.id === id)
					?.comments.push({ authorType: "agent", body, createdAt: new Date(NOW).toISOString() });
			},
		},
	};
	return { ctx, updates, comments };
}

const stranded = (n: number, over: Partial<Row> = {}, ageMs = 36 * HOUR): Row => ({
	id: `i${n}`,
	identifier: `SOF-${n}`,
	title: `Triage task ${n}`,
	status: "blocked",
	assigneeAgentId: "adams",
	comments: [
		{ authorType: "agent", body: "working", createdAt: new Date(NOW - ageMs - HOUR).toISOString() },
		{ authorType: "system", body: NOTICE, createdAt: new Date(NOW - ageMs).toISOString() },
	],
	blockedBy: [],
	...over,
});
const ADAMS = { id: "adams", name: "Adams", status: "idle" };
const now = () => NOW;

describe("runResumeSweep", () => {
	test("reopens a paused-stranded issue once its seat runs again, with one comment", async () => {
		const rows = [stranded(1)];
		const { ctx, updates, comments } = fakeCtx(rows, [ADAMS]);
		await runResumeSweep(ctx, now);
		expect(updates).toEqual([["i1", { status: "todo" }]]);
		expect(comments).toEqual([
			[
				"i1",
				"Reopened by the resume sweep: this task was blocked because Adams was paused, not because it failed (sf#1730).",
			],
		]);
		for (const r of rows) r.status = "blocked";
		await runResumeSweep(ctx, now);
		expect(comments.length).toBe(1);
	});

	test("skips a seat that is still paused", async () => {
		const { ctx, updates } = fakeCtx([stranded(1)], [{ ...ADAMS, status: "paused" }]);
		await runResumeSweep(ctx, now);
		expect(updates).toEqual([]);
	});

	test("skips an issue blocked over 7 days ago, one with an open blocker, a Review/Merge task, a non-stranded block", async () => {
		const { ctx, updates } = fakeCtx(
			[
				stranded(1, {}, 8 * 24 * HOUR),
				stranded(2, { blockedBy: [{ status: "todo" }] }),
				stranded(3, { title: "Review PR 12" }),
				stranded(4, { title: "Merge PR 12" }),
				stranded(5, {
					comments: [
						{
							authorType: "system",
							body: "Blocked by a human.",
							createdAt: new Date(NOW).toISOString(),
						},
					],
				}),
				stranded(6, { blockedBy: [{ status: "done" }] }),
			],
			[ADAMS],
		);
		await runResumeSweep(ctx, now);
		expect(updates).toEqual([["i6", { status: "todo" }]]);
	});

	test("a failed-retry notice (no live execution path) is never reopened", async () => {
		const rows = [stranded(1), stranded(2)];
		(rows[1] as Row).comments[1] = {
			authorType: "system",
			body: FAILED_RETRY,
			createdAt: new Date(NOW - 36 * HOUR).toISOString(),
		};
		const { ctx, updates } = fakeCtx(rows, [ADAMS]);
		await runResumeSweep(ctx, now);
		expect(updates).toEqual([["i1", { status: "todo" }]]);
	});

	test("reads 150 blocked tasks without a window and reopens the eligible task at index 149", async () => {
		const rows = Array.from({ length: 150 }, (_, i) => stranded(i + 1, { comments: [] }));
		rows[149] = stranded(150);
		const { ctx, updates } = fakeCtx(rows, [ADAMS]);
		await runResumeSweep(ctx, now);
		expect(updates).toEqual([["i150", { status: "todo" }]]);
	});

	test("does not reopen a stranded task after a human comments keep this blocked", async () => {
		const row = stranded(1);
		row.comments.push({
			authorType: "user",
			body: "keep this blocked",
			createdAt: new Date(NOW - HOUR).toISOString(),
		});
		const { ctx, updates, comments } = fakeCtx([row], [ADAMS]);
		await runResumeSweep(ctx, now);
		expect(updates).toEqual([]);
		expect(comments).toEqual([]);
	});

	test("at most 10 a tick, and off without boardWatch config", async () => {
		const rows = Array.from({ length: 13 }, (_, i) => stranded(i + 1));
		const off = fakeCtx(rows, [ADAMS], {} as typeof CFG);
		await runResumeSweep(off.ctx, now);
		expect(off.updates).toEqual([]);
		const { ctx, updates } = fakeCtx(rows, [ADAMS]);
		expect(RESUME_CAP).toBe(10);
		await runResumeSweep(ctx, now);
		expect(updates.length).toBe(10);
		await runResumeSweep(ctx, now);
		expect(updates.length).toBe(13);
	});
});
