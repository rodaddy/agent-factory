/**
 * @module github/publication-comment
 * @description The comment plan builders: the single deduplicated result comment,
 *   and the issue-triage lane's variant that appends the selected-labels
 *   and requested-labels sections and OPENS with the acknowledgment header.
 *  Split out of `github/publication.ts` as the comment-rendering region.
 *
 *   Two properties the move preserves. First, the template structure is
 *   author-controlled: every heading, the hidden marker, and the exact-SHA
 *   "Reviewed at" line come from here, and runner text only ever appears inside
 *   bounded, redacted, escaped lines. Second, the triage comment states INTENT,
 *   not completion — it is written at PLAN time, before the separate label
 *   posting runs (which can fail independently, and once did), so it must
 *   not claim a mutation it cannot observe.
 *
 *   The factory-side allowlist filter also lives here: a runner-chosen label that
 *   the repository's trusted config allowlist lacks produces NO label plan and is
 *   demoted into the comment's request block instead, so untrusted output can
 *   never invent a forge label mutation.
 *
 * @outputs
 *   - `buildComment` -- the single deduplicated result comment plan
 *   - `buildTriageComment` -- the triage variant with selected/requested sections
 *   - `allowlistedChosenLabels` -- the trusted-allowlist intersection used by both
 *     the comment and the label-plan fan-out
 *
 * @dependencies
 *   - ./publication-types -- caps, the comment target, and the plan shapes
 *   - ./publication-text -- the outbound redaction/escape/cap boundary
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { traced } from "../log";
import { redactSecrets } from "../results/ingest";
import type { RunnerResult } from "../results/schema";
import {
	capText,
	renderCheckScope,
	renderCheckTrail,
	renderFindings,
	STATUS_HEADLINE,
	sanitizeIdentity,
	sanitizeRunnerText,
} from "./publication-text";
import {
	CAPS,
	COMMENT_TARGET,
	type CommentPlan,
	commentDedupeKey,
	type JobIdentity,
	type ReceiptSpec,
	receiptSatisfied,
	receiptSpecFor,
} from "./publication-types";
import { signatureLine } from "./signature";

/**
 * The runner-chosen triage labels that ARE in the repository's config allowlist.
 * This is the factory-side filter: a trusted allowlist intersected with
 * the untrusted `result.triage.labels`, de-duplicated so the same name never
 * yields two add plans. A label the runner named that is not allowlisted is
 * dropped here (and surfaced as a request line in the comment) — the runner can
 * only SELECT from the fixed set, never introduce a name.
 */
export const allowlistedChosenLabels = traced(
	"github.allowlistedChosenLabels",
	function allowlistedChosenLabels(
		result: RunnerResult,
		triageAllowlist: readonly string[],
	): string[] {
		const allowed = new Set(triageAllowlist);
		const chosen = result.triage?.labels ?? [];
		const out: string[] = [];
		const seen = new Set<string>();
		for (const label of chosen) {
			if (allowed.has(label) && !seen.has(label)) {
				seen.add(label);
				out.push(label);
			}
		}
		return out;
	},
);

/** Build the single deduplicated comment plan for the trusted item. */
export const buildComment = traced(
	"github.buildComment",
	function buildComment(
		identity: JobIdentity,
		result: RunnerResult,
		status: RunnerResult["status"],
	): CommentPlan {
		const dedupeKey = commentDedupeKey(identity);
		const findings = renderFindings(result);
		// Fixed template structure. Runner text only appears inside bounded, redacted
		// finding lines; every heading and the marker are author-controlled.
		const lines = [
			`<!-- ${dedupeKey} -->`,
			// sf#369: the attribution line opens every factory-authored body. Marker
			// stays line 1 (invisible, and the dedupe scan is substring-based anyway);
			// the signature is the first thing a reader sees. No model is in scope here.
			signatureLine(),
			`### software-factory: ${STATUS_HEADLINE[status]}`,
			// Scope travels with the verdict here too. Fixing only the status
			// check would leave the same unqualified "passed" on the comment, which is
			// the surface a human actually reads.
			`Job \`${sanitizeIdentity(identity.jobType)}\` for \`${sanitizeIdentity(identity.repository)}\` ${STATUS_HEADLINE[status]} (${renderCheckScope(result.checks)}).`,
		];
		appendReviewedAtLine(lines, identity);
		appendRunReferenceLine(lines, identity);
		appendReceiptSection(lines, identity, result);
		if (findings.length > 0) {
			lines.push("", "Findings:", ...findings);
		}
		const body = capText(redactSecrets(lines.join("\n")), CAPS.commentBody);
		return {
			kind: "comment",
			action: "upsert",
			target: COMMENT_TARGET,
			itemNumber: identity.itemNumber as number,
			body,
			dedupeKey,
		};
	},
	// The RESULT carries the assembled full comment body, which embeds bounded
	// runner-produced finding and check text. Args are all keyed objects or fixed
	// enums, so none needs positional redaction.
	{ redact: { result: true } },
);

/**
 * Append THE RECEIPT — the evidence the state flip is earned by.
 *
 * The receipt states three things, in this order: which spec judged this job,
 * whether that spec was satisfied, and the verbatim per-check outcomes the runner
 * recorded. A held item's reader needs the third part most, because "what
 * actually failed" is the whole question a HOLD asks a human to answer.
 *
 * BOUNDING IS REUSED, NOT REBUILT. The verbatim check rows go through
 * `renderCheckTrail`, the SAME boundary the proposal body already uses: it
 * redacts secrets, escapes every Markdown/HTML structural character, caps each
 * name and summary, and caps the ROW COUNT so a pathological 100-check result
 * cannot push the receipt past `CAPS.commentBody` and truncate the rest of the
 * comment mid-line. The whole body then takes the standard `redactSecrets` +
 * `capText` pass in the caller, so runner text here is doubly bounded.
 *
 * The spec kind and its `describes` text are author-controlled constants, so the
 * receipt's own claims are never runner-influenced. `degraded` is empty: an
 * allowance is a dispatch-time gate concept the comment path has no access to,
 * and inventing one here would flag rows as allowed that nothing allowed.
 */
function appendReceiptSection(lines: string[], identity: JobIdentity, result: RunnerResult): void {
	const spec = receiptSpecFor(identity.jobType);
	if (spec === null) {
		// Off the allowlisted path entirely. Say so rather than omitting the section:
		// a missing receipt that looks like no receipt was needed is the exact
		// ambiguity this loop exists to remove.
		lines.push(
			"",
			"#### Receipt",
			`No receipt spec is registered for job type \`${sanitizeIdentity(identity.jobType)}\`, so no state may be earned from this result.`,
		);
		return;
	}
	const ok = receiptSatisfied(identity, result);
	lines.push(
		"",
		"#### Receipt",
		`Spec: \`${spec.kind}\` — ${spec.describes}`,
		// NOT "Verdict". This field says whether the receipt SPEC was
		// satisfied — whether the lane produced the evidence it owes. On a
		// `pr-review` job that comment sits beside `factory/pr-review`, whose own
		// status IS a verdict on the code, and the two mean opposite things: a
		// review can find a P0 (verdict `fix-first`, status `failure`) in a run
		// whose checks all executed cleanly (receipt satisfied). Labelled
		// "Verdict: satisfied", that reads as approval. Two sessions read it that
		// way on one day and both acted on the wrong conclusion, then filed the
		// correct status posting as a bug. One word was the whole defect.
		`Receipt: **${ok ? "satisfied" : "NOT satisfied"}**`,
	);
	const trail = renderCheckTrail(result.checks ?? [], []);
	if (trail.length > 0) {
		lines.push("", "Verbatim check outcomes:", ...trail);
	} else if (spec.kind !== "none-required") {
		// The load-bearing sentence for the empty-evidence case: zero checks on a
		// lane that owes a probe is WHY the receipt failed, and a reader seeing only
		// "NOT satisfied" would go looking for a failing row that does not exist.
		lines.push("", "The runner recorded no checks, so this lane produced no evidence.");
	}
	appendHoldEscalation({ lines, identity, result, spec, receiptOk: ok });
}

/**
 * The HOLD escalation report.
 *
 * SHAPE IS MANDATED, not stylistic: the FIRST SENTENCE is `BLOCKED`, the cause,
 * and the decision needed. A held item exists to get a human to act, and an
 * escalation whose first line is context rather than the ask gets triaged as
 * noise — the brief specifies this shape for exactly that reason.
 *
 * Emitted only when the item is actually holding, so a passing job's comment
 * carries no escalation. Every substitution is author-controlled or already
 * sanitized: the cause is chosen from a fixed set here, and the job type goes
 * through `sanitizeIdentity`.
 */
type HoldEscalationArgs = {
	lines: string[];
	identity: JobIdentity;
	result: RunnerResult;
	spec: ReceiptSpec;
	receiptOk: boolean;
};

function appendHoldEscalation({
	lines,
	identity,
	result,
	spec,
	receiptOk,
}: HoldEscalationArgs): void {
	const heldByStatus = result.status === "failed" || result.status === "error";
	if (!heldByStatus && receiptOk) {
		return;
	}
	// Fixed causes, most specific first. A cause the reader can act on beats an
	// accurate summary of everything that is true.
	let cause: string;
	if (!receiptOk && (result.checks ?? []).length === 0 && spec.kind !== "none-required") {
		cause = `the \`${spec.kind}\` receipt produced no evidence at all (zero checks recorded)`;
	} else if (!receiptOk) {
		cause = `the \`${spec.kind}\` receipt was not satisfied by the recorded checks`;
	} else {
		cause = `the job reported \`${result.status}\``;
	}
	lines.push(
		"",
		`**BLOCKED** — \`${sanitizeIdentity(identity.jobType)}\` is on HOLD because ${cause}. Decision needed: confirm whether this is a real failure to fix, or an accepted condition this item may be released from.`,
		"",
		"This item was NOT closed and NOT retried. #254 clause 3: a job that cannot produce its receipt holds for a human, and destructive steps are never retried unattended.",
	);
}

/**
 * Append the exact-SHA "Reviewed at" author line to a comment body when the
 * trusted identity carries a SHA. The SHA is the DB-derived
 * `identity.sha`, resolved from the authoritative jobs → github_items join, never
 * from runner output — the same trusted field the exact-SHA check binds to — so a
 * runner cannot forge which commit a reader will direct-match against the PR head.
 * The line is author-structured (fixed label, fixed backtick delimiters); the SHA
 * is passed through the identity sanitizer as defence-in-depth so even a corrupt
 * row can introduce no markup, and the whole body remains hard-capped by the
 * caller. A shaless identity (some issues) simply omits the line.
 */
function appendReviewedAtLine(lines: string[], identity: JobIdentity): void {
	if (identity.sha === "") {
		return;
	}
	lines.push(`Reviewed at: \`${sanitizeIdentity(identity.sha)}\``);
}

/**
 * The run reference: ONE bounded line naming the exact run behind this
 * comment, so a reader of any factory-authored comment can go find the job row,
 * the attempt row, and — from the attempt's `trace_id` — the Langfuse trace.
 *
 * IDS ONLY, AND THAT IS THE WHOLE DESIGN. The controller ruled on 2026-08-16
 * that a forge comment carries `job N, attempt M` and never the Langfuse host or
 * a trace URL; the clickable link lives on the status page, which is the surface
 * already allowed to know the internal host. The issue anticipated gating the URL
 * on repository visibility instead — that gate does not exist here and is not
 * needed, because there is no URL to gate. That is the stronger property: a
 * visibility check is a thing that can be wrong on one repository, and a comment
 * that never contains a host cannot leak one however it is published, mirrored,
 * or quoted.
 *
 * Both values are integers from the trusted DB join, rendered through the
 * conservative identity sanitizer as defence-in-depth so even a corrupt row can
 * introduce no markup. An identity with no attempt (every non-result call site,
 * and every pre-#184 fixture) renders NO line rather than an invented attempt
 * number — a run reference naming an attempt that does not exist is worse than
 * none, because it sends the operator looking for a row that was never written.
 */
function appendRunReferenceLine(lines: string[], identity: JobIdentity): void {
	const attemptId = identity.attemptId ?? null;
	if (attemptId === null) {
		return;
	}
	lines.push(
		`Run: job ${sanitizeIdentity(String(identity.jobId))}, attempt ${sanitizeIdentity(String(attemptId))}`,
	);
}

/**
 * The acknowledgment header the triage comment OPENS with: the early
 * signal a filer gets that the factory saw the issue, claimed it, and understood
 * it — or that it is missing what the implement lane's spec contract needs.
 *
 * Three blocks, in a fixed author-controlled order:
 *
 *  1. CLAIM RECEIPT. The k-board task id, the job id, and the lane name — every
 *     one of them from the TRUSTED identity (the jobs → repositories/github_items
 *     join), never from runner output, so nothing a runner can send names a job
 *     or a task. A job with no task id SAYS it is unbound rather than omitting the
 *     line: an ack that silently drops the binding reads as though there is none
 *     to report, and an ack naming a task the board never issued is worse still.
 *  2. THE FACTORY'S READ. The runner's one-line restatement of the ask, labelled
 *     as the factory's read and explicitly marked PROPOSED. Worker output is
 *     PROPOSED until verified, so the header must never phrase it as a fact about
 *     the issue. A result carrying no `read` renders no read block at all — an
 *     empty "the factory understood:" heading asserts more than silence does.
 *  3. SPEC GAPS. The parts of the spec contract the issue does not supply.
 *     REPORT, NEVER BLOCK: the wording says what is missing and nothing about
 *     stopping, because the lane proceeds with whatever the issue has. No gaps
 *     renders no section, so a complete issue is not handed a heading that reads
 *     like a problem.
 *
 * Both runner-supplied fields pass through `sanitizeRunnerText` (redact, then
 * escape every Markdown/HTML structural character and break @-mentions) and are
 * hard-capped per line, exactly like a finding line: the ack introduces display
 * text, never structure, and the whole body is capped again by the caller.
 */
function appendAck(lines: string[], identity: JobIdentity, result: RunnerResult): void {
	lines.push("### software-factory: triage claimed", "");
	appendClaimReceipt(lines, identity);
	appendFactoryRead(lines, result);
	appendSpecGaps(lines, result);
	lines.push("");
}

/**
 * The claim-receipt line. Every value is trusted-identity-derived and passes the
 * conservative identity sanitizer as defence-in-depth, so even a corrupt row can
 * introduce no markup. The unbound wording deliberately avoids the backticked
 * "k-board task `" form the bound branch uses, so the two can never be confused
 * by a reader OR by a check.
 */
function appendClaimReceipt(lines: string[], identity: JobIdentity): void {
	const lane = sanitizeIdentity(identity.jobType);
	const taskId = identity.kboardTaskId ?? null;
	const claim =
		taskId === null || taskId === ""
			? "this job is not bound to a k-board task"
			: `k-board task \`${sanitizeIdentity(taskId)}\``;
	lines.push(`Claimed by the \`${lane}\` lane as job ${identity.jobId} — ${claim}.`);
}

/** The factory's read of the ask, flagged PROPOSED. Absent when unsupplied. */
function appendFactoryRead(lines: string[], result: RunnerResult): void {
	const read = result.triage?.read;
	if (read === undefined || read.trim() === "") {
		return;
	}
	lines.push(
		"",
		`The factory's read of the ask (PROPOSED — the lane's own restatement, not a verified fact): ${capText(sanitizeRunnerText(read), CAPS.findingLine)}`,
	);
}

/** The named spec gaps. Report-only wording; absent when the runner named none. */
function appendSpecGaps(lines: string[], result: RunnerResult): void {
	const gaps = (result.triage?.spec_gaps ?? []).filter((gap) => gap.trim() !== "");
	if (gaps.length === 0) {
		return;
	}
	lines.push(
		"",
		"Spec gaps the implement lane would be missing (reported, not a stop — the lane proceeds with what the issue has):",
	);
	for (const gap of gaps.slice(0, CAPS.findings)) {
		lines.push(capText(`- ${sanitizeRunnerText(gap)}`, CAPS.findingLine));
	}
}

/**
 * Build the single deduplicated triage comment plan. It OPENS with the
 * acknowledgment header (#248 — see `appendAck`), then carries the same fixed
 * classification structure as `buildComment` (status headline + redacted finding
 * lines), then appends two triage-specific, author-structured sections:
 *
 *  - the labels the watcher SELECTED — the runner-chosen names that survived the
 *    factory-side allowlist filter. This comment is written at PLAN time, before
 *    the separate label-posting step runs (which can fail independently, and once
 *    did — #124), so the wording states INTENT ("the watcher applies these"), not
 *    a completed mutation the comment cannot actually know happened.
 *  - a REQUEST block listing every label the runner named that the allowlist
 *    lacks (dropped, never applied) plus every explicit `triage.requests` entry.
 *    This is the ratified path: a runner may ASK a human to create a label, and
 *    the ask renders as bounded text — it is never a forge mutation.
 *
 * All runner-supplied names and reasons are redacted and escaped through
 * `sanitizeRunnerText`, so a request line can no more inject markup than a
 * finding line can. The whole body is hard-capped like every other comment.
 */
export const buildTriageComment = traced(
	"github.buildTriageComment",
	function buildTriageComment(
		identity: JobIdentity,
		result: RunnerResult,
		status: RunnerResult["status"],
		triageAllowlist: readonly string[],
	): CommentPlan {
		const dedupeKey = commentDedupeKey(identity);
		const findings = renderFindings(result);
		// sf#369: signature ahead of the #248 ack. The ack remains the first CONTENT
		// block; the attribution says who wrote it before the claim it makes.
		const lines = [`<!-- ${dedupeKey} -->`, signatureLine()];
		appendAck(lines, identity, result);
		lines.push(
			`### software-factory: ${STATUS_HEADLINE[status]}`,
			`Job \`${sanitizeIdentity(identity.jobType)}\` for \`${sanitizeIdentity(identity.repository)}\` ${STATUS_HEADLINE[status]} (${renderCheckScope(result.checks)}).`,
		);
		appendReviewedAtLine(lines, identity);
		appendRunReferenceLine(lines, identity);
		// The triage comment carries the receipt too. Both comment
		// builders are the SAME receipt for the same flip: the plan array holds exactly
		// one comment per job, and which builder produced it is a rendering detail. If
		// only one carried the receipt, half the lanes would flip state with no
		// evidence attached and the gap would be invisible from the item.
		appendReceiptSection(lines, identity, result);
		if (findings.length > 0) {
			lines.push("", "Findings:", ...findings);
		}

		appendSelectedLabels(lines, result, triageAllowlist);
		appendRequestedLabels(lines, result, triageAllowlist);

		const body = capText(redactSecrets(lines.join("\n")), CAPS.commentBody);
		return {
			kind: "comment",
			action: "upsert",
			target: COMMENT_TARGET,
			itemNumber: identity.itemNumber as number,
			body,
			dedupeKey,
		};
	},
	// Same as `buildComment`: the RESULT is the assembled full comment body
	// carrying bounded runner-produced ack/finding/request text.
	{ redact: { result: true } },
);

/**
 * Append the SELECTED labels section: exactly the runner-chosen names the
 * allowlist filter kept. The heading states intent, not completion — this comment
 * is built at plan time, and the label application is a separate posting that can
 * fail independently. "Say which kind of true it is": the comment must not
 * claim a mutation it cannot observe. Extracted from `buildTriageComment` purely
 * to keep it within the function ceiling.
 */
function appendSelectedLabels(
	lines: string[],
	result: RunnerResult,
	triageAllowlist: readonly string[],
): void {
	const selected = allowlistedChosenLabels(result, triageAllowlist);
	if (selected.length === 0) {
		return;
	}
	lines.push("", "Labels (selected from the triage vocabulary; the watcher applies these):");
	for (const label of selected) {
		lines.push(`- ${sanitizeRunnerText(label)}`);
	}
}

/**
 * Append the REQUEST block: non-allowlisted chosen labels + explicit requests.
 * Both are labels the watcher did NOT apply — the ask is text for a human, never
 * a mutation. Bounded by the finding cap so a hostile result cannot fan out.
 * Extracted from `buildTriageComment` purely to keep it within the ceiling.
 */
function appendRequestedLabels(
	lines: string[],
	result: RunnerResult,
	triageAllowlist: readonly string[],
): void {
	const requests = triageLabelRequests(result, triageAllowlist);
	if (requests.length === 0) {
		return;
	}
	lines.push(
		"",
		"Requested labels (not applied — create these to add them to the triage vocabulary):",
	);
	for (const req of requests) {
		const name = sanitizeRunnerText(req.name);
		const reason = req.reason ? ` — ${sanitizeRunnerText(req.reason)}` : "";
		lines.push(capText(`- ${name}${reason}`, CAPS.findingLine));
	}
}

/**
 * The bounded set of label REQUESTS to render into the triage comment: the
 * runner-chosen labels the allowlist rejected (so they were dropped, not applied)
 * PLUS every explicit `triage.requests` entry. De-duplicated by name so a label
 * that is both chosen-and-rejected and explicitly requested renders once, and
 * hard-capped at the finding cap so a pathological result cannot blow the comment.
 * A dropped chosen-label carries no reason; an explicit request keeps its reason.
 */
function triageLabelRequests(
	result: RunnerResult,
	triageAllowlist: readonly string[],
): Array<{ name: string; reason?: string }> {
	const allowed = new Set(triageAllowlist);
	const out: Array<{ name: string; reason?: string }> = [];
	const seen = new Set<string>();
	const add = (name: string, reason?: string) => {
		if (out.length >= CAPS.findings || seen.has(name)) {
			return;
		}
		seen.add(name);
		out.push(reason === undefined ? { name } : { name, reason });
	};
	// A chosen label the allowlist lacks is a request by demotion.
	for (const label of result.triage?.labels ?? []) {
		if (!allowed.has(label)) {
			add(label);
		}
	}
	// Every explicit request the runner made.
	for (const req of result.triage?.requests ?? []) {
		add(req.name, req.reason);
	}
	return out;
}
