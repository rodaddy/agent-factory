/**
 * @module service-proposal-deps
 * @description The proposal pass's wiring, split out of `service.ts` so the
 *   composition root stays at the size ceiling.
 *
 *   Every value built here is WATCHER-OWNED: the candidates come from the trusted
 *   DB join, the remote from config, the branch from the item number, and the
 *   credential from the operator's environment. Nothing a runner returned decides
 *   what is pushed or where — that is the property this module exists to keep
 *   legible in one place.
 *
 * @outputs
 *   - `ProposalDepsInputs` -- the already-resolved collaborators the wiring needs
 *   - `createProposalDeps` -- assemble the proposal pass's dependency record
 *   - `createValidationEnqueuer` -- enqueue `repo-validate` against a pushed head
 *
 * @dependencies
 *   - ./db/repos -- the idempotent pending-job insert
 *   - ./results/change-verifier -- the verified-snapshot path derivation
 *   - ./results/proposal-pass -- the candidate loader and proposal queuer
 *   - ./templates/ids -- the allowlisted `repo-validate` id
 */
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WatcherConfig } from "./config/schema";
import type { WatcherDb } from "./db/client";
import { createPendingJob } from "./db/repos";
import type { ForgeClient } from "./forge/boundary";
import { readBundleArtifact } from "./rails/artifact";
import { evaluateRails } from "./rails/enforce";
import type { GitRunner } from "./results/branch-publisher";
import { snapshotPathFor } from "./results/change-verifier";
import {
	createCandidateLoader,
	createProposalQueuer,
	type ProposalPassDeps,
} from "./results/proposal-pass";
import { VALIDATE_TEMPLATE_ID } from "./templates/ids";

/** The already-resolved collaborators the proposal wiring is assembled from. */
export interface ProposalDepsInputs {
	db: WatcherDb;
	config: WatcherConfig;
	git: GitRunner;
	/** Watcher-owned root for verified snapshots and publish scratch. */
	changeWorkRoot: string;
	clientFor: (repository: string) => Promise<ForgeClient | null>;
	remoteFor: (repository: string) => string | null;
	credentialFor: (repository: string) => Promise<string | null>;
	/** Read-only path to rtech-infra's factory rails manifest. */
	railsManifestPath?: string;
	onError: (error: unknown) => void;
}

/**
 * Assemble the proposal pass's dependency record.
 *
 * @param inputs - the already-resolved watcher-owned collaborators
 * @returns the dependency record `runProposalPass` drives
 */
export function createProposalDeps(inputs: ProposalDepsInputs): ProposalPassDeps {
	const { db, config, git, changeWorkRoot, clientFor, remoteFor, credentialFor, onError } = inputs;
	return {
		db,
		clientFor,
		config,
		git,
		remoteFor,
		credentialFor,
		scratchRepoFor: (repository) => join(changeWorkRoot, "publish", repository.replace("/", "__")),
		ensureScratchRepo: createScratchPreparer(git, credentialFor),
		loadCandidates: createCandidateLoader(
			db,
			(jobRunnerId, hostname) => snapshotPathFor(changeWorkRoot, jobRunnerId, hostname),
			snapshotExists,
		),
		/**
		 * The operator's own `config.railsManifestPath` is the ONLY default.
		 *
		 * The first live verb candidate to reach rails-eval (job 5107, 2026-08-17)
		 * HELD with `rails.manifest_absent` on an ENOENT for a Mac-local path, while
		 * the SAME box's verb dispatch read `config.railsManifestPath` and rendered
		 * the manifest fine minutes earlier. The compiled fallback that used to sit
		 * here was sf#295's killed class still alive on the rails side. Absence must
		 * be an honest hold, never a Mac path on an LXC.
		 */
		railsManifestPath: inputs.railsManifestPath ?? inputs.config.railsManifestPath,
		evaluateRails,
		loadRenderedArtifact: async (artifactInput) => {
			const outcome = await readBundleArtifact({ ...artifactInput, git });
			return outcome.status === "ok" ? outcome.artifact : null;
		},
		queueProposal: createProposalQueuer(db),
		enqueueValidation: createValidationEnqueuer(db),
		onError,
	};
}

/**
 * Enqueue a `repo-validate` job against a pushed proposal head.
 *
 * NO NEW MACHINERY, which is the whole point. This is the ordinary pending-job
 * insert every other producer uses, with the sha set to the pushed head instead
 * of the dispatched base — so the job dispatches, runs, and reports through the
 * unchanged cycle, and its verdict surfaces on the EXISTING exact-SHA
 * check-run/report path bound to that head. No publication kind is added and the
 * proposal comment is never rewritten (controller ruling, option A, memo
 * 6f2a93a).
 *
 * IDEMPOTENCY IS FREE, NOT IMPLEMENTED HERE. `createPendingJob` inserts with
 * `onConflictDoNothing` against the `(repository_id, item_id, sha, job_type)`
 * unique key (`src/db/repos.ts`), and the head sha is part of that key. A second
 * proposal pass over the same candidate — which happens whenever a plan fails to
 * persist and the candidate stays eligible — therefore enqueues NOTHING and
 * returns false. A re-push at a genuinely NEW head is a different key and gets
 * its own validation, which is the behaviour that ticket wants: the verdict
 * belongs to a tree, not to a branch name.
 *
 * `itemId` is passed through as the job row carries it (nullable in the schema),
 * never coerced: the uniqueness key includes it, so substituting a value would
 * change which rows collide.
 *
 * @param db - the watcher database handle
 * @returns an enqueuer reporting whether a NEW validation job row was created
 */
export function createValidationEnqueuer(db: WatcherDb): ProposalPassDeps["enqueueValidation"] {
	return async (candidate, headSha) =>
		await createPendingJob(db, {
			repositoryId: candidate.repositoryId,
			itemId: candidate.itemId,
			sha: headSha,
			jobType: VALIDATE_TEMPLATE_ID,
		});
}

/** Prepare a bare scratch repo that contains the exact dispatched base. */
function createScratchPreparer(
	git: GitRunner,
	credentialFor: ProposalDepsInputs["credentialFor"],
): ProposalPassDeps["ensureScratchRepo"] {
	return async (dir, remote, baseSha, repository) => {
		try {
			await mkdir(dir, { recursive: true });
		} catch {
			return false;
		}
		const init = await git.run(["init", "--bare", "--quiet"], { cwd: dir });
		if (init.exitCode !== 0) return false;

		const credential = await credentialFor(repository);
		const base = await git.run(["fetch", "--no-tags", "--depth", "1", remote, baseSha], {
			cwd: dir,
			...(credential === null ? {} : { credential }),
		});
		return base.exitCode === 0;
	};
}

/** A verified snapshot exists only when the lane produced and passed a bundle. */
async function snapshotExists(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch {
		return false;
	}
}
