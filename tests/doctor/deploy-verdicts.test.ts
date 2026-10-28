import { describe, expect, test } from "bun:test";
import type { WatcherDb } from "../../src/db/client";
import {
	type ForgeRunState,
	forgeRuns,
	githubPostings,
	jobAttempts,
	jobs,
	repositories,
	shadowPublications,
} from "../../src/db/schema";
import type { WatcherConfig } from "../../src/config/schema";
import {
	enabledConfigLanes,
	parseDeployVerdictsArgs,
	runDeployVerdicts,
	runDeployVerdictsCommand,
} from "../../src/doctor/deploy-verdicts";
import { withTestDb } from "../db/helpers";

/** sf#605 (605b): every lane that dispatched since a deploy posted a verdict. */

const SINCE = new Date("2026-09-24T10:00:00Z");
const BEFORE = new Date("2026-09-24T09:00:00Z");
const AFTER = new Date("2026-09-24T10:05:00Z");

async function seedJob(
	db: WatcherDb,
	repoId: number,
	jobType: string,
	startedAt: Date,
	attemptStatus = "completed",
	job_: { sha?: string; status?: string } = {},
): Promise<number> {
	const [job] = await db
		.insert(jobs)
		.values({
			repositoryId: repoId,
			jobType,
			sha: job_.sha ?? "a".repeat(40),
			status: job_.status ?? "completed",
		})
		.returning();
	if (!job) throw new Error("fixture job not inserted");
	await db.insert(jobAttempts).values({ jobId: job.id, status: attemptStatus, startedAt });
	return job.id;
}

async function seedPosting(
	db: WatcherDb,
	jobId: number,
	opts: {
		kind: string;
		target: string;
		status: string;
		conclusion?: string;
		action?: string;
		postedAt?: Date;
	},
): Promise<number> {
	const [row] = await db
		.insert(githubPostings)
		.values({
			jobId,
			kind: opts.kind,
			action: opts.action ?? (opts.kind === "label" ? "add" : "upsert"),
			target: opts.target,
			status: opts.status,
			payload: JSON.stringify(opts.conclusion ? { conclusion: opts.conclusion } : {}),
			dedupeKey: `k-${jobId}-${opts.kind}-${opts.target}`,
			postedAt: opts.status === "posted" ? (opts.postedAt ?? AFTER) : null,
		})
		.returning();
	if (!row) throw new Error("fixture posting not inserted");
	return row.id;
}

function capture() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		io: { stdout: (m: string) => out.push(m), stderr: (m: string) => err.push(m) },
		out,
		err,
	};
}

describe("doctor deploy-verdicts", () => {
	test("classifies POSTED, NO_VERDICT, FAILED_VERDICT and UNKNOWN per lane; exit 1 on NO_VERDICT", async () => {
		await withTestDb(async (db) => {
			const [repo] = await db
				.insert(repositories)
				.values({ provider: "forgejo", fullName: "rodaddy/x" })
				.returning();
			if (!repo) throw new Error("fixture repo not inserted");

			// POSTED: a pr-review job with a posted success check.
			const posted = await seedJob(db, repo.id, "pr-review", AFTER);
			await seedPosting(db, posted, {
				kind: "check",
				target: "check",
				status: "posted",
				conclusion: "success",
			});
			// NO_VERDICT: attempt "completed" but the posting is still pending — the
			// attempt status must NEVER be read as success (AGENTS trap).
			const pending = await seedJob(db, repo.id, "issue-triage", AFTER, "completed");
			await seedPosting(db, pending, { kind: "comment", target: "comment", status: "pending" });
			// FAILED_VERDICT: a posted failure check.
			const failed = await seedJob(db, repo.id, "infra-static", AFTER);
			await seedPosting(db, failed, {
				kind: "check",
				target: "check",
				status: "posted",
				conclusion: "failure",
			});
			// UNKNOWN: this lane only dispatched before --since.
			const old = await seedJob(db, repo.id, "implement", BEFORE);
			await seedPosting(db, old, {
				kind: "check",
				target: "check",
				status: "posted",
				conclusion: "success",
			});

			const cap = capture();
			const code = await runDeployVerdicts(db, SINCE, cap.io, { configLanes: ["implement"] });
			expect(cap.out).toContain("[NO_VERDICT] issue-triage: dispatched 1, posted 0");
			expect(cap.out).toContain("[POSTED] pr-review: 1");
			expect(cap.out).toContain("[FAILED_VERDICT] infra-static: dispatched 1, failed 1");
			expect(cap.out).toContain(
				"[UNKNOWN] implement: not dispatched since 2026-09-24T10:00:00.000Z",
			);
			expect(code).toBe(1);
		});
	}, 30_000);

	test("exit 0 when no lane is NO_VERDICT (FAILED_VERDICT and UNKNOWN do not fail); terminal notice is a failure", async () => {
		await withTestDb(async (db) => {
			const [repo] = await db
				.insert(repositories)
				.values({ provider: "forgejo", fullName: "rodaddy/y" })
				.returning();
			if (!repo) throw new Error("fixture repo not inserted");
			const ok = await seedJob(db, repo.id, "pr-review", AFTER);
			await seedPosting(db, ok, {
				kind: "check",
				target: "check",
				status: "posted",
				conclusion: "success",
			});
			const term = await seedJob(db, repo.id, "infra-static", AFTER, "failed");
			await seedPosting(db, term, {
				kind: "check",
				target: "terminal-check",
				status: "posted",
				conclusion: "neutral",
			});
			await seedJob(db, repo.id, "implement", BEFORE);

			const cap = capture();
			expect(await runDeployVerdicts(db, SINCE, cap.io)).toBe(0);
			expect(cap.out).toContain("[POSTED] pr-review: 1");
			expect(cap.out).toContain("[FAILED_VERDICT] infra-static: dispatched 1, failed 1");
		});
	}, 30_000);

	test("a DB error exits 3 and never quotes the driver message", async () => {
		const cap = capture();
		const code = await runDeployVerdictsCommand(["--since", "2026-09-24T10:00:00Z"], cap.io, {
			createDb: () => {
				throw new Error("postgres://u:secret@h/db unreachable");
			},
		});
		expect(code).toBe(3);
		expect(cap.err.join("\n")).not.toContain("secret");
	});

	test("parse requires a valid ISO-8601 --since", () => {
		expect(parseDeployVerdictsArgs(["--since", "2026-09-24T10:00:00Z"])).toEqual({
			ok: true,
			since: SINCE,
		});
		expect(parseDeployVerdictsArgs([]).ok).toBe(false);
		expect(parseDeployVerdictsArgs(["--since", "yesterday"]).ok).toBe(false);
	});
});

describe("doctor deploy-verdicts hardening (605c)", () => {
	async function repoRow(db: WatcherDb, name: string): Promise<number> {
		const [repo] = await db
			.insert(repositories)
			.values({ provider: "forgejo", fullName: name })
			.returning();
		if (!repo) throw new Error("fixture repo not inserted");
		return repo.id;
	}

	test("(1) only a check or a hold/failed/error label ADD is a verdict; comments and label removes never are", async () => {
		await withTestDb(async (db) => {
			const repoId = await repoRow(db, "rodaddy/v1");
			const comment = await seedJob(db, repoId, "pr-review", AFTER);
			await seedPosting(db, comment, { kind: "comment", target: "comment", status: "posted" });
			const removed = await seedJob(db, repoId, "issue-triage", AFTER);
			await seedPosting(db, removed, {
				kind: "label",
				target: "watcher:hold",
				status: "posted",
				action: "remove",
			});
			const held = await seedJob(db, repoId, "implement", AFTER);
			await seedPosting(db, held, { kind: "label", target: "watcher:hold", status: "posted" });

			const cap = capture();
			expect(await runDeployVerdicts(db, SINCE, cap.io)).toBe(1);
			expect(cap.out).toContain("[NO_VERDICT] pr-review: dispatched 1, posted 0");
			expect(cap.out).toContain("[NO_VERDICT] issue-triage: dispatched 1, posted 0");
			expect(cap.out).toContain("[FAILED_VERDICT] implement: dispatched 1, failed 1");
		});
	}, 30_000);

	test("(2) a posting with a shadow_publications row is not a verdict", async () => {
		await withTestDb(async (db) => {
			const repoId = await repoRow(db, "rodaddy/v2");
			const job = await seedJob(db, repoId, "pr-review", AFTER);
			const postingId = await seedPosting(db, job, {
				kind: "check",
				target: "check",
				status: "posted",
				conclusion: "success",
			});
			await db.insert(shadowPublications).values({
				postingId,
				jobId: job,
				kind: "check",
				repository: "rodaddy/v2",
				wouldAction: "created",
				target: "check",
				dedupeKey: "shadow",
			});
			const cap = capture();
			expect(await runDeployVerdicts(db, SINCE, cap.io)).toBe(1);
			expect(cap.out).toContain("[NO_VERDICT] pr-review: dispatched 1, posted 0");
		});
	}, 30_000);

	test("(3) a job whose latest attempt is not terminal is IN_FLIGHT; --wait polls until it posts", async () => {
		await withTestDb(async (db) => {
			const repoId = await repoRow(db, "rodaddy/v3");
			const job = await seedJob(db, repoId, "pr-review", AFTER, "running");
			const cap = capture();
			expect(await runDeployVerdicts(db, SINCE, cap.io)).toBe(1);
			expect(cap.out).toContain("[IN_FLIGHT] pr-review: dispatched 1, in flight 1");

			const waited = capture();
			let sleeps = 0;
			const code = await runDeployVerdicts(db, SINCE, waited.io, {
				waitSeconds: 60,
				sleep: async () => {
					sleeps++;
					await seedPosting(db, job, {
						kind: "check",
						target: "check",
						status: "posted",
						conclusion: "success",
					});
				},
			});
			expect(sleeps).toBe(1);
			expect(code).toBe(0);
			expect(waited.out).toContain("[POSTED] pr-review: 1");
			expect(waited.out.join("\n")).not.toContain("IN_FLIGHT");
		});
	}, 30_000);

	test("(3b) --wait gives up when the budget ends with a lane still IN_FLIGHT", async () => {
		await withTestDb(async (db) => {
			const repoId = await repoRow(db, "rodaddy/v3b");
			await seedJob(db, repoId, "pr-review", AFTER, "submitted");
			let clock = 0;
			const cap = capture();
			const code = await runDeployVerdicts(db, SINCE, cap.io, {
				waitSeconds: 30,
				now: () => clock,
				sleep: async (ms) => {
					clock += ms;
				},
			});
			expect(code).toBe(1);
			expect(cap.out).toContain("[IN_FLIGHT] pr-review: dispatched 1, in flight 1");
		});
	}, 30_000);

	test("(4) lanes come from config UNION forge_runs since --since; a stale jobs-table lane is not listed", async () => {
		await withTestDb(async (db) => {
			const repoId = await repoRow(db, "rodaddy/v4");
			await seedJob(db, repoId, "retired-lane", BEFORE);
			const run = (workflow: string, state: ForgeRunState, dispatchedAt: Date) => ({
				repo: "rodaddy/v4",
				workflow,
				targetSha: "b".repeat(40),
				inputs: {},
				state,
				dispatchedAt,
			});
			await db
				.insert(forgeRuns)
				.values([
					run("pr-review.yml", "success", AFTER),
					run("smoke.yml", "running", AFTER),
					run("lint.yml", "failure", AFTER),
					run("gone.yml", "cancelled", AFTER),
					run("old.yml", "success", BEFORE),
				]);
			const cap = capture();
			const code = await runDeployVerdicts(db, SINCE, cap.io, { configLanes: ["issue-triage"] });
			expect(cap.out).toContain(
				"[UNKNOWN] issue-triage: not dispatched since 2026-09-24T10:00:00.000Z",
			);
			expect(cap.out).toContain("[POSTED] pr-review.yml: 1");
			expect(cap.out).toContain("[IN_FLIGHT] smoke.yml: dispatched 1, in flight 1");
			expect(cap.out).toContain("[FAILED_VERDICT] lint.yml: dispatched 1, failed 1");
			expect(cap.out).toContain("[NO_VERDICT] gone.yml: dispatched 1, posted 0");
			expect(cap.out.join("\n")).not.toContain("retired-lane");
			expect(cap.out.join("\n")).not.toContain("old.yml");
			expect(code).toBe(1);
		});
	}, 30_000);

	test("(5) --since must carry Z or an offset", () => {
		expect(parseDeployVerdictsArgs(["--since", "2026-09-24T10:00:00"]).ok).toBe(false);
		expect(parseDeployVerdictsArgs(["--since", "2026-09-24"]).ok).toBe(false);
		expect(parseDeployVerdictsArgs(["--since", "2026-09-24T12:00:00+02:00"])).toEqual({
			ok: true,
			since: SINCE,
		});
	});

	test("--wait takes a positive integer number of seconds", () => {
		expect(parseDeployVerdictsArgs(["--since", "2026-09-24T10:00:00Z", "--wait", "x"]).ok).toBe(
			false,
		);
		expect(parseDeployVerdictsArgs(["--since", "2026-09-24T10:00:00Z", "--wait", "600"])).toEqual({
			ok: true,
			since: SINCE,
			waitSeconds: 600,
		});
	});

	test("(4) config lanes: allowlisted templates minus lanes no repository opts into", () => {
		const cfg = {
			repositories: [{ name: "rodaddy/a", pr_review: false }],
			job_templates: [{ id: "pr-review" }, { id: "issue-triage" }, { id: "infra-static" }],
		} as unknown as WatcherConfig;
		expect(enabledConfigLanes(cfg)).toEqual(["infra-static"]);
	});
});

describe("doctor deploy-verdicts repair 2 (605c)", () => {
	async function repoRow(db: WatcherDb, name: string): Promise<number> {
		const [repo] = await db
			.insert(repositories)
			.values({ provider: "forgejo", fullName: name })
			.returning();
		if (!repo) throw new Error("fixture repo not inserted");
		return repo.id;
	}

	test("(P1) a watcher:passed / watcher:skipped label ADD and a posted issue plan are ok verdicts", async () => {
		await withTestDb(async (db) => {
			const repoId = await repoRow(db, "rodaddy/r1");
			const noSha = { sha: "" };
			const passed = await seedJob(db, repoId, "issue-triage", AFTER, "completed", noSha);
			await seedPosting(db, passed, { kind: "label", target: "watcher:passed", status: "posted" });
			const skipped = await seedJob(db, repoId, "implement", AFTER, "completed", noSha);
			await seedPosting(db, skipped, {
				kind: "label",
				target: "watcher:skipped",
				status: "posted",
			});
			const issue = await seedJob(db, repoId, "audit-deps", AFTER, "completed", noSha);
			await seedPosting(db, issue, {
				kind: "issue",
				target: "fp1",
				status: "posted",
				action: "open",
			});
			const cap = capture();
			expect(await runDeployVerdicts(db, SINCE, cap.io)).toBe(0);
			expect(cap.out).toContain("[POSTED] issue-triage: 1");
			expect(cap.out).toContain("[POSTED] implement: 1");
			expect(cap.out).toContain("[POSTED] audit-deps: 1");
		});
	}, 30_000);

	test("(P1) an audit job that completed with zero findings is POSTED_NOTHING; a failed one is NO_VERDICT", async () => {
		await withTestDb(async (db) => {
			const repoId = await repoRow(db, "rodaddy/r2");
			await seedJob(db, repoId, "audit-clean", AFTER, "completed", {
				sha: "",
				status: "completed",
			});
			await seedJob(db, repoId, "audit-broke", AFTER, "completed", { sha: "", status: "failed" });
			const cap = capture();
			expect(await runDeployVerdicts(db, SINCE, cap.io)).toBe(1);
			expect(cap.out).toContain(
				"[POSTED_NOTHING] audit-clean: dispatched 1, completed with nothing to post 1",
			);
			expect(cap.out).toContain("[NO_VERDICT] audit-broke: dispatched 1, posted 0");
		});
	}, 30_000);

	test("(P2) a job requeued to pending after a failed attempt is IN_FLIGHT, not NO_VERDICT", async () => {
		await withTestDb(async (db) => {
			const repoId = await repoRow(db, "rodaddy/r3");
			await seedJob(db, repoId, "pr-review", AFTER, "failed", { status: "pending" });
			const cap = capture();
			expect(await runDeployVerdicts(db, SINCE, cap.io)).toBe(1);
			expect(cap.out).toContain("[IN_FLIGHT] pr-review: dispatched 1, in flight 1");
		});
	}, 30_000);

	test("(P3) a posting posted before --since is not a verdict for the window", async () => {
		await withTestDb(async (db) => {
			const repoId = await repoRow(db, "rodaddy/r4");
			const job = await seedJob(db, repoId, "pr-review", AFTER);
			await seedPosting(db, job, {
				kind: "check",
				target: "check",
				status: "posted",
				conclusion: "success",
				postedAt: BEFORE,
			});
			const cap = capture();
			expect(await runDeployVerdicts(db, SINCE, cap.io)).toBe(1);
			expect(cap.out).toContain("[NO_VERDICT] pr-review: dispatched 1, posted 0");
		});
	}, 30_000);

	test("(P3) forge_runs unknown is IN_FLIGHT; cancelled is NO_VERDICT", async () => {
		await withTestDb(async (db) => {
			const run = (workflow: string, state: ForgeRunState) => ({
				repo: "rodaddy/r5",
				workflow,
				targetSha: "c".repeat(40),
				inputs: {},
				state,
				dispatchedAt: AFTER,
			});
			await db.insert(forgeRuns).values([run("u.yml", "unknown"), run("c.yml", "cancelled")]);
			const cap = capture();
			expect(await runDeployVerdicts(db, SINCE, cap.io)).toBe(1);
			expect(cap.out).toContain("[IN_FLIGHT] u.yml: dispatched 1, in flight 1");
			expect(cap.out).toContain("[NO_VERDICT] c.yml: dispatched 1, posted 0");
		});
	}, 30_000);
});

describe("doctor deploy-verdicts sweep G (verdict sweep, PRs 880/887)", () => {
	async function repoRow(db: WatcherDb, name: string): Promise<number> {
		const [repo] = await db
			.insert(repositories)
			.values({ provider: "forgejo", fullName: name })
			.returning();
		if (!repo) throw new Error("fixture repo not inserted");
		return repo.id;
	}

	test("(G P1) a check with a missing or unknown conclusion is UNKNOWN_CONCLUSION, not POSTED; exit 1", async () => {
		await withTestDb(async (db) => {
			const repoId = await repoRow(db, "rodaddy/g1");
			const missing = await seedJob(db, repoId, "pr-review", AFTER);
			await seedPosting(db, missing, { kind: "check", target: "watcher", status: "posted" });
			const odd = await seedJob(db, repoId, "pr-review", AFTER);
			await seedPosting(db, odd, {
				kind: "check",
				target: "watcher",
				status: "posted",
				conclusion: "bogus",
			});
			const cap = capture();
			expect(await runDeployVerdicts(db, SINCE, cap.io)).toBe(1);
			expect(cap.out).toContain(
				"[UNKNOWN_CONCLUSION] pr-review: dispatched 2, unknown conclusion 2",
			);
			expect(cap.out.some((l) => l.startsWith("[POSTED] pr-review"))).toBe(false);
			expect(cap.out.some((l) => l.startsWith("[NO_VERDICT] pr-review"))).toBe(false);
			expect(cap.out).toContain(
				"1 lane(s) posted only checks with a missing or unknown conclusion",
			);
		});
	}, 30_000);

	test("(G P2) --since refuses a calendar date that does not round-trip (02-30, 13th month, hour 24)", () => {
		expect(parseDeployVerdictsArgs(["--since", "2026-02-30T10:00:00Z"]).ok).toBe(false);
		expect(parseDeployVerdictsArgs(["--since", "2026-13-01T10:00:00Z"]).ok).toBe(false);
		expect(parseDeployVerdictsArgs(["--since", "2026-09-24T24:00:00Z"]).ok).toBe(false);
		expect(parseDeployVerdictsArgs(["--since", "2026-09-24T10:60:00Z"]).ok).toBe(false);
		expect(parseDeployVerdictsArgs(["--since", "2028-02-29T10:00:00Z"]).ok).toBe(true);
		expect(parseDeployVerdictsArgs(["--since", "2026-09-24T12:00:00.5+02:00"]).ok).toBe(true);
	});

	test("(G P2) the CLI exits 2 (bad args; the done-means script maps it to 3) on 02-30", async () => {
		const cap = capture();
		expect(await runDeployVerdictsCommand(["--since", "2026-02-30T10:00:00Z"], cap.io)).toBe(2);
	});
});
