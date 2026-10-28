/** One JetStream delivery, one authoritative reservation, one isolated durable review. */
import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { hostname } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BASE, CAPS, digest, MODELS, openBudget, pilotModel } from "./proxy.mjs";
import { validateRequestPacket, validateRequestResult } from "./request-packet.mjs";
import { snapshot } from "./run.mjs";

let activeChild;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SOURCES = [
	"request-run.mjs",
	"request-model-worker.mjs",
	"request-packet.mjs",
	"request-config.mjs",
	"request-bus.mjs",
	"request-credentials.mjs",
	"proxy.mjs",
	"run.mjs",
	"package.json",
	"bun.lock",
	"../pi-extensions/fleet-proxy-models/index.ts",
];
const write = (directory, name, value) =>
	writeFileSync(join(directory, name), `${JSON.stringify(value)}\n`, { mode: 0o600 });
const read = (directory, name) => JSON.parse(readFileSync(join(directory, name), "utf8"));

function childRun(directory, timeoutMs) {
	return new Promise((resolveRun, reject) => {
		const child = fork(
			fileURLToPath(new URL("./request-model-worker.mjs", import.meta.url)),
			[directory],
			{
				execArgv: [],
				stdio: ["ignore", "ignore", "pipe", "ipc"],
				env: { PATH: process.env.PATH, HOME: directory, NODE_NO_WARNINGS: "1" },
			},
		);
		activeChild = child;
		let stderr = "";
		let timedOut = false;
		let spawnError = false;
		const timer = setTimeout(() => {
			timedOut = true;
			child.kill("SIGKILL");
		}, timeoutMs);
		child.stderr.on("data", (bytes) => {
			stderr = (stderr + bytes.toString()).slice(-4096);
		});
		child.on("error", () => {
			spawnError = true;
			child.kill("SIGKILL");
		});
		child.on("close", (code, signal) => {
			clearTimeout(timer);
			activeChild = undefined;
			write(directory, "process.json", { pid: child.pid, code, signal, timedOut, stderr });
			if (spawnError || timedOut || code !== 0 || signal !== null)
				return reject(new Error("request_child_failed"));
			resolveRun({ pid: child.pid, code, signal });
		});
	});
}

function inspect(directory, job, model, sealed) {
	const stored = snapshot(directory);
	const result = read(directory, "worker-result.json");
	assert.equal(stored.submissions.length, 1, "request_submission_count");
	assert.equal(stored.submissions[0].status, "done", "request_submission_status");
	assert.equal(stored.submissions[0].id, result.submissionId);
	const tasks = stored.tasks.filter((task) => task.kind === "pi.generation");
	assert.equal(tasks.length, 1, "request_generation_count");
	assert.equal(tasks[0].state.status, "terminal");
	assert.deepEqual(
		stored.entries.find((entry) => entry.id === result.entry.id),
		result.entry,
	);
	const messages = stored.entries
		.flatMap((entry) => entry.model ?? [])
		.filter((message) => message.role === "assistant");
	assert.equal(messages.length, 1, "request_assistant_count");
	const message = messages[0];
	assert.equal(message.model, model.id);
	assert.equal(message.provider, "fleet-proxy");
	assert.equal(message.stopReason, "stop");
	assert.equal(
		result.raw,
		message.content
			.filter((part) => part.type === "text")
			.map((part) => part.text)
			.join(""),
	);
	assert.deepEqual(result.usage, message.usage);
	for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"])
		assert.ok(
			Number.isFinite(message.usage?.[key]) && message.usage[key] >= 0,
			"request_usage_unreported",
		);
	assert.ok(
		message.usage.totalTokens > 0 && message.usage.output <= CAPS.outputTokens,
		"request_usage_bounds",
	);
	assert.deepEqual(
		result.environmentKeys,
		process.platform === "darwin"
			? ["HOME", "NODE_NO_WARNINGS", "PATH", "__CF_USER_TEXT_ENCODING"]
			: ["HOME", "NODE_NO_WARNINGS", "PATH"],
		"request_child_environment",
	);
	const budget = openBudget(join(directory, "budget.sqlite"));
	try {
		const rows = budget.rows();
		assert.equal(rows.length, 1, "request_count");
		assert.equal(rows[0].phase, "request");
		assert.equal(rows[0].model, model.id);
	} finally {
		budget.close();
	}
	assert.ok(result.provider.sessionId && result.conversationId, "request_session_missing");
	const output = {
		review: validateRequestResult(result.raw, sealed.packet),
		usage: message.usage,
		session: {
			submissionId: result.submissionId,
			taskId: tasks[0].id,
			conversationId: result.conversationId,
			providerSessionId: result.provider.sessionId,
			entryId: result.entry.id,
		},
		receipt: {
			jobId: job.id,
			packetHash: sealed.packetHash,
			model: model.id,
			family: job.family,
			host: job.host ?? job.targetHost,
			sourceHashes: Object.fromEntries(
				SOURCES.map((source) => [
					source,
					createHash("sha256")
						.update(readFileSync(new URL(source, import.meta.url)))
						.digest("hex"),
				]),
			),
		},
	};
	assert.ok(Buffer.byteLength(JSON.stringify(output)) <= 16384, "request_result_bounds");
	write(directory, "snapshot.json", stored);
	write(directory, "review.json", output);
	return output;
}

/** Injected store/loopback base are test seams; the live CLI fixes the proxy base. */
export async function runRequestJob({
	jobId,
	store,
	workerId,
	host,
	stateRoot,
	base = BASE,
	deadlineMs = 90000,
}) {
	assert.match(jobId, UUID, "request_job_id_refused");
	assert.ok(["107", "109", "113"].includes(host), "request_host_refused");
	assert.ok(deadlineMs > 0 && deadlineMs <= 90000, "request_deadline_refused");
	const started = Date.now();
	const claimed = await store.claim(jobId, workerId, host, { leaseMs: 120000 });
	if (!claimed) return { outcome: "no_claim" };
	const { job, claimToken } = claimed;
	let reserved = false;
	try {
		assert.equal(job.id, jobId);
		assert.ok(job.targetHost === null || job.targetHost === host, "request_target_host_refused");
		assert.ok(Object.hasOwn(MODELS, job.family), "request_family_refused");
		const sealed = validateRequestPacket(job.packet, { expectedHash: job.packetHash });
		const root = lstatSync(stateRoot);
		assert.ok(
			root.isDirectory() && [0, process.getuid()].includes(root.uid) && (root.mode & 0o077) === 0,
			"request_state_root_private",
		);
		const directory = join(resolve(stateRoot), jobId);
		mkdirSync(directory, { mode: 0o700 });
		const response = await fetch(`${base}/v1/models`, {
			redirect: "error",
			signal: AbortSignal.timeout(Math.min(10000, deadlineMs)),
		});
		assert.ok(response.ok, "request_catalog_failed");
		const model = pilotModel(await response.json(), job.family, base);
		write(directory, "config.json", {
			model,
			base,
			packet: sealed.packet,
			packetHash: sealed.packetHash,
			effort: job.family === "claude" ? "medium" : "low",
		});
		const admission = await store.reserveAttempt(jobId, claimToken);
		assert.ok(admission, "request_attempt_refused");
		reserved = true;
		const remaining = deadlineMs - (Date.now() - started);
		assert.ok(remaining > 0, "request_deadline_expired");
		await childRun(directory, remaining);
		const result = inspect(directory, job, model, sealed);
		const completed = await store.complete(jobId, claimToken, {
			result,
			resultHash: digest(result),
		});
		assert.ok(completed, "request_commit_refused");
		return { outcome: "completed", jobId };
	} catch (error) {
		// Lost storage acknowledgement is not evidence that admission did not commit.
		const current = await store.status(jobId);
		const uncertain = reserved || Boolean(current?.attemptId);
		const reason =
			error instanceof Error ? error.message.split("\n")[0].slice(0, 200) : "request_failed";
		const failed = await store.fail(jobId, claimToken, { reason, uncertain });
		if (!failed) throw new Error("request_terminal_commit_failed");
		return { outcome: uncertain ? "uncertain" : "failed", jobId, reason };
	}
}

function binding(jobId, family) {
	assert.equal(typeof jobId, "string", "request_binding_job_required");
	assert.match(jobId, UUID, "request_binding_job_refused");
	assert.ok(Object.hasOwn(MODELS, family), "request_binding_family_refused");
}

/** Fixed-order root-admission arguments are checked before loading any connection config. */
export function parseWorkerArgs(args) {
	assert.equal(args.length, 7, "request_arguments_refused");
	assert.deepEqual(
		[args[0], args[2], args[3], args[5]],
		["--config", "--once", "--job", "--family"],
		"request_arguments_refused",
	);
	assert.ok(
		typeof args[1] === "string" && args[1].startsWith("/"),
		"request_config_argument_refused",
	);
	binding(args[4], args[6]);
	return { configPath: args[1], expectedJobId: args[4], expectedFamily: args[6] };
}

function noExecution(delivery, outcome, expectedJobId) {
	delivery.message.nak();
	return { outcome, expectedJobId, jobId: delivery.jobId, executed: false, acknowledged: false };
}

export async function consumeRequest({ bus, store, expectedJobId, expectedFamily, ...options }) {
	binding(expectedJobId, expectedFamily);
	const delivery = await bus.next({ expiresMs: 1000 });
	if (!delivery) return { outcome: "idle", expectedJobId, executed: false, acknowledged: false };
	assert.match(delivery.jobId, UUID, "request_message_id_refused");
	if (delivery.jobId !== expectedJobId)
		return noExecution(delivery, "unexpected_job", expectedJobId);
	const stored = await store.status(expectedJobId);
	if (!stored) return noExecution(delivery, "missing_job", expectedJobId);
	if (stored.family !== expectedFamily)
		return noExecution(delivery, "unexpected_family", expectedJobId);
	const result = await runRequestJob({ ...options, store, jobId: expectedJobId });
	const acknowledged = await bus.handleAck(delivery.message, store);
	return { ...result, acknowledged };
}

async function main() {
	const { configPath, expectedJobId, expectedFamily } = parseWorkerArgs(process.argv.slice(2));
	const deadline = setTimeout(() => {
		process.stderr.write('{"event":"request_worker_deadline"}\n');
		if (!activeChild) process.exit(1);
		activeChild.once("close", () => process.exit(1));
		activeChild.kill("SIGKILL");
	}, 90000);
	deadline.unref();
	const { loadRequestConfig } = await import("./request-config.mjs");
	const { createDeliveredCredentialReader } = await import("./request-credentials.mjs");
	const { createStore, openRequestSql, normalizeHost } = await import("./request-store.mjs");
	const { connectRequestBus } = await import("./request-bus.mjs");
	const readCredential = createDeliveredCredentialReader({
		instance: `${expectedFamily}-${expectedJobId}`,
		serviceUid: process.getuid(),
	});
	const config = loadRequestConfig(configPath, { worker: true, readCredential });
	const sql = openRequestSql(readCredential(config.postgresUrlFile).trim());
	const store = createStore({ sql, trancheId: config.trancheId });
	let bus;
	try {
		bus = await connectRequestBus(config, { readCredential });
		const outcome = await consumeRequest({
			bus,
			store,
			host: normalizeHost(hostname()),
			workerId: `${hostname()}:${process.pid}`,
			stateRoot: config.stateRoot,
			expectedJobId,
			expectedFamily,
		});
		process.stdout.write(`${JSON.stringify(outcome)}\n`);
	} finally {
		if (bus) await bus.close();
		await sql.end();
		clearTimeout(deadline);
	}
}
if (process.argv[1] === fileURLToPath(import.meta.url))
	main().catch(() => {
		process.stderr.write('{"event":"request_worker_failed"}\n');
		process.exitCode = 1;
	});
