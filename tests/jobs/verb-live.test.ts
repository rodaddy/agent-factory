import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { asc, eq } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import type { ControlSurfaceDecision } from "../../src/control-surface/pass";
import { createPendingJob } from "../../src/db/repos";
import { githubItems, jobs, repositories } from "../../src/db/schema";
import { recordDispatch } from "../../src/forge/actions-store";
import type { VerbDispatchInputs } from "../../src/hooks/verb";
import { dispatchVerbLive, loadVerbManifest } from "../../src/jobs/verb-live";
import { RUNNER_JOB_TRANSPORT_CAP } from "../../src/prepush/body-constants";
import type { BodyLandingStager } from "../../src/prepush/stage";
import { requeueInfraFailedJobs } from "../../src/reconcile/dispatch-pass";
import { createPassBudget } from "../../src/runner/pass-budget";
import { createPassVmids } from "../../src/runner/pass-vmids";
import { scriptRouteViolation } from "../../src/runner/script-route";
import type {
	RunnerAllocation,
	RunnerRunParams,
	RunnerTransport,
} from "../../src/runner/transport";
import { withTestDb } from "../db/helpers";
import { testTmpBase } from "../support/test-temp";

const CONFIG: WatcherConfig = {
	poll_interval_minutes: 15,
	repositories: [
		{
			name: "rodaddy/x",
			provider: "github",
			checks: "standard",
			gate_selection: "full",
			verb_dispatch: true,
		},
	],
	job_templates: [{ id: "newapp", runner_size: "small", return_mode: "patch" }],
	doorbell_enabled: false,
	shadow_publish: false,
	railsManifestPath: "/fixture/rails.yml",
	// sf#301: the two read-only share checkouts the executable body copies from.
	// Both are REQUIRED for a dispatch — absent, the lane skips rather than
	// shipping a body that names a path the box does not have.
	verbEnginePath: "/mnt/share/checkouts/rtech-infra",
	verbK3sCheckoutPath: "/mnt/share/checkouts/k3s-deploy",
};

/** The k3s-deploy head the fake forge reports; the base every change must root on. */
const K3S_HEAD = "c".repeat(40);
const K3S_BRANCH_PATH = "/repos/rtech/k3s-deploy/branches/main";
const TARGET_REMOTE = "https://forge.example.internal/rtech/k3s-deploy.git";

async function writeManifestFixture(bytes: Uint8Array): Promise<string> {
	const base = join(testTmpBase(), "_scratch");
	await mkdir(base, { recursive: true });
	const dir = await mkdtemp(join(base, "verb-manifest-"));
	const path = join(dir, "rails.yml");
	await writeFile(path, bytes);
	return path;
}

/**
 * The bounded READ boundary sf#301 added, as a recording fake.
 *
 * It THROWS on an unscripted path rather than defaulting to a success shape
 * (done-means README rule 11): a permissive fake makes every call sequence pass
 * regardless of what was actually requested.
 */
function forge(overrides: { status?: number; id?: unknown } = {}) {
	const paths: string[] = [];
	return {
		paths,
		get: async <T>(path: string) => {
			paths.push(path);
			if (path !== K3S_BRANCH_PATH) {
				throw new Error(`unscripted forge read: ${path}`);
			}
			return {
				status: overrides.status ?? 200,
				data: { commit: { id: "id" in overrides ? overrides.id : K3S_HEAD } } as T,
				link: null,
				rateRemaining: null,
			};
		},
	};
}

function configuredRepo(): WatcherConfig["repositories"][number] {
	const repo = CONFIG.repositories[0];
	if (repo === undefined) throw new Error("CONFIG fixture must define a repository");
	return repo;
}

const CONFIG_REPO = configuredRepo();

function decision(job: "newapp" | "newapp-down" = "newapp"): ControlSurfaceDecision {
	return {
		repository: "rodaddy/x",
		item: 295,
		observedLabels: ["deploy:demo"],
		column: null,
		columnState: null,
		decision: {
			job,
			label: "deploy:",
			parameter: "demo",
			reason: "label 'deploy:' resolved",
		},
		dryRun: false,
		dispatched: true,
	};
}

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

async function seedVerbItem(db: TestDb): Promise<{ repositoryId: number; itemId: number }> {
	const [repo] = await db
		.insert(repositories)
		.values({ fullName: "rodaddy/x", provider: "github", checks: "standard" })
		.returning();
	if (repo === undefined) throw new Error("repository seed failed");
	const [item] = await db
		.insert(githubItems)
		.values({ repositoryId: repo.id, kind: "issue", number: 295, state: "open" })
		.returning();
	if (item === undefined) throw new Error("item seed failed");
	return { repositoryId: repo.id, itemId: item.id };
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

/**
 * A RECORDING body-landing stager.
 *
 * The verb lane no longer submits its ~28k body inline — mcp2cli caps
 * `params.job` at 10,000 chars and refused it twice on a live box.
 * It lands the full body as the job-scoped `job.md` and
 * submits only a bootstrap, so every dispatching test needs a stager. This fake
 * keeps the exact landed body so a test can assert what the box would read
 * WITHOUT touching a real share.
 */
function landingStager(): BodyLandingStager & { landed: { jobId: string; body: string }[] } {
	const landed: { jobId: string; body: string }[] = [];
	return {
		landed,
		land: async (jobId, body) => {
			landed.push({ jobId, body });
			const runnerJobBodyPath = `/mnt/share/runners/jobs/${jobId}/input/job.md`;
			return { jobBodyPath: `/share${runnerJobBodyPath}`, runnerJobBodyPath };
		},
	};
}

function verbArgs(
	db: TestDb,
	ids: { repositoryId: number; itemId: number },
	runner: RunnerTransport,
	manifestSha: string,
): Parameters<typeof dispatchVerbLive>[0] {
	return {
		db,
		transport: runner,
		config: CONFIG,
		repo: CONFIG_REPO,
		...ids,
		decision: decision(),
		manifest: { content: "rails: []\n", sha256: manifestSha },
		targetRemote: TARGET_REMOTE,
		forge: forge(),
		bodyLandingStager: landingStager(),
	};
}

describe("loadVerbManifest", () => {
	test("loads valid UTF-8 bytes with their exact digest", async () => {
		const content = "rails:\n  - id: safe\n";
		const path = await writeManifestFixture(Buffer.from(content));

		expect(await loadVerbManifest(path)).toEqual({
			ok: true,
			manifest: {
				content,
				sha256: createHash("sha256").update(content).digest("hex"),
			},
		});
	});

	test("returns a bounded refusal for a manifest containing a NUL byte", async () => {
		const path = await writeManifestFixture(
			Buffer.from("rails:\nSF_RAILS_MANIFEST_\0EOF\nprintf 'injected\\n'\n"),
		);

		expect(await loadVerbManifest(path)).toEqual({
			ok: false,
			reason: "manifest contains a NUL byte",
		});
	});
});

describe("dispatchVerbLive", () => {
	/**
	 * sf#304 REPLACES sf#302's containment here, and the replacement is the whole
	 * ticket: this test used to assert `skipped: "verb job body could not be
	 * rendered"` for a down verb, because `renderVerbScriptBody` returned `null`
	 * for all three. That refusal was correct while the prune body did not exist
	 * and became the defect once it did — `spindown:<app>` is documented
	 * DISPATCHABLE (`_DOCS/control-surface.md`, `control-surface/vocabulary.ts`)
	 * and a null body turns it into a silent dispatch skip the operator never sees.
	 *
	 * What the down body CONTAINS is pinned in `tests/jobs/verb-body.test.ts`; what
	 * this boundary owes is that a down verb reaches the runner at all, on the same
	 * agentless script route and with its own verb id bound into the body.
	 */
	test("dispatches a down verb on the same agentless script route as an up verb", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const runner = transport();
			const stager = landingStager();
			const outcome = await dispatchVerbLive({
				db,
				transport: runner,
				config: {
					...CONFIG,
					job_templates: [{ id: "newapp-down", runner_size: "small", return_mode: "patch" }],
				},
				repo: CONFIG_REPO,
				...ids,
				decision: decision("newapp-down"),
				manifest: { content: "rails: []\n", sha256: "e".repeat(64) },
				targetRemote: TARGET_REMOTE,
				forge: forge(),
				bodyLandingStager: stager,
			});
			expect(outcome.status).toBe("dispatched");
			expect(runner.allocations).toBe(1);
			const submitted = runner.runs[0];
			expect(submitted?.runtime).toBe("script");
			// A script runtime carrying a model or effort is refused before the first
			// invoke and costs an allocated box every dispatch — so the down
			// route is proven agentless by the real guard, not by re-asserting inputs.
			expect(scriptRouteViolation(submitted ?? {})).toBeNull();
			// The body is the DOWN body: its own verb id, and the git-tracked removal.
			const body = stager.landed[0]?.body ?? submitted?.job ?? "";
			expect(body).toContain("verb=newapp-down");
			expect(body).toContain("rm -r --quiet --ignore-unmatch");
			const persisted = await db.select().from(jobs);
			expect(persisted).toHaveLength(1);
			expect(persisted[0]?.jobType).toBe("newapp-down");
		});
	});

	test("persists and submits one allowlisted runtime=script verb job with bound inputs", async () => {
		await withTestDb(async (db) => {
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", provider: "github", checks: "standard" })
				.returning();
			if (repo === undefined) throw new Error("repository seed failed");
			const [item] = await db
				.insert(githubItems)
				.values({ repositoryId: repo.id, kind: "issue", number: 295, state: "open" })
				.returning();
			if (item === undefined) throw new Error("item seed failed");

			const runner = transport();
			// THE REAL MANIFEST from the failing live run. It is
			// the reason the rendered body is ~28k rather than the ~6k a toy two-line
			// manifest produces — and 6k is UNDER the mcp2cli cap, so a toy manifest
			// would let a staging bypass pass this test while the live dispatch still
			// died. The fixture is what makes the cap assertion below load-bearing.
			const manifestContent = await readFile(
				join(import.meta.dir, "..", "fixtures", "verb", "rails-manifest-r4.yml"),
				"utf8",
			);
			const manifest = {
				content: manifestContent,
				sha256: createHash("sha256").update(manifestContent).digest("hex"),
			};
			const targetForge = forge();
			const stager = landingStager();
			const args = {
				db,
				transport: runner,
				config: CONFIG,
				repo: CONFIG_REPO,
				repositoryId: repo.id,
				itemId: item.id,
				decision: decision(),
				manifest,
				targetRemote: TARGET_REMOTE,
				forge: targetForge,
				bodyLandingStager: stager,
			};

			const outcome = await dispatchVerbLive(args);
			expect(outcome.status).toBe("dispatched");
			expect(targetForge.paths).toEqual([K3S_BRANCH_PATH]);
			expect(runner.allocations).toBe(1);
			expect(runner.runs).toHaveLength(1);
			const submitted = runner.runs[0];
			expect(submitted?.runtime).toBe("script");

			// sf#306 THE CLAIM, asserted FIRST so a staging bypass goes red on the thing
			// that actually failed live: what crosses mcp2cli must be under the inline
			// cap. Asserting the landing first would mask this with a bookkeeping
			// failure and never name the 10,000-char refusal at all.
			expect(submitted?.job.length).toBeLessThan(RUNNER_JOB_TRANSPORT_CAP);

			// The CONTRACT is landed on the share; only a bootstrap goes inline.
			expect(stager.landed).toHaveLength(1);
			const staged = stager.landed[0];
			// And the landed body is genuinely OVER the cap, so the assertion above is
			// not vacuously true: this is a body the inline path could not have sent.
			expect((staged?.body.length ?? 0) > RUNNER_JOB_TRANSPORT_CAP).toBe(true);
			expect(staged?.jobId).toBe(submitted?.jobId);
			expect(staged?.body).toContain("verb=newapp");
			expect(staged?.body).toContain("item_number=295");
			expect(staged?.body).toContain("app=demo");
			expect(staged?.body).toContain(manifest.content.trimEnd());
			// sf#301: the body is EXECUTABLE shell, not the old prose instruction list.
			expect(staged?.body).toContain("#!/usr/bin/env bash");
			expect(staged?.body).not.toContain("Run the fixed");
			// The manifest rides as quoted-heredoc DATA, never as raw script lines.
			expect(staged?.body).toMatch(/<<\s*'[A-Z0-9_]+'/);

			// The bootstrap is executable bash pointing at the staged file, carrying the
			// digest of exactly those bytes.
			expect(submitted?.job).toContain(`/mnt/share/runners/jobs/${submitted?.jobId}/input/job.md`);
			expect(submitted?.job).toContain(
				`expected_sha256=${createHash("sha256")
					.update(staged?.body ?? "", "utf8")
					.digest("hex")}`,
			);
			// The agentless route SURVIVES staging, proven by running the real guard
			// over the real submitted params rather than by re-asserting its inputs. A
			// script runtime carrying a model or effort is refused by
			// `scriptRouteViolation` before the first invoke — so a route that drifted
			// during staging would cost an allocated box on every dispatch.
			expect(scriptRouteViolation(submitted ?? {})).toBeNull();
			// sf#301: the k3s base rides in its OWN columns; `sha` stays the manifest
			// digest so createPendingJob's (repo,item,sha,type) dedup key is unchanged.
			const row = (await db.select().from(jobs))[0];
			expect(row?.status).toBe("running");
			expect(row?.sha).toBe(manifest.sha256);
			expect(row?.changeBaseRepository).toBe("rtech/k3s-deploy");
			expect(row?.changeBaseSha).toBe(K3S_HEAD);

			const duplicate = await dispatchVerbLive(args);
			expect(duplicate).toMatchObject({ status: "skipped" });
			expect(runner.allocations).toBe(1);
			expect(runner.runs).toHaveLength(1);
		});
	});

	test("re-dispatches a re-pended verb only after its stored backoff is due", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const due = new Date("2026-08-16T10:15:00.000Z");
			const [job] = await db
				.insert(jobs)
				.values({
					...ids,
					sha: "a".repeat(64),
					jobType: "newapp",
					status: "pending",
					nextAttemptAt: due,
					changeBaseRepository: "rtech/k3s-deploy",
					changeBaseSha: K3S_HEAD,
				})
				.returning();
			if (job === undefined) throw new Error("job seed failed");
			const runner = transport();
			const baseArgs = {
				db,
				transport: runner,
				config: CONFIG,
				repo: CONFIG_REPO,
				...ids,
				decision: decision(),
				manifest: { content: "rails: []\n", sha256: "a".repeat(64) },
				targetRemote: TARGET_REMOTE,
				bodyLandingStager: landingStager(),
				forge: forge(),
			};

			expect(
				await dispatchVerbLive({ ...baseArgs, now: new Date("2026-08-16T10:00:00.000Z") }),
			).toEqual({ status: "skipped", reason: "pending verb job is not due" });
			expect(runner.runs).toHaveLength(0);
			expect((await dispatchVerbLive({ ...baseArgs, now: due })).status).toBe("dispatched");
			expect(runner.runs[0]?.runtime).toBe("script");
			expect(runner.runs[0]?.job).not.toContain("Run the fixed");
			const [row] = await db.select().from(jobs).where(eq(jobs.id, job.id));
			expect(row?.status).toBe("running");
		});
	});

	test("terminalizes a pre-migration pending row and dispatches a fresh based row", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const manifestSha = "a".repeat(64);
			const [legacy] = await db
				.insert(jobs)
				.values({ ...ids, sha: manifestSha, jobType: "newapp", status: "pending" })
				.returning();
			if (legacy === undefined) throw new Error("legacy job seed failed");
			const runner = transport();

			const outcome = await dispatchVerbLive(verbArgs(db, ids, runner, manifestSha));

			expect(outcome.status).toBe("dispatched");
			expect(runner.runs).toHaveLength(1);
			const rows = await db.select().from(jobs).orderBy(asc(jobs.id));
			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({
				id: legacy.id,
				status: "failed",
				terminalReason: "missing change base (pre-migration)",
			});
			expect(rows[1]).toMatchObject({
				sha: manifestSha,
				status: "running",
				changeBaseRepository: "rtech/k3s-deploy",
				changeBaseSha: K3S_HEAD,
			});
			const requeue = await requeueInfraFailedJobs(db, new Date("2026-08-16T12:00:00.000Z"));
			expect(requeue.requeued).toBe(0);
			const [terminalized] = await db.select().from(jobs).where(eq(jobs.id, legacy.id));
			expect(terminalized?.status).toBe("failed");
		});
	});

	test("terminalizes a stale-manifest pending row and dispatches the current manifest", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const staleSha = "a".repeat(64);
			const currentSha = "b".repeat(64);
			const [stale] = await db
				.insert(jobs)
				.values({
					...ids,
					sha: staleSha,
					jobType: "newapp",
					status: "pending",
					changeBaseRepository: "rtech/k3s-deploy",
					changeBaseSha: K3S_HEAD,
				})
				.returning();
			if (stale === undefined) throw new Error("stale job seed failed");
			const runner = transport();

			const outcome = await dispatchVerbLive(verbArgs(db, ids, runner, currentSha));

			expect(outcome.status).toBe("dispatched");
			const rows = await db.select().from(jobs).orderBy(asc(jobs.id));
			expect(rows).toHaveLength(2);
			expect(rows[0]).toMatchObject({ id: stale.id, sha: staleSha, status: "failed" });
			expect(rows[1]).toMatchObject({ sha: currentSha, status: "running" });
		});
	});

	test("treats a completed tuple conflict as one skipped outcome per sweep", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const manifestSha = "a".repeat(64);
			await db.insert(jobs).values({
				...ids,
				sha: manifestSha,
				jobType: "newapp",
				status: "completed",
				changeBaseRepository: "rtech/k3s-deploy",
				changeBaseSha: K3S_HEAD,
			});
			const runner = transport();
			const args = verbArgs(db, ids, runner, manifestSha);

			const first = await dispatchVerbLive(args);
			const second = await dispatchVerbLive(args);

			expect(first).toEqual({
				status: "skipped",
				reason: "verb already completed for this manifest",
			});
			expect(second).toEqual(first);
			expect(runner.allocations).toBe(0);
			expect(await db.select().from(jobs)).toHaveLength(1);
		});
	});

	// R9-F-B, THE HONESTY DEFECT. A FAILED row holding the manifest tuple made
	// `createPendingJob` conflict, and the outcome then reported "verb already
	// completed for this manifest" — naming SUCCESS for a run that failed. An
	// operator reading that believes the change landed. The fix is to name the
	// REAL terminal state; it is deliberately NOT a re-run (deferred to sf#305,
	// `_DOCS/decisions-ledger.md` L-017).
	test("names a FAILED tuple conflict by its real state, never 'completed'", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const manifestSha = "b".repeat(64);
			const [stale] = await db
				.insert(jobs)
				.values({
					...ids,
					sha: manifestSha,
					jobType: "newapp",
					status: "failed",
					terminalReason: "runner exploded",
					changeBaseRepository: "rtech/k3s-deploy",
					changeBaseSha: K3S_HEAD,
				})
				.returning({ id: jobs.id });
			const runner = transport();
			const args = verbArgs(db, ids, runner, manifestSha);

			const outcome = await dispatchVerbLive(args);

			expect(outcome).toEqual({
				status: "skipped",
				reason: "verb job for this manifest is terminal (failed)",
			});
			// Reading the reason through the narrowed union keeps the assertion
			// honest: a `dispatched` outcome carries no reason field at all.
			const reason = outcome.status === "dispatched" ? "" : outcome.reason;
			expect(reason).not.toContain("already completed");
			expect(runner.allocations).toBe(0);

			// NOTHING MOVED. The failed row keeps its status, its terminal reason,
			// and — critically — its `jobs.sha` identity anchor, and no second row
			// was created. `origin/main` stopped here too; this PR only changes what
			// the outcome SAYS.
			const rows = await db.select().from(jobs).orderBy(jobs.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({
				id: stale?.id,
				sha: manifestSha,
				status: "failed",
				terminalReason: "runner exploded",
			});
		});
	});

	// The honest-labeling rule is keyed on SUCCEEDED_JOB_STATUSES, not on a
	// hardcoded `failed`, so every other terminal status names itself too.
	test("names a cancelled tuple by its real state, never 'completed'", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const manifestSha = "c".repeat(64);
			await db.insert(jobs).values({
				...ids,
				sha: manifestSha,
				jobType: "newapp",
				status: "cancelled",
				changeBaseRepository: "rtech/k3s-deploy",
				changeBaseSha: K3S_HEAD,
			});
			const runner = transport();
			const outcome = await dispatchVerbLive(verbArgs(db, ids, runner, manifestSha));

			expect(outcome).toEqual({
				status: "skipped",
				reason: "verb job for this manifest is terminal (cancelled)",
			});
			const reason = outcome.status === "dispatched" ? "" : outcome.reason;
			expect(reason).not.toContain("already completed");
			expect(runner.allocations).toBe(0);
			// The terminal row is untouched and no re-queue happened.
			const rows = await db.select().from(jobs).orderBy(jobs.id);
			expect(rows).toHaveLength(1);
			expect(rows[0]).toMatchObject({ sha: manifestSha, status: "cancelled" });
		});
	});

	// sf#306: staging is the ONLY way a verb body reaches a box. Without a stager
	// the lane must SKIP, never fall back to the inline submission mcp2cli refuses
	// — a fallback would reproduce the live failure exactly: box allocated,
	// `runner_run` exit 1 in under a second, watcher reaps.
	test("skips without a body-landing stager rather than submitting inline", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const runner = transport();
			const { bodyLandingStager: _omitted, ...withoutStager } = verbArgs(
				db,
				ids,
				runner,
				"a".repeat(64),
			);

			const outcome = await dispatchVerbLive(withoutStager);

			expect(outcome).toEqual({
				status: "skipped",
				reason: "verb dispatch requires a body-landing stager",
			});
			// No box was allocated and nothing was submitted: the refusal is BEFORE the
			// allocation, which is where the live failure was not.
			expect(runner.allocations).toBe(0);
			expect(runner.runs).toHaveLength(0);
		});
	});

	test("verb_runtime: actions hands the verb to verb.yml and places no box", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const runner = transport();
			const calls: unknown[] = [];
			const args = verbArgs(db, ids, runner, "e".repeat(64));
			const outcome = await dispatchVerbLive({
				...args,
				repo: { ...CONFIG_REPO, verb_runtime: "actions" },
				verbDispatch: async (inputs) => {
					calls.push(inputs);
					return true;
				},
			});
			expect(calls).toEqual([
				{
					verb: "newapp",
					repo: "rodaddy/x",
					item: 295,
					app: "demo",
					manifestSha: "e".repeat(64),
					baseSha: K3S_HEAD,
				},
			]);
			expect(outcome).toEqual({
				status: "skipped",
				reason: "dispatched: verb handed to Forgejo Actions (verb.yml)",
				provenNoBox: true,
			});
			expect(runner.allocations).toBe(0);
			expect(await db.select().from(jobs)).toHaveLength(0);
		});
	});

	test("verb_runtime: actions dispatches once per (item, verb, manifest): a re-surface skips", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const runner = transport();
			let calls = 0;
			// The fake records exactly as the real hook's record seam does.
			const verbDispatch = async (inputs: VerbDispatchInputs) => {
				calls++;
				await recordDispatch(db, {
					repo: "rodaddy/software-factory",
					workflow: "verb.yml",
					runId: null,
					targetSha: inputs.baseSha,
					inputs: {
						verb: inputs.verb,
						repo: inputs.repo,
						item: String(inputs.item),
						app: inputs.app,
						manifest_sha: inputs.manifestSha,
						base_sha: inputs.baseSha,
						log_level: "info",
					},
				});
				return true;
			};
			const args = {
				...verbArgs(db, ids, runner, "e".repeat(64)),
				repo: { ...CONFIG_REPO, verb_runtime: "actions" as const },
				verbDispatch,
			};
			await dispatchVerbLive(args);
			const second = await dispatchVerbLive({ ...args, forge: forge() });
			expect(calls).toBe(1);
			expect(second).toEqual({
				status: "skipped",
				reason: "verb already dispatched to Actions for this manifest",
				provenNoBox: true,
			});
		});
	});

	test("verb_runtime: actions with a pending box verb row skips and dispatches nothing", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			await createPendingJob(db, {
				repositoryId: ids.repositoryId,
				itemId: ids.itemId,
				sha: "e".repeat(64),
				jobType: "newapp",
				changeBaseRepository: "rtech/k3s-deploy",
				changeBaseSha: K3S_HEAD,
			});
			const runner = transport();
			let calls = 0;
			const outcome = await dispatchVerbLive({
				...verbArgs(db, ids, runner, "e".repeat(64)),
				repo: { ...CONFIG_REPO, verb_runtime: "actions" },
				verbDispatch: async () => {
					calls++;
					return true;
				},
			});
			expect(calls).toBe(0);
			expect(outcome).toEqual({
				status: "skipped",
				reason: "box verb row still live; flip waits",
				provenNoBox: true,
			});
			expect(runner.allocations).toBe(0);
		});
	});

	test("verb_runtime: actions without a wired dispatcher skips and places no box", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const runner = transport();
			const outcome = await dispatchVerbLive({
				...verbArgs(db, ids, runner, "e".repeat(64)),
				repo: { ...CONFIG_REPO, verb_runtime: "actions" },
			});
			expect(outcome).toEqual({
				status: "skipped",
				reason: "verb actions dispatcher is not wired",
				provenNoBox: true,
			});
			expect(runner.allocations).toBe(0);
		});
	});

	test("verb_runtime: box (and absent) keeps the box path and never calls the dispatcher", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const runner = transport();
			let called = 0;
			const outcome = await dispatchVerbLive({
				...verbArgs(db, ids, runner, "e".repeat(64)),
				repo: { ...CONFIG_REPO, verb_runtime: "box" },
				verbDispatch: async () => {
					called++;
					return true;
				},
			});
			expect(outcome.status).toBe("dispatched");
			expect(called).toBe(0);
			expect(runner.allocations).toBe(1);
		});
	});

	test("rejects a non-verb decision before allocation", async () => {
		await withTestDb(async (db) => {
			const runner = transport();
			const nonVerb = {
				...decision(),
				decision: {
					job: "issue-triage" as const,
					label: "factory-triage",
					parameter: null,
					reason: "resolved",
				},
			};
			const outcome = await dispatchVerbLive({
				db,
				transport: runner,
				config: CONFIG,
				repo: CONFIG_REPO,
				repositoryId: 1,
				itemId: 1,
				decision: nonVerb,
				manifest: { content: "constraints: []\n", sha256: "b".repeat(64) },
				targetRemote: TARGET_REMOTE,
				forge: forge(),
			});
			expect(outcome).toEqual({ status: "skipped", reason: "decision is not a verb job" });
			expect(runner.allocations).toBe(0);
		});
	});

	/**
	 * sf#301 preconditions. Each one must SKIP BEFORE persisting: a job created
	 * without a usable base or a renderable body would hold the manifest's dedup
	 * key while being permanently unverifiable, and the eventual rejection would
	 * read as a runner defect rather than a missing watcher precondition.
	 */
	describe("fails closed before persisting anything", () => {
		const seed = async (db: Parameters<typeof dispatchVerbLive>[0]["db"]) => {
			const [repo] = await db
				.insert(repositories)
				.values({ fullName: "rodaddy/x", provider: "github", checks: "standard" })
				.returning();
			if (repo === undefined) throw new Error("repository seed failed");
			const [item] = await db
				.insert(githubItems)
				.values({ repositoryId: repo.id, kind: "issue", number: 295, state: "open" })
				.returning();
			if (item === undefined) throw new Error("item seed failed");
			return { repositoryId: repo.id, itemId: item.id };
		};

		test.each([
			[
				"the Forgejo deployment is unavailable",
				{ targetRemote: null },
				"verb target remote unresolvable: no forgejo deployment",
			],
			[
				"the forge read is unavailable",
				{ forge: undefined },
				"k3s-deploy base sha could not be resolved",
			],
			[
				"the forge answers non-2xx",
				{ forge: forge({ status: 404 }) },
				"k3s-deploy base sha could not be resolved",
			],
			[
				"the forge returns an abbreviated sha",
				{ forge: forge({ id: "abc1234" }) },
				"k3s-deploy base sha could not be resolved",
			],
			[
				"the share checkout paths are unconfigured",
				{ config: { ...CONFIG, verbK3sCheckoutPath: undefined }, forge: forge() },
				"verb share checkout paths are not configured",
			],
		])("skips when %s, creating no job", async (_label, override, reason) => {
			await withTestDb(async (db) => {
				const ids = await seed(db);
				const runner = transport();
				const outcome = await dispatchVerbLive({
					db,
					transport: runner,
					config: CONFIG,
					repo: CONFIG_REPO,
					...ids,
					decision: decision(),
					manifest: { content: "rails: []\n", sha256: "d".repeat(64) },
					targetRemote: TARGET_REMOTE,
					...(override as Record<string, unknown>),
				} as Parameters<typeof dispatchVerbLive>[0]);
				expect(outcome).toEqual({ status: "skipped", reason });
				expect(runner.allocations).toBe(0);
				// The load-bearing assertion: NOTHING was persisted, so the manifest's
				// dedup key is still free for a retry once the precondition holds.
				expect(await db.select().from(jobs)).toHaveLength(0);
			});
		});
	});
});

describe("the sweep's dispatch budget bounds this lane too", () => {
	test("a same-pass vmid refusal refunds the slot it reserved", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const runner = transport();
			// A sibling dispatch already holds 9001 this pass, so the box the gateway
			// re-reports is refused and NO box is placed for this row.
			const passVmids = createPassVmids();
			expect(passVmids.take(9001)).toBe(true);
			const passBudget = createPassBudget(1);
			const outcome = await dispatchVerbLive({
				db,
				transport: runner,
				config: CONFIG,
				repo: CONFIG_REPO,
				...ids,
				decision: decision("newapp"),
				manifest: { content: "rails: []\n", sha256: "f".repeat(64) },
				targetRemote: TARGET_REMOTE,
				forge: forge(),
				bodyLandingStager: landingStager(),
				passVmids,
				passBudget,
			});
			expect(outcome.status).not.toBe("dispatched");
			expect(runner.runs).toHaveLength(0);
			// The slot goes back to the sweep for the generic pass to spend.
			expect(passBudget.remaining()).toBe(1);
		});
	});

	test("a submit failure after the box was placed KEEPS the slot", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const runner = transport();
			// The gateway allocated the box; the submit then failed. The box was
			// placed against the cap whatever the row's status says.
			runner.run = async () => {
				throw new Error("submit failed");
			};
			const passBudget = createPassBudget(1);
			const outcome = await dispatchVerbLive({
				db,
				transport: runner,
				config: CONFIG,
				repo: CONFIG_REPO,
				...ids,
				decision: decision("newapp"),
				manifest: { content: "rails: []\n", sha256: "d".repeat(64) },
				targetRemote: TARGET_REMOTE,
				forge: forge(),
				bodyLandingStager: landingStager(),
				passBudget,
			});
			expect(outcome.status).toBe("error");
			expect(runner.allocations).toBe(1);
			expect(passBudget.remaining()).toBe(0);
		});
	});

	test("a dispatch that THROWS keeps the slot it reserved", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const runner = transport();
			// The ledger faults inside the dispatch, after the slot was reserved: a
			// throw cannot prove no box was placed, so the reservation stays.
			const faulting = createPassVmids();
			faulting.take = () => {
				throw new Error("ledger fault");
			};
			const passBudget = createPassBudget(1);
			await expect(
				dispatchVerbLive({
					db,
					transport: runner,
					config: CONFIG,
					repo: CONFIG_REPO,
					...ids,
					decision: decision("newapp"),
					manifest: { content: "rails: []\n", sha256: "e".repeat(64) },
					targetRemote: TARGET_REMOTE,
					forge: forge(),
					bodyLandingStager: landingStager(),
					passVmids: faulting,
					passBudget,
				}),
			).rejects.toThrow("ledger fault");
			expect(passBudget.remaining()).toBe(0);
		});
	});

	test("an exhausted budget persists the row but places no box", async () => {
		await withTestDb(async (db) => {
			const ids = await seedVerbItem(db);
			const runner = transport();
			const outcome = await dispatchVerbLive({
				db,
				transport: runner,
				config: CONFIG,
				repo: CONFIG_REPO,
				...ids,
				decision: decision("newapp"),
				manifest: { content: "rails: []\n", sha256: "f".repeat(64) },
				targetRemote: TARGET_REMOTE,
				forge: forge(),
				bodyLandingStager: landingStager(),
				passBudget: createPassBudget(0),
			});
			expect(outcome.status).toBe("skipped");
			expect("reason" in outcome ? outcome.reason : "").toContain("budget");
			expect(runner.allocations).toBe(0);
			// The row exists and is due again next pass; nothing was lost.
			const persisted = await db.select().from(jobs);
			expect(persisted).toHaveLength(1);
			expect(persisted[0]?.status).toBe("pending");
		});
	});
});
