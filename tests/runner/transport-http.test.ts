import { afterEach, describe, expect, test } from "bun:test";
import {
	DEFAULT_RUN_READY_ATTEMPTS,
	DEFAULT_RUN_READY_DELAY_MS,
	Mcp2cliRunnerTransport,
	RUNNER_FORGE_UP_TIMEOUT_MS,
	RUNNER_STOP_TIMEOUT_MS,
	RunnerAllocationUnknownError,
	RunnerBandRefusedError,
} from "../../src/runner/transport";
import {
	createRunnerTransport,
	DEFAULT_DONE_TIMEOUT_MS,
	DEFAULT_HTTP_TIMEOUT_MS,
	HttpRunnerTransport,
	RunnerTransportConfigError,
} from "../../src/runner/transport-http";

/**
 * A bearer token used only by these tests. Never asserted BY VALUE into a wire
 * fixture: the mock proves the `Authorization` header is PRESENT and well-shaped,
 * and the leak test proves the value never reaches a log line. Asserting the value
 * into an expected-request fixture would be the leak the rule forbids.
 */
const TOKEN = "test-only-not-a-real-credential";

/**
 * The EXACT declared key sets. Stated as literals rather than derived from the
 * code under test: a fixture computed from the constant it pins measures itself.
 */
const DECLARED = {
	body: ["jsonrpc", "id", "method", "params"],
	params: ["name", "arguments", "_meta"],
	meta: [
		"io.modelcontextprotocol/protocolVersion",
		"io.modelcontextprotocol/clientInfo",
		"io.modelcontextprotocol/clientCapabilities",
	],
	metaWithTrace: [
		"io.modelcontextprotocol/protocolVersion",
		"io.modelcontextprotocol/clientInfo",
		"io.modelcontextprotocol/clientCapabilities",
		"traceparent",
	],
	runner_needed: ["size", "job_id", "count"],
	runner_status: ["allocation_id"],
	runner_cancel: ["allocation_id"],
	runner_run: [
		"vmid",
		"job_id",
		"job",
		"runtime",
		"max_turns",
		"model",
		"effort",
		"engine_base_url",
		"engine_auth_header_name",
	],
	runner_done: ["vmid", "job_id"],
	runner_forge_up: ["vmid"],
	runner_forge_down: ["vmid", "force"],
	runner_list: ["band"],
} as const;

/** The reviewed route every run() carries (L-042): the v2 server REQUIRES it. */
const ROUTE = {
	model: "gpt-5.6-sol",
	effort: "low",
	engineEndpoint: {
		baseUrl: "https://codex-proxy.example.internal",
		authHeaderName: "Authorization",
	},
} as const;

/** Declared arguments the v2 server permits callers to omit. */
const OPTIONAL = {
	runner_done: ["job_id"],
	runner_list: ["band"],
} as const;

interface Recorded {
	method: string;
	path: string;
	contentType: string | null;
	accept: string | null;
	mcpMethod: string | null;
	mcpName: string | null;
	mcpProtocolVersion: string | null;
	authorization: string | null;
	body: Record<string, unknown>;
}

interface MockOptions {
	/** JSON-RPC reply, or a function of the recorded request. */
	reply?: Record<string, unknown> | ((req: Recorded) => unknown);
	/** HTTP status for the reply. */
	status?: number;
	/** Delay the reply, or derive the delay from the recorded request. */
	delayMs?: number | ((req: Recorded) => number);
	/** Extra argument keys the mock will accept for this verb, beyond DECLARED. */
	expectTrace?: boolean;
}

const servers: Array<{ stop: (force?: boolean) => Promise<void> }> = [];

afterEach(async () => {
	while (servers.length > 0) {
		await servers.pop()?.stop(true);
	}
});

/**
 * A STRICT mock gateway. It asserts the wire shape the way the live v2 server
 * does — REJECTING a request that carries an undeclared key rather than accepting
 * and discarding it, which is precisely the silent-drop failure that produced a P0
 * on PR #175. A rejection surfaces as HTTP 400 with a `wire:` reason, so a test
 * that expects a successful round trip goes RED the moment this repo sends
 * something undeclared.
 *
 * Binds `port: 0` — Bun.serve allocates an ephemeral port and reports it on
 * `server.port`, so nothing in 7100-7199 is claimed and the reserved 7141 (the
 * aqmd librarian) cannot be shadowed.
 */
function startMock(options: MockOptions = {}): { url: string; requests: Recorded[] } {
	const requests: Recorded[] = [];
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const text = await req.text();
			let body: Record<string, unknown>;
			try {
				body = JSON.parse(text) as Record<string, unknown>;
			} catch {
				return new Response("wire: body is not JSON", { status: 400 });
			}
			const recorded: Recorded = {
				method: req.method,
				path: url.pathname,
				contentType: req.headers.get("content-type"),
				accept: req.headers.get("accept"),
				mcpMethod: req.headers.get("mcp-method"),
				mcpName: req.headers.get("mcp-name"),
				mcpProtocolVersion: req.headers.get("mcp-protocol-version"),
				authorization: req.headers.get("authorization"),
				body,
			};
			requests.push(recorded);
			const reason = wireViolation(recorded, options.expectTrace === true);
			if (reason) {
				return new Response(`wire: ${reason}`, { status: 400 });
			}
			const delayMs =
				typeof options.delayMs === "function" ? options.delayMs(recorded) : (options.delayMs ?? 0);
			if (delayMs > 0) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
			const reply =
				typeof options.reply === "function"
					? (options.reply as (r: Recorded) => unknown)(recorded)
					: (options.reply ?? { jsonrpc: "2.0", id: body.id, result: { content: [] } });
			return new Response(JSON.stringify(reply), {
				status: options.status ?? 200,
				headers: { "content-type": "application/json" },
			});
		},
	});
	servers.push(server);
	return { url: `http://127.0.0.1:${server.port}`, requests };
}

/** The mock's own verdict on one request, or `null` when it is well-formed. */
function wireViolation(req: Recorded, expectTrace: boolean): string | null {
	if (req.method !== "POST") {
		return `method ${req.method}`;
	}
	if (req.contentType !== "application/json" || req.accept !== "application/json") {
		return `content negotiation ${String(req.contentType)}/${String(req.accept)}`;
	}
	if (req.path !== "/mcp") {
		return `path ${req.path}`;
	}
	if (req.mcpProtocolVersion !== "2026-07-28") {
		return `Mcp-Protocol-Version ${String(req.mcpProtocolVersion)}`;
	}
	if (!req.authorization?.startsWith("Bearer ")) {
		return "missing bearer authorization";
	}
	const keys = Object.keys(req.body).sort();
	if (keys.join(",") !== [...DECLARED.body].sort().join(",")) {
		return `body keys ${keys.join(",")}`;
	}
	if (req.body.jsonrpc !== "2.0" || req.body.method !== "tools/call") {
		return `envelope ${String(req.body.jsonrpc)}/${String(req.body.method)}`;
	}
	// The spec REQUIRES the server to reject a request whose headers and body
	// disagree, so the mock does exactly that rather than trusting either side.
	if (req.mcpMethod !== req.body.method) {
		return `Mcp-Method ${String(req.mcpMethod)} != body method ${String(req.body.method)}`;
	}
	const params = (req.body.params ?? {}) as Record<string, unknown>;
	const paramKeys = Object.keys(params).sort();
	if (paramKeys.join(",") !== [...DECLARED.params].sort().join(",")) {
		return `params keys ${paramKeys.join(",")}`;
	}
	if (req.mcpName !== params.name) {
		return `Mcp-Name ${String(req.mcpName)} != body name ${String(params.name)}`;
	}
	return metaViolation(params, expectTrace) ?? argsViolation(params);
}

/** `_meta` must carry the stateless negotiation fields, and trace when configured. */
function metaViolation(params: Record<string, unknown>, expectTrace: boolean): string | null {
	const meta = (params._meta ?? {}) as Record<string, unknown>;
	const expected = expectTrace ? DECLARED.metaWithTrace : DECLARED.meta;
	const got = Object.keys(meta).sort();
	if (got.join(",") !== [...expected].sort().join(",")) {
		return `_meta keys ${got.join(",")}`;
	}
	if (meta["io.modelcontextprotocol/protocolVersion"] !== "2026-07-28") {
		return `_meta protocolVersion ${String(meta["io.modelcontextprotocol/protocolVersion"])}`;
	}
	if (
		JSON.stringify(meta["io.modelcontextprotocol/clientInfo"]) !==
		JSON.stringify({ name: "software-factory-watcher", version: "1" })
	) {
		return `_meta clientInfo ${JSON.stringify(meta["io.modelcontextprotocol/clientInfo"])}`;
	}
	if (JSON.stringify(meta["io.modelcontextprotocol/clientCapabilities"]) !== "{}") {
		return `_meta clientCapabilities ${JSON.stringify(meta["io.modelcontextprotocol/clientCapabilities"])}`;
	}
	if (expectTrace && typeof meta.traceparent !== "string") {
		return "_meta traceparent missing";
	}
	return null;
}

/** The verb argument object must carry EXACTLY the keys that verb declares. */
function argsViolation(params: Record<string, unknown>): string | null {
	const name = String(params.name);
	const declared = (DECLARED as Record<string, readonly string[] | undefined>)[name];
	if (!declared) {
		return `unknown tool ${name}`;
	}
	const args = (params.arguments ?? {}) as Record<string, unknown>;
	// The v2 server enforces `additionalProperties: false` and REJECTS extras with
	// `extra_forbidden` (live, job 5458, 2026-08-18), so the sent set is EXACT —
	// no superset allowance for any verb. Since rtech-infra#1051/#1063 (a fleet host,
	// 2026-08-25) `runner_run` DECLARES and REQUIRES `model`, `effort`,
	// `engine_base_url`, and `engine_auth_header_name`.
	for (const key of Object.keys(args)) {
		if (!declared.includes(key)) {
			return `undeclared argument ${key} on ${name}`;
		}
	}
	const optional = (OPTIONAL as Record<string, readonly string[] | undefined>)[name] ?? [];
	for (const key of declared) {
		if (!optional.includes(key) && !(key in args)) {
			return `missing argument ${key} on ${name}`;
		}
	}
	return null;
}

const textReply = (id: unknown, text: string) => ({
	jsonrpc: "2.0",
	id,
	result: { content: [{ type: "text", text }] },
});

const structuredReply = (id: unknown, structured: unknown) => ({
	jsonrpc: "2.0",
	id,
	result: { content: [], structuredContent: structured },
});

const RUN_NOT_FOUND = {
	ok: false,
	exit_code: 1,
	stderr: "ERROR: vmid 9001 not found on any reachable node",
} as const;

const DONE_REFUSED_MESSAGE =
	"REFUSED: vmid 9001 is owned by job 'rw-infra-static-OTHER', not 'rw-infra-static-OURS' — the slot has been recycled; reaping it would destroy another job's box (#909). Operator force: runner-boxes done --vmid 9001";

const failedRunReply = (id: unknown, failure: unknown) => ({
	jsonrpc: "2.0",
	id,
	result: {
		isError: true,
		content: [{ type: "text", text: JSON.stringify(failure) }],
		structuredContent: failure,
	},
});

const allocationHandle = (failure: Record<string, unknown> | null = null) => ({
	allocation_id: failure ? "" : "alloc-test",
	status: failure ? "failed" : "working",
	job_id: "job-abc",
	poll_interval_ms: 1_000,
	failure,
});

const allocationState = (
	status: "working" | "completed" | "failed",
	vmids: number[] = [],
	failure: Record<string, unknown> | null = null,
) => ({
	allocation_id: "alloc-test",
	status,
	job_id: "job-abc",
	vmids,
	reaped_vmids: [],
	reap_failures: [],
	poll_interval_ms: 1_000,
	result: status === "working" ? null : { ok: status === "completed", failure },
});

const typedFailure = (kind: string, message: string, outcomeUnknown: boolean) => ({
	kind,
	message,
	retryable: kind === "refusal",
	outcome_unknown: outcomeUnknown,
});

const cancelOutcome = (reapFailures: string[] = []) => ({
	allocation_id: "alloc-test",
	status: reapFailures.length === 0 ? "cancelled" : "failed",
	reaped_vmids: reapFailures.length === 0 ? [9021] : [],
	already_final: false,
	reap_failures: reapFailures,
});

/**
 * The `arguments` object of the nth recorded request, THROWING when that request
 * was never made.
 *
 * Deliberately not an optional chain defaulting to `{}`: a missing request would
 * then read as "a verb that sent no arguments", which is a legitimate expected
 * value for `runner_list`. So the absence would pass the very clause meant to pin
 * the key set.
 */
function recordedArgs(requests: Recorded[], index: number): Record<string, unknown> {
	const request = requests[index];
	if (!request) {
		throw new Error(`no request recorded at index ${index} (recorded ${requests.length})`);
	}
	const params = request.body.params as { arguments?: unknown } | undefined;
	if (!params || typeof params !== "object") {
		throw new Error(`request ${index} carried no params object`);
	}
	return (params.arguments ?? {}) as Record<string, unknown>;
}

/** The `_meta` object of the nth recorded request, throwing when it is absent. */
function recordedMeta(requests: Recorded[], index: number): Record<string, unknown> {
	const request = requests[index];
	if (!request) {
		throw new Error(`no request recorded at index ${index} (recorded ${requests.length})`);
	}
	const params = request.body.params as { _meta?: unknown } | undefined;
	const meta = params?._meta;
	if (!meta || typeof meta !== "object") {
		throw new Error(`request ${index} carried no _meta object`);
	}
	return meta as Record<string, unknown>;
}

/**
 * A real `runner_list` capture shape: `[host] ` prefix, repeated header, and a
 * BLANK fixed-width Lock column on the running box, which is why the parser reads
 * columns from the right.
 */
const LIST_TABLE = [
	"[node05] VMID       Status     Lock         Name                 JOB_ID     SPAWN_ISO",
	"[node05] 9921       running                 CT119               job-abc    2026-08-17T01:02:03Z",
	"[node05] 9922       stopped                 CT120               -          -",
].join("\n");

describe("HttpRunnerTransport wire shape", () => {
	test("posts tools/call to /mcp with matching Mcp-Method and Mcp-Name headers", async () => {
		const mock = startMock({
			reply: (r) => {
				const name = String((r.body.params as { name?: unknown }).name);
				if (name === "runner_needed") {
					return structuredReply(r.body.id, allocationHandle());
				}
				return structuredReply(r.body.id, allocationState("completed", [9021]));
			},
		});
		const transport = new HttpRunnerTransport(mock.url, TOKEN, { sleep: async () => {} });
		const out = await transport.needed("small", "job-abc", 1);

		expect(out.ok).toBe(true);
		expect(mock.requests).toHaveLength(2);
		const req = mock.requests[0];
		expect(req?.method).toBe("POST");
		expect(req?.path).toBe("/mcp");
		expect({
			"content-type": req?.contentType,
			accept: req?.accept,
			"mcp-method": req?.mcpMethod,
			"mcp-name": req?.mcpName,
			"mcp-protocol-version": req?.mcpProtocolVersion,
		}).toEqual({
			"content-type": "application/json",
			accept: "application/json",
			"mcp-method": "tools/call",
			"mcp-name": "runner_needed",
			"mcp-protocol-version": "2026-07-28",
		});
		const meta = (req?.body.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
		expect(meta?.["io.modelcontextprotocol/protocolVersion"]).toBe(req?.mcpProtocolVersion);
		// PRESENCE and shape only -- never the token value in a wire fixture.
		expect(req?.authorization?.startsWith("Bearer ")).toBe(true);
		expect(Object.keys(req?.body ?? {}).sort()).toEqual([...DECLARED.body].sort());
	});

	test("normalizes base URLs with and without /mcp to one endpoint", async () => {
		const endpoints: string[] = [];
		const doFetch = (async (input: string | URL | Request) => {
			endpoints.push(String(input));
			return new Response(JSON.stringify(textReply(1, LIST_TABLE)), { status: 200 });
		}) as unknown as typeof fetch;
		await new HttpRunnerTransport("http://gateway.test:7180", TOKEN, { fetch: doFetch }).list();
		await new HttpRunnerTransport("http://gateway.test:7180/mcp/", TOKEN, {
			fetch: doFetch,
		}).list();

		expect(endpoints).toEqual(["http://gateway.test:7180/mcp", "http://gateway.test:7180/mcp"]);
	});

	test("sends the exact declared key set, with optional done job_id only when scoped", async () => {
		const mock = startMock({ reply: (r) => textReply(r.body.id, LIST_TABLE) });
		const transport = new HttpRunnerTransport(mock.url, TOKEN);
		await transport.list();
		await transport.done(9921);
		await transport.done(9921, "rw-infra-static-OURS");

		expect(recordedArgs(mock.requests, 0)).toEqual({});
		expect(recordedArgs(mock.requests, 1)).toEqual({ vmid: 9921 });
		expect(recordedArgs(mock.requests, 2)).toEqual({
			vmid: 9921,
			job_id: "rw-infra-static-OURS",
		});
	});

	test("returns an ownership refusal as data", async () => {
		const mock = startMock({
			reply: (r) => failedRunReply(r.body.id, DONE_REFUSED_MESSAGE),
		});
		const outcome = await new HttpRunnerTransport(mock.url, TOKEN).done(
			9001,
			"rw-infra-static-OURS",
		);
		expect(outcome).toEqual({ refused: true, ownerJobId: "rw-infra-static-OTHER" });
		expect(mock.requests).toHaveLength(1);
	});

	test("run forwards the routing keys the v2 server requires: model/effort/engine", async () => {
		const mock = startMock({ reply: (r) => textReply(r.body.id, "started") });
		const transport = new HttpRunnerTransport(mock.url, TOKEN);
		await transport.run({
			vmid: 9001,
			jobId: "rw-test-run-1",
			job: "# job.md",
			runtime: "codex",
			maxTurns: 30,
			model: "gpt-5.6-sol",
			effort: "low",
			engineEndpoint: {
				baseUrl: "https://codex-proxy.example.internal",
				authHeaderName: "Authorization",
			},
		});
		const runArgs = recordedArgs(mock.requests, 0);
		expect(Object.keys(runArgs).sort()).toEqual([...DECLARED.runner_run].sort());
		expect(runArgs).toEqual({
			vmid: 9001,
			job_id: "rw-test-run-1",
			job: "# job.md",
			runtime: "codex",
			max_turns: 30,
			model: "gpt-5.6-sol",
			effort: "low",
			engine_base_url: "https://codex-proxy.example.internal",
			engine_auth_header_name: "Authorization",
		});
	});

	test("_meta carries the exact namespaced stateless envelope on every request", async () => {
		const bodies: Record<string, unknown>[] = [];
		const doFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
			bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
			return new Response(JSON.stringify(textReply(1, LIST_TABLE)), { status: 200 });
		}) as unknown as typeof fetch;
		const transport = new HttpRunnerTransport("http://gateway.test:7180", TOKEN, {
			fetch: doFetch,
		});
		await transport.list();
		await transport.list();

		expect(bodies).toHaveLength(2);
		for (const body of bodies) {
			const meta = (body.params as { _meta: Record<string, unknown> })._meta;
			expect(meta).toEqual({
				"io.modelcontextprotocol/protocolVersion": "2026-07-28",
				"io.modelcontextprotocol/clientInfo": {
					name: "software-factory-watcher",
					version: "1",
				},
				"io.modelcontextprotocol/clientCapabilities": {},
			});
			// STATELESS: no session id anywhere, and no initialize call was made.
			expect(Object.keys(meta)).not.toContain("sessionId");
		}
	});

	test("_meta carries the W3C traceparent under its locked-down key when supplied", async () => {
		const traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01";
		const mock = startMock({
			expectTrace: true,
			reply: (r) => textReply(r.body.id, LIST_TABLE),
		});
		const transport = new HttpRunnerTransport(mock.url, TOKEN, { traceparent });
		await transport.list();

		const meta = recordedMeta(mock.requests, 0);
		expect(meta.traceparent).toBe(traceparent);
	});

	test("setTraceparent threads a correlator without widening RunnerTransport", async () => {
		const mock = startMock({ expectTrace: true, reply: (r) => textReply(r.body.id, LIST_TABLE) });
		const transport = new HttpRunnerTransport(mock.url, TOKEN);
		transport.setTraceparent("00-11111111111111111111111111111111-2222222222222222-01");
		await transport.list();

		const meta = recordedMeta(mock.requests, 0);
		expect(meta.traceparent).toBe("00-11111111111111111111111111111111-2222222222222222-01");
	});

	test("the mock REJECTS an undeclared body key, so a widened wire goes red", async () => {
		// Drives the mock's own guard directly: this is the negative control proving
		// the strictness the other tests depend on is real and not vacuous.
		const mock = startMock();
		const response = await fetch(`${mock.url}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": "tools/call",
				"mcp-name": "runner_list",
				authorization: `Bearer ${TOKEN}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: { name: "runner_list", arguments: {}, _meta: {} },
				sessionId: "undeclared",
			}),
		});
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("body keys");
	});

	test("the mock REJECTS an undeclared verb argument", async () => {
		const mock = startMock();
		const response = await fetch(`${mock.url}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": "tools/call",
				"mcp-name": "runner_list",
				authorization: `Bearer ${TOKEN}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "runner_list",
					arguments: { size: "small" },
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientInfo": {
							name: "software-factory-watcher",
							version: "1",
						},
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		});
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("undeclared argument size");
	});

	test("the mock REJECTS a Mcp-Method header that disagrees with the body", async () => {
		const mock = startMock();
		const response = await fetch(`${mock.url}/mcp`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				accept: "application/json",
				"mcp-protocol-version": "2026-07-28",
				"mcp-method": "tools/list",
				"mcp-name": "runner_list",
				authorization: `Bearer ${TOKEN}`,
			},
			body: JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "tools/call",
				params: {
					name: "runner_list",
					arguments: {},
					_meta: {
						"io.modelcontextprotocol/protocolVersion": "2026-07-28",
						"io.modelcontextprotocol/clientInfo": {
							name: "software-factory-watcher",
							version: "1",
						},
						"io.modelcontextprotocol/clientCapabilities": {},
					},
				},
			}),
		});
		expect(response.status).toBe(400);
		expect(await response.text()).toContain("Mcp-Method");
	});
});

describe("HttpRunnerTransport verb round-trips", () => {
	test("needed polls its handle through working to completed and keeps the inventory guard", async () => {
		let polls = 0;
		const mock = startMock({
			reply: (r) => {
				const name = String((r.body.params as { name?: unknown }).name);
				if (name === "runner_needed") return structuredReply(r.body.id, allocationHandle());
				polls += 1;
				return structuredReply(
					r.body.id,
					polls === 1 ? allocationState("working") : allocationState("completed", [9021, 9900]),
				);
			},
		});
		const out = await new HttpRunnerTransport(mock.url, TOKEN, {
			neededPollIntervalMs: 0,
			sleep: async () => {},
		}).needed("small", "job-abc", 1);
		expect(out).toEqual({ ok: true, boxes: [{ vmid: 9021, size: "small" }] });
		expect(mock.requests.map((r) => r.mcpName)).toEqual([
			"runner_needed",
			"runner_status",
			"runner_status",
		]);
	});

	test("needed keeps typed capacity refusals and includes the server message", async () => {
		const refusal = typedFailure("refusal", "in-flight allocation ceiling reached", false);
		let calls = 0;
		const doFetch = (async () => {
			calls += 1;
			return new Response(JSON.stringify(structuredReply(1, allocationHandle(refusal))), {
				status: 200,
			});
		}) as unknown as typeof fetch;
		const out = await new HttpRunnerTransport("http://gateway.test:7180", TOKEN, {
			fetch: doFetch,
		}).needed("small", "job-abc", 1);
		expect(out).toEqual({
			ok: false,
			refused: true,
			reason: "runner capacity unavailable -- in-flight allocation ceiling reached",
			placed: [],
		});
		expect(calls).toBe(1);
	});

	test("needed retries a transient status error within the allocation budget", async () => {
		let statusCalls = 0;
		const mock = startMock({
			reply: (r) => {
				const name = String((r.body.params as { name?: unknown }).name);
				if (name === "runner_needed") return structuredReply(r.body.id, allocationHandle());
				statusCalls += 1;
				if (statusCalls === 1) {
					return { jsonrpc: "2.0", id: r.body.id, error: { code: -32_000, message: "busy" } };
				}
				return structuredReply(r.body.id, allocationState("completed", [9022]));
			},
		});
		const out = await new HttpRunnerTransport(mock.url, TOKEN, {
			neededPollIntervalMs: 0,
			sleep: async () => {},
		}).needed("medium", "job-abc", 1);
		expect(out).toEqual({ ok: true, boxes: [{ vmid: 9022, size: "medium" }] });
		expect(statusCalls).toBe(2);
	});

	test("needed surfaces a terminal typed failure with bounded detail", async () => {
		const failure = typedFailure("contract_rejection", `bad request ${"x".repeat(2_000)}`, false);
		const mock = startMock({
			reply: (r) => {
				const name = String((r.body.params as { name?: unknown }).name);
				return structuredReply(
					r.body.id,
					name === "runner_needed" ? allocationHandle() : allocationState("failed", [], failure),
				);
			},
		});
		const error = await new HttpRunnerTransport(mock.url, TOKEN).needed("small", "job-abc", 1).then(
			() => undefined,
			(err: unknown) => err as Error,
		);
		expect(error?.message).toContain("contract_rejection");
		expect(error?.message).toContain("bad request");
		expect(error?.message.length).toBeLessThan(700);
	});

	test("needed cancels once at budget exhaustion and reports a confirmed reap as plain failure", async () => {
		let now = 0;
		const mock = startMock({
			reply: (r) => {
				const name = String((r.body.params as { name?: unknown }).name);
				if (name === "runner_needed") return structuredReply(r.body.id, allocationHandle());
				if (name === "runner_status") return structuredReply(r.body.id, allocationState("working"));
				return structuredReply(r.body.id, cancelOutcome());
			},
		});
		const transport = new HttpRunnerTransport(mock.url, TOKEN, {
			neededTimeoutMs: 10,
			neededPollIntervalMs: 10,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});
		const error = await transport.needed("small", "job-abc", 1).then(
			() => undefined,
			(err: unknown) => err as Error,
		);
		expect(error).not.toBeInstanceOf(RunnerAllocationUnknownError);
		expect(error?.message).toContain("confirmed");
		expect(mock.requests.filter((r) => r.mcpName === "runner_cancel")).toHaveLength(1);
	});

	test("needed turns a cancel failure into RunnerAllocationUnknownError", async () => {
		let now = 0;
		const mock = startMock({
			reply: (r) => {
				const name = String((r.body.params as { name?: unknown }).name);
				if (name === "runner_needed") return structuredReply(r.body.id, allocationHandle());
				if (name === "runner_status") return structuredReply(r.body.id, allocationState("working"));
				return {
					jsonrpc: "2.0",
					id: r.body.id,
					error: { code: -32_000, message: "cancel unavailable" },
				};
			},
		});
		const transport = new HttpRunnerTransport(mock.url, TOKEN, {
			neededTimeoutMs: 10,
			neededPollIntervalMs: 10,
			now: () => now,
			sleep: async (ms) => {
				now += ms;
			},
		});
		await expect(transport.needed("small", "job-abc", 1)).rejects.toBeInstanceOf(
			RunnerAllocationUnknownError,
		);
		expect(mock.requests.filter((r) => r.mcpName === "runner_cancel")).toHaveLength(1);
	});

	test("needed turns an unknown-handle infra fault into RunnerAllocationUnknownError", async () => {
		const unknown = typedFailure(
			"infra_fault",
			"unknown handle; reconcile with runner_list, match your own job id, then runner_done",
			true,
		);
		const mock = startMock({
			reply: (r) => {
				const name = String((r.body.params as { name?: unknown }).name);
				return structuredReply(
					r.body.id,
					name === "runner_needed" ? allocationHandle() : allocationState("failed", [], unknown),
				);
			},
		});
		const error = await new HttpRunnerTransport(mock.url, TOKEN).needed("small", "job-abc", 1).then(
			() => undefined,
			(err: unknown) => err as Error,
		);
		expect(error).toBeInstanceOf(RunnerAllocationUnknownError);
		expect(error?.message).toContain("runner_list");
		expect(error?.message).toContain("runner_done");
	});

	test("list parses structuredContent rows", async () => {
		const mock = startMock({
			reply: (r) =>
				structuredReply(r.body.id, [
					{
						vmid: 9921,
						status: "running",
						name: "CT119",
						job_id: "job-abc",
						spawn_iso: "2026-08-17T01:02:03Z",
					},
				]),
		});
		const out = await new HttpRunnerTransport(mock.url, TOKEN).list();
		expect(out).toEqual([
			{
				vmid: 9921,
				status: "running",
				name: "CT119",
				jobId: "job-abc",
				spawnIso: "2026-08-17T01:02:03Z",
			},
		]);
	});

	test("list falls back to the text table through parseListedBoxes", async () => {
		const mock = startMock({ reply: (r) => textReply(r.body.id, LIST_TABLE) });
		const out = await new HttpRunnerTransport(mock.url, TOKEN).list();
		// The running box has a BLANK Lock column; right-anchored parsing must still
		// read a fleet host as the name rather than the job id.
		expect(out).toEqual([
			{
				vmid: 9921,
				status: "running",
				name: "CT119",
				jobId: "job-abc",
				spawnIso: "2026-08-17T01:02:03Z",
			},
			{ vmid: 9922, status: "stopped", name: "CT120", jobId: null, spawnIso: null },
		]);
	});

	test("run sends the mcp2cli param shape with its defaults and resolves on success", async () => {
		const mock = startMock();
		await new HttpRunnerTransport(mock.url, TOKEN).run({
			vmid: 9921,
			jobId: "job-abc",
			job: "body",
			...ROUTE,
		});
		const args = recordedArgs(mock.requests, 0);
		expect(args).toEqual({
			vmid: 9921,
			job_id: "job-abc",
			job: "body",
			runtime: "claude",
			max_turns: 30,
			model: "gpt-5.6-sol",
			effort: "low",
			engine_base_url: "https://codex-proxy.example.internal",
			engine_auth_header_name: "Authorization",
		});
	});

	test("done resolves on a clean reply", async () => {
		const mock = startMock();
		await new HttpRunnerTransport(mock.url, TOKEN).done(9921);
		expect(mock.requests[0]?.mcpName).toBe("runner_done");
	});

	test("pins the done timeout above the gateway reap budget", () => {
		// Bounded terms: `flock -w 120` (:292) + a 10s connect ceiling per host
		// probed by `owning_host` (:211, :942-946; two hosts). The destroy inside
		// `guarded_hard_reap` (:1024, called by `done` at :1144) has no cap, so the
		// 180s budget is 140s bounded plus a chosen 40s destroy window.
		expect(DEFAULT_HTTP_TIMEOUT_MS).toBe(90_000);
		expect(DEFAULT_DONE_TIMEOUT_MS).toBe(180_000);
		expect(DEFAULT_DONE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_HTTP_TIMEOUT_MS);
		expect(DEFAULT_DONE_TIMEOUT_MS).toBeGreaterThanOrEqual(120_000 + 2 * 10_000 + 40_000);
	});

	test("done uses its default budget while needed, run, and list use timeoutMs", async () => {
		const budgets: number[] = [];
		const originalTimeout = AbortSignal.timeout;
		AbortSignal.timeout = ((ms: number) => {
			budgets.push(ms);
			return new AbortController().signal;
		}) as typeof AbortSignal.timeout;
		try {
			const mock = startMock({
				reply: (r) => {
					const name = String((r.body.params as { name?: unknown }).name);
					if (name === "runner_needed") return structuredReply(r.body.id, allocationHandle());
					if (name === "runner_status") {
						return structuredReply(r.body.id, allocationState("completed", [9921]));
					}
					if (name === "runner_list") return textReply(r.body.id, LIST_TABLE);
					return textReply(r.body.id, "started");
				},
			});
			const transport = new HttpRunnerTransport(mock.url, TOKEN, {
				timeoutMs: 17,
				neededPollIntervalMs: 0,
				sleep: async () => {},
			});

			await transport.needed("small", "job-abc", 1);
			await transport.run({ vmid: 9921, jobId: "job-abc", job: "body", ...ROUTE });
			await transport.list();
			await transport.done(9921);

			expect(budgets).toEqual([17, 17, 17, 17, DEFAULT_DONE_TIMEOUT_MS]);
		} finally {
			AbortSignal.timeout = originalTimeout;
		}
	});

	test("done resolves when its reply arrives after timeoutMs but before doneTimeoutMs", async () => {
		const timeoutMs = 10;
		const doneTimeoutMs = 100;
		const replyDelayMs = 30;
		const mock = startMock({ delayMs: replyDelayMs });

		expect(replyDelayMs).toBeGreaterThan(timeoutMs);
		await expect(
			new HttpRunnerTransport(mock.url, TOKEN, { timeoutMs, doneTimeoutMs }).done(9921),
		).resolves.toBeUndefined();
		expect(mock.requests).toHaveLength(1);
	});
});

describe("HttpRunnerTransport run boot-race retry", () => {
	test("retries the observed not-found answer, then succeeds", async () => {
		let runCalls = 0;
		const sleeps: number[] = [];
		const mock = startMock({
			reply: (request) => {
				runCalls += 1;
				return runCalls <= 2
					? failedRunReply(request.body.id, RUN_NOT_FOUND)
					: textReply(request.body.id, "started");
			},
		});
		const transport = new HttpRunnerTransport(mock.url, TOKEN, {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});

		await transport.run({ vmid: 9001, jobId: "job-abc", job: "body", ...ROUTE });

		expect(runCalls).toBe(3);
		expect(sleeps).toEqual([DEFAULT_RUN_READY_DELAY_MS, DEFAULT_RUN_READY_DELAY_MS]);
	});

	test("an agent run WITHOUT engineEndpoint is refused BEFORE any request", async () => {
		// The guard fires before the first `call`, so the mock records nothing: a box
		// is already allocated and held when `run` is reached.
		const mock = startMock();
		await expect(
			new HttpRunnerTransport(mock.url, TOKEN).run({
				vmid: 9001,
				jobId: "rw-pr-review-1",
				job: "body",
				model: "gpt-5.6-luna",
				effort: "max",
			}),
		).rejects.toThrow(/missing: engineEndpoint/);
		expect(mock.requests).toHaveLength(0);
	});

	test("names the attempt budget and final not-found answer on exhaustion", async () => {
		const sleeps: number[] = [];
		const mock = startMock({
			reply: (request) => failedRunReply(request.body.id, RUN_NOT_FOUND),
		});
		const transport = new HttpRunnerTransport(mock.url, TOKEN, {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});

		await expect(
			transport.run({ vmid: 9001, jobId: "job-abc", job: "body", ...ROUTE }),
		).rejects.toThrow(
			new RegExp(
				`runner_run failed after ${DEFAULT_RUN_READY_ATTEMPTS} attempts.*not found on any reachable node`,
			),
		);
		expect(mock.requests).toHaveLength(DEFAULT_RUN_READY_ATTEMPTS);
		expect(sleeps).toHaveLength(DEFAULT_RUN_READY_ATTEMPTS - 1);
		expect(sleeps.every((ms) => ms === DEFAULT_RUN_READY_DELAY_MS)).toBe(true);
	});

	test("keeps a contract rejection terminal in one call with no sleep", async () => {
		const sleeps: number[] = [];
		const rejection = {
			ok: false,
			exit_code: 2,
			stderr: "ERROR: runtime must be claude|codex",
		};
		const mock = startMock({
			reply: (request) => failedRunReply(request.body.id, rejection),
		});
		const transport = new HttpRunnerTransport(mock.url, TOKEN, {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});

		await expect(
			transport.run({ vmid: 9001, jobId: "job-abc", job: "body", ...ROUTE }),
		).rejects.toThrow(/runtime must be claude\|codex/);
		expect(mock.requests).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});

	test("keeps any other structured failure terminal in one call", async () => {
		const sleeps: number[] = [];
		const failure = { ok: false, exit_code: 1, stderr: "ERROR: placement failed" };
		const mock = startMock({
			reply: (request) => failedRunReply(request.body.id, failure),
		});
		const transport = new HttpRunnerTransport(mock.url, TOKEN, {
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});

		await expect(
			transport.run({ vmid: 9001, jobId: "job-abc", job: "body", ...ROUTE }),
		).rejects.toThrow(/placement failed/);
		expect(mock.requests).toHaveLength(1);
		expect(sleeps).toEqual([]);
	});
});

describe("HttpRunnerTransport structured errors", () => {
	test("a JSON-RPC error makes run terminal in ONE attempt, with no retry loop", async () => {
		const mock = startMock({
			reply: (r) => ({
				jsonrpc: "2.0",
				id: r.body.id,
				error: { code: -32602, message: "runtime must be claude|codex" },
			}),
		});
		const started = Date.now();
		await expect(
			new HttpRunnerTransport(mock.url, TOKEN).run({
				vmid: 9921,
				jobId: "job-abc",
				job: "body",
				...ROUTE,
			}),
		).rejects.toThrow(/JSON-RPC error -32602/);
		// ONE request, not the 10-attempt boot window. The count is the assertion; the
		// elapsed bound is a second, weaker guard against a hidden sleep.
		expect(mock.requests).toHaveLength(1);
		expect(Date.now() - started).toBeLessThan(5_000);
	});

	test("result.isError is a structured failure even on HTTP 200", async () => {
		const mock = startMock({
			reply: (r) => ({
				jsonrpc: "2.0",
				id: r.body.id,
				result: { isError: true, content: [{ type: "text", text: "placement failed" }] },
			}),
		});
		await expect(new HttpRunnerTransport(mock.url, TOKEN).done(9921)).rejects.toThrow(
			/placement failed/,
		);
	});

	test("an in-band {ok:false} text envelope still fails, via the classifier FALLBACK", async () => {
		const mock = startMock({
			reply: (r) => textReply(r.body.id, JSON.stringify({ success: true, result: { ok: false } })),
		});
		await expect(new HttpRunnerTransport(mock.url, TOKEN).list()).rejects.toThrow(
			/runner_list failed/,
		);
	});

	test("the live HTTP 400 envelope throws instead of becoming a capacity refusal", async () => {
		const body =
			'{"jsonrpc":"2.0","id":1,"error":{"code":-32020,"message":"mcp-protocol-version must be one of [2026-07-28] for tools/call; the legacy path performs no routing-header validation and is refused here"}}';
		let calls = 0;
		const doFetch = (async () => {
			calls += 1;
			return new Response(body, { status: 400 });
		}) as unknown as typeof fetch;
		const transport = new HttpRunnerTransport("http://gateway.test:7180", TOKEN, {
			fetch: doFetch,
		});

		await expect(transport.needed("small", "job-abc", 1)).rejects.toThrow(
			/runner_needed HTTP 400.*mcp-protocol-version.*refused here/,
		);
		expect(calls).toBe(1);
	});

	test("a non-2xx status fails without a retry loop", async () => {
		const mock = startMock({ status: 503, reply: { error: "unavailable" } });
		await expect(new HttpRunnerTransport(mock.url, TOKEN).list()).rejects.toThrow(/HTTP 503/);
		expect(mock.requests).toHaveLength(1);
	});
});

describe("transport selection seam", () => {
	test("unset RUNNER_TRANSPORT yields today's mcp2cli transport", () => {
		expect(createRunnerTransport({})).toBeInstanceOf(Mcp2cliRunnerTransport);
	});

	test("RUNNER_TRANSPORT=mcp2cli and a typo both keep the mcp2cli transport", () => {
		expect(createRunnerTransport({ RUNNER_TRANSPORT: "mcp2cli" })).toBeInstanceOf(
			Mcp2cliRunnerTransport,
		);
		expect(createRunnerTransport({ RUNNER_TRANSPORT: "htpp" })).toBeInstanceOf(
			Mcp2cliRunnerTransport,
		);
	});

	test("RUNNER_TRANSPORT=http with both variables yields the HTTP transport", () => {
		const transport = createRunnerTransport({
			RUNNER_TRANSPORT: "http",
			RUNNER_BOXES_HTTP_URL: "http://127.0.0.1:1",
			RUNNER_BOXES_HTTP_TOKEN: TOKEN,
		});
		expect(transport).toBeInstanceOf(HttpRunnerTransport);
		expect(transport).not.toBeInstanceOf(Mcp2cliRunnerTransport);
	});

	test("http with a MISSING TOKEN fails closed and never falls back to mcp2cli", () => {
		let caught: unknown;
		try {
			createRunnerTransport({
				RUNNER_TRANSPORT: "http",
				RUNNER_BOXES_HTTP_URL: "http://127.0.0.1:1",
			});
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(RunnerTransportConfigError);
		expect((caught as Error).message).toContain("RUNNER_BOXES_HTTP_TOKEN");
		// A silent fallback would have RETURNED a transport instead of throwing; this
		// is the clause that distinguishes the two.
		expect(caught).not.toBeInstanceOf(Mcp2cliRunnerTransport);
	});

	test("http with a MISSING URL fails closed", () => {
		expect(() =>
			createRunnerTransport({ RUNNER_TRANSPORT: "http", RUNNER_BOXES_HTTP_TOKEN: TOKEN }),
		).toThrow(RunnerTransportConfigError);
	});

	test("a blank token is treated as missing, not as a token", () => {
		expect(() =>
			createRunnerTransport({
				RUNNER_TRANSPORT: "http",
				RUNNER_BOXES_HTTP_URL: "http://127.0.0.1:1",
				RUNNER_BOXES_HTTP_TOKEN: "   ",
			}),
		).toThrow(RunnerTransportConfigError);
	});

	test("the constructor itself refuses an empty token", () => {
		expect(() => new HttpRunnerTransport("http://127.0.0.1:1", "")).toThrow(
			RunnerTransportConfigError,
		);
	});
});

describe("no secret leakage", () => {
	test("the token never appears in any log line captured during a failing 401", async () => {
		const mock = startMock({
			status: 401,
			reply: { error: `unauthorized token ${TOKEN}` },
		});
		const captured: string[] = [];
		const originalWrite = process.stderr.write.bind(process.stderr);
		const originalLog = console.error;
		// Capture BOTH channels: this repo's `log()` writes structured JSON to stderr,
		// and anything falling back to console.error would otherwise escape the scan.
		(process.stderr as unknown as { write: (chunk: string) => boolean }).write = (chunk) => {
			captured.push(String(chunk));
			return true;
		};
		console.error = (...args: unknown[]) => {
			captured.push(args.map(String).join(" "));
		};
		let message = "";
		try {
			await new HttpRunnerTransport(mock.url, TOKEN).list();
		} catch (err) {
			message = (err as Error).message;
		} finally {
			(process.stderr as unknown as { write: typeof originalWrite }).write = originalWrite;
			console.error = originalLog;
		}

		expect(message).toContain("HTTP 401");
		// The gateway ECHOED the token in its 401 body, which is the realistic hostile
		// case: untrusted output must be redacted before it reaches a log or a result.
		for (const line of captured) {
			expect(line).not.toContain(TOKEN);
		}
		expect(message).not.toContain(TOKEN);
	});

	test("a construction failure message names the variable, never a value", () => {
		try {
			createRunnerTransport({
				RUNNER_TRANSPORT: "http",
				RUNNER_BOXES_HTTP_URL: "http://127.0.0.1:1",
			});
		} catch (err) {
			expect((err as Error).message).not.toContain(TOKEN);
		}
	});
});

describe("HttpRunnerTransport forge band verbs", () => {
	const BAND_REFUSED = "refused: vmid 9001 is outside the forge band 9101-9150";

	test("start/stop/listBand send the declared tool and arguments", async () => {
		const mock = startMock({ reply: (r) => textReply(r.body.id, "") });
		const t = new HttpRunnerTransport(mock.url, TOKEN);
		await t.startBandMember(9101);
		await t.stopBandMember(9102);
		expect(await t.listBand("forge")).toEqual([]);
		const names = mock.requests.map((r) => (r.body.params as { name: string }).name);
		expect(names).toEqual(["runner_forge_up", "runner_forge_down", "runner_list"]);
		expect(recordedArgs(mock.requests, 0)).toEqual({ vmid: 9101 });
		expect(recordedArgs(mock.requests, 1)).toEqual({ vmid: 9102, force: false });
		expect(recordedArgs(mock.requests, 2)).toEqual({ band: "forge" });
	});

	test("a refused answer throws RunnerBandRefusedError on every band verb", async () => {
		for (const isError of [true, false]) {
			const mock = startMock({
				reply: (r) => ({
					jsonrpc: "2.0",
					id: r.body.id,
					result: { isError, content: [{ type: "text", text: BAND_REFUSED }] },
				}),
			});
			const t = new HttpRunnerTransport(mock.url, TOKEN);
			await expect(t.startBandMember(9001)).rejects.toBeInstanceOf(RunnerBandRefusedError);
			await expect(t.stopBandMember(9001)).rejects.toBeInstanceOf(RunnerBandRefusedError);
			await expect(t.listBand("forge")).rejects.toBeInstanceOf(RunnerBandRefusedError);
		}
	});
});

/**
 * sf#1080 R1: the gateway's `runner_list {band}` answer is its declared `VerbResult`
 * (`{ok, exit_code, stdout, stderr, cmd, failure}`, runner-boxes-mcp `results.py`),
 * carried as `structuredContent` and serialised into the text block. The forge
 * table sits in `stdout` in the exact `cmd_list` shape: `[host] ` prefix, header
 * repeated per host, blank Lock column, `-` for an unstamped box.
 */
const FORGE_TABLE = [
	"[node05] VMID       Status     Lock         Name                 JOB_ID                                       SPAWN_ISO",
	"[node05] 9101       running                 CT103               -                                            -",
	"[node06] VMID       Status     Lock         Name                 JOB_ID                                       SPAWN_ISO",
	"[node06] 9102       stopped                 CT121               -                                            -",
	"",
].join("\n");

const verbResult = (ok: boolean, stdout: string, stderr = "", failure: unknown = null) => ({
	ok,
	exit_code: ok ? 0 : 1,
	stdout,
	stderr,
	cmd: "/opt/dev/rtech-infra/scripts/runner-boxes list --band forge",
	failure,
});

const verbResultReply = (id: unknown, vr: unknown, withText = true) => ({
	jsonrpc: "2.0",
	id,
	result: {
		content: withText ? [{ type: "text", text: JSON.stringify(vr) }] : [],
		structuredContent: vr,
	},
});

describe("HttpRunnerTransport forge band VerbResult replies", () => {
	const FORGE_BOXES = [
		{ vmid: 9101, status: "running", name: "CT103", jobId: null, spawnIso: null },
		{ vmid: 9102, status: "stopped", name: "CT121", jobId: null, spawnIso: null },
	];

	test("listBand parses the forge table out of a real VerbResult (structured + text)", async () => {
		const mock = startMock({
			reply: (r) => verbResultReply(r.body.id, verbResult(true, FORGE_TABLE)),
		});
		const t = new HttpRunnerTransport(mock.url, TOKEN);
		expect(await t.listBand("forge")).toEqual(FORGE_BOXES);
	});

	test("listBand parses a VerbResult carried only as structuredContent", async () => {
		const mock = startMock({
			reply: (r) => verbResultReply(r.body.id, verbResult(true, FORGE_TABLE), false),
		});
		const t = new HttpRunnerTransport(mock.url, TOKEN);
		expect(await t.listBand("forge")).toEqual(FORGE_BOXES);
	});

	test("an empty forge table in an ok VerbResult is an empty band", async () => {
		const header = `${FORGE_TABLE.split("\n")[0]}\n`;
		const mock = startMock({
			reply: (r) => verbResultReply(r.body.id, verbResult(true, header), false),
		});
		const t = new HttpRunnerTransport(mock.url, TOKEN);
		expect(await t.listBand("forge")).toEqual([]);
	});

	test("an ok:false VerbResult with refusal stderr throws RunnerBandRefusedError on every band verb", async () => {
		const refused = verbResult(false, "", "refused: vmid 9001 is outside the forge band 9101-9150");
		const mock = startMock({ reply: (r) => verbResultReply(r.body.id, refused, false) });
		const t = new HttpRunnerTransport(mock.url, TOKEN);
		await expect(t.startBandMember(9001)).rejects.toBeInstanceOf(RunnerBandRefusedError);
		await expect(t.stopBandMember(9001)).rejects.toBeInstanceOf(RunnerBandRefusedError);
		await expect(t.listBand("forge")).rejects.toBeInstanceOf(RunnerBandRefusedError);
	});

	test("an ok:false VerbResult that is not a refusal still throws, never [] or success", async () => {
		const failed = verbResult(false, "", "ERROR: pct status 9101 failed on 10.0.0.5", {
			kind: "verb_failure",
			message: "pct status 9101 failed",
			retryable: false,
			outcome_unknown: false,
		});
		const mock = startMock({ reply: (r) => verbResultReply(r.body.id, failed, false) });
		const t = new HttpRunnerTransport(mock.url, TOKEN);
		for (const call of [
			() => t.startBandMember(9101),
			() => t.stopBandMember(9101),
			() => t.listBand("forge"),
		]) {
			const err = await call().catch((e: unknown) => e);
			expect(err).toBeInstanceOf(Error);
			expect(err).not.toBeInstanceOf(RunnerBandRefusedError);
			expect((err as Error).message).toContain("failed");
		}
	});

	test("forge_up and forge_down get their own 150s budgets; listBand keeps timeoutMs", async () => {
		const budgets: number[] = [];
		const originalTimeout = AbortSignal.timeout;
		AbortSignal.timeout = ((ms: number) => {
			budgets.push(ms);
			return new AbortController().signal;
		}) as typeof AbortSignal.timeout;
		try {
			const mock = startMock({ reply: (r) => verbResultReply(r.body.id, verbResult(true, "")) });
			const t = new HttpRunnerTransport(mock.url, TOKEN, { timeoutMs: 17 });
			await t.startBandMember(9101);
			await t.stopBandMember(9101);
			await t.listBand("forge");
			expect(budgets).toEqual([RUNNER_FORGE_UP_TIMEOUT_MS, RUNNER_STOP_TIMEOUT_MS, 17]);
		} finally {
			AbortSignal.timeout = originalTimeout;
		}
	});
});

const SLOT_SAMPLE = [
	"[node05] VMID       Status     Lock         Name                 JOB_ID                                       SPAWN_ISO",
	"[node05] 9102       running                 CT121               -                                            -",
	"[slot] vmid=9106 status=absent lane=general",
	"[slot] vmid=9102 node=node02 status=running lane=general",
	"[slot] vmid=9103 node=- status=unknown lane=general",
	"",
].join("\n");
const SLOT_BOXES = [
	{ vmid: 9106, status: "absent", name: "CT9106", jobId: null, spawnIso: null },
	{ vmid: 9102, status: "running", name: "CT9102", jobId: null, spawnIso: null },
	{ vmid: 9103, status: "unknown", name: "CT9103", jobId: null, spawnIso: null },
];

describe("HttpRunnerTransport ephemeral forge slots", () => {
	test("a refused: busy exit-1 VerbResult from runner_forge_down throws RunnerBandRefusedError", async () => {
		for (const busy of [
			verbResult(false, "refused: busy"),
			verbResult(false, "", "refused: busy"),
		]) {
			const mock = startMock({ reply: (r) => verbResultReply(r.body.id, busy) });
			const t = new HttpRunnerTransport(mock.url, TOKEN);
			await expect(t.stopBandMember(9102)).rejects.toBeInstanceOf(RunnerBandRefusedError);
			expect(recordedArgs(mock.requests, 0)).toEqual({ vmid: 9102, force: false });
		}
	});

	test("listBand returns the [slot] rows, absent included, over the old table", async () => {
		const mock = startMock({
			reply: (r) => verbResultReply(r.body.id, verbResult(true, SLOT_SAMPLE)),
		});
		const t = new HttpRunnerTransport(mock.url, TOKEN);
		expect(await t.listBand("forge")).toEqual(SLOT_BOXES);
	});
});
