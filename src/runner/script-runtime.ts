/**
 * @module runner/script-runtime
 * @description The AGENTLESS `script` runtime. A lane whose invocation is
 *   already fully known does not need an agent to rediscover it: the packet
 *   carries the exact allowlisted command block from the reviewed template and
 *   the runner executes it with no LLM in the loop, and therefore with no agent
 *   credential.
 *
 *   The business case is on record: of 291 observed job failures, 173 were
 *   agent-runtime deaths, and the fleet OAuth outage (2026-08-14) would not have
 *   touched an agentless lane at all — a lane that holds no Claude credential
 *   cannot fail on one.
 *
 *   TWO PROPERTIES MAKE THIS SAFE, and both are enforced here rather than in
 *   prose:
 *
 *   1. **Commands come only from the reviewed template.** `scriptCommandSet`
 *      reads the SAME `INFRA_STATIC_COMMANDS` literal the agent lane already
 *      instructs, so the agentless lane cannot drift from the reviewed set, and
 *      there is no second copy to update. Repository content contributes nothing:
 *      the render takes no context at all, so there is no slot for it to reach.
 *      (`AGENTS.md`: a runner must never accept commands from repository content.)
 *   2. **A script route carries no agent route.** `model` and `effort` exist only
 *      for the `pi` runtime; travelling with `script` they are a routing
 *      defect, so `scriptRouteViolation` names them and the transport refuses the
 *      submission BEFORE a box is allocated.
 *
 * @outputs
 *   - `SCRIPT_RUNTIME` / `scriptRouteViolation` -- re-exported from
 *     `./script-route`, the dependency-free leaf the transport imports, so a
 *     caller that wants the whole script runtime has one import to reach for
 *   - `AGENTLESS_TEMPLATE_IDS` / `isAgentlessTemplate` -- the narrow opt-in set
 *   - `scriptCommandSet` -- the reviewed command set for an agentless template
 *   - `renderScriptCommandBlock` -- the fixed, fail-fast command block
 *
 *   The pre-push receipt lane (`repo-validate`) also composes its command
 *   set here, so the receipt script the box execs and the receipt schema share the
 *   one `PREPUSH_COMMANDS` literal and cannot drift into two copies.
 *
 * @dependencies
 *   - ../infra/body -- the reviewed per-gate static command literal
 *   - ../infra/gates -- the fixed gate order
 *   - ../prepush/receipt -- the fixed pre-push command literal and template id
 *   - ./script-route -- the dependency-free runtime literal and route guard
 *   - ../log -- the shared traced() wrapper on the exported functions
 */
import { INFRA_STATIC_COMMANDS } from "../infra/body";
import { STATIC_GATES } from "../infra/gates";
import { traced } from "../log";
import { PREPUSH_COMMANDS, PREPUSH_TEMPLATE_ID } from "../prepush/receipt";
import { SCRIPT_RUNTIME, scriptRouteViolation } from "./script-route";

export type { ScriptRouteCandidate } from "./script-route";
export { SCRIPT_RUNTIME, scriptRouteViolation };

/**
 * The templates that dispatch agentless, and ONLY those.
 *
 * Deliberately narrow. #177's non-goal is explicit: judgment lanes (triage,
 * review, implement) are agents by design and are never converted. The agentless
 * variant is a SEPARATE template id from its agent sibling (`infra-static`)
 * rather than a flag on it, so the two bodies, the two runtimes, and the two
 * dispatch paths cannot be confused for one another — and so converting a lane
 * is an additive reviewed change rather than an edit that silently reroutes
 * every existing dispatch of that id.
 */
export const AGENTLESS_TEMPLATE_IDS = ["infra-static-agentless"] as const;

export type AgentlessTemplateId = (typeof AGENTLESS_TEMPLATE_IDS)[number];

/**
 * Every template id whose command set is composed here. `repo-validate`
 * is deliberately NOT added to `AGENTLESS_TEMPLATE_IDS`: the watcher still
 * dispatches that id as an AGENT lane through `service-proposal-deps.ts`, so
 * `renderScriptCommandBlock` — gated on `isAgentlessTemplate` — must keep
 * returning `null` for it. Only the pre-push receipt body reads its group, and
 * it reads it by name.
 */
export type ScriptCommandTemplateId = AgentlessTemplateId | typeof PREPUSH_TEMPLATE_ID;

/**
 * True when a template id dispatches with no agent in the loop.
 *
 * The parameter is `unknown` rather than `string` ONLY because that is the shape
 * `traced()`'s type-guard overload declares: a guard whose parameter is
 * narrower falls through to the general overload, which returns a plain
 * `boolean` and silently ERASES the predicate — observed here as
 * `renderScriptCommandBlock` failing to narrow `jobType` for `scriptCommandSet`.
 * Every existing call passes a string and is unaffected, and `unknown` is
 * strictly more permissive, so no caller is narrowed out.
 */
export const isAgentlessTemplate = traced(
	"runner.isAgentlessTemplate",
	function isAgentlessTemplate(jobType: unknown): jobType is AgentlessTemplateId {
		return (AGENTLESS_TEMPLATE_IDS as readonly string[]).includes(jobType as string);
	},
);

/** One reviewed group of fixed commands, carrying its fixed human label. */
export interface ScriptCommandGroup {
	readonly label: string;
	readonly commands: readonly string[];
}

/**
 * The reviewed command set an agentless template executes.
 *
 * `infra-static-agentless` is composed from `INFRA_STATIC_COMMANDS` — the same
 * literal the agent `infra-static` lane already enumerates — in the fixed
 * `STATIC_GATES` order. It is NOT a copy: editing a gate's checks edits one
 * reviewed literal and both lanes move together.
 *
 * The agentless variant runs EVERY gate rather than a watcher-selected subset.
 * Gate selection exists to bound an agent's turn budget; a script run has no
 * turns to bound and the full static sweep is the cheaper, more useful answer,
 * so there is no selection input and therefore no per-dispatch variability for a
 * caller to influence.
 *
 * A FUNCTION, not a top-level constant, and that is load-bearing rather than
 * stylistic. `../infra/body` imports `../templates/registry`, which imports this
 * module, so a constant that read `INFRA_STATIC_COMMANDS` at module-init time
 * closed the loop and every template and runner test died at load with
 * `ReferenceError: Cannot access 'INFRA_STATIC_COMMANDS' before initialization`.
 * Reading the literal at CALL time — long after every module has finished
 * initializing — makes the cycle inert. The commands are still the same single
 * reviewed literal; only the moment they are read moved.
 */
export const scriptCommandSet = traced(
	"runner.scriptCommandSet",
	function scriptCommandSet(jobType: ScriptCommandTemplateId): readonly ScriptCommandGroup[] {
		// One entry today. A `switch` rather than a map keeps the read lazy per id and
		// makes adding a second agentless lane a visible, reviewed edit.
		switch (jobType) {
			case "infra-static-agentless":
				return STATIC_GATES.map((gate) => ({
					label: INFRA_STATIC_COMMANDS[gate].label,
					commands: INFRA_STATIC_COMMANDS[gate].commands,
				}));
			case PREPUSH_TEMPLATE_ID:
				return [{ label: "Exact-SHA pre-push validation", commands: PREPUSH_COMMANDS }];
		}
	},
);

/**
 * Render the fixed command block an agentless template executes, or `null` for
 * any template that is not agentless (so an agent lane can never be dispatched
 * down this path by a typo'd id).
 *
 * The block is FAIL-FAST (`set -euo pipefail`): a failed check must end the run
 * with a non-zero status, which is what the wrapper turns into a failed result.
 * A script failure is still a VALID result — status `failed`, attempt completed
 * — exactly as an agent lane's failure is (the #95 structural rule); it is not
 * a lane that never ran.
 *
 * The function takes NO render context on purpose. Every substitution point in
 * an executed command block is a place repository content could reach, and the
 * only safe number of them is zero.
 */
export const renderScriptCommandBlock = traced(
	"runner.renderScriptCommandBlock",
	function renderScriptCommandBlock(jobType: string): string | null {
		if (!isAgentlessTemplate(jobType)) {
			return null;
		}
		const lines: string[] = ["#!/usr/bin/env bash", "set -euo pipefail"];
		for (const group of scriptCommandSet(jobType)) {
			lines.push("", `# ${group.label}`, ...group.commands);
		}
		return lines.join("\n");
	},
);
