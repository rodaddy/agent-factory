/**
 * @module service
 * @description Compose the watcher's runtime: load configuration, resolve the
 *   database and GitHub read client, and drive the single-flight reconciliation
 *   scheduler. This is the wiring layer the CLI's run command invokes; it owns
 *   startup, interval scheduling, structured result logging, and graceful
 *   shutdown on SIGINT/SIGTERM. After each pass reconciles runner results, the
 *   bounded GitHub posting reconciler publishes the durable publication plans
 *   those results queued (approved labels/comments/checks only).
 *
 *   `startService` (the `watch` daemon) and `runOnce` (the one-shot `reconcile
 *   once` command) share ONE composition — `composeService` — so the one-shot
 *   path reuses the exact loadConfig/createDb/credentials/client/pass wiring the
 *   daemon uses; the ONLY difference is that `runOnce` runs a single pass and
 *   returns, starting neither the status server nor the interval scheduler.
 *
 *   The cycle also drives the k-board READY STATION: a bounded
 *   top-of-cycle step claims `ready` board tasks and creates their implement
 *   jobs, and a bounded final step reports the ruled outcome transitions
 *   (`review` on a proposal, `blocked` on a terminal failure) back to the board.
 *   Both are inert with no `KBOARD_TOKEN`, so the service deploys and boots
 *   healthily before that credential is minted.
 *
 *   In shadow mode ONLY, `runOnce` additionally renders the bounded shadow
 *   compare report (the intended labels/comments/checks the pass recorded to the
 *   ledger, scoped to the jobs it touched) to stdout after the pass summary, so
 *   the operator sees the intended writes before going live. A real run emits no
 *   report and makes zero GitHub mutating calls.
 *
 *   Every pass STAMPS the process-level liveness record before its body
 *   runs and records its outcome after, so `/healthz` can answer "is the loop
 *   turning" independently of any repository's cursor — and the pass summary
 *   NAMES the repositories behind its fail count, which it previously dropped.
 *
 * @outputs
 *   - `startService` -- start the reconciliation loop and return a stop handle
 *   - `runOnce` -- run exactly one reconciliation pass, then return (no server)
 *   - `ServiceHandle` -- await/stop the running service
 *   - `summarize` -- the one-line pass summary, naming failed repositories
 *   - `logRepoFailures` -- one structured event per failed repository
 *   - `redactBusUrl` -- host/port only, for every line that names the bus URL
 *
 * @dependencies
 *   - ./config/load, ./db/client, ./github/credentials, ./github/client
 *   - ./github/publish, ./github/shadow-report, ./reconcile/pass,
 *     ./reconcile/dispatch-pass, ./reconcile/scheduler
 */

import type { NatsBus } from "./bus/nats";
import {
	closeBus,
	createBusFromEnv,
	type ResultsConsumerHandle,
	redactBusUrl,
	startResultsConsumerOrNone,
	stopResultsConsumer,
} from "./bus/side-channels";
// Re-exported rather than moved out of reach: `redactBusUrl` is imported from
// this module by its own tests, and the extraction is about
// file size, not about changing what `service.ts` offers.
import { BusResultReader } from "./results/bus-reader";

// Re-exported rather than moved out of reach: `redactBusUrl` is imported from
// this module by its own tests, and the extraction is about
// file size, not about changing what `service.ts` offers.
export { redactBusUrl };

import type { loadConfig } from "./config/load";
import type { WatcherConfig } from "./config/schema";
import type { WatcherDb } from "./db/client";
import type { ForgeRegistry } from "./forge/registry";
import { createForgejoClient } from "./forgejo/client";
import { resolveForgejoDeployment } from "./forgejo/config";
import { resolveForgejoToken } from "./forgejo/credentials";
import type { GitHubClient } from "./github/client";
import type { resolveGitHubToken } from "./github/credentials";
import { buildShadowReportForJobs, renderShadowReport } from "./github/shadow-report";
import { createHookTrigger } from "./hooks/infra-static";
import { BUMP_RECEIPT_REPOSITORY } from "./imagebuild/bump";
import {
	createKubeJobsClient,
	type KubeJobsClient,
	resolveBuildBumpKubeconfig,
} from "./imagebuild/kube";
import type { FetchLike } from "./kboard/client";
import { resolveKboardClient } from "./kboard/resolve";
import { errorMessage, log, withLogFields } from "./log";
import { bindCriticalAlert, defaultOnError } from "./observability/critical-alert";
import type { HostConflictStatus } from "./observability/host-conflicts";
import type { assertPacketsBootable } from "./packets/registry";
import { createArgoRefresher } from "./reconcile/argo-refresh";
import type { MergeWatchDeps } from "./reconcile/build-bump-merge-watch";
import { followThroughSink } from "./reconcile/follow-through";
import { resolveBuildBump } from "./reconcile/build-bump-resolve";
import { parseMaxDispatchPerPass } from "./reconcile/dispatch-pass";
import type { PassResult } from "./reconcile/pass";
import { Scheduler, type SchedulerOptions } from "./reconcile/scheduler";
import { createGitRunner, type GitRunner } from "./results/branch-publisher";
import { defaultChangeWorkRoot } from "./results/change-verifier";
import { defaultCollabRoot } from "./results/reconcile";
import { assertChangeWorkRootWritable } from "./results/work-root-preflight";
import type { RunnerTransport } from "./runner/transport";
import { createRunnerTransport } from "./runner/transport-http";
import { bootService } from "./service-boot";
import { createReconcileCycle } from "./service-cycle";
import { createIngestAndPublish } from "./service-ingest";
import { logPassResult, passScoped } from "./service-pass-log";
import { createInfraGateSelector, createServiceResolvers } from "./service-resolvers";
import { PassLivenessTracker } from "./status/pass-liveness";
import { startStatusServer } from "./status/server";

export { summarize } from "./service-pass-log";

export interface ServiceHandle {
	/**
	 * Stop scheduling, await the in-flight pass, then flush observability. MUST be
	 * awaited before `process.exit` — the trace flush is the last step and an
	 * un-awaited stop drops the SDK's whole batching window.
	 */
	stop: () => Promise<void>;
	/** The scheduler, exposed for explicit triggers/tests. */
	scheduler: Scheduler;
}

/**
 * Overridable factory seams. Production leaves these unset and the real
 * config/db/credentials/client/transport are built; tests inject fakes to
 * exercise composition without a live database, GitHub token, or runner box.
 */
export interface ComposeDeps {
	loadConfig?: typeof loadConfig;
	/**
	 * The packet boot gate. Production leaves it unset and the real gate
	 * validates every packet in `packets/`; a test injects a fake to drive the
	 * boot-fails-on-a-malformed-packet path (or to point at a fixture directory)
	 * without shipping a broken packet in the repo.
	 */
	assertPacketsBootable?: typeof assertPacketsBootable;
	/**
	 * The change work-root write probe. Production leaves it unset and the
	 * real probe runs against the bound work root; a test injects a fake to drive
	 * the boot-fails-on-an-unwritable-root path without needing a real unwritable
	 * directory.
	 */
	assertChangeWorkRootWritable?: typeof assertChangeWorkRootWritable;
	resolveGitHubToken?: typeof resolveGitHubToken;
	createDb?: () => { db: WatcherDb; client: { end?: () => Promise<void> } };
	createGitHubClient?: (token: string) => GitHubClient;
	/**
	 * Per-provider forge registry the sweep reads mixed repos through. Production
	 * leaves it unset and one is built from the resolved GitHub token plus the
	 * `FORGEJO_TOKEN` resolver; tests inject a registry with faked clients.
	 */
	forgeRegistry?: ForgeRegistry;
	/** Runner-box transport for dispatch. Defaults to the mcp2cli transport. */
	transport?: RunnerTransport;
	/**
	 * Git surface for change verification and branch publication. Defaults
	 * to the real subprocess runner; tests inject a scripted one so a cycle can be
	 * driven without a repository or a network.
	 */
	git?: GitRunner;
	/**
	 * Resolve a managed repository's push/fetch remote. Production derives
	 * it from the repository's configured provider; tests point it at a local
	 * fixture repository so the whole chain can run against real git without a
	 * network. Never reachable from runner output either way.
	 */
	remoteFor?: (repository: string) => string | null;
	/** Read-only rtech-infra rails manifest path; tests may point at a fixture. */
	railsManifestPath?: string;
	/**
	 * Transport seam for the k-board client. Production leaves it
	 * unset and the global fetch is used; a test injects a scripted fetch so the
	 * ready station can be driven without the live board.
	 */
	kboardFetch?: FetchLike;
	/**
	 * Environment the k-board credential is read from. Production leaves it unset
	 * (`process.env`); a test supplies one so the token-present and token-absent
	 * paths are both reachable without mutating the process environment.
	 */
	kboardEnv?: NodeJS.ProcessEnv;
}

/**
 * Lifecycle seams the DAEMON alone uses to bind its long-lived resources: the
 * status HTTP server and the interval scheduler. Both default to the real
 * implementations. `runOnce` NEVER touches either seam — it is single-shot and
 * binds no listener or timer — so a test can inject spies here and assert they
 * are never invoked during a one-shot run (proving the single-shot property
 * would fail the instant a future change starts a server or interval in runOnce).
 */
export interface LifecycleSeams {
	/** Bind the status HTTP server. The daemon calls this; `runOnce` never does. */
	startStatusServer?: typeof startStatusServer;
	/** Construct the interval scheduler. The daemon calls this; `runOnce` never does. */
	createScheduler?: (opts: ConstructorParameters<typeof Scheduler>[0]) => Scheduler;
}

export interface StartServiceOptions extends ComposeDeps, LifecycleSeams {
	/** Path to the YAML config. Defaults to `config/repos.yml`. */
	configPath?: string;
	/** Result sink; defaults to a compact stdout line. */
	onResult?: (result: PassResult) => void;
	/** Error sink; defaults to a compact stderr line. */
	onError?: (error: unknown) => void;
	/** Local status page port. Defaults to 8787; set 0 to pick a free port. */
	statusPort?: number;
	/** Collab share root override for tests/nonstandard mounts. */
	collabRoot?: string;
	/**
	 * Watcher-owned work root for verified change snapshots and publish scratch.
	 * Defaults to `defaultChangeWorkRoot()`; MUST be outside the collab
	 * share so a runner cannot rewrite a snapshot between verification and push.
	 */
	changeWorkRoot?: string;
	/**
	 * The pass-liveness record the scheduler stamps and the status server reads.
	 * Defaults to a fresh `PassLivenessTracker`; injected in tests so an
	 * assertion can drive the real scheduler seam and then read what was recorded,
	 * rather than inferring it from an HTTP response.
	 */
	passLiveness?: PassLivenessTracker;
	/**
	 * The event bus, injected instead of built from the environment.
	 *
	 * A seam rather than a feature: the shutdown ORDER a bus participates in
	 * is observable only as a sequence of calls, and both
	 * orders otherwise "succeed". Env-driven construction stays the production
	 * path — `createBusFromEnv` is used whenever this is absent.
	 */
	bus?: NatsBus;
}

export interface RunOnceOptions extends ComposeDeps, LifecycleSeams {
	/** Path to the YAML config. Defaults to `config/repos.yml`. */
	configPath?: string;
	/** Result sink; defaults to a compact stdout line. */
	onResult?: (result: PassResult) => void;
	/** Error sink; defaults to a compact stderr line. */
	onError?: (error: unknown) => void;
	/** Collab share root override for tests/nonstandard mounts. */
	collabRoot?: string;
	/**
	 * Watcher-owned work root for verified change snapshots and publish scratch.
	 * Defaults to `defaultChangeWorkRoot()`; MUST be outside the collab
	 * share so a runner cannot rewrite a snapshot between verification and push.
	 */
	changeWorkRoot?: string;
	/** Force shadow publication regardless of the config field (e.g. `--shadow`). */
	shadow?: boolean;
	/**
	 * Sink for the rendered shadow compare report. Invoked ONLY in shadow mode,
	 * after the pass summary; a real (non-shadow) run never calls it. Defaults to a
	 * stdout write. Injected in tests to assert a shadow run emits a report and a
	 * non-shadow run does not.
	 */
	onReport?: (rendered: string) => void;
}

/** The composed reconciler: shared deps plus the single-pass closure. */
interface ComposedService {
	db: WatcherDb;
	config: WatcherConfig;
	/** Whether publication runs in shadow (ledger-only) mode. */
	shadow: boolean;
	/**
	 * Run exactly one full cycle: reconcile items+jobs, dispatch pending jobs,
	 * reconcile runner results, then publish (or shadow-record) the queued plans.
	 * This is the identical body the scheduler drives on every tick. Its signature
	 * is `() => Promise<PassResult>` so the daemon's scheduler drives it unchanged.
	 */
	runReconcileCycle: () => Promise<PassResult>;
	/**
	 * The job ids whose intended writes the LAST completed cycle recorded to the
	 * shadow ledger (shadow mode only; empty in real mode). The one-shot path reads
	 * this after the cycle to scope the operator-facing compare report to exactly
	 * this pass's writes without changing the scheduler-facing cycle signature.
	 */
	lastShadowJobIds: () => readonly number[];
	/**
	 * Flush the observability emitter's queued traces. The daemon's `stop()` awaits
	 * this last, after the scheduler has drained, so the flush sees every trace the
	 * final pass produced. The one-shot path awaits it before returning.
	 */
	shutdownObserver: () => Promise<void>;
	/**
	 * Read the ingest observer's host-conflict tripwire. The daemon hands
	 * this to the status server so the page reports live counts; the one-shot path
	 * starts no server and never calls it.
	 */
	hostConflicts: () => HostConflictStatus;
}

/**
 * Compose the reconciler once from the shared wiring. Loads and validates config,
 * validates configured endpoints, builds the db + lazy forge registry + runner
 * transport, and returns the deps plus the single-pass closure. Credentials are
 * resolved only when a repository asks the registry for its provider, keeping a
 * missing credential isolated to that repository. Both `startService` and
 * `runOnce` call this, so the one-shot path can never drift from the daemon's
 * startup wiring.
 */
/**
 * Resolve the build-bump Kubernetes Jobs client ONCE, at composition.
 *
 * The credential lives in the operator's environment, never in config, so this is
 * a boot-time question with a boot-time answer: resolving it per cycle would
 * re-decode and re-validate the same kubeconfig every poll interval and emit the
 * same warn on every one of them.
 *
 * An absent or unusable credential is NOT a boot failure — the factory runs every
 * other rail without the image-builds cluster. One bounded warn names the reason
 * (which `resolveBuildBumpKubeconfig` constructs from fixed strings, so it carries
 * no secret) and the build pass becomes a no-op. The decoded config itself is
 * never logged.
 *
 * @returns the namespace-pinned Jobs client, or `null` when no kubeconfig is set
 */
function resolveKubeJobs(): KubeJobsClient | null {
	const kube = resolveBuildBumpKubeconfig();
	if (!kube.ok) {
		log("warn", "build_bump.kube.unavailable", { reason: kube.error });
		return null;
	}
	return createKubeJobsClient(kube.config);
}

/**
 * The cycle deps resolved ONCE at composition rather than per cycle: the k-board
 * client and the build-bump Jobs client, both from the operator's ENVIRONMENT,
 * plus the build-bump stuck-pair alert's destination, from CONFIG.
 *
 * Either client may be `null` — an absent credential disables exactly its own
 * rail and boots the rest of the factory normally — and the alert target is
 * `undefined` whenever `critical_alert` is unconfigured, the same off-by-default
 * posture (§8).
 *
 * THE TARGET IS PASSED IN, not resolved here: `bindCriticalAlert` already
 * installed it at boot and RETURNED it, and resolving it a second time would
 * give the cycle a different object than the one `defaultOnError` uses.
 *
 * @param deps - the compose seams (the k-board client reads its env and fetch from here)
 * @param criticalAlertTarget - what `bindCriticalAlert` bound at boot
 * @returns the three values, spread straight into the cycle deps
 */
function resolveEnvClients(
	deps: ComposeDeps,
	criticalAlertTarget: ReturnType<typeof bindCriticalAlert>,
) {
	const buildBump = resolveBuildBump();
	const kboardClient = resolveKboardClient(deps);
	const kubeJobs = resolveKubeJobs();
	const bumpMergeWatch = resolveBumpMergeWatch();
	return { kboardClient, kubeJobs, buildBump, bumpMergeWatch, criticalAlertTarget };
}

/**
 * Build the bump merge watch seams, or null when this watcher
 * cannot authenticate to Forgejo. Same resolution as `sopGateTrigger`; the token
 * is never logged.
 */
function resolveBumpMergeWatch(): MergeWatchDeps | null {
	const client = forgejoClientFor("build_bump.merge_watch");
	if (!client) return null;
	const refreshArgo = createArgoRefresher(process.env);
	log("info", "build_bump.merge_watch.enabled", { argo: refreshArgo !== null });
	const readPull = (pr: number) => client.getPullRequestMergeState(BUMP_RECEIPT_REPOSITORY, pr);
	return { readPull, refreshArgo, now: () => new Date() };
}

/**
 * A Forgejo client from the pinned deployment and `FORGEJO_TOKEN`, or null (with
 * `<event>.disabled` logged) when either is missing. The client supplies the
 * module's transport conventions: `Authorization: token`, a 10s timeout, and no
 * blind retry of a POST. The token is never logged.
 */
function forgejoClientFor(event: string): ReturnType<typeof createForgejoClient> | null {
	const deployment = resolveForgejoDeployment();
	const token = deployment.ok ? resolveForgejoToken() : undefined;
	if (!deployment.ok || !token?.ok) {
		const reason = deployment.ok ? "FORGEJO_TOKEN unset" : "forgejo endpoint not configured";
		log("info", `${event}.disabled`, { reason });
		return null;
	}
	return createForgejoClient(token.token, { baseUrl: deployment.config.apiUrl });
}

/**
 * Boot the service and bind the transport, shadow mode, filesystem roots, and git
 * surface every later wiring step reads.
 *
 * The two roots MUST stay distinct: the runner writes its own job directory under
 * the collab share, so a verified snapshot stored there could be rewritten by the
 * runner between verification and push — which would defeat the entire point of
 * snapshotting it. `changeWorkRoot` is therefore watcher-owned and outside the share.
 *
 * @param opts - config path, root overrides, shadow override, and the compose seams
 * @returns the booted config/db/registry plus the bound transport, mode, and roots
 * @throws when config, a packet, or a managed Forgejo deployment fails to resolve
 */
async function bootAndBindRoots(opts: {
	configPath?: string;
	collabRoot?: string;
	changeWorkRoot?: string;
	shadow?: boolean;
	deps: ComposeDeps;
}): Promise<
	Awaited<ReturnType<typeof bootService>> & {
		transport: RunnerTransport;
		shadow: boolean;
		collabRoot: string;
		changeWorkRoot: string;
		gitRunner: GitRunner;
		criticalAlertTarget: ReturnType<typeof bindCriticalAlert>;
	}
> {
	// Load config, gate every packet, and build the db + lazy forge registry.
	// A bad config, a malformed packet, or an unresolvable Forgejo deployment throws
	// here, before any credential or transport wiring exists.
	const booted = await bootService(opts.configPath ?? "config/repos.yml", opts.deps);

	// Prove the change work root is writable ONCE, at boot. Probed HERE rather
	// than inside `bootService` because this is where the EFFECTIVE root is bound: the
	// override wins over `defaultChangeWorkRoot()`, so a probe upstream of this line
	// would test a path the service does not use.
	//
	// Same reasoning as the packet gate above it: an unwritable work root is a
	// deploy-time defect, and discovering it per-ingest means a full runner run has
	// already been spent finding out. On 2026-08-02 job 715 burned two runs into
	// `EROFS: read-only file system, mkdir '/var/lib/software-factory'` — the first
	// ingest, then the infra-requeue's retry into the identical wall. Failing the boot
	// with the path and the env var named puts that in front of the operator instead.
	const changeWorkRoot = opts.changeWorkRoot ?? defaultChangeWorkRoot();
	const assertWorkRoot = opts.deps.assertChangeWorkRootWritable ?? assertChangeWorkRootWritable;
	await assertWorkRoot(process.env, { workRoot: changeWorkRoot });

	// Bind the `[monitoring-critical]` egress here, with the other
	// boot-time bindings and before any pass can fail. Absent `critical_alert`
	// binds `undefined`, which is exactly the pre-sf#699 behavior.
	//
	// CAPTURED, not just bound: the module-level binding serves `defaultOnError`,
	// a sink with no deps object, while the build-bump stuck-pair pass takes its
	// target as data through the cycle deps (§8). One resolution, two consumers —
	// inlined into the return because `lint:size` bounds this file at 500 code
	// lines, and the call's side effect is unchanged by where its value is named.
	return {
		...booted,
		criticalAlertTarget: bindCriticalAlert(booted),
		transport: opts.deps.transport ?? createRunnerTransport(),
		// The `--shadow` override wins over the config field so a one-shot run can
		// force shadow publication without editing config.
		shadow: opts.shadow ?? booted.config.shadow_publish,
		// The collab share root the result reader AND the dedicated infra-static
		// exact-SHA lane's job.md landing both resolve to. Bound once here so the
		// landed contract lands under the same share the runner mounts.
		collabRoot: opts.collabRoot ?? defaultCollabRoot(),
		changeWorkRoot,
		gitRunner: opts.deps.git ?? createGitRunner(),
	};
}

async function composeService(opts: {
	configPath?: string;
	collabRoot?: string;
	/** Watcher-owned root for verified snapshots and publish scratch. */
	changeWorkRoot?: string;
	shadow?: boolean;
	/**
	 * True when the NATS bus connected. The `bus_results` reader is
	 * built HERE rather than passed in, because it needs the database this
	 * function creates. Set, the reconciler reads `bus_results` BEFORE the share;
	 * unset, the share is the only source — what every deployment had before the
	 * bus existed, and what `runOnce` still gets.
	 */
	busEnabled?: boolean;
	onError: (error: unknown) => void;
	deps: ComposeDeps;
}): Promise<ComposedService> {
	// Boot (config + packet gate + db + registry), then bind the transport, the
	// shadow mode, the two filesystem roots, and the git surface.
	const base = await bootAndBindRoots(opts);
	const { config, criticalAlertTarget, db, registry, shadow } = base;
	const onError = (error: unknown) => opts.onError(error);
	// Every watcher-owned lookup the wiring below depends on. All of them read
	// CONFIG (plus the operator's environment for credentials) and never runner
	// output — that is what decides where a verified branch is pushed and which
	// runner-named labels are honoured.
	const resolvers = createServiceResolvers(config, registry, base.forgejoDeployment, opts.deps);

	// The ingest boundary, the publication boundary, the body-landing seam, and the
	// proposal pass's wiring — every one of them built from the resolvers above, so
	// none of them can disagree about which provider or credential owns a repository.
	const wiring = createIngestAndPublish({
		...resolvers,
		db,
		config,
		registry,
		shadow,
		collabRoot: base.collabRoot,
		changeWorkRoot: base.changeWorkRoot,
		shareRootOverride: opts.collabRoot,
		...(opts.busEnabled === true ? { busReader: new BusResultReader(db) } : {}),
		git: base.gitRunner,
		railsManifestPath: opts.deps.railsManifestPath,
		onError,
	});

	// The reconcile CYCLE. Its step ORDER is load-bearing and lives as one intact
	// block in `./service-cycle`, which documents why each step sits where it does.
	const cycle = createReconcileCycle({
		...wiring,
		db,
		config,
		registry,
		shadow,
		transport: base.transport,
		// sf#439: the operator's process environment owns the dispatch cap.
		maxDispatchPerPass: parseMaxDispatchPerPass(process.env),
		clientFor: resolvers.clientFor,
		// The two credential-bearing clients and the stuck-pair alert's destination,
		// all resolved once at composition rather than per cycle.
		...resolveEnvClients(opts.deps, criticalAlertTarget),
		infraGateSelector: createInfraGateSelector(config, registry),
		onError,
	});

	return {
		db,
		config,
		shadow,
		runReconcileCycle: cycle.run,
		lastShadowJobIds: cycle.lastShadowJobIds,
		shutdownObserver: wiring.shutdownObserver,
		hostConflicts: wiring.hostConflicts,
	};
}

/**
 * Emit one structured log event per failed repository.
 *
 * Complements the stdout summary above: the summary is the operator's one-line
 * read, this is the greppable record with the repository as its own field, on the
 * same `log()` format everything else in this service uses. A repository that
 * fails every pass produces one line per pass — which is the point, because the
 * silence was the defect.
 */
export function logRepoFailures(result: PassResult): void {
	for (const repo of result.repositories) {
		if (repo.error === undefined || repo.error === "") continue;
		// `cause` is already bounded and secret-free where `runPass` captured it; it
		// is the same value the summary line prints.
		log("warn", "reconcile.pass.repo_failed", { repository: repo.repository, cause: repo.error });
	}
}

/**
 * Start the watcher service. Loads config, wires dependencies, and starts the
 * scheduler (which runs one pass immediately). Throws with a bounded message
 * if config or credentials are unavailable.
 *
 * @param opts - overrides for config path and result/error sinks
 */
/**
 * Unwind a failed daemon startup: stop the already-bound status listener, close
 * the bus, then drain the scheduler back to a quiescent state — mirroring
 * `stop()`'s order exactly.
 *
 * The bus close belongs HERE rather than at the call site.
 * It used to run before this function, which made the failed-boot order
 * bus → HTTP stop → drain while `stopService` declared HTTP stop → bus → drain.
 * That inversion closed the side channel while the listener was still accepting
 * doorbells and an in-flight delivery could still be mid-publish. One ordered
 * unwind, one place that owns the order.
 *
 * The caller's original startup error is AUTHORITATIVE, so every failure here is
 * logged at debug and swallowed: a fault while cleaning up must not mask the error
 * that actually explains the failed boot. Neither step is retried, so no
 * double-stop or listener leak survives.
 *
 * The observability flush is LAST, exactly as in `stop()`. `scheduler.start()`
 * runs a pass immediately, so a startup that throws AFTER that pass has already
 * ingested attempts leaves traces sitting in the SDK's ~10s batching window —
 * and the process is about to die on the rethrown error, so nothing else will
 * ever flush them. The failed boot is the run most worth having a trace of (PR
 * #176 review round 2). Ordered last for the same reason `stop()` orders it
 * last: the scheduler drain can queue the final traces, and flushing before the
 * drain would miss exactly those.
 *
 * @param statusServer - the already-bound status listener to stop
 * @param sideChannels - the results consumer handle and the connected bus (or
 *   undefined when disabled), stopped in that order
 * @param scheduler - the scheduler to drain
 * @param shutdownObserver - the observability flush; never throws by contract,
 *   and is awaited anyway inside the same swallow-and-log posture as the rest
 */
async function unwindFailedStartup(
	statusServer: { stop: () => Promise<unknown> },
	sideChannels: { resultsConsumer: ResultsConsumerHandle; bus: NatsBus | undefined },
	scheduler: Scheduler,
	shutdownObserver: () => Promise<void>,
): Promise<void> {
	try {
		await statusServer.stop();
	} catch (err) {
		// Cleanup failure must not replace the authoritative startup error — debug,
		// because startup already fails loudly by rethrowing it.
		log("debug", "service.startup_cleanup.status_server_stop_failed", {
			cause: errorMessage(err),
		});
	}
	// After the listener, before the drain — the same positions they hold in
	// `stopService`: the consumer first, because its fetch rides the bus
	// connection. Both helpers swallow their own failures.
	await stopResultsConsumer(sideChannels.resultsConsumer);
	await closeBus(sideChannels.bus);
	try {
		await scheduler.stop();
	} catch (err) {
		// The scheduler drain (which also resets its lifecycle) may surface the same
		// or a related failure; the original startup error still wins. Debug, because
		// that authoritative error is rethrown by the caller.
		log("debug", "service.startup_cleanup.scheduler_stop_failed", {
			cause: errorMessage(err),
		});
	}
	try {
		// LAST, after the drain. `AttemptObserver.shutdown` never throws, but this
		// path must survive ANY flush seam a caller injects, and the authoritative
		// startup error still wins over anything raised here.
		await shutdownObserver();
	} catch (err) {
		log("debug", "service.startup_cleanup.observer_shutdown_failed", {
			cause: errorMessage(err),
		});
	}
}

/** The scheduler's sinks; `followThrough` arms one deferred pass. */
type Sinks = Required<Pick<SchedulerOptions, "onResult" | "onError">> & Partial<SchedulerOptions>;

/**
 * Build the scheduler's options, including the pass-liveness wiring.
 *
 * Extracted from `startService` so the liveness seam is readable as one unit:
 * the loop stamps `recordStart` BEFORE each pass body and `recordCompletion`
 * after, and those two calls together are what make `/healthz` answer "is the
 * loop turning" independently of whether any repository had work.
 *
 * The tracker this builds against is the SAME object `startService` hands the
 * status server, and it is handed there as a READER (`() => status()`) rather
 * than a value — for the same reason the #190 host-conflict tally is. A value
 * read at bind time pins the count at 0 and `lastPassStartedAt` at null forever,
 * so every probe would report the watcher permanently wedged no matter how many
 * passes ran.
 *
 * @param config - the loaded config, for its `poll_interval_minutes` cadence
 * @param run - the pass body the scheduler drives
 * @param passLiveness - the record stamped before and after every pass
 * @param sinks - the caller's own sinks. `onResult` is invoked AFTER the
 *   liveness record is updated, so a throwing sink cannot cost the record;
 *   `onError` is passed through unchanged.
 */
function schedulerWiring(
	config: WatcherConfig,
	run: () => Promise<PassResult>,
	passLiveness: PassLivenessTracker,
	sinks: Sinks,
): ConstructorParameters<typeof Scheduler>[0] {
	// Seeded per pass, never around the scheduler: a timer created in a scope keeps it.
	const pass = passScoped(run);
	return {
		intervalMinutes: config.poll_interval_minutes,
		run: pass.run,
		// Stamped BEFORE the pass body: a pass that starts and dies still moves
		// `lastPassStartedAt`, because the claim is that the LOOP is turning, not
		// that the work succeeded. This is what makes liveness independent of the
		// per-repository cursors, which a healthy but idle watcher never advances.
		onPassStart: () => passLiveness.recordStart(),
		onResult: (result) =>
			withLogFields(pass.fields(), () => {
				// Record BEFORE the caller's sink so a throwing sink cannot cost the
				// liveness record — the same untrusted-sink posture the scheduler applies.
				passLiveness.recordCompletion(result);
				// Name the repositories behind `failCount`; the summary line and
				// this event carry the same bounded values `runPass` captured.
				logRepoFailures(result);
				sinks.onResult(result);
			}),
		onError: sinks.onError,
		followThrough: sinks.followThrough,
	};
}

/**
 * Build the status server's options.
 *
 * Extracted from `startService` alongside `schedulerWiring` so the two halves of
 * the observability seam sit next to each other: the scheduler WRITES the
 * process-local records, and this is where they are handed to the surface that
 * READS them.
 *
 * Both `hostConflicts` and `passLiveness` cross as READER
 * functions, never as values. A value read here — at bind time, before any pass
 * has run — pins the conflict count at 0 and `lastPassStartedAt` at null for the
 * life of the process, so every `/healthz` probe would report the watcher
 * permanently wedged no matter how many passes completed.
 *
 * The Forgejo webhook mount is switched by ONE thing: the presence of
 * `FORGE_WEBHOOK_SECRET` in the environment. With it, the server binds `0.0.0.0`
 * (the forge posts from another host) and `POST /hooks/forgejo` is mounted with
 * the scheduler's coalescing trigger as its wake — the same trigger the doorbell
 * and the periodic sweep share, so a delivery creates no second dispatch path.
 * Without it, neither field is set and the server keeps its loopback-only bind,
 * which is the right posture for a watcher nobody has pointed a forge at. Read
 * from the environment rather than the YAML because it is a secret, and the
 * decision is logged at boot either way so an operator can tell a disabled hook
 * from a broken one without reading the config back.
 *
 * @param args - the db, loaded config, the scheduler the doorbell and webhook
 *   wake, the two process-local readers, the port, and the shutdown gate
 */

/**
 * Build the SOP gate trigger, or undefined when this watcher cannot
 * authenticate to Forgejo. Undefined leaves the receiver's behavior EXACTLY what
 * it was before the gate existed — a watcher with no token neither posts a
 * pending status nor dispatches a workflow, rather than failing at delivery time.
 *
 * The endpoint is the pinned deployment (`forgejo/config.ts`) and the token comes
 * from `FORGEJO_TOKEN` only; neither is ever logged.
 */
function sopGateTrigger(repos: WatcherConfig["repositories"], db: WatcherDb) {
	const client = forgejoClientFor("hooks.sop_gate");
	if (!client) return undefined;
	log("info", "hooks.sop_gate.enabled", {});
	// sf#827 infra-static and sf#476 pr-review (recorded in forge_runs) dispatches too.
	return createHookTrigger(client.write.bind(client), client.get.bind(client), repos, db);
}

function statusServerWiring(args: {
	db: WatcherDb;
	config: WatcherConfig;
	scheduler: Scheduler;
	hostConflicts: () => HostConflictStatus;
	passLiveness: PassLivenessTracker;
	port: number;
	accepting: () => boolean;
	bus: NatsBus | undefined;
}): Parameters<typeof startStatusServer>[0] {
	// Trimmed, because an env file's trailing newline would otherwise be part of
	// the HMAC key and break every signature with no visible cause. Never logged,
	// not even its length — a length is a real narrowing hint for an attacker.
	const webhookSecret = process.env.FORGE_WEBHOOK_SECRET?.trim() || undefined;
	if (webhookSecret === undefined) {
		log("info", "hooks.forgejo.disabled", { reason: "FORGE_WEBHOOK_SECRET unset" });
	} else {
		log("info", "hooks.forgejo.enabled", { hostname: "0.0.0.0", path: "/hooks/forgejo" });
	}
	return {
		db: args.db,
		pollIntervalMinutes: args.config.poll_interval_minutes,
		// The bundle deploy stamps the exact source revision once at process start.
		// The status handler carries this value verbatim; it never tries to infer a
		// revision from the deployed filesystem, which is deliberately not a clone.
		commit: process.env.SOFTWARE_FACTORY_COMMIT?.trim() || undefined,
		hostConflicts: args.hostConflicts,
		passLiveness: () => args.passLiveness.status(),
		port: args.port,
		// The off-loopback /metrics scrapers; validated at config load.
		metricsScrapeAllow: args.config.metrics_scrape_allow,
		accepting: args.accepting,
		// The Langfuse base URL for the page's trace links. Read from the
		// process environment rather than the watcher config file, because it is
		// the SAME variable the emitter already resolves — a second spelling in
		// YAML would let the page link to one Langfuse while traces land in
		// another. Read directly rather than through `loadLangfuseSettings`, which
		// returns null unless the two KEYS are also present: the page needs only
		// the host, and a watcher with a base URL and no keys still has trace ids
		// worth linking. Absent leaves the ids as plain text.
		langfuseBaseUrl: process.env.LANGFUSE_BASE_URL,
		// The build-bump lane's `/status.json` view (§8). FILTERED to the enrolled
		// entries rather than passed whole: an unenrolled repository contributes
		// nothing to the view either way, and narrowing here keeps the argument
		// naming exactly what it carries. `BuildBumpRepositoryConfig` is
		// structural, so the config entries pass as they are.
		buildBumpRepositories: args.config.repositories.filter((repo) => repo.build_bump !== undefined),
		// When enabled, the identifiers-only doorbell wakes an early pass by
		// coalescing onto the same authoritative single-flight scheduler the
		// periodic sweep uses. It never runs its own pass or dispatch. The wake
		// receives the validated ring, but the authoritative pass already sweeps
		// every configured repository, so it subsumes the ring's target and the
		// identifiers are intentionally not used to build a second targeted path.
		doorbell: args.config.doorbell_enabled
			? { config: args.config, wake: (_ring) => args.scheduler.trigger() }
			: undefined,
		// The webhook needs an off-machine bind; the doorbell keeps its loopback-only
		// property by remote address rather than by the bind (see status/server.ts).
		hostname: webhookSecret === undefined ? undefined : "0.0.0.0",
		forgeHook:
			webhookSecret === undefined
				? undefined
				: {
						secret: webhookSecret,
						db: args.db,
						config: args.config,
						// The same coalescing trigger the doorbell rings: a delivery only asks
						// for an earlier pass, and reconciliation re-reads the forge itself.
						wake: () => args.scheduler.trigger(),
						// Republishes a NEW delivery onto the bus. Undefined when
						// the bus is disabled or failed to connect, which leaves the
						// receiver's behavior exactly what it was before.
						bus: args.bus,
						// Marks the head commit pending and dispatches the SOP gate workflow
						// for a NEW pull-request delivery on the one gated repository.
						// Undefined when no Forgejo token resolves.
						sopGate: sopGateTrigger(args.config.repositories, args.db),
					},
	};
}

export async function startService(opts: StartServiceOptions = {}): Promise<ServiceHandle> {
	// The bus is connected BEFORE the composition, because the ingest wiring is
	// built with the bus-backed artifact reader and a reader cannot be injected
	// after the reconciler exists. A failure here is logged and yields undefined —
	// the share path and the webhook receiver must both keep working with the
	// cluster unreachable. The injected seam exists for shutdown-order tests;
	// the env path is production.
	const bus = opts.bus ?? (await createBusFromEnv());

	// EVERY stage after the connect is guarded. Cleanup used to
	// exist only in the `scheduler.start()` catch, so a throw in composition, the
	// consumer start, or the status bind left the bus connected — and with
	// `maxReconnectAttempts: -1` its reconnect loop keeps the PROCESS ALIVE after
	// `startService` has rejected, which reads as a hang rather than a failed boot.
	// The original error is rethrown: cleanup never replaces it. Once the listener
	// binds, `unwindFailedStartup` owns the same teardown in listener-first order,
	// so `started.owned` clears and nothing is closed twice.
	const started: StartedSideChannels = { resultsConsumer: undefined, owned: true };
	try {
		return await startServiceStages(opts, bus, started);
	} catch (err) {
		if (started.owned) {
			await stopResultsConsumer(started.resultsConsumer);
			await closeBus(bus);
		}
		throw err;
	}
}

/**
 * The composition the daemon and `reconcile once` share, with the daemon's
 * arguments applied.
 *
 * @param opts - the caller's options
 * @param bus - the connected bus, or undefined when disabled
 * @param onError - the error sink the wiring reports through
 */
function composeDaemon(
	opts: StartServiceOptions,
	bus: NatsBus | undefined,
	onError: (error: unknown) => void,
): ReturnType<typeof composeService> {
	return composeService({
		configPath: opts.configPath,
		collabRoot: opts.collabRoot,
		changeWorkRoot: opts.changeWorkRoot,
		busEnabled: bus !== undefined,
		onError,
		deps: opts,
	});
}

/**
 * Start the scheduler, unwinding the already-bound listener if it rejects.
 *
 * Separate from `startServiceStages` because the failure here is the ONE that
 * has a bound HTTP listener to take down: the status server is already
 * accepting doorbells, so the ordered unwind (listener, then side channels,
 * then drain) is the only correct teardown and the outer F3 guard deliberately
 * does not run for it.
 *
 * @param scheduler - the scheduler to start
 * @param statusServer - the already-bound listener the unwind stops first
 * @param shutdownObserver - the observability flush the unwind runs last
 * @param args - the side channels to stop, and the gate to close on failure
 */
async function startSchedulerOrUnwind(
	scheduler: Scheduler,
	statusServer: { stop: () => Promise<unknown> },
	shutdownObserver: () => Promise<void>,
	args: {
		resultsConsumer: ResultsConsumerHandle;
		bus: NatsBus | undefined;
		onFailure: () => void;
	},
): Promise<void> {
	try {
		await scheduler.start();
	} catch (startupError) {
		args.onFailure();
		// The side-channel shutdown lives INSIDE the unwind so both shutdown paths
		// share one order; closing the bus here would put it
		// ahead of the HTTP stop.
		await unwindFailedStartup(
			statusServer,
			{ resultsConsumer: args.resultsConsumer, bus: args.bus },
			scheduler,
			shutdownObserver,
		);
		throw startupError;
	}
}

/**
 * Construct the interval scheduler and the pass-liveness tracker it stamps.
 *
 * Extracted from `startServiceStages` only to keep that function under the
 * size lint once the F3 guard moved its body there; the pairing is meaningful
 * on its own, because the tracker handed to the status server MUST be the same
 * object this scheduler stamps.
 *
 * @param opts - the caller's options, for the seams
 * @param config - the loaded config, for its poll cadence
 * @param run - the pass body the scheduler drives
 * @param sinks - the result and error sinks
 */
function buildScheduler(
	opts: StartServiceOptions,
	config: WatcherConfig,
	run: () => Promise<PassResult>,
	sinks: Sinks,
): { scheduler: Scheduler; passLiveness: PassLivenessTracker } {
	const makeScheduler = opts.createScheduler ?? ((o) => new Scheduler(o));
	const passLiveness = opts.passLiveness ?? new PassLivenessTracker();
	return {
		scheduler: makeScheduler(schedulerWiring(config, run, passLiveness, sinks)),
		passLiveness,
	};
}

/**
 * What the startup guard is still holding, and whether it still owns it.
 *
 * `owned` flips false the moment a later path (`unwindFailedStartup`) takes over
 * the same teardown, which is what keeps a failed boot from closing the bus
 * twice.
 */
interface StartedSideChannels {
	resultsConsumer: ResultsConsumerHandle;
	owned: boolean;
}

/**
 * Every startup stage after the bus connect, so the guard in `startService` can
 * wrap them as one unit.
 *
 * Extracted rather than inlined because the guard has to span composition,
 * scheduler construction, the consumer start, AND the status bind — a try block
 * around all of that inside `startService` puts the function over the size lint
 * and buries the ordering the comments exist to explain.
 *
 * @param opts - the caller's options
 * @param bus - the already-connected bus, or undefined when disabled
 * @param started - the guard's record of what this function has started
 */
async function startServiceStages(
	opts: StartServiceOptions,
	bus: NatsBus | undefined,
	started: StartedSideChannels,
): Promise<ServiceHandle> {
	const onError = opts.onError ?? defaultOnError;
	const { db, config, runReconcileCycle, shutdownObserver, hostConflicts } = await composeDaemon(
		opts,
		bus,
		onError,
	);
	// sf#1076 row 0c: while the build-bump rail is in flight — or a large OOM
	// re-run is still waiting for its slot — re-pass 20 s out.
	const { scheduler, passLiveness } = buildScheduler(opts, config, runReconcileCycle, {
		onResult: opts.onResult ?? logPassResult,
		onError,
		followThrough: followThroughSink(db, process.env),
	});

	// Shutdown gate: flips false the instant stop() begins, before the scheduler
	// is stopped and drained. The status server checks this before accepting a
	// doorbell, so no caller receives an accepted 202 whose wake has already
	// become a no-op — the acknowledgement never outlives the work it promises.
	let accepting = true;

	// The durable pull consumer draining runner artifacts into `bus_results`.
	// AFTER the database is ready: every message it accepts is an
	// insert. A start failure is not fatal — see `startResultsConsumerOrNone`.
	// A fresh row rings the scheduler's coalescing trigger, the doorbell's
	// wake, so a result is reconciled next pass, not up to `poll_interval_minutes` later.
	started.resultsConsumer = await startResultsConsumerOrNone(bus, db, scheduler);

	const statusServer = bindStatusServer(opts.startStatusServer ?? startStatusServer, {
		db,
		config,
		scheduler,
		hostConflicts,
		passLiveness,
		port: opts.statusPort ?? 8787,
		accepting: () => accepting,
		bus,
	});
	// The listener is bound, so the ordered unwind below owns the teardown from
	// here on: it stops the HTTP listener FIRST, which the outer guard cannot do.
	started.owned = false;

	await startSchedulerOrUnwind(scheduler, statusServer, shutdownObserver, {
		resultsConsumer: started.resultsConsumer,
		bus,
		onFailure: () => {
			accepting = false;
		},
	});
	return {
		stop: async () => {
			accepting = false;
			await stopService(
				statusServer,
				{ resultsConsumer: started.resultsConsumer, bus },
				scheduler,
				shutdownObserver,
			);
		},
		scheduler,
	};
}

/**
 * Bind the status server and announce its address on stdout.
 *
 * The announcement belongs with the bind rather than at the call site, because
 * the address is only known once the listener is up.
 *
 * @param serveStatus - the (possibly injected) status-server factory
 * @param args - everything `statusServerWiring` needs, including the bus
 */
function bindStatusServer(
	serveStatus: typeof startStatusServer,
	args: Parameters<typeof statusServerWiring>[0],
): ReturnType<typeof startStatusServer> {
	const statusServer = serveStatus(statusServerWiring(args));
	log("info", "service.status_page", {
		url: `http://${statusServer.hostname}:${statusServer.port}/`,
	});
	return statusServer;
}

/**
 * The daemon's ordered shutdown.
 *
 * ORDER MATTERS, and each step is here for a reason:
 *   0. the CALLER flips the accepting gate false before calling this — the
 *      handler rechecks it immediately before waking, so a request that began
 *      before shutdown cannot return a late 202 whose wake is already a no-op.
 *   1. stop the HTTP listener.
 *   2. close the bus, after the listener so no in-flight delivery is mid-publish
 *      and before the drain, since draining flushes what is still queued.
 *   3. stop and drain the scheduler.
 *   4. flush observability LAST — the final pass may have queued traces the SDK
 *      is still batching (~10s window), and flushing before the drain would miss
 *      exactly those. Never throws; see `AttemptObserver.shutdown`.
 *
 * @param statusServer - the bound HTTP listener
 * @param bus - the connected bus, or undefined when disabled
 * @param scheduler - the reconciliation scheduler to stop and drain
 * @param shutdownObserver - the observability flush
 */
async function stopService(
	statusServer: { stop: () => Promise<void> },
	sideChannels: { resultsConsumer: ResultsConsumerHandle; bus: NatsBus | undefined },
	scheduler: Scheduler,
	shutdownObserver: () => Promise<void>,
): Promise<void> {
	const { resultsConsumer, bus } = sideChannels;
	await statusServer.stop();
	// Before the bus closes: the loop holds a fetch on that very connection, and
	// draining underneath it would surface as a fetch error rather than a stop.
	await stopResultsConsumer(resultsConsumer);
	await closeBus(bus);
	await scheduler.stop();
	await shutdownObserver();
}

/**
 * Run exactly ONE reconciliation cycle (pass + dispatch + result reconcile +
 * publication) and then return — starting NEITHER the status server NOR the
 * interval scheduler. It reuses the same `composeService` wiring the daemon uses,
 * so the one-shot path can never drift from `startService`; the sole difference
 * is it invokes the shared cycle once directly instead of scheduling it.
 *
 * Config path handling matches `watch` (defaults to `config/repos.yml`). Pass
 * `shadow: true` (the `--shadow` flag) to force shadow publication regardless of
 * the config's `shadow_publish` field.
 *
 * @param opts - config path, sinks, collab-root, shadow override, and test seams
 * @returns the single pass result (also delivered to `onResult`)
 */
export async function runOnce(opts: RunOnceOptions = {}): Promise<PassResult> {
	const onResult = opts.onResult ?? logPassResult;
	const onError = opts.onError ?? defaultOnError;

	const composed = await composeService({
		configPath: opts.configPath,
		collabRoot: opts.collabRoot,
		changeWorkRoot: opts.changeWorkRoot,
		shadow: opts.shadow,
		onError,
		deps: opts,
	});

	// Exactly one cycle; no server, no interval. A cycle-level throw propagates to
	// the caller (the CLI maps it to a non-zero exit) rather than being swallowed.
	const pass = passScoped(composed.runReconcileCycle);
	const result = await pass.run();
	withLogFields(pass.fields(), () => onResult(result));

	// In shadow mode, surface the operator-facing compare report: the intended
	// labels/comments/checks this pass recorded to the ledger, scoped to exactly
	// the jobs it touched. This is the whole point of `--shadow` — the operator
	// sees the intended writes before going live. A real run emits NO report, so a
	// non-shadow one-shot can never print a compare block. The builder is bounded
	// on every axis (rows scanned, distinct items) and surfaces its own truncation
	// flags, so a large ledger can never produce an unbounded report.
	if (composed.shadow) {
		const onReport = opts.onReport ?? ((rendered: string) => process.stdout.write(`${rendered}\n`));
		const report = await buildShadowReportForJobs(composed.db, composed.lastShadowJobIds());
		onReport(renderShadowReport(report));
	}
	// The one-shot path exits the process immediately after returning, so the SDK's
	// batching timer never fires: without this flush a `reconcile once` emitted
	// nothing at all. Never throws.
	await composed.shutdownObserver();
	return result;
}
