/**
 * @module actions/jev-advise
 * @description Advisory Jev classifier lines for issue-triage and pr-review
 *   (D2/D5/D6).
 *
 *   ADVISORY ONLY. A verdict never gates a lane: every Jev outcome exits 0.
 *   The TypeSafe key reaches this step only, never the agent job. A fault (no
 *   key, network, timeout, field mismatch) is NO_SIGNAL. Only the fixed-shape
 *   line (`ADVICE_LINE_RE`) is ever posted; no input text ever leaves it.
 *
 *   Usage: bun scripts/actions/jev-advise.ts <issue|pr> <input> <out-file> <classifier-id>...
 *   `issue` reads Forge issue JSON; `pr` reads a directory holding `pr.diff`
 *   and optionally `pr.json`. One line per classifier is appended to out-file.
 *   Exit 0 on every Jev outcome, 3 on bad arguments, an unreadable input, or
 *   an unknown classifier id.
 *
 * @outputs
 *   - `adviceFields` -- mode + input path -> classifier fields
 *   - `adviseOne` -- classifier id + fields -> the advice line
 *   - `parseAdviceLines` / `ADVICE_LINE_RE` -- the posted lines
 */
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	type Ask,
	type Classifier,
	classify,
	loadClassifier,
	questionFor,
} from "../../src/jev/classifier";
import { traced } from "../../src/log";

const BODY_CAP = 4000;
const DIFF_CAP = 4000;
const FILES_CAP = 2000;
const MAX_LINES = 4;

export const ADVICE_LINE_RE =
	/^jev [a-z0-9-]+ v\d+ \(advisory\): [A-Z_]{2,20}( [01]\.\d{2})?( \([A-Za-z0-9 .;]{1,80}\))?$/;

const str = (v: unknown): string => (typeof v === "string" ? v : "");

async function adviceFieldsImpl(
	mode: "issue" | "pr",
	input: string,
): Promise<Record<string, string>> {
	if (mode === "issue") {
		const issue = JSON.parse(await readFile(input, "utf8")) as { title?: unknown; body?: unknown };
		return { title: str(issue.title), body: str(issue.body).slice(0, BODY_CAP) };
	}
	const diff = await readFile(join(input, "pr.diff"), "utf8");
	let title = "";
	try {
		const pr = JSON.parse(await readFile(join(input, "pr.json"), "utf8")) as { title?: unknown };
		title = str(pr.title);
	} catch {
		title = "";
	}
	const files = [...diff.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((m) => m[1]).join("\n");
	return { title, files: files.slice(0, FILES_CAP), diff: diff.slice(0, DIFF_CAP) };
}
// The result carries untrusted title, body, and diff text: never traced (PR 1063 review).
export const adviceFields = traced("actions.adviceFields", adviceFieldsImpl, {
	redact: { result: true },
});

function lineFor(
	clf: Classifier,
	verdict: string,
	confidence: number | null,
	note: string,
): string {
	const conf = confidence === null ? "" : ` ${confidence.toFixed(2)}`;
	const n = note === "" ? "" : ` (${note})`;
	return `jev ${clf.id} v${clf.version} (advisory): ${verdict}${conf}${n}`;
}

/** The verdict of the policy entry acted on most freely (lowest `order`), or null when none is ordered. */
function freestVerdict(clf: Classifier): string | null {
	const ordered = Object.values(clf.policy).filter((p) => p.order !== undefined);
	if (ordered.length === 0) return null;
	return ordered.reduce((a, b) => ((b.order ?? 99) < (a.order ?? 99) ? b : a)).verdict;
}

/**
 * `partial` is true when the input was capped before classification. A capped input
 * cannot vouch for what was cut, so a result at the freest verdict (LIGHT review,
 * READY to implement) becomes the unsure verdict, and every line says so (the
 * PR 1062 review rule for the screen, applied here too).
 */
async function adviseOneImpl(
	clfId: string,
	fields: Record<string, string>,
	ask?: Ask,
	partial = false,
): Promise<string> {
	const clf = await loadClassifier(clfId);
	try {
		questionFor(clf, fields);
	} catch {
		return lineFor(clf, clf.no_signal.verdict, null, "field mismatch");
	}
	const v = await classify(clf, fields, ask);
	const cut = partial ? "partial input" : "";
	if (!v.signal) return lineFor(clf, v.verdict, null, "no Jev signal");
	if (partial && v.verdict === freestVerdict(clf)) {
		return lineFor(clf, clf.unsure.verdict, v.confidence, cut);
	}
	if (v.verdict === clf.unsure.verdict) {
		const below = `below ${clf.confident}`;
		return lineFor(clf, v.verdict, v.confidence, partial ? `${below}; ${cut}` : below);
	}
	return lineFor(clf, v.verdict, v.confidence, cut);
}

/** True when `adviceFields` would cap the input (body, files list, or diff). */
async function inputCappedImpl(mode: "issue" | "pr", input: string): Promise<boolean> {
	if (mode === "issue") {
		const issue = JSON.parse(await readFile(input, "utf8")) as { body?: unknown };
		return str(issue.body).length > BODY_CAP;
	}
	const diff = await readFile(join(input, "pr.diff"), "utf8");
	const files = [...diff.matchAll(/^diff --git a\/\S+ b\/(\S+)$/gm)].map((m) => m[1]).join("\n");
	// A PR is partial only when its FILE LIST was cut: the paths carry the risk
	// signal (workflows, migrations, tokens, deploy code) and stay whole when only
	// the diff excerpt is trimmed. Judging by the diff made almost every real PR
	// partial and LIGHT unreachable (PR 1063 review).
	return files.length > FILES_CAP;
}
export const inputCapped = traced("actions.inputCapped", inputCappedImpl);
export const adviseOne = traced("actions.adviseOne", adviseOneImpl, { redact: { args: [1] } });

function parseAdviceLinesImpl(text: string, max = MAX_LINES): string[] {
	return text
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => ADVICE_LINE_RE.test(l))
		.slice(0, max);
}
export const parseAdviceLines = traced("actions.parseAdviceLines", parseAdviceLinesImpl, {
	redact: { args: [0] },
});

if (import.meta.main) {
	const [mode, input, out, ...ids] = process.argv.slice(2);
	if ((mode !== "issue" && mode !== "pr") || !input || !out || ids.length === 0) {
		process.stderr.write("usage: jev-advise.ts <issue|pr> <input> <out-file> <classifier-id>...\n");
		process.exit(3);
	}
	for (const id of ids) {
		try {
			await loadClassifier(id);
		} catch {
			process.stderr.write(`jev-advise: unknown classifier ${id}\n`);
			process.exit(3);
		}
	}
	let fields: Record<string, string>;
	let partial: boolean;
	try {
		fields = await adviceFields(mode, input);
		partial = await inputCapped(mode, input);
	} catch {
		process.stderr.write("jev-advise: input unreadable or not valid JSON\n");
		process.exit(3);
	}
	for (const id of ids) {
		const line = await adviseOne(id, fields, undefined, partial);
		await appendFile(out, `${line}\n`);
		process.stdout.write(`${line}\n`);
	}
}
