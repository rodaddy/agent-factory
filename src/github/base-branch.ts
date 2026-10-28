/**
 * @module github/base-branch
 * @description Resolve the branch a change proposal targets (Q4).
 *
 *   Two sources, in a deliberate order:
 *
 *   1. **Config** (`proposal_base_branch` on the managed repository) — the
 *      predictable answer. The target cannot move under the watcher because
 *      someone renamed a default branch on the forge, and it is reviewed in the
 *      same file that allowlists the repository.
 *   2. **The forge's declared default branch** — the fallback, so a repository
 *      works with no configuration and stays correct if its default is renamed.
 *
 *   Neither source is the runner. A runner that could choose the base could
 *   target a branch nobody reviews, so the base is resolved entirely from
 *   watcher-side inputs and the result is validated again here rather than
 *   trusted because of where it came from — the forge is a remote system, and
 *   its response is data, not authority.
 *
 *   Resolution FAILS CLOSED. An unreachable forge, a missing field, or a
 *   malformed name yields null and the caller must refuse to open a proposal:
 *   guessing `main` would be a plausible-looking way to target the wrong branch
 *   in a repository that uses something else.
 *
 * @outputs
 *   - `resolveBaseBranch` -- config-then-forge resolution, fail-closed
 *   - `resolveBranchTipSha` -- the branch's current tip commit, fail-closed
 *   - `isPlainBranchName` -- the shared validity rule for a branch name
 *   - `isFullCommitSha` -- the shared validity rule for a dispatchable base
 *
 * @dependencies
 *   - ../forge/boundary -- the read verb used for the default-branch lookup
 *   - ../log -- structured, credential-free failure logging
 */
import type { ForgeClient } from "../forge/boundary";
import { errorMessage, log, traced } from "../log";

/**
 * A plain branch name safe to place in a forge API payload: no `refs/` prefix,
 * no traversal, no leading slash, no whitespace or control characters. Applied
 * to BOTH the configured value and the forge's answer — a remote response is
 * data, and this is the last point at which it can be checked.
 */
export const isPlainBranchName = traced(
	"github.isPlainBranchName",
	function isPlainBranchName(value: string): boolean {
		return (
			value.length > 0 &&
			value.length <= 255 &&
			/^[A-Za-z0-9._\-/]+$/.test(value) &&
			!value.includes("..") &&
			!value.startsWith("/") &&
			!value.startsWith("refs/")
		);
	},
);

/** The shape the watcher reads from a repository lookup. */
interface RepositoryRef {
	default_branch?: unknown;
}

/**
 * Resolve the base branch for a proposal, or null when it cannot be established.
 *
 * @param client - the provider client for the repository's forge
 * @param repository - `owner/repo`, already validated against the allowlist
 * @param configured - the reviewed `proposal_base_branch`, when the operator set one
 */
export const resolveBaseBranch = traced(
	"github.resolveBaseBranch",
	async function resolveBaseBranch(
		client: ForgeClient,
		repository: string,
		configured?: string,
	): Promise<string | null> {
		if (configured !== undefined) {
			// Re-validated rather than trusted: config is reviewed, but a bad value here
			// would be interpolated into a forge write, so it is checked at use.
			if (isPlainBranchName(configured)) {
				return configured;
			}
			log("warn", "proposal.base_branch.invalid_config", { repository });
			return null;
		}

		try {
			const response = await client.get<RepositoryRef>(`/repos/${repository}`);
			const branch = response.data?.default_branch;
			if (typeof branch !== "string" || !isPlainBranchName(branch)) {
				log("warn", "proposal.base_branch.unusable_default", { repository });
				return null;
			}
			return branch;
		} catch (error) {
			// Fail closed. Defaulting to `main` here would be a plausible-looking way
			// to target the wrong branch in a repository that uses something else.
			log("warn", "proposal.base_branch.lookup_failed", {
				repository,
				error: errorMessage(error),
			});
			return null;
		}
	},
);

/**
 * A FULL 40- or 64-character hex commit id. Deliberately stricter than the
 * result schema's `hexSha` (which accepts 7+ for a runner's own reporting): this
 * value becomes the dispatched base that #65's provenance gate compares against
 * in full, and an abbreviated base would be a prefix nobody can compare exactly.
 */
export const isFullCommitSha = traced(
	"github.isFullCommitSha",
	function isFullCommitSha(value: string): boolean {
		return /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i.test(value);
	},
);

/**
 * The shape a branch lookup returns, across BOTH forges.
 *
 * GitHub and Forgejo disagree here, and the disagreement is silent. Verified
 * against the live deployment (Forgejo 16.0.1+gitea-1.22.0) rather than assumed
 * from Gitea compatibility:
 *
 *   GitHub   GET /repos/{repo}/branches/{branch} -> `commit.sha`
 *   Forgejo  GET /repos/{repo}/branches/{branch} -> `commit.id`
 *
 * The Forgejo response is a `PayloadCommit`, which has NO `sha` property at all
 * — reading `commit.sha` there yields undefined on every repository, so a
 * single-shape reader fails closed on one whole forge for a reason that looks
 * like an outage. Both keys are declared optional and exactly one is expected.
 */
interface BranchRef {
	commit?: { sha?: unknown; id?: unknown };
}

/**
 * Resolve a branch's current tip commit, or null when it cannot be established.
 *
 * This is the value that must be recorded AT DISPATCH. #65 proves a returned
 * bundle applies to the exact commit the watcher handed out, so re-resolving the
 * tip at ingest time would defeat the check: the branch may have moved while the
 * job ran, and the bundle would then be validated against a commit nobody
 * dispatched.
 *
 * Fails closed for the same reason as `resolveBaseBranch`: a missing or
 * malformed tip yields null and the caller must not create work, because a job
 * with no truthful base is unverifiable by construction.
 *
 * @param client - the provider client for the repository's forge
 * @param repository - `owner/repo`, already validated against the allowlist
 * @param branch - a branch name that has already passed `isPlainBranchName`
 */
export const resolveBranchTipSha = traced(
	"github.resolveBranchTipSha",
	async function resolveBranchTipSha(
		client: ForgeClient,
		repository: string,
		branch: string,
	): Promise<string | null> {
		// Re-validated at use: this value is interpolated into a request path, and
		// the caller's guarantee is not visible from here.
		if (!isPlainBranchName(branch)) {
			log("warn", "base.tip.invalid_branch", { repository });
			return null;
		}
		try {
			// Encoded per SEGMENT, so a legitimate slashed branch (`release/1.x`) keeps
			// its separators. `encodeURIComponent` on the whole name escapes `/` to
			// `%2F`, which GitHub happens to accept but which no longer matches the
			// path-routed form either forge documents. `isPlainBranchName` has already
			// excluded traversal and a leading slash, so the segments are safe to join.
			const encoded = branch.split("/").map(encodeURIComponent).join("/");
			const response = await client.get<BranchRef>(`/repos/${repository}/branches/${encoded}`);
			const commit = response.data?.commit;
			// GitHub's `sha` first, then Forgejo's `id`. Neither is trusted to be a
			// string, because a forge response is data rather than authority.
			const raw = typeof commit?.sha === "string" ? commit.sha : commit?.id;
			if (typeof raw !== "string" || !isFullCommitSha(raw)) {
				log("warn", "base.tip.unusable", { repository, branch });
				return null;
			}
			return raw.toLowerCase();
		} catch (error) {
			log("warn", "base.tip.lookup_failed", {
				repository,
				branch,
				error: errorMessage(error),
			});
			return null;
		}
	},
);
