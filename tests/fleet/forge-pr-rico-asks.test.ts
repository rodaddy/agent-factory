import { describe, expect, test } from "bun:test";
import { ricoAskCounts } from "../../fleet/plugins/forge-pr/rico-asks.js";
import { runSweep } from "../../fleet/plugins/forge-pr/sweep.js";

// sf#1375: every request_board_approval is an ask to the owner, counted and filed
// as one Bishop issue, once per approval id.
const NOW = Date.parse("2026-10-06T12:00:00Z");
const ask = (id: string, createdAt: string, over: Record<string, unknown> = {}) => ({
	id,
	type: "request_board_approval",
	status: "pending",
	requestedByAgentId: "agent-lead",
	createdAt,
	payload: { title: `Go on rodaddy/demo#${id.length} at 1234567`, reasons: ["checks pending"] },
	...over,
});

function harness(approvals: unknown[]) {
	const state = new Map<string, unknown>();
	const created: Array<{ title: string; description: string; assigneeAgentId: string }> = [];
	const logs: string[] = [];
	let clock = NOW;
	const deps = {
		// Forge answers empty lists: only the board side is under test.
		fetch: async () => new Response("[]", { status: 200 }),
		baseUrl: "https://forge.example.internal/api/v1",
		token: "t",
		repos: ["rodaddy/demo"],
		now: () => clock,
		stateGet: async (k: string) => state.get(k) ?? null,
		stateSet: async (k: string, v: unknown) => void state.set(k, v),
		createTask: async (t: { title: string; description: string; assigneeAgentId: string }) => {
			created.push(t);
			return { id: `issue-${created.length}` };
		},
		listTitles: async () => [],
		cfg: { reviewerAgentId: "r", triageAgentId: "t" },
		log: (l: string) => void logs.push(l),
		approvals: { list: async () => approvals, decide: async () => ({}) },
		companyId: "co-1",
		findAgent: async (login: string) => (login === "sf-bishop" ? "agent-bishop" : null),
		agentName: async (id: string | null) => (id === "agent-lead" ? "Hicks" : null),
	};
	return {
		state,
		created,
		logs,
		deps,
		tick: (ms: number) => {
			clock += ms;
		},
	};
}

describe("Rico-ask filing in the forge sweep", () => {
	test("a new approval yields one Bishop issue naming the agent, title, reasons and the ask", async () => {
		const h = harness([ask("ap-1", "2026-10-06T11:58:00Z")]);
		await runSweep(h.deps);
		expect(h.created.length).toBe(1);
		const issue = h.created[0];
		expect(issue?.title).toBe("Rico was asked: Go on rodaddy/demo#4 at 1234567");
		expect(issue?.assigneeAgentId).toBe("agent-bishop");
		expect(issue?.description).toContain("Requested by: Hicks");
		expect(issue?.description).toContain("- checks pending");
		expect(issue?.description).toContain(
			"find the rule that sent this to Rico and open the PR that makes agents decide it",
		);
		expect(issue?.description).toContain("at most ~0.0001% of decisions reach him");
		expect(h.logs).toContain("rico_asks count24h=1 filed=1");
	});
	test("a second sweep yields no second issue for the same approval", async () => {
		const h = harness([ask("ap-1", "2026-10-06T11:58:00Z")]);
		await runSweep(h.deps);
		h.tick(5 * 60 * 1000);
		await runSweep(h.deps);
		expect(h.created.length).toBe(1);
		expect(h.logs.filter((l) => l.startsWith("rico_asks "))).toEqual([
			"rico_asks count24h=1 filed=1",
			"rico_asks count24h=1 filed=0",
		]);
	});
	test("an approval that is not request_board_approval yields no issue", async () => {
		const h = harness([ask("ap-1", "2026-10-06T11:58:00Z", { type: "hire_agent" })]);
		await runSweep(h.deps);
		expect(h.created.length).toBe(0);
		expect(h.logs).toContain("rico_asks count24h=0 filed=0");
	});
	test("an approval created before the last sweep is not filed again", async () => {
		const h = harness([ask("ap-old", "2026-10-05T09:00:00Z")]);
		h.state.set("ricoasks:since", { at: NOW - 5 * 60 * 1000 });
		await runSweep(h.deps);
		expect(h.created.length).toBe(0);
	});
});

describe("ricoAskCounts", () => {
	test("the 24 h count is right across a UTC day boundary, with per-day reasons", () => {
		const now = Date.parse("2026-10-06T03:00:00Z");
		const c = ricoAskCounts(
			[
				ask("a", "2026-10-05T02:59:00Z"), // 24 h + 1 min ago: outside
				ask("b", "2026-10-05T03:01:00Z", { payload: { title: "Go on x/y#1 at abcdef1" } }),
				ask("c", "2026-10-05T23:59:00Z"),
				ask("d", "2026-10-06T00:01:00Z"),
				ask("e", "2026-10-06T00:02:00Z", { type: "hire_agent" }),
			],
			now,
		);
		expect(c.last24h).toBe(3);
		expect(c.days).toEqual([
			{
				day: "2026-10-05",
				count: 3,
				reasons: ["checks pending", "Go on x/y#1 at abcdef1", "checks pending"],
			},
			{ day: "2026-10-06", count: 1, reasons: ["checks pending"] },
		]);
	});
});
