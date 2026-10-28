import { describe, expect, test } from "bun:test";
import type * as Logic from "../../fleet/plugins/alerts/logic.js";

// ALERTS_PLUGIN_UNDER_TEST points the suite at a mutated copy (RED proof).
const target = process.env.ALERTS_PLUGIN_UNDER_TEST ?? "../../fleet/plugins/alerts/logic.js";
const {
	alertOwner,
	alertTitle,
	handBackTo,
	opsGuardDecision,
	OPS_GUARD_CAP,
	issueDescription,
	runOpsGuard,
} = (await import(target)) as typeof Logic;

const OPS = "ops-agent";
const HOME = "nagatha";
const CFG = {
	assigneeAgentId: HOME,
	routes: [
		{ match: "^ForgeCI", assigneeAgentId: "greene" },
		{ match: "^FleetDigest", assigneeAgentId: OPS },
	],
	opsGuard: { opsAgentId: OPS, homeAgentId: HOME },
};
const ALERTS = "plugin:rodaddy.alerts";
// The title the webhook gives an alert issue; instance carries a colon on purpose.
const titleOf = (alertname: string) => alertTitle({ alertname, instance: "host:9100" });
const alertIssue = (alertname: string) => ({
	title: titleOf(alertname),
	description: issueDescription({
		key: "alert",
		title: titleOf(alertname),
		status: "firing",
		labels: { alertname, instance: "host:9100" },
		annotations: { summary: "alert" },
		startsAt: "",
		endsAt: "",
		generatorURL: "",
	}),
});

describe("alertOwner reads the original webhook labels and routes it now", () => {
	test("a digest alert belongs to Ops, a CI alert to its route, the rest to the default", () => {
		expect(alertOwner({ status: "todo", ...alertIssue("FleetDigestDaily") }, CFG)).toBe(OPS);
		expect(alertOwner({ status: "todo", ...alertIssue("ForgeCIFailing") }, CFG)).toBe("greene");
		expect(alertOwner({ status: "todo", ...alertIssue("KubePodCrashLooping") }, CFG)).toBe(HOME);
	});
	test("a title that is not an alert title has no known owner", () =>
		expect(alertOwner({ status: "todo", title: "Check the digest" }, CFG)).toBeUndefined());
});

describe("opsGuardDecision", () => {
	const open = { status: "todo", assigneeAgentId: OPS };
	test("done and cancelled are kept", () => {
		expect(opsGuardDecision({ ...open, status: "done" }, CFG)).toBe("keep");
		expect(opsGuardDecision({ ...open, status: "cancelled" }, CFG)).toBe("keep");
	});
	test("a routine execution is kept", () =>
		expect(opsGuardDecision({ ...open, originKind: "routine_execution" }, CFG)).toBe("keep"));
	test("an alert issue whose alert routes to Ops is kept", () =>
		expect(
			opsGuardDecision({ ...open, originKind: ALERTS, ...alertIssue("FleetDigestDaily") }, CFG),
		).toBe("keep"));
	test("editing the Ops route's pattern keeps an issue its alert still matches", () => {
		const edited = {
			...CFG,
			routes: [{ match: "^FleetDigestDaily$", assigneeAgentId: OPS }],
		};
		expect(
			opsGuardDecision({ ...open, originKind: ALERTS, ...alertIssue("FleetDigestDaily") }, edited),
		).toBe("keep");
	});
	test("an alert issue whose alert now routes elsewhere is handed back", () => {
		for (const name of ["ForgeCIFailing", "KubePodCrashLooping"])
			expect(opsGuardDecision({ ...open, originKind: ALERTS, ...alertIssue(name) }, CFG)).toBe(
				"hand-back",
			);
	});
	test("an alert issue with no alert title is kept, since its owner is unknown", () =>
		expect(opsGuardDecision({ ...open, originKind: ALERTS, title: "Digest" }, CFG)).toBe("keep"));
	test("a stray manual task is handed back, even with a digest alert title", () => {
		expect(opsGuardDecision({ ...open, originKind: "manual", title: "do x" }, CFG)).toBe(
			"hand-back",
		);
		expect(
			opsGuardDecision({ ...open, originKind: "manual", ...alertIssue("FleetDigestDaily") }, CFG),
		).toBe("hand-back");
	});
});

describe("handBackTo", () => {
	test("an alert issue goes to its alert's owner, so the webhook still finds it", () =>
		expect(
			handBackTo({ status: "todo", originKind: ALERTS, ...alertIssue("ForgeCIFailing") }, CFG),
		).toBe("greene"));
	test("anything else goes home", () =>
		expect(handBackTo({ status: "todo", originKind: "manual", title: "do x" }, CFG)).toBe(HOME));
});

interface Row {
	id: string;
	identifier: string;
	status: string;
	assigneeAgentId: string;
	originKind?: string;
	title?: string;
	description?: string;
}

function fakeCtx(rows: Row[], cfg: Record<string, unknown> = CFG) {
	const updates: [string, unknown, string][] = [];
	const comments: unknown[] = [];
	const logs: [string, unknown][] = [];
	const ctx: Logic.OpsGuardCtx = {
		companies: { list: async () => [{ id: "co-1" }] },
		config: { get: async () => cfg },
		logger: { info: (m, d) => void logs.push([m, d]), warn: () => {} },
		issues: {
			list: async (q) =>
				rows
					.filter((r) => r.assigneeAgentId === q.assigneeAgentId && r.status === q.status)
					.slice(q.offset, q.offset + q.limit)
					.map((r) => ({ ...r })),
			get: async (id) => rows.find((r) => r.id === id) ?? null,
			update: async (id, patch, companyId) => {
				updates.push([id, patch, companyId]);
				const r = rows.find((x) => x.id === id);
				if (r) Object.assign(r, patch);
			},
			createComment: async (...args: unknown[]) => void comments.push(args),
		},
	};
	return { ctx, updates, comments, logs };
}

const row = (n: number, over: Partial<Row> = {}): Row => ({
	id: `i${n}`,
	identifier: `SOF-${n}`,
	status: "todo",
	assigneeAgentId: OPS,
	originKind: "manual",
	title: "Triage stray",
	...over,
});

describe("runOpsGuard", () => {
	test("hands back a stray task and a rerouted alert, keeps a routine and a digest, posts no comment", async () => {
		const { ctx, updates, comments, logs } = fakeCtx([
			row(1, { status: "in_progress" }),
			row(2, { originKind: "routine_execution" }),
			row(3, { originKind: ALERTS, ...alertIssue("FleetDigestDaily") }),
			row(4, { originKind: ALERTS, ...alertIssue("ForgeCIFailing") }),
		]);
		await runOpsGuard(ctx);
		expect(updates).toEqual([
			["i4", { assigneeAgentId: "greene" }, "co-1"],
			["i1", { assigneeAgentId: HOME }, "co-1"],
		]);
		expect(comments).toEqual([]);
		expect(logs).toEqual([
			["ops-guard: handed back", { issue: "SOF-4" }],
			["ops-guard: handed back", { issue: "SOF-1" }],
		]);
	});

	test("a route on the original key keeps the alert with its webhook owner", async () => {
		const { handleDelivery } = (await import(target)) as typeof Logic;
		let task: Logic.AlertTask | undefined;
		const cfg = {
			...CFG,
			routes: [{ match: "^alert:Node:Down:node01:9100$", assigneeAgentId: OPS }],
		};
		await handleDelivery({
			headers: { "x-alerts-token": "test-secret" },
			secret: "test-secret",
			cfg,
			now: () => 0,
			body: {
				alerts: [{ status: "firing", labels: { alertname: "Node:Down", instance: "node01:9100" } }],
			},
			board: {
				listIssues: async () => [],
				listComments: async () => [],
				createIssue: async (value) => {
					task = value;
				},
				addComment: async () => {},
				updateIssue: async () => {},
			},
		});
		expect(task?.assigneeAgentId).toBe(OPS);
		expect(task?.title).toBe("Infra: alert:Node:Down:node");
		const { ctx, updates } = fakeCtx(
			[
				row(1, { ...task, originKind: ALERTS }),
				row(2, { originKind: ALERTS, title: "Infra: alert:NodeDown:proxmox" }),
			],
			cfg,
		);
		await runOpsGuard(ctx);
		expect(updates).toEqual([]);
	});

	test("a task completed between list and write is not reopened", async () => {
		const completed = row(1);
		const rows = [completed];
		const { ctx, updates } = fakeCtx(rows);
		ctx.issues.get = async () => {
			completed.status = "done";
			return completed;
		};
		await runOpsGuard(ctx);
		expect(updates).toEqual([]);
		expect(completed.status).toBe("done");
	});

	test("a blocked task handed back stays blocked", async () => {
		const blocked = row(1, { status: "blocked" });
		const rows = [blocked];
		const { ctx, updates } = fakeCtx(rows);
		await runOpsGuard(ctx);
		expect(updates).toEqual([["i1", { assigneeAgentId: HOME }, "co-1"]]);
		expect(blocked.status).toBe("blocked");
	});

	test("a manual task on page 2 is found", async () => {
		const rows = [
			...Array.from({ length: 100 }, (_, i) => row(i + 1, { originKind: "routine_execution" })),
			row(101),
		];
		const { ctx, updates } = fakeCtx(rows);
		await runOpsGuard(ctx);
		expect(updates).toEqual([["i101", { assigneeAgentId: HOME }, "co-1"]]);
	});

	test("150 issues across two offset pages are each seen once and the loop ends", async () => {
		const rows = Array.from({ length: 150 }, (_, i) => row(i, { originKind: "routine_execution" }));
		const { ctx, updates } = fakeCtx(rows);
		const visits = new Map<string, number>();
		const list = ctx.issues.list;
		ctx.issues.list = async (q) =>
			(await list(q)).map((issue) => ({
				...issue,
				get originKind() {
					const id = issue.id as string;
					visits.set(id, (visits.get(id) ?? 0) + 1);
					return "routine_execution";
				},
			}));
		await runOpsGuard(ctx);
		expect([...visits.keys()].sort()).toEqual(rows.map((r) => r.id).sort());
		expect([...visits.values()]).toEqual(Array(150).fill(1));
		expect(updates).toEqual([]);
	});

	test("a repeated page stops after one repeat and logs", async () => {
		const rows = Array.from({ length: 100 }, (_, i) => row(i, { originKind: "routine_execution" }));
		const { ctx, updates } = fakeCtx(rows);
		let reads = 0;
		const warnings: string[] = [];
		ctx.logger.warn = (m) => void warnings.push(m);
		ctx.issues.list = async (q) => {
			if (q.status !== "todo") return [];
			if (++reads > 2) throw new Error("read beyond one repeat");
			return rows;
		};
		await runOpsGuard(ctx);
		expect(reads).toBe(2);
		expect(warnings).toEqual(["alerts: repeated issue page, stopping"]);
		expect(updates).toEqual([]);
	});

	test("annotation Labels with ForgeCIFailing does not change routing", async () => {
		const description = issueDescription({
			key: "alert",
			title: "digest",
			status: "firing",
			labels: { alertname: "FleetDigestDaily" },
			annotations: {
				description: "An example:\n\nLabels:\n- alertname: ForgeCIFailing\n\nEnd example",
			},
			startsAt: "",
			endsAt: "",
			generatorURL: "",
		});
		const issue = row(1, { originKind: ALERTS, description });
		expect(alertOwner(issue, CFG)).toBe(OPS);
		const { ctx, updates } = fakeCtx([issue]);
		await runOpsGuard(ctx);
		expect(updates).toEqual([]);
	});

	test("a concurrent reassignment after update is logged without another write", async () => {
		const task = row(1);
		const { ctx, updates, logs } = fakeCtx([task]);
		const warnings: string[] = [];
		ctx.logger.warn = (m) => void warnings.push(m);
		const update = ctx.issues.update;
		ctx.issues.update = async (id, patch, companyId) => {
			await update(id, patch, companyId);
			task.assigneeAgentId = "other-actor";
		};
		await runOpsGuard(ctx);
		expect(task.assigneeAgentId).toBe("other-actor");
		expect(updates).toEqual([["i1", { assigneeAgentId: HOME }, "co-1"]]);
		expect(warnings).toEqual(["ops-guard: concurrent reassignment"]);
		expect(logs).toEqual([]);
	});

	test("with opsGuard absent it does nothing and logs that it is off", async () => {
		const { ctx, updates, comments, logs } = fakeCtx([row(1)], { assigneeAgentId: HOME });
		await runOpsGuard(ctx);
		expect(updates).toEqual([]);
		expect(comments).toEqual([]);
		expect(logs).toEqual([["ops-guard: off, no opsGuard config", { companyId: "co-1" }]]);
	});

	test("a refused update logs a warning and the tick goes on to the next issue", async () => {
		const { ctx, updates } = fakeCtx([row(1), row(2)]);
		const warns: [string, unknown][] = [];
		const update = ctx.issues.update;
		ctx.issues.update = async (id, patch, companyId) => {
			if (id === "i1") throw new Error("409 refused");
			return update(id, patch, companyId);
		};
		ctx.logger.warn = (m, d) => void warns.push([m, d]);
		await runOpsGuard(ctx);
		expect(updates).toEqual([["i2", { assigneeAgentId: HOME }, "co-1"]]);
		expect(warns).toEqual([
			["ops-guard: hand-back failed", { issue: "SOF-1", reason: "409 refused" }],
		]);
	});

	test("at most 20 hand-backs a tick", async () => {
		const rows = Array.from({ length: 25 }, (_, i) => row(i + 1));
		const { ctx, updates } = fakeCtx(rows);
		expect(OPS_GUARD_CAP).toBe(20);
		await runOpsGuard(ctx);
		expect(updates.length).toBe(20);
		await runOpsGuard(ctx);
		expect(updates.length).toBe(25);
	});
});
