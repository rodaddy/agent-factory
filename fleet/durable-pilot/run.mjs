/** Six-case tranche F controller: kill/reap/start, then independently inspect SQLite. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { BASE, CAPS, digest, MODELS, openBudget, pilotModel } from "./proxy.mjs";

export const CORRELATION = "DURABLE-PI-PROXY-RESTART-20261012-F";
const HOSTS = {
	"durable-pi-pilot-01": 5039,
	"durable-pi-pilot-02": 5040,
	"durable-pi-pilot-03": 5041,
};
const write = (directory, name, value) =>
	writeFileSync(join(directory, name), `${JSON.stringify(value, null, 2)}\n`);
const read = (directory, name) => JSON.parse(readFileSync(join(directory, name), "utf8"));

function worker(directory, phase, timeout) {
	return new Promise((resolve, reject) => {
		const child = fork(
			fileURLToPath(new URL("./worker.mjs", import.meta.url)),
			[directory, phase],
			{
				execArgv: [],
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				env: { PATH: process.env.PATH, HOME: directory, NODE_NO_WARNINGS: "1" },
			},
		);
		let ready = false;
		let stderr = "";
		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeout);
		child.stderr.on("data", (data) => {
			stderr = (stderr + data.toString()).slice(-8192);
		});
		child.on("message", (message) => {
			if (phase !== "start" || ready || message?.event !== "checkpoint") return;
			ready = true;
			child.kill("SIGKILL");
		});
		child.on("error", (error) => {
			clearTimeout(timer);
			reject(error);
		});
		child.on("exit", (code, signal) => {
			clearTimeout(timer);
			const receipt = { phase, pid: child.pid, code, signal, ready, timedOut, stderr };
			write(directory, `${phase}-process.json`, receipt);
			const success =
				phase === "start" ? ready && signal === "SIGKILL" : code === 0 && signal === null;
			if (!success || timedOut) return reject(new Error(`pilot_${phase}_process_failed`));
			resolve(receipt);
		});
	});
}

/** Read only after each worker exited; no simultaneous SQLite writer. */
export function snapshot(directory) {
	const db = new DatabaseSync(join(directory, "agent.sqlite"), { readOnly: true });
	try {
		return Object.fromEntries(
			["entries", "tasks", "submissions"].map((table) => [
				table,
				db
					.prepare(`SELECT record FROM ${table} ORDER BY id`)
					.all()
					.map((row) => JSON.parse(row.record)),
			]),
		);
	} finally {
		db.close();
	}
}

function beforeRestart(directory) {
	const marker = read(directory, "checkpoint.json");
	const before = snapshot(directory);
	const pending = before.submissions.find((s) => s.id === marker.pendingSubmission);
	assert.equal(pending?.status, "placed");
	const task = before.tasks.find((t) => t.kind === "pi.generation" && t.state.status === "running");
	assert.equal(task?.state.checkpoint.phase, "request");
	assert.deepEqual(
		before.entries.find((e) => e.id === marker.firstEntry.id),
		marker.firstEntry,
	);
	write(directory, "before.json", before);
	return { marker, taskId: task.id, firstEntryHash: digest(marker.firstEntry) };
}

function assess(directory, prior, model) {
	const after = snapshot(directory);
	const resumed = read(directory, "resumed.json");
	assert.equal(after.submissions.length, 2, "pilot_resubmitted_work");
	assert.ok(after.submissions.every((s) => s.status === "done"));
	assert.equal(after.tasks.find((t) => t.id === prior.taskId)?.state.status, "terminal");
	assert.equal(
		digest(after.entries.find((e) => e.id === prior.marker.firstEntry.id)),
		prior.firstEntryHash,
	);
	assert.deepEqual(resumed.provider, prior.marker.provider);
	const messages = after.entries
		.flatMap((e) => e.model ?? [])
		.filter((m) => m.role === "assistant");
	assert.equal(messages.length, 2, "pilot_completed_generation_replayed");
	const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
	for (const message of messages) {
		assert.equal(message.provider, "fleet-proxy");
		assert.equal(message.model, model.id);
		assert.equal(message.stopReason, "stop");
		for (const key of Object.keys(usage)) {
			assert.ok(
				Number.isFinite(message.usage?.[key]) && message.usage[key] >= 0,
				"pilot_usage_unreported",
			);
			usage[key] += message.usage[key];
		}
	}
	assert.ok(usage.totalTokens > 0 && usage.output <= CAPS.outputTokens * 2);
	write(directory, "after.json", after);
	return {
		conversationId: prior.marker.conversationId,
		providerSessionId: resumed.provider.sessionId,
		pendingSubmissionId: prior.marker.pendingSubmission,
		resumedTaskId: prior.taskId,
		firstEntryHash: prior.firstEntryHash,
		firstEntryUnchanged: true,
		submissions: 2,
		assistantMessages: 2,
		output: resumed.text,
		usage,
		usageByMessage: messages.map((m) => m.usage),
	};
}

/** Offline tests use a loopback endpoint; the live CLI below has no endpoint override. */
export async function runCase({ directory, family, base = BASE }) {
	assert.ok(Object.hasOwn(MODELS, family));
	mkdirSync(directory, { mode: 0o700 }); // Persistent one-shot admission; never reset for a rerun.
	const started = Date.now();
	const record = {
		correlation: CORRELATION,
		kind: "pi-durable-proxy-restart",
		host: hostname(),
		family,
		requestedModel: MODELS[family],
		provider: "fleet-proxy",
		startedAt: new Date().toISOString(),
		caps: CAPS,
	};
	try {
		const response = await fetch(`${base}/v1/models`, {
			redirect: "error",
			signal: AbortSignal.timeout(10000),
		});
		assert.ok(response.ok, "pilot_catalog_http_failed");
		const catalog = await response.json();
		const model = pilotModel(catalog, family, base);
		write(
			directory,
			"catalog.json",
			catalog.data.filter((m) => m.id === model.id),
		);
		write(directory, "config.json", {
			model,
			base,
			word: `ORBIT-${randomBytes(4).toString("hex")}`,
		});
		const killed = await worker(directory, "start", CAPS.caseMs - (Date.now() - started));
		const prior = beforeRestart(directory);
		const budget = openBudget(join(directory, "budget.sqlite"));
		assert.equal(budget.rows().length, 1, "pilot_first_phase_requests");
		budget.close();
		const remaining = CAPS.caseMs - (Date.now() - started);
		assert.ok(remaining > 0, "pilot_case_timeout");
		const restarted = await worker(directory, "resume", remaining);
		assert.notEqual(killed.pid, restarted.pid);
		const result = assess(directory, prior, model);
		const finalBudget = openBudget(join(directory, "budget.sqlite"));
		const requests = finalBudget.rows();
		finalBudget.close();
		assert.deepEqual(
			requests.map((r) => r.phase),
			["start", "resume"],
		);
		const receipt = {
			...record,
			...result,
			requests,
			killed,
			restarted,
			outcome: "pass",
			elapsedMs: Date.now() - started,
		};
		write(directory, "receipt.json", receipt);
		return receipt;
	} catch (error) {
		write(directory, "receipt.json", {
			...record,
			outcome: "fail",
			reason: error.message,
			elapsedMs: Date.now() - started,
		});
		throw error;
	}
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
	const family = process.argv[2];
	assert.ok(
		Object.hasOwn(HOSTS, hostname()) && process.getuid() === HOSTS[hostname()],
		"pilot_identity_refused",
	);
	await runCase({ directory: `/var/lib/durable-pi-pilot/proxy-restart-F/${family}`, family })
		.then((receipt) => process.stdout.write(`${JSON.stringify(receipt)}\n`))
		.catch((error) => {
			process.stderr.write(`${JSON.stringify({ event: "pilot_failed", reason: error.message })}\n`);
			process.exitCode = 1;
		});
}
