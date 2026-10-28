/**
 * @module kboard/config
 * @description The pinned k-board endpoint contract and the credential seam for
 *   the k-board client. This mirrors `src/forgejo/config.ts`, which pins
 *   `forge.example.internal` exactly rather than accepting a free-form URL a config
 *   file could repoint: the k-board API location is a REVIEWED CONSTANT, not a
 *   repointable setting.
 *
 *   PINNING RATIONALE. k-board is the sole mutation authority for `fleet.tasks`
 *   (see _DOCS/board-map.md). Letting a config file repoint the base URL
 *   would let a repository's own content redirect every claim, status write,
 *   and event to an attacker-chosen host carrying the watcher's bearer token.
 *   The URL is therefore a compile-time constant, reviewed once, and the module
 *   exports no way to override it.
 *
 *   VLAN-20 ROUTE FACT. The API runs as `k-board-api` (uvicorn) on a fleet host
 *   (bilby) at `http://10.0.20.71:8803`, reachable from the watcher host
 *   (the watcher host, `10.0.21.0`) over the vlan-20 route — the watcher host is on VLAN tag 20
 *   like a fleet host before it, so the route survived the 2026-08-04 migration.
 *  It is plain HTTP on a private VLAN, not
 *   TLS-terminated at a public host like Forgejo — so the constant is an
 *   `http://` address by design, and that is not a downgrade to fix.
 *
 *   CREDENTIAL SEAM. `loadKboardToken` mirrors `src/github/credentials.ts`: the
 *   bearer token is read from a NEW, SEPARATE env var `KBOARD_TOKEN` (never
 *   `GITHUB_TOKEN`/`FORGEJO_TOKEN`), and is returned wrapped so a caller can
 *   authorize a request without the raw string ever landing in a log line, an
 *   error message, a thrown `Error`, a published body, or a result. The wrapper
 *   exposes the token only through `authorization()`, which builds the header
 *   value at fetch time; it has no `toString`/`toJSON` that reveals the secret.
 *
 *   PASS OFF (SOF-11143, 2026-10-08). a fleet host (bilby) is stopped and stays off per
 *   the owner's 2026-08-30 ruling, so every pass against `KBOARD_BASE_URL`
 *   failed with `kboard.list_failed outcome=transport_failed`. fleet-board's live
 *   service on a fleet host (`10.0.20.74:3000`) is the READ-ONLY projection (`/tasks`,
 *   writes 405), not the mutation API this client speaks, so there is nothing to
 *   repoint to yet. `KBOARD_PASS_ENABLED` is therefore `false`: the service builds
 *   no k-board client and both k-board passes are inert. Flip it back to `true`
 *   (and repoint `KBOARD_BASE_URL` if the API moved) once a k-board mutation API
 *   (`legacy/k-board/server.py`) answers from the watcher host again.
 *
 * @outputs
 *   - `KBOARD_BASE_URL` -- the pinned API base (constant)
 *   - `KBOARD_PASS_ENABLED` -- whether the watcher talks to k-board at all (constant)
 *   - `KBOARD_ACTOR` -- the factory actor name (constant, ruled 2026-08-01)
 *   - `KboardToken` -- the opaque credential wrapper
 *   - `loadKboardToken` -- resolve `KBOARD_TOKEN` into a wrapper or a bounded error
 */

import { traced } from "../log";

/**
 * The pinned k-board API base URL. REVIEWED CONSTANT — see the module rationale.
 * Not config-repointable; there is deliberately no env override.
 */
export const KBOARD_BASE_URL = "http://10.0.20.71:8803" as const;

/**
 * Whether the watcher builds a k-board client at all. REVIEWED CONSTANT, `false`
 * since SOF-11143: the API at `KBOARD_BASE_URL` is off by the owner's 2026-08-30
 * ruling and no other k-board mutation API is live. With it off the service
 * resolves no client, so the ready station and the transitions pass make no
 * network call. See the module rationale for when to flip it back.
 */
export const KBOARD_PASS_ENABLED: boolean = false;

/**
 * The factory actor name. Every mutating request the watcher
 * makes is authored as this actor, and the server rejects an event whose
 * `actor` is not the authenticated one, so this must match the actor minted
 * into `KBOARD_AGENT_TOKENS_JSON` on the k-board service.
 */
export const KBOARD_ACTOR = "factory-watcher" as const;

/**
 * An opaque handle to the k-board bearer token. The raw string is held in a
 * closure and reachable ONLY through `authorization()`, which produces the
 * `Authorization` header value. There is intentionally no accessor that returns
 * the bare token and no `toString`/`toJSON`, so the credential cannot be
 * stringified into a log line, error, or serialized body by accident.
 */
export interface KboardToken {
	/** Build the `Authorization` header value (`Bearer <token>`) at fetch time. */
	authorization(): string;
}

/** Result of resolving the token: the value is never included in the error. */
export type KboardTokenResult = { ok: true; token: KboardToken } | { ok: false; error: string };

/** Wrap a raw token so it is only ever exposed as a header value. */
function wrapToken(raw: string): KboardToken {
	// The raw token is captured here and never stored on an enumerable field, so
	// nothing that spreads or JSON-serializes the wrapper can reach it.
	return {
		authorization(): string {
			return `Bearer ${raw}`;
		},
	};
}

/**
 * Resolve the k-board token from `KBOARD_TOKEN`. The value is never logged and
 * never placed in the returned error string — a caller that fails to configure
 * the credential learns only that it is missing, not any partial value.
 *
 * @param env - environment to read (defaults to `process.env`)
 * @returns a wrapped token, or a bounded failure with no secret in it
 */
export const loadKboardToken = traced(
	"kboard.loadKboardToken",
	function loadKboardToken(env: NodeJS.ProcessEnv = process.env): KboardTokenResult {
		const value = env.KBOARD_TOKEN?.trim();
		if (!value || value.length === 0) {
			return {
				ok: false,
				error: "no k-board token available: set KBOARD_TOKEN in the environment",
			};
		}
		return { ok: true, token: wrapToken(value) };
	},
	{ redact: { args: [0] } },
);
