/**
 * @module tests/status/metrics
 * @description Proves the Prometheus exposition carries the factory's WORK
 *   numbers, with the two properties that decide whether an
 *   alert rule can be written against it: cumulative totals are typed `counter`,
 *   and label values are escaped.
 *
 *   The gap this covers, observed live 2026-09-17: the only `factory_*` series on
 *   the box described the reaper, while `open-brain` sat at 63 completed against
 *   240 failed with no series carrying either number.
 *
 * @dependencies
 *   - ../../src/status/metrics -- the renderer under test
 */

import { describe, expect, test } from "bun:test";
import {
	forgeDeliveries,
	githubPostings,
	jobAttempts,
	jobs,
	repositories,
	resultPostings,
} from "../../src/db/schema";
import { alertDeliveryTally } from "../../src/observability/alert-tally";
import { raiseCriticalAlert } from "../../src/observability/critical-alert";
import { ALLOCATING_ATTEMPT_STATUS } from "../../src/runner/attempt-record";
import { renderMetrics } from "../../src/status/metrics";
import { getStatus, type StatusSnapshot } from "../../src/status/query";
import { startStatusServer } from "../../src/status/server";
import { withTestDb } from "../db/helpers";

const NOW_DATE = "2026-09-24T12:00:00Z";

/** A snapshot with one busy repository and one idle one. */
function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
	return {
		generatedAt: "2026-09-17T21:25:58.210Z",
		repositories: [
			{
				repository: "rodaddy/open-brain",
				provider: "forgejo",
				checks: "static-only",
				lastSweep: "2026-09-17T20:00:00-04:00",
				issueCount: 10,
				pullCount: 3,
				jobsPending: 1,
				jobsRunning: 2,
				jobsCompleted: 63,
				jobsFailed: 240,
				lastError: "runner result identity is invalid",
			},
			{
				repository: "rodaddy/web-ops",
				provider: "forgejo",
				checks: "static-only",
				lastSweep: null,
				issueCount: 0,
				pullCount: 0,
				jobsPending: 0,
				jobsRunning: 0,
				jobsCompleted: 0,
				jobsFailed: 0,
				lastError: null,
			},
		],
		audits: [],
		heldBoxes: [],
		unconfirmedAllocations: [],
		tracedAttempts: [],
		passesStarted: 460,
		passesCompleted: 459,
		lastPassFailCount: 2,
		zombiePending: 0,
		...overrides,
	} as StatusSnapshot;
}

describe("renderMetrics", () => {
	test("carries per-repository job counts as labelled series", () => {
		const out = renderMetrics(snapshot());

		expect(out).toContain(
			'factory_jobs_completed_total{repository="rodaddy/open-brain",provider="forgejo"} 63',
		);
		expect(out).toContain(
			'factory_jobs_failed{repository="rodaddy/open-brain",provider="forgejo"} 240',
		);
		expect(out).toContain(
			'factory_jobs_pending{repository="rodaddy/open-brain",provider="forgejo"} 1',
		);
		expect(out).toContain(
			'factory_jobs_running{repository="rodaddy/open-brain",provider="forgejo"} 2',
		);
	});

	test("emits an idle repository as an explicit zero, not a gap", () => {
		// A missing series reads as "exporter down" to a rule; a present zero reads
		// as "nothing happened". They must not look the same.
		const out = renderMetrics(snapshot());
		expect(out).toContain('factory_jobs_failed{repository="rodaddy/web-ops",provider="forgejo"} 0');
	});

	test("types cumulative totals as counters and depths as gauges", () => {
		// This is the property an alert rule depends on: `increase()` over a gauge
		// is not defined, so a cumulative total typed `gauge` makes the rule
		// silently useless rather than wrong-looking.
		const out = renderMetrics(snapshot());

		expect(out).toContain("# TYPE factory_jobs_completed_total counter");
		expect(out).toContain("# TYPE factory_jobs_failed gauge");
		// sf#815: `jobs.status = 'failed'` drops when an infra failure is requeued
		// (failed -> pending), so it is a depth, not a total: gauge, no `_total`.
		expect(out).toContain(
			"# HELP factory_jobs_failed Jobs currently in status failed (decreases on infra requeue)",
		);
		expect(out).not.toContain("factory_jobs_failed_total");
		expect(out).toContain("# TYPE factory_jobs_pending gauge");
		expect(out).toContain("# TYPE factory_jobs_running gauge");
	});

	test("reduces lastError to 0/1 and never emits the error text", () => {
		const out = renderMetrics(snapshot());

		expect(out).toContain(
			'factory_repo_last_error{repository="rodaddy/open-brain",provider="forgejo"} 1',
		);
		expect(out).toContain(
			'factory_repo_last_error{repository="rodaddy/web-ops",provider="forgejo"} 0',
		);
		// The summary is runner-influenced text; it belongs nowhere in a label.
		expect(out).not.toContain("runner result identity is invalid");
	});

	test("carries watcher-wide pass and pool health", () => {
		const out = renderMetrics(snapshot());

		expect(out).toContain("factory_passes_started_total 460");
		expect(out).toContain("factory_passes_completed_total 459");
		expect(out).toContain("factory_last_pass_repo_failures 2");
		expect(out).toContain("factory_traced_attempts 0");
	});

	test("reads hostConflicts as an object count, not a list length", () => {
		// `hostConflicts` is a single status object carrying a running `count`.
		// Treating it as an array yields `undefined` and a malformed line.
		const out = renderMetrics(
			snapshot({
				hostConflicts: { count: 4, lastAttemptId: "a-1", lastAt: null, lastPairs: [] },
			} as Partial<StatusSnapshot>),
		);
		expect(out).toContain("factory_host_conflicts_total 4");
	});

	test("types host conflicts as a counter, because the count is cumulative", () => {
		// The help text says "since process start", which is counter semantics: a
		// restart is a legitimate reset. Typed as a gauge, `increase()` and
		// `rate()` are undefined over it, so an operator cannot ask the only
		// question the metric exists to answer -- how many conflicts just happened.
		const out = renderMetrics(
			snapshot({
				hostConflicts: { count: 4, lastAttemptId: "a-1", lastAt: null, lastPairs: [] },
			} as Partial<StatusSnapshot>),
		);
		expect(out).toContain("# TYPE factory_host_conflicts_total counter");
		expect(out).not.toContain("# TYPE factory_host_conflicts_total gauge");
	});

	test("states the Forge-wins rule in the last-error help text", () => {
		// authoritativeRow prefers Forgejo even when a GitHub row was swept later,
		// which is correct (Forge is primary outside client). The defect was the help
		// text claiming a plain "newest-swept row" it does not implement: a metric
		// whose contract disagrees with its value is worse than an absent one.
		const out = renderMetrics(snapshot({} as Partial<StatusSnapshot>));
		const help = out.split("\n").find((l) => l.startsWith("# HELP factory_repo_last_error"));
		expect(help).toBeDefined();
		expect(help).toContain("authoritative");
		expect(help).not.toMatch(
			/^# HELP factory_repo_last_error 1 when the repository's newest-swept/,
		);
	});

	test("escapes a label value that could otherwise terminate the label", () => {
		const out = renderMetrics(
			snapshot({
				repositories: [
					{
						repository: 'evil"\\name',
						provider: "forgejo",
						checks: "static-only",
						lastSweep: null,
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 0,
						jobsFailed: 1,
						lastError: null,
					},
				],
			} as Partial<StatusSnapshot>),
		);
		expect(out).toContain('factory_jobs_failed{repository="evil\\"\\\\name",provider="forgejo"} 1');
	});

	test("stamps the snapshot's own clock so staleness is distinguishable", () => {
		const out = renderMetrics(snapshot());
		// 2026-09-17T21:25:58.210Z -> 1789680358
		expect(out).toContain("factory_status_generated_timestamp_seconds 1789680358");
	});

	test("FORGE WINS: a github row never contributes when a forgejo row exists", () => {
		// The real shape, live 2026-09-17: `rodaddy/rtech-infra` had a live `forgejo`
		// row and a `github` row frozen at the Forge flag day. They are not
		// two halves of one repository -- GitHub is a read-only backup mirror, so its
		// row is dead history. Summing them reported `software-factory` at 254
		// failures when the live figure was 141: a total describing neither forge.
		const out = renderMetrics(
			snapshot({
				repositories: [
					{
						repository: "rodaddy/rtech-infra",
						provider: "github",
						checks: "static-only",
						lastSweep: "2026-08-30T19:38:12Z",
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 2,
						jobsFailed: 221,
						lastError: "frozen at flag day",
					},
					{
						repository: "rodaddy/rtech-infra",
						provider: "forgejo",
						checks: "static-only",
						lastSweep: "2026-09-17T12:02:29-04:00",
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 91,
						jobsFailed: 166,
						lastError: null,
					},
				],
			} as Partial<StatusSnapshot>),
		);

		// BOTH rows emit, each on its own (repository, provider) series, and each
		// carries its OWN independent total -- never the sum (387), which described
		// neither forge. Separate series is what keeps the counters monotonic: a
		// single name-keyed series would change which row it reads from and look
		// like a counter reset.
		expect(out).toContain(
			'factory_jobs_failed{repository="rodaddy/rtech-infra",provider="forgejo"} 166',
		);
		expect(out).toContain(
			'factory_jobs_failed{repository="rodaddy/rtech-infra",provider="github"} 221',
		);
		expect(out).not.toContain('provider="forgejo"} 387');

		// Forge is the one that SPEAKS for the repository, so a query filtering on
		// this series gets 166 without knowing the migration history.
		expect(out).toContain(
			'factory_repo_authoritative{repository="rodaddy/rtech-infra",provider="forgejo"} 1',
		);
		expect(out).toContain(
			'factory_repo_authoritative{repository="rodaddy/rtech-infra",provider="github"} 0',
		);

		// The error flag is per NAME, from the authoritative row, so the GitHub
		// row's stale "frozen at flag day" error never reaches it.
		const errLines = out.split("\n").filter((l) => l.startsWith("factory_repo_last_error{"));
		expect(errLines).toHaveLength(1);
		expect(errLines[0]).toBe(
			'factory_repo_last_error{repository="rodaddy/rtech-infra",provider="forgejo"} 0',
		);
	});

	test("FORGE WINS even when the github row was swept more recently", () => {
		// The case that distinguishes "prefer Forge" from "prefer newest": here the
		// GitHub row is NEWER. Forge must still win, because the rule is about which
		// forge is authoritative (Forge is the git provider,
		// GitHub is a backup), not about which row was touched last. Without this
		// case a "newest row" implementation passes and the two rules are
		// indistinguishable.
		const out = renderMetrics(
			snapshot({
				repositories: [
					{
						repository: "rodaddy/both",
						provider: "forgejo",
						checks: "standard",
						lastSweep: "2026-09-01T00:00:00Z",
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 5,
						jobsFailed: 7,
						lastError: null,
					},
					{
						repository: "rodaddy/both",
						provider: "github",
						checks: "standard",
						lastSweep: "2026-09-17T00:00:00Z",
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 900,
						jobsFailed: 900,
						lastError: "github row error",
					},
				],
			} as Partial<StatusSnapshot>),
		);

		// Forge is authoritative DESPITE GitHub being newer. This is the assertion
		// that separates "Forge wins" from "newest wins": with a newest-row rule the
		// github row would be marked 1 here.
		expect(out).toContain(
			'factory_repo_authoritative{repository="rodaddy/both",provider="forgejo"} 1',
		);
		expect(out).toContain(
			'factory_repo_authoritative{repository="rodaddy/both",provider="github"} 0',
		);

		// And the per-name error flag follows Forge, so the github row's error does
		// not raise it.
		const errLines = out.split("\n").filter((l) => l.startsWith("factory_repo_last_error{"));
		expect(errLines).toHaveLength(1);
		expect(errLines[0]).toBe(
			'factory_repo_last_error{repository="rodaddy/both",provider="forgejo"} 0',
		);

		// Both rows keep their own counters; neither is dropped or merged.
		expect(out).toContain('factory_jobs_failed{repository="rodaddy/both",provider="forgejo"} 7');
		expect(out).toContain('factory_jobs_failed{repository="rodaddy/both",provider="github"} 900');
	});

	test("a github-only repository still reports, rather than vanishing", () => {
		// `rodaddy/open-brain` and `rodaddy/rtech-audit` are github-only in this
		// table. A naive "forgejo only" filter would drop them from the metrics
		// entirely -- including open-brain, which carries the worst failure count on
		// the box. Forge wins only where a Forge row EXISTS.
		const out = renderMetrics(
			snapshot({
				repositories: [
					{
						repository: "rodaddy/open-brain",
						provider: "github",
						checks: "standard",
						lastSweep: "2026-09-17T20:00:00-04:00",
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 63,
						jobsFailed: 240,
						lastError: null,
					},
				],
			} as Partial<StatusSnapshot>),
		);

		expect(out).toContain(
			'factory_jobs_failed{repository="rodaddy/open-brain",provider="github"} 240',
		);
		// github-only, so the github row is the one that speaks for it.
		expect(out).toContain(
			'factory_repo_authoritative{repository="rodaddy/open-brain",provider="github"} 1',
		);
	});

	test("clears the error flag when the NEWEST-swept row succeeded", () => {
		// The flag is not summable. ORing it across rows pins an old error at 1
		// forever, and the rows really do span weeks: live 2026-09-17,
		// `rodaddy/rtech-infra` carried two rows swept 18 days apart, so a stale
		// August error would have held an alert on indefinitely.
		const out = renderMetrics(
			snapshot({
				repositories: [
					{
						repository: "rodaddy/rtech-infra",
						provider: "forgejo",
						checks: "static-only",
						lastSweep: "2026-08-30T19:38:12Z",
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 2,
						jobsFailed: 221,
						lastError: "reclaimed: runner exceeded the running cap",
					},
					{
						repository: "rodaddy/rtech-infra",
						provider: "forgejo",
						checks: "static-only",
						lastSweep: "2026-09-17T12:02:29-04:00",
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 91,
						jobsFailed: 166,
						lastError: null,
					},
				],
			} as Partial<StatusSnapshot>),
		);

		expect(out).toContain(
			'factory_repo_last_error{repository="rodaddy/rtech-infra",provider="forgejo"} 0',
		);
		// Both rows are forgejo here, so the newest-row rule picks the September one.
		expect(out).toContain(
			'factory_jobs_failed{repository="rodaddy/rtech-infra",provider="forgejo"} 166',
		);
	});

	test("sets the error flag when the newest-swept row is the one that errored", () => {
		const out = renderMetrics(
			snapshot({
				repositories: [
					{
						repository: "rodaddy/rtech-infra",
						provider: "forgejo",
						checks: "static-only",
						lastSweep: "2026-08-30T19:38:12Z",
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 2,
						jobsFailed: 0,
						lastError: null,
					},
					{
						repository: "rodaddy/rtech-infra",
						provider: "forgejo",
						checks: "static-only",
						lastSweep: "2026-09-17T12:02:29-04:00",
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 91,
						jobsFailed: 1,
						lastError: "boom",
					},
				],
			} as Partial<StatusSnapshot>),
		);

		expect(out).toContain(
			'factory_repo_last_error{repository="rodaddy/rtech-infra",provider="forgejo"} 1',
		);
	});

	test("treats a never-swept row as older than any real sweep", () => {
		// `lastSweep` is null on a repository that has never been swept. A null must
		// lose to a real timestamp, or an unswept row silently decides the flag.
		const out = renderMetrics(
			snapshot({
				repositories: [
					{
						repository: "rodaddy/x",
						provider: "forgejo",
						checks: "static-only",
						lastSweep: null,
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 0,
						jobsFailed: 0,
						lastError: "stale error on a never-swept row",
					},
					{
						repository: "rodaddy/x",
						provider: "forgejo",
						checks: "static-only",
						lastSweep: "2026-09-17T12:02:29-04:00",
						issueCount: 0,
						pullCount: 0,
						jobsPending: 0,
						jobsRunning: 0,
						jobsCompleted: 1,
						jobsFailed: 0,
						lastError: null,
					},
				],
			} as Partial<StatusSnapshot>),
		);

		expect(out).toContain('factory_repo_last_error{repository="rodaddy/x",provider="forgejo"} 0');
	});

	test("breaks a lastSweep tie stably, on the first row", () => {
		// With equal timestamps "newest" is undefined. The choice is arbitrary but
		// must be FIXED: a flapping value would look like a real state change to an
		// alert every time row order shifted between scrapes.
		const rows = (firstError: string | null, secondError: string | null) => [
			{
				repository: "rodaddy/tie",
				provider: "forgejo",
				checks: "static-only",
				lastSweep: "2026-09-17T12:00:00Z",
				issueCount: 0,
				pullCount: 0,
				jobsPending: 0,
				jobsRunning: 0,
				jobsCompleted: 0,
				jobsFailed: 0,
				lastError: firstError,
			},
			{
				repository: "rodaddy/tie",
				provider: "forgejo",
				checks: "static-only",
				lastSweep: "2026-09-17T12:00:00Z",
				issueCount: 0,
				pullCount: 0,
				jobsPending: 0,
				jobsRunning: 0,
				jobsCompleted: 0,
				jobsFailed: 0,
				lastError: secondError,
			},
		];

		const firstClean = renderMetrics(
			snapshot({ repositories: rows(null, "boom") } as Partial<StatusSnapshot>),
		);
		expect(firstClean).toContain(
			'factory_repo_last_error{repository="rodaddy/tie",provider="forgejo"} 0',
		);

		const firstErrored = renderMetrics(
			snapshot({ repositories: rows("boom", null) } as Partial<StatusSnapshot>),
		);
		expect(firstErrored).toContain(
			'factory_repo_last_error{repository="rodaddy/tie",provider="forgejo"} 1',
		);
	});

	test("an empty snapshot emits headers and scalars but no repository samples", () => {
		// The contract, stated precisely: a repository PRESENT
		// with no activity emits an explicit 0 (covered above); a repository ABSENT
		// emits nothing, because a labelled series needs a label value and this
		// module cannot see the allowlist. The scalars still prove the exporter is
		// alive, so "configured with no repositories" stays distinguishable from
		// "exporter down".
		const out = renderMetrics(snapshot({ repositories: [] } as Partial<StatusSnapshot>));

		expect(out).toContain("# TYPE factory_jobs_failed gauge");
		expect(out.split("\n").filter((l) => l.includes("{repository="))).toHaveLength(0);
		expect(out).toContain("factory_passes_started_total 460");
		expect(out).toContain("factory_status_generated_timestamp_seconds 1789680358");
	});

	test("emits no two samples carrying identical labels", () => {
		// The general form of the rule above, over the whole exposition.
		const out = renderMetrics(snapshot());
		const samples = out.split("\n").filter((l) => l !== "" && !l.startsWith("#"));
		const keys = samples.map((l) => l.slice(0, l.lastIndexOf(" ")));
		expect(new Set(keys).size).toBe(keys.length);
	});

	test("ends every line with a newline, as the text format requires", () => {
		const out = renderMetrics(snapshot());
		expect(out.endsWith("\n")).toBe(true);
	});
});

/** The DB-derived work totals a live `getStatus` carries. */
const WORK = {
	dispatches: 812,
	resultsIngested: 640,
	publicationsPosted: 1203,
	webhookDeliveries: [
		{ event: "push", count: 90 },
		{ event: "pull_request", count: 41 },
	],
	jobsByStatus: [
		{ status: "completed", count: 500 },
		{ status: "pending", count: 7 },
	],
};

describe("renderMetrics work series", () => {
	test("dispatches, results ingested, and publications posted are _total counters", () => {
		const out = renderMetrics(snapshot({ work: WORK }));

		expect(out).toContain("# TYPE factory_dispatches_total counter");
		expect(out).toContain("factory_dispatches_total 812\n");
		expect(out).toContain("# TYPE factory_results_ingested_total counter");
		expect(out).toContain("factory_results_ingested_total 640\n");
		expect(out).toContain("# TYPE factory_publications_posted_total counter");
		expect(out).toContain("factory_publications_posted_total 1203\n");
	});

	test("webhook deliveries are a counter labelled by event", () => {
		const out = renderMetrics(snapshot({ work: WORK }));

		expect(out).toContain("# TYPE factory_webhook_deliveries_total counter");
		expect(out).toContain('factory_webhook_deliveries_total{event="push"} 90\n');
		expect(out).toContain('factory_webhook_deliveries_total{event="pull_request"} 41\n');
	});

	test("jobs by status is a GAUGE labelled by status", () => {
		// A status count moves both ways (pending -> running drops pending), so it
		// can never be a counter.
		const out = renderMetrics(snapshot({ work: WORK }));

		expect(out).toContain("# TYPE factory_jobs_by_status gauge");
		expect(out).toContain('factory_jobs_by_status{status="completed"} 500\n');
		expect(out).toContain('factory_jobs_by_status{status="pending"} 7\n');
	});

	test("alert deliveries are a counter split delivered/undelivered", () => {
		const out = renderMetrics(snapshot({ alertDeliveries: { delivered: 3, undelivered: 2 } }));

		expect(out).toContain("# TYPE factory_alert_deliveries_total counter");
		expect(out).toContain('factory_alert_deliveries_total{outcome="delivered"} 3\n');
		expect(out).toContain('factory_alert_deliveries_total{outcome="undelivered"} 2\n');
	});

	test("an unmeasured source emits no sample rather than a false zero", () => {
		// The doctor probe assembles a snapshot with no work read and no alert tally.
		const out = renderMetrics(snapshot());

		expect(out).not.toContain("factory_dispatches_total ");
		expect(out).not.toContain("factory_jobs_by_status{");
		expect(out).not.toContain("factory_alert_deliveries_total{");
	});

	test("escapes an event label value", () => {
		const out = renderMetrics(
			snapshot({ work: { ...WORK, webhookDeliveries: [{ event: 'a"b', count: 1 }] } }),
		);
		expect(out).toContain('factory_webhook_deliveries_total{event="a\\"b"} 1\n');
	});
});

describe("getStatus -> renderMetrics work series (database-backed)", () => {
	test("counts dispatches past allocating, ingests, posts, deliveries, and jobs by status", async () => {
		await withTestDb(async (db) => {
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/web-ops", checks: "standard" })
				.returning();
			if (!repo) throw new Error("seed failed");
			const [job] = await db
				.insert(jobs)
				.values({ repositoryId: repo.id, sha: "abc", jobType: "pr-review", status: "running" })
				.returning();
			if (!job) throw new Error("seed failed");
			await db.insert(jobs).values({ repositoryId: repo.id, sha: "def", jobType: "pr-review" });
			// An `allocating` intent is the one attempt row ever deleted, so it is
			// not a dispatch; counting it would let the counter go down.
			await db.insert(jobAttempts).values([
				{ jobId: job.id, status: "submitted" },
				{ jobId: job.id, status: ALLOCATING_ATTEMPT_STATUS },
			]);
			await db.insert(resultPostings).values({ jobId: job.id, target: "t1", status: "recorded" });
			await db.insert(githubPostings).values([
				{
					jobId: job.id,
					kind: "label",
					action: "add",
					target: "a",
					payload: "{}",
					dedupeKey: "k1",
					postedAt: new Date(NOW_DATE),
				},
				{
					jobId: job.id,
					kind: "comment",
					action: "upsert",
					target: "comment",
					payload: "{}",
					dedupeKey: "k2",
				},
			]);
			await db.insert(forgeDeliveries).values([
				{
					provider: "forgejo",
					deliveryId: "d1",
					event: "push",
					repository: "rodaddy/web-ops",
					payload: {},
				},
				{
					provider: "forgejo",
					deliveryId: "d2",
					event: "push",
					repository: "rodaddy/web-ops",
					payload: {},
				},
			]);

			const out = renderMetrics(await getStatus(db, NOW_DATE));

			expect(out).toContain("factory_dispatches_total 1\n");
			expect(out).toContain("factory_results_ingested_total 1\n");
			expect(out).toContain("factory_publications_posted_total 1\n");
			expect(out).toContain('factory_webhook_deliveries_total{event="push"} 2\n');
			expect(out).toContain('factory_jobs_by_status{status="running"} 1\n');
			expect(out).toContain('factory_jobs_by_status{status="pending"} 1\n');
		});
	});
});

describe("GET /metrics carries the live alert tally", () => {
	test("factory_alert_deliveries_total renders the process tally's values", async () => {
		await raiseCriticalAlert(undefined, { alertClass: "x", cause: "y" });
		const tally = alertDeliveryTally();
		await withTestDb(async (db) => {
			const server = startStatusServer({ db, port: 0, pollIntervalMinutes: 15 });
			try {
				const out = await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text();
				expect(out).toContain(
					`factory_alert_deliveries_total{outcome="delivered"} ${tally.delivered}\n`,
				);
				expect(out).toContain(
					`factory_alert_deliveries_total{outcome="undelivered"} ${tally.undelivered}\n`,
				);
			} finally {
				await server.stop();
			}
		});
	});
});
