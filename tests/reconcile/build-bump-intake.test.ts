/**
 * @module tests/reconcile/build-bump-intake
 * @description Hermetic tests for the build-bump tag intake pass. They
 *   assert: an enrolled forgejo repository's matching tag becomes exactly one
 *   candidate row, a second pass over the same tag inserts nothing (the dedupe
 *   receipt on the (repository, tag, sha) unique index), a repository with NO
 *   `build_bump` block is never listed at all, a tag failing `tag_pattern` is
 *   filtered out, the stored sha is the COMMIT sha and never the annotated tag
 *   object's own id, and a lister that returns null SKIPS the repository for the
 *   pass rather than throwing.
 *
 *   The MARKER tests additionally pin that a marker is resolved BY NAME and
 *   never by membership in the bounded 50-tag page: the load-bearing one seeds a
 *   full page that does NOT contain the marker and proves the named lookup still
 *   upserts it, which is the regression the page-membership bug produced.
 */
import { describe, expect, test } from "bun:test";
import type { WatcherConfig } from "../../src/config/schema";
import { buildBumpCandidates, buildBumpMarkers } from "../../src/db/schema";
import type { ForgejoTag } from "../../src/forgejo/tags";
import { matchesTagPattern, runBuildBumpIntake } from "../../src/reconcile/build-bump-intake";
import { withTestDb } from "../db/helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

/**
 * A config with one repository. `build_bump` is supplied verbatim so a test can
 * omit the block entirely (the not-enrolled case) rather than flag it off — the
 * whole enrolment contract is the block's PRESENCE.
 */
function config(args: {
	provider?: "github" | "forgejo";
	buildBump?: Record<string, unknown>;
}): WatcherConfig {
	const repo: Record<string, unknown> = {
		name: "rodaddy/x",
		provider: args.provider ?? "forgejo",
		checks: "standard",
		gate_selection: "full",
	};
	if (args.buildBump) {
		repo.build_bump = args.buildBump;
	}
	return {
		poll_interval_minutes: 15,
		repositories: [repo],
		job_templates: [],
		doorbell_enabled: false,
		shadow_publish: false,
	} as unknown as WatcherConfig;
}

const enrolled = (tag_pattern = "v*") => ({
	app_dirs: ["hello"],
	tag_pattern,
	prod: "manual" as const,
});

/**
 * The rare two-level enrolment: the first environment follows the version-tag
 * stream, the second a movable tag named after itself (`prod`). The words are
 * configuration only — no factory code knows them.
 */
const twoEnvironments = () => ({
	environments: [
		{ name: "uat", app_dirs: ["hello-uat"] },
		{ name: "prod", app_dirs: ["hello"] },
	],
	tag_pattern: "v*",
});

/** Every candidate row, ordered so assertions read deterministically. */
async function candidates(db: TestDb) {
	return db
		.select({
			repository: buildBumpCandidates.repository,
			tag: buildBumpCandidates.tag,
			sha: buildBumpCandidates.sha,
			status: buildBumpCandidates.status,
			image: buildBumpCandidates.image,
			dockerfile: buildBumpCandidates.dockerfile,
		})
		.from(buildBumpCandidates)
		.orderBy(buildBumpCandidates.tag, buildBumpCandidates.image);
}

/** Every marker row, ordered by marker so assertions read deterministically. */
async function markers(db: TestDb) {
	return db
		.select({
			repository: buildBumpMarkers.repository,
			marker: buildBumpMarkers.marker,
			sha: buildBumpMarkers.sha,
		})
		.from(buildBumpMarkers)
		.orderBy(buildBumpMarkers.marker);
}

/** The tag_created_at column, which the row-shape helper above deliberately omits. */
async function candidateDates(db: TestDb) {
	return db
		.select({ tag: buildBumpCandidates.tag, tagCreatedAt: buildBumpCandidates.tagCreatedAt })
		.from(buildBumpCandidates)
		.orderBy(buildBumpCandidates.tag);
}

/**
 * A lister returning a fixed set, recording how many times it was called.
 *
 * `read` is the NAMED-lookup seam (`readTag`). By default it answers from the
 * same fixed set, which is the convenient shape for every test that is not
 * about markers — but the two are separate seams deliberately, and the
 * regression test below drives them APART, because a marker that is not in the
 * bounded page is exactly the case the production bug turned on.
 */
function lister(tags: ForgejoTag[] | null) {
	const calls: string[] = [];
	const reads: string[] = [];
	return {
		calls,
		reads,
		list: async (repository: string) => {
			calls.push(repository);
			return tags;
		},
		read: async (repository: string, name: string): Promise<ForgejoTag | "absent" | null> => {
			reads.push(`${repository}#${name}`);
			if (tags === null) return null;
			return tags.find((tag) => tag.name === name) ?? "absent";
		},
	};
}

/** A `readTag` seam that answers a fixed verdict for every name. */
function reader(verdict: ForgejoTag | "absent" | null) {
	const reads: string[] = [];
	return {
		reads,
		read: async (repository: string, name: string) => {
			reads.push(`${repository}#${name}`);
			return verdict;
		},
	};
}

describe("runBuildBumpIntake", () => {
	test("records an enrolled forgejo repo's matching tag as one candidate", async () => {
		await withTestDb(async (db) => {
			const l = lister([{ name: "v1.2.3", commitSha: "c".repeat(40) }]);
			await runBuildBumpIntake(db, config({ buildBump: enrolled() }), {
				listTags: l.list,
				readTag: l.read,
			});

			const rows = await candidates(db);
			expect(rows.length).toBe(1);
			expect(rows[0]).toMatchObject({
				repository: "rodaddy/x",
				tag: "v1.2.3",
				sha: "c".repeat(40),
				status: "pending",
				// The legacy single-image shape: the short name from the root Dockerfile.
				image: "x",
				dockerfile: "Dockerfile",
			});
			expect(l.calls).toEqual(["rodaddy/x"]);
		});
	});

	test("one tag on a repository declaring two images records one candidate per image", async () => {
		await withTestDb(async (db) => {
			const cfg = config({
				buildBump: {
					images: [
						{ name: "mcp-gitingest", dockerfile: "servers/gitingest/Containerfile" },
						{ name: "mcp-unifi", dockerfile: "unifi-network-mcp/Containerfile" },
					],
					tag_pattern: "v*",
					prod: "manual",
				},
			});
			const l = lister([{ name: "v0.1.0", commitSha: "c".repeat(40) }]);
			await runBuildBumpIntake(db, cfg, { listTags: l.list, readTag: l.read });
			await runBuildBumpIntake(db, cfg, { listTags: l.list, readTag: l.read });

			const rows = await candidates(db);
			expect(rows.map((r) => [r.tag, r.image, r.dockerfile, r.status])).toEqual([
				["v0.1.0", "mcp-gitingest", "servers/gitingest/Containerfile", "pending"],
				["v0.1.0", "mcp-unifi", "unifi-network-mcp/Containerfile", "pending"],
			]);
		});
	});

	test("a second pass over the same tag inserts nothing (dedupe receipt)", async () => {
		await withTestDb(async (db) => {
			const cfg = config({ buildBump: enrolled() });
			const l = lister([{ name: "v1.2.3", commitSha: "c".repeat(40) }]);

			await runBuildBumpIntake(db, cfg, { listTags: l.list, readTag: l.read });
			await runBuildBumpIntake(db, cfg, { listTags: l.list, readTag: l.read });

			// The forge was re-read both passes; the unique index is what dedupes.
			expect(l.calls.length).toBe(2);
			expect((await candidates(db)).length).toBe(1);
		});
	});

	test("a repository with no build_bump block is never listed", async () => {
		await withTestDb(async (db) => {
			const l = lister([{ name: "v1.2.3", commitSha: "c".repeat(40) }]);
			await runBuildBumpIntake(db, config({}), { listTags: l.list, readTag: l.read });

			expect(l.calls).toEqual([]);
			expect((await candidates(db)).length).toBe(0);
		});
	});

	test("a tag that fails tag_pattern records no candidate", async () => {
		await withTestDb(async (db) => {
			const l = lister([
				{ name: "nightly-2026-09-01", commitSha: "a".repeat(40) },
				{ name: "release", commitSha: "b".repeat(40) },
			]);
			await runBuildBumpIntake(db, config({ buildBump: enrolled("v*") }), {
				listTags: l.list,
				readTag: l.read,
			});

			expect((await candidates(db)).length).toBe(0);
		});
	});

	test("an exact tag_pattern with no '*' matches only that exact name", async () => {
		await withTestDb(async (db) => {
			const l = lister([
				{ name: "v1.0.0", commitSha: "a".repeat(40) },
				{ name: "v1.0.0-rc1", commitSha: "b".repeat(40) },
			]);
			await runBuildBumpIntake(db, config({ buildBump: enrolled("v1.0.0") }), {
				listTags: l.list,
				readTag: l.read,
			});

			const rows = await candidates(db);
			expect(rows.length).toBe(1);
			expect(rows[0]?.tag).toBe("v1.0.0");
		});
	});

	test("stores the COMMIT sha, never the annotated tag object's own id", async () => {
		await withTestDb(async (db) => {
			// The lister's contract is that it has ALREADY mapped commit.sha; this
			// fixture pins the stored value against a tag-object sha that differs, so
			// a pass reading any other field cannot pass.
			const commitSha = "c".repeat(40);
			const tagObjectSha = "d".repeat(40);
			expect(commitSha).not.toBe(tagObjectSha);
			const l = lister([{ name: "v2.0.0", commitSha }]);

			await runBuildBumpIntake(db, config({ buildBump: enrolled() }), {
				listTags: l.list,
				readTag: l.read,
			});

			const rows = await candidates(db);
			expect(rows.length).toBe(1);
			expect(rows[0]?.sha).toBe(commitSha);
			expect(rows[0]?.sha).not.toBe(tagObjectSha);
		});
	});

	test("a null lister result skips the repository without throwing", async () => {
		await withTestDb(async (db) => {
			const l = lister(null);
			const warnings: string[] = [];

			await runBuildBumpIntake(db, config({ buildBump: enrolled() }), {
				listTags: l.list,
				readTag: l.read,
				onWarn: (m) => warnings.push(m),
			});

			expect(l.calls).toEqual(["rodaddy/x"]);
			expect((await candidates(db)).length).toBe(0);
			expect(warnings.length).toBe(1);
		});
	});

	test("a non-forgejo enrolled repository is warned and skipped, never listed", async () => {
		await withTestDb(async (db) => {
			const l = lister([{ name: "v1.2.3", commitSha: "c".repeat(40) }]);
			const warnings: string[] = [];

			await runBuildBumpIntake(db, config({ provider: "github", buildBump: enrolled() }), {
				listTags: l.list,
				readTag: l.read,
				onWarn: (m) => warnings.push(m),
			});

			expect(l.calls).toEqual([]);
			expect((await candidates(db)).length).toBe(0);
			expect(warnings.length).toBe(1);
		});
	});

	test("records the forge commit date on the candidate row", async () => {
		await withTestDb(async (db) => {
			const created = new Date("2026-09-01T10:11:12.000Z");
			const l = lister([{ name: "v1.2.3", commitSha: "c".repeat(40), commitCreatedAt: created }]);

			await runBuildBumpIntake(db, config({ buildBump: enrolled() }), {
				listTags: l.list,
				readTag: l.read,
			});

			expect(await candidateDates(db)).toEqual([{ tag: "v1.2.3", tagCreatedAt: created }]);
		});
	});

	test("a tag with no commit date records NULL, never a fabricated one", async () => {
		await withTestDb(async (db) => {
			const l = lister([{ name: "v1.2.3", commitSha: "c".repeat(40) }]);

			await runBuildBumpIntake(db, config({ buildBump: enrolled() }), {
				listTags: l.list,
				readTag: l.read,
			});

			expect(await candidateDates(db)).toEqual([{ tag: "v1.2.3", tagCreatedAt: null }]);
		});
	});
	test("an existing UNDATED candidate is backfilled once the forge sends a date", async () => {
		await withTestDb(async (db) => {
			const sha = "c".repeat(40);
			const cfg = config({ buildBump: enrolled() });
			// Pass one: the forge omits the date, exactly like the rows migration
			// 0021 left NULL.
			await runBuildBumpIntake(db, cfg, {
				listTags: lister([{ name: "v1.2.3", commitSha: sha }]).list,
				readTag: reader("absent").read,
			});
			expect(await candidateDates(db)).toEqual([{ tag: "v1.2.3", tagCreatedAt: null }]);

			const created = new Date("2026-09-02T03:04:05.000Z");
			await runBuildBumpIntake(db, cfg, {
				listTags: lister([{ name: "v1.2.3", commitSha: sha, commitCreatedAt: created }]).list,
				readTag: reader("absent").read,
			});

			expect(await candidateDates(db)).toEqual([{ tag: "v1.2.3", tagCreatedAt: created }]);
			// Still ONE row: the backfill updates, it never inserts a duplicate.
			expect((await candidates(db)).length).toBe(1);
		});
	});

	test("a candidate that already carries a date is never rewritten", async () => {
		await withTestDb(async (db) => {
			const sha = "c".repeat(40);
			const first = new Date("2026-09-01T00:00:00.000Z");
			const cfg = config({ buildBump: enrolled() });
			await runBuildBumpIntake(db, cfg, {
				listTags: lister([{ name: "v1.2.3", commitSha: sha, commitCreatedAt: first }]).list,
				readTag: reader("absent").read,
			});

			// A forge answering a DIFFERENT date for the same tag/sha must not move
			// the stored one: the backfill is for the unknown, not a re-sync.
			await runBuildBumpIntake(db, cfg, {
				listTags: lister([
					{ name: "v1.2.3", commitSha: sha, commitCreatedAt: new Date("2026-01-01T00:00:00Z") },
				]).list,
				readTag: reader("absent").read,
			});

			expect(await candidateDates(db)).toEqual([{ tag: "v1.2.3", tagCreatedAt: first }]);
		});
	});

	test("a declared marker present on the forge becomes exactly one row at its sha", async () => {
		await withTestDb(async (db) => {
			const cfg = config({ buildBump: twoEnvironments() });
			const first = "1".repeat(40);
			const second = "2".repeat(40);

			const one = lister([
				{ name: "v1.0.0", commitSha: first },
				{ name: "prod", commitSha: first },
			]);
			await runBuildBumpIntake(db, cfg, { listTags: one.list, readTag: one.read });
			expect(await markers(db)).toEqual([{ repository: "rodaddy/x", marker: "prod", sha: first }]);
			// The marker was resolved BY NAME, not found in the listing.
			expect(one.reads).toEqual(["rodaddy/x#prod"]);

			// The marker MOVED — onto a different commit, which is a legitimate
			// deploy of that version and must update the one row, not add a second.
			const two = lister([
				{ name: "v1.0.0", commitSha: first },
				{ name: "v2.0.0", commitSha: second },
				{ name: "prod", commitSha: second },
			]);
			await runBuildBumpIntake(db, cfg, { listTags: two.list, readTag: two.read });
			expect(await markers(db)).toEqual([{ repository: "rodaddy/x", marker: "prod", sha: second }]);

			// The marker was DELETED on the forge — the named read answers 404 — and
			// the projection follows it away.
			const gone = lister([{ name: "v2.0.0", commitSha: second }]);
			await runBuildBumpIntake(db, cfg, { listTags: gone.list, readTag: gone.read });
			expect(await markers(db)).toEqual([]);
		});
	});

	test("a marker beyond the bounded page is still upserted, from the named lookup", async () => {
		// THE REGRESSION (swarm P1). The version listing is ONE page of 50 tags. A
		// repository with more than 50 tags carries its `prod` marker on page two,
		// so the marker is absent from everything the listing can see. Deciding
		// absence from page membership deleted that row on every pass and the
		// environment could never move. The named lookup is the only evidence.
		await withTestDb(async (db) => {
			const cfg = config({ buildBump: twoEnvironments() });
			const markerSha = "9".repeat(40);
			// A full page of 50 version tags, and `prod` is NOT among them.
			const page: ForgejoTag[] = Array.from({ length: 50 }, (_, i) => ({
				name: `v2.${i}.0`,
				commitSha: String(i % 10).repeat(40),
			}));
			expect(page.some((tag) => tag.name === "prod")).toBe(false);

			const l = lister(page);
			const r = reader({ name: "prod", commitSha: markerSha });
			await runBuildBumpIntake(db, cfg, { listTags: l.list, readTag: r.read });

			expect(await markers(db)).toEqual([
				{ repository: "rodaddy/x", marker: "prod", sha: markerSha },
			]);
			expect(r.reads).toEqual(["rodaddy/x#prod"]);
		});
	});

	test("a named lookup answering absent deletes the marker row", async () => {
		await withTestDb(async (db) => {
			const cfg = config({ buildBump: twoEnvironments() });
			const sha = "1".repeat(40);
			const seed = lister([
				{ name: "v1.0.0", commitSha: sha },
				{ name: "prod", commitSha: sha },
			]);
			await runBuildBumpIntake(db, cfg, { listTags: seed.list, readTag: seed.read });
			expect(await markers(db)).toEqual([{ repository: "rodaddy/x", marker: "prod", sha }]);

			// The forge answered 404 for the name: the tag genuinely is not there.
			const l = lister([{ name: "v1.0.0", commitSha: sha }]);
			await runBuildBumpIntake(db, cfg, { listTags: l.list, readTag: reader("absent").read });

			expect(await markers(db)).toEqual([]);
		});
	});

	test("a FAILED named lookup leaves the marker row exactly as it was", async () => {
		// `null` is "unknown", never "absent". A transient forge error must not
		// delete a marker the forge still carries.
		await withTestDb(async (db) => {
			const cfg = config({ buildBump: twoEnvironments() });
			const sha = "1".repeat(40);
			const seed = lister([
				{ name: "v1.0.0", commitSha: sha },
				{ name: "prod", commitSha: sha },
			]);
			await runBuildBumpIntake(db, cfg, { listTags: seed.list, readTag: seed.read });

			const l = lister([{ name: "v1.0.0", commitSha: sha }]);
			await runBuildBumpIntake(db, cfg, { listTags: l.list, readTag: reader(null).read });

			expect(await markers(db)).toEqual([{ repository: "rodaddy/x", marker: "prod", sha }]);
		});
	});

	test("a tag no environment declares is never stored as a marker", async () => {
		await withTestDb(async (db) => {
			// ONE environment, so the enrolment declares NO marker at all — the tag
			// `prod` here is just a tag on the repository.
			const cfg = config({
				buildBump: {
					environments: [{ name: "live", app_dirs: ["hello"] }],
					tag_pattern: "v*",
				},
			});
			const sha = "1".repeat(40);

			const l = lister([
				{ name: "v1.0.0", commitSha: sha },
				{ name: "prod", commitSha: sha },
			]);
			await runBuildBumpIntake(db, cfg, { listTags: l.list, readTag: l.read });

			expect(await markers(db)).toEqual([]);
			// The declared set is the allowlist: nothing was even looked up.
			expect(l.reads).toEqual([]);
		});
	});

	test("an explicit marker name is what is read, never the environment's name", async () => {
		await withTestDb(async (db) => {
			const cfg = config({
				buildBump: {
					environments: [
						{ name: "live", app_dirs: ["hello"] },
						{ name: "staging", app_dirs: ["hello-staging"], promote: "marker", marker: "stage" },
					],
					tag_pattern: "v*",
				},
			});
			const wanted = "1".repeat(40);
			const other = "2".repeat(40);

			const l = lister([
				{ name: "v1.0.0", commitSha: wanted },
				{ name: "stage", commitSha: wanted },
				{ name: "staging", commitSha: other },
			]);
			await runBuildBumpIntake(db, cfg, { listTags: l.list, readTag: l.read });

			expect(await markers(db)).toEqual([
				{ repository: "rodaddy/x", marker: "stage", sha: wanted },
			]);
			expect(l.reads).toEqual(["rodaddy/x#stage"]);
		});
	});

	test("a marker row the configuration no longer declares is removed next pass", async () => {
		// THE DEFECT. The declared loop can only clear a marker the FORGE dropped.
		// A marker the CONFIGURATION dropped — an environment renamed or removed —
		// was never visited, so its row outlived its declaration forever. The table
		// is a projection of the enrolment, so the declared set is the allowlist in
		// both directions.
		await withTestDb(async (db) => {
			const sha = "1".repeat(40);
			const two = config({
				buildBump: {
					environments: [
						{ name: "live", app_dirs: ["hello"] },
						{ name: "stage", app_dirs: ["hello-stage"] },
						{ name: "prod", app_dirs: ["hello-prod"] },
					],
					tag_pattern: "v*",
				},
			});
			const seed = lister([
				{ name: "v1.0.0", commitSha: sha },
				{ name: "stage", commitSha: sha },
				{ name: "prod", commitSha: sha },
			]);
			await runBuildBumpIntake(db, two, { listTags: seed.list, readTag: seed.read });
			expect(await markers(db)).toEqual([
				{ repository: "rodaddy/x", marker: "prod", sha },
				{ repository: "rodaddy/x", marker: "stage", sha },
			]);

			// `stage` is dropped from the enrolment. The tag is STILL on the forge —
			// what changed is only that no environment declares it any more.
			const one = config({
				buildBump: {
					environments: [
						{ name: "live", app_dirs: ["hello"] },
						{ name: "prod", app_dirs: ["hello-prod"] },
					],
					tag_pattern: "v*",
				},
			});
			const next = lister([
				{ name: "v1.0.0", commitSha: sha },
				{ name: "stage", commitSha: sha },
				{ name: "prod", commitSha: sha },
			]);
			await runBuildBumpIntake(db, one, { listTags: next.list, readTag: next.read });

			expect(await markers(db)).toEqual([{ repository: "rodaddy/x", marker: "prod", sha }]);
			// Only the still-declared marker was looked up at all.
			expect(next.reads).toEqual(["rodaddy/x#prod"]);
		});
	});

	test("an enrolment that drops every marker ends with zero rows", async () => {
		// The empty-declared-set branch: `notInArray` with an empty list is invalid
		// SQL, so this case must delete every row for the repository instead.
		await withTestDb(async (db) => {
			const sha = "1".repeat(40);
			const seed = lister([
				{ name: "v1.0.0", commitSha: sha },
				{ name: "prod", commitSha: sha },
			]);
			await runBuildBumpIntake(db, config({ buildBump: twoEnvironments() }), {
				listTags: seed.list,
				readTag: seed.read,
			});
			expect(await markers(db)).toEqual([{ repository: "rodaddy/x", marker: "prod", sha }]);

			// Back to the single-environment common case: no environment promotes by
			// marker, so the repository declares none.
			const single = config({
				buildBump: {
					environments: [{ name: "live", app_dirs: ["hello"] }],
					tag_pattern: "v*",
				},
			});
			const next = lister([
				{ name: "v1.0.0", commitSha: sha },
				{ name: "prod", commitSha: sha },
			]);
			await runBuildBumpIntake(db, single, { listTags: next.list, readTag: next.read });

			expect(await markers(db)).toEqual([]);
			expect(next.reads).toEqual([]);
		});
	});

	test("a failed tag LISTING skips the repository, markers included", async () => {
		// The listing failing skips the repository entirely for the pass — the
		// marker reconcile does not run at all, so the rows stand.
		await withTestDb(async (db) => {
			const cfg = config({ buildBump: twoEnvironments() });
			const sha = "1".repeat(40);
			const seed = lister([
				{ name: "v1.0.0", commitSha: sha },
				{ name: "prod", commitSha: sha },
			]);
			await runBuildBumpIntake(db, cfg, { listTags: seed.list, readTag: seed.read });

			const failed = lister(null);
			await runBuildBumpIntake(db, cfg, {
				listTags: failed.list,
				readTag: failed.read,
				onWarn: () => {},
			});

			expect(await markers(db)).toEqual([{ repository: "rodaddy/x", marker: "prod", sha }]);
			expect(failed.reads).toEqual([]);
		});
	});
});

/**
 * The matcher is pure — no db, no lister. The cases that matter are the length
 * guard's: it refuses a name shorter than prefix + suffix, where `startsWith`
 * and `endsWith` could both hold only by SHARING characters. A star matching the
 * empty string is legitimate and must still match.
 */
describe("matchesTagPattern", () => {
	test("refuses a name where prefix and suffix would share characters", () => {
		expect(matchesTagPattern("v", "v*v")).toBe(false);
	});

	test("allows the star to match the empty string", () => {
		expect(matchesTagPattern("v", "v*")).toBe(true);
		expect(matchesTagPattern("v.0", "v*.0")).toBe(true);
	});

	test("refuses a name that is missing the suffix", () => {
		expect(matchesTagPattern("v0", "v*.0")).toBe(false);
	});

	test("a starless pattern is an exact match", () => {
		expect(matchesTagPattern("v1.2.3", "v1.2.3")).toBe(true);
		expect(matchesTagPattern("v1.2.3", "v1.2.4")).toBe(false);
	});
});
