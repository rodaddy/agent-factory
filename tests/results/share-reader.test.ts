import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { ShareResultReader } from "../../src/results/share-reader";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

// Fixtures live under the portable temp workspace (Mac default or the runner's
// job-local override), cleaned up after the suite.
const tmpBase = testTmpBase();
const archive = testArchiveDir();
const shareRoot = mkdtempSync(join(tmpBase, "test-share-"));
const tempDirs: string[] = [shareRoot];

afterAll(() => {
	for (const dir of tempDirs) {
		renameSync(dir, join(archive, `${basename(dir)}-${Date.now()}`));
	}
});

/** Create a job dir under <shareRoot>/runners/jobs/<job>/<host>/ with files. */
function seedJobDir(job: string, host: string, files: Record<string, string>) {
	const dir = join(shareRoot, "runners", "jobs", job, host);
	mkdirSync(dir, { recursive: true });
	for (const [name, content] of Object.entries(files)) {
		writeFileSync(join(dir, name), content);
	}
	return dir;
}

describe("ShareResultReader", () => {
	const reader = new ShareResultReader(shareRoot);

	test("isDone reflects the DONE marker", async () => {
		seedJobDir("rw-pr-review-a", "host1", { DONE: "" });
		expect(await reader.isDone("rw-pr-review-a", "host1")).toBe(true);
		expect(await reader.isDone("rw-pr-review-a", "host-absent")).toBe(false);
		expect(await reader.isDone("rw-absent", "host1")).toBe(false);
	});

	test("listHosts discovers only bounded safe directories", async () => {
		seedJobDir("rw-discover", "host-b", { DONE: "" });
		seedJobDir("rw-discover", "host-a", { DONE: "" });
		writeFileSync(join(shareRoot, "runners", "jobs", "rw-discover", "not-a-host"), "");
		const hosts = await reader.listHosts("rw-discover", 1);
		expect(hosts).toHaveLength(1);
		const host = hosts[0];
		if (host === undefined) throw new Error("expected one discovered host");
		expect(["host-a", "host-b"]).toContain(host);
		expect(await reader.listHosts("missing", 8)).toEqual([]);
		expect(await reader.listHosts("../escape", 8)).toEqual([]);
	});

	test("readResult returns the file contents, or null when absent", async () => {
		seedJobDir("rw-pr-review-b", "host1", { "result.json": '{"ok":true}' });
		expect(await reader.readResult("rw-pr-review-b", "host1", 1024)).toBe('{"ok":true}');
		expect(await reader.readResult("rw-pr-review-b", "host-absent", 1024)).toBeNull();
	});

	test("readNamedResult reads the distinct artifact, not the wrapper result.json", async () => {
		// Reproduce the observed real collision: the runner wrapper owns and writes
		// its mechanical envelope to result.json, while the pre-push job writes the
		// watcher-schema result to the distinct validation-result.json. Reading the
		// named artifact must return the watcher schema, and the plain readResult
		// (result.json) must return only the wrapper envelope — never the reverse.
		seedJobDir("rw-prepush-artifact", "host1", {
			"result.json":
				'{"job_id":"rw-prepush-artifact","lane":"prepush","status":"done","host":"host1"}',
			"validation-result.json": '{"result_version":1,"status":"passed"}',
		});
		expect(
			await reader.readNamedResult("rw-prepush-artifact", "host1", "validation-result.json", 1024),
		).toBe('{"result_version":1,"status":"passed"}');
		// The wrapper envelope is NOT the watcher result.
		expect(await reader.readResult("rw-prepush-artifact", "host1", 1024)).toContain('"lane"');
		// A missing named artifact reads null even when result.json exists.
		expect(
			await reader.readNamedResult(
				"rw-prepush-artifact",
				"host-absent",
				"validation-result.json",
				1024,
			),
		).toBeNull();
	});

	test("readNamedResult rejects an unsafe or traversing filename", async () => {
		seedJobDir("rw-named-safety", "host1", { "validation-result.json": "{}" });
		for (const bad of ["..", ".", "a/b", "../result.json", "a\0b", ""]) {
			expect(await reader.readNamedResult("rw-named-safety", "host1", bad, 1024)).toBeNull();
		}
	});

	test("readResult caps the read at maxBytes+1 (oversized detectable)", async () => {
		const big = "x".repeat(5000);
		seedJobDir("rw-pr-review-c", "host1", { "result.json": big });
		const out = await reader.readResult("rw-pr-review-c", "host1", 100);
		expect(out).not.toBeNull();
		expect((out as string).length).toBe(101); // 100 + 1, not the full 5000
	});

	test("rejects unsafe path segments (traversal / separators)", async () => {
		for (const bad of ["..", ".", "a/b", "../escape", "a\0b"]) {
			expect(await reader.isDone(bad, "host1")).toBe(false);
			expect(await reader.readResult(bad, "host1", 1024)).toBeNull();
			expect(await reader.isDone("rw-x", bad)).toBe(false);
		}
	});

	test("rejects a symlinked DONE marker (lstat, regular-file only)", async () => {
		// A crafted job plants DONE as a symlink to a real file elsewhere. isDone must
		// lstat and accept ONLY a regular file, so the symlink is not treated as done.
		const dir = seedJobDir("rw-symlink-done", "host1", {});
		const realTarget = join(shareRoot, "real-done-target");
		writeFileSync(realTarget, "");
		symlinkSync(realTarget, join(dir, "DONE"));
		expect(await reader.isDone("rw-symlink-done", "host1")).toBe(false);
	});

	test("rejects a symlinked result.json (O_NOFOLLOW read returns null)", async () => {
		const dir = seedJobDir("rw-symlink-result", "host1", {});
		const realTarget = join(shareRoot, "real-result-target.json");
		writeFileSync(realTarget, '{"ok":true}');
		symlinkSync(realTarget, join(dir, "result.json"));
		expect(await reader.readResult("rw-symlink-result", "host1", 1024)).toBeNull();
	});

	test("rejects a symlinked validation-result.json (O_NOFOLLOW read returns null)", async () => {
		const dir = seedJobDir("rw-symlink-named", "host1", {});
		const realTarget = join(shareRoot, "real-validation-target.json");
		writeFileSync(realTarget, '{"result_version":1,"status":"passed"}');
		symlinkSync(realTarget, join(dir, "validation-result.json"));
		expect(
			await reader.readNamedResult("rw-symlink-named", "host1", "validation-result.json", 1024),
		).toBeNull();
	});

	test("rejects a symlinked <job-id> parent directory (real dir required)", async () => {
		// A crafted job plants its <job-id> entry as a symlink to a real, populated
		// directory elsewhere under the share. O_NOFOLLOW only guards the leaf, so the
		// parent components must be lstat-verified as real directories: isDone,
		// readNamedResult, and listHosts must all refuse the symlinked parent.
		const realDir = join(shareRoot, "runners", "jobs", "rw-real-target", "host1");
		mkdirSync(realDir, { recursive: true });
		writeFileSync(join(realDir, "DONE"), "");
		writeFileSync(join(realDir, "validation-result.json"), '{"ok":true}');
		symlinkSync(
			join(shareRoot, "runners", "jobs", "rw-real-target"),
			join(shareRoot, "runners", "jobs", "rw-symlink-job"),
		);

		expect(await reader.isDone("rw-symlink-job", "host1")).toBe(false);
		expect(
			await reader.readNamedResult("rw-symlink-job", "host1", "validation-result.json", 1024),
		).toBeNull();
		expect(await reader.listHosts("rw-symlink-job", 8)).toEqual([]);
	});

	test("rejects a symlinked <hostname> parent directory (real dir required)", async () => {
		// The <hostname> component is planted as a symlink to a real dir elsewhere.
		// isDone and readNamedResult must lstat-verify it as a real directory and
		// refuse the symlink even though it resolves to a populated directory.
		const realHostDir = join(shareRoot, "runners", "jobs", "rw-real-host", "real-host");
		mkdirSync(realHostDir, { recursive: true });
		writeFileSync(join(realHostDir, "DONE"), "");
		writeFileSync(join(realHostDir, "validation-result.json"), '{"ok":true}');
		const jobDir = join(shareRoot, "runners", "jobs", "rw-symlink-host");
		mkdirSync(jobDir, { recursive: true });
		symlinkSync(realHostDir, join(jobDir, "host1"));

		expect(await reader.isDone("rw-symlink-host", "host1")).toBe(false);
		expect(
			await reader.readNamedResult("rw-symlink-host", "host1", "validation-result.json", 1024),
		).toBeNull();
	});

	// sf#699: the wrapper flattens most artifacts to <job>/<host>/ but leaves the
	// agent event stream nested at out/events.jsonl. `readNamedResult` joins the
	// job/host dir to an isSafeSegment name, so it could never reach it — 133
	// streams on the share, zero where the reader looked, zero traces.
	test("readOutArtifact reads a nested out/ artifact readNamedResult cannot reach", async () => {
		const hostDir = seedJobDir("rw-outdir", "runner-1", {});
		const outDir = join(hostDir, "out");
		mkdirSync(outDir, { recursive: true });
		writeFileSync(join(outDir, "events.jsonl"), '{"type":"message_end"}\n');

		expect(await reader.readOutArtifact("rw-outdir", "runner-1", "events.jsonl", 4096)).toBe(
			'{"type":"message_end"}\n',
		);
		// The control: the flat reader still cannot see it, which is the defect.
		expect(await reader.readNamedResult("rw-outdir", "runner-1", "events.jsonl", 4096)).toBeNull();
		// And an absent out/ artifact is null, not a throw.
		expect(await reader.readOutArtifact("rw-outdir", "runner-1", "absent.jsonl", 4096)).toBeNull();
	});

	test("readOutArtifact rejects a symlinked out/ directory", async () => {
		// Mutation-proved 2026-09-10: dropping the isRealDir(outDir) guard makes this
		// case go red while the happy path above stays green.
		const evilDir = mkdtempSync(join(tmpBase, "test-evil-out-"));
		tempDirs.push(evilDir);
		writeFileSync(join(evilDir, "events.jsonl"), "leaked");
		const hostDir = seedJobDir("rw-symlink-out", "runner-1", {});
		symlinkSync(evilDir, join(hostDir, "out"));

		expect(
			await reader.readOutArtifact("rw-symlink-out", "runner-1", "events.jsonl", 4096),
		).toBeNull();
	});

	test("readOutArtifact rejects an unsafe filename and a traversing host", async () => {
		seedJobDir("rw-outdir-guard", "runner-1", {});
		expect(
			await reader.readOutArtifact("rw-outdir-guard", "runner-1", "../result.json", 4096),
		).toBeNull();
		expect(await reader.readOutArtifact("../escape", "runner-1", "events.jsonl", 4096)).toBeNull();
	});

	test("cannot read a sibling root that shares the jobsRoot prefix", async () => {
		// Seed a DONE under a sibling share root `<shareRoot>X` whose jobs path is a
		// string-prefix sibling of the legit reader's jobsRoot. The legit reader,
		// rooted at `shareRoot`, must never surface the sibling's DONE — proving the
		// containment guard uses a trailing separator, not a bare prefix match.
		const siblingRoot = `${shareRoot}X`;
		const siblingDir = join(siblingRoot, "runners", "jobs", "rw-sibling", "host1");
		mkdirSync(siblingDir, { recursive: true });
		writeFileSync(join(siblingDir, "DONE"), "");
		tempDirs.push(siblingRoot);

		// the legit reader has no such job under its own root
		expect(await reader.isDone("rw-sibling", "host1")).toBe(false);
		// and a reader correctly rooted at the sibling DOES see it (control)
		expect(await new ShareResultReader(siblingRoot).isDone("rw-sibling", "host1")).toBe(true);
	});
});
