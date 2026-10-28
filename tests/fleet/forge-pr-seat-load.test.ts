import { describe, expect, mock, test } from "bun:test";

// sf#1730 no-lead review (plan L3): the worker's seat deps for the reviewer
// pair, and the open-review check over a recorded pair, against a fake ctx.
const CO = "co-1730";
type Issue = { id: string; title?: string; status: string; assigneeAgentId?: string };
type Worker = {
	default: { setup: (c: unknown) => Promise<void> };
	seatDeps: (companyId: string) => {
		seatsOf: () => Promise<Map<string, { id: string; name: string; status: string }>>;
		seatLoad: () => Promise<Map<string, number>>;
	};
	reviewOpen: (
		companyId: string,
		task: { title: string; assigneeAgentId: string },
		recorded: unknown,
	) => Promise<boolean>;
};

const AGENTS = [
	{ id: "a-kapoor", name: "Kapoor", status: "idle" },
	{ id: "a-giraud", name: "Giraud", status: "idle" },
	{ id: "a-colter", name: "Colter", status: "paused" },
	{ id: "a-smythe", name: "Smythe", status: "idle" },
];

async function load(board: Issue[], opts: { failFor?: string } = {}) {
	// Scheduling fixture: the protected host admits this task. Real receipt/refusal
	// behavior is exercised separately in review-round-ledger.test.ts.
	mock.module("../../fleet/plugins/forge-pr/review-admission-client.js", () => ({
		reviewAdmissionFor: () => async () => ({ action: "start" }),
	}));
	mock.module("@paperclipai/plugin-sdk", () => ({
		definePlugin: (p: unknown) => p,
		runWorker: () => {},
	}));
	const workerPath: string = "../../fleet/plugins/forge-pr/worker.js";
	const mod = (await import(workerPath)) as Worker;
	const warns: string[] = [];
	const ctx = {
		agents: { list: async () => AGENTS },
		issues: {
			// Like the host: filters by assignee and status, and caps a list at 100 rows.
			list: async (q: {
				assigneeAgentId?: string;
				status?: string;
				limit?: number;
				offset?: number;
			}) => {
				if (q.assigneeAgentId === opts.failFor) throw new Error("board down");
				return board
					.filter((i) => !q.assigneeAgentId || i.assigneeAgentId === q.assigneeAgentId)
					.filter((i) => !q.status || i.status === q.status)
					.slice(q.offset ?? 0, (q.offset ?? 0) + Math.min(q.limit ?? 100, 100));
			},
			get: async (id: string) => board.find((i) => i.id === id) ?? null,
		},
		jobs: { register: () => {} },
		events: { on: () => {} },
		logger: { info: () => {}, warn: (line: string) => warns.push(line) },
	};
	await mod.default.setup(ctx);
	return { mod, warns };
}

describe("seatsOf: each family login to its board agent", () => {
	test("maps sf-<name> to the agent named <Name>, skips a login with no agent", async () => {
		const { mod } = await load([]);
		const seats = await mod.seatDeps(CO).seatsOf();
		expect([...seats.keys()]).toEqual(["sf-kapoor", "sf-giraud", "sf-colter"]);
		expect(seats.get("sf-kapoor")?.id).toBe("a-kapoor");
		expect(seats.get("sf-colter")?.status).toBe("paused");
		expect(seats.has("sf-kong")).toBe(false);
	});
});

describe("seatLoad: open tasks per seat", () => {
	const board: Issue[] = [
		{ id: "1", status: "todo", assigneeAgentId: "a-kapoor" },
		{ id: "2", status: "in_progress", assigneeAgentId: "a-kapoor" },
		{ id: "3", status: "done", assigneeAgentId: "a-kapoor" },
		{ id: "4", status: "cancelled", assigneeAgentId: "a-giraud" },
		{ id: "5", status: "backlog", assigneeAgentId: "a-giraud" },
		{ id: "6", status: "todo", assigneeAgentId: "a-colter" },
		{ id: "7", status: "todo", assigneeAgentId: "a-smythe" },
	];
	test("counts only todo and in_progress, for family seats only", async () => {
		const { mod } = await load(board);
		const n = await mod.seatDeps(CO).seatLoad();
		expect(Object.fromEntries(n)).toEqual({ "a-kapoor": 2, "a-giraud": 0, "a-colter": 1 });
	});
	test("a seat whose read throws counts 0 and logs a warning; the rest still count", async () => {
		const { mod, warns } = await load(board, { failFor: "a-kapoor" });
		const n = await mod.seatDeps(CO).seatLoad();
		expect(Object.fromEntries(n)).toEqual({ "a-kapoor": 0, "a-giraud": 0, "a-colter": 1 });
		expect(warns.length).toBe(1);
	});
	test("a seat with more than 100 done tasks still counts its open ones", async () => {
		const done: Issue[] = Array.from({ length: 150 }, (_, i) => ({
			id: `d${i}`,
			status: "done",
			assigneeAgentId: "a-kapoor",
		}));
		const { mod } = await load([...done, ...board]);
		const n = await mod.seatDeps(CO).seatLoad();
		expect(n.get("a-kapoor")).toBe(2);
	});
	test("a seat with more than 100 open tasks of one status counts every page", async () => {
		const todo: Issue[] = Array.from({ length: 250 }, (_, i) => ({
			id: `t${i}`,
			status: "todo",
			assigneeAgentId: "a-giraud",
		}));
		const { mod } = await load([...todo, ...board]);
		const n = await mod.seatDeps(CO).seatLoad();
		expect(n.get("a-giraud")).toBe(250);
	});
});

describe("reviewOpen over a recorded pair (D1 item 8)", () => {
	const task = { title: "Review rodaddy/demo#7 @ abcdef1", assigneeAgentId: "x" };
	const pair = { issueId: "c", issueIds: { claude: "c", gpt: "g" } };
	const open = async (c: string, g: string) => {
		const { mod } = await load([
			{ id: "c", status: c },
			{ id: "g", status: g },
		]);
		return mod.reviewOpen(CO, task, pair);
	};
	test("open while one of the two is open", async () => {
		expect(await open("done", "in_progress")).toBe(true);
		expect(await open("todo", "cancelled")).toBe(true);
	});
	test("closed when both are done or cancelled", async () => {
		expect(await open("done", "cancelled")).toBe(false);
		expect(await open("done", "done")).toBe(false);
	});
	test("only issueId: as before, that one issue decides", async () => {
		const { mod } = await load([
			{ id: "c", status: "todo" },
			{ id: "d", status: "done" },
		]);
		expect(await mod.reviewOpen(CO, task, { issueId: "c" })).toBe(true);
		expect(await mod.reviewOpen(CO, task, { issueId: "d" })).toBe(false);
		expect(await mod.reviewOpen(CO, task, { issueId: "gone" })).toBe(false);
	});
	test("nothing recorded: falls back to the open-title check", async () => {
		const { mod } = await load([
			{ id: "t", title: task.title, status: "todo", assigneeAgentId: "x" },
		]);
		expect(await mod.reviewOpen(CO, task, null)).toBe(true);
	});
});
