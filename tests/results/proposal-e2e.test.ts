/**
 * The implement lane, END TO END.
 *
 * Two independent review lanes rejected helper-level mocks for this chain on PR
 * #83, and they were right to: every piece of it was already tested in isolation
 * and passing while the lane as a whole did nothing. `verifyChangeBundle` had no
 * production caller at all, so `result.change` was never read, no bundle was ever
 * verified, and `pushVerifiedBranch` was never reached. Each unit test was green.
 *
 * So this drives the REAL cycle: a real scratch database, a real share directory
 * a runner would have written, a real `git bundle` produced by real git against a
 * real origin repository, and the real `runOnce` composition. The only fakes are
 * the forge client and the runner transport — the network and the runner box.
 *
 * The assertion chain is the one that was missing: the named watcher-result.json
 * on the share -> a verified bundle -> a branch that actually EXISTS on the origin
 * at the right commit -> a persisted, pending `proposal` posting pointing at that
 * branch.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { eq } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import { githubItems, githubPostings, jobAttempts, jobs, repositories } from "../../src/db/schema";
import type { GitHubClient, GitHubResponse } from "../../src/github/client";
import { RESULT_VERSION } from "../../src/results/schema";
import type {
	RunnerAllocation,
	RunnerRunParams,
	RunnerTransport,
} from "../../src/runner/transport";
import { runOnce } from "../../src/service";
import { WATCHER_RESULT_NAME } from "../../src/templates/agent-lane";
import { withTestDb } from "../db/helpers";
import { testTmpBase } from "../support/test-temp";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const REPO = "rodaddy/x";
const ITEM = 42;
const RAIL_IDS = [
	"replicas-default",
	"replicas-spread",
	"cnpg-implies-backup",
	"no-unbounded-ephemeral",
	"storageclass-explicit",
	"pvc-prune-guard",
	"port-bands",
	"no-new-lxc",
	"runner-label",
	"probe-shape",
	"bind-all-interfaces",
] as const;

/**
 * Run git, failing loudly: a broken fixture must not look like a failed assertion.
 *
 * `core.hooksPath=/dev/null` makes these throwaway fixture repositories hermetic.
 * Without it they inherit the operator's `core.hooksPath`, and this repo's own
 * protected-branch hook blocks the fixture's second commit to `main` — a real
 * failure that has nothing to do with what is under test.
 */
function git(args: string[], cwd: string): string {
	const out = Bun.spawnSync(["git", "-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		env: {
			...process.env,
			GIT_AUTHOR_NAME: "t",
			GIT_AUTHOR_EMAIL: "t@example.invalid",
			GIT_COMMITTER_NAME: "t",
			GIT_COMMITTER_EMAIL: "t@example.invalid",
		},
	});
	if (out.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString()}`);
	}
	return out.stdout.toString().trim();
}

/**
 * Build the world a real implement job leaves behind:
 *   - an `origin` bare repo with a base commit (what the watcher dispatched)
 *   - a work clone with ONE new commit on top (what the runner produced)
 *   - a `git bundle` of that commit, written into the runner's own share dir
 *   - the named watcher-result.json claiming it
 */
function buildFixture(root: string): { origin: string; baseSha: string; headSha: string } {
	const origin = join(root, "origin.git");
	const work = join(root, "work");
	mkdirSync(origin, { recursive: true });
	mkdirSync(work, { recursive: true });

	git(["init", "--bare", "--quiet", "--initial-branch=main"], origin);
	git(["init", "--quiet", "--initial-branch=main"], work);
	writeFileSync(join(work, "README.md"), "base\n");
	git(["add", "README.md"], work);
	git(["commit", "--quiet", "-m", "base"], work);
	git(["remote", "add", "origin", origin], work);
	git(["push", "--quiet", "origin", "main"], work);
	const baseSha = git(["rev-parse", "HEAD"], work);

	// The runner's change: one commit on top of the exact dispatched base.
	writeFileSync(join(work, "feature.txt"), "implemented\n");
	git(["add", "feature.txt"], work);
	git(["commit", "--quiet", "-m", `implement #${ITEM}`], work);
	const headSha = git(["rev-parse", "HEAD"], work);

	return { origin, baseSha, headSha };
}

function writeRailsManifest(root: string): string {
	const path = join(root, "factory-rails.yml");
	writeFileSync(
		path,
		[
			"constraints:",
			...RAIL_IDS.flatMap((id) => [`  - id: ${id}`, "    check: fixture"]),
			"not_encoded: []",
		].join("\n"),
	);
	return path;
}

function config(): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [{ name: REPO, provider: "github", checks: "standard", gate_selection: "full" }],
		job_templates: [{ id: "implement-issue", runner_size: "medium", return_mode: "patch" }],
		doorbell_enabled: false,
		shadow_publish: false,
	};
}

/** Reads are empty; the default-branch read answers `main`. Writes never happen here. */
function fakeClient(): GitHubClient {
	const resp = <T>(data: T): GitHubResponse<T> => ({
		status: 200,
		data,
		link: null,
		rateRemaining: null,
	});
	return {
		async get<T>(path: string): Promise<GitHubResponse<T>> {
			if (/^\/repos\/[^/]+\/[^/]+$/.test(path)) {
				return resp({ default_branch: "main" } as unknown as T);
			}
			return resp([] as unknown as T);
		},
		async paginate<T>(): Promise<T[]> {
			return [];
		},
		async getPage<T>(): Promise<{ body: T; next: string | null }> {
			return { body: [] as unknown as T, next: null };
		},
		async write<T>(): Promise<GitHubResponse<T>> {
			return resp({ number: 1, html_url: "https://example.invalid/pr/1" } as unknown as T);
		},
	} as unknown as GitHubClient;
}

function fakeTransport(): RunnerTransport {
	return {
		startBandMember: async () => {
			throw new Error("not implemented");
		},
		stopBandMember: async () => {
			throw new Error("not implemented");
		},
		listBand: async () => {
			throw new Error("not implemented");
		},
		needed: async (): Promise<RunnerAllocation> => ({
			ok: true,
			boxes: [{ vmid: 9001, size: "medium" }],
		}),
		run: async (_p: RunnerRunParams) => {},
		list: async () => [],
		done: async () => {},
	};
}

/**
 * Seed a COMPLETED implement attempt whose result is waiting on the share, which
 * is the state the reconciler picks up. Written directly because dispatching a
 * real runner is not what this test is proving.
 */
async function seedAttempt(db: TestDb, jobRunnerId: string, baseSha: string): Promise<void> {
	/** A fixture insert that returned nothing is a broken fixture, not a test failure. */
	const required = <T>(rows: T[], what: string): T => {
		const row = rows[0];
		if (row === undefined) {
			throw new Error(`fixture failed to insert ${what}`);
		}
		return row;
	};

	const repo = required(
		await db
			.insert(repositories)
			.values({ fullName: REPO, provider: "github" })
			.returning({ id: repositories.id }),
		"repository",
	);
	const item = required(
		await db
			.insert(githubItems)
			.values({
				repositoryId: repo.id,
				number: ITEM,
				kind: "issue",
				state: "open",
				title: "implement me",
			})
			.returning({ id: githubItems.id }),
		"item",
	);
	const job = required(
		await db
			.insert(jobs)
			.values({
				repositoryId: repo.id,
				itemId: item.id,
				jobType: "implement-issue",
				status: "running",
				sha: baseSha,
			})
			.returning({ id: jobs.id }),
		"job",
	);
	const attempt = required(
		await db
			.insert(jobAttempts)
			.values({
				jobId: job.id,
				status: "submitted",
				runnerJobId: jobRunnerId,
				runnerVmid: 9001,
			})
			.returning({ id: jobAttempts.id }),
		"attempt",
	);
	// The dispatch path sets `active_attempt_id` when an attempt claims the job;
	// a running job in production always has an owner. Seed it so the store's ownership
	// guard sees the attempt that OWNS this running job, mirroring real dispatch.
	await db.update(jobs).set({ activeAttemptId: attempt.id }).where(eq(jobs.id, job.id));
}

describe("the implement lane end to end", () => {
	test("result.json becomes a verified bundle, a real pushed branch, and a queued proposal", async () => {
		await withTestDb(async (db) => {
			// mkdtemp, not a time stamp: two concurrent test processes (the full
			// check and a receipt sandbox) could pick the same performance.now()
			// value and share one fixture directory.
			mkdirSync(join(testTmpBase(), "_scratch"), { recursive: true });
			const root = mkdtempSync(join(testTmpBase(), "_scratch", "proposal-e2e-"));
			const stamp = basename(root).slice("proposal-e2e-".length);
			const share = join(root, "collab");
			const workRoot = join(root, "watcher-work");
			const jobRunnerId = `rw-implement-${stamp}`;
			mkdirSync(root, { recursive: true });

			const { origin, baseSha, headSha } = buildFixture(root);
			const railsManifestPath = writeRailsManifest(root);

			// The runner's own output directory on the share, and the bundle in it.
			const hostDir = join(share, "runners", "jobs", jobRunnerId, "runner-1");
			mkdirSync(hostDir, { recursive: true });
			git(
				["bundle", "create", join(hostDir, "change.bundle"), `${baseSha}..HEAD`],
				join(root, "work"),
			);
			writeFileSync(
				join(hostDir, WATCHER_RESULT_NAME),
				JSON.stringify({
					result_version: RESULT_VERSION,
					repository: REPO,
					job_type: "implement-issue",
					item_number: ITEM,
					sha: baseSha,
					status: "passed",
					// A COMPLIANT trail: the implement lane's required-check manifest
					// demands `secrets` and `test` be PRESENT, so a fixture
					// carrying only `lint` is now rejected at gate 0 before any bundle
					// work. Kept complete here so each test still proves the gate its
					// name describes rather than tripping the trail gate first.
					checks: [
						{ name: "lint", status: "pass" },
						{ name: "secrets", status: "pass" },
						{ name: "test", status: "pass" },
					],
					findings: [],
					output_path: `runners/jobs/${jobRunnerId}/runner-1/agent.log`,
					change: { base_sha: baseSha, bundle_path: "change.bundle" },
				}),
			);
			writeFileSync(join(hostDir, "DONE"), "");

			await seedAttempt(db, jobRunnerId, baseSha);

			await runOnce({
				collabRoot: share,
				changeWorkRoot: workRoot,
				loadConfig: async () => ({ ok: true as const, config: config() }),
				resolveGitHubToken: async () => ({ ok: true as const, token: "t" }),
				createDb: () => ({ db, client: { end: async () => {} } }),
				createGitHubClient: () => fakeClient(),
				transport: fakeTransport(),
				railsManifestPath,
				// Point the lane at the local fixture origin instead of github.com, so the
				// base fetch and the push are REAL git against a REAL repository.
				remoteFor: () => origin,
			});

			// 1. The change was VERIFIED, so the result was accepted rather than refused.
			const [attempt] = await db
				.select({ status: jobAttempts.status })
				.from(jobAttempts)
				.where(eq(jobAttempts.runnerJobId, jobRunnerId))
				.limit(1);
			expect(attempt?.status).toBe("completed");

			// 2. The branch EXISTS ON THE ORIGIN, at exactly the commit the runner made.
			//    This is the assertion no mock can fake: real git, real ref, real sha.
			const pushed = git(["rev-parse", "refs/heads/rw/issue-42"], origin);
			expect(pushed).toBe(headSha);

			// 3. A proposal plan was queued AGAINST THAT BRANCH — not before the push.
			const rows = await db
				.select({
					target: githubPostings.target,
					action: githubPostings.action,
					payload: githubPostings.payload,
				})
				.from(githubPostings)
				.where(eq(githubPostings.kind, "proposal"));
			expect(rows).toHaveLength(1);
			expect(rows[0]?.target).toBe("rw/issue-42");
			expect(rows[0]?.action).toBe("open");
			const plan = JSON.parse(rows[0]?.payload ?? "{}");
			expect(plan.headBranch).toBe("rw/issue-42");
			expect(plan.baseBranch).toBe("main");
			expect(plan.itemNumber).toBe(ITEM);
			expect(plan.draft).toBe(true);
		});
	}, 60_000);

	test("a bundle that does NOT descend from the dispatched base is refused, and nothing is pushed", async () => {
		await withTestDb(async (db) => {
			mkdirSync(join(testTmpBase(), "_scratch"), { recursive: true });
			const root = mkdtempSync(join(testTmpBase(), "_scratch", "proposal-e2e-bad-"));
			const stamp = basename(root).slice("proposal-e2e-bad-".length);
			const share = join(root, "collab");
			const workRoot = join(root, "watcher-work");
			const jobRunnerId = `rw-implement-bad-${stamp}`;
			mkdirSync(root, { recursive: true });

			const { origin, baseSha } = buildFixture(root);
			const railsManifestPath = writeRailsManifest(root);

			// A SECOND, unrelated history. Its commits descend from nothing the watcher
			// dispatched — the case the ancestry proof exists to catch.
			const rogue = join(root, "rogue");
			mkdirSync(rogue, { recursive: true });
			git(["init", "--quiet", "--initial-branch=main"], rogue);
			writeFileSync(join(rogue, "evil.txt"), "not yours\n");
			git(["add", "evil.txt"], rogue);
			git(["commit", "--quiet", "-m", "rogue"], rogue);

			const hostDir = join(share, "runners", "jobs", jobRunnerId, "runner-1");
			mkdirSync(hostDir, { recursive: true });
			git(["bundle", "create", join(hostDir, "change.bundle"), "--all"], rogue);
			writeFileSync(
				join(hostDir, WATCHER_RESULT_NAME),
				JSON.stringify({
					result_version: RESULT_VERSION,
					repository: REPO,
					job_type: "implement-issue",
					item_number: ITEM,
					sha: baseSha,
					status: "passed",
					// A COMPLIANT trail: the implement lane's required-check manifest
					// demands `secrets` and `test` be PRESENT, so a fixture
					// carrying only `lint` is now rejected at gate 0 before any bundle
					// work. Kept complete here so each test still proves the gate its
					// name describes rather than tripping the trail gate first.
					checks: [
						{ name: "lint", status: "pass" },
						{ name: "secrets", status: "pass" },
						{ name: "test", status: "pass" },
					],
					findings: [],
					output_path: `runners/jobs/${jobRunnerId}/runner-1/agent.log`,
					change: { base_sha: baseSha, bundle_path: "change.bundle" },
				}),
			);
			writeFileSync(join(hostDir, "DONE"), "");

			await seedAttempt(db, jobRunnerId, baseSha);

			await runOnce({
				collabRoot: share,
				changeWorkRoot: workRoot,
				loadConfig: async () => ({ ok: true as const, config: config() }),
				resolveGitHubToken: async () => ({ ok: true as const, token: "t" }),
				createDb: () => ({ db, client: { end: async () => {} } }),
				createGitHubClient: () => fakeClient(),
				transport: fakeTransport(),
				railsManifestPath,
				// Point the lane at the local fixture origin instead of github.com, so the
				// base fetch and the push are REAL git against a REAL repository.
				remoteFor: () => origin,
			});

			// NOTHING was written to the origin: no branch, at all.
			expect(git(["for-each-ref", "--format=%(refname)", "refs/heads/rw/"], origin)).toBe("");

			// And no proposal was queued.
			const rows = await db
				.select({ id: githubPostings.id })
				.from(githubPostings)
				.where(eq(githubPostings.kind, "proposal"));
			expect(rows).toHaveLength(0);
		});
	}, 60_000);
});
