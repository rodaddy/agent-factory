/** Isolated shadow-G CLI. Admissions remain consumed on every failure. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, CAPS, MODELS, openBudget, pilotModel } from "./proxy.mjs";
import { snapshot } from "./run.mjs";
import { hash, PACKET_PATH, sealPacket, validateResult } from "./shadow-packet.mjs";
export const CORRELATION = "DURABLE-PI-SHADOW-20261012-G";
const HOSTS = {
	"durable-pi-pilot-01": 5039,
	"durable-pi-pilot-02": 5040,
	"durable-pi-pilot-03": 5041,
};
const write = (directory, name, value) =>
	writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
const read = (directory, name) => JSON.parse(readFileSync(join(directory, name), "utf8"));
const files = [
	"shadow.mjs",
	"shadow-worker.mjs",
	"shadow-packet.mjs",
	"shadow-packet.json",
	"proxy.mjs",
	"run.mjs",
	"package.json",
	"bun.lock",
	"../pi-extensions/fleet-proxy-models/index.ts",
];
function worker(directory, timeout) {
	return new Promise((resolve, reject) => {
		const child = fork(
			fileURLToPath(new URL("./shadow-worker.mjs", import.meta.url)),
			[directory],
			{
				execArgv: [],
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				env: { PATH: process.env.PATH, HOME: directory, NODE_NO_WARNINGS: "1" },
			},
		);
		let timedOut = false;
		let stderr = "";
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeout);
		child.stderr.on("data", (data) => {
			stderr = (stderr + data.toString()).slice(-8192);
		});
		let spawnError;
		child.on("error", (error) => {
			spawnError = error;
			child.kill("SIGKILL");
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			const receipt = { pid: child.pid, code, signal, timedOut, stderr };
			write(directory, "process.json", receipt);
			if (spawnError || timedOut || code !== 0 || signal !== null)
				reject(new Error(timedOut ? "shadow_worker_timeout" : "shadow_worker_failed"));
			else resolve(receipt);
		});
	});
}
function ledger(directory) {
	const budget = openBudget(join(directory, "budget.sqlite"));
	try {
		return budget.rows();
	} finally {
		budget.close();
	}
}
export async function runShadow({
	directory,
	family,
	base = BASE,
	packetPath = PACKET_PATH,
	deadlineMs = CAPS.caseMs,
	requireRootPacket = false,
}) {
	assert.ok(Object.hasOwn(MODELS, family), "shadow_family_refused");
	mkdirSync(directory, { mode: 0o700 });
	const start = Date.now();
	const record = {
		correlation: CORRELATION,
		host: hostname(),
		family,
		requestedModel: MODELS[family],
		provider: "fleet-proxy",
		effort: family === "claude" ? "medium" : "low",
		startedAt: new Date().toISOString(),
		caps: CAPS,
	};
	try {
		if (requireRootPacket) {
			const packet = statSync(packetPath);
			assert.ok(packet.uid === 0 && (packet.mode & 0o022) === 0, "shadow_packet_ownership_refused");
		}
		const sealed = sealPacket(packetPath);
		Object.assign(record, {
			pr: sealed.packet.pr,
			base: sealed.packet.base,
			mergeBase: sealed.packet.mergeBase,
			head: sealed.packet.head,
			packetHash: sealed.hash,
			packetBytes: sealed.bytes,
			sourceHashes: Object.fromEntries(
				files.map((file) => [file, hash(readFileSync(new URL(file, import.meta.url)))]),
			),
		});
		const response = await fetch(`${base}/v1/models`, {
			redirect: "error",
			signal: AbortSignal.timeout(Math.min(10000, deadlineMs)),
		});
		assert.ok(response.ok, "shadow_catalog_http_failed");
		const catalog = await response.json();
		const model = pilotModel(catalog, family, base);
		write(
			directory,
			"catalog.json",
			catalog.data.filter((m) => m.id === model.id),
		);
		write(directory, "config.json", { model, base, packetPath, effort: record.effort });
		const remaining = deadlineMs - (Date.now() - start);
		assert.ok(remaining > 0, "shadow_case_timeout");
		const child = await worker(directory, remaining);
		const stored = snapshot(directory);
		write(directory, "snapshot.json", stored);
		const result = read(directory, "worker-result.json");
		assert.equal(stored.submissions.length, 1, "shadow_submission_count");
		assert.equal(stored.submissions[0].status, "done");
		assert.equal(stored.submissions[0].id, result.submissionId);
		const tasks = stored.tasks.filter((t) => t.kind === "pi.generation");
		assert.equal(tasks.length, 1, "shadow_generation_count");
		assert.equal(tasks[0].state.status, "terminal");
		const messages = stored.entries
			.flatMap((e) => e.model ?? [])
			.filter((m) => m.role === "assistant");
		assert.equal(messages.length, 1, "shadow_assistant_count");
		assert.deepEqual(
			stored.entries.find((e) => e.id === result.entry.id),
			result.entry,
		);
		const message = messages[0];
		assert.equal(message.model, model.id);
		assert.equal(message.provider, "fleet-proxy");
		assert.equal(message.stopReason, "stop");
		assert.equal(
			result.raw,
			message.content
				.filter((p) => p.type === "text")
				.map((p) => p.text)
				.join(""),
		);
		assert.deepEqual(result.usage, message.usage);
		const usage = message.usage;
		for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
			assert.ok(Number.isFinite(usage?.[key]) && usage[key] >= 0, "shadow_usage_unreported");
		assert.ok(usage.totalTokens > 0 && usage.output <= 512, "shadow_usage_bounds");
		const requests = ledger(directory);
		assert.equal(requests.length, 1, "shadow_request_count");
		assert.equal(requests[0].phase, "shadow");
		assert.equal(requests[0].model, model.id);
		assert.ok(result.provider.sessionId && result.conversationId, "shadow_session_unreported");
		const output = validateResult(result.raw, sealed.packet);
		write(directory, "review.json", output);
		const receipt = {
			...record,
			outcome: "pass",
			elapsedMs: Date.now() - start,
			child,
			submissionId: result.submissionId,
			taskId: tasks[0].id,
			conversationId: result.conversationId,
			providerSessionId: result.provider.sessionId,
			entryId: result.entry.id,
			requests,
			usage,
		};
		write(directory, "receipt.json", receipt);
		return receipt;
	} catch (error) {
		const receipt = {
			...record,
			outcome: "fail",
			reason: error.message,
			elapsedMs: Date.now() - start,
		};
		try {
			receipt.child = read(directory, "process.json");
		} catch (evidenceError) {
			receipt.processEvidence = {
				available: false,
				category: evidenceError instanceof SyntaxError ? "invalid_json" : "read_failed",
				code: evidenceError.code === "ENOENT" ? "ENOENT" : "UNAVAILABLE",
			};
		}
		try {
			receipt.requests = ledger(directory);
		} catch (evidenceError) {
			receipt.ledgerEvidence = {
				available: false,
				category: evidenceError instanceof SyntaxError ? "invalid_json" : "ledger_read_failed",
				code: evidenceError.code === "ERR_SQLITE_ERROR" ? "ERR_SQLITE_ERROR" : "UNAVAILABLE",
			};
		}
		write(directory, "receipt.json", receipt);
		throw error;
	}
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
	try {
		assert.equal(process.argv.length, 3, "shadow_arguments_refused");
		assert.ok(
			Object.hasOwn(HOSTS, hostname()) && process.getuid() === HOSTS[hostname()],
			"pilot_identity_refused",
		);
		const family = process.argv[2];
		const receipt = await runShadow({
			directory: `/var/lib/durable-pi-pilot/shadow-G/${family}`,
			family,
			requireRootPacket: true,
		});
		process.stdout.write(`${JSON.stringify(receipt)}\n`);
	} catch (error) {
		process.stderr.write(`${JSON.stringify({ event: "shadow_failed", reason: error.message })}\n`);
		process.exitCode = 1;
	}
}
