/**
 * @module src/jev/classifier
 * @description Data-driven Jev classifiers. A classifier is a JSON
 *   file under `config/jev/classifiers/` holding one question, its confidence
 *   threshold, a label -> verdict policy, and labelled examples. `classify`
 *   turns one set of fields into a verdict; `calibrate` runs every example and
 *   reports whether the threshold separates right answers from wrong ones.
 *   Mirrors rtech-infra `tools/jev/src/jev_harness/classifier.py`.
 *
 *   NO SIGNAL IS NEVER A PASS: an `ok: false` from Jev yields the classifier's
 *   `no_signal` verdict with `signal: false`, never a policy verdict.
 *
 * @outputs
 *   - `loadClassifier` -- id or path -> validated `Classifier`
 *   - `questionFor` -- classifier + fields -> `JevQuestion`
 *   - `readAnswer` -- classifier + answer -> label and confidence
 *   - `classify` -- classifier + fields -> `Verdict`
 *   - `calibrate` -- classifier -> `CalibrationReport`
 *   - `CLASSIFIER_DIR` / `Ask` / `Classifier` / `Reading` / `Verdict` / `CalibrationReport`
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { traced } from "../log";
import { askJev, type JevAnswer, type JevQuestion, type JevResult } from "./client";

export type Ask = (state: unknown, questions: Record<string, JevQuestion>) => Promise<JevResult>;

export const CLASSIFIER_DIR = "config/jev/classifiers";

const outcomeSchema = z.object({ verdict: z.string(), why: z.string().optional() });
const levelSchema = z.union([
	z.string(),
	z.object({ what: z.string(), examples: z.array(z.string()).optional() }),
]);
const base = z.object({
	id: z.string().min(1),
	version: z.number(),
	about: z.string().optional(),
	ask: z.string().min(1),
	confident: z.number().min(0).max(1),
	policy: z.record(
		z.string(),
		z.object({ verdict: z.string(), order: z.number().optional(), why: z.string().optional() }),
	),
	unsure: outcomeSchema,
	no_signal: outcomeSchema,
	examples: z.array(z.object({ fields: z.record(z.string(), z.string()), expect: z.string() })),
});
const classifierSchema = z.discriminatedUnion("type", [
	base.extend({ type: z.literal("noul"), criteria: z.undefined().optional() }).loose(),
	base.extend({ type: z.literal("choice"), criteria: z.record(z.string(), z.string()) }).loose(),
	base.extend({ type: z.literal("score"), criteria: z.record(z.string(), levelSchema) }).loose(),
]);

export type Classifier = z.infer<typeof classifierSchema>;
export interface Reading {
	label: string;
	confidence: number;
}
export interface Verdict {
	signal: boolean;
	label: string | null;
	confidence: number;
	verdict: string;
	why: string;
}
export interface CalibrationReport {
	classifier: string;
	version: number;
	examples: number;
	accuracy: number;
	threshold_now: number;
	lowest_confidence_when_right: number | null;
	highest_confidence_when_wrong: number | null;
	separable: boolean;
	right_but_sent_to_unsure: number;
	wrong_and_trusted: number;
	unsafe_misses: number;
	no_signal: number;
	misses: { index: number; expect: string; got: string; confidence: number; unsafe: boolean }[];
	cost: { questions: number; requests: number; ms: number; input_tokens: number };
}

/** Rules zod cannot name: criteria presence. */
function checkRaw(name: string, raw: unknown): void {
	if (typeof raw !== "object" || raw === null) return;
	const { type, criteria } = raw as { type?: unknown; criteria?: unknown };
	if (type === "noul" && criteria !== undefined) {
		throw new Error(`classifier ${name}: a noul has no criteria; its labels are yes and no`);
	}
	if ((type === "choice" || type === "score") && criteria === undefined) {
		throw new Error(`classifier ${name}: a ${type} needs criteria`);
	}
}

/** Criteria counts, the policy label set, and verdict collisions. */
function checkParsed(clf: Classifier): void {
	const labels = clf.type === "noul" ? ["yes", "no"] : Object.keys(clf.criteria);
	if (clf.type === "choice" && labels.length < 2) {
		throw new Error(`classifier ${clf.id}: a choice needs at least 2 criteria`);
	}
	if (clf.type === "score" && (labels.length < 2 || labels.length > 10)) {
		throw new Error(`classifier ${clf.id}: a score needs 2 to 10 criteria`);
	}
	const policy = Object.keys(clf.policy);
	if (policy.length !== labels.length || !labels.every((l) => Object.hasOwn(clf.policy, l))) {
		throw new Error(`classifier ${clf.id}: policy labels must be ${labels.join(", ")}`);
	}
	const verdicts = new Set(Object.values(clf.policy).map((p) => p.verdict));
	for (const key of ["no_signal", "unsure"] as const) {
		const v = clf[key].verdict;
		if (verdicts.has(v)) {
			throw new Error(`classifier ${clf.id}: ${key} verdict ${v} equals a policy verdict`);
		}
	}
}

async function loadClassifierImpl(idOrPath: string): Promise<Classifier> {
	const path =
		idOrPath.includes("/") || idOrPath.endsWith(".json")
			? idOrPath
			: join(import.meta.dir, "..", "..", CLASSIFIER_DIR, `${idOrPath}.json`);
	const raw: unknown = JSON.parse(await readFile(path, "utf8"));
	const id = (raw as { id?: unknown } | null)?.id;
	const name = typeof id === "string" ? id : idOrPath;
	checkRaw(name, raw);
	const parsed = classifierSchema.safeParse(raw);
	if (!parsed.success) {
		throw new Error(`classifier ${name}: invalid (${parsed.error.issues.length} issues)`);
	}
	checkParsed(parsed.data);
	return parsed.data;
}
export const loadClassifier = traced("jev.loadClassifier", loadClassifierImpl);

export function questionFor(clf: Classifier, fields: Record<string, string>): JevQuestion {
	const instructions = clf.ask.replace(/\{(\w+)\}/g, (_m, name: string) => {
		if (!Object.hasOwn(fields, name))
			throw new Error(`classifier ${clf.id}: missing field ${name}`);
		return fields[name] as string;
	});
	if (clf.type === "noul") return { type: "noul", instructions };
	if (clf.type === "choice") return { type: "choice", instructions, criteria: clf.criteria };
	// The classifier keys levels by label (low to high); the API takes the ordered list.
	return { type: "score", instructions, criteria: Object.values(clf.criteria) };
}

export function readAnswer(clf: Classifier, answer: JevAnswer): Reading {
	if (answer.type === "noul") {
		return {
			label: answer.noul >= 0.5 ? "yes" : "no",
			confidence: Math.max(answer.noul, 1 - answer.noul),
		};
	}
	if (answer.type === "choice") return { label: answer.choice, confidence: answer.confidence };
	const levels = clf.type === "noul" ? [] : Object.keys(clf.criteria);
	const label = levels[Math.round(answer.score)];
	if (label === undefined) {
		throw new Error(`classifier ${clf.id}: score ${answer.score} outside ${levels.length} levels`);
	}
	return { label, confidence: answer.confidence };
}

function verdictFor(clf: Classifier, result: JevResult): Verdict {
	if (!result.ok) {
		return {
			signal: false,
			label: null,
			confidence: 0,
			verdict: clf.no_signal.verdict,
			why: clf.no_signal.why ?? "no Jev signal",
		};
	}
	const answer = result.answers[clf.id];
	if (answer === undefined)
		return verdictFor(clf, { ok: false, error: "no answer", ms: result.ms });
	let reading: Reading;
	try {
		reading = readAnswer(clf, answer);
	} catch {
		return verdictFor(clf, { ok: false, error: "unreadable answer", ms: result.ms });
	}
	const { label, confidence } = reading;
	const policy = clf.policy[label];
	if (confidence < clf.confident || policy === undefined) {
		return {
			signal: true,
			label,
			confidence,
			verdict: clf.unsure.verdict,
			why: clf.unsure.why ?? `below ${clf.confident}`,
		};
	}
	return { signal: true, label, confidence, verdict: policy.verdict, why: policy.why ?? label };
}

async function classifyImpl(
	clf: Classifier,
	fields: Record<string, string>,
	ask: Ask = askJev,
): Promise<Verdict> {
	return verdictFor(clf, await ask(fields, { [clf.id]: questionFor(clf, fields) }));
}
export const classify = traced("jev.classify", classifyImpl, { redact: { args: [1] } });

async function runExamples(clf: Classifier, ask: Ask, concurrency: number): Promise<JevResult[]> {
	const results: JevResult[] = Array.from({ length: clf.examples.length });
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < clf.examples.length) {
			const i = next++;
			const ex = clf.examples[i] as Classifier["examples"][number];
			results[i] = await ask(ex.fields, { [clf.id]: questionFor(clf, ex.fields) });
		}
	};
	const lanes = Math.max(1, Math.min(concurrency, clf.examples.length));
	await Promise.all(Array.from({ length: lanes }, worker));
	return results;
}

/** Tally one example into the report; returns true when the reading was right. */
function tally(clf: Classifier, r: CalibrationReport, res: JevResult, index: number): boolean {
	r.cost.ms += res.ms;
	const answer = res.ok ? res.answers[clf.id] : undefined;
	if (!res.ok || answer === undefined) {
		r.no_signal++;
		return false;
	}
	r.cost.input_tokens += res.inputTokens;
	const expect = (clf.examples[index] as Classifier["examples"][number]).expect;
	let reading: Reading;
	try {
		reading = readAnswer(clf, answer);
	} catch {
		r.no_signal++;
		return false;
	}
	const { label, confidence } = reading;
	const trusted = confidence >= clf.confident;
	if (label === expect) {
		if (!trusted) r.right_but_sent_to_unsure++;
		const low = r.lowest_confidence_when_right;
		r.lowest_confidence_when_right = low === null ? confidence : Math.min(low, confidence);
		return true;
	}
	const order = (l: string): number => clf.policy[l]?.order ?? 99;
	const unsafe = trusted && order(label) < order(expect);
	if (trusted) r.wrong_and_trusted++;
	if (unsafe) r.unsafe_misses++;
	const high = r.highest_confidence_when_wrong;
	r.highest_confidence_when_wrong = high === null ? confidence : Math.max(high, confidence);
	r.misses.push({ index, expect, got: label, confidence, unsafe });
	return false;
}

async function calibrateImpl(
	clf: Classifier,
	ask: Ask = askJev,
	concurrency = 4,
): Promise<CalibrationReport> {
	const results = await runExamples(clf, ask, concurrency);
	const n = clf.examples.length;
	const r: CalibrationReport = {
		classifier: clf.id,
		version: clf.version,
		examples: n,
		accuracy: 0,
		threshold_now: clf.confident,
		lowest_confidence_when_right: null,
		highest_confidence_when_wrong: null,
		separable: true,
		right_but_sent_to_unsure: 0,
		wrong_and_trusted: 0,
		unsafe_misses: 0,
		no_signal: 0,
		misses: [],
		cost: { questions: n, requests: n, ms: 0, input_tokens: 0 },
	};
	const right = results.filter((res, i) => tally(clf, r, res, i)).length;
	const signal = n - r.no_signal;
	r.accuracy = signal === 0 ? 0 : Math.round((right / signal) * 1000) / 1000;
	const hw = r.highest_confidence_when_wrong;
	const lr = r.lowest_confidence_when_right;
	r.separable = hw === null || lr === null || hw < lr;
	return r;
}
export const calibrate = traced("jev.calibrate", calibrateImpl);
