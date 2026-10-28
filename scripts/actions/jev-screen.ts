/**
 * @module actions/jev-screen
 * @description Screen untrusted lane input for prompt injection with the
 *   `lane-input-injection` Jev classifier (D1).
 *
 *   ADVISORY ONLY. The verdict never blocks a lane: every Jev outcome exits 0.
 *   The TypeSafe key reaches this step only, never the agent job. A fault (no
 *   key, network, timeout) is NO_SIGNAL and never reads as CLEAN. The one line
 *   this step writes is the only thing posted; no input text ever leaves it.
 *
 *   Usage: bun scripts/actions/jev-screen.ts <issue|diff> <input-file> <out-file>
 *   `issue` reads Forge issue JSON (title + body); `diff` reads raw text.
 *   Exit 0 on every Jev outcome, 3 on bad arguments or an unreadable input.
 *
 * @outputs
 *   - `chunkText` -- text -> at most `limit` chunks of at most `max` chars
 *   - `screenText` -- source + text -> aggregated `ScreenResult`
 *   - `formatScreenLine` / `parseScreenLine` / `SCREEN_LINE_RE` -- the posted line
 */
import { readFile, writeFile } from "node:fs/promises";
import { type Ask, classify, loadClassifier } from "../../src/jev/classifier";
import { traced } from "../../src/log";

export type ScreenVerdict = "CLEAN" | "INJECTION" | "UNSURE" | "NO_SIGNAL";
export interface ScreenResult {
	verdict: ScreenVerdict;
	confidence: number | null;
	notes: string[];
	classifier: string;
	version: number;
}
type Source = "issue body" | "PR diff";

const CLASSIFIER_ID = "lane-input-injection";
const CHUNK_MAX = 6000;
const CHUNK_LIMIT = 6;
const NEWLINE_WINDOW = 1000;

export const SCREEN_LINE_RE =
	/^jev screen \(advisory, [a-z0-9-]+ v\d+\): (CLEAN|INJECTION|UNSURE|NO_SIGNAL)( [01]\.\d{2})?( \([A-Za-z0-9 ;]{1,80}\))?$/;

function chunkTextImpl(
	text: string,
	max = CHUNK_MAX,
	limit = CHUNK_LIMIT,
): { chunks: string[]; truncated: boolean } {
	const chunks: string[] = [];
	let pos = 0;
	while (pos < text.length && chunks.length < limit) {
		let end = Math.min(pos + max, text.length);
		if (end < text.length) {
			const nl = text.lastIndexOf("\n", end - 1);
			if (nl >= end - NEWLINE_WINDOW && nl > pos) end = nl + 1;
		}
		chunks.push(text.slice(pos, end));
		pos = end;
	}
	return { chunks, truncated: pos < text.length };
}
export const chunkText = traced("actions.chunkText", chunkTextImpl, { redact: { args: [0] } });

function aggregate(verdicts: { verdict: string; confidence: number }[]): {
	verdict: ScreenVerdict;
	confidence: number | null;
} {
	const of = (v: string): number[] =>
		verdicts.filter((x) => x.verdict === v).map((x) => x.confidence);
	const injection = of("INJECTION");
	if (injection.length > 0) return { verdict: "INJECTION", confidence: Math.max(...injection) };
	const unsure = of("UNSURE");
	if (unsure.length > 0) return { verdict: "UNSURE", confidence: Math.min(...unsure) };
	if (of("NO_SIGNAL").length > 0) return { verdict: "NO_SIGNAL", confidence: null };
	return { verdict: "CLEAN", confidence: Math.min(...of("CLEAN")) };
}

async function screenTextImpl(source: Source, text: string, ask?: Ask): Promise<ScreenResult> {
	// Any thrown error (the classifier file, the loader, a classify fault) is a
	// NO_SIGNAL result, so the step always writes its line (PR 1062 review, P1).
	try {
		return await screenOrThrow(source, text, ask);
	} catch {
		return {
			classifier: CLASSIFIER_ID,
			version: 0,
			verdict: "NO_SIGNAL",
			confidence: null,
			notes: ["screen error"],
		};
	}
}

async function screenOrThrow(source: Source, text: string, ask?: Ask): Promise<ScreenResult> {
	const clf = await loadClassifier(CLASSIFIER_ID);
	const base = { classifier: clf.id, version: clf.version };
	if (text.length === 0) return { ...base, verdict: "CLEAN", confidence: null, notes: ["empty"] };
	const { chunks, truncated } = chunkText(text);
	const verdicts: { verdict: string; confidence: number }[] = [];
	for (const chunk of chunks) {
		verdicts.push(await classify(clf, { source, text: chunk }, ask));
	}
	const agg = aggregate(verdicts);
	// A partial screen cannot vouch for the unscreened tail: an all-clean
	// truncated input is UNSURE, never CLEAN (PR 1062 review, P2).
	const verdict: ScreenVerdict = truncated && agg.verdict === "CLEAN" ? "UNSURE" : agg.verdict;
	const notes: string[] = [];
	if (truncated) notes.push(`first ${CHUNK_MAX * CHUNK_LIMIT} chars`);
	if (verdict === "NO_SIGNAL") notes.push("no Jev signal");
	return { ...base, verdict, confidence: agg.confidence, notes };
}
export const screenText = traced("actions.screenText", screenTextImpl, {
	redact: { args: [1] },
});

function formatScreenLineImpl(r: ScreenResult): string {
	const conf = r.confidence === null ? "" : ` ${r.confidence.toFixed(2)}`;
	const note = r.notes.length === 0 ? "" : ` (${r.notes.join("; ")})`;
	return `jev screen (advisory, ${r.classifier} v${r.version}): ${r.verdict}${conf}${note}`;
}
export const formatScreenLine = traced("actions.formatScreenLine", formatScreenLineImpl);

function parseScreenLineImpl(raw: string): string | null {
	const line = raw.trim();
	return SCREEN_LINE_RE.test(line) ? line : null;
}
export const parseScreenLine = traced("actions.parseScreenLine", parseScreenLineImpl, {
	redact: { args: [0] },
});

async function readInput(mode: string, path: string): Promise<{ source: Source; text: string }> {
	const raw = await readFile(path, "utf8");
	if (mode === "diff") return { source: "PR diff", text: raw };
	const issue = JSON.parse(raw) as { title?: unknown; body?: unknown };
	const str = (v: unknown): string => (typeof v === "string" ? v : "");
	return { source: "issue body", text: `${str(issue.title)}\n\n${str(issue.body)}` };
}

if (import.meta.main) {
	const [mode, input, out] = process.argv.slice(2);
	if ((mode !== "issue" && mode !== "diff") || !input || !out || process.argv.length !== 5) {
		process.stderr.write("usage: jev-screen.ts <issue|diff> <input-file> <out-file>\n");
		process.exit(3);
	}
	let parsed: { source: Source; text: string };
	try {
		parsed = await readInput(mode, input);
	} catch {
		process.stderr.write("jev-screen: input file unreadable or not valid JSON\n");
		process.exit(3);
	}
	const line = formatScreenLine(await screenText(parsed.source, parsed.text));
	await writeFile(out, `${line}\n`);
	process.stdout.write(`${line}\n`);
}
