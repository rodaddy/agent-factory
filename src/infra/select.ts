/**
 * @module infra/select
 * @description The wiring seam that turns a static-only repository's configured
 *   `gate_selection` mode into a concrete `GateSelection` for one candidate
 *   pull request. It is the ONLY place the bounded changed-files read
 *   (`./changed-files`) meets the pure gate selector (`./gates`): for the `full`
 *   mode it returns a full escalation after ONE read of the PR object for the
 *   immutable base SHA the body's verdict is relative to; for the
 *   `changed-files` mode it derives the changed PATHS from the IMMUTABLE pinned
 *   SHA (a `base..pinnedSHA` compare) through the read-only client and maps them
 *   through `selectGates`, still failing closed to a full escalation on any
 *   indeterminate or cross-cutting change.
 *
 *   Exact-SHA binding (HIGH-2 / TOCTOU). The changed-file set is read from the
 *   GitHub COMPARE endpoint bound to the job's exact pinned SHA, NOT from the PR's
 *   mutable head. The PR object is read ONCE only to obtain the IMMUTABLE base
 *   COMMIT (`base.sha`, strict-hex; never the mutable `base.ref` branch name — see
 *   HIGH-2a) and to confirm the PR exists; the narrow decision itself never
 *   depends on the PR head, and BOTH sides of the compare are immutable commits,
 *   so a push after dispatch — to the PR head OR to the base branch — can NOT
 *   change which gates are selected for a pinned job. There is no separate
 *   head-match pre-check because the compare IS the exact-SHA binding.
 *
 *   It grants no capability and names no command: it decides only WHICH fixed
 *   static gates apply. A missing item number (a static check bound to a SHA with
 *   no PR to enumerate) also fails closed to a full escalation, so the runner
 *   always runs at least the full fixed static gate set.
 *
 * @outputs
 *   - `GateSelectionMode` -- the configured selection mode
 *   - `resolveGateSelection` -- config mode + item -> concrete GateSelection
 *
 * @dependencies
 *   - ../github/client -- the read-only, bounded REST client (injectable)
 *   - ./changed-files -- the bounded, fail-closed, SHA-bound changed-paths reader
 *   - ./gates -- the pure fixed gate selector
 */
import type { ForgeClient } from "../forge/boundary";
import type { Provider } from "../forge/provider";
import { errorClass, log, traced } from "../log";
import { isExactSha, readChangedFilesForSha } from "./changed-files";
import { type GateSelection, STATIC_GATES, selectGates } from "./gates";

/** The configured gate-selection mode (mirrors `repositoryConfigSchema`). */
export type GateSelectionMode = "changed-files" | "full";

/** A full escalation over all fixed gates, carrying a fixed reason. */
function fullEscalation(reason: string): GateSelection {
	return { gates: [...STATIC_GATES], fullEscalation: true, reason };
}

/**
 * Resolve the concrete gate selection for one candidate.
 *
 * Both modes require a client and a PR item number; absent either they fail
 * closed to a full escalation carrying no base. `full` (the default) then reads
 * the PR object ONCE for the immutable base SHA and returns a full escalation
 * carrying it (never the compare read). `changed-files` reads the PR
 * object ONCE to obtain the IMMUTABLE base COMMIT `base.sha` (and confirm the PR
 * exists), then derives the changed paths from a `base.sha..pinnedSHA` compare —
 * both sides immutable, never the mutable PR head OR a mutable base branch name —
 * and maps them through the pure `selectGates`. An indeterminate read (unreadable
 * PR/base, absent/non-hex base SHA, unreachable SHA, over-cap, malformed, or API
 * error) escalates to the full gate set. The result is always a bounded
 * `GateSelection` — never a throw.
 *
 * @param mode - the repository's configured `gate_selection`
 * @param client - the read-only forge client (one PR-object read in both modes)
 * @param repository - `owner/repo`
 * @param itemNumber - the candidate PR number, when known
 * @param sha - the job's pinned exact SHA the runner will validate
 */
/** Arguments for {@link resolveGateSelection}. */
export type ResolveGateSelectionArgs = {
	mode: GateSelectionMode;
	client: ForgeClient | null;
	repository: string;
	itemNumber: number | null | undefined;
	sha: string;
	provider?: Provider;
};

export const resolveGateSelection = traced(
	"infra.resolveGateSelection",
	async function resolveGateSelection({
		mode,
		client,
		repository,
		itemNumber,
		sha,
		provider = "github",
	}: ResolveGateSelectionArgs): Promise<GateSelection> {
		if (client === null || itemNumber === null || itemNumber === undefined) {
			return fullEscalation("no candidate item to enumerate: escalated to full static gates");
		}
		if (mode !== "changed-files") {
			// The full mode still reads the PR object ONCE for the IMMUTABLE base SHA
			// (never the compare): without it the body renders an absolute verdict and
			// the base-relative rule of sf#586 never fires for a `gate_selection: full`
			// repository (observed live on jobs 11864/11869, 2026-09-03). An unreadable
			// base leaves the field absent, which the body renders as before.
			const fullBase = await pullBaseSha(client, repository, itemNumber);
			const full = fullEscalation("gate_selection=full: all fixed static gates run");
			return fullBase === null ? full : { ...full, baseSha: fullBase };
		}
		// EXACT-SHA binding. Read the PR object ONCE, only to obtain the IMMUTABLE base
		// commit SHA (and confirm the PR exists). The narrow decision never depends on
		// the mutable PR head; the changed-file set is derived from a compare bound to
		// the job's pinned SHA below. A base SHA that cannot be read (absent/non-hex)
		// fails closed to full.
		const baseSha = await pullBaseSha(client, repository, itemNumber);
		if (baseSha === null) {
			return fullEscalation("PR base SHA unreadable: escalated to full static gates");
		}
		// GitHub compares immutable commits; Forgejo proves the PR file list complete
		// and requires its head to match the pinned SHA before and after pagination.
		const changed = await readChangedFilesForSha({
			client,
			repository,
			base: baseSha,
			sha,
			provider,
			pullNumber: itemNumber,
		});
		// Attach the IMMUTABLE base the compare was bound to. `selectGates` does not
		// know the base; the body needs it to render a base-relative verdict.
		// Both the narrow and the escalated result of this call carry it; the two
		// earlier `fullEscalation(...)` returns (no item, unreadable base) do not.
		return { ...selectGates(changed.paths, changed.indeterminate), baseSha };
	},
);

/** The base SHA is the only field this narrow PR-object read consumes. */
interface RawPullBase {
	base?: { sha?: unknown };
}

/**
 * Read the pull request's IMMUTABLE base COMMIT SHA through the read-only client's
 * `getPage` seam (the same seam the changed-files read uses). It consumes ONLY
 * `base.sha` (HIGH-2a): base.sha is an immutable commit, so binding the compare
 * left side to it cannot be raced by a push to the base branch. There is NO
 * `base.ref` fallback — a mutable branch NAME may never bind the compare, because
 * a push to that branch between this read and the compare read would be a
 * (smaller) TOCTOU race. The SHA is strict-hex validated with the shared
 * `isExactSha`, so `select.ts` only ever passes a strict-hex base SHA to the
 * changed-files reader. Returns `null` fail-closed on any API/network error,
 * non-object body, or a base SHA that is absent, non-string, empty, or not
 * strict-hex — so the caller escalates to the full gate set rather than narrowing
 * from an unreadable or mutable base. It adds no write capability and no new
 * client surface.
 */
async function pullBaseSha(
	client: ForgeClient,
	repository: string,
	pullNumber: number,
): Promise<string | null> {
	if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repository)) {
		return null;
	}
	if (!Number.isInteger(pullNumber) || pullNumber <= 0) {
		return null;
	}
	let page: { body: unknown; next: string | null };
	try {
		page = await client.getPage<unknown>(`/repos/${repository}/pulls/${pullNumber}`);
	} catch (err) {
		// Failing closed here is correct, but it is not free: the caller escalates to
		// the FULL gate set, so a persistent API outage silently makes every PR run
		// the expensive gates while looking like ordinary behaviour.
		// Class only — a client error can quote the Authorization header.
		log("warn", "infra.select.base_sha_unreadable", {
			repository,
			pull: pullNumber,
			error_class: errorClass(err),
		});
		return null;
	}
	const body = page.body;
	if (body === null || typeof body !== "object") {
		return null;
	}
	const baseSha = (body as RawPullBase).base?.sha;
	// Use ONLY the immutable base.sha, strict-hex validated. No base.ref fallback:
	// an absent, non-string, empty, or non-hex base SHA fails closed to full so the
	// compare can never bind to a mutable ref.
	if (typeof baseSha === "string" && isExactSha(baseSha)) {
		return baseSha;
	}
	return null;
}
