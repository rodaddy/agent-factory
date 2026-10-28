/**
 * @module packets/dispatch-flag
 * @description The KILL SWITCH for emitting a packet's declared pi routing trio
 *   (`runtime`/`model`/`effort`) onto a runner submission. DEFAULT OFF.
 *
 *   WHY THIS EXISTS. #171 wires the factory half of the pi handoff, but the
 *   wrapper half is rtech-infra's and is NOT running yet: the live
 *   `scripts/runner-boxes` verb dies on any runtime that is not `claude|codex`,
 *   and `runner-job` has no `pi` arm. Emitting `runtime: "pi"` today therefore
 *   converts a WORKING issue-triage lane into a box-burning failure loop — the
 *   die is a non-JSON stderr exit, which the transport would otherwise read as a
 *   boot race and retry ten times while holding an allocated box.
 *
 *   So the emission is gated, not the wiring. With the flag OFF the routing trio
 *   is dropped at the dispatch boundary and a packet lane submits EXACTLY what it
 *   submitted before #171 (body only; the wrapper keeps its `claude` default).
 *   With the flag ON the full declared trio travels. Nothing else about the
 *   render, the packet contract, or the boot gate changes with the flag.
 *
 *   TURNING IT ON. The flag stays off until the rtech-infra pi arm is RUNNING —
 *   both the `runner-job` pi branch AND `runner_run` accepting `model`/`effort`
 *   (the MCP server drops unknown params silently today). See
 *   `_DOCS/runner-contract.md`.
 *
 *   ENV SHAPE. Read from `PACKET_PI_DISPATCH_ENABLED`, matching the repo's other
 *   env seams (`src/kboard/config.ts`, `src/results/change-verifier.ts`): a
 *   `NodeJS.ProcessEnv` parameter defaulting to `process.env`, so a test proves
 *   both states without mutating the real environment. Only the exact opt-in
 *   spellings enable it — anything else, including unset, empty, `0`, `false`, or
 *   a typo, is OFF. A kill switch must never be enabled by a misspelling.
 *
 * @outputs
 *   - `PACKET_PI_DISPATCH_ENV_VAR` -- the env var name (single source of truth)
 *   - `packetPiDispatchEnabled` -- resolve the flag from an environment
 */

import { traced } from "../log";

/** The env var that opts a deployment into emitting the pi routing trio. */
export const PACKET_PI_DISPATCH_ENV_VAR = "PACKET_PI_DISPATCH_ENABLED" as const;

/**
 * The exact values that mean ON. Deliberately a small closed set rather than
 * "anything truthy": an operator who exports `PACKET_PI_DISPATCH_ENABLED=maybe`
 * gets the safe state, not the box-burning one.
 */
const ENABLED_VALUES: readonly string[] = ["1", "true", "yes", "on"];

/**
 * Is the pi routing emission enabled for this process? DEFAULT FALSE.
 *
 * @param env - environment to read (defaults to `process.env`)
 * @returns true only when the env var carries an exact opt-in value
 */
export const packetPiDispatchEnabled = traced(
	"packets.packetPiDispatchEnabled",
	function packetPiDispatchEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
		const raw = env[PACKET_PI_DISPATCH_ENV_VAR];
		if (raw === undefined) {
			return false;
		}
		return ENABLED_VALUES.includes(raw.trim().toLowerCase());
	},
	// A whole environment as arg 0 would put every secret this process holds into
	// a debug trace. The RESULT is the interesting bit and is one boolean.
	{ redact: { args: [0] } },
);
