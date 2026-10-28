/**
 * @module fleet/pi-extensions/langfuse-trace/send
 * @description Bounded delivery to Langfuse `/api/public/ingestion` for the Pi
 *   langfuse-trace extension. Plain `fetch`, no SDK. A POST per
 *   `batchSize` events while the session runs, at most one in flight, at most
 *   `maxQueued` waiting (the oldest drop). Each POST times out; one retry on a
 *   network error, timeout, 429 or 5xx. `close()` drains within `shutdownBoundMs`,
 *   counts what is left as dropped, and returns the totals. Never throws, never logs.
 *   Every timeout, retry delay and shutdown bound runs on `opts.timer` (default
 *   `setTimeout`), so a test drives them from a clock it owns.
 */
import type { IngestionEvent } from "./batch.ts";

export const DEFAULTS = {
	timeoutMs: 5000,
	retryDelayMs: 500,
	shutdownBoundMs: 8000,
	batchSize: 50,
	maxQueued: 1000,
};
/** Runs `fn` after `ms` and returns a cancel; every timeout, retry delay and shutdown bound goes through it. */
export type Timer = (fn: () => void, ms: number) => () => void;
export type SendOpts = Partial<typeof DEFAULTS> & { timer?: Timer };
export type Totals = { sent: number; failed: number; dropped: number };

const realTimer: Timer = (fn, ms) => {
	const t = setTimeout(fn, ms);
	return () => clearTimeout(t);
};

/** Resolves after `ms`, or at once when `signal` aborts; either way it leaves no listener behind. */
function sleep(timer: Timer, ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((done) => {
		if (signal.aborted) return done();
		const onAbort = () => {
			cancel();
			done();
		};
		const cancel = timer(() => {
			signal.removeEventListener("abort", onAbort);
			done();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * A Langfuse 207 is a few dozen bytes per event. A declared length over the bound is refused
 * before the read; an undeclared (chunked) body is cancelled as soon as it passes the bound.
 */
const RECEIPT_MAX_BYTES = 65536;

/**
 * Reads at most RECEIPT_MAX_BYTES of the body, or returns null past the bound. The read is
 * raced against the fetch's abort signal and the signal is re-checked after every chunk: on
 * bun 1.3.14 (the runner's bun) a read on an aborted body resolves `done` with no bytes
 * instead of rejecting, which would count a stalled receipt as empty instead of retrying it.
 */
async function readBounded(res: Response, signal: AbortSignal): Promise<string | null> {
	const declared = Number(res.headers.get("content-length"));
	if (declared > RECEIPT_MAX_BYTES) {
		void res.body?.cancel().catch(() => null); // Failure is counted; do not wait on cancellation.
		return null;
	}
	const reader = res.body?.getReader();
	if (!reader) return "";
	const aborted = new Promise<never>((_, reject) => {
		const fail = () => reject(signal.reason ?? new Error("aborted"));
		if (signal.aborted) fail();
		else signal.addEventListener("abort", fail, { once: true });
	});
	aborted.catch(() => null); // Observed through the race below; never unhandled.
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await Promise.race([aborted, reader.read()]);
			if (signal.aborted) throw signal.reason ?? new Error("aborted");
			if (done) break;
			size += value.byteLength;
			if (size > RECEIPT_MAX_BYTES) {
				void reader.cancel().catch(() => null); // Failure is counted; do not wait on cancellation.
				return null;
			}
			chunks.push(value);
		}
	} finally {
		// A read left pending by the abort keeps the lock; cancel releases it without waiting.
		if (signal.aborted) void reader.cancel().catch(() => null);
		else reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
}

/**
 * Only unique, expected success IDs confirm delivery. Invalid, oversized or absent
 * acknowledgements remain failed; response text never enters a log. A stalled body throws
 * into the retry.
 */
async function successCount(
	res: Response,
	batch: IngestionEvent[],
	signal: AbortSignal,
): Promise<number> {
	const text = await readBounded(res, signal);
	if (text === null) return 0; // Counted as failed by the caller's delivery totals.
	let body: { successes?: unknown; errors?: unknown };
	try {
		body = JSON.parse(text);
	} catch {
		return 0; // Counted as failed by the caller's delivery totals.
	}
	if (!Array.isArray(body?.successes) || !Array.isArray(body?.errors)) return 0;
	const expected = new Set(batch.map((e) => e.id));
	const seen = new Set<string>();
	let successes = 0;
	for (const entry of [...body.successes, ...body.errors]) {
		if (!entry || typeof entry.id !== "string" || !expected.has(entry.id) || seen.has(entry.id))
			return 0;
		seen.add(entry.id);
	}
	for (const entry of body.successes) {
		if (Number.isInteger(entry.status) && entry.status >= 200 && entry.status < 300) successes++;
	}
	return successes;
}

export function makeSender(url: string, auth: string, opts: SendOpts = {}) {
	const o = { ...DEFAULTS, timer: realTimer, ...opts };
	const totals: Totals = { sent: 0, failed: 0, dropped: 0 };
	const queue: IngestionEvent[] = [];
	const stop = new AbortController();
	let inFlight = 0;
	let pumping: Promise<void> | undefined;
	let draining = false;

	const count = (sent: number, failed: number) => {
		if (stop.signal.aborted) return;
		totals.sent += sent;
		totals.failed += failed;
		inFlight = 0;
	};

	async function post(batch: IngestionEvent[]): Promise<void> {
		for (let attempt = 0; ; attempt++) {
			let retry = true;
			const expired = new AbortController();
			const cancel = o.timer(() => expired.abort(), o.timeoutMs);
			const signal = AbortSignal.any([expired.signal, stop.signal]);
			try {
				const res = await fetch(url, {
					method: "POST",
					headers: { Authorization: auth, "Content-Type": "application/json" },
					body: JSON.stringify({ batch }),
					signal,
				});
				if (res.ok) {
					const sent = await successCount(res, batch, signal);
					return count(sent, batch.length - sent);
				}
				await res.body?.cancel();
				retry = res.status === 429 || res.status >= 500;
			} catch {
				// network error, timeout or shutdown abort: retryable
			} finally {
				cancel();
			}
			if (!retry || attempt >= 1 || stop.signal.aborted) return count(0, batch.length);
			await sleep(o.timer, o.retryDelayMs, stop.signal);
		}
	}

	function pump(): Promise<void> {
		pumping ??= (async () => {
			while (!stop.signal.aborted && (queue.length >= o.batchSize || (draining && queue.length))) {
				const batch = queue.splice(0, o.batchSize);
				inFlight = batch.length;
				await post(batch);
			}
		})().finally(() => {
			pumping = undefined;
		});
		return pumping;
	}

	return {
		push(event: IngestionEvent): void {
			queue.push(event);
			const over = queue.length - o.maxQueued;
			if (over > 0) totals.dropped += queue.splice(0, over).length;
			if (queue.length >= o.batchSize) void pump();
		},
		/** Flush what remains within the shutdown bound; the rest counts as dropped. */
		async close(): Promise<Totals> {
			draining = true;
			const bound = new AbortController();
			// `pumping` can still hold a pump whose loop already ended; go round until the queue is empty.
			const drain = async () => {
				while (pumping || (queue.length && !stop.signal.aborted)) await pump();
			};
			await Promise.race([drain(), sleep(o.timer, o.shutdownBoundMs, bound.signal)]);
			bound.abort();
			if (pumping || queue.length) {
				totals.dropped += queue.splice(0).length + inFlight;
				stop.abort();
			}
			return { ...totals };
		},
	};
}
