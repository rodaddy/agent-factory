import { describe, expect, test } from "bun:test";
import type * as Logic from "../../fleet/plugins/alerts/logic.js";

// ALERTS_PLUGIN_UNDER_TEST points the suite at a mutated copy (RED proof).
const target = process.env.ALERTS_PLUGIN_UNDER_TEST ?? "../../fleet/plugins/alerts/logic.js";
const { alertKey, alertTitle, handleDelivery, handleWebhook, parseAlerts, REPEAT_QUIET_MS } =
	(await import(target)) as typeof Logic;

// Built at runtime so no credential-looking literal sits in the file.
const SECRET = ["am", "hook", String(4 * 1000 + 211)].join("-");
const AUTH = { "x-alerts-token": SECRET };
const T0 = Date.parse("2026-10-02T12:00:00Z");

interface Issue {
	id: string;
	title: string;
	status: string;
	priority?: string;
	assigneeAgentId?: string;
	description?: string;
}
interface Comment {
	issueId: string;
	body: string;
	createdAt: string;
}

function fakeBoard(seed: Issue[] = []) {
	const issues: Issue[] = [...seed];
	const comments: Comment[] = [];
	let clock = T0;
	const board: Logic.Board = {
		listIssues: async () => issues.map((i) => ({ ...i })),
		listComments: async (id) => comments.filter((c) => c.issueId === id),
		createIssue: async (task) => {
			const issue = { id: `i${issues.length + 1}`, ...task };
			issues.push(issue);
			return issue;
		},
		addComment: async (issueId, body) => {
			comments.push({ issueId, body, createdAt: new Date(clock).toISOString() });
		},
		updateIssue: async (id, patch) => {
			const i = issues.find((x) => x.id === id);
			if (i) Object.assign(i, patch);
		},
	};
	return {
		issues,
		comments,
		board,
		setNow: (ms: number) => {
			clock = ms;
		},
		now: () => clock,
	};
}

const alert = (over: Record<string, unknown> = {}, labels: Record<string, string> = {}) => ({
	status: "firing",
	labels: { alertname: "KubePodCrashLooping", namespace: "web", severity: "warning", ...labels },
	annotations: { summary: "pod crash looping", description: "web/api restarts" },
	startsAt: "2026-10-02T11:55:00Z",
	endsAt: "0001-01-01T00:00:00Z",
	generatorURL: "http://prometheus/graph?g0.expr=x",
	fingerprint: "abc",
	...over,
});
const group = (...alerts: unknown[]) => ({
	version: "4",
	status: "firing",
	groupKey: "{}:{alertname}",
	externalURL: "http://alertmanager",
	alerts,
});

function deliver(
	f: ReturnType<typeof fakeBoard>,
	body: unknown,
	headers: Logic.Headers = AUTH,
	cfg: Logic.AlertsCfg = { assigneeAgentId: "nagatha" },
) {
	return handleDelivery({ headers, body, secret: SECRET, cfg, board: f.board, now: f.now });
}

const CI_ROUTES = [
	{ match: "^(ForgeCI|alert:fleet-verify:forge-ci-duration)", assigneeAgentId: "greene" },
];
const ciAlert = () => alert({}, { alertname: "ForgeCIJobSlow", namespace: "", job: "forge-ci" });

describe("alertKey and alertTitle", () => {
	test("namespace wins", () =>
		expect(alertKey({ alertname: "A", namespace: "ns", instance: "h:9100", job: "j" })).toBe(
			"alert:A:ns",
		));
	test("instance when no namespace", () =>
		expect(alertKey({ alertname: "A", instance: "h:9100", job: "j" })).toBe("alert:A:h:9100"));
	test("job when no namespace or instance", () =>
		expect(alertKey({ alertname: "A", job: "j" })).toBe("alert:A:j"));
	test("dash when none", () => expect(alertKey({ alertname: "A" })).toBe("alert:A:-"));
	test("title prefixes Infra", () =>
		expect(alertTitle({ alertname: "A", namespace: "ns" })).toBe("Infra: alert:A:ns"));
	test("Watchdog skipped", () =>
		expect(
			parseAlerts(group(alert({}, { alertname: "Watchdog" }), alert())).map((a) => a.key),
		).toEqual(["alert:KubePodCrashLooping:web"]));
});

describe("handleDelivery", () => {
	test("token mismatch throws and creates nothing", async () => {
		const f = fakeBoard();
		const wrong = { "x-alerts-token": `${SECRET}x` };
		await expect(deliver(f, group(alert()), wrong)).rejects.toThrow("token");
		await expect(deliver(f, group(alert()), {})).rejects.toThrow("token");
		// The secret in Authorization is not accepted: Paperclip owns that header.
		const inAuth = { authorization: `Bearer ${SECRET}` };
		await expect(deliver(f, group(alert()), inAuth)).rejects.toThrow("token");
		expect(f.issues.length).toBe(0);
		expect(f.comments.length).toBe(0);
	});

	test("firing creates once, repeat comments, third within 30 min is quiet", async () => {
		const f = fakeBoard();
		expect(await deliver(f, group(alert()))).toEqual([
			{ key: "alert:KubePodCrashLooping:web", action: "create" },
		]);
		expect(f.issues.length).toBe(1);
		const issue = f.issues[0] as Issue;
		expect(issue.title).toBe("Infra: alert:KubePodCrashLooping:web");
		expect(issue.assigneeAgentId).toBe("nagatha");
		expect(issue.status).toBe("todo");
		expect(issue.priority).toBe("medium");
		expect(issue.description).toContain("pod crash looping");
		expect(issue.description).toContain("web/api restarts");
		expect(issue.description).toContain("- namespace: web");
		expect(issue.description).toContain("2026-10-02T11:55:00Z");
		expect(issue.description).toContain("http://prometheus/graph?g0.expr=x");

		f.setNow(T0 + 60_000);
		await deliver(f, group(alert()));
		expect(f.issues.length).toBe(1);
		expect(f.comments.length).toBe(1);
		expect(f.comments[0]?.body).toContain("still firing at 2026-10-02T12:01:00.000Z");

		f.setNow(T0 + 60_000 + REPEAT_QUIET_MS - 1000);
		await deliver(f, group(alert()));
		expect(f.comments.length).toBe(1);

		f.setNow(T0 + 60_000 + REPEAT_QUIET_MS + 1000);
		await deliver(f, group(alert()));
		expect(f.comments.length).toBe(2);
	});

	test("a human comment does not silence the repeat", async () => {
		const f = fakeBoard([
			{ id: "h1", title: "Infra: alert:KubePodCrashLooping:web", status: "todo" },
		]);
		f.comments.push({ issueId: "h1", body: "looking", createdAt: new Date(T0).toISOString() });
		await deliver(f, group(alert()));
		expect(f.comments.length).toBe(2);
	});

	test("critical gives high priority", async () => {
		const f = fakeBoard();
		await deliver(f, group(alert({}, { severity: "critical" })));
		expect(f.issues[0]?.priority).toBe("high");
	});

	test("resolved on a todo issue comments and sets done", async () => {
		const f = fakeBoard([
			{ id: "x", title: "Infra: alert:KubePodCrashLooping:web", status: "todo" },
		]);
		await deliver(f, group(alert({ status: "resolved", endsAt: "2026-10-02T12:10:00Z" })));
		expect(f.comments.map((c) => c.body.split("\n")[0])).toEqual([
			"RESOLVED at 2026-10-02T12:10:00Z (Alertmanager)",
		]);
		expect(f.issues[0]?.status).toBe("done");
	});

	test("resolved on an in_progress issue only comments", async () => {
		const f = fakeBoard([
			{ id: "x", title: "Infra: alert:KubePodCrashLooping:web", status: "in_progress" },
		]);
		await deliver(f, group(alert({ status: "resolved", endsAt: "2026-10-02T12:10:00Z" })));
		expect(f.comments.length).toBe(1);
		expect(f.issues[0]?.status).toBe("in_progress");
	});

	test("resolved with none open does nothing; firing re-opens a done issue", async () => {
		const f = fakeBoard([
			{ id: "x", title: "Infra: alert:KubePodCrashLooping:web", status: "done" },
		]);
		await deliver(f, group(alert({ status: "resolved" })));
		expect(f.comments.length).toBe(0);
		expect(f.issues.length).toBe(1);
		await deliver(f, group(alert()));
		expect(f.issues.map((i) => i.status)).toEqual(["todo"]);
	});

	test("a two-alert group makes two issues", async () => {
		const f = fakeBoard();
		await deliver(f, group(alert(), alert({}, { alertname: "NodeDown", namespace: "" })));
		expect(f.issues.map((i) => i.title).sort()).toEqual([
			"Infra: alert:KubePodCrashLooping:web",
			"Infra: alert:NodeDown:-",
		]);
	});
});

describe("routes pick the assignee by alert family", () => {
	test("a ForgeCI alert with a route goes to the routed assignee", async () => {
		const f = fakeBoard();
		await deliver(f, group(ciAlert()), AUTH, { assigneeAgentId: "nagatha", routes: CI_ROUTES });
		expect(f.issues.map((i) => i.assigneeAgentId)).toEqual(["greene"]);
	});

	test("a fleet-verify forge-ci-duration alert matches on its key", async () => {
		const f = fakeBoard();
		const fv = alert({}, { alertname: "fleet-verify", namespace: "forge-ci-duration-slow-job" });
		await deliver(f, group(fv), AUTH, { assigneeAgentId: "nagatha", routes: CI_ROUTES });
		expect(f.issues[0]?.assigneeAgentId).toBe("greene");
	});

	test("a non-matching alert goes to the default", async () => {
		const f = fakeBoard();
		await deliver(f, group(alert()), AUTH, { assigneeAgentId: "nagatha", routes: CI_ROUTES });
		expect(f.issues[0]?.assigneeAgentId).toBe("nagatha");
	});

	test("an invalid regex or malformed routes fall back without throwing", async () => {
		for (const routes of [
			[{ match: "(ForgeCI", assigneeAgentId: "greene" }],
			[null, { match: 7, assigneeAgentId: "greene" }, { match: "ForgeCI" }],
			"ForgeCI",
		]) {
			const f = fakeBoard();
			await deliver(f, group(ciAlert()), AUTH, { assigneeAgentId: "nagatha", routes });
			expect(f.issues[0]?.assigneeAgentId).toBe("nagatha");
		}
	});
});

describe("handleWebhook", () => {
	const COMPANY = "0f1e2d3c-4b5a-4968-8778-a1b2c3d4e5f6";
	function fakeCtx(cfg: Record<string, unknown> = {}) {
		const f = fakeBoard();
		const configCalls: string[] = [];
		const ctx: Logic.WebhookCtx = {
			companies: {
				list: async () => {
					throw new Error("companies.list must not be called");
				},
			},
			config: {
				get: async (id) => {
					configCalls.push(id);
					return { bearer: "secret-ref", assigneeAgentId: "nagatha", ...cfg };
				},
			},
			secrets: { resolve: async () => SECRET },
			issues: {
				// Like the host: only the asked assignee's issues come back.
				list: async (q) =>
					f.issues.filter((i) => i.assigneeAgentId === q.assigneeAgentId).map((i) => ({ ...i })),
				listComments: async (id) => f.comments.filter((c) => c.issueId === id),
				create: async (task) => {
					const issue = { id: `i${f.issues.length + 1}`, ...task };
					f.issues.push(issue);
					return issue;
				},
				createComment: async (issueId, body) => {
					f.comments.push({ issueId, body, createdAt: new Date(T0).toISOString() });
				},
				update: async () => undefined,
			},
		};
		return { f, ctx, configCalls };
	}
	const input = (headers: Logic.Headers) => ({
		endpointKey: "alertmanager",
		headers,
		parsedBody: group(alert()),
		rawBody: "",
	});

	test("a webhook without the company header throws the header error", async () => {
		const { ctx } = fakeCtx();
		await expect(handleWebhook(ctx, input(AUTH), () => T0)).rejects.toThrow(
			"alerts: x-alerts-company header missing or not a company id",
		);
		await expect(
			handleWebhook(ctx, input({ ...AUTH, "x-alerts-company": "nope" }), () => T0),
		).rejects.toThrow("alerts: x-alerts-company header missing or not a company id");
	});

	test("with the header, config.get gets that id and the delivery proceeds", async () => {
		const { f, ctx, configCalls } = fakeCtx();
		const results = await handleWebhook(
			ctx,
			input({ ...AUTH, "X-Alerts-Company": COMPANY }),
			() => T0,
		);
		expect(configCalls).toEqual([COMPANY]);
		expect(results).toEqual([{ key: "alert:KubePodCrashLooping:web", action: "create" }]);
		expect(f.issues[0]?.assigneeAgentId).toBe("nagatha");
	});

	test("companies.list throws yet the happy path passes: it is never called", async () => {
		const { f, ctx } = fakeCtx();
		await handleWebhook(ctx, input({ ...AUTH, "x-alerts-company": COMPANY }), () => T0);
		expect(f.issues.length).toBe(1);
	});

	test("a second ForgeCI delivery reuses the routed open issue", async () => {
		const { f, ctx } = fakeCtx({ routes: CI_ROUTES });
		const ci = {
			endpointKey: "alertmanager",
			headers: { ...AUTH, "x-alerts-company": COMPANY },
			parsedBody: group(ciAlert()),
			rawBody: "",
		};
		expect((await handleWebhook(ctx, ci, () => T0)).map((r) => r.action)).toEqual(["create"]);
		expect((await handleWebhook(ctx, ci, () => T0 + 60_000)).map((r) => r.action)).toEqual([
			"comment",
		]);
		expect(f.issues.map((i) => i.assigneeAgentId)).toEqual(["greene"]);
		expect(f.comments.length).toBe(1);
	});

	// Every alert issue lands in a project: cfg.projectId, else the
	// project named rtech/rtech-infra; neither still creates and logs.
	const withProjects = (ctx: Logic.WebhookCtx, projects: unknown[], warns: unknown[] = []) =>
		Object.assign(ctx, {
			projects: { list: async () => projects },
			logger: { warn: (m: string, d: unknown) => void warns.push([m, d]) },
		});
	const hdrs = { ...AUTH, "x-alerts-company": COMPANY };
	test("no cfg.projectId: the issue carries the rtech/rtech-infra project", async () => {
		const { f, ctx } = fakeCtx();
		withProjects(ctx, [
			{ id: "p-sf", name: "rodaddy/software-factory" },
			{ id: "p-infra", name: "rtech/rtech-infra" },
		]);
		await handleWebhook(ctx, input(hdrs), () => T0);
		expect(f.issues.map((i) => (i as { projectId?: string }).projectId)).toEqual(["p-infra"]);
	});
	test("cfg.projectId wins and no project list is read", async () => {
		const { f, ctx } = fakeCtx({ projectId: "p-cfg" });
		withProjects(ctx, []);
		ctx.projects = {
			list: async () => {
				throw new Error("projects.list must not be called");
			},
		};
		await handleWebhook(ctx, input(hdrs), () => T0);
		expect(f.issues.map((i) => (i as { projectId?: string }).projectId)).toEqual(["p-cfg"]);
	});
	test("no infra project: the issue is still created, one project-missing line", async () => {
		const { f, ctx } = fakeCtx();
		const warns: unknown[] = [];
		withProjects(ctx, [{ id: "p-sf", name: "rodaddy/software-factory" }], warns);
		await handleWebhook(ctx, input(hdrs), () => T0);
		expect(f.issues.length).toBe(1);
		expect("projectId" in (f.issues[0] ?? {})).toBe(false);
		expect(warns).toEqual([["alerts: project-missing", { repo: "rtech/rtech-infra" }]]);
	});
});
