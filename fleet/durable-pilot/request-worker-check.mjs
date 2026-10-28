/** Offline real Harness/SQLite/subprocess contract; no external provider access. */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { digest, MODELS } from "./proxy.mjs";
import { validateRequestPacket } from "./request-packet.mjs";
import { consumeRequest, parseWorkerArgs, runRequestJob } from "./request-run.mjs";

const scratch = process.env.REQUEST_WORKER_TEST_ROOT;
assert.ok(scratch?.startsWith("/opt/_tmp/"), "explicit_request_worker_scratch_required");
mkdirSync(scratch, { recursive: true, mode: 0o700 });
const runScratch = mkdtempSync(join(scratch, "run-"));
const packet = JSON.parse(readFileSync(new URL("./shadow-packet.json", import.meta.url), "utf8"));
delete packet.intent;
delete packet.correlation;
packet.schema = "durable-pi-request-packet.v1";
packet.context = { path: packet.allowedPaths[0], text: "" };
const sealed = validateRequestPacket(packet);
const valid = JSON.stringify({ summary: "No concrete defect in supplied lines.", findings: [] });

async function endpoint({ output = valid, mode = "ok" } = {}) {
	const requests = [];
	let base;
	const server = createServer(async (req, res) => {
		if (req.url === "/v1/models") {
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
		for await (const bytes of req) raw += bytes;
		const body = JSON.parse(raw);
		requests.push(body);
		if (mode === "hang") return;
		if (mode === "500") {
			res.writeHead(500);
			res.end("{}");
			return;
		}
		res.writeHead(200, { "Content-Type": "text/event-stream" });
		const chunk = (choices, usage) =>
			`data: ${JSON.stringify({ id: "request-offline", object: "chat.completion.chunk", model: body.model, choices, usage })}\n\n`;
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
		close: async () => {
			server.closeAllConnections();
			await new Promise((resolve) => server.close(resolve));
		},
	};
}
let serial = 0;
function fixture(family = "gpt", crashReserve = false) {
	const id = `00000000-0000-4000-8000-${String(++serial).padStart(12, "0")}`;
	const job = {
		id,
		family,
		targetHost: "107",
		packet: sealed.packet,
		packetHash: sealed.packetHash,
		status: "queued",
		attemptId: null,
	};
	const store = {
		async claim() {
			if (job.status !== "queued") return null;
			job.status = "claimed";
			return { job: { ...job }, claimToken: "claim" };
		},
		async reserveAttempt() {
			job.attemptId = "attempt";
			job.status = "started";
			if (crashReserve) throw new Error("lost_reservation_ack");
			return { attemptId: job.attemptId, job: { ...job } };
		},
		async complete(_id, _token, result) {
			job.status = "completed";
			Object.assign(job, result);
			return true;
		},
		async fail(_id, _token, error) {
			job.status = error.uncertain ? "uncertain" : "failed";
			job.error = error;
			return true;
		},
		async status() {
			return { ...job };
		},
		async expire() {},
	};
	const stateRoot = join(runScratch, id);
	mkdirSync(stateRoot, { mode: 0o700 });
	return { job, store, options: { jobId: id, store, workerId: "offline", host: "107", stateRoot } };
}

test("each family produces one original SQLite-verified bounded review; duplicate delivery has no egress", async () => {
	const http = await endpoint();
	const original = process.env.FORGE_TOKEN;
	process.env.FORGE_TOKEN = "offline-secret-never-child";
	try {
		for (const family of Object.keys(MODELS)) {
			const f = fixture(family);
			assert.equal((await runRequestJob({ ...f.options, base: http.base })).outcome, "completed");
			assert.equal(f.job.status, "completed");
			assert.deepEqual(f.job.result.review, JSON.parse(valid));
			assert.equal(f.job.result.receipt.packetHash, sealed.packetHash);
			assert.equal(f.job.resultHash, digest(f.job.result));
			assert.equal(f.job.result.usage.totalTokens, 2030);
			assert.ok(f.job.result.session.providerSessionId);
			const local = JSON.parse(
				readFileSync(join(f.options.stateRoot, f.job.id, "worker-result.json"), "utf8"),
			);
			assert.deepEqual(
				local.environmentKeys,
				process.platform === "darwin"
					? ["HOME", "NODE_NO_WARNINGS", "PATH", "__CF_USER_TEXT_ENCODING"]
					: ["HOME", "NODE_NO_WARNINGS", "PATH"],
			);
			const prior = http.requests.length;
			assert.equal((await runRequestJob({ ...f.options, base: http.base })).outcome, "no_claim");
			assert.equal(http.requests.length, prior);
			const wire = http.requests.at(-1);
			assert.equal(wire.model, MODELS[family]);
			assert.equal(wire.tools, undefined);
			assert.equal(wire.max_completion_tokens ?? wire.max_tokens, 512);
			assert.ok(Buffer.byteLength(JSON.stringify(wire.messages)) <= 8192);
		}
		assert.equal(http.requests.length, 2);
	} finally {
		if (original === undefined) delete process.env.FORGE_TOKEN;
		else process.env.FORGE_TOKEN = original;
		await http.close();
	}
});

test("lost reservation acknowledgement becomes uncertain and redelivery never invokes provider", async () => {
	const http = await endpoint();
	const f = fixture("gpt", true);
	try {
		assert.equal((await runRequestJob({ ...f.options, base: http.base })).outcome, "uncertain");
		assert.equal(f.job.status, "uncertain");
		assert.equal((await runRequestJob({ ...f.options, base: http.base })).outcome, "no_claim");
		assert.equal(http.requests.length, 0);
	} finally {
		await http.close();
	}
});

for (const [name, config] of [
	["invalid result", { output: "not JSON" }],
	["HTTP failure", { mode: "500" }],
	["timeout", { mode: "hang" }],
])
	test(`${name} is terminal with one attempt, no repair or replay`, async () => {
		const http = await endpoint(config);
		const f = fixture();
		try {
			assert.equal(
				(
					await runRequestJob({
						...f.options,
						base: http.base,
						deadlineMs: name === "timeout" ? 4000 : 10000,
					})
				).outcome,
				"uncertain",
			);
			assert.equal(f.job.status, "uncertain");
			assert.equal(http.requests.length, 1);
			if (name === "timeout") {
				const killed = JSON.parse(
					readFileSync(join(f.options.stateRoot, f.job.id, "process.json"), "utf8"),
				);
				assert.equal(killed.signal, "SIGKILL");
				assert.throws(() => process.kill(killed.pid, 0), /ESRCH/);
			}
			assert.equal((await runRequestJob({ ...f.options, base: http.base })).outcome, "no_claim");
			assert.equal(http.requests.length, 1);
		} finally {
			await http.close();
		}
	});

test("malformed delivery refuses before claim and is never acknowledged", async () => {
	let acknowledged = false;
	const bus = {
		async next() {
			return { jobId: "../../outside", message: {} };
		},
		async handleAck() {
			acknowledged = true;
		},
	};
	const f = fixture();
	await assert.rejects(
		consumeRequest({ ...f.options, bus, expectedJobId: f.job.id, expectedFamily: f.job.family }),
		/request_message_id_refused/,
	);
	assert.equal(f.job.status, "queued");
	assert.equal(acknowledged, false);
});

test("storage failure leaves delivery unacknowledged after consumed inference", async () => {
	const http = await endpoint();
	const f = fixture();
	let acknowledged = false;
	f.store.complete = async () => {
		throw new Error("storage_unavailable");
	};
	f.store.status = async () => {
		if (f.job.attemptId) throw new Error("storage_unavailable");
		return { ...f.job };
	};
	const bus = {
		async next() {
			return { jobId: f.job.id, message: {} };
		},
		async handleAck() {
			acknowledged = true;
		},
	};
	try {
		await assert.rejects(
			consumeRequest({
				...f.options,
				base: http.base,
				bus,
				expectedJobId: f.job.id,
				expectedFamily: f.job.family,
			}),
			/storage_unavailable/,
		);
		assert.equal(http.requests.length, 1);
		assert.equal(f.job.status, "started");
		assert.equal(acknowledged, false);
	} finally {
		await http.close();
	}
});

for (const kind of ["wrong job", "wrong family", "missing job"])
	test(`bound launch ${kind} has zero execution`, async () => {
		const f = fixture();
		const http = await endpoint();
		let disposition = "none";
		f.store.claim = async () => {
			throw new Error("unexpected_claim");
		};
		f.store.reserveAttempt = async () => {
			throw new Error("unexpected_reservation");
		};
		if (kind === "missing job") f.store.status = async () => null;
		const bus = {
			async next() {
				return {
					jobId: f.job.id,
					message: {
						nak() {
							disposition = "nak";
						},
					},
				};
			},
			async handleAck() {
				disposition = "ack";
			},
		};
		try {
			const outcome = await consumeRequest({
				...f.options,
				base: http.base,
				bus,
				expectedJobId: kind === "wrong job" ? "00000000-0000-4000-8000-999999999999" : f.job.id,
				expectedFamily: kind === "wrong family" ? "claude" : "gpt",
			});
			assert.equal(
				outcome.outcome,
				{
					"wrong job": "unexpected_job",
					"wrong family": "unexpected_family",
					"missing job": "missing_job",
				}[kind],
			);
			assert.equal(outcome.executed, false);
			assert.equal(outcome.acknowledged, false);
			assert.equal(disposition, "nak");
			assert.equal(f.job.status, "queued");
			assert.equal(f.job.attemptId, null);
			assert.equal(http.requests.length, 0);
		} finally {
			await http.close();
		}
	});

test("missing or invalid launch bindings refuse before bus or store access", async () => {
	const f = fixture();
	const bus = {
		async next() {
			throw new Error("unexpected_bus_access");
		},
	};
	for (const fields of [
		{},
		{ expectedJobId: f.job.id },
		{ expectedFamily: "gpt" },
		{ expectedJobId: f.job.id, expectedFamily: "other" },
	])
		await assert.rejects(consumeRequest({ ...f.options, bus, ...fields }), /request_binding/);
	assert.equal(f.job.status, "queued");
	assert.equal(f.job.attemptId, null);
	const args = ["--config", "/private/H.json", "--once", "--job", f.job.id, "--family", "gpt"];
	assert.deepEqual(parseWorkerArgs(args), {
		configPath: "/private/H.json",
		expectedJobId: f.job.id,
		expectedFamily: "gpt",
	});
	for (const invalid of [
		args.slice(0, 3),
		args.slice(0, 5),
		[...args, "extra"],
		args.map((value) => (value === f.job.id ? "../bad" : value)),
		args.map((value) => (value === "gpt" ? "other" : value)),
	])
		assert.throws(() => parseWorkerArgs(invalid), /request_arguments|request_binding/);
});

test("valid launch binding runs the original durable path and duplicate delivery remains harmless", async () => {
	const f = fixture();
	const http = await endpoint();
	const bus = {
		async next() {
			return {
				jobId: f.job.id,
				message: {
					nak() {
						throw new Error("unexpected_nak");
					},
				},
			};
		},
		async handleAck() {
			return f.job.status === "completed";
		},
	};
	try {
		const options = {
			...f.options,
			bus,
			base: http.base,
			expectedJobId: f.job.id,
			expectedFamily: "gpt",
		};
		assert.equal((await consumeRequest(options)).outcome, "completed");
		assert.deepEqual(f.job.result.review, JSON.parse(valid));
		assert.equal((await consumeRequest(options)).outcome, "no_claim");
		assert.equal(http.requests.length, 1);
	} finally {
		await http.close();
	}
});

test("idle bound launch stops without claiming or expiring unrelated work", async () => {
	const f = fixture();
	f.store.expire = async () => {
		throw new Error("unexpected_expiry");
	};
	f.store.claim = async () => {
		throw new Error("unexpected_claim");
	};
	const outcome = await consumeRequest({
		...f.options,
		expectedJobId: f.job.id,
		expectedFamily: "gpt",
		bus: {
			async next() {
				return null;
			},
		},
	});
	assert.equal(outcome.outcome, "idle");
	assert.equal(outcome.executed, false);
	assert.equal(f.job.status, "queued");
});
