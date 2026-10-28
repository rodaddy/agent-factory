/** Real Pi 1.1.0, real SQLite, real SIGKILL, loopback HTTP only. */
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { BASE, CAPS, MODELS, openBudget, pilotModel, proxyProvider } from "./proxy.mjs";
import { runCase } from "./run.mjs";

const scratch = process.env.PILOT_TEST_ROOT;
assert.ok(scratch?.startsWith("/opt/_tmp/"), "explicit_test_scratch_required");
mkdirSync(scratch, { recursive: true });

async function endpoint() {
	const requests = [];
	let fail = false;
	let base;
	const catalog = () => ({
		data: Object.values(MODELS).map((id) => ({
			id,
			name: id,
			reasoning: true,
			input: ["text"],
			contextWindow: 100000,
			maxTokens: 64000,
			endpoint: { api: "openai-completions", baseUrl: `${base}/v1` },
		})),
	});
	const server = createServer(async (req, res) => {
		if (req.url === "/v1/models") {
			res.end(JSON.stringify(catalog()));
			return;
		}
		let raw = "";
		for await (const chunk of req) raw += chunk;
		const body = JSON.parse(raw);
		requests.push(body);
		if (fail) {
			res.writeHead(500);
			res.end('{"error":{"message":"offline failure"}}');
			return;
		}
		const messages = body.messages;
		const text = JSON.stringify(messages);
		const word = text.match(/ORBIT-[a-f0-9]+/)?.[0];
		const output = messages.some((m) => m.role === "assistant") ? word : "STORED";
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (choices, usage) =>
			`data: ${JSON.stringify({ id: "offline", object: "chat.completion.chunk", model: body.model, choices, usage })}\n\n`;
		res.write(
			chunk([{ index: 0, delta: { role: "assistant", content: output }, finish_reason: null }]),
		);
		res.write(
			chunk([{ index: 0, delta: {}, finish_reason: "stop" }], {
				prompt_tokens: 40,
				completion_tokens: 5,
				total_tokens: 45,
			}),
		);
		res.end("data: [DONE]\n\n");
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	base = `http://127.0.0.1:${server.address().port}`;
	return {
		base,
		catalog,
		requests,
		fail: () => {
			fail = true;
		},
		close: () => new Promise((resolve) => server.close(resolve)),
	};
}

test("both catalog families recover the persisted generation, without replay or resubmission", async () => {
	const http = await endpoint();
	try {
		for (const family of Object.keys(MODELS)) {
			const directory = join(scratch, family);
			const receipt = await runCase({ directory, family, base: http.base });
			assert.equal(receipt.outcome, "pass");
			assert.equal(receipt.killed.signal, "SIGKILL");
			assert.equal(receipt.restarted.code, 0);
			assert.equal(receipt.firstEntryUnchanged, true);
			await assert.rejects(runCase({ directory, family, base: http.base }), /EEXIST/);
			const budget = openBudget(join(directory, "budget.sqlite"));
			const model = pilotModel(http.catalog(), family, http.base);
			const provider = proxyProvider(model, budget, { phase: "extra", base: http.base });
			const blocked = await provider
				.streamSimple(model, { messages: [{ role: "user", content: "third", timestamp: 0 }] })
				.result();
			assert.equal(blocked.stopReason, "error");
			assert.match(blocked.errorMessage, /pilot_request_limit/);
			assert.equal(budget.rows().length, 2);
			budget.close();
		}
		assert.equal(http.requests.length, 4);
		for (const body of http.requests) {
			assert.equal(body.max_completion_tokens ?? body.max_tokens, CAPS.outputTokens);
			assert.ok(Buffer.byteLength(JSON.stringify(body.messages)) <= CAPS.messageBytes);
			assert.equal(body.tools, undefined);
		}
	} finally {
		await http.close();
	}
});

test("catalog escape, oversized context and retry fail closed at the real HTTP boundary", async () => {
	const http = await endpoint();
	const budget = openBudget(join(scratch, "refusal.sqlite"));
	try {
		assert.throws(() => pilotModel(http.catalog(), "claude", BASE), /pilot_catalog_route_refused/);
		const model = pilotModel(http.catalog(), "claude", http.base);
		const provider = proxyProvider(model, budget, { phase: "negative", base: http.base });
		const oversized = await provider
			.streamSimple(model, {
				messages: [{ role: "user", content: "x".repeat(8193), timestamp: 0 }],
			})
			.result();
		assert.equal(oversized.stopReason, "error");
		assert.match(oversized.errorMessage, /pilot_context_limit/);
		assert.equal(http.requests.length, 0);
		assert.equal(budget.rows().length, 0);
		http.fail();
		const failure = await provider
			.streamSimple(
				model,
				{ messages: [{ role: "user", content: "tiny", timestamp: 0 }] },
				{ maxRetries: 9 },
			)
			.result();
		assert.equal(failure.stopReason, "error");
		assert.equal(http.requests.length, 1);
		assert.equal(budget.rows().length, 1);
	} finally {
		budget.close();
		await http.close();
	}
});
