import { describe, expect, test } from "bun:test";
import type * as Sweep from "../../fleet/plugins/alerts/backlog-sweep.js";

// BACKLOG_SWEEP_UNDER_TEST points the suite at a mutated copy (RED proof).
const target =
	process.env.BACKLOG_SWEEP_UNDER_TEST ?? "../../fleet/plugins/alerts/backlog-sweep.js";
const { BACKLOG_ORIGIN, MOVE_CAP, runBacklogSweep } = (await import(target)) as typeof Sweep;

const NOW = Date.parse("2026-10-07T12:00:00Z");
const HOUR = 3600 * 1000;
const CFG = { backlogSweep: { triageAgentId: "simms" } };

interface Row {
	id: string;
	identifier: string;
	title: string;
	status: string;
	assigneeAgentId: string | null;
	updatedAt: string;
	labels: { name: string }[];
	originKind?: string;
	originId?: string;
}

function fakeCtx(
	rows: Row[],
	agents: { id: string; name: string; status: string }[],
	cfg: unknown = CFG,
	fail: { update?: string[]; comment?: string[]; create?: boolean } = {},
) {
	const updates: [string, unknown][] = [];
	const comments: [string, string][] = [];
	const created: Record<string, unknown>[] = [];
	const warns: [string, unknown][] = [];
	// The installed host windows twice: limit/offset in SQL, then applyWindow
	// slices the SQL result by the same offset and limit (capped at 100).
	const win = <T>(xs: T[], off: number, limit: number | undefined) =>
		xs.slice(off, limit === undefined ? undefined : off + limit);
	const ctx: Sweep.BacklogCtx = {
		companies: { list: async () => [{ id: "co-1" }] },
		config: { get: async () => cfg as Record<string, unknown> },
		logger: { info: () => {}, warn: (m, d) => warns.push([m, d]) },
		agents: { list: async () => agents },
		issues: {
			list: async (q) => {
				const hit = rows.filter(
					(r) =>
						(!q.status || r.status === q.status) &&
						(!q.originKind || r.originKind === q.originKind) &&
						(!q.originId || r.originId === q.originId),
				);
				const off = q.offset ?? 0;
				const sql = win(hit, off, q.limit);
				const capped = q.limit === undefined ? undefined : Math.min(q.limit, 100);
				return win(sql, off, capped).map((r) => ({ ...r }));
			},
			update: async (id, patch) => {
				if (fail.update?.includes(id)) throw new Error(`update ${id} refused`);
				updates.push([id, patch]);
				const r = rows.find((x) => x.id === id);
				if (r) Object.assign(r, patch);
			},
			createComment: async (id, body) => {
				if (fail.comment?.includes(id)) throw new Error(`comment ${id} refused`);
				comments.push([id, body]);
			},
			create: async (task) => {
				if (fail.create) throw new Error("create refused");
				created.push(task);
				rows.push({ ...(task as unknown as Row), id: `new${created.length}`, labels: [] });
			},
		},
	};
	return { ctx, updates, comments, created, warns };
}

const row = (n: number, labels: string[] = [], idleH = 1, over: Partial<Row> = {}): Row => ({
	id: `i${n}`,
	identifier: `SOF-${n}`,
	title: `Triage task ${n}`,
	status: "backlog",
	assigneeAgentId: "adams",
	updatedAt: new Date(NOW - idleH * HOUR).toISOString(),
	labels: labels.map((name) => ({ name })),
	...over,
});
const ADAMS = { id: "adams", name: "Adams", status: "idle" };
const now = () => NOW;
const moved = (u: [string, unknown][]) => u.map(([id]) => id).sort();

describe("runBacklogSweep", () => {
	test("a priority-labelled backlog task moves at once, with one comment", async () => {
		const { ctx, updates, comments } = fakeCtx([row(1, ["priority", "tier-5"])], [ADAMS]);
		await runBacklogSweep(ctx, now);
		expect(updates).toEqual([["i1", { status: "todo" }]]);
		expect(comments).toEqual([
			["i1", "Moved out of backlog by the backlog sweep: it carries the priority label (sf#1730)."],
		]);
	});

	test("tier-1 and tier-2 move at once; a fresh tier-3 task stays", async () => {
		const rows = [row(1, ["tier-1"]), row(2, ["tier-2"]), row(3, ["tier-3"]), row(4, ["tier-4"])];
		const { ctx, updates, comments } = fakeCtx(rows, [ADAMS]);
		await runBacklogSweep(ctx, now);
		expect(moved(updates)).toEqual(["i1", "i2"]);
		expect(comments.find(([id]) => id === "i2")?.[1]).toBe(
			"Moved out of backlog by the backlog sweep: its repo is tier-2 (sf#1730).",
		);
	});

	test("tier-0 (infra) moves at once, whatever its idle time", async () => {
		const { ctx, updates, comments } = fakeCtx([row(1, ["tier-0"], 0)], [ADAMS]);
		await runBacklogSweep(ctx, now);
		expect(moved(updates)).toEqual(["i1"]);
		expect(comments).toEqual([
			["i1", "Moved out of backlog by the backlog sweep: its repo is tier-0 (sf#1730)."],
		]);
	});

	test("tier-3 and untagged move only once idle 24 h or more", async () => {
		const rows = [
			row(1, ["tier-3"], 23),
			row(2, [], 23.9),
			row(3, ["tier-3"], 24),
			row(4, [], 30),
			row(5, ["tier-5"], 48),
		];
		const { ctx, updates, comments } = fakeCtx(rows, [ADAMS]);
		await runBacklogSweep(ctx, now);
		expect(moved(updates)).toEqual(["i3", "i4", "i5"]);
		expect(comments.find(([id]) => id === "i4")?.[1]).toBe(
			"Moved out of backlog by the backlog sweep: it sat in backlog 30 h (sf#1730).",
		);
	});

	test("a task whose seat cannot run is not moved", async () => {
		const seats = ["paused", "error", "terminated", "archived"].map((status, i) => ({
			id: `s${i}`,
			name: `S${i}`,
			status,
		}));
		const rows = seats.map((s, i) => row(i, ["priority", "tier-1"], 48, { assigneeAgentId: s.id }));
		rows.push(row(9, ["tier-1"], 1, { assigneeAgentId: "gone" }));
		const { ctx, updates, comments } = fakeCtx(rows, seats);
		await runBacklogSweep(ctx, now);
		expect(updates).toEqual([]);
		expect(comments).toEqual([]);
	});

	test("unassigned is never moved and lands in one digest a UTC day", async () => {
		const rows = [
			row(1, ["priority"], 5, { assigneeAgentId: null, title: "Orphan one" }),
			row(2, [], 92, { assigneeAgentId: null, title: "Orphan two" }),
		];
		const { ctx, updates, created } = fakeCtx(rows, [ADAMS]);
		await runBacklogSweep(ctx, now);
		await runBacklogSweep(ctx, () => NOW + 6 * HOUR);
		expect(updates).toEqual([]);
		expect(created.length).toBe(1);
		const d = created[0] as Record<string, string>;
		expect(d).toMatchObject({
			companyId: "co-1",
			assigneeAgentId: "simms",
			status: "todo",
			originKind: BACKLOG_ORIGIN,
			originId: "2026-10-07",
		});
		expect(d.description).toContain("SOF-1 Orphan one, idle 5 h");
		expect(d.description).toContain("SOF-2 Orphan two, idle 92 h");
		await runBacklogSweep(ctx, () => NOW + 13 * HOUR);
		expect(created.length).toBe(2);
		expect((created[1] as Record<string, string>).originId).toBe("2026-10-08");
	});

	test("no unassigned backlog files no digest", async () => {
		const { ctx, created } = fakeCtx([row(1, ["tier-1"])], [ADAMS]);
		await runBacklogSweep(ctx, now);
		expect(created).toEqual([]);
	});

	test(`caps at ${20} moves a run, priority then tier then oldest first`, async () => {
		const rows = Array.from({ length: 30 }, (_, i) => row(i, ["tier-2"], 1 + i));
		rows.push(row(99, ["priority", "tier-4"]));
		const { ctx, updates } = fakeCtx(rows, [ADAMS]);
		await runBacklogSweep(ctx, now);
		expect(MOVE_CAP).toBe(20);
		expect(updates.length).toBe(20);
		expect(updates[0]?.[0]).toBe("i99");
		expect(updates[1]?.[0]).toBe("i29");
	});

	test("several tier labels: the lowest tier wins, whatever the label order", async () => {
		const rows = [row(1, ["tier-4", "tier-1"]), row(2, ["tier-5", "tier-3"])];
		const { ctx, updates, comments } = fakeCtx(rows, [ADAMS]);
		await runBacklogSweep(ctx, now);
		expect(moved(updates)).toEqual(["i1"]);
		expect(comments).toEqual([
			["i1", "Moved out of backlog by the backlog sweep: its repo is tier-1 (sf#1730)."],
		]);
	});

	test("a failed move is logged and skipped, and does not count against the cap", async () => {
		const rows = Array.from({ length: 25 }, (_, i) => row(i, ["tier-1"], 1 + i));
		const { ctx, updates, warns } = fakeCtx(rows, [ADAMS], CFG, { update: ["i24", "i23"] });
		await runBacklogSweep(ctx, now);
		expect(updates.length).toBe(MOVE_CAP);
		expect(moved(updates)).not.toContain("i24");
		expect(warns.map(([, d]) => (d as { issue: string }).issue)).toEqual(["SOF-24", "SOF-23"]);
	});

	test("a failed comment or digest does not stop the sweep", async () => {
		const rows = [
			row(1, ["tier-1"], 3),
			row(2, ["tier-1"], 2),
			row(3, [], 5, { assigneeAgentId: null }),
		];
		const { ctx, updates, comments, warns } = fakeCtx(rows, [ADAMS], CFG, {
			comment: ["i1"],
			create: true,
		});
		await runBacklogSweep(ctx, now);
		expect(moved(updates)).toEqual(["i1", "i2"]);
		expect(comments.map(([id]) => id)).toEqual(["i2"]);
		expect(warns.length).toBe(2);
	});

	test("sweeps rows past the first 100 (the host windows a page twice)", async () => {
		const rows = Array.from({ length: 110 }, (_, i) => row(i, ["tier-4"], 1));
		rows.push(row(500, ["tier-1"]));
		const { ctx, updates } = fakeCtx(rows, [ADAMS]);
		await runBacklogSweep(ctx, now);
		expect(moved(updates)).toEqual(["i500"]);
	});

	test("off without backlogSweep.triageAgentId", async () => {
		for (const cfg of [{}, null, { backlogSweep: {} }]) {
			const { ctx, updates, created } = fakeCtx(
				[row(1, ["priority"]), row(2, [], 48, { assigneeAgentId: null })],
				[ADAMS],
				cfg,
			);
			await runBacklogSweep(ctx, now);
			expect(updates).toEqual([]);
			expect(created).toEqual([]);
		}
	});
});
