import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import type { WatcherConfig } from "../../src/config/schema";
import type { StatusSnapshot } from "../../src/status/query";
import {
	createStatusHandler,
	type DoorbellWiring,
	startStatusServer,
} from "../../src/status/server";
import { withTestDb } from "../db/helpers";
import { until } from "../support/wait-until";

const SNAPSHOT: StatusSnapshot = {
	generatedAt: "2026-07-19T18:00:00Z",
	repositories: [],
	heldBoxes: [],
	unconfirmedAllocations: [],
	tracedAttempts: [],
};

function config(): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{
				name: "rodaddy/open-brain",
				provider: "github",
				checks: "standard",
				gate_selection: "full",
			},
		],
		job_templates: [],
		doorbell_enabled: true,
		shadow_publish: false,
	};
}

/** Build a handler with an optional doorbell and a wake counter. */
function handlerWith(doorbell?: Partial<DoorbellWiring>, accepting?: () => boolean) {
	let wakes = 0;
	const wiring: DoorbellWiring | undefined = doorbell
		? {
				config: doorbell.config ?? config(),
				wake:
					doorbell.wake ??
					(() => {
						wakes++;
					}),
			}
		: undefined;
	const handler = createStatusHandler({
		source: async () => SNAPSHOT,
		pollIntervalMinutes: 15,
		doorbell: wiring,
		accepting,
	});
	return { handler, wakes: () => wakes };
}

function doorbellReq(body: unknown, init: RequestInit = {}): Request {
	// A real loopback client sends a loopback Host. Bun's `new Request` does not
	// auto-populate Host, so the fixture sets it explicitly; the DNS-rebinding
	// guard requires it. Header overrides in `init` are MERGED (not replaced) so a
	// caller tweaking content-type still keeps the loopback Host, while a caller
	// can override host explicitly to exercise the rebinding guard.
	const { headers: initHeaders, ...restInit } = init;
	const headers = new Headers({
		"content-type": "application/json",
		host: "localhost",
	});
	if (initHeaders) {
		for (const [k, v] of new Headers(initHeaders)) {
			headers.set(k, v);
		}
	}
	return new Request("http://localhost/doorbell", {
		method: "POST",
		headers,
		body: typeof body === "string" ? body : JSON.stringify(body),
		...restInit,
	});
}

describe("status server routing", () => {
	test("GET / still serves HTML", async () => {
		const { handler } = handlerWith();
		const res = await handler(new Request("http://localhost/"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
	});

	test("POST /doorbell without a configured doorbell stays method-not-allowed (no generic RPC)", async () => {
		const { handler } = handlerWith(); // no doorbell wiring
		const res = await handler(doorbellReq({ repository: "rodaddy/open-brain" }));
		expect(res.status).toBe(405);
	});

	test("non-POST methods on /doorbell remain method-not-allowed", async () => {
		const { handler } = handlerWith({ config: config() });
		for (const method of ["PUT", "DELETE", "PATCH"]) {
			const res = await handler(new Request("http://localhost/doorbell", { method }));
			expect(res.status).toBe(405);
		}
	});
});

describe("POST /doorbell", () => {
	test("accepted identifiers wake an early pass (202)", async () => {
		const { handler, wakes } = handlerWith({ config: config() });
		const res = await handler(doorbellReq({ repository: "rodaddy/open-brain" }));
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ accepted: true });
		expect(wakes()).toBe(1);
	});

	test("the 202 resolves before an unresolved (still-running) wake pass", async () => {
		// The no-wait contract: the endpoint fires the coalescing trigger and
		// returns 202 immediately. It must NOT await the pass, or a slow pass would
		// block the caller for the whole reconciliation. We prove this by handing a
		// wake that never resolves and asserting the response resolves anyway.
		let wakeCalled = false;
		let wakeResolved = false;
		const { handler } = handlerWith({
			config: config(),
			// A never-resolving wake models a long in-flight pass.
			wake: () => {
				wakeCalled = true;
				return new Promise<void>(() => {}).then(() => {
					wakeResolved = true;
				});
			},
		});
		const res = await handler(doorbellReq({ repository: "rodaddy/open-brain" }));
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ accepted: true });
		// The wake was fired but the response did not wait for it to complete.
		expect(wakeCalled).toBe(true);
		expect(wakeResolved).toBe(false);
	});

	test("the validated ring is forwarded to the wake seam", async () => {
		// Identifiers must not be discarded at the HTTP boundary: the accepted ring
		// reaches wake, even though the default service wiring subsumes the target.
		let seen: unknown = null;
		const { handler } = handlerWith({
			config: config(),
			wake: (ring) => {
				seen = ring;
			},
		});
		const res = await handler(doorbellReq({ repository: "rodaddy/open-brain", item: 42 }));
		expect(res.status).toBe(202);
		expect(seen).toEqual({ repository: "rodaddy/open-brain", item: 42 });
	});

	test("a request that finishes reading after shutdown starts is refused before wake", async () => {
		let accepting = true;
		let wakes = 0;
		let markStarted: () => void = () => {};
		let releaseBody: () => void = () => {};
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const bodyGate = new Promise<void>((resolve) => {
			releaseBody = resolve;
		});
		const payload = new TextEncoder().encode(JSON.stringify({ repository: "rodaddy/open-brain" }));
		let emitted = false;
		const stream = new ReadableStream<Uint8Array>({
			async pull(controller) {
				if (emitted) return;
				emitted = true;
				markStarted();
				await bodyGate;
				controller.enqueue(payload);
				controller.close();
			},
		});
		const { handler } = handlerWith(
			{
				config: config(),
				wake: () => {
					wakes++;
				},
			},
			() => accepting,
		);
		const request = new Request("http://localhost/doorbell", {
			method: "POST",
			headers: { "content-type": "application/json", host: "localhost" },
			body: stream,
			duplex: "half",
		} as RequestInit);

		const responsePromise = handler(request);
		await started;
		accepting = false;
		releaseBody();
		const response = await responsePromise;
		expect(response.status).toBe(503);
		expect(await response.json()).toEqual({
			accepted: false,
			error: "server is shutting down",
		});
		expect(wakes).toBe(0);
	});

	test("an async wake rejection is handled without waiting or an unhandled rejection", async () => {
		// A wake that rejects asynchronously must not block the response nor leak an
		// unhandled rejection. We capture process-level unhandled rejections for the
		// duration of the call and assert none escape.
		const leaks: unknown[] = [];
		const onUnhandled = (reason: unknown) => leaks.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const { handler } = handlerWith({
				config: config(),
				wake: () => Promise.reject(new Error("pass failed")),
			});
			const res = await handler(doorbellReq({ repository: "rodaddy/open-brain" }));
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ accepted: true });
			// Flush microtasks/macrotasks so any unhandled rejection would surface.
			await new Promise((r) => setTimeout(r, 0)); // fixed-sleep-ok: asserts absence, no completion signal
			expect(leaks).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("a wake failure is recorded, sync and async, so a dead doorbell is visible", async () => {
		// The doorbell answers 202 whether or not the wake succeeded, because the
		// periodic sweep stays authoritative. That makes a PERMANENTLY broken early-wake
		// path invisible unless it is logged. Both throw shapes must report.
		// The logger (src/log.ts, pino) writes NDJSON synchronously to fd 2 via
		// fs.writeSync, NOT through process.stderr.write, so capture at the
		// descriptor level. Each emit is one JSON object per line.
		const lines: string[] = [];
		const wakeFailures = () =>
			lines
				.flatMap((chunk) => chunk.split("\n"))
				.map((l) => l.trim())
				.filter(Boolean)
				.map((l) => JSON.parse(l) as Record<string, unknown>)
				.filter((obj) => obj.msg === "status.doorbell.wake_failed");
		const realWriteSync = fs.writeSync;
		(fs as { writeSync: typeof fs.writeSync }).writeSync = ((
			fd: number,
			data: string | NodeJS.ArrayBufferView,
			...rest: unknown[]
		) => {
			if (fd === 2) {
				const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString();
				lines.push(text);
				return typeof data === "string" ? Buffer.byteLength(text) : (data as Uint8Array).length;
			}
			return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
		}) as typeof fs.writeSync;
		try {
			const sync = handlerWith({
				config: config(),
				wake: () => {
					throw new Error("scheduler gone");
				},
			});
			expect((await sync.handler(doorbellReq({ repository: "rodaddy/open-brain" }))).status).toBe(
				202,
			);

			const async = handlerWith({
				config: config(),
				wake: () => Promise.reject(new Error("pass failed")),
			});
			expect((await async.handler(doorbellReq({ repository: "rodaddy/open-brain" }))).status).toBe(
				202,
			);
			await until(() => wakeFailures().length === 2);
		} finally {
			(fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
		}

		const failures = wakeFailures();
		expect(failures).toHaveLength(2);
		// Context values are strings via bounded(); sync is emitted as "true"/"false".
		expect(failures.some((o) => o.sync === "true" && o.cause === "scheduler gone")).toBe(true);
		expect(failures.some((o) => o.sync === "false" && o.cause === "pass failed")).toBe(true);
	});

	test("unknown repository is rejected without waking", async () => {
		const { handler, wakes } = handlerWith({ config: config() });
		const res = await handler(doorbellReq({ repository: "rodaddy/not-managed" }));
		expect(res.status).toBe(400);
		expect(wakes()).toBe(0);
	});

	test("arbitrary extra fields are rejected without waking", async () => {
		const { handler, wakes } = handlerWith({ config: config() });
		const res = await handler(
			doorbellReq({ repository: "rodaddy/open-brain", template: "pr-review" }),
		);
		expect(res.status).toBe(400);
		expect(wakes()).toBe(0);
	});

	test("wrong content-type is 415 without waking", async () => {
		const { handler, wakes } = handlerWith({ config: config() });
		const res = await handler(
			doorbellReq(
				{ repository: "rodaddy/open-brain" },
				{ headers: { "content-type": "text/plain" } },
			),
		);
		expect(res.status).toBe(415);
		expect(wakes()).toBe(0);
	});

	test("an exact application/json with charset parameter is accepted", async () => {
		// Parameters after the media type are allowed; only the bare media type
		// must equal application/json.
		const { handler, wakes } = handlerWith({ config: config() });
		const res = await handler(
			doorbellReq(
				{ repository: "rodaddy/open-brain" },
				{ headers: { "content-type": "application/json; charset=utf-8" } },
			),
		);
		expect(res.status).toBe(202);
		expect(wakes()).toBe(1);
	});

	test("false content-types that merely contain the token are 415 (exact media-type match)", async () => {
		// Substring matching would accept these; exact media-type matching rejects
		// them. None may wake a pass.
		for (const ct of [
			"text/application/json-evil",
			"application/json-x",
			"application/jsonp",
			"x-application/json",
			"application/vnd.json",
		]) {
			const { handler, wakes } = handlerWith({ config: config() });
			const res = await handler(
				doorbellReq({ repository: "rodaddy/open-brain" }, { headers: { "content-type": ct } }),
			);
			expect(res.status).toBe(415);
			expect(wakes()).toBe(0);
		}
	});

	test("oversize body is 413 without waking", async () => {
		const { handler, wakes } = handlerWith({ config: config() });
		const big = `{"repository":"rodaddy/open-brain","x":"${"a".repeat(2000)}"}`;
		const res = await handler(doorbellReq(big));
		expect(res.status).toBe(413);
		expect(wakes()).toBe(0);
	});

	test("multibyte UTF-8 is measured in bytes, not UTF-16 code units", async () => {
		// The cap is 1024 UTF-8 bytes. A body whose UTF-16 length is under 1024 but
		// whose UTF-8 byte length is over 1024 must still be rejected — proving the
		// reader counts bytes, not code units. "é" is 2 UTF-8 bytes / 1 code unit,
		// so 550 of them = 1100 bytes but only 550 code units.
		const { handler, wakes } = handlerWith({ config: config() });
		const multibyteOver = `{"repository":"rodaddy/${"é".repeat(550)}"}`;
		expect(multibyteOver.length).toBeLessThan(1024); // UTF-16 code units
		expect(new TextEncoder().encode(multibyteOver).byteLength).toBeGreaterThan(1024); // UTF-8 bytes
		const res = await handler(doorbellReq(multibyteOver));
		expect(res.status).toBe(413);
		expect(wakes()).toBe(0);
	});

	test("a valid multibyte-decoded body round-trips to valid JSON under the cap", async () => {
		// A well-formed JSON body containing multibyte characters within the byte
		// cap must decode correctly. If the reader mangled multibyte bytes, the
		// decoded text would be invalid JSON (400 "not valid JSON"). Instead it
		// parses cleanly and is rejected only at the schema layer for the unknown
		// repository — proving the bytes decoded to the intended non-ASCII string.
		const { handler, wakes } = handlerWith({ config: config() });
		// Valid JSON, valid repo-name shape (ASCII), plus a multibyte string value
		// in an extra field to exercise decoding. .strict() rejects the extra field
		// AFTER a successful JSON parse of the multibyte content.
		const body = JSON.stringify({ repository: "rodaddy/open-brain", note: "café ☕ ünïcode" });
		const res = await handler(doorbellReq(body));
		const json = (await res.json()) as { error?: string };
		expect(res.status).toBe(400);
		// The failure is schema validation, NOT a JSON parse error — so decoding
		// of the multibyte bytes succeeded.
		expect(json.error).not.toContain("not valid JSON");
		expect(wakes()).toBe(0);
	});

	test("a chunked body with no content-length is still bounded (413, no unbounded buffering)", async () => {
		// A sender can omit content-length and stream the body in chunks. The
		// bounded reader must stop at the cap regardless, so an oversize chunked
		// body is rejected without buffering it all. We build a ReadableStream that
		// would emit far more than the cap and assert 413 without waking.
		const { handler, wakes } = handlerWith({ config: config() });
		let bytesPulled = 0;
		const chunk = new TextEncoder().encode("a".repeat(256));
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				// Emit chunks; if the reader kept pulling unboundedly this would run
				// forever. The bounded reader must cancel well before that.
				bytesPulled += chunk.byteLength;
				controller.enqueue(chunk);
				if (bytesPulled > 1_000_000) {
					controller.close();
				}
			},
		});
		const req = new Request("http://localhost/doorbell", {
			method: "POST",
			// Loopback host (rebinding guard) but deliberately no content-length.
			headers: { "content-type": "application/json", host: "localhost" },
			body: stream,
			duplex: "half",
		} as RequestInit);
		const res = await handler(req);
		expect(res.status).toBe(413);
		expect(wakes()).toBe(0);
		// The reader stopped near the cap, not after draining ~1 MB of chunks.
		expect(bytesPulled).toBeLessThan(10_000);
	});

	test("invalid JSON is 400 without waking", async () => {
		const { handler, wakes } = handlerWith({ config: config() });
		const res = await handler(doorbellReq("{not json"));
		expect(res.status).toBe(400);
		expect(wakes()).toBe(0);
	});

	test("a wake failure is harmless: the ring is still accepted (sweep unaffected)", async () => {
		// The periodic sweep is authoritative; a doorbell wake failure must not
		// surface as an error that could stop or replace it. The endpoint swallows
		// the wake error and returns its stable accepted response.
		const { handler } = handlerWith({
			config: config(),
			wake: () => {
				throw new Error("scheduler unavailable");
			},
		});
		const res = await handler(doorbellReq({ repository: "rodaddy/open-brain" }));
		expect(res.status).toBe(202);
		expect(await res.json()).toEqual({ accepted: true });
	});
});

describe("POST /doorbell DNS-rebinding guard (finding P2)", () => {
	test("a non-loopback Host is forbidden (403) before any body read or wake", async () => {
		// A browser steered to POST to an attacker hostname that resolves to
		// loopback carries that hostname in Host. It must be refused with a stable
		// 403 without waking.
		for (const host of ["evil.example.com", "attacker.test:8787", "10.0.0.5", "192.168.1.10:80"]) {
			const { handler, wakes } = handlerWith({ config: config() });
			const res = await handler(
				doorbellReq({ repository: "rodaddy/open-brain" }, { headers: { host } }),
			);
			expect(res.status).toBe(403);
			expect(wakes()).toBe(0);
		}
	});

	test("a missing Host is forbidden (403) — an unnamed host is never accepted", async () => {
		// Build a request with no Host header at all (bypass the fixture default).
		const { handler, wakes } = handlerWith({ config: config() });
		const req = new Request("http://localhost/doorbell", {
			method: "POST",
			headers: { "content-type": "application/json" }, // deliberately no host
			body: JSON.stringify({ repository: "rodaddy/open-brain" }),
		});
		// Ensure the harness did not silently add a Host.
		if (req.headers.get("host") === null) {
			const res = await handler(req);
			expect(res.status).toBe(403);
			expect(wakes()).toBe(0);
		}
	});

	test("loopback Host variants are accepted (localhost, 127.0.0.1, [::1], with/without port)", async () => {
		for (const host of [
			"localhost",
			"localhost:8787",
			"127.0.0.1",
			"127.0.0.1:8787",
			"[::1]",
			"[::1]:8787",
		]) {
			const { handler, wakes } = handlerWith({ config: config() });
			const res = await handler(
				doorbellReq({ repository: "rodaddy/open-brain" }, { headers: { host } }),
			);
			expect(res.status).toBe(202);
			expect(wakes()).toBe(1);
		}
	});

	test("a non-numeric port on an otherwise-loopback Host is forbidden (403)", async () => {
		const { handler, wakes } = handlerWith({ config: config() });
		const res = await handler(
			doorbellReq({ repository: "rodaddy/open-brain" }, { headers: { host: "localhost:evil" } }),
		);
		expect(res.status).toBe(403);
		expect(wakes()).toBe(0);
	});

	test("a present non-loopback Origin is forbidden (403) even with a loopback Host", async () => {
		for (const origin of ["https://evil.example.com", "http://attacker.test:8080"]) {
			const { handler, wakes } = handlerWith({ config: config() });
			const res = await handler(
				doorbellReq({ repository: "rodaddy/open-brain" }, { headers: { origin } }),
			);
			expect(res.status).toBe(403);
			expect(wakes()).toBe(0);
		}
	});

	test("a present loopback Origin is accepted", async () => {
		for (const origin of ["http://localhost:8787", "http://127.0.0.1", "http://[::1]:8787"]) {
			const { handler, wakes } = handlerWith({ config: config() });
			const res = await handler(
				doorbellReq({ repository: "rodaddy/open-brain" }, { headers: { origin } }),
			);
			expect(res.status).toBe(202);
			expect(wakes()).toBe(1);
		}
	});

	test("a malformed Origin is forbidden (403)", async () => {
		const { handler, wakes } = handlerWith({ config: config() });
		const res = await handler(
			doorbellReq({ repository: "rodaddy/open-brain" }, { headers: { origin: "not-a-url" } }),
		);
		expect(res.status).toBe(403);
		expect(wakes()).toBe(0);
	});
});

describe("POST /doorbell Content-Length pre-check (finding P3)", () => {
	test("a valid Content-Length over the cap is rejected immediately (413) without waking", async () => {
		// A declared length over 1024 is refused up front. The body here would parse
		// to a perfectly valid ring; the 413 proves the length pre-check fires before
		// the body is ever validated (which would otherwise return 202).
		const { handler, wakes } = handlerWith({ config: config() });
		const body = JSON.stringify({ repository: "rodaddy/open-brain" });
		const res = await handler(doorbellReq(body, { headers: { "content-length": "2048" } }));
		expect(res.status).toBe(413);
		expect(wakes()).toBe(0);
	});

	test("a valid in-range Content-Length still parses and validates normally", async () => {
		const { handler, wakes } = handlerWith({ config: config() });
		const body = JSON.stringify({ repository: "rodaddy/open-brain" });
		const len = String(new TextEncoder().encode(body).byteLength);
		const res = await handler(doorbellReq(body, { headers: { "content-length": len } }));
		expect(res.status).toBe(202);
		expect(wakes()).toBe(1);
	});

	test("a deceptive (small) Content-Length does not bypass streaming enforcement", async () => {
		// A sender declares a tiny length but streams far more. Streaming enforcement
		// counts actual bytes and rejects with 413 regardless of the declared value.
		const { handler, wakes } = handlerWith({ config: config() });
		let bytesPulled = 0;
		const chunk = new TextEncoder().encode("a".repeat(256));
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				bytesPulled += chunk.byteLength;
				controller.enqueue(chunk);
				if (bytesPulled > 1_000_000) {
					controller.close();
				}
			},
		});
		const req = new Request("http://localhost/doorbell", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				host: "localhost",
				"content-length": "10", // deceptively small
			},
			body: stream,
			duplex: "half",
		} as RequestInit);
		const res = await handler(req);
		expect(res.status).toBe(413);
		expect(wakes()).toBe(0);
		expect(bytesPulled).toBeLessThan(10_000);
	});

	test("an invalid Content-Length falls through to streaming enforcement", async () => {
		// Malformed lengths (negative, non-decimal) are treated as unknown, not
		// trusted: a small valid body still succeeds via streaming.
		for (const cl of ["-5", "1e3", "12abc", " 10 ", "0x10"]) {
			const { handler, wakes } = handlerWith({ config: config() });
			const res = await handler(
				doorbellReq({ repository: "rodaddy/open-brain" }, { headers: { "content-length": cl } }),
			);
			// The tiny body is well under the cap, so streaming accepts it.
			expect(res.status).toBe(202);
			expect(wakes()).toBe(1);
		}
	});
});

describe("POST /doorbell stream failures (finding P2)", () => {
	test("a body stream that errors on read yields a bounded 400 without waking", async () => {
		const { handler, wakes } = handlerWith({ config: config() });
		const stream = new ReadableStream<Uint8Array>({
			pull() {
				throw new Error("transport read failure");
			},
		});
		const req = new Request("http://localhost/doorbell", {
			method: "POST",
			headers: { "content-type": "application/json", host: "localhost" },
			body: stream,
			duplex: "half",
		} as RequestInit);
		const res = await handler(req);
		expect(res.status).toBe(400);
		expect(wakes()).toBe(0);
	});

	test("a read error does not surface as an unhandled rejection", async () => {
		const leaks: unknown[] = [];
		const onUnhandled = (reason: unknown) => leaks.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			const { handler } = handlerWith({ config: config() });
			const stream = new ReadableStream<Uint8Array>({
				pull() {
					throw new Error("transport read failure");
				},
			});
			const req = new Request("http://localhost/doorbell", {
				method: "POST",
				headers: { "content-type": "application/json", host: "localhost" },
				body: stream,
				duplex: "half",
			} as RequestInit);
			const res = await handler(req);
			expect(res.status).toBe(400);
			await new Promise((r) => setTimeout(r, 0)); // fixed-sleep-ok: asserts absence, no completion signal
			expect(leaks).toEqual([]);
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}
	});

	test("once oversize is known, a cancel failure does not replace the 413", async () => {
		// The reader crosses the cap and calls cancel(); if cancel rejects, the
		// authoritative verdict is still 413 (too-large), not a downgraded 400.
		const { handler, wakes } = handlerWith({ config: config() });
		const chunk = new TextEncoder().encode("a".repeat(2048)); // over the 1024 cap
		let delivered = false;
		const stream = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (!delivered) {
					delivered = true;
					controller.enqueue(chunk);
				}
			},
			cancel() {
				// Cancellation fails; must not mask the oversize verdict.
				throw new Error("cancel failed");
			},
		});
		const req = new Request("http://localhost/doorbell", {
			method: "POST",
			headers: { "content-type": "application/json", host: "localhost" },
			body: stream,
			duplex: "half",
		} as RequestInit);
		const res = await handler(req);
		expect(res.status).toBe(413);
		expect(wakes()).toBe(0);
	});
});

/**
 * The `/status.json` build-bump view is only visible if the SERVER forwards the
 * enrolment config into `getStatus` (§8). `createStatusHandler` takes a `source`
 * closure, so every test above stubs the snapshot and cannot see that
 * forwarding at all — this one binds the REAL `startStatusServer`, which is
 * where the closure is built, and reads the response over HTTP.
 *
 * An EMPTY database is deliberate: the assertion is that the enrolled
 * environment APPEARS, carrying a null desired tag, rather than that a bump was
 * computed. A repository the view never reached would yield `[]`, which is
 * exactly what the pass-through's absence produces — so the empty-db case is
 * the one that distinguishes them.
 *
 * Mutation-proven: deleting `buildBumpRepositories: opts.buildBumpRepositories`
 * from `startStatusServerImpl` makes `buildBump` `[]` and this test fails.
 */
describe("startStatusServer build-bump pass-through (§8)", () => {
	test("/status.json carries an enrolled repository's environments", async () => {
		await withTestDb(async (db) => {
			const server = startStatusServer({
				db,
				port: 0,
				pollIntervalMinutes: 15,
				buildBumpRepositories: [
					{
						name: "rodaddy/rtech-mcps",
						build_bump: {
							environments: [{ name: "staging", app_dirs: ["rtech-mcps-staging"] }],
						},
					},
				],
			});
			try {
				const res = await fetch(`http://127.0.0.1:${server.port}/status.json`);
				expect(res.status).toBe(200);
				const body = (await res.json()) as StatusSnapshot;
				expect(body.buildBump).toEqual([
					{
						repository: "rodaddy/rtech-mcps",
						image: "rtech-mcps",
						environment: "staging",
						desiredTag: null,
						markerSha: null,
						lastPr: null,
						lastOutcome: null,
						attempts: 0,
					},
				]);
			} finally {
				await server.stop();
			}
		});
	});
});

describe("GET /metrics", () => {
	test("serves the Prometheus exposition with the text-format content type", async () => {
		const { handler } = handlerWith();
		const res = await handler(new Request("http://localhost/metrics"));

		expect(res.status).toBe(200);
		// `version=0.0.4` is what identifies this as the Prometheus text format; a
		// bare `text/plain` scrapes but leaves the version to the scraper's default.
		expect(res.headers.get("content-type")).toBe("text/plain; version=0.0.4; charset=utf-8");

		const body = await res.text();
		expect(body).toContain("# TYPE factory_jobs_failed gauge");
		expect(body).toContain("factory_passes_started_total");
	});

	test("refuses a non-GET method like every other status route", async () => {
		const { handler } = handlerWith();
		const res = await handler(new Request("http://localhost/metrics", { method: "POST" }));
		expect(res.status).toBe(405);
	});
});

describe("GET /metrics peer allowlist", () => {
	/** A fake Bun server reporting a fixed peer, without binding a real socket. */
	const peer = (address: string) => ({ requestIP: (_req: Request) => ({ address }) });
	const withAllow = (metricsScrapeAllow?: readonly string[]) =>
		createStatusHandler({
			source: async () => SNAPSHOT,
			pollIntervalMinutes: 15,
			metricsScrapeAllow,
		});

	test("default (no allowlist) refuses an off-loopback /metrics scrape: today's behavior", async () => {
		const res = await withAllow()(
			new Request("http://10.0.20.111:8787/metrics"),
			peer("10.0.20.5"),
		);
		expect(res.status).toBe(403);
	});

	test("an empty allowlist refuses an off-loopback /metrics scrape", async () => {
		const res = await withAllow([])(
			new Request("http://10.0.20.111:8787/metrics"),
			peer("10.0.20.5"),
		);
		expect(res.status).toBe(403);
	});

	test("a peer inside an allowed CIDR is served /metrics", async () => {
		const res = await withAllow(["10.0.0.0/16"])(
			new Request("http://10.0.20.111:8787/metrics"),
			peer("10.0.20.5"),
		);
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("factory_passes_started_total");
	});

	test("an exact allowed address matches, including Bun's IPv4-mapped form", async () => {
		const handler = withAllow(["10.0.20.5"]);
		const plain = await handler(new Request("http://h:8787/metrics"), peer("10.0.20.5"));
		const mapped = await handler(new Request("http://h:8787/metrics"), peer("::ffff:10.0.20.5"));
		expect(plain.status).toBe(200);
		expect(mapped.status).toBe(200);
	});

	test("a peer outside the allowlist is still refused", async () => {
		const res = await withAllow(["10.0.0.0/16"])(
			new Request("http://h:8787/metrics"),
			peer("10.72.0.9"),
		);
		expect(res.status).toBe(403);
	});

	test("an allowed peer reaches ONLY /metrics: every other status route stays refused", async () => {
		const handler = withAllow(["10.0.0.0/16"]);
		for (const path of ["/status.json", "/healthz", "/", "/index.html", "/nope"]) {
			const res = await handler(new Request(`http://h:8787${path}`), peer("10.0.20.5"));
			expect(res.status).toBe(403);
		}
	});

	test("an allowed peer cannot POST /metrics", async () => {
		const res = await withAllow(["10.0.0.0/16"])(
			new Request("http://h:8787/metrics", { method: "POST" }),
			peer("10.0.20.5"),
		);
		expect(res.status).toBe(403);
	});
});
