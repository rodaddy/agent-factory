/**
 * @module hostedapp/vault
 * @description The Vaultwarden READ seam `hosted-app validate --referential`
 *   uses to prove a declaration's `secrets[].vaultwarden_item` + `keys[]` and
 *   `database.password_item` exist. It answers with key NAMES only --
 *   the field names of one item -- and never returns, logs, or traces a value.
 *
 *   The live lookup runs the same `mcp2cli vaultwarden-secrets get_credential`
 *   shape as `bin/forgejo-token` and unwraps the `result` envelope like
 *   enroll-app's `services/vault.py` `_unwrap`. get_credential matches FUZZILY:
 *   probed 2026-09-24, a query for a nonexistent item returned exit 0 and a
 *   DIFFERENT item (`matchType: "fuzzy"`). So an item is found only when the
 *   returned `result.name` equals the query exactly; anything else is missing.
 *
 * @outputs
 *   - `VaultLookup` / `VaultLookupResult` -- the injected seam and its result
 *   - `keyNamesOf` -- a decoded get_credential body -> key names, pure
 *   - `mcp2cliVaultLookup` -- the live implementation over mcp2cli
 *
 * @dependencies
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { traced } from "../log";

/** A lookup found the item (with its field names), did not, or failed. */
export type VaultLookupResult =
	| { status: "found"; keys: string[] }
	| { status: "missing" }
	| { status: "error"; error: string };

/** The injected seam: given an exact Vaultwarden item name, its key names. */
export type VaultLookup = (item: string) => Promise<VaultLookupResult>;

/**
 * Reduce a decoded get_credential body to the item's key names.
 *
 * @param payload - the decoded JSON body (`{ result: { name, fields } }`)
 * @param item - the exact item name that was queried
 * @returns the field names on an exact name match, missing on any other match
 */
export const keyNamesOf = traced(
	"hostedapp.keyNamesOf",
	function keyNamesOf(payload: unknown, item: string): VaultLookupResult {
		if (typeof payload !== "object" || payload === null) {
			return { status: "error", error: `Vaultwarden returned an unexpected body for ${item}` };
		}
		const result = (payload as Record<string, unknown>).result;
		if (typeof result !== "object" || result === null) {
			return { status: "error", error: `Vaultwarden returned no result for ${item}` };
		}
		const { name, fields } = result as Record<string, unknown>;
		if (name !== item) return { status: "missing" };
		if (typeof fields !== "object" || fields === null) return { status: "found", keys: [] };
		return { status: "found", keys: Object.keys(fields) };
	},
	// ARG 0 ONLY. The decoded body carries every field VALUE of the item (and
	// `result.value`); summarize() masks only fixed secret words, so a field named
	// `LINKEDIN_COOKIE` would reach the wire verbatim. The result is names only.
	{ redact: { args: [0] } },
);

/**
 * Look up one item's key names through `mcp2cli vaultwarden-secrets get_credential`.
 *
 * @param item - the exact Vaultwarden item name
 * @returns found with key names, missing, or an error that names no value
 */
export const mcp2cliVaultLookup: VaultLookup = traced(
	"hostedapp.mcp2cliVaultLookup",
	async function mcp2cliVaultLookup(item: string): Promise<VaultLookupResult> {
		let stdout: string;
		let code: number;
		try {
			const child = Bun.spawn(
				[
					"mcp2cli",
					"vaultwarden-secrets",
					"get_credential",
					"--params",
					JSON.stringify({ query: item }),
				],
				{ stdout: "pipe", stderr: "ignore", stdin: "ignore" },
			);
			stdout = await new Response(child.stdout).text();
			code = await child.exited;
		} catch {
			return { status: "error", error: "mcp2cli not runnable" };
		}
		// NEITHER stream goes into the error: stdout is where the values are, and
		// stderr echoes invocations often enough to carry one (vault.py:222-226).
		if (code !== 0)
			return { status: "error", error: `cannot fetch ${item} from Vaultwarden: exit ${code}` };
		try {
			return keyNamesOf(JSON.parse(stdout), item);
		} catch {
			return { status: "error", error: `Vaultwarden returned a non-JSON body for ${item}` };
		}
	},
);
