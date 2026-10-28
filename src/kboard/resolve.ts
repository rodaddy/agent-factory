/**
 * @module kboard/resolve
 * @description Build the service's one k-board client at composition, or decide
 *   there is none. Moved out of `service.ts` (SOF-11143) when the pass switch was
 *   added, so the switch and its test live next to the client they gate.
 *
 * @outputs
 *   - `resolveKboardClient` -- the client, or `null` when the pass is off or no token is set
 *   - `KboardResolveDeps` -- the env and fetch seams it reads
 */
import { traced } from "../log";
import { createKboardClient, type FetchLike, type KboardClient } from "./client";
import { KBOARD_PASS_ENABLED, loadKboardToken } from "./config";

/** The compose seams the resolver reads; both are unset in production. */
export interface KboardResolveDeps {
	kboardFetch?: FetchLike;
	kboardEnv?: NodeJS.ProcessEnv;
}

/**
 * Build the k-board client ONCE. Returns NULL when `KBOARD_TOKEN`
 * is absent, and that is a healthy boot, not a failure: the token is minted on the
 * k-board service as a separate operator step, so this service must deploy BEFORE
 * the credential exists. A null client makes the ready station log one bounded
 * line per cycle and skip; every other step is untouched.
 *
 * It is also NULL whenever `KBOARD_PASS_ENABLED` is off (SOF-11143): the pinned
 * k-board API is off by the owner's 2026-08-30 ruling, so building a client would only
 * buy a failed list call every cycle.
 *
 * @param deps - the k-board env and fetch overrides
 * @param enabled - the reviewed pass switch; production passes the constant
 * @returns the constructed client, or `null` when off or no credential is present
 */
export const resolveKboardClient = traced(
	"kboard.resolveKboardClient",
	function resolveKboardClient(
		deps: KboardResolveDeps,
		enabled: boolean = KBOARD_PASS_ENABLED,
	): KboardClient | null {
		if (!enabled) {
			return null;
		}
		const kboardToken = loadKboardToken(deps.kboardEnv ?? process.env);
		return kboardToken.ok
			? createKboardClient({
					token: kboardToken.token,
					...(deps.kboardFetch ? { fetch: deps.kboardFetch } : {}),
				})
			: null;
	},
	// The env carries KBOARD_TOKEN; never let it reach a trace.
	{ redact: { args: [0] } },
);
