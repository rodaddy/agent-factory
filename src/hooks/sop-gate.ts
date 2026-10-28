/**
 * @module hooks/sop-gate
 * @description The watcher's bridge from an inbound Forgejo pull-request
 *   delivery to the SOP gate that judges it. A NEW delivery on the one
 *   gated repository marks the head commit `pending` and then asks the factory's
 *   own Forgejo Actions workflow to run — nothing more.
 *
 *   CONFIGURATION COMES FROM CODE, NEVER FROM REPOSITORY CONTENT. The gated
 *   repository, the commit-status context, the dispatch repository, the workflow
 *   file, and the dispatch ref are fixed constants in this file. A webhook body
 *   can select NOTHING: it cannot name a repository to post to, a workflow to
 *   run, or a ref to run it on. The only two values read out of a payload are a
 *   pull-request number and a head sha, and both are validated to a narrow shape
 *   before they are interpolated into a path or a body. That is what keeps the
 *   receiver's "the hook is a hint, never an instruction" property intact while
 *   still letting a delivery cause an effect.
 *
 *   THE TRIGGER NEVER DELAYS OR FAILS THE WEBHOOK RESPONSE. The receiver calls
 *   it fire-and-forget; this module additionally swallows every failure and logs
 *   it by error CLASS only. A forge answered an error retries the delivery, and
 *   the delivery is already durably stored by the time this runs, so surfacing a
 *   gate failure into the response would cause a replay that the dedupe key then
 *   correctly refuses — losing the event entirely.
 *
 *   A SECOND QUALIFYING SHAPE: a `push` delivery on the same gated repository
 *   whose top-level `ref` is exactly `refs/heads/main` marks the merge commit
 *   `sop-verify` pending and dispatches `sop-verify.yml`. The
 *   same rule holds — configuration comes from code, and the ONLY payload-sourced
 *   value on this path is the top-level `after` sha, validated to 40 lowercase
 *   hex characters AND rejected when it is the all-zeros sha, which a Forgejo
 *   branch-deletion push carries and which names no commit to post a status on.
 *   The ref is compared against a fixed literal rather than parsed, so a payload
 *   cannot select a branch to verify.
 *
 *   A THIRD QUALIFYING SHAPE: a `push` to `refs/heads/main` on the one enrolled
 *   content repository (`SITE_PUBLISH_SOURCE_REPO`) marks that commit
 *   `site-publish` pending on the SOURCE repository and dispatches
 *   `site-publish.yml` (rtech-consulting #307, publish-on-main). Same rules,
 *   same validation of `after`; the optional `before` is forwarded only when it
 *   is itself a sha and is otherwise the empty string. See the constant's doc.
 *
 *   A FOURTH QUALIFYING SHAPE: a `push` to `refs/heads/main` on the one hosted-app
 *   registry repository (`HOSTED_APP_REGISTRY_REPO`) marks that commit
 *   `hosted-app-render` pending on THAT repository and dispatches
 *   `hosted-app-render.yml`. Same rules and the same validation of `after`; this
 *   path reads NOTHING else out of the payload. See the constant's doc.
 *
 *   ORDER IS FIXED: pending status first, dispatch second. The pending status is
 *   the LIVENESS SIGNAL a reviewer sees on the pull request; posting it first
 *   means a dispatch that never lands leaves a visible pending check rather than
 *   a silent absence. A failed pending post stops the sequence, because
 *   dispatching a run whose result has nowhere to land is worse than not running.
 *
 *   A DUPLICATE DELIVERY TRIGGERS NOTHING. That property is the receiver's, not
 *   this module's: the call sits after the `ON CONFLICT DO NOTHING RETURNING id`
 *   insert and only runs for a row that was actually created, so the gate
 *   inherits the table's dedupe rather than adding a second, weaker one. ONE
 *   exception: an insert that threw may still have committed,
 *   so the receiver hands a qualifying pull-request duplicate over with
 *   `duplicate: true`, and the gate runs it only when the head's latest sop-gate
 *   row is the db-unavailable `error` this module posted.
 *
 *   NEVER LOGGED: the token, any payload text, any response body. Warn lines
 *   carry identifiers and error classes only.
 *
 * @outputs
 *   - `SopGateTrigger` -- the seam the receiver calls
 *   - `SopGateWrite` -- the bounded forge-write seam this module needs
 *   - `createSopGateTrigger` -- build a trigger over a write seam
 *   - `isGatedPullRequest` -- does a delivery qualify for the pull-request gate
 *   - `SOP_GATE_GATED_REPO`, `SOP_GATE_DISPATCH_REPO` -- the fixed constants
 *   - `SITE_PUBLISH_SOURCE_REPO` -- the one content repo enrolled in publish-on-main
 *   - `HOSTED_APP_REGISTRY_REPO` -- the one hosted-app registry repo
 *   - `DISPATCH_TARGETS` -- where each dispatched workflow reports
 *   - `INFRA_STATIC_WORKFLOW_FILE`, `INFRA_STATIC_STATUS_CONTEXT` -- sf#827
 *   - `PR_REVIEW_WORKFLOW_FILE`, `PR_REVIEW_STATUS_CONTEXT` -- sf#476 D18
 *   - `PREPUSH_WORKFLOW_FILE`, `PREPUSH_STATUS_CONTEXT` -- sf#828 D23
 *   - `ISSUE_TRIAGE_WORKFLOW_FILE`, `ISSUE_TRIAGE_STATUS_CONTEXT` -- sf#476 D18
 *   - `VERB_WORKFLOW_FILE`, `VERB_STATUS_CONTEXT` -- sf#829
 *   - `IMPLEMENT_WORKFLOW_FILE`, `IMPLEMENT_STATUS_CONTEXT` -- sf#826
 *
 * @dependencies
 *   - ../forge/boundary -- the `ForgeResponse` shape the write seam returns
 *   - ../log -- structured logging
 */
import type { ForgeResponse } from "../forge/boundary";
import { bounded, errorClass, log, traced } from "../log";
import { type DispatchGuardOptions, type DispatchTarget, guardDispatches } from "./dispatch-guard";

/** The one repository whose pull requests this gate judges. */
export const SOP_GATE_GATED_REPO = "rtech/k3s-deploy";

/** The repository owning the workflow that runs the gate. */
export const SOP_GATE_DISPATCH_REPO = "rodaddy/software-factory";

/** Commit-status context the gate publishes under. */
const STATUS_CONTEXT = "sop-gate";

/** Error-status description when the receiver's database is down. */
const DB_UNAVAILABLE_DESCRIPTION = "sop-gate database unavailable; re-run after recovery";

/** Workflow file dispatched on the factory repository. */
const WORKFLOW_FILE = "sop-gate.yml";

/** Ref the workflow is dispatched on. Fixed; never read from a payload. */
const DISPATCH_REF = "main";

/** Forgejo API base. Pinned to the one reviewed deployment (`forgejo/config.ts`). */
const API_BASE = "https://forge.example.internal/api/v1";

/** Where a reviewer follows the queued run. */
const TARGET_URL = "https://forge.example.internal/rodaddy/software-factory/actions";

/** Webhook event this gate acts on. */
const QUALIFYING_EVENT = "pull_request";

/** Payload `action` values that mean "the head commit changed or arrived". */
const QUALIFYING_ACTIONS: ReadonlySet<string> = new Set([
	"opened",
	"synchronized",
	"edited",
	"reopened",
]);

/** A full 40-character lowercase-hex commit sha, and nothing else. */
const HEAD_SHA = /^[0-9a-f]{40}$/;

/** Commit-status context the post-merge verify publishes under. */
const VERIFY_STATUS_CONTEXT = "sop-verify";

/** Workflow file dispatched for the post-merge verify. */
const VERIFY_WORKFLOW_FILE = "sop-verify.yml";

/** Webhook event the post-merge verify acts on. */
const VERIFY_QUALIFYING_EVENT = "push";

/** The one ref a push must be on. Compared literally; never parsed. */
const VERIFY_QUALIFYING_REF = "refs/heads/main";

/** A branch-deletion push carries this; it names no commit. */
const ZERO_SHA = "0000000000000000000000000000000000000000";

/**
 * A THIRD QUALIFYING SHAPE: publish-on-main for one enrolled content site
 * (policy: nothing in the content loop waits on a human, and the site publish
 * was the last human hop). A `push` delivery on
 * the one enrolled CONTENT repository whose top-level `ref` is exactly
 * `refs/heads/main` marks the pushed commit `site-publish` pending on THAT
 * repository and dispatches `site-publish.yml`, which runs the infra repo's
 * `scripts/site-publish.sh` (web image build, k3s-deploy tag bump, Argo
 * rollout) and the site-chat rebuild when its inputs changed.
 *
 * Same rules as the other two shapes, and the same code: configuration comes
 * from these constants, the status lands on the source repository (the only
 * place a reader of that commit looks), and exactly two payload values are
 * read. `after` is validated as the other paths validate a sha. `before` is
 * OPTIONAL: it lets the workflow diff the push range to decide whether the
 * chat corpus inputs moved; a `before` that is not a 40-hex sha (a branch
 * creation carries the zero sha) is forwarded as the empty string, never
 * rejected, and the workflow then diffs the head commit against its parent.
 */
export const SITE_PUBLISH_SOURCE_REPO = "rtech/rtech-consulting";

/** Commit-status context the site publish reports under, on the source repo. */
const SITE_PUBLISH_STATUS_CONTEXT = "site-publish";

/** Workflow file dispatched for the site publish. */
const SITE_PUBLISH_WORKFLOW_FILE = "site-publish.yml";

/**
 * A FOURTH QUALIFYING SHAPE: hosted-app render-on-main. A `push` delivery on the
 * one hosted-app REGISTRY repository whose top-level `ref` is exactly
 * `refs/heads/main` marks the pushed commit `hosted-app-render` pending on THAT
 * repository and dispatches `hosted-app-render.yml`, which renders the registry
 * into the hosted-app surface.
 *
 * Same rules as the other three shapes, and the same code: configuration comes
 * from these constants, the status lands on the registry repository (the only
 * place a reader of that commit looks), and exactly ONE payload value is read —
 * the top-level `after` sha, validated as the other paths validate a sha and
 * rejected when it is the all-zeros sha a branch-deletion push carries.
 */
export const HOSTED_APP_REGISTRY_REPO = "rtech/hosted-apps";

/** Commit-status context the hosted-app render reports under, on the registry repo. */
const HOSTED_APP_STATUS_CONTEXT = "hosted-app-render";

/** Workflow file dispatched for the hosted-app render. */
const HOSTED_APP_WORKFLOW_FILE = "hosted-app-render.yml";

/** Workflow file the infra-static lane runs; dispatched by ./infra-static. */
export const INFRA_STATIC_WORKFLOW_FILE = "infra-static.yml";

/** Commit-status context the infra-static lane reports under, on the target repo. */
export const INFRA_STATIC_STATUS_CONTEXT = "factory/infra-static";

/** Workflow file the pr-review lane runs for foreign repos; dispatched by ./pr-review. */
export const PR_REVIEW_WORKFLOW_FILE = "pr-review.yml";

/** Commit-status context the pr-review lane reports under, on the target repo. */
export const PR_REVIEW_STATUS_CONTEXT = "factory/pr-review";

/** Workflow file the prepush gate runs (D23); dispatched by ./prepush. */
export const PREPUSH_WORKFLOW_FILE = "prepush.yml";

/** Commit-status context the prepush gate reports under, on the target repo. */
export const PREPUSH_STATUS_CONTEXT = "factory/prepush";

/** Workflow file the issue-triage lane runs for foreign repos; dispatched by ./issue-triage. */
export const ISSUE_TRIAGE_WORKFLOW_FILE = "issue-triage.yml";

/** Context the issue-triage lane's guard would report under. */
export const ISSUE_TRIAGE_STATUS_CONTEXT = "factory/issue-triage";

/** Workflow file the verb lane runs; dispatched through ./verb. */
export const VERB_WORKFLOW_FILE = "verb.yml";

/** Context the verb lane's guard would report under. */
export const VERB_STATUS_CONTEXT = "factory/verb";

/** Workflow file the implement lane runs; dispatched by ./implement. */
export const IMPLEMENT_WORKFLOW_FILE = "implement.yml";

/** Context the implement lane's guard would report under. */
export const IMPLEMENT_STATUS_CONTEXT = "factory/implement";

/**
 * The bounded forge-write seam. Structurally the `write` method of
 * `ForgejoClient`, taken as a function so this module depends on the one verb it
 * uses rather than the whole client — and so tests inject a recorder with no
 * network. The implementation supplies `Authorization: token`, a 10s timeout, and
 * no retry on POST.
 */
export type SopGateWrite = (
	method: "POST",
	pathOrUrl: string,
	body: unknown,
) => Promise<ForgeResponse<unknown>>;

/**
 * The bounded forge-read seam: structurally `ForgejoClient.get`. Used for ONE
 * read — the commit's combined status — so a pending row is posted once per
 * (sha, context) rather than once per delivery.
 */
export type SopGateRead = (pathOrUrl: string) => Promise<ForgeResponse<unknown>>;

/** What the receiver hands the gate about one newly stored delivery. */
export interface SopGateDelivery {
	repository: string;
	event: string;
	payload: unknown;
	/**
	 * The receiver could not record the delivery because its database threw.
	 * The gate then posts an `error` status instead of queueing a run,
	 * so the PR shows the outage rather than carrying no sop-gate status at all.
	 */
	dbUnavailable?: boolean;
	/**
	 * The receiver already holds this delivery id. An insert
	 * that threw may still have committed, so a forge retry lands here. Only a
	 * pull-request delivery whose head still carries the db-unavailable `error`
	 * is gated; every other duplicate triggers nothing.
	 */
	duplicate?: boolean;
}

/** The seam the receiver calls, fire-and-forget. Contracts never to reject. */
export type SopGateTrigger = (delivery: SopGateDelivery) => Promise<void>;

/**
 * Where each dispatched workflow reports: the repository and context
 * of its pending status, and the dispatch input that carries the validated sha.
 * The runner guard fails exactly that status when no runner takes the run.
 */
export const DISPATCH_TARGETS: Readonly<Record<string, DispatchTarget>> = {
	[WORKFLOW_FILE]: {
		statusRepo: SOP_GATE_GATED_REPO,
		context: STATUS_CONTEXT,
		shaInput: "head_sha",
	},
	[VERIFY_WORKFLOW_FILE]: {
		statusRepo: SOP_GATE_GATED_REPO,
		context: VERIFY_STATUS_CONTEXT,
		shaInput: "merge_sha",
	},
	[SITE_PUBLISH_WORKFLOW_FILE]: {
		statusRepo: SITE_PUBLISH_SOURCE_REPO,
		context: SITE_PUBLISH_STATUS_CONTEXT,
		shaInput: "source_sha",
	},
	[HOSTED_APP_WORKFLOW_FILE]: {
		statusRepo: HOSTED_APP_REGISTRY_REPO,
		context: HOSTED_APP_STATUS_CONTEXT,
		shaInput: "registry_sha",
	},
	// sf#827: dispatched for every static-only repo, so the status lands on the
	// repo named in the `repo` input rather than a fixed one.
	[INFRA_STATIC_WORKFLOW_FILE]: {
		statusRepo: "",
		repoInput: "repo",
		context: INFRA_STATIC_STATUS_CONTEXT,
		shaInput: "head_sha",
	},
	// sf#476 D18: dispatched for every enrolled Forgejo repo with pr_review on,
	// so the status lands on the repo named in the `repo` input.
	[PR_REVIEW_WORKFLOW_FILE]: {
		statusRepo: "",
		repoInput: "repo",
		context: PR_REVIEW_STATUS_CONTEXT,
		shaInput: "head_sha",
	},
	// sf#828 D23: dispatched for every Forgejo repo on the Actions prepush
	// runtime, software-factory included; the status lands on `repo`.
	[PREPUSH_WORKFLOW_FILE]: {
		statusRepo: "",
		repoInput: "repo",
		context: PREPUSH_STATUS_CONTEXT,
		shaInput: "head_sha",
	},
	// sf#476 D18: dispatched for every enrolled Forgejo repo with triage on the
	// Actions runtime. An issue has no sha, so the dispatch carries no
	// `head_sha` input and the #808 guard starts no watch (it needs a 40-hex
	// sha); the lane's own failure() step comments on the issue instead.
	[ISSUE_TRIAGE_WORKFLOW_FILE]: {
		statusRepo: "",
		repoInput: "repo",
		context: ISSUE_TRIAGE_STATUS_CONTEXT,
		shaInput: "head_sha",
	},
	// sf#829: a verb acts on an issue, and its base_sha is rtech/k3s-deploy's
	// head, not a commit of the item's repo, so no status may land on
	// `repo`@base_sha. Like issue-triage the dispatch carries no `head_sha`
	// input and the #808 guard starts no watch; the lane comments instead.
	[VERB_WORKFLOW_FILE]: {
		statusRepo: "",
		repoInput: "repo",
		context: VERB_STATUS_CONTEXT,
		shaInput: "head_sha",
	},
	// sf#826: dispatched for an issue, like issue-triage. The dispatch carries
	// `base_sha`, never `head_sha`, so the #808 guard starts no watch and posts
	// no status on the target's default branch; the lane comments on the issue.
	[IMPLEMENT_WORKFLOW_FILE]: {
		statusRepo: "",
		repoInput: "repo",
		context: IMPLEMENT_STATUS_CONTEXT,
		shaInput: "head_sha",
	},
};

/** The two values a qualifying payload must yield, both already validated. */
interface GateSubject {
	prNumber: number;
	headSha: string;
}

/** Read a nested property off an unknown value without asserting its shape. */
function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	return (value as Record<string, unknown>)[key];
}

/**
 * Does the commit already carry a `pending` row under this context?
 * Two DISTINCT deliveries for one sha (a PR `opened` then `edited`, say) each
 * pass the receiver's delivery-id dedupe, so without this read each
 * posted its own identical pending row. The combined-status endpoint answers the
 * LATEST row per context, so a settled context (success/failure) is re-marked
 * pending by a new delivery exactly as before. Never throws: an unreadable or
 * malformed answer returns false, because the pending row is the liveness
 * signal and a duplicate is cosmetic while a missing one is not.
 */
async function alreadyPending(
	read: SopGateRead | undefined,
	repository: string,
	sha: string,
	context: string,
): Promise<boolean> {
	if (read === undefined) {
		return false;
	}
	try {
		const response = await read(`${API_BASE}/repos/${repository}/commits/${sha}/status`);
		const statuses = property(response.data, "statuses");
		if (!Array.isArray(statuses)) {
			return false;
		}
		return statuses.some(
			(entry) => property(entry, "context") === context && property(entry, "status") === "pending",
		);
	} catch (err) {
		log("warn", "hooks.sop_gate.status_read_failed", { error_class: errorClass(err), sha });
		return false;
	}
}

/**
 * Does the head's LATEST sop-gate row say the gate never ran because the
 * database was down? The combined-status endpoint answers the
 * latest row per context. Never throws: an absent seam or a failed or malformed
 * read answers false, so a redelivery that cannot prove the outage gates nothing.
 */
async function dbOutageRecorded(read: SopGateRead | undefined, sha: string): Promise<boolean> {
	if (read === undefined) {
		return false;
	}
	try {
		const response = await read(`${API_BASE}/repos/${SOP_GATE_GATED_REPO}/commits/${sha}/status`);
		const statuses = property(response.data, "statuses");
		const row = Array.isArray(statuses)
			? statuses.find((entry) => property(entry, "context") === STATUS_CONTEXT)
			: undefined;
		return (
			property(row, "status") === "error" &&
			property(row, "description") === DB_UNAVAILABLE_DESCRIPTION
		);
	} catch (err) {
		log("warn", "hooks.sop_gate.status_read_failed", { error_class: errorClass(err), sha });
		return false;
	}
}

/** Is this delivery on the gated repo, the right event, and a qualifying action? */
function qualifies(delivery: SopGateDelivery): boolean {
	if (delivery.repository !== SOP_GATE_GATED_REPO || delivery.event !== QUALIFYING_EVENT) {
		return false;
	}
	const action = property(delivery.payload, "action");
	return typeof action === "string" && QUALIFYING_ACTIONS.has(action);
}

/**
 * Extract the ONLY two payload-sourced values, or null when either is malformed.
 * Both are interpolated into a request path or body downstream, so the shapes are
 * deliberately narrow: a positive safe integer, and exactly 40 lowercase hex
 * characters. Anything else is treated as absent rather than coerced.
 */
function subject(payload: unknown): GateSubject | null {
	const pullRequest = property(payload, "pull_request");
	const prNumber = property(pullRequest, "number");
	const headSha = property(property(pullRequest, "head"), "sha");
	if (typeof prNumber !== "number" || !Number.isSafeInteger(prNumber) || prNumber <= 0) {
		return null;
	}
	if (typeof headSha !== "string" || !HEAD_SHA.test(headSha)) {
		return null;
	}
	return { prNumber, headSha };
}

/**
 * The post-merge half: a push landing on the gated repo's `main`. Silent for any
 * other ref; a qualifying one whose `after` fails validation logs malformed and
 * stops, exactly like the pull-request path. Callers have already established
 * the repository and the event.
 *
 * @param write - the bounded forge-write seam
 * @param delivery - the newly stored push delivery
 */
async function triggerVerify(
	write: SopGateWrite,
	read: SopGateRead | undefined,
	delivery: SopGateDelivery,
): Promise<void> {
	const ref = property(delivery.payload, "ref");
	if (ref !== VERIFY_QUALIFYING_REF) {
		return;
	}
	const after = property(delivery.payload, "after");
	if (typeof after !== "string" || !HEAD_SHA.test(after) || after === ZERO_SHA) {
		// Identifiers only — the payload that failed validation is never logged.
		log("warn", "hooks.sop_gate.malformed", { repository: bounded(delivery.repository) });
		return;
	}

	// 1. The liveness signal, first — same rationale as the pull-request path —
	//    and once per (sha, context), never once per delivery.
	try {
		if (!(await alreadyPending(read, SOP_GATE_GATED_REPO, after, VERIFY_STATUS_CONTEXT))) {
			await write("POST", `${API_BASE}/repos/${SOP_GATE_GATED_REPO}/statuses/${after}`, {
				context: VERIFY_STATUS_CONTEXT,
				state: "pending",
				description: "sop-verify queued",
				target_url: TARGET_URL,
			});
		}
	} catch (err) {
		log("warn", "hooks.sop_gate.status_failed", {
			error_class: errorClass(err),
			merge_sha: after,
		});
		return;
	}

	// 2. The run itself. Forgejo answers 204 with no body.
	try {
		await write(
			"POST",
			`${API_BASE}/repos/${SOP_GATE_DISPATCH_REPO}/actions/workflows/${VERIFY_WORKFLOW_FILE}/dispatches`,
			{ ref: DISPATCH_REF, inputs: { merge_sha: after } },
		);
	} catch (err) {
		log("warn", "hooks.sop_gate.dispatch_failed", {
			error_class: errorClass(err),
			merge_sha: after,
		});
		return;
	}

	log("info", "hooks.sop_gate.dispatched", { merge_sha: after });
}

/** What one push-on-main shape supplies to the shared body below. */
interface PushOnMainShape {
	/** Repository the pending status lands on — the one the push landed on. */
	statusRepo: string;
	/** Commit-status context, which is also the description's subject. */
	statusContext: string;
	/** Workflow file dispatched in the factory repo. */
	workflowFile: string;
	/** Log field the validated sha is reported under. */
	logKey: string;
	/** The inputs this shape's workflow takes, built from the validated sha. */
	inputs: (after: string, payload: unknown) => Record<string, string>;
}

/**
 * The shared body of the push-on-main shapes: validate the ref and the `after`
 * sha, post a pending status on the repository the push landed on, then dispatch
 * the shape's workflow. Silent for any other ref; a qualifying one whose `after`
 * fails validation logs malformed and stops, exactly like the verify path.
 * Callers have already established the repository and the event.
 *
 * Order and failure handling are the module's and are NOT per-shape: pending
 * first, a failing pending stops the sequence, a failing dispatch is logged, and
 * neither rejects.
 *
 * @param write - the bounded forge-write seam
 * @param delivery - the newly stored push delivery
 * @param shape - the one shape's repository, context, workflow, and inputs
 */
async function triggerPushOnMain(
	write: SopGateWrite,
	read: SopGateRead | undefined,
	delivery: SopGateDelivery,
	shape: PushOnMainShape,
): Promise<void> {
	const ref = property(delivery.payload, "ref");
	if (ref !== VERIFY_QUALIFYING_REF) {
		return;
	}
	const after = property(delivery.payload, "after");
	if (typeof after !== "string" || !HEAD_SHA.test(after) || after === ZERO_SHA) {
		// Identifiers only — the payload that failed validation is never logged.
		log("warn", "hooks.sop_gate.malformed", { repository: bounded(delivery.repository) });
		return;
	}

	// 1. The liveness signal, first — on the commit the push landed on, and once
	//    per (sha, context), never once per delivery.
	try {
		if (!(await alreadyPending(read, shape.statusRepo, after, shape.statusContext))) {
			await write("POST", `${API_BASE}/repos/${shape.statusRepo}/statuses/${after}`, {
				context: shape.statusContext,
				state: "pending",
				description: `${shape.statusContext} queued`,
				target_url: TARGET_URL,
			});
		}
	} catch (err) {
		log("warn", "hooks.sop_gate.status_failed", {
			error_class: errorClass(err),
			[shape.logKey]: after,
		});
		return;
	}

	// 2. The run itself. Forgejo answers 204 with no body.
	try {
		await write(
			"POST",
			`${API_BASE}/repos/${SOP_GATE_DISPATCH_REPO}/actions/workflows/${shape.workflowFile}/dispatches`,
			{ ref: DISPATCH_REF, inputs: shape.inputs(after, delivery.payload) },
		);
	} catch (err) {
		log("warn", "hooks.sop_gate.dispatch_failed", {
			error_class: errorClass(err),
			[shape.logKey]: after,
		});
		return;
	}

	log("info", "hooks.sop_gate.dispatched", { [shape.logKey]: after });
}

/**
 * The publish-on-main half: a push landing on the enrolled content repo's
 * `main`. The status lands on the SOURCE repository.
 *
 * @param write - the bounded forge-write seam
 * @param delivery - the newly stored push delivery
 */
async function triggerSitePublish(
	write: SopGateWrite,
	read: SopGateRead | undefined,
	delivery: SopGateDelivery,
): Promise<void> {
	return await triggerPushOnMain(write, read, delivery, {
		statusRepo: SITE_PUBLISH_SOURCE_REPO,
		statusContext: SITE_PUBLISH_STATUS_CONTEXT,
		workflowFile: SITE_PUBLISH_WORKFLOW_FILE,
		logKey: "source_sha",
		inputs: (after, payload) => {
			// Optional, and forwarded only when it is exactly a sha; anything else is
			// the empty string so the workflow falls back to a parent diff rather
			// than refusing a publish it could still do.
			const beforeRaw = property(payload, "before");
			const before =
				typeof beforeRaw === "string" && HEAD_SHA.test(beforeRaw) && beforeRaw !== ZERO_SHA
					? beforeRaw
					: "";
			return { source_sha: after, before_sha: before };
		},
	});
}

/**
 * The render-on-main half: a push landing on the hosted-app registry repo's
 * `main`. The status lands on the REGISTRY repository, and the validated `after`
 * sha is the only payload value this path reads.
 *
 * @param write - the bounded forge-write seam
 * @param delivery - the newly stored push delivery
 */
async function triggerHostedAppRender(
	write: SopGateWrite,
	read: SopGateRead | undefined,
	delivery: SopGateDelivery,
): Promise<void> {
	return await triggerPushOnMain(write, read, delivery, {
		statusRepo: HOSTED_APP_REGISTRY_REPO,
		statusContext: HOSTED_APP_STATUS_CONTEXT,
		workflowFile: HOSTED_APP_WORKFLOW_FILE,
		logKey: "registry_sha",
		inputs: (after) => ({ registry_sha: after }),
	});
}

/**
 * Post the `error` status that tells a reviewer the gate could not run because
 * its database is down. Never throws: a failed post is logged.
 */
async function postDbUnavailable(
	write: SopGateWrite,
	target: { prNumber: number; headSha: string },
): Promise<void> {
	log("error", "hooks.sop_gate.db_unavailable", {
		pr_number: target.prNumber,
		head_sha: target.headSha,
	});
	try {
		await write("POST", `${API_BASE}/repos/${SOP_GATE_GATED_REPO}/statuses/${target.headSha}`, {
			context: STATUS_CONTEXT,
			state: "error",
			description: DB_UNAVAILABLE_DESCRIPTION,
			target_url: TARGET_URL,
		});
	} catch (err) {
		log("warn", "hooks.sop_gate.status_failed", {
			error_class: errorClass(err),
			pr_number: target.prNumber,
		});
	}
}

/** The original shape: a pull_request delivery on the gated repo. */
async function triggerGate(
	write: SopGateWrite,
	read: SopGateRead | undefined,
	delivery: SopGateDelivery,
): Promise<void> {
	if (!qualifies(delivery)) {
		return;
	}
	const target = subject(delivery.payload);
	if (target === null) {
		// Identifiers only — the payload that failed validation is never logged.
		log("warn", "hooks.sop_gate.malformed", { repository: bounded(delivery.repository) });
		return;
	}

	// 0. The database is down: say so on the PR, dispatch nothing.
	if (delivery.dbUnavailable === true) {
		await postDbUnavailable(write, target);
		return;
	}
	// A redelivery gates only a head the outage left in `error`.
	if (delivery.duplicate === true && !(await dbOutageRecorded(read, target.headSha))) {
		return;
	}

	// 1. The liveness signal, first: a reviewer must see a pending check even if
	//    the dispatch below never lands. Once per (sha, context), never once per
	//    delivery: distinct deliveries can share one head sha.
	try {
		if (!(await alreadyPending(read, SOP_GATE_GATED_REPO, target.headSha, STATUS_CONTEXT))) {
			await write("POST", `${API_BASE}/repos/${SOP_GATE_GATED_REPO}/statuses/${target.headSha}`, {
				context: STATUS_CONTEXT,
				state: "pending",
				description: "sop-gate queued",
				target_url: TARGET_URL,
			});
		}
	} catch (err) {
		log("warn", "hooks.sop_gate.status_failed", {
			error_class: errorClass(err),
			pr_number: target.prNumber,
		});
		return;
	}

	// 2. The run itself.
	await dispatchGate(write, target);
}

/** Dispatch the sop-gate workflow for one PR head. Forgejo answers 204 with no body. */
async function dispatchGate(
	write: SopGateWrite,
	target: { prNumber: number; headSha: string },
): Promise<void> {
	try {
		await write(
			"POST",
			`${API_BASE}/repos/${SOP_GATE_DISPATCH_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`,
			{
				ref: DISPATCH_REF,
				inputs: { pr_number: String(target.prNumber), head_sha: target.headSha },
			},
		);
	} catch (err) {
		log("warn", "hooks.sop_gate.dispatch_failed", {
			error_class: errorClass(err),
			pr_number: target.prNumber,
		});
		return;
	}

	log("info", "hooks.sop_gate.dispatched", {
		pr_number: target.prNumber,
		head_sha: target.headSha,
	});
}

/**
 * Build the trigger the receiver wires in.
 *
 * Returns a function that resolves in every case — a non-qualifying delivery, a
 * malformed one, and a failed forge call all resolve, because the caller cannot
 * act on a rejection without risking the webhook response.
 *
 * @param write - the bounded forge-write seam
 * @param read - the bounded forge-read seam; absent, every delivery posts pending
 *   and no runner guard runs (the guard needs the read)
 * @param guardOptions - test seams for the post-dispatch runner guard
 */
function createTriggerImpl(
	forgeWrite: SopGateWrite,
	read?: SopGateRead,
	guardOptions?: DispatchGuardOptions,
): SopGateTrigger {
	// Every successful dispatch below starts a detached guard that fails the
	// lane's own status when no runner picks the run up.
	const write =
		read === undefined
			? forgeWrite
			: guardDispatches(forgeWrite, read, DISPATCH_TARGETS, guardOptions);
	return async function triggerSopGate(delivery: SopGateDelivery): Promise<void> {
		// A duplicate can only ever re-run the pull-request gate.
		if (delivery.duplicate === true) {
			if (!qualifies(delivery)) {
				return;
			}
			return await triggerGate(write, read, delivery);
		}
		if (delivery.repository === SOP_GATE_GATED_REPO && delivery.event === VERIFY_QUALIFYING_EVENT) {
			return await triggerVerify(write, read, delivery);
		}
		if (
			delivery.repository === SITE_PUBLISH_SOURCE_REPO &&
			delivery.event === VERIFY_QUALIFYING_EVENT
		) {
			return await triggerSitePublish(write, read, delivery);
		}
		if (
			delivery.repository === HOSTED_APP_REGISTRY_REPO &&
			delivery.event === VERIFY_QUALIFYING_EVENT
		) {
			return await triggerHostedAppRender(write, read, delivery);
		}
		return await triggerGate(write, read, delivery);
	};
}

/** Does a delivery qualify for the pull-request gate? The receiver's duplicate filter. */
export const isGatedPullRequest = traced("hooks.isGatedPullRequest", qualifies);

export const createSopGateTrigger = traced("hooks.createSopGateTrigger", createTriggerImpl);
