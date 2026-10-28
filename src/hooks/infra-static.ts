/**
 * @module hooks/infra-static
 * @description Dispatch the infra-static Forgejo Actions lane for a
 *   pull-request delivery on any repository the watcher config marks
 *   `checks: static-only`.
 *
 *   Same rules as `./sop-gate`: the set of repositories comes from the loaded
 *   config, the workflow file, dispatch repo and ref are fixed constants, and
 *   the only payload values read are the PR number, head sha and base sha, each
 *   validated to a narrow shape before use. The repository name forwarded is
 *   the delivery's own, and only when it is in the configured set.
 *
 *   The workflow posts its own `factory/infra-static` pending status (job P),
 *   so this module only dispatches. The write goes through `guardDispatches`
 *   over `DISPATCH_TARGETS`, the #808 runner guard every other dispatch uses:
 *   a run no runner picks up fails the status on the TARGET repo.
 *
 *   NEVER REJECTS and never logs a payload or a token.
 *
 * @outputs
 *   - `createInfraStaticTrigger` -- build the trigger over a write and read seam
 *   - `createHookTrigger` -- the SOP gate, infra-static, pr-review, issue-triage, implement and prepush, as the receiver's one trigger
 */
import type { WatcherDb } from "../db/client";
import {
	type DispatchQuery,
	claimDispatch,
	type DispatchRecord,
	findDispatch,
	recordDispatch,
	releaseDispatch,
} from "../forge/actions-store";
import { errorClass, log, traced } from "../log";
import { type DispatchGuardOptions, guardDispatches } from "./dispatch-guard";
import { createImplementTrigger, type ImplementRepo } from "./implement";
import { createIssueTriageTrigger, type IssueTriageRepo } from "./issue-triage";
import { createPrepushTrigger, type PrepushRepo } from "./prepush";
import { createPrReviewTrigger, type PrReviewRepo } from "./pr-review";
import {
	createSopGateTrigger,
	DISPATCH_TARGETS,
	INFRA_STATIC_WORKFLOW_FILE,
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

/**
 * The config fields this module reads off each repository entry. Only a
 * `static_runtime: actions` repo is dispatched; absent means the `box` default.
 */
export interface InfraStaticRepo {
	name: string;
	checks: string;
	static_runtime?: string;
}

/** The workflow inputs, or null when the PR number or either sha is malformed. */
function dispatchInputs(delivery: SopGateDelivery): Record<string, string> | null {
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

function createInfraStaticTriggerImpl(
	forgeWrite: SopGateWrite,
	read: SopGateRead,
	repositories: readonly InfraStaticRepo[],
	guardOptions?: DispatchGuardOptions,
): SopGateTrigger {
	const repos = new Set(
		repositories
			.filter((repo) => repo.checks === "static-only" && repo.static_runtime === "actions")
			.map((repo) => repo.name),
	);
	const write = guardDispatches(forgeWrite, read, DISPATCH_TARGETS, guardOptions);
	const url = `${API_BASE}/repos/${SOP_GATE_DISPATCH_REPO}/actions/workflows/${INFRA_STATIC_WORKFLOW_FILE}/dispatches`;
	return async function triggerInfraStatic(delivery: SopGateDelivery): Promise<void> {
		if (delivery.event !== "pull_request" || !repos.has(delivery.repository)) {
			return;
		}
		const action = property(delivery.payload, "action");
		if (typeof action !== "string" || !QUALIFYING_ACTIONS.has(action)) {
			return;
		}
		const inputs = dispatchInputs(delivery);
		if (inputs === null) {
			log("warn", "hooks.infra_static.malformed", { repository: delivery.repository });
			return;
		}
		const ids = { repository: delivery.repository, pr_number: inputs.number };
		try {
			await write("POST", url, { ref: "main", inputs });
		} catch (err) {
			log("warn", "hooks.infra_static.dispatch_failed", { error_class: errorClass(err), ...ids });
			return;
		}
		log("info", "hooks.infra_static.dispatched", { ...ids, head_sha: inputs.head_sha });
	};
}

export const createInfraStaticTrigger = traced(
	"hooks.createInfraStaticTrigger",
	createInfraStaticTriggerImpl,
);

/**
 * The receiver's one trigger: the SOP gate, then infra-static, then pr-review
 * and issue-triage, then implement, then prepush.
 * All six never reject, so running them in turn is safe. With a db,
 * each pr-review, issue-triage, implement and prepush dispatch is recorded in
 * `forge_runs`.
 */
function createHookTriggerImpl(
	write: SopGateWrite,
	read: SopGateRead,
	repositories: readonly (InfraStaticRepo &
		PrReviewRepo &
		IssueTriageRepo &
		ImplementRepo &
		PrepushRepo)[],
	db?: WatcherDb,
): SopGateTrigger {
	const sopGate = createSopGateTrigger(write, read);
	const infraStatic = createInfraStaticTrigger(write, read, repositories);
	const record = db === undefined ? undefined : (rec: DispatchRecord) => recordDispatch(db, rec);
	const prReview = createPrReviewTrigger(write, read, repositories, { record });
	const issueTriage = createIssueTriageTrigger(write, read, repositories, { record });
	const find = db === undefined ? undefined : (q: DispatchQuery) => findDispatch(db, q);
	const claim =
		db === undefined
			? undefined
			: (rec: DispatchRecord, match: Record<string, string>) => claimDispatch(db, rec, match);
	const release = db === undefined ? undefined : (id: number) => releaseDispatch(db, id);
	const implement = createImplementTrigger(write, read, repositories, {
		record,
		find,
		claim,
		release,
	});
	const prepush = createPrepushTrigger(write, read, repositories, {
		record,
		find,
		claim,
		release,
	});
	return async (delivery) => {
		await sopGate(delivery);
		// A redelivered duplicate or a database-down delivery reaches the sop gate
		// only: the other lanes would re-dispatch, or write to a dead DB.
		if (delivery.duplicate === true || delivery.dbUnavailable === true) {
			return;
		}
		await infraStatic(delivery);
		await prReview(delivery);
		await issueTriage(delivery);
		await implement(delivery);
		await prepush(delivery);
	};
}

export const createHookTrigger = traced("hooks.createHookTrigger", createHookTriggerImpl);
