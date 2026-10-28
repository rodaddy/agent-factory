/**
 * @module status/query
 * @description Read a bounded, operator-safe status snapshot from the watcher
 *   database. Reports per-repository last-sweep time, issue/PR counts, and job
 *   counts by state, plus a bounded last-error summary. It never selects issue
 *   bodies, runner prompts, raw logs, or secrets — only counts, states, and
 *   already-bounded failure summaries the writer stored.
 *
 *   ONE FIELD IS NOT DB-DERIVED: the host-conflict tripwire is a
 *   process-local tally the ingest observer records into and this query merely
 *   passes through. It is threaded in as an argument rather than read here, so
 *   this module keeps exactly one job.
 *
 * @outputs
 *   - `getStatus` -- assemble the full status snapshot
 *   - `StatusSnapshot` / `RepoStatus` -- the bounded status shapes
 *   - `TracedAttemptStatus` -- one attempt's Langfuse trace id, an ID and
 *     never a URL: the base URL is applied by the renderer, so the internal
 *     Langfuse host never reaches `/status.json`
 *   - `BuildBumpStatus` -- one enrolled (repository, image, environment) and the
 *     tag its promotion rule currently selects (§8 of
 *     `_DOCS/BUILD_BUMP_ENVIRONMENTS.md`), the lane's only operator-visible surface
 *   - `UnconfirmedAllocationStatus` -- an attempt whose allocation returned no
 *     vmid, carrying the identity to match against `runner_list`
 *
 * @dependencies
 *   - drizzle-orm -- aggregate queries
 *   - ../db/schema, ../db/client -- tables and db type
 *   - ../observability/host-conflicts -- the host-conflict tripwire shape
 */
import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import {
	forgeDeliveries,
	githubItems,
	githubPostings,
	jobAttempts,
	jobs,
	reconciliationCursors,
	repositories,
	resultPostings,
	runnerBoxes,
} from "../db/schema";
import { traced } from "../log";
import type { HostConflictStatus } from "../observability/host-conflicts";
import { ITEM_REAPED_TERMINAL_REASON } from "../reconcile/dispatch-pass";
import { ALLOCATING_ATTEMPT_STATUS } from "../runner/attempt-record";
import {
	type BuildBumpRepositoryConfig,
	type BuildBumpStatus,
	buildBumpStatuses,
} from "./build-bump-status";
import type { PassLivenessStatus } from "./pass-liveness";

// Re-exported so `/status.json` consumers keep importing the whole snapshot
// vocabulary from one module; the view itself lives in `./build-bump-status`
// because this file sits against the 500-line `max-lines` bound.
export type { BuildBumpRepositoryConfig, BuildBumpStatus };

/** Per-repository bounded status. */
export interface RepoStatus {
	repository: string;
	/**
	 * The forge this row belongs to (`github` or `forgejo`).
	 *
	 * Uniqueness is provider-qualified, so the SAME `owner/repo` can appear twice
	 * -- live 2026-09-17, four names did. Without this field those rows are
	 * indistinguishable by name alone, which is how `/metrics` came to add a
	 * GitHub row frozen at the Forge flag day (2026-08-28/30) to the live
	 * Forgejo row and report a total that described neither.
	 */
	provider: string;
	checks: string;
	/** Newest reconciliation cursor value, or null if never swept. */
	lastSweep: string | null;
	issueCount: number;
	pullCount: number;
	jobsPending: number;
	jobsRunning: number;
	jobsCompleted: number;
	/** Jobs CURRENTLY in `failed`; an infra requeue moves one back to pending, so it can drop. */
	jobsFailed: number;
	/** Bounded last-error summary, or null. Never contains secrets or logs. */
	lastError: string | null;
}

/** Whole-watcher status snapshot. */
export interface StatusSnapshot {
	generatedAt: string;
	repositories: RepoStatus[];
	/**
	 * Runner boxes the watcher currently believes are held, newest claim first.
	 *
	 * This is the pool view that survives a restart. A row here whose job is no
	 * longer live is a LEAKED box — reap it by vmid. Before this existed nothing
	 * could name a stranded box at all: the operator had to run
	 * `runner_list` by hand and compare it against nothing.
	 *
	 * Empty on a watcher whose pool is idle, which is the normal steady state.
	 */
	heldBoxes: HeldBoxStatus[];
	/**
	 * Attempts whose allocation NEVER returned a vmid, and which are therefore
	 * likely to have left a box running that nothing can otherwise name.
	 *
	 * Distinct from {@link heldBoxes} in the direction of the unknown, which is why
	 * it is a separate field rather than more rows on that one: `heldBoxes` lists
	 * boxes the watcher KNOWS it claimed, so a stale row there is a leak it can
	 * already name. This lists attempts the watcher could not attach a vmid to at
	 * all — the harm is that the box exists and no row points at it.
	 *
	 * SURFACING ONLY. Each entry carries the literal LIST command — not a reap —
	 * because no vmid is known for these rows by construction, and NOTHING in this
	 * codebase acts on them automatically: a timed-out allocation verb probably
	 * SUCCEEDED server-side, so an automatic power-off would act on an inference
	 * about a box that was never named. The operator lists, matches the job id, and
	 * decides.
	 *
	 * Empty on a healthy watcher, which is the normal steady state.
	 */
	unconfirmedAllocations: UnconfirmedAllocationStatus[];
	/**
	 * The newest attempts carrying a Langfuse trace id, newest first, so an
	 * operator reaches the trace for a recent run from the page instead of writing
	 * a query. Bounded to `RECENT_TRACE_LIMIT` rows.
	 *
	 * IDS ONLY ON THIS SNAPSHOT — this is `/status.json`, and a trace URL baked in
	 * here would put the internal Langfuse host into a JSON document. The base URL
	 * is applied at HTML RENDER time (`../status/render`), by the one surface that
	 * is allowed to know it. With no `LANGFUSE_BASE_URL` in the environment the
	 * page renders the id as plain text and this field is unaffected.
	 *
	 * Empty on any watcher that has ingested no observed attempt, which includes
	 * every deployment before #184 and every one whose lanes write no event stream.
	 */
	tracedAttempts: TracedAttemptStatus[];
	/**
	 * The host-conflict tripwire: how often two hosts attested DIFFERENT
	 * models for one attempt since this process started, plus the last one's
	 * attempt id and host/model pairs.
	 *
	 * OPTIONAL, and the only non-DB-derived field on this snapshot. Every other
	 * field is read out of the watcher database; this one is a process-local tally
	 * the ingest observer records into (see `../observability/host-conflicts` for
	 * why it is not persisted). Absent when no tally is supplied — the doctor
	 * probe assembles a snapshot from the db alone and has no observer to read.
	 */
	hostConflicts?: HostConflictStatus;
	/**
	 * Whether the reconciliation LOOP is turning: when the last pass
	 * STARTED, the last completed pass's counts, and the per-repository errors
	 * behind its fail count.
	 *
	 * The SECOND non-DB-derived field group, and process-local for the same reason
	 * `hostConflicts` is (see `../status/pass-liveness`). It is a distinct claim
	 * from every repository's `lastSweep` cursor above: a cursor answers "did this
	 * repo have work reconciled", so an idle-but-healthy watcher advances none,
	 * and cursor age therefore cannot distinguish idle from wedged.
	 *
	 * SPREAD FLAT ONTO THE SNAPSHOT rather than nested under one key, because the
	 * `/status.json` contract this repo already deploys is a flat object and the
	 * done-means check (`scripts/done-means/factory-pass-liveness.sh`) pins
	 * `lastPassStartedAt` at the top level. Every field is optional, so an existing
	 * consumer of `/status.json` — including sf#253 — sees only additions.
	 */
	lastPassStartedAt?: PassLivenessStatus["lastPassStartedAt"];
	/** @see lastPassStartedAt — the same #252 record, spread flat. */
	lastPassFinishedAt?: PassLivenessStatus["lastPassFinishedAt"];
	/** @see lastPassStartedAt */
	lastPassOk?: PassLivenessStatus["lastPassOk"];
	/** @see lastPassStartedAt */
	lastPassFailCount?: PassLivenessStatus["lastPassFailCount"];
	/** @see lastPassStartedAt — the per-repository detail behind the fail count. */
	lastPassRepoErrors?: PassLivenessStatus["lastPassRepoErrors"];
	/** @see lastPassStartedAt */
	passesStarted?: PassLivenessStatus["passesStarted"];
	/** @see lastPassStartedAt */
	passesCompleted?: PassLivenessStatus["passesCompleted"];
	/**
	 * Pending jobs whose bound item is CLOSED — the starved-queue gauge.
	 *
	 * A closed item can never become eligible again, so such a row is a ZOMBIE: it
	 * re-arms every defer window and re-takes an id-ordered slot in the dispatch
	 * shortlist forever. Observed live 2026-08-30 at 41 rows, starving a fresh
	 * implement-lane job at `MAX_DISPATCH_PER_PASS=3`. The sf#481
	 * dispatch-time reap terminalizes them, so the HEALTHY reading is 0 and any
	 * non-zero value means the reap is not keeping up — or is not running.
	 *
	 * Counted through the SAME left join the dispatch shortlist uses, so a job
	 * bound to no item (repo-validate, audit) is never a zombie.
	 *
	 * SURFACING ONLY, per the owner ruling on sf#482: this reports the condition and
	 * nothing acts on it here. Remediation is the reap's job; paging is the
	 * existing monitoring path's.
	 *
	 * OPTIONAL like every field added after the first `/status.json` shipped: a
	 * snapshot assembled elsewhere (the doctor probe) or captured before sf#482
	 * carries no key, and absent is honestly distinct from a zero it never measured.
	 */
	zombiePending?: number;
	/**
	 * Whole minutes since the oldest DUE pending job's `next_attempt_at`,
	 * or null when no pending job is due.
	 *
	 * DUE, not merely pending: a row deferred forward is backoff working as
	 * designed, and counting it would report a negative age as the queue's worst
	 * case. Null rather than 0 for an empty queue — 0 reads as "perfectly fresh",
	 * which is the opposite claim from "there is nothing waiting".
	 *
	 * This is the gauge that moves FIRST when dispatch wedges for any reason,
	 * zombies included: the oldest due row keeps ageing while nothing reaches it.
	 *
	 * @see zombiePending for why this is optional.
	 */
	oldestDuePendingMinutes?: number | null;
	/**
	 * Jobs the sf#481 dispatch-time reap terminalized recently — whether
	 * the reaper is FIRING, as distinct from whether zombies exist.
	 *
	 * WINDOW: a FIXED TRAILING 20 MINUTES, ending at `now`. The pass-liveness record
	 * would be the tighter source, but it is process-local and OPTIONAL on this
	 * snapshot (a caller that drives no scheduler omits it), so deriving the window
	 * from it would make this gauge silently absent on exactly the callers that
	 * still read the database fine. A fixed window is honest about what it measures
	 * and needs no argument the caller may not have. 20 minutes is comfortably more
	 * than one poll cadence, so a single sweep's reaps stay inside it.
	 *
	 * Matched on the reap's OWN terminal reason (the exported constant, not a copy
	 * of the string), so a job terminalized for any other cause is not counted.
	 *
	 * @see zombiePending for why this is optional.
	 */
	reapedLastSweep?: number;
	/**
	 * The build-bump lane's per-environment desired state
	 * (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §8), one entry per enrolled
	 * (repository, image, environment).
	 *
	 * THE ONLY PLACE THE LANE IS VISIBLE. Every other record of what an
	 * environment wants and what happened to it is a row in `build_bump_*` on a
	 * loopback-only box, and §6 made the lane self-healing — a pair that fails
	 * returns to `pending` forever rather than landing in a terminal state — so
	 * "stuck" and "quiet" are indistinguishable without this. §10 item 4 is the
	 * acceptance property: a forced failure SHOWS HERE within three passes.
	 *
	 * DESIRED, not deployed. `desiredTag` is what the environment's promotion rule
	 * selects right now; `lastPr`/`lastOutcome` say what the most recent attempt to
	 * reach it did. A repository enrolled to build and owning no app directory
	 * contributes no entry at all, because it has no environment to report.
	 *
	 * Empty when no repository is enrolled, or when the caller supplies no
	 * enrolment blocks — see `ProcessLocalStatus.buildBumpRepositories`.
	 *
	 * OPTIONAL like every field added after the first `/status.json` shipped: a
	 * snapshot assembled by hand elsewhere carries no key, and absent is honestly
	 * distinct from an empty array meaning "enrolment read, nothing enrolled".
	 * `getStatus` itself always populates it.
	 */
	buildBump?: BuildBumpStatus[];
	/**
	 * The factory's cumulative WORK totals (surface D), read from the
	 * database. See {@link WorkStatus} for each source and why it never decreases.
	 *
	 * @see zombiePending for why this is optional.
	 */
	work?: WorkStatus;
	/**
	 * Critical-alert deliveries since process start, split by whether the
	 * operator can now see the issue. PROCESS-LOCAL, passed through like
	 * `hostConflicts`; absent when the caller holds no tally.
	 */
	alertDeliveries?: AlertDeliveryTally;
}

/** Critical-alert outcomes since process start; each field only grows. */
export interface AlertDeliveryTally {
	delivered: number;
	undelivered: number;
}

/**
 * Cumulative work totals. Every count reads a table whose counted rows
 * are never deleted and never leave the counted state, so each is monotonic and
 * typed a counter -- except `jobsByStatus`, a point-in-time depth (a gauge).
 */
export interface WorkStatus {
	/** `job_attempts` rows past `allocating` -- the only attempt rows ever deleted. */
	dispatches: number;
	/** `result_postings` rows: every ingest, valid or invalid, one per (job, target). */
	resultsIngested: number;
	/** `github_postings` rows with `posted_at` set; `markPosted` is its only writer. */
	publicationsPosted: number;
	/** `forge_deliveries` rows by event; the table is insert-only. */
	webhookDeliveries: { event: string; count: number }[];
	/** `jobs` rows by current status -- moves both ways, so a gauge. */
	jobsByStatus: { status: string; count: number }[];
}

/**
 * How many traced attempts the page carries.
 *
 * Small on purpose: this is a "reach the run I just watched" affordance, not a
 * run history, and the snapshot is rebuilt on every request. The durable record
 * is the `job_attempts` table, which holds every trace id and is one query away.
 */
const RECENT_TRACE_LIMIT = 20;

/** One attempt whose run was observed and emitted under a Langfuse trace. */
export interface TracedAttemptStatus {
	/** The internal attempt id — the same `attempt M` a factory comment names. */
	attemptId: number;
	/** The job the attempt belongs to; the trace's Langfuse session is `job-N`. */
	jobId: number;
	/** The lane, so a row is identifiable without cross-referencing the job. */
	jobType: string;
	repository: string;
	/**
	 * The Langfuse trace id, host-qualified `attempt-N-<host>`. AN ID, NOT A URL:
	 * the link is composed in the renderer from `LANGFUSE_BASE_URL`, so nothing
	 * internal reaches `/status.json`.
	 */
	traceId: string;
	/** ISO-8601 attempt start, or null on a row predating the timestamp default. */
	startedAt: string | null;
}

/** One runner box the watcher believes is held, and by what. */
export interface HeldBoxStatus {
	vmid: number;
	band: string;
	/** `null` for a template band, which is never served an address. */
	ip: string | null;
	/** The runner job id holding it. */
	heldByJobId: string;
	/** ISO-8601, or null if the claim predates the timestamp column. */
	heldAt: string | null;
}

/**
 * One attempt whose allocation never returned a vmid.
 *
 * DB-DERIVED ONLY, and the boundary matters. This module reads the watcher
 * database and never calls a fleet verb — a status page that made a ~60s MCP call
 * would be a status page that hangs. The `allocating`/null-vmid ROWS live in the
 * database, so naming them here is honest; matching them to a live box does not,
 * and that is the reconcile pass's job (`surfaceUnconfirmedAllocations`), whose
 * findings reach the operator through the log.
 *
 * So `vmid` is deliberately absent from this shape: the whole condition is that
 * no vmid was ever returned. What the operator gets is the `runnerJobId` to match
 * against `runner_list`, and the literal command to run first.
 */
export interface UnconfirmedAllocationStatus {
	/** The attempt row's id. */
	attemptId: number;
	/** The job whose dispatch entered `runner_needed` and never got a box name. */
	jobId: number;
	/** The identity the fleet would have stamped on any box it placed. */
	runnerJobId: string;
	/** ISO-8601 attempt start. */
	startedAt: string | null;
	/** The literal command that lists the fleet so the operator can match `runnerJobId`. */
	listCommand: string;
}

/**
 * The fixed command an operator runs to see the fleet's own box list.
 *
 * Deliberately the LIST verb rather than a reap: no vmid is known for these rows
 * by construction, and printing a `runner_done` for a vmid nobody has confirmed
 * would be inviting an operator to power off a box on a guess. List first, match
 * the job id, then reap by the vmid that matching produced.
 */
export const UNCONFIRMED_ALLOCATION_LIST_COMMAND = "mcp2cli runner-boxes runner_list --params '{}'";

/**
 * The trailing window `reapedLastSweep` counts reaps within.
 *
 * Fixed rather than derived from pass liveness — see the field's docstring for
 * why. Wider than any configured poll cadence, so one sweep's reaps are never
 * split across the boundary.
 */
const REAP_WINDOW_MINUTES = 20;

/** Cap on unconfirmed-allocation rows the status page reports. */
const UNCONFIRMED_ALLOCATION_LIMIT = 20;

/** Bound a stored failure summary defensively before it leaves the DB. */
function boundError(value: string | null): string | null {
	if (value === null) {
		return null;
	}
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
}

/**
 * The snapshot fields that are NOT read from the database.
 *
 * Grouped into one argument rather than a growing positional tail (#252 would
 * have made a fifth): they share a property, which is that a caller unable to
 * observe the value OMITS it and the field is then absent rather than reported
 * as a false zero. Both members are process-local records the daemon holds in
 * memory beside this query.
 */
export interface ProcessLocalStatus {
	/**
	 * The ingest observer's host-conflict tally. Omitted by callers with no
	 * observer (the doctor probe).
	 */
	hostConflicts?: HostConflictStatus;
	/**
	 * The scheduler's pass-liveness record. Omitted by callers that drive no
	 * scheduler (the doctor probe): a probe reporting `lastPassStartedAt: null`
	 * would be indistinguishable from a genuinely wedged watcher.
	 */
	passLiveness?: PassLivenessStatus;
	/**
	 * The managed-repository entries whose `build_bump` block defines the enrolled
	 * environments (§8). Config-derived rather than process-local, but it rides in
	 * this grouped argument for the reason the group exists at all: a fifth
	 * positional parameter trips the `max-params` ceiling `lint:size` enforces
	 * (probed — oxlint errors at 5, max is 4), and every caller that cannot supply
	 * it should OMIT it rather than be forced to pass a placeholder.
	 *
	 * Absent yields an empty `buildBump` array, which is the honest answer for a
	 * caller holding no config (the doctor probe).
	 */
	buildBumpRepositories?: readonly BuildBumpRepositoryConfig[];
	/** The critical-alert delivery tally; omitted by callers holding none. */
	alertDeliveries?: AlertDeliveryTally;
}

/**
 * Assemble the status snapshot.
 *
 * @param db - watcher database
 * @param now - current time as ISO-8601 (injected for deterministic tests)
 * @param processLocal - the non-DB-derived fields; see `ProcessLocalStatus`
 */
async function getStatusImpl(
	db: WatcherDb,
	now: string,
	processLocal: ProcessLocalStatus = {},
): Promise<StatusSnapshot> {
	// Ordered by name AND id, so the sequence is TOTAL. `fullName` alone is not a
	// unique key -- several rows can share a name (live 2026-09-17:
	// `rtech/rtech-infra`, `rodaddy/software-factory`, `rodaddy/mcp2cli`, and
	// `rodaddy/rtech-mcps` each had two) and Postgres leaves the order of equal
	// sort keys undefined, so their relative position could change between reads.
	// Every consumer of this snapshot then sees rows shuffle for no reason; for
	// `/metrics` specifically, a tie-broken-by-position value would flap between
	// scrapes and an alert would read that as a real state change.
	const repos = await db
		.select({
			id: repositories.id,
			name: repositories.fullName,
			provider: repositories.provider,
			checks: repositories.checks,
		})
		.from(repositories)
		.orderBy(repositories.fullName, repositories.id);

	const out: RepoStatus[] = [];
	for (const repo of repos) {
		out.push(await repoStatusFor(db, repo));
	}

	const heldBoxes = await heldBoxStatuses(db);

	// The #184 acceptance property, made a page rather than a query an operator has
	// to remember: pick a recent attempt, get its trace.
	const tracedAttempts = await tracedAttemptStatuses(db);

	// sf#179: attempts whose allocation never returned a vmid. A box is probably
	// running under the attempt's runner job id and no row can point at it.
	const unconfirmedAllocations = await unconfirmedAllocationStatuses(db);

	// sf#482: whether the dispatch queue is STARVED, and whether the sf#481 reap is
	// firing. Surfacing only — nothing here acts on any of the three.
	const gauges = await reaperGauges(db, now);

	// §8: the build-bump lane's desired state per environment. Empty when the
	// caller holds no enrolment config, which is honest — it measured nothing.
	const buildBump = await buildBumpStatuses(db, processLocal.buildBumpRepositories ?? []);

	// sf#824: the cumulative work totals `/metrics` exposes as counters.
	const work = await workStatus(db);

	return {
		generatedAt: now,
		buildBump,
		repositories: out,
		heldBoxes,
		unconfirmedAllocations,
		tracedAttempts,
		zombiePending: gauges.zombiePending,
		oldestDuePendingMinutes: gauges.oldestDuePendingMinutes,
		reapedLastSweep: gauges.reapedLastSweep,
		work,
		hostConflicts: processLocal.hostConflicts,
		alertDeliveries: processLocal.alertDeliveries,
		// Spread flat: the liveness fields are top-level on `/status.json` (see the
		// StatusSnapshot docblock). A caller that supplies no tracker leaves every one
		// of them absent rather than reporting a false "no pass has ever started".
		...processLocal.passLiveness,
	};
}

export const getStatus = traced("status.getStatus", getStatusImpl) as typeof getStatusImpl;

/**
 * The three reaper-health gauges, read in ONE round trip.
 *
 * ONE QUERY, not three, and the reason is that all three describe the same
 * instant: read separately, a reap landing between two of them could report a
 * zombie count and a reaped count that never coexisted, and an operator would be
 * reconciling a state the database never held.
 *
 * The zombie count reuses the dispatch shortlist's own LEFT join
 * (`src/reconcile/dispatch-pass.ts`, `selectDuePendingJobs`), so "bound to a
 * closed item" means here exactly what it means at the moment dispatch decides.
 * An INNER join would have counted every pending row on a repo with no items at
 * all, which is why the left join is load-bearing rather than stylistic.
 *
 * Every value is a bounded number or null; nothing repository-authored is read.
 */
async function reaperGauges(
	db: WatcherDb,
	now: string,
): Promise<{
	zombiePending: number;
	oldestDuePendingMinutes: number | null;
	reapedLastSweep: number;
}> {
	const nowDate = new Date(now);
	const windowStart = new Date(nowDate.getTime() - REAP_WINDOW_MINUTES * 60_000);
	const [row] = await db
		.select({
			zombiePending: sql<number>`count(*) filter (where ${jobs.status} = 'pending' and ${githubItems.state} = 'closed')::int`,
			// The oldest DUE next_attempt_at, or null when nothing is due. Computed in
			// SQL so "oldest" is decided by the same read that counts the rest.
			// A NULL next_attempt_at is DUE — dispatch selects with (IS NULL OR <= now)
			// (dispatch-pass.ts), so the gauge shares that predicate and ages a NULL
			// row from created_at, the moment it became due.
			oldestDue: sql<Date | null>`min(coalesce(${jobs.nextAttemptAt}, ${jobs.createdAt})) filter (where ${jobs.status} = 'pending' and (${jobs.nextAttemptAt} is null or ${jobs.nextAttemptAt} <= ${nowDate}))`,
			reapedLastSweep: sql<number>`count(*) filter (where ${jobs.terminalReason} = ${ITEM_REAPED_TERMINAL_REASON} and ${jobs.updatedAt} >= ${windowStart})::int`,
		})
		.from(jobs)
		.leftJoin(githubItems, eq(githubItems.id, jobs.itemId));

	const oldestDue = row?.oldestDue ?? null;
	return {
		zombiePending: row?.zombiePending ?? 0,
		oldestDuePendingMinutes:
			oldestDue === null
				? null
				: Math.floor((nowDate.getTime() - new Date(oldestDue).getTime()) / 60_000),
		reapedLastSweep: row?.reapedLastSweep ?? 0,
	};
}

/**
 * The cumulative work totals, one aggregate per table.
 *
 * Plain `count(*)` reads: each counted set only grows (see {@link WorkStatus}),
 * which is what makes the `_total` counter type honest. Label sources are
 * `jobs.status` (internal vocabulary) and `forge_deliveries.event` (the forge's
 * HMAC-admitted event name; escaped by the renderer).
 */
async function workStatus(db: WatcherDb): Promise<WorkStatus> {
	const [attempts] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(jobAttempts)
		.where(sql`${jobAttempts.status} <> ${ALLOCATING_ATTEMPT_STATUS}`);
	const [ingested] = await db.select({ n: sql<number>`count(*)::int` }).from(resultPostings);
	const [posted] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(githubPostings)
		.where(isNotNull(githubPostings.postedAt));
	const webhookDeliveries = await db
		.select({ event: forgeDeliveries.event, count: sql<number>`count(*)::int` })
		.from(forgeDeliveries)
		.groupBy(forgeDeliveries.event)
		.orderBy(forgeDeliveries.event);
	const jobsByStatus = await db
		.select({ status: jobs.status, count: sql<number>`count(*)::int` })
		.from(jobs)
		.groupBy(jobs.status)
		.orderBy(jobs.status);
	return {
		dispatches: attempts?.n ?? 0,
		resultsIngested: ingested?.n ?? 0,
		publicationsPosted: posted?.n ?? 0,
		webhookDeliveries,
		jobsByStatus,
	};
}

/**
 * Runner boxes the watcher believes are held, newest claim first.
 *
 * Extracted from {@link getStatus} to keep it inside the function-length
 * ceiling, exactly as `tracedAttemptStatuses` already is; the query, the order,
 * and the null-narrowing are unchanged.
 */
async function heldBoxStatuses(db: WatcherDb): Promise<HeldBoxStatus[]> {
	// Newest claim first: a stale claim is the interesting one, and it sorts to the
	// bottom where the list stays short. `heldAt` may be null on a claim written
	// before the column existed, so break ties on vmid for a stable order.
	const held = await db
		.select({
			vmid: runnerBoxes.vmid,
			band: runnerBoxes.band,
			ip: runnerBoxes.ip,
			heldByJobId: runnerBoxes.heldByJobId,
			heldAt: runnerBoxes.heldAt,
		})
		.from(runnerBoxes)
		.where(isNotNull(runnerBoxes.heldByJobId))
		.orderBy(desc(runnerBoxes.heldAt), asc(runnerBoxes.vmid));

	const heldBoxes: HeldBoxStatus[] = held.flatMap((box) =>
		// The WHERE clause already excludes null holders; this narrows the type
		// without asserting, so a schema change cannot turn into a lying non-null.
		box.heldByJobId === null
			? []
			: [
					{
						vmid: box.vmid,
						band: box.band,
						ip: box.ip,
						heldByJobId: box.heldByJobId,
						heldAt: box.heldAt?.toISOString() ?? null,
					},
				],
	);
	return heldBoxes;
}

/**
 * Attempts still in `allocating` with NO vmid — the rows whose
 * allocation verb never returned a box name.
 *
 * NO AGE FILTER, unlike the reconcile pass that surfaces the same condition. The
 * two answer different questions: the pass decides when to ACT (log a candidate,
 * hand an operator a command), so it waits out the window during which the verb
 * may legitimately still be in flight. This is a status page, where the honest
 * answer to "what is allocating right now" includes the row that is thirty
 * seconds old. Filtering by age here would hide a live allocation storm behind an
 * empty section.
 *
 * A null `runner_job_id` is EXCLUDED: without the identity there is nothing an
 * operator could match against `runner_list`, so the row is noise rather than a
 * lead. Ordered oldest-first, because the oldest is the likeliest real leak.
 */
async function unconfirmedAllocationStatuses(
	db: WatcherDb,
): Promise<UnconfirmedAllocationStatus[]> {
	const rows = await db
		.select({
			attemptId: jobAttempts.id,
			jobId: jobAttempts.jobId,
			runnerJobId: jobAttempts.runnerJobId,
			startedAt: jobAttempts.startedAt,
		})
		.from(jobAttempts)
		.where(
			and(
				eq(jobAttempts.status, ALLOCATING_ATTEMPT_STATUS),
				isNull(jobAttempts.runnerVmid),
				isNotNull(jobAttempts.runnerJobId),
			),
		)
		.orderBy(asc(jobAttempts.id))
		.limit(UNCONFIRMED_ALLOCATION_LIMIT);
	return rows.flatMap((row) =>
		// The WHERE already excludes a null identity; this narrows the type without
		// asserting, exactly as `heldBoxes` does.
		row.runnerJobId === null
			? []
			: [
					{
						attemptId: row.attemptId,
						jobId: row.jobId,
						runnerJobId: row.runnerJobId,
						startedAt: row.startedAt?.toISOString() ?? null,
						listCommand: UNCONFIRMED_ALLOCATION_LIST_COMMAND,
					},
				],
	);
}

/**
 * The newest attempts that carry a Langfuse trace id.
 *
 * THE FILTER IS IN SQL, BEFORE THE LIMIT, and that ordering is the correctness
 * property rather than an optimization. `LIMIT` applies in the database: with the
 * predicate moved into the mapper instead, 20 newer untraced attempts consume the
 * whole limit, every one is dropped, and the page shows an EMPTY section while
 * traced rows sit in the table. Proven by mutation — removing the `WHERE` fails
 * `tests/status/query.test.ts` on a 25-untraced-attempt fixture and passes on a
 * small one, which is exactly why the fixture seeds past the limit.
 *
 * Ordered by attempt id rather than `startedAt`: the id is the monotonic,
 * never-null key, while two attempts can share a timestamp.
 */
async function tracedAttemptStatuses(db: WatcherDb): Promise<TracedAttemptStatus[]> {
	const traced = await db
		.select({
			attemptId: jobAttempts.id,
			jobId: jobAttempts.jobId,
			jobType: jobs.jobType,
			repository: repositories.fullName,
			traceId: jobAttempts.traceId,
			startedAt: jobAttempts.startedAt,
		})
		.from(jobAttempts)
		.innerJoin(jobs, eq(jobs.id, jobAttempts.jobId))
		.innerJoin(repositories, eq(repositories.id, jobs.repositoryId))
		.where(isNotNull(jobAttempts.traceId))
		.orderBy(desc(jobAttempts.id))
		.limit(RECENT_TRACE_LIMIT);

	return traced.flatMap((row) =>
		// The WHERE already excludes a null trace id; this narrows the type without
		// asserting, exactly as `heldBoxes` does, so a later schema change cannot
		// turn into a lying non-null.
		row.traceId === null
			? []
			: [
					{
						attemptId: row.attemptId,
						jobId: row.jobId,
						jobType: row.jobType,
						repository: row.repository,
						traceId: row.traceId,
						startedAt: row.startedAt?.toISOString() ?? null,
					},
				],
	);
}

/** The bounded per-repository rollup: item counts, job counts, cursor, last error. */
/**
 * The failure summary of the NEWEST ATTEMPT for a repository -- `null` when that
 * attempt succeeded, and undefined when the repository has no attempts at all.
 *
 * CURRENT STATE, NOT HISTORY. This previously filtered
 * `failure_summary is not null` BEFORE ordering, which selects the newest
 * FAILURE EVER rather than the newest attempt. A repository that failed once
 * then succeeded a thousand times still reported that first failure forever, so
 * `factory_repo_last_error` was effectively `has_ever_failed` and an alert built
 * on it could never clear. The filter is gone: the newest attempt answers, and a
 * successful newest attempt carries a null summary, which is the "recovered"
 * signal that was previously unreachable.
 *
 * This also corrects the HTML status page, which renders the same field and had
 * the same sticky behaviour.
 */
async function newestFailureSummary(
	db: WatcherDb,
	repositoryId: number,
): Promise<{ summary: string | null } | undefined> {
	const [row] = await db
		.select({ summary: jobAttempts.failureSummary })
		.from(jobAttempts)
		.innerJoin(jobs, eq(jobs.id, jobAttempts.jobId))
		.where(eq(jobs.repositoryId, repositoryId))
		// `id desc` is a REQUIRED tie-breaker, not decoration: two attempts can share
		// a `startedAt` to the millisecond, and Postgres may then return either one.
		// When a failed and a successful attempt tie, `lastError` -- and the
		// `factory_repo_last_error` metric built on it -- flaps between scrapes, and
		// an alert reads that as a real state change.
		.orderBy(sql`${jobAttempts.startedAt} desc, ${jobAttempts.id} desc`)
		.limit(1);
	return row;
}

async function repoStatusFor(
	db: WatcherDb,
	repo: { id: number; name: string; provider: string; checks: RepoStatus["checks"] },
): Promise<RepoStatus> {
	const [items] = await db
		.select({
			issues: sql<number>`count(*) filter (where ${githubItems.kind} = 'issue')::int`,
			pulls: sql<number>`count(*) filter (where ${githubItems.kind} = 'pull')::int`,
		})
		.from(githubItems)
		.where(eq(githubItems.repositoryId, repo.id));

	const [jobCounts] = await db
		.select({
			pending: sql<number>`count(*) filter (where ${jobs.status} = 'pending')::int`,
			running: sql<number>`count(*) filter (where ${jobs.status} in ('running', 'dispatching'))::int`,
			completed: sql<number>`count(*) filter (where ${jobs.status} = 'completed')::int`,
			failed: sql<number>`count(*) filter (where ${jobs.status} = 'failed')::int`,
		})
		.from(jobs)
		.where(eq(jobs.repositoryId, repo.id));

	const [cursor] = await db
		.select({ cursor: reconciliationCursors.cursor })
		.from(reconciliationCursors)
		.where(
			and(
				eq(reconciliationCursors.repositoryId, repo.id),
				eq(reconciliationCursors.resource, "issues"),
			),
		)
		.limit(1);

	const lastErr = await newestFailureSummary(db, repo.id);

	return {
		repository: repo.name,
		provider: repo.provider,
		checks: repo.checks,
		lastSweep: cursor?.cursor ?? null,
		issueCount: items?.issues ?? 0,
		pullCount: items?.pulls ?? 0,
		jobsPending: jobCounts?.pending ?? 0,
		jobsRunning: jobCounts?.running ?? 0,
		jobsCompleted: jobCounts?.completed ?? 0,
		jobsFailed: jobCounts?.failed ?? 0,
		lastError: boundError(lastErr?.summary ?? null),
	};
}
