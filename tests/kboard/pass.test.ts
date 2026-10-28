/**
 * The READY STATION (ruled by the owner 2026-08-01 — "Rulings" and
 * "Station table RATIFIED"). These drive `runKboardPass` and
 * `runKboardTransitionsPass` against a REAL scratch database and a scripted
 * k-board fetch, so the assertions are about persisted state and the exact
 * requests that left the process, not about mock call counts.
 *
 * The two properties written so a MUTATION reds a named test:
 *
 *   (a) THE LIVE-JOB IDEMPOTENCY GUARD. A `ready` task whose local job is still
 *       live must be SKIPPED WITHOUT A CLAIM — no PATCH may leave the process.
 *       Break the guard (let a claimed task with a live job through) and
 *       "a task with a live local job is skipped WITHOUT any claim PATCH" reds.
 *   (b) THE RULED IDEMPOTENCY-KEY DERIVATION. Event keys are
 *       `${task_id}:${job_id}:${event_type}` — derived from the RUN, never a
 *       per-attempt UUID, because the server's UNIQUE constraint is the whole
 *       retry-safety property. Swap the derivation for a fresh UUID and
 *       "the dispatched event carries the RUN-derived idempotency key" reds.
 */
import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import { and, eq } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import { githubItems, githubPostings, jobs, repositories } from "../../src/db/schema";
import type { ForgeClient } from "../../src/forge/boundary";
import { createKboardClient, type FetchLike } from "../../src/kboard/client";
import type { KboardToken } from "../../src/kboard/config";
import {
	eventIdempotencyKey,
	runKboardPass,
	runKboardTransitionsPass,
} from "../../src/kboard/pass";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const NOW = new Date("2026-08-02T09:00:00.000Z");
const BASE_SHA = "a".repeat(40);
const TOKEN: KboardToken = { authorization: () => "Bearer test-token" };

/** One recorded request the fake fetch saw. */
interface Seen {
	url: string;
	method: string;
	body: Record<string, unknown> | undefined;
}

/**
 * A scripted k-board server keyed by `METHOD path-prefix`. Everything not
 * scripted 404s, so a request this station should never send fails loudly rather
 * than silently succeeding against a permissive catch-all.
 */
function fakeBoard(routes: {
	tasks?: Record<string, unknown>[];
	/** Per-task state the GET returns; mutated by a successful PATCH. */
	task?: Record<string, unknown>;
	/** Force a status for the next PATCH (e.g. 409 for a CAS miss). */
	patchStatus?: number;
	/** Force a status for the next event POST. */
	eventStatus?: number;
}): { fetch: FetchLike; seen: Seen[] } {
	const seen: Seen[] = [];
	const state = { ...(routes.task ?? {}) };
	const fetch: FetchLike = async (url, init) => {
		const method = init?.method ?? "GET";
		const body = init?.body
			? (JSON.parse(String(init.body)) as Record<string, unknown>)
			: undefined;
		seen.push({ url, method, body });
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		const json = (status: number, value: unknown) =>
			new Response(JSON.stringify(value), {
				status,
				headers: { "content-type": "application/json" },
			});

		if (method === "GET" && path.startsWith("/api/tasks?")) {
			return json(200, { tasks: routes.tasks ?? [] });
		}
		if (method === "GET" && path.startsWith("/api/tasks/")) {
			return json(200, state);
		}
		if (method === "PATCH" && path.startsWith("/api/tasks/")) {
			const status = routes.patchStatus ?? 200;
			if (status !== 200) return json(status, { error: "conflict" });
			Object.assign(state, body ?? {});
			state.sync_version = Number(state.sync_version ?? 0) + 1;
			return json(200, state);
		}
		if (method === "POST" && path.includes("/events")) {
			const status = routes.eventStatus ?? 201;
			if (status !== 201) return json(status, { error: "already_logged" });
			return json(201, { event_id: "e_1", event_type: String(body?.event_type ?? "") });
		}
		return json(404, { error: "not_found" });
	};
	return { fetch, seen };
}

/** A board task in `ready` with a complete GitHub repo binding. */
function readyTask(over: Record<string, unknown> = {}): Record<string, unknown> {
	return {
		task_id: "t_ready1",
		title: "Implement the thing",
		status: "ready",
		sync_version: 3,
		assignee: null,
		repo_provider: "github",
		repo_full_name: "rodaddy/x",
		repo_item_number: 42,
		...over,
	};
}

/**
 * Config managing exactly `rodaddy/x` on GitHub, with a pinned base branch AND
 * the implement template allowlisted. The allowlist entry is LOAD-BEARING:
 * the station now refuses to claim a task whose implement template is not in
 * `job_templates`, so a config without it claims nothing.
 */
function config(over: Partial<WatcherConfig["repositories"][number]> = {}): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{
				name: "rodaddy/x",
				provider: "github",
				checks: "standard",
				gate_selection: "full",
				proposal_base_branch: "main",
				...over,
			},
		],
		job_templates: [{ id: "implement-issue", runner_size: "medium", return_mode: "patch" }],
		doorbell_enabled: false,
		shadow_publish: false,
	} as unknown as WatcherConfig;
}

/**
 * A forge client that answers only the branch-tip lookup the base resolution
 * needs. `proposal_base_branch` is pinned in config above, so the default-branch
 * read never happens and a single scripted GET is the whole surface.
 */
function forgeClient(tipSha: string | null): ForgeClient {
	return {
		provider: "github",
		get: async <T>(path: string) => {
			if (tipSha !== null && path.includes("/branches/")) {
				return { data: { commit: { sha: tipSha } } as T, status: 200, headers: new Headers() };
			}
			throw new Error("branch not found");
		},
		getPage: async () => {
			throw new Error("unused");
		},
		paginate: async () => [],
		write: async () => {
			throw new Error("unused");
		},
		postCommitCheck: async () => ({ status: "failed" as const, reason: "unused" }),
		findCommitCheck: async () => ({ status: "absent" as const }),
	} as unknown as ForgeClient;
}

/** Deps for a pass whose forge resolves the base to {@link BASE_SHA}. */
function deps(
	db: TestDb,
	fetch: FetchLike,
	over: { tipSha?: string | null; config?: WatcherConfig } = {},
) {
	return {
		db,
		client: createKboardClient({ token: TOKEN, fetch, sleep: async () => {} }),
		config: over.config ?? config(),
		clientFor: async () => forgeClient(over.tipSha === undefined ? BASE_SHA : over.tipSha),
	};
}

/** Seed the repository + item rows a pre-existing local job needs. */
async function seedRepoAndItem(db: TestDb, itemNumber: number): Promise<[number, number]> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x", provider: "github", checks: "standard" })
		.returning({ id: repositories.id });
	if (!repo) throw new Error("seed failed");
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "issue", number: itemNumber, state: "open" })
		.returning({ id: githubItems.id });
	if (!item) throw new Error("seed failed");
	return [repo.id, item.id];
}

/** Every PATCH the fake board saw. */
function patches(seen: Seen[]): Seen[] {
	return seen.filter((s) => s.method === "PATCH");
}

/** Every event POST the fake board saw. */
function events(seen: Seen[]): Seen[] {
	return seen.filter((s) => s.method === "POST" && s.url.includes("/events"));
}

/**
 * Run `fn` capturing the NDJSON log lines it emits.
 *
 * Captured at the DESCRIPTOR level, the way `tests/kboard/client.test.ts` does:
 * post-#88 the logger (pino) writes synchronously to fd 2 via `fs.writeSync`, NOT
 * through `process.stderr.write`, so a `process.stderr` spy sees nothing and any
 * assertion on log content passes vacuously.
 */
async function withCapturedLogs<T>(
	fn: () => Promise<T>,
): Promise<{ value: T; lines: Record<string, unknown>[] }> {
	const raw: string[] = [];
	const realWriteSync = fs.writeSync;
	(fs as { writeSync: typeof fs.writeSync }).writeSync = ((
		fd: number,
		data: string | NodeJS.ArrayBufferView,
		...rest: unknown[]
	) => {
		if (fd === 2) {
			const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString();
			raw.push(text);
			return typeof data === "string" ? Buffer.byteLength(text) : (data as Uint8Array).length;
		}
		return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
	}) as typeof fs.writeSync;
	try {
		const value = await fn();
		const lines = raw
			.join("")
			.split("\n")
			.filter((l) => l.trim().length > 0)
			.map((l) => JSON.parse(l) as Record<string, unknown>);
		return { value, lines };
	} finally {
		(fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
	}
}

describe("runKboardPass — the ready station", () => {
	test("a ready task is claimed and given a local implement job carrying its task id", async () => {
		await withTestDb(async (db) => {
			const { fetch, seen } = fakeBoard({ tasks: [readyTask()], task: readyTask() });
			const summary = await runKboardPass(deps(db, fetch), NOW);

			expect(summary.enabled).toBe(true);
			expect(summary.tasks).toBe(1);
			// REGRESSION GUARD for the #144 gate: with the template ALLOWLISTED the
			// claim still happens exactly as before. A gate that refused everything
			// would red here rather than only in its own named test.
			expect(summary.claimed).toBe(1);
			expect(summary.skipped).toBe(0);

			// The claim PATCH assigns the factory actor and moves the task to running,
			// under the CAS token the fresh GET returned.
			const claim = patches(seen)[0];
			expect(claim?.body?.assignee).toBe("factory-watcher");
			expect(claim?.body?.status).toBe("running");
			expect(claim?.body?.expected_sync_version).toBe(3);

			// The local job exists, is pending, targets the PROVEN base, and carries the
			// board task id — the marker every ruled transition keys on.
			const [job] = await db.select().from(jobs);
			expect(job?.status).toBe("pending");
			expect(job?.jobType).toBe("implement-issue");
			expect(job?.sha).toBe(BASE_SHA);
			expect(job?.kboardTaskId).toBe("t_ready1");
		});
	});

	test("the dispatched event carries the RUN-derived idempotency key", async () => {
		await withTestDb(async (db) => {
			const { fetch, seen } = fakeBoard({ tasks: [readyTask()], task: readyTask() });
			await runKboardPass(deps(db, fetch), NOW);

			const [job] = await db.select().from(jobs);
			if (!job) throw new Error("no job created");

			const posted = events(seen);
			expect(posted).toHaveLength(1);
			expect(posted[0]?.body?.event_type).toBe("dispatched");
			// MUTATION TARGET: swap the derivation for a fresh UUID and this reds. The
			// key must be reproducible from (task, job, type) alone — that is what makes
			// the server's UNIQUE constraint absorb a retried pass instead of
			// double-logging it.
			expect(posted[0]?.body?.idempotency_key).toBe(
				eventIdempotencyKey("t_ready1", job.id, "dispatched"),
			);
			expect(posted[0]?.body?.idempotency_key).toBe(`t_ready1:${job.id}:dispatched`);
		});
	});

	test("a non-managed repository is skipped without any claim", async () => {
		await withTestDb(async (db) => {
			const { fetch, seen } = fakeBoard({
				tasks: [readyTask({ repo_full_name: "someone/else" })],
			});
			const summary = await runKboardPass(deps(db, fetch), NOW);

			expect(summary.skipped).toBe(1);
			expect(summary.claimed).toBe(0);
			// Board placement authorizes only for a MANAGED repository. Nothing was
			// mutated on the board and no job was created.
			expect(patches(seen)).toHaveLength(0);
			expect(await db.select().from(jobs)).toHaveLength(0);
		});
	});

	test("a ready task on a MANAGED forgejo repository is claimed", async () => {
		await withTestDb(async (db) => {
			// The phase-1b `provider !== "github"` pin in `validateBinding` is LIFTED
			// (umbrella sf#249 — the factory moves to Forge). Authorization is
			// still the managed-repository allowlist keyed on the provider-qualified
			// pair, so this only claims because the config below manages
			// (forgejo, rodaddy/x). MUTATION TARGET: restore the github-only pin and
			// this reds — the task is skipped and no claim PATCH leaves the process.
			const forgejoConfig = config({ provider: "forgejo" });
			const task = readyTask({ repo_provider: "forgejo" });
			const { fetch, seen } = fakeBoard({ tasks: [task], task });
			const summary = await runKboardPass(deps(db, fetch, { config: forgejoConfig }), NOW);

			expect(summary.tasks).toBe(1);
			expect(summary.claimed).toBe(1);
			expect(summary.skipped).toBe(0);
			expect(patches(seen)).toHaveLength(1);
			const [job] = await db.select().from(jobs);
			expect(job?.status).toBe("pending");
			expect(job?.sha).toBe(BASE_SHA);
			expect(job?.kboardTaskId).toBe("t_ready1");
		});
	});

	test("a ready task on an UNMANAGED forgejo repository is still skipped", async () => {
		await withTestDb(async (db) => {
			// Lifting the provider pin must not widen authorization: the config below
			// manages (github, rodaddy/x) only, so the same full_name on forgejo is a
			// DIFFERENT managed key and stays unauthorized.
			const task = readyTask({ repo_provider: "forgejo" });
			const { fetch, seen } = fakeBoard({ tasks: [task], task });
			const summary = await runKboardPass(deps(db, fetch), NOW);

			expect(summary.skipped).toBe(1);
			expect(summary.claimed).toBe(0);
			expect(patches(seen)).toHaveLength(0);
			expect(await db.select().from(jobs)).toHaveLength(0);
		});
	});

	test("a ready task whose implement template is NOT allowlisted is never claimed", async () => {
		await withTestDb(async (db) => {
			const { fetch, seen } = fakeBoard({ tasks: [readyTask()], task: readyTask() });
			// `implement-issue` ships commented-out in repos.example.yml — deliberate
			// opt-in — so a factory that has not enabled it must leave the task where
			// the human parked it. Claiming here strands the task in `running` behind a
			// job the dispatcher re-defers hourly forever (live 2026-08-02, job 715).
			const noTemplates = { ...config(), job_templates: [] } as unknown as WatcherConfig;
			const { value: summary, lines } = await withCapturedLogs(() =>
				runKboardPass(deps(db, fetch, { config: noTemplates }), NOW),
			);

			expect(summary.tasks).toBe(1);
			expect(summary.skipped).toBe(1);
			expect(summary.claimed).toBe(0);
			// MUTATION TARGET: invert (or delete) the gate and this reds — a claim PATCH
			// goes out and the task lands in `running` with a job nothing will dispatch.
			expect(patches(seen)).toHaveLength(0);
			expect(events(seen)).toHaveLength(0);
			expect(await db.select().from(jobs)).toHaveLength(0);

			// And the refusal is NAMED, not silent: an absent gate and a refusing gate
			// must not look alike. MUTATION TARGET: drop the log call and this reds.
			const warn = lines.find((l) => l.msg === "kboard.template_not_allowlisted");
			expect(warn).toBeDefined();
			expect(warn?.level).toBe("warn");
			expect(warn?.task_id).toBe("t_ready1");
			expect(warn?.template_id).toBe("implement-issue");
		});
	});

	test("a ready task on an implement_runtime: actions repo creates no box job", async () => {
		await withTestDb(async (db) => {
			// The Actions lane implements this repo; a box implement-issue job from the
			// board would run the retired path alongside it. MUTATION TARGET: drop the
			// runtime check and this reds -- a claim PATCH goes out and a jobs row lands.
			const actions = config({ provider: "forgejo", implement_runtime: "actions" });
			const task = readyTask({ repo_provider: "forgejo" });
			const { fetch, seen } = fakeBoard({ tasks: [task], task });
			const { value: summary, lines } = await withCapturedLogs(() =>
				runKboardPass(deps(db, fetch, { config: actions }), NOW),
			);

			expect(summary.skipped).toBe(1);
			expect(summary.claimed).toBe(0);
			expect(patches(seen)).toHaveLength(0);
			expect(events(seen)).toHaveLength(0);
			expect(await db.select().from(jobs)).toHaveLength(0);
			const warn = lines.find((l) => l.msg === "kboard.implement.actions_runtime_not_wired");
			expect(warn?.task_id).toBe("t_ready1");
		});
	});

	test("a ready task on an implement_runtime: box repo still gets its box job", async () => {
		await withTestDb(async (db) => {
			const box = config({ provider: "forgejo", implement_runtime: "box" });
			const task = readyTask({ repo_provider: "forgejo" });
			const { fetch } = fakeBoard({ tasks: [task], task });
			const summary = await runKboardPass(deps(db, fetch, { config: box }), NOW);

			expect(summary.claimed).toBe(1);
			const [job] = await db.select().from(jobs);
			expect(job?.jobType).toBe("implement-issue");
		});
	});

	test("a task with a live local job is skipped WITHOUT any claim PATCH", async () => {
		await withTestDb(async (db) => {
			// The live job carries the TASK ID but is bound to a DIFFERENT item, so only
			// the task-id guard can catch it — the item-level guard below is looking at
			// item 42 and would see nothing. That isolation is deliberate: it makes this
			// test fail for exactly one reason.
			const [repoId] = await seedRepoAndItem(db, 42);
			const [other] = await db
				.insert(githubItems)
				.values({ repositoryId: repoId, kind: "issue", number: 99, state: "open" })
				.returning({ id: githubItems.id });
			if (!other) throw new Error("seed failed");
			await db.insert(jobs).values({
				repositoryId: repoId,
				itemId: other.id,
				sha: BASE_SHA,
				jobType: "implement-issue",
				status: "running",
				kboardTaskId: "t_ready1",
			});

			const { fetch, seen } = fakeBoard({ tasks: [readyTask()], task: readyTask() });
			const summary = await runKboardPass(deps(db, fetch), NOW);

			expect(summary.skipped).toBe(1);
			expect(summary.claimed).toBe(0);
			// MUTATION TARGET: break the live-job guard and this reds — a second claim
			// PATCH would go out and a second implement job would race the first to
			// propose a competing change for one piece of work.
			expect(patches(seen)).toHaveLength(0);
			expect(await db.select().from(jobs)).toHaveLength(1);
		});
	});

	test("an item already worked by the LABEL lane is skipped without a claim", async () => {
		await withTestDb(async (db) => {
			// No task id on the live job: the label lane queued it. A board task pointed
			// at the same issue must not queue a second competing implement run — the two
			// triggers coexist, so this collision is the expected steady state, not an
			// exceptional one.
			const [repoId, itemId] = await seedRepoAndItem(db, 42);
			await db.insert(jobs).values({
				repositoryId: repoId,
				itemId,
				sha: "b".repeat(40),
				jobType: "implement-issue",
				status: "running",
			});

			const { fetch, seen } = fakeBoard({ tasks: [readyTask()], task: readyTask() });
			const summary = await runKboardPass(deps(db, fetch), NOW);

			expect(summary.skipped).toBe(1);
			expect(patches(seen)).toHaveLength(0);
			expect(await db.select().from(jobs)).toHaveLength(1);
		});
	});

	test("a CAS miss on the claim skips the task and creates no job", async () => {
		await withTestDb(async (db) => {
			const { fetch, seen } = fakeBoard({
				tasks: [readyTask()],
				task: readyTask(),
				patchStatus: 409,
			});
			const summary = await runKboardPass(deps(db, fetch), NOW);

			expect(summary.refused).toBe(1);
			expect(summary.claimed).toBe(0);
			// Exactly ONE PATCH: the refusal is never blind-retried ("someone else moved
			// it" is an answer, not a transient fault).
			expect(patches(seen)).toHaveLength(1);
			expect(await db.select().from(jobs)).toHaveLength(0);
		});
	});

	test("a claim that wins but cannot enqueue moves the task to blocked with runner_failed", async () => {
		await withTestDb(async (db) => {
			const [repoId, itemId] = await seedRepoAndItem(db, 42);
			// A TERMINAL job on the exact uniqueness key (repo, item, sha, type). It is
			// not live, so the guards let the claim through — then `createPendingJob`
			// conflicts and inserts nothing. A claimed task with no job behind it is the
			// one state this station must never leave, so it must land in `blocked`.
			await db.insert(jobs).values({
				repositoryId: repoId,
				itemId,
				sha: BASE_SHA,
				jobType: "implement-issue",
				status: "completed",
			});

			const { fetch, seen } = fakeBoard({ tasks: [readyTask()], task: readyTask() });
			const summary = await runKboardPass(deps(db, fetch), NOW);

			expect(summary.failed).toBe(1);
			expect(summary.claimed).toBe(0);
			// Two PATCHes: the winning claim, then the ruled failure transition.
			const sent = patches(seen);
			expect(sent).toHaveLength(2);
			expect(sent[1]?.body?.status).toBe("blocked");
			const posted = events(seen);
			expect(posted).toHaveLength(1);
			expect(posted[0]?.body?.event_type).toBe("runner_failed");
		});
	});

	test("an item the sweep already recorded keeps its title and state", async () => {
		await withTestDb(async (db) => {
			const [repoId] = await seedRepoAndItem(db, 1);
			// The sweep's own row, with the forge's real values on it.
			await db.insert(githubItems).values({
				repositoryId: repoId,
				kind: "issue",
				number: 42,
				state: "open",
				title: "The real issue title",
			});

			const { fetch } = fakeBoard({ tasks: [readyTask()], task: readyTask() });
			await runKboardPass(deps(db, fetch), NOW);

			const [row] = await db
				.select()
				.from(githubItems)
				.where(and(eq(githubItems.repositoryId, repoId), eq(githubItems.number, 42)));
			// The station knows only the integer the board handed it, so it must never
			// overwrite what the forge read actually established. An upsert here would
			// blank the title, and the sweep only rewrites it if the issue falls inside
			// its cursor window — which for a long-idle issue it does not.
			expect(row?.title).toBe("The real issue title");
		});
	});

	test("an unresolvable base leaves the task in ready and claims nothing", async () => {
		await withTestDb(async (db) => {
			const { fetch, seen } = fakeBoard({ tasks: [readyTask()], task: readyTask() });
			// The base must be PROVEN LIVE (#65 compares a bundle against the exact
			// dispatched commit in full). No tip, no claim — the task stays where the
			// human parked it rather than stranding in `running`.
			const summary = await runKboardPass(deps(db, fetch, { tipSha: null }), NOW);

			expect(summary.skipped).toBe(1);
			expect(patches(seen)).toHaveLength(0);
			expect(await db.select().from(jobs)).toHaveLength(0);
		});
	});

	test("no token disables the whole pass and leaves the cycle untouched", async () => {
		await withTestDb(async (db) => {
			const summary = await runKboardPass(
				{
					db,
					client: null,
					config: config(),
					clientFor: async () => forgeClient(BASE_SHA),
				},
				NOW,
			);
			// The credential is minted as a separate operator step, so this service must
			// deploy and boot BEFORE it exists.
			expect(summary.enabled).toBe(false);
			expect(summary.tasks).toBe(0);
			expect(summary.claimed).toBe(0);
			expect(await db.select().from(jobs)).toHaveLength(0);
		});
	});
});

describe("runKboardTransitionsPass — the ruled outcome transitions", () => {
	test("a posted proposal for a board-claimed job sets the PR number, review, and the event", async () => {
		await withTestDb(async (db) => {
			const [repoId, itemId] = await seedRepoAndItem(db, 42);
			const [job] = await db
				.insert(jobs)
				.values({
					repositoryId: repoId,
					itemId,
					sha: BASE_SHA,
					jobType: "implement-issue",
					status: "completed",
					kboardTaskId: "t_ready1",
				})
				.returning({ id: jobs.id });
			if (!job) throw new Error("seed failed");
			await db.insert(githubPostings).values({
				jobId: job.id,
				kind: "proposal",
				action: "open",
				target: "rw/issue-42",
				status: "posted",
				payload: "{}",
				dedupeKey: "d",
				externalRef: "137",
			});

			const { fetch, seen } = fakeBoard({ task: readyTask({ status: "running" }) });
			const summary = await runKboardTransitionsPass({
				db,
				client: createKboardClient({ token: TOKEN, fetch, sleep: async () => {} }),
			});

			expect(summary.reviewed).toBe(1);
			const sent = patches(seen);
			// The forge's own PR number, then the ruled `review` status.
			expect(sent[0]?.body?.repo_pr_number).toBe(137);
			expect(sent[1]?.body?.status).toBe("review");
			const posted = events(seen);
			expect(posted).toHaveLength(1);
			expect(posted[0]?.body?.event_type).toBe("proposal_opened");
			expect(posted[0]?.body?.idempotency_key).toBe(
				eventIdempotencyKey("t_ready1", job.id, "proposal_opened"),
			);
		});
	});

	test("a proposal for a LABEL-triggered job reports nothing to the board", async () => {
		await withTestDb(async (db) => {
			const [repoId, itemId] = await seedRepoAndItem(db, 42);
			const [job] = await db
				.insert(jobs)
				.values({
					repositoryId: repoId,
					itemId,
					sha: BASE_SHA,
					jobType: "implement-issue",
					status: "completed",
					// No task id: the pre-existing label path, which must stay untouched
					// while board and label triggers coexist.
				})
				.returning({ id: jobs.id });
			if (!job) throw new Error("seed failed");
			await db.insert(githubPostings).values({
				jobId: job.id,
				kind: "proposal",
				action: "open",
				target: "rw/issue-42",
				status: "posted",
				payload: "{}",
				dedupeKey: "d",
				externalRef: "137",
			});

			const { fetch, seen } = fakeBoard({ task: readyTask({ status: "running" }) });
			const summary = await runKboardTransitionsPass({
				db,
				client: createKboardClient({ token: TOKEN, fetch, sleep: async () => {} }),
			});

			expect(summary.reviewed).toBe(0);
			expect(seen).toHaveLength(0);
		});
	});

	test("a terminal-failed board-claimed job is moved to blocked with runner_failed", async () => {
		await withTestDb(async (db) => {
			const [repoId, itemId] = await seedRepoAndItem(db, 42);
			const [job] = await db
				.insert(jobs)
				.values({
					repositoryId: repoId,
					itemId,
					sha: BASE_SHA,
					jobType: "implement-issue",
					status: "failed",
					kboardTaskId: "t_ready1",
				})
				.returning({ id: jobs.id });
			if (!job) throw new Error("seed failed");

			const { fetch, seen } = fakeBoard({ task: readyTask({ status: "running" }) });
			const summary = await runKboardTransitionsPass({
				db,
				client: createKboardClient({ token: TOKEN, fetch, sleep: async () => {} }),
			});

			expect(summary.blocked).toBe(1);
			expect(patches(seen)[0]?.body?.status).toBe("blocked");
			const posted = events(seen);
			expect(posted[0]?.body?.event_type).toBe("runner_failed");
			expect(posted[0]?.body?.idempotency_key).toBe(
				eventIdempotencyKey("t_ready1", job.id, "runner_failed"),
			);
		});
	});

	test("a task re-worked after an earlier failure is NOT dragged back to blocked", async () => {
		await withTestDb(async (db) => {
			const [repoId, itemId] = await seedRepoAndItem(db, 42);
			// The task's FIRST run, terminal-failed and already reported.
			await db.insert(jobs).values({
				repositoryId: repoId,
				itemId,
				sha: BASE_SHA,
				jobType: "implement-issue",
				status: "failed",
				kboardTaskId: "t_ready1",
			});
			// A SECOND run for the same task, live. Only the newest job speaks for the
			// task; without that restriction the old `failed` row would re-write
			// `blocked` every cycle and undo the human's re-queue with an automated write.
			await db.insert(jobs).values({
				repositoryId: repoId,
				itemId,
				sha: "c".repeat(40),
				jobType: "implement-issue",
				status: "running",
				kboardTaskId: "t_ready1",
			});

			const { fetch, seen } = fakeBoard({ task: readyTask({ status: "running" }) });
			const summary = await runKboardTransitionsPass({
				db,
				client: createKboardClient({ token: TOKEN, fetch, sleep: async () => {} }),
			});

			expect(summary.blocked).toBe(0);
			expect(seen).toHaveLength(0);
		});
	});

	test("a task already at its target status converges without a write", async () => {
		await withTestDb(async (db) => {
			const [repoId, itemId] = await seedRepoAndItem(db, 42);
			await db.insert(jobs).values({
				repositoryId: repoId,
				itemId,
				sha: BASE_SHA,
				jobType: "implement-issue",
				status: "failed",
				kboardTaskId: "t_ready1",
			});

			const { fetch, seen } = fakeBoard({ task: readyTask({ status: "blocked" }) });
			const summary = await runKboardTransitionsPass({
				db,
				client: createKboardClient({ token: TOKEN, fetch, sleep: async () => {} }),
			});

			expect(summary.converged).toBe(1);
			expect(summary.blocked).toBe(0);
			// One GET to check, and no write at all. Re-reporting every cycle forever
			// would be safe (the writes are idempotent) but wasteful.
			expect(patches(seen)).toHaveLength(0);
			expect(events(seen)).toHaveLength(0);
		});
	});

	test("a MERGED task (done) is never dragged back — done is human-only", async () => {
		await withTestDb(async (db) => {
			const [repoId, itemId] = await seedRepoAndItem(db, 42);
			const [job] = await db
				.insert(jobs)
				.values({
					repositoryId: repoId,
					itemId,
					sha: BASE_SHA,
					jobType: "implement-issue",
					status: "completed",
					kboardTaskId: "t_ready1",
				})
				.returning({ id: jobs.id });
			if (!job) throw new Error("seed failed");
			await db.insert(githubPostings).values({
				jobId: job.id,
				kind: "proposal",
				action: "open",
				target: "rw/issue-42",
				status: "posted",
				payload: "{}",
				dedupeKey: "d",
				externalRef: "137",
			});

			const { fetch, seen } = fakeBoard({ task: readyTask({ status: "done" }) });
			const summary = await runKboardTransitionsPass({
				db,
				client: createKboardClient({ token: TOKEN, fetch, sleep: async () => {} }),
			});

			expect(summary.converged).toBe(1);
			expect(summary.reviewed).toBe(0);
			expect(patches(seen)).toHaveLength(0);
		});
	});

	test("no token makes the reporter inert", async () => {
		await withTestDb(async (db) => {
			const summary = await runKboardTransitionsPass({ db, client: null });
			expect(summary.enabled).toBe(false);
			expect(summary.reviewed).toBe(0);
			expect(summary.blocked).toBe(0);
		});
	});
});

describe("the label path is untouched", () => {
	test("a label-triggered job row still carries a NULL task id", async () => {
		await withTestDb(async (db) => {
			const [repoId, itemId] = await seedRepoAndItem(db, 7);
			await db.insert(jobs).values({
				repositoryId: repoId,
				itemId,
				sha: BASE_SHA,
				jobType: "implement-issue",
				status: "pending",
			});
			const [row] = await db
				.select()
				.from(jobs)
				.where(and(eq(jobs.repositoryId, repoId), eq(jobs.itemId, itemId)));
			// The NULL is the discriminator: every ruled board transition keys on a
			// non-null task id, so the label lane is invisible to the station.
			expect(row?.kboardTaskId).toBeNull();
		});
	});
});
