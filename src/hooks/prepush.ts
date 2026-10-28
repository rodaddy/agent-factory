/**
 * @module hooks/prepush
 * @description Dispatch the prepush Forgejo Actions gate (D23) for a
 *   pull-request delivery on any Forgejo repository whose watcher config sets
 *   `prepush_runtime: actions`, software-factory itself included: D23 moves
 *   prepush.yml to `workflow_dispatch` only, so the workflow that holds the
 *   status credential is read from the default branch and never from the PR.
 *   Absent or `box` runtime dispatches nothing; the box receipt path stays.
 *
 *   Same rules as `./pr-review`: the set of repositories comes from the loaded
 *   config, the workflow file, dispatch repo and ref are fixed constants, and
 *   the only payload values read are the PR number, head sha and base sha, each
 *   validated to a narrow shape before use. The workflow validates them again
 *   (scripts/actions/validate-inputs.ts) before any use.
 *
 *   The write goes through `guardDispatches` over `DISPATCH_TARGETS`,
 *   so a run no runner takes fails `factory/prepush` on the target head sha.
 *   Every accepted dispatch is recorded in `forge_runs` through the optional
 *   `record` seam; the row's `repo` is the workflow HOST repo
 *   (`SOP_GATE_DISPATCH_REPO`) and the gated repo is `inputs.repo`.
 *
 *   NEVER REJECTS and never logs a payload or a token.
 *
 * @outputs
 *   - `createPrepushTrigger` -- build the trigger over a write, read and record seam
 */
import type { DispatchQuery, DispatchRecord } from "../forge/actions-store";
import { errorClass, log, traced } from "../log";
import { type DispatchGuardOptions, dispatchLanded, guardDispatches } from "./dispatch-guard";
import {
	DISPATCH_TARGETS,
	PREPUSH_WORKFLOW_FILE,
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

/**
 * Head-ref prefix of the throwaway PRs the v1 receipt scripts open
 * (`scripts/done-means/v1-receipt-*.sh`). A same-repo PR on such a
 * ref is not gated; a fork PR with the same ref still is.
 */
export const RECEIPT_SCRATCH_PREFIX = "scratch/v1-receipt-";

/**
 * The head ref when this PR is a same-repo receipt scratch PR, else null.
 * Missing repo names never match, so an unknown origin is still gated.
 */
function sameRepoScratchRef(delivery: SopGateDelivery): string | null {
	const pr = property(delivery.payload, "pull_request");
	const head = property(pr, "head");
	const ref = property(head, "ref");
	const headRepo = property(property(head, "repo"), "full_name");
	const baseRepo = property(property(property(pr, "base"), "repo"), "full_name");
	if (typeof ref !== "string" || !ref.startsWith(RECEIPT_SCRATCH_PREFIX)) {
		return null;
	}
	if (typeof headRepo !== "string" || headRepo === "" || headRepo !== baseRepo) {
		return null;
	}
	return ref;
}

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	return (value as Record<string, unknown>)[key];
}

/** The config fields this module reads off each repository entry. */
export interface PrepushRepo {
	name: string;
	provider: string;
	prepush_runtime?: "box" | "actions";
}

/** Persist one dispatch; the receiver wires this to `recordDispatch(db, ...)`. */
export type PrepushRecord = (rec: DispatchRecord) => Promise<unknown>;

/** Find a live recorded dispatch; the receiver wires this to `findDispatch(db, ...)`. */
export type PrepushFind = (query: DispatchQuery) => Promise<number | null>;

/** Test and wiring seams: the #808 guard's clock, the forge_runs recorder and reader. */
export interface PrepushOptions {
	guard?: DispatchGuardOptions;
	record?: PrepushRecord;
	find?: PrepushFind;
	/** Atomic find-or-insert: the new row id, or null when a live dispatch holds the head. */
	claim?: (rec: DispatchRecord, match: Record<string, string>) => Promise<number | null>;
	/** Undo a claim whose POST failed twice. */
	release?: (id: number) => Promise<unknown>;
}

/**
 * True when forge_runs already holds a live prepush dispatch for this repo at
 * this head sha. A failed read is logged and dispatch proceeds.
 */
async function alreadyDispatched(
	find: PrepushFind,
	inputs: { head_sha: string } & Record<string, string>,
	ids: Record<string, string | undefined>,
): Promise<boolean> {
	try {
		const found = await find({
			repo: SOP_GATE_DISPATCH_REPO,
			workflow: PREPUSH_WORKFLOW_FILE,
			targetSha: inputs.head_sha,
			inputs: { repo: inputs.repo ?? "" },
		});
		return found !== null;
	} catch (err) {
		log("warn", "hooks.prepush.dedupe_read_failed", { error_class: errorClass(err), ...ids });
		return false;
	}
}

/**
 * Claim the dispatch row for this head: the new id, null when a live
 * dispatch already holds it, or undefined when the claim failed (logged).
 */
async function claimQuietly(
	claim: NonNullable<PrepushOptions["claim"]>,
	inputs: { head_sha: string } & Record<string, string>,
	ids: Record<string, string | undefined>,
): Promise<number | null | undefined> {
	try {
		return await claim(
			{
				repo: SOP_GATE_DISPATCH_REPO,
				workflow: PREPUSH_WORKFLOW_FILE,
				runId: null,
				targetSha: inputs.head_sha,
				inputs,
			},
			{ repo: inputs.repo ?? "" },
		);
	} catch (err) {
		log("warn", "hooks.prepush.dedupe_read_failed", { error_class: errorClass(err), ...ids });
		return undefined;
	}
}

/** The Forgejo repos on the Actions prepush runtime, software-factory included. */
function gatedRepos(repositories: readonly PrepushRepo[]): ReadonlySet<string> {
	return new Set(
		repositories
			.filter((repo) => repo.provider === "forgejo" && repo.prepush_runtime === "actions")
			.map((repo) => repo.name),
	);
}

/** Record one dispatch in forge_runs; a failure is logged, never thrown. */
async function recordQuietly(
	record: PrepushRecord,
	repo: string,
	inputs: { head_sha: string } & Record<string, string>,
): Promise<void> {
	try {
		await record({
			repo: SOP_GATE_DISPATCH_REPO,
			workflow: PREPUSH_WORKFLOW_FILE,
			runId: null,
			targetSha: inputs.head_sha,
			inputs,
		});
	} catch (err) {
		log("warn", "hooks.prepush.record_failed", {
			error_class: errorClass(err),
			repository: repo,
		});
	}
}

/** The workflow inputs, or null when the PR number or either sha is malformed. */
function dispatchInputs(
	delivery: SopGateDelivery,
): (DispatchRecord["inputs"] & { head_sha: string }) | null {
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
		// sf#708 (D15): the constant first-attempt level.
		log_level: "info",
	};
}

function createPrepushTriggerImpl(
	forgeWrite: SopGateWrite,
	read: SopGateRead,
	repositories: readonly PrepushRepo[],
	options: PrepushOptions = {},
): SopGateTrigger {
	const repos = gatedRepos(repositories);
	const write = guardDispatches(forgeWrite, read, DISPATCH_TARGETS, options.guard);
	const url = `${API_BASE}/repos/${SOP_GATE_DISPATCH_REPO}/actions/workflows/${PREPUSH_WORKFLOW_FILE}/dispatches`;
	return async function triggerPrepush(delivery: SopGateDelivery): Promise<void> {
		const gated = gatedDelivery(delivery, repos);
		if (gated === null) {
			return;
		}
		const { action, inputs, ids } = gated;
		const post = () => postDispatch(write, url, inputs, ids);
		// sf#940: `synchronized` and repeated `opened` deliveries for a head that
		// already has a live dispatch are deduped. `reopened` always dispatches,
		// so reopening a PR stays the deliberate way to re-run the gate.
		// sf#1019: an atomic claim replaces find -> POST -> record, so two
		// concurrent deliveries for one head cannot both dispatch. The winner
		// retries a failed POST once before releasing, so a deduped loser's head
		// is not left undispatched. A retry first proves the failed POST
		// created no run, since Forgejo inserts the run inside the POST.
		if (action !== "reopened" && options.claim !== undefined) {
			const claimed = await claimQuietly(options.claim, inputs, ids);
			if (claimed === null) {
				log("info", "hooks.prepush.deduped", { ...ids, head_sha: inputs.head_sha, action });
				return;
			}
			if (claimed !== undefined) {
				await dispatchClaimed({ post, read, inputs, ids }, () =>
					releaseQuietly(options.release, claimed, ids),
				);
				return;
			}
			// A failed claim falls through to the pre-sf#1019 path below, find
			// included (PR 1037 review).
		}
		if (
			action !== "reopened" &&
			options.find !== undefined &&
			(await alreadyDispatched(options.find, inputs, ids))
		) {
			log("info", "hooks.prepush.deduped", { ...ids, head_sha: inputs.head_sha, action });
			return;
		}
		if ((await post()) && options.record !== undefined) {
			await recordQuietly(options.record, delivery.repository, inputs);
		}
	};
}

type PrepushInputs = { head_sha: string } & Record<string, string>;
type PrepushIds = { repository: string; pr_number: string | undefined };

/** The action, inputs and log ids of a delivery this trigger gates, or null (logged when malformed or scratch). */
function gatedDelivery(
	delivery: SopGateDelivery,
	repos: ReadonlySet<string>,
): { action: string; inputs: PrepushInputs; ids: PrepushIds } | null {
	if (delivery.event !== "pull_request" || !repos.has(delivery.repository)) {
		return null;
	}
	const action = property(delivery.payload, "action");
	if (typeof action !== "string" || !QUALIFYING_ACTIONS.has(action)) {
		return null;
	}
	const inputs = dispatchInputs(delivery);
	if (inputs === null) {
		log("warn", "hooks.prepush.malformed", { repository: delivery.repository });
		return null;
	}
	const ids = { repository: delivery.repository, pr_number: inputs.number };
	const scratchRef = sameRepoScratchRef(delivery);
	if (scratchRef !== null) {
		log("info", "hooks.prepush.skipped_scratch", { ...ids, head_ref: scratchRef });
		return null;
	}
	return { action, inputs, ids };
}

/** POST the dispatch; true when accepted. A failure is logged, never thrown. */
async function postDispatch(
	write: SopGateWrite,
	url: string,
	inputs: PrepushInputs,
	ids: PrepushIds,
): Promise<boolean> {
	try {
		await write("POST", url, { ref: "main", inputs });
	} catch (err) {
		log("warn", "hooks.prepush.dispatch_failed", { error_class: errorClass(err), ...ids });
		return false;
	}
	log("info", "hooks.prepush.dispatched", { ...ids, head_sha: inputs.head_sha });
	return true;
}

/**
 * The claim winner's dispatch: post, and on failure check whether the first
 * POST landed anyway before one retry. When the retry fails too,
 * check again, and release only when neither POST created a run.
 */
async function dispatchClaimed(
	d: { post: () => Promise<boolean>; read: SopGateRead; inputs: PrepushInputs; ids: PrepushIds },
	release: () => Promise<void>,
): Promise<void> {
	const since = Date.now();
	const landed = async (): Promise<boolean> => {
		if (!(await landedQuietly(d.read, d.inputs, d.ids, since))) {
			return false;
		}
		log("info", "hooks.prepush.dispatch_landed", { ...d.ids, head_sha: d.inputs.head_sha });
		return true;
	};
	if ((await d.post()) || (await landed())) {
		return;
	}
	log("info", "hooks.prepush.dispatch_retry", { ...d.ids, head_sha: d.inputs.head_sha });
	if (!(await d.post()) && !(await landed())) {
		await release();
	}
}

/** True when the failed first POST is proven to have created a run. A failed read is logged and counts as not landed. */
async function landedQuietly(
	read: SopGateRead,
	inputs: PrepushInputs,
	ids: PrepushIds,
	since: number,
): Promise<boolean> {
	try {
		return await dispatchLanded(read, {
			dispatchRepo: SOP_GATE_DISPATCH_REPO,
			workflowFile: PREPUSH_WORKFLOW_FILE,
			inputs: { repo: inputs.repo ?? "", head_sha: inputs.head_sha },
			since,
		});
	} catch (err) {
		log("warn", "hooks.prepush.landed_read_failed", { error_class: errorClass(err), ...ids });
		return false;
	}
}

/** Release a claim whose POST failed; a failure is logged, never thrown. */
async function releaseQuietly(
	release: PrepushOptions["release"],
	id: number,
	ids: PrepushIds,
): Promise<void> {
	try {
		await release?.(id);
	} catch (err) {
		log("warn", "hooks.prepush.release_failed", { error_class: errorClass(err), ...ids });
	}
}

export const createPrepushTrigger = traced("hooks.createPrepushTrigger", createPrepushTriggerImpl);
