import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { sql } from "drizzle-orm";
import { busResults } from "../../src/db/schema";
import { BusResultReader, DONE_ARTIFACT } from "../../src/results/bus-reader";
import { ShareResultReader } from "../../src/results/share-reader";
import { withTestDb } from "../db/helpers";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const tmpBase = testTmpBase();
const archive = testArchiveDir();
const roots: string[] = [];

afterAll(() => {
	for (const root of roots) {
		renameSync(root, join(archive, `${basename(root)}-${Date.now()}`));
	}
});

type TestDb = Parameters<Parameters<typeof withTestDb>[0]>[0];

/** Insert one drained bus artifact row for (job, host, artifact). */
async function seedBusRow(
	db: TestDb,
	jobRunnerId: string,
	hostname: string,
	artifact: string,
	body: string,
	msgId = `${jobRunnerId}-${hostname}-${artifact}`,
) {
	await db.insert(busResults).values({
		jobRunnerId,
		hostname,
		artifact,
		body,
		msgId,
		subject: `factory.jobs.${jobRunnerId}.result`,
	});
}

describe("BusResultReader", () => {
	test("a drained row is done, listed, and read back byte-identically", async () => {
		await withTestDb(async (db) => {
			const body = '{"result_version":1,"status":"passed"}';
			await seedBusRow(db, "rj-1", "runner-a", "result.json", body);
			await seedBusRow(db, "rj-1", "runner-a", DONE_ARTIFACT, "");
			const reader = new BusResultReader(db);

			expect(await reader.isDone("rj-1", "runner-a")).toBe(true);
			expect(await reader.listHosts("rj-1", 8)).toEqual(["runner-a"]);
			expect(await reader.readResult("rj-1", "runner-a", 1024)).toBe(body);
			expect(await reader.readNamedResult("rj-1", "runner-a", "result.json", 1024)).toBe(body);
		});
	});

	test("a named artifact other than result.json is read by its own name only", async () => {
		await withTestDb(async (db) => {
			await seedBusRow(db, "rj-2", "runner-a", "watcher-result.json", "named-body");
			const reader = new BusResultReader(db);

			expect(await reader.readNamedResult("rj-2", "runner-a", "watcher-result.json", 1024)).toBe(
				"named-body",
			);
			// result.json was never published for this (job, host): absent, not the
			// named artifact's body.
			expect(await reader.readResult("rj-2", "runner-a", 1024)).toBeNull();
			// An artifact row is NOT a completion attestation: only the DONE marker is.
			expect(await reader.isDone("rj-2", "runner-a")).toBe(false);
		});
	});

	test("an absent job/host reads as not done, no hosts, and no body", async () => {
		await withTestDb(async (db) => {
			const reader = new BusResultReader(db);
			expect(await reader.isDone("rj-absent", "runner-a")).toBe(false);
			expect(await reader.listHosts("rj-absent", 8)).toEqual([]);
			expect(await reader.readResult("rj-absent", "runner-a", 1024)).toBeNull();
			expect(await reader.readNamedResult("rj-absent", "runner-a", "result.json", 1024)).toBeNull();
		});
	});

	test("results are per (job, host): another host's row is never read for this host", async () => {
		await withTestDb(async (db) => {
			await seedBusRow(db, "rj-3", "runner-a", "result.json", "a-body");
			const reader = new BusResultReader(db);
			// PR #86 shape: a reader keyed on jobRunnerId alone would return runner-a's
			// body for runner-b and re-ingest every host's result.
			expect(await reader.readResult("rj-3", "runner-b", 1024)).toBeNull();
			expect(await reader.isDone("rj-3", "runner-b")).toBe(false);
		});
	});

	test("two hosts are both listed in id order and maxHosts bounds the list", async () => {
		await withTestDb(async (db) => {
			await seedBusRow(db, "rj-4", "runner-b", "result.json", "b-body");
			await seedBusRow(db, "rj-4", "runner-a", "result.json", "a-body");
			const reader = new BusResultReader(db);

			// Insert order, not alphabetical: `listHosts` orders by id.
			expect(await reader.listHosts("rj-4", 8)).toEqual(["runner-b", "runner-a"]);
			expect(await reader.listHosts("rj-4", 1)).toEqual(["runner-b"]);
			expect(await reader.listHosts("rj-4", 0)).toEqual([]);
		});
	});

	test("a duplicate host row does not list the host twice", async () => {
		await withTestDb(async (db) => {
			await seedBusRow(db, "rj-5", "runner-a", "result.json", "r");
			await seedBusRow(db, "rj-5", "runner-a", "watcher-result.json", "w");
			const reader = new BusResultReader(db);
			expect(await reader.listHosts("rj-5", 8)).toEqual(["runner-a"]);
		});
	});

	test("artifact rows alone are not done: only the DONE marker attests completion", async () => {
		await withTestDb(async (db) => {
			// The share path's DONE file is written AFTER every artifact, so a
			// partially-arrived host is never read. On the bus the runner publishes the
			// same ordering guarantee as a final `Factory-Artifact: DONE` message. An
			// isDone keyed on "any row exists" reads a host whose result.json landed
			// before its named artifact as done-with-artifact-missing, and
			// `reconcile.ts` never re-selects a failed attempt — the failure is
			// permanent.
			await seedBusRow(db, "rj-partial", "runner-a", "result.json", "{}");
			await seedBusRow(db, "rj-partial", "runner-a", "watcher-result.json", "named");
			const reader = new BusResultReader(db);
			expect(await reader.isDone("rj-partial", "runner-a")).toBe(false);

			await seedBusRow(db, "rj-partial", "runner-a", DONE_ARTIFACT, "");
			expect(await reader.isDone("rj-partial", "runner-a")).toBe(true);
			// Every stored artifact is still served once DONE exists.
			expect(await reader.readResult("rj-partial", "runner-a", 1024)).toBe("{}");
			expect(
				await reader.readNamedResult("rj-partial", "runner-a", "watcher-result.json", 1024),
			).toBe("named");
		});
	});

	test("a DONE marker with no artifact is done, and every stored artifact is still served", async () => {
		await withTestDb(async (db) => {
			// The share behaves the same way: a DONE file beside an empty directory
			// reads as done, and `classifyMissing` names the cause. An attempt sitting
			// pending forever is the worse outcome.
			await seedBusRow(db, "rj-done-only", "runner-a", DONE_ARTIFACT, "");
			const reader = new BusResultReader(db);
			expect(await reader.isDone("rj-done-only", "runner-a")).toBe(true);
			expect(await reader.readResult("rj-done-only", "runner-a", 1024)).toBeNull();
		});
	});

	test("DONE is per (job, host): one host's marker never completes another", async () => {
		await withTestDb(async (db) => {
			await seedBusRow(db, "rj-9", "runner-a", DONE_ARTIFACT, "");
			await seedBusRow(db, "rj-9", "runner-b", "result.json", "b-body");
			const reader = new BusResultReader(db);
			expect(await reader.isDone("rj-9", "runner-a")).toBe(true);
			// runner-b published an artifact but no DONE of its own.
			expect(await reader.isDone("rj-9", "runner-b")).toBe(false);
		});
	});

	test("an unsafe hostname row is skipped before it can consume the maxHosts budget", async () => {
		await withTestDb(async (db) => {
			// The share reader filters host DIRECTORIES with isSafeSegment while
			// enumerating, so an unsafe name never counts against the cap. Rows here
			// come from untrusted runner output, so the bus reader must filter in the
			// same place: eight unsafe rows stored first would otherwise fill a
			// maxHosts of 8 and hide the one real host entirely.
			for (let i = 0; i < 8; i += 1) {
				await seedBusRow(db, "rj-unsafe-hosts", `../x${i}`, "result.json", "junk");
			}
			await seedBusRow(db, "rj-unsafe-hosts", "runner-real", "result.json", "real");
			const reader = new BusResultReader(db);

			expect(await reader.listHosts("rj-unsafe-hosts", 8)).toEqual(["runner-real"]);
		});
	});

	test("an over-cap body returns exactly what the share reader returns", async () => {
		await withTestDb(async (db) => {
			const maxBytes = 16;
			// 40 bytes: comfortably past maxBytes+1, so the over-cap slice is visible.
			const body = "0123456789abcdefghijklmnopqrstuvwxyzABCD";
			await seedBusRow(db, "rj-6", "runner-a", "result.json", body);
			const busReader = new BusResultReader(db);

			// The SAME bytes on the share, read through the real ShareResultReader:
			// the two readers must not drift, because ingest's byte-cap refusal path
			// keys on the returned length.
			const shareRoot = mkdtempSync(join(tmpBase, "bus-reader-overcap-"));
			roots.push(shareRoot);
			const dir = join(shareRoot, "runners", "jobs", "rj-6", "runner-a");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "DONE"), "");
			writeFileSync(join(dir, "result.json"), body);
			const shareReader = new ShareResultReader(shareRoot);

			const fromShare = await shareReader.readResult("rj-6", "runner-a", maxBytes);
			const fromBus = await busReader.readResult("rj-6", "runner-a", maxBytes);
			expect(fromShare).not.toBeNull();
			expect(fromShare?.length).toBe(maxBytes + 1);
			expect(fromBus).toBe(fromShare as string);
		});
	});

	test("an over-cap MULTIBYTE body is cut in the same BYTES as the share reader", async () => {
		await withTestDb(async (db) => {
			// The ASCII case above cannot tell a byte slice from a character slice:
			// `String.slice(0, maxBytes + 1)` passes it. Here every character is 2-3
			// bytes and the cap falls INSIDE a UTF-8 sequence, so a character slice
			// returns a different (longer) byte string than the share's fixed-size
			// read. Bytes are compared, not strings: a lone replacement character
			// U+FFFD at the cut point compares equal to itself, and only the encoded
			// length distinguishes the two slicings.
			const maxBytes = 17;
			const body = "é日本".repeat(12);
			await seedBusRow(db, "rj-6-mb", "runner-a", "result.json", body);
			const busReader = new BusResultReader(db);

			const shareRoot = mkdtempSync(join(tmpBase, "bus-reader-overcap-mb-"));
			roots.push(shareRoot);
			const dir = join(shareRoot, "runners", "jobs", "rj-6-mb", "runner-a");
			mkdirSync(dir, { recursive: true });
			writeFileSync(join(dir, "DONE"), "");
			writeFileSync(join(dir, "result.json"), body);
			const shareReader = new ShareResultReader(shareRoot);

			const fromShare = await shareReader.readResult("rj-6-mb", "runner-a", maxBytes);
			const fromBus = await busReader.readResult("rj-6-mb", "runner-a", maxBytes);
			expect(fromShare).not.toBeNull();
			expect(fromBus).not.toBeNull();

			const encoder = new TextEncoder();
			const shareBytes = encoder.encode(fromShare as string);
			const busBytes = encoder.encode(fromBus as string);
			// The share read maxBytes+1 raw bytes off disk; the trailing partial
			// sequence decodes to U+FFFD, so the decoded string re-encodes LONGER than
			// the 18 bytes read. What matters is that both readers land on the same
			// bytes, and that neither returned the whole 72-byte body.
			expect(Array.from(busBytes)).toEqual(Array.from(shareBytes));
			expect(busBytes.byteLength).toBeLessThan(encoder.encode(body).byteLength);
		});
	});

	test("an unsafe path segment is refused without reaching the database", async () => {
		await withTestDb(async (db) => {
			await seedBusRow(db, "rj-7", "runner-a", "result.json", "body");
			// Rows whose stored key IS an unsafe segment. Without these the assertions
			// below would pass on ABSENCE (no row matches `../x`) rather than on the
			// guard, so removing `isSafeSegment` would leave the test green — observed:
			// mutation M4 was green until these rows existed.
			await seedBusRow(db, "../x", "runner-a", "result.json", "unsafe-job");
			await seedBusRow(db, "rj-7", "../x", "result.json", "unsafe-host");
			await seedBusRow(db, "rj-7", "runner-a", "../x", "unsafe-artifact");
			await seedBusRow(db, "rj-7", "runner-a", "a/b.json", "unsafe-separator");
			const reader = new BusResultReader(db);

			expect(await reader.listHosts("../x", 8)).toEqual([]);
			expect(await reader.isDone("../x", "runner-a")).toBe(false);
			expect(await reader.isDone("rj-7", "../x")).toBe(false);
			expect(await reader.readResult("../x", "runner-a", 1024)).toBeNull();
			expect(await reader.readResult("rj-7", "../x", 1024)).toBeNull();
			expect(await reader.readNamedResult("rj-7", "runner-a", "../x", 1024)).toBeNull();
			expect(await reader.readNamedResult("rj-7", "runner-a", "a/b.json", 1024)).toBeNull();
			// A stored row whose name is unsafe is never SERVED, even though it exists.
			expect(await reader.readResult("../x", "runner-a", 1024)).not.toBe("unsafe-job");
			expect(await reader.readResult("rj-7", "../x", 1024)).not.toBe("unsafe-host");
		});
	});

	test("a re-publish of the same (job, host, artifact) is refused by the unique index", async () => {
		await withTestDb(async (db) => {
			await seedBusRow(db, "rj-8", "runner-a", "result.json", "first", "msg-1");

			// Drizzle's own message carries only the failed query, so the constraint
			// name and SQLSTATE are read off the driver error underneath it — the same
			// shape `tests/db/client.test.ts` uses, and the reason AGENTS.md warns that
			// Bun.sql puts SQLSTATE in `errno`, never `code`.
			let caught: unknown;
			try {
				await seedBusRow(db, "rj-8", "runner-a", "result.json", "second", "msg-2");
			} catch (error) {
				caught = error;
			}
			expect(caught).toBeInstanceOf(Error);
			const cause = (caught as { cause?: { errno?: string; message?: string } }).cause;
			// 23505 = unique_violation.
			expect(cause?.errno).toBe("23505");
			expect(cause?.message).toContain("bus_results_job_host_artifact_key");

			const rows = await db
				.select()
				.from(busResults)
				.where(sql`${busResults.jobRunnerId} = 'rj-8'`);
			expect(rows).toHaveLength(1);
			expect(rows[0]?.body).toBe("first");
		});
	});
});
