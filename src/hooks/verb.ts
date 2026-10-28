/**
 * @module hooks/verb
 * @description Dispatch the verb Forgejo Actions lane (829a skeleton)
 *   for one allowlisted verb on one item. Called by `jobs/verb-live.ts`
 *   `dispatchVerbLive` when the repository's config sets
 *   `verb_runtime: actions`; absent or `box` never reaches here.
 *
 *   Same rules as `./issue-triage`: the workflow file, dispatch repo and ref
 *   are fixed constants, and every input is validated here before the write
 *   (the workflow validates each one again, scripts/actions/validate-inputs.ts,
 *   before any use). `base_sha` is the watcher-resolved rtech/k3s-deploy head,
 *   never a payload value.
 *
 *   The write goes through `guardDispatches` over `DISPATCH_TARGETS`;
 *   the dispatch carries no `head_sha`, so the guard starts no watch. Every
 *   accepted dispatch is recorded in `forge_runs` through the optional `record`
 *   seam: `repo` is the workflow HOST repo (`SOP_GATE_DISPATCH_REPO`), the item's
 *   repo is `inputs.repo`, and `target_sha` is `base_sha`.
 *
 *   NEVER REJECTS and never logs a payload or a token.
 *
 * @outputs
 *   - `createVerbDispatcher` -- build the dispatcher over a write, read and record seam
 *   - `verbDispatcherFor` -- the recorded dispatcher for a `verb_runtime: actions` repo, else undefined
 *   - `VERB_WORKFLOW_FILE` -- re-exported from ./sop-gate
 */
import type { WatcherDb } from "../db/client";
import { type DispatchRecord, recordDispatch } from "../forge/actions-store";
import type { ForgeClientResult } from "../forge/registry";
import { isVerbId } from "../jobs/verb-dispatch";
import { errorClass, log, traced } from "../log";
import { DNS_LABEL_PATTERN } from "../names/dns-label";
import { type DispatchGuardOptions, guardDispatches } from "./dispatch-guard";
import {
	DISPATCH_TARGETS,
	SOP_GATE_DISPATCH_REPO,
	type SopGateRead,
	type SopGateWrite,
	VERB_WORKFLOW_FILE,
} from "./sop-gate";

export { VERB_WORKFLOW_FILE } from "./sop-gate";

/** Forgejo API base. Pinned to the one reviewed deployment (`forgejo/config.ts`). */
const API_BASE = "https://forge.example.internal/api/v1";

const OWNER_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;

/** One verb dispatch, as dispatchVerbLive resolved it. */
export interface VerbDispatchInputs {
	verb: string;
	repo: string;
	item: number;
	app: string;
	/** The rails manifest sha256 (64 hex) the verb is bound to. */
	manifestSha: string;
	/** The rtech/k3s-deploy head (40 hex) the watcher resolved. */
	baseSha: string;
}

/** Dispatch one verb run; true when the forge accepted the dispatch. Never rejects. */
export type VerbWorkflowDispatch = (inputs: VerbDispatchInputs) => Promise<boolean>;

/** Persist one dispatch; the caller wires this to `recordDispatch(db, ...)`. */
export type VerbRecord = (rec: DispatchRecord) => Promise<unknown>;

/** Test and wiring seams: the #808 guard's clock, and the forge_runs recorder. */
export interface VerbDispatchOptions {
	guard?: DispatchGuardOptions;
	record?: VerbRecord;
}

function valid(inputs: VerbDispatchInputs): boolean {
	return (
		isVerbId(inputs.verb) &&
		OWNER_REPO.test(inputs.repo) &&
		// The host repo is never a verb target (as issue-triage / pr-review).
		inputs.repo !== SOP_GATE_DISPATCH_REPO &&
		Number.isSafeInteger(inputs.item) &&
		inputs.item > 0 &&
		DNS_LABEL_PATTERN.test(inputs.app) &&
		/^[0-9a-f]{64}$/.test(inputs.manifestSha) &&
		/^[0-9a-f]{40}$/.test(inputs.baseSha)
	);
}

function createVerbDispatcherImpl(
	forgeWrite: SopGateWrite,
	read: SopGateRead,
	options: VerbDispatchOptions = {},
): VerbWorkflowDispatch {
	const write = guardDispatches(forgeWrite, read, DISPATCH_TARGETS, options.guard);
	const url = `${API_BASE}/repos/${SOP_GATE_DISPATCH_REPO}/actions/workflows/${VERB_WORKFLOW_FILE}/dispatches`;
	return async function dispatchVerbWorkflow(inputs: VerbDispatchInputs): Promise<boolean> {
		if (!valid(inputs)) {
			log("warn", "hooks.verb.malformed", { repository: inputs.repo });
			return false;
		}
		const wire = {
			verb: inputs.verb,
			repo: inputs.repo,
			item: String(inputs.item),
			app: inputs.app,
			manifest_sha: inputs.manifestSha,
			base_sha: inputs.baseSha,
			log_level: "info",
		};
		const ids = { repository: inputs.repo, item: wire.item, verb: inputs.verb };
		try {
			await write("POST", url, { ref: "main", inputs: wire });
		} catch (err) {
			log("warn", "hooks.verb.dispatch_failed", { error_class: errorClass(err), ...ids });
			return false;
		}
		log("info", "hooks.verb.dispatched", ids);
		if (options.record !== undefined) {
			try {
				await options.record({
					repo: SOP_GATE_DISPATCH_REPO,
					workflow: VERB_WORKFLOW_FILE,
					runId: null,
					targetSha: inputs.baseSha,
					inputs: wire,
				});
			} catch (err) {
				log("warn", "hooks.verb.record_failed", { error_class: errorClass(err), ...ids });
			}
		}
		return true;
	};
}

export const createVerbDispatcher = traced("hooks.createVerbDispatcher", createVerbDispatcherImpl, {
	// The write and read seams close over the forge credential.
	redact: { args: [0, 1] },
});

/**
 * The verb dispatcher the reconcile cycle wires (sweep-F, PR 902): write and read
 * over one Forgejo client, and every accepted dispatch recorded in forge_runs, the
 * same seams `createHookTrigger` gives the other dispatchers. Undefined unless the
 * repository sets `verb_runtime: actions` and the Forgejo client resolved.
 */
export const verbDispatcherFor = traced(
	"hooks.verbDispatcherFor",
	function verbDispatcherFor(
		repo: { verb_runtime?: "box" | "actions" | undefined },
		forgejo: ForgeClientResult,
		db: WatcherDb,
	): VerbWorkflowDispatch | undefined {
		if (!forgejo.ok || repo.verb_runtime !== "actions") return undefined;
		const client = forgejo.client;
		return createVerbDispatcher(client.write.bind(client), client.get.bind(client), {
			record: (rec) => recordDispatch(db, rec),
		});
	},
	// The client closes over the forge credential; the db over the connection.
	{ redact: { args: [1, 2] } },
);
