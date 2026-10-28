/**
 * @module tests/reconcile/build-bump-build
 * @description Hermetic tests for the build-bump Kaniko build pass.
 *   Every cluster call goes through a fake `KubeJobsClient` that RECORDS its
 *   calls, so the assertions are on the call log as much as on the rows: the
 *   adoption case is only meaningful if `createJob` was NOT called, and the
 *   terminal-failure case is only meaningful if a later pass calls nothing.
 *
 *   The clock is injected. The watch-timeout case sets `build_started_at` 2500 s
 *   in the past against a fixed `now`, rather than sleeping.
 */
import { describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { buildBumpCandidates } from "../../src/db/schema";
import type { KubeJob, KubeJobsClient, KubeResult } from "../../src/imagebuild/kube";
import { runBuildBumpBuild } from "../../src/reconcile/build-bump-build";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const SHA = "c".repeat(40);
const NOW = new Date("2026-09-01T12:00:00.000Z");

/** A Job as the API server returns it, with whatever conditions a case needs. */
function job(
	name: string,
	conditions: Array<{ type: string; status: string; reason?: string }> = [],
): KubeJob {
	return {
		metadata: { name, namespace: "image-builds" },
		status: { conditions },
	};
}

/**
 * A recording fake. Every verb THROWS on an unscripted call rather than
 * returning a default, so a pass that reaches a boundary a case did not script
 * fails loudly instead of quietly taking a happy path.
 */
function fakeKube(script: {
	create?: KubeResult<KubeJob>;
	list?: KubeResult<KubeJob[]>;
	get?: KubeResult<KubeJob>;
}) {
	const createCalls: unknown[] = [];
	const listCalls: (string | undefined)[] = [];
	const getCalls: string[] = [];
	const kube: KubeJobsClient = {
		async createJob(body: unknown) {
			createCalls.push(body);
			if (!script.create) throw new Error("unscripted createJob");
			return script.create;
		},
		async listJobs(labelSelector?: string) {
			listCalls.push(labelSelector);
			if (!script.list) throw new Error("unscripted listJobs");
			return script.list;
		},
		async getJob(name: string) {
			getCalls.push(name);
			if (!script.get) throw new Error("unscripted getJob");
			return script.get;
		},
	};
	return { kube, createCalls, listCalls, getCalls };
}

/** Insert one candidate row and return its id. */
async function seed(
	db: TestDb,
	values: {
		repository?: string;
		tag?: string;
		sha?: string;
		status?: string;
		image?: string;
		dockerfile?: string;
		buildJobName?: string | null;
		buildStartedAt?: Date | null;
		buildFinishedAt?: Date | null;
		buildReason?: string | null;
		tagCreatedAt?: Date | null;
	} = {},
): Promise<number> {
	const [row] = await db
		.insert(buildBumpCandidates)
		.values({
			buildFinishedAt: values.buildFinishedAt ?? null,
			buildReason: values.buildReason ?? null,
			tagCreatedAt: values.tagCreatedAt ?? null,
			repository: values.repository ?? "acme/web-bb-landing",
			image: values.image ?? "web-bb-landing",
			dockerfile: values.dockerfile ?? "Dockerfile",
			tag: values.tag ?? "v1.2.3",
			sha: values.sha ?? SHA,
			status: values.status ?? "pending",
			buildJobName: values.buildJobName ?? null,
			buildStartedAt: values.buildStartedAt ?? null,
		})
		.returning({ id: buildBumpCandidates.id });
	if (!row) throw new Error("seed insert returned no row");
	return row.id;
}

/** Read one candidate back by id. */
async function read(db: TestDb, id: number) {
	const rows = await db.select().from(buildBumpCandidates).where(eq(buildBumpCandidates.id, id));
	const row = rows[0];
	if (!row) throw new Error(`no candidate row ${id}`);
	return row;
}

const now = () => NOW;

describe("runBuildBumpBuild", () => {
	test("(a) a pending row with no existing Job creates one and becomes building", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const f = fakeKube({
				list: { ok: true, job: [] },
				create: { ok: true, job: job("build-web-bb-landing-abc12") },
			});

			await runBuildBumpBuild(db, { kube: f.kube, now });

			expect(f.createCalls.length).toBe(1);
			const body = f.createCalls[0] as { kind: string; metadata: { namespace: string } };
			expect(body.kind).toBe("Job");
			expect(body.metadata.namespace).toBe("image-builds");

			const row = await read(db, id);
			expect(row.status).toBe("building");
			expect(row.buildJobName).toBe("build-web-bb-landing-abc12");
			expect(row.buildStartedAt).toBeInstanceOf(Date);
		});
	});

	test("(a2) a per-image candidate builds its own image from its own dockerfile, keyed on the image", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db, {
				repository: "rodaddy/rtech-mcps",
				image: "mcp-gitingest",
				dockerfile: "servers/gitingest/Containerfile",
				tag: "v0.1.0",
			});
			const f = fakeKube({
				list: { ok: true, job: [] },
				create: { ok: true, job: job("build-mcp-gitingest-abc12") },
			});

			await runBuildBumpBuild(db, { kube: f.kube, now });

			// The adoption key is the IMAGE, not the repository short name: the four
			// rtech-mcps images share owner, tag, and sha and must not adopt each
			// other's Jobs.
			expect(f.listCalls[0]).toContain("image-builds.rtech/app=mcp-gitingest");
			expect(f.listCalls[0]).toContain("image-builds.rtech/owner=rodaddy");
			const body = f.createCalls[0] as {
				metadata: { generateName: string };
				spec: { template: { spec: { containers: Array<{ args: string[] }> } } };
			};
			expect(body.metadata.generateName).toBe("build-mcp-gitingest-");
			const args = body.spec.template.spec.containers[0]?.args ?? [];
			expect(args).toContain("--dockerfile=servers/gitingest/Containerfile");
			expect(args).toContain("--destination=10.0.20.58:3000/rtech/mcp-gitingest:v0.1.0");
			expect((await read(db, id)).status).toBe("building");
		});
	});

	test("(b) an existing Job for the app+tag is ADOPTED, never re-created", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const f = fakeKube({ list: { ok: true, job: [job("build-web-bb-landing-existing")] } });

			await runBuildBumpBuild(db, { kube: f.kube, now });

			// The whole point: a lost create response must not produce a second Job.
			expect(f.createCalls.length).toBe(0);
			expect(f.listCalls.length).toBe(1);
			const row = await read(db, id);
			expect(row.status).toBe("building");
			expect(row.buildJobName).toBe("build-web-bb-landing-existing");
		});
	});

	test("(c) a building row whose Job is Complete/True becomes built", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db, {
				status: "building",
				buildJobName: "build-x-1",
				buildStartedAt: new Date(NOW.getTime() - 60_000),
			});
			const f = fakeKube({
				get: { ok: true, job: job("build-x-1", [{ type: "Complete", status: "True" }]) },
			});

			await runBuildBumpBuild(db, { kube: f.kube, now });

			const row = await read(db, id);
			expect(row.status).toBe("built");
			expect(row.buildFinishedAt).toBeInstanceOf(Date);
		});
	});

	test("(d) Failed/True becomes failed with the reason, and a later pass leaves it", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db, {
				status: "building",
				buildJobName: "build-x-1",
				buildStartedAt: new Date(NOW.getTime() - 60_000),
			});
			const f = fakeKube({
				get: {
					ok: true,
					job: job("build-x-1", [
						{ type: "Failed", status: "True", reason: "BackoffLimitExceeded" },
					]),
				},
			});

			await runBuildBumpBuild(db, { kube: f.kube, now });

			const row = await read(db, id);
			expect(row.status).toBe("failed");
			expect(row.buildReason).toBe("BackoffLimitExceeded");
			expect(row.buildFinishedAt).toBeInstanceOf(Date);

			// A failed row is TERMINAL: the second pass must touch no boundary at all.
			const before = f.getCalls.length;
			await runBuildBumpBuild(db, { kube: f.kube, now });
			expect(f.createCalls.length).toBe(0);
			expect(f.getCalls.length).toBe(before);
			expect((await read(db, id)).status).toBe("failed");
		});
	});

	test("(e) a building row whose Job is gone (404) fails with 'job missing'", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db, {
				status: "building",
				buildJobName: "build-x-1",
				buildStartedAt: new Date(NOW.getTime() - 60_000),
			});
			const f = fakeKube({ get: { ok: false, status: 404, reason: "not found" } });

			await runBuildBumpBuild(db, { kube: f.kube, now });

			const row = await read(db, id);
			expect(row.status).toBe("failed");
			expect(row.buildReason).toBe("job missing");
		});
	});

	test("(f) a null kube warns once and changes nothing", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const warnings: string[] = [];

			await runBuildBumpBuild(db, { kube: null, now, onWarn: (m) => warnings.push(m) });

			expect(warnings.length).toBe(1);
			expect(warnings[0]).toContain("no_kubeconfig");
			expect((await read(db, id)).status).toBe("pending");
		});
	});

	test("(g) a network error on createJob leaves the row pending", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const f = fakeKube({
				list: { ok: true, job: [] },
				create: { ok: false, status: 0, reason: "network error" },
			});
			const warnings: string[] = [];

			await runBuildBumpBuild(db, { kube: f.kube, now, onWarn: (m) => warnings.push(m) });

			expect(f.createCalls.length).toBe(1);
			const row = await read(db, id);
			expect(row.status).toBe("pending");
			expect((await db.select().from(buildBumpCandidates)).length).toBe(1);
			expect(warnings.length).toBe(1);
		});
	});

	test("(h) a building row past the watch bound fails with 'watch timeout'", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db, {
				status: "building",
				buildJobName: "build-x-1",
				// 2500 s > activeDeadlineSeconds (1800) + grace (600).
				buildStartedAt: new Date(NOW.getTime() - 2_500_000),
			});
			const f = fakeKube({ get: { ok: true, job: job("build-x-1", []) } });

			await runBuildBumpBuild(db, { kube: f.kube, now });

			const row = await read(db, id);
			expect(row.status).toBe("failed");
			expect(row.buildReason).toBe("watch timeout");
		});
	});

	test("(i) a bad sha fails the row before any cluster call", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db, { sha: "abc1234" });
			const f = fakeKube({});

			await runBuildBumpBuild(db, { kube: f.kube, now });

			expect(f.createCalls.length).toBe(0);
			expect(f.listCalls.length).toBe(0);
			const row = await read(db, id);
			expect(row.status).toBe("failed");
			expect(row.buildReason).toContain("commitSha");
			expect(row.buildFinishedAt).toBeInstanceOf(Date);
		});
	});

	test("(j) at most MAX_BUILDS_PER_PASS candidates are started in one pass", async () => {
		await withTestDb(async (db) => {
			for (let i = 0; i < 7; i += 1) {
				await seed(db, { tag: `v1.0.${i}` });
			}
			const f = fakeKube({
				list: { ok: true, job: [] },
				create: { ok: true, job: job("build-x-1") },
			});

			await runBuildBumpBuild(db, { kube: f.kube, now });

			expect(f.createCalls.length).toBe(5);
		});
	});

	test("(k) a force-moved tag does not adopt the Job that built the old sha", async () => {
		await withTestDb(async (db) => {
			const shaA = "a".repeat(40);
			const shaB = "b".repeat(40);
			const idA = await seed(db, { sha: shaA });
			const idB = await seed(db, { sha: shaB });
			const createCalls: unknown[] = [];
			const listCalls: string[] = [];
			// The Job that built sha A exists; nothing built sha B.
			const kube: KubeJobsClient = {
				async createJob(body: unknown) {
					createCalls.push(body);
					return { ok: true, job: job("build-web-bb-landing-newB") };
				},
				async listJobs(labelSelector?: string) {
					listCalls.push(labelSelector ?? "");
					return {
						ok: true,
						job: (labelSelector ?? "").includes(shaA) ? [job("build-web-bb-landing-oldA")] : [],
					};
				},
				async getJob() {
					throw new Error("unscripted getJob");
				},
			};

			await runBuildBumpBuild(db, { kube, now });

			// Row A adopts its own Job; row B must build, not inherit A's.
			expect(createCalls.length).toBe(1);
			const body = createCalls[0] as { metadata: { labels: Record<string, string> } };
			expect(body.metadata.labels["image-builds.rtech/sha"]).toBe(shaB);

			const rowA = await read(db, idA);
			const rowB = await read(db, idB);
			expect(rowA.status).toBe("building");
			expect(rowB.status).toBe("building");
			expect(rowA.buildJobName).toBe("build-web-bb-landing-oldA");
			expect(rowB.buildJobName).toBe("build-web-bb-landing-newB");
			expect(rowA.buildJobName).not.toBe(rowB.buildJobName);
		});
	});

	test("(l) an image name that is not a DNS label fails the row terminally", async () => {
		await withTestDb(async (db) => {
			// The row's IMAGE is what reaches the Job name and label; the
			// repository short name no longer does.
			const id = await seed(db, { repository: "owner/Web_Landing", image: "Web_Landing" });
			const f = fakeKube({});

			await runBuildBumpBuild(db, { kube: f.kube, now });

			expect(f.createCalls.length).toBe(0);
			expect(f.listCalls.length).toBe(0);
			const row = await read(db, id);
			expect(row.status).toBe("failed");
			expect(row.buildReason).toBeTruthy();
			expect((row.buildReason ?? "").length).toBeLessThan(200);
		});
	});

	test("(m) pending candidates are claimed newest commit date first, NULL last", async () => {
		await withTestDb(async (db) => {
			// The ids ASCEND while the dates DESCEND, and one date is absent. Any
			// pass ordering by id would claim them in exactly the wrong order, which
			// is why row id is never a recency order here.
			const oldest = await seed(db, {
				tag: "v1.0.0",
				sha: "a".repeat(40),
				tagCreatedAt: new Date("2026-01-01T00:00:00.000Z"),
			});
			const newest = await seed(db, {
				tag: "v0.9.0",
				sha: "b".repeat(40),
				tagCreatedAt: new Date("2026-06-01T00:00:00.000Z"),
			});
			const unknown = await seed(db, { tag: "v0.1.0", sha: "d".repeat(40) });
			expect(oldest).toBeLessThan(newest);
			expect(newest).toBeLessThan(unknown);

			const claimed: string[] = [];
			const kube: KubeJobsClient = {
				async createJob(body: unknown) {
					const labels = (body as { metadata: { labels: Record<string, string> } }).metadata.labels;
					claimed.push(labels["image-builds.rtech/tag"] ?? "");
					return { ok: true, job: job(`build-web-bb-landing-${claimed.length}`) };
				},
				async listJobs() {
					return { ok: true, job: [] };
				},
				async getJob() {
					throw new Error("unscripted getJob");
				},
			};

			await runBuildBumpBuild(db, { kube, now });

			// Newest date, then the older date, then the unknown date LAST — "unknown"
			// is never read as "old".
			expect(claimed).toEqual(["v0.9.0", "v1.0.0", "v0.1.0"]);
		});
	});

	test("(n) a re-queued failed row is claimed with every build field reset", async () => {
		await withTestDb(async (db) => {
			// The shape the bump phase produces when a marker environment needs a
			// candidate that failed: status back to `pending`, the LAST attempt's
			// job name, finished-at, and reason still on the row.
			const id = await seed(db, {
				status: "pending",
				buildJobName: "build-web-bb-landing-stale",
				buildStartedAt: new Date("2026-08-01T00:00:00.000Z"),
				buildFinishedAt: new Date("2026-08-01T00:10:00.000Z"),
				buildReason: "BackoffLimitExceeded",
			});
			const f = fakeKube({
				list: { ok: true, job: [] },
				create: { ok: true, job: job("build-web-bb-landing-fresh") },
			});

			await runBuildBumpBuild(db, { kube: f.kube, now });

			const row = await read(db, id);
			expect(row.status).toBe("building");
			expect(row.buildJobName).toBe("build-web-bb-landing-fresh");
			expect(row.buildStartedAt).toEqual(NOW);
			expect(row.buildFinishedAt).toBeNull();
			expect(row.buildReason).toBeNull();
		});
	});
});
