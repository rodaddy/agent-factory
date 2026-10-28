/** Offline intake boundaries; no Forge, hosts or provider requests. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { test } from "node:test";
import {
	buildRequestPacket,
	validateRequestPacket,
	validateRequestResult,
	parseRequestUrl,
} from "./request-packet.mjs";
import { freezeRequest, main, requestErrorCategory } from "./request-cli.mjs";
const url = "https://forge.example.internal/rodaddy/software-factory/pulls/123";
const pr = {
	number: 123,
	title: "Fix",
	state: "open",
	merged: false,
	base: { sha: "a".repeat(40) },
	head: { sha: "b".repeat(40) },
};
const diff =
	"diff --git a/src/x.ts b/src/x.ts\nindex 1111111..2222222 100644\n--- a/src/x.ts\n+++ b/src/x.ts\n@@ -1 +1 @@\n-old\n+new\n";
const fixture = () => ({ url, prBefore: pr, prAfter: pr, diff, mergeBase: "c".repeat(40) });
test("CLI error categories preserve actionable refusals and hide arbitrary payloads", () => {
	assert.equal(requestErrorCategory(new Error("request_packet_size")), "request_packet_size");
	assert.equal(
		requestErrorCategory(new Error("request_admission_limit")),
		"request_admission_limit",
	);
	assert.equal(
		requestErrorCategory(new Error("postgres://secret request_password_leaked")),
		"command_refused_or_failed",
	);
});
test("frozen packet and scoped results preserve useful outputs", () => {
	const sealed = buildRequestPacket(fixture());
	assert.equal(
		validateRequestPacket(sealed.packet, { expectedHash: sealed.packetHash }).packetHash,
		sealed.packetHash,
	);
	assert.deepEqual(sealed.packet.allowedPaths, ["src/x.ts"]);
	assert.deepEqual(
		validateRequestResult('{"summary":"No defects","findings":[]}', sealed.packet).findings,
		[],
	);
	const finding = {
		summary: "Bug",
		findings: [{ severity: "P1", path: "src/x.ts", line: 1, explanation: "Concrete trigger" }],
	};
	assert.equal(validateRequestResult(JSON.stringify(finding), sealed.packet).findings[0].line, 1);
	finding.findings[0].line = 2;
	assert.throws(
		() => validateRequestResult(JSON.stringify(finding), sealed.packet),
		/shadow_finding_scope/,
	);
	assert.throws(
		() => validateRequestResult('{"summary":"x","findings":[],"verdict":"approve"}', sealed.packet),
		/shadow_result_schema/,
	);
});
test("foreign and malformed URLs refuse before Forge or admission", async () => {
	for (const bad of [
		url.replace("forge.example.internal", "evil.test"),
		`${url}?x=1`,
		url.replace("123", "0"),
		url.replace("software-factory", "open-brain"),
	]) {
		assert.throws(() => parseRequestUrl(bad), /request_url_refused/);
		await assert.rejects(
			freezeRequest(
				bad,
				{ repoPath: "/unused" },
				{ forge: () => assert.fail("Forge called"), git: () => assert.fail("git called") },
			),
			/request_url_refused/,
		);
	}
});
test("drift and oversized or unsupported diffs refuse without truncation", () => {
	assert.throws(
		() => buildRequestPacket({ ...fixture(), prAfter: { ...pr, head: { sha: "d".repeat(40) } } }),
		/request_pr_drift/,
	);
	assert.throws(
		() => buildRequestPacket({ ...fixture(), diff: diff.replace("+new", `+${"x".repeat(7000)}`) }),
		/request_packet_size/,
	);
	assert.throws(
		() =>
			buildRequestPacket({
				...fixture(),
				diff: "diff --git a/x b/y\nrename from x\nrename to y\n",
			}),
		/request_diff_unsupported/,
	);
	assert.throws(
		() => buildRequestPacket({ ...fixture(), diff: diff.replace("src/x.ts", "../x") }),
		/request_path_refused/,
	);
	const sealed = buildRequestPacket(fixture());
	assert.throws(
		() =>
			validateRequestPacket(
				{ ...sealed.packet, title: "Tampered" },
				{ expectedHash: sealed.packetHash },
			),
		/request_packet_seal/,
	);
});
test("freeze intake reads metadata twice around exact git diff and refuses changed head", async () => {
	let reads = 0;
	const calls = [];
	const boundaries = {
		forge: async () => (++reads === 1 ? pr : { ...pr, head: { sha: "e".repeat(40) } }),
		git: async (_path, args) => {
			calls.push(args);
			return args[0] === "remote"
				? "https://forge.example.internal/rodaddy/software-factory.git\n"
				: args[0] === "merge-base"
					? `${"c".repeat(40)}\n`
					: diff;
		},
	};
	await assert.rejects(freezeRequest(url, { repoPath: "/repo" }, boundaries), /request_pr_drift/);
	assert.equal(reads, 2);
	assert.ok(calls.find((args) => args[0] === "diff").includes("--no-ext-diff"));
});

test("readPrivateFile promptly refuses an actual FIFO", () => {
	const root =
		process.env.REQUEST_INTAKE_TEST_ROOT ??
		process.env.SF_TEST_RUN_DIR ??
		(process.platform === "darwin"
			? "/opt/_tmp/software-factory/_validation-runs/durable-request-H"
			: "/mnt/share/tmp_space/software-factory/_validation-runs/durable-request-H");
	assert.ok(
		root.startsWith("/opt/_tmp/") || root.startsWith("/mnt/share/tmp_space/"),
		"request_intake_test_root_refused",
	);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	const directory = `${root}/fifo-${crypto.randomUUID()}`;
	mkdirSync(directory, { mode: 0o700 });
	const fifo = `${directory}/private.fifo`;
	execFileSync("/usr/bin/mkfifo", ["-m", "600", fifo]);
	const code = `import assert from "node:assert/strict"; import { readPrivateFile } from ${JSON.stringify(new URL("./request-config.mjs", import.meta.url).href)}; assert.throws(() => readPrivateFile(${JSON.stringify(fifo)}), /request_private_file_refused/);`;
	execFileSync(process.execPath, ["--input-type=module", "--eval", code], {
		timeout: 2000,
		killSignal: "SIGKILL",
		stdio: "pipe",
	});
});

test("submit without a request key refuses before config, Forge or database reads", async () => {
	await assert.rejects(
		main([
			"--config",
			"/missing-private-config-never-read.json",
			"submit",
			url,
			"--family",
			"claude",
			"--target-host",
			"107",
		]),
		/request_submit_arguments/,
	);
});
