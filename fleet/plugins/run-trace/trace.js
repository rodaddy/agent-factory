import { buildIngestionBatch, extractSteps, parseLogContent } from "./logic.js";

export class HttpError extends Error {
	constructor(message, status) {
		super(message);
		this.name = "HttpError";
		this.status = status;
	}
}

const realSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryable = (err) =>
	!(err instanceof HttpError) || err.status === 429 || (err.status >= 500 && err.status <= 599);

export async function withRetry(fn, { delays = [1000, 3000, 9000], sleep = realSleep } = {}) {
	for (let i = 0; ; i++) {
		try {
			return await fn();
		} catch (err) {
			if (i >= delays.length || !isRetryable(err)) throw err;
			await sleep(delays[i]);
		}
	}
}

/** Bounds fetch and body consumption, including transports that ignore abort. */
async function request(fetchImpl, url, init, timeoutMs, consume) {
	const controller = new AbortController();
	let timer;
	const deadline = new Promise((_, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error("run-trace: request timeout"));
		}, timeoutMs);
	});
	try {
		return await Promise.race([
			fetchImpl(url, { ...init, signal: controller.signal }).then(consume),
			deadline,
		]);
	} finally {
		clearTimeout(timer);
		controller.abort();
	}
}

async function getJson(fetchImpl, url, token, retry, timeoutMs, { emptyOn404 = false } = {}) {
	return withRetry(async () => {
		return request(
			fetchImpl,
			url,
			{ headers: { Authorization: `Bearer ${token}` } },
			timeoutMs,
			async (res) => {
				if (emptyOn404 && res.status === 404) return { content: "" };
				if (!res.ok)
					throw new HttpError(
						`run-trace: board GET ${new URL(url).pathname} -> ${res.status}`,
						res.status,
					);
				return res.json();
			},
		);
	}, retry);
}

function confirmed(out, batch) {
	if (!Array.isArray(out?.successes) || !Array.isArray(out?.errors)) return 0;
	const expected = new Set(batch.map((e) => e.id));
	const seen = new Set();
	for (const entry of [...out.successes, ...out.errors]) {
		if (!entry || typeof entry.id !== "string" || !expected.has(entry.id) || seen.has(entry.id))
			return 0;
		seen.add(entry.id);
	}
	return out.successes.filter(
		(entry) => Number.isInteger(entry.status) && entry.status >= 200 && entry.status < 300,
	).length;
}

/** A Langfuse receipt is bounded by bytes as well as the request deadline. */
async function readReceipt(res) {
	const reader = res.body?.getReader();
	if (!reader) return null;
	const chunks = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 65536) {
				void reader.cancel().catch(() => null); // Counted as failure; cancellation cannot hold the worker.
				return null;
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return null;
	} // Unparseable receipt is counted as failed by the caller.
}

/**
 * The Pi exporter's own log lines decide whether replay may price this run. Its
 * receipt decides (confirmed / incomplete). With no receipt, only this run's
 * `langfuse_disabled` line proves nothing was exported (missing: replay prices
 * it); otherwise delivery is unknown and never priced, so usage is not counted twice.
 */
function canonicalDeliveryVerdict(entries, runId) {
	// Pi's stderr reaches the log as chunks that need not end on a line boundary, so
	// the stream is joined before it is split: a receipt cut across two chunks must
	// not read as missing, or replay would price a run that was already delivered.
	const stderr = entries
		.filter((entry) => entry.stream === "stderr")
		.map((entry) => String(entry.text ?? ""))
		.join("");
	let receipt;
	let disabled = false;
	for (const line of stderr.split("\n")) {
		try {
			const body = JSON.parse(line);
			if (body?.correlation_id !== runId) continue;
			if (body.message === "langfuse_delivery") receipt = body;
			if (body.message === "langfuse_disabled") disabled = true;
		} catch {
			/* An unparseable log line proves nothing; a missing receipt is decided below. */
		}
	}
	// A langfuse_disabled line never outranks this run's own receipt, and one from a
	// nested Pi process (another correlation_id) never counts. No receipt and no
	// disabled line for this run: Pi may have exported and died before its receipt,
	// so delivery is unknown and replay must not price it.
	if (!receipt) return disabled ? "canonical_delivery_missing" : "canonical_delivery_unknown";
	const valid = [receipt.sent, receipt.failed, receipt.dropped].every(
		(n) => Number.isInteger(n) && n >= 0,
	);
	return valid && receipt.sent > 0 && receipt.failed === 0 && receipt.dropped === 0
		? "canonical_delivery_confirmed"
		: "canonical_delivery_incomplete";
}

export async function traceRun({
	runId,
	companyId: _companyId,
	config,
	fetchImpl,
	secrets,
	sleep,
	requestTimeoutMs = 5000,
}) {
	const retry = sleep ? { sleep } : {};
	const boardUrl = config?.boardUrl ?? "http://127.0.0.1:3100";
	const langfuseHost = config?.langfuseHost ?? "https://langfuse.example.internal";
	const run = await getJson(
		fetchImpl,
		`${boardUrl}/api/heartbeat-runs/${runId}`,
		secrets.boardApiKey,
		retry,
		requestTimeoutMs,
	);
	// A run whose log the board no longer has is still a run: trace what exists.
	const log = await getJson(
		fetchImpl,
		`${boardUrl}/api/heartbeat-runs/${runId}/log`,
		secrets.boardApiKey,
		retry,
		requestTimeoutMs,
		{ emptyOn404: true },
	);
	let agentName = run.agentId;
	const diagnostics = [];
	try {
		const agent = await getJson(
			fetchImpl,
			`${boardUrl}/api/agents/${run.agentId}`,
			secrets.boardApiKey,
			retry,
			requestTimeoutMs,
		);
		agentName = agent?.name ?? run.agentId;
	} catch {
		agentName = run.agentId;
		diagnostics.push("agent_name_unavailable");
	}
	const adapterType = run.runnerProfileJson?.adapterDispatch?.adapterType ?? run.adapterType;
	const entries = parseLogContent(log?.content ?? "");
	const canonicalDelivery =
		adapterType === "pi_local" ? canonicalDeliveryVerdict(entries, runId) : undefined;
	if (canonicalDelivery && canonicalDelivery !== "canonical_delivery_confirmed")
		diagnostics.push(canonicalDelivery);
	const batch = buildIngestionBatch({ ...run, agentName }, extractSteps(adapterType, entries), {
		canonicalDelivery,
	});
	const basic = Buffer.from(`${secrets.langfusePublicKey}:${secrets.langfuseSecretKey}`).toString(
		"base64",
	);
	const out = await withRetry(async () => {
		return request(
			fetchImpl,
			`${langfuseHost}/api/public/ingestion`,
			{
				method: "POST",
				headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/json" },
				body: JSON.stringify({ batch }),
			},
			requestTimeoutMs,
			async (r) => {
				if (!r.ok) {
					await r.body?.cancel();
					throw new HttpError(`run-trace: langfuse ingestion -> ${r.status}`, r.status);
				}
				return readReceipt(r);
			},
		);
	}, retry);
	const successes = confirmed(out, batch);
	return {
		runId,
		events: batch.length,
		successes,
		errors: batch.length - successes,
		diagnostics,
	};
}
