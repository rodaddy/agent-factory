import { describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { main } from "../../scripts/jev/model-route-backtest";
import { type Ask, type Classifier, loadClassifier } from "../../src/jev/classifier";
import type { JevResult } from "../../src/jev/client";
import { backtest, summaryLine } from "../../src/jev/model-route";
import { testTmpBase } from "../support/test-temp";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts/jev/model-route-backtest.ts");

/** Fake Ask: the brief's `title` names the answer as `<label>@<confidence>`. */
const fake: Ask = async (state) => {
	const [choice, conf] = String((state as { title: string }).title).split("@");
	const res: JevResult = {
		ok: true,
		answers: {
			"model-route": {
				type: "choice",
				choice: choice as string,
				probabilities: {},
				confidence: Number(conf),
			},
		},
		inputTokens: 7,
		ms: 2,
	};
	return res;
};
const ex = (got: string, expect: string) => ({
	fields: { title: got, task: "t", seat: "s" },
	expect,
});

// 3 right, 1 over-routed (light -> deep), 1 under-routed (deep -> standard), 1 below 0.7.
const matrix = [
	ex("light@0.9", "light"),
	ex("standard@0.9", "standard"),
	ex("deep@0.9", "deep"),
	ex("deep@0.9", "light"),
	ex("standard@0.9", "deep"),
	ex("light@0.5", "deep"),
];

async function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
	const dir = join(testTmpBase(), `jev-route-${process.pid}-${Date.now()}-${Math.random()}`);
	mkdirSync(dir, { recursive: true });
	try {
		return await fn(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

describe("model-route classifier file", () => {
	test("loads as a 3-label choice, policy order 0 1 2, no examples", async () => {
		const clf = await loadClassifier("model-route");
		expect(clf.type).toBe("choice");
		expect(Object.keys(clf.criteria ?? {})).toEqual(["light", "standard", "deep"]);
		expect(["light", "standard", "deep"].map((l) => clf.policy[l]?.order)).toEqual([0, 1, 2]);
		expect(clf.examples).toEqual([]);
	});
});

describe("backtest", () => {
	test("known confusion matrix gives the hand-computed rates", async () => {
		const clf = await loadClassifier("model-route");
		const r = await backtest(clf, matrix, fake);
		expect(r.examples).toBe(6);
		expect(r.no_signal).toBe(0);
		expect(r.trusted).toBe(5);
		// 3 right of 6 with signal; the below-threshold reading is unsure, not a miss.
		expect(r.accuracy).toBe(0.5);
		expect(r.unsure_rate).toBe(0.167);
		expect(r.false_escalation_rate).toBe(0.2);
		expect(r.under_route_rate).toBe(0.2);
		expect(r.confusion.light).toEqual({ light: 1, deep: 1 });
		expect(r.confusion.deep).toEqual({ deep: 1, standard: 1, unsure: 1 });
		expect(r.cost).toEqual({ questions: 6, requests: 6, ms: 12, input_tokens: 42 });
	});

	test("over-routing is escalation, under-routing is not", async () => {
		const clf = await loadClassifier("model-route");
		const over = await backtest(clf, [ex("deep@0.9", "light")], fake);
		expect([over.false_escalation_rate, over.under_route_rate]).toEqual([1, 0]);
		const under = await backtest(clf, [ex("light@0.9", "deep")], fake);
		expect([under.false_escalation_rate, under.under_route_rate]).toEqual([0, 1]);
	});

	test("a below-confidence reading counts as unsure, not as a miss", async () => {
		const clf = await loadClassifier("model-route");
		const r = await backtest(clf, [ex("light@0.9", "light"), ex("deep@0.4", "light")], fake);
		expect(r.trusted).toBe(1);
		expect(r.unsure_rate).toBe(0.5);
		expect(r.false_escalation_rate).toBe(0);
	});

	test("zero trusted readings gives null rates, never 0", async () => {
		const clf = await loadClassifier("model-route");
		const r = await backtest(clf, [ex("light@0.1", "deep")], fake);
		expect(r.trusted).toBe(0);
		expect(r.false_escalation_rate).toBeNull();
		expect(r.under_route_rate).toBeNull();
		expect(summaryLine(r)).toBe(
			"model-route heldout: accuracy=0 false_escalation=null under_route=null unsure=1 n=1",
		);
	});

	test("an ok:false result is counted as no signal", async () => {
		const clf = await loadClassifier("model-route");
		const none: Ask = async () => ({ ok: false, error: "x", ms: 1 });
		const r = await backtest(clf, [ex("light@0.9", "light")], none);
		expect(r.no_signal).toBe(1);
		expect(r.accuracy).toBe(0);
	});

	test("an expect outside the criteria is refused", async () => {
		const clf: Classifier = await loadClassifier("model-route");
		await expect(backtest(clf, [ex("light@0.9", "opus")], fake)).rejects.toThrow("opus");
	});
});

describe("scripts/jev/model-route-backtest", () => {
	test("prints the summary line first and exits 0", async () => {
		await withDir(async (dir) => {
			const file = join(dir, "heldout.json");
			writeFileSync(file, JSON.stringify(matrix));
			let printed = "";
			const code = await main([file], fake, (s) => {
				printed += s;
			});
			expect(code).toBe(0);
			const first = printed.split("\n")[0] as string;
			expect(first).toMatch(
				/^model-route heldout: accuracy=[0-9.]+ false_escalation=([0-9.]+|null) under_route=([0-9.]+|null) unsure=[0-9.]+ n=[0-9]+$/,
			);
			expect(first).toBe(
				"model-route heldout: accuracy=0.5 false_escalation=0.2 under_route=0.2 unsure=0.167 n=6",
			);
			expect(JSON.parse(printed.slice(first.length + 1)).trusted).toBe(5);
		});
	});

	test("bad arguments, unreadable or invalid input, and bad expect exit 3", async () => {
		await withDir(async (dir) => {
			const bad = join(dir, "bad.json");
			writeFileSync(bad, JSON.stringify([ex("light@0.9", "opus")]));
			const shape = join(dir, "shape.json");
			writeFileSync(shape, JSON.stringify([{ fields: {} }]));
			const quiet = () => {};
			expect(await main([], fake, quiet)).toBe(3);
			expect(await main([bad, "--bogus"], fake, quiet)).toBe(3);
			expect(await main([join(dir, "missing.json")], fake, quiet)).toBe(3);
			expect(await main([shape], fake, quiet)).toBe(3);
			expect(await main([bad], fake, quiet)).toBe(3);
		});
	});

	test("no Jev key means no signal, and the spawned script exits 3", async () => {
		await withDir(async (dir) => {
			const file = join(dir, "heldout.json");
			writeFileSync(file, JSON.stringify([ex("light@0.9", "light")]));
			const env = { ...process.env };
			delete env.TYPESAFE_API_KEY;
			const proc = Bun.spawnSync(["bun", SCRIPT, file], { env, stdout: "pipe", stderr: "pipe" });
			expect(proc.exitCode).toBe(3);
			expect(proc.stderr.toString()).toContain("no Jev signal");
		});
	});
});
