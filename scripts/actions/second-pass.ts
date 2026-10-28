/**
 * @module scripts/actions/second-pass
 * @description The publisher's half of the adversarial second pass.
 *   The workflow's second-pass step writes `second-pass.json` (what was
 *   requested) plus a refuter and/or trust-surface checklist reply beside the
 *   pass-1 chunk replies; this module reads them and applies the fixed verdict
 *   rules to the merged pass-1 verdict.
 *
 *   Order is refute, then checklist. `error` stays `error` whatever the second
 *   pass says. A refuter that is unavailable leaves the pass-1 findings
 *   standing; a checklist that is unavailable fails CLOSED to `fix-first`,
 *   because a trust-surface diff nobody checked is not an approved one. An
 *   absent or unparseable plan changes nothing (backward compatible).
 *
 * @outputs
 *   - `SecondPassPlan` -- the parsed `second-pass.json`
 *   - `checklistComplete` -- checklist reply -> all seven rows pass or n/a
 *   - `applySecondPass` -- (verdict, plan, refute, checklist) -> { verdict, sections };
 *     a `diff_truncated` plan never downgrades and never checklist-approves
 *   - `readSecondPass` -- dir -> { plan, refute, checklist }; absent/invalid plan -> null
 */

import { traced } from "../../src/log";
import { extractReply, parseVerdict, type Verdict } from "./post-pr-review";

/** What the render step requested. */
export type SecondPassPlan = {
	refute: boolean;
	checklist: boolean;
	trust_files: string[];
	refute_skipped?: string;
	refute_findings?: number;
	diff_truncated?: boolean;
};

export const REFUTER_UNAVAILABLE = "Refuter unavailable: the pass-1 findings stand.";
export const DIFF_TRUNCATED =
	"Second pass saw a truncated diff: no downgrade, no checklist approval.";
export const CHECKLIST_UNAVAILABLE = "Checklist unavailable: fix-first on a trust-surface diff.";

/**
 * A downgrade needs per-finding evidence: an `approve` verdict, one
 * `- REFUTED:` line per pass-1 P0/P1 finding (`plan.refute_findings`, which
 * must be >= 1; absent or 0 fails closed), and no `- UPHELD:` line. A bare
 * `verdict: approve` is not a refutation.
 */
function refutesAll(text: string, plan: SecondPassPlan): boolean {
	const need = plan.refute_findings;
	if (typeof need !== "number" || need < 1) return false;
	const refuted = new Set(
		text
			.split("\n")
			.filter((line) => /^\s*[-*]\s*REFUTED:/.test(line))
			.map((line) => line.trim()),
	).size;
	return parseVerdict(text) === "approve" && refuted >= need && !/^\s*[-*]\s*UPHELD:/im.test(text);
}

/**
 * True only when each checklist item 1..7 has a table row whose first cell is
 * the item number and whose result cell is `pass` or `n/a`.
 */
function checklistCompleteImpl(text: string): boolean {
	const lines = text.split("\n");
	for (let n = 1; n <= 7; n++) {
		const row = new RegExp(`^\\|\\s*${n}\\s*\\|`);
		// Every row for item n must pass: a duplicate `pass` row cannot mask a `fail`.
		const rows = lines.filter((line) => row.test(line)).map((line) => line.split("|"));
		const ok = (cells: string[]): boolean => {
			const result = (cells[3] ?? "").trim().toLowerCase();
			const evidence = (cells[4] ?? "").trim();
			return (
				(result === "pass" || result === "n/a") &&
				evidence !== "" &&
				evidence !== "-" &&
				evidence !== "—"
			);
		};
		if (rows.length === 0 || !rows.every(ok)) return false;
	}
	return true;
}

// The text is engine output derived from an untrusted diff: redacted.
export const checklistComplete = traced(
	"actions.secondPass.checklistComplete",
	checklistCompleteImpl,
	{
		redact: { args: [0] },
	},
);

function applySecondPassImpl(
	verdict: Verdict,
	plan: SecondPassPlan | null,
	refuteReview: string | null,
	checklistReview: string | null,
): { verdict: Verdict; sections: string } {
	if (plan === null || (!plan.refute && !plan.checklist && plan.refute_skipped === undefined)) {
		return { verdict, sections: "" };
	}
	let v = verdict;
	const sections: string[] = [];
	const truncated = plan.diff_truncated === true;
	if (truncated) sections.push(DIFF_TRUNCATED);
	if (plan.refute_skipped !== undefined) {
		sections.push(
			`### Second pass: refuter\n\nRefuter skipped: ${plan.refute_skipped}. The pass-1 findings stand.`,
		);
	} else if (plan.refute) {
		const text = refuteReview ?? "";
		const r = parseVerdict(text);
		if (!truncated && v === "fix-first" && refutesAll(text, plan)) v = "approve";
		sections.push(`### Second pass: refuter\n\n${r === "error" ? REFUTER_UNAVAILABLE : text}`);
	}
	if (plan.checklist) {
		const text = checklistReview ?? "";
		const c = parseVerdict(text);
		if (v !== "error" && (truncated || !(c === "approve" && checklistComplete(text)))) {
			v = "fix-first";
		}
		const n = plan.trust_files.length;
		sections.push(
			`### Second pass: trust-surface checklist (${n} file(s))\n\n${c === "error" ? CHECKLIST_UNAVAILABLE : text}`,
		);
	}
	return { verdict: v, sections: sections.join("\n\n") };
}

/**
 * The second pass goes FIRST: comment truncation cuts the end, so it can
 * never hide the second pass behind a long pass-1 body.
 */
function withSecondPassImpl(review: string, sections: string): string {
	return sections === "" ? review : `${sections}\n\n---\n\n${review}`;
}

// Both arguments and the result are engine output from an untrusted diff: redacted.
export const withSecondPass = traced("actions.secondPass.with", withSecondPassImpl, {
	redact: { args: [0, 1], result: true },
});

export const applySecondPass = traced("actions.secondPass.apply", applySecondPassImpl, {
	redact: { args: [2, 3], result: true },
});

function isPlan(value: unknown): value is SecondPassPlan {
	if (typeof value !== "object" || value === null) return false;
	const p = value as Record<string, unknown>;
	return (
		typeof p.refute === "boolean" &&
		typeof p.checklist === "boolean" &&
		Array.isArray(p.trust_files) &&
		p.trust_files.every((f) => typeof f === "string") &&
		(p.refute_skipped === undefined || typeof p.refute_skipped === "string") &&
		(p.refute_findings === undefined ||
			(Number.isInteger(p.refute_findings) && (p.refute_findings as number) >= 0)) &&
		(p.diff_truncated === undefined || typeof p.diff_truncated === "boolean")
	);
}

async function readText(path: string): Promise<string | null> {
	const file = Bun.file(path);
	return (await file.exists()) ? await file.text() : null;
}

async function readSecondPassImpl(
	dir: string,
): Promise<{ plan: SecondPassPlan | null; refute: string | null; checklist: string | null }> {
	let plan: SecondPassPlan | null = null;
	const rawPlan = await readText(`${dir}/second-pass.json`);
	if (rawPlan !== null) {
		try {
			const parsed: unknown = JSON.parse(rawPlan);
			if (isPlan(parsed)) plan = parsed;
		} catch {
			plan = null;
		}
	}
	const rawRefute = await readText(`${dir}/refute-reply.json`);
	const rawChecklist = await readText(`${dir}/checklist-reply.json`);
	return {
		plan,
		refute: rawRefute === null ? null : extractReply(rawRefute),
		checklist: rawChecklist === null ? null : extractReply(rawChecklist),
	};
}

// The replies are engine output derived from an untrusted diff: redacted.
export const readSecondPass = traced("actions.secondPass.read", readSecondPassImpl, {
	redact: { result: true },
});
