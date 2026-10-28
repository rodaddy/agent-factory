/**
 * @module github/publish-decode
 * @description The stored-plan decoder and its strict re-validation — the
 *   SECURITY-ADJACENT boundary a `github_postings` payload must pass before any
 *   transport call. Split out of `github/publish.ts` unchanged: the publisher
 *   still calls exactly this decode as the first thing it does with a locked row,
 *   and a `null` return still fails the row terminally rather than posting.
 *
 *   The invariant the split preserves: the row has been AT REST in the database
 *   between enqueue and publish, so this is the point where a tampered or
 *   migrated payload has to fail closed. Every structural check is re-run here,
 *   and the label path re-applies the #124 two-tier vocabulary gate — the fixed
 *   `watcher:*` status vocabulary, OR (for the issue-triage lane's ADD plans
 *   only) a label still present in the repository's live config allowlist at
 *   PUBLISH time. Both inputs are trusted: the job type is the DB-joined value
 *   and the allowlist comes from config; nothing runner-writable participates.
 *   A publisher with no resolver knows no triage vocabulary, so every triage
 *   label plan fails closed.
 *
 * @outputs
 *   - `decodePlan` -- stored payload -> revalidated `PublicationPlan`, or null
 *   - `isRecord` / `isPositiveInteger` / `isSafeText` -- shared shape guards
 *   - `requireExternalId` -- bounded external-id extraction
 *   - `planIdentity` -- minimal identity for deriving fixed dedupe markers
 *
 * @dependencies
 *   - ../log -- the one logger, for the traced() wrapper
 *   - ./publication -- caps, markers, and the plan shapes being revalidated
 *   - ../results/ingest -- redactSecrets, used by the safe-text guard
 *   - ../results/store -- the triage allowlist resolver type
 */
import { errorMessage, log, traced } from "../log";
import { redactSecrets } from "../results/ingest";
import { TRIAGE_JOB_TYPE } from "../results/schema";
import type { TriageAllowlistResolver } from "../results/store";
import { isPlainBranchName } from "./base-branch";
import {
	ALL_RESULT_LABELS,
	AUDIT_ISSUE_MARKER_PREFIX,
	CAPS,
	CHECK_NAME,
	CHECK_TARGET,
	type CheckPlan,
	COMMENT_TARGET,
	type CommentPlan,
	checkDedupeKey,
	commentDedupeKey,
	type IssuePlan,
	type JobIdentity,
	type LabelPlan,
	type ProposalPlan,
	type PublicationPlan,
	proposalBranchFor,
	TERMINAL_CHECK_NAME,
	TERMINAL_CHECK_TARGET,
	TERMINAL_CHECK_TITLE,
	type TerminalCheckPlan,
	terminalCheckDedupeKey,
	terminalCheckSummaryPrefix,
} from "./publication";

/** Bounded reason for a plan whose stored payload could not be used safely. */
export const UNPUBLISHABLE = "publication plan could not be published";

/** The stored posting row fields the decoder revalidates against. */
export interface DecodableRow {
	jobId: number;
	kind: string;
	action: string;
	target: string;
	payload: string;
	dedupeKey: string;
	jobType: string;
	repository: string;
}

/** Decode and strictly revalidate a stored plan before any transport call. */
export const decodePlan = traced(
	"github.decodePlan",
	function decodePlan(
		row: DecodableRow,
		triageAllowlistFor: TriageAllowlistResolver,
	): PublicationPlan | null {
		try {
			const parsed: unknown = JSON.parse(row.payload);
			if (!isRecord(parsed) || parsed.kind !== row.kind || parsed.action !== row.action) {
				return null;
			}

			if (parsed.kind === "label") {
				return decodeLabelPlan(parsed, row, triageAllowlistFor);
			}

			if (parsed.kind === "comment") {
				return decodeCommentPlan(parsed, row);
			}

			if (parsed.kind === "issue") {
				return decodeIssuePlan(parsed, row);
			}

			if (parsed.kind === "check") {
				if (parsed.target === TERMINAL_CHECK_TARGET || row.target === TERMINAL_CHECK_TARGET) {
					return decodeTerminalCheckPlan(parsed, row);
				}
				return decodeCheckPlan(parsed, row);
			}

			if (parsed.kind === "proposal") {
				return decodeProposalPlan(parsed, row);
			}

			return null;
		} catch (err) {
			// An undecodable payload fails the row terminally, so record why. Only the
			// row's identifiers are logged — never the stored payload itself.
			log("warn", "publish.plan.decode_failed", {
				job_id: row.jobId,
				kind: row.kind,
				action: row.action,
				cause: errorMessage(err),
			});
			return null;
		}
	},
	{ redact: { args: [0] } },
);

/**
 * Revalidate a stored LABEL plan, including the #124 two-tier vocabulary gate.
 * Extracted from `decodePlan` purely to keep it within the function ceiling; the
 * checks and their order are unchanged.
 */
function decodeLabelPlan(
	parsed: Record<string, unknown>,
	row: DecodableRow,
	triageAllowlistFor: TriageAllowlistResolver,
): LabelPlan | null {
	// Every structural check the watcher:* status labels have always had; the
	// only thing that changes for triage is the label-VOCABULARY check below.
	if (
		(parsed.action !== "add" && parsed.action !== "remove") ||
		typeof parsed.label !== "string" ||
		parsed.target !== parsed.label ||
		row.target !== parsed.label ||
		row.dedupeKey !== parsed.label ||
		!isPositiveInteger(parsed.itemNumber)
	) {
		return null;
	}
	// The label must be either the fixed watcher:* status vocabulary (add OR
	// remove, any lane), OR — for the issue-triage lane's ADD plans only — a
	// label that is STILL in the repository's live config allowlist at publish
	// time. Both inputs are trusted: `jobType` is the DB-joined job type and
	// the allowlist comes from config; nothing runner-writable participates.
	// Fail closed: a triage label absent from the current allowlist, or any
	// non-status label under a non-triage lane / a remove action, is refused.
	if (!ALL_RESULT_LABELS.includes(parsed.label)) {
		if (row.jobType !== TRIAGE_JOB_TYPE || parsed.action !== "add") {
			return null;
		}
		const allowlist = triageAllowlistFor(row.repository, row.jobType);
		if (!allowlist.includes(parsed.label)) {
			return null;
		}
	}
	return parsed as unknown as LabelPlan;
}

/**
 * Revalidate a stored COMMENT plan. Extracted from `decodePlan` purely to keep it
 * within the function ceiling; the checks and their order are unchanged.
 */
function decodeCommentPlan(parsed: Record<string, unknown>, row: DecodableRow): CommentPlan | null {
	const identity = planIdentity(row.jobId);
	const expectedKey = commentDedupeKey(identity);
	if (
		parsed.action !== "upsert" ||
		parsed.target !== COMMENT_TARGET ||
		row.target !== COMMENT_TARGET ||
		parsed.dedupeKey !== expectedKey ||
		row.dedupeKey !== expectedKey ||
		!isPositiveInteger(parsed.itemNumber) ||
		!isSafeText(parsed.body, CAPS.commentBody) ||
		!parsed.body.startsWith(`<!-- ${expectedKey} -->\n`)
	) {
		return null;
	}
	return parsed as unknown as CommentPlan;
}

/**
 * Revalidate a stored audit ISSUE plan. Extracted from `decodePlan` purely to
 * keep it within the function ceiling; the checks and their order are unchanged.
 */
function decodeIssuePlan(parsed: Record<string, unknown>, row: DecodableRow): IssuePlan | null {
	// Structural revalidation: an audit issue plan carries a marker of the
	// fixed `rodaddy-watcher:audit:<audit>:<fingerprint>` shape whose trailing
	// fingerprint is exactly the plan's target, and the body begins with that
	// marker as an HTML comment. The audit-name authorization against THIS
	// job's type is enforced separately in `targetAuthorizes`.
	const expectedMarker = `<!-- ${parsed.dedupeKey} -->`;
	if (
		(parsed.action !== "open" && parsed.action !== "update") ||
		typeof parsed.dedupeKey !== "string" ||
		!parsed.dedupeKey.startsWith(`${AUDIT_ISSUE_MARKER_PREFIX}:`) ||
		!parsed.dedupeKey.endsWith(`:${parsed.target}`) ||
		typeof parsed.target !== "string" ||
		parsed.target.length === 0 ||
		row.target !== parsed.target ||
		row.dedupeKey !== parsed.dedupeKey ||
		typeof parsed.cleared !== "boolean" ||
		!isSafeText(parsed.title, CAPS.issueTitle) ||
		!isSafeText(parsed.body, CAPS.issueBody) ||
		!parsed.body.startsWith(`${expectedMarker}\n`)
	) {
		return null;
	}
	return parsed as unknown as IssuePlan;
}

/**
 * Revalidate a stored exact-SHA CHECK plan. Extracted from `decodePlan` purely to
 * keep it within the function ceiling; the checks and their order are unchanged.
 */
function decodeCheckPlan(parsed: Record<string, unknown>, row: DecodableRow): CheckPlan | null {
	if (typeof parsed.sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(parsed.sha)) {
		return null;
	}
	const identity = planIdentity(row.jobId, parsed.sha);
	const expectedKey = checkDedupeKey(identity);
	if (
		parsed.action !== "upsert" ||
		parsed.target !== CHECK_TARGET ||
		row.target !== CHECK_TARGET ||
		parsed.name !== CHECK_NAME ||
		!isCheckConclusion(parsed.conclusion) ||
		parsed.dedupeKey !== expectedKey ||
		row.dedupeKey !== expectedKey ||
		!isSafeText(parsed.title, CAPS.checkTitle) ||
		!isSafeText(parsed.summary, CAPS.checkSummary)
	) {
		return null;
	}
	return parsed as unknown as CheckPlan;
}

/** Revalidate the fixed neutral notice for a job terminalized without a verdict. */
function decodeTerminalCheckPlan(
	parsed: Record<string, unknown>,
	row: DecodableRow,
): TerminalCheckPlan | null {
	if (typeof parsed.sha !== "string" || !/^[0-9a-f]{7,64}$/i.test(parsed.sha)) {
		return null;
	}
	const expectedKey = terminalCheckDedupeKey({ jobId: row.jobId, sha: parsed.sha });
	const summaryPrefix = terminalCheckSummaryPrefix(row.jobId);
	if (
		parsed.action !== "upsert" ||
		parsed.target !== TERMINAL_CHECK_TARGET ||
		row.target !== TERMINAL_CHECK_TARGET ||
		parsed.name !== TERMINAL_CHECK_NAME ||
		parsed.conclusion !== "neutral" ||
		parsed.title !== TERMINAL_CHECK_TITLE ||
		parsed.dedupeKey !== expectedKey ||
		row.dedupeKey !== expectedKey ||
		!isSafeText(parsed.summary, CAPS.checkSummary) ||
		!parsed.summary.startsWith(summaryPrefix) ||
		parsed.summary.slice(summaryPrefix.length).length === 0
	) {
		return null;
	}
	return parsed as unknown as TerminalCheckPlan;
}

/**
 * Revalidate a stored PROPOSAL plan, re-deriving the branch from the stored item
 * number and DB-joined job type. Extracted from `decodePlan` purely to keep it
 * within the function ceiling; the checks and their order are unchanged.
 */
function decodeProposalPlan(
	parsed: Record<string, unknown>,
	row: DecodableRow,
): ProposalPlan | null {
	// Re-derive the branch from the stored item number and DB-joined job type
	// rather than trusting the stored branch string. The row has been at rest in the database
	// between enqueue and publish, so this is the point where a tampered or
	// migrated payload has to fail closed: if `headBranch` is not exactly
	// what `proposalBranchFor` produces for this item, the plan is refused.
	// `targetAuthorizes` re-derives it a THIRD time at transport; both
	// checks are deliberate, because this one is what stops a bad row ever
	// reaching that code.
	if (!isPositiveInteger(parsed.itemNumber)) {
		return null;
	}
	const derived = proposalBranchFor(parsed.itemNumber, row.jobType);
	if (derived === null) {
		return null;
	}
	if (
		parsed.action !== "open" ||
		parsed.headBranch !== derived ||
		parsed.target !== derived ||
		row.target !== derived ||
		// The base branch is runner-independent (it comes from config),
		// but it is stored, so it is revalidated on the way back out.
		typeof parsed.baseBranch !== "string" ||
		!isPlainBranchName(parsed.baseBranch) ||
		// A proposal that merges into itself is not a proposal.
		parsed.baseBranch === derived ||
		typeof parsed.draft !== "boolean" ||
		!isSafeText(parsed.title, CAPS.issueTitle) ||
		!isSafeText(parsed.body, CAPS.issueBody)
	) {
		return null;
	}
	return parsed as unknown as ProposalPlan;
}

export const isRecord = traced(
	"github.isRecord",
	function isRecord(value: unknown): value is Record<string, unknown> {
		return typeof value === "object" && value !== null && !Array.isArray(value);
	},
);

export const isPositiveInteger = traced(
	"github.isPositiveInteger",
	function isPositiveInteger(value: unknown): value is number {
		return typeof value === "number" && Number.isInteger(value) && value > 0;
	},
);

function isCheckConclusion(value: unknown): value is CheckPlan["conclusion"] {
	return value === "success" || value === "failure" || value === "neutral";
}

export const requireExternalId = traced(
	"github.requireExternalId",
	function requireExternalId(value: unknown): string {
		if (!isPositiveInteger(value)) {
			throw new Error(UNPUBLISHABLE);
		}
		return String(value);
	},
);

// The predicate overload in `traced()` matches a ONE-parameter guard only, so
// this two-parameter guard falls through to the general overload and would come
// back as plain `boolean` with `value is string` erased. The explicit
// annotation restores the predicate; the signature itself is unchanged.
export const isSafeText = traced(
	"github.isSafeText",
	function isSafeText(value: unknown, max: number): value is string {
		return typeof value === "string" && value.length <= max && redactSecrets(value) === value;
	},
	{ redact: { args: [0] } },
) as (value: unknown, max: number) => value is string;

/** Minimal identity used only to derive fixed job-bound dedupe markers. */
export const planIdentity = traced(
	"github.planIdentity",
	function planIdentity(jobId: number, sha = ""): JobIdentity {
		return { jobId, repository: "", itemNumber: null, sha, jobType: "" };
	},
);
