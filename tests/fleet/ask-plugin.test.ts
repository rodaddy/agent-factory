/**
 * @module tests/fleet/ask-plugin
 * @description The rodaddy.ask plugin's pure logic against a fake board and a
 *   fake plugin state. `ASK_PLUGIN_UNDER_TEST` points the suite at a mutated
 *   copy of logic.js (RED proof).
 */
import { describe, expect, mock, test } from "bun:test";
import type * as Logic from "../../fleet/plugins/ask/logic.js";

const target = process.env.ASK_PLUGIN_UNDER_TEST ?? "../../fleet/plugins/ask/logic.js";
const { askTitle, handleAsk, handleComment, parseAsk } = (await import(target)) as typeof Logic;

// Built at runtime so no credential-looking literal sits in the file.
const SECRET = ["ask", "hook", String(7 * 1000 + 35)].join("-");
const AUTH = { "x-ask-token": SECRET };
const NAGATHA = "agent-nagatha";
const CALLBACK = "http://10.0.20.105:9999/answers";

interface Issue {
	id: string;
	identifier: string;
	title: string;
	status: string;
	description?: string;
	priority?: string;
	assigneeAgentId?: string;
}

function fakeBoard(seed: Issue[] = []) {
	const issues: Issue[] = [...seed];
	const comments: (Logic.BoardComment & { issueId: string })[] = [];
	const stored = new Map<string, Logic.Stored>();
	const posts: { url: string; payload: Logic.CallbackPayload }[] = [];
	let failPosts = 0;
	const board: Logic.Board = {
		createIssue: async (task) => {
			const n = issues.length + 1;
			const issue = { id: `i${n}`, identifier: `SOF-${100 + n}`, ...task };
			issues.push(issue);
			return issue;
		},
		getIssue: async (id) => issues.find((i) => i.id === id) ?? null,
		listComments: async (id) => comments.filter((c) => c.issueId === id),
		updateIssue: async (id, patch) => {
			const i = issues.find((x) => x.id === id);
			if (i) Object.assign(i, patch);
		},
	};
	const state: Logic.State = {
		get: async (id) => stored.get(id),
		set: async (id, v) => {
			stored.set(id, v);
		},
	};
	const post: Logic.Post = async (url, payload) => {
		posts.push({ url, payload });
		if (failPosts > 0) {
			failPosts--;
			return { ok: false };
		}
		return { ok: true };
	};
	return {
		issues,
		comments,
		stored,
		posts,
		board,
		state,
		post,
		failNext: (n: number) => {
			failPosts = n;
		},
	};
}

const HOSTS = ["10.0.20.105:9999"];
const cfg: Logic.Config = { assigneeAgentId: NAGATHA, callbackHosts: HOSTS };
const body = (over: Record<string, unknown> = {}) => ({
	question: "Where is the k3s SOP index?",
	asker: "rico@mac",
	hits: [
		{ path: "rtech-infra/_DOCS/sops/k3s/README.md", line: 3, snippet: "k3s SOPs" },
		{ path: "rtech-infra/_DOCS/sops/k3s/index.json" },
	],
	callbackUrl: CALLBACK,
	...over,
});

function ask(
	f: ReturnType<typeof fakeBoard>,
	b: unknown,
	headers: Logic.Headers = AUTH,
	c: Logic.Config = cfg,
) {
	return handleAsk({ headers, body: b, secret: SECRET, cfg: c, board: f.board, state: f.state });
}

function comment(
	f: ReturnType<typeof fakeBoard>,
	issueId: string,
	text: string,
	author: string | null,
	c: Logic.Config = cfg,
) {
	const id = `c${f.comments.length + 1}`;
	f.comments.push({ id, issueId, body: text, authorAgentId: author });
	const issue = f.issues.find((i) => i.id === issueId);
	return handleComment({
		event: { entityId: issueId, payload: { commentId: id, issueTitle: issue?.title } },
		cfg: c,
		board: f.board,
		state: f.state,
		post: f.post,
	});
}

describe("askTitle and parseAsk", () => {
	test("title is one line, prefixed, at most 120 characters of question", () => {
		expect(askTitle("where  is\nthe index?")).toBe("Ask: where is the index?");
		expect(askTitle("x".repeat(300))).toBe(`Ask: ${"x".repeat(120)}`);
	});
	test("question is required and bounded", () => {
		expect(() => parseAsk(body({ question: "" }), HOSTS)).toThrow("question");
		expect(() => parseAsk(body({ question: "y".repeat(4001) }), HOSTS)).toThrow("4000");
		expect(parseAsk(body({ question: "y".repeat(4000) }), HOSTS).question.length).toBe(4000);
	});
	test("asker is required; a non-http callback is refused", () => {
		expect(() => parseAsk(body({ asker: "" }), HOSTS)).toThrow("asker");
		expect(() => parseAsk(body({ callbackUrl: "file:///etc/passwd" }), HOSTS)).toThrow(
			"callbackUrl",
		);
	});
});

describe("handleAsk", () => {
	test("a wrong, missing, or Authorization-borne token is refused and files nothing", async () => {
		const f = fakeBoard();
		await expect(ask(f, body(), { "x-ask-token": `${SECRET}x` })).rejects.toThrow("token");
		await expect(ask(f, body(), {})).rejects.toThrow("token");
		// The secret in Authorization is not accepted: Paperclip owns that header.
		await expect(ask(f, body(), { authorization: `Bearer ${SECRET}` })).rejects.toThrow("token");
		await expect(ask(f, body(), { authorization: SECRET })).rejects.toThrow("token");
		expect(f.issues.length).toBe(0);
		expect(f.stored.size).toBe(0);
	});

	test("files the issue for Nagatha with the question, asker, and hits", async () => {
		const f = fakeBoard();
		expect(await ask(f, body())).toEqual({ id: "i1", identifier: "SOF-101" });
		expect(f.issues.length).toBe(1);
		const issue = f.issues[0] as Issue;
		expect(issue.title).toBe("Ask: Where is the k3s SOP index?");
		expect(issue.assigneeAgentId).toBe(NAGATHA);
		expect(issue.status).toBe("todo");
		expect(issue.priority).toBe("medium");
		expect(issue.description).toContain("Where is the k3s SOP index?");
		expect(issue.description).toContain("Asked by: rico@mac");
		expect(issue.description).toContain("- rtech-infra/_DOCS/sops/k3s/README.md:3");
		expect(issue.description).toContain("  > k3s SOPs");
		expect(issue.description).toContain("- rtech-infra/_DOCS/sops/k3s/index.json");
		expect(issue.description).toContain("ONE comment starting `ANSWER:`");
		expect(issue.description).toContain(
			"separately specified implementation task through spec-ready and task-new",
		);
		expect(f.stored.get("i1")).toEqual({
			callbackUrl: CALLBACK,
			question: "Where is the k3s SOP index?",
		});
	});

	test("no callbackUrl stores nothing; the long question survives in full", async () => {
		const f = fakeBoard();
		const q = `${"why ".repeat(60)}?`;
		await ask(f, body({ callbackUrl: undefined, hits: undefined, question: q }));
		expect(f.stored.size).toBe(0);
		expect(f.issues[0]?.title.length).toBe(5 + 120);
		expect(f.issues[0]?.description).toContain(q.trim());
		expect(f.issues[0]?.description).toContain("- none");
	});
});

describe("handleComment", () => {
	test("ANSWER: from the assignee posts the callback and closes the issue", async () => {
		const f = fakeBoard();
		await ask(f, body());
		const r = await comment(f, "i1", "ANSWER: rtech-infra/_DOCS/sops/k3s/README.md:3", NAGATHA);
		expect(r).toEqual({ action: "answered", callback: "sent", closed: true });
		expect(f.posts).toEqual([
			{
				url: CALLBACK,
				payload: {
					issueId: "i1",
					identifier: "SOF-101",
					question: "Where is the k3s SOP index?",
					answer: "ANSWER: rtech-infra/_DOCS/sops/k3s/README.md:3",
				},
			},
		]);
		expect(f.issues[0]?.status).toBe("done");
	});

	test("ANSWER: from anyone else, or a non-answer from her, is ignored", async () => {
		const f = fakeBoard();
		await ask(f, body());
		expect((await comment(f, "i1", "ANSWER: it is in the wiki", "agent-bishop")).action).toBe(
			"ignored",
		);
		expect((await comment(f, "i1", "ANSWER: human says hi", null)).action).toBe("ignored");
		expect((await comment(f, "i1", "looking into it", NAGATHA)).action).toBe("ignored");
		expect(f.posts.length).toBe(0);
		expect(f.issues[0]?.status).toBe("todo");
	});

	test("an ANSWER: on a non-Ask issue is ignored", async () => {
		const f = fakeBoard([
			{ id: "x", identifier: "SOF-9", title: "Infra: alert:A:-", status: "todo" },
		]);
		expect((await comment(f, "x", "ANSWER: done", NAGATHA)).action).toBe("ignored");
		expect(f.issues[0]?.status).toBe("todo");
	});

	test("one retry on a failed callback; in_review is left for her", async () => {
		const f = fakeBoard();
		await ask(f, body());
		f.failNext(1);
		(f.issues[0] as Issue).status = "in_review";
		const r = await comment(f, "i1", "ANSWER: x", NAGATHA);
		expect(r).toEqual({ action: "answered", callback: "sent", closed: false });
		expect(f.posts.length).toBe(2);
		expect(f.issues[0]?.status).toBe("in_review");

		const g = fakeBoard();
		await ask(g, body());
		g.failNext(5);
		expect((await comment(g, "i1", "ANSWER: y", NAGATHA)).callback).toBe("failed");
		expect(g.posts.length).toBe(2);
		expect(g.issues[0]?.status).toBe("done");
	});

	test("no stored callback still closes an in_progress issue", async () => {
		const f = fakeBoard();
		await ask(f, body({ callbackUrl: undefined }));
		(f.issues[0] as Issue).status = "in_progress";
		expect(await comment(f, "i1", "  ANSWER: z", NAGATHA)).toEqual({
			action: "answered",
			callback: "none",
			closed: true,
		});
		expect(f.posts.length).toBe(0);
		expect(f.issues[0]?.status).toBe("done");
	});
});

describe("worker onWebhook", () => {
	const CO = "11111111-2222-3333-4444-555555555555";
	async function loadWorker() {
		mock.module("@paperclipai/plugin-sdk", () => ({
			definePlugin: (p: unknown) => p,
			runWorker: () => {},
		}));
		// worker.js has no .d.ts; the test drives the plugin's hooks directly.
		const workerPath: string = "../../fleet/plugins/ask/worker.js";
		const mod = (await import(workerPath)) as {
			default: {
				setup: (c: unknown) => Promise<void>;
				onWebhook: (i: unknown) => Promise<unknown>;
			};
		};
		const configCalls: unknown[] = [];
		const ctx = {
			companies: {
				list: async () => {
					throw new Error("companies.list is not allowed on a webhook");
				},
			},
			config: {
				get: async (id: unknown) => {
					configCalls.push(id);
					return { token: "tok-ref", assigneeAgentId: NAGATHA, callbackHosts: HOSTS };
				},
			},
			secrets: { resolve: async () => SECRET },
			issues: {
				create: async (t: Record<string, unknown>) => ({ id: "i1", identifier: "SOF-101", ...t }),
			},
			state: { get: async () => undefined, set: async () => {} },
			events: { on: () => {} },
			logger: { info: () => {}, warn: () => {} },
		};
		await mod.default.setup(ctx);
		return { plugin: mod.default, configCalls };
	}
	const input = (headers: Record<string, string>) => ({
		endpointKey: "ask",
		headers,
		rawBody: JSON.stringify(body({ callbackUrl: undefined })),
		parsedBody: body({ callbackUrl: undefined }),
		requestId: "r1",
	});

	test("a webhook without x-ask-company is refused", async () => {
		const { plugin } = await loadWorker();
		await expect(plugin.onWebhook(input(AUTH))).rejects.toThrow(
			"ask: x-ask-company header missing or not a company id",
		);
		await expect(plugin.onWebhook(input({ ...AUTH, "x-ask-company": "co-1" }))).rejects.toThrow(
			"x-ask-company",
		);
	});

	test("the company comes from the header; companies.list is never called", async () => {
		const { plugin, configCalls } = await loadWorker();
		expect(await plugin.onWebhook(input({ ...AUTH, "X-Ask-Company": CO }))).toEqual({
			id: "i1",
			identifier: "SOF-101",
		});
		expect(configCalls).toEqual([CO]);
	});
});

describe("callback allowlist", () => {
	const ALLOWED = "http://10.0.20.105:8787/answer";
	const only: Logic.Config = { assigneeAgentId: NAGATHA, callbackHosts: ["10.0.20.105:8787"] };

	test("a callback to a host that is not allowlisted, or with no allowlist, is refused", async () => {
		const f = fakeBoard();
		await expect(
			ask(f, body({ callbackUrl: "http://127.0.0.1:3100/x" }), AUTH, only),
		).rejects.toThrow("callbackUrl host is not allowlisted");
		expect(f.issues.length).toBe(0);
		expect(f.stored.size).toBe(0);
		// No allowlist at all refuses every callback, even the host allowed above.
		const none = fakeBoard();
		await expect(
			ask(none, body({ callbackUrl: ALLOWED }), AUTH, { assigneeAgentId: NAGATHA }),
		).rejects.toThrow("callbackUrl host is not allowlisted");
		expect(none.issues.length).toBe(0);
	});

	test("an allowlisted callback is accepted and posted", async () => {
		const f = fakeBoard();
		expect(await ask(f, body({ callbackUrl: ALLOWED }), AUTH, only)).toEqual({
			id: "i1",
			identifier: "SOF-101",
		});
		const r = await comment(f, "i1", "ANSWER: here", NAGATHA, only);
		expect(r).toEqual({ action: "answered", callback: "sent", closed: true });
		expect(f.posts.length).toBe(1);
		expect(f.posts[0]?.url).toBe(ALLOWED);
	});

	test("a stored callback that is no longer allowlisted is not posted", async () => {
		const f = fakeBoard();
		await ask(f, body({ callbackUrl: ALLOWED }), AUTH, only);
		expect(f.stored.get("i1")?.callbackUrl).toBe(ALLOWED);
		const r = await comment(f, "i1", "ANSWER: here", NAGATHA, {
			assigneeAgentId: NAGATHA,
			callbackHosts: [],
		});
		expect(r).toEqual({ action: "answered", callback: "none", closed: true });
		expect(f.posts.length).toBe(0);
	});

	test("a callback URL with credentials is refused", async () => {
		const f = fakeBoard();
		await expect(
			ask(f, body({ callbackUrl: "http://user:pw@10.0.20.105:8787/answer" }), AUTH, only),
		).rejects.toThrow("callbackUrl must not carry credentials");
		expect(f.issues.length).toBe(0);
	});
});
