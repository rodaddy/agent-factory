/**
 * @module github/publication-types
 * @description The publication registry's plan SHAPES, caps, and author-controlled
 *   constants. Split out of `github/publication.ts` so the builders, the posting
 *   layer, and the persistence layer can all depend on one declaration surface
 *   without an import cycle.
 *
 *   Everything here is author-controlled by construction: the caps, the fixed
 *   label vocabulary, the check name, the reserved branch prefix, and the audit
 *   marker prefix. A runner's validated status can SELECT a fixed row; it can
 *   never introduce a value into this file's vocabulary.
 *
 * @outputs
 *   - `PUBLICATION_KINDS` / `PublicationKind` -- the postable kinds
 *   - `CAPS` -- the hard outbound caps
 *   - `RESULT_LABELS` / `ALL_RESULT_LABELS` -- the fixed label allowlist
 *   - `PUBLISHABLE_STATUSES` / `isPublishableStatus` -- the runner statuses that
 *     may select a label (deliberately narrower than the label vocabulary)
 *   - `stateForOutcome` -- status + receipt verdict -> the state to flip to
 *   - `RECEIPT_SPECS` / `receiptSpecFor` / `ReceiptSpec` -- the per-job receipt
 *     spec
 *   - `COMMENT_TARGET` / `CHECK_TARGET` / `CHECK_NAME` -- fixed idempotency targets
 *   - `TERMINAL_CHECK_TARGET` / `TERMINAL_CHECK_NAME` -- the separate terminal notice
 *   - `JobIdentity` and the five plan interfaces + `PublicationPlan`
 *   - `PROPOSAL_BRANCH_PREFIX` / `proposalBranchFor` -- the derived head branch
 *   - `AUDIT_ISSUE_MARKER_PREFIX` / `auditIssueDedupeKey` -- the audit marker
 *   - `commentDedupeKey` / `checkDedupeKey` -- the deterministic job markers
 */

import { isVerbId } from "../jobs/verb-dispatch";
import { traced } from "../log";
import type { RunnerResult } from "../results/schema";
import { receiptSpecFor as templateReceiptSpecFor } from "../templates/registry";

export {
	RECEIPT_SPECS,
	type ReceiptSpec,
	receiptSpecFor,
} from "../templates/registry";

/** Publication kinds this registry can emit. Nothing else is postable. */
export const PUBLICATION_KINDS = ["label", "comment", "check", "issue"] as const;
export type PublicationKind = (typeof PUBLICATION_KINDS)[number];

/** Hard outbound caps. Defence-in-depth on top of the ingest schema caps. */
export const CAPS = {
	/** Max characters in a posted comment body. */
	commentBody: 4000,
	/** Max characters in a check-run title. */
	checkTitle: 120,
	/** Max characters in a check-run output summary. */
	checkSummary: 4000,
	/** Max characters of any single displayed finding line. */
	findingLine: 300,
	/** Max findings rendered into a comment/check summary. */
	findings: 20,
	/** Max characters in a posted/updated issue title. */
	issueTitle: 200,
	/** Max characters in a posted/updated issue body. */
	issueBody: 4000,
	/**
	 * Max check rows rendered into a proposal body's check trail.
	 *
	 * SIZED AGAINST THE WORST CASE, not a guess. The result schema caps `checks`
	 * at 100 with a 120-char name and a 2000-char summary each, so a naive render
	 * is ~200KB against a 4000-char body: the outer `capText` would then truncate
	 * the table MID-ROW and silently eat both the "…and K more" line and the
	 * `Closes #<n>` trailer below it — losing the issue link and hiding the fact
	 * that rows were dropped at all.
	 *
	 * So the SECTION bounds itself. One row costs at most
	 * `trailName` + `trailSummary` + ~25 characters of fixed markup (~285), the
	 * fixed body around it is ~450, and escaping can expand a character into an
	 * entity. 10 rows therefore lands near 3300 worst-case, inside `issueBody`
	 * with headroom for the escape expansion, and the truncation stays EXPLICIT.
	 * Raising this cap requires re-checking that product against `issueBody`;
	 * `tests/results/check-trail.test.ts` asserts it at the maximum trail shape.
	 */
	trailChecks: 10,
	/** Max characters of a displayed check NAME in the trail. */
	trailName: 60,
	/** Max characters of a displayed check SUMMARY in the trail. */
	trailSummary: 200,
	/**
	 * Max check NAMES listed in the status summary's scope line.
	 *
	 * The scope line exists so a green cannot be read as broader than the lane
	 * that produced it, which means it must stay readable at a glance: past a
	 * handful of names a reader stops reading and the line defeats its own
	 * purpose. Beyond this cap the line says how many more ran rather than
	 * naming them, so the COUNT is never wrong even when the list is partial.
	 *
	 * Bounded against `checkSummary` the same way `trailChecks` is bounded
	 * against `issueBody`: 6 names at `trailName` (60) plus separators is ~400
	 * worst-case, against a 4000-char summary that also carries up to 20
	 * findings. The outer `capText` stays a backstop, not the mechanism.
	 */
	scopeChecks: 6,
	/**
	 * Max distinct audit findings turned into their own issue in ONE result. A
	 * pathological audit surfacing thousands of findings must not fan out thousands
	 * of issue writes; beyond this cap the remaining findings are dropped for this
	 * result (a later run re-surfaces persistent ones), which is bounded and safe.
	 */
	issueFindings: 50,
} as const;

/**
 * The runner statuses that may SELECT a label. Closed and author-controlled, and
 * deliberately NOT the same set as {@link RESULT_LABELS}'s keys.
 *
 * These two used to be one object, and the receipt loop is what forced
 * them apart. `hold` is a state the FACTORY derives from a failed probe; it is
 * never a value a runner may report. While the vocabulary and the accepted-status
 * set were the same object, `buildPublicationPlans`'s admission guard read
 * `result.status in RESULT_LABELS`, so adding a `hold` member would silently have
 * made `{"status":"hold"}` a publishable runner result — a runner naming its own
 * terminal state. The ingest schema (`results/schema.ts`, `z.enum`) rejects it
 * today, which means the widening would have been a latent second-line failure
 * rather than an immediate one: exactly the shape that survives review.
 *
 * So the admission guard keys on THIS set, and the label vocabulary is free to
 * carry factory-derived states the runner cannot ask for.
 */
export const PUBLISHABLE_STATUSES = ["passed", "failed", "error", "skipped"] as const;

/** A runner-reportable status that maps to a label. */
export type PublishableStatus = (typeof PUBLISHABLE_STATUSES)[number];

/**
 * Whether a validated result's status may select a label. Author-controlled
 * membership test; a factory-derived state such as `hold` is deliberately absent.
 */
export const isPublishableStatus = traced(
	"github.isPublishableStatus",
	function isPublishableStatus(status: unknown): status is PublishableStatus {
		return (PUBLISHABLE_STATUSES as readonly unknown[]).includes(status);
	},
);

/**
 * THE STATE VOCABULARY — the ONE module every label/column string is read from.
 *
 * A runner's overall status maps to exactly one label to add; every other
 * allowlisted label is removed. The runner cannot introduce a label name — only
 * choose which fixed row applies via its validated status. `hold` is the one
 * member no status selects: the factory derives it (see {@link stateForOutcome}).
 *
 * SINGLE-SEAM RULE (#253 lands the wider label/column taxonomy in parallel).
 * Every label and column string this repo flips lives HERE and nowhere else, so
 * reconciling the two vocabularies at merge is a one-file rename rather than a
 * hunt. Checks and tests read the VALUES from this module rather than spelling
 * them, so a rename is free; only a KEY rename touches anything outside it.
 */
export const RESULT_LABELS = {
	passed: "watcher:passed",
	failed: "watcher:failed",
	error: "watcher:error",
	skipped: "watcher:skipped",
	/**
	 * HOLD — #254's honesty layer. A job whose receipt could not be produced lands
	 * here with a RED report, and NEVER in a done/closed state. It is factory-
	 * derived and unreachable from runner output: no member of
	 * {@link PUBLISHABLE_STATUSES} maps to it.
	 */
	hold: "watcher:hold",
} as const;

/**
 * Every label this watcher may ever add or remove.
 *
 * `hold` is included deliberately. The label transition set adds ONE member and
 * removes every other, so a stale `watcher:hold` from a previous failing run is
 * cleared when the job later succeeds. Omitting it would strand the hold label on
 * an item that has since gone green — a permanently-held card nothing can release.
 */
export const ALL_RESULT_LABELS = Object.values(RESULT_LABELS) as readonly string[];

/**
 * The state one job outcome flips to (#254 clauses 3 and 4).
 *
 * TWO INDEPENDENT WAYS TO LAND IN HOLD, and both are required:
 *
 *   1. THE JOB DID NOT SUCCEED. A `failed` or `error` status is a failed probe
 *      by definition — the work did not produce the outcome it was dispatched
 *      for. #254 clause 3 is verbatim that such a job HOLDs with a RED report and
 *      is never closed, so `watcher:failed` as a resting state is exactly what
 *      this replaces. A held card is an item a human must look at; a failed one
 *      reads as a finished job that happens to be red, and gets scrolled past.
 *   2. THE RECEIPT IS UNSATISFIED (`receiptOk` false). This catches the harder
 *      case: a runner reporting `passed` whose evidence does not support it —
 *      no check rows at all, or a failing row inside a nominally passing result.
 *      That is the declared-done-but-not-running defect itself, and without this
 *      arm the honesty layer only catches jobs already honest enough to say they
 *      failed.
 *
 * The function is one-directional on purpose: it can only ever DOWNGRADE an
 * outcome into hold, never upgrade a failure into a pass. `skipped` keeps its own
 * state — a skipped job made no claim to be verified.
 */
export const stateForOutcome = traced(
	"github.stateForOutcome",
	function stateForOutcome(status: PublishableStatus, receiptOk: boolean): string {
		if (status === "failed" || status === "error") {
			return RESULT_LABELS.hold;
		}
		if (!receiptOk) {
			return RESULT_LABELS.hold;
		}
		return RESULT_LABELS[status];
	},
);

/**
 * Whether this result's RECEIPT is satisfied (#254 clauses 2 and 3).
 *
 * The receipt is the job's own evidence that what it claims actually happened.
 * The verdict is derived from author-controlled inputs only — the allowlisted
 * template's fixed {@link ReceiptSpec} and the runner's already-schema-validated
 * per-check statuses. A runner cannot introduce a probe, choose its spec, or
 * declare its own receipt satisfied; it can only report check rows that this
 * function reads.
 *
 * WHICH JOB TYPE SELECTS THE SPEC MATTERS. It is `identity.jobType`, resolved
 * from the authoritative jobs -> repositories join, NOT the `job_type` the runner
 * put in its own result body. The two are normally equal, but only the first is
 * trusted: a runner that could choose which spec judges it would simply name a
 * `none-required` lane and receipt itself. Every other trusted field in this
 * module comes from the identity for exactly this reason.
 *
 * The rules, in order:
 *
 *   1. NO SPEC, NO FLIP. A job type carrying no receipt spec is off the
 *      allowlisted path entirely (dispatch is impossible for an unregistered
 *      template), so it HOLDs rather than flipping to a state nothing vouched for.
 *   2. A `none-required` lane is satisfied by construction — it is a report and
 *      mutates nothing live. This is a STATED decision recorded in the spec, not
 *      an absent check.
 *   3. Every other kind demands OBSERVED evidence: at least one check row, and no
 *      row in `fail`/`error`. The "at least one" half is the load-bearing part —
 *      without it a runner that died before running anything returns zero checks
 *      and vacuously satisfies its own receipt, which is precisely the
 *      declared-done-but-not-running defect. A job that produced no evidence has
 *      not produced a passing receipt.
 *
 * A `skip` row does not fail the receipt: skipping is a reported outcome, not a
 * failed probe. It cannot stand alone as the only evidence of a live surface,
 * which is what rule 3's presence requirement already covers.
 */
export const receiptSatisfied = traced(
	"github.receiptSatisfied",
	function receiptSatisfied(identity: JobIdentity, result: RunnerResult): boolean {
		const spec = templateReceiptSpecFor(identity.jobType);
		if (spec === null) {
			return false;
		}
		if (spec.kind === "none-required") {
			return true;
		}
		const checks = result.checks ?? [];
		if (checks.length === 0) {
			return false;
		}
		return !checks.some((check) => check.status === "fail" || check.status === "error");
	},
);

/** Fixed markers used as the (job, kind) idempotency target for singletons. */
export const COMMENT_TARGET = "comment";
export const CHECK_TARGET = "check";
/** Separate durable target/context for a terminal notice with no runner verdict. */
export const TERMINAL_CHECK_TARGET = "terminal-check";
export const TERMINAL_CHECK_NAME = "software-factory-terminal";
export const TERMINAL_CHECK_TITLE = "software-factory terminalized; no verdict produced";

/**
 * Trusted job identity. Every field is resolved from the authoritative DB join
 * (jobs -> repositories / github_items), never from the runner result. `sha` is
 * empty and `itemNumber` is null for itemless/shaless jobs.
 */
export interface JobIdentity {
	jobId: number;
	repository: string;
	itemNumber: number | null;
	sha: string;
	jobType: string;
	/**
	 * The k-board task this job was claimed FROM, read from
	 * `jobs.kboard_task_id` in the same trusted join as every other field here.
	 * `null` for a label-triggered job — the acknowledgment header then SAYS the
	 * job is unbound rather than inventing an id, because an ack that names a task
	 * the board does not know is worse than one that names none.
	 *
	 * Optional on the interface so the many call sites that construct an identity
	 * for a non-board path (and every existing test fixture) stay unchanged; a
	 * missing field reads the same as an explicit `null`.
	 */
	kboardTaskId?: string | null;
	/**
	 * The attempt this comment reports on, read from `job_attempts.id` in
	 * the same trusted resolution the result store already performs to find the
	 * attempt a runner result belongs to. Lets a reader of any factory comment name
	 * the exact run — job N, attempt M — and go find its row and its trace.
	 *
	 * IDS ONLY, NEVER A URL. Ruled by the controller (2026-08-16): a forge comment
	 * carries the identifiers and nothing else, and the clickable Langfuse link
	 * lives on the status page. The Langfuse host is LAN/tailnet-internal, so a URL
	 * in an outward-facing comment leaks an internal hostname — and because the
	 * comment carries no URL at all, no repository-visibility gate is needed and
	 * none exists. An id is meaningless to a stranger and sufficient for the
	 * operator, which is exactly the property wanted.
	 *
	 * Optional on the interface so every call site that constructs an identity
	 * without an attempt in hand (and every existing fixture) stays unchanged; a
	 * missing field renders no run reference rather than inventing an attempt
	 * number.
	 */
	attemptId?: number | null;
}

/** A label add/remove operation against the trusted item. */
export interface LabelPlan {
	kind: "label";
	action: "add" | "remove";
	/** Idempotency target within (job, label): the label name itself. */
	target: string;
	label: string;
	itemNumber: number;
}

/** The single deduplicated comment against the trusted item. */
export interface CommentPlan {
	kind: "comment";
	action: "upsert";
	target: typeof COMMENT_TARGET;
	itemNumber: number;
	/** Fully-bounded, redacted body including the hidden dedupe marker. */
	body: string;
	dedupeKey: string;
}

/** The normal exact-SHA external check against the trusted commit. */
interface NormalCheckPlan {
	kind: "check";
	action: "upsert";
	target: typeof CHECK_TARGET;
	/** Fixed check name/context — never runner-chosen. */
	name: string;
	/** The exact trusted commit SHA the check is bound to. */
	sha: string;
	conclusion: "success" | "failure" | "neutral";
	title: string;
	summary: string;
	/** Stable external id so a re-post targets the same check run. */
	dedupeKey: string;
}

/** The terminal notice check against the trusted commit, with no verdict. */
export interface TerminalCheckPlan {
	kind: "check";
	action: "upsert";
	target: typeof TERMINAL_CHECK_TARGET;
	name: typeof TERMINAL_CHECK_NAME;
	/** The exact trusted commit SHA the notice is bound to. */
	sha: string;
	/** A terminal notice never claims pass/fail. */
	conclusion: "neutral";
	title: typeof TERMINAL_CHECK_TITLE;
	summary: string;
	/** Stable external id so a repeated reap updates the same notice. */
	dedupeKey: string;
}

/** Both fixed check shapes accepted by the durable publisher. */
export type CheckPlan = NormalCheckPlan | TerminalCheckPlan;

/**
 * One audit-finding issue against the audit's repository. The watcher's
 * controller may OPEN a new issue (proven-absence) or UPDATE an existing one to
 * move a finding along; it MUST NEVER close an issue and MUST NEVER touch code —
 * closure is the fixer-PR flow (`Closes #N`), owned by fixer agents. `action`
 * carries only `open` or `update`; there is deliberately no `close`.
 *
 * The plan targets no source item — it creates/updates an issue on the audit's
 * repository. Dedupe is by the STABLE finding fingerprint carried in `dedupeKey`
 * and embedded as a hidden marker in the body, and `target` (the (job,kind)
 * idempotency target) is that same fingerprint. `cleared` records that the
 * finding was NOT present in this run's result, so the update COMMENTS/tags that
 * the finding cleared rather than editing the issue as still-open — still never
 * closing it.
 */
export interface IssuePlan {
	kind: "issue";
	action: "open" | "update";
	/** Idempotency target within (job, issue): the stable finding fingerprint. */
	target: string;
	/** Fully-bounded, redacted title. */
	title: string;
	/** Fully-bounded, redacted body including the hidden dedupe marker. */
	body: string;
	/**
	 * Hidden GitHub-side marker (`<!-- rodaddy-watcher:audit:<audit>:<fp> -->`) so a
	 * re-run recognizes the finding's own issue rather than opening a duplicate.
	 */
	dedupeKey: string;
	/**
	 * True when this plan represents a finding that CLEARED (was present before but
	 * absent in this run). The publisher then comments/tags the clearance on the
	 * existing issue instead of re-asserting it, and never opens a new issue for it.
	 */
	cleared: boolean;
}

/**
 * Open the change proposal for a VERIFIED change.
 *
 * This plan is only ever built after `results/change-ingest` has proven the
 * change: confined to its own job directory, rooted on the exact dispatched
 * base, and touching no CI workflow path. The plan therefore carries no bundle
 * path and no runner-supplied ref — by the time it exists, the bytes are already
 * trusted and the branch name is the watcher's own.
 *
 * `headBranch` is derived by the watcher from the trusted item number and job
 * type (`rw/issue-<n>` or `verb/<verb>-<n>`) and is NEVER taken from runner
 * output: a runner that could name the branch could name someone else's.
 *
 * Dedupe is by the branch pair at the forge (`GET /pulls/{base}/{head}`), so a
 * re-publish returns the existing proposal instead of opening a second. There is
 * deliberately no `action: "update"`: this plan opens a proposal or recognizes
 * one, and never edits, marks ready, or merges.
 */
export interface ProposalPlan {
	kind: "proposal";
	/**
	 * Always `open`. Unlike the issue plan there is deliberately no `update`
	 * counterpart: recognizing an existing proposal is a DEDUPE at the forge, not
	 * a second action, so this lane has exactly one thing it can do.
	 */
	action: "open";
	/** Idempotency target within (job, kind): the watcher-derived head branch. */
	target: string;
	/** The watcher-derived source branch, always inside a reserved namespace. */
	headBranch: string;
	/** The branch the proposal merges into. */
	baseBranch: string;
	/** Fully-bounded, redacted title. */
	title: string;
	/** Fully-bounded, redacted body. */
	body: string;
	/** The item this change implements, linked for traceability. */
	itemNumber: number;
	/**
	 * Whether to request not-ready-to-merge state. Forgejo 16.0.1 cannot express
	 * this natively, so the client falls back to a `WIP:` marker and reports which
	 * guarantee was actually obtained; the real block is branch protection.
	 */
	draft: boolean;
}

/** One approved, bounded, ready-to-persist publication operation. */
export type PublicationPlan = LabelPlan | CommentPlan | CheckPlan | IssuePlan | ProposalPlan;

/** The reserved branch prefix every non-verb watcher proposal lives under. */
export const PROPOSAL_BRANCH_PREFIX = "rw/" as const;

/** The reserved namespace for allowlisted deterministic verb proposals. */
export const VERB_PROPOSAL_BRANCH_PREFIX = "verb/" as const;

/**
 * The branch name the watcher will push for one trusted item and job type.
 *
 * Both components are validated before interpolation: the item must be a
 * positive integer, and a verb component is emitted only when `jobType` is one
 * of the fixed reviewed verb ids. Every other job type keeps the existing
 * `rw/issue-<n>` branch. A bad item number yields null so callers fail closed
 * rather than pushing to a guessed ref.
 */
export const proposalBranchFor = traced(
	"github.proposalBranchFor",
	function proposalBranchFor(itemNumber: number, jobType: string): string | null {
		if (!Number.isInteger(itemNumber) || itemNumber <= 0) {
			return null;
		}
		if (isVerbId(jobType)) {
			return `${VERB_PROPOSAL_BRANCH_PREFIX}${jobType}-${itemNumber}`;
		}
		return `${PROPOSAL_BRANCH_PREFIX}issue-${itemNumber}`;
	},
);

/**
 * Fixed prefix for the hidden audit-issue dedupe marker. Author-controlled.
 *
 * DELIBERATELY still `rodaddy-watcher` after the software-factory rename.
 * This string is not a label — it is the DEDUPE KEY matched against markers
 * already embedded in live GitHub issues. Renaming it makes every existing audit
 * issue invisible to `findAuditIssueByMarker`, so the next sweep files a
 * DUPLICATE issue for every finding that is already tracked.
 *
 * Changing it therefore requires a migration that rewrites the marker in every
 * existing audit issue first, which is not worth doing for a cosmetic rename.
 */
export const AUDIT_ISSUE_MARKER_PREFIX = "rodaddy-watcher:audit";

/**
 * The deterministic hidden marker for one audit finding's issue. Composed only
 * from the fixed prefix, the audit name (a validated slug), and the stable
 * finding fingerprint — never any run-varying text — so the SAME finding across
 * runs derives the SAME marker and dedupes onto its own issue.
 */
export const auditIssueDedupeKey = traced(
	"github.auditIssueDedupeKey",
	function auditIssueDedupeKey(auditName: string, fingerprint: string): string {
		return `${AUDIT_ISSUE_MARKER_PREFIX}:${auditName}:${fingerprint}`;
	},
);

/**
 * Fixed check name/context. Author-controlled; never from runner output.
 *
 * Renamed with the repository. Unlike `AUDIT_ISSUE_MARKER_PREFIX` this is
 * safe to change: a check name is not a dedupe key, so the worst effect is that
 * check runs published before the rename keep the old name in PR history. It
 * would NOT be safe if a required-status-check rule named the old value — but
 * branch protection is unavailable on this private free-tier repository
 * (verified: the protection API returns 403 "Upgrade to GitHub Pro"), so nothing
 * enforced depends on it. Re-check this if the repo ever goes public or Pro.
 */
export const CHECK_NAME = "software-factory";

/** Deterministic dedupe marker for the single comment of a job. */
export const commentDedupeKey = traced(
	"github.commentDedupeKey",
	function commentDedupeKey(identity: JobIdentity): string {
		return `software-factory:comment:job-${identity.jobId}`;
	},
);

/** Deterministic external id for the single check of a job, bound to its SHA. */
export const checkDedupeKey = traced(
	"github.checkDedupeKey",
	function checkDedupeKey(identity: JobIdentity): string {
		return `software-factory:check:job-${identity.jobId}:${identity.sha}`;
	},
);

/** Deterministic external id for one terminal notice, bound to its job and SHA. */
export const terminalCheckDedupeKey = traced(
	"github.terminalCheckDedupeKey",
	function terminalCheckDedupeKey(identity: Pick<JobIdentity, "jobId" | "sha">): string {
		return `software-factory:terminal-check:job-${identity.jobId}:${identity.sha}`;
	},
);

/** Fixed summary prefix; the suffix is the bounded, watcher-authored terminal reason. */
export const terminalCheckSummaryPrefix = traced(
	"github.terminalCheckSummaryPrefix",
	function terminalCheckSummaryPrefix(jobId: number): string {
		return `Job ${jobId} was terminalized; no verdict was produced. Reason: `;
	},
);
