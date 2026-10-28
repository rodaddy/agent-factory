/**
 * @module runner/route
 * @description Decide the runtime/model/effort/endpoint route a rendered body
 *   dispatches with. Split out of `src/runner/dispatch.ts` when that module
 *   reached its 500-line ceiling; it remains a pure decision over a render result
 *   with no database, transport, or job-state involvement.
 *
 * @outputs
 *   - `RenderedDispatch` -- the render result this resolver consumes
 *   - `ENGINE_ENDPOINTS` -- reviewed base URL/auth-header-name endpoint pairs
 *   - `resolveRuntimeRoute` -- decide the explicit route, or refuse any route-less lane
 */

import { log, traced } from "../log";
import { PACKET_PI_DISPATCH_ENV_VAR, packetPiDispatchEnabled } from "../packets/dispatch-flag";
import { isPacketLane } from "../packets/registry";
import type { renderJobDispatch } from "../templates/registry";
import type { RunnerSubmission } from "./dispatch";
import { ENGINE_ENDPOINTS, type EngineEndpoint } from "./engine-endpoints";
import { SCRIPT_ROUTE } from "./script-route";
import type { RunnerEffort, RunnerRuntime } from "./transport";

export { ENGINE_ENDPOINTS, type EngineEndpoint } from "./engine-endpoints";

/**
 * The render result this resolver consumes. Typed off `renderJobDispatch`'s own
 * return so the body and any packet-declared route remain one typed artifact.
 */
export type RenderedDispatch = NonNullable<ReturnType<typeof renderJobDispatch>>;

/** Reviewed default routes for the four issue-bound agent job classes (compat-matrix and audit-rtech-audit retired sf#830). */
const AGENT_ROUTES = {
	"pr-review": { model: "gpt-6.1-sol", effort: "low" },
	"issue-triage": { model: "gpt-6.1-sol", effort: "low" },
	"implement-issue": { model: "gpt-6.1-sol", effort: "low" },
	"infra-static": { model: "gpt-6.1-sol", effort: "medium" },
} as const satisfies Record<string, { model: string; effort: RunnerEffort }>;

type AgentRoute = {
	runtime: Exclude<RunnerRuntime, "script">;
	model: string;
	effort: RunnerEffort;
	engineEndpoint?: EngineEndpoint;
};

/** Build the common endpoint-bearing agent submission shape. */
function agentSubmission(body: string, route: AgentRoute): RunnerSubmission {
	return {
		body,
		...route,
		engineEndpoint: route.engineEndpoint ?? ENGINE_ENDPOINTS.cliproxyapi,
	};
}

/** Resolve one packet-owned route without letting an agent packet become script. */
function resolvePacketRoute(
	jobType: string,
	rendered: RenderedDispatch,
	env: NodeJS.ProcessEnv,
): { ok: true; submission: RunnerSubmission } | { ok: false; reason: string } {
	const routing = rendered.routing;
	if (!routing) {
		return {
			ok: false,
			reason: `packet lane ${jobType} declares no runtime/model/effort route; refusing dispatch`,
		};
	}
	if (routing.runtime === "script") {
		return {
			ok: false,
			reason: `packet lane ${jobType} declares agentless runtime script with an agent route; refusing dispatch`,
		};
	}
	if (routing.runtime === "pi" && !packetPiDispatchEnabled(env)) {
		log("info", "dispatch.pi_flag_off", {
			job_type: jobType,
			declared_runtime: routing.runtime,
			flag_env_var: PACKET_PI_DISPATCH_ENV_VAR,
		});
		return {
			ok: false,
			reason: `packet lane ${jobType} declares runtime pi and ${PACKET_PI_DISPATCH_ENV_VAR} is off; refusing unrouted dispatch (sf#386)`,
		};
	}
	// L-042: gpt-6-luna runs only at max. The packet frontmatter is reviewed,
	// but this resolver is the last factory-side gate before the wire.
	if (routing.model === "gpt-6-luna" && routing.effort !== "max") {
		return {
			ok: false,
			reason: `packet lane ${jobType} declares gpt-6-luna at effort ${routing.effort}; luna runs only at max (L-042); refusing dispatch (sf#386)`,
		};
	}
	return {
		ok: true,
		submission: agentSubmission(rendered.body, {
			runtime: routing.runtime,
			model: routing.model,
			effort: routing.effort,
		}),
	};
}

/**
 * Decide the runtime and route for a rendered body.
 *
 * NO exit returns an unrouted submission: every `ok: true` names a
 * runtime, model, effort, and engine endpoint. Agentless templates declare
 * `runtime: script` and receive `SCRIPT_ROUTE` plus the cliproxyapi endpoint:
 * nothing is launched without naming its route, agentless included. A
 * template-declared NON-script runtime carries no model/effort and is REFUSED.
 * Packet lanes remain declaration-owned: a missing route is refused, an explicit
 * Claude selection is preserved, and a `pi` lane with the emission flag off is
 * REFUSED rather than sent unrouted, because the live wrapper rejects it. The four
 * reviewed agent classes receive explicit Codex defaults so none can inherit the
 * transport's Claude fallback, and an UNKNOWN job type is refused for naming no
 * reviewed route at all.
 *
 * @param jobType - the lane being dispatched
 * @param rendered - the body plus any route `renderJobDispatch` produced
 * @param env - environment used only by the legacy pi emission flag
 */
export const resolveRuntimeRoute = traced(
	"runner.resolveRuntimeRoute",
	function resolveRuntimeRoute(
		jobType: string,
		rendered: RenderedDispatch,
		env: NodeJS.ProcessEnv = process.env,
	): { ok: true; submission: RunnerSubmission } | { ok: false; reason: string } {
		if (rendered.runtime !== undefined) {
			if (rendered.runtime === "script") {
				return {
					ok: true,
					submission: {
						body: rendered.body,
						runtime: "script",
						...SCRIPT_ROUTE,
						engineEndpoint: ENGINE_ENDPOINTS.cliproxyapi,
					},
				};
			}
			return {
				ok: false,
				reason: `template for ${jobType} declares runtime ${rendered.runtime} with no model/effort route; refusing dispatch (sf#386)`,
			};
		}

		if (isPacketLane(jobType)) {
			return resolvePacketRoute(jobType, rendered, env);
		}

		const route = AGENT_ROUTES[jobType as keyof typeof AGENT_ROUTES];
		if (route !== undefined) {
			return {
				ok: true,
				submission: agentSubmission(rendered.body, { runtime: "codex", ...route }),
			};
		}

		return {
			ok: false,
			reason: `${jobType} has no reviewed model/effort route; refusing dispatch (sf#386)`,
		};
	},
	// arg 2 is a whole `process.env` by default — every credential in the watcher's
	// environment. traced() masks on object KEYS, so an unredacted env dumps verbatim.
	{ redact: { args: [2] } },
);
