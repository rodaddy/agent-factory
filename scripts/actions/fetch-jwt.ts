/**
 * @module scripts/actions/fetch-jwt
 * @description Mint the lane's OIDC token from the Actions ID-token endpoint and
 *   hand it to the job as a step output.
 *
 *   Forgejo IGNORES a `permissions:` block (it prints a UI warning on every
 *   run), so the automatic job token could never be narrowed — it is whatever
 *   the forge mints, job-scoped rather than step-scoped. The owner ruling
 *   2026-08-30: the lanes authenticate through an Authorized Integration
 *   instead. The runner exposes the ID-token endpoint when the workflow sets
 *   `enable-openid-connect: true` (forgejo-runner >= v12.10.0); the JWT it
 *   returns is bound to the audience of the integration and is accepted by the
 *   Forge API as a bearer token with exactly the capabilities that integration
 *   was granted.
 *
 *   The audience is NOT a secret — it names the integration, it does not
 *   authorize anything — so it travels in the workflow file as plain `env`.
 *   The request token and the JWT ARE secrets: the JWT is masked before it is
 *   printed, and a failed request reports its HTTP STATUS only. The body of a
 *   rejected call is the one place a proxy has been seen to echo a credential
 *   back, so it is never logged.
 *
 * @outputs
 *   - `fetchJwt` -- pure, injectable: options -> ok jwt, or a reason
 *   - CLI: reads `ACTIONS_ID_TOKEN_REQUEST_URL`, `ACTIONS_ID_TOKEN_REQUEST_TOKEN`
 *     and `AUD` from env; on success writes `::add-mask::<jwt>` to stdout and
 *     appends `jwt=<jwt>` to `$GITHUB_OUTPUT` / `$FORGEJO_OUTPUT`; exit 0 on
 *     success, 22 on a non-2xx or transport failure, 3 on a missing env var.
 */

import { traced } from "../../src/log";

/** The ceiling on the token request. The endpoint is local to the runner. */
export const JWT_TIMEOUT_MS = 20_000;

/** The cap on a reason string, so a verbose error cannot flood the log. */
const MAX_REASON_CHARS = 200;

export type JwtResult = { ok: true; jwt: string } | { ok: false; reason: string };

export interface JwtOptions {
	/** The runner's ID-token endpoint; it already carries a query string. */
	requestUrl: string;
	/** The bearer token the runner mints for that endpoint. Never logged. */
	requestToken: string;
	/** The Authorized Integration's audience, e.g. `u:11:<uuid>`. Not a secret. */
	audience: string;
	fetchImpl?: typeof fetch;
}

/** A thrown fetch error rendered without its cause chain or any request detail. */
function reasonForError(error: unknown): string {
	if (error instanceof Error) {
		return `${error.name}: ${error.message}`.slice(0, MAX_REASON_CHARS);
	}
	return String(error).slice(0, MAX_REASON_CHARS);
}

/**
 * Ask the runner for an ID token bound to `audience`.
 *
 * The endpoint URL already contains a query string, so the audience is appended
 * with `&`, URL-encoded — the audience is operator-supplied and must not be
 * able to inject another parameter.
 */
async function fetchJwtImpl(opts: JwtOptions): Promise<JwtResult> {
	const doFetch = opts.fetchImpl ?? fetch;
	const url = `${opts.requestUrl}&audience=${encodeURIComponent(opts.audience)}`;
	try {
		const res = await doFetch(url, {
			headers: { Authorization: `bearer ${opts.requestToken}` },
			signal: AbortSignal.timeout(JWT_TIMEOUT_MS),
		});
		if (!res.ok) {
			// The status only. The body of a rejected call can echo the credential.
			return { ok: false, reason: `http ${res.status}` };
		}
		const payload = (await res.json()) as { value?: unknown };
		const jwt = payload.value;
		if (typeof jwt !== "string" || jwt === "") {
			return { ok: false, reason: "the id-token response carried no value" };
		}
		return { ok: true, jwt };
	} catch (error) {
		return { ok: false, reason: reasonForError(error) };
	}
}

/**
 * BOTH ENDS ARE REDACTED, and neither is optional. `traced()` logs arguments
 * and return values by default: `opts` carries `requestToken`, and the result
 * carries the minted JWT. Tracing this function without redaction would put a
 * live credential in the lane log -- the exact failure the module header says
 * it guards against by masking the JWT before printing it.
 */
export const fetchJwt = traced("actions.fetchJwt", fetchJwtImpl, {
	redact: { args: [0], result: true },
});

function required(name: string): string {
	const value = process.env[name];
	if (value === undefined || value === "") {
		process.stderr.write(`fetch-jwt: ${name} is required\n`);
		process.exit(3);
	}
	return value;
}

if (import.meta.main) {
	const requestUrl = required("ACTIONS_ID_TOKEN_REQUEST_URL");
	// Read in process and never printed: it reaches the Authorization header only.
	const requestToken = required("ACTIONS_ID_TOKEN_REQUEST_TOKEN");
	const audience = required("AUD");

	const result = await fetchJwt({ requestUrl, requestToken, audience });
	if (!result.ok) {
		process.stderr.write(`fetch-jwt: the id-token request failed (${result.reason})\n`);
		process.exitCode = 22;
	} else {
		// Masked BEFORE it can appear anywhere else in the log, including in the
		// output file write below failing and echoing its argument.
		process.stdout.write(`::add-mask::${result.jwt}\n`);
		// Forgejo sets FORGEJO_OUTPUT; the GitHub-compatible name is also set on
		// current runners. Write whichever exists, both when both do.
		const line = `jwt=${result.jwt}\n`;
		let written = 0;
		for (const name of ["GITHUB_OUTPUT", "FORGEJO_OUTPUT"]) {
			const path = process.env[name];
			if (path === undefined || path === "") continue;
			const existing = await Bun.file(path)
				.text()
				.catch(() => "");
			await Bun.write(path, existing + line);
			written += 1;
		}
		if (written === 0) {
			process.stderr.write("fetch-jwt: no GITHUB_OUTPUT or FORGEJO_OUTPUT to write\n");
			process.exitCode = 3;
		}
	}
}
