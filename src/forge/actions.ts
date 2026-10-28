/**
 * @module forge/actions
 * @description The Forgejo Actions client (lane 476a): dispatch a
 *   workflow, list and read runs, and rerun one. Callers (sop-gate, the 476b/476c
 *   dispatchers) switch to it in their own lanes; nothing here is wired yet.
 *
 *   Live facts (read-only probe of forge.example.internal, Forgejo 16, 2026-09-24):
 *   `/actions/runs` answers `{total_count, workflow_runs[]}`; a run's
 *   `event_payload` is a JSON STRING, carrying `inputs` for a workflow_dispatch
 *   run; the dispatch POST accepts `return_run_info: true` and answers the new
 *   run's id. `POST /actions/runs/{id}/rerun` does NOT exist (404, and absent
 *   from the swagger), so `rerun` is a fresh dispatch of the same workflow with
 *   the run's recorded inputs.
 *
 * @outputs
 *   - `dispatchWorkflow` -- POST a workflow_dispatch on `main`; returns the run id when the forge reports it
 *   - `listRuns` -- a bounded, parsed list of runs, filtered by workflow/event/status
 *   - `getRun` -- one parsed run by id
 *   - `rerun` -- re-dispatch a workflow_dispatch run with its recorded inputs
 *   - `MAX_RUNS` -- the list bound
 *
 * @dependencies
 *   - ./boundary -- the reviewed transport client
 *   - ../log -- traced()
 */
import { traced } from "../log";
import type { ForgeClient } from "./boundary";

/** The most runs one `listRuns` call returns; one page, never paginated. */
export const MAX_RUNS = 50;

/** One Actions run, reduced to the fields the factory reads. */
export interface ActionRun {
	id: number;
	/** The workflow FILE name, e.g. `sop-gate.yml`. */
	workflowId: string;
	status: string;
	triggerEvent: string;
	created: string;
	/** `event_payload` parsed from its JSON string; null when absent or unparseable. */
	eventPayload: unknown;
	/** `index_in_repo`: the run number in the web URL and on an Actions task; null when absent. */
	index: number | null;
}

export interface RunFilter {
	workflow?: string;
	event?: string;
	status?: string;
}

const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function assertRepo(repo: string): void {
	if (!REPO_SHAPE.test(repo) || repo.includes("..")) {
		throw new Error(
			`forge actions: repository must be owner/repo, got ${JSON.stringify(repo.slice(0, 80))}`,
		);
	}
}

function parsePayload(raw: unknown): unknown {
	if (typeof raw !== "string") return raw ?? null;
	try {
		return JSON.parse(raw);
	} catch {
		return null;
	}
}

function parseRun(raw: unknown): ActionRun {
	const r = raw as Record<string, unknown> | null;
	if (!r || typeof r.id !== "number") throw new Error("forge actions: run has no numeric id");
	return {
		id: r.id,
		workflowId: String(r.workflow_id ?? ""),
		status: String(r.status ?? ""),
		triggerEvent: String(r.trigger_event ?? r.event ?? ""),
		created: String(r.created ?? ""),
		eventPayload: parsePayload(r.event_payload),
		index: typeof r.index_in_repo === "number" ? r.index_in_repo : null,
	};
}

/** POST a workflow_dispatch on `main`. `runId` is null when the forge answers without run info. */
export const dispatchWorkflow = traced(
	"forge.dispatchWorkflow",
	async function dispatchWorkflow(
		client: ForgeClient,
		repo: string,
		file: string,
		inputs: Record<string, string>,
	): Promise<{ runId: number | null }> {
		assertRepo(repo);
		const res = await client.write<{ id?: unknown } | null>(
			"POST",
			`/repos/${repo}/actions/workflows/${encodeURIComponent(file)}/dispatches`,
			{ ref: "main", inputs, return_run_info: true },
		);
		const id = res.data?.id;
		return { runId: typeof id === "number" ? id : null };
	},
	{ redact: { args: [0] } },
);

/** List runs, newest first as the forge returns them, bounded to MAX_RUNS. */
export const listRuns = traced(
	"forge.listRuns",
	async function listRuns(
		client: ForgeClient,
		repo: string,
		filter: RunFilter = {},
	): Promise<ActionRun[]> {
		assertRepo(repo);
		// Forgejo 16 ignores `limit` without `page` and returns every run (46 MB).
		const q = new URLSearchParams({ page: "1", limit: String(MAX_RUNS) });
		if (filter.workflow) q.set("workflow_id", filter.workflow);
		if (filter.event) q.set("event", filter.event);
		if (filter.status) q.set("status", filter.status);
		const res = await client.get<{ workflow_runs?: unknown }>(
			`/repos/${repo}/actions/runs?${q.toString()}`,
		);
		const runs = res.data?.workflow_runs;
		if (!Array.isArray(runs))
			throw new Error("forge actions: runs response has no workflow_runs array");
		return runs.slice(0, MAX_RUNS).map(parseRun);
	},
	{ redact: { args: [0] } },
);

/** Read one run by id. */
export const getRun = traced(
	"forge.getRun",
	async function getRun(client: ForgeClient, repo: string, id: number): Promise<ActionRun> {
		assertRepo(repo);
		const res = await client.get<unknown>(`/repos/${repo}/actions/runs/${Math.trunc(id)}`);
		return parseRun(res.data);
	},
	{ redact: { args: [0] } },
);

/**
 * Rerun a workflow_dispatch run: Forgejo 16 has no rerun endpoint, so this
 * dispatches the same workflow again on `main` with the run's recorded inputs.
 * A run triggered by any other event has no inputs to replay and is refused.
 */
export const rerun = traced(
	"forge.rerun",
	async function rerun(
		client: ForgeClient,
		repo: string,
		id: number,
	): Promise<{ runId: number | null }> {
		const run = await getRun(client, repo, id);
		if (run.triggerEvent !== "workflow_dispatch") {
			throw new Error(
				`forge actions: run ${run.id} is ${run.triggerEvent}, only a workflow_dispatch run can be rerun`,
			);
		}
		const raw = (run.eventPayload as { inputs?: unknown } | null)?.inputs;
		const inputs: Record<string, string> = {};
		if (raw && typeof raw === "object") {
			for (const [k, v] of Object.entries(raw)) inputs[k] = String(v);
		}
		return dispatchWorkflow(client, repo, run.workflowId, inputs);
	},
	{ redact: { args: [0] } },
);
