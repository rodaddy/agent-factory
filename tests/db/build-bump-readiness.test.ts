/**
 * @module tests/db/build-bump-readiness
 * @description Pins the three readiness-observation columns added to
 *   `build_bump_bumps` by sf#620 (`ready_seconds`, `ready_restart_count`,
 *   `ready_sample_count`).
 *
 *   The whole point of these tests is the NULL-vs-zero distinction. NULL means
 *   "never measured"; 0 means "measured and instant". A `.default(0)` anywhere
 *   on these columns collapses the two claims into one and is the defect this
 *   file exists to catch, so the assertions below distinguish an unwritten
 *   column from a written zero rather than merely checking the columns exist.
 */
import { describe, expect, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { type BuildBumpBumpRow, buildBumpBumps, buildBumpCandidates } from "../../src/db/schema";
import { withTestDb } from "./helpers";

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

const SHA = "e".repeat(40);
const REPO = "acme/web-bb-landing";

/** Insert one candidate row and return its id. */
async function seedCandidate(db: TestDb): Promise<number> {
	const [row] = await db
		.insert(buildBumpCandidates)
		.values({
			repository: REPO,
			image: "web-bb-landing",
			tag: "v9.9.9",
			sha: SHA,
			status: "built",
			buildJobName: "build-web-bb-landing-zzz99",
		})
		.returning({ id: buildBumpCandidates.id });
	if (!row) throw new Error("candidate seed insert returned no row");
	return row.id;
}

/** Read every bump row for a candidate, in insert order. */
async function rows(db: TestDb, candidateId: number) {
	return await db
		.select()
		.from(buildBumpBumps)
		.where(eq(buildBumpBumps.candidateId, candidateId))
		.orderBy(asc(buildBumpBumps.id));
}

describe("build_bump_bumps readiness observation columns", () => {
	test("(1) the three columns exist on the inferred select type", () => {
		// A compile-time assertion: if a column is missing from the table
		// definition, `keyof BuildBumpBumpRow` does not include it and typecheck
		// refuses. The runtime expectation pins the same names against the
		// drizzle column map so a rename is caught by the test run too.
		const keys: Array<keyof BuildBumpBumpRow> = [
			"readySeconds",
			"readyRestartCount",
			"readySampleCount",
		];
		expect(keys).toEqual(["readySeconds", "readyRestartCount", "readySampleCount"]);
		expect(Object.keys(buildBumpBumps)).toContain("readySeconds");
		expect(Object.keys(buildBumpBumps)).toContain("readyRestartCount");
		expect(Object.keys(buildBumpBumps)).toContain("readySampleCount");
	});

	test("(2) a row inserted without them reads back NULL on all three", async () => {
		await withTestDb(async (db) => {
			const id = await seedCandidate(db);
			await db.insert(buildBumpBumps).values({
				candidateId: id,
				appDir: "landing",
				status: "pending",
			});

			const row = (await rows(db, id))[0];
			if (!row) throw new Error("no bump row inserted");
			// Never measured. A `.default(0)` on any of these would make this read
			// back 0 and silently claim an instant deploy was observed.
			expect(row.readySeconds).toBeNull();
			expect(row.readyRestartCount).toBeNull();
			expect(row.readySampleCount).toBeNull();
		});
	});

	test("(3) an explicit zero reads back 0, not NULL", async () => {
		await withTestDb(async (db) => {
			const id = await seedCandidate(db);
			await db.insert(buildBumpBumps).values({
				candidateId: id,
				appDir: "landing",
				status: "opened",
				readySeconds: 0,
				readyRestartCount: 0,
				readySampleCount: 1,
			});

			const row = (await rows(db, id))[0];
			if (!row) throw new Error("no bump row inserted");
			// Measured and instant. Distinct from case (2)'s never-measured NULL:
			// `toBe(0)` fails on null, and `toBeNull` fails on 0, so the two tests
			// together cannot both pass under a single collapsed representation.
			expect(row.readySeconds).toBe(0);
			expect(row.readySeconds).not.toBeNull();
			expect(row.readyRestartCount).toBe(0);
			// n=1 is a MEASUREMENT, not an average; a reader distinguishes the two
			// by this count, so it is stored as given rather than normalised away.
			expect(row.readySampleCount).toBe(1);
		});
	});
});
