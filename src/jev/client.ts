/**
 * @module src/jev/client
 * @description The one client for TypeSafe's Jev System One model.
 *   `askJev` posts an application state plus a set of typed questions and
 *   returns validated, typed answers. Every fault -- no key, network error,
 *   timeout, non-2xx, malformed body -- comes back as `{ ok: false, error }`;
 *   it never throws. One retry covers network errors, timeouts, 429 and 5xx.
 *
 *   NO SIGNAL IS NEVER A PASS. A caller that gets `ok: false` must treat the
 *   judgment as absent and fall back to its non-Jev path; it must never read a
 *   missing answer as approval. Error strings carry status codes and error
 *   classes only -- never the key, the state, or the response body.
 *
 * @outputs
 *   - `askJev` -- state + questions -> `JevResult`
 *   - `JEV_MODEL` / `JEV_ENDPOINT` -- the pinned model and endpoint
 *   - `JevQuestion` / `JevAnswer` / `JevResult` / `JevOptions` -- the types
 */
import { z } from "zod";
import { errorClass, log, traced } from "../log";

export const JEV_MODEL = "jev-1.13.0";
export const JEV_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

export type JevQuestion =
	| { type: "noul"; instructions: string; criteria?: { true: string; false: string } }
	| { type: "choice"; instructions: string; criteria: Record<string, string> }
	| {
			type: "score";
			instructions: string;
			/** Ordered levels, low to high. The live API refuses a map here (HTTP 422, probed 2026-09-28). */
			criteria: JevLevel[];
	  };
/** One score level: a description, or a description with examples. */
export type JevLevel = string | { what: string; examples?: string[] };
export type JevAnswer =
	| { type: "noul"; noul: number }
	| { type: "choice"; choice: string; probabilities: Record<string, number>; confidence: number }
	| {
			type: "score";
			score: number;
			confidence: number;
			/** Level index ("0", "1", ...) to the level as sent. */
			legend: Record<string, JevLevel>;
			probabilities: Record<string, number>;
	  };
export type JevResult =
	| { ok: true; answers: Record<string, JevAnswer>; inputTokens: number; ms: number }
	| { ok: false; error: string; ms: number };
export interface JevOptions {
	apiKey?: string;
	fetchImpl?: typeof fetch;
	timeoutMs?: number;
	retryDelayMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

const unit = z.number().min(0).max(1);
const responseSchema = z.object({
	answers: z.record(z.string(), z.unknown()),
	usage: z.object({ input_tokens: z.number().optional() }).optional(),
});
const noulSchema = z.object({ type: z.literal("noul"), noul: unit });
const choiceSchema = z.object({
	type: z.literal("choice"),
	choice: z.string(),
	probabilities: z.record(z.string(), z.number()).default({}),
	confidence: unit,
});
const scoreSchema = z.object({
	type: z.literal("score"),
	score: z.number(),
	confidence: unit,
	legend: z
		.record(
			z.string(),
			z.union([
				z.string(),
				z.object({ what: z.string(), examples: z.array(z.string()).optional() }),
			]),
		)
		.default({}),
	probabilities: z.record(z.string(), z.number()).default({}),
});

function validateAnswer(q: JevQuestion, raw: unknown): JevAnswer | undefined {
	if (q.type === "noul") {
		const r = noulSchema.safeParse(raw);
		return r.success ? r.data : undefined;
	}
	if (q.type === "choice") {
		const r = choiceSchema.safeParse(raw);
		return r.success && Object.hasOwn(q.criteria, r.data.choice) ? r.data : undefined;
	}
	const r = scoreSchema.safeParse(raw);
	const inRange = r.success && r.data.score >= 0 && r.data.score <= q.criteria.length - 1;
	return inRange ? r.data : undefined;
}

type Attempt =
	| { kind: "response"; res: Response }
	| { kind: "retryable"; error: string }
	| { kind: "fatal"; error: string };

async function attempt(
	fetchImpl: typeof fetch,
	key: string,
	body: string,
	timeoutMs: number,
): Promise<Attempt> {
	try {
		const res = await fetchImpl(JEV_ENDPOINT, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body,
			signal: AbortSignal.timeout(timeoutMs),
		});
		if (res.ok) return { kind: "response", res };
		const error = `http ${res.status}`;
		return res.status === 429 || res.status >= 500
			? { kind: "retryable", error }
			: { kind: "fatal", error };
	} catch (err) {
		return { kind: "retryable", error: `request failed: ${errorClass(err)}` };
	}
}

async function parse(
	res: Response,
	questions: Record<string, JevQuestion>,
): Promise<JevResult | string> {
	let raw: unknown;
	try {
		raw = await res.json();
	} catch (err) {
		return `unreadable response: ${errorClass(err)}`;
	}
	const parsed = responseSchema.safeParse(raw);
	if (!parsed.success) return "malformed response";
	const answers: Record<string, JevAnswer> = {};
	for (const [id, q] of Object.entries(questions)) {
		const a = Object.hasOwn(parsed.data.answers, id)
			? validateAnswer(q, parsed.data.answers[id])
			: undefined;
		if (a === undefined) return `malformed answer: ${id}`;
		answers[id] = a;
	}
	return { ok: true, answers, inputTokens: parsed.data.usage?.input_tokens ?? 0, ms: 0 };
}

async function run(
	state: unknown,
	questions: Record<string, JevQuestion>,
	opts: JevOptions,
): Promise<JevResult | string> {
	const key = opts.apiKey ?? process.env.TYPESAFE_API_KEY;
	if (key === undefined || key === "") return "no TYPESAFE_API_KEY";
	const fetchImpl = opts.fetchImpl ?? fetch;
	const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
	const body = JSON.stringify({ model: JEV_MODEL, state, questions });
	let outcome = await attempt(fetchImpl, key, body, opts.timeoutMs ?? 10_000);
	if (outcome.kind === "retryable") {
		await sleep(opts.retryDelayMs ?? 1_000);
		outcome = await attempt(fetchImpl, key, body, opts.timeoutMs ?? 10_000);
	}
	if (outcome.kind !== "response") return outcome.error;
	return parse(outcome.res, questions);
}

async function askJevImpl(
	state: unknown,
	questions: Record<string, JevQuestion>,
	opts: JevOptions = {},
): Promise<JevResult> {
	const started = performance.now();
	const ids = Object.keys(questions).join(",");
	let out: JevResult | string;
	try {
		out = await run(state, questions, opts);
	} catch (err) {
		out = `unexpected: ${errorClass(err)}`;
	}
	const ms = Math.round(performance.now() - started);
	// Usage attribution from one key: the question ids name the classifier,
	// and a lane job's REPO/LANE env name the target repo and the lane.
	const who = { repo: process.env.REPO ?? "", lane: process.env.LANE ?? "" };
	if (typeof out === "string") {
		log("warn", "jev.no_signal", { questions: ids, ...who, error: out });
		return { ok: false, error: out, ms };
	}
	log("info", "jev.ask", {
		questions: ids,
		...who,
		ms,
		input_tokens: out.ok ? out.inputTokens : 0,
	});
	return { ...out, ms };
}

export const askJev = traced("jev.askJev", askJevImpl, { redact: { args: [0, 2] } });
