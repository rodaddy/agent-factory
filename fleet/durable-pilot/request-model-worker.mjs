/** One submission through the real Durable Harness; no repair or retry. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, createRegistry, Harness, ProviderDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CAPS, openBudget, proxyProvider } from "./proxy.mjs";
import { validateRequestPacket } from "./request-packet.mjs";

const [directory] = process.argv.slice(2);
const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
const sealed = validateRequestPacket(config.packet, { expectedHash: config.packetHash });
const persisted = openBudget(join(directory, "budget.sqlite"));
const budget = {
	rows: () => persisted.rows(),
	consume(record) {
		assert.equal(persisted.rows().length, 0, "request_attempt_limit");
		persisted.consume(record);
	},
	close: () => persisted.close(),
};
let harness;
async function run() {
	try {
		const models = createModels();
		models.setProvider(
			proxyProvider(config.model, budget, { phase: "request", base: config.base }),
		);
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
					process.stderr.write('{"event":"request_harness_error"}\n');
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
		assert.equal(settled.status, "done", "request_submission_failed");
		const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
		assert.equal(entry.model.length, 1, "request_message_count");
		const message = entry.model[0];
		assert.equal(message.stopReason, "stop", "request_incomplete_output");
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
				environmentKeys: Object.keys(process.env).sort(),
			}),
		);
	} finally {
		if (harness) await harness.close(ctx);
		budget.close();
	}
	if (process.connected) process.disconnect();
}
run().catch((error) => {
	process.stderr.write(
		`${JSON.stringify({ event: "request_worker_failed", reason: error.code ?? error.message?.split("\n")[0] })}\n`,
	);
	process.exitCode = 1;
	if (process.connected) process.disconnect();
});
