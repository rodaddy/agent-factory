import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
	FIXED_REVIEW_PROMPT,
	parsePreparationManifest,
} from "../../fleet/review/preparation-contract.ts";

const sample = JSON.parse(
	readFileSync(
		new URL("../../fleet/review/contracts/manifest-v1.example.json", import.meta.url),
		"utf8",
	),
);
const binding = {
	repo: sample.repo,
	pr: sample.pr,
	baseSha: sample.baseSha,
	headSha: sample.headSha,
};
const bytes = (m: unknown) => Buffer.from(JSON.stringify(m));
const check = (m: unknown) => parsePreparationManifest(bytes(m), binding);

test("canonical wire example accepts; protected binding mismatch refuses", () => {
	assert.equal(check(sample).ok, true);
	assert.deepEqual(parsePreparationManifest(bytes(sample), { ...binding, pr: 2 }), {
		ok: false,
		reason: "binding",
	});
});
test("exact inventory rejects duplicate, unsafe, mismatched and prefix paths", () => {
	for (const path of [
		"../README.md",
		"/README.md",
		"head/../README.md",
		"head\\README.md",
		"head/\u007f",
		"head/\ud800",
	]) {
		const m = structuredClone(sample);
		m.files[3].path = path;
		assert.equal(check(m).ok, false, path);
	}
	const duplicate = structuredClone(sample);
	duplicate.files.push(duplicate.files[3]);
	assert.deepEqual(check(duplicate), { ok: false, reason: "inventory" });
	const mismatch = structuredClone(sample);
	mismatch.files[3].repoPath = "other";
	assert.deepEqual(check(mismatch), { ok: false, reason: "inventory" });
});
test("materialized symlink records accept only exact mode and no extra fields", () => {
	const m = structuredClone(sample);
	m.files[3].kind = "symlink";
	m.files[3].gitMode = "120000";
	assert.equal(check(m).ok, true);
	m.files[3].gitMode = "100644";
	assert.equal(check(m).ok, false);
	m.files[3].gitMode = "120000";
	m.nonce = "caller supplied";
	assert.equal(check(m).ok, false);
});
test("unchanged gitlinks have both sides; additions and changed object IDs hold", () => {
	const m = structuredClone(sample);
	m.gitlinks = ["base", "head"].map((side) => ({
		repoPath: "vendor",
		side,
		gitMode: "160000",
		objectOid: "c".repeat(40),
	}));
	assert.equal(check(m).ok, true);
	m.gitlinks[1].objectOid = "d".repeat(40);
	assert.deepEqual(check(m), { ok: false, reason: "changed_gitlink" });
	m.gitlinks.shift();
	assert.deepEqual(check(m), { ok: false, reason: "changed_gitlink" });
});
test("bounds and strict UTF8 fail closed", () => {
	const m = structuredClone(sample);
	m.files[1].bytes = 1_048_577;
	assert.deepEqual(check(m), { ok: false, reason: "bounds" });
	assert.deepEqual(parsePreparationManifest(new Uint8Array([0xff]), binding), {
		ok: false,
		reason: "schema",
	});
});
test("prompt artifact is exactly the literal supplied to the launcher", () => {
	assert.equal(
		readFileSync(
			new URL("../../fleet/review/contracts/fixed-review-prompt.txt", import.meta.url),
			"utf8",
		),
		FIXED_REVIEW_PROMPT,
	);
});

test("NFC collisions and file/directory prefix conflicts hold", () => {
	const m = structuredClone(sample);
	const one = { ...m.files[3], path: "head/café", repoPath: "café" };
	const two = { ...m.files[3], path: "head/cafe\u0301", repoPath: "cafe\u0301" };
	m.files.push(one, two);
	m.files.sort((a: { path: string }, b: { path: string }) =>
		Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
	);
	assert.deepEqual(check(m), { ok: false, reason: "inventory" });
	const prefix = structuredClone(sample);
	prefix.files.push({
		...prefix.files[3],
		path: "head/README.md/child",
		repoPath: "README.md/child",
	});
	assert.deepEqual(check(prefix), { ok: false, reason: "inventory" });
});

test("gitlink path identity preserves raw Unicode across sides", () => {
	const m = structuredClone(sample);
	m.gitlinks = ["base", "head"].map((side) => ({
		repoPath: "caf\u00e9",
		side,
		gitMode: "160000",
		objectOid: "c".repeat(40),
	}));
	assert.equal(check(m).ok, true);
	m.gitlinks[1].repoPath = "cafe\u0301";
	assert.deepEqual(check(m), { ok: false, reason: "changed_gitlink" });
});

test("a materialized file cannot be an ancestor of a gitlink", () => {
	const m = structuredClone(sample);
	m.files.push({ ...m.files[0], path: "base/sub", repoPath: "sub" });
	m.files.sort((a: { path: string }, b: { path: string }) =>
		Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
	);
	m.gitlinks = ["base", "head"].map((side) => ({
		repoPath: "sub-other/nested",
		side,
		gitMode: "160000",
		objectOid: "c".repeat(40),
	}));
	assert.equal(check(m).ok, true);
	for (const link of m.gitlinks) link.repoPath = "sub/nested";
	assert.deepEqual(check(m), { ok: false, reason: "changed_gitlink" });
});

test("valid manifest normalization work grows with records, not file/gitlink pairs", () => {
	const m = structuredClone(sample);
	m.files = m.files.filter((f: { kind: string }) => f.kind === "artifact");
	m.gitlinks = [];
	for (const side of ["base", "head"]) {
		for (let i = 0; i < 64; i++) {
			const suffix = String(i).padStart(3, "0");
			const repoPath = `source/cafe\u0301-${suffix}/file.ts`;
			m.files.push({ ...sample.files[0], side, path: `${side}/${repoPath}`, repoPath });
			m.gitlinks.push({
				side,
				repoPath: `vendor/cafe\u0301-${suffix}`,
				gitMode: "160000",
				objectOid: "c".repeat(40),
			});
		}
	}
	m.files.sort((a: { path: string }, b: { path: string }) =>
		Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
	);
	const input = bytes(m);
	const original = String.prototype.normalize;
	let normalizations = 0;
	let result: ReturnType<typeof parsePreparationManifest>;
	try {
		String.prototype.normalize = function (this: string, form?: string) {
			normalizations++;
			return original.call(this, form);
		};
		result = parsePreparationManifest(input, binding);
	} finally {
		String.prototype.normalize = original;
	}
	assert.equal(result.ok, true);
	// Count work, not wall time: the old Cartesian scan exceeds this by orders of magnitude.
	assert.ok(
		normalizations <= 4 * (m.files.length + m.gitlinks.length),
		`normalizations=${normalizations}`,
	);
});

test("gitlink/file conflicts use normalized membership and ancestors but respect path boundaries", () => {
	for (const [filePath, linkPath, accepted] of [
		["cafe\u0301", "café", false],
		["cafe\u0301/nested/file", "café", false],
		["cafe\u0301", "café/nested/link", false],
		["cafe\u0301-other/file", "café", true],
		["cafe\u0301", "café-other/nested", true],
	] as const) {
		const m = structuredClone(sample);
		m.files.push({ ...sample.files[0], path: `base/${filePath}`, repoPath: filePath });
		m.files.sort((a: { path: string }, b: { path: string }) =>
			Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)),
		);
		m.gitlinks = ["base", "head"].map((side) => ({
			side,
			repoPath: linkPath,
			gitMode: "160000",
			objectOid: "c".repeat(40),
		}));
		const result = check(m);
		assert.equal(result.ok, accepted, `${filePath} vs ${linkPath}`);
		if (!accepted) assert.deepEqual(result, { ok: false, reason: "changed_gitlink" });
	}
});
