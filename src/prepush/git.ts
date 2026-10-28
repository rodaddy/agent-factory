/**
 * @module prepush/git
 * @description Git object-id predicate shared by the runner body renderers.
 *
 * @outputs
 *   - `isFullSha` -- a complete lowercase SHA-1 or SHA-256 object id
 *
 * @dependencies
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { traced } from "../log";

/** A complete lowercase Git object id (SHA-1 or SHA-256), never an abbreviation. */
export const isFullSha = traced("prepush.isFullSha", (value: string): boolean =>
	/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value),
);
