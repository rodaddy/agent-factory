/**
 * @module control-surface/registry
 * @description Resolves one `ControlSurface` per backend, mirroring the
 *   fail-closed shape of the existing `forge/registry` so this repo has one
 *   idiom for "resolve a provider-specific implementation behind a shared
 *   contract" rather than two competing ones. As there, a backend that cannot be
 *   built returns a bounded, secret-free error result instead of a half-built
 *   surface, and resolution is memoized so a repeated ask cannot change its
 *   answer within a pass.
 *
 *   `backends()` is deliberately ENUMERABLE. #253 clause 2 asks for agnosticism,
 *   not for two shipped backends today — Forgejo is named as "later". Making the
 *   set enumerable is what lets a second backend become observable the moment it
 *   is registered, with no edit to the callers or to the done-means check.
 *
 *   Backends are INJECTED as already-built surfaces rather than constructed from
 *   credentials here. The deployable-state audit is explicit that current `main`
 *   introduces ZERO new environment keys and that the config mechanism on the watcher host
 *   is the `config/repos.yml` symlink; a registry that resolved its own tokens
 *   would need a new key and would break that property. Composition stays with
 *   the caller that already holds a `ForgeClient`.
 *
 * @outputs
 *   - `ControlSurfaceResult` -- the fail-closed per-backend resolution result
 *   - `ControlSurfaceRegistry` -- enumerate backends, resolve one surface
 *   - `createControlSurfaceRegistry` -- build a registry over injected backends
 *
 * @dependencies
 *   - ./boundary -- the semantic control-surface contract
 */
import { traced } from "../log";
import type { ControlSurface } from "./boundary";

/** A resolved surface, or a bounded secret-free reason it is unavailable. */
export type ControlSurfaceResult =
	| { ok: true; surface: ControlSurface }
	| { ok: false; error: string };

/** The injectable backend set: a backend name to its built surface. */
export interface ControlSurfaceRegistryDeps {
	readonly backends?: Readonly<Record<string, ControlSurface>>;
}

/**
 * Enumerates the registered backends and resolves exactly one surface per name.
 * Fails closed: an unregistered name yields an error result, never a throw and
 * never an empty stub surface that would silently answer every read with
 * nothing.
 */
export class ControlSurfaceRegistry {
	private readonly registered: Readonly<Record<string, ControlSurface>>;
	private readonly cache = new Map<string, ControlSurfaceResult>();

	constructor(deps: ControlSurfaceRegistryDeps = {}) {
		this.registered = deps.backends ?? {};
	}

	/** The registered backend names, in registration order. */
	backends(): readonly string[] {
		return Object.keys(this.registered);
	}

	/** Resolve `backend`'s surface, memoizing the outcome. */
	surfaceFor(backend: string): ControlSurfaceResult {
		const cached = this.cache.get(backend);
		if (cached) {
			return cached;
		}
		const surface = this.registered[backend];
		const result: ControlSurfaceResult = surface
			? { ok: true, surface }
			: {
					ok: false,
					error: `no control-surface backend registered for '${backend}'`,
				};
		this.cache.set(backend, result);
		return result;
	}
}

/** Build a registry over the injected backends. */
export const createControlSurfaceRegistry = traced(
	"control-surface.createControlSurfaceRegistry",
	function createControlSurfaceRegistry(
		deps: ControlSurfaceRegistryDeps = {},
	): ControlSurfaceRegistry {
		return new ControlSurfaceRegistry(deps);
	},
);
