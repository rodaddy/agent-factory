/**
 * @module service-ingest
 * @description The INGEST and PUBLICATION boundaries, split out of `service.ts` so
 *   the composition root stays at the size ceiling.
 *
 *   These two objects are built together because they share the triage allowlist
 *   resolver, and that sharing is the point: the result store filters runner-named
 *   labels against the repository's live config allowlist at plan-creation time,
 *  and the publisher RE-validates the stored plan against the same live
 *   resolver at publish time. Wiring them from one place is what keeps those
 *   two checks reading the same answer.
 *
 * @outputs
 *   - `IngestAndPublishInputs` -- the already-resolved collaborators the wiring needs
 *   - `IngestAndPublish` -- the reconciler, publisher, and body-landing seam
 *   - `createIngestAndPublish` -- build all three
 *
 * @dependencies
 *   - ./github/publish -- the bounded publication boundary
 *   - ./results/change-verifier -- the fail-closed change verification
 *   - ./results/reconcile -- the result ingest boundary
 */
import type { WatcherConfig } from "./config/schema";
import type { WatcherDb } from "./db/client";
import type { ForgeClient } from "./forge/boundary";
import type { ForgeRegistry } from "./forge/registry";
import { GitHubPublisher } from "./github/publish";
import { AttemptObserver } from "./observability/attempt-observer";
import { type HostConflictStatus, HostConflictTally } from "./observability/host-conflicts";
import { createLangfuseEmitter, loadLangfuseSettings } from "./observability/langfuse";
import { LocalBodyLandingStager } from "./prepush/stage";
import type { ArtifactReader } from "./results/artifact-reader";
import type { GitRunner } from "./results/branch-publisher";
import { ShareChangeVerifier } from "./results/change-verifier";
import { CompositeResultReader } from "./results/composite-reader";
import type { IngestObserver } from "./results/ingest";
import type { ProposalPassDeps } from "./results/proposal-pass";
import { defaultCollabRoot, ResultReconciler } from "./results/reconcile";
import { ShareResultReader } from "./results/share-reader";
import { createProposalDeps } from "./service-proposal-deps";

/** The already-resolved collaborators the ingest/publish wiring is built from. */
export interface IngestAndPublishInputs {
	db: WatcherDb;
	config: WatcherConfig;
	registry: ForgeRegistry;
	/** Whether publication runs in shadow (ledger-only) mode. */
	shadow: boolean;
	/** The resolved collab share root the runner writes its job directory under. */
	collabRoot: string;
	/** Watcher-owned root for verified snapshots; MUST be outside the share. */
	changeWorkRoot: string;
	/** The caller's raw share-root override, preserved for the result reader. */
	shareRootOverride: string | undefined;
	/**
	 * The NATS-fed `bus_results` reader, when the bus is connected.
	 *
	 * Present makes the reconciler read the BUS FIRST and the share second, so a
	 * runner that publishes and a runner that still writes to the share both
	 * reconcile through one unchanged reconciler. Absent — bus disabled, or its
	 * connect failed — leaves the share as the only source, which is the behavior
	 * every existing deployment already has.
	 */
	busReader?: ArtifactReader;
	git: GitRunner;
	remoteFor: (repository: string) => string | null;
	credentialFor: (repository: string) => Promise<string | null>;
	railsManifestPath?: string;
	triageAllowlistFor: (repository: string, jobType: string) => readonly string[];
	clientFor: (repository: string) => Promise<ForgeClient | null>;
	onError: (error: unknown) => void;
}

/** The ingest/publication boundaries, the body-landing seam, and proposal wiring. */
export interface IngestAndPublish {
	resultReconciler: ResultReconciler;
	publisher: GitHubPublisher;
	bodyLandingStager: LocalBodyLandingStager;
	proposalDeps: ProposalPassDeps;
	/**
	 * Flush the observability emitter. The service's stop path awaits this before
	 * the process exits; nothing on the hot path calls it. Returned here because
	 * this is where the emitter is constructed — without a seam out, the SDK's
	 * batching window silently dropped every queued trace on each restart.
	 */
	shutdownObserver: () => Promise<void>;
	/**
	 * Read the ingest observer's host-conflict tripwire. The status server
	 * calls this per request so the page shows the live count, the last-seen
	 * attempt id, and the host/model pairs of the most recent conflict. Returned
	 * from here because this is where the observer — and therefore the tally — is
	 * constructed.
	 */
	hostConflicts: () => HostConflictStatus;
	/**
	 * The ingest observer this wiring installed on the reconciler.
	 *
	 * Returned so the PRODUCTION SEAM is assertable: `hostConflicts` above reads a
	 * tally, and without a handle on the observer that records into it, a test can
	 * only ever prove the two halves separately. Swapping the shared tally for a
	 * fresh `new HostConflictTally()` at the construction site then survives a full
	 * green suite (verified by mutation, PR #208 review) because every other test
	 * builds its own observer/tally pair. With this handle a test drives THIS
	 * observer and reads THIS reader, so the two must be the same object.
	 */
	observer: IngestObserver;
}

/**
 * The artifact source the reconciler reads, or undefined for the default share.
 *
 * With a bus reader the two sources are COMPOSED in a fixed order — bus first,
 * share second — rather than swapped: a runner that publishes to NATS and a
 * runner that still writes to the share must both reconcile through one
 * unchanged reconciler while the fleet is mid-migration. Undefined leaves the
 * reconciler on its own share reader, which is what it has always done.
 *
 * `shareRoot` stays set on the reconciler either way, because its wrapper /
 * envelope side channel deliberately keeps reading the share directly.
 *
 * @param inputs - the ingest wiring inputs, for the bus reader and share root
 */
function artifactReaderFor(inputs: IngestAndPublishInputs): ArtifactReader | undefined {
	if (inputs.busReader === undefined) return undefined;
	return new CompositeResultReader({
		first: inputs.busReader,
		second: new ShareResultReader(inputs.shareRootOverride ?? defaultCollabRoot()),
	});
}

/**
 * Build the result ingest boundary, the publication boundary, and the body-only
 * landing seam.
 *
 * @param inputs - the already-resolved watcher-owned collaborators
 * @returns the reconciler, the publisher, and the body-landing stager
 */
export function createIngestAndPublish(inputs: IngestAndPublishInputs): IngestAndPublish {
	// Observability. `loadLangfuseSettings` returns null when any of the
	// three optional env vars is absent, which DISABLES trace emission and logs one
	// boot line. The observer is still installed in that case: stamping the attested
	// model on the attempt row is a write against the watcher's own database and has
	// nothing to do with whether a trace sink exists. Nothing this seam does can
	// fail, slow, or alter an ingest — see `observability/attempt-observer`.
	// The host-conflict tripwire is built HERE and handed to the observer, so
	// the object the status page reads is the very object the warn path records
	// into. Both live in this one process — `composeService` builds this wiring and
	// then binds the status server (src/service.ts) — which is what makes a
	// process-local tally reachable from the page at all.
	const hostConflicts = new HostConflictTally();
	const observer = new AttemptObserver(
		inputs.db,
		createLangfuseEmitter(loadLangfuseSettings()),
		undefined,
		hostConflicts,
	);

	const reader = artifactReaderFor(inputs);

	const resultReconciler = new ResultReconciler(inputs.db, {
		shareRoot: inputs.shareRootOverride,
		...(reader === undefined ? {} : { reader }),
		onError: inputs.onError,
		triageAllowlistFor: inputs.triageAllowlistFor,
		observer,
		// Without this, a result claiming a change is refused at ingest (fail-closed),
		// so the implement lane is inert rather than silently accepting unproven work.
		changeVerifier: new ShareChangeVerifier({
			db: inputs.db,
			paths: { shareRoot: inputs.collabRoot, workRoot: inputs.changeWorkRoot },
			remoteFor: inputs.remoteFor,
			git: inputs.git,
			credentialFor: inputs.credentialFor,
		}),
	});

	// The body-only landing seam the dedicated infra-static lane uses to land its
	// digest-bound job.md (no candidate bundle — the foreign-repo exact commit is
	// fetched inside the landed contract). Every other job type ignores it.
	const bodyLandingStager = new LocalBodyLandingStager(inputs.collabRoot);

	const publisher = new GitHubPublisher(inputs.db, inputs.registry, {
		shadow: inputs.shadow,
		onError: inputs.onError,
		// Re-validate a stored triage add-label plan against the repository's LIVE
		// config allowlist at publish time, using the same trusted resolver the
		// result store filters with at plan-creation time. Without it a triage
		// label plan fails its decode closed and never posts.
		triageAllowlistFor: inputs.triageAllowlistFor,
	});

	// The proposal pass's wiring. Every value is watcher-owned; nothing a
	// runner returned decides what is pushed or where.
	const proposalDeps = createProposalDeps({
		db: inputs.db,
		config: inputs.config,
		git: inputs.git,
		changeWorkRoot: inputs.changeWorkRoot,
		clientFor: inputs.clientFor,
		remoteFor: inputs.remoteFor,
		credentialFor: inputs.credentialFor,
		railsManifestPath: inputs.railsManifestPath,
		onError: inputs.onError,
	});

	return {
		resultReconciler,
		publisher,
		bodyLandingStager,
		proposalDeps,
		shutdownObserver: () => observer.shutdown(),
		hostConflicts: () => hostConflicts.status(),
		observer,
	};
}
