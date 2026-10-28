/**
 * @module kboard/pass
 * @description The READY STATION of the assembly line. One
 *   bounded top-of-cycle step that turns a k-board task sitting in `ready` into
 *   a claimed, dispatched implement job, and reports the run's outcome back to
 *   the board through the ruled transitions.
 *
 *   THE RULED DESIGN (the owner, 2026-08-01, issue #71 comments "Rulings" and
 *   "Station table RATIFIED"). Do not re-derive it here; the table below is the
 *   spec, and this module implements exactly the `ready` row of it:
 *
 *     | status  | worker spawned | on success        | on failure |
 *     |---------|----------------|-------------------|------------|
 *     | ready   | implement      | running (claim)   | —          |
 *     | running | (in flight)    | review + PR num   | blocked    |
 *
 *   A task ENTERING a status is the trigger; the worker's outcome moves it
 *   onward. Triage and review stations are PHASE 2 and are deliberately absent.
 *
 *   BOARD PLACEMENT *IS* THE AUTHORIZATION. There is no new config flag. Any
 *   k-board task in `ready` carrying a complete repo binding — `repo_provider`
 *   `github`, a `repo_full_name` that is a MANAGED repository in the live
 *   config, and a `repo_item_number` — is dispatchable. The managed-repository
 *   allowlist is the gate that already exists, re-read from config every pass,
 *   exactly as the dispatch pass re-gates a queued job. The IMPLEMENT-TEMPLATE
 *   allowlist is the second half of that same re-gate: the station must
 *   refuse to claim work the dispatcher would then refuse to dispatch, or the task
 *   strands in `running` behind a job deferred hourly forever.
 *
 *   DISAGREEMENT IS LOGGED, NEVER RESOLVED. The board is the work-state
 *   authority; the local `jobs` table is the dispatch bookkeeping. When they
 *   disagree — a CAS miss, an ownership refusal, a `ready` task whose job is
 *   already live — the pass emits a bounded `kboard.divergence` line and SKIPS
 *   that task for THIS pass. Nothing is blind-retried, and a failed board write
 *   can never lose or double-dispatch a local job: the job row is the only
 *   thing that decides what a runner receives.
 *
 *   TOKEN ABSENT IS A HEALTHY BOOT. `KBOARD_TOKEN` is minted on the k-board
 *   service as a separate operator step, so this code must deploy BEFORE the
 *   credential exists. With no token the entire pass emits ONE bounded
 *   `kboard.disabled_no_token` warning per cycle and returns; the rest of the
 *   cycle is untouched and the service stays healthy.
 *
 *   THE LABEL PATH IS UNCHANGED. The forge `implement_label` trigger in
 *   `reconcile/pass.ts` still runs exactly as before. Board and label triggers
 *   COEXIST until the owner retires the label; the only thing that distinguishes a
 *   board-claimed job is the `jobs.kboard_task_id` marker this pass writes.
 *
 *   BLOCKED IS TERMINAL FOR NOW — DELIBERATELY. The #95 infra-requeue can revive
 *   a terminal-`failed` job to `pending`, and that job will dispatch again and
 *   may well succeed. Its board task STAYS `blocked`: the ratified table says an
 *   infra-class failure "MAY auto-requeue → ready", and a MAY is not a MUST.
 *   Automating `blocked → ready` is phase 2's decision, not this module's, so a
 *   revived job whose proposal opens will still write `review` (the proposal
 *   seam does not read the current status), while a revived job that fails again
 *   re-writes `blocked` idempotently. An operator reading the board during that
 *   window sees `blocked` for a job that is running again; that is a known,
 *   ruled gap, not a defect to fix here.
 *
 * @outputs
 *   - `runKboardPass` -- one bounded ready-station pass (claim + enqueue)
 *   - `runKboardTransitionsPass` -- report the ruled outcome transitions
 *   - `reportProposalOpened` / `reportJobFailed` -- the two ruled transitions
 *   - `KboardPassSummary` / `KboardTransitionsSummary` -- bounded counters
 *   - `KboardPassDeps` -- the injected seams (client, config, db, clock)
 *   - `eventIdempotencyKey` -- the ruled `${task}:${job}:${type}` derivation
 *   - `MAX_KBOARD_CLAIMS_PER_PASS` / `MAX_KBOARD_TRANSITIONS_PER_PASS` -- bounds
 *
 * @dependencies
 *   - ./client -- the bounded CAS-guarded k-board client
 *   - ./ready-gate -- the pre-claim refusal ladder and binding/base resolution
 *   - ../db/repos -- the sanctioned job/item/repository writers
 *   - ../templates/registry -- the fixed implement template id
 *   - ../log -- bounded, secret-safe structured logging
 */
import { and, desc, eq, gt, isNotNull, notExists, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import { createPendingJob } from "../db/repos";
import { githubPostings, jobs } from "../db/schema";
import type { ForgeClient } from "../forge/boundary";
import { bounded, errorMessage, log, traced } from "../log";
import { IMPLEMENT_TEMPLATE_ID } from "../templates/registry";
import type { KboardClient, KboardTask } from "./client";
import { KBOARD_PASS_ENABLED } from "./config";
import { gateReadyTask } from "./ready-gate";

/**
 * Cap on tasks CLAIMED per pass. Bounded for the same reason every other
 * top-of-cycle step is: one cycle must stay predictable however many tasks a
 * human parked in `ready`, and a remaining backlog is simply claimed next cycle.
 * Deliberately smaller than the dispatch cap — each claim costs a GET, a PATCH,
 * a forge base lookup, and an event POST.
 */
export const MAX_KBOARD_CLAIMS_PER_PASS = 10;

/** The event types this station emits. Fixed strings, never derived from input. */
const EVENT_DISPATCHED = "dispatched" as const;
const EVENT_RUNNER_FAILED = "runner_failed" as const;
const EVENT_PROPOSAL_OPENED = "proposal_opened" as const;

/**
 * The ruled event idempotency key: `${task_id}:${job_id}:${event_type}` (the owner,
 * 2026-08-01 — "Event idempotency keys derive from the run, never per-attempt
 * UUIDs").
 *
 * This derivation is the WHOLE safety property of a retried pass. The server's
 * `idempotency_key` column is UNIQUE, so a key derived from the run makes a
 * re-post a 409 the client reports as `already_logged` — success-equivalent. A
 * fresh UUID per call would satisfy the same types, compile, read correctly, and
 * silently double-log every event on every retry, which is exactly the failure
 * the uniqueness constraint exists to prevent.
 */
export const eventIdempotencyKey = traced(
	"kboard.eventIdempotencyKey",
	function eventIdempotencyKey(taskId: string, jobId: number, eventType: string): string {
		return `${taskId}:${jobId}:${eventType}`;
	},
);

/** Bounded per-pass counters. Safe to log as-is: no secrets, no free text. */
export interface KboardPassSummary {
	/** Whether the pass ran at all (false when no token is configured). */
	enabled: boolean;
	/** `ready` tasks the board returned. */
	tasks: number;
	/** Tasks claimed AND given a local implement job. */
	claimed: number;
	/** Tasks skipped before any claim (unmanaged repo, bad binding, live job). */
	skipped: number;
	/** Claims the board refused (CAS miss, ownership, not claimable). */
	refused: number;
	/** Claims that won but whose job could not be created (task moved to blocked). */
	failed: number;
}

export interface KboardPassDeps {
	db: WatcherDb;
	/**
	 * The bounded k-board client, or null when no `KBOARD_TOKEN` is configured.
	 * NULL IS A FIRST-CLASS STATE, not an error: this code deploys before the
	 * credential is minted, so a null client means the pass logs one bounded
	 * warning and returns without touching anything.
	 */
	client: KboardClient | null;
	/** The live watcher config; owns the managed-repository allowlist. */
	config: WatcherConfig;
	/**
	 * The forge client for a managed repository, used ONLY to read the repository's
	 * default branch and that branch's tip commit. Returns null when the provider
	 * has no usable credential, and the task is refused rather than dispatched
	 * against an unproven base.
	 */
	clientFor(repository: string): Promise<ForgeClient | null>;
	/** Max tasks claimed this pass. Defaults to {@link MAX_KBOARD_CLAIMS_PER_PASS}. */
	maxPerPass?: number;
	/** Error sink for an isolated per-task failure. Never aborts the pass. */
	onError?: (error: unknown) => void;
}

/**
 * Invoke the caller's error sink without letting a faulty sink abort the pass.
 * Mirrors `reconcile/dispatch-pass`'s `reportError`: a monitoring sink is
 * untrusted here, and a throw from it must not take down the rest of the cycle.
 */
function reportError(onError: KboardPassDeps["onError"], error: unknown): void {
	try {
		onError?.(error);
	} catch (sinkErr) {
		log("debug", "kboard.sink_failed", { cause: errorMessage(sinkErr) });
	}
}

/**
 * Post one event, treating `already_logged` as the success it is.
 *
 * A 409 on the UNIQUE `idempotency_key` means the event this pass wanted logged
 * IS logged — by an earlier attempt of the same run, since the key derives from
 * the run. Reporting that as a failure would make every retried pass look
 * broken. Any other non-ok outcome is a DIVERGENCE (the board did not record
 * something the factory did) and is logged as one; it never throws.
 */
type PostEventOrDivergeArgs = {
	client: KboardClient;
	taskId: string;
	jobId: number;
	eventType: string;
	payload?: Record<string, unknown>;
};

async function postEventOrDiverge({
	client,
	taskId,
	jobId,
	eventType,
	payload,
}: PostEventOrDivergeArgs): Promise<void> {
	const outcome = await client.postEvent(taskId, {
		eventType,
		idempotencyKey: eventIdempotencyKey(taskId, jobId, eventType),
		...(payload === undefined ? {} : { payload }),
	});
	if (outcome.kind === "ok" || outcome.kind === "already_logged") {
		return;
	}
	log("warn", "kboard.divergence", {
		reason: "event not logged on the board",
		task_id: taskId,
		job_id: jobId,
		event_type: eventType,
		outcome: outcome.kind,
	});
}
/**
 * Run one bounded ready-station pass.
 *
 * Composition mirrors `requeueInfraFailedJobs`: ONE step at the top of the
 * reconcile cycle, every per-task failure isolated through `onError`, never
 * throwing into the cycle, and a pure function of the injected clock.
 *
 * @param deps - client, db, config, forge-client resolver, bounds, error sink
 * @param now - clock seam for the placeholder item's observed timestamp
 */
export const runKboardPass = traced(
	"kboard.runKboardPass",
	async function runKboardPass(deps: KboardPassDeps, now: Date): Promise<KboardPassSummary> {
		const summary: KboardPassSummary = {
			enabled: false,
			tasks: 0,
			claimed: 0,
			skipped: 0,
			refused: 0,
			failed: 0,
		};

		const client = deps.client;
		if (client === null && !KBOARD_PASS_ENABLED) {
			// Switched off on purpose (SOF-11143): a debug line, not a warn every cycle.
			log("debug", "kboard.pass_disabled", {
				reason: "KBOARD_PASS_ENABLED is false; the k-board API is off (SOF-11143)",
			});
			return summary;
		}
		if (client === null) {
			// ONE bounded line per cycle. The token is minted on the k-board service as
			// a separate operator step, so a watcher deployed before that step must boot
			// healthy and simply not do board work.
			log("warn", "kboard.disabled_no_token", {
				reason: "KBOARD_TOKEN is not configured; the ready station is inactive",
			});
			return summary;
		}
		summary.enabled = true;

		const maxPerPass = Math.max(1, Math.min(deps.maxPerPass ?? MAX_KBOARD_CLAIMS_PER_PASS, 200));

		const listed = await client.listTasks({ status: "ready" });
		if (listed.kind !== "ok") {
			// A read failure is not a divergence — the board said nothing, so nothing
			// disagrees. Log it and leave the cycle to continue.
			log("warn", "kboard.list_failed", { outcome: listed.kind });
			return summary;
		}
		summary.tasks = listed.value.length;

		for (const task of listed.value) {
			if (summary.claimed >= maxPerPass) {
				break;
			}
			try {
				await processReadyTask({ deps, client, task, now, summary });
			} catch (err) {
				// Defence in depth: every step below already handles its own failures, but
				// an unexpected throw is isolated to this task and never aborts the pass or
				// the cycle. No board write and no job creation is retried as a result.
				summary.failed++;
				log("error", "kboard.task_failed", {
					task_id: task.task_id,
					cause: errorMessage(err),
				});
				reportError(deps.onError, err);
			}
		}

		return summary;
	},
);

/**
 * Process ONE `ready` task: validate, guard, claim, enqueue, report.
 *
 * The order is load-bearing. Every cheap local refusal happens BEFORE the claim,
 * so a task this factory will not work is never mutated on the board; and the
 * base resolution happens before the claim too, so a repository whose base
 * cannot be proven leaves the task exactly where a human parked it instead of
 * stranding it in `running` with nothing behind it.
 */
type ProcessReadyTaskArgs = {
	deps: KboardPassDeps;
	client: KboardClient;
	task: KboardTask;
	now: Date;
	summary: KboardPassSummary;
};

/**
 * True (and the task skipped, unmutated, with a named reason) when the repo is on
 * `implement_runtime: actions`: the Actions lane implements it, so the
 * board must not queue a box job. The Actions dispatcher (hooks/implement.ts) is
 * a webhook trigger over sop-gate seams this pass does not hold, and its dispatch
 * carries no job id for the board events, so it is NOT wired here.
 */
function skipActionsRuntime(
	task: KboardTask,
	binding: { repository: string; repoConfig: { implement_runtime?: "box" | "actions" } },
	summary: KboardPassSummary,
): boolean {
	if (binding.repoConfig.implement_runtime !== "actions") {
		return false;
	}
	summary.skipped++;
	log("warn", "kboard.implement.actions_runtime_not_wired", {
		task_id: task.task_id,
		repository: binding.repository,
	});
	return true;
}

async function processReadyTask({
	deps,
	client,
	task,
	now,
	summary,
}: ProcessReadyTaskArgs): Promise<void> {
	// Steps 1-4: every cheap local refusal, ALL of them before the claim, so a task
	// this factory will not work is never mutated on the board.
	const gated = await gateReadyTask(deps, task, now, summary);
	// sf#826: an `implement_runtime: actions` repo gets no box job from the board.
	if (gated === null || skipActionsRuntime(task, gated.binding, summary)) {
		return;
	}
	const { binding, repositoryId, itemId, baseSha } = gated;

	// 5. CLAIM. The client reads fresh and CAS-PATCHes `{assignee, status:running}`
	// in one call. Every refusal outcome means the same thing — someone else moved
	// it — and is handled identically: log, skip THIS task THIS pass, never retry.
	const claim = await client.claimTask(task.task_id);
	if (claim.kind !== "ok") {
		summary.refused++;
		log("warn", "kboard.divergence", {
			reason: "claim refused; the task moved under us",
			task_id: task.task_id,
			outcome: claim.kind,
			...(claim.kind === "not_claimable" ? { detail: bounded(claim.reason) } : {}),
		});
		return;
	}

	// 6. The task is now OURS and sits in `running`. From here a failure must not
	// leave it there with nothing behind it, so every path below either creates the
	// job or moves the task to `blocked`.
	const { jobId, createFailure } = await createClaimedJob(deps.db, task.task_id, {
		repositoryId,
		itemId,
		sha: baseSha,
	});

	if (jobId === null) {
		// A claimed task with no job is the one state this station must never leave
		// behind: it would sit in `running` forever, invisible to every other station.
		// Move it to `blocked` and log `runner_failed`, the ruled failure transition.
		summary.failed++;
		await blockClaimedTask(client, task.task_id, createFailure ?? "job creation failed");
		return;
	}

	summary.claimed++;
	log("info", "kboard.claimed", {
		task_id: task.task_id,
		job_id: jobId,
		repository: binding.repository,
		item_number: binding.itemNumber,
	});
	// The `dispatched` event records that the factory took the work. Posted AFTER
	// the job exists so the board never claims a dispatch that did not happen.
	await postEventOrDiverge({
		client,
		taskId: task.task_id,
		jobId,
		eventType: EVENT_DISPATCHED,
		payload: { repository: binding.repository, item_number: binding.itemNumber },
	});
}

/**
 * Create the implement job for a task this pass has already CLAIMED, reporting
 * either its id or the bounded reason creation failed.
 *
 * Never throws: the caller has a claimed task sitting in `running`, and a throw
 * here would leave it there with nothing behind it. Every failure becomes a
 * `createFailure` string the caller turns into the ruled `blocked` transition.
 */
async function createClaimedJob(
	db: WatcherDb,
	taskId: string,
	row: { repositoryId: number; itemId: number; sha: string },
): Promise<{ jobId: number | null; createFailure: string | null }> {
	try {
		const created = await createPendingJob(db, {
			repositoryId: row.repositoryId,
			itemId: row.itemId,
			sha: row.sha,
			jobType: IMPLEMENT_TEMPLATE_ID,
			kboardTaskId: taskId,
		});
		if (!created) {
			// The (repo, item, sha, type) uniqueness key already held a row. The live
			// guards in the gate ruled out a live one, so this is a TERMINAL job for the
			// same base — re-running it would need a new base, which there is not. Treat
			// it as a creation failure so the task does not sit in `running` forever.
			return {
				jobId: null,
				createFailure: "an implement job already exists for this item at this base",
			};
		}
		const jobId = await findCreatedJobId(db, taskId);
		if (jobId === null) {
			return { jobId: null, createFailure: "the created job could not be read back" };
		}
		return { jobId, createFailure: null };
	} catch (err) {
		return { jobId: null, createFailure: errorMessage(err) };
	}
}

/**
 * Read back the job id of the row this pass just created for `taskId`.
 *
 * `createPendingJob` reports only WHETHER it inserted, and widening its return
 * shape would touch every existing caller for one new one. The task id is unique
 * per live job (guarded above), so this is an exact lookup, not a heuristic.
 */
async function findCreatedJobId(db: WatcherDb, kboardTaskId: string): Promise<number | null> {
	const [row] = await db
		.select({ id: jobs.id })
		.from(jobs)
		.where(eq(jobs.kboardTaskId, kboardTaskId))
		.orderBy(desc(jobs.id))
		.limit(1);
	return row?.id ?? null;
}

/**
 * Move a claimed task to `blocked` and log `runner_failed`, the ruled failure
 * transition for a task the factory took but could not run.
 *
 * A board write that itself fails is a DIVERGENCE and is logged as one — the
 * factory knows the run failed, the board does not, and resolving that
 * automatically would mean guessing which system is right. It never throws: the
 * caller has already counted the failure, and a throw here would take a
 * per-task problem into the cycle.
 *
 * The event key uses job id `0` because there is no job — that is the fact being
 * reported. It is stable across retries of the same task's failure, which is
 * exactly what the UNIQUE `idempotency_key` needs.
 */
async function blockClaimedTask(
	client: KboardClient,
	taskId: string,
	reason: string,
): Promise<void> {
	const moved = await client.setStatus(taskId, "blocked");
	if (moved.kind !== "ok") {
		log("error", "kboard.divergence", {
			reason: "claimed task could not be moved to blocked",
			task_id: taskId,
			outcome: moved.kind,
			cause: bounded(reason),
		});
		return;
	}
	await postEventOrDiverge({
		client,
		taskId,
		jobId: 0,
		eventType: EVENT_RUNNER_FAILED,
		// Bounded: the reason may quote a database error, which is operator-facing
		// text and must be clamped before it reaches an external system.
		payload: { reason: bounded(reason) },
	});
}

/** Bounded per-pass counters for the transition reporter. Safe to log as-is. */
export interface KboardTransitionsSummary {
	/** Whether the reporter ran at all (false when no token is configured). */
	enabled: boolean;
	/** Board-claimed jobs whose proposal opened and were moved to `review`. */
	reviewed: number;
	/** Board-claimed jobs that terminal-failed and were moved to `blocked`. */
	blocked: number;
	/** Rows already in their target status; no write sent. */
	converged: number;
}

/**
 * Cap on transitions reported per pass. Same reasoning as the claim cap: one
 * cycle stays predictable, and a remaining backlog reports next cycle.
 */
export const MAX_KBOARD_TRANSITIONS_PER_PASS = 25;

/**
 * Report the ruled OUTCOME transitions for board-claimed jobs (station
 * table rows `running → review` and `running → blocked`).
 *
 * WHY A PASS AND NOT AN INLINE CALL AT EACH SEAM. Both facts this reports —
 * "the proposal opened" and "the job terminal-failed" — become known inside a
 * database transaction holding a `FOR UPDATE` lock on the job row (the publisher's
 * per-row lock, the result store's persist). A k-board HTTP write inside either
 * lock would block every concurrent dispatch for a network round trip and risk a
 * transaction timeout part-way through, which is the SAME reason `proposal-pass`
 * exists outside the ingest transaction rather than inside it. So the transactions
 * record the durable fact and this bounded step, running in the same cycle after
 * the publisher, reports it.
 *
 * IDEMPOTENCE COMES FROM THE BOARD, NOT A LOCAL MARKER. Each row is reported only
 * when a FRESH read shows the task is not already in its target status, so a
 * converged task costs one GET and no write. Belt-and-braces, the writes are
 * idempotent anyway: a `setStatus` to the status a task already holds is a no-op
 * CAS write, and every event carries the ruled run-derived key, so a re-post is a
 * 409 the client reports as `already_logged`. This is why no "reported" column is
 * needed — adding one would create a second place for the two systems to disagree.
 *
 * @param deps - client, db, bounds, error sink
 */
export const runKboardTransitionsPass = traced(
	"kboard.runKboardTransitionsPass",
	async function runKboardTransitionsPass(
		deps: Pick<KboardPassDeps, "db" | "client" | "onError"> & { maxPerPass?: number },
	): Promise<KboardTransitionsSummary> {
		const summary: KboardTransitionsSummary = {
			enabled: false,
			reviewed: 0,
			blocked: 0,
			converged: 0,
		};
		const client = deps.client;
		if (client === null) {
			// The claim pass already emitted the single per-cycle `kboard.disabled_no_token`
			// line; a second one here would double it every cycle for one condition.
			return summary;
		}
		summary.enabled = true;
		const maxPerPass = Math.max(
			1,
			Math.min(deps.maxPerPass ?? MAX_KBOARD_TRANSITIONS_PER_PASS, 500),
		);

		await reportOpenedProposals(deps, client, maxPerPass, summary);
		await reportTerminalFailures(deps, client, maxPerPass, summary);

		return summary;
	},
);

/** The seams both transition halves read and report through. */
type TransitionsDeps = Pick<KboardPassDeps, "db" | "client" | "onError">;

/**
 * (a) PROPOSAL OPENED -> review. A `posted` proposal posting is the durable
 * proof the PR exists, and its `externalRef` IS the PR number the publisher got
 * back from the forge. Joined to the job so only BOARD-CLAIMED jobs are
 * reported; a label-triggered proposal carries no task id and is invisible here.
 */
async function reportOpenedProposals(
	deps: TransitionsDeps,
	client: KboardClient,
	maxPerPass: number,
	summary: KboardTransitionsSummary,
): Promise<void> {
	const proposals = await deps.db
		.select({
			jobId: jobs.id,
			taskId: jobs.kboardTaskId,
			externalRef: githubPostings.externalRef,
		})
		.from(githubPostings)
		.innerJoin(jobs, eq(jobs.id, githubPostings.jobId))
		.where(
			and(
				eq(githubPostings.kind, "proposal"),
				eq(githubPostings.status, "posted"),
				isNotNull(jobs.kboardTaskId),
				isNewestJobForItsTask(deps.db),
			),
		)
		.orderBy(desc(githubPostings.id))
		.limit(maxPerPass);

	for (const row of proposals) {
		const taskId = row.taskId;
		if (taskId === null) continue;
		// The forge's own PR number, round-tripped through a text column. Parsed
		// strictly: a non-integer here means the posting is not what this reports on,
		// and guessing would put a wrong number on the board.
		const prNumber = Number(row.externalRef);
		if (!Number.isInteger(prNumber) || prNumber <= 0) {
			log("warn", "kboard.divergence", {
				reason: "proposal posting carries no usable PR number",
				task_id: taskId,
				job_id: row.jobId,
			});
			continue;
		}
		try {
			if (await alreadyAt(client, taskId, "review")) {
				summary.converged++;
				continue;
			}
			await reportProposalOpened(client, taskId, row.jobId, prNumber);
			summary.reviewed++;
		} catch (err) {
			reportError(deps.onError, err);
		}
	}
}

/**
 * (b) TERMINAL FAILURE -> blocked. `jobs.status = failed` is the seam: it is
 * the ONE place a job reaches a terminal failure, whatever produced it (the
 * result store's ingest outcome, an exhausted dispatch). Reading the job status
 * rather than hooking each writer means a new failure path is reported without
 * a new call site — and the owning boundary stays the job row, which is already
 * the dispatch bookkeeping this station reports on.
 */
async function reportTerminalFailures(
	deps: TransitionsDeps,
	client: KboardClient,
	maxPerPass: number,
	summary: KboardTransitionsSummary,
): Promise<void> {
	const failures = await deps.db
		.select({ jobId: jobs.id, taskId: jobs.kboardTaskId })
		.from(jobs)
		.where(
			and(eq(jobs.status, "failed"), isNotNull(jobs.kboardTaskId), isNewestJobForItsTask(deps.db)),
		)
		.orderBy(desc(jobs.id))
		.limit(maxPerPass);

	for (const row of failures) {
		const taskId = row.taskId;
		if (taskId === null) continue;
		try {
			if (await alreadyAt(client, taskId, "blocked")) {
				summary.converged++;
				continue;
			}
			await reportJobFailed(client, taskId, row.jobId, "job reached a terminal failure");
			summary.blocked++;
		} catch (err) {
			reportError(deps.onError, err);
		}
	}
}

/**
 * Restrict a transition read to the task's NEWEST job — no job with the same
 * `kboard_task_id` and a higher id exists.
 *
 * WHY THIS IS LOAD-BEARING, not tidiness. A task can legitimately be worked more
 * than once: its first job terminal-fails, a human moves the task back to `ready`
 * (phase 2 may automate that), the station claims it again, and a SECOND job row
 * carries the same task id. Without this clause the OLD `failed` row still
 * matches, so every cycle would drag the task back to `blocked` while its new run
 * is live — an automated write undoing a human's decision, and the divergence log
 * would look like the board was fine.
 *
 * A correlated `NOT EXISTS` rather than a window function: the partial
 * `jobs_kboard_task_id_idx` serves it directly, and the semantics ("nothing newer
 * for this task") are the thing being asserted rather than a rank that has to be
 * read as one.
 */
function isNewestJobForItsTask(db: WatcherDb) {
	const newer = alias(jobs, "newer_job");
	return notExists(
		db
			.select({ one: sql`1` })
			.from(newer)
			.where(and(eq(newer.kboardTaskId, jobs.kboardTaskId), gt(newer.id, jobs.id))),
	);
}

/**
 * True when a fresh read shows the task ALREADY holds `status`.
 *
 * A read failure answers FALSE, not true: the report that follows is itself
 * idempotent (a no-op CAS write plus an `already_logged` event), so attempting it
 * costs a round trip, while skipping on an unreadable task would silently drop a
 * transition the board never learned about.
 *
 * A task that reached `done` is also treated as converged — `done` is HUMAN ONLY
 * after merge (ruled), and dragging a merged task back to `review` would undo an
 * operator's decision with an automated write. That is the one status this
 * station must never move off, so it is checked here rather than relied on
 * downstream.
 */
async function alreadyAt(
	client: KboardClient,
	taskId: string,
	status: "review" | "blocked",
): Promise<boolean> {
	const fresh = await client.getTask(taskId);
	if (fresh.kind !== "ok") {
		return false;
	}
	return fresh.value.status === status || fresh.value.status === "done";
}

/**
 * The ruled `running → review` transition: a proposal opened for a board-claimed
 * job (station table). Called from the proposal seam, once, with the PR
 * number the publisher obtained.
 *
 * Sets `repo_pr_number`, moves the task to `review`, and logs `proposal_opened`.
 * Every write is best-effort by design: a board-write failure is a divergence,
 * logged and returned, NEVER a reason to fail the proposal. The proposal is real
 * — the branch is pushed and the PR is open — and unwinding that because a
 * status write failed would destroy work to make two systems agree.
 */
async function reportProposalOpenedImpl(
	client: KboardClient,
	taskId: string,
	jobId: number,
	prNumber: number,
): Promise<void> {
	const numbered = await client.setPrNumber(taskId, prNumber);
	if (numbered.kind !== "ok") {
		log("warn", "kboard.divergence", {
			reason: "proposal PR number not recorded on the board",
			task_id: taskId,
			job_id: jobId,
			outcome: numbered.kind,
		});
	}
	const moved = await client.setStatus(taskId, "review");
	if (moved.kind !== "ok") {
		log("warn", "kboard.divergence", {
			reason: "task not moved to review after a proposal opened",
			task_id: taskId,
			job_id: jobId,
			outcome: moved.kind,
		});
	}
	await postEventOrDiverge({
		client,
		taskId,
		jobId,
		eventType: EVENT_PROPOSAL_OPENED,
		payload: { pr_number: prNumber },
	});
}

/**
 * The ruled `running → blocked` transition: a board-claimed job reached a
 * terminal failure (station table).
 *
 * Same posture as {@link reportProposalOpened} — every write is best-effort, a
 * failure is a logged divergence, and nothing throws into the caller's own
 * failure handling. The job is already terminal in the local database; the board
 * write only mirrors that.
 *
 * NOTE the deliberate one-way-ness. The #95 infra-requeue may revive this job to
 * `pending`, and the task STAYS `blocked` until phase 2 defines `blocked → ready`
 * automation. The ratified table makes that automation a MAY, not a MUST.
 */
async function reportJobFailedImpl(
	client: KboardClient,
	taskId: string,
	jobId: number,
	reason: string,
): Promise<void> {
	const moved = await client.setStatus(taskId, "blocked");
	if (moved.kind !== "ok") {
		log("warn", "kboard.divergence", {
			reason: "failed job's task not moved to blocked",
			task_id: taskId,
			job_id: jobId,
			outcome: moved.kind,
		});
	}
	await postEventOrDiverge({
		client,
		taskId,
		jobId,
		eventType: EVENT_RUNNER_FAILED,
		payload: { reason: bounded(reason) },
	});
}

/*
 * The two transition reporters are declared as `*Impl` and exported as traced
 * consts HERE, at the end of the module, because both are called from
 * `reportOpenedProposals` / `reportTerminalFailures` ABOVE their own
 * definitions. A `const` has no hoisting, so converting the declarations in
 * place would have required reordering the file; the `Impl` form keeps the
 * declaration hoisted for the reader while the exported binding is the traced
 * wrapper every caller resolves at call time.
 */

/** Report a proposal PR opening onto the board (traced; see the block above). */
export const reportProposalOpened = traced(
	"kboard.reportProposalOpened",
	reportProposalOpenedImpl,
) as typeof reportProposalOpenedImpl;

/** Report a terminal job failure onto the board (traced; see the block above). */
export const reportJobFailed = traced(
	"kboard.reportJobFailed",
	reportJobFailedImpl,
) as typeof reportJobFailedImpl;
