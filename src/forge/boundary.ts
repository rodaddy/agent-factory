/**
 * @module forge/boundary
 * @description The NARROW semantic forge boundary. It is deliberately not a
 *   generic plugin framework: it is exactly the read/write surface the watcher's
 *   publisher, incremental reader, changed-files comparison, and doctor probe
 *   already use, factored into one interface both the existing GitHub client and
 *   the new Forgejo client satisfy. Because the surface is the SAME shape the
 *   `GitHubClient` already exposes (`get`, `getPage`, `paginate`, `write`), the
 *   GitHub client implements it WITHOUT any behavior change, so every GitHub
 *   caller and invariant is preserved byte-for-byte.
 *
 *   The single provider-varying operation is the exact-SHA commit check: GitHub
 *   uses check-runs (an object-shaped list keyed by `external_id`), Forgejo uses
 *   commit statuses with a stable `context`. That difference is expressed through
 *   `postCommitCheck`/`findCommitCheck` on the boundary — a small, typed seam —
 *   rather than leaking raw endpoint shapes into the publisher. Everything else
 *   (issues/PR reads, labels, comments, audit issues, changed files) is
 *   provider-correct at the client's endpoint level behind the shared `get`/
 *   `getPage`/`paginate`/`write` verbs.
 *
 * @outputs
 *   - `ForgeClient` -- the narrow read/write contract both clients satisfy
 *   - `ForgeResponse` / `ForgePage` -- the shared response shapes (from the
 *     existing GitHub client types, so nothing about GitHub changes)
 *   - `CommitCheck` / `CommitCheckLookup` -- the provider-varying commit-check seam
 *
 * @dependencies
 *   - ./provider -- the forge-provider identity every client carries
 */
import type { Provider } from "./provider";

/**
 * A successful read response with the parsed body and the pagination/rate
 * signals the watcher already consumes. This is structurally identical to the
 * existing GitHub client's response type, so the GitHub client's `get` already
 * returns it — the boundary reuses the exact shape rather than redefining it.
 */
export interface ForgeResponse<T> {
	status: number;
	data: T;
	/** GitHub Link header; null for Forgejo and when GitHub omits it. */
	link: string | null;
	/** Remaining primary rate-limit budget, when reported (GitHub only). */
	rateRemaining: number | null;
}

/** A single page's raw parsed body plus the `next` page URL (null when done). */
export interface ForgePage<T> {
	body: T;
	next: string | null;
	/** Forgejo collection count, when reported. */
	totalCount?: number;
}

/**
 * The conclusion the watcher publishes for a commit, derived only from the
 * validated runner status. Both providers map it to their own vocabulary
 * (GitHub check-run conclusion; Forgejo commit-status state) inside the client.
 */
export type ForgeCheckConclusion = "success" | "failure" | "neutral";

/** The bounded, provider-agnostic commit-check the publisher wants to upsert. */
export interface CommitCheck {
	/** The exact trusted commit SHA the check binds to. */
	sha: string;
	/** The fixed, stable context/name — never runner-chosen. */
	context: string;
	conclusion: ForgeCheckConclusion;
	title: string;
	summary: string;
	/**
	 * The deterministic stable identity a re-post reuses so it updates the same
	 * check rather than creating a second. GitHub carries it as the check-run
	 * `external_id`; Forgejo folds it into the stable status `context` (a commit
	 * status is already keyed by context, so a re-post naturally replaces it).
	 */
	dedupeKey: string;
}

/**
 * A commit-check dedupe lookup outcome, mirroring the publisher's existing
 * fail-closed dedupe posture. `absent` is a PROVEN negative from a fully
 * consumed, well-formed scan (only then is a create safe); `found` carries the
 * existing reference; `indeterminate` means the scan was truncated or malformed,
 * so absence cannot be proven and the caller must stay retryable.
 */
export type CommitCheckLookup =
	| { status: "found"; ref: string }
	| { status: "absent" }
	| { status: "indeterminate"; reason: string };

/**
 * The narrow forge contract. Read verbs (`get`/`getPage`/`paginate`) and the
 * bounded `write` verb are the exact surface the publisher, reader, and doctor
 * already call on the GitHub client, so it satisfies this interface unchanged.
 * `provider` lets a caller branch the ONE genuinely provider-varying decision
 * (commit check-run vs commit status) without a downcast.
 */
export interface ForgeClient {
	/** The forge this client talks to. */
	readonly provider: Provider;

	/** A single bounded GET with timeout/retries/rate-limit handling. */
	get<T>(pathOrUrl: string): Promise<ForgeResponse<T>>;

	/**
	 * Fetch one page and expose the parsed body plus the `next` page URL, without
	 * concatenating or interpreting the body shape. Dedupe scans drive a bounded,
	 * shape-validating loop over this so a truncated result is never read as proof
	 * of absence. GitHub derives `next` from the `Link` header; Forgejo derives it
	 * from `page`, `limit`, and `X-Total-Count`.
	 */
	getPage<T>(pathOrUrl: string): Promise<ForgePage<T>>;

	/** Follow pagination, concatenating array pages up to a hard `maxPages` bound. */
	paginate<T>(pathOrUrl: string, maxPages?: number): Promise<T[]>;

	/**
	 * One bounded JSON write (POST/PATCH/PUT/DELETE). The body must already be
	 * bounded by the caller; a non-2xx after retries throws a bounded error that
	 * never contains the token or the request body.
	 */
	write<T>(
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		pathOrUrl: string,
		body?: unknown,
	): Promise<ForgeResponse<T>>;

	/**
	 * Upsert the single exact-SHA commit check, provider-correct: a GitHub
	 * check-run (POST/PATCH `/check-runs`) or a Forgejo commit status (POST
	 * `/statuses/{sha}` with the stable context). Returns the outcome the durable
	 * publisher records; a dedupe scan that cannot prove absence stays retryable.
	 *
	 * `terminal: true` on a failure says the provider PROVED this write
	 * can never succeed — a 404 for a (repository, sha) pair the forge does not
	 * hold. The publisher fails such a row immediately instead of rescheduling it
	 * until the attempt budget is spent. Only this boundary, which saw the
	 * response status, may make that call.
	 */
	postCommitCheck(
		repository: string,
		check: CommitCheck,
	): Promise<
		| { status: "posted" | "deduped"; externalRef?: string }
		| { status: "failed"; reason: string; terminal?: boolean }
	>;

	/**
	 * Read-only dedupe lookup used by shadow publication. It must prove the
	 * provider's full status/check-run set was consumed before returning absent.
	 */
	findCommitCheck(repository: string, check: CommitCheck): Promise<CommitCheckLookup>;

	/**
	 * Open the change proposal for an already-pushed branch, or report the
	 * existing one. Optional on purpose: a forge that cannot host code — or
	 * one the operator has not authorized to receive proposals — simply omits it,
	 * and the publisher treats its absence as "this provider cannot receive a
	 * change" rather than assuming a REST shape that may not exist. Only a client
	 * that implements this can ever have a change published to it.
	 *
	 * Implementations MUST be idempotent on `headBranch`: a re-publish returns
	 * `deduped` for the existing proposal instead of opening a second one.
	 */
	openChangeProposal?(repository: string, proposal: ChangeProposal): Promise<ChangeProposalOutcome>;
}

/**
 * A bounded request to open a change proposal (a pull request) for a branch the
 * watcher has ALREADY pushed. Every field is watcher-derived: `headBranch` comes
 * from the watcher's own `rw/`-prefixed naming, never from runner output, and the
 * text is bounded before it reaches the forge.
 */
export interface ChangeProposal {
	/** The watcher-derived source branch, always within the reserved prefix. */
	headBranch: string;
	/** The target branch the proposal merges into. */
	baseBranch: string;
	title: string;
	body: string;
	/** The issue this change implements, linked for traceability. */
	itemNumber: number;
	/**
	 * Whether the forge should mark this proposal as not-ready-to-merge natively.
	 * Forgejo 16.0.1 has NO `draft` field on its create-PR payload (verified
	 * against the deployed swagger), so a client that cannot express draft state
	 * natively MUST fall back to an explicit in-band marker — a `WIP:` title
	 * prefix and/or a work-in-progress label — and report `draftMode` below so the
	 * caller records which guarantee it actually got. The real merge guarantee is
	 * server-side branch protection, never this flag.
	 */
	draft: boolean;
}

/**
 * How the "not ready to merge" intent was actually honoured. Recorded so an
 * operator can tell a NATIVE draft (the forge itself blocks merging) from a
 * CONVENTION marker (a title prefix a human could merge straight past) — the
 * distinction that decides how much the marker can be trusted.
 */
export type DraftMode = "native" | "wip-marker" | "none";

/** The outcome of opening a change proposal. */
export type ChangeProposalOutcome =
	| { status: "opened"; number: number; url: string; draftMode: DraftMode }
	| { status: "deduped"; number: number; url: string }
	| { status: "failed"; reason: string };
