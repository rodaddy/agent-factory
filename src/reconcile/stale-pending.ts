/**
 * @module reconcile/stale-pending
 * @description The single owner of stranded factory commit statuses. A
 *   lane posts its context `pending` and ends it from a step in the same job, so
 *   a cancelled run, lost runner, job timeout, forge outage, or expired token
 *   leaves it pending forever. Once per cycle this pass finds every
 *   factory context whose NEWEST status on a watched sha is still `pending` and,
 *   when its run has provably ended, posts `error` over it. Per-workflow
 *   finalize jobs are not to be added; this pass is the one place that decides.
 *
 *   Jobs are matched to a run by URL PATH: a lane posts an ABSOLUTE run URL
 *   (`https://<host>/<owner>/<repo>/actions/runs/<N>`) while Forgejo's own job
 *   statuses carry a RELATIVE `/<owner>/<repo>/actions/runs/<N>/jobs/<k>`, so both
 *   are reduced to their path and a job belongs to the run when its path starts
 *   with `<run path>/jobs/`. A run has ended when it has at least one job status
 *   on the sha and all of them are terminal. When the run has ZERO job statuses
 *   on the sha, the age rule is the fallback: the record is swept once it is
 *   older than the threshold. That fallback exists because a foreign-repo lane
 *   (status on k3s-deploy, say) posts its job statuses on the HOST repo's commit,
 *   so its jobs are never visible on the sha it reports on.
 *
 *   Known window: such a jobless run still working past the threshold IS swept
 *   to `error`, and its later verdict then overwrites the swept `error` (newest
 *   record wins). The false `error` is visible on the PR until that verdict
 *   lands. The default threshold (120 min) fits two 30 min engine attempts plus
 *   queue time so the window stays rare.
 *
 *   Supersede (`factory/smoke` only): a same-sha rerun of the smoke
 *   workflow that fails before posting leaves the OLDER run's terminal verdict
 *   standing, and the workflow cannot correct it because finalize must never
 *   overwrite a terminal verdict. So when the newest `factory/smoke` record is
 *   terminal and names run R, and the highest-numbered `factory-smoke / ` job
 *   run M > R on the sha has ended (no pending job) and failed (a job is
 *   `failure` or `error`), this pass posts `failure` naming run M. The ordering
 *   key is the Actions run number N in `/<owner>/<repo>/actions/runs/<N>`,
 *   monotonic per repo. The posted record names M, so the next sweep is a no-op.
 *   Forgejo "Re-run all jobs" keeps the run number (M == R): then it supersedes
 *   only when every job of R re-posted rows after the record (id > record.id),
 *   each attempt started strictly after the record's updated_at, all ended, and
 *   one failed -- a job that fails after posting the verdict never flips it.
 *
 *   Forge load: the step runs at most once per 5 minutes, and a
 *   forge_runs row already terminal in the DB, a PR head, or a main commit is
 *   read through its one-call combined status first, the full list only when
 *   that shows a pending, a possible smoke supersede, or is truncated.
 *
 *   Watched shas come from three sources: forge_runs rows of the last 24h, open
 *   PR heads of enrolled repos, and the fixed status repos. sop-gate,
 *   sop-verify, site-publish and hosted-app-render write no forge_runs row and
 *   report on repos that are not enrolled, so every fixed `statusRepo` in
 *   DISPATCH_TARGETS is watched by name: its open PR heads and its newest 30
 *   commits on main.
 *
 *   A repo whose open-PR or commits read fails is skipped for this cycle with
 *   one warn; it never fails the step.
 *
 * @outputs
 *   - `sweepStalePending` -- one sweep over given (repo, sha) targets; returns counts
 *   - `collectTargets` -- the watched (repo, sha) set: recent forge_runs + open PR heads
 *     + the fixed status repos' open PR heads and newest main commits
 *   - `runStalePendingStep` -- the isolated cycle step
 *   - `OWNED_CONTEXTS` / `STALE_PENDING_MINUTES`
 *
 * @dependencies
 *   - ../hooks/sop-gate -- DISPATCH_TARGETS, the one map of lane -> status repo/context
 *   - ../db/schema -- forge_runs
 *   - ../log -- traced(), log()
 */
import { gt, sql } from "drizzle-orm";
import type { WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import { forgeRuns } from "../db/schema";
import type { ForgeClient } from "../forge/boundary";
import { DISPATCH_TARGETS } from "../hooks/sop-gate";
import { errorMessage, log, traced } from "../log";

/** Default minutes before a pending record with no pending job counts as stranded. */
export const STALE_PENDING_MINUTES = 120;

/**
 * Every context the factory owns: each watcher-dispatched lane's context
 * (DISPATCH_TARGETS: sop-gate, sop-verify, site-publish, hosted-app-render,
 * factory/infra-static, factory/pr-review, factory/prepush, factory/issue-triage,
 * factory/verb, factory/implement) plus `factory/smoke`, the one lane
 * `pull_request` triggers directly.
 */
export const OWNED_CONTEXTS: ReadonlySet<string> = new Set([
	...Object.values(DISPATCH_TARGETS).map((t) => t.context),
	"factory/smoke",
]);

export interface StatusTarget {
	repo: string;
	sha: string;
	/** Read the one-call combined status first; the full list only when it shows something to act on. */
	combined?: boolean;
}

/** sf#1636: the step reads Forge at most once per this window. Process-local: a restart may run one early. */
export const STEP_EVERY_MS = 5 * 60_000;
let lastStepAt: number | null = null;

/** Whether the step is due at `now` (ms); a due call claims the window. A clock that went backwards is due. */
function stepDue(now: number): boolean {
	if (lastStepAt !== null && now >= lastStepAt && now - lastStepAt < STEP_EVERY_MS) return false;
	lastStepAt = now;
	return true;
}

interface CommitStatus {
	id: number;
	context: string;
	status?: string;
	state?: string;
	target_url?: string;
	updated_at?: string;
}

const SHA = /^[0-9a-f]{40}$/;
const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const stateOf = (s: CommitStatus) => s.status ?? s.state ?? "";

/** Newest status per context, by id. */
function newestByContext(rows: CommitStatus[]): Map<string, CommitStatus> {
	const newest = new Map<string, CommitStatus>();
	for (const s of rows) {
		const prev = newest.get(s.context);
		if (!prev || s.id > prev.id) newest.set(s.context, s);
	}
	return newest;
}

/** A target_url reduced to its path: scheme and host stripped when present. */
const pathOf = (url: string | undefined) =>
	(url ?? "").replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, "");

/** The `/<owner>/<repo>/actions/runs/<N>` path a target_url names, or "" when it names no run. */
const runPathOf = (url: string | undefined) =>
	/^\/[^?#]*?\/actions\/runs\/\d+(?=$|[/?#])/.exec(pathOf(url))?.[0] ?? "";

/** Whether the pending record's run has ended, per the module contract. */
function runEnded(
	record: CommitStatus,
	newest: Map<string, CommitStatus>,
	now: Date,
	minutes: number,
) {
	const runPath = runPathOf(record.target_url);
	const jobs = runPath
		? [...newest.values()].filter((s) => pathOf(s.target_url).startsWith(`${runPath}/jobs/`))
		: [];
	if (jobs.some((j) => stateOf(j) === "pending")) return false;
	if (jobs.length > 0) return true;
	const age = now.getTime() - Date.parse(record.updated_at ?? "");
	return age >= minutes * 60_000;
}

const TERMINAL = new Set(["success", "failure", "error"]);

/** forge_runs states that end a run (`ForgeRunState`). */
const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set(["success", "failure", "cancelled"]);

/** The integer run number N a target_url names, or null. */
function runNumberOf(url: string | undefined): number | null {
	const m = /\/(\d+)$/.exec(runPathOf(url));
	return m?.[1] ? Number.parseInt(m[1], 10) : null;
}

const failed = (jobs: CommitStatus[]) =>
	jobs.some((j) => stateOf(j) === "failure" || stateOf(j) === "error");

/**
 * Whether a combined-first target needs its full statuses list: the
 * combined state or any context's newest status is `pending`, or the sf#954
 * smoke supersede could apply (a `factory/smoke` verdict beside a failed
 * `factory-smoke / ` job), or the response is truncated (`total_count`). Anything else has nothing this pass would post.
 */
async function needsFullRead(client: ForgeClient, repo: string, sha: string): Promise<boolean> {
	const res = await client.get<{ state?: string; statuses?: CommitStatus[]; total_count?: number }>(
		`/repos/${repo}/commits/${sha}/status?limit=50`,
	);
	const latest = Array.isArray(res.data?.statuses) ? res.data.statuses : [];
	if ((res.data?.total_count ?? 0) > latest.length) return true;
	if (res.data?.state === "pending" || latest.some((s) => stateOf(s) === "pending")) return true;
	const smokeJobs = latest.filter((s) => s.context.startsWith("factory-smoke / "));
	return latest.some((s) => s.context === "factory/smoke") && failed(smokeJobs);
}

/**
 * Whether run R's same-number rerun (Forgejo "Re-run all jobs") ended failed:
 * every job context of R has an attempt start (its newest `pending` row, else
 * its oldest row) posted after the record (id > record.id) and strictly later
 * than the record's updated_at, its newest row is terminal, and one ended
 * failure/error. A
 * job that fails AFTER its own run posted the verdict started before it, so
 * it never flips the verdict.
 */
function rerunFailed(record: CommitStatus, rows: CommitStatus[], jobs: CommitStatus[]): boolean {
	const since = Date.parse(record.updated_at ?? "");
	const runPath = runPathOf(jobs[0]?.target_url);
	const ended: CommitStatus[] = [];
	for (const { context } of jobs) {
		const own = rows
			.filter((s) => s.context === context && runPathOf(s.target_url) === runPath)
			.sort((a, b) => a.id - b.id);
		// The attempt begins at its own `pending` row (a rerun re-posts one).
		const first = [...own].reverse().find((s) => stateOf(s) === "pending") ?? own[0];
		const last = own.at(-1);
		if (!first || !last || first.id <= record.id || stateOf(last) === "pending") return false;
		if (!(Date.parse(first.updated_at ?? "") > since)) return false;
		ended.push(last);
	}
	return failed(ended);
}

/** The sf#954 supersede body for the newest `factory/smoke` record, or null when none applies. */
function supersedeSmoke(
	record: CommitStatus,
	rows: CommitStatus[],
	repo: string,
	sha: string,
): Record<string, string> | null {
	const r = runNumberOf(record.target_url);
	if (!TERMINAL.has(stateOf(record)) || r === null || !repo || !sha) return null;
	// Group by run FIRST, then take the newest row per job within the candidate
	// run: a late status from an older run on the same job context must not hide
	// a job that is still pending in the newest run (PR #1088 review, P1).
	const runs = new Map<number, CommitStatus[]>();
	for (const s of rows) {
		const n = runNumberOf(s.target_url);
		if (s.context.startsWith("factory-smoke / ") && n !== null)
			runs.set(n, [...(runs.get(n) ?? []), s]);
	}
	const m = Math.max(-1, ...runs.keys());
	const jobs = [...newestByContext(runs.get(m) ?? []).values()];
	let description: string;
	if (m === r && jobs.length > 0) {
		if (!rerunFailed(record, rows, jobs)) return null;
		description = `factory/smoke: rerun of run ${r} failed before posting (stale sweep, sf#954)`;
	} else {
		if (m <= r || jobs.some((j) => stateOf(j) === "pending") || !failed(jobs)) return null;
		description = `factory/smoke: run ${m} failed before posting; supersedes run ${r} (stale sweep, sf#954)`;
	}
	const origin = /^[a-z][a-z0-9+.-]*:\/\/[^/]*/i.exec(record.target_url ?? "")?.[0] ?? "";
	return {
		context: "factory/smoke",
		state: "failure",
		description: description.slice(0, 120),
		target_url: `${origin}${runPathOf(jobs[0]?.target_url)}`,
	};
}

export interface SweepDeps {
	client: ForgeClient;
	targets: readonly StatusTarget[];
	now: Date;
	staleMinutes?: number;
}

/** One sweep: read each target's statuses once, post `error` over each stranded pending context. */
export const sweepStalePending = traced(
	"reconcile.sweepStalePending",
	async function sweepStalePending(deps: SweepDeps) {
		const minutes = deps.staleMinutes ?? STALE_PENDING_MINUTES;
		const counts = { targets: 0, pending: 0, swept: 0, superseded: 0, failed: 0 };
		const seen = new Set<string>();
		for (const { repo, sha, combined } of deps.targets) {
			if (seen.has(`${repo}@${sha}`)) continue;
			seen.add(`${repo}@${sha}`);
			counts.targets++;
			try {
				if (combined && !(await needsFullRead(deps.client, repo, sha))) continue;
				const rows = await deps.client.paginate<CommitStatus>(
					`/repos/${repo}/commits/${sha}/statuses?limit=50`,
					5,
				);
				const newest = newestByContext(rows);
				for (const [context, record] of newest) {
					if (!OWNED_CONTEXTS.has(context) || stateOf(record) !== "pending") continue;
					counts.pending++;
					if (!runEnded(record, newest, deps.now, minutes)) continue;
					await deps.client.write("POST", `/repos/${repo}/statuses/${sha}`, {
						context,
						state: "error",
						description: `${context}: run ended without a verdict (stale pending swept)`,
						target_url: record.target_url ?? "",
					});
					counts.swept++;
				}
				const smoke = newest.get("factory/smoke");
				const body = smoke ? supersedeSmoke(smoke, rows, repo, sha) : null;
				if (body) {
					await deps.client.write("POST", `/repos/${repo}/statuses/${sha}`, body);
					counts.superseded++;
				}
			} catch {
				counts.failed++;
			}
		}
		if (counts.targets > 0) log("info", "reconcile.stale_pending", counts);
		return counts;
	},
	{ redact: { args: [0] } },
);

/** Every distinct fixed `statusRepo` in DISPATCH_TARGETS: lanes that report on a repo they name, not an input. */
const FIXED_STATUS_REPOS: readonly string[] = [
	...new Set(
		Object.values(DISPATCH_TARGETS)
			.map((t) => t.statusRepo)
			.filter((r) => r !== ""),
	),
];

/** The newest 30 commits on main of one fixed status repo. A failed read logs one warn and yields none. */
async function mainCommitTargets(client: ForgeClient, repo: string): Promise<StatusTarget[]> {
	try {
		// `get`, never `paginate`: a commits list always has more pages, and paginate throws on that.
		const res = await client.get<unknown>(
			`/repos/${repo}/commits?sha=main&limit=30&stat=false&verification=false&files=false`,
		);
		const rows = Array.isArray(res.data) ? (res.data as { sha?: unknown }[]) : [];
		return rows
			.map((c) => (typeof c?.sha === "string" ? c.sha : ""))
			.filter((sha) => SHA.test(sha))
			.map((sha) => ({ repo, sha }));
	} catch (e) {
		log("warn", "reconcile.stale_pending.commits_failed", { repo, error: errorMessage(e) });
		return [];
	}
}

/**
 * The watched set: forge_runs dispatched in the last 24h (their status repo/sha),
 * open PR heads of enrolled Forgejo repos, and the fixed status repos' open PR
 * heads plus newest 30 main commits.
 */
export const collectTargets = traced(
	"reconcile.stalePendingTargets",
	async function collectTargets(db: WatcherDb, client: ForgeClient, config: WatcherConfig) {
		// Keyed by repo@sha: a forge_runs target (full read) wins over the same sha
		// as a combined-first PR head or main commit.
		const targets = new Map<string, StatusTarget>();
		const add = (t: StatusTarget) => {
			const had = targets.get(`${t.repo}@${t.sha}`);
			if (!had || (had.combined && !t.combined)) targets.set(`${t.repo}@${t.sha}`, t);
		};
		const rows = await db
			.select({
				workflow: forgeRuns.workflow,
				inputs: forgeRuns.inputs,
				sha: forgeRuns.targetSha,
				state: forgeRuns.state,
			})
			.from(forgeRuns)
			.where(gt(forgeRuns.dispatchedAt, sql`now() - interval '24 hours'`));
		for (const row of rows) {
			const t = DISPATCH_TARGETS[row.workflow];
			const raw = typeof row.inputs === "string" ? JSON.parse(row.inputs) : row.inputs;
			const inputs = (raw ?? {}) as Record<string, unknown>;
			const repo = t?.repoInput ? String(inputs[t.repoInput] ?? "") : (t?.statusRepo ?? "");
			const sha = String(inputs[t?.shaInput ?? ""] ?? row.sha);
			// A run already terminal in the DB stays watched for its 24h (a same-number
			// rerun can still strand a pending), combined-first.
			if (OWNER_REPO.test(repo) && SHA.test(sha))
				add({ repo, sha, combined: TERMINAL_RUN_STATES.has(row.state) });
		}
		const enrolled = config.repositories.filter((x) => x.provider === "forgejo").map((x) => x.name);
		for (const repo of new Set([...enrolled, ...FIXED_STATUS_REPOS])) {
			try {
				const prs = await client.paginate<{ head?: { sha?: string } }>(
					`/repos/${repo}/pulls?state=open&limit=50`,
					2,
				);
				for (const pr of prs)
					if (SHA.test(pr.head?.sha ?? "")) add({ repo, sha: pr.head?.sha ?? "", combined: true });
			} catch (e) {
				log("warn", "reconcile.stale_pending.pulls_failed", { repo, error: errorMessage(e) });
			}
		}
		for (const repo of FIXED_STATUS_REPOS)
			for (const t of await mainCommitTargets(client, repo)) add({ ...t, combined: true });
		return [...targets.values()];
	},
	{ redact: { args: [0, 1] } },
);

/**
 * The cycle step: isolated, a failure reaches `onError` and never aborts the
 * cycle. Runs at most once per `STEP_EVERY_MS`; a skipped cycle is a
 * no-op. Skipped in shadow mode: a swept `error` status IS a forge write, and
 * shadow never writes.
 */
export const runStalePendingStep = traced(
	"reconcile.runStalePendingStep",
	async function runStalePendingStep(deps: {
		db: WatcherDb;
		config: WatcherConfig;
		shadow: boolean;
		clientFor: (repository: string) => Promise<ForgeClient | null>;
		onError: (e: unknown) => void;
		/** Clock in ms, for the sf#1636 cadence. */
		now?: () => number;
	}): Promise<void> {
		if (deps.shadow || !stepDue((deps.now ?? Date.now)())) return;
		try {
			// Every Forgejo repo shares the ONE Forgejo client, so the first enrolled
			// repo's client also reads/writes the unenrolled status repos (k3s-deploy).
			const first = deps.config.repositories.find((r) => r.provider === "forgejo");
			const client = first ? await deps.clientFor(first.name) : null;
			if (client === null) return;
			const targets = await collectTargets(deps.db, client, deps.config);
			await sweepStalePending({
				client,
				targets,
				now: new Date(),
				staleMinutes: deps.config.stale_pending_minutes,
			});
		} catch (e) {
			deps.onError(e);
		}
	},
	{ redact: { args: [0] } },
);
