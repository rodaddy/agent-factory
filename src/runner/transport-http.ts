/**
 * @module runner/transport-http
 * @description A second `RunnerTransport` implementation that speaks MCP
 *   2026-07-28 stateless streamable-HTTP JSON-RPC directly to the runner-boxes
 *   gateway, alongside (never replacing) `Mcp2cliRunnerTransport`.
 *
 *   WHAT THIS REMOVES. Today the path is
 *   `watcher -> Bun.spawn(mcp2cli) -> local daemon -> stdio -> runner-boxes-mcp`.
 *   That spawn plus daemon hop is the origin of the `CONNECTION_ERROR` transport
 *   fault this repo carries `RunnerAllocationUnknownError`, `STRANDED_BOX_HINT`,
 *   and `isTransportFault` to survive. Speaking HTTP removes the hop.
 *
 *   ALLOCATION USES THE GATEWAY HANDLE. `runner_needed` returns immediately;
 *   this transport polls `runner_status` and cancels on timeout. A failed cancel
 *   becomes `RunnerAllocationUnknownError`, preserving the existing reconciliation
 *   contract without relying on the removed MCP Tasks extension.
 *
 *   STATELESS is the load-bearing spec property: no `initialize`, no
 *   `Mcp-Session-Id`. Protocol version and client info travel in `_meta` on EVERY
 *   request, so any request can route to any gateway instance. The protocol version
 *   also travels in `Mcp-Protocol-Version`; `Mcp-Method` and `Mcp-Name` complete the
 *   required routing headers. Servers reject requests where headers and body
 *   disagree, so both surfaces derive from the same named values.
 *
 *   ERROR DECISIONS BEGIN WITH STRUCTURE HERE. A JSON-RPC `error` object, an
 *   `isError` result, or an HTTP failure is tagged at decode time. `runner_run`
 *   then retries only the observed not-found-on-any-reachable-node tool answer;
 *   every transport/RPC fault and every other verb failure stays terminal in one
 *   attempt. The string classifiers remain AUTHORITATIVE on the mcp2cli path,
 *   which this HTTP policy does not change.
 *
 * @outputs
 *   - `HttpRunnerTransport` -- the v2 stateless-HTTP implementation
 *   - `RunnerTransportConfigError` -- fail-closed selection/construction error
 *   - `createRunnerTransport` -- the env-gated selection seam
 *   - `MCP_PROTOCOL_VERSION` / `MCP_CLIENT_INFO` -- the pinned `_meta` values
 *
 * @dependencies
 *   - ./transport -- the shared `RunnerTransport` contract, classifiers, parsers
 *   - ./transport-http-run -- the one-answer boot-race retry policy
 *   - ./transport-boxes -- `parseBoxes` / `parseListedBoxes`, one parser family
 *   - ./script-route -- the sf#384 agentless-route guard, applied identically here
 *   - ../log -- structured stderr logging (never the token, never the URL creds)
 */
import { log } from "../log";
import { runnerRunArgs } from "./routing-args";
import { runRouteViolation } from "./script-route";
import {
	boundedPayload,
	hasErrorPayload,
	isRefusal,
	NEEDED_TIMEOUT_MS,
	RUNNER_FORGE_UP_TIMEOUT_MS,
	RUNNER_STOP_TIMEOUT_MS,
	type RunnerAllocation,
	RunnerAllocationUnknownError,
	RunnerBandRefusedError,
	type RunnerDoneOutcome,
	type RunnerRunParams,
	type RunnerTransport,
	runnerDoneArgs,
	runnerDoneFailure,
} from "./transport";
import { type ListedBox, parseBoxes, parseForgeSlots, parseListedBoxes } from "./transport-boxes";
import { type HttpRunResult, runWithHttpBootRetry } from "./transport-http-run";

/**
 * The protocol revision this client speaks, sent in the header and `_meta` on every
 * request because the transport is stateless and has no `initialize` negotiation.
 */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/** Client identity, also `_meta` on every request for the same stateless reason. */
export const MCP_CLIENT_INFO = { name: "software-factory-watcher", version: "1" } as const;

/** MCP SDK-defined `_meta` key for the protocol revision. */
export const MCP_PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";

/** MCP SDK-defined `_meta` key for the client identity. */
export const MCP_CLIENT_INFO_META_KEY = "io.modelcontextprotocol/clientInfo";

/** MCP SDK-defined `_meta` key for client capabilities. */
export const MCP_CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";

/**
 * The W3C Trace Context key names are LOCKED DOWN by the spec so traces correlate
 * across SDKs and gateways. Named as a constant so a future `tracestate`/`baggage`
 * addition joins a list rather than being spelled inline at a call site.
 */
export const TRACEPARENT_META_KEY = "traceparent";

/** Default per-request HTTP timeout for every verb except `done`. */
export const DEFAULT_HTTP_TIMEOUT_MS = 90_000;

/**
 * Dedicated `done` timeout for the gateway's foreground reap sequence.
 * `runner_done` runs `guarded_hard_reap` under `with_lease_lock`
 * (`runner-boxes:1144`, `:1178`). The HARD-BOUNDED terms are 120s for the
 * lease lock (`flock -w 120`, `runner-boxes:292`) and a 10s SSH connect
 * ceiling per host probed by `owning_host` (`runner-boxes:211`, `:942-946`;
 * two configured hosts, so up to 20s). The established SSH session and the
 * `pct stop`/unlock/`pct destroy` sequence inside `guarded_hard_reap` have NO
 * cap: `REAP_SSH_TIMEOUT_S` is set only by `bounded_hard_reap`
 * (`runner-boxes:1006-1013`), which the allocation path uses, not `done`. The
 * 180s budget is therefore the bounded 140s plus a chosen 40s window for the
 * destroy itself, not a derived ceiling; bounding the gateway side is
 * rtech-infra's. The client must outlive the destroy or an abort leaves a
 * `lock: destroyed` tombstone.
 */
export const DEFAULT_DONE_TIMEOUT_MS = 180_000;

/** Fixed allocation-status cadence; slow enough not to hammer the gateway. */
export const NEEDED_POLL_INTERVAL_MS = 4_000;

/**
 * A configuration/selection fault, thrown at CONSTRUCTION rather than on first
 * use, and NEVER recovered by falling back to mcp2cli.
 *
 * WHY IT FAILS CLOSED. A silent fallback is how a config typo re-introduces the
 * mcp2cli hop while every log line and dashboard still reads as though the HTTP
 * path is live — the operator would be told the migration succeeded by a process
 * that quietly did not migrate. Failing at construction puts the missing variable
 * in front of whoever set it.
 */
export class RunnerTransportConfigError extends Error {
	override readonly name = "RunnerTransportConfigError";
}

/** Tunables for the HTTP transport (defaults suit production; tests inject). */
export interface HttpTransportOptions {
	/** Per-request timeout in ms for every verb except `done`. */
	timeoutMs?: number;
	/** Per-request timeout in ms for the `done` reap verb. */
	doneTimeoutMs?: number;
	/**
	 * W3C `traceparent` for outbound `_meta`, so a runner job correlates with its
	 * Langfuse trace across the gateway boundary (the runner-transport leg of #184).
	 *
	 * Threaded via constructor/setter rather than a per-call argument on purpose:
	 * `RunnerTransport` is SHARED with `Mcp2cliRunnerTransport` and must stay
	 * byte-identical, so widening its method signatures is not available.
	 */
	traceparent?: string;
	/** Injectable fetch so tests drive a mock server without patching globals. */
	fetch?: typeof fetch;
	/** Allocation budget; production uses the shared `NEEDED_TIMEOUT_MS`. */
	neededTimeoutMs?: number;
	/** Injectable allocation poll interval. */
	neededPollIntervalMs?: number;
	/** Injectable sleep so allocation and run-retry tests never wait on wall clock. */
	sleep?: (ms: number) => Promise<void>;
	/** Injectable monotonic clock for deterministic allocation-budget tests. */
	now?: () => number;
}

/** One decoded `tools/call` outcome: structured payload, text, or a failure. */
interface ToolCallResult extends HttpRunResult {
	/** `structuredContent` when the gateway declared an `outputSchema`. */
	structured: unknown;
	/** Concatenated `text` content blocks; `""` when none. */
	text: string;
}

type AllocationStatus = "working" | "completed" | "failed" | "cancelled";

interface TypedFailure {
	kind: string;
	message: string;
	retryable: boolean;
	outcome_unknown: boolean;
}

interface AllocationHandle {
	allocation_id: string;
	status: AllocationStatus;
	failure: TypedFailure | null;
}

interface AllocationState {
	allocation_id: string;
	status: AllocationStatus;
	vmids: number[];
	result: { failure: TypedFailure | null } | null;
}

interface CancelOutcome {
	allocation_id: string;
	status: AllocationStatus;
	reaped_vmids: number[];
	reap_failures: string[];
}

/**
 * `RunnerTransport` over MCP 2026-07-28 stateless streamable HTTP.
 *
 * Verb names and param shapes are IDENTICAL to what the mcp2cli transport sends
 * today (`runner_needed`, `runner_run`, `runner_done`, `runner_list` with `{}`),
 * because the server on the far end is the same server — only the envelope
 * changed. The MCP boundary silently DROPS params the old server does not declare,
 * and the v2 server REJECTS them, so an invented key here is a loud failure rather
 * than a no-op: do not add one.
 */
export class HttpRunnerTransport implements RunnerTransport {
	private readonly endpoint: string;
	private readonly token: string;
	private readonly timeoutMs: number;
	private readonly doneTimeoutMs: number;
	private readonly neededTimeoutMs: number;
	private readonly neededPollIntervalMs: number;
	private readonly doFetch: typeof fetch;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly now: () => number;
	private traceparent: string | undefined;
	private nextId = 1;

	/**
	 * @param baseUrl gateway base URL; normalized to one trailing `/mcp` path.
	 * @param token bearer credential. NEVER logged, NEVER placed in argv, NEVER
	 *   written into a result or an error message. It travels only in the
	 *   `Authorization` header of a request this class builds.
	 */
	constructor(baseUrl: string, token: string, options: HttpTransportOptions = {}) {
		if (!baseUrl.trim()) {
			throw new RunnerTransportConfigError("runner HTTP transport requires a base URL");
		}
		if (!token.trim()) {
			throw new RunnerTransportConfigError("runner HTTP transport requires a bearer token");
		}
		this.endpoint = `${baseUrl.replace(/\/+$/, "").replace(/\/mcp$/, "")}/mcp`;
		this.token = token;
		this.timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS);
		this.doneTimeoutMs = Math.max(1, options.doneTimeoutMs ?? DEFAULT_DONE_TIMEOUT_MS);
		this.neededTimeoutMs = Math.max(0, options.neededTimeoutMs ?? NEEDED_TIMEOUT_MS);
		this.neededPollIntervalMs = Math.max(
			0,
			options.neededPollIntervalMs ?? NEEDED_POLL_INTERVAL_MS,
		);
		this.doFetch = options.fetch ?? fetch;
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.now = options.now ?? Date.now;
		this.traceparent = options.traceparent;
	}

	/** Set the W3C `traceparent` carried in `_meta` on subsequent requests. */
	setTraceparent(traceparent: string | undefined): void {
		this.traceparent = traceparent;
	}

	/**
	 * One stateless `tools/call`. `Mcp-Method` and `Mcp-Name` are derived from the
	 * same values written into the body, because the spec requires servers to
	 * reject a request whose headers and body disagree.
	 */
	protected async call(
		name: string,
		args: Record<string, unknown>,
		timeoutMs: number = this.timeoutMs,
	): Promise<ToolCallResult> {
		const method = "tools/call";
		const meta: Record<string, unknown> = {
			[MCP_PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_VERSION,
			[MCP_CLIENT_INFO_META_KEY]: MCP_CLIENT_INFO,
			[MCP_CLIENT_CAPABILITIES_META_KEY]: {},
		};
		if (this.traceparent) {
			meta[TRACEPARENT_META_KEY] = this.traceparent;
		}
		const body = {
			jsonrpc: "2.0",
			id: this.nextId++,
			method,
			params: { name, arguments: args, _meta: meta },
		};
		const response = await this.doFetch(this.endpoint, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				"mcp-method": method,
				"mcp-name": name,
				"mcp-protocol-version": MCP_PROTOCOL_VERSION,
				// The bearer token is read here and nowhere else. It is not logged, not
				// interpolated into any message, and not returned in any result: this
				// repo's no-secrets rule covers logs, results, fixtures, and PR bodies.
				authorization: `Bearer ${this.token}`,
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		return decodeToolCall(name, response.status, this.scrub(await response.text()));
	}

	/**
	 * Remove this transport's OWN bearer token from untrusted gateway output before
	 * any of it reaches a message, a log line, or a persisted column.
	 *
	 * WHY `redactSecrets` IS NOT ENOUGH HERE. Its patterns are shape-based — `ghp_`,
	 * `xox[baprs]-`, a JWT's three segments, `Bearer <token>` — and a gateway token
	 * of arbitrary shape appearing BARE in an error body matches none of them. This
	 * transport is the one place in the process that knows the literal value, so it
	 * is the only boundary that can remove it unconditionally. A 401 body echoing the
	 * credential it rejected is the realistic case, not a hypothetical.
	 *
	 * Runs BEFORE decoding so every downstream path — the failure message, the
	 * `structuredContent`, the text fallback — is scrubbed by construction rather
	 * than at each site that might forget.
	 */
	private scrub(body: string): string {
		return body.split(this.token).join("[REDACTED]");
	}

	async needed(size: string, jobId: string, count: number): Promise<RunnerAllocation> {
		const result = await this.call("runner_needed", { size, job_id: jobId, count });
		if (result.failure) {
			if (!result.structuredFailure && isRefusal(result.failure)) {
				return capacityRefusal();
			}
			throw new Error(`runner_needed failed -- ${boundedPayload(result.failure)}`);
		}
		const handle = allocationHandleFrom(result);
		if (handle.failure) {
			return allocationHandleFailure(handle.failure);
		}
		if (!handle.allocation_id) {
			throw new Error("runner_needed failed -- allocation handle carried no allocation_id");
		}
		return this.pollAllocation(handle.allocation_id, size);
	}

	private async pollAllocation(allocationId: string, size: string): Promise<RunnerAllocation> {
		const deadline = this.now() + this.neededTimeoutMs;
		while (this.now() < deadline) {
			const result = await this.pollStatus(allocationId);
			if (!result) {
				await this.waitForNextPoll(deadline);
				continue;
			}
			const state = allocationStateFrom(result);
			if (state.status === "completed") {
				return completedAllocation(state, size);
			}
			if (state.status === "failed") {
				throwAllocationFailure(state.result?.failure);
			}
			if (state.status !== "working") {
				throw new Error(`runner_needed failed -- unexpected allocation status ${state.status}`);
			}
			await this.waitForNextPoll(deadline);
		}
		return this.cancelTimedOutAllocation(allocationId);
	}

	private async pollStatus(allocationId: string): Promise<ToolCallResult | null> {
		try {
			const result = await this.call("runner_status", { allocation_id: allocationId });
			return result.failure ? null : result;
		} catch (err) {
			log("warn", "runner.transport_http.status_poll_failed", {
				allocation_id: allocationId,
				error_class: err instanceof Error ? err.name : typeof err,
			});
			return null;
		}
	}

	private async waitForNextPoll(deadline: number): Promise<void> {
		const remaining = Math.max(0, deadline - this.now());
		await this.sleep(Math.min(this.neededPollIntervalMs, remaining));
	}

	private async cancelTimedOutAllocation(allocationId: string): Promise<never> {
		let result: ToolCallResult;
		try {
			result = await this.call("runner_cancel", { allocation_id: allocationId });
		} catch (err) {
			throw cancelUnknownError(allocationId, err instanceof Error ? err.message : String(err));
		}
		if (result.failure) {
			throw cancelUnknownError(allocationId, result.failure);
		}
		let outcome: CancelOutcome;
		try {
			outcome = cancelOutcomeFrom(result);
		} catch (err) {
			throw cancelUnknownError(allocationId, err instanceof Error ? err.message : String(err));
		}
		if (outcome.status !== "cancelled" || outcome.reap_failures.length > 0) {
			throw cancelUnknownError(allocationId, JSON.stringify(outcome.reap_failures));
		}
		throw new Error(
			`runner_needed timed out after ${this.neededTimeoutMs}ms; runner_cancel confirmed allocation ${allocationId} was reaped`,
		);
	}

	async run(params: RunnerRunParams): Promise<void> {
		// sf#384: a script route must NAME model and effort; refused here, before the
		// first `invoke`, because a box is already allocated and held.
		// Identical to the mcp2cli path deliberately — the guard belongs to the verb
		// contract, not to a transport.
		const violation = runRouteViolation(params);
		if (violation) {
			throw new Error(`runner_run ${violation}`);
		}
		await runWithHttpBootRetry({
			params,
			call: () => this.call("runner_run", runnerRunArgs(params)),
			sleep: this.sleep,
		});
	}

	async list(): Promise<ListedBox[]> {
		// SENDS `{}`. The verb declares NO parameters (live signature, 2026-08-17:
		// `def runner_list()`), and an invented argument is a loud rejection on the v2
		// server where it was a silent drop on the old one. Do not add one.
		const result = await this.call("runner_list", {});
		if (result.failure) {
			throw new Error(`runner_list failed -- ${boundedPayload(result.failure)}`);
		}
		return listedFromStructured(result.structured) ?? parseListedBoxes(result.text);
	}

	async startBandMember(vmid: number): Promise<void> {
		// sf#1090: the gateway clones the slot and waits up to 90 s for it to go active.
		await this.bandCall("runner_forge_up", { vmid }, RUNNER_FORGE_UP_TIMEOUT_MS);
	}

	async stopBandMember(vmid: number): Promise<void> {
		// sf#1090: destroys the slot; `refused: busy` while it holds a job.
		await this.bandCall("runner_forge_down", { vmid, force: false }, RUNNER_STOP_TIMEOUT_MS);
	}

	async listBand(band: "forge"): Promise<ListedBox[]> {
		// sf#1080: the gateway answers with its declared `VerbResult` (`{ok, exit_code,
		// stdout, stderr, cmd, failure}`, runner-boxes-mcp `results.py`) as
		// `structuredContent`; its `stdout` IS the `cmd_list` table. Without this
		// unwrap the table was never read and the band looked empty forever. `ok:false`
		// never reaches here (`bandCall` throws). The older shapes stay as fallbacks.
		// A VerbResult carried ONLY as a JSON text block is not unwrapped: the gateway
		// declares an `outputSchema`, and this file is at the `lint:size` bound.
		const result = await this.bandCall("runner_list", { band });
		const verb = (result.structured ?? {}) as { stdout?: unknown };
		const table = typeof verb.stdout === "string" ? verb.stdout : result.text;
		const slots = parseForgeSlots(table);
		if (slots.length > 0) return slots;
		return listedFromStructured(result.structured) ?? parseListedBoxes(table);
	}

	/**
	 * One forge-band call: refusal text (failure or success) throws
	 * `RunnerBandRefusedError`. A structured `VerbResult` with `ok:false` throws too,
	 * even when the gateway neither set `isError` nor serialised it into a text
	 * block (`decodeToolCall` already fails the text-block form). `floorMs` raises the
	 * budget above `timeoutMs` for a verb that legitimately runs longer.
	 */
	private async bandCall(name: string, args: Record<string, unknown>, floorMs = 0) {
		const result = await this.call(name, args, Math.max(this.timeoutMs, floorMs));
		const verb = JSON.stringify(result.structured ?? null);
		const text = result.failure ?? (hasErrorPayload(verb) ? verb : result.text);
		if (text && isRefusal(text))
			throw new RunnerBandRefusedError(`${name} refused -- ${boundedPayload(text)}`);
		if (result.failure || hasErrorPayload(verb))
			throw new Error(`${name} failed -- ${boundedPayload(text)}`);
		return result;
	}

	async done(vmid: number, jobId?: string): Promise<RunnerDoneOutcome> {
		const result = await this.call("runner_done", runnerDoneArgs(vmid, jobId), this.doneTimeoutMs);
		if (result.failure) return runnerDoneFailure(vmid, result.failure);
	}
}

function capacityRefusal(detail?: string): RunnerAllocation {
	const suffix = detail ? ` -- ${boundedPayload(detail)}` : "";
	return { ok: false, refused: true, reason: `runner capacity unavailable${suffix}`, placed: [] };
}

function allocationHandleFailure(failure: TypedFailure): RunnerAllocation {
	if (failure.kind === "refusal" && !failure.outcome_unknown) {
		return capacityRefusal(failure.message);
	}
	if (failure.outcome_unknown) {
		throw new RunnerAllocationUnknownError(
			`runner_needed outcome UNKNOWN -- ${boundedPayload(failure.message)}`,
		);
	}
	throw new Error(`runner_needed failed -- ${failure.kind}: ${boundedPayload(failure.message)}`);
}

function completedAllocation(state: AllocationState, size: string): RunnerAllocation {
	const boxes = parseBoxes(JSON.stringify(state.vmids.map((vmid) => ({ vmid }))), size);
	if (boxes.length === 0) {
		return { ok: false, refused: true, reason: "no runner box allocated", placed: [] };
	}
	return { ok: true, boxes };
}

function throwAllocationFailure(failure: TypedFailure | null | undefined): never {
	if (!failure) {
		throw new Error("runner_needed failed -- terminal allocation carried no typed failure");
	}
	if (failure.outcome_unknown) {
		throw new RunnerAllocationUnknownError(
			`runner_needed outcome UNKNOWN -- ${boundedPayload(failure.message)}`,
		);
	}
	throw new Error(`runner_needed failed -- ${failure.kind}: ${boundedPayload(failure.message)}`);
}

function cancelUnknownError(allocationId: string, detail: string): RunnerAllocationUnknownError {
	return new RunnerAllocationUnknownError(
		`runner_needed outcome UNKNOWN after timeout: runner_cancel failed for ${allocationId} -- ${boundedPayload(detail)}`,
	);
}

function allocationHandleFrom(result: ToolCallResult): AllocationHandle {
	const obj = structuredRecord(result, "runner_needed");
	return {
		allocation_id: stringField(obj, "allocation_id", "runner_needed"),
		status: allocationStatus(obj.status, "runner_needed"),
		failure: typedFailureFrom(obj.failure, "runner_needed"),
	};
}

function allocationStateFrom(result: ToolCallResult): AllocationState {
	const obj = structuredRecord(result, "runner_status");
	const rawResult = obj.result;
	const resultObj =
		rawResult && typeof rawResult === "object" ? (rawResult as Record<string, unknown>) : null;
	return {
		allocation_id: stringField(obj, "allocation_id", "runner_status"),
		status: allocationStatus(obj.status, "runner_status"),
		vmids: numberArray(obj.vmids, "runner_status.vmids"),
		result: resultObj
			? { failure: typedFailureFrom(resultObj.failure, "runner_status.result") }
			: null,
	};
}

function cancelOutcomeFrom(result: ToolCallResult): CancelOutcome {
	const obj = structuredRecord(result, "runner_cancel");
	return {
		allocation_id: stringField(obj, "allocation_id", "runner_cancel"),
		status: allocationStatus(obj.status, "runner_cancel"),
		reaped_vmids: numberArray(obj.reaped_vmids, "runner_cancel.reaped_vmids"),
		reap_failures: stringArray(obj.reap_failures, "runner_cancel.reap_failures"),
	};
}

function structuredRecord(result: ToolCallResult, tool: string): Record<string, unknown> {
	if (
		result.structured &&
		typeof result.structured === "object" &&
		!Array.isArray(result.structured)
	) {
		return result.structured as Record<string, unknown>;
	}
	throw new Error(`${tool} failed -- response carried no structuredContent`);
}

function typedFailureFrom(value: unknown, context: string): TypedFailure | null {
	if (value === null || value === undefined) {
		return null;
	}
	if (typeof value !== "object" || Array.isArray(value)) {
		throw new Error(`${context} failed -- malformed typed failure`);
	}
	const obj = value as Record<string, unknown>;
	return {
		kind: stringField(obj, "kind", context),
		message: stringField(obj, "message", context),
		retryable: booleanField(obj, "retryable", context),
		outcome_unknown: booleanField(obj, "outcome_unknown", context),
	};
}

function allocationStatus(value: unknown, context: string): AllocationStatus {
	if (value === "working" || value === "completed" || value === "failed" || value === "cancelled") {
		return value;
	}
	throw new Error(`${context} failed -- invalid allocation status ${String(value)}`);
}

function stringField(obj: Record<string, unknown>, key: string, context: string): string {
	const value = obj[key];
	if (typeof value === "string") {
		return value;
	}
	throw new Error(`${context} failed -- ${key} is not a string`);
}

function booleanField(obj: Record<string, unknown>, key: string, context: string): boolean {
	const value = obj[key];
	if (typeof value === "boolean") {
		return value;
	}
	throw new Error(`${context} failed -- ${key} is not a boolean`);
}

function numberArray(value: unknown, context: string): number[] {
	if (Array.isArray(value) && value.every((entry) => Number.isInteger(entry))) {
		return value as number[];
	}
	throw new Error(`${context} failed -- expected an integer array`);
}

function stringArray(value: unknown, context: string): string[] {
	if (Array.isArray(value) && value.every((entry) => typeof entry === "string")) {
		return value as string[];
	}
	throw new Error(`${context} failed -- expected a string array`);
}

/**
 * Decode a JSON-RPC response into {@link ToolCallResult}.
 *
 * ERROR-WITH-200 is assumed, not excluded: a completed tool call can carry a
 * failed verb, which is exactly why `hasErrorPayload` exists on the mcp2cli path.
 * So the status code is one signal among three — transport status, a JSON-RPC
 * `error` object, and `result.isError` — and only after all three are clean is the
 * prose classifier given the text as a fallback.
 */
function decodeToolCall(name: string, status: number, raw: string): ToolCallResult {
	if (status < 200 || status >= 300) {
		// Bounded and redacted: the body is UNTRUSTED gateway/runner output, and a
		// 401 body must not become a channel for echoing a credential into a log.
		return failure(`${name} HTTP ${status} -- ${boundedPayload(raw)}`, true, "http");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw) as unknown;
	} catch {
		// Not JSON at all on a 2xx: the gateway is not speaking the protocol. Class
		// only, no body, because the body is untrusted and may carry a credential.
		log("warn", "runner.transport_http.response_not_json", { tool: name });
		return failure(`${name} returned a non-JSON body`, true, "json-rpc");
	}
	const envelope = (parsed ?? {}) as { error?: unknown; result?: unknown };
	const rpcError = describeRpcError(envelope.error);
	if (rpcError) {
		return failure(`${name} ${rpcError}`, true, "json-rpc");
	}
	const result = (envelope.result ?? {}) as { isError?: unknown; structuredContent?: unknown };
	const text = collectText(envelope.result);
	if (result.isError === true) {
		return failure(`${name} ${text || "reported isError with no text"}`, true, "tool");
	}
	// FALLBACK ONLY. Structure said nothing was wrong, so the prose classifier gets
	// a look — a gateway that has not yet declared an `outputSchema` for a verb can
	// still hand back the old in-band `{"ok":false}` envelope inside a text block.
	if (text && hasErrorPayload(text)) {
		return failure(`${name} ${text}`, false, "prose");
	}
	return {
		structured: result.structuredContent,
		text,
		failure: null,
		structuredFailure: false,
		failureSource: null,
	};
}

/** A `ToolCallResult` carrying only a failure. */
function failure(
	message: string,
	structured: boolean,
	failureSource: NonNullable<HttpRunResult["failureSource"]>,
): ToolCallResult {
	return {
		structured: undefined,
		text: "",
		failure: message,
		structuredFailure: structured,
		failureSource,
	};
}

/** Render a JSON-RPC `error` object as one bounded line, or `null` when absent. */
function describeRpcError(error: unknown): string | null {
	if (!error || typeof error !== "object") {
		return null;
	}
	const obj = error as { code?: unknown; message?: unknown; data?: unknown };
	const code = typeof obj.code === "number" ? obj.code : "unknown";
	const message = typeof obj.message === "string" ? obj.message : "";
	const data = obj.data === undefined ? "" : ` ${JSON.stringify(obj.data)}`;
	return `JSON-RPC error ${code}: ${boundedPayload(`${message}${data}`)}`;
}

/** Concatenate the `text` blocks of a `tools/call` result's content array. */
function collectText(result: unknown): string {
	if (!result || typeof result !== "object") {
		return "";
	}
	const content = (result as { content?: unknown }).content;
	if (!Array.isArray(content)) {
		return "";
	}
	return content
		.filter(
			(block): block is { type: string; text: string } =>
				!!block &&
				typeof block === "object" &&
				(block as { type?: unknown }).type === "text" &&
				typeof (block as { text?: unknown }).text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

/**
 * `ListedBox` rows from `structuredContent`, or `null` when the gateway declared
 * no output schema for `runner_list` and the caller must fall back to the text
 * table.
 *
 * The text path stays on `parseListedBoxes`, which reads the fixed-width `pct
 * list` columns FROM THE RIGHT because the `Lock` column is usually empty and
 * left-to-right splitting reads a running box's job id as its name.
 */
function listedFromStructured(structured: unknown): ListedBox[] | null {
	const rows = Array.isArray(structured)
		? structured
		: Array.isArray((structured as { boxes?: unknown } | null)?.boxes)
			? ((structured as { boxes: unknown[] }).boxes as unknown[])
			: null;
	if (!rows) {
		return null;
	}
	const out: ListedBox[] = [];
	for (const row of rows) {
		if (!row || typeof row !== "object") {
			continue;
		}
		const obj = row as Record<string, unknown>;
		const vmid = Number(obj.vmid);
		if (!Number.isInteger(vmid)) {
			continue;
		}
		out.push({
			vmid,
			status: typeof obj.status === "string" ? obj.status : "",
			name: typeof obj.name === "string" ? obj.name : "",
			jobId: typeof obj.job_id === "string" ? obj.job_id : null,
			spawnIso: typeof obj.spawn_iso === "string" ? obj.spawn_iso : null,
		});
	}
	return out;
}

/**
 * The selection seam moved to `./transport-select`: choosing an
 * implementation is a different concern from being one, and this module is at
 * the `lint:size` bound. Re-exported so every existing importer of this path
 * keeps working unchanged.
 */
export { createRunnerTransport, RUNNER_TRANSPORT_ENV } from "./transport-select";
