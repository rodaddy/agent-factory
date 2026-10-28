import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JevAnswer, JevQuestion, JevResult } from "../../src/jev/client";
import {
	type Ask,
	type Classifier,
	calibrate,
	classify,
	loadClassifier,
	questionFor,
	readAnswer,
} from "../../src/jev/classifier";
import { testTmpBase } from "../support/test-temp";

const tiny: Classifier = {
	id: "tiny",
	version: 1,
	type: "noul",
	ask: "Is {source} bad?",
	confident: 0.8,
	policy: { yes: { verdict: "BLOCK", order: 1 }, no: { verdict: "PASS", order: 0 } },
	unsure: { verdict: "REVIEW" },
	no_signal: { verdict: "FALLBACK" },
	examples: [
		{ fields: { source: "a" }, expect: "yes" },
		{ fields: { source: "b" }, expect: "yes" },
		{ fields: { source: "c" }, expect: "yes" },
		{ fields: { source: "d" }, expect: "no" },
	],
};

function ok(id: string, answer: JevAnswer): JevResult {
	return { ok: true, answers: { [id]: answer }, inputTokens: 10, ms: 1 };
}
const fixed =
	(r: JevResult): Ask =>
	async () =>
		r;

describe("loadClassifier", () => {
	test("loads the real lane-input-injection classifier", async () => {
		const clf = await loadClassifier("lane-input-injection");
		expect(clf.id).toBe("lane-input-injection");
		expect(clf.examples.length).toBe(32);
	});
	test("rejects a file missing policy", async () => {
		const dir = join(testTmpBase(), `jev-clf-${process.pid}-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "bad.json");
		const { policy: _p, ...rest } = tiny;
		writeFileSync(path, JSON.stringify(rest));
		try {
			await expect(loadClassifier(path)).rejects.toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	async function rejects(raw: unknown, message: string): Promise<void> {
		const dir = join(testTmpBase(), `jev-clf-${process.pid}-${Date.now()}-${Math.random()}`);
		mkdirSync(dir, { recursive: true });
		const path = join(dir, "bad.json");
		writeFileSync(path, JSON.stringify(raw));
		try {
			await expect(loadClassifier(path)).rejects.toThrow(message);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	}
	const choice = {
		...tiny,
		type: "choice",
		criteria: { bug: "a bug", feat: "a feature" },
		policy: { bug: { verdict: "FIX" }, feat: { verdict: "BUILD" } },
	};
	const score = {
		...tiny,
		type: "score",
		criteria: { low: "l", high: { what: "h", examples: ["x"] } },
		policy: { low: { verdict: "PASS" }, high: { verdict: "BLOCK" } },
	};
	test("no_signal verdict may not equal a policy verdict", async () => {
		await rejects(
			{ ...tiny, no_signal: { verdict: "PASS" } },
			"classifier tiny: no_signal verdict PASS equals a policy verdict",
		);
	});
	test("unsure verdict may not equal a policy verdict", async () => {
		await rejects(
			{ ...tiny, unsure: { verdict: "BLOCK" } },
			"classifier tiny: unsure verdict BLOCK equals a policy verdict",
		);
	});
	test("a noul has no criteria", async () => {
		await rejects(
			{ ...tiny, criteria: { true: "bad", false: "fine" } },
			"classifier tiny: a noul has no criteria; its labels are yes and no",
		);
	});
	test("a noul policy is exactly yes and no", async () => {
		await rejects(
			{ ...tiny, policy: { yes: { verdict: "BLOCK" }, maybe: { verdict: "PASS" } } },
			"classifier tiny: policy labels must be",
		);
	});
	test("a choice needs criteria", async () => {
		const { criteria: _c, ...rest } = choice;
		await rejects(rest, "classifier tiny: a choice needs criteria");
	});
	test("a choice needs at least 2 criteria", async () => {
		await rejects(
			{ ...choice, criteria: { bug: "a bug" }, policy: { bug: { verdict: "FIX" } } },
			"classifier tiny: a choice needs at least 2 criteria",
		);
	});
	test("choice criteria are strings", async () => {
		await rejects({ ...choice, criteria: { bug: 1, feat: "f" } }, "classifier tiny: invalid");
	});
	test("choice policy labels equal the criteria keys", async () => {
		await rejects(
			{ ...choice, policy: { bug: { verdict: "FIX" }, other: { verdict: "BUILD" } } },
			"classifier tiny: policy labels must be",
		);
	});
	test("a score needs criteria", async () => {
		const { criteria: _c, ...rest } = score;
		await rejects(rest, "classifier tiny: a score needs criteria");
	});
	test("a score needs 2 to 10 criteria", async () => {
		await rejects(
			{ ...score, criteria: { low: "l" }, policy: { low: { verdict: "PASS" } } },
			"classifier tiny: a score needs 2 to 10 criteria",
		);
		const many = Object.fromEntries(Array.from({ length: 11 }, (_, i) => [`l${i}`, "x"]));
		const policy = Object.fromEntries(Object.keys(many).map((k) => [k, { verdict: `V${k}` }]));
		await rejects({ ...score, criteria: many, policy }, "classifier tiny: a score needs 2 to 10");
	});
	test("score levels are strings or {what, examples}", async () => {
		await rejects(
			{ ...score, criteria: { low: "l", high: { no: 1 } } },
			"classifier tiny: invalid",
		);
	});
	test("score policy labels equal the criteria keys", async () => {
		await rejects(
			{ ...score, policy: { low: { verdict: "PASS" }, mid: { verdict: "BLOCK" } } },
			"classifier tiny: policy labels must be",
		);
	});
});

describe("questionFor", () => {
	test("substitutes placeholders; a noul sends no criteria", () => {
		const q = questionFor(tiny, { source: "issue" });
		expect(q).toEqual({
			type: "noul",
			instructions: "Is issue bad?",
		});
	});
	test("a missing field throws naming it", () => {
		expect(() => questionFor(tiny, {})).toThrow("classifier tiny: missing field source");
	});
});

describe("readAnswer", () => {
	test("noul", () => {
		const low = readAnswer(tiny, { type: "noul", noul: 0.2 });
		expect(low.label).toBe("no");
		expect(low.confidence).toBeCloseTo(0.8);
		expect(readAnswer(tiny, { type: "noul", noul: 0.9 })).toEqual({
			label: "yes",
			confidence: 0.9,
		});
	});
	test("score rounds onto the criteria levels", () => {
		const clf: Classifier = {
			...tiny,
			type: "score",
			criteria: { low: "l", mid: "m", high: "h" },
		};
		const r = readAnswer(clf, {
			type: "score",
			score: 1.6,
			confidence: 0.7,
			legend: {},
			probabilities: {},
		});
		expect(r).toEqual({ label: "high", confidence: 0.7 });
	});
});

describe("classify", () => {
	test("confident answer -> policy verdict", async () => {
		const v = await classify(
			tiny,
			{ source: "x" },
			fixed(ok("tiny", { type: "noul", noul: 0.95 })),
		);
		expect(v).toMatchObject({ signal: true, label: "yes", verdict: "BLOCK" });
	});
	test("low confidence -> unsure with label kept", async () => {
		const v = await classify(tiny, { source: "x" }, fixed(ok("tiny", { type: "noul", noul: 0.3 })));
		expect(v).toMatchObject({ signal: true, label: "no", verdict: "REVIEW", why: "below 0.8" });
	});
	test("an out-of-range score that bypassed the client -> no_signal", async () => {
		const clf: Classifier = {
			...tiny,
			type: "score",
			criteria: { low: "l", high: "h" },
			policy: { low: { verdict: "PASS" }, high: { verdict: "BLOCK" } },
		};
		const answer: JevAnswer = {
			type: "score",
			score: 2.7,
			confidence: 0.99,
			legend: {},
			probabilities: {},
		};
		expect(() => readAnswer(clf, answer)).toThrow("classifier tiny: score 2.7 outside 2 levels");
		const v = await classify(clf, { source: "x" }, fixed(ok("tiny", answer)));
		expect(v).toMatchObject({ signal: false, label: null, verdict: "FALLBACK" });
	});
	test("ok:false -> no_signal", async () => {
		const v = await classify(tiny, { source: "x" }, fixed({ ok: false, error: "http 500", ms: 1 }));
		expect(v).toEqual({
			signal: false,
			label: null,
			confidence: 0,
			verdict: "FALLBACK",
			why: "no Jev signal",
		});
	});
});

describe("calibrate", () => {
	const script: Record<string, JevResult> = {
		a: ok("tiny", { type: "noul", noul: 0.95 }),
		b: ok("tiny", { type: "noul", noul: 0.3 }),
		c: ok("tiny", { type: "noul", noul: 0.1 }),
		d: { ok: false, error: "http 500", ms: 1 },
	};
	const scripted: Ask = async (state) => script[(state as { source: string }).source] as JevResult;

	test("counts right, unsure, unsafe, and no-signal", async () => {
		const r = await calibrate(tiny, scripted);
		expect(r.examples).toBe(4);
		expect(r.accuracy).toBe(0.333);
		expect(r.no_signal).toBe(1);
		expect(r.unsafe_misses).toBe(1);
		expect(r.wrong_and_trusted).toBe(1);
		expect(r.right_but_sent_to_unsure).toBe(0);
		expect(r.lowest_confidence_when_right).toBe(0.95);
		expect(r.highest_confidence_when_wrong).toBe(0.9);
		expect(r.separable).toBe(true);
		expect(r.cost.requests).toBe(4);
		expect(r.cost.input_tokens).toBe(30);
		expect(r.misses.map((m) => [m.index, m.unsafe])).toEqual([
			[1, false],
			[2, true],
		]);
	});

	test("never exceeds concurrency in flight", async () => {
		let inFlight = 0;
		let peak = 0;
		const clf: Classifier = {
			...tiny,
			examples: Array.from({ length: 10 }, (_, i) => ({
				fields: { source: `s${i}` },
				expect: "no",
			})),
		};
		const ask: Ask = async (_s, _q: Record<string, JevQuestion>) => {
			inFlight++;
			peak = Math.max(peak, inFlight);
			await new Promise((r) => setTimeout(r, 5)); // fixed-sleep-ok: simulated latency in a fake
			inFlight--;
			return ok("tiny", { type: "noul", noul: 0.1 });
		};
		const r = await calibrate(clf, ask, 3);
		expect(peak).toBe(3);
		expect(r.accuracy).toBe(1);
	});
});

describe("calibrate CLI", () => {
	test("no args exits 3", async () => {
		const p = Bun.spawn(["bun", join(import.meta.dir, "..", "..", "scripts/jev/calibrate.ts")], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await p.exited).toBe(3);
	});
});
