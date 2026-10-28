/**
 * @module forge/read
 * @description Provider-aware incremental read dispatch. A reconciliation pass
 *   reads changed issues/PRs for a repository through whichever forge that
 *   repository lives on, without the pass itself knowing the wire differences.
 *   The dispatch is a closed switch over the provider the client already carries:
 *   GitHub keeps its exact existing `readChangedIssues` path (byte-for-byte, so
 *   every GitHub invariant is preserved), and Forgejo uses its X-Total-Count
 *   fail-closed reader. There is no third path — an unknown provider is
 *   unreachable through the closed `Provider` enum.
 *
 * @outputs
 *   - `readChangedItems` -- read changed items via the client's provider
 *   - `findOpenProposalForHead` -- is a proposal already open for a head branch?
 *
 * @dependencies
 *   - ./boundary -- the narrow forge client (carries its provider)
 *   - ../github/read -- the unchanged GitHub reader + shared result shape
 *   - ../forgejo/read -- the Forgejo X-Total-Count reader
 *   - ../log -- the shared traced() build-phase wrapper and log()
 */
import { readChangedForgejoIssues } from "../forgejo/read";
import { type ReadResult, readChangedIssues } from "../github/read";
import { log, traced } from "../log";
import type { ForgeClient } from "./boundary";

/**
 * Read the changed issues/PRs for `fullName` since `cursor`, dispatching on the
 * client's own provider. GitHub uses its existing reader unchanged; Forgejo uses
 * the fail-closed X-Total-Count reader. Both return the SAME `ReadResult` shape,
 * so the reconcile pass consumes the result identically for either forge.
 *
 * @param client - the forge client (its `provider` selects the reader)
 * @param fullName - `owner/repo`
 * @param cursor - prior watermark (ISO-8601) or null for a first read
 * @param now - current time as ISO-8601, injected for deterministic tests
 */
export const readChangedItems = traced(
	"forge.readChangedItems",
	function readChangedItems(
		client: ForgeClient,
		fullName: string,
		cursor: string | null,
		now: string,
	): Promise<ReadResult> {
		if (client.provider === "forgejo") {
			return readChangedForgejoIssues(client, fullName, cursor, now);
		}
		// github — the existing reader, unchanged. It consumes the client through the
		// shared `ForgeClient` verbs only, so it accepts the boundary type directly.
		return readChangedIssues(client, fullName, cursor, now);
	},
);

/**
 * Whether an OPEN change proposal already exists for `headBranch`.
 *
 * Three-valued ON PURPOSE, and `"unknown"` is NOT `"absent"`. A caller that
 * cannot PROVE absence must fail closed: for the implement lane that is the
 * difference between skipping one pass and spending a runner on a duplicate
 * proposal for an issue that already has one.
 *
 * GitHub filters server-side with `head=owner:branch`, which answers an empty
 * array rather than a 404 when nothing matches, so absence is a well-formed
 * answer instead of an error that has to be interpreted. Forgejo's list endpoint
 * exposes no head filter, so the bounded OPEN set is read and scanned locally;
 * a factory repository's open set is small and the page bound keeps it so.
 *
 * A closed-unmerged proposal is `"absent"` by construction — the query is
 * state=open — which is the intended re-run path.
 *
 * @param client - the forge client (its `provider` selects the wire shape)
 * @param repository - `owner/repo`
 * @param headBranch - the watcher-derived source branch, e.g. `rw/issue-7`
 */
export const findOpenProposalForHead = traced(
	"forge.findOpenProposalForHead",
	async function findOpenProposalForHead(
		client: ForgeClient,
		repository: string,
		headBranch: string,
	): Promise<"open" | "absent" | "unknown"> {
		try {
			if (client.provider === "forgejo") {
				const rows = await client.paginate<{
					head?: { ref?: string; repo?: { full_name?: string } };
					state?: string;
				}>(`/repos/${repository}/pulls?state=open&limit=50`, 10);
				if (!Array.isArray(rows)) {
					throw new Error("proposal list is not an array");
				}
				// A ref match alone is not a match: a FORK can carry the same `rw/issue-<n>`
				// ref. The proposal is ours only when its head
				// repository is THIS repository; a matching ref whose source repository
				// the forge did not report cannot be proven either way, so it is `unknown`.
				const matching = rows.filter((row) => row?.head?.ref === headBranch);
				if (matching.some((row) => row.head?.repo?.full_name === undefined)) {
					throw new Error("proposal head repository not reported");
				}
				return matching.some((row) => row.head?.repo?.full_name === repository) ? "open" : "absent";
			}
			const owner = repository.split("/")[0];
			if (!owner) {
				throw new Error("repository is not owner/name");
			}
			// `head` must be `owner:branch` on this endpoint; a bare branch name
			// silently matches nothing, which would read as absence.
			const query = `head=${encodeURIComponent(`${owner}:${headBranch}`)}&state=open&per_page=1`;
			const response = await client.get<unknown[]>(`/repos/${repository}/pulls?${query}`);
			const rows = response.data;
			if (!Array.isArray(rows)) {
				throw new Error("proposal list is not an array");
			}
			return rows.length > 0 ? "open" : "absent";
		} catch (error) {
			// Bounded and secret-free: the branch and repository are watcher-derived,
			// and only the error message rides along — never a response body.
			log("warn", "reconcile.open_proposal_probe_failed", {
				repository,
				head_branch: headBranch,
				cause: error instanceof Error ? error.message : "unknown error",
			});
			return "unknown";
		}
	},
);
