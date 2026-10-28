/**
 * @module jobs/verb-base
 * @description The CHANGE BASE a job's proposed change must descend from.
 *
 *   For nearly every lane this is a question with an obvious answer: a change
 *   proposed by a job dispatched against `owner/repo` at commit `X` must descend
 *   from `owner/repo` at `X`, and `change-verifier` reads both straight off the
 *   `jobs` row. The deterministic k3s verbs break that identity in a way no
 *   existing lane does.
 *
 *   A verb job is dispatched against a MANAGED repository's issue — that is where
 *   the `deploy:<app>` label lives and what the item number belongs to — and
 *   `jobs.sha` carries the rails-manifest sha256 the dispatch was built from,
 *   because the manifest is what decides whether two dispatches are the same
 *   work. But the change the box returns is a RENDER against `rtech/k3s-deploy`.
 *   So the dispatch identity and the change base are two different facts, and
 *   before sf#301 the verifier only had the first one: a correct verb bundle was
 *   compared against a manifest digest (not a git object at all) belonging to a
 *   repository the change never touched, and was rejected.
 *
 *   THE SHAPE OF THE FIX. Two nullable columns carry the change base when it
 *   differs, and this module is the ONE place that decides which identity wins.
 *   `jobs.sha` is untouched, so `createPendingJob`'s
 *   (repository_id, item_id, sha, job_type) dedup key keeps meaning exactly what
 *   it meant. The alternative — overloading `jobs.sha` with the k3s-deploy head —
 *   was rejected because it silently changes dedup in both directions
 *   (_DOCS/decisions-ledger.md L-013).
 *
 *   FAIL CLOSED, NEVER FALL BACK. A verb job whose change base is missing or
 *   malformed yields `null` rather than quietly reverting to its dispatch
 *   identity. Falling back would reintroduce the exact defect this module exists
 *   to fix, and would do it invisibly — the verifier would reject every bundle
 *   with `base_sha_mismatch` and the cause would look like a runner problem.
 *
 * @outputs
 *   - `VERB_CHANGE_BASE_REPOSITORY` -- the one repository every verb change targets
 *   - `VERB_CHECK_CONTEXT` -- the sop-gate-distinct status context a verb receipt uses
 *   - `dispatchedBaseForJob` -- the change base for one job row, or `null`
 *   - `isFullGitSha` -- a full 40-hex object id, the only base a verb may declare
 *
 * @dependencies
 *   - ./verb-dispatch -- the allowlisted verb ids
 */
import { traced } from "../log";
import { isVerbId } from "./verb-dispatch";

/**
 * The one protected GitOps repository every deterministic verb proposal targets.
 *
 * Spelled here as well as in `verb-dispatch` because this is the identity the
 * VERIFIER compares against, and a verifier that imported its expectation from
 * the dispatcher would agree with the dispatcher by construction. The two are
 * pinned to each other by test instead.
 */
export const VERB_CHANGE_BASE_REPOSITORY = "rtech/k3s-deploy" as const;

/**
 * The commit-status context a verb job's factory receipt posts under on
 * `VERB_CHANGE_BASE_REPOSITORY`.
 *
 * DELIBERATELY OUTSIDE THE `sop-gate` FAMILY. The change base repository is a
 * protected GitOps repo, and a status context is the vocabulary a branch
 * protection rule speaks. Reusing a sop-gate context would let a factory receipt
 * — which reports whether a RUNNER job passed, not whether a change may merge —
 * be read as a merge judgment. `rtech/rtech-infra` today requires no context,
 * so a status posted under this name gates nothing; that stays true only as long
 * as the name stays distinct. Do not rename this to anything a protection rule
 * might plausibly require.
 */
export const VERB_CHECK_CONTEXT = "watcher-verb" as const;

/**
 * A FULL 40-character hex object id.
 *
 * Deliberately stricter than the result schema's `hexSha` (which accepts 7–64 to
 * tolerate abbreviations a runner might report). This value is watcher-resolved
 * from the forge, not runner-supplied, so there is no reason to accept an
 * abbreviation — and an abbreviated base would be fetched and compared
 * ambiguously. Rejecting it here keeps the ambiguity out of the verifier.
 */
export const isFullGitSha = traced(
	"jobs.isFullGitSha",
	function isFullGitSha(value: string): boolean {
		return /^[0-9a-f]{40}$/.test(value);
	},
);

/** One `jobs` row's identity, as the verifier reads it. */
export interface JobBaseIdentity {
	jobType: string;
	/** `jobs.sha` — the dispatch digest. For a verb job this is the manifest sha256. */
	jobSha: string;
	/** The job's own repository, resolved from `jobs.repository_id`. */
	repositoryFullName: string;
	/** `jobs.change_base_repository`, when the job recorded one. */
	changeBaseRepository?: string | null;
	/** `jobs.change_base_sha`, when the job recorded one. */
	changeBaseSha?: string | null;
}

/**
 * The repository and commit a job's proposed change must descend from.
 *
 * A job that recorded no change base answers with its own dispatch identity,
 * byte-for-byte as before sf#301 — that covers every implement-lane job and every
 * row that predates the change-base columns.
 *
 * A VERB job must have recorded one, and it must name the one allowlisted target
 * repository at a full git sha. Anything else returns `null`, which the caller
 * turns into a rejection: a verb change with no trustworthy base is unverifiable
 * by construction, and guessing one is how the original defect happened.
 *
 * @param job - the job row's identity fields
 * @returns the base to verify against, or `null` when a verb job has no usable one
 */
export const dispatchedBaseForJob = traced(
	"jobs.dispatchedBaseForJob",
	function dispatchedBaseForJob(job: JobBaseIdentity): { repository: string; sha: string } | null {
		const repository = job.changeBaseRepository ?? null;
		const sha = job.changeBaseSha ?? null;

		if (isVerbId(job.jobType)) {
			// Fail closed. A verb job's change base is the ONLY correct answer here;
			// answering with the dispatch identity would compare a k3s-deploy render
			// against a rails-manifest digest, which is sf#301 itself.
			if (repository !== VERB_CHANGE_BASE_REPOSITORY) return null;
			if (sha === null || !isFullGitSha(sha)) return null;
			return { repository, sha };
		}

		// Every non-verb lane: a recorded change base still wins when present (nothing
		// sets one today, and this keeps the column meaningful if a future lane does),
		// otherwise the job's own dispatch identity, exactly as before.
		if (repository !== null && sha !== null && isFullGitSha(sha)) {
			return { repository, sha };
		}
		if (job.jobSha === "") return null;
		return { repository: job.repositoryFullName, sha: job.jobSha };
	},
);
