/**
 * @module doctor/deploy-verdicts
 * @description `doctor deploy-verdicts --since <iso8601> [--wait <seconds>]`
 *   (lanes 605b + 605c): the job-completes verify for a deploy. For every
 *   lane that dispatched since `--since` (normally the watcher unit's start time),
 *   it requires a VERDICT published for a job of that lane dispatched since then.
 *
 *   LANES (605c item 4) are the enabled job types from config (`enabledConfigLanes`)
 *   UNION every job type dispatched in the window UNION every Forgejo Actions
 *   workflow file with a `forge_runs` row dispatched in the window. A job type that
 *   only exists in old `jobs` rows is no longer listed.
 *
 *   A VERDICT (605c item 1) is a `github_postings` row with status `posted` and
 *   `posted_at >= since` that is a check (judged by its conclusion), a label ADD of a
 *   result label (`watcher:passed` / `watcher:skipped` ok; `watcher:hold` /
 *   `watcher:failed` / `watcher:error` failed), or an issue plan (an audit
 *   finding, ok). SHA-less jobs (triage, audit) never get a check, so the label or
 *   the issue is their only verdict. Comments and label removes never count. A
 *   posting that has a `shadow_publications` row never reached the forge and is not
 *   a verdict (605c item 2). For a forge_runs lane the verdict is the run state:
 *   `success` / `failure`; `unknown` is still in flight, `cancelled` is none.
 *
 *   An AUDIT job (no item, no SHA) with zero findings publishes nothing BY DESIGN.
 *   When its job row is `completed` (the result ingest path sets that only for an
 *   ingested, passing result: src/results/store.ts:116) and it has no posting at
 *   all, it is POSTED_NOTHING, an ok class.
 *
 *   The published verdict is the outcome record. `job_attempts.status` is read ONLY
 *   to tell a still-running job (latest attempt outside TERMINAL_ATTEMPT_STATUSES,
 *   or a job row requeued to pending/dispatching/running) from a finished one. It is NEVER read as success: `completed`
 *   there means a valid result was INGESTED, and the result's own verdict can be
 *   `error` (src/results/store.ts:98-100; AGENTS.md trap).
 *
 *   One line per lane:
 *     [POSTED] <lane>: <n>                                n jobs with a non-failure verdict
 *     [POSTED_NOTHING] <lane>: dispatched n, completed with nothing to post m
 *                                                         audit jobs with zero findings (ok)
 *     [FAILED_VERDICT] <lane>: dispatched n, failed m     every verdict is a failure
 *     [IN_FLIGHT] <lane>: dispatched n, in flight m       no verdict yet, still running
 *     [UNKNOWN_CONCLUSION] <lane>: dispatched n, unknown conclusion m
 *                                                         only checks with a missing or
 *                                                         unrecognised conclusion: NOT a verdict
 *     [NO_VERDICT] <lane>: dispatched n, posted 0         finished and nothing posted
 *     [UNKNOWN] <lane>: not dispatched since <iso>        a config lane with no dispatch
 *   `--wait <seconds>` re-reads until no lane is IN_FLIGHT or the budget ends.
 *   Exit 0 iff no lane is NO_VERDICT, UNKNOWN_CONCLUSION or IN_FLIGHT, 1 otherwise, 2 on bad args,
 *   3 on a config/DB/harness error.
 *
 * @outputs
 *   - `parseDeployVerdictsArgs` -- parse `--since`, `--wait`, `--config`
 *   - `enabledConfigLanes` -- the job types a loaded config can dispatch
 *   - `readLaneTallies` -- per-lane verdict counts and earliest dispatch since a time
 *   - `runDeployVerdicts` -- classify lanes against a db and print the report
 *   - `runDeployVerdictsCommand` -- CLI adapter: load config, build the db, run
 *
 * @dependencies
 *   - ../db/client -- createDb / WatcherDb
 *   - ../db/schema -- jobs, job_attempts, github_postings, shadow_publications, forge_runs
 *   - ../config/load -- loadConfig
 *   - ../reconcile/attempt-lifecycle -- TERMINAL_ATTEMPT_STATUSES
 */
import { and, eq, gte, inArray, isNull, min } from "drizzle-orm";
import { loadConfig } from "../config/load";
import type { WatcherConfig } from "../config/schema";
import { createDb, type WatcherDb } from "../db/client";
import { forgeRuns, githubPostings, jobAttempts, jobs, shadowPublications } from "../db/schema";
import { RESULT_LABELS, TERMINAL_CHECK_TARGET } from "../github/publication-types";
import { traced } from "../log";
import { TERMINAL_ATTEMPT_STATUSES } from "../reconcile/attempt-lifecycle";
import { IMPLEMENT_TEMPLATE_ID, TRIAGE_TEMPLATE_ID } from "../templates/ids";

/** Injectable output sink (same shape as `DoctorIo`). */
export interface DeployVerdictsIo {
	stdout(message: string): void;
	stderr(message: string): void;
}

const processIo: DeployVerdictsIo = {
	stdout: (message) => process.stdout.write(`${message}\n`),
	stderr: (message) => process.stderr.write(`${message}\n`),
};

export const DEPLOY_VERDICTS_USAGE =
	"Usage: software-factory doctor deploy-verdicts --since <iso8601 with Z or offset> [--wait <seconds>] [--config <path>]\n" +
	"  Per lane: POSTED, POSTED_NOTHING (an audit job completed with zero findings, which posts nothing by design; ok),\n" +
	"  FAILED_VERDICT, IN_FLIGHT, UNKNOWN_CONCLUSION, NO_VERDICT, UNKNOWN.\n" +
	"  Exit 0 iff no lane is NO_VERDICT, UNKNOWN_CONCLUSION or IN_FLIGHT.";

const DEFAULT_CONFIG_PATH = "config/repos.yml";
const POLL_MS = 15_000;
/** A full instant: date, time, and an explicit zone (Z or +hh:mm / -hhmm). */
const ISO_INSTANT =
	/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-](\d{2}):?(\d{2}))$/;
const FAILURE_LABELS: ReadonlySet<string> = new Set([
	RESULT_LABELS.hold,
	RESULT_LABELS.failed,
	RESULT_LABELS.error,
]);
const OK_LABELS: ReadonlySet<string> = new Set([RESULT_LABELS.passed, RESULT_LABELS.skipped]);
/** Job-row statuses that mean the job will be (re)dispatched or is running. */
const ACTIVE_JOB_STATUSES: ReadonlySet<string> = new Set(["pending", "dispatching", "running"]);

export type DeployVerdictsArgs = {
	ok: true;
	since: Date;
	waitSeconds?: number;
	configPath?: string;
};

/**
 * A strict RFC 3339 instant, or null. `new Date` normalises an impossible
 * calendar date (`2026-02-30` becomes Mar 1), so every field must round-trip.
 */
function parseInstant(value: string | undefined): Date | null {
	const m = value === undefined ? null : ISO_INSTANT.exec(value);
	if (m === null || value === undefined) return null;
	const [y, mo, d, h, mi, s, oh, om] = m.slice(1).map((f) => Number(f ?? "0"));
	const wall = new Date(Date.UTC(y ?? 0, (mo ?? 0) - 1, d, h, mi, s));
	const back = [
		wall.getUTCMonth() + 1,
		wall.getUTCDate(),
		wall.getUTCHours(),
		wall.getUTCMinutes(),
	];
	if (back.join() !== [mo, d, h, mi].join() || (s ?? 0) > 59) return null;
	if ((oh ?? 0) > 23 || (om ?? 0) > 59) return null;
	const parsed = new Date(value);
	return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/** Parse args; `--since` must carry an explicit zone so it is never read as local time. */
export const parseDeployVerdictsArgs = traced(
	"doctor.parseDeployVerdictsArgs",
	function parseDeployVerdictsArgs(
		args: readonly string[],
	): DeployVerdictsArgs | { ok: false; error: string } {
		const out: Partial<DeployVerdictsArgs> = {};
		for (let i = 0; i < args.length; i += 2) {
			const token = args[i];
			const value = args[i + 1];
			if (token === "--since") {
				const parsed = parseInstant(value);
				if (parsed === null) {
					return {
						ok: false,
						error: "--since requires a valid RFC 3339 timestamp with Z or an offset",
					};
				}
				out.since = parsed;
			} else if (token === "--wait") {
				if (value === undefined || !/^[1-9]\d{0,5}$/.test(value)) {
					return { ok: false, error: "--wait requires a positive integer number of seconds" };
				}
				out.waitSeconds = Number(value);
			} else if (token === "--config" && value !== undefined) {
				out.configPath = value;
			} else {
				return { ok: false, error: `unknown option: ${token}` };
			}
		}
		if (out.since === undefined) return { ok: false, error: "--since is required" };
		return { ok: true, ...out, since: out.since };
	},
);

/**
 * The job types this config can dispatch: every allowlisted `job_templates` id,
 * minus a lane whose per-repository opt-in no managed repository sets (triage,
 * implement_label) or that every repository hands to native Forge review (pr_review).
 */
export const enabledConfigLanes = traced(
	"doctor.enabledConfigLanes",
	function enabledConfigLanes(config: WatcherConfig): string[] {
		const repos = config.repositories;
		const off = new Set<string>();
		if (!repos.some((r) => r.triage === true)) off.add(TRIAGE_TEMPLATE_ID);
		if (!repos.some((r) => r.implement_label !== undefined)) off.add(IMPLEMENT_TEMPLATE_ID);
		if (repos.every((r) => r.pr_review === false)) off.add("pr-review");
		return config.job_templates.map((t) => t.id).filter((id) => !off.has(id));
	},
);

type Verdict = "ok" | "failed" | "unknown";
/** The non-failure check conclusions a publication plan carries (github/publication-types.ts). */
const OK_CONCLUSIONS: ReadonlySet<unknown> = new Set(["success", "neutral"]);

/** A posting's verdict, or undefined when the posting is not a verdict at all. */
function postingVerdict(p: {
	kind: string;
	action: string;
	target: string;
	payload: string;
}): Verdict | undefined {
	if (p.kind === "label") {
		if (p.action !== "add") return undefined;
		if (FAILURE_LABELS.has(p.target)) return "failed";
		return OK_LABELS.has(p.target) ? "ok" : undefined;
	}
	if (p.kind === "issue") return "ok";
	if (p.kind !== "check") return undefined;
	if (p.target === TERMINAL_CHECK_TARGET) return "failed";
	try {
		const plan = JSON.parse(p.payload) as { conclusion?: unknown };
		if (plan.conclusion === "failure") return "failed";
		// A missing or unrecognised conclusion proves nothing: not a verdict, and
		// it must never satisfy the deploy-completes gate (verdict sweep G).
		return OK_CONCLUSIONS.has(plan.conclusion) ? "ok" : "unknown";
	} catch {
		// An unparseable check payload proves no verdict; count it as a failure
		// rather than a pass so it can never green-light a lane.
		return "failed";
	}
}

/** Each job's verdict from its posted, non-shadow verdict postings: any failure wins. */
async function readJobVerdicts(
	db: WatcherDb,
	jobIds: number[],
	since: Date,
): Promise<Map<number, Verdict>> {
	const jobVerdict = new Map<number, Verdict>();
	if (jobIds.length === 0) return jobVerdict;
	const posted = await db
		.select({
			jobId: githubPostings.jobId,
			kind: githubPostings.kind,
			action: githubPostings.action,
			target: githubPostings.target,
			payload: githubPostings.payload,
		})
		.from(githubPostings)
		.leftJoin(shadowPublications, eq(shadowPublications.postingId, githubPostings.id))
		.where(
			and(
				inArray(githubPostings.jobId, jobIds),
				eq(githubPostings.status, "posted"),
				gte(githubPostings.postedAt, since),
				isNull(shadowPublications.id),
			),
		);
	for (const p of posted) {
		const v = postingVerdict(p);
		// Per job: failed > ok > unknown.
		const seen = jobVerdict.get(p.jobId);
		if (v === "failed") jobVerdict.set(p.jobId, "failed");
		else if (v === "ok" && seen !== "failed") jobVerdict.set(p.jobId, "ok");
		else if (v === "unknown" && seen === undefined) jobVerdict.set(p.jobId, "unknown");
	}
	return jobVerdict;
}

/** Jobs whose LATEST attempt is not terminal. Detects running only; never success. */
async function readInFlightJobs(db: WatcherDb, jobIds: number[]): Promise<Set<number>> {
	if (jobIds.length === 0) return new Set();
	const attempts = await db
		.select({ id: jobAttempts.id, jobId: jobAttempts.jobId, status: jobAttempts.status })
		.from(jobAttempts)
		.where(inArray(jobAttempts.jobId, jobIds));
	const latest = new Map<number, { id: number; status: string }>();
	for (const a of attempts) {
		const seen = latest.get(a.jobId);
		if (seen === undefined || a.id > seen.id) latest.set(a.jobId, a);
	}
	const terminal: readonly string[] = TERMINAL_ATTEMPT_STATUSES;
	return new Set([...latest].filter(([, a]) => !terminal.includes(a.status)).map(([id]) => id));
}

/** Jobs with ANY posting row, whatever its status: such a job is not "nothing to post". */
async function readJobsWithPostings(db: WatcherDb, jobIds: number[]): Promise<Set<number>> {
	if (jobIds.length === 0) return new Set();
	const rows = await db
		.selectDistinct({ jobId: githubPostings.jobId })
		.from(githubPostings)
		.where(inArray(githubPostings.jobId, jobIds));
	return new Set(rows.map((r) => r.jobId));
}

/** One lane's counts in the window; `oldestAt` is its earliest dispatch (ms epoch). */
export interface LaneTally {
	dispatched: number;
	ok: number;
	nothing: number;
	failed: number;
	inFlight: number;
	/** Jobs whose only check postings carry a missing or unknown conclusion. */
	unknown: number;
	oldestAt: number;
}

type TallyField = Exclude<keyof LaneTally, "dispatched" | "oldestAt">;

function bump(tallies: Map<string, LaneTally>, lane: string, at: Date, field?: TallyField): void {
	const t = tallies.get(lane) ?? {
		dispatched: 0,
		ok: 0,
		nothing: 0,
		failed: 0,
		inFlight: 0,
		unknown: 0,
		oldestAt: at.getTime(),
	};
	t.dispatched++;
	t.oldestAt = Math.min(t.oldestAt, at.getTime());
	if (field !== undefined) t[field]++;
	tallies.set(lane, t);
}

/** A job with no verdict: still running, an audit that completed with nothing to post, or none. */
function unpostedField(
	d: { jobId: number; status: string; itemId: number | null; sha: string },
	inFlight: Set<number>,
	withPostings: Set<number>,
): TallyField | undefined {
	if (inFlight.has(d.jobId) || ACTIVE_JOB_STATUSES.has(d.status)) return "inFlight";
	const audit = d.itemId === null && d.sha === "";
	if (audit && d.status === "completed" && !withPostings.has(d.jobId)) return "nothing";
	return undefined;
}

/** Watcher-job lanes: one tally per job type dispatched since `since`. */
async function tallyJobLanes(db: WatcherDb, since: Date, tallies: Map<string, LaneTally>) {
	const dispatched = await db
		.select({
			jobId: jobs.id,
			jobType: jobs.jobType,
			status: jobs.status,
			itemId: jobs.itemId,
			sha: jobs.sha,
			firstAt: min(jobAttempts.startedAt),
		})
		.from(jobs)
		.innerJoin(jobAttempts, eq(jobAttempts.jobId, jobs.id))
		.where(gte(jobAttempts.startedAt, since))
		.groupBy(jobs.id);
	const ids = dispatched.map((d) => d.jobId);
	const verdicts = await readJobVerdicts(db, ids, since);
	const inFlight = await readInFlightJobs(db, ids);
	const withPostings = await readJobsWithPostings(db, ids);
	for (const d of dispatched) {
		const field = verdicts.get(d.jobId) ?? unpostedField(d, inFlight, withPostings);
		bump(tallies, d.jobType, d.firstAt ?? since, field);
	}
}

const RUN_STATE_FIELD: Partial<Record<string, TallyField>> = {
	success: "ok",
	failure: "failed",
	dispatched: "inFlight",
	waiting: "inFlight",
	running: "inFlight",
	// The run's state cannot be read yet; `cancelled` has no entry, so it is NO_VERDICT.
	unknown: "inFlight",
};

/** Forgejo Actions lanes, keyed by workflow file name, dispatched since `since`. */
async function tallyForgeRuns(db: WatcherDb, since: Date, tallies: Map<string, LaneTally>) {
	const runs = await db
		.select({ workflow: forgeRuns.workflow, state: forgeRuns.state, at: forgeRuns.dispatchedAt })
		.from(forgeRuns)
		.where(gte(forgeRuns.dispatchedAt, since));
	for (const r of runs) bump(tallies, r.workflow, r.at, RUN_STATE_FIELD[r.state]);
}

interface Report {
	lines: string[];
	noVerdict: number;
	inFlight: number;
	unknownConclusion: number;
}

/**
 * Every lane that dispatched since `since`, with its verdict counts and earliest
 * dispatch. The ONE lane query: `doctor deploy-verdicts` and the reconcile-cycle
 * postings-absence alert (605d) both read it.
 */
export const readLaneTallies = traced(
	"doctor.readLaneTallies",
	async function readLaneTallies(db: WatcherDb, since: Date): Promise<Map<string, LaneTally>> {
		const tallies = new Map<string, LaneTally>();
		await tallyJobLanes(db, since, tallies);
		await tallyForgeRuns(db, since, tallies);
		return tallies;
	},
);

async function classify(
	db: WatcherDb,
	since: Date,
	configLanes: readonly string[],
): Promise<Report> {
	const tallies = await readLaneTallies(db, since);
	const lanes = [...new Set([...configLanes, ...tallies.keys()])].sort();
	const report: Report = { lines: [], noVerdict: 0, inFlight: 0, unknownConclusion: 0 };
	for (const lane of lanes) {
		const t = tallies.get(lane);
		if (t === undefined) {
			report.lines.push(`[UNKNOWN] ${lane}: not dispatched since ${since.toISOString()}`);
		} else if (t.ok > 0) {
			report.lines.push(`[POSTED] ${lane}: ${t.ok}`);
		} else if (t.nothing > 0) {
			report.lines.push(
				`[POSTED_NOTHING] ${lane}: dispatched ${t.dispatched}, completed with nothing to post ${t.nothing}`,
			);
		} else if (t.failed > 0) {
			report.lines.push(`[FAILED_VERDICT] ${lane}: dispatched ${t.dispatched}, failed ${t.failed}`);
		} else if (t.inFlight > 0) {
			report.inFlight++;
			report.lines.push(`[IN_FLIGHT] ${lane}: dispatched ${t.dispatched}, in flight ${t.inFlight}`);
		} else if (t.unknown > 0) {
			report.unknownConclusion++;
			report.lines.push(
				`[UNKNOWN_CONCLUSION] ${lane}: dispatched ${t.dispatched}, unknown conclusion ${t.unknown}`,
			);
		} else {
			report.noVerdict++;
			report.lines.push(`[NO_VERDICT] ${lane}: dispatched ${t.dispatched}, posted 0`);
		}
	}
	return report;
}

/** Options for `runDeployVerdicts`; `now`/`sleep` are test seams for the wait loop. */
export interface DeployVerdictsOptions {
	configLanes?: readonly string[];
	waitSeconds?: number;
	now?: () => number;
	sleep?: (ms: number) => Promise<void>;
}

/**
 * Classify every lane against the window starting at `since`, re-reading while a
 * lane is IN_FLIGHT and the wait budget lasts, then print one line per lane.
 * Returns 0 iff no lane is NO_VERDICT, UNKNOWN_CONCLUSION or IN_FLIGHT, else 1. DB errors propagate.
 */
export const runDeployVerdicts = traced(
	"doctor.runDeployVerdicts",
	async function runDeployVerdicts(
		db: WatcherDb,
		since: Date,
		io: DeployVerdictsIo,
		opts: DeployVerdictsOptions = {},
	): Promise<number> {
		const now = opts.now ?? Date.now;
		const sleep = opts.sleep ?? ((ms: number) => Bun.sleep(ms));
		const deadline = now() + (opts.waitSeconds ?? 0) * 1000;
		const lanes = opts.configLanes ?? [];
		let report = await classify(db, since, lanes);
		while (report.inFlight > 0 && now() < deadline) {
			await sleep(Math.min(POLL_MS, deadline - now()));
			report = await classify(db, since, lanes);
		}
		for (const line of report.lines) io.stdout(line);
		io.stdout(`${report.noVerdict} lane(s) dispatched without a posted verdict`);
		io.stdout(`${report.inFlight} lane(s) still in flight`);
		io.stdout(
			`${report.unknownConclusion} lane(s) posted only checks with a missing or unknown conclusion`,
		);
		return report.noVerdict + report.inFlight + report.unknownConclusion === 0 ? 0 : 1;
	},
);

/** Test seam: the db factory. Production uses the real `createDb`. */
export interface DeployVerdictsSeams {
	createDb?: () => { db: WatcherDb; client: { end?: () => Promise<void> } };
	configLanes?: (path: string) => Promise<readonly string[]>;
}

async function loadConfigLanes(path: string): Promise<readonly string[]> {
	const loaded = await loadConfig(path);
	if (!loaded.ok) throw new Error(loaded.error);
	return enabledConfigLanes(loaded.config);
}

/** CLI adapter: exit 2 on bad args, 3 on a config/DB/harness error, else the report's code. */
export const runDeployVerdictsCommand = traced(
	"doctor.runDeployVerdictsCommand",
	async function runDeployVerdictsCommand(
		args: readonly string[],
		io: DeployVerdictsIo = processIo,
		seams: DeployVerdictsSeams = {},
	): Promise<number> {
		if (args.includes("--help") || args.includes("-h")) {
			io.stdout(DEPLOY_VERDICTS_USAGE);
			return 0;
		}
		const parsed = parseDeployVerdictsArgs(args);
		if (!parsed.ok) {
			io.stderr(parsed.error);
			io.stderr(DEPLOY_VERDICTS_USAGE);
			return 2;
		}
		let configLanes: readonly string[];
		try {
			configLanes = await (seams.configLanes ?? loadConfigLanes)(
				parsed.configPath ?? DEFAULT_CONFIG_PATH,
			);
		} catch (err) {
			io.stderr(`deploy-verdicts: config error: ${err instanceof Error ? err.message : "unknown"}`);
			return 3;
		}
		let handle: { db: WatcherDb; client: { end?: () => Promise<void> } } | undefined;
		try {
			handle = (seams.createDb ?? createDb)();
			return await runDeployVerdicts(handle.db, parsed.since, io, {
				configLanes,
				waitSeconds: parsed.waitSeconds,
			});
		} catch (err) {
			// CLASS only: a driver error message can quote DATABASE_URL with its password.
			io.stderr(`deploy-verdicts: database error (${err instanceof Error ? err.name : "unknown"})`);
			return 3;
		} finally {
			await handle?.client.end?.().catch(() => undefined);
		}
	},
);
