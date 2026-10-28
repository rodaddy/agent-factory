/**
 * @module hooks/pr-review
 * @description Dispatch the pr-review Forgejo Actions lane for a
 *   pull-request delivery on any enrolled Forgejo repository whose watcher
 *   config sets `pr_review_runtime: actions` and leaves `pr_review` on. Absent
 *   or `box` runtime dispatches nothing: reconcile keeps its box review job
 *   (src/reconcile/pass.ts reads the same flag).
 *
 *   Same rules as `./infra-static`: the set of repositories comes from the
 *   loaded config, the workflow file, dispatch repo and ref are fixed constants,
 *   and the only payload values read are the PR number, head sha and base sha,
 *   each validated to a narrow shape before use. The workflow validates them
 *   again (scripts/actions/validate-inputs.ts) before any use.
 *
 *   Excluded: a `static-only` repo (its lane is infra-static), a GitHub repo
 *   (not on this forge). software-factory itself is reviewed by dispatch
 *   like any enrolled repo: pr-review.yml is dispatch-only (D23).
 *
 *   The write goes through `guardDispatches` over `DISPATCH_TARGETS`,
 *   and every accepted dispatch is recorded in `forge_runs` through the
 *   optional `record` seam. The row's `repo` is the workflow HOST repo
 *   (`SOP_GATE_DISPATCH_REPO`, per the forge_runs schema); the reviewed repo
 *   is `inputs.repo`. `run_id` is null at dispatch time; 476c's `workflow_run`
 *   receiver fills `run_id` and `state`.
 *
 *   NEVER REJECTS and never logs a payload or a token.
 *
 * @outputs
 *   - `createPrReviewTrigger` -- build the trigger over a write, read and record seam
 */
import type { DispatchRecord } from "../forge/actions-store";
import { errorClass, log, traced } from "../log";
import { type DispatchGuardOptions, guardDispatches } from "./dispatch-guard";
import {
	DISPATCH_TARGETS,
	PR_REVIEW_WORKFLOW_FILE,
	SOP_GATE_DISPATCH_REPO,
	type SopGateDelivery,
	type SopGateRead,
	type SopGateTrigger,
	type SopGateWrite,
} from "./sop-gate";

/** Forgejo API base. Pinned to the one reviewed deployment (`forgejo/config.ts`). */
const API_BASE = "https://forge.example.internal/api/v1";

/** Payload `action` values that mean "the head commit changed or arrived". */
const QUALIFYING_ACTIONS: ReadonlySet<string> = new Set(["opened", "synchronized", "reopened"]);

/** A full 40-character lowercase-hex commit sha, and nothing else. */
const SHA = /^[0-9a-f]{40}$/;

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	return (value as Record<string, unknown>)[key];
}

/** The config fields this module reads off each repository entry. */
export interface PrReviewRepo {
	name: string;
	provider: string;
	checks: string;
	pr_review?: boolean;
	pr_review_runtime?: "box" | "actions";
}

/** Persist one dispatch; the receiver wires this to `recordDispatch(db, ...)`. */
export type PrReviewRecord = (rec: DispatchRecord) => Promise<unknown>;

/** Test and wiring seams: the #808 guard's clock, and the forge_runs recorder. */
export interface PrReviewOptions {
	guard?: DispatchGuardOptions;
	record?: PrReviewRecord;
}

/** The enrolled Forgejo repos this lane reviews, software-factory included (sf#927 D23: dispatch-only). */
function reviewedRepos(repositories: readonly PrReviewRepo[]): ReadonlySet<string> {
	return new Set(
		repositories
			.filter(
				(repo) =>
					repo.provider === "forgejo" &&
					repo.pr_review !== false &&
					repo.pr_review_runtime === "actions" &&
					repo.checks !== "static-only",
			)
			.map((repo) => repo.name),
	);
}

/**
 * Record one dispatch in forge_runs; a failure is logged, never thrown. `repo`
 * is the workflow host, where the run lives; the target repo rides in `inputs`.
 */
async function recordQuietly(
	record: PrReviewRecord,
	repo: string,
	inputs: { head_sha: string } & Record<string, string>,
): Promise<void> {
	try {
		await record({
			repo: SOP_GATE_DISPATCH_REPO,
			workflow: PR_REVIEW_WORKFLOW_FILE,
			runId: null,
			targetSha: inputs.head_sha,
			inputs,
		});
	} catch (err) {
		log("warn", "hooks.pr_review.record_failed", {
			error_class: errorClass(err),
			repository: repo,
		});
	}
}

/** The workflow inputs, or null when the PR number or either sha is malformed. */
function dispatchInputs(delivery: SopGateDelivery):
	| (DispatchRecord["inputs"] & {
			head_sha: string;
	  })
	| null {
	const pr = property(delivery.payload, "pull_request");
	const number = property(pr, "number");
	const headSha = property(property(pr, "head"), "sha");
	const baseSha = property(property(pr, "base"), "sha");
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
		return null;
	}
	if (typeof headSha !== "string" || !SHA.test(headSha)) {
		return null;
	}
	if (typeof baseSha !== "string" || !SHA.test(baseSha)) {
		return null;
	}
	return {
		repo: delivery.repository,
		number: String(number),
		head_sha: headSha,
		base_sha: baseSha,
		// sf#708 (D15): the constant first-attempt level. Respawn escalation to
		// `debug` on Actions arrives with the #417b re-dispatch.
		log_level: "info",
	};
}

/** The commit-status context the pr-review lane publishes (scripts/actions/post-pr-review.ts). */
const REVIEW_CONTEXT = "factory/pr-review";

/**
 * Settled pr-review states that mean the head was already reviewed.
 * `error` (the job broke or the comment did not post) and `pending` are not:
 * those heads may be dispatched again. An advisory `success` whose
 * description names a failure rather than a landed review is treated like
 * `error`: only the two advisory verdict descriptions count as reviewed.
 */
const COMPLETED_STATES: ReadonlySet<string> = new Set(["success", "failure", "warning"]);

/** The description prefix of every advisory-mode status (scripts/actions/post-pr-review.ts). */
const ADVISORY_PREFIX = "pr-review advisory:";

/** The advisory descriptions of a review that landed; any other advisory success re-dispatches. */
const ADVISORY_REVIEWED = [
	"pr-review advisory: no blocking findings",
	"pr-review advisory: blocking findings in the comment",
] as const;

/**
 * Has this exact head already got a completed `factory/pr-review` result
 *? The combined-status endpoint answers the latest row per context.
 * Never throws: an unreadable or malformed answer returns false, so a probe
 * failure dispatches rather than silently dropping a review. The explicit
 * re-run override is a manual `workflow_dispatch` of pr-review.yml, which does
 * not pass through this hook.
 */
async function alreadyReviewed(
	read: SopGateRead,
	repository: string,
	sha: string,
): Promise<boolean> {
	try {
		const response = await read(`${API_BASE}/repos/${repository}/commits/${sha}/status`);
		const statuses = property(response.data, "statuses");
		if (!Array.isArray(statuses)) {
			return false;
		}
		return statuses.some((entry) => {
			const state = property(entry, "status");
			const description = property(entry, "description");
			if (
				property(entry, "context") !== REVIEW_CONTEXT ||
				typeof state !== "string" ||
				!COMPLETED_STATES.has(state)
			) {
				return false;
			}
			if (
				state === "success" &&
				typeof description === "string" &&
				description.startsWith(ADVISORY_PREFIX)
			) {
				return ADVISORY_REVIEWED.some((reviewed) => description.startsWith(reviewed));
			}
			return true;
		});
	} catch (err) {
		log("warn", "hooks.pr_review.status_read_failed", {
			error_class: errorClass(err),
			repository,
		});
		return false;
	}
}

/**
 * A qualifying action, or a title edit: leaving WIP (Forgejo's draft) arrives
 * as `edited` with `changes.title`. Any other `edited` is ignored.
 */
function qualifies(payload: unknown): boolean {
	const action = property(payload, "action");
	if (typeof action !== "string") {
		return false;
	}
	if (QUALIFYING_ACTIONS.has(action)) {
		return true;
	}
	return action === "edited" && property(property(payload, "changes"), "title") !== undefined;
}

function createPrReviewTriggerImpl(
	forgeWrite: SopGateWrite,
	read: SopGateRead,
	repositories: readonly PrReviewRepo[],
	options: PrReviewOptions = {},
): SopGateTrigger {
	const repos = reviewedRepos(repositories);
	const write = guardDispatches(forgeWrite, read, DISPATCH_TARGETS, options.guard);
	const url = `${API_BASE}/repos/${SOP_GATE_DISPATCH_REPO}/actions/workflows/${PR_REVIEW_WORKFLOW_FILE}/dispatches`;
	return async function triggerPrReview(delivery: SopGateDelivery): Promise<void> {
		if (delivery.event !== "pull_request" || !repos.has(delivery.repository)) {
			return;
		}
		if (!qualifies(delivery.payload)) {
			return;
		}
		const inputs = dispatchInputs(delivery);
		if (inputs === null) {
			log("warn", "hooks.pr_review.malformed", { repository: delivery.repository });
			return;
		}
		const ids = { repository: delivery.repository, pr_number: inputs.number };
		// A WIP title makes the PR a draft: no review until WIP leaves the title.
		if (property(property(delivery.payload, "pull_request"), "draft") === true) {
			log("info", `pr-review: skip ${delivery.repository}#${inputs.number}, draft (WIP title)`, {
				...ids,
				head_sha: inputs.head_sha,
			});
			return;
		}
		if (await alreadyReviewed(read, delivery.repository, inputs.head_sha)) {
			log(
				"info",
				`pr-review: skip ${delivery.repository}#${inputs.number}@${inputs.head_sha.slice(0, 7)}, already reviewed`,
				{ ...ids, head_sha: inputs.head_sha },
			);
			return;
		}
		try {
			await write("POST", url, { ref: "main", inputs });
		} catch (err) {
			log("warn", "hooks.pr_review.dispatch_failed", { error_class: errorClass(err), ...ids });
			return;
		}
		log("info", "hooks.pr_review.dispatched", { ...ids, head_sha: inputs.head_sha });
		if (options.record !== undefined) {
			await recordQuietly(options.record, delivery.repository, inputs);
		}
	};
}

export const createPrReviewTrigger = traced(
	"hooks.createPrReviewTrigger",
	createPrReviewTriggerImpl,
);
