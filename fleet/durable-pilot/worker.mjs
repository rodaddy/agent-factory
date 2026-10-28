/** One real Harness process. The second process only resumes stored work. */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { AssistantEntry, createRegistry, Harness, ProviderDoc } from "@earendil-works/pi-durable";
import { openNodeSqliteStorage } from "@earendil-works/pi-durable/storage/sqlite/node";
import { CAPS, openBudget, proxyProvider } from "./proxy.mjs";

const [directory, phase] = process.argv.slice(2);
assert.ok(["start", "resume"].includes(phase), "pilot_phase_refused");
const config = JSON.parse(readFileSync(join(directory, "config.json"), "utf8"));
const budget = openBudget(join(directory, "budget.sqlite"));
let ready;
const admission = new Promise((resolve) => {
	ready = resolve;
});
let harness;
let root;
async function beforeSend() {
	if (phase !== "start" || budget.rows().length !== 1) return;
	const marker = await admission;
	marker.provider = await harness.snapshot(ProviderDoc, root.id, ctx);
	writeFileSync(join(directory, "checkpoint.json"), JSON.stringify(marker));
	process.send({ event: "checkpoint", pid: process.pid });
	// Intentional crash barrier: no second network request until a new process resumes.
	await new Promise(() => {});
}

async function answer(submission) {
	const settled = await submission.wait(ctx);
	assert.equal(settled.status, "done", "pilot_submission_failed");
	const entry = await root.commit((tx) => tx.entry(AssistantEntry, settled.answer), ctx);
	const message = entry.model[0];
	assert.equal(message.stopReason, "stop", "pilot_model_did_not_finish");
	assert.equal(message.model, config.model.id);
	assert.equal(message.provider, "fleet-proxy");
	return {
		entry,
		text: message.content
			.filter((p) => p.type === "text")
			.map((p) => p.text)
			.join("")
			.trim(),
	};
}

async function run() {
	const models = createModels();
	models.setProvider(proxyProvider(config.model, budget, { beforeSend, phase, base: config.base }));
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
				process.stderr.write('{"event":"pilot_harness_error"}\n');
				process.exit(2);
			},
		},
		ctx,
	);
	root = await harness.root(ctx, {
		agent: { model: { provider: "fleet-proxy", modelId: config.model.id }, thinkingLevel: "low" },
	});
	if (phase === "start") {
		const first = await root.submit(
			{ type: "input", content: `Remember the word ${config.word}. Reply only STORED.` },
			ctx,
		);
		const saved = await answer(first);
		assert.equal(saved.text, "STORED");
		const pending = await root.submit(
			{
				type: "input",
				content: "Reply with only the word I asked you to remember, no formatting.",
			},
			ctx,
		);
		ready({
			firstSubmission: first.id,
			pendingSubmission: pending.id,
			firstEntry: saved.entry,
			conversationId: root.id,
		});
		await pending.wait(ctx);
		throw new Error("pilot_crash_barrier_skipped");
	}
	const marker = JSON.parse(readFileSync(join(directory, "checkpoint.json"), "utf8"));
	assert.equal(root.id, marker.conversationId);
	assert.deepEqual(await harness.snapshot(ProviderDoc, root.id, ctx), marker.provider);
	const pending = await harness.submission(marker.pendingSubmission, ctx);
	assert.ok(pending, "pilot_pending_submission_missing");
	harness.resume();
	const resumed = await answer(pending);
	assert.equal(resumed.text, config.word, "pilot_context_not_preserved");
	writeFileSync(
		join(directory, "resumed.json"),
		JSON.stringify({ ...resumed, provider: marker.provider, pid: process.pid }),
	);
	await harness.close(ctx);
	budget.close();
	process.disconnect();
}

run().catch((error) => {
	process.stderr.write(
		`${JSON.stringify({ event: "pilot_worker_failed", reason: error.code ?? error.message?.split("\n")[0] })}\n`,
	);
	process.exit(1);
});
