/**
 * @module hooks/dispatch-guard
 * @description After the watcher dispatches a Forgejo Actions workflow, watch
 *   for a run that no runner will ever pick up, and say so on the commit.
 *
 *   WHY. A job whose `runs-on` matches no registered runner label sits in
 *   `waiting` forever and says nothing. Observed on rodaddy/development: 29 runs
 *   across 25 days never started, and each was later reported by Forge as a
 *   `failure` status that read like a test failure. All five runners were idle.
 *
 *   HOW. Forgejo inserts the run row inside the dispatch POST, so by the first
 *   poll the run either sits in the `waiting` list or a runner has already
 *   taken it. The guard reads `actions/runs?event=workflow_dispatch&status=waiting`
 *   (small: the unfiltered listing ignores `limit` and returns megabytes) and
 *   matches the run by workflow file and by its own dispatch inputs: the run's
 *   `event_payload` (a JSON string) carries `inputs[shaInput]` equal to the
 *   dispatched sha, so two dispatches of one workflow never cross-attribute.
 *   Outcomes:
 *     - seen waiting, then gone: a runner took it -> `picked_up`, silent.
 *     - never seen waiting within 60 s: taken before the first poll ->
 *       `not_observed`, logged at info.
 *     - still waiting 120 s after it was first seen: nothing picked it up ->
 *       an `error` status `no runner picked up <workflow> within 120s` on the
 *       target sha under the lane's own context, and `hooks.dispatch.no_runner`.
 *       Before failing, the guard reads `actions/runs?status=running`:
 *       if any run is running the runners are busy, not absent, so it logs
 *       `hooks.dispatch.queued_busy` once and keeps polling, re-checking every
 *       120 s, up to `DISPATCH_BUSY_MAX_MS`; a later pickup is
 *       `picked_up_after_busy`, and running out the bound posts the error
 *       with `(runners busy)`.
 *     - a fourth consecutive unreadable poll: `unreadable`, one warn line.
 *
 *   `dispatchLanded` reads one page of dispatched runs to prove
 *   whether a POST whose response was lost created a run, before a retry.
 *
 *   NEVER REJECTS. It runs detached from the webhook path; every failure is
 *   logged by error class and returns an outcome.
 */

import type { ForgeResponse } from "../forge/boundary";
import { errorClass, log, traced } from "../log";

/** Forgejo API base. Pinned to the one reviewed deployment (`forgejo/config.ts`). */
const API_BASE = "https://forge.example.internal/api/v1";

/** Interval between polls. */
export const DISPATCH_POLL_MS = 10_000;
/** How long a dispatched run has to appear in the waiting list. */
export const DISPATCH_APPEAR_MS = 60_000;
/** How long a seen run may sit `waiting` before it counts as runner-less. */
export const DISPATCH_WAIT_MS = 120_000;
/** Longest a waiting run is tolerated while other runs hold the runners. */
export const DISPATCH_BUSY_MAX_MS = 45 * 60_000;
/** Consecutive failed reads tolerated; the next one ends the watch. */
const MAX_READ_FAILURES = 3;

/** Bounded forge read: structurally `ForgejoClient.get`. */
export type DispatchGuardRead = (pathOrUrl: string) => Promise<ForgeResponse<unknown>>;

/** Bounded forge write: structurally `ForgejoClient.write`. */
export type DispatchGuardWrite = (
	method: "POST",
	pathOrUrl: string,
	body: unknown,
) => Promise<ForgeResponse<unknown>>;

/** The seams, injectable so tests run with no clock and no network. */
export interface DispatchGuardDeps {
	read: DispatchGuardRead;
	write: DispatchGuardWrite;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/** One dispatch to watch. Every field comes from code or a validated sha. */
export interface DispatchWatch {
	/** Repository the workflow was dispatched on. */
	dispatchRepo: string;
	/** Workflow file dispatched, e.g. `sop-gate.yml`. */
	workflowFile: string;
	/** Repository the no-runner status lands on. */
	statusRepo: string;
	/** The validated 40-hex sha the lane reports on. */
	sha: string;
	/** The dispatch input that carried `sha`; matches the run to this dispatch. */
	shaInput: string;
	/** Commit-status context the lane reports under. */
	context: string;
	/** Where a reviewer follows the run. */
	targetUrl: string;
	/** Epoch ms at which the dispatch was sent. */
	dispatchedAt: number;
}

/** What the guard concluded. */
export type DispatchGuardOutcome =
	| "picked_up"
	| "picked_up_after_busy"
	| "not_observed"
	| "no_runner"
	| "unreadable";

/** Sleep that never holds the process open. */
function unrefSleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(resolve, ms);
		timer.unref?.();
	});
}

/** Read a nested property off an unknown value without asserting its shape. */
function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	return (value as Record<string, unknown>)[key];
}

/** Is our dispatched run in this waiting list? */
function isWaiting(data: unknown, watch: DispatchWatch): boolean {
	const runs = property(data, "workflow_runs");
	if (!Array.isArray(runs)) {
		return false;
	}
	return runs.some((run) => {
		if (property(run, "workflow_id") !== watch.workflowFile) {
			return false;
		}
		if (property(run, "status") !== "waiting") {
			return false;
		}
		return dispatchedSha(property(run, "event_payload"), watch.shaInput) === watch.sha;
	});
}

/** The sha input a run was dispatched with, from its JSON-string `event_payload`. */
function dispatchedSha(payload: unknown, shaInput: string): unknown {
	if (typeof payload !== "string") {
		return undefined;
	}
	try {
		return property(property(JSON.parse(payload), "inputs"), shaInput);
	} catch {
		return undefined;
	}
}

/** How many runs in a `status=running` list are actually running. */
function runningCount(data: unknown): number {
	const runs = property(data, "workflow_runs");
	if (!Array.isArray(runs)) {
		return 0;
	}
	return runs.filter((run) => property(run, "status") === "running").length;
}

/** Mutable state of one watch. */
interface WatchState {
	firstSeen: number | null;
	failures: number;
	/** Consecutive failed running-list reads; reset only by a good one. */
	runningFailures: number;
	/** Set once the runners were found busy. */
	busy: boolean;
	/** Elapsed-since-first-seen mark at which the next running-list check happens. */
	nextCheck: number;
}

/** One read with the consecutive-failure budget. `undefined` = skip this poll. */
async function tolerantRead(
	deps: DispatchGuardDeps,
	watch: DispatchWatch,
	state: WatchState,
	probe: { url: string; counter: "failures" | "runningFailures" },
): Promise<{ data: unknown } | "unreadable" | undefined> {
	try {
		const data = (await deps.read(probe.url)).data;
		state[probe.counter] = 0;
		return { data };
	} catch (err) {
		state[probe.counter]++;
		if (state[probe.counter] <= MAX_READ_FAILURES) {
			return undefined;
		}
		log("warn", "hooks.dispatch.watch_failed", {
			error_class: errorClass(err),
			workflow: watch.workflowFile,
			sha: watch.sha,
		});
		return "unreadable";
	}
}

/**
 * Our run is still waiting `elapsed` ms after first seen. Returns an outcome
 * to end the watch, or `undefined` to keep polling.
 */
async function onStillWaiting(
	deps: DispatchGuardDeps,
	watch: DispatchWatch,
	state: WatchState,
	elapsed: number,
): Promise<DispatchGuardOutcome | undefined> {
	if (state.busy && elapsed >= DISPATCH_BUSY_MAX_MS) {
		return await failNoRunner(deps, watch, true);
	}
	if (elapsed < state.nextCheck) {
		return undefined;
	}
	const url = `${API_BASE}/repos/${watch.dispatchRepo}/actions/runs?status=running`;
	const running = await tolerantRead(deps, watch, state, { url, counter: "runningFailures" });
	if (running === undefined) {
		state.nextCheck = elapsed + DISPATCH_WAIT_MS;
		return undefined;
	}
	if (running === "unreadable") {
		return running;
	}
	const count = runningCount(running.data);
	if (count === 0) {
		return await failNoRunner(deps, watch, false);
	}
	if (!state.busy) {
		state.busy = true;
		log("info", "hooks.dispatch.queued_busy", {
			workflow: watch.workflowFile,
			sha: watch.sha,
			running: count,
		});
	}
	state.nextCheck += DISPATCH_WAIT_MS;
	return undefined;
}

/** Our run left the waiting list after being seen: a runner took it. */
function pickedUp(watch: DispatchWatch, state: WatchState): DispatchGuardOutcome {
	if (!state.busy) {
		return "picked_up";
	}
	log("info", "hooks.dispatch.picked_up_after_busy", {
		workflow: watch.workflowFile,
		sha: watch.sha,
	});
	return "picked_up_after_busy";
}

async function watchDispatchImpl(
	deps: DispatchGuardDeps,
	watch: DispatchWatch,
): Promise<DispatchGuardOutcome> {
	const now = deps.now ?? Date.now;
	const sleep = deps.sleep ?? unrefSleep;
	const url = `${API_BASE}/repos/${watch.dispatchRepo}/actions/runs?event=workflow_dispatch&status=waiting`;
	const state: WatchState = {
		firstSeen: null,
		failures: 0,
		runningFailures: 0,
		busy: false,
		nextCheck: DISPATCH_WAIT_MS,
	};
	for (;;) {
		await sleep(DISPATCH_POLL_MS);
		const read = await tolerantRead(deps, watch, state, { url, counter: "failures" });
		if (read === "unreadable") {
			return read;
		}
		if (read === undefined) {
			continue;
		}
		const t = now();
		if (isWaiting(read.data, watch)) {
			state.firstSeen ??= t;
			const outcome = await onStillWaiting(deps, watch, state, t - state.firstSeen);
			if (outcome !== undefined) {
				return outcome;
			}
		} else if (state.firstSeen !== null) {
			return pickedUp(watch, state);
		} else if (t - watch.dispatchedAt >= DISPATCH_APPEAR_MS) {
			log("info", "hooks.dispatch.not_observed", {
				workflow: watch.workflowFile,
				sha: watch.sha,
			});
			return "not_observed";
		}
	}
}

/** Say it loudly: an error status on the lane's own context, and a log line. */
async function failNoRunner(
	deps: DispatchGuardDeps,
	watch: DispatchWatch,
	busy: boolean,
): Promise<DispatchGuardOutcome> {
	const description = busy
		? `no runner picked up ${watch.workflowFile} within ${DISPATCH_BUSY_MAX_MS / 60_000}m (runners busy)`
		: `no runner picked up ${watch.workflowFile} within ${DISPATCH_WAIT_MS / 1000}s`;
	log("warn", "hooks.dispatch.no_runner", {
		workflow: watch.workflowFile,
		status_repo: watch.statusRepo,
		sha: watch.sha,
	});
	try {
		await deps.write("POST", `${API_BASE}/repos/${watch.statusRepo}/statuses/${watch.sha}`, {
			context: watch.context,
			state: "error",
			description,
			target_url: watch.targetUrl,
		});
	} catch (err) {
		log("warn", "hooks.dispatch.status_failed", {
			error_class: errorClass(err),
			workflow: watch.workflowFile,
			sha: watch.sha,
		});
	}
	return "no_runner";
}

export const watchDispatch = traced("hooks.watchDispatch", watchDispatchImpl);

/** Where one dispatched workflow reports, keyed by workflow file. */
export interface DispatchTarget {
	/** Fixed repository the no-runner status lands on; ignored when `repoInput` is set. */
	statusRepo: string;
	/**
	 * The dispatch input carrying the status repository, for a workflow that
	 * reports on whichever enrolled repo it was dispatched for. Its value
	 * must be `owner/repo` shaped or no guard starts.
	 */
	repoInput?: string;
	context: string;
	/** The dispatch input carrying the already-validated sha. */
	shaInput: string;
}

/** Test seams for the guard a wrapped write starts. */
export interface DispatchGuardOptions {
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
	/** Receives each detached guard promise, so a test can await it. */
	onWatch?: (outcome: Promise<DispatchGuardOutcome>) => void;
}

/** An `owner/repo` name and nothing else. */
const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** `.../repos/<owner>/<repo>/actions/workflows/<file>/dispatches`. */
const DISPATCH_PATH = /\/repos\/([^/]+\/[^/]+)\/actions\/workflows\/([^/]+)\/dispatches$/;

/**
 * Wrap a forge write so every SUCCESSFUL workflow dispatch whose file is in
 * `targets` starts a detached `watchDispatch`. The wrapped write returns
 * exactly what the inner one did and never waits on the guard; a dispatch to an
 * unknown workflow, or one without a 40-hex sha input, starts nothing.
 */
function guardDispatchesImpl(
	write: DispatchGuardWrite,
	read: DispatchGuardRead,
	targets: Readonly<Record<string, DispatchTarget>>,
	options: DispatchGuardOptions = {},
): DispatchGuardWrite {
	const now = options.now ?? Date.now;
	return async (method, pathOrUrl, body) => {
		const dispatchedAt = now();
		const response = await write(method, pathOrUrl, body);
		const match = DISPATCH_PATH.exec(pathOrUrl);
		const target = match ? targets[match[2] ?? ""] : undefined;
		const inputs = property(body, "inputs");
		const sha = property(inputs, target?.shaInput ?? "");
		const statusRepo =
			target?.repoInput === undefined ? target?.statusRepo : property(inputs, target.repoInput);
		if (
			match &&
			target &&
			typeof sha === "string" &&
			/^[0-9a-f]{40}$/.test(sha) &&
			typeof statusRepo === "string" &&
			OWNER_REPO.test(statusRepo)
		) {
			const outcome = watchDispatch(
				{ read, write, now, sleep: options.sleep },
				{
					dispatchRepo: match[1] ?? "",
					workflowFile: match[2] ?? "",
					statusRepo,
					sha,
					shaInput: target.shaInput,
					context: target.context,
					targetUrl: `https://forge.example.internal/${match[1]}/actions`,
					dispatchedAt,
				},
			);
			options.onWatch?.(outcome);
		}
		return response;
	};
}

export const guardDispatches = traced("hooks.guardDispatches", guardDispatchesImpl);

/** Tolerance for forge-vs-watcher clock skew when matching a run's `created`. */
export const DISPATCH_CLOCK_SKEW_MS = 10_000;

/** One dispatch whose landing is in question. */
export interface LandedQuery {
	/** Repository the workflow was dispatched on, e.g. `SOP_GATE_DISPATCH_REPO`. */
	dispatchRepo: string;
	/** Workflow file dispatched, e.g. `prepush.yml`. */
	workflowFile: string;
	/** Every key must equal the run's `event_payload.inputs[key]`. */
	inputs: Readonly<Record<string, string>>;
	/** Epoch ms taken immediately before the FIRST POST. */
	since: number;
}

/** Does this listed run match the query: workflow, created since, and every input? */
function landedRun(run: unknown, q: LandedQuery): boolean {
	if (property(run, "workflow_id") !== q.workflowFile) {
		return false;
	}
	const created = property(run, "created");
	const at = typeof created === "string" ? Date.parse(created) : Number.NaN;
	if (!(at >= q.since - DISPATCH_CLOCK_SKEW_MS)) {
		return false;
	}
	return Object.entries(q.inputs).every(
		([key, value]) => dispatchedSha(property(run, "event_payload"), key) === value,
	);
}

/**
 * Whether a dispatch POST whose response was lost created a run:
 * true when a matching run exists, false when none does; a failed read throws.
 * Reads one newest-first page of any status. Residual race: if the forge API
 * does not yet list a run the POST just created, the read misses it and the
 * caller's retry dispatches a second run; the read narrows that window, it
 * cannot close it.
 */
async function dispatchLandedImpl(read: DispatchGuardRead, q: LandedQuery): Promise<boolean> {
	const url = `${API_BASE}/repos/${q.dispatchRepo}/actions/runs?event=workflow_dispatch&page=1&limit=50`;
	const runs = property((await read(url)).data, "workflow_runs");
	if (!Array.isArray(runs)) {
		return false;
	}
	return runs.some((run) => landedRun(run, q));
}

export const dispatchLanded = traced("hooks.dispatchLanded", dispatchLandedImpl);
