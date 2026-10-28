/**
 * @module src/status/metrics
 * @description Render the status snapshot as Prometheus text-format metrics, so
 *   the factory's WORK is scrapeable.
 *
 *   WHY THIS EXISTS. Before it, the only `factory_*` series on the box described
 *   the REAPER -- the janitor -- and the status-page timestamp. Nothing counted a
 *   dispatch, a completion, or a failure, so no alert could fire on the work going
 *   wrong. Observed 2026-09-17, live: `open-brain` at 63 completed against 240
 *   failed and `rtech-infra` at 2 against 221, with no series carrying either
 *   number and nothing having ever alerted.
 *
 *   WHY IT IS A RENDERER AND NOT AN INSTRUMENT. Every number here is ALREADY in
 *   the snapshot that `/status.json` serves; this module only re-expresses it in
 *   text format. That means no counter state, no registry, no new dependency
 *   (`prom-client` is deliberately not added), and no second source of truth that
 *   can disagree with the status page. The snapshot is the source; this is a view.
 *
 *   ONE SERIES PER (repository, provider). Uniqueness is provider-qualified, so
 *   the same `owner/repo` can appear once per forge; live 2026-09-17 four names
 *   carried both a live `forgejo` row and a `github` row frozen at the Forge flag
 *   day. Both rows get their own series, because a counter must never
 *   change which row it reads from -- a switch looks like a counter RESET to
 *   `rate()` and reports work that never happened.
 *
 *   Forge is the git provider and GitHub a read-only backup, so
 *   `factory_repo_authoritative` marks the row that speaks for a repository
 *   (Forge where present, else newest). A query wanting the live number filters
 *   `provider="forgejo"` or joins on that series. Two earlier shapes were wrong:
 *   SUMMING the rows reported `software-factory` at 254 failures when the live
 *   figure was 141, and selecting one row per name made the counters resettable.
 *
 *   COUNTERS VS GAUGES. `jobsCompleted` is a cumulative total read from the
 *   database, so it is typed `counter` and named `_total`, which is what lets
 *   `rate()` and `increase()` work over it. `jobsPending`/`jobsRunning`/`jobsFailed`
 *   are point-in-time depths, so they are gauges -- `jobsFailed` included,
 *   because an infra requeue moves a job failed -> pending and the count DROPS.
 *  Typing a cumulative total as a
 *   gauge is the mistake that makes an alert rule silently useless, because
 *   `increase()` over a gauge is not defined.
 *
 *   WORK SERIES. Dispatches, results ingested, publications posted, and
 *   webhook deliveries by event are `_total` counters because each reads a set of
 *   rows that is never deleted and never leaves the counted state (sources in
 *   `renderWorkMetrics`); jobs by status is a gauge. Alert deliveries are the one
 *   process-local counter, reset on restart like `factory_host_conflicts_total`.
 *   The `status` label is the factory's own job vocabulary; `event` is the event
 *   header of an HMAC-admitted Forgejo delivery (Forgejo's fixed event set), and
 *   is escaped like every other label value.
 *
 *   LABEL CARDINALITY is bounded by the managed-repository allowlist -- one series
 *   per repository per metric, and that list is operator-maintained config, not
 *   anything a runner or a forge payload can grow. No job id, attempt id, vmid, or
 *   error text is ever a label: those are unbounded by construction and are what
 *   turn a scrape target into an outage.
 *
 * @dependencies
 *   - ./query -- the StatusSnapshot shape this renders
 */

import { traced } from "../log";
import type { StatusSnapshot } from "./query";

/**
 * Escape a Prometheus label VALUE: backslash, double quote, and newline, in that
 * order (the backslash first, or the escapes introduced after it are re-escaped).
 *
 * Repository names are `owner/name` and contain none of these today. This exists
 * because a label value that can carry a raw quote can terminate the label and
 * inject a series, and "the input is well-formed today" is not a property this
 * module controls.
 */
function escapeLabelValue(value: string): string {
	return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** One `# HELP` + `# TYPE` header pair. */
function header(name: string, help: string, type: "counter" | "gauge"): string {
	return `# HELP ${name} ${help}\n# TYPE ${name} ${type}\n`;
}

/**
 * Render `snapshot` as a Prometheus text-format exposition.
 *
 * Pure over its input and newline-terminated, as the format requires.
 *
 * ZERO VS ABSENT, precisely. A repository PRESENT in the
 * snapshot with no activity emits an explicit `0` rather than being skipped, so
 * "nothing happened" is distinguishable from "this repository vanished". But a
 * repository ABSENT from the snapshot emits nothing at all: a labelled series
 * needs a label value, and this module is a renderer over the snapshot with no
 * access to the managed-repository allowlist -- inventing series for names it
 * cannot see would be a second source of truth, which is exactly what this
 * module exists not to be.
 *
 * So an empty snapshot yields the HELP/TYPE headers and no samples. The
 * whole-watcher scalars below are ALWAYS emitted, and
 * `factory_status_generated_timestamp_seconds` is the liveness signal: it
 * advancing with no repository samples means "configured with no repositories",
 * while the whole exposition going away means the exporter is down.
 */
export const renderMetrics = traced(
	"status.renderMetrics",
	function renderMetrics(snapshot: StatusSnapshot): string {
		return [
			renderRepoMetrics(snapshot),
			renderWatcherMetrics(snapshot),
			renderWorkMetrics(snapshot),
		].join("");
	},
);

/** One labelled sample line. */
function labelled(name: string, label: string, value: string, n: number): string {
	return `${name}{${label}="${escapeLabelValue(value)}"} ${n}\n`;
}

/**
 * The sf#824 work series. Each is emitted ONLY when its source was measured:
 * `work` is absent on a snapshot assembled without the database read (the doctor
 * probe) and `alertDeliveries` without a tally, and an unmeasured source must be
 * absent rather than a false zero.
 *
 * Sources and types (the COUNTERS VS GAUGES rule in the header):
 *   - `factory_dispatches_total` counter -- `job_attempts` past `allocating`
 *   - `factory_results_ingested_total` counter -- `result_postings` rows
 *   - `factory_publications_posted_total` counter -- `github_postings.posted_at` set
 *   - `factory_webhook_deliveries_total{event}` counter -- `forge_deliveries`
 *   - `factory_jobs_by_status{status}` GAUGE -- `jobs.status` now (moves both ways)
 *   - `factory_alert_deliveries_total{outcome}` counter -- process-local tally,
 *     so it resets on restart, which `rate()` reads as a legitimate counter reset
 */
function renderWorkMetrics(snapshot: StatusSnapshot): string {
	const out: string[] = [];
	const work = snapshot.work;
	if (work !== undefined) {
		const totals: ReadonlyArray<[string, string, number]> = [
			[
				"factory_dispatches_total",
				"Runner dispatches (attempts past allocating).",
				work.dispatches,
			],
			[
				"factory_results_ingested_total",
				"Runner results ingested, valid or invalid.",
				work.resultsIngested,
			],
			["factory_publications_posted_total", "Forge publications posted.", work.publicationsPosted],
		];
		for (const [name, help, n] of totals) {
			out.push(header(name, help, "counter"), `${name} ${n}\n`);
		}
		out.push(
			header(
				"factory_webhook_deliveries_total",
				"Forge webhook deliveries recorded, by event.",
				"counter",
			),
		);
		for (const d of work.webhookDeliveries) {
			out.push(labelled("factory_webhook_deliveries_total", "event", d.event, d.count));
		}
		out.push(header("factory_jobs_by_status", "Jobs currently in each status.", "gauge"));
		for (const j of work.jobsByStatus) {
			out.push(labelled("factory_jobs_by_status", "status", j.status, j.count));
		}
	}
	const alerts = snapshot.alertDeliveries;
	if (alerts !== undefined) {
		const name = "factory_alert_deliveries_total";
		out.push(header(name, "Critical-alert deliveries since process start, by outcome.", "counter"));
		out.push(labelled(name, "outcome", "delivered", alerts.delivered));
		out.push(labelled(name, "outcome", "undelivered", alerts.undelivered));
	}
	return out.join("");
}

/**
 * The four per-repository work numbers plus the error flag.
 *
 * Table-driven rather than five near-identical loops: adding a sixth number is a
 * row here, and the `counter`/`gauge` choice stays visible beside the field it
 * describes instead of drifting into a copied block.
 */
const REPO_SERIES: ReadonlyArray<{
	name: string;
	help: string;
	type: "counter" | "gauge";
	value: (r: StatusSnapshot["repositories"][number]) => number;
}> = [
	{
		name: "factory_jobs_pending",
		help: "Jobs queued and not yet dispatched.",
		type: "gauge",
		value: (r) => r.jobsPending,
	},
	{
		name: "factory_jobs_running",
		help: "Jobs currently dispatched to a runner.",
		type: "gauge",
		value: (r) => r.jobsRunning,
	},
	{
		name: "factory_jobs_completed_total",
		help: "Jobs that ingested a valid result.",
		type: "counter",
		value: (r) => r.jobsCompleted,
	},
	// NOT "jobs that produced a bad review": in this schema a job ends `failed`
	// when no valid result was ingested, which includes an infrastructure abort.
	// A GAUGE, not a counter: it is a live `jobs.status = 'failed'` row
	// count, and the infra requeue (reconcile/dispatch-pass.ts, releaseJob with
	// expectedStatus "failed") moves a job back to pending, so it DECREASES.
	// Typed counter, every requeue read as a reset to `rate()`/`increase()`.
	{
		name: "factory_jobs_failed",
		help: "Jobs currently in status failed (decreases on infra requeue)",
		type: "gauge",
		value: (r) => r.jobsFailed,
	},
];

/**
 * Pick the row that was swept most recently, for a name that has several.
 *
 * `lastSweep` is an ISO timestamp or null; a null (never swept) loses to any
 * real one, and an unparseable value is treated as null rather than throwing --
 * a malformed cursor must not take the metrics down with it.
 *
 * ON A TIE THE FIRST ROW WINS (strict `>`), which matters only when two rows
 * share a timestamp or both are null. "Newest" is genuinely undefined there, so
 * the rule is arbitrary -- but it is DETERMINISTIC, because `getStatus` orders
 * repositories by `(fullName, id)`. That matters: `fullName` alone is not unique
 * and Postgres leaves equal sort keys in an undefined order, so before that
 * ordering was made total a tie here could resolve differently between scrapes
 * and flap the metric, which an alert reads as a real state change (sf#796
 * review). The tie-break is positional, so the position has to be stable.
 */
function newestRow<T extends { lastSweep: string | null }>(rows: readonly T[]): T | undefined {
	let best: T | undefined;
	let bestMs = Number.NEGATIVE_INFINITY;
	for (const r of rows) {
		const ms = r.lastSweep === null ? Number.NEGATIVE_INFINITY : Date.parse(r.lastSweep);
		const usable = Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
		if (best === undefined || usable > bestMs) {
			best = r;
			bestMs = usable;
		}
	}
	return best;
}

/**
 * `factory_repo_last_error`, computed from the NEWEST-SWEPT row only.
 *
 * Deliberately NOT part of {@link REPO_SERIES}: every series there is summed
 * across the rows sharing a name, and this flag is not summable. ORing it means
 * an error recorded by a stale row pins the metric at 1 forever, even after a
 * newer sweep succeeds -- and the rows really do span weeks. Live 2026-09-17,
 * `rodaddy/rtech-infra` carried two rows swept 18 days apart (2026-09-17 and
 * 2026-08-30), so the August row would have held the alert on indefinitely.
 *
 * WHICH row is "the" row: the AUTHORITATIVE provider's newest sweep, not the
 * globally newest. Forge wins wherever both providers carry the same repository
 * name (Forge is primary, GitHub is a backup outside
 * client), so a GitHub row swept more recently than the Forge row does NOT decide
 * this flag. That preference is deliberate; the HELP text says so rather than
 * claiming a plain "newest sweep" it does not implement.
 */
function renderLastErrorMetric(
	byName: ReadonlyMap<string, StatusSnapshot["repositories"]>,
): string {
	const out: string[] = [
		header(
			"factory_repo_last_error",
			"1 when the authoritative provider's newest-swept row recorded an error (Forge wins where both exist).",
			"gauge",
		),
	];
	for (const [repository, rows] of byName) {
		// Bounded to 0/1 and carrying NO error text: `lastError` is a bounded
		// summary, but it is still runner-influenced free text and belongs nowhere
		// near a label.
		//
		// Carries the authoritative row's `provider` so this joins to the counters
		// on the same `(repository, provider)` key. One series per NAME here, not
		// per row: "did this repository's newest attempt fail" is a single question,
		// and the answer comes from the row that speaks for it.
		const newest = authoritativeRow(rows);
		const value = newest === undefined || newest.lastError === null ? 0 : 1;
		const provider = newest?.provider ?? "";
		out.push(
			`factory_repo_last_error{repository="${escapeLabelValue(repository)}",provider="${escapeLabelValue(provider)}"} ${value}\n`,
		);
	}
	return out.join("");
}

/**
 * Choose the ONE authoritative row for a repository name: FORGE WINS.
 *
 * Uniqueness is provider-qualified, so the same `owner/repo` can appear once per
 * forge, and four names did live 2026-09-17. Those pairs are not two halves of
 * one repository -- they are the Forge-era row and a GitHub-era row frozen at
 * the flag day: `rodaddy/software-factory` last swept 2026-09-17 under
 * `forgejo` and 2026-08-28 under `github`, `rodaddy/rtech-infra` 2026-09-17 and
 * 2026-08-30.
 *
 * Forge is the git provider; GitHub is a read-only
 * backup mirror. So where both exist the Forge row is the answer and the GitHub
 * row is dead history. SUMMING them -- which this module did first -- reported
 * `software-factory` at 254 failures when the live number was 141, a total that
 * described neither forge.
 *
 * Where only one row exists it wins regardless of provider: `rodaddy/open-brain`
 * and `rodaddy/rtech-audit` are github-only in this table, and a naive
 * "forgejo only" filter would drop them from the metrics entirely -- including
 * open-brain, the worst failure count on the box.
 *
 * THE CLIENT ORG is the standing exception to "Forge wins" in general, but no client
 * repository is in this table (all 16 rows are `rodaddy` or `acme`), so
 * the rule needs no carve-out here. If one is added later, it arrives as a
 * github-only row and the single-row branch already does the right thing.
 */
function authoritativeRow(
	rows: StatusSnapshot["repositories"],
): StatusSnapshot["repositories"][number] | undefined {
	const forge = rows.filter((r) => r.provider === "forgejo");
	return forge.length > 0 ? newestRow(forge) : newestRow(rows);
}

/** Render the per-repository series, one line per repository NAME. */
function renderRepoMetrics(snapshot: StatusSnapshot): string {
	const series = REPO_SERIES;

	// ONE SERIES PER (repository, provider), NOT per repository name.
	//
	// The label pair is what makes the counters sound. Keying
	// on the name alone means the sample comes from whichever row is currently
	// authoritative, and that row can CHANGE -- a github-only repository that
	// gains a Forge row switches source, and the Forge row's independent totals
	// are lower. Prometheus reads a `_total` going down as a counter RESET, so
	// `increase()` and `rate()` then report a burst of work that never happened.
	// Giving each forge its own series means no series ever switches its source,
	// and the two rows' counters advance independently and monotonically.
	//
	// It also removes the duplicate-label hazard by construction: `(provider,
	// full_name)` is the table's own unique key, so no two samples can collide.
	// That matters because identical labels are a parse error that makes
	// Prometheus discard the WHOLE scrape -- every metric absent, not just wrong.
	//
	// A query wanting "the real number" filters `provider="forgejo"`, which is
	// the Forge-wins rule expressed where it belongs: in the query, not baked
	// irreversibly into the exposition. `factory_repo_authoritative` below marks
	// which row that is, so the rule survives without hiding the other row.
	const out: string[] = [];
	for (const s of series) {
		out.push(header(s.name, s.help, s.type));
		for (const r of snapshot.repositories) {
			out.push(
				`${s.name}{repository="${escapeLabelValue(r.repository)}",provider="${escapeLabelValue(r.provider)}"} ${s.value(r)}\n`,
			);
		}
	}

	const byName = new Map<string, StatusSnapshot["repositories"]>();
	for (const r of snapshot.repositories) {
		byName.set(r.repository, [...(byName.get(r.repository) ?? []), r]);
	}
	out.push(renderAuthoritativeMetric(snapshot, byName));
	out.push(renderLastErrorMetric(byName));
	return out.join("");
}

/**
 * `factory_repo_authoritative` -- 1 on the row that speaks for the repository.
 *
 * Forge wins where a Forge row exists, else the newest row (see
 * {@link authoritativeRow}). Emitting this as its own series rather than
 * filtering the others keeps BOTH forges' counters visible and monotonic while
 * still letting a rule say "the live number" without knowing the migration
 * history:
 *
 *   factory_jobs_completed_total * on(repository,provider) factory_repo_authoritative
 */
function renderAuthoritativeMetric(
	snapshot: StatusSnapshot,
	byName: ReadonlyMap<string, StatusSnapshot["repositories"]>,
): string {
	const chosen = new Set<StatusSnapshot["repositories"][number]>();
	for (const rows of byName.values()) {
		const row = authoritativeRow(rows);
		if (row !== undefined) {
			chosen.add(row);
		}
	}

	const out: string[] = [
		header(
			"factory_repo_authoritative",
			"1 on the row that speaks for this repository (Forge wins; else newest).",
			"gauge",
		),
	];
	for (const r of snapshot.repositories) {
		out.push(
			`factory_repo_authoritative{repository="${escapeLabelValue(r.repository)}",provider="${escapeLabelValue(r.provider)}"} ${chosen.has(r) ? 1 : 0}\n`,
		);
	}
	return out.join("");
}

/**
 * The whole-watcher scalars, as a static table.
 *
 * A module constant rather than a local, so `renderWatcherMetrics` stays a loop
 * and adding a number is one row. Each `value` reads the snapshot; none of them
 * computes anything, which keeps the "renderer, not instrument" property.
 */
const WATCHER_SCALARS: ReadonlyArray<{
	name: string;
	help: string;
	type: "counter" | "gauge";
	value: (s: StatusSnapshot) => number;
}> = [
	{
		name: "factory_passes_started_total",
		help: "Reconciliation passes started.",
		type: "counter",
		value: (s) => s.passesStarted ?? 0,
	},
	{
		name: "factory_passes_completed_total",
		help: "Reconciliation passes completed.",
		type: "counter",
		value: (s) => s.passesCompleted ?? 0,
	},
	{
		name: "factory_last_pass_repo_failures",
		help: "Repositories that errored in the newest pass.",
		type: "gauge",
		value: (s) => s.lastPassFailCount ?? 0,
	},
	{
		name: "factory_held_boxes",
		help: "Runner boxes the watcher believes it holds.",
		type: "gauge",
		value: (s) => s.heldBoxes.length,
	},
	{
		name: "factory_unconfirmed_allocations",
		help: "Attempts whose allocation never returned a vmid (likely leaked box).",
		type: "gauge",
		value: (s) => s.unconfirmedAllocations.length,
	},
	// `hostConflicts` is a single status OBJECT carrying a running `count`,
	// not a list -- its count only grows within a process, so it is a counter.
	{
		// Cumulative since process start, so it is a COUNTER and its name carries
		// the _total suffix. As a gauge, `increase()` and `rate()` are undefined
		// over it and a process restart cannot be read as a legitimate counter
		// reset.
		name: "factory_host_conflicts_total",
		help: "Host attestation conflicts since process start.",
		type: "counter",
		value: (s) => s.hostConflicts?.count ?? 0,
	},
	// The sf#699 headline: zero here while jobs complete is the signal that the
	// correlation between a run and its trace has broken.
	{
		name: "factory_traced_attempts",
		help: "Recent attempts carrying a Langfuse trace id.",
		type: "gauge",
		value: (s) => s.tracedAttempts.length,
	},
	{
		name: "factory_zombie_pending",
		help: "Pending jobs bound to a closed item.",
		type: "gauge",
		value: (s) => s.zombiePending ?? 0,
	},
];

/**
 * Whole-watcher health: pass progress, pool leaks, and traceability.
 *
 * Each of these was previously reachable only by reading the HTML status page.
 */
function renderWatcherMetrics(snapshot: StatusSnapshot): string {
	const out: string[] = [];
	for (const s of WATCHER_SCALARS) {
		out.push(header(s.name, s.help, s.type));
		out.push(`${s.name} ${s.value(snapshot)}\n`);
	}

	// The snapshot's own clock, so a rule can tell "all zero because idle" from
	// "all zero because this exposition is stale".
	const generatedMs = Date.parse(snapshot.generatedAt);
	if (Number.isFinite(generatedMs)) {
		out.push(
			header(
				"factory_status_generated_timestamp_seconds",
				"generatedAt of the snapshot these metrics were rendered from.",
				"gauge",
			),
		);
		out.push(`factory_status_generated_timestamp_seconds ${Math.floor(generatedMs / 1000)}\n`);
	}

	return out.join("");
}
