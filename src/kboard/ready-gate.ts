/**
 * @module kboard/ready-gate
 * @description The PRE-CLAIM half of the ready station. Every
 *   cheap local refusal a `ready` k-board task must survive BEFORE anything on
 *   the board is mutated, plus the binding/base/item resolution the claim and
 *   job creation then consume.
 *
 *   THE ORDER IS LOAD-BEARING, and it is the whole reason this is one unit.
 *   Every refusal here happens before the CAS claim in `kboard/pass`, so a task
 *   this factory will not work is never moved out of `ready`; and the base
 *   resolution happens before the claim too, so a repository whose base cannot
 *   be proven leaves the task exactly where a human parked it instead of
 *   stranding it in `running` with nothing behind it.
 *
 *   Split out of `kboard/pass` unchanged: that module sits at the
 *   500-code-line file ceiling, so this gate is a sibling rather than another
 *   function in it. Nothing about the gate's behavior changed in the move.
 *
 * @outputs
 *   - `gateReadyTask` -- steps 1-4, returning the resolved binding or null
 *   - `GatedReadyTask` -- what a passing gate hands the claim
 *   - `ValidatedBinding` -- a task's proven managed-repository binding
 *   - `validateBinding` -- the managed-repository authorization check
 *
 * @dependencies
 *   - ./client -- the k-board task shape
 *   - ../db/repos -- the sanctioned live-job/repository readers and writers
 *   - ../forge/provider -- the closed provider enum and its fail-closed parse
 *   - ../github/base-branch -- the fail-closed base commit resolution
 *   - ../templates/registry -- the fixed implement template id
 *   - ../log -- bounded, secret-safe structured logging
 */
import { and, eq } from "drizzle-orm";
import type { WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import { hasLiveJobForItem, hasLiveJobForKboardTask, upsertRepository } from "../db/repos";
import { githubItems } from "../db/schema";
import type { ForgeClient } from "../forge/boundary";
import { parseProvider } from "../forge/provider";
import { resolveBaseBranch, resolveBranchTipSha } from "../github/base-branch";
import { bounded, log, traced } from "../log";
import { IMPLEMENT_TEMPLATE_ID } from "../templates/registry";
import type { KboardTask } from "./client";

/**
 * A task's repo binding after it has been proven complete, well-formed, and
 * against the live managed-repository allowlist. Every field here is derived
 * from the BOARD, but only after the pair `(provider, full_name)` was proven to
 * be a managed repository — the same provider-qualified key the dispatch pass
 * and the config `superRefine` use.
 */
export interface ValidatedBinding {
	repository: string;
	itemNumber: number;
	/** The managed-repository config entry, source of `proposal_base_branch`. */
	repoConfig: WatcherConfig["repositories"][number];
}

/** The seams the pre-claim gate needs; a narrowing of `KboardPassDeps`. */
export interface ReadyGateDeps {
	db: WatcherDb;
	/** The live watcher config; owns the managed-repository allowlist. */
	config: WatcherConfig;
	/**
	 * The forge client for a managed repository, used ONLY to read the repository's
	 * default branch and that branch's tip commit. Returns null when the provider
	 * has no usable credential, and the task is refused rather than dispatched
	 * against an unproven base.
	 */
	clientFor(repository: string): Promise<ForgeClient | null>;
}

/** The bounded per-pass counters the gate tallies its refusals into. */
export interface ReadyGateSummary {
	skipped: number;
}

/** Everything the claim and job creation need, once every pre-claim gate passed. */
export interface GatedReadyTask {
	binding: ValidatedBinding;
	repositoryId: number;
	itemId: number;
	baseSha: string;
}

/**
 * Validate a task's repo binding against the live managed-repository allowlist.
 *
 * Returns null (with the caller logging a bounded skip) for anything short of a
 * complete, managed, supported-provider binding. This is the ONLY authorization
 * check the station needs — board placement plus a managed binding IS the
 * authorization (ruled) — so it is deliberately strict about every field rather
 * than filling a default in.
 *
 * The phase-1b `github`-only provider pin is LIFTED (umbrella sf#249 —
 * the factory moves to Forge): a task is now authorized on any provider in the
 * closed `PROVIDERS` enum, resolved through `parseProvider` so a corrupt or
 * unknown label still fails closed to null. Authorization itself is UNCHANGED —
 * it remains the managed-repository allowlist keyed on the provider-qualified
 * pair `(provider, full_name)`, so lifting the pin widens nothing on its own: a
 * Forgejo repository the operator has not listed is still refused.
 *
 * An ABSENT `repo_provider` is REFUSED: there is no silent `github`
 * default any more, matching the repository config, which now requires an
 * explicit `provider`. A board row that predates the provider column therefore
 * no longer binds; the refusal is logged at warn with the task id so a row that
 * used to bind and now does not is visible, not silent.
 */
export const validateBinding = traced(
	"kboard.validateBinding",
	function validateBinding(task: KboardTask, config: WatcherConfig): ValidatedBinding | null {
		if (task.repo_provider === undefined || task.repo_provider === null) {
			log("warn", "kboard.binding_refused", {
				task_id: task.task_id,
				reason: "repo_provider absent; refusing to bind (sf#812)",
			});
			return null;
		}
		const provider = parseProvider(task.repo_provider);
		const repository = task.repo_full_name;
		const itemNumber = task.repo_item_number;
		if (provider === null || typeof repository !== "string" || repository.length === 0) {
			return null;
		}
		if (typeof itemNumber !== "number" || !Number.isInteger(itemNumber) || itemNumber <= 0) {
			return null;
		}
		const repoConfig = config.repositories.find(
			(r) => r.provider === provider && r.name === repository,
		);
		if (repoConfig === undefined) {
			return null;
		}
		return { repository, itemNumber, repoConfig };
	},
);

/**
 * Whether the implement template this station would dispatch through is named in
 * the live config's `job_templates` allowlist.
 *
 * This is deliberately the SAME question `reconcile/dispatch-pass`'s
 * `resolveTemplate` asks, asked one layer earlier. The registry half of that gate
 * (`isKnownTemplate`) is not re-checked here: the id is a compile-time constant
 * from the registry itself, so only the operator-owned allowlist can be missing.
 * Re-read from the live config on every pass, exactly like the managed-repository
 * allowlist above, so enabling the template revives every task still sitting in
 * `ready` without any board write to undo.
 *
 * The REFUSAL IS NAMED because an absent gate and a refusing gate must not look
 * alike (trap #84): the silent version of this is the whole of defect 2 in #144.
 */
const isTemplateAllowlisted = (config: WatcherConfig): boolean =>
	config.job_templates.some((t) => t.id === IMPLEMENT_TEMPLATE_ID);

/**
 * Resolve the base commit an implement job must start from, using the SAME
 * config-first, forge-fallback, fail-closed resolution the label lane uses.
 *
 * A task may carry `repo_base_sha`, and it is DELIBERATELY NOT TRUSTED: #65's
 * provenance gate compares a returned bundle against the exact commit the
 * watcher handed out, in full, so the base must be a value this service proved
 * live at dispatch time. A board-supplied SHA is a claim about the forge made by
 * a system that is not the forge; taking it would validate a bundle against a
 * commit nobody confirmed exists. Fails closed — no base, no job.
 */
async function resolveDispatchBase(
	deps: ReadyGateDeps,
	binding: ValidatedBinding,
): Promise<string | null> {
	const client = await deps.clientFor(binding.repository);
	if (client === null) {
		return null;
	}
	const branch = await resolveBaseBranch(
		client,
		binding.repository,
		binding.repoConfig.proposal_base_branch,
	);
	if (branch === null) {
		return null;
	}
	return resolveBranchTipSha(client, binding.repository, branch);
}

/** The issue item row's id for this repository/number, or `undefined` if absent. */
async function findIssueItemId(
	db: WatcherDb,
	repositoryId: number,
	itemNumber: number,
): Promise<number | undefined> {
	const [row] = await db
		.select({ id: githubItems.id })
		.from(githubItems)
		.where(
			and(
				eq(githubItems.repositoryId, repositoryId),
				eq(githubItems.kind, "issue"),
				eq(githubItems.number, itemNumber),
			),
		)
		.limit(1);
	return row?.id;
}

/**
 * Materialize the durable `github_items` row the job must join to.
 *
 * A job with no item cannot become a proposal: `proposalBranchFor` derives
 * `rw/issue-<n>` from the item number, and the candidate loader inner-joins
 * `github_items`. The sweep normally creates this row, but the ready station
 * runs BEFORE the sweep in the cycle (so a claimed task dispatches the same
 * cycle), and a task may name an issue no sweep has observed yet.
 *
 * READ FIRST, INSERT ONLY IF ABSENT — deliberately NOT `upsertGithubItem`. That
 * helper's `onConflictDoUpdate` is correct for the sweep, which has just READ the
 * item from the forge and is writing the truth. This station has read nothing: it
 * knows only the integer the board handed it. Routing through the upsert would
 * clobber a real title, state, and head SHA the sweep recorded with a blank
 * placeholder, and the sweep only writes them back if the item happens to fall
 * inside its cursor window — which for a long-idle issue it does not. So the
 * placeholder is written ONLY when the row does not exist at all, and the sweep
 * fills in the real values whenever it next observes the issue.
 *
 * The placeholder is minimal and matches the shape the sweep writes for an open
 * issue: `kind: "issue"`, `state: "open"`, no head SHA, empty title. It does NOT
 * invent a PR — an implement job's item is an issue by definition, and the
 * sweep's own `isImplementCandidate` refuses a PR for the same reason.
 */
async function ensureItemRow(
	db: WatcherDb,
	binding: ValidatedBinding,
	repositoryId: number,
	now: Date,
): Promise<number> {
	const existing = await findIssueItemId(db, repositoryId, binding.itemNumber);
	if (existing !== undefined) {
		return existing;
	}
	// `onConflictDoNothing` closes the race between the select above and this
	// insert: a concurrent pass (or the sweep) may have created the row in between,
	// and losing that race must resolve to the existing id, never an error.
	const [inserted] = await db
		.insert(githubItems)
		.values({
			repositoryId,
			kind: "issue",
			number: binding.itemNumber,
			headSha: null,
			state: "open",
			title: "",
			githubUpdatedAt: now,
			observedAt: now,
		})
		.onConflictDoNothing({
			target: [githubItems.repositoryId, githubItems.kind, githubItems.number],
		})
		.returning({ id: githubItems.id });
	if (inserted !== undefined) {
		return inserted.id;
	}
	const raced = await findIssueItemId(db, repositoryId, binding.itemNumber);
	if (raced === undefined) {
		throw new Error(`could not resolve item row for issue #${binding.itemNumber}`);
	}
	return raced;
}

/**
 * Steps 1-2 of the gate: the two purely-local refusals, decided from the task
 * and the live config alone, with no database or forge read at all.
 *
 * Returns the proven binding, or `null` having logged the bounded refusal.
 */
function gateLocally(
	deps: ReadyGateDeps,
	task: KboardTask,
	summary: ReadyGateSummary,
): ValidatedBinding | null {
	// 1. Board placement plus a managed binding IS the authorization (ruled). A
	// task without one is not this factory's work; skip it quietly and cheaply.
	const binding = validateBinding(task, deps.config);
	if (binding === null) {
		summary.skipped++;
		log("info", "kboard.skipped_unmanaged", {
			task_id: task.task_id,
			// The board's own strings, bounded — they name a repository, which is not a
			// secret, but they are external input and are clamped like any other.
			repo_provider: bounded(task.repo_provider ?? "none"),
			repo_full_name: bounded(task.repo_full_name ?? "none"),
			has_item: task.repo_item_number != null,
		});
		return null;
	}

	// 2. TEMPLATE GATE, BEFORE ANY CLAIM. The ready station hardcodes
	// IMPLEMENT_TEMPLATE_ID at its `createPendingJob` call, but the dispatch pass
	// INDEPENDENTLY re-gates every pending job against `config.job_templates` and
	// defers a template it cannot resolve. `implement-issue` ships commented-out in
	// `config/repos.example.yml` — deliberate opt-in — so a factory that has not
	// enabled it would claim the task into `running` and then have its job
	// re-deferred hourly forever: the exact stranded state the station's own doc
	// promises never to leave (live 2026-08-02, task t_67e2952e / job 715). Asking
	// the SAME question here, before the claim, leaves the task exactly where the
	// human parked it. No CAS write and no event — nothing about the task changed —
	// so enabling the template later simply lets a later pass claim it.
	if (!isTemplateAllowlisted(deps.config)) {
		summary.skipped++;
		// NAMED, not silent: an absent gate and a refusing gate must not look alike
		// (trap #84) — the silent version of this is defect 2 of the same issue.
		log("warn", "kboard.template_not_allowlisted", {
			reason: "the implement template is not in config job_templates; leaving the task in ready",
			task_id: task.task_id,
			template_id: IMPLEMENT_TEMPLATE_ID,
		});
		return null;
	}

	return binding;
}

/**
 * Steps 1-4 of the ready station: every cheap local refusal, ALL of them BEFORE
 * the claim. Returns `null` when the task is refused (the caller returns having
 * tallied the reason), so a task this factory will not work is never mutated on
 * the board.
 */
export const gateReadyTask = traced(
	"kboard.gateReadyTask",
	async function gateReadyTask(
		deps: ReadyGateDeps,
		task: KboardTask,
		now: Date,
		summary: ReadyGateSummary,
	): Promise<GatedReadyTask | null> {
		const binding = gateLocally(deps, task, summary);
		if (binding === null) {
			return null;
		}

		// 3. IDEMPOTENCY GUARD, BEFORE ANY CLAIM. Two independent questions, because a
		// duplicate can arrive from either side: the same task re-listed while its job
		// still runs, or a DIFFERENT task pointed at an issue the label lane already
		// picked up. Either way a second implement job for one issue means two runners
		// racing to propose competing changes for the same work. Checked before the
		// PATCH so a skipped task is never mutated on the board.
		if (await hasLiveJobForKboardTask(deps.db, task.task_id)) {
			summary.skipped++;
			log("warn", "kboard.divergence", {
				reason: "task is ready but already has a live local job",
				task_id: task.task_id,
			});
			return null;
		}

		const repositoryId = await upsertRepository(
			deps.db,
			binding.repository,
			binding.repoConfig.checks,
			binding.repoConfig.provider,
		);
		const itemId = await ensureItemRow(deps.db, binding, repositoryId, now);

		if (await hasLiveJobForItem(deps.db, repositoryId, itemId, IMPLEMENT_TEMPLATE_ID)) {
			summary.skipped++;
			log("warn", "kboard.divergence", {
				reason: "item already has a live implement job from another trigger",
				task_id: task.task_id,
				repository: binding.repository,
				item_number: binding.itemNumber,
			});
			return null;
		}

		// 4. Prove the base LIVE before claiming. #65 compares a returned bundle
		// against the exact dispatched commit in full, so a job with no proven base is
		// unverifiable by construction. Resolving it first means an unresolvable base
		// costs a forge read and leaves the task untouched in `ready`, rather than
		// parking it in `running` behind a job that was never created.
		const baseSha = await resolveDispatchBase(deps, binding);
		if (baseSha === null) {
			summary.skipped++;
			log("warn", "kboard.base_unresolved", {
				task_id: task.task_id,
				repository: binding.repository,
				reason: "no proven base commit; leaving the task in ready",
			});
			return null;
		}

		return { binding, repositoryId, itemId, baseSha };
	},
);
