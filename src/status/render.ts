/**
 * @module status/render
 * @description Server-render the watcher status as a single self-contained HTML
 *   page — no UI framework, no client JS required. All dynamic values are
 *   HTML-escaped. The renderer only ever receives the already-bounded
 *   `StatusSnapshot`, so secrets, issue bodies, and logs cannot reach the page.
 *
 *   TWO STALENESS FACTS, KEPT APART. A repository's staleness is derived
 *   from its last sweep cursor versus the poll interval; the WATCHER's staleness
 *   is derived from when the reconciliation loop last started a pass. They are
 *   different claims — a healthy watcher with quiet repositories advances no
 *   cursor — so the page reports the loop in its own section and uses that fact
 *   to distinguish a `quiet` repository from a `stale` one.
 *
 *   THE ONLY SURFACE THAT KNOWS THE LANGFUSE HOST. Trace links are
 *   composed HERE, from a base URL passed to the renderer and deliberately never
 *   placed on the snapshot: `/status.json` and every factory-authored forge
 *   comment carry ids only, because the Langfuse host is LAN/tailnet-internal and
 *   a comment is outward-facing. With no base URL supplied the ids render as
 *   plain text, which is a fully working page and not a degraded one.
 *
 * @outputs
 *   - `renderStatusHtml` -- produce the full HTML document
 *   - `repoHealth` -- classify a repository as ok/degraded/stale/quiet/idle
 *
 * @dependencies
 *   - ./query -- the StatusSnapshot shape
 *   - ./pass-liveness -- the process-level loop-liveness judgment
 */
import { traced } from "../log";
import type { HostConflictStatus } from "../observability/host-conflicts";
import { isPassLive } from "./pass-liveness";
import type {
	HeldBoxStatus,
	RepoStatus,
	StatusSnapshot,
	TracedAttemptStatus,
	UnconfirmedAllocationStatus,
} from "./query";

/** Escape a string for safe HTML text/attribute interpolation. */
export const escapeHtml = traced("status.escapeHtml", function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
});

export type Health = "ok" | "degraded" | "stale" | "idle" | "quiet";

/**
 * Classify a repository's health.
 *
 * - `idle`: never swept.
 * - `stale`: last sweep older than twice the poll interval AND the watcher's own
 *   reconciliation loop is not demonstrably live — the reading that means
 *   "nobody is looking at this repository".
 * - `quiet`: last sweep older than twice the poll interval while the loop IS
 *   live — passes are running and this repository simply had nothing to move.
 * - `degraded`: has failed jobs or a recorded last error.
 * - `ok`: swept recently with no failures.
 *
 * TWO FACTS, NOT ONE. Before this split, an old cursor was reported
 * `stale` unconditionally, which conflated two different situations an operator
 * responds to differently: a WEDGED watcher (nothing is sweeping anything — go
 * look at the process) and a QUIET repository (the loop is turning fine, this
 * repo just has no traffic — nothing to do). On a watcher whose configured
 * repositories are mostly idle, the old reading painted the whole page red and
 * trained the operator to ignore it, which is how a genuine wedge hides.
 *
 * `watcherLive` is the process-level fact from `../status/pass-liveness`, and it
 * is a PARAMETER rather than something derived here so this function keeps
 * exactly one job. Callers that cannot observe loop liveness pass `false`, which
 * reproduces the previous behaviour exactly — an unknown loop is not evidence of
 * a live one.
 *
 * @param repo - the bounded per-repository status
 * @param pollIntervalMinutes - the configured cadence; the threshold is 2x it
 * @param now - the instant to judge cursor age against, ISO-8601
 * @param watcherLive - whether the reconciliation loop itself is demonstrably
 *   live. Defaults to `false`: absent evidence, an old cursor keeps its old
 *   `stale` reading rather than being quietly excused.
 */
export const repoHealth = traced(
	"status.repoHealth",
	function repoHealth(
		repo: RepoStatus,
		pollIntervalMinutes: number,
		now: string,
		watcherLive = false,
	): Health {
		if (repo.lastSweep === null) {
			return "idle";
		}
		const ageMs = Date.parse(now) - Date.parse(repo.lastSweep);
		if (ageMs > pollIntervalMinutes * 60_000 * 2) {
			// The one place the two facts are distinguished. A failing repository still
			// reports `degraded` below when its cursor is FRESH; an old cursor is the
			// coarser signal and it answers "who is not looking" first.
			return watcherLive ? "quiet" : "stale";
		}
		if (repo.jobsFailed > 0 || repo.lastError !== null) {
			return "degraded";
		}
		return "ok";
	},
);

const STYLE = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 2rem; }
h1 { font-size: 1.3rem; }
table { border-collapse: collapse; width: 100%; margin-top: 1rem; }
th, td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #8884; }
th { font-weight: 600; }
.badge { padding: 0.1rem 0.5rem; border-radius: 0.5rem; font-size: 0.8rem; }
.ok { background: #1a7f37; color: #fff; }
.degraded { background: #bf8700; color: #fff; }
.stale { background: #cf222e; color: #fff; }
.idle { background: #6e7781; color: #fff; }
/* An old cursor while the loop IS live: informational, not an alarm. */
.quiet { background: #6e7781; color: #fff; }
.missed { background: #bf8700; color: #fff; }
.failed { background: #cf222e; color: #fff; }
.muted { color: #8888; }
.err { color: #cf222e; }
`.trim();

function renderRow(
	repo: RepoStatus,
	pollIntervalMinutes: number,
	now: string,
	watcherLive: boolean,
): string {
	const health = repoHealth(repo, pollIntervalMinutes, now, watcherLive);
	const sweep = repo.lastSweep ? escapeHtml(repo.lastSweep) : "—";
	const err = repo.lastError
		? `<span class="err">${escapeHtml(repo.lastError)}</span>`
		: '<span class="muted">—</span>';
	return `<tr>
  <td>${escapeHtml(repo.repository)}</td>
  <td><span class="badge ${health}">${health}</span></td>
  <td>${escapeHtml(repo.checks)}</td>
  <td>${sweep}</td>
  <td>${repo.issueCount}</td>
  <td>${repo.pullCount}</td>
  <td>${repo.jobsPending}</td>
  <td>${repo.jobsRunning}</td>
  <td>${repo.jobsCompleted}</td>
  <td>${repo.jobsFailed}</td>
  <td>${err}</td>
</tr>`;
}

/**
 * Render the held-runner-box section. Empty-guarded
 * section: an idle pool is the normal steady state and renders nothing.
 *
 * Every value is escaped. `held_by_job_id` is watcher-generated (`rw-<type>-<uuid>`)
 * rather than repository-supplied, but it reaches an HTML page, and "trusted
 * today" is not a property worth betting a page on.
 */
function renderHeldBoxesSection(heldBoxes: HeldBoxStatus[]): string {
	if (heldBoxes.length === 0) {
		return "";
	}
	const rows = heldBoxes
		.map(
			(box) => `<tr>
  <td>${box.vmid}</td>
  <td>${escapeHtml(box.band)}</td>
  <td>${escapeHtml(box.ip ?? "—")}</td>
  <td>${escapeHtml(box.heldByJobId)}</td>
  <td>${escapeHtml(box.heldAt ?? "—")}</td>
</tr>`,
		)
		.join("\n");
	return `
  <h2>Held runner boxes</h2>
  <p class="muted">A box held with no live job is leaked — reap it by vmid.</p>
  <table>
    <thead>
      <tr>
        <th>VMID</th><th>Band</th><th>IP</th><th>Held by</th><th>Since</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
}

/**
 * Render the unconfirmed-allocation section. Empty-guarded like the
 * held-boxes section: a healthy watcher has none, and rendering an empty table
 * would train an operator to skip the heading.
 *
 * Every value is escaped. The `runner_job_id` is watcher-generated and the
 * command is a fixed constant, but both reach an HTML page, and "trusted today"
 * is not a property worth betting a page on.
 *
 * The copy names the NON-ACTION deliberately. An operator reading "a box may be
 * running" reaches for the reap; the sentence has to say, at the moment of
 * reaching, that the box was never named and must be identified before anything
 * is powered off.
 */
function renderUnconfirmedAllocationsSection(
	rows: UnconfirmedAllocationStatus[] | undefined,
): string {
	// TOLERATE AN ABSENT FIELD. The parameter is typed non-optional, but this
	// renderer is also handed snapshots that were not produced by THIS build's
	// `getStatus` — the doctor probe assembles one, and a `/status.json` captured
	// before sf#179 has no such key. A bare `.length` on that input throws and
	// takes the WHOLE page down over a section that had nothing to show, which is
	// a strictly worse failure than omitting it.
	if (!rows || rows.length === 0) {
		return "";
	}
	const body = rows
		.map(
			(row) => `<tr>
  <td>${row.attemptId}</td>
  <td>${row.jobId}</td>
  <td>${escapeHtml(row.runnerJobId)}</td>
  <td>${escapeHtml(row.startedAt ?? "—")}</td>
  <td><code>${escapeHtml(row.listCommand)}</code></td>
</tr>`,
		)
		.join("\n");
	return `
  <h2>Unconfirmed allocations</h2>
  <p class="muted">These allocations never returned a vmid, so a box may be RUNNING that no row can name. Nothing is reaped automatically. Run the list command, match the runner job id, then reap by the vmid that match gives you — never before.</p>
  <table>
    <thead>
      <tr>
        <th>Attempt</th><th>Job</th><th>Runner job id</th><th>Started</th><th>Identify with</th>
      </tr>
    </thead>
    <tbody>
${body}
    </tbody>
  </table>`;
}

/**
 * The Langfuse trace URL for one trace id, or null when no usable base URL is
 * configured.
 *
 * PARSED, NOT CONCATENATED. `LANGFUSE_BASE_URL` is operator-supplied environment,
 * and a string-built `href` from operator input is how a `javascript:` scheme
 * gets into an anchor. `new URL` both normalizes the join (trailing slash or not)
 * and gives a scheme to check; anything that is not `http`/`https` yields no link
 * at all rather than a link the page cannot vouch for.
 *
 * THE SCHEME CHECK IS REACHABLE AND LOAD-BEARING, and the obvious probe for it is
 * not. `javascript:alert(1)` THROWS out of `new URL` and lands in the catch, so a
 * test using it passes with this check deleted (verified by mutation). The bases
 * that actually reach it PARSE — `javascript://evil.com` yields a clean
 * `javascript://evil.com/trace/...`, and `file:`/`ftp:` parse too. The test uses
 * those three for that reason.
 *
 * ABSENT ENV IS A FIRST-CLASS CASE, NOT A DEGRADED ONE. A watcher with no
 * Langfuse configured emits no traces, and one whose operator has not put the
 * base URL in the status process's environment still has valid trace ids. Both
 * render the id as PLAIN TEXT — the id is what a factory comment names and what
 * the operator resolves by hand, so the row remains useful with no link on it.
 *
 * The empty-string return is DECLARATIVE, not defensive: an empty base makes the
 * `new URL` call below throw, so removing it changes no behavior (probed both
 * ways). It stays because the primary case must not depend on an exception thrown
 * for an unrelated reason — a later change that supplies a default base would
 * silently turn "no Langfuse configured" into a link to nowhere.
 *
 * The trace id is watcher-derived (`attempt-N-<host>`), but it reaches a URL
 * path, so it is percent-encoded rather than trusted for being ours.
 */
function traceHref(baseUrl: string | undefined, traceId: string): string | null {
	const trimmed = baseUrl?.trim() ?? "";
	if (trimmed === "") {
		return null;
	}
	try {
		const url = new URL(
			`./trace/${encodeURIComponent(traceId)}`,
			`${trimmed.replace(/\/+$/, "")}/`,
		);
		if (url.protocol !== "http:" && url.protocol !== "https:") {
			return null;
		}
		return url.toString();
	} catch {
		// A malformed base URL renders plain ids, exactly as an absent one does. The
		// status page never fails to render because an env var is wrong.
		return null;
	}
}

/**
 * Render the recent traced attempts — the surface where the run reference
 * a factory comment carries as bare ids becomes clickable.
 *
 * THIS IS THE ONLY SURFACE THAT KNOWS THE LANGFUSE HOST, by ruling: forge
 * comments carry `job N, attempt M` and nothing else, because the host is
 * LAN/tailnet-internal and a comment is outward-facing. The status page is bound
 * to localhost and read by the operator, so the link belongs here and only here.
 *
 * Empty-guarded, unlike the host-conflict section: an empty list here means "no
 * attempt has been observed yet", which is the ordinary state of a fresh watcher
 * and not a fact worth a permanent empty table.
 *
 * Every value is escaped even though all of them are watcher-derived: the page is
 * the boundary, and a value's provenance three modules away is not a property
 * this function can check.
 */
function renderTracedAttemptsSection(
	tracedAttempts: TracedAttemptStatus[],
	langfuseBaseUrl: string | undefined,
): string {
	if (tracedAttempts.length === 0) {
		return "";
	}
	const rows = tracedAttempts
		.map((attempt) => {
			const href = traceHref(langfuseBaseUrl, attempt.traceId);
			const trace =
				href === null
					? escapeHtml(attempt.traceId)
					: `<a href="${escapeHtml(href)}">${escapeHtml(attempt.traceId)}</a>`;
			return `<tr>
  <td>${attempt.attemptId}</td>
  <td>${attempt.jobId}</td>
  <td>${escapeHtml(attempt.jobType)}</td>
  <td>${escapeHtml(attempt.repository)}</td>
  <td>${escapeHtml(attempt.startedAt ?? "—")}</td>
  <td>${trace}</td>
</tr>`;
		})
		.join("\n");
	const note =
		traceHref(langfuseBaseUrl, "probe") === null
			? "No <code>LANGFUSE_BASE_URL</code> configured for this process, so trace ids render as plain text — resolve one by hand in Langfuse."
			: "A factory comment names the run as <code>job N, attempt M</code>; this is where that run becomes clickable.";
	return `
  <h2>Recent traced attempts</h2>
  <p class="muted">${note}</p>
  <table>
    <thead>
      <tr>
        <th>Attempt</th><th>Job</th><th>Lane</th><th>Repository</th>
        <th>Started</th><th>Trace</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>`;
}

/**
 * Render the host-conflict tripwire.
 *
 * UNLIKE the held-boxes section, this is NOT empty-guarded on a zero
 * count: zero is the tripwire's healthy reading and showing it is the point — a
 * section that vanishes when the count is 0 is indistinguishable from a section
 * that was never wired up, which is exactly the failure this issue exists to fix.
 * It is omitted only when the snapshot carries no tally at all (`undefined`),
 * which means the caller had no observer to read rather than that it saw none.
 *
 * Every value is escaped. The models came off runner boxes (already redacted and
 * length-bounded at the stamp) and the hostname is watcher-resolved, but both
 * reach an HTML page, so neither is trusted here.
 */
function renderHostConflictsSection(conflicts: HostConflictStatus | undefined): string {
	if (conflicts === undefined) {
		return "";
	}
	const badge = conflicts.count > 0 ? "degraded" : "ok";
	const pairs =
		conflicts.lastPairs.length > 0
			? conflicts.lastPairs
					.map((pair) => `${escapeHtml(pair.host)} → ${escapeHtml(pair.model)}`)
					.join("<br>")
			: '<span class="muted">—</span>';
	const attempt = conflicts.lastAttemptId
		? escapeHtml(conflicts.lastAttemptId)
		: '<span class="muted">—</span>';
	const at = conflicts.lastAt ? escapeHtml(conflicts.lastAt) : '<span class="muted">—</span>';
	return `
  <h2>Model host conflicts</h2>
  <p class="muted">Two hosts attested different models for one attempt. Count is since process start; every occurrence is also logged as <code>observability.model.host_conflict</code>.</p>
  <table>
    <thead>
      <tr>
        <th>Count</th><th>Last attempt</th><th>Last seen</th><th>Host → model</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><span class="badge ${badge}">${conflicts.count}</span></td>
        <td>${attempt}</td>
        <td>${at}</td>
        <td>${pairs}</td>
      </tr>
    </tbody>
  </table>`;
}

/**
 * Render the watcher's own process-level liveness — the fact that is NOT
 * about any repository.
 *
 * This section exists because the page previously had no way to say "the loop is
 * turning": every signal on it was per-repository and cursor-derived, so a
 * wedged scheduler and a quiet week looked identical. It reports when the last
 * pass STARTED, whether that is inside the staleness threshold, and the
 * repositories behind the last pass's fail count — the detail `failCount` alone
 * never named.
 *
 * Omitted entirely when the snapshot carries no liveness record, so a caller
 * that drives no scheduler (the doctor probe) shows nothing rather than a false
 * "no pass has ever started".
 */
function renderWatcherSection(
	snapshot: StatusSnapshot,
	pollIntervalMinutes: number,
	watcherLive: boolean,
): string {
	if (snapshot.lastPassStartedAt === undefined) {
		return "";
	}
	const started = snapshot.lastPassStartedAt;
	const health: Health = watcherLive ? "ok" : "stale";
	const startedCell = started === null ? "—" : escapeHtml(started);
	const finished = snapshot.lastPassFinishedAt;
	const finishedCell = finished === null || finished === undefined ? "—" : escapeHtml(finished);
	const errors = snapshot.lastPassRepoErrors ?? [];
	const errorCell =
		errors.length === 0
			? '<span class="muted">—</span>'
			: errors
					.map(
						(entry) =>
							`<span class="err">${escapeHtml(entry.repository)}: ${escapeHtml(entry.error)}</span>`,
					)
					.join("<br>");
	return `
  <h2>Watcher</h2>
  <p class="muted">Whether the reconciliation loop is turning — a different fact
  from any repository's cursor age. Stale after ${pollIntervalMinutes * 2} minutes
  (2x the poll interval).</p>
  <table>
    <thead>
      <tr>
        <th>Loop</th><th>Last pass started</th><th>Last pass finished</th>
        <th>Ok</th><th>Failed</th><th>Passes started</th><th>Failures</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><span class="badge ${health}">${health}</span></td>
        <td>${startedCell}</td>
        <td>${finishedCell}</td>
        <td>${snapshot.lastPassOk ?? 0}</td>
        <td>${snapshot.lastPassFailCount ?? 0}</td>
        <td>${snapshot.passesStarted ?? 0}</td>
        <td>${errorCell}</td>
      </tr>
    </tbody>
  </table>`;
}

/**
 * Render the queue-health gauges — is the dispatch queue starving, and
 * is the reaper firing.
 *
 * NOT EMPTY-GUARDED ON ZERO, on the host-conflict section's precedent: zero
 * zombies is the HEALTHY reading and showing it is the whole point. A section
 * that vanished at 0 would be indistinguishable from a section nobody wired up,
 * which is the failure mode (trap #84) this gauge exists to remove.
 *
 * OMITTED only when the snapshot carries none of the three (`undefined`), which
 * means the caller measured nothing rather than measured zero — a `/status.json`
 * captured before sf#482, or the doctor probe's assembled snapshot. Reading
 * `undefined` as 0 would put a fabricated all-clear on the page.
 *
 * SURFACING ONLY: the copy names the condition and the operator's next look. No
 * remediation is offered here, because remediation is the sf#481 dispatch-time
 * reap's job and paging is the monitoring path's.
 */
function renderQueueHealthSection(snapshot: StatusSnapshot): string {
	if (snapshot.zombiePending === undefined) {
		return "";
	}
	const zombies = snapshot.zombiePending;
	const badge: Health = zombies > 0 ? "degraded" : "ok";
	const oldest = snapshot.oldestDuePendingMinutes;
	// An em dash, not `0m`: nothing due is a different fact from something due
	// zero minutes ago.
	const oldestCell =
		oldest === null || oldest === undefined ? '<span class="muted">—</span>' : `${oldest}m`;
	return `
  <h2>Queue health</h2>
  <p class="muted">A pending job bound to a CLOSED item can never become eligible
  again — it re-arms every defer window and re-takes an id-ordered dispatch slot
  forever (sf#444). The sf#481 dispatch-time reap terminalizes these, so zero is
  the healthy reading; anything else means the reap is behind or not running.
  Nothing on this page acts — it reports.</p>
  <table>
    <thead>
      <tr>
        <th>Zombie pending</th><th>Oldest due pending</th><th>Reaped (last 20m)</th>
      </tr>
    </thead>
    <tbody>
      <tr>
        <td><span class="badge ${badge}">${zombies}</span></td>
        <td>${oldestCell}</td>
        <td>${snapshot.reapedLastSweep ?? 0}</td>
      </tr>
    </tbody>
  </table>`;
}

/**
 * Compose every optional section of the page, in their fixed display order.
 *
 * Extracted from {@link renderStatusHtml} to keep it inside the function-length
 * ceiling. THE ORDER IS THE CONTRACT this returns: each section empty-guards
 * itself, so an idle watcher yields the empty string and the page shows only the
 * repository table.
 */
function renderSections(
	snapshot: StatusSnapshot,
	pollIntervalMinutes: number,
	watcherLive: boolean,
	langfuseBaseUrl?: string,
): string {
	const watcherSection = renderWatcherSection(snapshot, pollIntervalMinutes, watcherLive);
	// Directly after the watcher's own liveness: both answer "is the machine
	// moving", and an operator reading a stale loop wants the queue depth next.
	const queueHealthSection = renderQueueHealthSection(snapshot);
	const heldBoxesSection = renderHeldBoxesSection(snapshot.heldBoxes);
	const unconfirmedSection = renderUnconfirmedAllocationsSection(snapshot.unconfirmedAllocations);
	const hostConflictsSection = renderHostConflictsSection(snapshot.hostConflicts);
	const tracedAttemptsSection = renderTracedAttemptsSection(
		snapshot.tracedAttempts,
		langfuseBaseUrl,
	);

	return `${watcherSection}${queueHealthSection}${heldBoxesSection}${unconfirmedSection}${tracedAttemptsSection}${hostConflictsSection}`;
}

/**
 * Render the full status page.
 *
 * @param snapshot - the bounded status snapshot
 * @param pollIntervalMinutes - configured interval, for staleness classification
 * @param langfuseBaseUrl - the Langfuse base URL trace links are composed from.
 *  OPTIONAL, and deliberately not on the snapshot: `/status.json` must
 *   stay free of the internal host, so the base URL reaches the HTML renderer and
 *   nothing else. Absent renders trace ids as plain text.
 */
function renderStatusHtmlImpl(
	snapshot: StatusSnapshot,
	pollIntervalMinutes: number,
	langfuseBaseUrl?: string,
): string {
	// The process-level fact, computed ONCE and handed to every row. A row's
	// old cursor means something different depending on it, so deriving it per row
	// would invite the two answers to disagree within one page.
	const watcherLive = isPassLive(
		snapshot.lastPassStartedAt ?? null,
		pollIntervalMinutes,
		Date.parse(snapshot.generatedAt),
	);
	const rows =
		snapshot.repositories.length > 0
			? snapshot.repositories
					.map((r) => renderRow(r, pollIntervalMinutes, snapshot.generatedAt, watcherLive))
					.join("\n")
			: '<tr><td colspan="10" class="muted">No repositories reconciled yet.</td></tr>';

	const sections = renderSections(snapshot, pollIntervalMinutes, watcherLive, langfuseBaseUrl);

	return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>software-factory status</title>
  <style>${STYLE}</style>
</head>
<body>
  <h1>software-factory status</h1>
  <p class="muted">Generated ${escapeHtml(snapshot.generatedAt)}</p>
  <table>
    <thead>
      <tr>
        <th>Repository</th><th>Health</th><th>Checks</th><th>Last sweep</th>
        <th>Issues</th><th>PRs</th><th>Pending</th><th>Running</th>
        <th>Done</th><th>Failed</th><th>Last error</th>
      </tr>
    </thead>
    <tbody>
${rows}
    </tbody>
  </table>${sections}
</body>
</html>`;
}

export const renderStatusHtml = traced(
	"status.renderStatusHtml",
	renderStatusHtmlImpl,
) as typeof renderStatusHtmlImpl;
