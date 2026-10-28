/**
 * @module status/pass-liveness
 * @description The process-local record of whether the reconciliation LOOP is
 *   still turning. This is a different claim from every other field on
 *   the status snapshot, and the difference is the whole point:
 *
 *   - `systemctl status` answers "is the process up". The watcher on the watcher host was
 *     `active (running)` for ten days while nobody could say whether it had
 *     completed a pass in the last half hour.
 *   - A repository's `lastSweep` cursor answers "did this repo have work
 *     reconciled". A watcher whose configured repositories are all quiet
 *     advances no cursor, so cursor age cannot distinguish a healthy idle
 *     watcher from a wedged one.
 *   - THIS module answers "did the scheduler start a pass recently", which is
 *     the liveness question an operator and a monitor actually ask.
 *
 *   PASS-START, NOT PASS-END, is what `lastPassStartedAt` records. A pass that
 *   begins and then dies still moves the timestamp, because the claim is that
 *   the LOOP is running — not that work succeeded. Recording only completions
 *   would make a watcher whose passes all throw look identical to a watcher
 *   whose scheduler has stopped firing, which is exactly the conflation #252
 *   exists to remove. Failure is reported separately, through the pass counters
 *   and the per-repository errors below.
 *
 *   IN-MEMORY AND PROCESS-LOCAL, DELIBERATELY, on the `HostConflictTally`
 *   precedent: the scheduler and the status server live in ONE Bun process
 *   (`composeService` builds both — src/service.ts), so a process-local record
 *   is genuinely reachable from the status surface with no migration. The cost
 *   is that a restart reports "no pass has started yet" until the first pass
 *   begins, and that reading is CORRECT — a just-restarted watcher genuinely has
 *   not completed a pass, and `/healthz` says so with a 503 rather than
 *   inventing a fresh timestamp.
 *
 *   PER-REPOSITORY ERRORS ARE SURFACED HERE. `runPass` captures a bounded,
 *   secret-free `error` on every failed `RepoPassResult`, and the service's
 *   result sink summarised the pass as "N ok, M failed" and dropped them — so
 *   "1 failed" named no repository for ten days. Recording them on the pass
 *   record makes the error visible at the same seam that reports liveness.
 *
 * @outputs
 *   - `PassLivenessTracker` -- the process-local recorder + reader
 *   - `PassLivenessStatus` -- the bounded shape the status snapshot carries
 *   - `RepoPassError` -- one repository's bounded failure summary
 *   - `emptyPassLivenessStatus` -- what a process that has started no pass reports
 *   - `isPassLive` -- the staleness judgment `/healthz` and the status page share
 *
 * @dependencies
 *   - none (deliberately: a leaf, so the scheduler seam can own it with no cycle)
 */

/**
 * Max characters retained of a repository name or a bounded error summary.
 *
 * `runPass` already bounds what it stores, but this module owns the bound so its
 * stated property — that nothing unbounded reaches the status surface — is true
 * of THIS module rather than true only because of what its callers happen to do.
 */
import { traced } from "../log";

const MAX_FIELD = 200;

/**
 * Max per-repository errors retained from one pass.
 *
 * A pass reports at most one error per configured repository, so this is already
 * bounded by config size; the cap makes the bound this module's own rather than
 * an inherited one, and keeps a watcher configured with hundreds of repositories
 * from putting hundreds of rows on a status page.
 */
const MAX_REPO_ERRORS = 20;

/** One repository's bounded, secret-free failure summary from the last pass. */
export interface RepoPassError {
	/** The repository's full name, as configured. Bounded on record. */
	repository: string;
	/** The bounded summary `runPass` captured. Never a log, body, or secret. */
	error: string;
}

/**
 * The bounded pass-liveness record carried on the status snapshot.
 *
 * `lastPassStartedAt` is the field the liveness claim cannot be made without;
 * everything else is detail an operator wants once liveness has answered.
 */
export interface PassLivenessStatus {
	/**
	 * ISO-8601 time the most recent pass STARTED, or null when no pass has
	 * started in this process. Null is the honest reading immediately after a
	 * restart, and `/healthz` treats it as not-live rather than as fresh.
	 */
	lastPassStartedAt: string | null;
	/**
	 * ISO-8601 time the most recent pass FINISHED, or null when no pass has
	 * finished. A `lastPassStartedAt` with a null (or older) `lastPassFinishedAt`
	 * is a pass currently in flight — or one that died without reporting.
	 */
	lastPassFinishedAt: string | null;
	/** Repositories the last completed pass reconciled successfully. */
	lastPassOk: number;
	/** Repositories the last completed pass failed on. */
	lastPassFailCount: number;
	/**
	 * The bounded per-repository errors from the last completed pass — the detail
	 * behind `lastPassFailCount`, which named no repository before #252. Empty on
	 * a clean pass and on a process that has completed none.
	 */
	lastPassRepoErrors: RepoPassError[];
	/** Passes STARTED since this process started. Counts wedge-free loop turns. */
	passesStarted: number;
	/** Passes that COMPLETED since this process started (started minus in-flight/died). */
	passesCompleted: number;
}

/** What a pass reports when it completes. Mirrors the fields `PassResult` carries. */
export interface PassCompletion {
	okCount: number;
	failCount: number;
	/** Per-repository failures; only entries carrying an error are recorded. */
	repositories: readonly { repository: string; error?: string | undefined }[];
}

/** Bound one field at the boundary that stores it. */
function clip(value: string): string {
	return value.slice(0, MAX_FIELD);
}

/** The empty record: what a process that has started no pass reports. */
export const emptyPassLivenessStatus = traced(
	"status.emptyPassLivenessStatus",
	function emptyPassLivenessStatus(): PassLivenessStatus {
		return {
			lastPassStartedAt: null,
			lastPassFinishedAt: null,
			lastPassOk: 0,
			lastPassFailCount: 0,
			lastPassRepoErrors: [],
			passesStarted: 0,
			passesCompleted: 0,
		};
	},
);

/**
 * Is the reconciliation loop live, as of `now`?
 *
 * The threshold is TWICE the configured poll interval — one whole interval of
 * slack past the point a pass was due, so a pass that starts late or runs long
 * does not flap the endpoint. The interval is the caller's
 * `poll_interval_minutes`; there is deliberately no second constant here, so the
 * threshold cannot drift from the cadence it describes.
 *
 * A null `lastPassStartedAt` is NOT live: a process that has started no pass has
 * not demonstrated a turning loop, and reporting it live would make the restart
 * window — the exact window in which a broken boot hides — indistinguishable
 * from a healthy one.
 *
 * A FUTURE timestamp is NOT live either, and the same slack applies in both
 * directions. An age computed as `now - started` goes NEGATIVE for a
 * future-dated start, which sails under any upper bound — so the naive
 * comparison reports a clock-skewed or corrupted timestamp as the healthiest
 * possible reading. This is the endpoint's fail-open hole and it is closed by
 * bounding the MAGNITUDE of the difference: a start up to 2x the interval in
 * either direction is tolerated (NTP correction, a container whose clock
 * settles after boot), and anything beyond that is refused in both directions.
 *
 * @param lastPassStartedAt - ISO-8601 pass-start time, or null
 * @param pollIntervalMinutes - the configured cadence
 * @param nowMs - the instant to judge against, in epoch milliseconds
 */
export const isPassLive = traced(
	"status.isPassLive",
	function isPassLive(
		lastPassStartedAt: string | null,
		pollIntervalMinutes: number,
		nowMs: number,
	): boolean {
		if (lastPassStartedAt === null) {
			return false;
		}
		const startedMs = Date.parse(lastPassStartedAt);
		if (Number.isNaN(startedMs)) {
			// An unparseable timestamp is not evidence of a live loop. Fail closed: a
			// monitor reading 200 off a value nothing could interpret is worse than a
			// 503 that makes the operator look.
			return false;
		}
		// MAGNITUDE, not signed age: a future-dated start yields a negative age that
		// would sail under an upper bound and report as maximally healthy.
		return Math.abs(nowMs - startedMs) <= pollIntervalMinutes * 60_000 * 2;
	},
);

/**
 * The process-local pass-liveness record.
 *
 * `recordStart` is called by the scheduler seam BEFORE the pass body runs, so a
 * pass that throws, hangs, or takes the process down with it has still moved
 * `lastPassStartedAt`. `recordCompletion` is called from the existing result
 * sink. The two are separate on purpose: liveness is about the loop, and success
 * is about the work.
 */
export class PassLivenessTracker {
	private startedAt: string | null = null;
	private finishedAt: string | null = null;
	private okCount = 0;
	private failCount = 0;
	private repoErrors: RepoPassError[] = [];
	private started = 0;
	private completed = 0;
	private readonly now: () => Date;

	/** @param now - clock, injected so a test can assert an exact timestamp. */
	constructor(now: () => Date = () => new Date()) {
		this.now = now;
	}

	/**
	 * Record that a pass has STARTED. Called before the pass body, so the loop's
	 * liveness does not depend on the pass succeeding — or on it returning at all.
	 */
	recordStart(): void {
		this.started += 1;
		this.startedAt = this.now().toISOString();
	}

	/**
	 * Record that a pass COMPLETED, with its counts and its per-repository
	 * errors. Only repositories carrying an error are retained: the successes are
	 * already counted, and the whole reason this exists is that `failCount` named
	 * nobody.
	 */
	recordCompletion(result: PassCompletion): void {
		this.completed += 1;
		this.finishedAt = this.now().toISOString();
		this.okCount = result.okCount;
		this.failCount = result.failCount;
		this.repoErrors = result.repositories
			.flatMap((repo) =>
				repo.error === undefined || repo.error === ""
					? []
					: [{ repository: clip(repo.repository), error: clip(repo.error) }],
			)
			.slice(0, MAX_REPO_ERRORS);
	}

	/** The current bounded status. Returns fresh objects; callers cannot mutate state. */
	status(): PassLivenessStatus {
		return {
			lastPassStartedAt: this.startedAt,
			lastPassFinishedAt: this.finishedAt,
			lastPassOk: this.okCount,
			lastPassFailCount: this.failCount,
			lastPassRepoErrors: this.repoErrors.map((entry) => ({
				repository: entry.repository,
				error: entry.error,
			})),
			passesStarted: this.started,
			passesCompleted: this.completed,
		};
	}
}
