/**
 * @module runner/script-route
 * @description The AGENTLESS runtime literal, the reviewed route an agentless job
 *   declares, and the route guard that keeps an agentless submission from
 *   travelling UNROUTED. Deliberately DEPENDENCY-FREE.
 *
 *   WHY IT IS ITS OWN MODULE. `src/runner/transport.ts` needs this guard, and the
 *   command-set half of the script runtime (`./script-runtime`) is composed from
 *   the reviewed infra gate literal — which reaches the template registry, the
 *   packet renderer, and back to the transport. Importing the composed module
 *   from the transport closes that loop, and the loop is not theoretical: it made
 *   `packetFrontmatterSchema`'s `z.enum(RUNNER_RUNTIMES)` read the union before
 *   initialization and every transport test died at load with
 *   `ReferenceError: Cannot access 'RUNNER_RUNTIMES' before initialization`.
 *   Splitting the pure guard out is the smallest correct fix: the transport
 *   depends on a leaf, and the composed module is free to depend on infra.
 *
 * @outputs
 *   - `SCRIPT_RUNTIME` -- the agentless runtime literal
 *   - `SCRIPT_ROUTE` -- the reviewed model/effort an agentless job declares
 *   - `ScriptRouteCandidate` -- the route fields the guard inspects
 *   - `scriptRouteViolation` -- the named unrouted-script-submission defect
 *   - `RunRouteCandidate` -- the route fields the every-runtime guard inspects
 *   - `runRouteViolation` -- the named unrouted-submission defect, any runtime
 *
 * @dependencies
 *   - ../log -- the shared traced() wrapper, and ONLY that. `src/log.ts` imports
 *     nothing but `pino`, so it is a leaf and cannot re-enter the cycle this
 *     module was split out to break.
 */
import { traced } from "../log";

/**
 * The agentless runtime. Named here rather than inlined so the transport union,
 * the template declaration, and the route guard all cite one literal.
 */
export const SCRIPT_RUNTIME = "script" as const;

/**
 * The reviewed route an agentless job DECLARES (an owner ruling, sf#384:
 * nothing is launched without naming a real model and effort, agentless
 * included). The box does not invoke the model on a script lane; the declaration
 * is the record of who chose the route, so a submission can never be read
 * downstream as having been left unrouted by accident. Luna is only ever
 * dispatched at max.
 */
export const SCRIPT_ROUTE = { model: "gpt-6-luna", effort: "max" } as const;

/** The route fields this guard inspects — a structural subset of a run's params. */
export interface ScriptRouteCandidate {
	runtime?: string;
	model?: string;
	effort?: string;
}

/**
 * Name the defect when an agentless submission travels WITHOUT a route, or
 * `null` when the route is complete.
 *
 * The original #177 guard did the opposite: it REFUSED a model or effort on a
 * script route, on the reasoning that a script invokes no LLM. sf#384 reverses
 * it. An unrouted submission is indistinguishable downstream from a chosen one,
 * so the record never shows who picked the route — and the MCP server
 * now refuses any submission missing model, effort, or
 * engine endpoint outright.
 *
 * The failure mode of letting an unrouted submission through is still the worst
 * kind, and it is why the guard runs BEFORE the first invoke: the MCP boundary
 * silently DROPS params the server does not declare (probed 2026-08-03), so a
 * mis-assembled route would otherwise be a success-shaped run with no signal
 * anywhere that the routing was wrong.
 *
 * Returns a MESSAGE rather than a boolean so the caller's error names which key
 * was missing; an operator reading "runner_run refused" learns nothing.
 *
 * Only reached for `runtime === "script"`. Every agent runtime — including `pi`
 * with its full declared trio — passes through untouched.
 */
export const scriptRouteViolation = traced(
	"runner.scriptRouteViolation",
	function scriptRouteViolation(candidate: ScriptRouteCandidate): string | null {
		if (candidate.runtime !== SCRIPT_RUNTIME) {
			return null;
		}
		const missing = (["model", "effort"] as const).filter(
			(key) => typeof candidate[key] !== "string" || candidate[key] === "",
		);
		if (missing.length === 0) {
			return null;
		}
		return `script runtime must name model and effort (sf#384); missing: ${missing.join(" and ")}`;
	},
);

/** The route fields the every-runtime guard inspects — a structural subset of a run's params. */
export interface RunRouteCandidate {
	model?: string;
	effort?: string;
	engineEndpoint?: { baseUrl: string; authHeaderName: string };
}

/**
 * Name the defect when ANY submission travels without a complete route, or
 * `null` when model, effort, and the engine endpoint are all present and
 * non-empty. This generalizes `scriptRouteViolation` from the one
 * agentless runtime to every runtime, because the v2 runner server
 * (rtech-infra#1051/#1063, live on a fleet host since 2026-08-25) DECLARES and REQUIRES
 * `model`, `effort`, `engine_base_url`, and `engine_auth_header_name` on
 * `runner_run` and refuses a fieldless submission at the schema layer.
 *
 * WHY IT RUNS BEFORE THE FIRST INVOKE. By the time `run` is reached a box is
 * already allocated and HELD, so a submission the server will refuse costs the
 * whole boot window on a live box — the #175 cost, paid once already. It is also
 * the only place a mis-assembled route can be caught at all: the MCP boundary
 * silently DROPS params the server does not declare (probed 2026-08-03), so a
 * route assembled with the wrong keys would otherwise be a success-shaped no-op
 * with no signal anywhere that the routing was wrong.
 *
 * Returns a MESSAGE rather than a boolean so the caller's error names which key
 * was missing; an operator reading "runner_run refused" learns nothing.
 */
export const runRouteViolation = traced(
	"runner.runRouteViolation",
	function runRouteViolation(candidate: RunRouteCandidate): string | null {
		const missing: string[] = [];
		for (const key of ["model", "effort"] as const) {
			if (typeof candidate[key] !== "string" || candidate[key] === "") {
				missing.push(key);
			}
		}
		const endpoint = candidate.engineEndpoint;
		if (
			endpoint === undefined ||
			typeof endpoint.baseUrl !== "string" ||
			endpoint.baseUrl === "" ||
			typeof endpoint.authHeaderName !== "string" ||
			endpoint.authHeaderName === ""
		) {
			missing.push("engineEndpoint");
		}
		if (missing.length === 0) {
			return null;
		}
		return `must name model, effort, and engineEndpoint before a box is held (sf#390); missing: ${missing.join(" and ")}`;
	},
);
