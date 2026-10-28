/**
 * @module forgejo/pull-state
 * @description Shape-checked read of a Forgejo pull request's landing state
 *   from `GET /repos/{owner}/{repo}/pulls/{number}`. Shared by
 *   `ForgejoClient.getPullRequestMergeState` (`scripts/land.ts`) and the
 *   build-bump merge watch, which reads the same body through the
 *   generic forge `get`.
 *
 * @outputs
 *   - `PullRequestMergeState` -- merged, merge commit, open/closed, merge time
 *   - `RawForgejoPullState` -- the bounded fields read from the body
 *   - `pullRequestMergeStateOf` -- raw body -> shape-checked state
 */

import { traced } from "../log";

/**
 * Whether a pull request has landed, the commit it landed as, its open/closed
 * state, and the forge's merge time. `state` is `null` unless the body said
 * exactly `open` or `closed`; `mergedAt` is `null` unless it is a non-empty
 * string `Date.parse` accepts.
 */
export interface PullRequestMergeState {
	merged: boolean;
	mergeCommitSha: string | null;
	state: "open" | "closed" | null;
	mergedAt: string | null;
}

/** The bounded merge-state fields read back from `GET /pulls/{number}`. */
export interface RawForgejoPullState {
	merged?: unknown;
	merge_commit_sha?: unknown;
	state?: unknown;
	merged_at?: unknown;
}

/**
 * Every field is shape-checked rather than trusted: anything that is not a
 * literal `true` reads as not merged, and a missing/blank SHA reads as `null`,
 * so a malformed body can never be mistaken for a proven landing.
 */
function pullRequestMergeStateOfImpl(
	raw: RawForgejoPullState | null | undefined,
): PullRequestMergeState {
	const sha = raw?.merge_commit_sha;
	const state = raw?.state;
	const mergedAt = raw?.merged_at;
	return {
		merged: raw?.merged === true,
		mergeCommitSha: typeof sha === "string" && sha.length > 0 ? sha : null,
		state: state === "open" || state === "closed" ? state : null,
		mergedAt:
			typeof mergedAt === "string" && mergedAt.length > 0 && !Number.isNaN(Date.parse(mergedAt))
				? mergedAt
				: null,
	};
}

export const pullRequestMergeStateOf = traced(
	"forgejo.pullRequestMergeStateOf",
	pullRequestMergeStateOfImpl,
);
