import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { parsePreparationManifest } from "../../fleet/review/preparation-contract.ts";
import { testTmpBase } from "../support/test-temp.ts";

const scratchRoot =
	process.env.REVIEW_PREPARE_TEST_ROOT ?? join(testTmpBase(), "review-prepare-tests");
mkdirSync(scratchRoot, { recursive: true });
const root = mkdtempSync(join(scratchRoot, "run-"));
const binary = join(root, "review-prepare");
const build = spawnSync(
	"bun",
	["build", "--compile", "fleet/review/prepare-cli.ts", "--outfile", binary],
	{ encoding: "utf8" },
);
assert.equal(build.status, 0, build.stderr);
function git(cwd: string, args: string[], input?: string): string {
	const r = spawnSync("/usr/bin/git", ["-c", "core.hooksPath=/dev/null", ...args], {
		cwd,
		input,
		encoding: "utf8",
		env: {
			PATH: "/usr/bin:/bin",
			HOME: root,
			GIT_CONFIG_NOSYSTEM: "1",
			GIT_CONFIG_GLOBAL: "/dev/null",
			GIT_AUTHOR_NAME: "fixture",
			GIT_AUTHOR_EMAIL: "fixture@example.invalid",
			GIT_COMMITTER_NAME: "fixture",
			GIT_COMMITTER_EMAIL: "fixture@example.invalid",
		},
	});
	assert.equal(r.status, 0, r.stderr);
	return r.stdout.trim();
}
function fixture() {
	const dir = mkdtempSync(join(root, "case-"));
	const repo = join(dir, "repo");
	mkdirSync(repo);
	git(repo, ["init", "--template="]);
	writeFileSync(join(repo, "README.md"), "base\n");
	writeFileSync(join(repo, ".gitattributes"), "*.md filter=hostile diff=hostile\n");
	symlinkSync("../../outside", join(repo, "link"));
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "base"]);
	const baseSha = git(repo, ["rev-parse", "HEAD"]);
	writeFileSync(join(repo, "README.md"), "head\n");
	git(repo, ["add", "."]);
	git(repo, ["commit", "-m", "head"]);
	const headSha = git(repo, ["rev-parse", "HEAD"]);
	const bundle = join(dir, "base.bundle");
	git(repo, ["bundle", "create", bundle, "--all"]);
	const packet = {
		version: 1,
		id: randomUUID(),
		lane: "gpt",
		model: "gpt-6.1-sol",
		thinking: "low",
		repo: "rodaddy/fixture",
		pr: 1,
		baseSha,
		headSha,
		nonce: "a".repeat(64),
		attemptId: "one",
		childRunId: "one",
		review: { title: "fixture", nested: { b: 2, a: 1 } },
	};
	return { dir, repo, bundle, packet };
}
type Fixture = ReturnType<typeof fixture>;
function invoke(f: Fixture, packet = f.packet, extraEnv = {}) {
	const input = join(f.dir, `${randomUUID()}.json`);
	writeFileSync(input, JSON.stringify(packet));
	const output = join(f.dir, `out-${randomUUID()}`);
	mkdirSync(output);
	const result = spawnSync(binary, [input, f.bundle, output], {
		encoding: "utf8",
		env: { ...process.env, ...extraEnv },
	});
	return { ...result, output };
}
function refused(r: ReturnType<typeof invoke>, reason: string) {
	assert.equal(r.status, 2, r.stderr);
	assert.equal(JSON.parse(r.stderr).reason, reason);
	assert.equal(existsSync(join(r.output, "manifest.json")), false);
}
test("compiled executable extracts exact blobs and identical common bytes for both lanes; inherited Git commands cannot run", () => {
	const f = fixture();
	const hostile = join(f.dir, "hostile.gitconfig");
	const marker = join(f.dir, "executed");
	writeFileSync(
		hostile,
		`[diff "hostile"]\ntextconv = touch ${marker}\n[filter "hostile"]\nsmudge = touch ${marker}\n`,
	);
	const a = invoke(f, f.packet, {
		GIT_CONFIG_GLOBAL: hostile,
		GIT_EXTERNAL_DIFF: `touch ${marker}`,
		GIT_DIR: f.repo,
	});
	assert.equal(a.status, 0, a.stderr);
	assert.equal(readFileSync(join(a.output, "head/README.md"), "utf8"), "head\n");
	assert.equal(readFileSync(join(a.output, "base/README.md"), "utf8"), "base\n");
	assert.equal(lstatSync(join(a.output, "head/link")).isFile(), true);
	assert.equal(readFileSync(join(a.output, "head/link"), "utf8"), "../../outside");
	assert.equal(existsSync(marker), false);
	assert.deepEqual(readdirSync(a.output).sort(), [
		"base",
		"context.json",
		"diff.patch",
		"head",
		"manifest.json",
	]);
	const b = invoke(f, {
		...f.packet,
		lane: "claude",
		model: "claude-sonnet-5-5",
		thinking: "medium",
		nonce: "b".repeat(64),
		childRunId: "two",
	});
	assert.equal(b.status, 0, b.stderr);
	for (const name of ["manifest.json", "context.json", "diff.patch"])
		assert.deepEqual(readFileSync(join(a.output, name)), readFileSync(join(b.output, name)));
	const bytes = readFileSync(join(a.output, "manifest.json"));
	const parsed = parsePreparationManifest(bytes, f.packet);
	assert.equal(parsed.ok, true);
	if (!parsed.ok) throw new Error("manifest refused");
	for (const file of parsed.manifest.files) {
		const content = readFileSync(join(a.output, file.path));
		assert.equal(content.length, file.bytes);
		assert.equal(createHash("sha256").update(content).digest("hex"), file.sha256);
	}
	assert.match(readFileSync(join(a.output, "diff.patch"), "utf8"), /\+head/);
});
test("prerequisite bundle and absent protected commit refuse before a completion manifest", () => {
	const f = fixture();
	git(f.repo, ["bundle", "create", f.bundle, `${f.packet.baseSha}..HEAD`]);
	refused(invoke(f), "git_rejected");
	git(f.repo, ["bundle", "create", f.bundle, "--all"]);
	refused(invoke(f, { ...f.packet, headSha: "f".repeat(40) }), "git_rejected");
});
test("changed gitlink holds; unchanged gitlink is metadata without a filesystem inode", () => {
	const f = fixture();
	git(f.repo, ["update-index", "--add", "--cacheinfo", `160000,${f.packet.baseSha},vendor`]);
	git(f.repo, ["commit", "-m", "gitlink"]);
	f.packet.headSha = git(f.repo, ["rev-parse", "HEAD"]);
	git(f.repo, ["bundle", "create", f.bundle, "--all"]);
	refused(invoke(f), "manifest_changed_gitlink");
	f.packet.baseSha = f.packet.headSha;
	const r = invoke(f);
	assert.equal(r.status, 0, r.stderr);
	assert.equal(existsSync(join(r.output, "head/vendor")), false);
	assert.equal(
		JSON.parse(readFileSync(join(r.output, "manifest.json"), "utf8")).gitlinks.length,
		2,
	);
});
test("unsafe Git paths are refused before extraction", () => {
	const f = fixture();
	const blob = git(f.repo, ["hash-object", "-w", "--stdin"], "evil");
	const tree = git(f.repo, ["mktree"], `100644 blob ${blob}\tbad\\name\n`);
	const commit = git(f.repo, ["commit-tree", tree, "-p", f.packet.baseSha], "unsafe\n");
	git(f.repo, ["update-ref", "refs/heads/unsafe", commit]);
	f.packet.headSha = commit;
	git(f.repo, ["bundle", "create", f.bundle, "--all"]);
	refused(invoke(f), "manifest_schema");
});
test("oversized blob is a named hold rather than truncated review input", () => {
	const f = fixture();
	writeFileSync(join(f.repo, "large"), Buffer.alloc(16_777_217, 65));
	git(f.repo, ["add", "."]);
	git(f.repo, ["commit", "-m", "large"]);
	f.packet.headSha = git(f.repo, ["rev-parse", "HEAD"]);
	git(f.repo, ["bundle", "create", f.bundle, "--all"]);
	refused(invoke(f), "file_bounds");
});
test("invalid packet and nonempty output refuse without changing existing output", () => {
	const f = fixture();
	refused(invoke(f, { ...f.packet, model: "unexpected" }), "packet_lane");
	const input = join(f.dir, "packet.json");
	writeFileSync(input, JSON.stringify(f.packet));
	const output = join(f.dir, "existing");
	mkdirSync(output);
	writeFileSync(join(output, "keep"), "keep");
	const result = spawnSync(binary, [input, f.bundle, resolve(output)], { encoding: "utf8" });
	assert.equal(result.status, 2);
	assert.equal(JSON.parse(result.stderr).reason, "output_not_empty_directory");
	assert.deepEqual(readdirSync(output), ["keep"]);
});
