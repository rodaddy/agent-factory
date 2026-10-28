/**
 * @module github/publication-text
 * @description The outbound text boundary for every publication plan: the
 *   redact-then-escape pass over untrusted runner text, the conservative
 *   identity sanitizer, the hard cap, the bounded finding renderer, and the fixed
 *   status headline. Split out of `github/publication.ts` so every builder shares
 *   one text boundary rather than several.
 *
 *   The security property is unchanged by the move: runner text is redacted
 *   FIRST, then every Markdown/HTML structural character is escaped and
 *   @-mentions are broken, so a finding, a label name, or a request reason can
 *   never introduce a link, heading, list, tag, or notification into a body whose
 *   structure is author-controlled. Trusted identity values pass through the
 *   narrower charset sanitizer as defence-in-depth.
 *
 * @outputs
 *   - `STATUS_HEADLINE` -- the bounded human label per validated status
 *   - `sanitizeRunnerText` -- redact + escape untrusted runner text to inert Markdown
 *   - `sanitizeIdentity` -- conservative safe charset for trusted identity values
 *   - `capText` -- observable hard cap
 *   - `renderFindings` -- bounded, redacted finding lines with a truncation note
 *   - `renderCheckTrail` -- the bounded per-check trail for a proposal body
 *   - `renderCheckScope` -- the bounded scope clause naming which checks answered
 *
 * @dependencies
 *   - ../log -- the one logger, for the traced() wrapper
 *   - ../results/ingest -- redactSecrets, applied before every escape
 *   - ../results/check-trail -- the allowance names flagged in the rendered trail
 *   - ./publication-types -- the outbound caps
 */
import { traced } from "../log";
import type { DegradedCheck } from "../results/check-trail";
import { redactSecrets } from "../results/ingest";
import type { ResultCheck, RunnerResult } from "../results/schema";
import { CAPS } from "./publication-types";

/** Bounded human label for a result status, used inside fixed templates. */
export const STATUS_HEADLINE: Record<RunnerResult["status"], string> = {
	passed: "passed",
	failed: "failed",
	error: "errored",
	skipped: "skipped",
};

/**
 * Render bounded, redacted finding lines from the validated result. Each line is
 * hard-capped and the count is capped; a truncation note is appended when the
 * runner surfaced more findings than the cap allows.
 */
export const renderFindings = traced(
	"github.renderFindings",
	function renderFindings(result: RunnerResult): string[] {
		const shown = result.findings.slice(0, CAPS.findings);
		const lines = shown.map((f) => {
			const title = sanitizeRunnerText(f.title);
			const loc = f.location ? ` (${sanitizeRunnerText(f.location)})` : "";
			return capText(`- [${f.severity}] ${title}${loc}`, CAPS.findingLine);
		});
		if (result.findings.length > CAPS.findings) {
			lines.push(`- …${result.findings.length - CAPS.findings} more finding(s) omitted`);
		}
		return lines;
	},
	// BOTH ENDS. The returned lines ARE the runner's finding titles and locations,
	// rebuilt from `sanitizeRunnerText` and `capText` -- the two functions above
	// and below that are themselves only as safe as a finite pattern list. Masking
	// arg 0 alone just moves the same text to the `.exit` line. Probed: `.exit`
	// emitted `["- [high] tok m2c\_AAAA… end (tok m2c\_AAAA… end)"]`.
	{ redact: { args: [0], result: true } },
);

/**
 * Render the bounded check trail for a proposal body.
 *
 * THIS IS THE FIRST RUNNER-SUPPLIED DISPLAY TEXT IN A PROPOSAL BODY, and it is
 * bounded on three axes rather than one:
 *
 *   - **Count.** At most `CAPS.trailChecks` rows are rendered, with an explicit
 *     "…and K more" line when the runner sent more. The schema already caps
 *     `checks` at 100; rendering all of them would consume the entire body
 *     budget and let `capText` truncate the section mid-row, silently dropping
 *     the very rows most likely to carry a degraded entry.
 *   - **Width.** Each name and summary is capped individually, so no single
 *     pathological field can crowd out the rest of the table.
 *   - **Content.** Every runner field passes through `sanitizeRunnerText`, which
 *     redacts secrets first and then escapes Markdown/HTML structure, so a check
 *     summary cannot introduce a link, a heading, or a table row of its own.
 *
 * Degraded-but-allowed rows are flagged with `⚠` and the ALLOWANCE NAME, so the
 * human at merge time sees exactly which holes in the trail were tolerated and
 * on whose authority — the point of the ruling.
 *
 * @param checks - the validated per-check trail from the persisted result
 * @param degraded - the allowance uses gate 0 recorded for this result
 * @returns bounded Markdown lines, or an empty array when there is no trail
 */
export const renderCheckTrail = traced(
	"github.renderCheckTrail",
	function renderCheckTrail(
		checks: readonly ResultCheck[],
		degraded: readonly DegradedCheck[],
	): string[] {
		if (checks.length === 0) {
			return [];
		}
		const allowanceByCheck = new Map(degraded.map((entry) => [entry.check, entry.allowance]));
		const shown = checks.slice(0, CAPS.trailChecks);
		const lines = shown.map((check) => {
			const name = capText(sanitizeRunnerText(check.name), CAPS.trailName);
			// The allowance is looked up by the check's own name; the VALUE is an
			// author-controlled constant from the allowance list, never runner text.
			const allowance = allowanceByCheck.get(check.name);
			const flag = allowance === undefined ? "" : ` ⚠ allowed by \`${allowance}\``;
			const summary = check.summary
				? ` — ${capText(sanitizeRunnerText(check.summary), CAPS.trailSummary)}`
				: "";
			return `- \`${check.status}\` **${name}**${flag}${summary}`;
		});
		if (checks.length > shown.length) {
			lines.push(`- …and ${checks.length - shown.length} more check(s) not shown`);
		}
		return lines;
	},
	// BOTH ENDS, for the same reason as `renderFindings`: the returned rows carry
	// the runner's own check names and summaries. Probed: `.exit` emitted
	// ``["- `pass` **tok m2c\_AAAA… end** — …"]``.
	{ redact: { args: [0], result: true } },
);

/**
 * Render the scope clause for a status summary: WHICH checks answered.
 *
 * A verdict of "passed" with no scope is read as *this PR is good*. What it
 * actually means is *the checks in this lane passed*, and the lane is narrower
 * than the repo. On rtech-infra PR #1453 that gap let two real regressions
 * through under a truthful green: `projects/ansible/tests/rodaddy_watcher/`
 * was never in the lane, so the lane was never asked, and the reader could not
 * tell from the verdict. The check was right; its title overclaimed.
 *
 * The names come from the VERIFIED result's own trail rather than from a static
 * per-job label, because the scope is not static: an `infra-static` job selects
 * its gates per-PR from the changed paths (`selectGates`), so a fixed label
 * would advertise coverage a given run did not have — a worse lie than the bare
 * verdict it replaced.
 *
 * THE EMPTY CASE IS THE WHOLE POINT. A trail can be empty because the runner
 * sent none, and an absent input must never render as reassurance: this returns
 * an explicit "no check trail" clause rather than the empty string, so a caller
 * appending it cannot silently reproduce the unqualified verdict this function
 * exists to eliminate. That is the absent-input-PASS family (rtech-infra #1607)
 * — a clause whose quiet branch means "nothing bad found" also fires when there
 * was nothing to look at.
 *
 * Names go through `sanitizeIdentity`, NOT `sanitizeRunnerText`, because the
 * primary consumer is a forge STATUS DESCRIPTION, which is plain text: the
 * Markdown escaping would be rendered literally there, publishing
 * `ansible\-lint` to the reader this clause exists to inform. Dropping unsafe
 * characters is also strictly safer than escaping them, and a check name is a
 * command's `name=` field — already a plain token by construction — so the
 * conservative charset costs nothing real. The clause stays inert in the
 * comment surface too, where it IS Markdown.
 */
export const renderCheckScope = traced(
	"github.renderCheckScope",
	function renderCheckScope(checks: readonly ResultCheck[]): string {
		if (checks.length === 0) {
			return "no check trail reported, scope unknown";
		}
		// SANITIZE THE WHOLE TRAIL BEFORE CAPPING. Capping first and filtering
		// second loses a real name whenever the unusable ones happen to sort early:
		// six unnameable checks followed by `shellcheck` reported "7 unnamed
		// check(s)" and hid a name that was right there. That is this function's own
		// defect — a scope clause concealing scope — caught in review on PR #717.
		const named = checks
			.map((check) => capText(sanitizeIdentity(check.name), CAPS.trailName))
			.filter((name) => name !== "");
		// Only when NO check in the entire trail has a usable name. The count is of
		// the whole trail, so it is never an undercount of what ran.
		if (named.length === 0) {
			return `covered: ${checks.length} unnamed check(s)`;
		}
		const shown = named.slice(0, CAPS.scopeChecks);
		// The remainder covers both halves of what is not listed: names past the cap
		// AND checks whose name did not survive sanitizing. Counting from the full
		// trail keeps the total honest however the two divide.
		const remainder = checks.length - shown.length;
		const more = remainder > 0 ? `, +${remainder} more` : "";
		return `covered: ${shown.join(", ")}${more}`;
	},
	{ redact: { args: [0] } },
);

/**
 * Render untrusted runner text as inert Markdown text. Redact first, then escape
 * every Markdown/HTML structural character and break @-mentions so findings can
 * never introduce links, headings, lists, tags, or notifications.
 */
export const sanitizeRunnerText = traced(
	"github.sanitizeRunnerText",
	function sanitizeRunnerText(value: string): string {
		const withoutControls = Array.from(redactSecrets(value), (char) => {
			const code = char.charCodeAt(0);
			return code < 32 || code === 127 ? " " : char;
		}).join("");
		return withoutControls
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/@/g, "@​")
			.replace(/[\\`*{}[\]()#+.!_|~-]/g, "\\$&")
			.replace(/\s+/g, " ")
			.trim();
	},
	// BOTH ENDS. The escaping this does is a MARKDOWN-STRUCTURE control, not a
	// secret control: it stops runner text introducing a link or a heading, and it
	// does nothing whatsoever to a credential. The only redaction here is the
	// `redactSecrets` call, which is a FIXED pattern list that misses a bare
	// 40-hex Forgejo token.
	{ redact: { args: [0], result: true } },
);

/**
 * Cap a string to `max` characters, appending an ellipsis marker when it is
 * truncated so the bound is observable rather than silent.
 */
export const capText = traced(
	"github.capText",
	function capText(value: string, max: number): string {
		if (value.length <= max) {
			return value;
		}
		return `${value.slice(0, Math.max(0, max - 1))}…`;
	},
	// BOTH ENDS. This function only TRUNCATES -- it redacts nothing -- so its
	// return is exactly as sensitive as the argument masked above, and masking
	// one end only moves the same text to the other trace line. Callers wrap it
	// around redactSecrets(...), but that is a FIXED pattern list and misses a
	// bare 40-hex Forgejo token, so "already redacted" is not the same
	// as safe.
	{ redact: { args: [0], result: true } },
);

/**
 * Reduce a trusted identity value to a conservative safe charset before it is
 * embedded in a fixed template. These values are already validated upstream;
 * this strips markdown/HTML control characters as defence-in-depth so a value
 * can never introduce structure into the fixed body.
 */
export const sanitizeIdentity = traced(
	"github.sanitizeIdentity",
	function sanitizeIdentity(value: string): string {
		return value.replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 120);
	},
);
