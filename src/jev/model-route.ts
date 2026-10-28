/**
 * @module src/jev/model-route
 * @description Held-out back-test for the `model-route` classifier (sf#1493
 *   P3.1a). The classifier answers a difficulty tier (`light`, `standard`,
 *   `deep`), never a model name. `backtest` scores it once on a held-out set
 *   that never mixes with the classifier file's tuning examples, and reports
 *   accuracy plus how often a trusted reading over-routes (false escalation)
 *   or under-routes. A reading below the classifier's `confident` threshold is
 *   `unsure` (the seat would serve its default), not a miss. Zero trusted
 *   readings give `null` rates: a rate of 0 over nothing must not read as a pass.
 *
 * @outputs
 *   - `backtest` -- classifier + held-out examples -> `RouteBacktest`
 *   - `summaryLine` -- `RouteBacktest` -> the one-line done-means summary
 *   - `RouteBacktest` -- the report type
 */
import { traced } from "../log";
import { type Ask, type Classifier, questionFor, type Reading, readAnswer } from "./classifier";
import { askJev, type JevResult } from "./client";

type Example = Classifier["examples"][number];

export interface RouteBacktest {
	classifier: string;
	version: number;
	examples: number;
	no_signal: number;
	accuracy: number;
	trusted: number;
	unsure_rate: number;
	false_escalation_rate: number | null;
	under_route_rate: number | null;
	/** expect -> got -> count; a below-threshold reading is tallied as `unsure`. */
	confusion: Record<string, Record<string, number>>;
	cost: { questions: number; requests: number; ms: number; input_tokens: number };
}

const round3 = (n: number): number => Math.round(n * 1000) / 1000;
const rate = (n: number, d: number): number | null => (d === 0 ? null : round3(n / d));

async function askAll(clf: Classifier, set: Example[], ask: Ask, lanes: number) {
	const results: JevResult[] = Array.from({ length: set.length });
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < set.length) {
			const i = next++;
			const { fields } = set[i] as Example;
			results[i] = await ask(fields, { [clf.id]: questionFor(clf, fields) });
		}
	};
	await Promise.all(Array.from({ length: Math.max(1, Math.min(lanes, set.length)) }, worker));
	return results;
}

function read(clf: Classifier, res: JevResult): Reading | null {
	const answer = res.ok ? res.answers[clf.id] : undefined;
	if (answer === undefined) return null;
	try {
		return readAnswer(clf, answer);
	} catch {
		return null;
	}
}

interface Tally {
	noSignal: number;
	right: number;
	unsure: number;
	over: number;
	under: number;
	confusion: RouteBacktest["confusion"];
}

/** Tally one held-out reading; below `confident` is unsure, never a miss. */
function tally(clf: Classifier, t: Tally, expect: string, reading: Reading | null): void {
	if (reading === null) {
		t.noSignal++;
		return;
	}
	const order = (l: string): number => clf.policy[l]?.order ?? 99;
	const trusted = reading.confidence >= clf.confident;
	if (reading.label === expect) t.right++;
	const got = trusted ? reading.label : "unsure";
	const row = t.confusion[expect] ?? {};
	row[got] = (row[got] ?? 0) + 1;
	t.confusion[expect] = row;
	if (!trusted) t.unsure++;
	else if (order(reading.label) > order(expect)) t.over++;
	else if (order(reading.label) < order(expect)) t.under++;
}

async function backtestImpl(
	clf: Classifier,
	heldout: Example[],
	ask: Ask = askJev,
	concurrency = 4,
): Promise<RouteBacktest> {
	const labels = clf.type === "noul" ? ["yes", "no"] : Object.keys(clf.criteria);
	for (const ex of heldout) {
		if (!labels.includes(ex.expect)) {
			throw new Error(`expect ${ex.expect} is not one of ${labels.join(", ")}`);
		}
	}
	const results = await askAll(clf, heldout, ask, concurrency);
	const n = heldout.length;
	const cost = { questions: n, requests: n, ms: 0, input_tokens: 0 };
	const t: Tally = { noSignal: 0, right: 0, unsure: 0, over: 0, under: 0, confusion: {} };
	results.forEach((res, i) => {
		cost.ms += res.ms;
		if (res.ok) cost.input_tokens += res.inputTokens;
		tally(clf, t, (heldout[i] as Example).expect, read(clf, res));
	});
	const signal = n - t.noSignal;
	const trusted = signal - t.unsure;
	return {
		classifier: clf.id,
		version: clf.version,
		examples: n,
		no_signal: t.noSignal,
		accuracy: signal === 0 ? 0 : round3(t.right / signal),
		trusted,
		unsure_rate: signal === 0 ? 0 : round3(t.unsure / signal),
		false_escalation_rate: rate(t.over, trusted),
		under_route_rate: rate(t.under, trusted),
		confusion: t.confusion,
		cost,
	};
}
export const backtest = traced("jev.backtest", backtestImpl);

export const summaryLine = traced(
	"jev.summaryLine",
	(r: RouteBacktest): string =>
		`model-route heldout: accuracy=${r.accuracy} false_escalation=${r.false_escalation_rate} under_route=${r.under_route_rate} unsure=${r.unsure_rate} n=${r.examples}`,
);
