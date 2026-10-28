/**
 * @module status/server
 * @description Serve the local watcher status page from the same Bun process.
 *   `/` returns server-rendered HTML; `/status.json` returns the same bounded
 *   status as JSON; `/healthz` answers the one process-level liveness question
 *   neither of those does — did the reconciliation LOOP start a pass recently
 *   — with its status code, 200 while live and 503 when stale or when no
 *   pass has started. The server binds to localhost (the trusted network, per
 *   _DOCS/architecture.md) and is read-only apart from one fixed, optional
 *   `POST /doorbell` endpoint: an identifiers-only seam that asks the existing
 *   scheduler to run an *early* reconciliation pass. The doorbell selects no
 *   job, template, command, or output — it only coalesces onto the same
 *   authoritative single-flight pass the 15-minute sweep drives (see
 *   ../reconcile/doorbell). Before any body read or wake, the doorbell requires
 *   a loopback `Host` authority and rejects any present non-loopback `Origin`,
 *   closing the DNS-rebinding vector without adding a token system. A request
 *   handler is also exported directly so tests can exercise routing without
 *   opening a socket.
 *
 *   THE BIND IS NO LONGER ALWAYS LOOPBACK. With a Forgejo webhook
 *   secret configured the service asks for `0.0.0.0`, because the forge posts to
 *   this process from another host. That removes the bind as the thing enforcing
 *   the status surface's "localhost only" property, so the handler now checks
 *   the REMOTE ADDRESS itself: Bun passes the server as `fetch`'s second
 *   argument, and every route except the webhook refuses a peer whose
 *   `server.requestIP()` is not loopback with a bounded 403 (the doorbell's
 *   `Host`/`Origin` checks stay as they were). Direct handler calls (tests, the
 *   handler used without a server) pass no server and skip the check — routing
 *   tests never had a socket to have an address on.
 *
 *   ONE NARROW EXCEPTION: `metricsScrapeAllow` lists addresses/CIDRs a
 *   Prometheus scraper may use, and a peer matching it is let through for
 *   `GET /metrics` ONLY. Empty (the default) is the loopback-only rule above.
 *
 *   The webhook route itself is `POST /hooks/forgejo`, mounted only when
 *   `forgeHook` wiring is present, and it authenticates by HMAC rather than by
 *   network position — see ../hooks/forgejo for its decision order.
 *
 * @outputs
 *   - `createStatusHandler` -- build a fetch handler over a status source
 *   - `startStatusServer` -- bind the handler to a port (loopback by default)
 *
 * @dependencies
 *   - ./query -- StatusSnapshot type
 *   - ./render -- HTML rendering
 *   - ../hooks/forgejo -- inbound Forgejo webhook receiver
 *   - ../reconcile/doorbell -- identifiers-only early-reconciliation validation
 */

import { BlockList, isIP } from "node:net";
import type { WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import { type ForgeHookWiring, handleForgejoHook } from "../hooks/forgejo";
import { errorClass, errorMessage, log, traced } from "../log";
import { alertDeliveryTally } from "../observability/alert-tally";
import type { HostConflictStatus } from "../observability/host-conflicts";
import { type DoorbellRing, evaluateDoorbell } from "../reconcile/doorbell";
import { renderMetrics } from "./metrics";
import { isPassLive, type PassLivenessStatus } from "./pass-liveness";
import { type BuildBumpRepositoryConfig, getStatus, type StatusSnapshot } from "./query";
import { renderStatusHtml } from "./render";

/** A source of the current status snapshot (injectable for tests). */
export type StatusSource = () => Promise<StatusSnapshot>;

/**
 * Optional doorbell wiring. When present, `POST /doorbell` validates an
 * identifiers-only body against `config` and, on acceptance, calls `wake` to
 * request an early pass. `wake` MUST be the existing scheduler's coalescing
 * trigger so duplicate rings collapse onto the in-flight pass and no second
 * scheduler or dispatch path is created.
 */
export interface DoorbellWiring {
	config: WatcherConfig;
	/**
	 * Request an early reconciliation pass (the scheduler's coalescing trigger).
	 * Receives the validated identifiers-only ring so a wiring may use them, but
	 * the current authoritative pass sweeps *all* configured repositories, so the
	 * default wiring subsumes the target and ignores the ring (see service.ts).
	 * The handler never awaits the returned promise — it fires and returns 202.
	 */
	wake: (ring: DoorbellRing) => Promise<void> | void;
}

/**
 * Largest doorbell body we will read, in UTF-8 bytes. The body is a tiny
 * identifiers-only JSON object; anything larger is rejected before parsing so a
 * sender cannot force unbounded buffering — including a chunked body that
 * declares no `content-length`.
 */
const DOORBELL_MAX_BODY_BYTES = 1024;

/**
 * The one content type the doorbell accepts. Matched exactly (case-insensitive)
 * against the media type parsed out of the `Content-Type` header, so values like
 * `text/application/json-evil` or `application/json-x` are rejected.
 */
const DOORBELL_MEDIA_TYPE = "application/json";

/**
 * Loopback host allowlist for the doorbell (the one write endpoint). The server
 * binds to 127.0.0.1, but a browser on the same machine can still be steered
 * (DNS rebinding) into POSTing to an attacker-controlled hostname that resolves
 * to loopback. Requiring the `Host` header — and any present `Origin` — to name
 * a loopback authority closes that: an off-machine or rebound `Host` never
 * matches, so no such request reaches the body read or wake. This is a host
 * check only; it is not a token system and adds no credential surface.
 *
 * A bare `localhost`, `127.0.0.1`, or the IPv6 loopback `::1` (optionally
 * bracketed) is accepted, each with an optional numeric port.
 */
function isLoopbackHost(hostname: string): boolean {
	const bare = hostname.toLowerCase();
	if (bare === "localhost" || bare === "127.0.0.1" || bare === "::1" || bare === "[::1]") {
		return true;
	}
	return false;
}

/**
 * Split an authority (`Host` header value) into host and optional port and check
 * the host against the loopback allowlist. Accepts `localhost`, `127.0.0.1`, and
 * `[::1]`/`::1`, each with an optional numeric port. Anything else — a public
 * hostname, a non-loopback IP, a malformed authority, or a non-numeric port — is
 * rejected. A missing/empty `Host` is rejected: we never accept an unnamed host.
 */
function isLoopbackAuthority(hostHeader: string | null): boolean {
	if (hostHeader === null) {
		return false;
	}
	const value = hostHeader.trim();
	if (value === "") {
		return false;
	}
	// Bracketed IPv6 authority, e.g. `[::1]` or `[::1]:8787`.
	if (value.startsWith("[")) {
		const close = value.indexOf("]");
		if (close === -1) {
			return false;
		}
		const host = value.slice(0, close + 1);
		const rest = value.slice(close + 1);
		if (rest !== "" && !isNumericPort(rest)) {
			return false;
		}
		return isLoopbackHost(host);
	}
	// host[:port] where host is not an unbracketed IPv6 literal. A raw `::1`
	// carries no port, so treat a value with >1 colon as a bare IPv6 host.
	const colon = value.indexOf(":");
	if (colon !== -1 && value.indexOf(":", colon + 1) === -1) {
		const host = value.slice(0, colon);
		const port = value.slice(colon);
		if (!isNumericPort(port)) {
			return false;
		}
		return isLoopbackHost(host);
	}
	return isLoopbackHost(value);
}

/**
 * The remote addresses the doorbell accepts once the bind can be wider than
 * loopback. `::ffff:127.0.0.1` is the IPv4-mapped form Bun reports for
 * an IPv4 client on a dual-stack listener, so omitting it would refuse ordinary
 * local callers on exactly the deployments this check exists for.
 */
const LOOPBACK_REMOTE_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Bun's server handle, narrowed to the one method the handler uses. Bun passes
 * the server as `fetch`'s second argument, so it flows in unchanged; it is
 * optional because a directly-called handler has no socket behind it.
 */
export interface RequestAddressSource {
	requestIP(req: Request): { address: string } | null;
}

/**
 * Is this request's peer on the loopback interface?
 *
 * `true` when no server was supplied: a handler invoked directly (tests, an
 * embedding caller) has no connection to read an address from, and treating that
 * absence as a refusal would break every routing test without adding security —
 * there is no remote peer to defend against.
 */
function isLoopbackRemote(server: RequestAddressSource | undefined, req: Request): boolean {
	if (server === undefined) {
		return true;
	}
	const address = server.requestIP(req)?.address;
	return address !== undefined && LOOPBACK_REMOTE_ADDRESSES.has(address);
}

/**
 * Build the `/metrics` scrape allowlist from config entries, which the
 * config schema has already validated as addresses or in-range CIDRs. `null`
 * when empty, so the default path allocates nothing and matches nothing.
 */
function buildScrapeAllow(entries: readonly string[] | undefined): BlockList | null {
	if (entries === undefined || entries.length === 0) {
		return null;
	}
	const list = new BlockList();
	for (const entry of entries) {
		const [address = "", prefix] = entry.split("/");
		const type = isIP(address) === 6 ? "ipv6" : "ipv4";
		if (prefix === undefined) {
			list.addAddress(address, type);
		} else {
			list.addSubnet(address, Number(prefix), type);
		}
	}
	return list;
}

/**
 * Is this request's peer on the `/metrics` scrape allowlist? `BlockList.check`
 * matches Bun's IPv4-mapped IPv6 form (`::ffff:a.b.c.d`) against IPv4 entries,
 * so a dual-stack listener needs no normalization here.
 */
function isAllowedScraper(
	allow: BlockList | null,
	server: RequestAddressSource | undefined,
	req: Request,
): boolean {
	const address = allow === null ? undefined : server?.requestIP(req)?.address;
	if (allow === null || address === undefined) {
		return false;
	}
	const family = isIP(address);
	return family !== 0 && allow.check(address, family === 6 ? "ipv6" : "ipv4");
}

/** `:<digits>` with at least one decimal digit and nothing else. */
function isNumericPort(portWithColon: string): boolean {
	return /^:[0-9]+$/.test(portWithColon);
}

/**
 * A present `Origin` header must parse to a loopback hostname. A `null` or
 * absent Origin (non-CORS, same-origin, or a direct client) is allowed — only a
 * *present* cross-origin-style Origin whose hostname is not loopback is
 * rejected, which is exactly the DNS-rebinding vector we bound.
 */
function isOriginAllowed(originHeader: string | null): boolean {
	if (originHeader === null || originHeader === "null" || originHeader.trim() === "") {
		return true;
	}
	let parsed: URL;
	try {
		parsed = new URL(originHeader);
	} catch (err) {
		// Expected: a malformed Origin is a refusal, not a fault. The caller returns the
		// same bounded 403 as a non-loopback Origin and handleDoorbell logs that refusal,
		// so this line only names the parse failure — never the header value.
		//
		// CLASS ONLY, and this is not optional: Bun's URL TypeError quotes the whole
		// input verbatim (`"<value>" cannot be parsed as a URL.`), and Origin is
		// entirely request-controlled — so errorMessage here writes whatever a probing
		// sender chose into the log. Verified by reproducing it with a token-shaped
		// Origin.
		log("debug", "status.doorbell.origin_unparseable", { error_class: errorClass(err) });
		return false;
	}
	// URL hostname strips the port and brackets IPv6, so compare against the
	// unbracketed loopback forms plus the bracketed one URL yields for `::1`.
	const host = parsed.hostname.toLowerCase();
	return host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]";
}

/**
 * Parse the bare media type out of a `Content-Type` header value: lower-cased,
 * with any `; charset=...`/parameters and surrounding whitespace stripped. A
 * missing header yields the empty string.
 */
function mediaType(headerValue: string | null): string {
	if (headerValue === null) {
		return "";
	}
	const semicolon = headerValue.indexOf(";");
	const base = semicolon === -1 ? headerValue : headerValue.slice(0, semicolon);
	return base.trim().toLowerCase();
}

/** Outcome of reading a request body under the byte cap. */
type BodyRead =
	| { ok: true; text: string }
	| { ok: false; reason: "too-large" }
	| { ok: false; reason: "read-error" };

/**
 * Read a request body while consuming at most `maxBytes + 1` bytes, then stop.
 * This bounds buffering even when the sender streams a chunked body with no
 * declared `content-length`: as soon as the running total exceeds `maxBytes`
 * we cancel the stream and return `too-large` without decoding the overflow.
 * Only the bounded, in-range bytes are decoded to text, so `text` is safe to
 * parse. A body with no stream (no `body`) reads as empty.
 *
 * Failure handling: acquiring the reader or reading a chunk can throw (an
 * aborted or already-locked stream, a transport error). Such failures surface as
 * a bounded `read-error` — the caller returns 400 without waking — never an
 * unhandled rejection. The reader lock is released in every path. Once the body
 * is known oversize, a failure to `cancel()` the remainder must not mask the
 * result: we still return `too-large` (413) rather than downgrading to a read
 * error.
 */
async function readBoundedBody(req: Request, maxBytes: number): Promise<BodyRead> {
	const stream = req.body;
	if (!stream) {
		return { ok: true, text: "" };
	}
	// Acquiring the reader throws if the stream is already locked/disturbed.
	let reader: ReadableStreamDefaultReader<Uint8Array>;
	try {
		reader = stream.getReader() as ReadableStreamDefaultReader<Uint8Array>;
	} catch (err) {
		log("warn", "status.doorbell.body_reader_unavailable", { cause: errorMessage(err) });
		return { ok: false, reason: "read-error" };
	}
	const drained = await drainBounded(reader, maxBytes);
	if (!drained.ok) {
		return drained;
	}
	if (drained.oversize) {
		return { ok: false, reason: "too-large" };
	}
	// Concatenate the bounded bytes and decode once. total <= maxBytes here.
	const bytes = new Uint8Array(drained.total);
	let offset = 0;
	for (const chunk of drained.chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { ok: true, text: new TextDecoder("utf-8").decode(bytes) };
}

/** The buffered outcome of a bounded stream drain. */
type DrainResult =
	| { ok: true; chunks: Uint8Array[]; total: number; oversize: boolean }
	| { ok: false; reason: "too-large" | "read-error" };

/**
 * Read the stream until it ends or exceeds `maxBytes`, buffering only in-range
 * bytes. The reader lock is released in every path. Once the body is known
 * oversize, a failure to `cancel()` the remainder must not mask the result: the
 * `oversize` verdict still stands rather than downgrading to a read error.
 */
async function drainBounded(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	maxBytes: number,
): Promise<DrainResult> {
	const chunks: Uint8Array[] = [];
	let total = 0;
	let oversize = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				break;
			}
			if (!value) {
				continue;
			}
			total += value.byteLength;
			if (total > maxBytes) {
				// Over the cap: stop reading and discard the buffered bytes without
				// decoding them. Cancelling releases the underlying source, but a
				// cancel failure must not replace the authoritative 413 — swallow it.
				oversize = true;
				try {
					await reader.cancel();
				} catch (err) {
					// Cancellation failed; the oversize verdict still stands, so nothing the
					// caller sees changes — debug only.
					log("debug", "status.doorbell.body_cancel_failed", { cause: errorMessage(err) });
				}
				break;
			}
			chunks.push(value);
		}
	} catch (err) {
		// A read error after we already knew the body was oversize keeps the 413;
		// otherwise it is a bounded read failure the caller maps to 400.
		log("warn", "status.doorbell.body_read_failed", {
			cause: errorMessage(err),
			oversize,
		});
		if (oversize) {
			return { ok: false, reason: "too-large" };
		}
		return { ok: false, reason: "read-error" };
	} finally {
		try {
			reader.releaseLock();
		} catch (err) {
			// Releasing a lock on an errored/cancelled reader can throw; the read verdict
			// is already decided, so this is ignorable cleanup — debug only.
			log("debug", "status.doorbell.body_release_failed", { cause: errorMessage(err) });
		}
	}
	return { ok: true, chunks, total, oversize };
}

/**
 * Parse a `Content-Length` header. Returns the byte count for a syntactically
 * valid nonnegative decimal, `null` when the header is absent, and `"invalid"`
 * for anything malformed (negative, non-decimal, multiple values, `+`/`-` sign,
 * whitespace, overflow). Callers reject an over-cap valid length immediately but
 * keep streaming enforcement for the `null`/`"invalid"` cases, where the
 * declared length is missing or deceptive.
 */
function parseContentLength(headerValue: string | null): number | null | "invalid" {
	if (headerValue === null) {
		return null;
	}
	// Exactly one run of decimal digits, no sign, no whitespace, no comma-joined
	// duplicate values. A deceptive length is treated as unknown, not trusted.
	if (!/^[0-9]+$/.test(headerValue)) {
		return "invalid";
	}
	const parsed = Number(headerValue);
	if (!Number.isSafeInteger(parsed)) {
		return "invalid";
	}
	return parsed;
}

export interface StatusHandlerOptions {
	source: StatusSource;
	pollIntervalMinutes: number;
	/** Commit stamped into the process environment by the deployment path. */
	commit?: string;
	/** Optional identifiers-only early-reconciliation doorbell. */
	doorbell?: DoorbellWiring;
	/**
	 * Optional inbound Forgejo webhook receiver. Present mounts
	 * `POST /hooks/forgejo`; absent leaves the path unrouted, so an unconfigured
	 * watcher exposes no webhook surface at all rather than one that always 401s.
	 */
	forgeHook?: ForgeHookWiring;
	/**
	 * Shutdown gate. When present and it returns false, the doorbell stops
	 * accepting requests and returns 503 *before* the scheduler is marked stopped
	 * and drained. This guarantees no request receives an accepted 202 after the
	 * trigger it would fire has already become a no-op — the acknowledgement never
	 * outlives the work it promises. Absent, the doorbell always accepts.
	 */
	accepting?: () => boolean;
	/**
	 * Clock for the `/healthz` staleness judgment, in epoch milliseconds.
	 *
	 * Defaults to the wall clock, which is what production wants: liveness is a
	 * claim about the real present, and judging it against the snapshot's own
	 * `generatedAt` would let a frozen snapshot source report itself live forever.
	 * Injected in tests so a staleness assertion never sleeps and never measures
	 * elapsed time — the only difference between a fresh and a stale case is the
	 * value, so the test cannot flake on a loaded machine.
	 */
	nowMs?: () => number;
	/**
	 * Off-loopback peers (addresses or CIDRs, from config `metrics_scrape_allow`)
	 * allowed to `GET /metrics` and nothing else. Absent or empty keeps
	 * the whole status surface loopback-only.
	 */
	metricsScrapeAllow?: readonly string[];
	/**
	 * The Langfuse base URL trace links on the HTML page are composed from.
	 *
	 * Reaches the HTML route ONLY. `/status.json` is deliberately not given it: the
	 * Langfuse host is LAN/tailnet-internal, and a JSON document is the shape that
	 * gets scraped, mirrored, and pasted elsewhere. Absent leaves trace ids
	 * rendering as plain text, which is the correct reading for a deployment whose
	 * operator has not configured a Langfuse to link to.
	 */
	langfuseBaseUrl?: string;
}

/**
 * Serve `GET /healthz`: is the reconciliation LOOP turning?
 *
 * 200 with a small JSON body while the last pass STARTED within twice the
 * configured poll interval; 503 with the same shape when it is older, or when no
 * pass has started in this process. The threshold comes from
 * `pollIntervalMinutes` — the caller's `poll_interval_minutes` — so there is no
 * second cadence constant that can drift from the interval it describes.
 *
 * SEPARATE FROM `/status.json`, deliberately. That surface is the machine
 * contract already deployed, and its shape does not change here beyond gaining
 * one optional field. `/healthz` is what a monitor polls, so it is small,
 * fixed-shape, and answers with its STATUS CODE — a probe that must parse JSON to
 * learn a service is wedged is a probe that reports healthy when the parse fails.
 *
 * NOT the same claim as `systemctl status` (the process is up) and not the same
 * claim as a repository cursor's age (that repo had work). A watcher whose
 * configured repositories are all quiet advances no cursor and is perfectly
 * healthy; this endpoint distinguishes it from one whose scheduler has wedged.
 */
async function handleHealthz(
	source: StatusSource,
	pollIntervalMinutes: number,
	nowMs: () => number,
	commit?: string,
): Promise<Response> {
	let snapshot: StatusSnapshot;
	try {
		snapshot = await source();
	} catch (err) {
		// The snapshot source reads the database. A health endpoint that 500s on a
		// failed read tells a monitor nothing it can act on differently from a wedge,
		// so report the same not-live shape with the cause named by CLASS only —
		// never a driver message, which can quote connection detail.
		log("warn", "status.healthz.source_failed", { error_class: errorClass(err) });
		return Response.json(
			{
				ok: false,
				reason: "status source unavailable",
				lastPassStartedAt: null,
				commit: commit ?? null,
			},
			{ status: 503 },
		);
	}
	const lastPassStartedAt = snapshot.lastPassStartedAt ?? null;
	const live = isPassLive(lastPassStartedAt, pollIntervalMinutes, nowMs());
	// The body is small and fixed: `lastPassStartedAt` is the field the liveness
	// claim cannot be made without, and the counters are the detail an operator
	// wants once the code has already answered the question.
	return Response.json(
		{
			ok: live,
			// Fixed at process startup from the deploy environment. Never inspect the
			// filesystem here: production is intentionally shipped as a bundle rather
			// than a git checkout, and a request-time lookup could not identify it.
			commit: commit ?? null,
			lastPassStartedAt,
			lastPassFinishedAt: snapshot.lastPassFinishedAt ?? null,
			lastPassOk: snapshot.lastPassOk ?? 0,
			lastPassFailCount: snapshot.lastPassFailCount ?? 0,
			// The per-repository errors behind that fail count. Bounded and
			// secret-free at the tracker; "1 failed" named no repository for ten days
			// before #252, which is the defect this field closes.
			lastPassRepoErrors: snapshot.lastPassRepoErrors ?? [],
			passesStarted: snapshot.passesStarted ?? 0,
			passesCompleted: snapshot.passesCompleted ?? 0,
			pollIntervalMinutes,
			// State the threshold the judgment used, so an operator reading a 503 can
			// tell "stale by a minute" from "stale by a day" without knowing the
			// watcher's configured cadence.
			stalenessThresholdMinutes: pollIntervalMinutes * 2,
		},
		{ status: live ? 200 : 503 },
	);
}

/**
 * Handle the fixed `POST /doorbell` endpoint. Enforces strict method (caller),
 * an exact `application/json` media type, a hard UTF-8 byte cap read from a
 * bounded stream, and identifiers-only schema handling, returning stable bounded
 * responses. On acceptance it fires the coalescing wake and returns 202
 * immediately — it never awaits the pass, so the caller is never blocked. A
 * parse/validation/wake failure is harmless: it never runs a pass itself and
 * never affects the authoritative periodic sweep.
 */
async function handleDoorbell(
	req: Request,
	doorbell: DoorbellWiring,
	accepting?: () => boolean,
	server?: RequestAddressSource,
): Promise<Response> {
	const response = await doorbellVerdict(req, doorbell, accepting, server);
	// The doorbell is this service's only inbound surface, and every refusal path
	// below returns a bounded HTTP error while recording nothing — so a probing
	// client, a DNS-rebinding attempt, and a misconfigured caller all look
	// identical to the operator. Log the refusal here, once, where
	// every path converges: a future refusal cannot forget to report itself.
	// Accepted rings are the normal case and stay quiet.
	if (response.status !== 202) {
		log("warn", "status.doorbell.refused", {
			status: response.status,
			// Request-controlled; `bounded` clamps it. Header presence only — never a
			// header value, which could carry a token.
			has_origin: req.headers.get("origin") !== null,
		});
	}
	return response;
}

/**
 * The header-only refusals, evaluated BEFORE any body read or wake. Returns the
 * bounded refusal response, or `null` when every header guard passes.
 *
 * DNS-rebinding guard: the server binds to loopback, but a browser can be
 * steered to POST to an attacker-controlled hostname that resolves to 127.0.0.1.
 * Require the Host authority — and any present Origin — to name a loopback host.
 * A rebound or off-machine Host never matches, so the request is refused with a
 * stable 403 before it can buffer a body or wake a pass. This is not a token
 * system.
 */
function doorbellHeaderRefusal(req: Request, server?: RequestAddressSource): Response | null {
	// The remote-address guard, ahead of the Host check: with the server bindable
	// on 0.0.0.0 for the webhook route, the peer's address is the property the bind
	// used to supply, and an off-machine caller must not reach a body read or wake.
	// Same bounded 403 as the Host refusal, so the two are indistinguishable to a
	// prober and both are logged once by handleDoorbell.
	if (!isLoopbackRemote(server, req)) {
		return Response.json({ accepted: false, error: "forbidden" }, { status: 403 });
	}
	if (!isLoopbackAuthority(req.headers.get("host"))) {
		return Response.json({ accepted: false, error: "forbidden" }, { status: 403 });
	}
	if (!isOriginAllowed(req.headers.get("origin"))) {
		return Response.json({ accepted: false, error: "forbidden" }, { status: 403 });
	}

	// Exact media-type match: require application/json, not merely a header that
	// contains it. Parameters (e.g. `; charset=utf-8`) are allowed; a compound
	// type like `text/application/json-evil` is not.
	if (mediaType(req.headers.get("content-type")) !== DOORBELL_MEDIA_TYPE) {
		return Response.json(
			{ accepted: false, error: "content-type must be application/json" },
			{ status: 415 },
		);
	}

	// If the sender declares a syntactically valid Content-Length over the cap,
	// reject immediately without reading the body at all. A missing, malformed, or
	// deceptive length falls through to streaming enforcement in the caller, which
	// counts actual bytes and stops at the cap regardless of what was declared.
	const declaredLength = parseContentLength(req.headers.get("content-length"));
	if (typeof declaredLength === "number" && declaredLength > DOORBELL_MAX_BODY_BYTES) {
		return Response.json({ accepted: false, error: "request body too large" }, { status: 413 });
	}

	return null;
}

/** The doorbell's actual decision logic; every exit is logged by its caller. */
async function doorbellVerdict(
	req: Request,
	doorbell: DoorbellWiring,
	accepting?: () => boolean,
	server?: RequestAddressSource,
): Promise<Response> {
	// Check both before reading and again immediately before waking. A request may
	// begin before shutdown, then finish its streamed body after shutdown starts;
	// the second check prevents a late 202 whose scheduler trigger is now a no-op.
	if (accepting && !accepting()) {
		return Response.json({ accepted: false, error: "server is shutting down" }, { status: 503 });
	}

	// Header-only guards, evaluated BEFORE any body read or wake.
	const refusal = doorbellHeaderRefusal(req, server);
	if (refusal) {
		return refusal;
	}

	// Read the body under a hard UTF-8 byte cap. This bounds buffering even for a
	// chunked body with no declared content-length: the reader stops at MAX+1
	// bytes and never decodes the overflow.
	const read = await readBoundedBody(req, DOORBELL_MAX_BODY_BYTES);
	if (!read.ok) {
		if (read.reason === "too-large") {
			return Response.json({ accepted: false, error: "request body too large" }, { status: 413 });
		}
		// A reader-acquisition or read failure: bounded 400, never a wake.
		return Response.json(
			{ accepted: false, error: "could not read request body" },
			{ status: 400 },
		);
	}

	let body: unknown;
	try {
		body = JSON.parse(read.text);
	} catch (err) {
		// Expected for any malformed sender: handleDoorbell already logs the refusal at
		// warn, so this only names the parse cause. NEVER the body text, which is
		// request-controlled and could carry whatever the caller sent.
		//
		// Enforcing that requires the CLASS, not the message: a JSON.parse SyntaxError
		// quotes the offending token out of the body (`Unexpected identifier
		// "<token>"`), so errorMessage would log the very bytes this comment promises to
		// withhold. The forge clients already use errorClass for parsing a response body
		// for exactly this reason.
		log("debug", "status.doorbell.body_not_json", { error_class: errorClass(err) });
		return Response.json({ accepted: false, error: "body is not valid JSON" }, { status: 400 });
	}

	const decision = evaluateDoorbell(body, doorbell.config);
	if (!decision.accepted) {
		return Response.json({ accepted: false, error: decision.reason }, { status: 400 });
	}

	// Shutdown may have started while a bounded streamed body was being read. Do
	// not acknowledge work after the scheduler has stopped accepting triggers.
	if (accepting && !accepting()) {
		return Response.json({ accepted: false, error: "server is shutting down" }, { status: 503 });
	}

	// Fire-and-forget the coalescing trigger and respond 202 immediately. The
	// ring only requests an early wake; `wake` is the scheduler's coalescing
	// trigger, which resolves only when the (possibly long) pass completes. We
	// must NOT await it, or the caller would block for the whole pass, breaking
	// the no-wait contract. We hand the validated ring so identifiers reach the
	// wake seam rather than being discarded at the HTTP boundary.
	//
	// `wake` may throw synchronously or reject asynchronously; both are harmless
	// (the periodic sweep stays authoritative), so we swallow either without
	// leaving an unhandled rejection. `Promise.resolve(...).catch` captures the
	// async rejection; the surrounding try/catch captures a synchronous throw.
	//
	// Harmless is not the same as unremarkable: a doorbell whose wake fails EVERY
	// time still answers 202, so without a line here a permanently broken early-wake
	// path is indistinguishable from a working one.
	try {
		Promise.resolve(doorbell.wake(decision.ring)).catch((err: unknown) => {
			log("warn", "status.doorbell.wake_failed", {
				cause: errorMessage(err),
				sync: false,
			});
		});
	} catch (err) {
		log("warn", "status.doorbell.wake_failed", { cause: errorMessage(err), sync: true });
	}
	return Response.json({ accepted: true }, { status: 202 });
}

/**
 * Serve `GET /metrics`: the SAME snapshot as `/status.json`, re-expressed in
 * Prometheus text format.
 *
 * The factory emits its own work numbers. The infrastructure repo owns the box,
 * the exporter, and the scrape; it does not own the DATA, so the counts that
 * describe factory work are rendered HERE, from the factory's own snapshot,
 * rather than reconstructed elsewhere from a copy that can drift.
 *
 * Loopback-only by default, like every route below the peer check; an
 * off-loopback scraper is admitted only via `metricsScrapeAllow`.
 */
function metricsResponse(snapshot: StatusSnapshot): Response {
	return new Response(renderMetrics(snapshot), {
		headers: { "content-type": "text/plain; version=0.0.4; charset=utf-8" },
	});
}

/**
 * Answer an off-loopback peer on the status surface: a bounded 403, with the
 * one exemption that an allowlisted scraper may `GET /metrics` and
 * nothing else. Every other route and method stays behind the same 403.
 */
async function remotePeerResponse(
	source: StatusSource,
	scrapeAllow: BlockList | null,
	server: RequestAddressSource | undefined,
	req: Request,
): Promise<Response> {
	if (
		req.method === "GET" &&
		new URL(req.url).pathname === "/metrics" &&
		isAllowedScraper(scrapeAllow, server, req)
	) {
		return metricsResponse(await source());
	}
	log("warn", "status.remote_peer_refused", { method: req.method });
	return new Response("forbidden", { status: 403 });
}

/** Build a `fetch`-style request handler for the status routes. */
function createStatusHandlerImpl(
	opts: StatusHandlerOptions,
): (req: Request, server?: RequestAddressSource) => Promise<Response> {
	const scrapeAllow = buildScrapeAllow(opts.metricsScrapeAllow);
	return async (req: Request, server?: RequestAddressSource): Promise<Response> => {
		const url = new URL(req.url);
		// The one fixed write endpoint: only reachable when the doorbell is
		// configured and only via POST to its exact path. Every other route stays
		// GET-only and read-only.
		if (opts.doorbell && url.pathname === "/doorbell" && req.method === "POST") {
			return handleDoorbell(req, opts.doorbell, opts.accepting, server);
		}
		// The second write endpoint, and the only one reachable off-machine: an
		// HMAC-authenticated Forgejo webhook. It is deliberately NOT subject to the
		// loopback checks above — the forge is remote by definition — which is why
		// its own module authenticates every delivery before touching a parser.
		if (opts.forgeHook && url.pathname === "/hooks/forgejo" && req.method === "POST") {
			// Same shutdown gate as the doorbell: once the scheduler is stopping its
			// trigger is a no-op, so an accepted 202 would promise a wake that never
			// comes and the stored delivery id would dedupe the forge's retry. Refuse
			// before the receiver stores anything; the forge retries after restart.
			if (opts.accepting && !opts.accepting()) {
				return Response.json(
					{ accepted: false, error: "server is shutting down" },
					{ status: 503 },
				);
			}
			return handleForgejoHook(req, opts.forgeHook);
		}
		// Everything below is the local status surface. When the server is bound
		// beyond loopback for the webhook, the peer address is what keeps it local:
		// an off-machine peer gets a bounded 403 here, before any route can read the
		// database. Direct handler calls carry no server and skip the check.
		if (!isLoopbackRemote(server, req)) {
			return remotePeerResponse(opts.source, scrapeAllow, server, req);
		}
		if (req.method !== "GET") {
			return new Response("method not allowed", { status: 405 });
		}
		if (url.pathname === "/healthz") {
			return handleHealthz(
				opts.source,
				opts.pollIntervalMinutes,
				opts.nowMs ?? (() => Date.now()),
				opts.commit,
			);
		}
		if (url.pathname === "/status.json") {
			const snapshot = await opts.source();
			return Response.json(snapshot);
		}
		if (url.pathname === "/metrics") {
			return metricsResponse(await opts.source());
		}
		if (url.pathname === "/" || url.pathname === "/index.html") {
			const snapshot = await opts.source();
			const html = renderStatusHtml(snapshot, opts.pollIntervalMinutes, opts.langfuseBaseUrl);
			return new Response(html, {
				headers: { "content-type": "text/html; charset=utf-8" },
			});
		}
		return new Response("not found", { status: 404 });
	};
}

export const createStatusHandler = traced(
	"status.createStatusHandler",
	createStatusHandlerImpl,
) as typeof createStatusHandlerImpl;

export interface StartStatusServerOptions {
	db: WatcherDb;
	pollIntervalMinutes: number;
	/** Commit stamped into the process environment by the deployment path. */
	commit?: string;
	/**
	 * The ingest observer's host-conflict tripwire. The daemon passes the
	 * SAME tally the observer records into — both live in this one process — so the
	 * page reports live counts. Omitted leaves the section off the page entirely.
	 */
	hostConflicts?: () => HostConflictStatus;
	/**
	 * The scheduler's pass-liveness record. The daemon passes the SAME
	 * tracker the scheduler seam records into — both live in this one process — so
	 * `/healthz` and the status page report live values. Passed as a READER, not a
	 * value: a snapshot taken at bind time would pin `lastPassStartedAt` to null
	 * forever and every probe would report the watcher wedged. Omitted leaves the
	 * field off the snapshot and `/healthz` answering 503, which is the correct
	 * reading for a status server nothing is driving a scheduler behind.
	 */
	passLiveness?: () => PassLivenessStatus;
	/** Port to bind; 0 selects a free port (useful in tests). */
	port?: number;
	/**
	 * Interface to bind. Defaults to `127.0.0.1` — the trusted-network posture of
	 * _DOCS/architecture.md, and the correct answer for a watcher nobody posts to.
	 * The service widens it to `0.0.0.0` only when a Forgejo webhook secret is
	 * configured, because the forge posts from another host; the doorbell keeps its
	 * loopback-only property by remote address either way.
	 */
	hostname?: string;
	/** Clock for the snapshot; defaults to the real current time. */
	now?: () => string;
	/** Optional identifiers-only early-reconciliation doorbell. */
	doorbell?: DoorbellWiring;
	/** @see StatusHandlerOptions.forgeHook — mounts `POST /hooks/forgejo`. */
	forgeHook?: ForgeHookWiring;
	/**
	 * Shutdown gate forwarded to the handler. Returns false once the service has
	 * begun stopping, so the doorbell stops accepting before the scheduler drains.
	 */
	accepting?: () => boolean;
	/** @see StatusHandlerOptions.langfuseBaseUrl — forwarded to the HTML route. */
	langfuseBaseUrl?: string;
	/** @see StatusHandlerOptions.metricsScrapeAllow — forwarded to the handler. */
	metricsScrapeAllow?: readonly string[];
	/**
	 * The managed-repository entries whose `build_bump` block defines the enrolled
	 * environments (§8), forwarded verbatim into `getStatus`'s grouped
	 * `ProcessLocalStatus` argument.
	 *
	 * Bound ONCE rather than read per request, unlike the tally and the liveness
	 * beside it: those are live counters whose value changes under the server,
	 * while this is config, fixed for the process's life by the same load that
	 * built the database handle above it. Omitted yields an empty `buildBump`
	 * array — the honest answer for a caller holding no config, and what every
	 * existing composition and test gets unchanged.
	 */
	buildBumpRepositories?: readonly BuildBumpRepositoryConfig[];
}

/**
 * Start the status HTTP server. Binds loopback unless `hostname` widens it (the
 * Forgejo webhook case). Returns the Bun server.
 */
function startStatusServerImpl(opts: StartStatusServerOptions) {
	const now = opts.now ?? (() => new Date().toISOString());
	const handler = createStatusHandler({
		// Read per request, not once at bind: the tally is live and a snapshot taken
		// at startup would pin the counter at 0 forever.
		source: () =>
			getStatus(opts.db, now(), {
				hostConflicts: opts.hostConflicts?.(),
				// Read per request for the same reason the tally is: liveness taken at
				// bind time is null forever, which reads as a permanently wedged loop.
				passLiveness: opts.passLiveness?.(),
				// Config, not a live counter: the same value on every request.
				buildBumpRepositories: opts.buildBumpRepositories,
				// Read per request: the process-local critical-alert tally.
				alertDeliveries: alertDeliveryTally(),
			}),
		pollIntervalMinutes: opts.pollIntervalMinutes,
		commit: opts.commit,
		doorbell: opts.doorbell,
		forgeHook: opts.forgeHook,
		accepting: opts.accepting,
		langfuseBaseUrl: opts.langfuseBaseUrl,
		metricsScrapeAllow: opts.metricsScrapeAllow,
	});
	return Bun.serve({
		hostname: opts.hostname ?? "127.0.0.1",
		port: opts.port ?? 8787,
		// A second, transport-level bound on the webhook body, applied only when the
		// webhook is wired so a watcher without one keeps Bun's default transport
		// behaviour. The receiver already refuses over its own cap, but that refusal
		// runs after Bun has accepted the request; this stops an oversize body at
		// the socket.
		...(opts.forgeHook ? { maxRequestBodySize: 1_048_576 } : {}),
		fetch: handler,
	});
}

export const startStatusServer = traced(
	"status.startStatusServer",
	startStatusServerImpl,
) as typeof startStatusServerImpl;
