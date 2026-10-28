/**
 * @module forgejo/credentials
 * @description Resolve the Forgejo token from the environment ONLY, never
 *   logging or returning it in error text. Forgejo is a SEPARATE credential from
 *   GitHub: it is read from `FORGEJO_TOKEN` and there is deliberately NO `gh` CLI
 *   fallback (the gh CLI authenticates GitHub, not the deployed Forgejo instance —
 *   falling back to it would silently send a GitHub token to Forgejo). A missing
 *   token fails closed with a bounded, secret-free error. The runtime credential
 *   is a Forgejo personal access token scoped only to reads of the managed
 *   Forgejo repositories plus the fixed commit-status write the publisher uses.
 *
 * @outputs
 *   - `resolveForgejoToken` -- return a usable token or a bounded failure
 *
 * @dependencies
 *   - ../github/credentials -- the shared `TokenResult` result shape
 */
import type { TokenResult } from "../github/credentials";
import { traced } from "../log";

/** Read a Forgejo token from the environment, if present and non-empty. */
function fromEnv(env: NodeJS.ProcessEnv): string | undefined {
	const value = env.FORGEJO_TOKEN?.trim();
	return value && value.length > 0 ? value : undefined;
}

/**
 * Resolve a Forgejo token from `FORGEJO_TOKEN` ONLY. Unlike the GitHub resolver
 * there is NO `gh` CLI fallback — the gh CLI issues GitHub tokens, and reusing one
 * against the deployed Forgejo host would leak a GitHub credential to a different
 * forge. The token value is never logged and never placed in the returned error.
 *
 * @param env - environment to read (defaults to `process.env`)
 */
export const resolveForgejoToken = traced(
	"forgejo.resolveForgejoToken",
	function resolveForgejoToken(env: NodeJS.ProcessEnv = process.env): TokenResult {
		const token = fromEnv(env);
		if (token) {
			return { ok: true, token };
		}
		return {
			ok: false,
			error: "no Forgejo token available: set FORGEJO_TOKEN (no gh CLI fallback)",
		};
	},
	{ redact: { args: [0] } },
);
