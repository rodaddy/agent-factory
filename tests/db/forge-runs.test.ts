import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { forgeRuns } from "../../src/db/schema";
import {
	claimDispatch,
	DISPATCH_STALE_MINUTES,
	findDispatch,
	hasOpenVerbDispatch,
	recordDispatch,
	recordRunState,
	releaseDispatch,
	toRunState,
} from "../../src/forge/actions-store";
import { withTestDb } from "./helpers";

/** sf#476 (476a): forge_runs records each dispatched Actions run and its state. */
describe("forge_runs store", () => {
	test("recordDispatch inserts a dispatched row; recordRunState moves it by (repo, run_id)", async () => {
		await withTestDb(async (db) => {
			const id = await recordDispatch(db, {
				repo: "rodaddy/software-factory",
				workflow: "sop-gate.yml",
				runId: 7001,
				targetSha: "a".repeat(40),
				inputs: { pr: "12" },
			});
			expect(id).toBeNumber();
			const [row] = await db
				.select()
				.from(forgeRuns)
				.where(eq(forgeRuns.id, id as number));
			expect(row?.state).toBe("dispatched");
			expect(row?.inputs).toEqual({ pr: "12" });

			expect(await recordRunState(db, "rodaddy/software-factory", 7001, "running")).toBe(1);
			expect(await recordRunState(db, "rodaddy/software-factory", 9999, "success")).toBe(0);
			const [after] = await db
				.select()
				.from(forgeRuns)
				.where(eq(forgeRuns.id, id as number));
			expect(after?.state).toBe("running");
			expect(after?.updatedAt.getTime()).toBeGreaterThanOrEqual(row?.updatedAt.getTime() ?? 0);
		});
	}, 30_000);

	test("a second dispatch record for the same (repo, run_id) is a no-op; null run ids never collide", async () => {
		await withTestDb(async (db) => {
			const base = { repo: "o/r", workflow: "x.yml", targetSha: "b".repeat(40), inputs: {} };
			expect(await recordDispatch(db, { ...base, runId: 5 })).toBeNumber();
			expect(await recordDispatch(db, { ...base, runId: 5 })).toBeNull();
			expect(await recordDispatch(db, { ...base, runId: null })).toBeNumber();
			expect(await recordDispatch(db, { ...base, runId: null })).toBeNumber();
			expect(await db.select().from(forgeRuns)).toHaveLength(3);
		});
	}, 30_000);

	test("findDispatch matches repo, workflow, sha and contained inputs; failure/cancelled rows do not count", async () => {
		await withTestDb(async (db) => {
			const sha = "c".repeat(40);
			const query = {
				repo: "rodaddy/software-factory",
				workflow: "implement.yml",
				targetSha: sha,
				inputs: { repo: "rtech/app", number: "7" },
			};
			expect(await findDispatch(db, query)).toBeNull();
			await recordDispatch(db, {
				...query,
				runId: 41,
				inputs: { ...query.inputs, base_sha: sha, log_level: "info" },
			});
			expect(await findDispatch(db, query)).toBeNumber();
			expect(await findDispatch(db, { ...query, targetSha: "d".repeat(40) })).toBeNull();
			expect(
				await findDispatch(db, { ...query, inputs: { repo: "rtech/app", number: "8" } }),
			).toBeNull();
			expect(await findDispatch(db, { ...query, workflow: "issue-triage.yml" })).toBeNull();
			await recordRunState(db, "rodaddy/software-factory", 41, "failure");
			expect(await findDispatch(db, query)).toBeNull();
		});
	}, 30_000);

	test("toRunState maps Forgejo run statuses into the closed state set", () => {
		expect(toRunState("success")).toBe("success");
		expect(toRunState("failure")).toBe("failure");
		expect(toRunState("cancelled")).toBe("cancelled");
		expect(toRunState("running")).toBe("running");
		expect(toRunState("waiting")).toBe("waiting");
		expect(toRunState("blocked")).toBe("waiting");
		expect(toRunState("skipped")).toBe("unknown");
		expect(toRunState("anything-else")).toBe("unknown");
	});

	test("a runId-null `dispatched` row older than the stale window is not live for dedupe (sweep-F, PR 902)", async () => {
		await withTestDb(async (db) => {
			const sha = "c".repeat(40);
			const query = {
				repo: "rodaddy/software-factory",
				workflow: "verb.yml",
				targetSha: sha,
				inputs: { repo: "rtech/app", item: "7", verb: "newapp", manifest_sha: "a".repeat(64) },
			};
			const key = { repo: "rtech/app", item: 7, verb: "newapp", manifestSha: "a".repeat(64) };
			const id = await recordDispatch(db, { ...query, runId: null });
			if (id === null) throw new Error("seed failed");
			// Fresh: live for both readers.
			expect(await findDispatch(db, query)).toBe(id);
			expect(await hasOpenVerbDispatch(db, key)).toBe(true);
			// Older than the default window (30 min) and still no run: not live.
			await db
				.update(forgeRuns)
				.set({ dispatchedAt: new Date(Date.now() - 31 * 60_000) })
				.where(eq(forgeRuns.id, id));
			expect(DISPATCH_STALE_MINUTES).toBe(30);
			expect(await findDispatch(db, query)).toBeNull();
			expect(await hasOpenVerbDispatch(db, key)).toBe(false);
			// A wider window keeps it live.
			expect(await findDispatch(db, query, 60)).toBe(id);
			expect(await hasOpenVerbDispatch(db, key, 60)).toBe(true);
			// An old row that DID get a run id stays live.
			await db.update(forgeRuns).set({ runId: 99 }).where(eq(forgeRuns.id, id));
			expect(await findDispatch(db, query)).toBe(id);
			expect(await hasOpenVerbDispatch(db, key)).toBe(true);
		});
	}, 30_000);
});

/** sf#911: the write lands `inputs` as a jsonb OBJECT, so plain `inputs->>'k'` works. */
describe("forge_runs inputs shape", () => {
	test("recordDispatch stores inputs as a jsonb object", async () => {
		await withTestDb(async (db) => {
			const id = await recordDispatch(db, {
				repo: "o/r",
				workflow: "verb.yml",
				runId: null,
				targetSha: "e".repeat(40),
				inputs: { repo: "rtech/app", item: "3" },
			});
			const rows = await db.execute<{ t: string; repo: string | null }>(
				sql`select jsonb_typeof(inputs) as t, inputs->>'repo' as repo from forge_runs where id = ${id}`,
			);
			const row = [...(rows as unknown as Iterable<{ t: string; repo: string | null }>)][0];
			expect(row?.t).toBe("object");
			expect(row?.repo).toBe("rtech/app");
		});
	}, 30_000);
});

/** sf#911: a pre-fix row (inputs as a jsonb string scalar) is still found by both readers. */
describe("forge_runs old string-scalar rows", () => {
	test("findDispatch and hasOpenVerbDispatch match a string-scalar inputs row", async () => {
		await withTestDb(async (db) => {
			const inputs = { repo: "rtech/app", item: "5", verb: "implement", manifest_sha: "m1" };
			await db.insert(forgeRuns).values({
				repo: "o/r",
				workflow: "verb.yml",
				runId: 77,
				targetSha: "f".repeat(40),
				inputs: sql`to_jsonb(${JSON.stringify(inputs)}::text)`,
				state: "dispatched",
			});
			const key = { repo: "rtech/app", item: 5, verb: "implement", manifestSha: "m1" };
			expect(await hasOpenVerbDispatch(db, key)).toBe(true);
			const query = {
				repo: "o/r",
				workflow: "verb.yml",
				targetSha: "f".repeat(40),
				inputs: { item: "5" },
			};
			expect(await findDispatch(db, query)).toBeNumber();
		});
	}, 30_000);
});

describe("forge_runs atomic claim", () => {
	const rec = {
		repo: "rodaddy/software-factory",
		workflow: "prepush.yml",
		runId: null,
		targetSha: "e".repeat(40),
		inputs: { repo: "rtech/app", number: "4", head_sha: "e".repeat(40) },
	};
	const match = { repo: "rtech/app" };

	test("release leaves a settled run alone (PR 1037 review)", async () => {
		await withTestDb(async (db) => {
			const id = await claimDispatch(db, rec, match);
			await db
				.update(forgeRuns)
				.set({ state: "success" })
				.where(eq(forgeRuns.id, id as number));
			expect(await releaseDispatch(db, id as number)).toBe(0);
			const [row] = await db
				.select()
				.from(forgeRuns)
				.where(eq(forgeRuns.id, id as number));
			expect(row?.state).toBe("success");
		});
	});

	test("a claim for an already-recorded (repo, run_id) returns null (PR 1037 review)", async () => {
		await withTestDb(async (db) => {
			await recordDispatch(db, { ...rec, runId: 42 });
			const other = { ...rec, runId: 42, targetSha: "f".repeat(40) };
			expect(await claimDispatch(db, other, match)).toBeNull();
		});
	});

	test("sequential claims: id then null; after release a new id", async () => {
		await withTestDb(async (db) => {
			const first = await claimDispatch(db, rec, match);
			expect(first).toBeNumber();
			expect(await claimDispatch(db, rec, match)).toBeNull();
			expect(await releaseDispatch(db, first as number)).toBe(1);
			const again = await claimDispatch(db, rec, match);
			expect(again).toBeNumber();
			expect(again).not.toBe(first);
			const [row] = await db
				.select()
				.from(forgeRuns)
				.where(eq(forgeRuns.id, again as number));
			expect(row?.state).toBe("dispatched");
			expect(row?.inputs).toEqual(rec.inputs);
		});
	}, 30_000);

	test("5 concurrent claims on one key: exactly one wins", async () => {
		await withTestDb(async (db) => {
			const ids = await Promise.all(Array.from({ length: 5 }, () => claimDispatch(db, rec, match)));
			expect(ids.filter((id) => id !== null)).toHaveLength(1);
		});
	}, 30_000);
});
