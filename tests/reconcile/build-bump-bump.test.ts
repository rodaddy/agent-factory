/**
 * @module tests/reconcile/build-bump-bump
 * @description Hermetic tests for the build-bump BUMP pass, as the pass now is:
 *   RECONCILE DESIRED STATE PER ENVIRONMENT (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md`
 *   §6). The invoke seam is a RECORDING fake that THROWS on an unscripted call,
 *   so every case asserts on the call log as much as on the rows: "this pass
 *   invoked nothing" is a real assertion, not an absence of evidence.
 *
 *   The words "uat" and "prod" appear here as CONFIGURATION and nowhere else —
 *   that is the whole point of the environment model, and a test that can name
 *   them while the module cannot is the proof.
 */
import { describe, expect, test } from "bun:test";
import { and, asc, eq } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import { buildBumpBumps, buildBumpCandidates, buildBumpMarkers } from "../../src/db/schema";
import type { BumpInput, BumpOutcome } from "../../src/imagebuild/bump";
import {
	type BuildBumpBumpDeps,
	claimPairAttempt,
	runBuildBumpBump,
} from "../../src/reconcile/build-bump-bump";
import { reopenSuperseded } from "../../src/reconcile/build-bump-bump-pairs";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const SHA = "d".repeat(40);
const OLD_SHA = "c".repeat(40);
const REPO = "acme/web-bb-landing";
const IMAGE = "web-bb-landing";
const NOW = new Date("2026-09-01T12:00:00.000Z");
const SCRIPT = "/opt/factory/open-bump-pr.sh";
const WORKROOT = "/var/lib/watcher/build-bump";

/** A config enrolling REPO with the given ordered environment list. */
function config(
	environments: Array<{ name: string; app_dirs: string[] }> = [
		{ name: "live", app_dirs: ["landing"] },
	],
): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{
				name: REPO,
				provider: "forgejo",
				checks: "static-only",
				gate_selection: "full",
				build_bump: { environments, tag_pattern: "v*" },
			},
		],
		job_templates: [],
		doorbell_enabled: false,
		shadow_publish: false,
	} as unknown as WatcherConfig;
}

/** The two-level shape: a version-tag stream, and a movable tag named after itself. */
function twoEnvironments(): WatcherConfig {
	return config([
		{ name: "uat", app_dirs: ["landing-uat"] },
		{ name: "prod", app_dirs: ["landing"] },
	]);
}

/** A config with no repositories at all — nothing is enrolled. */
function emptyConfig(): WatcherConfig {
	return { ...config(), repositories: [] } as WatcherConfig;
}

/**
 * BUILD-ONLY: enrolled with NEITHER `environments` nor `images`, because the
 * repository owns no app directory at all. Its tags build and push an image that
 * another repository consumes by pin, so no manifest is ever bumped for it.
 * Enrolment is the PRESENCE of the block: intake gates on that plus provider plus
 * a tag match, and reads no list.
 */
function buildOnlyConfig(): WatcherConfig {
	return {
		...config(),
		repositories: [
			{
				name: REPO,
				provider: "forgejo",
				checks: "static-only",
				gate_selection: "full",
				build_bump: { tag_pattern: "v*" },
			},
		],
	} as unknown as WatcherConfig;
}

/**
 * rtech-mcps' shape: several images from one tag, each with its own environments.
 * `mcp-unifi` declares none — its image is consumed by pin.
 */
function imagesConfig(): WatcherConfig {
	return {
		...config(),
		repositories: [
			{
				name: REPO,
				provider: "forgejo",
				checks: "static-only",
				gate_selection: "full",
				build_bump: {
					images: [
						{
							name: "mcp-gitingest",
							dockerfile: "servers/gitingest/Containerfile",
							environments: [{ name: "live", app_dirs: ["mcp-gitingest"] }],
						},
						{ name: "mcp-unifi", dockerfile: "unifi-network-mcp/Containerfile" },
					],
					tag_pattern: "v*",
				},
			},
		],
	} as unknown as WatcherConfig;
}

/**
 * A recording invoke fake. Outcomes are consumed in order; an unscripted call
 * THROWS rather than taking a happy default, which is what makes "this pass
 * invoked nothing" a real assertion.
 */
function fakeBump(outcomes: BumpOutcome[]) {
	const calls: BumpInput[] = [];
	const bump = async (input: BumpInput): Promise<BumpOutcome> => {
		calls.push(input);
		const next = outcomes.shift();
		if (!next) throw new Error("unscripted bump invocation");
		return next;
	};
	return { bump, calls };
}

/** Insert one candidate row and return its id. */
async function seed(
	db: TestDb,
	values: {
		repository?: string;
		status?: string;
		tag?: string;
		image?: string;
		sha?: string;
		tagCreatedAt?: Date;
		buildJobName?: string | null;
	} = {},
): Promise<number> {
	const [row] = await db
		.insert(buildBumpCandidates)
		.values({
			repository: values.repository ?? REPO,
			image: values.image ?? IMAGE,
			tag: values.tag ?? "v1.2.3",
			sha: values.sha ?? SHA,
			status: values.status ?? "built",
			tagCreatedAt: values.tagCreatedAt ?? null,
			buildJobName: values.buildJobName ?? "build-web-bb-landing-abc12",
		})
		.returning({ id: buildBumpCandidates.id });
	if (!row) throw new Error("seed insert returned no row");
	return row.id;
}

/** Point a movable tag at a commit. */
async function seedMarker(db: TestDb, marker: string, sha: string): Promise<void> {
	await db.insert(buildBumpMarkers).values({ repository: REPO, marker, sha });
}

/** Read every bump row for a candidate, ordered by insert order. */
async function rows(db: TestDb, candidateId: number) {
	return await db
		.select()
		.from(buildBumpBumps)
		.where(eq(buildBumpBumps.candidateId, candidateId))
		.orderBy(asc(buildBumpBumps.id));
}

const opened = (pr: number): BumpOutcome => ({
	kind: "opened",
	pr,
	url: `https://forge.example.internal/rtech/k3s-deploy/pulls/${pr}`,
	repository: "rtech/k3s-deploy",
	branch: `bump/${pr}`,
	app: "landing",
	oldTag: "v1.2.2",
	newTag: "v1.2.3",
});

/** The base deps every case starts from. */
function deps(
	bump: BuildBumpBumpDeps["bump"],
	extra: Partial<BuildBumpBumpDeps> = {},
): BuildBumpBumpDeps {
	return {
		bump,
		scriptPath: SCRIPT,
		workdirRoot: WORKROOT,
		now: () => NOW,
		...extra,
	};
}

describe("runBuildBumpBump — one environment", () => {
	test("(1) the newest built candidate opens a PR on the one dir, target `live`, no allowOlder", async () => {
		await withTestDb(async (db) => {
			await seed(db, { tag: "v1.0.0", tagCreatedAt: new Date("2026-08-01T00:00:00Z") });
			const newest = await seed(db, {
				tag: "v1.2.3",
				tagCreatedAt: new Date("2026-08-20T00:00:00Z"),
			});
			const f = fakeBump([opened(11)]);
			const receipts: Array<{ repository: string; pr: number; body: string }> = [];

			await runBuildBumpBump(
				db,
				config(),
				deps(f.bump, {
					postReceipt: async (repository, pr, body) => {
						receipts.push({ repository, pr, body });
					},
				}),
			);

			expect(f.calls.length).toBe(1);
			const call = f.calls[0];
			expect(call?.appDir).toBe("landing");
			expect(call?.target).toBe("live");
			expect(call?.allowOlder).toBe(false);
			expect(call?.candidate).toEqual({ repository: REPO, tag: "v1.2.3", sha: SHA });
			expect(call?.workdir).toBe(`${WORKROOT}/${newest}-landing`);
			const all = await rows(db, newest);
			expect(all.map((r) => r.status)).toEqual(["opened"]);
			expect(all[0]?.pr).toBe(11);
			expect(receipts.map((r) => r.pr)).toEqual([11]);
			expect(receipts[0]?.body).toContain("v1.2.3");
		});
	});

	test("(2) a second pass answering ALREADY_AT_TAG records refused + converged and invokes nothing else", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const f = fakeBump([{ kind: "refused", reason: "ALREADY_AT_TAG" }]);

			await runBuildBumpBump(db, config(), deps(f.bump));
			const after = (await rows(db, id))[0];
			expect(after?.status).toBe("refused");
			expect(after?.reason).toBe("ALREADY_AT_TAG");
			expect(after?.finishedAt).toBeInstanceOf(Date);

			// The fake is exhausted: any further invocation throws.
			await runBuildBumpBump(db, config(), deps(f.bump));
			expect(f.calls.length).toBe(1);
		});
	});

	test("(3) two app dirs in one environment open two PRs", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const f = fakeBump([opened(21), opened(22)]);

			await runBuildBumpBump(
				db,
				config([{ name: "live", app_dirs: ["landing", "api"] }]),
				deps(f.bump),
			);

			expect(f.calls.map((c) => c.appDir)).toEqual(["landing", "api"]);
			expect(f.calls.every((c) => c.target === "live")).toBe(true);
			expect((await rows(db, id)).map((r) => r.status)).toEqual(["opened", "opened"]);
		});
	});
});

describe("runBuildBumpBump — two environments", () => {
	test("(4) with no marker, only the tag-stream environment bumps, target `uat`", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const f = fakeBump([opened(31)]);
			const warns: string[] = [];

			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { onWarn: (m) => warns.push(m) }));

			expect(f.calls.length).toBe(1);
			expect(f.calls[0]?.appDir).toBe("landing-uat");
			expect(f.calls[0]?.target).toBe("uat");
			expect(f.calls[0]?.allowOlder).toBe(false);
			// No marker is the normal quiet state, not a fault.
			expect(warns).toEqual([]);
			expect((await rows(db, id)).map((r) => r.appDir)).toEqual(["landing-uat"]);
		});
	});

	test("(5) a marker on an OLDER built candidate bumps that one, target `prod`, allowOlder, uat untouched", async () => {
		await withTestDb(async (db) => {
			const older = await seed(db, {
				tag: "v0.2.57",
				sha: OLD_SHA,
				tagCreatedAt: new Date("2026-08-01T00:00:00Z"),
			});
			const newest = await seed(db, {
				tag: "v1.2.3",
				tagCreatedAt: new Date("2026-08-20T00:00:00Z"),
			});
			await seedMarker(db, "prod", OLD_SHA);
			// uat first (newest), then prod (the marker's older candidate).
			const f = fakeBump([opened(41), opened(42)]);

			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump));

			expect(f.calls.length).toBe(2);
			expect(f.calls[0]).toMatchObject({
				appDir: "landing-uat",
				target: "uat",
				allowOlder: false,
			});
			expect(f.calls[0]?.candidate.tag).toBe("v1.2.3");
			expect(f.calls[1]).toMatchObject({ appDir: "landing", target: "prod", allowOlder: true });
			expect(f.calls[1]?.candidate).toEqual({
				repository: REPO,
				tag: "v0.2.57",
				sha: OLD_SHA,
			});
			// Each pair belongs to its own candidate; neither leaked onto the other.
			expect((await rows(db, newest)).map((r) => r.appDir)).toEqual(["landing-uat"]);
			expect((await rows(db, older)).map((r) => r.appDir)).toEqual(["landing"]);
		});
	});

	test("(6) a marker on a FAILED candidate re-queues it to pending and invokes nothing for prod", async () => {
		await withTestDb(async (db) => {
			const failed = await seed(db, {
				tag: "v0.2.57",
				sha: OLD_SHA,
				status: "failed",
				tagCreatedAt: new Date("2026-08-01T00:00:00Z"),
			});
			await seed(db, { tag: "v1.2.3", tagCreatedAt: new Date("2026-08-20T00:00:00Z") });
			await seedMarker(db, "prod", OLD_SHA);
			// Exactly one scripted outcome: uat's. A prod invocation would throw.
			const f = fakeBump([opened(51)]);

			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump));

			expect(f.calls.map((c) => c.target)).toEqual(["uat"]);
			const [row] = await db
				.select()
				.from(buildBumpCandidates)
				.where(eq(buildBumpCandidates.id, failed));
			expect(row?.status).toBe("pending");
			expect(row?.buildReason).toBeNull();
			expect(row?.buildFinishedAt).toBeNull();
			expect(await rows(db, failed)).toEqual([]);
		});
	});

	/**
	 * THE DEFECT THAT MADE THE REQUEUE INVISIBLE. A permanent build failure under
	 * a placed marker is re-queued every pass forever — correct, because the fault
	 * may be transient and the lane must converge without an operator — but it
	 * created no pair row, so `runBuildBumpAlerts` had nothing to match and
	 * `/status.json` read exactly like an environment nobody had marked. The
	 * counter is the evidence; the retry itself is deliberately still unbounded.
	 *
	 * The build lane is not run here, so the row stays `pending` after the first
	 * requeue and is seeded back to `failed` between passes — which is what the
	 * build pass would have done by failing it again.
	 */
	test("(6b) three passes over a permanently failing candidate count three requeues and invoke nothing for prod", async () => {
		await withTestDb(async (db) => {
			const failed = await seed(db, {
				tag: "v0.2.57",
				sha: OLD_SHA,
				status: "failed",
				tagCreatedAt: new Date("2026-08-01T00:00:00Z"),
			});
			await seedMarker(db, "prod", OLD_SHA);
			// Not one scripted outcome: the uat environment has nothing built either,
			// so ANY invocation in any of the three passes throws.
			const f = fakeBump([]);

			for (let pass = 0; pass < 3; pass += 1) {
				await runBuildBumpBump(db, twoEnvironments(), deps(f.bump));
				await db
					.update(buildBumpCandidates)
					.set({ status: "failed", buildReason: "BackoffLimitExceeded" })
					.where(eq(buildBumpCandidates.id, failed));
			}

			const [row] = await db
				.select()
				.from(buildBumpCandidates)
				.where(eq(buildBumpCandidates.id, failed));
			expect(row?.requeues).toBe(3);
			expect(f.calls).toEqual([]);
			// Still no pair row anywhere — which is precisely why the count had to
			// live on the candidate rather than be derived from `build_bump_bumps`.
			expect(await rows(db, failed)).toEqual([]);
		});
	});

	test("(7) a marker matching no version tag warns ONCE and invokes nothing for prod", async () => {
		await withTestDb(async (db) => {
			await seed(db, { tag: "v1.2.3" });
			await seedMarker(db, "prod", "e".repeat(40));
			const f = fakeBump([opened(61)]);
			const warns: string[] = [];

			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { onWarn: (m) => warns.push(m) }));

			expect(f.calls.map((c) => c.target)).toEqual(["uat"]);
			expect(warns.length).toBe(1);
			expect(warns[0]).toContain("prod");
		});
	});
});

describe("runBuildBumpBump — pair lifecycle", () => {
	test("(8) a harness outcome returns the pair to pending EVERY time, never failed", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const f = fakeBump([
				{ kind: "harness", reason: "timeout" },
				{ kind: "harness", reason: "spawn error" },
				{ kind: "harness", reason: "still broken" },
			]);

			await runBuildBumpBump(db, config(), deps(f.bump));
			let r = (await rows(db, id))[0];
			expect(r?.status).toBe("pending");
			expect(r?.attempts).toBe(1);
			expect(r?.startedAt).toBeNull();
			expect(r?.finishedAt).toBeNull();
			expect(r?.reason).toBe("timeout");

			await runBuildBumpBump(db, config(), deps(f.bump));
			r = (await rows(db, id))[0];
			// Still PENDING at attempt 2: the environment gets fixed, and a pair that
			// stopped retrying would be a deploy that silently never lands.
			expect(r?.status).toBe("pending");
			expect(r?.attempts).toBe(2);
			expect(r?.finishedAt).toBeNull();
			expect(r?.reason).toBe("spawn error");

			// THE THIRD ATTEMPT IS THE ONE THAT USED TO END IT. `attempts` crossing the
			// alert threshold (3, §8) RAISES a signal; it does not stop the retry. A
			// pair that goes terminal here is a deploy that silently never lands, and
			// nothing but the alert ever says so.
			await runBuildBumpBump(db, config(), deps(f.bump));
			r = (await rows(db, id))[0];
			expect(r?.status).toBe("pending");
			expect(r?.attempts).toBe(3);
			expect(r?.finishedAt).toBeNull();
			// A harness outcome settles nothing, so nothing can supersede it.
			expect(r?.settledAt).toBeNull();
			expect(r?.reason).toBe("still broken");
		});
	});

	test("(8b) a pair that opens after a harness failure carries NO stale reason", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const f = fakeBump([{ kind: "harness", reason: "timeout" }, opened(201)]);

			await runBuildBumpBump(db, config(), deps(f.bump));
			expect((await rows(db, id))[0]?.reason).toBe("timeout");

			// THE TERMINAL RECORD OWNS ITS OWN FIELDS. `reason` explains a non-opened
			// ending; an `opened` row that inherits the earlier harness string reads
			// as a PR opened because of a timeout, which is not what happened.
			await runBuildBumpBump(db, config(), deps(f.bump));
			const r = (await rows(db, id))[0];
			expect(r?.status).toBe("opened");
			expect(r?.pr).toBe(201);
			expect(r?.reason).toBeNull();
		});
	});

	test("(9) an unconfigured seam warns ONCE and creates no rows", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const warns: string[] = [];

			await runBuildBumpBump(db, config(), deps(null, { onWarn: (m) => warns.push(m) }));

			expect(warns.length).toBe(1);
			expect(await rows(db, id)).toEqual([]);
		});
	});

	test("(10) nothing built yet is the quiet state: no invocation, no row, no warning", async () => {
		await withTestDb(async (db) => {
			const pending = await seed(db, { status: "pending", tag: "v1.0.0" });
			const building = await seed(db, { status: "building", tag: "v1.0.1" });
			const failed = await seed(db, { status: "failed", tag: "v1.0.2" });
			const f = fakeBump([]);
			const warns: string[] = [];

			await runBuildBumpBump(db, config(), deps(f.bump, { onWarn: (m) => warns.push(m) }));

			expect(f.calls).toEqual([]);
			expect(warns).toEqual([]);
			for (const id of [pending, building, failed]) expect(await rows(db, id)).toEqual([]);
		});
	});

	test("(11) a candidate whose repository is no longer enrolled warns and creates no row", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const warns: string[] = [];
			const f = fakeBump([]);

			await runBuildBumpBump(db, emptyConfig(), deps(f.bump, { onWarn: (m) => warns.push(m) }));

			expect(f.calls).toEqual([]);
			expect(warns.length).toBe(1);
			expect(await rows(db, id)).toEqual([]);
		});
	});

	test("(12) a receipt failure warns but leaves the row opened", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const f = fakeBump([opened(71)]);
			const warns: string[] = [];

			await runBuildBumpBump(
				db,
				config(),
				deps(f.bump, {
					onWarn: (m) => warns.push(m),
					postReceipt: async () => {
						throw new Error("forge 502");
					},
				}),
			);

			const r = (await rows(db, id))[0];
			expect(r?.status).toBe("opened");
			expect(r?.pr).toBe(71);
			expect(warns.length).toBe(1);
		});
	});

	test("(13) the CAS claims once and refuses the same stale read a second time", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			await db.insert(buildBumpBumps).values({
				candidateId: id,
				appDir: "landing",
				status: "pending",
				attempts: 0,
			});
			const snapshot = (await rows(db, id))[0];
			if (!snapshot) throw new Error("no bump row seeded");

			expect(await claimPairAttempt(db, snapshot)).toBe(1);
			// The SAME read again: the DB has moved to 1, so the compare-and-swap
			// matches nothing and the caller is told it does not own the invocation.
			expect(await claimPairAttempt(db, snapshot)).toBeUndefined();

			const r = (await rows(db, id))[0];
			expect(r?.attempts).toBe(1);
			expect(r?.status).toBe("invoking");
			expect(r?.startedAt).toBeInstanceOf(Date);
		});
	});

	test("(14) an in-flight claim is skipped until stale, then recovered to pending and retried", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			await db.insert(buildBumpBumps).values({
				candidateId: id,
				appDir: "landing",
				status: "invoking",
				attempts: 3,
				startedAt: new Date(NOW.getTime() - 60_000),
			});
			const f = fakeBump([opened(81)]);

			await runBuildBumpBump(db, config(), deps(f.bump));
			expect(f.calls).toEqual([]);

			// Past the timeout: recovered to PENDING even at attempt 3, never failed.
			await runBuildBumpBump(
				db,
				config(),
				deps(f.bump, { now: () => new Date(NOW.getTime() + 16 * 60_000) }),
			);
			expect(f.calls.length).toBe(1);
			expect((await rows(db, id))[0]?.status).toBe("opened");
		});
	});
});

/**
 * THE MARKER ROUND TRIP. The pair key is (candidate_id, app_dir) for all time, so
 * a marker that moves prod v2 -> v1 -> v2 meets v2's own row, still terminal from
 * the first move. These cases pin what makes it move again — and, just as much,
 * what must NOT.
 */
describe("runBuildBumpBump — a superseded pair is re-driven", () => {
	/** Each pass gets its own clock, so settlement ORDER is a real observation. */
	const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

	/** Seed the two-level shape: a newest v2 and an older v1, both built. */
	async function twoTags(db: TestDb): Promise<{ v2: number; v1: number }> {
		const v2 = await seed(db, { tag: "v2.0.0", tagCreatedAt: new Date("2026-08-20T00:00:00Z") });
		const v1 = await seed(db, {
			tag: "v1.0.0",
			sha: OLD_SHA,
			tagCreatedAt: new Date("2026-08-01T00:00:00Z"),
		});
		return { v2, v1 };
	}

	/** Point the `prod` marker at one commit, replacing wherever it was. */
	async function moveMarker(db: TestDb, sha: string): Promise<void> {
		await db.delete(buildBumpMarkers);
		await seedMarker(db, "prod", sha);
	}

	test("(17) marker v2 -> v1 -> v2 re-drives v2, and a fourth pass invokes nothing", async () => {
		await withTestDb(async (db) => {
			const { v2, v1 } = await twoTags(db);
			// uat's own v2 bump, then prod v2, then prod v1, then prod v2 again.
			const f = fakeBump([opened(101), opened(102), opened(103), opened(104)]);

			// PASS 1: the marker is on v2. uat takes v2 by the tag stream; prod takes
			// v2 by the marker.
			await moveMarker(db, SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(0) }));
			expect(f.calls.map((c) => c.target)).toEqual(["uat", "prod"]);
			expect((await rows(db, v2)).map((r) => [r.appDir, r.status, r.pr])).toEqual([
				["landing-uat", "opened", 101],
				["landing", "opened", 102],
			]);

			// PASS 2: the marker moves BACK to v1 — a legitimate deploy of an older
			// version. uat is already terminal on v2 and invokes nothing.
			await moveMarker(db, OLD_SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(10) }));
			expect(f.calls.length).toBe(3);
			expect(f.calls[2]).toMatchObject({ appDir: "landing", target: "prod", allowOlder: true });
			expect((await rows(db, v1)).map((r) => [r.appDir, r.status, r.pr])).toEqual([
				["landing", "opened", 103],
			]);

			// PASS 3: the marker returns to v2. WITHOUT the reopen this is where prod
			// strands: v2's `landing` row is still `opened` from pass 1, the pair state
			// machine refuses it, and prod sits on v1 forever with no signal.
			await moveMarker(db, SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(20) }));
			expect(f.calls.length).toBe(4);
			expect(f.calls[3]).toMatchObject({ appDir: "landing", target: "prod", allowOlder: true });
			expect(f.calls[3]?.candidate.tag).toBe("v2.0.0");
			const reopened = (await rows(db, v2)).find((r) => r.appDir === "landing");
			expect(reopened?.status).toBe("opened");
			expect(reopened?.pr).toBe(104);
			expect(reopened?.settledAt).toEqual(at(20));

			// PASS 4: nothing moved. The fake is exhausted and THROWS on any call, so
			// this asserts the reopen is driven by supersession, not by every pass.
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(30) }));
			expect(f.calls.length).toBe(4);
			const unchanged = (await rows(db, v2)).find((r) => r.appDir === "landing");
			expect(unchanged?.pr).toBe(104);
			expect(unchanged?.settledAt).toEqual(at(20));
		});
	});

	test("(17b) a reopened row is a CLEAN pending row: no finish time, no settlement", async () => {
		await withTestDb(async (db) => {
			const { v2, v1 } = await twoTags(db);
			const f = fakeBump([opened(101), opened(102), opened(103)]);

			await moveMarker(db, SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(0) }));
			await moveMarker(db, OLD_SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(10) }));
			expect((await rows(db, v1)).map((r) => r.status)).toEqual(["opened"]);

			// The reopen is driven DIRECTLY, so the row is observed in exactly the
			// state the reopen left it in rather than in whatever the following
			// invocation wrote over it. `finished_at` is documented NULL while
			// `pending`; carrying the superseded settlement's finish time makes a row
			// that is both unfinished and finished.
			const ctx = {
				db,
				deps: deps(f.bump, { now: () => at(20) }),
				bump: f.bump,
				now: at(20),
				warnedMarkers: new Set<string>(),
			};
			expect(await reopenSuperseded(ctx, v2, "landing")).toBe(true);
			expect(f.calls.length).toBe(3);
			const reopened = (await rows(db, v2)).find((r) => r.appDir === "landing");
			expect(reopened?.status).toBe("pending");
			expect(reopened?.pr).toBeNull();
			expect(reopened?.finishedAt).toBeNull();
			expect(reopened?.settledAt).toBeNull();
		});
	});

	test("(17c) a reopen clears the merge-watch record, so the next PR is watched and refreshed", async () => {
		await withTestDb(async (db) => {
			const { v2 } = await twoTags(db);
			const f = fakeBump([opened(101), opened(102), opened(103)]);

			await moveMarker(db, SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(0) }));
			await moveMarker(db, OLD_SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(10) }));

			// PR 101 (v2 landing) was merged and refreshed in Argo before the marker moved back.
			await db
				.update(buildBumpBumps)
				.set({ mergedAt: at(5), prClosedAt: at(5), argoRefreshedAt: at(6) })
				.where(and(eq(buildBumpBumps.candidateId, v2), eq(buildBumpBumps.appDir, "landing")));
			const ctx = {
				db,
				deps: deps(f.bump, { now: () => at(20) }),
				bump: f.bump,
				now: at(20),
				warnedMarkers: new Set<string>(),
			};
			expect(await reopenSuperseded(ctx, v2, "landing")).toBe(true);
			const reopened = (await rows(db, v2)).find((r) => r.appDir === "landing");
			expect(reopened?.mergedAt).toBeNull();
			expect(reopened?.prClosedAt).toBeNull();
			expect(reopened?.argoRefreshedAt).toBeNull();
		});
	});

	test("(18) a refused ALREADY_AT_TAG superseded by a later bump is re-driven once", async () => {
		await withTestDb(async (db) => {
			const { v2, v1 } = await twoTags(db);
			// uat v2, prod v2 CONVERGED, prod v1, then prod v2 re-driven.
			const f = fakeBump([
				opened(111),
				{ kind: "refused", reason: "ALREADY_AT_TAG" },
				opened(113),
				opened(114),
			]);

			await moveMarker(db, SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(0) }));
			const converged = (await rows(db, v2)).find((r) => r.appDir === "landing");
			expect(converged?.status).toBe("refused");
			expect(converged?.settledAt).toEqual(at(0));

			await moveMarker(db, OLD_SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(10) }));
			expect((await rows(db, v1))[0]?.pr).toBe(113);

			// Converged means "this directory WAS carrying this tag" — exactly the
			// claim a later bump of the same directory invalidates.
			await moveMarker(db, SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(20) }));
			expect(f.calls.length).toBe(4);
			const redriven = (await rows(db, v2)).find((r) => r.appDir === "landing");
			expect(redriven?.status).toBe("opened");
			expect(redriven?.pr).toBe(114);
			expect(redriven?.reason).toBeNull();
		});
	});

	test("(19) a refused BAD_TARGET stays terminal even once superseded", async () => {
		await withTestDb(async (db) => {
			const { v2, v1 } = await twoTags(db);
			// uat v2, prod v2 REFUSED for a real fault, prod v1. Nothing more is
			// scripted: a fourth invocation throws, which is the assertion.
			const f = fakeBump([opened(121), { kind: "refused", reason: "BAD_TARGET" }, opened(123)]);

			await moveMarker(db, SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(0) }));
			await moveMarker(db, OLD_SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(10) }));
			expect((await rows(db, v1))[0]?.pr).toBe(123);

			// The bump itself is wrong for this pair and the same inputs reproduce it,
			// so reopening it would be exactly the churn loop terminality prevents.
			await moveMarker(db, SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(20) }));
			expect(f.calls.length).toBe(3);
			const still = (await rows(db, v2)).find((r) => r.appDir === "landing");
			expect(still?.status).toBe("refused");
			expect(still?.reason).toBe("BAD_TARGET");
			expect(still?.settledAt).toEqual(at(0));
		});
	});

	test("(20) a TAG environment never reopens, even with a newer opened row on its dir", async () => {
		await withTestDb(async (db) => {
			// One environment, promote: tag. Its newest candidate opens on `landing`.
			const v1 = await seed(db, { tag: "v1.0.0", tagCreatedAt: new Date("2026-08-01T00:00:00Z") });
			const f = fakeBump([opened(131)]);
			await runBuildBumpBump(db, config(), deps(f.bump, { now: () => at(0) }));
			expect((await rows(db, v1))[0]?.pr).toBe(131);

			// A LATER-SETTLED opened row for the SAME app_dir: the exact supersession
			// shape a marker environment acts on. Seeded by hand, because a tag
			// environment never moves backwards and so cannot produce one itself.
			const other = await seed(db, {
				tag: "v9.9.9",
				sha: "f".repeat(40),
				status: "pending",
				tagCreatedAt: new Date("2026-07-01T00:00:00Z"),
			});
			await db.insert(buildBumpBumps).values({
				candidateId: other,
				appDir: "landing",
				status: "opened",
				pr: 999,
				attempts: 1,
				settledAt: at(5),
			});

			// The fake is exhausted: a reopen here would re-drive v1 and THROW. Tag
			// environments follow the version-tag stream forwards only, so the
			// supersession question never arises for them.
			await runBuildBumpBump(db, config(), deps(f.bump, { now: () => at(20) }));
			expect(f.calls.length).toBe(1);
			const untouched = (await rows(db, v1))[0];
			expect(untouched?.status).toBe("opened");
			expect(untouched?.pr).toBe(131);
			expect(untouched?.settledAt).toEqual(at(0));
		});
	});

	test("(21) a converged REFUSAL supersedes, so a marker round trip over it re-drives", async () => {
		await withTestDb(async (db) => {
			const { v2 } = await twoTags(db);
			// uat v2, prod v2 opened (pr 100), then prod v1 CONVERGES — v2's PR is
			// still unmerged, so the deploy repo already carries v2's tag. A
			// superseder set of `opened` rows alone cannot see that, and prod strands.
			const f = fakeBump([
				opened(99),
				opened(100),
				{ kind: "refused", reason: "ALREADY_AT_TAG" },
				opened(102),
			]);

			await moveMarker(db, SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(0) }));
			expect(f.calls.length).toBe(2);

			await moveMarker(db, OLD_SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(10) }));
			expect(f.calls.length).toBe(3);

			// Back to v2: the later-settled refusal is the superseder, so v2 re-drives
			// EXACTLY ONCE.
			await moveMarker(db, SHA);
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(20) }));
			expect(f.calls.length).toBe(4);
			expect(f.calls[3]).toMatchObject({ appDir: "landing", target: "prod", allowOlder: true });
			expect(f.calls[3]?.candidate.tag).toBe("v2.0.0");
			const redriven = (await rows(db, v2)).find((r) => r.appDir === "landing");
			expect(redriven?.pr).toBe(102);

			// Quiet on the next pass: the fake is exhausted and THROWS on any call.
			await runBuildBumpBump(db, twoEnvironments(), deps(f.bump, { now: () => at(30) }));
			expect(f.calls.length).toBe(4);
		});
	});

	test("(22) another repository sharing the directory name never supersedes", async () => {
		const BETA = "other/web-bb-landing";
		await withTestDb(async (db) => {
			// Two enrolled repositories both own an app dir called `landing`, and both
			// publish an image of the same name. That is legal: `app_dirs` entries and
			// image names are plain names, not globally unique keys — so the
			// REPOSITORY is the only thing telling the two pairs apart.
			const [entry] = config([{ name: "uat", app_dirs: ["landing-uat"] }]).repositories;
			const shape = (name: string) =>
				({
					...config(),
					repositories: [
						{
							...(entry as object),
							name,
							build_bump: {
								tag_pattern: "v*",
								environments: [
									{ name: "uat", app_dirs: ["landing-uat"] },
									{ name: "prod", app_dirs: ["landing"] },
								],
							},
						},
					],
				}) as unknown as WatcherConfig;
			const alphaConfig = shape(REPO);
			const betaConfig = shape(BETA);

			// alpha's prod settles FIRST, on `landing`.
			const alpha = await seed(db, { tag: "v1.0.0", tagCreatedAt: new Date("2026-08-01") });
			await seedMarker(db, "prod", SHA);
			const f = fakeBump([opened(201), opened(202), opened(203), opened(204)]);
			await runBuildBumpBump(db, alphaConfig, deps(f.bump, { now: () => at(0) }));
			expect(f.calls.length).toBe(2);
			const alphaProd = (await rows(db, alpha)).find((r) => r.appDir === "landing");
			expect(alphaProd?.pr).toBe(202);

			// beta bumps the SAME directory name, settling LATER.
			const betaSha = "e".repeat(40);
			await seed(db, {
				repository: BETA,
				tag: "v5.0.0",
				sha: betaSha,
				tagCreatedAt: new Date("2026-08-02"),
			});
			await db.insert(buildBumpMarkers).values({ repository: BETA, marker: "prod", sha: betaSha });
			await runBuildBumpBump(db, betaConfig, deps(f.bump, { now: () => at(10) }));
			expect(f.calls.length).toBe(4);

			// alpha's pair is CONVERGED, not stale: nothing bumped ITS `landing`. The
			// fake is exhausted, so a reopen here would re-drive alpha and THROW.
			await runBuildBumpBump(db, alphaConfig, deps(f.bump, { now: () => at(20) }));
			expect(f.calls.length).toBe(4);
			const untouched = (await rows(db, alpha)).find((r) => r.appDir === "landing");
			expect(untouched?.status).toBe("opened");
			expect(untouched?.pr).toBe(202);
			expect(untouched?.settledAt).toEqual(at(0));
		});
	});
});

describe("runBuildBumpBump — enrolment shapes", () => {
	test("(15) build-only enrolment invokes nothing, warns nothing, and writes no row", async () => {
		await withTestDb(async (db) => {
			const id = await seed(db);
			const f = fakeBump([]);
			const warns: string[] = [];

			await runBuildBumpBump(db, buildOnlyConfig(), deps(f.bump, { onWarn: (m) => warns.push(m) }));

			expect(f.calls).toEqual([]);
			expect(warns).toEqual([]);
			expect(await rows(db, id)).toEqual([]);
		});
	});

	test("(16) a per-image candidate bumps only its own image's environment", async () => {
		await withTestDb(async (db) => {
			const gitingest = await seed(db, { image: "mcp-gitingest", tag: "v0.1.0" });
			const unifi = await seed(db, { image: "mcp-unifi", tag: "v0.1.0" });
			const f = fakeBump([opened(91)]);
			const receipts: string[] = [];

			await runBuildBumpBump(
				db,
				imagesConfig(),
				deps(f.bump, {
					postReceipt: async (_repository, _pr, body) => {
						receipts.push(body);
					},
				}),
			);

			expect(f.calls.map((c) => c.appDir)).toEqual(["mcp-gitingest"]);
			expect(f.calls[0]?.target).toBe("live");
			expect((await rows(db, gitingest)).map((r) => r.status)).toEqual(["opened"]);
			// mcp-unifi declares no environments: build-only, a silent no-op.
			expect(await rows(db, unifi)).toEqual([]);
			expect(receipts[0]).toContain("image: mcp-gitingest");
		});
	});
});
