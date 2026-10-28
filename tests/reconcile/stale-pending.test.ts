import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { configSchema, type WatcherConfig } from "../../src/config/schema";
import type { WatcherDb } from "../../src/db/client";
import type { ForgeClient, ForgeResponse } from "../../src/forge/boundary";
import {
	collectTargets,
	runStalePendingStep,
	sweepStalePending,
} from "../../src/reconcile/stale-pending";

/**
 * #810: the stale-pending sweep is the single owner of stranded factory statuses.
 * Statuses mirror Forgejo 16's commit-status list shape (`status`, `context`,
 * `target_url`, `updated_at`); job-level contexts are `<workflow> / <job> (<event>)`
 * with a target_url under the run URL.
 */
const REPO = "rodaddy/software-factory";
const SHA = "a".repeat(40);
const RUN = "https://forge.example.internal/rodaddy/software-factory/actions/runs/77";
/** Job statuses carry the RELATIVE run path (live Forgejo 16 shape; see the fixture tests). */
const RUN_PATH = "/rodaddy/software-factory/actions/runs/77";
const NOW = new Date("2026-09-24T12:00:00Z");
const RECENT = "2026-09-24T11:50:00Z";
const OLD = "2026-09-24T09:00:00Z";

type Status = {
	id: number;
	context: string;
	status: string;
	target_url?: string;
	updated_at: string;
};

const smoke = (id: number, status: string, updated_at = RECENT): Status => ({
	id,
	context: "factory/smoke",
	status,
	target_url: RUN,
	updated_at,
});
const job = (id: number, status: string): Status => ({
	id,
	context: "factory-smoke / smoke (pull_request)",
	status,
	target_url: `${RUN_PATH}/jobs/0`,
	updated_at: RECENT,
});

function fakeForge(statuses: Status[]) {
	const posts: { path: string; body: Record<string, unknown> }[] = [];
	const client = {
		provider: "forgejo",
		paginate: async () => statuses,
		write: async (_m: string, path: string, body: Record<string, unknown>) => {
			posts.push({ path, body });
			return { status: 201, data: {}, link: null, rateRemaining: null } as ForgeResponse<unknown>;
		},
	} as unknown as ForgeClient;
	return { client, posts };
}

const sweep = (client: ForgeClient) =>
	sweepStalePending({
		client,
		targets: [
			{ repo: REPO, sha: SHA },
			{ repo: REPO, sha: SHA },
		],
		now: NOW,
	});

describe("sweepStalePending", () => {
	test("pending whose run's jobs are all terminal -> one error posted with the run URL", async () => {
		const { client, posts } = fakeForge([smoke(1, "pending"), job(2, "failure")]);
		const counts = await sweep(client);
		expect(posts).toEqual([
			{
				path: `/repos/${REPO}/statuses/${SHA}`,
				body: {
					context: "factory/smoke",
					state: "error",
					description: "factory/smoke: run ended without a verdict (stale pending swept)",
					target_url: RUN,
				},
			},
		]);
		expect(counts).toEqual({ targets: 1, pending: 1, swept: 1, superseded: 0, failed: 0 });
	});

	test("pending whose run still has a pending job -> untouched, even when old", async () => {
		const { client, posts } = fakeForge([smoke(1, "pending", OLD), job(2, "pending")]);
		await sweep(client);
		expect(posts).toEqual([]);
	});

	test("pending older than the threshold with no job statuses -> error posted", async () => {
		const { client, posts } = fakeForge([smoke(1, "pending", OLD)]);
		await sweep(client);
		expect(posts.map((p) => p.body.state)).toEqual(["error"]);
	});

	test("recent pending with no job statuses -> untouched", async () => {
		const { client, posts } = fakeForge([smoke(1, "pending")]);
		await sweep(client);
		expect(posts).toEqual([]);
	});

	test("newest record terminal -> untouched, even over an older pending", async () => {
		const { client, posts } = fakeForge([smoke(1, "pending", OLD), smoke(3, "success", OLD)]);
		await sweep(client);
		expect(posts).toEqual([]);
	});

	test("a context the factory does not own -> untouched", async () => {
		const { client, posts } = fakeForge([{ ...smoke(1, "pending", OLD), context: "ci/other" }]);
		await sweep(client);
		expect(posts).toEqual([]);
	});
});

describe("sweepStalePending against the live status shape", () => {
	// Live rows: job target_url is RELATIVE (`/owner/repo/actions/runs/N/jobs/k`),
	// the lane posts an ABSOLUTE run URL, and list rows carry `status` with `state: null`.
	const fixture = JSON.parse(
		readFileSync(new URL("../fixtures/forgejo/statuses-with-jobs.json", import.meta.url), "utf8"),
	) as { statuses: Status[] };
	const LATE = new Date("2026-09-25T06:00:00Z"); // ~9h after the lane record: past any threshold

	test("an old lane pending whose run's relative-URL jobs are still pending -> untouched", async () => {
		const { client, posts } = fakeForge(fixture.statuses);
		const counts = await sweepStalePending({
			client,
			targets: [{ repo: REPO, sha: SHA }],
			now: LATE,
		});
		expect(posts).toEqual([]);
		expect(counts).toEqual({ targets: 1, pending: 1, swept: 0, superseded: 0, failed: 0 });
	});

	test("the same run once its relative-URL jobs are terminal -> swept before the age rule", async () => {
		const rows = fixture.statuses.map((s) =>
			s.context.startsWith("pr-review / ") ? { ...s, id: s.id + 10, status: "failure" } : s,
		);
		const { client, posts } = fakeForge(rows);
		const early = new Date("2026-09-24T22:40:00Z"); // 2 min after the lane record
		await sweepStalePending({ client, targets: [{ repo: REPO, sha: SHA }], now: early });
		expect(posts.map((p) => p.body.context)).toEqual(["factory/pr-review"]);
	});
});

describe("runStalePendingStep and its config", () => {
	const config = (extra: Record<string, unknown> = {}) =>
		configSchema.safeParse({
			poll_interval_minutes: 15,
			repositories: [{ name: REPO, provider: "forgejo" }],
			...extra,
		});

	test("shadow mode never asks for a forge client, so it cannot post a swept error", async () => {
		const asked: string[] = [];
		const parsed = config();
		expect(parsed.success).toBe(true);
		const deps = {
			db: {} as WatcherDb,
			config: parsed.data as WatcherConfig,
			clientFor: async (name: string) => {
				asked.push(name);
				return null;
			},
			onError: (e: unknown) => {
				throw e;
			},
			// A clock behind any other caller's is always due, so
			// another test file's step run cannot skip this one.
			now: () => 0,
		};
		await runStalePendingStep({ ...deps, shadow: true });
		expect(asked).toEqual([]);
		await runStalePendingStep({ ...deps, shadow: false });
		expect(asked).toEqual([REPO]);
	});

	test("stale_pending_minutes is capped at the 24 h forge_runs lookback", () => {
		expect(config({ stale_pending_minutes: 1440 }).success).toBe(true);
		expect(config({ stale_pending_minutes: 1441 }).success).toBe(false);
	});
});

describe("sweepStalePending supersedes a stale factory/smoke verdict", () => {
	const HOST = "https://forge.example.internal";
	const runUrl = (n: number) => `${HOST}/rodaddy/software-factory/actions/runs/${n}`;
	const record = (id: number, status: string, run: number, context = "factory/smoke"): Status => ({
		id,
		context,
		status,
		target_url: runUrl(run),
		updated_at: RECENT,
	});
	const smokeJob = (
		id: number,
		name: string,
		status: string,
		run: number,
		wf = "factory-smoke",
	): Status => ({
		id,
		context: `${wf} / ${name} (pull_request)`,
		status,
		target_url: `/rodaddy/software-factory/actions/runs/${run}/jobs/${id}`,
		updated_at: RECENT,
	});
	const once = async (rows: Status[]) => {
		const forge = fakeForge(rows);
		const counts = await sweepStalePending({
			client: forge.client,
			targets: [{ repo: REPO, sha: SHA }],
			now: NOW,
		});
		return { ...forge, counts };
	};
	const newerFailed = [
		record(1, "success", 100),
		smokeJob(5, "smoke", "failure", 101),
		smokeJob(6, "finalize", "success", 101),
	];

	test("sf#954 a late older-run status on the same job never hides a pending job of the newest run", async () => {
		// Run 101's smoke job is still pending (id 50); run 100's smoke job reports
		// late (id 51) on the same context, and run 101's finalize already failed.
		const { posts } = await once([
			record(1, "success", 100),
			smokeJob(50, "smoke", "pending", 101),
			smokeJob(51, "smoke", "failure", 100),
			smokeJob(52, "finalize", "failure", 101),
		]);
		expect(posts).toEqual([]);
	});

	test("sf#954 older success + newer run failed before posting -> one failure naming the newer run", async () => {
		const { posts, counts } = await once(newerFailed);
		expect(posts).toEqual([
			{
				path: `/repos/${REPO}/statuses/${SHA}`,
				body: {
					context: "factory/smoke",
					state: "failure",
					description:
						"factory/smoke: run 101 failed before posting; supersedes run 100 (stale sweep, sf#954)",
					target_url: runUrl(101),
				},
			},
		]);
		expect(counts.superseded).toBe(1);
	});

	test("sf#954 record names the newer run, jobs of an older run failed -> no post", async () => {
		const { posts } = await once([record(9, "success", 101), smokeJob(5, "smoke", "failure", 100)]);
		expect(posts).toEqual([]);
	});

	test("sf#954 newer run still has a pending job -> no post", async () => {
		const { posts } = await once([
			record(1, "success", 100),
			smokeJob(5, "smoke", "failure", 101),
			smokeJob(6, "finalize", "pending", 101),
		]);
		expect(posts).toEqual([]);
	});

	test("sf#954 newer run all success/skipped -> no post", async () => {
		const { posts } = await once([
			record(1, "success", 100),
			smokeJob(5, "smoke", "success", 101),
			smokeJob(6, "finalize", "skipped", 101),
		]);
		expect(posts).toEqual([]);
	});

	test("sf#954 the posted record fed back -> the second sweep posts nothing", async () => {
		const first = await once(newerFailed);
		const posted = first.posts[0]?.body as { state: string; target_url: string } | undefined;
		expect(posted?.state).toBe("failure");
		const fed: Status = {
			id: 50,
			context: "factory/smoke",
			status: posted?.state ?? "",
			target_url: posted?.target_url ?? "",
			updated_at: RECENT,
		};
		const { posts } = await once([...newerFailed, fed]);
		expect(posts).toEqual([]);
	});

	test("sf#954 a non-smoke context with the same shape -> untouched", async () => {
		const { posts } = await once([
			record(1, "success", 100, "factory/pr-review"),
			smokeJob(5, "review", "failure", 101, "pr-review"),
			smokeJob(6, "finalize", "success", 101, "pr-review"),
		]);
		expect(posts).toEqual([]);
	});

	// Same-run-number rerun (Forgejo "Re-run all jobs"): record at RECENT (11:50).
	const at = (s: Status, updated_at: string): Status => ({ ...s, updated_at });
	const BEFORE = "2026-09-24T11:40:00Z";
	const AFTER = "2026-09-24T11:55:00Z";

	test("sf#954 rerun of the same run number failed before posting -> one failure naming that run", async () => {
		const { posts, counts } = await once([
			record(10, "success", 100),
			at(smokeJob(20, "smoke", "pending", 100), AFTER),
			at({ ...smokeJob(20, "smoke", "failure", 100), id: 21 }, AFTER),
		]);
		expect(posts).toEqual([
			{
				path: `/repos/${REPO}/statuses/${SHA}`,
				body: {
					context: "factory/smoke",
					state: "failure",
					description:
						"factory/smoke: rerun of run 100 failed before posting (stale sweep, sf#954)",
					target_url: runUrl(100),
				},
			},
		]);
		expect(counts.superseded).toBe(1);
	});

	test("sf#954 normal run whose job fails after posting the verdict -> no post", async () => {
		const { posts } = await once([
			at(smokeJob(5, "smoke", "pending", 100), BEFORE),
			record(10, "success", 100),
			at({ ...smokeJob(5, "smoke", "failure", 100), id: 11 }, AFTER),
		]);
		expect(posts).toEqual([]);
	});

	test("sf#954 rerun with a job still pending -> no post", async () => {
		const { posts } = await once([
			record(10, "success", 100),
			at(smokeJob(20, "smoke", "pending", 100), AFTER),
		]);
		expect(posts).toEqual([]);
	});

	test("sf#954 rerun whose jobs all succeeded -> no post", async () => {
		const { posts } = await once([
			record(10, "success", 100),
			at(smokeJob(20, "smoke", "pending", 100), AFTER),
			at({ ...smokeJob(20, "smoke", "success", 100), id: 21 }, AFTER),
		]);
		expect(posts).toEqual([]);
	});
});

describe("collectTargets survives one repo's Forge timeout", () => {
	test("sf#797 a timed-out open-PR read for one repo skips it; the other repo's PR heads are still collected", async () => {
		const config = configSchema.parse({
			poll_interval_minutes: 15,
			repositories: [
				{ name: "rodaddy/a", provider: "forgejo" },
				{ name: "rodaddy/b", provider: "forgejo" },
			],
		});
		const db = {
			select: () => ({ from: () => ({ where: async () => [] }) }),
		} as unknown as WatcherDb;
		const client = {
			paginate: async (path: string) => {
				if (path.includes("/repos/rodaddy/a/pulls"))
					throw new Error("Forgejo request failed: request timed out");
				if (path.includes("/repos/rodaddy/b/pulls")) return [{ head: { sha: "b".repeat(40) } }];
				return [];
			},
		} as unknown as ForgeClient;
		// The fake has no `get`: each fixed status repo's commits read throws and is
		// skipped, which is the per-repo isolation.
		expect(await collectTargets(db, client, config)).toEqual([
			{ repo: "rodaddy/b", sha: "b".repeat(40), combined: true },
		]);
	});
});

describe("collectTargets watches the fixed status repos", () => {
	test("sf#1272 open PR heads and newest main commits of each fixed status repo are watched", async () => {
		const config = configSchema.parse({
			poll_interval_minutes: 15,
			repositories: [{ name: "rodaddy/a", provider: "forgejo" }],
		});
		const db = {
			select: () => ({ from: () => ({ where: async () => [] }) }),
		} as unknown as WatcherDb;
		const commits: Record<string, string> = {
			"/repos/rtech/k3s-deploy/commits": "d".repeat(40),
			"/repos/rtech/rtech-consulting/commits": "e".repeat(40),
			"/repos/rtech/hosted-apps/commits": "f".repeat(40),
		};
		const client = {
			paginate: async (path: string) =>
				path.includes("/repos/rtech/k3s-deploy/pulls") ? [{ head: { sha: "c".repeat(40) } }] : [],
			get: async (path: string) => {
				const sha = commits[path.split("?")[0] ?? ""];
				const data = sha ? [{ sha }, { sha: "not-a-sha" }] : [];
				return { status: 200, data, link: null, rateRemaining: null };
			},
		} as unknown as ForgeClient;
		expect(await collectTargets(db, client, config)).toEqual(
			expect.arrayContaining([
				{ repo: "rtech/k3s-deploy", sha: "c".repeat(40), combined: true },
				{ repo: "rtech/k3s-deploy", sha: "d".repeat(40), combined: true },
				{ repo: "rtech/rtech-consulting", sha: "e".repeat(40), combined: true },
				{ repo: "rtech/hosted-apps", sha: "f".repeat(40), combined: true },
			]),
		);
	});
});

describe("the sweep reads Forge only where something can be stranded", () => {
	const config = configSchema.parse({
		poll_interval_minutes: 15,
		repositories: [{ name: REPO, provider: "forgejo" }],
	});

	test("sf#1636 a second step call inside 5 minutes does nothing", async () => {
		const asked: string[] = [];
		const deps = {
			db: {} as WatcherDb,
			config,
			shadow: false,
			clientFor: async (name: string) => {
				asked.push(name);
				return null;
			},
			onError: (e: unknown) => {
				throw e;
			},
		};
		const at = NOW.getTime();
		await runStalePendingStep({ ...deps, now: () => at });
		await runStalePendingStep({ ...deps, now: () => at + 4 * 60_000 });
		expect(asked).toEqual([REPO]);
		await runStalePendingStep({ ...deps, now: () => at + 5 * 60_000 });
		expect(asked).toEqual([REPO, REPO]);
	});

	test("sf#1636 a forge_runs row already terminal in the DB stays a combined-first target", async () => {
		const row = (sha: string, state: string) => ({
			workflow: "prepush.yml",
			inputs: { repo: REPO, head_sha: sha },
			sha,
			state,
		});
		const db = {
			select: () => ({
				from: () => ({
					where: async () => [row("1".repeat(40), "success"), row(SHA, "dispatched")],
				}),
			}),
		} as unknown as WatcherDb;
		const client = { paginate: async () => [] } as unknown as ForgeClient;
		const targets = await collectTargets(db, client, config);
		expect(targets).toEqual([
			{ repo: REPO, sha: "1".repeat(40), combined: true },
			{ repo: REPO, sha: SHA, combined: false },
		]);
	});

	test("sf#1636 a combined-first target is fully read only when its combined status shows a pending", async () => {
		const reads: string[] = [];
		const combined: Record<string, Status[]> = {
			["b".repeat(40)]: [smoke(1, "success")],
			[SHA]: [smoke(2, "pending", OLD)],
		};
		const client = {
			get: async (path: string) => {
				const sha = path.split("/")[5] ?? "";
				const statuses = combined[sha] ?? [];
				const state = statuses.some((s) => s.status === "pending") ? "pending" : "success";
				return { status: 200, data: { state, statuses }, link: null, rateRemaining: null };
			},
			paginate: async (path: string) => {
				reads.push(path);
				return [smoke(2, "pending", OLD)];
			},
			write: async () => ({ status: 201, data: {}, link: null, rateRemaining: null }),
		} as unknown as ForgeClient;
		const counts = await sweepStalePending({
			client,
			targets: [
				{ repo: REPO, sha: "b".repeat(40), combined: true },
				{ repo: REPO, sha: SHA, combined: true },
			],
			now: NOW,
		});
		expect(reads).toEqual([`/repos/${REPO}/commits/${SHA}/statuses?limit=50`]);
		expect(counts.swept).toBe(1);
	});
});
