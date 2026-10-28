/**
 * @module forge/registry
 * @description The per-provider forge-client registry the reconciler uses to
 *   read from MIXED repositories. A config may name both GitHub and Forgejo
 *   repositories; each needs a client built from its OWN separate credential
 *   (GitHub token vs `FORGEJO_TOKEN`) targeting its OWN reviewed API base. The
 *   registry resolves — and memoizes — exactly one `ForgeClient` per provider it
 *   is asked for, LAZILY, so a GitHub-only deployment never needs a Forgejo token
 *   and vice versa. A provider with no usable token FAILS CLOSED: `clientFor`
 *   returns a bounded, secret-free error result rather than a half-built client.
 *
 *   This is a narrow composition seam, not a plugin system: the closed provider
 *   enum, the two credential resolvers, and the two concrete client factories are
 *   all author-controlled. The registry only decides WHICH already-reviewed client
 *   a repository's durable provider maps to.
 *
 * @outputs
 *   - `ForgeRegistry` -- resolve/memoize a `ForgeClient` per provider
 *   - `createForgeRegistry` -- build the production registry (real resolvers/factories)
 *   - `ForgeRegistryDeps` -- the injectable resolver/factory seams (tests)
 *   - `ForgeClientResult` -- the fail-closed per-provider resolution result
 *
 * @dependencies
 *   - ./boundary -- the narrow `ForgeClient` contract
 *   - ./provider -- the closed provider enum
 *   - ../github/client, ../github/credentials -- GitHub client + token
 *   - ../forgejo/client, ../forgejo/credentials -- Forgejo client + token
 *   - ../log -- the shared traced() build-phase wrapper
 */
import { createForgejoClient, type ForgejoClientOptions } from "../forgejo/client";
import type { ForgejoDeploymentConfig } from "../forgejo/config";
import { resolveForgejoToken } from "../forgejo/credentials";
import { createGitHubClient } from "../github/client";
import type { TokenResult } from "../github/credentials";
import { resolveGitHubToken } from "../github/credentials";
import { traced } from "../log";
import type { ForgeClient } from "./boundary";
import type { Provider } from "./provider";

/** A resolved client, or a bounded secret-free reason it could not be built. */
export type ForgeClientResult = { ok: true; client: ForgeClient } | { ok: false; error: string };

/**
 * Injectable resolver/factory seams. Production leaves these unset and the real
 * credential resolvers + client factories are used; tests inject fakes so the
 * registry's per-provider routing can be exercised without a live token.
 */
export interface ForgeRegistryDeps {
	resolveGitHubToken?: () => Promise<TokenResult>;
	resolveForgejoToken?: () => TokenResult;
	createGitHubClient?: (token: string) => ForgeClient;
	createForgejoClient?: (token: string, opts: ForgejoClientOptions) => ForgeClient;
	/** Validated infrastructure-owned endpoints, required before Forgejo use. */
	forgejoDeployment?: ForgejoDeploymentConfig;
}

/**
 * Resolves and memoizes one `ForgeClient` per provider. Each provider's client is
 * built at most once (on first request) from its own credential; a provider that
 * is never requested is never resolved, so a GitHub-only run needs no Forgejo
 * token. A resolution result — success or a bounded failure — is cached so a
 * repeated request neither re-resolves the token nor changes its answer within a
 * cycle.
 */
export class ForgeRegistry {
	private readonly deps: ForgeRegistryDeps;
	private readonly cache = new Map<Provider, ForgeClientResult>();

	constructor(deps: ForgeRegistryDeps = {}) {
		this.deps = deps;
	}

	/**
	 * Resolve the client for `provider`, building it once and caching the result.
	 * Returns a bounded failure (never throws) when the provider's token is absent,
	 * so a mixed pass can isolate one forge's missing credential to its own repos.
	 */
	async clientFor(provider: Provider): Promise<ForgeClientResult> {
		const cached = this.cache.get(provider);
		if (cached) {
			return cached;
		}
		const resolved = await this.build(provider);
		this.cache.set(provider, resolved);
		return resolved;
	}

	private async build(provider: Provider): Promise<ForgeClientResult> {
		if (provider === "github") {
			const resolve = this.deps.resolveGitHubToken ?? resolveGitHubToken;
			const token = await resolve();
			if (!token.ok) {
				return { ok: false, error: token.error };
			}
			const make = this.deps.createGitHubClient ?? createGitHubClient;
			return { ok: true, client: make(token.token) };
		}
		// forgejo
		if (!this.deps.forgejoDeployment) {
			return { ok: false, error: "Forgejo endpoint configuration is unavailable" };
		}
		const resolve = this.deps.resolveForgejoToken ?? resolveForgejoToken;
		const token = resolve();
		if (!token.ok) {
			return { ok: false, error: token.error };
		}
		const make = this.deps.createForgejoClient ?? createForgejoClient;
		return {
			ok: true,
			client: make(token.token, { baseUrl: this.deps.forgejoDeployment.apiUrl }),
		};
	}
}

/** Build the production registry (real resolvers + concrete client factories). */
export const createForgeRegistry = traced(
	"forge.createForgeRegistry",
	function createForgeRegistry(deps: ForgeRegistryDeps = {}): ForgeRegistry {
		return new ForgeRegistry(deps);
	},
);
