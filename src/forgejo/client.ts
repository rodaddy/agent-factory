/**
 * @module forgejo/client
 * @description Minimal read/write Forgejo 16 (Gitea-compatible `/api/v1`) client
 *   for the watcher. It mirrors the bounded transport posture of the GitHub
 *   client — injectable `fetch`, explicit per-request timeout, bounded retries
 *   with backoff, a single bounded `write` seam, and a fail-closed `getPage`
 *   loop — but speaks FORGEJO's wire contract, never GitHub's:
 *
 *     - Auth is `Authorization: token <token>` (Forgejo/Gitea), NEVER GitHub's
 *       `Bearer`. There is NO `X-GitHub-Api-Version` and NO `application/
 *       vnd.github+json` Accept. The token is a SEPARATE credential from the
 *       GitHub token and is never logged.
 *     - Pagination follows Forgejo 16's `page` + `limit` query contract and
 *       `X-Total-Count`. Collection reads require a valid count and fail closed
 *       when page contents cannot reconcile with it.
 *     - The exact-SHA commit check is a Forgejo COMMIT STATUS
 *       (`POST /repos/{o}/{r}/statuses/{sha}`) keyed by a bounded, stable context
 *       derived from the logical check context and dedupe key, not a GitHub
 *       check-run. The dedupe read looks up that exact context and an existing
 *       status makes a retry read-only.
 *
 *   The client satisfies the narrow `ForgeClient` boundary UNCHANGED in shape, so
 *   the publisher/reader/doctor drive it through the same verbs they drive the
 *   GitHub client through; only the endpoints and the commit-check kind differ.
 *
 * @outputs
 *   - `ForgejoClient` -- the bounded Forgejo read/write client
 *   - `createForgejoClient` -- construct one from a token + options
 *   - `ForgejoClientOptions` -- supporting options
 *
 * @dependencies
 *   - ../forge/boundary -- the narrow forge contract this client satisfies
 */
import { createHash } from "node:crypto";
import type {
	ChangeProposal,
	ChangeProposalOutcome,
	CommitCheck,
	CommitCheckLookup,
	ForgeClient,
	ForgePage,
	ForgeResponse,
} from "../forge/boundary";
import type { Provider } from "../forge/provider";
import { errorClass, log, traced } from "../log";
import {
	type PullRequestMergeState,
	pullRequestMergeStateOf,
	type RawForgejoPullState,
} from "./pull-state";

/** How a pull request should be landed, and what to do with its branch after. */
export interface MergePullRequestOptions {
	/** Forgejo's `Do` strategy. Defaults to `squash`. */
	method?: "squash" | "merge" | "rebase";
	/** Whether the head branch is removed after a successful merge. Defaults to true. */
	deleteBranchAfterMerge?: boolean;
	/** Optional merge commit title; omitted entirely when not supplied. */
	title?: string;
	/** Optional merge commit message body; omitted entirely when not supplied. */
	message?: string;
}

/**
 * The typed outcome of a merge attempt. A refusal is a RESULT, not an
 * exception: `not-mergeable` (405) and `conflict` (409) are ordinary states a
 * lander branches on, and `error` carries whatever status the forge gave (or
 * `null` when the failure was a network fault that never reached it).
 */
export type MergePullRequestResult =
	| { merged: true; sha: string }
	| { merged: false; reason: "not-mergeable" | "conflict" | "error"; status: number | null };

export type { PullRequestMergeState } from "./pull-state";

/** Injectable fetch signature (matches the global `fetch`). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface ForgejoClientOptions {
	/** Validated API base supplied by runtime composition. */
	baseUrl: string;
	/** Per-request timeout in milliseconds. */
	timeoutMs?: number;
	/** Maximum retry attempts for transient failures (5xx/network/timeout). */
	maxRetries?: number;
	/** Base backoff in milliseconds; grows with the attempt number. */
	backoffMs?: number;
	/** Transport seam for tests. Defaults to the global fetch. */
	fetch?: FetchLike;
	/** Sleep seam so tests do not wait on real backoff. */
	sleep?: (ms: number) => Promise<void>;
}

const DEFAULTS = {
	timeoutMs: 10_000,
	maxRetries: 3,
	backoffMs: 500,
};

/** Hard ceiling (ms) on any single backoff/retry sleep, however derived. */
const MAX_BACKOFF_MS = 60_000;

/** The fixed Forgejo commit-status states, mapped from the boundary conclusion. */
const FORGEJO_STATUS_STATE: Record<CommitCheck["conclusion"], string> = {
	success: "success",
	failure: "failure",
	neutral: "warning",
};

/**
 * Non-retryable HTTP marker so the retry loop can tell a definitive HTTP failure
 * apart from a transient network/timeout error. Carries only the status code and
 * a FIXED reason suffix, never body text.
 */
class ForgejoHttpError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
		this.name = "ForgejoHttpError";
	}
}

/**
 * sf#851: Forgejo answers DELETE of an undefined label with 422 "label does not
 * exist"; that one 422 gets a FIXED suffix so `isAbsentLabelError` can tell it
 * from any other 422. The body is only tested, never echoed.
 */
async function httpErrorOf(res: Response): Promise<ForgejoHttpError> {
	const error = new ForgejoHttpError(res.status);
	const body = res.status === 422 ? await res.text().catch(() => "") : "";
	if (body.includes("label does not exist")) error.message += ": label does not exist";
	return error;
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Parse a numeric header value, or null when absent/invalid. */
function numberOrNull(value: string | null): number | null {
	if (value === null || !/^\d+$/.test(value)) {
		return null;
	}
	const n = Number(value);
	return Number.isSafeInteger(n) ? n : null;
}

/** Bounded Forgejo read/write client. Construct via `createForgejoClient`. */
export class ForgejoClient implements ForgeClient {
	readonly provider: Provider = "forgejo";
	private readonly token: string;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;
	private readonly backoffMs: number;
	private readonly fetchImpl: FetchLike;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(token: string, opts: ForgejoClientOptions) {
		this.token = token;
		this.baseUrl = opts.baseUrl.replace(/\/$/, "");
		this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
		this.maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
		this.backoffMs = Math.min(Math.max(0, opts.backoffMs ?? DEFAULTS.backoffMs), MAX_BACKOFF_MS);
		this.fetchImpl = opts.fetch ?? (globalThis.fetch as FetchLike);
		this.sleep = opts.sleep ?? defaultSleep;
	}

	/** Absolute-or-relative path -> absolute URL against the API base. */
	private resolve(pathOrUrl: string): string {
		if (pathOrUrl.startsWith("http://") || pathOrUrl.startsWith("https://")) {
			return pathOrUrl;
		}
		return `${this.baseUrl}${pathOrUrl.startsWith("/") ? "" : "/"}${pathOrUrl}`;
	}

	async get<T>(pathOrUrl: string): Promise<ForgeResponse<T>> {
		const { response } = await this.request<T>("GET", pathOrUrl);
		return response;
	}

	async write<T>(
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		pathOrUrl: string,
		body?: unknown,
	): Promise<ForgeResponse<T>> {
		const { response } = await this.request<T>(method, pathOrUrl, body);
		return response;
	}

	/**
	 * Shared request path for reads and bounded writes. Returns the parsed forge
	 * response PLUS the raw `X-Total-Count` header (Forgejo reports the full
	 * collection size there), so `getPage` can fail closed on an incomplete page
	 * without a second request. `get`/`write` discard the count.
	 */
	private async request<T>(
		method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
		pathOrUrl: string,
		body?: unknown,
	): Promise<{ response: ForgeResponse<T>; totalCount: number | null }> {
		const url = this.resolve(pathOrUrl);
		const serialized = body === undefined ? undefined : JSON.stringify(body);
		// POST is not idempotent for a create: an ambiguous failure may mean Forgejo
		// accepted it, so the durable publisher must re-scan its marker before another
		// create. (A commit status POST is context-idempotent, but the transport is
		// kept uniform with the GitHub client and never blind-retries a POST.)
		const mayRetry = method !== "POST";
		let lastError = "request failed";

		for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
			const outcome = await this.attemptRequest<T>({
				method,
				url,
				serialized,
				mayRetry,
				attempt,
			});
			if (!("retry" in outcome)) {
				return outcome;
			}
			lastError = outcome.retry;
		}
		throw new Error(`Forgejo request failed: ${lastError}`);
	}

	/** The fixed Forgejo request headers, plus JSON content type only when there is a body. */
	private requestHeaders(serialized: string | undefined): Record<string, string> {
		const headers: Record<string, string> = {
			// Forgejo/Gitea token auth — NEVER GitHub's Bearer. No GitHub headers.
			Authorization: `token ${this.token}`,
			Accept: "application/json",
			"User-Agent": "software-factory",
		};
		if (serialized !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		return headers;
	}

	/**
	 * One attempt of the shared request path. Returns the bounded response on
	 * success, or `{ retry: lastError }` when the caller should try again. Throws
	 * for a non-retryable HTTP status or an exhausted retry budget, so the loop in
	 * `request` never has to decide what is fatal.
	 */
	private async attemptRequest<T>(args: {
		method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
		url: string;
		serialized: string | undefined;
		mayRetry: boolean;
		attempt: number;
	}): Promise<{ response: ForgeResponse<T>; totalCount: number | null } | { retry: string }> {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), this.timeoutMs);
		try {
			const res = await this.fetchImpl(args.url, {
				method: args.method,
				headers: this.requestHeaders(args.serialized),
				body: args.serialized,
				signal: controller.signal,
			});
			clearTimeout(timer);

			if (args.mayRetry && this.isRetryable(res) && args.attempt < this.maxRetries) {
				await this.sleep(this.retryDelay(res, args.attempt));
				return { retry: `HTTP ${res.status}` };
			}

			if (!res.ok) {
				throw await httpErrorOf(res);
			}

			const data = (await this.parseBody(res)) as T;
			return {
				response: {
					status: res.status,
					data,
					link: res.headers.get("link"),
					// Forgejo does not report a GitHub-style primary rate remaining.
					rateRemaining: null,
				},
				totalCount: numberOrNull(res.headers.get("x-total-count")),
			};
		} catch (err) {
			clearTimeout(timer);
			if (err instanceof ForgejoHttpError) {
				throw new Error(`Forgejo request failed: ${err.message}`);
			}
			const lastError =
				err instanceof Error && err.name === "AbortError" ? "request timed out" : "network error";
			if (args.mayRetry && args.attempt < this.maxRetries) {
				await this.sleep(Math.min(this.backoffMs * (args.attempt + 1), MAX_BACKOFF_MS));
				return { retry: lastError };
			}
			throw new Error(`Forgejo request failed: ${lastError}`);
		}
	}

	/** Parse a JSON body, tolerating an empty (204/no-content) response. */
	private async parseBody(res: Response): Promise<unknown> {
		if (res.status === 204) {
			return null;
		}
		const text = await res.text();
		if (text.length === 0) {
			return null;
		}
		try {
			return JSON.parse(text);
		} catch (err) {
			// A 2xx whose body will not parse yields a null body, which the fail-closed
			// page/dedupe loops reject rather than read as complete — record the
			// degradation. Only the error CLASS: a parse error can quote the body, which
			// came back over a token-authenticated request. Never the body text.
			log("warn", "forgejo.client.body_unparseable", {
				status: res.status,
				bytes: text.length,
				error_class: errorClass(err),
			});
			return null;
		}
	}

	/**
	 * Follow Forgejo's count-derived page traversal, concatenating array pages up
	 * to `maxPages`. The concatenating helper is used only where a COMPLETE
	 * enumeration is acceptable (the incremental item read, which advances a cursor
	 * only after the whole repo succeeds). Fail-closed dedupe scans use `getPage`.
	 */
	async paginate<T>(pathOrUrl: string, maxPages = 20): Promise<T[]> {
		const out: T[] = [];
		let next: string | null = pathOrUrl;
		let pages = 0;
		while (next && pages < maxPages) {
			const currentPage: ForgePage<T[]> = await this.getPage<T[]>(next);
			if (!Array.isArray(currentPage.body)) {
				// A non-array body cannot be a page of items — fail closed rather than
				// silently returning a short list that could look like an exhausted scan.
				throw new Error("Forgejo paginate: page body was not an array");
			}
			out.push(...currentPage.body);
			next = currentPage.next;
			pages++;
		}
		if (next !== null) {
			throw new Error("Forgejo paginate: page bound reached with pages remaining");
		}
		return out;
	}

	/**
	 * Fetch one page and derive the next `page` URL from the current `page`,
	 * `limit`, and Forgejo's `X-Total-Count`. Array-shaped collection responses
	 * require a valid count; missing/invalid counts and impossible page/count
	 * combinations fail closed instead of being read as complete.
	 *
	 * The concatenation and shape validation stay in the caller (mirroring the
	 * GitHub client's `getPage`), so the byte cap, JSON parse, and per-entry shape
	 * checks the publisher already runs are unchanged for Forgejo.
	 */
	async getPage<T>(pathOrUrl: string): Promise<ForgePage<T>> {
		const { response, totalCount } = await this.request<T>("GET", pathOrUrl);
		if (!Array.isArray(response.data)) {
			return { body: response.data, next: null };
		}
		if (totalCount === null) {
			throw new Error("Forgejo collection response missing valid X-Total-Count");
		}
		const current = new URL(this.resolve(pathOrUrl));
		const page = positiveIntParam(current, "page", 1);
		const limit = positiveIntParam(current, "limit", 50);
		const consumedBefore = (page - 1) * limit;
		const consumed = consumedBefore + response.data.length;
		if (consumed > totalCount || (response.data.length === 0 && consumedBefore < totalCount)) {
			throw new Error("Forgejo collection response X-Total-Count mismatch");
		}
		if (consumed === totalCount) {
			return { body: response.data, next: null, totalCount };
		}
		current.searchParams.set("limit", String(limit));
		current.searchParams.set("page", String(page + 1));
		return { body: response.data, next: current.toString(), totalCount };
	}

	/** Which non-2xx responses are transient and worth retrying (idempotent verbs). */
	private isRetryable(res: Response): boolean {
		const status = res.status;
		if (status === 429 || (status >= 500 && status <= 599)) {
			return true;
		}
		// Forgejo returns 429 with Retry-After for rate limiting; a 403 here is a
		// genuine authorization failure and must fail fast, not churn the budget.
		return false;
	}

	/** Honor Retry-After when given; else exponential, capped at the ceiling. */
	private retryDelay(res: Response, attempt: number): number {
		const retryAfter = numberOrNull(res.headers.get("retry-after"));
		if (retryAfter !== null) {
			return Math.min(Math.max(0, retryAfter * 1000), MAX_BACKOFF_MS);
		}
		return Math.min(this.backoffMs * (attempt + 1), MAX_BACKOFF_MS);
	}

	/**
	 * Upsert the single exact-SHA commit check for Forgejo as a COMMIT STATUS.
	 * Dedupe by the bounded status context derived from the logical context and
	 * durable dedupe key: list the commit's statuses (fail-closed on a truncated or
	 * malformed scan) and return read-only when that exact context exists. POST
	 * exactly once only after absence is PROVEN over a complete scan.
	 *
	 * A 404 from either the dedupe read or the POST is reported TERMINAL.
	 * `/repos/{repo}/statuses/{sha}` answers 404 when the repository does not hold
	 * that commit, and no amount of retrying makes a repository grow a commit it
	 * does not have — so rescheduling only burns the attempt budget and fills
	 * `github_postings` with permanently-failing rows (263 failed / 91 posted in
	 * production before the verb check was redirected to the repository that owns
	 * the sha). Every other failure stays retryable, unchanged.
	 */
	async postCommitCheck(
		repository: string,
		check: CommitCheck,
	): Promise<
		| { status: "posted" | "deduped"; externalRef?: string }
		| { status: "failed"; reason: string; terminal?: boolean }
	> {
		const statusContext = forgejoStatusContext(check);
		let existing: CommitCheckLookup;
		try {
			existing = await this.findCommitStatus(repository, check.sha, statusContext);
		} catch (error) {
			return {
				status: "failed",
				reason: error instanceof Error ? error.message : "status dedupe failed",
				...(isNotFound(error) ? { terminal: true } : {}),
			};
		}
		if (existing.status === "indeterminate") {
			return { status: "failed", reason: `status dedupe indeterminate: ${existing.reason}` };
		}
		if (existing.status === "found") {
			return { status: "deduped", externalRef: statusContext };
		}
		try {
			// POST /repos/{owner}/{repo}/statuses/{sha}. The body is fully bounded:
			// fixed context, mapped state, and the bounded title/summary as description.
			await this.write(`POST`, `/repos/${repository}/statuses/${check.sha}`, {
				context: statusContext,
				state: FORGEJO_STATUS_STATE[check.conclusion],
				description: capDescription(`${check.title} — ${check.summary}`),
			});
		} catch (error) {
			return {
				status: "failed",
				reason: error instanceof Error ? error.message : "status write failed",
				...(isNotFound(error) ? { terminal: true } : {}),
			};
		}
		return { status: "posted", externalRef: statusContext };
	}

	async findCommitCheck(repository: string, check: CommitCheck): Promise<CommitCheckLookup> {
		return this.findCommitStatus(repository, check.sha, forgejoStatusContext(check));
	}

	/**
	 * Open the change proposal for an already-pushed `rw/` branch.
	 *
	 * Forgejo 16.0.1 exposes `POST /repos/{owner}/{repo}/pulls`, but its
	 * `CreatePullRequestOption` has NO `draft` field (verified against the
	 * deployed swagger at forge.example.internal). So "not ready to merge" is expressed
	 * as a `WIP:` title prefix — the marker Forgejo's own UI recognises — and the
	 * outcome reports `wip-marker`, never `native`, so no caller can mistake a
	 * convention for an enforced block. The REAL guarantee that this cannot be
	 * merged by the runner is server-side branch protection, which is why
	 * `mergePullRequest` below is safe to expose: the forge, not this client,
	 * decides whether a merge is permitted.
	 *
	 * Dedupe is a PROVEN existing-proposal check first: `GET /pulls/{base}/{head}`
	 * resolves an open proposal for the exact branch pair, so a re-publish updates
	 * nothing and opens nothing. A dedupe read that FAILS is reported as failed
	 * rather than proceeding — opening a duplicate proposal is worse than
	 * retrying.
	 */
	async openChangeProposal(
		repository: string,
		proposal: ChangeProposal,
	): Promise<ChangeProposalOutcome> {
		// Prove absence before creating. An error here is NOT absence: fail
		// retryably rather than risk a second proposal for the same branch.
		try {
			const existing = await this.get<RawForgejoPullRef>(
				`/repos/${repository}/pulls/${encodeURIComponent(proposal.baseBranch)}/${encodeURIComponent(proposal.headBranch)}`,
			);
			const found = existing.data;
			if (found && typeof found.number === "number") {
				return {
					status: "deduped",
					number: found.number,
					url: typeof found.html_url === "string" ? found.html_url : "",
				};
			}
		} catch (error) {
			// A 404 is the expected "no such proposal" answer and is the ONLY
			// error that means absence. Anything else leaves absence unproven.
			if (!isNotFound(error)) {
				return {
					status: "failed",
					reason: error instanceof Error ? error.message : "proposal dedupe failed",
				};
			}
		}

		// Forgejo cannot mark a PR as draft natively, so the WIP intent rides in
		// the title. The prefix is applied here (not by the caller) so every
		// Forgejo proposal is marked consistently.
		const title = proposal.draft ? `WIP: ${proposal.title}` : proposal.title;
		try {
			const created = await this.write<RawForgejoPullRef>("POST", `/repos/${repository}/pulls`, {
				head: proposal.headBranch,
				base: proposal.baseBranch,
				title: capTitle(title),
				body: capBody(proposal.body),
			});
			const number = created.data?.number;
			if (typeof number !== "number") {
				// A 2xx without a usable number means we cannot record or dedupe this
				// proposal later. Report failure rather than claim an opaque success.
				return { status: "failed", reason: "proposal created without a usable number" };
			}
			return {
				status: "opened",
				number,
				url: typeof created.data?.html_url === "string" ? created.data.html_url : "",
				draftMode: proposal.draft ? "wip-marker" : "none",
			};
		} catch (error) {
			return {
				status: "failed",
				reason: error instanceof Error ? error.message : "proposal write failed",
			};
		}
	}

	/**
	 * Merge an open pull request. The factory owns the forge, so landing
	 * is a first-class verb here — but the MERGE GUARD is server-side branch
	 * protection, never this method: Forgejo refuses a merge this client is
	 * not permitted to make, and that refusal arrives as a bounded status.
	 *
	 * The write goes through the same bounded `write` seam every other write uses
	 * (timeout, no blind POST retry, token never logged) — no raw fetch. Forgejo
	 * answers 200 on success, 405 when the pull is not in a mergeable state, and
	 * 409 on conflict; the transport turns each non-2xx into a bounded `Error`
	 * carrying only the status, so those are classified into a typed result
	 * instead of thrown. A caller landing a change must be able to branch on
	 * "not yet" without a try/catch that cannot tell 409 from a network fault.
	 *
	 * A 200 whose body carries no usable SHA is reported as `error`, not as a
	 * merge: an opaque success is indistinguishable from a lie downstream.
	 */
	async mergePullRequest(
		repository: string,
		number: number,
		opts: MergePullRequestOptions = {},
	): Promise<MergePullRequestResult> {
		const body: Record<string, unknown> = {
			Do: opts.method ?? "squash",
			delete_branch_after_merge: opts.deleteBranchAfterMerge ?? true,
		};
		// Message fields are sent ONLY when the caller supplies them, so Forgejo
		// keeps its own default commit message rather than receiving an empty one.
		if (opts.title !== undefined) {
			body.MergeTitleField = capTitle(opts.title);
		}
		if (opts.message !== undefined) {
			body.MergeMessageField = capBody(opts.message);
		}

		let response: ForgeResponse<RawForgejoMergeResult>;
		try {
			response = await this.write<RawForgejoMergeResult>(
				"POST",
				`/repos/${repository}/pulls/${number}/merge`,
				body,
			);
		} catch (error) {
			const status = httpStatusOf(error);
			if (status === 405) {
				return { merged: false, reason: "not-mergeable", status };
			}
			if (status === 409) {
				return { merged: false, reason: "conflict", status };
			}
			return { merged: false, reason: "error", status };
		}

		const sha = response.data?.sha;
		if (typeof sha !== "string" || sha.length === 0) {
			return { merged: false, reason: "error", status: response.status };
		}
		return { merged: true, sha };
	}

	/**
	 * Read whether a pull request has landed and, if so, the commit it landed as
	 * (`scripts/land.ts`). Forgejo reports both on `GET /pulls/{number}`
	 * as `merged` and `merge_commit_sha`. Both fields are shape-checked rather
	 * than trusted: anything that is not a literal `true` reads as not merged, and
	 * a missing/blank SHA reads as `null`, so a malformed body can never be
	 * mistaken for a proven landing.
	 */
	async getPullRequestMergeState(
		repository: string,
		number: number,
	): Promise<PullRequestMergeState> {
		const response = await this.get<RawForgejoPullState>(`/repos/${repository}/pulls/${number}`);
		return pullRequestMergeStateOf(response.data);
	}

	/**
	 * Look up an existing commit status for `sha` carrying the stable `context`,
	 * newest-first, through a bounded number of pages. `found` proves the context
	 * already has a status; `absent` is proven only over a well-formed, fully
	 * consumed scan; a count mismatch or malformed page yields
	 * `indeterminate` so the caller refuses to treat absence as proven.
	 */
	private async findCommitStatus(
		repository: string,
		sha: string,
		context: string,
	): Promise<CommitCheckLookup> {
		let next: string | null =
			`/repos/${repository}/commits/${sha}/statuses?limit=50&page=1&sort=recentupdate`;
		let pages = 0;
		while (next && pages < 10) {
			const page: ForgePage<unknown> = await this.getPage<unknown>(next);
			if (!Array.isArray(page.body)) {
				return { status: "indeterminate", reason: "status list body was not an array" };
			}
			for (const entry of page.body as Array<{ context?: unknown }>) {
				if (typeof entry.context !== "string") {
					return { status: "indeterminate", reason: "status entry had an invalid shape" };
				}
				if (entry.context === context) {
					return { status: "found", ref: context };
				}
			}
			next = page.next;
			pages++;
		}
		if (next) {
			// Hit the page bound with more pages remaining: absence is unproven.
			return { status: "indeterminate", reason: "status scan truncated or incomplete" };
		}
		return { status: "absent" };
	}
}

/** Read a positive integer query parameter, using `fallback` only when absent. */
function positiveIntParam(url: URL, name: string, fallback: number): number {
	const raw = url.searchParams.get(name);
	if (raw === null) {
		return fallback;
	}
	if (!/^\d+$/.test(raw)) {
		throw new Error(`Forgejo pagination has invalid ${name}`);
	}
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error(`Forgejo pagination has invalid ${name}`);
	}
	return parsed;
}

/** Cap a Forgejo commit-status description to a safe bound with an ellipsis. */
function capDescription(value: string): string {
	const max = 255;
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Cap a change-proposal title. Bounded before it ever reaches the forge. */
function capTitle(value: string): string {
	const max = 255;
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Cap a change-proposal body. The runner's summary is already bounded by the
 * result schema; this is defence-in-depth at the write boundary.
 */
function capBody(value: string): string {
	const max = 60_000;
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Whether an error is a proven 404. The transport converts `ForgejoHttpError`
 * into a plain `Error` whose message carries the status, so the status is
 * matched on that fixed message shape. Only a 404 may be read as "absent"; any
 * other failure leaves absence UNPROVEN and must not license a create.
 */
function isNotFound(error: unknown): boolean {
	return error instanceof Error && /Forgejo request failed: HTTP 404\b/.test(error.message);
}

/** The bounded fields the watcher reads back from a Forgejo pull reference. */
interface RawForgejoPullRef {
	number?: unknown;
	html_url?: unknown;
}

/** The bounded fields read back from a Forgejo merge response. */
interface RawForgejoMergeResult {
	sha?: unknown;
}

/**
 * Extract the HTTP status from a bounded transport error. `attemptRequest`
 * flattens `ForgejoHttpError` into a plain `Error` whose message is the fixed
 * `Forgejo request failed: HTTP <status>` shape, so the status is matched on
 * that shape — the same contract `isNotFound` relies on. A network error or a
 * timeout carries no status and yields `null`, which callers must NOT read as
 * any particular refusal.
 */
function httpStatusOf(error: unknown): number | null {
	if (!(error instanceof Error)) {
		return null;
	}
	const match = /Forgejo request failed: HTTP (\d{3})\b/.exec(error.message);
	return match ? Number(match[1]) : null;
}

/**
 * Build the exact Forgejo commit-status identity for one durable publication.
 * Output is ASCII-safe, visibly watcher-owned, stable across retries, and capped
 * below Forgejo's 255-character context limit. Framing both inputs into the hash
 * prevents ambiguous concatenations while the readable segment preserves the
 * operator-recognizable logical check name.
 */
function forgejoStatusContext(check: Pick<CommitCheck, "context" | "dedupeKey">): string {
	const prefix = "software-factory/";
	const readable =
		check.context
			.replace(/^software-factory[/:_-]*/i, "")
			.replace(/[^A-Za-z0-9._/-]+/g, "-")
			.replace(/^[-./]+|[-./]+$/g, "") || "check";
	const digest = createHash("sha256")
		.update(`${check.context.length}:${check.context}${check.dedupeKey.length}:${check.dedupeKey}`)
		.digest("hex")
		.slice(0, 16);
	const suffix = `/${digest}`;
	const max = 255;
	return `${prefix}${readable.slice(0, max - prefix.length - suffix.length)}${suffix}`;
}

/** Construct the bounded Forgejo read/write client for the given token. */
export const createForgejoClient = traced(
	"forgejo.createForgejoClient",
	function createForgejoClient(token: string, opts: ForgejoClientOptions): ForgejoClient {
		return new ForgejoClient(token, opts);
	},
	{ redact: { args: [0] } },
);
