/**
 * @module hostedapp/fetch
 * @description The READ seam `hosted-app land` uses to pull declaration and
 *   config-file text out of a product repo on Forge. It mirrors the shape of
 *   `src/forgejo/` — a narrow injected function returning a discriminated
 *   result rather than throwing — so the land loop is pure with respect to the
 *   network and its tests serve a URL map instead of standing up a server.
 *
 *   The distinction the loop depends on is transport failure (harness error,
 *   exit 3) versus an HTTP status (a per-app FAIL row). A thrown fetch is the
 *   former; a 404 at the accepted ref is the latter, so it never aborts a run
 *   that could still land the other apps.
 *
 * @outputs
 *   - `FetchText` / `FetchTextResult` -- the injected read seam and its result
 *   - `DEFAULT_FORGE_API` -- the Forge API base the CLI defaults to
 *   - `rawUrl` -- build the raw-content URL for a repo path at a ref
 *   - `forgeFetchText` -- the live implementation over global fetch
 *
 * @dependencies
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { traced } from "../log";

/** The Forge API base used when `--forge-api` is not given. */
export const DEFAULT_FORGE_API = "https://forge.example.net/api/v1";

/** A read either produced text, or failed with a status and a reason. */
export type FetchTextResult =
	| { ok: true; text: string }
	| { ok: false; status: number; error: string };

/**
 * The injected read seam: given an absolute URL and a token, return text.
 * A status of `0` means the transport itself failed (no HTTP reply), which the
 * land loop maps onto a harness error rather than a per-app failure.
 */
export type FetchText = (url: string, token: string) => Promise<FetchTextResult>;

/**
 * Build the raw-content URL for one path in a repo at one ref.
 *
 * @param api - the Forge API base, trailing slashes ignored
 * @param repo - `<owner>/<repo>`
 * @param path - the repo-relative file path
 * @param ref - the commit sha to read at
 * @returns the absolute `.../raw/<path>?ref=<ref>` URL
 */
export const rawUrl = traced(
	"hostedapp.rawUrl",
	function rawUrl(api: string, repo: string, path: string, ref: string): string {
		const base = api.replace(/\/+$/, "");
		return `${base}/repos/${repo}/raw/${path}?ref=${ref}`;
	},
);

/**
 * Read text from Forge over global fetch, the live `FetchText`.
 *
 * @param url - the absolute raw-content URL
 * @param token - the Forge token, sent as `Authorization: token <t>`
 * @returns the body text, or the status and reason it could not be read
 */
export const forgeFetchText = traced(
	"hostedapp.forgeFetchText",
	async function forgeFetchText(url: string, token: string): Promise<FetchTextResult> {
		try {
			const response = await fetch(url, { headers: { Authorization: `token ${token}` } });
			if (!response.ok) {
				return { ok: false, status: response.status, error: `HTTP ${response.status}` };
			}
			return { ok: true, text: await response.text() };
		} catch (error) {
			const reason = error instanceof Error ? error.message : "fetch failed";
			return { ok: false, status: 0, error: reason };
		}
	},
	// BOTH ENDS. Arg 1 is the bare Forge token as a POSITIONAL -- it has no key of
	// its own, and summarize() masks on object keys, so it reaches the wire
	// verbatim. Probed: summarize(["m2c_SECRET"]) returned the value intact.
	// The result carries `text`, which is arbitrary product-repo file content --
	// this is the seam `land` fetches config_files through, and a config file is
	// exactly the place a credential lives.
	{ redact: { args: [1], result: true } },
);
