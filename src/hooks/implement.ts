/**
 * @module hooks/implement
 * @description Dispatch the implement Forgejo Actions lane (skeleton
 *   826a) for an issue delivery that carries the repository's configured
 *   `implement_label`, on any enrolled Forgejo repository whose watcher config
 *   sets `implement_runtime: actions`. Absent or `box` runtime dispatches
 *   nothing: reconcile keeps its box implement job (src/reconcile/pass.ts reads
 *   the same flag).
 *
 *   Same rules as `./issue-triage`: the set of repositories comes from the
 *   loaded config, the workflow file, dispatch repo and ref are fixed
 *   constants, and the only payload values read are the issue number
 *   (validated to a positive safe integer) and its label names (compared
 *   EXACTLY with the configured label). The `base_sha` input is NEVER read off
 *   the payload: it is the target's default-branch head, read through the
 *   trusted read seam, and must be 40 lowercase hex. The workflow validates
 *   every input again (scripts/actions/validate-inputs.ts) before any use.
 *
 *   Excluded: a GitHub repo (not on this forge) and software-factory itself.
 *
 *   The write goes through `guardDispatches` over `DISPATCH_TARGETS`;
 *   the dispatch carries no `head_sha`, so the guard starts no watch. Every
 *   accepted dispatch is recorded in `forge_runs` through the optional `record`
 *   seam: `repo` is the workflow HOST repo (`SOP_GATE_DISPATCH_REPO`), the
 *   target repo is `inputs.repo`, and `target_sha` is the base sha. Before the
 *   POST, the optional `find` seam reads forge_runs: a live (not failure or
 *   cancelled) implement dispatch for the same issue at the same base skips
 *   the dispatch, so repeated `label_updated` deliveries dispatch once per
 *   base (826b34). Only an OPEN issue qualifies.
 *
 *   NEVER REJECTS and never logs a payload or a token.
 *
 * @outputs
 *   - `createImplementTrigger` -- build the trigger over a write, read and record seam
 */
import type { DispatchQuery, DispatchRecord } from "../forge/actions-store";
import { errorClass, log, traced } from "../log";
import { type DispatchGuardOptions, dispatchLanded, guardDispatches } from "./dispatch-guard";
import {
	DISPATCH_TARGETS,
	IMPLEMENT_WORKFLOW_FILE,
	SOP_GATE_DISPATCH_REPO,
	type SopGateDelivery,
	type SopGateRead,
	type SopGateTrigger,
	type SopGateWrite,
} from "./sop-gate";

/** Forgejo API base. Pinned to the one reviewed deployment (`forgejo/config.ts`). */
const API_BASE = "https://forge.example.internal/api/v1";

/** Delivery events that can carry a label on an issue. */
const QUALIFYING_EVENTS: ReadonlySet<string> = new Set(["issues", "issue_label"]);

/**
 * Payload `action` values that can mean "this issue now carries the label":
 * opened with it, or labelled (`label_updated` is Forgejo's spelling).
 */
const QUALIFYING_ACTIONS: ReadonlySet<string> = new Set(["opened", "labeled", "label_updated"]);

const SHA = /^[0-9a-f]{40}$/;

function property(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) {
		return undefined;
	}
	return (value as Record<string, unknown>)[key];
}

/** The config fields this module reads off each repository entry. */
export interface ImplementRepo {
	name: string;
	provider: string;
	implement_label?: string;
	implement_runtime?: "box" | "actions";
}

/** Persist one dispatch; the receiver wires this to `recordDispatch(db, ...)`. */
export type ImplementRecord = (rec: DispatchRecord) => Promise<unknown>;

/** Find a live recorded dispatch; the receiver wires this to `findDispatch(db, ...)`. */
export type ImplementFind = (query: DispatchQuery) => Promise<number | null>;

/** Test and wiring seams: the #808 guard's clock, the forge_runs recorder and reader. */
export interface ImplementOptions {
	guard?: DispatchGuardOptions;
	record?: ImplementRecord;
	find?: ImplementFind;
	/** Atomic find-or-insert: the new row id, or null when a live dispatch holds the issue. */
	claim?: (rec: DispatchRecord, match: Record<string, string>) => Promise<number | null>;
	/** Undo a claim whose POST failed twice. */
	release?: (id: number) => Promise<unknown>;
}

/** Enrolled Forgejo repos on the Actions runtime, to their exact label. */
function implementRepos(repositories: readonly ImplementRepo[]): ReadonlyMap<string, string> {
	const out = new Map<string, string>();
	for (const repo of repositories) {
		if (
			repo.provider === "forgejo" &&
			repo.implement_runtime === "actions" &&
			repo.implement_label !== undefined &&
			repo.name !== SOP_GATE_DISPATCH_REPO
		) {
			out.set(repo.name, repo.implement_label);
		}
	}
	return out;
}

/** True when the issue's labels include `label`, matched exactly. */
function carriesLabel(payload: unknown, label: string): boolean {
	const labels = property(property(payload, "issue"), "labels");
	return Array.isArray(labels) && labels.some((entry) => property(entry, "name") === label);
}

/** The target's default-branch head through the trusted read seam, or null. */
async function readBaseSha(read: SopGateRead, repo: string): Promise<string | null> {
	const meta = await read(`${API_BASE}/repos/${repo}`);
	const branch = property(meta.data, "default_branch");
	if (meta.status !== 200 || typeof branch !== "string" || branch === "") {
		return null;
	}
	const head = await read(`${API_BASE}/repos/${repo}/branches/${encodeURIComponent(branch)}`);
	const sha = property(property(head.data, "commit"), "id");
	return head.status === 200 && typeof sha === "string" && SHA.test(sha) ? sha : null;
}

/** Record one dispatch in forge_runs; a failure is logged, never thrown. */
async function recordQuietly(
	record: ImplementRecord,
	repo: string,
	inputs: Record<string, string>,
): Promise<void> {
	try {
		await record({
			repo: SOP_GATE_DISPATCH_REPO,
			workflow: IMPLEMENT_WORKFLOW_FILE,
			runId: null,
			targetSha: inputs.base_sha ?? "",
			inputs,
		});
	} catch (err) {
		log("warn", "hooks.implement.record_failed", {
			error_class: errorClass(err),
			repository: repo,
		});
	}
}

/**
 * True when forge_runs already holds a live implement dispatch for this issue
 * at this base. A failed read is logged and dispatch proceeds.
 */
async function alreadyDispatched(
	find: ImplementFind,
	inputs: Record<string, string>,
	ids: Record<string, string>,
): Promise<boolean> {
	try {
		const found = await find({
			repo: SOP_GATE_DISPATCH_REPO,
			workflow: IMPLEMENT_WORKFLOW_FILE,
			targetSha: inputs.base_sha ?? "",
			inputs: { repo: inputs.repo ?? "", number: inputs.number ?? "" },
		});
		return found !== null;
	} catch (err) {
		log("warn", "hooks.implement.dedupe_read_failed", { error_class: errorClass(err), ...ids });
		return false;
	}
}

/**
 * Claim the dispatch row for this issue at this base: the new id,
 * null when a live dispatch already holds it, or undefined when the claim
 * failed (logged).
 */
async function claimQuietly(
	claim: NonNullable<ImplementOptions["claim"]>,
	inputs: Record<string, string>,
	ids: Record<string, string>,
): Promise<number | null | undefined> {
	try {
		return await claim(
			{
				repo: SOP_GATE_DISPATCH_REPO,
				workflow: IMPLEMENT_WORKFLOW_FILE,
				runId: null,
				targetSha: inputs.base_sha ?? "",
				inputs,
			},
			{ repo: inputs.repo ?? "", number: inputs.number ?? "" },
		);
	} catch (err) {
		log("warn", "hooks.implement.dedupe_read_failed", { error_class: errorClass(err), ...ids });
		return undefined;
	}
}

/** Release a claim whose POST failed; a failure is logged, never thrown. */
async function releaseQuietly(
	release: ImplementOptions["release"],
	id: number,
	ids: Record<string, string>,
): Promise<void> {
	try {
		await release?.(id);
	} catch (err) {
		log("warn", "hooks.implement.release_failed", { error_class: errorClass(err), ...ids });
	}
}

/**
 * The claim winner's dispatch: post, and on failure check whether the first
 * POST landed anyway before one retry. When the retry fails too,
 * check again, and release only when neither POST created a run.
 */
async function dispatchClaimed(
	d: {
		post: () => Promise<boolean>;
		read: SopGateRead;
		inputs: Record<string, string>;
		ids: Record<string, string>;
	},
	release: () => Promise<void>,
): Promise<void> {
	const since = Date.now();
	const landed = async (): Promise<boolean> => {
		if (!(await landedQuietly(d.read, d.inputs, d.ids, since))) {
			return false;
		}
		log("info", "hooks.implement.dispatch_landed", d.ids);
		return true;
	};
	if ((await d.post()) || (await landed())) {
		return;
	}
	log("info", "hooks.implement.dispatch_retry", d.ids);
	if (!(await d.post()) && !(await landed())) {
		await release();
	}
}

/** True when the failed first POST is proven to have created a run. A failed read is logged and counts as not landed. */
async function landedQuietly(
	read: SopGateRead,
	inputs: Record<string, string>,
	ids: Record<string, string>,
	since: number,
): Promise<boolean> {
	try {
		return await dispatchLanded(read, {
			dispatchRepo: SOP_GATE_DISPATCH_REPO,
			workflowFile: IMPLEMENT_WORKFLOW_FILE,
			inputs: {
				repo: inputs.repo ?? "",
				number: inputs.number ?? "",
				base_sha: inputs.base_sha ?? "",
			},
			since,
		});
	} catch (err) {
		log("warn", "hooks.implement.landed_read_failed", { error_class: errorClass(err), ...ids });
		return false;
	}
}

/** POST the dispatch; true when accepted. A failure is logged, never thrown. */
async function postDispatch(
	write: SopGateWrite,
	url: string,
	inputs: Record<string, string>,
	ids: Record<string, string>,
): Promise<boolean> {
	try {
		await write("POST", url, { ref: "main", inputs });
	} catch (err) {
		log("warn", "hooks.implement.dispatch_failed", { error_class: errorClass(err), ...ids });
		return false;
	}
	log("info", "hooks.implement.dispatched", ids);
	return true;
}

/** The validated issue number of a qualifying delivery (open issues only), or null. */
function qualifyingIssue(
	delivery: SopGateDelivery,
	repos: ReadonlyMap<string, string>,
): number | null {
	const label = repos.get(delivery.repository);
	if (label === undefined || !QUALIFYING_EVENTS.has(delivery.event)) {
		return null;
	}
	const action = property(delivery.payload, "action");
	if (typeof action !== "string" || !QUALIFYING_ACTIONS.has(action)) {
		return null;
	}
	if (property(property(delivery.payload, "issue"), "state") !== "open") {
		return null;
	}
	if (!carriesLabel(delivery.payload, label)) {
		return null;
	}
	const number = property(property(delivery.payload, "issue"), "number");
	if (typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0) {
		log("warn", "hooks.implement.malformed", { repository: delivery.repository });
		return null;
	}
	return number;
}

/** The target's base sha, or null (logged) when the read fails or does not resolve. */
async function resolveBaseSha(
	read: SopGateRead,
	repo: string,
	ids: Record<string, string>,
): Promise<string | null> {
	let baseSha: string | null;
	try {
		baseSha = await readBaseSha(read, repo);
	} catch (err) {
		log("warn", "hooks.implement.base_read_failed", { error_class: errorClass(err), ...ids });
		return null;
	}
	if (baseSha === null) {
		log("warn", "hooks.implement.base_unresolved", ids);
	}
	return baseSha;
}

function createImplementTriggerImpl(
	forgeWrite: SopGateWrite,
	read: SopGateRead,
	repositories: readonly ImplementRepo[],
	options: ImplementOptions = {},
): SopGateTrigger {
	const repos = implementRepos(repositories);
	const write = guardDispatches(forgeWrite, read, DISPATCH_TARGETS, options.guard);
	const url = `${API_BASE}/repos/${SOP_GATE_DISPATCH_REPO}/actions/workflows/${IMPLEMENT_WORKFLOW_FILE}/dispatches`;
	return async function triggerImplement(delivery: SopGateDelivery): Promise<void> {
		const number = qualifyingIssue(delivery, repos);
		if (number === null) {
			return;
		}
		const ids = { repository: delivery.repository, issue_number: String(number) };
		const baseSha = await resolveBaseSha(read, delivery.repository, ids);
		if (baseSha === null) {
			return;
		}
		const inputs = {
			repo: delivery.repository,
			number: String(number),
			base_sha: baseSha,
			log_level: "info",
		};
		// sf#1033: an atomic claim replaces find -> POST -> record, so the
		// `opened` and `label_updated` deliveries of one issue cannot both dispatch.
		// The winner retries a failed POST once before releasing, so a deduped
		// loser's issue is not left undispatched. A retry first proves
		// the failed POST created no run, since Forgejo inserts it inside the POST.
		if (options.claim !== undefined) {
			const claimed = await claimQuietly(options.claim, inputs, ids);
			if (claimed === null) {
				log("debug", "hooks.implement.duplicate_skipped", ids);
				return;
			}
			if (claimed !== undefined) {
				const post = () => postDispatch(write, url, inputs, ids);
				await dispatchClaimed({ post, read, inputs, ids }, () =>
					releaseQuietly(options.release, claimed, ids),
				);
				return;
			}
			// A failed claim falls through to the pre-sf#1033 path below, find
			// included (PR 1037 review).
		}
		if (options.find !== undefined && (await alreadyDispatched(options.find, inputs, ids))) {
			log("debug", "hooks.implement.duplicate_skipped", ids);
			return;
		}
		if ((await postDispatch(write, url, inputs, ids)) && options.record !== undefined) {
			await recordQuietly(options.record, delivery.repository, inputs);
		}
	};
}

export const createImplementTrigger = traced(
	"hooks.createImplementTrigger",
	createImplementTriggerImpl,
);
