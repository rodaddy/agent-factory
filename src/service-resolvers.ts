/**
 * @module service-resolvers
 * @description The watcher-owned lookup functions the reconcile cycle's wiring
 *   depends on: which provider owns a repository, where its push/fetch remote is,
 *   which credential reads it, and which triage labels it permits. Split out of
 *   `service.ts` so the composition root stays at the size ceiling.
 *
 *   Every resolver here reads CONFIG (plus the operator's environment for
 *   credentials) and NEVER runner output. That is the property that matters: these
 *   decide where a verified branch is pushed and which runner-named labels are
 *   honoured. Unmanaged repositories resolve `null` except the fixed verb change
 *   target, whose Forgejo remote is derived from the deployment config.
 *
 * @outputs
 *   - `createProviderResolver` -- repository -> configured provider
 *   - `createRemoteResolver` -- repository -> push/fetch remote URL
 *   - `createCredentialResolver` -- repository -> forge token
 *   - `createTriageAllowlistResolver` -- (repository, jobType) -> permitted labels
 *
 * @dependencies
 *   - ./config/schema, ./forge/provider
 *   - ./forgejo/credentials, ./github/credentials
 */
import type { WatcherConfig } from "./config/schema";
import type { ForgeClient } from "./forge/boundary";
import type { Provider } from "./forge/provider";
import type { ForgeRegistry } from "./forge/registry";
import type { ForgejoDeploymentConfig } from "./forgejo/config";
import { resolveForgejoToken } from "./forgejo/credentials";
import { resolveGitHubToken } from "./github/credentials";
import { resolveGateSelection } from "./infra/select";
import { VERB_CHANGE_BASE_REPOSITORY } from "./jobs/verb-base";
import type { InfraGateSelector } from "./reconcile/dispatch-pass";

/** The four watcher-owned lookups the reconcile wiring depends on. */
export interface ServiceResolvers {
	providerFor: (repository: string) => Provider | null;
	remoteFor: (repository: string) => string | null;
	credentialFor: (repository: string) => Promise<string | null>;
	triageAllowlistFor: (repository: string, jobType: string) => readonly string[];
	clientFor: (repository: string) => Promise<ForgeClient | null>;
}

/**
 * Build every watcher-owned resolver from the booted config and registry. They are
 * assembled together because they CHAIN — remote, credential, triage, and client
 * all resolve through the provider lookup — so building them in one place is what
 * keeps a single repository's provider answer consistent across all of them.
 *
 * @param config - the validated watcher config; the only source of repository truth
 * @param registry - the lazy forge registry credentials resolve through
 * @param forgejoDeployment - resolved only for a config managing a Forgejo repo
 * @param overrides - test seams for the remote and GitHub-token lookups
 * @returns the resolver set the reconcile wiring is built from
 */
export function createServiceResolvers(
	config: WatcherConfig,
	registry: ForgeRegistry,
	forgejoDeployment: { config: ForgejoDeploymentConfig } | null,
	overrides: {
		remoteFor?: (repository: string) => string | null;
		resolveGitHubToken?: typeof resolveGitHubToken;
	} = {},
): ServiceResolvers {
	const providerFor = createProviderResolver(config, forgejoDeployment);
	return {
		providerFor,
		remoteFor: createRemoteResolver(config, forgejoDeployment, overrides.remoteFor),
		credentialFor: createCredentialResolver(
			providerFor,
			overrides.resolveGitHubToken ?? resolveGitHubToken,
		),
		triageAllowlistFor: createTriageAllowlistResolver(config, providerFor),
		// Resolve a repository's forge client through the lazy registry, so a missing
		// credential stays isolated to the repository that asked for it. Shared by the
		// proposal pass and the k-board ready station.
		clientFor: async (repository) => {
			const provider = providerFor(repository);
			if (provider === null) {
				return null;
			}
			const resolved = await registry.clientFor(provider);
			return resolved.ok ? resolved.client : null;
		},
	};
}

/**
 * Resolve an infra-static job's fixed static gates from the candidate's changed
 * paths when the repository opts into changed-files selection. Every other case
 * (full mode, unknown repo, no item, read fault) fails closed to a full
 * escalation. The selector reads only PATHS and grants nothing.
 */
export function createInfraGateSelector(
	config: WatcherConfig,
	registry: ForgeRegistry,
): InfraGateSelector {
	return async ({ repository, itemNumber, itemKind, sha }) => {
		const repo = config.repositories.find((r) => r.name === repository);
		const provider = repo?.provider ?? "github";
		const resolvedClient = await registry.clientFor(provider);
		const selection = await resolveGateSelection({
			mode: repo?.gate_selection ?? "full",
			client: resolvedClient.ok ? resolvedClient.client : null,
			repository,
			// Only a pull has a base: an issue-bound job passes no item so the selector
			// makes no doomed `/pulls/<issue-number>` read and escalates in silence.
			itemNumber: itemKind === "pull" ? itemNumber : null,
			sha,
			provider,
		});
		return {
			ansible: selection.gates.includes("ansible"),
			workflows: selection.gates.includes("workflows"),
			scripts: selection.gates.includes("scripts"),
			config: selection.gates.includes("config"),
			fullEscalation: selection.fullEscalation,
			// The immutable base the body's verdict is relative to.
			...(selection.baseSha === undefined ? {} : { baseSha: selection.baseSha }),
		};
	};
}

/**
 * Resolve a repository's configured provider, or `null` when unmanaged.
 *
 * The fixed verb change target is UNMANAGED and still answers `forgejo`, mirroring
 * `createRemoteResolver`'s existing special case. Without it the chained
 * `credentialFor` resolved `null` for `rtech/k3s-deploy`, the verifier's base fetch
 * went out anonymous against a private Forgejo repo, and git prompted for a
 * username in a non-TTY — exit 128, `change.verify.base_fetch_failed`, no ACCEPT.
 * Widening HERE rather than special-casing inside `createCredentialResolver` keeps
 * one answer to "who owns this repository" across the whole chain; a credential
 * resolver that disagreed with the provider lookup is the shape that hides the
 * next defect of this kind.
 *
 * The widening is exactly one repository and is conditioned on a configured
 * Forgejo deployment, because a provider whose remote cannot be derived is not a
 * usable answer. Both other `providerFor` consumers are unaffected: this string
 * reaches `triageAllowlistFor` never (its config lookup would still miss, and the
 * verb lane is not `issue-triage`), and `clientFor` never — proposal-pass and the
 * k-board ready gate both key on a MANAGED dispatch repository, and the verb
 * lane's own forge read goes straight to `registry.clientFor("forgejo")` by
 * provider (`service-cycle.ts`), never through this repository-keyed lookup.
 */
export function createProviderResolver(
	config: WatcherConfig,
	forgejoDeployment: { config: ForgejoDeploymentConfig } | null = null,
): (repository: string) => Provider | null {
	return (repository) => {
		const configured = config.repositories.find((r) => r.name === repository)?.provider;
		if (configured !== undefined) {
			return configured;
		}
		return repository === VERB_CHANGE_BASE_REPOSITORY && forgejoDeployment !== null
			? "forgejo"
			: null;
	};
}

/**
 * Resolve a repository's push/fetch remote from CONFIG, never from runner output.
 * Managed repositories follow their provider. The fixed verb change target may be
 * unmanaged and still derives from the configured Forgejo clone base; every other
 * unmanaged repository yields `null`.
 */
export function createRemoteResolver(
	config: WatcherConfig,
	forgejoDeployment: { config: ForgejoDeploymentConfig } | null,
	override?: (repository: string) => string | null,
): (repository: string) => string | null {
	return (repository) => {
		if (override) {
			return override(repository);
		}
		const repo = config.repositories.find((r) => r.name === repository);
		const forgejoRemote = forgejoDeployment
			? `${forgejoDeployment.config.cloneBase}/${repository}.git`
			: null;
		if (!repo) {
			return repository === VERB_CHANGE_BASE_REPOSITORY ? forgejoRemote : null;
		}
		if (repo.provider === "forgejo") {
			return forgejoRemote;
		}
		return `https://github.com/${repository}.git`;
	};
}

/**
 * One credential resolver shared by verification, the base fetch, and the push.
 * A private repository cannot be FETCHED without it either, so binding it only to
 * the push made every private-repo implement result fail verification and record
 * as invalid.
 */
export function createCredentialResolver(
	providerFor: (repository: string) => Provider | null,
	resolveGitHub: typeof resolveGitHubToken = resolveGitHubToken,
): (repository: string) => Promise<string | null> {
	return async (repository) => {
		const provider = providerFor(repository);
		if (provider === null) {
			return null;
		}
		const token = provider === "forgejo" ? resolveForgejoToken() : await resolveGitHub();
		return token.ok ? token.token : null;
	};
}

/**
 * The per-repository triage label allowlist, resolved from live config for
 * the publication boundary's factory-side label filter. Provider-qualified so a
 * same-named repo on the other forge never leaks its vocabulary; an unmatched
 * repository (or a non-triage lane) resolves an empty list, which safely demotes
 * every runner-named label to a request.
 */
export function createTriageAllowlistResolver(
	config: WatcherConfig,
	providerFor: (repository: string) => Provider | null,
): (repository: string, jobType: string) => readonly string[] {
	return (repository, jobType) => {
		if (jobType !== "issue-triage") {
			return [];
		}
		const provider = providerFor(repository);
		return (
			config.repositories.find((r) => r.name === repository && r.provider === provider)
				?.triage_labels ?? []
		);
	};
}
