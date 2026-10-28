/**
 * @module hooks/forgejo
 * @description Inbound Forgejo (and Gitea-spelled) webhook receiver.
 *   Verifies the delivery's HMAC, records it under a durable replay key, and —
 *   only for a repository this process actually manages on Forgejo — rings the
 *   existing reconciliation doorbell.
 *
 *   THE HOOK IS A HINT, NEVER AN INSTRUCTION. Nothing in the payload selects
 *   work, names a job, or reaches a runner. The entire effect of an accepted
 *   delivery is "reconcile sooner than the poll would have"; reconciliation then
 *   re-reads the forge itself, which is the only trusted source. That is why the
 *   body may be stored verbatim without becoming an injection surface.
 *
 *   DECISION ORDER IS THE SECURITY BOUNDARY, and it is fixed:
 *     1. non-POST -> 405
 *     2. body larger than `MAX_BODY_BYTES`, declared or actual -> 413
 *     3. signature -> 401 on failure. NOTHING below runs before this passes:
 *        no JSON parse, no database write, no wake. An unauthenticated caller
 *        must not be able to reach the parser or the table.
 *     4. missing event or delivery id -> 400
 *     5. unparseable body, or no plausible `repository.full_name` -> 400
 *     6. insert under the (provider, delivery_id) unique key; already present
 *        -> 200 duplicate, NO wake and NO bus publish
 *     7. a NEW row is published onto the bus, if one is wired, and fires
 *        the SOP gate, if one is wired — neither changes the response
 *     8. repository managed on `forgejo` -> wake, 202; otherwise 200 woken:false
 *
 *   THE BUS PUBLISH NEVER CHANGES THE RESPONSE. It runs only for a row
 *   that was actually inserted — never for a duplicate, never for a refusal — so
 *   the stream inherits the table's dedupe rather than adding a second one. The
 *   publisher contracts never to reject, and the call is ALSO wrapped here:
 *   a delivery that is durably stored must never be answered with an error
 *   because a side channel is down, since the forge would then retry a delivery
 *   that is already recorded.
 *
 *   DUPLICATES ARE NORMAL. Forgejo retries a delivery it could not confirm, with
 *   the same delivery id, so the insert is `ON CONFLICT DO NOTHING RETURNING id`
 *   and zero returned rows is the dedupe signal. A duplicate is answered 200 —
 *   an error status would make the forge retry the retry.
 *
 *   THE WAKE IS NOT AWAITED. Reconciliation can take far longer than a webhook
 *   caller will wait, and holding the response open invites the forge to time
 *   out and retry. A rejected wake is logged by CLASS only.
 *
 *   NEVER LOGGED: the body, the signature header, the secret.
 *
 * @outputs
 *   - `verifyForgejoSignature` -- constant-time HMAC-SHA256 check of raw bytes
 *   - `ForgeHookWiring` -- collaborators one receiver needs
 *   - `handleForgejoHook` -- handle one inbound webhook request
 *
 * @dependencies
 *   - node:crypto -- HMAC and constant-time comparison
 *   - ../bus/nats -- the `ForgeEventPublisher` seam a new row is published on
 *   - drizzle-orm -- insert with conflict handling
 *   - ../config/schema -- managed-repository configuration
 *   - ../db/client -- WatcherDb type
 *   - ../db/schema -- the `forge_deliveries` replay table
 *   - ../log -- structured logging
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { sql } from "drizzle-orm";
import type { ForgeEventPublisher } from "../bus/nats";
import type { WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import { forgeDeliveries } from "../db/schema";
import { bounded, errorClass, log, traced, withLogFields } from "../log";
import { isGatedPullRequest, type SopGateTrigger } from "./sop-gate";

/** Forge family this receiver speaks for; also the stored `provider` value. */
const PROVIDER = "forgejo";

/**
 * Largest webhook body accepted, in bytes. Forgejo payloads are kilobytes; a
 * megabyte is generous and still bounds what an authenticated-looking caller can
 * push through the parser and into a row.
 */
const MAX_BODY_BYTES = 1_048_576;

/** Hex length of a SHA-256 digest. */
const SIGNATURE_HEX_LENGTH = 64;

/**
 * Plausible `owner/repo`. Deliberately narrow: this value is only ever compared
 * against configured names and stored, never interpolated into a path, a URL, or
 * a command, and a narrow shape keeps it that way if a later caller forgets.
 */
const REPO_FULL_NAME = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** Collaborators one Forgejo webhook receiver needs. */
export interface ForgeHookWiring {
	/** Shared secret configured on the Forgejo webhook. */
	secret: string;
	/** Database handle owning the `forge_deliveries` replay table. */
	db: WatcherDb;
	/** Managed-repository configuration; decides whether a delivery wakes. */
	config: WatcherConfig;
	/** Rings the reconciliation doorbell. Never awaited by the receiver. */
	wake: () => Promise<void> | void;
	/**
	 * Republishes a newly stored delivery onto the bus. Optional: a
	 * watcher with no bus configured behaves exactly as it did before. By
	 * contract this never rejects, and the receiver guards it anyway.
	 */
	bus?: ForgeEventPublisher;
	/**
	 * Fires the SOP gate for a newly stored delivery. Optional: a watcher
	 * with no Forgejo token behaves exactly as it did before. Never awaited, and
	 * its failures never reach the response — see `hooks/sop-gate`.
	 */
	sopGate?: SopGateTrigger;
}

/** JSON body with a single bounded reason, for a refusal. */
function refuse(status: number, error: string, reason: string): Response {
	log("warn", "hooks.forgejo.refused", { status, reason: bounded(reason) });
	return Response.json({ accepted: false, error }, { status });
}

/**
 * Is `signatureHeader` the HMAC-SHA256 of `rawBody` under `secret`?
 *
 * The forge sends lowercase hex of the digest over the RAW BYTES — re-encoding a
 * parsed body would change them and never match, which is why this takes
 * `Uint8Array` and not a string.
 *
 * Compared with `timingSafeEqual` over the digest BUFFERS, so the comparison is
 * always over two equal-length 32-byte values and the function cannot leak the
 * digest through timing. A header that is absent, empty, not the expected hex
 * length, or not valid hex is rejected before any comparison, since
 * `timingSafeEqual` throws on a length mismatch. Hex is case-SENSITIVE here:
 * accepting an uppercase spelling would mean accepting a second encoding of the
 * same secret-derived value for no gain.
 *
 * @param rawBody - the exact bytes received
 * @param signatureHeader - the `x-forgejo-signature` / `x-gitea-signature` value
 * @param secret - the shared webhook secret
 */
function verifySignatureImpl(
	rawBody: Uint8Array,
	signatureHeader: string | null,
	secret: string,
): boolean {
	if (signatureHeader === null || signatureHeader.length !== SIGNATURE_HEX_LENGTH) {
		return false;
	}
	if (!/^[0-9a-f]+$/.test(signatureHeader)) {
		return false;
	}
	const expected = createHmac("sha256", secret).update(rawBody).digest();
	const provided = Buffer.from(signatureHeader, "hex");
	if (provided.length !== expected.length) {
		return false;
	}
	return timingSafeEqual(provided, expected);
}

/**
 * `secret` is argument 2 and a bare positional string, which `traced()`'s
 * key-based masking cannot see — without this it is emitted verbatim on the
 * `.enter` line wherever `LOG_LEVEL=debug` is set.
 */
export const verifyForgejoSignature = traced("hooks.verifyForgejoSignature", verifySignatureImpl, {
	redact: { args: [2] },
});

/** First non-empty value among the Forgejo and Gitea spellings of one header. */
function forgeHeader(req: Request, suffix: string): string | null {
	const value = req.headers.get(`x-forgejo-${suffix}`) ?? req.headers.get(`x-gitea-${suffix}`);
	return value !== null && value !== "" ? value : null;
}

/** Read `repository.full_name` off an already-parsed body, if it is plausible. */
function repositoryFullName(body: unknown): string | null {
	if (typeof body !== "object" || body === null) {
		return null;
	}
	const repository = (body as { repository?: unknown }).repository;
	if (typeof repository !== "object" || repository === null) {
		return null;
	}
	const fullName = (repository as { full_name?: unknown }).full_name;
	if (typeof fullName !== "string" || !REPO_FULL_NAME.test(fullName)) {
		return null;
	}
	return fullName;
}

/**
 * An admitted delivery: authenticated, well-formed, and ready to be stored.
 * Reaching this shape is the whole of the security boundary; everything after it
 * is bookkeeping.
 */
interface AdmittedDelivery {
	event: string;
	deliveryId: string;
	repository: string;
	payload: unknown;
	/**
	 * The exact bytes received. Carried forward only so a new row can be
	 * republished byte-identically — re-encoding the parsed payload
	 * would change them and break a consumer re-verifying the HMAC. Never logged.
	 */
	raw: Uint8Array;
	/** The delivery's signature header, already verified. Never logged. */
	signature: string | null;
}

/**
 * Steps 1-5 of the module doc's decision order: method, size, SIGNATURE, headers,
 * body. Returns the admitted delivery, or the `Response` that refuses it.
 *
 * Split out only to keep one function readable — the ORDER is the contract and
 * must not be rearranged. In particular the signature check stays ahead of the
 * JSON parse, so an unauthenticated caller never reaches the parser.
 *
 * @param req - the inbound request, body unread
 * @param secret - the shared webhook secret
 */
async function admitDelivery(req: Request, secret: string): Promise<AdmittedDelivery | Response> {
	if (req.method !== "POST") {
		return refuse(405, "method not allowed", `method ${req.method}`);
	}

	// Declared length first, so an oversize body is refused before it is read.
	const declared = Number(req.headers.get("content-length") ?? "");
	if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
		return refuse(413, "payload too large", `declared ${declared} bytes`);
	}
	const raw = new Uint8Array(await req.arrayBuffer());
	if (raw.byteLength > MAX_BODY_BYTES) {
		return refuse(413, "payload too large", `read ${raw.byteLength} bytes`);
	}

	// THE GATE. Nothing below this line runs for an unauthenticated caller.
	const signature = forgeHeader(req, "signature");
	if (!verifyForgejoSignature(raw, signature, secret)) {
		return refuse(401, "bad signature", "signature missing or invalid");
	}

	const event = forgeHeader(req, "event");
	const deliveryId = forgeHeader(req, "delivery");
	if (event === null || deliveryId === null) {
		return refuse(400, "missing delivery headers", "event or delivery id absent");
	}

	let payload: unknown;
	try {
		payload = JSON.parse(new TextDecoder().decode(raw));
	} catch (err) {
		return refuse(400, "malformed body", `body not json: ${errorClass(err)}`);
	}
	const repository = repositoryFullName(payload);
	if (repository === null) {
		return refuse(400, "malformed body", "repository.full_name absent or malformed");
	}

	return { event, deliveryId, repository, payload, raw, signature };
}

/** One `hooks.forgejo.received` line. Identifiers only — never the body. */
function logReceived(delivery: AdmittedDelivery, woken: boolean, duplicate: boolean): void {
	log("info", "hooks.forgejo.received", {
		event: bounded(delivery.event),
		delivery_id: bounded(delivery.deliveryId),
		repository: delivery.repository,
		woken,
		duplicate,
	});
}

/**
 * Republish a NEW row onto the bus, if one is wired.
 *
 * Awaited — the publisher contracts never to reject and bounds itself with its own
 * publish timeout — but guarded anyway: a durably stored delivery must never be
 * answered with an error because a side channel failed, and a forge answered an
 * error retries.
 *
 * @param bus - the publisher, or undefined when no bus is configured
 * @param delivery - the admitted delivery whose row was just created
 * @param rowId - the id of that row
 */
async function publishNewRow(
	bus: ForgeEventPublisher | undefined,
	delivery: AdmittedDelivery,
	rowId: number,
): Promise<void> {
	if (bus === undefined) {
		return;
	}
	try {
		await bus.publishForgeDelivery({
			repository: delivery.repository,
			event: delivery.event,
			deliveryId: delivery.deliveryId,
			rowId,
			rawBody: delivery.raw,
			signature: delivery.signature,
		});
	} catch (err) {
		log("warn", "hooks.forgejo.bus_publish_failed", { error_class: errorClass(err) });
	}
}

/**
 * Fire the SOP gate for a newly stored delivery, if one is wired.
 *
 * Deliberately NOT awaited and fully guarded on both the async and the synchronous
 * throw path: the delivery is already durably stored by the time this runs, so a
 * gate failure must never become an error response — a forge answered an error
 * retries the delivery, and the dedupe key would then correctly refuse the retry,
 * losing the event entirely.
 *
 * @param gate - the trigger, or undefined when no gate is configured
 * @param delivery - the admitted delivery whose row was just created
 */
function fireSopGate(
	gate: SopGateTrigger | undefined,
	delivery: AdmittedDelivery & { dbUnavailable?: boolean; duplicate?: boolean },
): void {
	if (gate === undefined) {
		return;
	}
	try {
		Promise.resolve(
			gate({
				repository: delivery.repository,
				event: delivery.event,
				payload: delivery.payload,
				...(delivery.dbUnavailable === true ? { dbUnavailable: true } : {}),
				...(delivery.duplicate === true ? { duplicate: true } : {}),
			}),
		).catch((err: unknown) => {
			log("warn", "hooks.forgejo.sop_gate_failed", { error_class: errorClass(err) });
		});
	} catch (err) {
		log("warn", "hooks.forgejo.sop_gate_failed", { error_class: errorClass(err), sync: true });
	}
}

/**
 * Store an admitted delivery and fire its side channels, reporting what the
 * response should say. Runs inside the delivery's log scope, so every
 * line it emits carries `delivery_id`/`event`/`repository`.
 *
 * @param admitted - the authenticated, well-formed delivery
 * @param wiring - database, configuration, bus, and SOP gate
 */
async function recordDelivery(
	admitted: AdmittedDelivery,
	wiring: ForgeHookWiring,
): Promise<"duplicate" | "unmanaged" | "managed" | "db_unavailable"> {
	// The unique (provider, delivery_id) key IS the dedupe: zero rows back means
	// this delivery was already recorded, so it is a forge retry, not a new event.
	let inserted: { id: number }[];
	try {
		inserted = await insertDelivery(admitted, wiring);
	} catch (err) {
		// sf#1071: a down database must not leave the PR with no sop-gate status.
		// Tell the gate, which posts an `error` status, and never rethrow.
		log("error", "hooks.forgejo.delivery_record_failed", { error_class: errorClass(err) });
		fireSopGate(wiring.sopGate, { ...admitted, dbUnavailable: true });
		return "db_unavailable";
	}

	if (inserted.length === 0) {
		// sf#1071 review: a throwing insert may still have committed, so the retry
		// lands here. The gate re-runs it only if the head shows our db error.
		if (isGatedPullRequest(admitted)) {
			fireSopGate(wiring.sopGate, { ...admitted, duplicate: true });
		}
		logReceived(admitted, false, true);
		return "duplicate";
	}

	await publishNewRow(wiring.bus, admitted, inserted[0]?.id as number);

	// Also only for a NEW row, so the gate inherits the table's dedupe.
	// Sits ahead of the managed-repository check because the gated repository is
	// judged by the gate, not reconciled by this watcher.
	fireSopGate(wiring.sopGate, admitted);

	const managed = wiring.config.repositories.some(
		(repo) => repo.provider === PROVIDER && repo.name === admitted.repository,
	);
	logReceived(admitted, managed, false);
	return managed ? "managed" : "unmanaged";
}

/** Insert the delivery row; zero rows back means a duplicate. */
async function insertDelivery(
	admitted: AdmittedDelivery,
	wiring: ForgeHookWiring,
): Promise<{ id: number }[]> {
	return await wiring.db
		.insert(forgeDeliveries)
		.values({
			provider: PROVIDER,
			deliveryId: admitted.deliveryId,
			event: admitted.event,
			repository: admitted.repository,
			// Bind the JSON text and cast in SQL: handing the object to the
			// jsonb mapper double-encodes through Bun.sql and stores a jsonb STRING;
			// the ::text hop stops Bun.sql inferring jsonb and re-encoding the text.
			payload: sql`${JSON.stringify(admitted.payload)}::text::jsonb`,
		})
		.onConflictDoNothing()
		.returning({ id: forgeDeliveries.id });
}

/**
 * Handle one inbound Forgejo webhook request.
 *
 * See the module doc for the fixed decision order and why each step sits where
 * it does. Returns the response to send; never throws for a malformed or
 * unauthenticated request.
 *
 * The delivery's correlation fields are seeded around `recordDelivery` only,
 * NOT around the wake: the wake rings the scheduler, and a pass started from
 * inside the delivery's scope would carry its `delivery_id`.
 *
 * @param req - the inbound request, body unread
 * @param wiring - secret, database, configuration, and the doorbell
 */
async function handleHookImpl(req: Request, wiring: ForgeHookWiring): Promise<Response> {
	const admitted = await admitDelivery(req, wiring.secret);
	if (admitted instanceof Response) {
		return admitted;
	}
	const fields = {
		delivery_id: bounded(admitted.deliveryId),
		event: bounded(admitted.event),
		repository: admitted.repository,
	};
	const outcome = await withLogFields(fields, () => recordDelivery(admitted, wiring));
	if (outcome === "db_unavailable") {
		// 503 so the forge redelivers once the database is back.
		return Response.json({ accepted: false, error: "db_unavailable" }, { status: 503 });
	}
	if (outcome === "duplicate") {
		return Response.json({ accepted: true, duplicate: true }, { status: 200 });
	}
	if (outcome === "unmanaged") {
		return Response.json({ accepted: true, woken: false }, { status: 200 });
	}

	// Deliberately not awaited: see the module doc.
	try {
		Promise.resolve(wiring.wake()).catch((err: unknown) => {
			log("warn", "hooks.forgejo.wake_failed", { error_class: errorClass(err) });
		});
	} catch (err) {
		log("warn", "hooks.forgejo.wake_failed", { error_class: errorClass(err), sync: true });
	}
	return Response.json({ accepted: true, woken: true }, { status: 202 });
}

export const handleForgejoHook = traced("hooks.handleForgejoHook", handleHookImpl);
