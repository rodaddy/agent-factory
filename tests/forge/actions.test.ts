import { describe, expect, test } from "bun:test";
import type { ForgeClient, ForgeResponse } from "../../src/forge/boundary";
import { dispatchWorkflow, getRun, listRuns, MAX_RUNS, rerun } from "../../src/forge/actions";

/**
 * sf#476 (476a): the Forgejo Actions client. Fixtures mirror the live Forgejo 16
 * shapes probed read-only on 2026-09-24 (forge.example.internal): `/actions/runs`
 * answers `{total_count, workflow_runs[]}`, each run's `event_payload` is a JSON
 * STRING (it carries `inputs` for a workflow_dispatch run), and
 * `POST /actions/runs/{id}/rerun` answers 404 -- the endpoint does not exist on
 * this Forgejo, so rerun() is a fresh dispatch with the recorded inputs.
 */
const DISPATCH_RUN = {
	id: 6100,
	workflow_id: "sop-gate.yml",
	status: "failure",
	event: "workflow_dispatch",
	trigger_event: "workflow_dispatch",
	created: "2026-09-23T10:00:00-04:00",
	event_payload: JSON.stringify({
		inputs: { pr: "12", sha: "a".repeat(40) },
		ref: "refs/heads/main",
	}),
};
const PR_RUN = {
	id: 6260,
	workflow_id: "prepush.yml",
	status: "waiting",
	event: "pull_request",
	trigger_event: "pull_request",
	created: "2026-09-24T01:05:07-04:00",
	event_payload: JSON.stringify({ action: "opened", number: 872 }),
};

type Call = { method: string; path: string; body?: unknown };

function fakeForgejo(runs: unknown[] = [DISPATCH_RUN, PR_RUN]): {
	client: ForgeClient;
	calls: Call[];
} {
	const calls: Call[] = [];
	const ok = <T>(status: number, data: unknown): ForgeResponse<T> => ({
		status,
		data: data as T,
		link: null,
		rateRemaining: null,
	});
	const client = {
		provider: "forgejo",
		get: async (path: string) => {
			calls.push({ method: "GET", path });
			const one = /\/actions\/runs\/(\d+)$/.exec(path);
			if (one) {
				const run = runs.find((r) => (r as { id: number }).id === Number(one[1]));
				if (!run) throw new Error("Forgejo GET failed: HTTP 404");
				return ok(200, run);
			}
			return ok(200, { total_count: runs.length, workflow_runs: runs });
		},
		getPage: async () => ({ body: [], next: null }),
		paginate: async () => [],
		write: async (method: string, path: string, body?: unknown) => {
			calls.push({ method, path, body });
			return ok(201, { id: 7001, run_number: 88, jobs: ["gate"] });
		},
		postCommitCheck: async () => ({ status: "posted" as const }),
		findCommitCheck: async () => ({ status: "absent" as const }),
	} as unknown as ForgeClient;
	return { client, calls };
}

describe("dispatchWorkflow", () => {
	test("POSTs ref main + inputs to the workflow dispatches path and returns the run id", async () => {
		const { client, calls } = fakeForgejo();
		const out = await dispatchWorkflow(client, "rodaddy/software-factory", "sop-gate.yml", {
			pr: "12",
		});
		expect(calls).toEqual([
			{
				method: "POST",
				path: "/repos/rodaddy/software-factory/actions/workflows/sop-gate.yml/dispatches",
				body: { ref: "main", inputs: { pr: "12" }, return_run_info: true },
			},
		]);
		expect(out).toEqual({ runId: 7001 });
	});

	test("a 204 with no run info yields runId null, not a throw", async () => {
		const { client } = fakeForgejo();
		client.write = (async () => ({
			status: 204,
			data: null,
			link: null,
			rateRemaining: null,
		})) as ForgeClient["write"];
		expect(await dispatchWorkflow(client, "o/r", "x.yml", {})).toEqual({ runId: null });
	});

	test("refuses a repository that is not owner/repo", async () => {
		const { client, calls } = fakeForgejo();
		await expect(dispatchWorkflow(client, "../admin", "x.yml", {})).rejects.toThrow(/owner\/repo/);
		expect(calls).toEqual([]);
	});
});

describe("listRuns", () => {
	test("passes the filters as query params and parses the string event_payload", async () => {
		const { client, calls } = fakeForgejo();
		const runs = await listRuns(client, "rodaddy/software-factory", {
			workflow: "sop-gate.yml",
			event: "workflow_dispatch",
			status: "failure",
		});
		expect(calls[0]?.path).toBe(
			`/repos/rodaddy/software-factory/actions/runs?page=1&limit=${MAX_RUNS}&workflow_id=sop-gate.yml&event=workflow_dispatch&status=failure`,
		);
		expect(runs[0]).toEqual({
			id: 6100,
			workflowId: "sop-gate.yml",
			status: "failure",
			triggerEvent: "workflow_dispatch",
			created: "2026-09-23T10:00:00-04:00",
			eventPayload: { inputs: { pr: "12", sha: "a".repeat(40) }, ref: "refs/heads/main" },
			index: null,
		});
		expect(runs).toHaveLength(2);
	});

	test("reads index_in_repo, the run number an Actions task carries", async () => {
		const client = {
			get: async () => ({
				status: 200,
				data: { workflow_runs: [{ ...PR_RUN, id: 8818, index_in_repo: 3493 }] },
			}),
		} as unknown as ForgeClient;
		expect((await listRuns(client, "o/r"))[0]?.index).toBe(3493);
	});

	test("bounds the result to MAX_RUNS", async () => {
		const many = Array.from({ length: MAX_RUNS + 7 }, (_, i) => ({ ...PR_RUN, id: i + 1 }));
		const { client } = fakeForgejo(many);
		expect(await listRuns(client, "o/r")).toHaveLength(MAX_RUNS);
	});

	test("an unparseable event_payload is kept as null, not thrown", async () => {
		const { client } = fakeForgejo([{ ...PR_RUN, event_payload: "{not json" }]);
		const [run] = await listRuns(client, "o/r");
		expect(run?.eventPayload).toBeNull();
	});

	test("a malformed body (no workflow_runs array) throws", async () => {
		const { client } = fakeForgejo();
		client.get = (async () => ({
			status: 200,
			data: { oops: 1 },
			link: null,
			rateRemaining: null,
		})) as ForgeClient["get"];
		await expect(listRuns(client, "o/r")).rejects.toThrow(/workflow_runs/);
	});
});

describe("getRun / rerun", () => {
	test("getRun reads one run by id", async () => {
		const { client, calls } = fakeForgejo();
		const run = await getRun(client, "o/r", 6260);
		expect(calls[0]?.path).toBe("/repos/o/r/actions/runs/6260");
		expect(run.workflowId).toBe("prepush.yml");
	});

	test("rerun re-dispatches the run's workflow with its recorded inputs", async () => {
		const { client, calls } = fakeForgejo();
		const out = await rerun(client, "o/r", 6100);
		expect(calls.at(-1)).toEqual({
			method: "POST",
			path: "/repos/o/r/actions/workflows/sop-gate.yml/dispatches",
			body: { ref: "main", inputs: { pr: "12", sha: "a".repeat(40) }, return_run_info: true },
		});
		expect(out).toEqual({ runId: 7001 });
	});

	test("rerun refuses a run that was not a workflow_dispatch (no inputs to replay)", async () => {
		const { client, calls } = fakeForgejo();
		await expect(rerun(client, "o/r", 6260)).rejects.toThrow(/workflow_dispatch/);
		expect(calls.filter((c) => c.method === "POST")).toEqual([]);
	});
});
