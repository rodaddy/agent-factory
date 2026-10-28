/**
 * @module bus/nats
 * @description The watcher's NATS JetStream publisher for Forge webhook
 *   deliveries. Every delivery this process durably stores in
 *   `forge_deliveries` is republished onto the `fleet` cluster's `FORGE_EVENTS`
 *   stream, so other consumers can react to a forge event without each of them
 *   holding a webhook receiver, a secret, and a public address.
 *
 *   THE BUS IS A SIDE CHANNEL, NEVER THE RECORD. The row is the durable truth;
 *   this publish is best effort. `publishForgeDelivery` therefore NEVER rejects
 *   — a failure is logged by class and swallowed — because a stored delivery
 *   must not fail its webhook because the bus is unreachable. A forge that
 *   receives an error retries the delivery, and retrying a delivery that was
 *   already stored buys nothing while costing a duplicate.
 *
 *   DEDUPE IS THE SERVER'S. `FORGE_EVENTS` runs a 2-minute duplicate window on
 *   `Nats-Msg-Id`, and the id IS the forge's delivery id — the same value the
 *   `(provider, delivery_id)` unique key dedupes on in the database. A forge
 *   retry that loses the race with the row insert therefore also loses it in the
 *   stream, and `pa.duplicate` is an INFO, not a failure.
 *
 *   THE SUBJECT IS SANITIZED, NOT TRUSTED. `owner`, `repo`, and `event` come
 *   from the payload. A `.` would change the subject's arity and a `*`/`>` are
 *   the subscription wildcards, so an unsanitized repository name could widen or
 *   re-target the subject it is interpolated into. Every one of those, plus
 *   whitespace and an empty token, becomes `_`.
 *
 *   NEVER LOGGED: the nkey seed, its file contents, or the webhook body. A
 *   publish failure logs the subject, the delivery id, and the error CLASS.
 *
 * @outputs
 *   - `forgeEventSubject` -- build a sanitized `forge.events.<owner>.<repo>.<event>`
 *   - `ForgeDeliveryEvent` -- one stored delivery, as published
 *   - `ForgeEventPublisher` -- the seam the webhook receiver depends on
 *   - `buildForgeEventMessage` -- pure subject/headers/body construction
 *   - `NatsBus` / `createNatsBus` -- a live connection implementing the seam
 *
 * @dependencies
 *   - nats -- the official client; JetStream publish and nkey authentication
 *   - ../log -- structured logging
 */
import {
	type ConnectionOptions,
	connect,
	type NatsConnection,
	headers as natsHeaders,
	nkeyAuthenticator,
} from "nats";
import { errorClass, log, traced } from "../log";

/** Root of every subject this module publishes under; the stream's filter. */
const SUBJECT_PREFIX = "forge.events";

/** Milliseconds to wait for a JetStream PubAck before giving up on one publish. */
const DEFAULT_PUBLISH_TIMEOUT_MS = 5_000;

/** Milliseconds to wait for the initial connection. */
const CONNECT_TIMEOUT_MS = 5_000;

/**
 * Milliseconds `close()` will wait for the drain before forcing the connection
 * shut.
 *
 * `nc.drain()` has NO timeout of its own in nats@2.29.3 — its flush waits on a
 * PONG with no timer — so a connected-but-unresponsive cluster would stall
 * shutdown indefinitely, ahead of the scheduler drain and the observability
 * flush. And with `maxReconnectAttempts: -1` a drain attempted while
 * disconnected can leave the reconnect loop alive. The bound is what makes
 * `close()` terminate in every case.
 */
const DEFAULT_CLOSE_TIMEOUT_MS = 5_000;

/**
 * Characters that may not appear inside a single subject token: `.` is the
 * separator, `*` and `>` are the wildcards, and whitespace is not permitted.
 */
const UNSAFE_TOKEN_CHARS = /[.*>\s]/g;

/**
 * Make one subject token safe to interpolate.
 *
 * Returns `_` for an empty result rather than an empty string, because an empty
 * token collapses `a..b` into a malformed subject and would let a blank
 * repository name change the subject's arity.
 *
 * @param token - untrusted text destined for one subject segment
 */
function safeToken(token: string): string {
	const replaced = token.replace(UNSAFE_TOKEN_CHARS, "_");
	return replaced.length === 0 ? "_" : replaced;
}

/**
 * Build the subject one forge event publishes to.
 *
 * Pure. Every segment is sanitized — see the module doc for why the repository
 * name is treated as untrusted here even though it was validated at the webhook
 * boundary.
 *
 * @param owner - repository owner, untrusted
 * @param repo - repository name, untrusted
 * @param event - the forge event name, untrusted
 */
export const forgeEventSubject = traced(
	"bus.forgeEventSubject",
	function forgeEventSubject(owner: string, repo: string, event: string): string {
		return `${SUBJECT_PREFIX}.${safeToken(owner)}.${safeToken(repo)}.${safeToken(event)}`;
	},
);

/** One stored Forge webhook delivery, as it crosses to the bus. */
export interface ForgeDeliveryEvent {
	/** `owner/repo` exactly as stored on the row. */
	repository: string;
	/** The forge event name (`push`, `issues`, ...). */
	event: string;
	/** The forge's delivery id; also the `Nats-Msg-Id` dedupe key. */
	deliveryId: string;
	/** Primary key of the `forge_deliveries` row this event came from. */
	rowId: number;
	/** The exact bytes received, republished unchanged. */
	rawBody: Uint8Array;
	/** The delivery's signature header, or null when absent. */
	signature: string | null;
}

/** The seam the webhook receiver depends on. Implementations never reject. */
export interface ForgeEventPublisher {
	/**
	 * Publish one stored delivery. Resolves even on failure — see the module doc.
	 *
	 * @param input - the delivery to publish
	 */
	publishForgeDelivery(input: ForgeDeliveryEvent): Promise<void>;
}

/** A live connection to the bus. */
export interface NatsBus extends ForgeEventPublisher {
	/**
	 * The underlying connection, exposed so consumers can be built on the SAME
	 * connection. A second `connect()` would mean a second
	 * authentication, a second reconnect state machine, and a second thing to
	 * shut down — the results consumer therefore borrows this one rather than
	 * opening its own.
	 */
	readonly connection: NatsConnection;
	/**
	 * Drain the connection, flushing anything still queued.
	 *
	 * BOUNDED and non-rejecting: resolves within the configured close timeout
	 * whether the drain completes, stalls, or fails — see
	 * `DEFAULT_CLOSE_TIMEOUT_MS`.
	 */
	close(): Promise<void>;
}

/**
 * Build the subject, headers, and body for one delivery.
 *
 * Pure, so the wire shape can be pinned without a cluster. `X-Forgejo-Signature`
 * is OMITTED rather than sent empty when the delivery carried no signature: an
 * empty header would be indistinguishable from a signature that failed to
 * compute, and a consumer re-verifying the HMAC needs to tell those apart.
 *
 * @param input - the delivery to publish
 */
export const buildForgeEventMessage = traced(
	"bus.buildForgeEventMessage",
	function buildForgeEventMessage(input: ForgeDeliveryEvent): {
		subject: string;
		headers: Record<string, string>;
		data: Uint8Array;
	} {
		const [owner = "", repo = ""] = input.repository.split("/");
		const built: Record<string, string> = {
			"Nats-Msg-Id": input.deliveryId,
			"X-Forgejo-Delivery": input.deliveryId,
			"X-Forgejo-Event": input.event,
			"Factory-Delivery-Row": String(input.rowId),
		};
		if (input.signature !== null) {
			built["X-Forgejo-Signature"] = input.signature;
		}
		return {
			subject: forgeEventSubject(owner, repo, input.event),
			headers: built,
			data: input.rawBody,
		};
	},
);

/**
 * Close a connection within a bound, forcing it shut if the drain does not
 * finish.
 *
 * The drain races a timer, and BOTH losing branches call `nc.close()`.
 * `drain()` cannot be cancelled, so on timeout the only way to stop waiting AND
 * stop the infinite reconnect loop (`maxReconnectAttempts: -1`) is to close
 * underneath it; `close()` is idempotent, so the abandoned drain settling later
 * is harmless. A rejected drain gets the same treatment for the same reason:
 * the connection's state after a failed drain is unknown, and leaving a
 * reconnecting client alive outlives the process's own shutdown.
 *
 * NEVER rejects, and always resolves within `closeTimeoutMs` plus the cost of
 * `nc.close()` — the caller is a shutdown path, and a close that throws would
 * skip the scheduler drain and the observability flush behind it.
 *
 * @param nc - the connection to drain, then force shut if the drain does not win
 * @param closeTimeoutMs - how long the drain gets before it is abandoned
 * @param emit - the log sink; a forced close warns, a clean drain says nothing
 */
async function boundedClose(
	nc: NatsConnection,
	closeTimeoutMs: number,
	emit: typeof log,
): Promise<void> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const reason = await Promise.race([
		nc
			.drain()
			.then(() => "drained" as const)
			.catch(() => "drain_failed" as const),
		new Promise<"timeout">((resolve) => {
			timer = setTimeout(() => resolve("timeout"), closeTimeoutMs);
		}),
	]);
	if (timer !== undefined) clearTimeout(timer);
	if (reason === "drained") return;
	try {
		await nc.close();
	} catch {
		// Nothing left to do: the process is shutting down and the deliveries this
		// bus republishes are already durably stored on their rows.
	}
	emit("warn", "bus.nats.close_forced", { reason });
}

/**
 * The client options for the watcher's one connection: nkey auth from the seed
 * bytes, a bounded initial connect, and unbounded reconnects (the bus is a side
 * channel; the process outlives any cluster blip).
 *
 * @param opts - server url and the nkey seed bytes
 */
function connectionOptions(opts: { url: string; nkeySeed: Uint8Array }): ConnectionOptions {
	return {
		servers: opts.url,
		authenticator: nkeyAuthenticator(opts.nkeySeed),
		name: "rodaddy-watcher",
		timeout: CONNECT_TIMEOUT_MS,
		maxReconnectAttempts: -1,
	};
}

/**
 * Connect to the bus and return a publisher.
 *
 * Reconnects forever (`maxReconnectAttempts: -1`): the watcher outlives any
 * single cluster restart, and a bus that gave up would silently stop publishing
 * with the process still healthy. The caller owns the failure of THIS call —
 * `service.ts` logs it and continues without a bus, because the webhook path
 * must keep working when the cluster is down.
 *
 * The seed is passed as bytes and never logged, never stored on the returned
 * object, and never included in an error line.
 *
 * @param opts - server url, the nkey seed bytes, an optional log sink, timeouts,
 *   and the connection factory (injected in tests; defaults to the nats client)
 */
export const createNatsBus = traced(
	"bus.createNatsBus",
	async function createNatsBus(opts: {
		url: string;
		nkeySeed: Uint8Array;
		log?: typeof log;
		publishTimeoutMs?: number;
		/** Bound on `close()`; see `DEFAULT_CLOSE_TIMEOUT_MS`. */
		closeTimeoutMs?: number;
		/**
		 * The connection factory. Defaults to the nats client's `connect`; injected
		 * so the close-bounding behaviour can be driven without a live cluster.
		 */
		connect?: typeof connect;
	}): Promise<NatsBus> {
		const emit = opts.log ?? log;
		const publishTimeout = opts.publishTimeoutMs ?? DEFAULT_PUBLISH_TIMEOUT_MS;
		const closeTimeout = opts.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
		const openConnection = opts.connect ?? connect;
		const nc: NatsConnection = await openConnection(connectionOptions(opts));
		const js = nc.jetstream();
		return {
			connection: nc,
			publishForgeDelivery: async (input: ForgeDeliveryEvent): Promise<void> => {
				const message = buildForgeEventMessage(input);
				try {
					const hdrs = natsHeaders();
					for (const [key, value] of Object.entries(message.headers)) {
						hdrs.set(key, value);
					}
					const ack = await js.publish(message.subject, message.data, {
						headers: hdrs,
						// The stream's dedupe key. The client writes this into
						// `Nats-Msg-Id`, matching the header built above.
						msgID: input.deliveryId,
						timeout: publishTimeout,
					});
					if (ack.duplicate) {
						emit("info", "bus.nats.duplicate", {
							subject: message.subject,
							delivery_id: input.deliveryId,
						});
					}
				} catch (err) {
					// Never rethrown: a stored delivery must not fail its webhook because
					// the bus is down. Class only — never the seed, never the body.
					emit("warn", "bus.nats.publish_failed", {
						subject: message.subject,
						delivery_id: input.deliveryId,
						error_class: errorClass(err),
					});
				}
			},
			close: (): Promise<void> => boundedClose(nc, closeTimeout, emit),
		};
	},
);
