/** One submission through the real Durable Harness; no repair or retry. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, createRegistry, Harness, ProviderDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CAPS, openBudget, proxyProvider } from "./proxy.mjs";
import { sealPacket } from "./shadow-packet.mjs";

const [directory] = process.argv.slice(2);
const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
const sealed = sealPacket(config.packetPath);
const budget = openBudget(join(directory, "budget.sqlite"));
let harness;
async function run() {
	try {
		const models = createModels();
		models.setProvider(proxyProvider(config.model, budget, { phase: "shadow", base: config.base }));
		harness = await Harness.open(
			await openNodeSqliteStorage(join(directory, "agent.sqlite")),
			{
				models,
				registry: createRegistry(),
				settings: {
					retry: { enabled: false, maxRetries: 0 },
					compaction: { enabled: false },
					stream: { maxRetries: 0, timeoutMs: CAPS.requestMs, cacheRetention: "none" },
				},
				onReport: () => {
					process.stderr.write('{"event":"shadow_harness_error"}\n');
					process.exit(2);
				},
			},
			ctx,
		);
		const root = await harness.root(ctx, {
			agent: {
				model: { provider: "fleet-proxy", modelId: config.model.id },
				thinkingLevel: config.effort,
			},
		});
		const submission = await root.submit({ type: "input", content: sealed.content }, ctx);
		const settled = await submission.wait(ctx);
		assert.equal(settled.status, "done", "shadow_submission_failed");
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
		assert.equal(entry.model.length, 1, "shadow_message_count");
		const message = entry.model[0];
		assert.equal(message.stopReason, "stop", "shadow_incomplete_output");
		assert.equal(message.provider, "fleet-proxy");
		assert.equal(message.model, config.model.id);
		const raw = message.content
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("");
		const provider = await harness.snapshot(ProviderDoc, root.id, ctx);
		writeFileSync(
			join(directory, "worker-result.json"),
			JSON.stringify({
				entry,
				raw,
				usage: message.usage,
				submissionId: submission.id,
				submission: settled,
				conversationId: root.id,
				provider,
				pid: process.pid,
			}),
		);
	} finally {
		if (harness) await harness.close(ctx);
		budget.close();
	}
	process.disconnect();
}
run().catch((error) => {
	process.stderr.write(
		`${JSON.stringify({ event: "shadow_worker_failed", reason: error.code ?? error.message?.split("\n")[0] })}\n`,
	);
	process.exitCode = 1;
	if (process.connected) process.disconnect();
});
