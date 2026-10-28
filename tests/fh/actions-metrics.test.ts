/**
 * @module tests/fh/actions-metrics
 * @description Functional tests for the Actions run mirror. Offline
 *   fixtures only — the payload shapes below are trimmed copies of what the
 *   live forge returned when the routes were probed on 2026-08-31.
 *
 *   The load-bearing properties: wall time is COMPUTED from the run row rather
 *   than trusted from a field that does not exist; an unusable timestamp yields
 *   null and never 0, because 0 is a real measurement; the verdict comes from
 *   the status STATE (which Forgejo names `status`, not `state`) rather than
 *   from description prose; and a triage or smoke run omits the verdict keys
 *   entirely instead of carrying nulls that would read as a lane that failed to
 *   report.
 */
import { describe, expect, test } from "bun:test";
import {
	attemptsOf,
	buildRow,
	prReviewStatus,
	renderJsonl,
	runNumberOf,
	verdictOf,
	wallSeconds,
} from "../../scripts/fh/actions-metrics";

/** The context the lane writes; spelled out so the fixtures are self-describing. */
const PR_REVIEW_CONTEXT_LITERAL = "factory/pr-review";

/** A pr-review run, trimmed from the live `/actions/tasks` payload. */
const REVIEW_TASK = {
	run_number: 61,
	workflow_id: "pr-review.yml",
	head_sha: "bb52ea11c7e8980caccf8299b78ddfe3b8c1f1e5",
	event: "pull_request",
	status: "success",
	run_started_at: "2026-08-31T00:20:28-04:00",
	updated_at: "2026-08-31T00:21:45-04:00",
};

/** A smoke run on the same commit: same shape, no status of its own. */
const SMOKE_TASK = {
	run_number: 60,
	workflow_id: "factory-smoke.yml",
	head_sha: "bb52ea11c7e8980caccf8299b78ddfe3b8c1f1e5",
	event: "pull_request",
	status: "success",
	run_started_at: "2026-08-31T00:20:20-04:00",
	updated_at: "2026-08-31T00:20:27-04:00",
};

/** The commit statuses on that sha, trimmed from `/commits/{sha}/statuses`. */
const STATUSES = [
	{
		context: "pr-review / review (pull_request)",
		status: "success",
		description: "Successful in 1m17s",
	},
	{
		context: "factory/pr-review",
		status: "failure",
		description: "pr-review: blocking findings, fix first (attempts=2)",
	},
];

describe("wallSeconds", () => {
	test("computes whole seconds from the run row's own timestamps", () => {
		expect(wallSeconds(REVIEW_TASK.run_started_at, REVIEW_TASK.updated_at)).toBe(77);
		expect(wallSeconds(SMOKE_TASK.run_started_at, SMOKE_TASK.updated_at)).toBe(7);
	});

	test("a run inside one second is 0, which is a measurement and not an error", () => {
		expect(wallSeconds("2026-08-31T00:20:28-04:00", "2026-08-31T00:20:28-04:00")).toBe(0);
	});

	test("is null for a missing, unparseable, or reversed pair", () => {
		expect(wallSeconds(undefined, REVIEW_TASK.updated_at)).toBeNull();
		expect(wallSeconds(REVIEW_TASK.run_started_at, undefined)).toBeNull();
		expect(wallSeconds("not a date", REVIEW_TASK.updated_at)).toBeNull();
		expect(wallSeconds(REVIEW_TASK.updated_at, REVIEW_TASK.run_started_at)).toBeNull();
	});
});

describe("attemptsOf", () => {
	test("reads the suffix describeStatus appends", () => {
		expect(attemptsOf("pr-review: no blocking findings (attempts=1)")).toBe(1);
		expect(attemptsOf("pr-review: blocking findings, fix first (attempts=3)")).toBe(3);
	});

	test("is null when no suffix was written", () => {
		expect(attemptsOf("pr-review: no blocking findings")).toBeNull();
		expect(attemptsOf(undefined)).toBeNull();
		expect(attemptsOf("")).toBeNull();
	});

	test("is anchored to the end, so review prose cannot fake it", () => {
		expect(attemptsOf("the reply said (attempts=9) and then kept going")).toBeNull();
	});

	test("rejects a zero count: a run that never asked wrote no metric", () => {
		expect(attemptsOf("pr-review: no blocking findings (attempts=0)")).toBeNull();
	});
});

describe("verdictOf", () => {
	test("maps the status state, which Forgejo names `status`", () => {
		expect(verdictOf({ status: "success" })).toBe("approve");
		expect(verdictOf({ status: "failure" })).toBe("fix-first");
		expect(verdictOf({ status: "error" })).toBe("error");
	});

	test("is null for a pending or absent status", () => {
		expect(verdictOf({ status: "pending" })).toBeNull();
		expect(verdictOf(undefined)).toBeNull();
	});
});

describe("prReviewStatus", () => {
	test("picks factory/pr-review and not the runner's own per-job status", () => {
		expect(prReviewStatus(STATUSES)?.status).toBe("failure");
	});

	test("is undefined when the lane wrote none", () => {
		expect(prReviewStatus(STATUSES.slice(0, 1))).toBeUndefined();
	});
});

describe("runNumberOf / prReviewStatus per run", () => {
	// A RERUN: the lane ran twice on one commit, so the sha carries two
	// factory/pr-review statuses. Joining by sha alone handed both runs the same
	// verdict and attempt count.
	const RERUN_STATUSES = [
		{
			context: PR_REVIEW_CONTEXT_LITERAL,
			status: "success",
			description: "pr-review: approve (attempts=1)",
			target_url: "https://forge.example.internal/rodaddy/software-factory/actions/runs/62",
			created_at: "2026-08-31T01:00:00-04:00",
		},
		{
			context: PR_REVIEW_CONTEXT_LITERAL,
			status: "failure",
			description: "pr-review: blocking findings, fix first (attempts=3)",
			target_url: "https://forge.example.internal/rodaddy/software-factory/actions/runs/61",
			created_at: "2026-08-31T00:21:45-04:00",
		},
	];

	test("reads the run number out of a target_url and null out of anything else", () => {
		expect(runNumberOf("https://forge.example.internal/r/s/actions/runs/61")).toBe(61);
		expect(runNumberOf("https://forge.example.internal/r/s/actions/runs/61/")).toBe(61);
		expect(runNumberOf("https://forge.example.internal/r/s/actions/runs/none")).toBeNull();
		expect(runNumberOf(undefined)).toBeNull();
	});

	test("two runs on ONE sha each get their own status", () => {
		expect(prReviewStatus(RERUN_STATUSES, 61)?.status).toBe("failure");
		expect(prReviewStatus(RERUN_STATUSES, 62)?.status).toBe("success");
	});

	test("buildRow gives the rerun its own verdict and attempts, not the first row's", () => {
		const older = buildRow({ ...REVIEW_TASK, run_number: 61 }, RERUN_STATUSES);
		const rerun = buildRow({ ...REVIEW_TASK, run_number: 62 }, RERUN_STATUSES);
		expect(older.verdict).toBe("fix-first");
		expect(older.attempts).toBe(3);
		expect(rerun.verdict).toBe("approve");
		expect(rerun.attempts).toBe(1);
	});

	// Statuses written before the target_url convention carry no run number at
	// all. The fallback is the NEWEST, not the first in the array.
	test("falls back to the newest status when no target_url matches the run", () => {
		const undated = RERUN_STATUSES.map(({ target_url, ...rest }) => rest);
		expect(prReviewStatus(undated, 99)?.status).toBe("success");
		expect(prReviewStatus(undated)?.status).toBe("success");
	});

	test("an undated row does not displace a dated one", () => {
		const mixed = [
			{ context: PR_REVIEW_CONTEXT_LITERAL, status: "error", description: "x" },
			{
				context: PR_REVIEW_CONTEXT_LITERAL,
				status: "success",
				description: "y",
				created_at: "2026-08-31T01:00:00-04:00",
			},
		];
		expect(prReviewStatus(mixed, 99)?.status).toBe("success");
	});
});

describe("buildRow", () => {
	test("a pr-review run carries the computed wall, verdict, and attempts", () => {
		expect(buildRow(REVIEW_TASK, STATUSES)).toEqual({
			run: 61,
			workflow: "pr-review.yml",
			sha: "bb52ea11c7e8980caccf8299b78ddfe3b8c1f1e5",
			event: "pull_request",
			status: "success",
			started: "2026-08-31T00:20:28-04:00",
			wall_s: 77,
			verdict: "fix-first",
			attempts: 2,
		});
	});

	test("a pr-review run with no status of ours carries explicit nulls", () => {
		const row = buildRow(REVIEW_TASK, STATUSES.slice(0, 1));
		expect(row.verdict).toBeNull();
		expect(row.attempts).toBeNull();
	});

	// The accepted gap: smoke and triage write no status, so they report no
	// verdict. The keys are ABSENT, not null — "this lane does not report one"
	// is a different fact from "this run should have and did not".
	test("a smoke run omits the verdict keys entirely", () => {
		const row = buildRow(SMOKE_TASK, STATUSES);
		expect(row).toEqual({
			run: 60,
			workflow: "factory-smoke.yml",
			sha: "bb52ea11c7e8980caccf8299b78ddfe3b8c1f1e5",
			event: "pull_request",
			status: "success",
			started: "2026-08-31T00:20:20-04:00",
			wall_s: 7,
		});
		expect("verdict" in row).toBe(false);
		expect("attempts" in row).toBe(false);
	});

	test("a row missing every field degrades to nulls rather than throwing", () => {
		expect(buildRow({}, [])).toEqual({
			run: null,
			workflow: null,
			sha: null,
			event: null,
			status: null,
			started: null,
			wall_s: null,
		});
	});
});

describe("renderJsonl", () => {
	test("is one object per line, newline-terminated", () => {
		const body = renderJsonl([buildRow(REVIEW_TASK, STATUSES), buildRow(SMOKE_TASK, STATUSES)]);
		const lines = body.split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[2]).toBe("");
		expect(JSON.parse(lines[0] ?? "{}").run).toBe(61);
		expect(JSON.parse(lines[1] ?? "{}").workflow).toBe("factory-smoke.yml");
	});

	test("an empty set is an empty file, not a lone newline", () => {
		expect(renderJsonl([])).toBe("");
	});
});
