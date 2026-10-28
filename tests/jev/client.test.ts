import { describe, expect, test } from "bun:test";
import {
	askJev,
	JEV_ENDPOINT,
	JEV_MODEL,
	type JevOptions,
	type JevQuestion,
} from "../../src/jev/client";

// Obviously fake and low-entropy, so gitleaks does not read it as a credential.
const KEY = "fake-typesafe-key-for-tests";
const questions: Record<string, JevQuestion> = {
	safe: { type: "noul", instructions: "is it safe" },
	kind: {
		type: "choice",
		instructions: "which kind",
		criteria: { bug: "a bug", feat: "a feature" },
	},
};
const goodBody = {
	answers: {
		safe: { type: "noul", noul: 0.9 },
		kind: {
			type: "choice",
			choice: "bug",
			probabilities: { bug: 0.8, feat: 0.2 },
			confidence: 0.8,
		},
	},
	usage: { input_tokens: 42 },
};

type Call = { url: string; init: RequestInit };
function fakeFetch(responses: Array<(() => Response) | Error>): {
	fetchImpl: typeof fetch;
	calls: Call[];
} {
	const calls: Call[] = [];
	const fetchImpl = (async (url: string, init: RequestInit) => {
		calls.push({ url, init });
		const r = responses[Math.min(calls.length - 1, responses.length - 1)];
		if (r === undefined) throw new Error("no fake response");
		if (r instanceof Error) throw r;
		return r();
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}
const json =
	(body: unknown, status = 200) =>
	() =>
		new Response(JSON.stringify(body), { status });
const noSleep = async () => {};
function opts(fetchImpl: typeof fetch, extra: Partial<JevOptions> = {}): JevOptions {
	return { apiKey: KEY, fetchImpl, sleep: noSleep, ...extra };
}
async function fail(o: JevOptions, q = questions): Promise<string> {
	const r = await askJev({ x: 1 }, q, o);
	expect(r.ok).toBe(false);
	if (r.ok) throw new Error("unreachable");
	return r.error;
}

describe("askJev", () => {
	test("success sends model/state/questions with bearer key", async () => {
		const { fetchImpl, calls } = fakeFetch([json(goodBody)]);
		const r = await askJev({ x: 1 }, questions, opts(fetchImpl));
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.inputTokens).toBe(42);
		expect(r.answers.safe).toEqual({ type: "noul", noul: 0.9 });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe(JEV_ENDPOINT);
		const init = calls[0]?.init as RequestInit;
		expect(init.method).toBe("POST");
		expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${KEY}`);
		const body = JSON.parse(String(init.body));
		expect(body).toEqual({ model: JEV_MODEL, state: { x: 1 }, questions });
	});

	test("no key: fetch never called", async () => {
		const { fetchImpl, calls } = fakeFetch([json(goodBody)]);
		const r = await askJev({}, questions, { apiKey: "", fetchImpl, sleep: noSleep });
		expect(r).toMatchObject({ ok: false, error: "no TYPESAFE_API_KEY" });
		expect(calls).toHaveLength(0);
	});

	test("429 then 200 retries once after retryDelayMs", async () => {
		const { fetchImpl, calls } = fakeFetch([json({}, 429), json(goodBody)]);
		const slept: number[] = [];
		const r = await askJev(
			{},
			questions,
			opts(fetchImpl, { retryDelayMs: 7, sleep: async (ms) => void slept.push(ms) }),
		);
		expect(r.ok).toBe(true);
		expect(calls).toHaveLength(2);
		expect(slept).toEqual([7]);
	});

	test("500 twice fails with status", async () => {
		const { fetchImpl, calls } = fakeFetch([json({}, 500)]);
		expect(await fail(opts(fetchImpl))).toContain("500");
		expect(calls).toHaveLength(2);
	});

	test("400 is not retried", async () => {
		const { fetchImpl, calls } = fakeFetch([json({}, 400)]);
		await fail(opts(fetchImpl));
		expect(calls).toHaveLength(1);
	});

	test("network error retried once then fails without throwing", async () => {
		const { fetchImpl, calls } = fakeFetch([new TypeError(`boom ${KEY}`)]);
		await fail(opts(fetchImpl));
		expect(calls).toHaveLength(2);
	});

	test("timeout aborts a hanging fetch", async () => {
		const fetchImpl = ((_u: string, init: RequestInit) =>
			new Promise((_res, rej) => {
				init.signal?.addEventListener("abort", () => rej(init.signal?.reason));
			})) as unknown as typeof fetch;
		await fail(opts(fetchImpl, { timeoutMs: 20 }));
	});

	test("malformed answers fail", async () => {
		const missing = { answers: { safe: goodBody.answers.safe } };
		expect(await fail(opts(fakeFetch([json(missing)]).fetchImpl))).toBe("malformed answer: kind");
		const badChoice = {
			answers: { ...goodBody.answers, kind: { ...goodBody.answers.kind, choice: "other" } },
		};
		expect(await fail(opts(fakeFetch([json(badChoice)]).fetchImpl))).toBe("malformed answer: kind");
		const badNoul = { answers: { ...goodBody.answers, safe: { type: "noul", noul: 1.5 } } };
		expect(await fail(opts(fakeFetch([json(badNoul)]).fetchImpl))).toBe("malformed answer: safe");
	});

	test("key never appears in any error", async () => {
		const hang = ((_u: string, init: RequestInit) =>
			new Promise((_res, rej) => {
				init.signal?.addEventListener("abort", () => rej(init.signal?.reason));
			})) as unknown as typeof fetch;
		const badNoul = { answers: { ...goodBody.answers, safe: { type: "noul", noul: 1.5 } } };
		const errors = [
			await fail(opts(fakeFetch([json({ key: KEY }, 500)]).fetchImpl)),
			await fail(opts(fakeFetch([json({ key: KEY }, 400)]).fetchImpl)),
			await fail(opts(fakeFetch([new TypeError(`boom ${KEY}`)]).fetchImpl)),
			await fail(opts(fakeFetch([json(badNoul)]).fetchImpl)),
			await fail(opts(hang, { timeoutMs: 20 })),
		];
		expect(errors).toHaveLength(5);
		for (const e of errors) expect(e).not.toContain(KEY);
	});
});

describe("askJev score questions (shapes captured live 2026-09-28)", () => {
	const scoreQ: Record<string, JevQuestion> = {
		risk: {
			type: "score",
			instructions: "risk",
			criteria: ["harmless", "some risk", { what: "dangerous", examples: ["rm -rf /"] }],
		},
	};
	test("a list of levels is sent as a list, and an object legend is accepted", async () => {
		const live = {
			model: "jev-1.13.0",
			answers: {
				risk: {
					type: "score",
					score: 1.8,
					confidence: 0.7,
					legend: {
						"0": { what: "harmless" },
						"1": { what: "some risk" },
						"2": { what: "dangerous", examples: ["rm -rf /"] },
					},
					probabilities: { "0": 0.01, "1": 0.18, "2": 0.81 },
				},
			},
			usage: { input_tokens: 346, output_tokens: 17 },
		};
		const { fetchImpl, calls } = fakeFetch([json(live)]);
		const r = await askJev({ message: "m" }, scoreQ, opts(fetchImpl));
		expect(r.ok).toBe(true);
		const sent = JSON.parse(String(calls[0]?.init.body)) as {
			questions: { risk: { criteria: unknown } };
		};
		expect(Array.isArray(sent.questions.risk.criteria)).toBe(true);
		if (r.ok) expect(r.answers.risk).toMatchObject({ type: "score", score: 1.8 });
	});
	test("a string legend (list of strings sent) is accepted", async () => {
		const live = {
			answers: {
				risk: {
					type: "score",
					score: 1.94,
					confidence: 0.92,
					legend: { "0": "harmless", "1": "some risk", "2": "dangerous" },
					probabilities: { "0": 0.01, "1": 0.04, "2": 0.95 },
				},
			},
		};
		const r = await askJev({ message: "m" }, scoreQ, opts(fakeFetch([json(live)]).fetchImpl));
		expect(r.ok).toBe(true);
	});
	test("a score outside the level range is malformed", async () => {
		for (const score of [2.5, -0.1]) {
			const body = {
				answers: { risk: { type: "score", score, confidence: 0.9, legend: {}, probabilities: {} } },
			};
			expect(await fail(opts(fakeFetch([json(body)]).fetchImpl), scoreQ)).toBe(
				"malformed answer: risk",
			);
		}
	});
});
