/** Real Harness/SQLite/subprocess acceptance, loopback egress only. */
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { CAPS, MODELS } from "./proxy.mjs";
import { runShadow } from "./shadow.mjs";
import { PACKET_HASH, PACKET_PATH, sealPacket } from "./shadow-packet.mjs";

const scratch = process.env.SHADOW_TEST_ROOT;
assert.ok(scratch?.startsWith("/opt/_tmp/"), "explicit_shadow_scratch_required");
mkdirSync(scratch, { recursive: true });
const valid = JSON.stringify({ summary: "No concrete defect in supplied lines.", findings: [] });
async function endpoint(output = valid, mode = "ok") {
	const requests = [];
	let catalogs = 0;
	let base;
	const server = createServer(async (req, res) => {
		if (req.url === "/v1/models") {
			catalogs++;
			res.end(
				JSON.stringify({
					data: Object.values(MODELS).map((id) => ({
						id,
						name: id,
						reasoning: true,
						input: ["text"],
						contextWindow: 100000,
						maxTokens: 64000,
						endpoint: { api: "openai-completions", baseUrl: `${base}/v1` },
					})),
				}),
			);
			return;
		}
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		requests.push(body);
		if (mode === "hang") return;
		if (mode === "500") {
			res.writeHead(500);
			res.end('{"error":{"message":"offline failure"}}');
			return;
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (choices, usage) =>
			`data: ${JSON.stringify({ id: "shadow-offline", object: "chat.completion.chunk", model: body.model, choices, usage })}\n\n`;
		res.write(
			chunk([{ index: 0, delta: { role: "assistant", content: output }, finish_reason: null }]),
		);
		res.write(
			chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
				prompt_tokens: 2000,
				completion_tokens: 30,
				total_tokens: 2030,
			}),
		);
		res.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${server.address().port}`;
	return {
		base,
		requests,
		catalogs: () => catalogs,
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
const receipt = (directory) => JSON.parse(readFileSync(join(directory, "receipt.json"), "utf8"));
test("both families finish one bounded durable review and duplicate admission has zero egress", async () => {
	const http = await endpoint();
	try {
		const sealed = sealPacket();
		assert.equal(sealed.hash, PACKET_HASH);
		assert.equal(sealed.bytes, 5577);
		for (const family of Object.keys(MODELS)) {
			const directory = join(scratch, family);
			const result = await runShadow({ directory, family, base: http.base });
			assert.equal(result.outcome, "pass");
			assert.equal(result.child.code, 0);
			for (const key of [
				"submissionId",
				"taskId",
				"conversationId",
				"providerSessionId",
				"entryId",
			])
				assert.ok(result[key], key);
			assert.equal(result.requests.length, 1);
			assert.equal(result.requests[0].phase, "shadow");
			assert.equal(result.usage.totalTokens, 2030);
			assert.equal(result.packetHash, PACKET_HASH);
			const count = http.requests.length;
			const catalogs = http.catalogs();
			await assert.rejects(runShadow({ directory, family, base: http.base }), /EEXIST/);
			assert.equal(http.requests.length, count);
			assert.equal(http.catalogs(), catalogs);
			const body = http.requests.at(-1);
			assert.equal(body.model, MODELS[family]);
			assert.equal(body.max_completion_tokens ?? body.max_tokens, 512);
			assert.ok(Buffer.byteLength(JSON.stringify(body.messages)) <= CAPS.messageBytes);
			assert.equal(body.tools, undefined);
			assert.equal(body.messages.filter((m) => m.role === "user").length, 1);
			assert.equal(body.messages.find((m) => m.role === "user").content, sealed.content);
			if (body.reasoning_effort !== undefined)
				assert.equal(body.reasoning_effort, family === "claude" ? "medium" : "low");
		}
		assert.equal(http.requests.length, 2);
	} finally {
		await http.close();
	}
});
test("tampered packet refuses before any catalog or provider request", async () => {
	const http = await endpoint();
	try {
		const bytes = readFileSync(PACKET_PATH);
		bytes[20] = bytes[20] === 120 ? 121 : 120;
		const packetPath = join(scratch, "tampered.json");
		writeFileSync(packetPath, bytes);
		const directory = join(scratch, "tampered");
		await assert.rejects(
			runShadow({ directory, family: "gpt", base: http.base, packetPath }),
			/shadow_packet_seal/,
		);
		assert.equal(receipt(directory).outcome, "fail");
		assert.equal(http.requests.length, 0);
		assert.equal(http.catalogs(), 0);
		await assert.rejects(runShadow({ directory, family: "gpt", base: http.base }), /EEXIST/);
	} finally {
		await http.close();
	}
});
for (const [name, output, expected] of [
	["malformed", "not JSON", /shadow_result_json/],
	[
		"path",
		JSON.stringify({
			summary: "bug",
			findings: [{ severity: "P2", path: "outside.ts", line: 1, explanation: "bad" }],
		}),
		/shadow_finding_scope/,
	],
	[
		"line",
		JSON.stringify({
			summary: "bug",
			findings: [
				{
					severity: "P2",
					path: "tests/fleet/merge-check.test.ts",
					line: 999999,
					explanation: "bad",
				},
			],
		}),
		/shadow_finding_scope/,
	],
	["size", JSON.stringify({ summary: "x".repeat(4100), findings: [] }), /shadow_result_size/],
])
	test(`${name} output consumes one attempt without repair`, async () => {
		const http = await endpoint(output);
		const directory = join(scratch, name);
		try {
			await assert.rejects(runShadow({ directory, family: "gpt", base: http.base }), expected);
			assert.equal(http.requests.length, 1);
			assert.equal(receipt(directory).requests.length, 1);
			assert.equal(receipt(directory).outcome, "fail");
			await assert.rejects(runShadow({ directory, family: "gpt", base: http.base }), /EEXIST/);
			assert.equal(http.requests.length, 1);
		} finally {
			await http.close();
		}
	});
test("HTTP500 consumes exactly one outgoing attempt without retry", async () => {
	const http = await endpoint(valid, "500");
	const directory = join(scratch, "http500");
	try {
		await assert.rejects(
			runShadow({ directory, family: "gpt", base: http.base, deadlineMs: 10000 }),
			/shadow_worker_failed/,
		);
		assert.equal(http.requests.length, 1);
		assert.equal(receipt(directory).requests.length, 1);
	} finally {
		await http.close();
	}
});
test("worker timeout kills and reaps the process and preserves failure evidence", async () => {
	const http = await endpoint(valid, "hang");
	const directory = join(scratch, "timeout");
	try {
		await assert.rejects(
			runShadow({ directory, family: "gpt", base: http.base, deadlineMs: 4000 }),
			/shadow_worker_timeout/,
		);
		const failed = receipt(directory);
		assert.equal(failed.child.signal, "SIGKILL");
		assert.equal(failed.child.timedOut, true);
		assert.throws(() => process.kill(failed.child.pid, 0), /ESRCH/);
		assert.equal(http.requests.length, 1);
		assert.equal(failed.requests.length, 1);
		await assert.rejects(runShadow({ directory, family: "gpt", base: http.base }), /EEXIST/);
	} finally {
		await http.close();
	}
});
