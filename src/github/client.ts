/**
 * @module github/client
 * @description Minimal read-only GitHub REST client for the watcher. Handles
 *   authentication headers, explicit request timeouts, bounded retries with
 *   backoff, secondary/primary rate-limit responses, and Link-header
 *   pagination. The transport (`fetch`) is injectable so tests exercise
 *   observable behavior against fakes rather than the network. Reads are
 *   unrestricted; the single bounded `write` seam exists only for the
 *   approved GitHub publication operations (labels/comments/checks) — the caller
 *   supplies an already-bounded JSON body. Tokens are never logged.
 *
 * @outputs
 *   - `GitHubClient` -- read client with `get` and `paginate`, plus bounded `write`
 *   - `createGitHubClient` -- construct a client from a token + options
 *   - `GitHubClientOptions` / `GitHubResponse` -- supporting types
 *
 * @dependencies
 *   - ./credentials -- token resolution happens upstream; a token is passed in
 *   - ../forge/boundary -- the narrow forge contract this client satisfies
 *     UNCHANGED (its read/write surface already matches), plus the commit-check
 *     seam (`postCommitCheck`) it fulfils with GitHub check-runs
 *   - ../log -- structured logging, and the traced() wrapper
 */
import type {
	ChangeProposal,
	ChangeProposalOutcome,
	CommitCheck,
	CommitCheckLookup,
	ForgeClient,
	ForgePage,
	ForgeResponse,
} from "../forge/boundary";
import { type Provider, providerApiBase } from "../forge/provider";
import { errorClass, log, traced } from "../log";

/** Injectable fetch signature (matches the global `fetch`). */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface GitHubClientOptions {
	/** API base; defaults to public GitHub. */
	baseUrl?: string;
	/** Per-request timeout in milliseconds. */
	timeoutMs?: number;
	/** Maximum retry attempts for transient failures (rate-limit/5xx/network). */
	maxRetries?: number;
	/** Base backoff in milliseconds; grows with the attempt number. */
	backoffMs?: number;
	/** Transport seam for tests. Defaults to the global fetch. */
	fetch?: FetchLike;
	/** Sleep seam so tests do not wait on real backoff. */
	sleep?: (ms: number) => Promise<void>;
}

/**
 * A successful read response with parsed body and useful headers. This is the
 * shared forge response shape — the boundary reuses the exact structure the
 * GitHub client already returns, so nothing about the GitHub read/write surface
 * changes when the client satisfies `ForgeClient`.
 */
export type GitHubResponse<T> = ForgeResponse<T>;

/** The fail-closed arm of a check-run dedupe scan, shared with `postCommitCheck`. */
type ResolveCheckFailure = { status: "failed"; reason: string };

/** Internal marker for a non-retryable HTTP status so the retry loop can tell a
 * definitive HTTP failure apart from a transient network/timeout error. Carries
 * only the status code — never the body or token. */
class GitHubHttpError extends Error {
	constructor(readonly status: number) {
		super(`HTTP ${status}`);
		this.name = "GitHubHttpError";
	}
}

const DEFAULTS = {
	// The endpoint lives in exactly one place — the reviewed, author-controlled
	// `PROVIDER_HOSTS` table in forge/provider — so a base URL can never
	// be re-declared here and drift from the one the remote parser accepts.
	baseUrl: providerApiBase("github"),
	timeoutMs: 10_000,
	maxRetries: 3,
	backoffMs: 500,
};

/** Hard ceiling (ms) on any single backoff/retry sleep, however it is derived. */
const MAX_BACKOFF_MS = 60_000;

/** Parse the `next` URL out of a GitHub `Link` header, if present. */
export const parseNextLink = traced(
	"github.parseNextLink",
	function parseNextLink(link: string | null): string | null {
		if (!link) {
			return null;
		}
		for (const part of link.split(",")) {
			const match = part.match(/<([^>]+)>\s*;\s*rel="next"/);
			if (match?.[1]) {
				return match[1];
			}
		}
		return null;
	},
);

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Bounded GitHub read/publication client. Construct via `createGitHubClient`. */
export class GitHubClient implements ForgeClient {
	/** The forge this client talks to. Fixed for a GitHub client. */
	readonly provider: Provider = "github";
	private readonly token: string;
	private readonly baseUrl: string;
	private readonly timeoutMs: number;
	private readonly maxRetries: number;
	private readonly backoffMs: number;
	private readonly fetchImpl: FetchLike;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(token: string, opts: GitHubClientOptions = {}) {
		this.token = token;
		this.baseUrl = (opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/$/, "");
		this.timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
		this.maxRetries = opts.maxRetries ?? DEFAULTS.maxRetries;
		// Clamp the configurable base backoff to the hard ceiling so a large value
		// can never schedule a multi-minute sleep, even before the per-attempt growth.
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

	/**
	 * Perform a single GET with timeout, retries, and rate-limit handling.
	 *
	 * @param pathOrUrl - API path (e.g. `/repos/o/r/issues`) or absolute URL
	 * @returns the parsed response, or throws a bounded Error after retries
	 */
	async get<T>(pathOrUrl: string): Promise<GitHubResponse<T>> {
		return this.request<T>("GET", pathOrUrl);
	}

	/**
	 * Perform a single bounded JSON write (POST/PATCH/PUT/DELETE). Idempotent verbs
	 * use the read retry policy; POST never retries in-transport because an ambiguous
	 * failure may follow a successful remote create. The body must already be bounded
	 * by the caller. On a non-2xx after retries, the thrown error is
	 * bounded (status only) and never contains the token or the request body.
	 *
	 * @param method - the write verb
	 * @param pathOrUrl - API path or absolute URL
	 * @param body - a small, already-bounded JSON-serializable payload
	 */
	async write<T>(
		method: "POST" | "PATCH" | "PUT" | "DELETE",
		pathOrUrl: string,
		body?: unknown,
	): Promise<GitHubResponse<T>> {
		return this.request<T>(method, pathOrUrl, body);
	}

	/** The fixed request headers, plus the JSON content type only when there is a body. */
	private requestHeaders(serialized: string | undefined): Record<string, string> {
		const headers: Record<string, string> = {
			Authorization: `Bearer ${this.token}`,
			Accept: "application/vnd.github+json",
			"X-GitHub-Api-Version": "2022-11-28",
			"User-Agent": "software-factory",
		};
		if (serialized !== undefined) {
			headers["Content-Type"] = "application/json";
		}
		return headers;
	}

	/**
	 * One attempt of the shared request path. Returns the bounded response on
	 * success, or `{ retry: lastError }` when the caller should sleep and try
	 * again. Throws for a non-retryable HTTP status or an exhausted retry budget,
	 * so the loop in `request` never has to decide what is fatal.
	 */
	private async attemptRequest<T>(args: {
		method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
		url: string;
		serialized: string | undefined;
		mayRetry: boolean;
		attempt: number;
	}): Promise<GitHubResponse<T> | { retry: string }> {
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
				throw new GitHubHttpError(res.status);
			}

			const data = (await this.parseBody(res)) as T;
			return {
				status: res.status,
				data,
				link: res.headers.get("link"),
				rateRemaining: numberOrNull(res.headers.get("x-ratelimit-remaining")),
			};
		} catch (err) {
			clearTimeout(timer);
			if (err instanceof GitHubHttpError) {
				// A non-retryable HTTP status: surface it without echoing the body.
				throw new Error(`GitHub request failed: HTTP ${err.status}`);
			}
			const lastError =
				err instanceof Error && err.name === "AbortError" ? "request timed out" : "network error";
			if (args.mayRetry && args.attempt < this.maxRetries) {
				// Grown-by-attempt backoff, capped so no network-retry sleep exceeds the ceiling.
				await this.sleep(Math.min(this.backoffMs * (args.attempt + 1), MAX_BACKOFF_MS));
				return { retry: lastError };
			}
			throw new Error(`GitHub request failed: ${lastError}`);
		}
	}

	/** Shared request path for reads and bounded writes. */
	private async request<T>(
		method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
		pathOrUrl: string,
		body?: unknown,
	): Promise<GitHubResponse<T>> {
		const url = this.resolve(pathOrUrl);
		const serialized = body === undefined ? undefined : JSON.stringify(body);
		// POST is not idempotent: an ambiguous failure may mean GitHub accepted it.
		// The durable publisher must re-scan its remote marker before another create.
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
		throw new Error(`GitHub request failed: ${lastError}`);
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
			// A 2xx whose body will not parse yields a null body, which a dedupe scan
			// reads as an invalid shape and fails closed on — so record the degradation.
			// Only the error CLASS: a parse error can quote the body, which came back
			// over an authenticated request. Never the body text.
			log("warn", "github.client.body_unparseable", {
				status: res.status,
				bytes: text.length,
				error_class: errorClass(err),
			});
			return null;
		}
	}

	/**
	 * Follow `Link: rel="next"` pagination, concatenating array pages.
	 *
	 * @param pathOrUrl - first page path or URL
	 * @param maxPages - hard cap on pages to avoid unbounded loops
	 */
	async paginate<T>(pathOrUrl: string, maxPages = 20): Promise<T[]> {
		const out: T[] = [];
		let next: string | null = pathOrUrl;
		let pages = 0;
		while (next && pages < maxPages) {
			const res: GitHubResponse<T[]> = await this.get<T[]>(next);
			out.push(...res.data);
			next = parseNextLink(res.link);
			pages++;
		}
		return out;
	}

	/**
	 * Fetch a single page and expose the parsed body plus the `next` Link, without
	 * concatenating or interpreting the body shape. Dedupe scans use this to drive
	 * a bounded, shape-validating loop that can tell an exhausted result apart from
	 * a truncated one — silent truncation must never be read as proof of absence.
	 *
	 * @param pathOrUrl - the page path or absolute URL
	 * @returns the raw parsed body and the `next` page URL (null when exhausted)
	 */
	async getPage<T>(pathOrUrl: string): Promise<ForgePage<T>> {
		const res = await this.get<T>(pathOrUrl);
		return { body: res.data, next: parseNextLink(res.link) };
	}

	/**
	 * Which non-2xx responses are transient and worth retrying (idempotent verbs
	 * only — a POST is filtered out before this by `mayRetry`).
	 *
	 * 429 and 5xx are always transient. A 403 is only treated as retryable when
	 * the response itself signals a rate limit — a `Retry-After` header, or a
	 * primary-limit `X-RateLimit-Remaining: 0` — because GitHub returns 403 both
	 * for rate limiting *and* for genuine authorization failures, and a permission
	 * error must fail fast rather than churn the retry budget.
	 */
	private isRetryable(res: Response): boolean {
		const status = res.status;
		if (status === 429 || (status >= 500 && status <= 599)) {
			return true;
		}
		if (status === 403) {
			const retryAfter = numberOrNull(res.headers.get("retry-after"));
			const remaining = numberOrNull(res.headers.get("x-ratelimit-remaining"));
			return retryAfter !== null || remaining === 0;
		}
		return false;
	}

	/** Honor Retry-After / rate-limit reset when given; else exponential. Every
	 * path is capped at MAX_BACKOFF_MS so a hostile header or a distant reset can
	 * never park a request on a multi-minute sleep. */
	private retryDelay(res: Response, attempt: number): number {
		const retryAfter = numberOrNull(res.headers.get("retry-after"));
		if (retryAfter !== null) {
			return Math.min(Math.max(0, retryAfter * 1000), MAX_BACKOFF_MS);
		}
		const remaining = numberOrNull(res.headers.get("x-ratelimit-remaining"));
		const reset = numberOrNull(res.headers.get("x-ratelimit-reset"));
		if (remaining === 0 && reset !== null) {
			// Reset is epoch seconds; bound the wait so tests/ops stay sane.
			const waitMs = Math.max(0, reset * 1000 - Date.now());
			return Math.min(waitMs, MAX_BACKOFF_MS);
		}
		return Math.min(this.backoffMs * (attempt + 1), MAX_BACKOFF_MS);
	}

	/**
	 * Upsert the single exact-SHA check for GitHub as a CHECK RUN, fulfilling the
	 * forge boundary's provider-varying commit-check seam with the SAME fail-closed
	 * dedupe posture the durable publisher uses: list the SHA's check runs
	 * (object-shaped, Link-paginated), match this job's stable `external_id`, and
	 * PATCH the existing run or POST a new one. A truncated or malformed scan is
	 * `indeterminate` so the caller refuses to create (which could duplicate) and
	 * stays retryable. The GitHub durable-publisher path keeps its own in-publisher
	 * check logic byte-for-byte; this method exists so the boundary contract is
	 * honest and the Forgejo path has a symmetric seam.
	 */
	async postCommitCheck(
		repository: string,
		check: CommitCheck,
	): Promise<
		{ status: "posted" | "deduped"; externalRef?: string } | { status: "failed"; reason: string }
	> {
		const existing = await this.resolveExistingCheckRun(repository, check);
		if (existing.status === "failed") {
			return existing;
		}
		const updateBody = {
			name: check.context,
			status: "completed",
			conclusion: githubConclusion(check.conclusion),
			external_id: check.dedupeKey,
			output: { title: check.title, summary: check.summary },
		};
		try {
			if (existing.status === "found") {
				await this.write("PATCH", `/repos/${repository}/check-runs/${existing.id}`, updateBody);
				return { status: "deduped", externalRef: String(existing.id) };
			}
			const res = await this.write<{ id?: unknown }>("POST", `/repos/${repository}/check-runs`, {
				...updateBody,
				head_sha: check.sha,
			});
			if (!isPositiveIntegerId(res.data?.id)) {
				return { status: "failed", reason: "check create returned no id" };
			}
			return { status: "posted", externalRef: String(res.data.id) };
		} catch (error) {
			return {
				status: "failed",
				reason: error instanceof Error ? error.message : "check write failed",
			};
		}
	}

	/**
	 * Fail-closed dedupe scan for an existing check run. A thrown transport error
	 * or a truncated/malformed scan becomes `failed`, so the caller refuses to
	 * create (which could duplicate) and stays retryable.
	 */
	private async resolveExistingCheckRun(
		repository: string,
		check: CommitCheck,
	): Promise<{ status: "found"; id: number } | { status: "absent" } | ResolveCheckFailure> {
		try {
			const existing = await this.findGitHubCheckRun(
				repository,
				check.sha,
				check.context,
				check.dedupeKey,
			);
			if (existing.status === "indeterminate") {
				return { status: "failed", reason: `check dedupe indeterminate: ${existing.reason}` };
			}
			return existing;
		} catch (error) {
			return {
				status: "failed",
				reason: error instanceof Error ? error.message : "check dedupe failed",
			};
		}
	}

	/**
	 * Open a DRAFT pull request for a branch the watcher has already pushed.
	 *
	 * Everything dangerous was settled upstream: `results/change-ingest` proved the
	 * bundle's confinement, base, and scope, and the publisher proved `headBranch`
	 * is the watcher's own `rw/`-derived ref. The only write here is a create.
	 * There is no merge, no ready-for-review flip, and no force-push — this client
	 * exposes no verb that could perform one.
	 *
	 * Unlike Forgejo 16.0.1, GitHub supports `draft` natively on the create
	 * payload, so the not-ready guarantee is enforced by the forge rather than by a
	 * `WIP:` title convention a human can merge straight past. Hence
	 * `draftMode: "native"`.
	 *
	 * Dedupe PROVES absence before creating. `GET /pulls?head=owner:branch` returns
	 * an empty array (not a 404) when no proposal exists, so absence is a
	 * well-formed answer rather than an error that has to be interpreted — which
	 * matters because this transport flattens HTTP errors into strings and a
	 * misread failure would open a SECOND pull request for the same branch.
	 * Anything malformed or thrown is reported as a failure instead.
	 */
	async openChangeProposal(
		repository: string,
		proposal: ChangeProposal,
	): Promise<ChangeProposalOutcome> {
		const existing = await this.findExistingProposal(repository, proposal);
		if (existing !== null) {
			return existing;
		}

		try {
			const created = await this.write<{ number?: unknown; html_url?: unknown }>(
				"POST",
				`/repos/${repository}/pulls`,
				{
					head: proposal.headBranch,
					base: proposal.baseBranch,
					title: capProposalTitle(proposal.title),
					body: capProposalBody(proposal.body),
					draft: proposal.draft,
					// The watcher opens proposals against issues it did not author; keeping
					// maintainer edits on is what lets a human take the change forward.
					maintainer_can_modify: true,
				},
			);
			if (!isPositiveIntegerId(created.data?.number)) {
				// A 2xx without a usable number cannot be recorded or deduped later.
				// Report failure rather than claim an opaque success.
				return { status: "failed", reason: "proposal created without a usable number" };
			}
			return {
				status: "opened",
				number: created.data.number,
				url: typeof created.data?.html_url === "string" ? created.data.html_url : "",
				draftMode: proposal.draft ? "native" : "none",
			};
		} catch (error) {
			return {
				status: "failed",
				reason: error instanceof Error ? error.message : "proposal write failed",
			};
		}
	}

	/**
	 * PROVE the absence of an existing proposal for this branch before creating.
	 * Returns `null` only when absence is well-formed and proven; any existing
	 * proposal, malformed list, or thrown transport error becomes a terminal
	 * outcome the caller returns unchanged.
	 *
	 * `GET /pulls?head=owner:branch` returns an empty array (not a 404) when no
	 * proposal exists, so absence is a well-formed answer rather than an error that
	 * has to be interpreted — which matters because this transport flattens HTTP
	 * errors into strings and a misread failure would open a SECOND pull request
	 * for the same branch.
	 */
	private async findExistingProposal(
		repository: string,
		proposal: ChangeProposal,
	): Promise<ChangeProposalOutcome | null> {
		const owner = repository.split("/")[0];
		if (!owner) {
			return { status: "failed", reason: "repository is not owner/name" };
		}
		// `head` must be `owner:branch` on this endpoint; a bare branch name silently
		// matches nothing, which would read as "absent" and open a duplicate.
		const query = `head=${encodeURIComponent(`${owner}:${proposal.headBranch}`)}&base=${encodeURIComponent(proposal.baseBranch)}&state=all&per_page=1`;
		try {
			const existing = await this.get<unknown>(`/repos/${repository}/pulls?${query}`);
			const rows = existing.data;
			if (!Array.isArray(rows)) {
				return { status: "failed", reason: "proposal dedupe returned a malformed list" };
			}
			const first = rows[0] as { number?: unknown; html_url?: unknown } | undefined;
			if (first === undefined) {
				return null;
			}
			if (!isPositiveIntegerId(first.number)) {
				// A proposal exists but cannot be named, so a later re-publish could not
				// dedupe against it. Refuse rather than open a second one.
				return { status: "failed", reason: "existing proposal has no usable number" };
			}
			return {
				status: "deduped",
				number: first.number,
				url: typeof first.html_url === "string" ? first.html_url : "",
			};
		} catch (error) {
			// Absence is unproven. Failing here costs a retry; guessing costs a
			// duplicate pull request.
			return {
				status: "failed",
				reason: error instanceof Error ? error.message : "proposal dedupe failed",
			};
		}
	}

	async findCommitCheck(repository: string, check: CommitCheck): Promise<CommitCheckLookup> {
		const found = await this.findGitHubCheckRun(
			repository,
			check.sha,
			check.context,
			check.dedupeKey,
		);
		return found.status === "found" ? { status: "found", ref: String(found.id) } : found;
	}

	/** Bounded, fail-closed check-run scan by `external_id` for the boundary seam. */
	private async findGitHubCheckRun(
		repository: string,
		sha: string,
		checkName: string,
		dedupeKey: string,
	): Promise<
		| { status: "found"; id: number }
		| { status: "absent" }
		| { status: "indeterminate"; reason: string }
	> {
		let next: string | null =
			`/repos/${repository}/commits/${sha}/check-runs?check_name=${encodeURIComponent(checkName)}&filter=all&per_page=100`;
		let pages = 0;
		while (next && pages < 10) {
			const page: ForgePage<unknown> = await this.getPage<unknown>(next);
			const body = page.body;
			if (
				typeof body !== "object" ||
				body === null ||
				!Array.isArray((body as { check_runs?: unknown }).check_runs)
			) {
				return { status: "indeterminate", reason: "check-runs body shape was invalid" };
			}
			for (const run of (body as { check_runs: Array<{ id?: unknown; external_id?: unknown }> })
				.check_runs) {
				if (
					!isPositiveIntegerId(run.id) ||
					(run.external_id !== null && typeof run.external_id !== "string")
				) {
					return { status: "indeterminate", reason: "check-run entry had an invalid shape" };
				}
				if (run.external_id === dedupeKey) {
					return { status: "found", id: run.id };
				}
			}
			next = page.next;
			pages++;
		}
		if (next) {
			return { status: "indeterminate", reason: "check-run scan truncated at page bound" };
		}
		return { status: "absent" };
	}
}

/** GitHub check-run conclusion vocabulary, from the boundary conclusion. */
function githubConclusion(conclusion: CommitCheck["conclusion"]): string {
	return conclusion;
}

/** True when a value is a positive-integer id (check-run id/number). */
function isPositiveIntegerId(value: unknown): value is number {
	return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * Cap a change-proposal title. Bounded before it reaches the forge; mirrors the
 * Forgejo client so the two providers cannot diverge on what they will send.
 */
function capProposalTitle(value: string): string {
	const max = 255;
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/**
 * Cap a change-proposal body. The runner's summary is already bounded by the
 * result schema; this is defence-in-depth at the write boundary.
 */
function capProposalBody(value: string): string {
	const max = 60_000;
	return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

/** Parse a header value to a number, or null when absent/non-numeric. */
function numberOrNull(value: string | null): number | null {
	if (value === null) {
		return null;
	}
	const n = Number(value);
	return Number.isFinite(n) ? n : null;
}

/** Construct the bounded GitHub read/publication client for the given token. */
export const createGitHubClient = traced(
	"github.createGitHubClient",
	function createGitHubClient(token: string, opts: GitHubClientOptions = {}): GitHubClient {
		return new GitHubClient(token, opts);
	},
	// arg 0 is the API TOKEN as a bare positional string. summarize() masks on
	// object KEYS, so nothing else would hide it: this module's whole contract is
	// "tokens are never logged", and the trace must not be the one place it is.
	{ redact: { args: [0] } },
);
