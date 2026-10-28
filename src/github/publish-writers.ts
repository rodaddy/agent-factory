/**
 * @module github/publish-writers
 * @description The per-plan-kind write paths of the posting reconciler. Split out
 *   of `github/publish.ts` as the one-plan-one-remote-operation region: each
 *   writer runs the plan's GitHub-side dedupe read, decides create vs update,
 *   and performs the single bounded write — or, in shadow mode, hands the
 *   intended write to the caller's ledger recorder instead.
 *
 *   The orchestrator still owns the row lock, the transaction, and the terminal
 *   state update. These writers receive the already-resolved forge client, the
 *   already-revalidated plan, and the trusted target, and return the same
 *   posted/deduped/failed outcome the class methods returned before the move.
 *
 *   The least-privilege boundary is unchanged: the issue writer only ever POSTs a
 *   new issue or PATCHes title/body — it never sends a `state` field, so it can
 *   neither close nor reopen — and the proposal writer only asks the forge to
 *   open a proposal for a branch that already exists. Shadow mode still gates
 *   every write, including the proposal path, whose live effect is the one
 *   code-bearing object in the set.
 *
 * @outputs
 *   - `PlanWriteOutcome` -- the posted / deduped / failed union
 *   - `WriteContext` -- the injected client, shadow flag, and ledger recorder
 *   - `publishLabel` / `publishComment` / `publishIssue` / `publishProposal` /
 *     `publishCheck` -- the five bounded write paths
 *
 * @dependencies
 *   - ../log -- the one logger, for the traced() wrapper
 *   - ../forge/boundary -- the bounded write seam
 *   - ./publish-dedupe -- the bounded GitHub-side dedupe scans
 *   - ./publish-decode -- shared shape guards and `requireExternalId`
 */
import type { CommitCheck, ForgeClient } from "../forge/boundary";
import { addIssueLabels, isAbsentLabelError, removeIssueLabel } from "../forge/labels";
import type { Provider } from "../forge/provider";
import { log, traced } from "../log";
import type { CheckPlan, CommentPlan, IssuePlan, LabelPlan, ProposalPlan } from "./publication";
import { requireExternalId, UNPUBLISHABLE } from "./publish-decode";
import { findCheckRun, findMarkedComment, findMarkedIssue } from "./publish-dedupe";

/**
 * The outcome of one plan's single remote operation.
 *
 * A `failed` outcome is RETRYABLE by default: the orchestrator bumps the attempt
 * count and reschedules until the budget is spent. `terminal: true` is
 * the narrow opposite — the write can never succeed no matter how often it is
 * retried, so the row is failed immediately instead of burning the budget. Only
 * a write path that has PROVEN the impossibility may set it; the classification
 * is made at the boundary that saw the provider's response, never by
 * string-matching a reason downstream.
 */
export type PlanWriteOutcome =
	| { status: "posted" | "deduped"; externalRef?: string }
	| { status: "failed"; reason: string; terminal?: boolean };

/** The authoritative target resolved from the jobs join. */
export interface ResolvedTarget {
	provider: Provider;
	repository: string;
	itemNumber: number | null;
	sha: string;
	/**
	 * Trusted full Git SHA for a redirected verb CHECK. `sha` remains the job and
	 * plan identity used by authorization and dedupe; this is only the commit
	 * addressed by the destination repository's status API.
	 */
	checkSha?: string;
	/** The job's type, authoritative for whether an issue plan is an audit issue. */
	jobType: string;
	/** Current item facts for the item-level eligibility gate. */
	itemKind: string | null;
	itemState: string | null;
	itemHeadSha: string | null;
	/**
	 * sf#599 — the commit-status context a CHECK plan must post under, when the
	 * plan's own `name` is not correct for this target. Set ONLY by the verb
	 * redirect, which moves the check onto the change base repository and must
	 * carry a context DISTINCT from the sop-gate family, so a factory receipt can
	 * never be read as a merge judgment on a repo whose main requires sop-gate.
	 * Absent for every other target, which leaves the plan's `name` authoritative.
	 *
	 * It is a TARGET field rather than a plan field on purpose: `publish-decode`
	 * pins a stored check plan's `name` to `CHECK_NAME`, and the redirect is a
	 * property of where the write lands, not of what the runner reported.
	 */
	checkContext?: string;
}

/**
 * Everything a writer needs that the orchestrator owns: the resolved client, the
 * shadow flag, and the ledger recorder that stands in for a GitHub write when
 * shadow mode is on. `recordShadow` writes through the orchestrator's own
 * transaction, so a ledger row still commits atomically with the row's terminal
 * state.
 */
export interface WriteContext {
	client: ForgeClient;
	shadow: boolean;
	recordShadow: (
		wouldAction: "created" | "deduped",
	) => Promise<{ status: "posted" | "deduped"; externalRef?: string }>;
}

/**
 * Apply a fixed label transition against the trusted item. Labels are
 * naturally idempotent: adding an existing label or removing an absent one is
 * a no-op on either host, so a crash-retry never duplicates.
 */
export const publishLabel = traced(
	"github.publishLabel",
	async function publishLabel(
		ctx: WriteContext,
		plan: LabelPlan,
		target: ResolvedTarget,
	): Promise<PlanWriteOutcome> {
		if (ctx.shadow) {
			// Labels are naturally idempotent (no dedupe read); the intended effect IS
			// the plan's fixed add/remove action. Record it and skip the GitHub write.
			return ctx.recordShadow("created");
		}
		// sf#816: the one label writer, keyed by NAME on both hosts (no id lookup).
		if (plan.action === "add") {
			const data = await addIssueLabels(ctx.client, target.repository, plan.itemNumber, [
				plan.label,
			]);
			// Both hosts return the item's full label set. Confirm our fixed label is
			// present before marking `posted`; a body that omits it (or is malformed)
			// leaves the add unproven, so stay retryable rather than record a false add.
			// Forgejo silently drops a name the repo does not define; this catches that too.
			if (!Array.isArray(data) || !data.some((l) => l?.name === plan.label)) {
				return { status: "failed", reason: "add-label response did not confirm the label" };
			}
		} else {
			// Remove is idempotent: an absent label (GitHub 404, Forgejo 422) is success.
			try {
				await removeIssueLabel(ctx.client, target.repository, plan.itemNumber, plan.label);
			} catch (error) {
				if (!isAbsentLabelError(error)) throw error;
			}
		}
		return { status: "posted" };
	},
	{ redact: { args: [0] } },
);

/**
 * Upsert the single deduplicated comment. GitHub-side dedup: list existing
 * comments and reuse the one carrying this job's hidden marker (PATCH it)
 * rather than posting a second. A crash after a create but before the local
 * `posted` update is recovered here — the marker is found and the row records
 * the existing comment instead of duplicating.
 */
export const publishComment = traced(
	"github.publishComment",
	async function publishComment(
		ctx: WriteContext,
		plan: CommentPlan,
		target: ResolvedTarget,
		dedupeKey: string,
	): Promise<PlanWriteOutcome> {
		// The dedupe READ runs in shadow mode too — it is a safe GitHub read and
		// preserves dedupe semantics, so a shadow record reflects the same create-vs-
		// update decision the real path would take.
		const existing = await findMarkedComment(
			ctx.client,
			target.repository,
			plan.itemNumber,
			dedupeKey,
		);
		if (existing.status === "indeterminate") {
			// The dedupe scan could not prove absence (truncated / malformed). Refuse
			// to POST a new comment — a create here could duplicate — and stay retryable.
			// Shadow mode obeys the same rule: never record a would-post it can't prove.
			return { status: "failed", reason: `comment dedupe indeterminate: ${existing.reason}` };
		}
		if (ctx.shadow) {
			// Record the intended write; a found marker WOULD be a PATCH (deduped), an
			// absent marker WOULD be a POST (created). No GitHub write is performed.
			return ctx.recordShadow(existing.status === "found" ? "deduped" : "created");
		}
		if (existing.status === "found") {
			await ctx.client.write(
				"PATCH",
				`/repos/${target.repository}/issues/comments/${existing.id}`,
				{
					body: plan.body,
				},
			);
			return { status: "deduped", externalRef: String(existing.id) };
		}
		const res = await ctx.client.write<{ id: number }>(
			"POST",
			`/repos/${target.repository}/issues/${plan.itemNumber}/comments`,
			{ body: plan.body },
		);
		return { status: "posted", externalRef: requireExternalId(res.data?.id) };
	},
	{ redact: { args: [0, 1] } },
);

/**
 * Open or update the single issue for one audit finding. GitHub-side
 * dedupe: scan the repository's issues (open AND closed) for this finding's
 * hidden marker. When the marker is absent (PROVEN over a fully-consumed scan)
 * the finding has no issue yet — POST a new one (open). When it is found — even
 * on a closed issue — the finding already has an issue, so PATCH it to
 * update/comment/tag it along; NEVER change its state to closed and NEVER touch
 * code. A truncated or malformed scan is `indeterminate`: refuse to POST (a
 * create could duplicate) and stay retryable.
 *
 * The watcher's least-privilege boundary is enforced here: the ONLY writes this
 * function performs are `POST /issues` (open) and `PATCH /issues/{n}` with a
 * title/body update — never a `state: closed` field, never a code write.
 */
export const publishIssue = traced(
	"github.publishIssue",
	async function publishIssue(
		ctx: WriteContext,
		plan: IssuePlan,
		target: ResolvedTarget,
		dedupeKey: string,
	): Promise<PlanWriteOutcome> {
		// The dedupe READ runs in shadow mode too (safe GitHub read), so a shadow
		// record reflects the same open-vs-update decision the real path would take.
		const existing = await findMarkedIssue(ctx.client, target.repository, dedupeKey);
		if (existing.status === "indeterminate") {
			// Absence unproven (truncated / malformed). Refuse to POST a new issue,
			// which could duplicate, and stay retryable — shadow mode obeys this too.
			return { status: "failed", reason: `issue dedupe indeterminate: ${existing.reason}` };
		}
		// A CLEARED plan must never open a new issue: if the finding's issue no longer
		// exists (or was never opened), there is nothing to comment a clearance on, so
		// the clearance is simply a no-op — the finding is gone and no issue tracks it.
		if (plan.cleared && existing.status !== "found") {
			return { status: "deduped" };
		}
		if (ctx.shadow) {
			// Record the intended write; a found marker WOULD be a PATCH (deduped/update),
			// an absent marker WOULD be a POST (created/open). No GitHub write is performed.
			return ctx.recordShadow(existing.status === "found" ? "deduped" : "created");
		}
		if (existing.status === "found") {
			// UPDATE only: title/body. NEVER send `state` — the watcher never closes an
			// issue (closure is the fixer-PR `Closes #N` flow) and never reopens one.
			await ctx.client.write("PATCH", `/repos/${target.repository}/issues/${existing.id}`, {
				title: plan.title,
				body: plan.body,
			});
			return { status: "deduped", externalRef: String(existing.id) };
		}
		// Absent: open a new issue for this finding.
		const res = await ctx.client.write<{ number: number }>(
			"POST",
			`/repos/${target.repository}/issues`,
			{ title: plan.title, body: plan.body },
		);
		return { status: "posted", externalRef: requireExternalId(res.data?.number) };
	},
	{ redact: { args: [0, 1] } },
);

/**
 * Open the change proposal for an already-pushed, already-VERIFIED change.
 * Everything dangerous about a runner-authored change was settled
 * before this point: `results/change-ingest` proved the bundle's confinement,
 * base, and scope, and `targetAuthorizes` proved the branch is the watcher's
 * own derived ref. This function therefore only asks the forge to open a
 * proposal for that branch.
 *
 * Delegated to the provider client's `openChangeProposal`, which is OPTIONAL
 * on the boundary. A provider that cannot host code (or has not implemented
 * the verb) yields a bounded failure rather than a thrown error, so a
 * non-forge provider can never be coerced into a code write.
 *
 * The least-privilege boundary: the only write performed is a proposal
 * create. There is no merge, no ready-for-review flip, no force-push, and no
 * branch write — the branch already exists.
 */
export const publishProposal = traced(
	"github.publishProposal",
	async function publishProposal(
		ctx: WriteContext,
		plan: ProposalPlan,
		target: ResolvedTarget,
	): Promise<PlanWriteOutcome> {
		if (ctx.shadow) {
			// Shadow mode must NEVER open a real proposal. This is the one plan kind
			// whose live effect is a code-bearing object, so a missing shadow gate here
			// would be the most consequential possible leak of the compare period.
			return ctx.recordShadow("created");
		}
		const client = ctx.client;
		if (typeof client.openChangeProposal !== "function") {
			return { status: "failed", reason: "provider cannot receive a change proposal" };
		}
		const outcome = await client.openChangeProposal(target.repository, {
			headBranch: plan.headBranch,
			baseBranch: plan.baseBranch,
			title: plan.title,
			body: plan.body,
			itemNumber: plan.itemNumber,
			draft: plan.draft,
		});
		if (outcome.status === "failed") {
			return { status: "failed", reason: outcome.reason };
		}
		if (outcome.status === "deduped") {
			return { status: "deduped", externalRef: String(outcome.number) };
		}
		// Record which not-ready guarantee was actually obtained. A `wip-marker` is
		// a convention a human can merge straight past; only `native` is enforced by
		// the forge. Logged so an operator can tell the two apart after the fact.
		log("info", "publish.proposal.opened", {
			repository: target.repository,
			number: outcome.number,
			draft_mode: outcome.draftMode,
		});
		return { status: "posted", externalRef: String(outcome.number) };
	},
	{ redact: { args: [0, 1] } },
);

/**
 * Upsert the single exact-SHA external check run. GitHub-side dedup: the
 * stable `external_id` lets a re-post find and update the same check run
 * rather than creating a second, so a crash between create and the local
 * `posted` update recovers without a duplicate.
 */
export const publishCheck = traced(
	"github.publishCheck",
	async function publishCheck(
		ctx: WriteContext,
		plan: CheckPlan,
		target: ResolvedTarget,
		dedupeKey: string,
	): Promise<PlanWriteOutcome> {
		const checkSha = target.checkSha ?? plan.sha;
		const check: CommitCheck = {
			sha: checkSha,
			// sf#599: the redirected verb check posts under the target's own context so
			// it can never collide with, or be mistaken for, the sop-gate family on the
			// change base repository. Every other target leaves the plan's name intact.
			context: target.checkContext ?? plan.name,
			conclusion: plan.conclusion,
			title: plan.title,
			summary: plan.summary,
			dedupeKey,
		};
		if (ctx.shadow) {
			const existing =
				target.provider === "github"
					? await findCheckRun({
							client: ctx.client,
							repository: target.repository,
							sha: checkSha,
							checkName: plan.name,
							dedupeKey,
						})
					: await ctx.client.findCommitCheck(target.repository, check);
			if (existing.status === "indeterminate") {
				return { status: "failed", reason: `check dedupe indeterminate: ${existing.reason}` };
			}
			return ctx.recordShadow(existing.status === "found" ? "deduped" : "created");
		}
		if (typeof ctx.client.postCommitCheck === "function") {
			return ctx.client.postCommitCheck(target.repository, check);
		}

		// Compatibility fallback for legacy focused fakes. Production clients
		// always implement the provider-aware seam above.
		return publishCheckFallback(ctx, plan, target, dedupeKey);
	},
	{ redact: { args: [0, 1] } },
);

/**
 * The legacy direct check-run upsert, used only when the client does not
 * implement the provider-aware `postCommitCheck` seam. Extracted from
 * `publishCheck` purely to keep it within the function ceiling; the dedupe scan
 * and the two bounded writes are unchanged.
 */
async function publishCheckFallback(
	ctx: WriteContext,
	plan: CheckPlan,
	target: ResolvedTarget,
	dedupeKey: string,
): Promise<PlanWriteOutcome> {
	const checkSha = target.checkSha ?? plan.sha;
	const existing = await findCheckRun({
		client: ctx.client,
		repository: target.repository,
		sha: checkSha,
		checkName: plan.name,
		dedupeKey,
	});
	if (existing.status === "indeterminate") {
		return { status: "failed", reason: `check dedupe indeterminate: ${existing.reason}` };
	}
	const updateBody = {
		name: plan.name,
		status: "completed",
		conclusion: plan.conclusion,
		external_id: dedupeKey,
		output: { title: plan.title, summary: plan.summary },
	};
	if (existing.status === "found") {
		await ctx.client.write(
			"PATCH",
			`/repos/${target.repository}/check-runs/${existing.id}`,
			updateBody,
		);
		return { status: "deduped", externalRef: String(existing.id) };
	}
	const res = await ctx.client.write<{ id: number }>(
		"POST",
		`/repos/${target.repository}/check-runs`,
		{
			...updateBody,
			head_sha: checkSha,
		},
	);
	return { status: "posted", externalRef: requireExternalId(res.data?.id) };
}

export { UNPUBLISHABLE };
