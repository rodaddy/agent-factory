/** Pi Durable pilot provider. No coding-agent extension, fallback, or credentials. */
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { stream, streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import { createProvider } from "@earendil-works/pi-ai/models";
import { providerOf } from "../pi-extensions/fleet-proxy-models/index.ts";

export const BASE = "https://subs.example.internal";
export const MODELS = { claude: "claude-sonnet-5-5", gpt: "gpt-6.1-sol" };
export const CAPS = {
	requests: 2,
	outputTokens: 512,
	messageBytes: 8192,
	requestMs: 60000,
	caseMs: 180000,
};
export const digest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Consume before network I/O; crashes and failed requests cannot refund a slot. */
export function openBudget(path) {
	const db = new DatabaseSync(path);
	db.exec(
		"PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS requests (id INTEGER PRIMARY KEY CHECK(id BETWEEN 1 AND 2), record TEXT NOT NULL)",
	);
	return {
		rows: () =>
			db
				.prepare("SELECT record FROM requests ORDER BY id")
				.all()
				.map((r) => JSON.parse(r.record)),
		consume(record) {
			db.exec("BEGIN IMMEDIATE");
			try {
				const id = db.prepare("SELECT count(*) AS n FROM requests").get().n + 1;
				if (id > CAPS.requests) throw new Error("pilot_request_limit");
				db.prepare("INSERT INTO requests VALUES (?,?)").run(id, JSON.stringify({ id, ...record }));
				db.exec("COMMIT");
			} catch (error) {
				db.exec("ROLLBACK");
				throw error;
			}
		},
		close: () => db.close(),
	};
}

/** The bound is applied to, and checked against, the actual HTTP request. */
export function boundedPayload(payload) {
	if (!Array.isArray(payload?.messages)) throw new Error("pilot_payload_shape");
	if (Buffer.byteLength(JSON.stringify(payload.messages)) > CAPS.messageBytes)
		throw new Error("pilot_context_limit");
	if (payload.tools?.length) throw new Error("pilot_tools_refused");
	const bounded = { ...payload };
	const key = "max_completion_tokens" in bounded ? "max_completion_tokens" : "max_tokens";
	delete bounded.max_completion_tokens;
	delete bounded.max_tokens;
	bounded[key] = CAPS.outputTokens;
	return bounded;
}

/** Fail closed on catalog routing changes; offline callers supply a loopback base. */
export function pilotModel(body, family, base) {
	const id = MODELS[family];
	if (!id) throw new Error("pilot_family_refused");
	const entry = body.data?.find((m) => m.id === id);
	if (entry?.endpoint?.api !== "openai-completions" || entry.endpoint.baseUrl !== `${base}/v1`)
		throw new Error("pilot_catalog_route_refused");
	const config = providerOf(body, base);
	const model = config.models.find((m) => m.id === id);
	if (!model) throw new Error("pilot_catalog_model_refused");
	return { ...model, provider: "fleet-proxy", api: config.api, baseUrl: config.baseUrl };
}

/** Register the standard Pi AI streaming implementation behind persisted admission. */
export function proxyProvider(
	model,
	budget,
	{ beforeSend = async () => {}, phase, base = BASE } = {},
) {
	const guardedFetch = async (input, init) => {
		const request = new Request(input, init);
		if (request.url !== `${base}/v1/chat/completions` || request.method !== "POST")
			throw new Error("pilot_endpoint_refused");
		const payload = JSON.parse(await request.clone().text());
		boundedPayload(payload);
		if (
			payload.model !== model.id ||
			(payload.max_completion_tokens ?? payload.max_tokens) !== CAPS.outputTokens ||
			("max_completion_tokens" in payload && "max_tokens" in payload)
		)
			throw new Error("pilot_wire_bounds_refused");
		await beforeSend();
		budget.consume({
			phase,
			pid: process.pid,
			model: payload.model,
			at: new Date().toISOString(),
			messageBytes: Buffer.byteLength(JSON.stringify(payload.messages)),
			payloadHash: digest(payload),
			maxOutputTokens: payload.max_completion_tokens ?? payload.max_tokens,
		});
		return fetch(request, {
			redirect: "error",
			signal: AbortSignal.any([request.signal, AbortSignal.timeout(CAPS.requestMs)]),
		});
	};
	const onPayload = (payload) => {
		if (budget.rows().length >= CAPS.requests) throw new Error("pilot_request_limit");
		return boundedPayload(payload);
	};
	const options = (given) => ({
		...given,
		apiKey: "none",
		maxTokens: CAPS.outputTokens,
		maxRetries: 0,
		timeoutMs: CAPS.requestMs,
		fetch: guardedFetch,
		onPayload,
	});
	return createProvider({
		id: "fleet-proxy",
		baseUrl: `${base}/v1`,
		models: [model],
		auth: {
			apiKey: {
				name: "Existing subscription proxy",
				resolve: async () => ({ auth: { apiKey: "none" } }),
			},
		},
		api: {
			stream: (m, c, o) => stream(m, c, options(o)),
			streamSimple: (m, c, o) => streamSimple(m, c, options(o)),
		},
	});
}
