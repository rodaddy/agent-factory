/**
 * @module github/publication
 * @description The fixed, pure publication registry. It converts a *trusted* job
 *   identity (repository, item number, SHA, job type — resolved from the
 *   authoritative database join, never from runner output) plus an already
 *   schema-validated, redacted `RunnerResult` into only a small set of approved
 *   GitHub operations: fixed allowlisted label transitions, one bounded
 *   deduplicated comment, and one exact-SHA external check for a source item; or,
 *   for a scheduled-audit job, one bounded open/update issue plan per
 *   surfaced finding against the audit's own repository (never a close, never a
 *   code write).
 *
 *   The security invariant: runner fields may supply bounded *displayed*
 *   findings and check summaries, but can never choose the endpoint, a label
 *   name, the comment template structure, the check name/context, the
 *   repository, the item number, or the SHA. Those all come from the trusted
 *   identity or from author-controlled constants here. Unknown action / kind /
 *   status is rejected before any plan is produced (and therefore before any
 *   network request). All free text is redacted again at this boundary and hard
 *   body/title/summary/finding/count caps are enforced.
 *
 *   This module is the ORCHESTRATOR and the public surface: it owns the
 *   status/audit/triage routing and the check builder, and re-exports the plan
 *   shapes, caps, and markers at their original module path. The regions split
 *   out of it are the declarations (`./publication-types`), the outbound text
 *   boundary (`./publication-text`), the comment builders
 *   (`./publication-comment`). The audit-issue builders were retired with sf#830.
 *
 * @outputs
 *   - `buildPublicationPlans` -- identity + result -> approved plans (or none)
 *   - `buildProposalPlan` -- an already-pushed branch -> its open-proposal plan
 *   - `PublicationPlan` -- one bounded, ready-to-post operation
 *   - `JobIdentity` -- the trusted, DB-derived identity
 *   - caps and marker constants for the persistence + posting layers
 *
 * @dependencies
 *   - ../results/schema -- the RunnerResult type this consumes
 *   - ../results/ingest -- redactSecrets for the outbound redaction pass
 *   - ../log -- the one logger, for the traced() wrapper
 *   - ./publication-types, ./publication-text, ./publication-comment -- the split regions
 */
import { traced } from "../log";
import type { DegradedCheck } from "../results/check-trail";
import { redactSecrets } from "../results/ingest";
import type { ResultCheck, RunnerResult } from "../results/schema";
import { TRIAGE_JOB_TYPE } from "../results/schema";
import { allowlistedChosenLabels, buildComment, buildTriageComment } from "./publication-comment";
import {
	capText,
	renderCheckScope,
	renderCheckTrail,
	renderFindings,
	STATUS_HEADLINE,
	sanitizeIdentity,
} from "./publication-text";
import {
	ALL_RESULT_LABELS,
	AUDIT_ISSUE_MARKER_PREFIX,
	auditIssueDedupeKey,
	CAPS,
	CHECK_NAME,
	CHECK_TARGET,
	type CheckPlan,
	COMMENT_TARGET,
	type CommentPlan,
	checkDedupeKey,
	commentDedupeKey,
	type IssuePlan,
	isPublishableStatus,
	type JobIdentity,
	type LabelPlan,
	PROPOSAL_BRANCH_PREFIX,
	type ProposalPlan,
	PUBLICATION_KINDS,
	PUBLISHABLE_STATUSES,
	type PublicationKind,
	type PublicationPlan,
	type PublishableStatus,
	proposalBranchFor,
	RECEIPT_SPECS,
	RESULT_LABELS,
	type ReceiptSpec,
	receiptSatisfied,
	receiptSpecFor,
	stateForOutcome,
	TERMINAL_CHECK_NAME,
	TERMINAL_CHECK_TARGET,
	TERMINAL_CHECK_TITLE,
	type TerminalCheckPlan,
	terminalCheckDedupeKey,
	terminalCheckSummaryPrefix,
} from "./publication-types";
import { signatureLine } from "./signature";

export { buildTerminalCheck } from "./publication-terminal";

export {
	ALL_RESULT_LABELS,
	AUDIT_ISSUE_MARKER_PREFIX,
	auditIssueDedupeKey,
	CAPS,
	CHECK_NAME,
	CHECK_TARGET,
	type CheckPlan,
	COMMENT_TARGET,
	type CommentPlan,
	checkDedupeKey,
	commentDedupeKey,
	type IssuePlan,
	isPublishableStatus,
	type JobIdentity,
	type LabelPlan,
	PROPOSAL_BRANCH_PREFIX,
	type ProposalPlan,
	PUBLICATION_KINDS,
	PUBLISHABLE_STATUSES,
	type PublicationKind,
	type PublicationPlan,
	type PublishableStatus,
	proposalBranchFor,
	RECEIPT_SPECS,
	RESULT_LABELS,
	type ReceiptSpec,
	receiptSatisfied,
	receiptSpecFor,
	stateForOutcome,
	TERMINAL_CHECK_NAME,
	TERMINAL_CHECK_TARGET,
	TERMINAL_CHECK_TITLE,
	type TerminalCheckPlan,
	terminalCheckDedupeKey,
	terminalCheckSummaryPrefix,
};

/** GitHub check-run conclusion, derived only from the validated status. */
const CHECK_CONCLUSION: Record<RunnerResult["status"], "success" | "failure" | "neutral"> = {
	passed: "success",
	failed: "failure",
	error: "failure",
	skipped: "neutral",
};

/**
 * Convert a trusted identity plus a validated result into approved plans.
 *
 * Returns an empty array (never throws) when nothing is publishable: an unknown
 * status, or a target the plan would need but the identity does not authorize
 * (label/comment writes require a trusted item number; a check requires a
 * trusted SHA). Itemless jobs therefore never produce issue/PR writes, and
 * shaless jobs never produce a check.
 *
 * `itemEligible` gates the item-level writes (labels/comment) at queue time: a
 * closed item, or an open PR whose head has already moved off the job's SHA, is
 * ineligible, so no label/comment plan is produced for it. The exact-SHA check
 * is unaffected — it binds to an immutable commit, not the item's live head.
 */
export const buildPublicationPlans = traced(
	"github.buildPublicationPlans",
	function buildPublicationPlans(
		identity: JobIdentity,
		result: RunnerResult,
		itemEligible = true,
		triageAllowlist: readonly string[] = [],
	): PublicationPlan[] {
		// Reject an unknown/unmapped status before producing any operation.
		//
		// KEYED ON `PUBLISHABLE_STATUSES`, NOT ON THE LABEL VOCABULARY. Those were the
		// same object until #254 added the factory-derived `hold` state; had this guard
		// kept reading `result.status in RESULT_LABELS`, a runner reporting
		// `{"status":"hold"}` would have become publishable and could have named its
		// own terminal state. The ingest `z.enum` rejects it first today, so the
		// widening would have been a latent second-line failure rather than a visible
		// one. The admission set and the state vocabulary are now separate on purpose.
		if (!isPublishableStatus(result.status)) {
			return [];
		}
		const status = result.status;
		const plans: PublicationPlan[] = [];

		// Labels + comment target the trusted item only. No item, or an item no longer
		// eligible (closed / stale PR head) => no such writes.
		if (identity.itemNumber !== null && itemEligible) {
			appendItemPlans({ plans, identity, result, status, triageAllowlist });
		}

		// External check binds to the exact trusted SHA only. No SHA => no check.
		if (identity.sha !== "") {
			plans.push(buildCheck(identity, result, status));
		}

		return plans;
	},
);

/**
 * Append the item-level plans: the fixed label transition set, the issue-triage
 * lane's allowlisted add plans, and the comment. Extracted from
 * `buildPublicationPlans` purely to keep it within the function ceiling; the
 * ordering and the filter rules are unchanged.
 */
type AppendItemPlansArgs = {
	plans: PublicationPlan[];
	identity: JobIdentity;
	result: RunnerResult;
	status: RunnerResult["status"];
	triageAllowlist: readonly string[];
};

function appendItemPlans({
	plans,
	identity,
	result,
	status,
	triageAllowlist,
}: AppendItemPlansArgs): void {
	// Whether this is the issue-triage lane. Its label decisions are
	// filtered FACTORY-SIDE against the repository's config allowlist below, and any
	// requested/non-allowlisted label demotes into a request block in the comment.
	const isTriage = identity.jobType === TRIAGE_JOB_TYPE;
	const itemNumber = identity.itemNumber as number;

	// ---------------------------------------------------------------------------
	// THE RECEIPT COMES FIRST. The receipt comment and the state
	// flip are ONE transaction, and within it the receipt is the earlier operation.
	//
	// This is not cosmetic ordering. `publish-plan.ts` inserts one `github_postings`
	// row per plan in array order, and `publish.ts` selects due rows
	// `ORDER BY github_postings.id ASC` — so the array order IS the posting order,
	// and each row posts in its own transaction. Emitting the flip first therefore
	// opens a real window in which the item reads as done on the forge while the
	// evidence for it has not been posted, and a crash or an exhausted retry inside
	// that window leaves it there permanently. That was the live shape before this
	// change: the four label plans occupied indices 0-3 and the comment index 4.
	//
	// Reversed, the failure mode inverts into the safe direction: a crash between
	// the two leaves a receipt with no flip — visible, and honest about what ran.
	// ---------------------------------------------------------------------------
	const receiptOk = receiptSatisfied(identity, result);
	const wanted = stateForOutcome(status, receiptOk);

	if (isTriage) {
		plans.push(buildTriageComment(identity, result, status, triageAllowlist));
	} else {
		plans.push(buildComment(identity, result, status));
	}

	for (const label of ALL_RESULT_LABELS) {
		plans.push({
			kind: "label",
			action: label === wanted ? "add" : "remove",
			target: label,
			label,
			itemNumber,
		});
	}
	if (isTriage) {
		// One ADD plan per runner-chosen label that is IN the allowlist. The filter
		// is here, factory-side: an allowlisted set derived from trusted config, an
		// intersection against the untrusted runner list. A name the runner chose
		// that is not allowlisted produces NO label plan — it is folded into the
		// comment's request block instead, so untrusted output can never invent a
		// forge label mutation.
		for (const label of allowlistedChosenLabels(result, triageAllowlist)) {
			plans.push({
				kind: "label",
				action: "add",
				target: label,
				label,
				itemNumber,
			});
		}
	}
}

/**
 * The persisted check trail displayed in a proposal body.
 *
 * Both fields come from what INGEST verified and persisted, never from a re-read
 * of the runner's share directory: share content is untrusted and remains
 * runner-writable after ingest, so a trail re-read at proposal time could differ
 * from the one the gate actually judged.
 */
export interface ProposalCheckTrail {
	/** The per-check trail from the verified result. */
	checks: readonly ResultCheck[];
	/** The allowance uses gate 0 recorded, flagged in the rendered trail. */
	degraded: readonly DegradedCheck[];
}

/** Trusted inputs that select proposal naming and render its verified trail. */
export interface ProposalPlanInput extends ProposalCheckTrail {
	/** The DB-joined job type that selects verb vs non-verb naming. */
	jobType: string;
}

/**
 * The check-trail section of a proposal body, or nothing when the result carried
 * no trail. A result with no checks renders no heading at all rather than an
 * empty section that would read as "there were no problems".
 */
function renderTrailSection(trail: ProposalCheckTrail): string[] {
	const lines = renderCheckTrail(trail.checks, trail.degraded);
	if (lines.length === 0) {
		return [];
	}
	const section = ["#### Runner check trail", "", ...lines, ""];
	if (trail.degraded.length > 0) {
		section.push(
			`⚠ ${trail.degraded.length} required check(s) did not reach a verdict and were accepted under a named allowance. Review the flagged rows before merging.`,
			"",
		);
	}
	return section;
}

/**
 * Build the proposal plan for a change whose branch is ALREADY PUSHED.
 *
 * Called by the proposal pass only after `pushVerifiedBranch` reports `pushed`,
 * so the head ref exists before the publisher can act on this plan.
 *
 * The structure, the title, the refs, and the branch names are watcher-authored
 * over a trusted integer item number and two branch names the watcher derived or
 * resolved itself.
 *
 * THE BODY NOW CARRIES BOUNDED RUNNER DISPLAY TEXT, which it previously
 * did not. The check trail is the point of the ruling: the human deciding
 * whether to merge must see what the runner actually verified, including which
 * degraded checks were tolerated and under which named allowance. So the honest
 * invariant is narrower than "no runner text reaches the title or body":
 *
 *   - The TITLE, the base and head REFS, the branch name, and every structural
 *     element of the body remain 100% watcher-authored. No runner value can
 *     influence where this PR points or what it targets.
 *   - The BODY may display bounded runner text, and only through
 *     `renderCheckTrail`, which redacts secrets, escapes all Markdown/HTML
 *     structure, caps each field, and caps the number of rows. The whole body
 *     then passes the standard `redactSecrets` + `CAPS.issueBody` pass, so the
 *     trail is defence-in-depth bounded rather than singly bounded.
 *
 * The trail comes from the PERSISTED, ALREADY-VERIFIED result — never from a
 * re-read of the share, whose contents are runner-writable and mutable after
 * ingest. `headBranch` is re-derived from the trusted item number and job type
 * rather than accepted: `publish.ts` re-derives it at authorization, so a plan
 * naming any other ref is refused there.
 *
 * @param itemNumber - the trusted item number the proposal closes
 * @param baseBranch - the resolved base branch
 * @param headSha - the verified head commit
 * @param input - trusted job type plus persisted check trail and allowance uses
 */
export const buildProposalPlan = traced(
	"github.buildProposalPlan",
	function buildProposalPlan(
		itemNumber: number,
		baseBranch: string,
		headSha: string,
		input: ProposalPlanInput,
	): ProposalPlan | null {
		const headBranch = proposalBranchFor(itemNumber, input.jobType);
		if (headBranch === null) {
			return null;
		}
		const base = sanitizeIdentity(baseBranch);
		// A proposal that merges into itself is not a proposal; `publish.ts` refuses
		// this too, and failing here keeps the unusable row out of the queue entirely.
		if (base === "" || base === headBranch) {
			return null;
		}
		const title = capText(
			redactSecrets(`software-factory: implement #${itemNumber}`),
			CAPS.issueTitle,
		);
		const body = capText(
			redactSecrets(
				[
					// sf#369: this body carries no hidden dedupe marker (proposals dedupe
					// on the branch pair), so the signature is line 1 outright.
					signatureLine(),
					"",
					`### software-factory proposed change for #${itemNumber}`,
					"",
					`This branch was produced by a runner, verified against the dispatched base commit \`${sanitizeIdentity(headSha)}\`, and pushed by the watcher.`,
					"",
					...renderTrailSection(input),
					"The watcher opens this proposal and does nothing further: it never marks it ready, never updates it, and never merges it.",
					"",
					`Closes #${itemNumber}`,
				].join("\n"),
			),
			CAPS.issueBody,
		);
		return {
			kind: "proposal",
			action: "open",
			target: headBranch,
			headBranch,
			baseBranch: base,
			title,
			body,
			itemNumber,
			// Not-ready-to-merge is requested, but the real block is branch protection;
			// the client reports which guarantee it actually obtained.
			draft: true,
		};
	},
);

/** Build the single exact-SHA external check plan for the trusted commit. */
function buildCheck(
	identity: JobIdentity,
	result: RunnerResult,
	status: RunnerResult["status"],
): CheckPlan {
	const findings = renderFindings(result);
	// The verdict NAMES ITS SCOPE. "passed" alone is read as "this PR is
	// good"; what it means is "the checks in this lane passed", and the lane is
	// narrower than the repo. The scope clause is unconditional — including when
	// the trail is empty, where it says so outright — so there is no input for
	// which this line silently degrades back to the unqualified verdict.
	const summaryLines = [
		`Job \`${sanitizeIdentity(identity.jobType)}\` ${STATUS_HEADLINE[status]} (${renderCheckScope(result.checks)}).`,
	];
	if (findings.length > 0) {
		summaryLines.push("", "Findings:", ...findings);
	}
	return {
		kind: "check",
		action: "upsert",
		target: CHECK_TARGET,
		name: CHECK_NAME,
		sha: identity.sha,
		conclusion: CHECK_CONCLUSION[status],
		title: capText(redactSecrets(`software-factory ${STATUS_HEADLINE[status]}`), CAPS.checkTitle),
		summary: capText(redactSecrets(summaryLines.join("\n")), CAPS.checkSummary),
		dedupeKey: checkDedupeKey(identity),
	};
}
