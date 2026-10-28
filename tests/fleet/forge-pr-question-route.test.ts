import { describe, expect, test } from "bun:test";
import { routeQuestions } from "../../fleet/plugins/forge-pr/question-route.js";

// sf#1730: a seat's ask_user_questions card is answered by
// Smythe, not by the owner on the Decisions page. The job routes each one once.
const NOW = Date.parse("2026-10-07T12:00:00Z");
const issue = (n: number, over: Record<string, unknown> = {}) => ({
	id: `iss-${n}`,
	identifier: `SOF-${n}`,
	status: "in_review",
	updatedAt: "2026-10-07T11:00:00Z",
	...over,
});
const question = (id: string, over: Record<string, unknown> = {}) => ({
	id,
	kind: "ask_user_questions",
	status: "pending",
	createdByAgentId: "agent-hicks",
	createdByUserId: null,
	title: "Which base branch?",
	payload: {
		version: 1,
		questions: [
			{
				id: "q1",
				prompt: "Rebase on main or on the release branch?",
				selectionMode: "single",
				options: [
					{ id: "a", label: "main" },
					{ id: "b", label: "release/2026-10" },
				],
			},
		],
	},
	...over,
});

function harness(
	issues: Array<Record<string, unknown>>,
	cards: Record<string, unknown[]>,
	{ smythe = "agent-smythe" as string | null } = {},
) {
	const state = new Map<string, unknown>();
	const created: Array<{ title: string; description: string; assigneeAgentId: string }> = [];
	const comments: Array<{ id: string; body: string }> = [];
	const logs: string[] = [];
	const listed: Array<{ status: string; limit: number }> = [];
	let inFlight = 0;
	let maxInFlight = 0;
	const deps = {
		listIssues: async (q: { status: string; limit: number }) => {
			listed.push(q);
			return issues.filter((i) => i.status === q.status);
		},
		listInteractions: async (id: string) => {
			inFlight++;
			maxInFlight = Math.max(maxInFlight, inFlight);
			// Yield so the other readers start before this one returns; no clock.
			await Promise.resolve();
			inFlight--;
			return cards[id] ?? [];
		},
		now: () => NOW,
		stateGet: async (k: string) => state.get(k) ?? null,
		stateSet: async (k: string, v: unknown) => void state.set(k, v),
		findAgent: async (login: string) => (login === "sf-smythe" ? smythe : null),
		agentName: async (id: string | null) => (id === "agent-hicks" ? "Hicks" : null),
		createTask: async (t: { title: string; description: string; assigneeAgentId: string }) => {
			created.push(t);
			return { id: `new-${created.length}`, identifier: `SOF-${900 + created.length}` };
		},
		comment: async (id: string, body: string) => void comments.push({ id, body }),
		log: (l: string) => void logs.push(l),
	};
	return { deps, state, created, comments, logs, listed, max: () => maxInFlight };
}

describe("question-route", () => {
	test("one pending agent question yields one Smythe task, one origin comment, state set", async () => {
		const h = harness([issue(7)], { "iss-7": [question("int-1")] });
		await routeQuestions(h.deps);
		expect(h.created.length).toBe(1);
		const t = h.created[0];
		expect(t?.title).toBe("Decision: Which base branch?");
		expect(t?.assigneeAgentId).toBe("agent-smythe");
		expect(t?.description).toContain("[SOF-7](/SOF/issues/SOF-7)");
		expect(t?.description).toContain("Asked by: Hicks");
		expect(t?.description).toContain("Rebase on main or on the release branch?");
		expect(t?.description).toContain("- main");
		expect(t?.description).toContain("- release/2026-10");
		expect(t?.description).toContain(
			"Decide and post the decision as a comment on the origin task. A question that only Rico may decide goes to him with TELL RICO:.",
		);
		expect(h.comments).toEqual([
			{
				id: "iss-7",
				body: "Routed to Smythe in SOF-901 (Rico 2026-10-07: the factory answers seat questions).",
			},
		]);
		expect(h.state.get("question:int-1")).toEqual({ issueId: "new-1" });
		expect(h.listed.map((l) => l.status)).toEqual(["in_review", "blocked", "todo", "in_progress"]);
		expect(h.listed.every((l) => l.limit === 100)).toBe(true);
		expect(h.logs).toContain("question_route issues=1 pending=1 routed=1");
	});
	test("a second pass routes nothing new", async () => {
		const h = harness([issue(7)], { "iss-7": [question("int-1")] });
		await routeQuestions(h.deps);
		await routeQuestions(h.deps);
		expect(h.created.length).toBe(1);
		expect(h.comments.length).toBe(1);
	});
	test("a question created by a board user is ignored", async () => {
		const h = harness([issue(7)], {
			"iss-7": [question("int-1", { createdByAgentId: null, createdByUserId: "user-rico" })],
		});
		await routeQuestions(h.deps);
		expect(h.created.length).toBe(0);
		expect(h.comments.length).toBe(0);
	});
	test("a non-pending interaction or another kind is ignored", async () => {
		const h = harness([issue(7)], {
			"iss-7": [
				question("int-1", { status: "answered" }),
				question("int-2", { kind: "suggest_tasks" }),
			],
		});
		await routeQuestions(h.deps);
		expect(h.created.length).toBe(0);
	});
	test("a pending seat question on a task last updated three days ago routes once", async () => {
		const h = harness([issue(7, { status: "blocked", updatedAt: "2026-10-04T12:00:00Z" })], {
			"iss-7": [question("int-1")],
		});
		expect(await routeQuestions(h.deps)).toEqual({ pending: 1, routed: 1 });
		expect(await routeQuestions(h.deps)).toEqual({ pending: 1, routed: 0 });
		expect(h.created).toHaveLength(1);
		expect(h.created[0]?.assigneeAgentId).toBe("agent-smythe");
		expect(h.comments).toHaveLength(1);
		expect(h.state.get("question:int-1")).toEqual({ issueId: "new-1" });
	});
	test("no Smythe on the board: logged, nothing created, nothing recorded", async () => {
		const h = harness([issue(7)], { "iss-7": [question("int-1")] }, { smythe: null });
		await routeQuestions(h.deps);
		expect(h.created.length).toBe(0);
		expect(h.comments.length).toBe(0);
		expect(h.state.size).toBe(0);
		expect(h.logs).toContain("question_route: Smythe not on the board, questions left unrouted");
	});
	test("more than 4 issues: never more than 4 interaction reads in flight", async () => {
		const many = Array.from({ length: 10 }, (_, n) => issue(n + 1));
		const h = harness(many, {});
		await routeQuestions(h.deps);
		expect(h.max()).toBeLessThanOrEqual(4);
		expect(h.max()).toBeGreaterThan(1);
	});
});
