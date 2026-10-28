/**
 * @module service-cycle
 * @description The reconcile CYCLE — the ordered sequence of steps one pass runs.
 *   Split out of `service.ts` (which remains the composition root) so the wiring
 *   and the cycle each stay at the size ceiling.
 *
 *   **The step ORDER in `createReconcileCycle` is load-bearing and moved here as
 *   one intact block.** Each step's position is a decision with a stated reason,
 *   and reordering them silently breaks the pipeline rather than failing a test:
 *
 *   1. `reclaimStaleJobs` — FIRST, before any sweep/dispatch, so this same cycle's
 *      dispatch pass re-claims what it releases.
 *   2. `requeueInfraFailedJobs` — alongside the reclaimer, before dispatch, same
 *      re-claim-this-cycle reason.
 *   3. `runKboardPass` (the READY STATION) — before the sweep, so a task claimed
 *      here has its implement job dispatched in this SAME cycle.
 *   4. `runPass` — the sweep; it owns and advances the cursors.
 *   5. `runVerbControlSurfacePass` — opted-in open verb issues only; creates and
 *      dispatches their fixed runtime=script jobs through the normal runner path.
 *      Its candidate set is the sweep's observed issues PLUS the items carrying a
 *      DUE pending verb row — verb rows are excluded from step 7 by design,
 *      so without that second half a due row is re-evaluated only when the forge
 *      cursor happens to re-surface its item. Inside this step the one-shot
 *      `redeploy:<app>` signal is CONSUMED FIRST and dispatch follows;
 *      that inner order is load-bearing for the same reason the outer one is.
 *   6. (retired with sf#830: the scheduled-audit step, #14.)
 *   7. `runBuildBumpIntake` — BEFORE dispatch, so a tag observed this pass is a
 *      candidate row the consuming lane can see in this same cycle. It
 *      re-reads each enrolled repository's tags FROM THE FORGE — a webhook payload
 *      is never the input — and dispatches nothing itself.
 *   8. `runBuildBumpBuild` — IMMEDIATELY AFTER intake, so a tag observed this pass
 *      starts building in the same cycle. It drives the Kaniko Job through
 *      the namespace-pinned Jobs client and dispatches no factory job; with no
 *      kubeconfig the client is `null` and the step is one bounded warn.
 *   9. `runBuildBumpBump` — IMMEDIATELY AFTER `runBuildBumpBuild`, so a candidate
 *      that finished building this pass opens its bump PRs in the same cycle.
 *     One invocation per (candidate, app_dir); with no bump credential
 *      or script the seam is `null` and the step is one bounded warn.
 *   9b. `runForgeRunnerScale` — sizes the Forge runner fleet for the bump's own
 *      Actions check; absent config disables it before any read.
 *   10. `dispatchPendingJobs` — dispatches what the pass just created.
 *   11. `resultReconciler.run()` — ingest.
 *   12. `runProposalPass` — BETWEEN ingest and publish: the branch must exist before
 *       the publisher can open a proposal against it. Skipped in shadow mode.
 *   13. `publisher.run()` — after ingest, so a plan is never posted before its
 *       source result is durably accepted.
 *   14. `runKboardTransitionsPass` — LAST, so it reads the state this cycle just
 *       produced, and OUTSIDE every transaction (a board round trip inside the
 *       publisher's `FOR UPDATE` lock would block concurrent dispatch).
 *
 *   Every step is ISOLATED: a failure is reported through `onError` and never
 *   aborts the cycle, advances a cursor, or deletes a result.
 *
 * @outputs
 *   - `ReconcileCycleDeps` -- the already-composed collaborators one cycle drives
 *   - `runVerbControlSurfacePass` -- step 5, exported so its cursor-independence is testable
 *   - `createReconcileCycle` -- build the single-pass closure and its shadow-id reader
 *
 * @dependencies
 *   - ./reconcile/dispatch-pass, ./reconcile/pass
 *   - ./kboard/pass, ./results/proposal-pass
 *   - ./jobs/verb-manifest-refresh -- freshens the share checkout before the manifest read
 */
import type { WatcherConfig } from "./config/schema";
import type { ControlSurface } from "./control-surface/boundary";
import { createGitHubControlSurface } from "./control-surface/github-backend";
import { runControlSurfacePass } from "./control-surface/pass";
import { resolveLabelDecision } from "./control-surface/resolve";
import { redeployRequests } from "./control-surface/vocabulary";
import type { WatcherDb } from "./db/client";
import type { ForgeClient } from "./forge/boundary";
import type { ForgeRegistry } from "./forge/registry";
import { runSettleForgeRunsStep } from "./forge/settle-runs";
import { listForgejoTags, readForgejoTag } from "./forgejo/tags";
import type { GitHubPublisher } from "./github/publish";
import { verbDispatcherFor } from "./hooks/verb";
import type { KubeJobsClient } from "./imagebuild/kube";
import { VERB_CHANGE_BASE_REPOSITORY } from "./jobs/verb-base";
import { isVerbId } from "./jobs/verb-dispatch";
import { type DueVerbItem, selectDueVerbItems } from "./jobs/verb-due";
import { dispatchVerbLive, loadVerbManifest, type VerbManifest } from "./jobs/verb-live";
import { refreshManifestCheckout } from "./jobs/verb-manifest-refresh";
import {
	consumeRedeployRequests,
	type RedeployCommenter,
	type RedeployConsumption,
} from "./jobs/verb-redeploy";
import type { KboardClient } from "./kboard/client";
import { runKboardPass, runKboardTransitionsPass } from "./kboard/pass";
import { errorMessage, log } from "./log";
import { type CriticalAlertTarget, runCycleAlerts } from "./observability/postings-absence-alert";
import type { BodyLandingStager } from "./prepush/stage";
import { runBuildBumpBuild } from "./reconcile/build-bump-build";
import { type BuildBumpBumpDeps, runBuildBumpBump } from "./reconcile/build-bump-bump";
import { type BuildBumpIntakeDeps, runBuildBumpIntake } from "./reconcile/build-bump-intake";
import { type MergeWatchDeps, runBumpMergeWatch } from "./reconcile/build-bump-merge-watch";
import {
	dispatchPendingJobs,
	type InfraGateSelector,
	reclaimStaleJobs,
	requeueInfraFailedJobs,
} from "./reconcile/dispatch-pass";
import { runForgeRunnerScaleStep } from "./reconcile/forge-runner-scale-resolve";
import { type ObservedOpenIssue, type PassResult, runPass } from "./reconcile/pass";
import { runStalePendingStep } from "./reconcile/stale-pending";
import { createSweepScope, type SweepScope } from "./reconcile/sweep-scope";
import { type ProposalPassDeps, runProposalPass } from "./results/proposal-pass";
import type { ResultReconciler } from "./results/reconcile";
import type { RunnerTransport } from "./runner/transport";

/** One managed repository's configuration, as the verb helpers below take it. */
type RepoConfig = WatcherConfig["repositories"][number];

/** The already-composed collaborators one reconcile cycle drives. */
export interface ReconcileCycleDeps {
	db: WatcherDb;
	config: WatcherConfig;
	registry: ForgeRegistry;
	transport: RunnerTransport;
	publisher: GitHubPublisher;
	resultReconciler: ResultReconciler;
	proposalDeps: ProposalPassDeps;
	bodyLandingStager: BodyLandingStager;
	kboardClient: KboardClient | null;
	/** Whether publication runs in shadow (ledger-only) mode; shadow never pushes. */
	shadow: boolean;
	/** Per-pass dispatch cap; absent means `MAX_DISPATCH_PER_PASS`. */
	maxDispatchPerPass?: number;
	/** Resolve an infra-static job's fixed static gates from the candidate's paths. */
	infraGateSelector: InfraGateSelector;
	/** Resolve a repository's forge client, or `null` when unmanaged. */
	clientFor: (repository: string) => Promise<ForgeClient | null>;
	/**
	 * The namespace-pinned Kubernetes Jobs client the build-bump build pass drives,
	 * or `null` when no `BUILD_BUMP_KUBECONFIG_B64` is configured. Resolved
	 * ONCE at composition, never per cycle; `null` makes step 8 a bounded no-op and
	 * leaves every other step running.
	 */
	kubeJobs: KubeJobsClient | null;
	/**
	 * The build-bump BUMP seam: the invoke closure with the forge
	 * credential already captured, plus the script path and workdir root. Composed
	 * ONCE at boot; `bump: null` (no token or no script on disk) makes step 9 a
	 * bounded no-op and leaves every other step running.
	 */
	buildBump: BuildBumpBumpDeps;
	/**
	 * Where the build-bump stuck-pair alert is filed
	 * (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §8), or `undefined` when `critical_alert`
	 * is not configured — the same off-by-default posture every other alert path
	 * takes.
	 *
	 * PASSED EXPLICITLY rather than read from the module-level binding
	 * `bindCriticalAlert` installs, because that binding is deliberately private to
	 * `observability/critical-alert` and its one consumer is `defaultOnError`, a
	 * sink with nothing to pass it. This pass HAS a deps object, so the target
	 * arrives as data and a test can supply a fake without touching process state.
	 *
	 * OPTIONAL so every existing composition and test compiles unchanged; absent
	 * means the pass still runs its bounded read and raises nothing.
	 */
	criticalAlertTarget?: CriticalAlertTarget;
	/** Bump merge watch seams; null or absent skips the step. */
	bumpMergeWatch?: MergeWatchDeps | null;
	onError: (error: unknown) => void;
}

/** One composed cycle: the closure the scheduler drives, plus its shadow-id reader. */
export interface ReconcileCycle {
	/**
	 * Run exactly one full cycle. Its signature is `() => Promise<PassResult>` so the
	 * daemon's scheduler drives it unchanged.
	 */
	run: () => Promise<PassResult>;
	/**
	 * The job ids whose intended writes the LAST completed cycle recorded to the
	 * shadow ledger (shadow mode only; empty in real mode).
	 */
	lastShadowJobIds: () => readonly number[];
}

/**
 * Build the single-pass closure. See the module docstring for why each step sits
 * where it does — that ORDER is the contract this function encodes.
 *
 * @param deps - the already-composed collaborators the cycle drives
 * @returns the cycle closure and the shadow-job-id reader the one-shot path reads
 */
/**
 * Steps 1-3 — the TOP-OF-CYCLE recovery phase. All of it runs BEFORE the sweep so
 * this same cycle's dispatch pass re-claims what these steps release. Every step
 * is isolated: a failure is reported through `onError` and never aborts the cycle,
 * advances a cursor, or deletes a result.
 */
async function runRecoveryPhase(deps: ReconcileCycleDeps, cycleNow: Date): Promise<void> {
	// Reclaim stale in-flight jobs FIRST, before any sweep/dispatch, so this same
	// cycle's dispatch pass re-claims what it releases. A crash between the
	// atomic claim and the running/release write strands a job in `dispatching`; a
	// runner box that dies before landing a result strands one in `running`. The
	// reclaimer re-pends both past a bounded age, status-guarded so a legitimately-
	// progressing row is never clobbered.
	//
	// The transport is threaded so a released box CLAIM also REAPS the LXC through
	// the same claim-scoped reap dispatch uses: releasing the claim without
	// powering the box off left three boxes running orphaned for hours and starved
	// the validate sandbox. Best-effort — a reap error is logged and never blocks
	// the re-pend.
	try {
		await reclaimStaleJobs(deps.db, cycleNow, {
			onError: (e) => deps.onError(e),
			transport: deps.transport,
		});
	} catch (e) {
		deps.onError(e);
	}
	// Revive terminal-`failed` jobs whose failure was INFRA-CLASS — the agent/harness
	// never produced a valid result (wrapper failure, missing/unparseable/schema-invalid
	// artifact, ingest rejection) — back to `pending` for a bounded number of retries.
	// A genuine review verdict (a valid ingested result whose status is `failed`)
	// left a `completed` attempt behind and is never revived. Runs alongside the
	// reclaimer, before dispatch, so this same cycle's dispatch pass re-claims what it
	// releases. Advances no cursor, touches no attempt/posting row.
	try {
		await requeueInfraFailedJobs(deps.db, cycleNow, { onError: (e) => deps.onError(e) });
	} catch (e) {
		deps.onError(e);
	}
	// The READY STATION. Runs alongside the reclaimer and the
	// infra-requeue, BEFORE the sweep and the dispatch pass, so a task claimed here
	// has its implement job dispatched in this SAME cycle rather than waiting a full
	// poll interval. It advances no cursor and dispatches nothing itself — it only
	// creates the pending job the existing dispatch pass then claims.
	//
	// With no `KBOARD_TOKEN` this logs one bounded warning and returns, so the
	// service boots and runs healthily before the credential is minted.
	try {
		await runKboardPass(
			{
				db: deps.db,
				client: deps.kboardClient,
				config: deps.config,
				clientFor: deps.clientFor,
				onError: (e) => deps.onError(e),
			},
			cycleNow,
		);
	} catch (e) {
		deps.onError(e);
	}
}

/** Build a semantic surface over labels already observed by the real sweep. */
function observedIssueSurface(issues: readonly ObservedOpenIssue[]): ControlSurface {
	const labelsByItem = new Map(issues.map(({ item }) => [item.number, item.labels]));
	return {
		readLabels: async ({ item }) => labelsByItem.get(item) ?? [],
		readColumn: async () => null,
		proposeLabelWrite: async ({ repository, item }) => ({
			applied: false,
			intent: `${repository}#${item} no-op`,
		}),
	};
}

/** Keep only issues whose current labels resolve to one of the six verb ids. */
function verbIssues(issues: readonly ObservedOpenIssue[]): ObservedOpenIssue[] {
	return issues.filter(({ item }) => {
		const job = resolveLabelDecision(item.labels).job;
		return job !== null && isVerbId(job);
	});
}

/**
 * Build the ONE observed-issue record a due pending verb row needs to re-enter the
 * control surface.
 *
 * `kind`/`state`/`headSha`/`title`/`updatedAt` are the shape `ObservedOpenIssue`
 * declares, and NONE of them is read by the verb path: `verbIssues` reads `labels`,
 * `observedIssueSurface` keys on `number`, and `dispatchVerbLive` takes
 * `repositoryId`/`itemId` from the row. They are stated as the fixed values a
 * verb-labelled open issue has rather than fetched, because inventing a richer read
 * here would add a forge round trip whose result nothing consumes.
 */
function dueVerbIssue(due: DueVerbItem, repo: RepoConfig, labels: string[]): ObservedOpenIssue {
	return {
		repo,
		repositoryId: due.repositoryId,
		itemId: due.itemId,
		item: {
			kind: "issue",
			number: due.itemNumber,
			state: "open",
			title: "",
			headSha: null,
			updatedAt: "",
			labels,
		},
	};
}

/**
 * Re-surface the items carrying a DUE pending verb row that this sweep's cursor did
 * not.
 *
 * THE LABELS ARE RE-READ FROM THE FORGE, not replayed from the row. Two reasons, and
 * the second is the load-bearing one:
 *
 *   1. The pending row does not persist the verb's parameter — the app name is
 *      derived from the label at decision time — so the decision has to be
 *      re-resolved from labels either way.
 *   2. Re-reading makes the re-dispatch honour a WITHDRAWN intent. An operator who
 *      removes the `deploy:<app>` label has cancelled the request; a driver that
 *      replayed a stored parameter would keep firing the verb after the label was
 *      gone. Re-resolving through the SAME `resolveLabelDecision` the observed path
 *      uses means the two paths can never disagree about what a label means.
 *
 * A read failure is a SKIP for that item this pass, never a throw: the row stays
 * pending and due, so the next cycle simply tries again. That is the same fail-soft
 * posture `observeLabels` already takes inside the control-surface pass.
 */
async function dueVerbCandidates(args: {
	deps: ReconcileCycleDeps;
	repo: RepoConfig;
	observed: readonly ObservedOpenIssue[];
	now: Date;
}): Promise<ObservedOpenIssue[]> {
	const { deps, repo, observed, now } = args;
	const due = await selectDueVerbItems(deps.db, { provider: repo.provider, name: repo.name }, now);
	const alreadyObserved = new Set(observed.map(({ item }) => item.number));
	const pending = due.filter((row) => !alreadyObserved.has(row.itemNumber));
	if (pending.length === 0) return [];

	const client = await deps.clientFor(repo.name);
	if (client === null) {
		log("warn", "verb.due_redispatch.no_client", {
			repository: repo.name,
			due_items: pending.length,
		});
		return [];
	}
	const surface = createGitHubControlSurface({ client });

	const candidates: ObservedOpenIssue[] = [];
	for (const row of pending) {
		const labels = await readDueVerbLabels(surface, repo.name, row.itemNumber);
		if (labels === null) continue;
		candidates.push(dueVerbIssue(row, repo, labels));
	}
	if (candidates.length > 0) {
		log("info", "verb.due_redispatch.resurfaced", {
			repository: repo.name,
			items: candidates.length,
		});
	}
	return candidates;
}

/**
 * Read one due item's current labels, or null when the forge cannot answer.
 *
 * Null is a SKIP for this item this pass, never a throw: the pending row is
 * untouched, still pending and still due, so the next cycle retries. Treating an
 * unreachable forge as "no labels" instead would be worse than skipping — it would
 * resolve to no-verb and look exactly like a deliberately withdrawn label.
 */
async function readDueVerbLabels(
	surface: ControlSurface,
	repository: string,
	item: number,
): Promise<string[] | null> {
	try {
		const labels = await surface.readLabels({ repository, item });
		return Array.isArray(labels) ? labels : null;
	} catch (error) {
		log("warn", "verb.due_redispatch.labels_unreadable", {
			repository,
			item,
			cause: errorMessage(error),
		});
		return null;
	}
}

async function dispatchObservedVerb(args: {
	deps: ReconcileCycleDeps;
	observed: ObservedOpenIssue;
	decision: Parameters<typeof dispatchVerbLive>[0]["decision"];
	manifest: VerbManifest;
	/**
	 * The sweep's shared per-pass state, carried down to this dispatch so
	 * the vmid it is handed is recorded in the SAME ledger `dispatchPendingJobs`
	 * consults. Required, not optional: a dispatch reaching here always belongs to
	 * exactly one sweep, and a missing ledger would silently restore the cross-lane
	 * collision this threading exists to close.
	 */
	scope: SweepScope;
	/**
	 * The already-CONSUMED re-run signal for this app, when one was
	 * consumed this pass. Reaching here at all means the label is already gone from
	 * the forge; this field only tells the dispatch to take its own point in the
	 * dedup key space instead of colliding with the terminal row.
	 */
	redeploy?: RedeployConsumption;
}): Promise<void> {
	const { deps, observed, decision, manifest, scope, redeploy } = args;
	try {
		// The verb's change is rendered against `rtech/k3s-deploy`, so its base comes
		// from the FORGEJO client regardless of which provider hosts the managed
		// issue. Resolution is fail-closed: an unresolved client leaves
		// `forge` undefined and `dispatchVerbLive` skips rather than persisting a job
		// whose result could only ever be rejected. This is a READ; the verb lane
		// still holds no forge-write credential.
		const forgejo = await deps.registry.clientFor("forgejo");
		const outcome = await dispatchVerbLive({
			db: deps.db,
			transport: deps.transport,
			config: deps.config,
			repo: observed.repo,
			repositoryId: observed.repositoryId,
			itemId: observed.itemId,
			decision,
			manifest,
			// The sweep's same-pass vmid ledger — the SAME object
			// `dispatchPendingJobs` gets below, which is what makes the de-dup span
			// both lanes rather than only this one's own dispatches.
			passVmids: scope.passVmids,
			// Likewise the SAME dispatch budget: the cap bounds the whole pass.
			passBudget: scope.passBudget,
			targetRemote: deps.proposalDeps.remoteFor(VERB_CHANGE_BASE_REPOSITORY),
			// The SAME landing seam the infra-static lane already dispatches through.
			// The rendered verb body is ~28k and the mcp2cli inline cap is
			// 10,000 chars, so the contract is landed as job.md and only a bootstrap
			// travels inline.
			bodyLandingStager: deps.bodyLandingStager,
			...(forgejo.ok ? { forge: forgejo.client } : {}),
			// The verb.yml dispatcher over the SAME Forgejo client, with the
			// forge_runs record seam createHookTrigger gives the other dispatchers. Built
			// only when the repository sets `verb_runtime: actions`.
			verbDispatch: verbDispatcherFor(observed.repo, forgejo, deps.db),
			// Omitted entirely when no signal was consumed, so the ordinary dispatch
			// path is byte-for-byte what it was.
			...(redeploy === undefined ? {} : { redeploy }),
		});
		log(outcome.status === "error" ? "warn" : "info", "verb.dispatch.result", {
			repository: decision.repository,
			item: decision.item,
			job_type: decision.decision.job,
			status: outcome.status,
			...(redeploy === undefined ? {} : { redeploy_app: redeploy.app }),
			...("reason" in outcome ? { cause: outcome.reason } : {}),
		});
	} catch (error) {
		deps.onError(error);
	}
}

/**
 * Resolve the rails manifest for a verb pass, or null when a config gate fails
 * closed (missing path, unreadable file, or invalid bytes); null cases are logged here.
 */
async function resolveVerbManifest(
	deps: ReconcileCycleDeps,
	repo: WatcherConfig["repositories"][number],
): Promise<VerbManifest | null> {
	const manifestPath = deps.config.railsManifestPath;
	if (manifestPath === undefined) {
		log("warn", "verb.dispatch.manifest_missing", { repository: repo.name });
		return null;
	}
	try {
		// FIRST, before the read: fast-forward the share checkout so this pass sees a
		// tuple reset that landed since the last cycle. Best-effort by
		// contract — it never throws, so a failed refresh falls through to the
		// as-is read below, which is exactly the pre-sf#321 behavior. In `external`
		// mode it skips the pull entirely and only records the on-disk HEAD.
		await refreshManifestCheckout(manifestPath, { mode: deps.config.railsManifestRefresh });
		const loaded = await loadVerbManifest(manifestPath);
		if (!loaded.ok) {
			log("warn", "verb.dispatch.manifest_missing", {
				repository: repo.name,
				cause: loaded.reason,
			});
			return null;
		}
		return loaded.manifest;
	} catch (error) {
		log("warn", "verb.dispatch.manifest_missing", {
			repository: repo.name,
			cause: errorMessage(error),
		});
		return null;
	}
}

/**
 * Assemble this repository's verb candidates: the issues THIS sweep observed, plus
 * the items carrying a DUE pending verb row that the cursor did not re-surface.
 *
 * The due-row driver runs only for a repository whose `verb_dispatch` gate is on and
 * only when the observed set is already exhausted of that item, so it adds no forge
 * read for a repository that would dispatch nothing anyway. Both halves are then
 * filtered by the SAME `verbIssues` predicate: an item whose labels no longer
 * resolve to a verb is dropped here regardless of which half it came from.
 */
async function verbCandidatesForRepo(args: {
	deps: ReconcileCycleDeps;
	repo: RepoConfig;
	observed: readonly ObservedOpenIssue[];
	now: Date;
}): Promise<ObservedOpenIssue[]> {
	const { deps, repo, observed, now } = args;
	const observedCandidates = verbIssues(observed);
	const due = await dueVerbCandidates({ deps, repo, observed: observedCandidates, now });
	return [...observedCandidates, ...verbIssues(due)];
}

/**
 * Build the APPLYING control surface the sf#305 consume step writes through.
 *
 * Deliberately NOT `observedIssueSurface`: that one is read-only by construction
 * (its `proposeLabelWrite` always answers `applied: false`), which is exactly
 * right for the dispatch pass and exactly wrong for a consumption that must
 * actually remove the label. `apply: true` is passed explicitly, because the
 * backend defaults to propose-only and the one caller allowed to mutate here says
 * so at the call site rather than inheriting it.
 */
function applyingSurfaceFor(client: ForgeClient): ControlSurface {
	return createGitHubControlSurface({ client, apply: true });
}

/** Post one bounded consumption receipt comment through the forge client. */
function redeployCommenter(client: ForgeClient): RedeployCommenter {
	return async ({ repository, item, body }) =>
		await client.write("POST", `/repos/${repository}/issues/${item}/comments`, { body });
}

/**
 * CONSUME every `redeploy:<app>` signal on this repository's candidates, BEFORE
 * anything is dispatched.
 *
 * This runs as its own pass over the candidate set rather than inside the
 * dispatch callback, and that placement IS the consume-before-dispatch guarantee:
 * every label removal the forge accepts has already returned by the time
 * `runControlSurfacePass` is called, so no ordering depends on the callback firing
 * in a particular sequence. See `jobs/verb-redeploy.ts` for why the reverse order
 * reopens the #210 box-churn failure.
 *
 * The candidate set here is the OBSERVED issues, not the verb-resolving subset: an
 * item carrying `redeploy:hello` with no `deploy:hello` names no verb row to
 * re-run, and its signal is still consumed and logged as a no-op. Leaving it
 * standing would make the watcher re-read the same dead label on every sweep
 * forever, and a one-shot label that is never consumed is not one-shot.
 */
async function consumeRedeployForRepo(args: {
	deps: ReconcileCycleDeps;
	repo: RepoConfig;
	candidates: readonly ObservedOpenIssue[];
	manifest: VerbManifest;
	now: Date;
}): Promise<Map<number, RedeployConsumption[]>> {
	const { deps, repo, candidates, manifest, now } = args;
	const consumed = new Map<number, RedeployConsumption[]>();
	const requesting = candidates.filter(({ item }) => redeployRequests(item.labels).length > 0);
	if (requesting.length === 0) return consumed;

	const client = await deps.clientFor(repo.name);
	if (client === null) {
		// No client is a SKIP, never a consumption: the label is still on the forge,
		// so reporting it consumed would dispatch a re-run whose signal stays armed.
		log("warn", "verb.redeploy.no_client", {
			repository: repo.name,
			items: requesting.length,
		});
		return consumed;
	}
	const consumeDeps = {
		surface: applyingSurfaceFor(client),
		repository: repo.name,
		manifestSha: manifest.sha256,
		comment: redeployCommenter(client),
		now,
	};
	for (const { item } of requesting) {
		const entries = await consumeRedeployRequests(consumeDeps, item.number, item.labels);
		if (entries.length > 0) consumed.set(item.number, entries);
	}
	return consumed;
}

/**
 * The consumed signal a decision's dispatch should carry, if any.
 *
 * Matched on the APP: `redeploy:hello` re-runs the row for `hello`, so a decision
 * resolving `deploy:other` on the same item must NOT pick it up. Without this the
 * label would re-run whatever verb the item happened to resolve to, which is a
 * different app's deploy than the one the operator named.
 */
function consumedForDecision(
	consumed: readonly RedeployConsumption[] | undefined,
	parameter: string | null,
): RedeployConsumption | undefined {
	if (consumed === undefined || parameter === null) return undefined;
	return consumed.find((entry) => entry.app === parameter);
}

/** Run the control surface for one repository, failing closed on both config gates. */
async function runVerbRepoPass(
	deps: ReconcileCycleDeps,
	repo: WatcherConfig["repositories"][number],
	observed: readonly ObservedOpenIssue[],
	scope: SweepScope,
): Promise<void> {
	const { now } = scope;
	// The verb gate is read BEFORE the due-row driver, so a repository with verb
	// dispatch off performs no extra forge read and its behaviour is byte-for-byte
	// what it was: warn on observed matches, dispatch nothing.
	if (repo.verb_dispatch !== true) {
		const observedCandidates = verbIssues(observed);
		if (observedCandidates.length === 0) return;
		log("warn", "verb.dispatch.disabled", {
			repository: repo.name,
			matching_items: observedCandidates.length,
		});
		return;
	}

	const candidates = await verbCandidatesForRepo({ deps, repo, observed, now });
	// The redeploy candidate set is the UNION of the verb candidates and every
	// observed issue carrying the label, so an item whose `redeploy:<app>` names no
	// verb row still gets its signal consumed rather than re-read forever.
	const redeployCandidates = [
		...candidates,
		...observed.filter(({ item }) => !candidates.some((c) => c.item.number === item.number)),
	];
	if (redeployCandidates.length === 0) return;

	const manifest = await resolveVerbManifest(deps, repo);
	if (manifest === null) return;

	// CONSUME BEFORE DISPATCH. This await completes — every accepted label
	// removal has already landed on the forge — before the dispatch pass below is
	// entered at all.
	const consumed = await consumeRedeployForRepo({
		deps,
		repo,
		candidates: redeployCandidates,
		manifest,
		now,
	});
	if (candidates.length === 0) return;

	await dispatchVerbCandidates({ deps, repo, candidates, manifest, consumed, scope });
}

/**
 * Drive the real control-surface pass over this repository's verb candidates.
 *
 * Split from `runVerbRepoPass` at the function-size ceiling, and the split line is
 * the meaningful one: everything above it PREPARES (gate, candidates, manifest,
 * and the sf#305 consume), everything here DISPATCHES. `consumed` arrives as a
 * completed map, so the consume-before-dispatch ordering is a property of the
 * call sequence rather than of anything inside this function.
 */
async function dispatchVerbCandidates(args: {
	deps: ReconcileCycleDeps;
	repo: RepoConfig;
	candidates: readonly ObservedOpenIssue[];
	manifest: VerbManifest;
	consumed: ReadonlyMap<number, RedeployConsumption[]>;
	/**
	 * The sweep's shared per-pass state, passed straight through to each
	 * dispatch so every vmid this lane takes lands in the ledger
	 * `dispatchPendingJobs` also reads.
	 */
	scope: SweepScope;
}): Promise<void> {
	const { deps, repo, candidates, manifest, consumed, scope } = args;
	const byItem = new Map(candidates.map((issue) => [issue.item.number, issue]));
	await runControlSurfacePass({
		surface: observedIssueSurface(candidates),
		events: candidates.map(({ item }) => ({ repository: repo.name, item: item.number })),
		dryRun: false,
		log: (decision) => {
			log("info", "control-surface.decision", {
				repository: decision.repository,
				item: decision.item,
				label: decision.decision.label,
				parameter: decision.decision.parameter,
				job_type: decision.decision.job,
				dispatched: decision.dispatched,
			});
		},
		dispatch: async (decision) => {
			const issue = byItem.get(decision.item);
			if (issue === undefined) return;
			const redeploy = consumedForDecision(
				consumed.get(decision.item),
				decision.decision.parameter,
			);
			await dispatchObservedVerb({
				deps,
				observed: issue,
				decision,
				manifest,
				scope,
				...(redeploy === undefined ? {} : { redeploy }),
			});
		},
	});
}

/**
 * Run each repository's verb surface once over this sweep's open issues, PLUS the
 * items carrying a due pending verb row that the cursor did not re-surface.
 *
 * Exported so the cursor-independence claim can be driven directly, the same way
 * `runProposalPass` is: the whole point of sf#300 is a dispatch that happens with an
 * EMPTY observed set, and a test that had to compose the entire cycle to assert it
 * would be proving the composition rather than the behaviour.
 *
 * `passVmids` is the sweep's same-pass vmid ledger, shared with
 * `dispatchPendingJobs`. It is OPTIONAL here and defaults to a fresh ledger so a
 * direct caller driving this lane alone still de-dups within its own dispatches;
 * only `runSweepPhase` can supply the cross-lane one, because only it owns both
 * lanes.
 */
export async function runVerbControlSurfacePass(
	deps: ReconcileCycleDeps,
	observed: readonly ObservedOpenIssue[],
	now: Date,
	shared: Partial<Pick<SweepScope, "passVmids" | "passBudget">> = {},
): Promise<void> {
	const scope = createSweepScope(deps, now, shared);
	for (const repo of deps.config.repositories) {
		const repoIssues = observed.filter(
			(issue) => issue.repo.name === repo.name && issue.repo.provider === repo.provider,
		);
		try {
			await runVerbRepoPass(deps, repo, repoIssues, scope);
		} catch (error) {
			deps.onError(error);
		}
	}
}

/**
 * The two forge seams build-bump intake reads through. Both use the SAME
 * per-repository client seam every other forge read uses, and both treat an
 * unmanaged repository (`null` client) as a FAILED read, with its own bounded
 * warn so a missing credential is distinguishable from an attempted read that
 * failed (`forgejo.tag*`). Two seams DELIBERATELY: `listTags` is one bounded page
 * of the newest tags; `readTag` is the MARKER path, a lookup BY NAME, because a
 * marker's commit can be arbitrarily old and page membership would read a live
 * marker as absent and delete its row.
 *
 * Isolated like every other step: a failure is reported and never aborts the cycle.
 *
 * @param deps - the composed cycle collaborators
 */
async function runBuildBumpIntakeStep(deps: ReconcileCycleDeps): Promise<void> {
	// `null` client => a FAILED read, with its own bounded warn first.
	const read = async <T>(repo: string, go: (c: ForgeClient) => Promise<T | null>) => {
		const c = await deps.clientFor(repo);
		if (c !== null) return go(c);
		log("warn", "build_bump_intake.no_client", { repository: repo });
		return null;
	};
	const intake: BuildBumpIntakeDeps = {
		listTags: (r) => read(r, (c) => listForgejoTags(c, r)),
		readTag: (r, name) => read(r, (c) => readForgejoTag(c, r, name)),
	};
	// ISOLATED, as `.catch()` rather than a `try` block — the same shape the alert
	// step below uses; a failure is reported and never aborts the cycle.
	await runBuildBumpIntake(deps.db, deps.config, intake).catch((e) => deps.onError(e));
}

/**
 * Steps 8 and 9: build the candidates intake just recorded, then bump the
 * ones that finished. Extracted as a pair because their adjacency IS the
 * contract — a build completing in this pass must reach its bump in the same cycle
 * rather than waiting a full poll interval.
 *
 * Neither step dispatches a factory job or advances a cursor, so their position
 * relative to `dispatchPendingJobs` is about latency, not correctness. Each is
 * ISOLATED separately: a build failure must not cost the bumps of candidates that
 * already built. With no `BUILD_BUMP_KUBECONFIG_B64` the Jobs client is `null`;
 * with no forge token or no script on disk the bump seam is `null`. Either way the
 * step is one bounded warn and the rest of the factory runs.
 *
 * The bump credential lives INSIDE `deps.buildBump.bump`, so the cycle never
 * handles a token.
 *
 * Then the merge watch: a merged bump PR hard-refreshes its Argo app.
 *
 * @param deps - the composed cycle collaborators
 */
async function runBuildBumpBuildAndBump(deps: ReconcileCycleDeps): Promise<void> {
	try {
		await runBuildBumpBuild(deps.db, { kube: deps.kubeJobs });
	} catch (e) {
		deps.onError(e);
	}
	await runBuildBumpBump(deps.db, deps.config, deps.buildBump).catch((e) => deps.onError(e));
	if (deps.bumpMergeWatch)
		await runBumpMergeWatch(deps.db, deps.bumpMergeWatch).catch((e) => deps.onError(e));
	// IMMEDIATELY AFTER the bump, reading the rows it just wrote (§8). §6 removed
	// harness terminality, so a failing pair returns to `pending` forever rather
	// than landing anywhere an operator could notice — this is the only thing that
	// turns a counter climbing in a loopback-only database into a
	// `[monitoring-critical]` issue.
	//
	// ISOLATED like every step above, as `.catch()` rather than a `try` block:
	// identical behaviour (the rejection reaches `onError` and the pass continues),
	// and this file sits ON the 500-line `max-lines` bound that `lint:size`
	// enforces — the four lines a `try` costs here are four the file does not have.
	//
	// Then, beside it, the postings-absence alert: a lane that dispatched
	// and posted nothing past the window. One call for both keeps this file inside
	// the `lint:size` bound; each alert is still isolated through `onError`.
	await runSettleForgeRunsStep(deps); // sf#990: settle forge_runs before the tallies are read
	await runCycleAlerts(deps.db, deps.criticalAlertTarget, deps.config, deps.onError);
}

/**
 * Steps 4-9 — the SWEEP phase: reconcile items and jobs, run the opted-in verb
 * control surface, evaluate declared audit schedules, take in build-bump tags and
 * build them, then dispatch everything now pending. `runPass` owns the cursors;
 * later steps are isolated.
 *
 * @returns the sweep's own pass result, which is the cycle's return value
 */
export async function runSweepPhase(deps: ReconcileCycleDeps, cycleNow: Date): Promise<PassResult> {
	// ONE same-pass vmid ledger for the whole sweep, created HERE because
	// this is the only scope that owns both dispatching lanes. The gateway's
	// `needed()` reports a warm box without reserving it, so the verb lane below and
	// `dispatchPendingJobs` after it could each be handed the same vmid and race
	// each other into a `runner_run failed (exit 1)` — measured live on the first
	// `deploy:hello` citizenship run (VMID 9001). Fresh per cycle:
	// the ledger is deliberately same-pass only, and one that outlived its pass would
	// refuse boxes the fleet has long since freed. The authoritative fix is the
	// gateway-side lease; this only stops the watcher racing itself.
	// ONE dispatch budget for the whole sweep too: the verb lane spends from
	// it first, the generic pass below shortlists at most what is left.
	const scope = createSweepScope(deps, cycleNow);
	const observedIssues: ObservedOpenIssue[] = [];
	const result = await runPass(deps.db, deps.registry, deps.config, {
		now: cycleNow.toISOString(),
		onOpenIssue: (issue) => observedIssues.push(issue),
	});
	// Feed current open verb issues through the real control-surface pass. The pass
	// itself dispatches the resulting verb jobs immediately; the normal pending
	// dispatch below remains responsible for every existing agent lane.
	//
	// The cycle clock is threaded so the verb pass's own DUE-ROW driver uses
	// the same `now` the rest of the cycle does. Verb rows are excluded from the
	// generic dispatcher by design, so without that driver a due pending verb row is
	// re-evaluated only when the forge cursor happens to re-surface its item.
	await runVerbControlSurfacePass(deps, observedIssues, cycleNow, scope);
	// Take in build-bump tags BEFORE dispatch, so a tag observed this pass
	// is a candidate row in this same cycle. The tags are RE-READ from the forge for
	// every repository carrying a `build_bump` block — a webhook payload is never
	// the input, so a spoofed or replayed delivery cannot introduce a candidate.
	// Dedupe is the (repository, tag, sha) unique index, so re-reading the same page
	// every cycle inserts nothing new. This step dispatches nothing and advances no
	// cursor; a repository whose read fails is skipped for the pass, and the whole
	// step is isolated like every other.
	await runBuildBumpIntakeStep(deps);
	await runBuildBumpBuildAndBump(deps);
	await runForgeRunnerScaleStep(deps);
	// The single owner of stranded factory statuses; isolated like the rest.
	await runStalePendingStep(deps);
	// Dispatch the pending jobs the pass just created. Bounded and idempotent: each
	// job's atomic claim skips a job already running/dispatched, and one job's
	// failure is isolated — it never aborts the cycle or advances a cursor (cursors
	// are owned by runPass, which already ran and advanced them).
	const dispatched = await dispatchPendingJobs(deps.db, deps.transport, deps.config, {
		// The SAME resolved cap the sweep's budget was built from (PR #680 review
		// P1), never a second parsing of `deps.maxDispatchPerPass`.
		maxPerPass: scope.maxDispatchPerPass,
		onError: (e) => deps.onError(e),
		// The dedicated infra-static exact-SHA lane lands its digest-bound job.md
		// through this seam (the runner fetches the exact foreign-repo commit from the
		// landed contract). Every other job type ignores it.
		bodyLandingStager: deps.bodyLandingStager,
		infraGateSelector: deps.infraGateSelector,
		// The SAME ledger the verb lane just used. Sharing the object is the
		// whole mechanism: a per-lane ledger would still let a verb job and an
		// infra-static job be handed the same warm vmid, which is the live defect.
		passVmids: scope.passVmids,
		passBudget: scope.passBudget,
	});
	// REPORT THE PASS. `DispatchPassSummary` is documented "safe to log
	// as-is (no secrets, no unbounded text)" and was returned here and dropped, so
	// the one number that answers "did the dispatcher do anything this cycle" was
	// computed every pass and never recorded.
	//
	// Gated on `selected > 0` DELIBERATELY. Every existing `info` line in this
	// service is event-triggered — `reclaim.box_released` fires only when a box was
	// released, `requeue.infra_failed` only when a job was revived, `kboard.claimed`
	// only when a task was claimed — and there is no unconditional per-pass
	// heartbeat anywhere in the codebase to match. At the default
	// `poll_interval_minutes: 15` an unconditional line would emit 96 all-zero
	// records a day, which is the noise that makes a journal census useless — the
	// very problem #144/#147 exist to fix. Nothing pending means nothing to say;
	// liveness is the status server's job, not this line's.
	if (dispatched.selected > 0) {
		log("info", "dispatch.summary", {
			selected: dispatched.selected,
			dispatched: dispatched.dispatched,
			queued: dispatched.queued,
			skipped: dispatched.skipped,
			errored: dispatched.errored,
		});
	}
	return result;
}

/**
 * Steps 10-13 — the SETTLE phase: ingest results, push verified branches and queue
 * their proposals, publish the queued plans, then report the ruled board outcome
 * transitions LAST.
 *
 * @returns the job ids whose intended writes were recorded to the shadow ledger
 */
async function runSettlePhase(deps: ReconcileCycleDeps): Promise<readonly number[]> {
	await deps.resultReconciler.run();
	// Push the branches for changes this cycle (or an earlier one) verified, and
	// queue their proposal plans. Sits BETWEEN ingest and publish for a
	// reason: the branch must exist before the publisher can open a proposal against
	// it, and the plan must exist before the publisher runs, or the whole chain waits
	// a full cycle at each hop. Isolated like every other step — a push failure is
	// counted and retried next cycle, never aborting the cycle.
	//
	// Shadow mode must not push: a shadow run records intended writes, and a real
	// branch appearing on the forge is not an intended write, it IS the write.
	// `.catch()` rather than `try` (same behaviour: the pass is async) to stay
	// inside the `lint:size` bound.
	if (!deps.shadow) await runProposalPass(deps.proposalDeps).catch((e) => deps.onError(e));
	// Publish (or, in shadow mode, ledger-record) the durable plans the just-
	// reconciled results queued. Runs after result reconciliation so a plan is never
	// posted before its source result is durably accepted.
	const published = await deps.publisher.run();
	// Report the ruled OUTCOME transitions for board-claimed jobs:
	// `running -> review` once a proposal is durably `posted`, and
	// `running -> blocked` once a job reaches a terminal failure. Runs LAST so it
	// reads the state this cycle just produced, and OUTSIDE every transaction for the
	// same reason the proposal pass is: a k-board round trip inside the publisher's
	// `FOR UPDATE` lock would block concurrent dispatch.
	//
	// A board-write failure here is a logged divergence, never a reason to unwind a
	// real PR or a real job outcome. Isolated like every other step.
	try {
		await runKboardTransitionsPass({
			db: deps.db,
			client: deps.kboardClient,
			onError: (e) => deps.onError(e),
		});
	} catch (e) {
		deps.onError(e);
	}
	return published.shadowJobIds;
}

/**
 * Build the single-pass closure. The three phase calls below ARE the cycle's
 * load-bearing order — recovery before the sweep, settle after it — and the module
 * docstring records why each individual step sits where it does inside its phase.
 *
 * @param deps - the already-composed collaborators the cycle drives
 * @returns the cycle closure and the shadow-job-id reader the one-shot path reads
 */
export function createReconcileCycle(deps: ReconcileCycleDeps): ReconcileCycle {
	// The job ids the LAST cycle's publisher recorded to the shadow ledger. Reset at
	// the start of every cycle so a stale set can never scope a later report.
	let shadowJobIds: readonly number[] = [];

	const run = async (): Promise<PassResult> => {
		shadowJobIds = [];
		const cycleNow = new Date();
		await runRecoveryPhase(deps, cycleNow);
		const result = await runSweepPhase(deps, cycleNow);
		// In shadow mode the publisher recorded the intended writes for these jobs to
		// the ledger; carry them so the one-shot path can render a scoped report.
		shadowJobIds = await runSettlePhase(deps);
		return result;
	};

	return { run, lastShadowJobIds: () => shadowJobIds };
}
