import { describe, expect, test } from "bun:test";
import type { DispatchRecord } from "../../src/forge/actions-store";
import type { ForgeClient, ForgeResponse } from "../../src/forge/boundary";
import { retryOomTasks, withOomRetry } from "../../src/reconcile/oom-retry";

/**
 * sf#1090: an OOM-killed lane task is re-run ONCE on the large runner. Fixtures
 * follow the live Forgejo 16 shapes: `/actions/tasks` names its array
 * `workflow_runs` (each `id` a TASK id, `run_number` the run's index), and
 * `/actions/runs` carries `index_in_repo` plus a JSON-string `event_payload`.
 */
const REPO = "rodaddy/software-factory";
const SHA = "b".repeat(40);

function task(id: number, runNumber: number, event = "workflow_dispatch") {
	return { id, run_number: runNumber, event, workflow_id: "lane.yml", head_sha: SHA };
}
function run(
	id: number,
	index: number,
	inputs: Record<string, string>,
	event = "workflow_dispatch",
) {
	return {
		id,
		workflow_id: "lane.yml",
		status: "failure",
		event,
		trigger_event: event,
		created: "2026-09-30T10:00:00Z",
		index_in_repo: index,
		event_payload: JSON.stringify({ inputs }),
	};
}

type Call = { method: string; path: string; body?: unknown };

function setup(opts: {
	tasks: unknown[];
	runs: unknown[];
	dispatchThrows?: boolean;
	handled?: number[];
}) {
	const calls: Call[] = [];
	const records: DispatchRecord[] = [];
	const alerts: string[] = [];
	const ok = <T>(data: unknown): ForgeResponse<T> => ({
		status: 200,
		data: data as T,
		link: null,
		rateRemaining: null,
	});
	const client = {
		provider: "forgejo",
		get: async (path: string) => {
			calls.push({ method: "GET", path });
			if (path.includes("/actions/tasks")) return ok({ workflow_runs: opts.tasks });
			return ok({ total_count: opts.runs.length, workflow_runs: opts.runs });
		},
		getPage: async () => ({ body: [], next: null }),
		paginate: async () => [],
		write: async (method: string, path: string, body?: unknown) => {
			calls.push({ method, path, body });
			if (opts.dispatchThrows) throw new Error("Forgejo POST failed: HTTP 500");
			return ok({ id: 9001 });
		},
		postCommitCheck: async () => ({ ok: true }),
	} as unknown as ForgeClient;
	const handled = new Set<number>(opts.handled ?? []);
	const deps = {
		client,
		repo: REPO,
		handled,
		record: async (rec: DispatchRecord) => {
			records.push(rec);
		},
		alert: async (cause: string) => {
			alerts.push(cause);
		},
	};
	const dispatches = () => calls.filter((c) => c.method === "POST");
	return { deps, calls, records, alerts, handled, dispatches };
}

describe("retryOomTasks", () => {
	test("a dispatch-event OOM task is re-dispatched once with runner_size=large", async () => {
		const s = setup({ tasks: [task(77, 3493)], runs: [run(8818, 3493, { pr: "12" })] });
		await retryOomTasks([77], s.deps);
		const posts = s.dispatches();
		expect(posts).toHaveLength(1);
		expect(posts[0]?.path).toBe(`/repos/${REPO}/actions/workflows/lane.yml/dispatches`);
		expect((posts[0]?.body as { inputs?: unknown } | undefined)?.inputs).toEqual({
			pr: "12",
			runner_size: "large",
		});
		expect(s.records).toEqual([
			{
				repo: REPO,
				workflow: "lane.yml",
				runId: 9001,
				targetSha: SHA,
				inputs: { pr: "12", runner_size: "large" },
			},
		]);
		expect(s.handled.has(77)).toBe(true);
		expect(s.alerts).toEqual([]);
	});

	test("reads one page of tasks: Forgejo 16 ignores limit without page", async () => {
		// Probed 2026-09-30: `tasks?limit=50` returned all 4317 tasks (2 MB, ~10 s,
		// past the client's 10 s timeout); `tasks?page=1&limit=50` returned 50.
		const s = setup({ tasks: [task(77, 3493)], runs: [run(8818, 3493, { pr: "12" })] });
		await retryOomTasks([77], s.deps);
		const reads = s.calls.filter((c) => c.method === "GET").map((c) => c.path);
		expect(reads[0]).toBe(`/repos/${REPO}/actions/tasks?page=1&limit=50`);
		expect(reads[1]).toStartWith(`/repos/${REPO}/actions/runs?page=1&limit=`);
	});

	test("a task that OOMed on the large runner alerts and is not retried", async () => {
		const s = setup({
			tasks: [task(78, 3500)],
			runs: [run(8900, 3500, { pr: "12", runner_size: "large" })],
		});
		await retryOomTasks([78], s.deps);
		expect(s.dispatches()).toHaveLength(0);
		expect(s.alerts).toHaveLength(1);
		expect(s.alerts[0]).toContain("died again");
		expect(s.handled.has(78)).toBe(true);
	});

	test("a later large run with the same inputs means already retried", async () => {
		const s = setup({
			tasks: [task(77, 3493)],
			runs: [run(8830, 3499, { pr: "12", runner_size: "large" }), run(8818, 3493, { pr: "12" })],
		});
		await retryOomTasks([77], s.deps);
		expect(s.dispatches()).toHaveLength(0);
		expect(s.alerts).toEqual([]);
		expect(s.handled.has(77)).toBe(true);
	});

	test("a non-dispatch event alerts and dispatches nothing", async () => {
		const s = setup({ tasks: [task(79, 3510, "pull_request")], runs: [] });
		await retryOomTasks([79], s.deps);
		expect(s.dispatches()).toHaveLength(0);
		expect(s.alerts).toHaveLength(1);
		expect(s.alerts[0]).toContain("cannot be re-dispatched");
		expect(s.handled.has(79)).toBe(true);
	});

	test("an unknown task id dispatches nothing and stays unhandled for the next pass (PR 1103 review)", async () => {
		const s = setup({ tasks: [task(77, 3493)], runs: [run(8818, 3493, { pr: "12" })] });
		await retryOomTasks([12345], s.deps);
		expect(s.dispatches()).toHaveLength(0);
		expect(s.alerts).toEqual([]);
		expect(s.handled.has(12345)).toBe(false);
	});

	test("a task whose run is not listed yet stays unhandled for the next pass (PR 1103 review)", async () => {
		const s = setup({ tasks: [task(77, 3493)], runs: [] });
		await retryOomTasks([77], s.deps);
		expect(s.dispatches()).toHaveLength(0);
		expect(s.handled.has(77)).toBe(false);
	});

	test("an id already handled makes no forge call at all", async () => {
		const s = setup({ tasks: [task(77, 3493)], runs: [], handled: [77] });
		await retryOomTasks([77], s.deps);
		expect(s.calls).toHaveLength(0);
	});

	test("a dispatch that throws leaves the id unhandled for the next pass", async () => {
		const s = setup({
			tasks: [task(77, 3493)],
			runs: [run(8818, 3493, { pr: "12" })],
			dispatchThrows: true,
		});
		await retryOomTasks([77], s.deps);
		expect(s.handled.has(77)).toBe(false);
		expect(s.records).toEqual([]);
	});

	test("the same id twice in one call dispatches once", async () => {
		const s = setup({ tasks: [task(77, 3493)], runs: [run(8818, 3493, { pr: "12" })] });
		await retryOomTasks([77, 77], s.deps);
		expect(s.dispatches()).toHaveLength(1);
	});
});

describe("withOomRetry (PR 1103 review)", () => {
	test("a clientFor rejection goes to onError and the slots still come back", async () => {
		const slots = [{ vmid: 9109, status: "running", oomTasks: [77] }];
		const errors: unknown[] = [];
		const listBand = withOomRetry(async () => slots, {
			clientFor: async () => {
				throw new Error("no client");
			},
			db: {} as never,
			onError: (e) => errors.push(e),
		});
		expect(await listBand()).toBe(slots);
		expect(errors).toHaveLength(1);
	});
});
