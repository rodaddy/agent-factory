/**
 * @module service-boot
 * @description The watcher's BOOT GATE and forge wiring, split out of `service.ts`
 *   so the composition root stays at the size ceiling.
 *
 *   Order here is deliberate and is the reason this is one function: config loads
 *   first, then every packet is validated, and only then is any db, credential, or
 *   transport wiring built. A malformed packet is a deploy-time defect that
 *   must fail the BOOT with a named error, so it has to be the first thing an
 *   operator sees — never a dispatched job discovering it on a runner box. Both
 *   `startService` and `runOnce` reach this, so neither can boot with a broken
 *   packet.
 *
 * @outputs
 *   - `BootedService` -- the validated config plus the db and forge registry
 *   - `bootService` -- load config, gate the packets, and build the forge wiring
 *
 * @dependencies
 *   - ./config/load, ./db/client, ./packets/registry
 *   - ./forge/registry, ./forgejo/config, ./github/client, ./github/credentials
 */
import { loadConfig } from "./config/load";
import type { WatcherConfig } from "./config/schema";
import { createDb, type WatcherDb } from "./db/client";
import { createForgeRegistry, type ForgeRegistry } from "./forge/registry";
import { type ForgejoDeploymentConfig, resolveForgejoDeployment } from "./forgejo/config";
import { createGitHubClient } from "./github/client";
import { resolveGitHubToken } from "./github/credentials";
import { assertPacketsBootable } from "./packets/registry";

/** The seams `bootService` resolves through; production leaves them all unset. */
export interface BootDeps {
	loadConfig?: typeof loadConfig;
	assertPacketsBootable?: typeof assertPacketsBootable;
	resolveGitHubToken?: typeof resolveGitHubToken;
	createDb?: () => { db: WatcherDb; client: { end?: () => Promise<void> } };
	createGitHubClient?: typeof createGitHubClient;
	forgeRegistry?: ForgeRegistry;
}

/** The validated config plus the database and forge wiring a composition needs. */
export interface BootedService {
	config: WatcherConfig;
	db: WatcherDb;
	registry: ForgeRegistry;
	/** Resolved when a managed repository or enabled verb lane needs Forgejo. */
	forgejoDeployment: { config: ForgejoDeploymentConfig } | null;
}

/**
 * Load and validate config, gate every packet, and build the db plus the lazy
 * forge registry.
 *
 * @param configPath - path to the YAML config
 * @param deps - overridable factory seams; production leaves them unset
 * @returns the validated config and the db/forge wiring built from it
 * @throws when config is invalid, a packet fails validation, or a managed Forgejo
 *   deployment cannot be resolved — every one a fail-closed boot error
 */
export async function bootService(configPath: string, deps: BootDeps): Promise<BootedService> {
	const load = deps.loadConfig ?? loadConfig;
	const loaded = await load(configPath);
	if (!loaded.ok) {
		throw new Error(loaded.error);
	}

	// Validate every packet at STARTUP: a packet is the agent's entire system
	// prompt, so a malformed one (bad frontmatter, a missing fixed section) is a
	// deploy-time defect that must fail the BOOT with a named error. This runs after
	// config load and before any db/credential/transport wiring.
	const assertPackets = deps.assertPacketsBootable ?? assertPacketsBootable;
	const packets = await assertPackets();
	if (!packets.ok) {
		throw new Error(`packet boot validation failed: ${packets.error}`);
	}

	const makeDb = deps.createDb ?? createDb;
	const { db } = makeDb();
	const config = loaded.config;
	const hasForgejo = config.repositories.some((repo) => repo.provider === "forgejo");
	const needsForgejo =
		hasForgejo || config.repositories.some((repo) => repo.verb_dispatch === true);
	const resolved = needsForgejo && !deps.forgeRegistry ? resolveForgejoDeployment() : null;
	if (resolved && !resolved.ok) {
		throw new Error(resolved.error);
	}
	const forgejoDeployment = resolved?.ok ? resolved : null;

	// The registry is the single lazy credential/client owner for sweep, publication,
	// and changed-file selection. A Forgejo-only config never asks it for GitHub, so
	// the unrelated GitHub credential is never resolved.
	const registry =
		deps.forgeRegistry ??
		createForgeRegistry({
			resolveGitHubToken: deps.resolveGitHubToken ?? resolveGitHubToken,
			createGitHubClient: deps.createGitHubClient ?? createGitHubClient,
			...(forgejoDeployment ? { forgejoDeployment: forgejoDeployment.config } : {}),
		});

	return { config, db, registry, forgejoDeployment };
}
