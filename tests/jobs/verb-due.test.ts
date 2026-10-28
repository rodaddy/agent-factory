/**
 * @module tests/jobs/verb-due
 * @description sf#300 — a DUE pending verb row is re-evaluated on every pass,
 *   without a forge-cursor event.
 *
 *   THE DEFECT THESE TESTS PIN. Verb rows are deliberately excluded from the
 *   generic pending dispatcher (`dispatch-pass.ts`
 *   `notInArray(jobs.jobType, VERB_IDS)`) because a verb job must be rendered and
 *   routed by the verb-only body/runtime path. The consequence, live on
 *   rtech-infra#795 (2026-08-16): a pending verb row that is DUE had NO
 *   re-dispatcher at all — `dispatchVerbLive` was reached only for issues the
 *   incremental cursor re-surfaced — so SIX manual "nudge" comments were posted
 *   purely to make the cursor see the item again.
 *
 *   MUTATION PROOF (run 2026-08-16, before the driver was trusted). Deleting the
 *   `dueVerbCandidates(...)` call from `verbCandidatesForRepo` in
 *   `src/service-cycle.ts` — i.e. reverting to observed-issues-only — turns
 *   "re-dispatches a due pending verb row with an EMPTY observed set" RED:
 *     `error: expect(received).toBe(expected)  Expected: 1  Received: 0`
 *   with zero runner allocations and the row still `pending`, which is exactly the
 *   live symptom. The other three tests stay green under that mutation, which is
 *   what makes them controls rather than restatements of the same claim.
 */

import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { eq } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import { githubItems, jobs, repositories } from "../../src/db/schema";
import type { ForgeResponse } from "../../src/forge/boundary";
import { VERB_CHANGE_BASE_REPOSITORY } from "../../src/jobs/verb-base";
import { selectDueVerbItems } from "../../src/jobs/verb-due";
import type { BodyLandingStager } from "../../src/prepush/stage";
import type {
	RunnerAllocation,
	RunnerRunParams,
	RunnerTransport,
} from "../../src/runner/transport";
import { type ReconcileCycleDeps, runVerbControlSurfacePass } from "../../src/service-cycle";
import { withTestDb } from "../db/helpers";
import { testTmpBase } from "../support/test-temp";

const REPO_NAME = "rodaddy/x";
const ITEM_NUMBER = 795;
const K3S_HEAD = "c".repeat(40);
const K3S_BRANCH_PATH = "/repos/rtech/k3s-deploy/branches/main";
const ITEM_PATH = `/repos/rodaddy/x/issues/${ITEM_NUMBER}`;
const TARGET_REMOTE = "https://forge.example.internal/rtech/k3s-deploy.git";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

/** The manifest bytes every dispatch in this file binds to. */
const MANIFEST_CONTENT = "rails:\n  - id: safe\n";
const MANIFEST_SHA = createHash("sha256").update(MANIFEST_CONTENT).digest("hex");

async function manifestFixture(): Promise<string> {
	const base = join(testTmpBase(), "_scratch");
	await mkdir(base, { recursive: true });
	const dir = await mkdtemp(join(base, "verb-due-manifest-"));
	const path = join(dir, "rails.yml");
	await writeFile(path, MANIFEST_CONTENT);
	return path;
}

function git(cwd: string, args: readonly string[]): string {
	const out = Bun.spawnSync(["git", ...args], {
		cwd,
		stdout: "pipe",
		stderr: "pipe",
		env: {
			...process.env,
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_CONFIG_SYSTEM: "/dev/null",
			GIT_AUTHOR_NAME: "test",
			GIT_AUTHOR_EMAIL: "test@example.com",
			GIT_COMMITTER_NAME: "test",
			GIT_COMMITTER_EMAIL: "test@example.com",
		},
	});
	if (out.exitCode !== 0) {
		throw new Error(`git ${args.join(" ")} failed: ${out.stderr.toString()}`);
	}
	return out.stdout.toString().trim();
}

async function gitManifestFixture(): Promise<{ path: string; head: string }> {
	const path = await manifestFixture();
	const root = dirname(path);
	git(root, ["init", "--quiet", "--initial-branch=main"]);
	git(root, ["add", "rails.yml"]);
	git(root, ["commit", "--quiet", "-m", "manifest"]);
	return { path, head: git(root, ["rev-parse", "HEAD"]) };
}

async function captureLogs(run: () => Promise<void>): Promise<Record<string, unknown>[]> {
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
		await run();
	} finally {
		(fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
	}
	return raw
		.join("")
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});
}

function config(manifestPath: string): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{
				name: REPO_NAME,
				provider: "github",
				checks: "standard",
				gate_selection: "full",
				verb_dispatch: true,
			},
		],
		job_templates: [{ id: "newapp", runner_size: "small", return_mode: "patch" }],
		doorbell_enabled: false,
		shadow_publish: false,
		railsManifestPath: manifestPath,
		verbEnginePath: "/mnt/share/checkouts/rtech-infra",
		verbK3sCheckoutPath: "/mnt/share/checkouts/k3s-deploy",
	};
}

/**
 * The forge fake, recording every path read.
 *
 * It THROWS on an unscripted path rather than defaulting to a success shape
 * (done-means README rule 11): a permissive fake makes every call sequence pass
 * regardless of what was actually requested — and this file's whole subject is
 * WHICH reads a pass performs.
 */
function forge(labels: string[] = ["deploy:hello"]) {
	const paths: string[] = [];
	const get = async <T>(path: string): Promise<ForgeResponse<T>> => {
		paths.push(path);
		if (path === K3S_BRANCH_PATH) {
			return {
				status: 200,
				data: { commit: { id: K3S_HEAD } } as T,
				link: null,
				rateRemaining: null,
			};
		}
		if (path === ITEM_PATH) {
			return {
				status: 200,
				data: { labels: labels.map((name) => ({ name })) } as T,
				link: null,
				rateRemaining: null,
			};
		}
		throw new Error(`unscripted forge read: ${path}`);
	};
	return { paths, get };
}

function transport(): RunnerTransport & { runs: RunnerRunParams[]; allocations: number } {
	const runs: RunnerRunParams[] = [];
	let allocations = 0;
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
		runs,
		get allocations() {
			return allocations;
		},
		needed: async (): Promise<RunnerAllocation> => {
			allocations++;
			return { ok: true, boxes: [{ vmid: 9001, size: "small" }] };
		},
		run: async (params) => {
			runs.push(params);
		},
		list: async () => [],
		done: async () => {},
	};
}

function landingStager(): BodyLandingStager {
	return {
		land: async (jobId) => {
			const runnerJobBodyPath = `/mnt/share/runners/jobs/${jobId}/input/job.md`;
			return { jobBodyPath: `/share${runnerJobBodyPath}`, runnerJobBodyPath };
		},
	};
}

interface Harness {
	deps: ReconcileCycleDeps;
	runner: ReturnType<typeof transport>;
	forge: ReturnType<typeof forge>;
	errors: unknown[];
}

/**
 * Compose the cycle deps the verb pass actually reaches. Every collaborator the
 * verb path does NOT touch is a throwing stub, so a change that started reaching
 * one would fail loudly here instead of silently passing through a permissive fake.
 */
async function harness(overrides: { labels?: string[] } = {}): Promise<Harness> {
	const manifestPath = await manifestFixture();
	const runner = transport();
	const client = forge(overrides.labels);
	const errors: unknown[] = [];
	const unreached = (name: string) => () => {
		throw new Error(`verb pass must not reach ${name}`);
	};
	const deps = {
		config: config(manifestPath),
		transport: runner,
		bodyLandingStager: landingStager(),
		proposalDeps: {
			remoteFor: (repository: string) =>
				repository === VERB_CHANGE_BASE_REPOSITORY ? TARGET_REMOTE : null,
		},
		registry: { clientFor: async () => ({ ok: true, client }) },
		clientFor: async (repository: string) => (repository === REPO_NAME ? client : null),
		publisher: { run: unreached("publisher") },
		resultReconciler: { run: unreached("resultReconciler") },
		kboardClient: null,
		shadow: false,
		infraGateSelector: unreached("infraGateSelector"),
		onError: (error: unknown) => errors.push(error),
	} as unknown as ReconcileCycleDeps;
	return { deps, runner, forge: client, errors };
}

/** Seed the repository and the verb-labelled issue every test dispatches against. */
async function seedItem(db: TestDb): Promise<{ repositoryId: number; itemId: number }> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: REPO_NAME, provider: "github", checks: "standard" })
		.returning();
	if (repo === undefined) throw new Error("repository seed failed");
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "issue", number: ITEM_NUMBER, state: "open" })
		.returning();
	if (item === undefined) throw new Error("item seed failed");
	return { repositoryId: repo.id, itemId: item.id };
}

/** Insert one pending verb row exactly as `createVerbJob` would have left it. */
async function seedPendingVerb(
	db: TestDb,
	ids: { repositoryId: number; itemId: number },
	overrides: { nextAttemptAt?: Date; jobType?: string; status?: string } = {},
): Promise<number> {
	const [row] = await db
		.insert(jobs)
		.values({
			repositoryId: ids.repositoryId,
			itemId: ids.itemId,
			sha: MANIFEST_SHA,
			jobType: overrides.jobType ?? "newapp",
			status: overrides.status ?? "pending",
			changeBaseRepository: VERB_CHANGE_BASE_REPOSITORY,
			changeBaseSha: K3S_HEAD,
			...(overrides.nextAttemptAt ? { nextAttemptAt: overrides.nextAttemptAt } : {}),
		})
		.returning({ id: jobs.id });
	if (row === undefined) throw new Error("job seed failed");
	return row.id;
}

const NOW = new Date("2026-08-16T06:00:00.000Z");

describe("selectDueVerbItems", () => {
	test("scopes to the provider-qualified repository, never a same-named other provider", async () => {
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			await seedPendingVerb(db, ids);

			expect(await selectDueVerbItems(db, { provider: "github", name: REPO_NAME }, NOW)).toEqual([
				{ itemId: ids.itemId, repositoryId: ids.repositoryId, itemNumber: ITEM_NUMBER },
			]);
			// The SAME repository name on a different provider is a different repository.
			// Keyed on name alone this would return the github row (#the managed-allowlist
			// key shape), and the caller's per-repository verb gate would apply to rows it
			// never selected.
			expect(await selectDueVerbItems(db, { provider: "forgejo", name: REPO_NAME }, NOW)).toEqual(
				[],
			);
		});
	});
});

describe("runVerbControlSurfacePass — due pending verb rows", () => {
	test("re-dispatches a due pending verb row with an EMPTY observed set", async () => {
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			const jobId = await seedPendingVerb(db, ids);
			const h = await harness();

			// NO control-surface event: the cursor re-surfaced nothing this pass. This
			// is the live rtech-infra#795 state that needed six manual nudges.
			await runVerbControlSurfacePass({ ...h.deps, db }, [], NOW);

			expect(h.errors).toEqual([]);
			expect(h.runner.allocations).toBe(1);
			expect(h.runner.runs).toHaveLength(1);
			expect(h.runner.runs[0]?.runtime).toBe("script");
			// The EXISTING row was driven, not a second one created: the identity anchor
			// (`jobs.sha` = the manifest digest) is untouched and no duplicate appeared.
			const rows = await db.select().from(jobs);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.id).toBe(jobId);
			expect(rows[0]?.sha).toBe(MANIFEST_SHA);
			expect(rows[0]?.status).toBe("running");
			// The labels were re-read from the forge — the row does not persist the app.
			expect(h.forge.paths).toContain(ITEM_PATH);
		});
	});

	test("passes railsManifestRefresh=external through the verb dispatch path", async () => {
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			await seedPendingVerb(db, ids);
			const h = await harness();
			const manifest = await gitManifestFixture();

			const logs = await captureLogs(async () => {
				await runVerbControlSurfacePass(
					{
						...h.deps,
						db,
						config: {
							...h.deps.config,
							railsManifestPath: manifest.path,
							railsManifestRefresh: "external",
						},
					},
					[],
					NOW,
				);
			});

			expect(h.errors).toEqual([]);
			expect(h.runner.runs).toHaveLength(1);
			const refresh = logs.find((line) => line.msg === "verb.manifest.refresh_external");
			expect(refresh?.head).toBe(manifest.head);
			expect(refresh?.path).toBe(dirname(manifest.path));
		});
	});

	test("leaves a NOT-YET-DUE row alone: no forge read, no allocation", async () => {
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			// Inside its backoff window — the #210 no-new-churn invariant. A driver that
			// ignored `nextAttemptAt` would re-dispatch a just-failed row every sweep.
			await seedPendingVerb(db, ids, { nextAttemptAt: new Date(NOW.getTime() + 60_000) });
			const h = await harness();

			await runVerbControlSurfacePass({ ...h.deps, db }, [], NOW);

			expect(h.errors).toEqual([]);
			expect(h.runner.allocations).toBe(0);
			// Not even the label read happens: a deferred row is not a candidate at all.
			expect(h.forge.paths).toEqual([]);
			const row = (await db.select().from(jobs).where(eq(jobs.id, 1)))[0];
			expect(row?.status).toBe("pending");
		});
	});

	test("a LIVE job for the item still blocks: a running row is never re-dispatched", async () => {
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			await seedPendingVerb(db, ids, { status: "running" });
			const h = await harness();

			await runVerbControlSurfacePass({ ...h.deps, db }, [], NOW);

			expect(h.errors).toEqual([]);
			expect(h.runner.allocations).toBe(0);
			expect(h.forge.paths).toEqual([]);
			const rows = await db.select().from(jobs);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("running");
		});
	});

	test("NON-VERB pending rows are unaffected: the driver selects verb job types only", async () => {
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			// A due pending `issue-triage` row is the generic dispatcher's work, and it
			// must never be rendered through the verb body/runtime path.
			await seedPendingVerb(db, ids, { jobType: "issue-triage" });
			const h = await harness();

			await runVerbControlSurfacePass({ ...h.deps, db }, [], NOW);

			expect(h.errors).toEqual([]);
			expect(h.runner.allocations).toBe(0);
			expect(h.forge.paths).toEqual([]);
			const rows = await db.select().from(jobs);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.status).toBe("pending");
			expect(rows[0]?.jobType).toBe("issue-triage");
		});
	});

	test("a WITHDRAWN label stops the re-dispatch: intent is re-resolved, never replayed", async () => {
		await withTestDb(async (db) => {
			const ids = await seedItem(db);
			await seedPendingVerb(db, ids);
			// The operator removed `deploy:hello`. The row still exists and is still due,
			// but the request it represents was cancelled — and the row does not persist
			// the app name, so replaying a stored parameter would fire a verb nobody asked
			// for any more.
			const h = await harness({ labels: ["bug"] });

			await runVerbControlSurfacePass({ ...h.deps, db }, [], NOW);

			expect(h.errors).toEqual([]);
			expect(h.runner.allocations).toBe(0);
			expect(h.forge.paths).toEqual([ITEM_PATH]);
			const rows = await db.select().from(jobs);
			expect(rows[0]?.status).toBe("pending");
		});
	});
});
