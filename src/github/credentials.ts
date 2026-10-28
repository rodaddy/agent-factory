/**
 * @module github/credentials
 * @description Resolve the GitHub token from the environment ONLY — `GITHUB_TOKEN`
 *   then `GH_TOKEN`, trimmed — without ever logging it or returning it in error
 *   text. There is deliberately NO gh CLI fallback: Forge is the
 *   factory's git provider and its credential is `FORGEJO_TOKEN`, so a gh CLI
 *   shell-out could only ever supply a token for the READ-ONLY GitHub mirror while
 *   presenting itself as the primary credential path. The GitHub client still
 *   serves that mirror, so the env read stays. The runtime credential is scoped
 *   only to managed repositories with metadata/contents/pull-request reads plus
 *   Issues and Checks writes for the fixed publication registry (see README.md).
 *
 * @outputs
 *   - `TokenResult` -- the shared, secret-free resolution result shape
 *   - `resolveGitHubToken` -- return a usable token or a bounded failure
 *
 * @dependencies
 *   - ../log -- the shared traced() build-phase wrapper
 */

import { traced } from "../log";

/** Result of resolving a token: the value is never included in the error. */
export type TokenResult = { ok: true; token: string } | { ok: false; error: string };

/** Read a token from the environment, if present and non-empty. */
function fromEnv(env: NodeJS.ProcessEnv): string | undefined {
	const value = (env.GITHUB_TOKEN ?? env.GH_TOKEN)?.trim();
	return value && value.length > 0 ? value : undefined;
}

/**
 * Resolve a GitHub token from the environment. No subprocess is ever spawned;
 * the token value is never logged and never placed in the returned error string.
 *
 * @param env - environment to read (defaults to `process.env`)
 */
export const resolveGitHubToken = traced(
	"github.resolveGitHubToken",
	async function resolveGitHubToken(env: NodeJS.ProcessEnv = process.env): Promise<TokenResult> {
		const envToken = fromEnv(env);
		if (envToken) {
			return { ok: true, token: envToken };
		}
		return {
			ok: false,
			error:
				"no GitHub token available: set GITHUB_TOKEN for the read-only mirror; the factory's forge credential is FORGEJO_TOKEN (no gh CLI fallback)",
		};
	},
	{ redact: { args: [0] } },
);
