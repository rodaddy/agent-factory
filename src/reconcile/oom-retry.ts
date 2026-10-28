/**
 * @module reconcile/oom-retry
 * @description sf#1090: a lane job the gateway reports as OOM-killed is re-run
 *   ONCE on the large runner (`runner_size=large`). A job that OOMs again on the
 *   large re-run is reported as a critical alert and never retried. No table:
 *   "already retried" is proven from the forge's own run list (a later dispatch
 *   of the same workflow with the same inputs plus `runner_size=large`).
 *
 *   sf#1076 (found 2026-09-30): the re-run is dispatched INSIDE a reconcile pass
 *   (the band listing is what reports the OOM), so the dispatching pass cannot
 *   see its own re-run's waiting job and the band scaler only places the large
 *   slot on the NEXT pass -- the 15-minute sweep, measured at 11 to 21 minutes
 *   behind the retry. `oomRetryInFlight` answers "is a large re-run still
 *   unplaced", which `reconcile/follow-through` turns into the 20 s cadence the
 *   build-bump rail already uses.
 *
 * @outputs
 *   - `retryOomTasks` -- settle a batch of OOM-killed task ids
 *   - `oomRetryInFlight` -- an unsettled large re-run was dispatched inside the window
 *   - `OOM_HOST_REPO`, `LARGE_INPUT`, `LARGE_VALUE`, `OOM_RETRY_WINDOW_MS` -- the fixed constants
 *
 * @dependencies
 *   - ../db/schema -- forge_runs (the recorded large re-runs)
 *   - ../forge/actions -- listRuns, dispatchWorkflow
 *   - ../forge/actions-store -- DispatchRecord
 *   - ../log -- log, traced, errorClass
 */

import { and, gte, notInArray, sql } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { type ForgeRunState, forgeRuns } from "../db/schema";
import { type ActionRun, dispatchWorkflow, listRuns } from "../forge/actions";
import { type DispatchRecord, recordDispatch } from "../forge/actions-store";
import type { ForgeClient } from "../forge/boundary";
import { errorClass, log, traced } from "../log";
import { type CriticalAlertTarget, raiseCriticalAlert } from "../observability/critical-alert";
import type { ListedVmid } from "./forge-runner-scale";

export const OOM_HOST_REPO = "rodaddy/software-factory";
/** The workflow_dispatch input name that selects the runner size. */
export const LARGE_INPUT = "runner_size";
export const LARGE_VALUE = "large";

/**
 * How long a recorded large re-run keeps the pass cadence short.
 *
 * The window is the ONLY bound that cannot be forgotten: `forge/settle-runs`
 * moves a row off `dispatched` from the commit status its workflow posts, but it
 * only looks at rows at least 2 minutes old, and a run whose workflow posts no
 * mapped status never settles at all. 10 minutes is long enough to cover a
 * clone of the large slot plus the queue wait that follows it, and short enough
 * that a never-settling row costs at most 30 extra passes -- six times less than
 * the hour the build-bump follow-through already accepts.
 */
export const OOM_RETRY_WINDOW_MS = 10 * 60_000;

/** The terminal run states: a row in one of these has reached its verdict. */
const SETTLED: ForgeRunState[] = ["success", "failure", "cancelled"];

export interface OomRetryDeps {
	/** Forge client for `repo`. */
	client: ForgeClient;
	/** The factory's workflow host repo. */
	repo: string;
	/** Task ids already settled in this process; mutated. */
	handled: Set<number>;
	/** recordDispatch bound to the db. */
	record: (rec: DispatchRecord) => Promise<unknown>;
	/** Raises the critical alert. */
	alert: (cause: string) => Promise<unknown>;
}

interface ActionTask {
	id: number;
	run_number: number;
	event: string;
	workflow_id: string;
	head_sha: string;
}

async function readTasks(deps: OomRetryDeps): Promise<ActionTask[]> {
	const res = await deps.client.get<{ workflow_runs?: unknown }>(
		// Without `page`, Forgejo 16 ignores `limit` and returns every task (past the timeout).
		`/repos/${deps.repo}/actions/tasks?page=1&limit=50`,
	);
	const tasks = res.data?.workflow_runs;
	if (res.status !== 200 || !Array.isArray(tasks)) {
		throw new Error("forge oom: tasks response has no workflow_runs array");
	}
	return tasks
		.filter(
			(t): t is ActionTask => !!t && typeof t.id === "number" && typeof t.run_number === "number",
		)
		.map((t) => ({
			id: t.id,
			run_number: t.run_number,
			event: String(t.event ?? ""),
			workflow_id: String(t.workflow_id ?? ""),
			head_sha: String(t.head_sha ?? ""),
		}));
}

function runInputs(run: ActionRun): Record<string, string> {
	const raw = (run.eventPayload as { inputs?: unknown } | null)?.inputs;
	const inputs: Record<string, string> = {};
	if (raw && typeof raw === "object") {
		for (const [k, v] of Object.entries(raw)) inputs[k] = String(v);
	}
	return inputs;
}

function sameInputs(a: Record<string, string>, b: Record<string, string>): boolean {
	const ka = Object.keys(a);
	if (ka.length !== Object.keys(b).length) return false;
	return ka.every((k) => Object.hasOwn(b, k) && a[k] === b[k]);
}

async function handleOne(
	task: ActionTask | undefined,
	id: number,
	deps: OomRetryDeps,
	runsFor: (workflow: string) => Promise<ActionRun[]>,
): Promise<boolean> {
	// Not found is NOT settled: the next pass looks again. The gateway's OOM record
	// dies with its slot, so an id that is never found (another repo's job) stops
	// being reported once the slot is destroyed (PR 1103 review).
	if (!task) {
		log("info", "forge_oom.task_not_found", { task_id: id });
		return false;
	}
	const workflow = task.workflow_id;
	const runNumber = task.run_number;
	if (task.event !== "workflow_dispatch") {
		log("warn", "forge_oom.not_retryable", { task_id: id, workflow, event: task.event });
		await deps.alert(
			`forge OOM: ${workflow} run ${runNumber} (task ${id}, event ${task.event}) was OOM-killed and cannot be re-dispatched`,
		);
		return true;
	}
	const runs = await runsFor(workflow);
	const run = runs.find((r) => r.index === runNumber);
	if (!run) {
		log("warn", "forge_oom.run_not_found", { task_id: id, workflow, run_number: runNumber });
		return false;
	}
	const inputs = runInputs(run);
	if (inputs[LARGE_INPUT] === LARGE_VALUE) {
		log("error", "forge_oom.failed_on_large", { task_id: id, workflow, run_number: runNumber });
		await deps.alert(
			`forge OOM on the large runner: ${workflow} run ${runNumber} (task ${id}) died again at 4 cores / 4 GB; not retried, a second OOM is a different problem`,
		);
		return true;
	}
	await retryLarge(task, { ...inputs, [LARGE_INPUT]: LARGE_VALUE }, runs, deps);
	return true;
}

/** Step 6: dispatch the large re-run unless a later identical one already exists. */
async function retryLarge(
	task: ActionTask,
	want: Record<string, string>,
	runs: ActionRun[],
	deps: OomRetryDeps,
): Promise<void> {
	const id = task.id;
	const workflow = task.workflow_id;
	const runNumber = task.run_number;
	const already = runs.some(
		(r) =>
			r.triggerEvent === "workflow_dispatch" &&
			r.index !== null &&
			r.index > runNumber &&
			sameInputs(runInputs(r), want),
	);
	if (already) {
		log("info", "forge_oom.already_retried", { task_id: id, workflow, run_number: runNumber });
		return;
	}
	const { runId } = await dispatchWorkflow(deps.client, deps.repo, workflow, want);
	await deps.record({
		repo: deps.repo,
		workflow,
		runId,
		targetSha: task.head_sha,
		inputs: want,
	});
	log("info", "forge_oom.retried", {
		task_id: id,
		workflow,
		run_number: runNumber,
		run_id: runId,
	});
}

async function impl(taskIds: number[], deps: OomRetryDeps): Promise<void> {
	const ids = [...new Set(taskIds)].filter((id) => !deps.handled.has(id));
	if (ids.length === 0) return;
	let tasks: ActionTask[];
	try {
		tasks = await readTasks(deps);
	} catch (e) {
		log("warn", "forge_oom.retry_failed", { task_id: ids[0], error_class: errorClass(e) });
		return;
	}
	const cache = new Map<string, Promise<ActionRun[]>>();
	const runsFor = (workflow: string): Promise<ActionRun[]> => {
		let p = cache.get(workflow);
		if (!p) {
			p = listRuns(deps.client, deps.repo, { workflow });
			cache.set(workflow, p);
		}
		return p;
	};
	for (const id of ids) {
		try {
			if (
				await handleOne(
					tasks.find((t) => t.id === id),
					id,
					deps,
					runsFor,
				)
			)
				deps.handled.add(id);
		} catch (e) {
			log("warn", "forge_oom.retry_failed", { task_id: id, error_class: errorClass(e) });
		}
	}
}

/** Re-run each OOM-killed task once on the large runner; alert on a second OOM. */
export const retryOomTasks = traced("reconcile.retryOomTasks", impl, { redact: { args: [1] } });

/** What `withOomRetry` needs from the reconcile cycle. */
export interface OomRetryWiring {
	clientFor: (repository: string) => Promise<ForgeClient | null>;
	db: WatcherDb;
	criticalAlertTarget?: CriticalAlertTarget;
	onError: (e: unknown) => void;
}

/** Task ids the OOM retry already settled in this process. */
const OOM_HANDLED = new Set<number>();

/**
 * Wrap the forge band listing so every listing also settles the OOM-killed
 * tasks it reports. The slots are returned unchanged; a retry failure goes to
 * `onError` and never breaks the scaler's listing.
 */
export const withOomRetry = traced(
	"reconcile.withOomRetry",
	function withOomRetry(
		listBand: () => Promise<ListedVmid[]>,
		w: OomRetryWiring,
	): () => Promise<ListedVmid[]> {
		return async () => {
			const slots = await listBand();
			const ids = slots.flatMap((s) => s.oomTasks ?? []);
			if (ids.length === 0) return slots;
			try {
				const client = await w.clientFor(OOM_HOST_REPO);
				if (!client) return slots;
				await retryOomTasks(ids, {
					client,
					repo: OOM_HOST_REPO,
					handled: OOM_HANDLED,
					record: (rec) => recordDispatch(w.db, rec),
					alert: (cause) =>
						raiseCriticalAlert(w.criticalAlertTarget, { alertClass: "forge_oom", cause }),
				});
			} catch (e) {
				// Never breaks the scaler's listing (PR 1103 review: clientFor was outside the catch).
				w.onError(e);
			}
			return slots;
		};
	},
	{ redact: { args: [1] } },
);

/**
 * Whether a large OOM re-run dispatched inside `OOM_RETRY_WINDOW_MS` is still
 * unsettled -- i.e. its job may still be waiting for a `forgejo-mvp-large` slot
 * the band scaler has not placed yet.
 *
 * Read from `forge_runs`, not from process memory: the retry is recorded there
 * by `retryLarge`, so a watcher restart between the dispatch and the placement
 * still follows through. `inputs->>'runner_size' = 'large'` is the OOM re-run's
 * signature -- `retryLarge` is the only writer of that input.
 */
async function oomRetryInFlightImpl(db: WatcherDb, now: Date): Promise<boolean> {
	const rows = await db
		.select({ one: sql<number>`1` })
		.from(forgeRuns)
		.where(
			and(
				sql`${forgeRuns.inputs}->>${LARGE_INPUT} = ${LARGE_VALUE}`,
				notInArray(forgeRuns.state, SETTLED),
				gte(forgeRuns.dispatchedAt, new Date(now.getTime() - OOM_RETRY_WINDOW_MS)),
			),
		)
		.limit(1);
	return rows.length > 0;
}

export const oomRetryInFlight = traced("reconcile.oomRetryInFlight", oomRetryInFlightImpl, {
	redact: { args: [0] },
});
