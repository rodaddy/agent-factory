/**
 * @module hooks/issue-triage
 * @description Dispatch the issue-triage Forgejo Actions lane for
 *   an `issues` opened/reopened delivery on any enrolled Forgejo repository
 *   whose watcher config sets `triage: true` and `triage_runtime: actions`.
 *   Absent or `box` runtime dispatches nothing: reconcile keeps its box triage
 *   job (src/reconcile/pass.ts reads the same flag).
 *
 *   Same rules as `./pr-review`: the set of repositories comes from the loaded
 *   config, the workflow file, dispatch repo and ref are fixed constants, and
 *   the only payload value read is the issue number, validated to a positive
 *   safe integer before use. The workflow validates it again
 *   (scripts/actions/validate-inputs.ts) before any use.
 *
 *   Excluded: a GitHub repo (not on this forge) and software-factory itself,
 *   whose own `issues` trigger already runs the workflow.
 *
 *   The write goes through `guardDispatches` over `DISPATCH_TARGETS`;
 *   an issue has no sha, so the guard starts no watch. Every accepted dispatch
 *   is recorded in `forge_runs` through the optional `record` seam: `repo` is
 *   the workflow HOST repo (`SOP_GATE_DISPATCH_REPO`), the triaged repo is
 *   `inputs.repo`, and `target_sha` is empty because an issue has none.
 *
 *   One event dispatches once. A repository's own hook and the system hook
 *   each deliver it under a different delivery id, so the receiver's
 *   delivery-id dedupe does not see them as one; the trigger drops the twin of
 *   a (repository, issue, action) inside `TWIN_WINDOW_MS`.
 *
 *   NEVER REJECTS and never logs a payload or a token.
 *
 * @outputs
 *   - `createIssueTriageTrigger` -- build the trigger over a write, read and record seam
 */
import type { DispatchRecord } from "../forge/actions-store";
import { errorClass, log, traced } from "../log";
import { type DispatchGuardOptions, guardDispatches } from "./dispatch-guard";
import {
	DISPATCH_TARGETS,
	ISSUE_TRIAGE_WORKFLOW_FILE,
	SOP_GATE_DISPATCH_REPO,
	type SopGateDelivery,
	type SopGateRead,
	type SopGateTrigger,
	type SopGateWrite,
} from "./sop-gate";

/** Forgejo API base. Pinned to the one reviewed deployment (`forgejo/config.ts`). */
const API_BASE = "https://forge.example.internal/api/v1";

/** Payload `action` values the workflow's own `issues` trigger reacts to. */
const QUALIFYING_ACTIONS: ReadonlySet<string> = new Set(["opened", "reopened"]);

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	return (value as Record<string, unknown>)[key];
}

/** The config fields this module reads off each repository entry. */
export interface IssueTriageRepo {
	name: string;
	provider: string;
	triage?: boolean;
	triage_runtime?: "box" | "actions";
}

/** Persist one dispatch; the receiver wires this to `recordDispatch(db, ...)`. */
export type IssueTriageRecord = (rec: DispatchRecord) => Promise<unknown>;

/** Test and wiring seams: the #808 guard's clock, the forge_runs recorder, the twin clock. */
export interface IssueTriageOptions {
	guard?: DispatchGuardOptions;
	record?: IssueTriageRecord;
	now?: () => number;
}

/**
 * How long one (repository, issue, action) suppresses its twin. A repository's
 * own hook and the system hook each deliver the same event under a different
 * delivery id, milliseconds apart; a real second reopen is minutes away.
 */
const TWIN_WINDOW_MS = 60_000;

/** One claimed key: when it was claimed, and whether its dispatch landed. */
interface TwinClaim {
	at: number;
	landed: Promise<boolean>;
	settle: (landed: boolean) => void;
}

/**
 * One owner per key inside the window. `claim` resolves to the owner's claim,
 * or to null when a twin's dispatch already landed. A twin WAITS for the
 * in-flight owner rather than returning at once: if that dispatch fails, the
 * failed claim is gone and exactly one waiting twin becomes the next owner, so
 * a failure never drops the event (PR 1113 review, P1).
 */
function createTwinFilter(now: () => number) {
	const claims = new Map<string, TwinClaim>();
	return {
		async claim(key: string): Promise<TwinClaim | null> {
			for (const [k, c] of claims) {
				if (now() - c.at >= TWIN_WINDOW_MS) claims.delete(k);
			}
			for (let held = claims.get(key); held !== undefined; held = claims.get(key)) {
				if (await held.landed) return null;
			}
			// No await between the last lookup and this set: one waiter wins.
			let settle: (landed: boolean) => void = () => {};
			const landed = new Promise<boolean>((resolve) => {
				settle = resolve;
			});
			const claim: TwinClaim = { at: now(), landed, settle };
			claims.set(key, claim);
			return claim;
		},
		// A failed dispatch frees its key before it settles, so a waiter can own it.
		fail(key: string, claim: TwinClaim): void {
			if (claims.get(key) === claim) claims.delete(key);
			claim.settle(false);
		},
	};
}

/** The enrolled Forgejo repos this lane triages, minus software-factory itself. */
function triagedRepos(repositories: readonly IssueTriageRepo[]): ReadonlySet<string> {
	return new Set(
		repositories
			.filter(
				(repo) =>
					repo.provider === "forgejo" &&
					repo.triage === true &&
					repo.triage_runtime === "actions" &&
					repo.name !== SOP_GATE_DISPATCH_REPO,
			)
			.map((repo) => repo.name),
	);
}

/** Record one dispatch in forge_runs; a failure is logged, never thrown. */
async function recordQuietly(
	record: IssueTriageRecord,
	repo: string,
	inputs: Record<string, string>,
): Promise<void> {
	try {
		await record({
			repo: SOP_GATE_DISPATCH_REPO,
			workflow: ISSUE_TRIAGE_WORKFLOW_FILE,
			runId: null,
			targetSha: "",
			inputs,
		});
	} catch (err) {
		log("warn", "hooks.issue_triage.record_failed", {
			error_class: errorClass(err),
			repository: repo,
		});
	}
}

function createIssueTriageTriggerImpl(
	forgeWrite: SopGateWrite,
	read: SopGateRead,
	repositories: readonly IssueTriageRepo[],
	options: IssueTriageOptions = {},
): SopGateTrigger {
	const repos = triagedRepos(repositories);
	const twins = createTwinFilter(options.now ?? Date.now);
	const write = guardDispatches(forgeWrite, read, DISPATCH_TARGETS, options.guard);
	const url = `${API_BASE}/repos/${SOP_GATE_DISPATCH_REPO}/actions/workflows/${ISSUE_TRIAGE_WORKFLOW_FILE}/dispatches`;
	return async function triggerIssueTriage(delivery: SopGateDelivery): Promise<void> {
		if (delivery.event !== "issues" || !repos.has(delivery.repository)) {
			return;
		}
		const action = property(delivery.payload, "action");
		if (typeof action !== "string" || !QUALIFYING_ACTIONS.has(action)) {
			return;
		}
		const number = property(property(delivery.payload, "issue"), "number");
		if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
			log("warn", "hooks.issue_triage.malformed", { repository: delivery.repository });
			return;
		}
		const inputs = {
			repo: delivery.repository,
			number: String(number),
			// sf#708 (D15): the constant first-attempt level. Respawn escalation to
			// `debug` on Actions arrives with the #417b re-dispatch.
			log_level: "info",
		};
		const ids = { repository: delivery.repository, issue_number: inputs.number };
		const key = `${delivery.repository}#${inputs.number}#${action}`;
		const claim = await twins.claim(key);
		if (claim === null) {
			log("info", "hooks.issue_triage.twin_skipped", ids);
			return;
		}
		try {
			await write("POST", url, { ref: "main", inputs });
		} catch (err) {
			twins.fail(key, claim);
			log("warn", "hooks.issue_triage.dispatch_failed", { error_class: errorClass(err), ...ids });
			return;
		}
		claim.settle(true);
		log("info", "hooks.issue_triage.dispatched", ids);
		if (options.record !== undefined) {
			await recordQuietly(options.record, delivery.repository, inputs);
		}
	};
}

export const createIssueTriageTrigger = traced(
	"hooks.createIssueTriageTrigger",
	createIssueTriageTriggerImpl,
);
