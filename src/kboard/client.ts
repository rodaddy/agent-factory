/**
 * @module kboard/client
 * @description Bounded read/write client for the k-board HTTP API (the sole
 *   mutation authority for `fleet.tasks`). It mirrors the transport posture
 *   of `src/forgejo/client.ts` — injectable `fetch`, explicit per-request
 *   timeout, bounded retries for TRANSIENT transport failures only, and a
 *   credential that never reaches an error path — but speaks k-board's wire
 *   contract:
 *
 *     - Auth is `Authorization: Bearer <token>` (k-board), built at fetch time
 *       from the opaque `KboardToken` wrapper. The token is a SEPARATE
 *       credential (`KBOARD_TOKEN`) and is unreachable from any thrown message,
 *       returned outcome, or log line — the wrapper is never interpolated into a
 *       string that could be logged or thrown.
 *     - Every mutation is READ-THEN-CAS (per the fleet-board Python reference):
 *       a fresh `GET` immediately precedes each `PATCH`, whose body carries the
 *       task's current `expected_sync_version`. `sync_version` is NEVER cached
 *       across calls — a stale token is a bug the server would 409 on, but the
 *       client refuses to even send one.
 *     - A CAS miss (`409`, or a precondition that changed between the GET and the
 *       PATCH) is a TYPED outcome the caller handles, never a blind retry
 *       (ruled: "someone else moved it"). Only transient TRANSPORT failures
 *       (network error, timeout, 5xx) are retried; no `4xx` is ever retried.
 *     - Event POSTs are idempotent: `idempotency_key` is UNIQUE server-side, so a
 *       `409` on an event is SUCCESS-EQUIVALENT (the event is already logged) and
 *       is returned as its own outcome, not an error.
 *     - Every response body is zod-parsed at the boundary. `status` is validated
 *       against the 8-member canonical union; an unknown status is a boundary
 *       rejection, and only the SHAPE (not the value) is logged.
 *
 * @outputs
 *   - `KBOARD_STATUSES` / `KboardStatus` -- the 8 canonical statuses
 *   - `KboardTask` -- the validated task shape
 *   - `KboardClient` / `createKboardClient` -- the bounded client
 *   - `KboardClientOptions` -- supporting options
 *   - mutation outcome unions (`ClaimOutcome`, `MutationOutcome`, `EventOutcome`)
 *
 * @dependencies
 *   - zod -- boundary validation
 *   - ./config -- pinned base URL, actor name, credential wrapper
 *   - ../log -- bounded, secret-safe structured logging
 */
import { z } from "zod";
import { bounded, errorClass, log, traced } from "../log";
import type { KboardToken } from "./config";
import { KBOARD_ACTOR, KBOARD_BASE_URL } from "./config";

/** Injectable fetch signature (matches the global `fetch`). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * The eight canonical k-board statuses. Source of truth is
 * `fleet-board/legacy/k-board/fleet_statuses.py`; `archived` is a boolean
 * column, NEVER a ninth status (_DOCS/board-map.md).
 */
export const KBOARD_STATUSES = [
	"triage",
	"todo",
	"scheduled",
	"ready",
	"running",
	"blocked",
	"review",
	"done",
] as const;

/** A canonical k-board status. */
export type KboardStatus = (typeof KBOARD_STATUSES)[number];

/** The statuses from which a task may be claimed (server-enforced). */
const CLAIMABLE_STATUSES: ReadonlySet<KboardStatus> = new Set([
	"triage",
	"todo",
	"scheduled",
	"ready",
]);

/**
 * The task shape the client trusts, validated at the boundary. Extra fields the
 * server returns are ignored; the ones named here are the client's contract.
 * `repo_*` fields mirror the fleet-board repo binding.
 */
const taskSchema = z.object({
	task_id: z.string(),
	title: z.string(),
	status: z.enum(KBOARD_STATUSES),
	sync_version: z.number().int(),
	tenant: z.string().nullish(),
	assignee: z.string().nullish(),
	body: z.string().nullish(),
	priority: z.number().int().nullish(),
	repo_provider: z.string().nullish(),
	repo_full_name: z.string().nullish(),
	repo_item_number: z.number().int().nullish(),
	repo_pr_number: z.number().int().nullish(),
	repo_base_sha: z.string().nullish(),
});

/** A validated k-board task. */
export type KboardTask = z.infer<typeof taskSchema>;

/** The list endpoint envelope; the client also tolerates a bare array. */
const listEnvelopeSchema = z.object({ tasks: z.array(taskSchema) });

/** The health endpoint body. */
const healthSchema = z.object({ status: z.string(), db: z.string().optional() });

/** The event-create success body (bounded: only the identity fields are read). */
const eventSchema = z.object({ event_id: z.string(), event_type: z.string() });

/** Result of a read that may fail at the boundary or in transport. */
export type ReadOutcome<T> =
	| { kind: "ok"; value: T }
	| { kind: "not_found" }
	| { kind: "rejected"; detail: string }
	| { kind: "transport_failed"; detail: string };

/**
 * The outcome of a CAS-guarded mutation. Callers in phase 1b switch on `kind`.
 * `cas_miss` covers BOTH a server CAS rejection (409) and a precondition that
 * changed between the fresh GET and the PATCH — either way the task moved and
 * this pass must not blind-retry.
 */
export type MutationOutcome =
	| { kind: "ok"; task: KboardTask }
	| { kind: "cas_miss" }
	| { kind: "ownership_refused" }
	| { kind: "not_found" }
	| { kind: "rejected"; detail: string }
	| { kind: "transport_failed"; detail: string };

/**
 * The outcome of a claim. Adds `not_claimable` (the fresh task is assigned to
 * someone else, or is not in a claimable status) — detected BEFORE any PATCH is
 * sent, so a doomed claim never mutates.
 */
export type ClaimOutcome = MutationOutcome | { kind: "not_claimable"; reason: string };

/**
 * The outcome of an event POST. `already_logged` is the idempotent-success case
 * (409 on the UNIQUE `idempotency_key`): the event exists, which is exactly what
 * the caller wanted.
 */
export type EventOutcome =
	| { kind: "ok"; eventId: string }
	| { kind: "already_logged" }
	| { kind: "ownership_refused" }
	| { kind: "not_found" }
	| { kind: "rejected"; detail: string }
	| { kind: "transport_failed"; detail: string };

export interface KboardClientOptions {
	/** The opaque bearer-token wrapper (from `loadKboardToken`). */
	token: KboardToken;
	/** Per-request timeout in milliseconds. */
	timeoutMs?: number;
	/** Maximum retry attempts for transient transport failures (5xx/network/timeout). */
	maxRetries?: number;
	/** Base backoff in milliseconds; grows with the attempt number. */
	backoffMs?: number;
	/** Transport seam for tests. Defaults to the global fetch. */
	fetch?: FetchLike;
	/** Sleep seam so tests do not wait on real backoff. */
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
	timeoutMs: 10_000,
	maxRetries: 3,
	backoffMs: 500,
};

/** Hard ceiling (ms) on any single backoff sleep, however derived. */
const MAX_BACKOFF_MS = 60_000;

/**
 * A definitive HTTP failure, carrying the status and a BOUNDED detail. The
 * detail is derived only from the parsed `error`/`detail` fields of the body or
 * a bounded slice of the text — it never carries the credential, which is only
 * ever a header value.
 */
class KboardHttpError extends Error {
	constructor(
		readonly status: number,
		readonly detail: string,
	) {
		super(`HTTP ${status}`);
		this.name = "KboardHttpError";
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** A raw request result: either a parsed body or a definitive HTTP error. */
type RawResult = { status: number; body: unknown };

/** Bounded k-board read/write client. Construct via `createKboardClient`. */
export class KboardClient {
	private readonly token: KboardToken;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;
	private readonly backoffMs: number;
	private readonly fetchImpl: FetchLike;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(opts: KboardClientOptions) {
		this.token = opts.token;
		this.baseUrl = KBOARD_BASE_URL;
		this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
		this.maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
		this.backoffMs = Math.min(Math.max(0, opts.backoffMs ?? DEFAULTS.backoffMs), MAX_BACKOFF_MS);
		this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
		this.sleep = opts.sleep ?? defaultSleep;
	}

	/**
	 * Perform one request with a bounded timeout and, for GET/PATCH only, bounded
	 * retries on TRANSIENT transport failures (network error, timeout, 5xx). A
	 * `4xx` is NEVER retried: it is a definitive answer thrown as `KboardHttpError`.
	 * POST is never retried at the transport layer — idempotency is handled at the
	 * event boundary via the UNIQUE `idempotency_key`, so a retry would be either
	 * redundant (409) or a fresh attempt the caller did not ask for.
	 *
	 * The `Authorization` header is built HERE, at fetch time, from the wrapper —
	 * the raw token is never a variable that could be interpolated into a log line
	 * or an error message.
	 */
	private async request(
		method: "GET" | "PATCH" | "POST",
		path: string,
		body?: unknown,
	): Promise<RawResult> {
		const url = `${this.baseUrl}${path}`;
		const serialized = body === undefined ? undefined : JSON.stringify(body);
		const mayRetry = method !== "POST";
		let lastError = "request failed";

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			const outcome = await this.attemptRequest({
				method,
				url,
				serialized,
				mayRetry,
				attempt,
			});
			if (!("retry" in outcome)) {
				return outcome;
			}
			lastError = outcome.retry;
		}
		throw new Error(`k-board request failed: ${lastError}`);
	}

	/**
	 * The fixed k-board request headers. The `Authorization` header is built HERE,
	 * at fetch time, from the wrapper — the raw token never becomes a standalone
	 * string that could be logged or thrown.
	 */
	private requestHeaders(serialized: string | undefined): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: this.token.authorization(),
			Accept: "application/json",
			"User-Agent": "software-factory",
		};
		if (serialized !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		return headers;
	}

	/**
	 * One attempt of the shared request path. Returns the parsed result on
	 * success, or `{ retry: lastError }` when the caller should try again. A
	 * `KboardHttpError` (any 4xx/5xx the retry budget will not absorb) propagates
	 * unchanged, so the loop in `request` never has to decide what is fatal.
	 */
	private async attemptRequest(args: {
		method: "GET" | "PATCH" | "POST";
		url: string;
		serialized: string | undefined;
		mayRetry: boolean;
		attempt: number;
	}): Promise<RawResult | { retry: string }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await this.fetchImpl(args.url, {
				method: args.method,
				headers: this.requestHeaders(args.serialized),
				body: args.serialized,
				signal: controller.signal,
			});
			clearTimeout(timer);

			if (
				args.mayRetry &&
				res.status >= 500 &&
				res.status <= 599 &&
				args.attempt < this.maxRetries
			) {
				await this.sleep(Math.min(this.backoffMs * (args.attempt + 1), MAX_BACKOFF_MS));
				return { retry: `HTTP ${res.status}` };
			}

			const parsed = await this.parseBody(res);
			if (res.status >= 400) {
				throw new KboardHttpError(res.status, detailOf(parsed, res.status));
			}
			return { status: res.status, body: parsed };
		} catch (err) {
			clearTimeout(timer);
			if (err instanceof KboardHttpError) {
				throw err;
			}
			const lastError =
				err instanceof Error && err.name === "AbortError" ? "request timed out" : "network error";
			if (args.mayRetry && args.attempt < this.maxRetries) {
				await this.sleep(Math.min(this.backoffMs * (args.attempt + 1), MAX_BACKOFF_MS));
				return { retry: lastError };
			}
			throw new Error(`k-board request failed: ${lastError}`);
		}
	}

	/** Parse a JSON body, tolerating an empty response. Never logs the body text. */
	private async parseBody(res: Response): Promise<unknown> {
		if (res.status === 204) return null;
		const text = await res.text();
		if (text.length === 0) return null;
		try {
			return JSON.parse(text);
		} catch (err) {
			// The body could quote a credentialed request; record only the error class
			// and the byte count, never the text.
			log("warn", "kboard.client.body_unparseable", {
				status: res.status,
				bytes: text.length,
				error_class: errorClass(err),
			});
			return null;
		}
	}

	/** Health probe: `GET /health`. */
	async health(): Promise<ReadOutcome<{ status: string; db?: string }>> {
		let raw: RawResult;
		try {
			raw = await this.request("GET", "/health");
		} catch (err) {
			return transportFail(err);
		}
		const parsed = healthSchema.safeParse(raw.body);
		if (!parsed.success) {
			log("warn", "kboard.client.health_shape_invalid", { issues: parsed.error.issues.length });
			return { kind: "rejected", detail: "health response shape invalid" };
		}
		return { kind: "ok", value: parsed.data };
	}

	/**
	 * List tasks, optionally filtered by `repo` (the `owner/repo` binding) and
	 * `status`. Tolerates BOTH the `{ tasks: [...] }` envelope the server returns
	 * and a bare array, so a future server change to a bare list does not break
	 * the read.
	 */
	async listTasks(
		filter: { repo?: string; status?: KboardStatus } = {},
	): Promise<ReadOutcome<KboardTask[]>> {
		const params = new URLSearchParams();
		if (filter.repo !== undefined) params.set("repo", filter.repo);
		if (filter.status !== undefined) params.set("status", filter.status);
		const query = params.toString();
		let raw: RawResult;
		try {
			raw = await this.request("GET", `/api/tasks${query ? `?${query}` : ""}`);
		} catch (err) {
			return this.readError(err);
		}
		// Accept both the envelope and a bare array.
		const asArray = Array.isArray(raw.body)
			? z.array(taskSchema).safeParse(raw.body)
			: listEnvelopeSchema.safeParse(raw.body);
		if (!asArray.success) {
			log("warn", "kboard.client.list_shape_invalid", { issues: asArray.error.issues.length });
			return { kind: "rejected", detail: "task list response shape invalid" };
		}
		const tasks = Array.isArray(asArray.data) ? asArray.data : asArray.data.tasks;
		return { kind: "ok", value: tasks };
	}

	/** Fetch one task by id: `GET /api/tasks/{id}`. */
	async getTask(taskId: string): Promise<ReadOutcome<KboardTask>> {
		let raw: RawResult;
		try {
			raw = await this.request("GET", `/api/tasks/${encodeURIComponent(taskId)}`);
		} catch (err) {
			return this.readError(err);
		}
		const parsed = taskSchema.safeParse(raw.body);
		if (!parsed.success) {
			log("warn", "kboard.client.task_shape_invalid", { issues: parsed.error.issues.length });
			return { kind: "rejected", detail: "task response shape invalid" };
		}
		return { kind: "ok", value: parsed.data };
	}

	/**
	 * Claim a task: read fresh, verify it is UNASSIGNED and in a claimable status,
	 * then CAS-PATCH `{ assignee, status: running, expected_sync_version }`. The
	 * claimability check happens against the FRESH read, so an assigned or
	 * non-claimable task returns `not_claimable` WITHOUT any PATCH being sent
	 * (read-then-CAS, per the fleet-board Python reference).
	 */
	async claimTask(taskId: string): Promise<ClaimOutcome> {
		const fresh = await this.getTask(taskId);
		if (fresh.kind !== "ok") return fresh;
		const task = fresh.value;
		if (!CLAIMABLE_STATUSES.has(task.status)) {
			return { kind: "not_claimable", reason: `status not claimable: ${task.status}` };
		}
		if (task.assignee != null && task.assignee !== KBOARD_ACTOR) {
			return { kind: "not_claimable", reason: "task is assigned to another actor" };
		}
		return this.casPatch(taskId, {
			assignee: KBOARD_ACTOR,
			status: "running",
			expected_sync_version: task.sync_version,
		});
	}

	/** Move a task to `status`: read fresh, then CAS-PATCH the status. */
	async setStatus(taskId: string, status: KboardStatus): Promise<MutationOutcome> {
		const fresh = await this.getTask(taskId);
		if (fresh.kind !== "ok") return fresh;
		return this.casPatch(taskId, {
			status,
			expected_sync_version: fresh.value.sync_version,
		});
	}

	/** Set `repo_pr_number`: read fresh, then CAS-PATCH the field. */
	async setPrNumber(taskId: string, prNumber: number): Promise<MutationOutcome> {
		const fresh = await this.getTask(taskId);
		if (fresh.kind !== "ok") return fresh;
		return this.casPatch(taskId, {
			repo_pr_number: prNumber,
			expected_sync_version: fresh.value.sync_version,
		});
	}

	/**
	 * Post an event: `POST /api/tasks/{id}/events` with `actor = KBOARD_ACTOR`.
	 * The `idempotencyKey` is CALLER-SUPPLIED (derivation is phase-1b's job) and
	 * is REQUIRED — a UNIQUE key is what makes a retried pass safe. A 409 means the
	 * event is already logged and is returned as `already_logged`, the
	 * success-equivalent outcome, NOT an error.
	 */
	async postEvent(
		taskId: string,
		event: { eventType: string; idempotencyKey: string; payload?: Record<string, unknown> },
	): Promise<EventOutcome> {
		let raw: RawResult;
		try {
			raw = await this.request("POST", `/api/tasks/${encodeURIComponent(taskId)}/events`, {
				event_type: event.eventType,
				actor: KBOARD_ACTOR,
				origin_agent: "software-factory",
				idempotency_key: event.idempotencyKey,
				...(event.payload !== undefined ? { new_value: event.payload } : {}),
			});
		} catch (err) {
			if (err instanceof KboardHttpError) {
				// 409 on a UNIQUE idempotency_key is success-equivalent: already logged.
				if (err.status === 409) return { kind: "already_logged" };
				if (err.status === 403) return { kind: "ownership_refused" };
				if (err.status === 404) return { kind: "not_found" };
				return { kind: "rejected", detail: err.detail };
			}
			return transportFail(err);
		}
		const parsed = eventSchema.safeParse(raw.body);
		if (!parsed.success) {
			log("warn", "kboard.client.event_shape_invalid", { issues: parsed.error.issues.length });
			return { kind: "rejected", detail: "event response shape invalid" };
		}
		return { kind: "ok", eventId: parsed.data.event_id };
	}

	/**
	 * Send one CAS-guarded PATCH and map its response to a `MutationOutcome`. The
	 * caller has already GET'd fresh; this method sends exactly one PATCH and does
	 * NOT retry a `4xx`. A 409 (or a 400 `expected_sync_version_required`, which
	 * means the guard was somehow dropped) maps to `cas_miss` so the caller
	 * re-reads and skips the pass rather than blind-retrying.
	 */
	private async casPatch(taskId: string, patch: Record<string, unknown>): Promise<MutationOutcome> {
		let raw: RawResult;
		try {
			raw = await this.request("PATCH", `/api/tasks/${encodeURIComponent(taskId)}`, patch);
		} catch (err) {
			if (err instanceof KboardHttpError) {
				if (err.status === 409) return { kind: "cas_miss" };
				if (err.status === 403) return { kind: "ownership_refused" };
				if (err.status === 404) return { kind: "not_found" };
				// A 400 whose body names the CAS token means the guard was rejected — a
				// precondition problem, treated as a CAS miss, never blind-retried.
				if (err.status === 400 && /expected_sync_version/.test(err.detail)) {
					return { kind: "cas_miss" };
				}
				return { kind: "rejected", detail: err.detail };
			}
			return transportFail(err);
		}
		const parsed = taskSchema.safeParse(raw.body);
		if (!parsed.success) {
			log("warn", "kboard.client.patch_shape_invalid", { issues: parsed.error.issues.length });
			return { kind: "rejected", detail: "patch response shape invalid" };
		}
		return { kind: "ok", task: parsed.data };
	}

	/** Map a thrown request error to a read outcome (`not_found` on 404). */
	private readError<T>(err: unknown): ReadOutcome<T> {
		if (err instanceof KboardHttpError) {
			if (err.status === 404) return { kind: "not_found" };
			return { kind: "rejected", detail: err.detail };
		}
		return transportFail(err);
	}
}

/**
 * Derive a BOUNDED, secret-free detail from a parsed error body. The k-board
 * server puts a machine key in `error` and prose in `detail`; either is safe to
 * surface. Falls back to the status. Never includes the request or any header.
 */
function detailOf(body: unknown, status: number): string {
	if (body && typeof body === "object") {
		const record = body as Record<string, unknown>;
		const error = typeof record.error === "string" ? record.error : undefined;
		const detail = typeof record.detail === "string" ? record.detail : undefined;
		if (error || detail) {
			return bounded(error ? (detail ? `${error}: ${detail}` : error) : detail);
		}
	}
	return `HTTP ${status}`;
}

/**
 * Build a `transport_failed` outcome from a caught error. The message here comes
 * ONLY from the fixed strings `request` throws (`"request timed out"` /
 * `"network error"`) — never from the token, which is never a variable at a
 * throw site.
 */
function transportFail(err: unknown): { kind: "transport_failed"; detail: string } {
	return { kind: "transport_failed", detail: bounded(err instanceof Error ? err.message : err) };
}

/** Construct the bounded k-board client. */
export const createKboardClient = traced(
	"kboard.createKboardClient",
	function createKboardClient(opts: KboardClientOptions): KboardClient {
		return new KboardClient(opts);
	},
);
