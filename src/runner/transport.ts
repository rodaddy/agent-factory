/**
 * @module runner/transport
 * @description The seam between the watcher and the existing runner-box MCP
 *   interface. `RunnerTransport` is a narrow, injectable contract over the
 *   three verbs the watcher uses — allocate (`needed`), submit (`run`), and
 *   reap (`done`). The default implementation shells out to
 *   `mcp2cli runner-boxes <verb>`; tests supply a fake. The watcher never opens
 *   an SSH session, selects a host, or issues arbitrary commands — it only
 *   passes a fixed job body through this contract.
 *
 *   This module keeps the verb contract, the default CLI implementation, and the
 *   output CLASSIFIERS (`isRefusal`, `isContractRejection`, `hasErrorPayload`,
 *   `isTransportFault`) plus `DEFAULT_VERB_TIMEOUT_MS` and `NEEDED_TIMEOUT_MS` — the symbols
 *   `_DOCS/runner-contract.md` cites at
 *   this path. The box PARSING region (`parseBoxes`, `parsePlacedBoxes`,
 *   `classifyVmid`, the envelope unwrapping and the #78 inventory guard) lives in
 *   `./transport-boxes` and is re-exported here, so every existing importer of
 *   this module is unaffected.
 *
 * @outputs
 *   - `RunnerTransport` -- the injectable verb contract
 *   - `Mcp2cliRunnerTransport` -- default implementation over the CLI
 *   - `RunnerAllocation` / `RunnerRefusal` -- allocation result union
 *   - `parseBoxes` / `isRefusal` / `hasErrorPayload` -- output classifiers
 *   - `isContractRejection` -- a terminal verb-contract rejection (never a boot race)
 *
 * @dependencies
 *   - bun (spawn) -- invoke the mcp2cli runner-boxes verbs
 *   - ../log -- structured stderr logging for the classifier fall-through paths
 *   - ./transport-boxes -- the guarded box parsing this re-exports
 */
import { errorClass, log, traced } from "../log";
import { redactSecrets } from "../results/ingest";
/**
 * Allocatable-box membership comes from the runner box inventory
 * (`./bands`), NOT from a hardcoded numeric range. A VMID is allocatable only if
 * the inventory holds a row for it and marks it so; a template or the
 * orchestrator is KNOWN but never allocatable.
 *
 * The old `RUNNER_POOL_MIN`/`MAX` constants are gone deliberately. They were
 * copied as literals into two Zod schemas as well, so "the single source of
 * truth" was never single, and a stale floor silently dropped every box the fleet
 * actually placed.
 */
import { isAllocatableVmid, lookupBox } from "./bands";
import type { EngineEndpoint } from "./engine-endpoints";
import { runnerRunArgs } from "./routing-args";
import { runRouteViolation } from "./script-route";
import {
	classifyVmid,
	type ListedBox,
	parseBoxes,
	parseForgeSlots,
	parseListedBoxes,
	parsePlacedBoxes,
	type RunnerBox,
	type VmidRejection,
} from "./transport-boxes";

export {
	classifyVmid,
	isAllocatableVmid,
	type ListedBox,
	lookupBox,
	parseBoxes,
	parseForgeSlots,
	parseListedBoxes,
	parsePlacedBoxes,
	type RunnerBox,
	type VmidRejection,
};

/**
 * Default hard local per-verb timeout. mcp2cli itself returns CONNECTION_ERROR
 * past ~60s while work continues; this ceiling only guards against a truly
 * wedged verb so it cannot stall the single-flight reconciliation loop
 * indefinitely.
 */
export const DEFAULT_VERB_TIMEOUT_MS = 90_000;

/**
 * `runner_stop` budget. The verb runs `pct shutdown --timeout 120` (a graceful
 * shutdown bounded at 120 s), so the 90 s default would abandon
 * a stop the gateway is still honouring. 120 s plus a 30 s margin for the SSH hop
 * and the status re-read.
 */
export const RUNNER_STOP_TIMEOUT_MS = 150_000;

/**
 * `runner_forge_up` budget. The gateway clones the slot, starts it, and
 * waits up to 90 s for the runner to go active; 150 s covers clone time plus margin.
 */
export const RUNNER_FORGE_UP_TIMEOUT_MS = 150_000;

/**
 * Allocation timeout. CT create + configure + DHCP under pool contention can
 * legitimately exceed 90s, and abandoning `needed` orphans its own placement.
 */
export const NEEDED_TIMEOUT_MS = 240_000;

/**
 * Bounded readiness-retry for `run`. `needed` returns a box vmid as soon as it
 * has a DHCP lease, but the container's userspace is not yet ready to accept the
 * `pct push --user 2021`/a shell on its host that `run` performs — the runner user and
 * `/work/job` are still being provisioned — so an early `run` fails fast with a
 * non-zero exit. `run`'s own success IS the readiness signal (the narrow verb
 * contract forbids a separate a shell on its host probe), so we resubmit the SAME request
 * across the provisioning window until the box accepts it. A failed `run` never
 * launches the job (the verb's `pct push`/a shell on its host fail atomically before the
 * agent starts), so retrying cannot double-launch.
 *
 * The window must actually cover provisioning: allocation alone can take ~40s,
 * and the box can need well past a minute more before it is exec-ready under
 * load. The defaults give ~10 attempts over ~150s. A structured refusal or
 * transport-fault payload is NOT a readiness lag, so it stops the loop at once
 * rather than burning the whole window.
 */
export const DEFAULT_RUN_READY_ATTEMPTS = 10;
export const DEFAULT_RUN_READY_DELAY_MS = 15_000;

/**
 * Attempts and delay for a `done` retried through a TRANSPORT fault only.
 *
 * Deliberately short and few: the observed fault clears on the immediate second
 * call, so this covers a cold or briefly-wedged daemon, not an outage. Three
 * attempts over ~4s. A daemon that is genuinely down must surface quickly as an
 * UNKNOWN-outcome error an operator can act on, not stall the caller.
 */
export const DONE_TRANSPORT_ATTEMPTS = 3;
export const DEFAULT_DONE_RETRY_DELAY_MS = 2_000;

/**
 * Allocation succeeded with at least one box, or was cleanly refused. A refusal
 * still carries `placed`: any in-pool boxes the runner-boxes verb had already
 * powered on before it refused (the "partial placement" case the runner-boxes
 * README documents). A caller that abandons the allocation MUST reap `placed`
 * or those boxes are stranded (the Proxmox capacity-ceiling incident class).
 * `placed` is optional and defaults to `[]`, so existing `refused:true` checks
 * are unaffected.
 */
export type RunnerAllocation =
	| { ok: true; boxes: RunnerBox[] }
	| { ok: false; refused: true; reason: string; placed?: RunnerBox[] };

/**
 * The runtimes the fleet wrapper knows how to launch. `claude` and `codex` are
 * the two it has always accepted (rtech-infra `scripts/runner-job`); `pi` is the
 * packet runtime the wrapper composes a `pi -p --mode json` invocation for
 * from the model/effort this dispatch hands it. The union is CLOSED so a typo'd
 * runtime is a type error here rather than an unrecognized string the wrapper
 * discovers on a box.
 *
 * `script` is the odd one out and the point of that issue: it is
 * AGENTLESS. The wrapper executes the job body as a fixed command block and
 * launches no agent binary, so the lane holds no agent credential and cannot die
 * of an agent-runtime fault — the failure class that accounted for 173 of 291
 * observed job failures. It carries no model and no effort (see
 * `./script-route` and `./script-runtime`), and the transport refuses a
 * submission that pairs one
 * with it.
 *
 * The wrapper half of `pi` and `script` is rtech-infra's work; the handoff
 * contract this side must satisfy is written down in `_DOCS/runner-contract.md`.
 */
export const RUNNER_RUNTIMES = ["claude", "codex", "pi", "script"] as const;

export type RunnerRuntime = (typeof RUNNER_RUNTIMES)[number];

/** The routed effort tier, matching the fleet router's canonical effort set. */
export const RUNNER_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type RunnerEffort = (typeof RUNNER_EFFORTS)[number];

/** Parameters for submitting a job to an allocated box. */
export interface RunnerRunParams {
	vmid: number;
	jobId: string;
	/** The fixed job body (a rendered template), never arbitrary user input. */
	job: string;
	runtime?: RunnerRuntime;
	maxTurns?: number;
	/** Reviewed model id; required on every route, agentless included. */
	model?: string;
	/** Reviewed effort tier paired with `model`. */
	effort?: RunnerEffort;
	/** Reviewed engine base URL/auth-header-name pair; contains no credential value. */
	engineEndpoint?: EngineEndpoint;
}

/** A scoped `runner_done` refused because the vmid belongs to another job. */
export interface RunnerDoneRefusal {
	refused: true;
	ownerJobId: string;
}

/** Success is `void`; ownership refusal is data so callers can skip without paging. */
export type RunnerDoneOutcome = void | RunnerDoneRefusal;

/** Narrow contract over the runner-box verbs the watcher needs. */
export interface RunnerTransport {
	/** Allocate `count` boxes of `size` for `jobId`. May be refused on capacity. */
	needed(size: string, jobId: string, count: number): Promise<RunnerAllocation>;
	/** Stage and fire a job on a box. Resolves when accepted; rejects on error. */
	run(params: RunnerRunParams): Promise<void>;
	/** Reap a box, optionally proving which job owns it. Other-owner refusal is data. */
	done(vmid: number, jobId?: string): Promise<RunnerDoneOutcome>;
	/**
	 * List the boxes the fleet reports as existing, with their attribution stamps.
	 *
	 * READ-ONLY, and the only verb here that grants no authority over a box. It
	 * exists because a `runner_needed` that times out client-side generally
	 * COMPLETES server-side and returns no vmid, leaving a box nothing can name.
	 * Job ids are single-use per attempt, so a caller can list, match its OWN job
	 * id, and identify exactly its own orphan. Matching ANOTHER caller's job id is
	 * never a licence to act on that box.
	 */
	list(): Promise<ListedBox[]>;
	/** Bring a forge slot up (`runner_forge_up`, the gateway clones it). A gateway refusal throws `RunnerBandRefusedError`. */
	startBandMember(vmid: number): Promise<void>;
	/** Take a forge slot down (`runner_forge_down`, the gateway destroys it; `refused: busy` while it holds a job). A gateway refusal throws `RunnerBandRefusedError`. */
	stopBandMember(vmid: number): Promise<void>;
	/** List the members of a named band (`runner_list {band}`). A gateway refusal throws `RunnerBandRefusedError`. */
	listBand(band: "forge"): Promise<ListedBox[]>;
}

/** Exact declared `runner_done` arguments; omission preserves operator-force. */
export const runnerDoneArgs = traced(
	"runner.runnerDoneArgs",
	function runnerDoneArgs(vmid: number, jobId?: string): Record<string, unknown> {
		return jobId === undefined ? { vmid } : { vmid, job_id: jobId };
	},
);

/** Exact argv passed to mcp2cli for one runner-box verb. */
export const runnerBoxArgv = traced(
	"runner.runnerBoxArgv",
	function runnerBoxArgv(bin: string, verb: string, params: Record<string, unknown>): string[] {
		return [bin, "runner-boxes", verb, "--params", JSON.stringify(params)];
	},
	// RESULT ONLY, and this one is the sharpest instance of the class. The ARGS
	// need no mask: `params` is a plain object, so `summarize()` matches its
	// secret-named KEYS and `.enter` already prints `"token":"[REDACTED]"`. Then
	// `JSON.stringify` flattens that object into one string and DESTROYS the very
	// key the masking keyed on, so the unmasked token reappears in full on the
	// `.exit` line. Probed: `.enter` emits `"token":"[REDACTED]"` while `.exit`
	// emitted `--params {"token":"m2c_AAAA…"}` verbatim. `createRunnerTransport`
	// calls this on the live `Bun.spawn` path with real verb params, not fixtures.
	{ redact: { result: true } },
);

/** Parse the deployed verb's ownership refusal and name the current owner. */
export const parseDoneRefusal = traced(
	"runner.parseDoneRefusal",
	function parseDoneRefusal(text: string): RunnerDoneRefusal | null {
		const match = text.match(/REFUSED: vmid \d+ is owned by job '([^']+)', not '[^']+'/);
		return match?.[1] ? { refused: true, ownerJobId: match[1] } : null;
	},
	// BOTH ENDS. Arg 0 is raw combined verb stdout/stderr as a bare positional:
	// the mcp2cli path has no `scrub()`, so nothing upstream has stripped a token
	// from it, and `summarize()` masks on object KEYS. The RETURN is not safe
	// either, and an earlier version of this comment claiming "the parsed owner id
	// is the signal" was wrong -- `([^']+)` captures whatever sits between the
	// quotes, so a credential echoed into a gateway refusal body is lifted
	// straight back out of the text arg 0 was protecting. Probed: `.enter` showed
	// `args:["[REDACTED]"]` while `.exit` showed `ownerJobId:"m2c_AAAA…"`.
	{ redact: { args: [0], result: true } },
);

/** Convert a failed HTTP `runner_done` answer to refusal data or a bounded error. */
export const runnerDoneFailure = traced(
	"runner.runnerDoneFailure",
	function runnerDoneFailure(vmid: number, failure: string): RunnerDoneRefusal {
		const refusal = parseDoneRefusal(failure);
		if (refusal) return refusal;
		throw new Error(`runner_done failed for vmid ${vmid} -- ${boundedPayload(failure)}`);
	},
	// Arg 1 is the gateway's raw failure body. The HTTP transport's `scrub()`
	// removes only ITS OWN bearer token, never a runner-side credential echoed
	// back in the body — which is exactly why the throw path runs it through
	// `boundedPayload` first. The vmid (arg 0) stays visible.
	{ redact: { args: [1] } },
);

/** Map `runner_done` data to the dispatch vocabulary and emit the refusal event. */
export const classifyDone = traced(
	"runner.classifyDone",
	function classifyDone(
		outcome: RunnerDoneOutcome,
		vmid: number,
		jobId?: string,
	): "reaped" | "skipped-identity-mismatch" {
		if (!outcome?.refused) return "reaped";
		log("warn", "runner.reap_refused_by_verb", {
			vmid,
			runner_job_id: jobId,
			verb_job_id: outcome.ownerJobId,
		});
		return "skipped-identity-mismatch";
	},
);

/**
 * A clean capacity refusal from the verb module. Anchored on refusal-specific
 * phrasing so a success message that merely mentions "capacity" is not
 * misclassified, while still covering the common ways the pool reports "full".
 */
export const isRefusal = traced(
	"runner.isRefusal",
	function isRefusal(text: string): boolean {
		return /\b(refus\w*|exhaust\w*|at capacity|over capacity|no (?:free |available )?(?:slot|runner|box|capacity)|0 (?:free|available)|none available|all (?:slots?|runners?|boxes) busy|pool (?:is )?full|fully utili[sz]ed)\b/i.test(
			text,
		);
	},
	// Raw combined verb stdout/stderr as a bare positional; the boolean verdict
	// is the signal, and `isTransportFault` below already redacts the identical
	// value for the identical reason.
	{ redact: { args: [0] } },
);

/**
 * A CONTRACT rejection from the verb: it understood the request and rejected the
 * request itself, so the same request will be rejected again no matter how long
 * the box has been up. Distinct from `isRefusal` (a capacity condition, which the
 * allocation path reports as "runner capacity unavailable") and from a bare
 * not-ready exit (a boot race, which IS worth retrying).
 *
 * WHY THIS EXISTS. The live `scripts/runner-boxes` verb dies on any
 * runtime that is not `claude|codex`, and it dies with a plain non-JSON stderr
 * message and a non-zero exit — indistinguishable, to `run`'s retry loop, from a
 * container that is not exec-ready yet. So a runtime the wrapper does not know
 * would be retried the full boot window (10 attempts x 15s ≈ 2.5 min) while
 * HOLDING an allocated box, and every one of those attempts is certain to fail.
 * Classifying the rejection makes it terminal on the FIRST attempt, so the caller
 * reaps and records immediately.
 *
 * The strings are the live verb's own rejection phrasings, matched loosely enough
 * to survive rewording of the surrounding sentence and narrowly enough that a
 * successful run mentioning a runtime name is not caught.
 */
export const isContractRejection = traced(
	"runner.isContractRejection",
	function isContractRejection(text: string): boolean {
		return /must be claude\|codex|\bunknown[- ]runtime\b|\bunsupported runtime\b|\binvalid runtime\b/i.test(
			text,
		);
	},
	// Raw combined verb stdout/stderr as a bare positional. The call site that
	// uses this verdict deliberately throws FIXED prose rather than the payload,
	// "never raw stdout/stderr, which is untrusted runner output" — the trace
	// must not reintroduce what that line refuses to carry.
	{ redact: { args: [0] } },
);

/**
 * A TRANSPORT fault: the mcp2cli client could not reach its local daemon, so the
 * verb never ran and its outcome is UNKNOWN. Distinct from a verb that ran and
 * failed, because the two demand opposite handling.
 *
 * Observed repeatedly on 2026-07-27/28: the FIRST call fails and an immediate
 * retry of the identical call succeeds.
 *
 *   {"error":true,"code":"CONNECTION_ERROR",
 *    "message":"Failed to communicate with local daemon: The operation timed out."}
 *
 * It is not a timeout of the work. The verb takes seconds; the runner-boxes MCP
 * server allows 300s and the mcp2cli service config allows ~62 minutes. The
 * failure is the client-to-daemon hop, before dispatch — consistent with a cold
 * start or a wedged worker.
 *
 * Treating this as a verb failure is what strands boxes. On `done` the caller
 * has just been handed a live VMID it owns; if one CONNECTION_ERROR is taken as
 * terminal, that pool slot leaks forever. That is the #406 leak reached from the
 * reap side rather than the allocation side.
 */
/**
 * An allocation whose outcome is UNKNOWN, not one that is known to have failed.
 *
 * The transport hop to the local daemon faulted, so the verb's fate is unknown —
 * and per `_DOCS/deployment.md` a timed-out `runner_needed` generally COMPLETES
 * server-side. The box gets placed; the response that would have carried its
 * vmid never arrives. The watcher therefore owns a running container it cannot
 * name, and the host-local reaper is stopped-only by design, so nothing
 * automatic collects it.
 *
 * Distinct from `runner_needed failed`, where the verb ran, refused, and placed
 * nothing. Collapsing the two is what invites the retry that leaks a second box
 * (observed 2026-07-28, three manual `runner_done` calls).
 */
/**
 * The gateway REFUSED a forge-band verb (`runner_start`/`runner_stop`/`runner_list
 * {band}`), e.g. `refused: vmid 9001 is outside the forge band 9101-9150`. The verb
 * ran and said no; repeating it will not change the answer.
 */
export class RunnerBandRefusedError extends Error {
	override readonly name = "RunnerBandRefusedError";
}

export class RunnerAllocationUnknownError extends Error {
	override readonly name = "RunnerAllocationUnknownError";
}

/**
 * The operator-facing remedy for an allocation whose outcome is unknown.
 *
 * Deliberately names no vmid: none is known at this point, and inventing one
 * would send the operator to reap a box that may belong to another job.
 */
export const STRANDED_BOX_HINT =
	"a box may be RUNNING and unattributable; check runner_list and reap by vmid before retrying -- retrying first can leak another box";

export const isTransportFault = traced(
	"runner.isTransportFault",
	function isTransportFault(stdout: string, stderr = ""): boolean {
		const combined = `${stdout}\n${stderr}`;
		if (/\bCONNECTION_ERROR\b/.test(combined)) {
			return true;
		}
		// Match the daemon-hop message shape even if the code field is absent or
		// renamed. Anchored on "local daemon" so an unrelated timeout (a verb that
		// genuinely ran too long) is NOT swallowed as retryable.
		return /failed to communicate with (?:the )?local daemon/i.test(combined);
	},
	// Both args are raw verb stdout/stderr -- untrusted fleet output, and the
	// classification is the useful signal, not the payload it read.
	{ redact: { args: [0, 1] } },
);

/**
 * Detect a structured error payload emitted on stdout even when the process
 * exits 0. Some verbs report a failure in-band, so exit code alone is not a
 * sufficient success signal.
 */
export const hasErrorPayload = traced(
	"runner.hasErrorPayload",
	function hasErrorPayload(stdout: string): boolean {
		const trimmed = stdout.trim();
		if (!trimmed) {
			return false;
		}
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (parsed && typeof parsed === "object") {
				const obj = parsed as Record<string, unknown>;
				if (typeof obj.error === "string" && obj.error.length > 0) {
					return true;
				}
				// The mcp2cli client reports transport faults as `{"error":true,...}` and
				// verb failures as `{"success":false,...}`; both are in-band errors.
				if (obj.error === true || obj.success === false) {
					return true;
				}
				if (typeof obj.status === "string" && /^(?:failed|error)$/i.test(obj.status)) {
					return true;
				}
				if (obj.ok === false) {
					return true;
				}
				// mcp2cli wraps a COMPLETED tool call whose underlying verb failed as
				// `{"success":true,"result":{"ok":false,...}}` — a top-level success
				// envelope carrying a nested verb failure. Inspect result.ok/result.success
				// too, or a not-ready box (verb ok:false) is mistaken for a launched run.
				const nested = obj.result;
				if (nested && typeof nested === "object") {
					const nestedObj = nested as Record<string, unknown>;
					if (nestedObj.ok === false || nestedObj.success === false || nestedObj.error === true) {
						return true;
					}
					if (typeof nestedObj.error === "string" && nestedObj.error.length > 0) {
						return true;
					}
				}
			}
		} catch (err) {
			// Non-JSON output: nothing structured to inspect. Expected — a verb may print
			// plain text, and the caller's exit-code check still governs the outcome.
			//
			// Class only. This parses raw mcp2cli stdout, and mcp2cli is the
			// credential-holding bridge: a JSON parse error quotes the offending token out
			// of that stdout verbatim.
			log("debug", "runner.transport.error_payload_not_json", { error_class: errorClass(err) });
		}
		return false;
	},
	// Raw verb stdout: untrusted fleet output, and the boolean is the signal.
	{ redact: { args: [0] } },
);

/** Max characters of verb stdout carried into a failure message. */
const MAX_PAYLOAD_CHARS = 500;

/**
 * Replace C0 controls plus DEL with spaces.
 *
 * Whitespace collapse does NOT cover these: `\s` matches TAB/LF/CR but not ESC,
 * BEL, or NUL. Probed — `"ok\x1b[31mred\x07bell\x00nul"` survives a `\s+` pass
 * unchanged. They must be removed explicitly, because this text is bound for a
 * database column an operator reads back through a terminal: a raw ESC sequence
 * is an injection into that terminal's rendering, and a NUL truncates the value
 * in some clients.
 *
 * Done by code point rather than by regex deliberately, and the two halves of
 * `biome check` are why: a `/[\x00-\x1f\x7f]/g` literal is an ERROR under
 * `noControlCharactersInRegex`, while the formatter COLLAPSES the equivalent
 * `new RegExp("[\\x00-\\x1f\\x7f]", "g")` back into exactly that literal. Neither
 * spelling survives both passes. `sanitizeRunnerText` in
 * `github/publication-text.ts` already does the identical job this way.
 */
function stripControls(value: string): string {
	return Array.from(value, (char) => {
		const code = char.charCodeAt(0);
		return code < 32 || code === 127 ? " " : char;
	}).join("");
}

/**
 * Render verb output for an operator-facing failure message: control characters
 * stripped, whitespace collapsed, secrets redacted, length bounded.
 *
 * ORDER IS LOAD-BEARING, and each step is placed against a specific failure:
 *
 *  1. Control characters become spaces FIRST. They are not whitespace to the
 *     collapse below, and leaving them lets a runner's ANSI escape reach an
 *     operator's terminal verbatim.
 *  2. Whitespace collapses, so a multi-line stderr becomes one summary line.
 *  3. Redaction runs BEFORE truncation. Truncating first can slice a token in
 *     half and leave the surviving prefix unmatched by its pattern, so a partial
 *     credential reaches the log — the same defect #191 fixed for the leading
 *     word boundary. This output comes from mcp2cli, the credential-holding
 *     bridge, so it is treated as capable of carrying a secret.
 *  4. Truncation last, on already-safe text.
 */
export const boundedPayload = traced(
	"runner.boundedPayload",
	function boundedPayload(stdout: string): string {
		const collapsed = redactSecrets(stripControls(stdout).replace(/\s+/g, " ").trim());
		if (!collapsed) {
			return "<no stdout>";
		}
		return collapsed.length > MAX_PAYLOAD_CHARS
			? `${collapsed.slice(0, MAX_PAYLOAD_CHARS - 3)}...`
			: collapsed;
	},
	// BOTH ENDS. The argument is raw pre-redaction verb output, and the RETURN is
	// not safe merely because it went through `redactSecrets` -- an earlier
	// version of this comment claimed exactly that and was wrong.
	// `redactSecrets` matches a FIXED pattern list (`SECRET_PATTERNS` in
	// `../results/ingest`), and a bare 40-hex Forgejo token is not in it.
	//
	// So the bounded result can still carry a live credential, and the caller
	// that persists it into `job_attempts.failure_summary` is a deliberate,
	// operator-facing exception -- a debug trace line is not.
	{ redact: { args: [0], result: true } },
);

/**
 * The message a FAILED `runner_run` throws — the exit code plus what the verb
 * actually said.
 *
 * WHY THIS EXISTS. `runner_run failed (exit 1)` was the whole summary, and the
 * caller persists that string into `job_attempts.failure_summary`. On the
 * 2026-08-16 B5 night both dispatch failures landed exactly that, while the
 * stderr this transport already held said, in effect, `params.job exceeds 10000
 * chars` — the entire answer. Diagnosing it instead cost two dispatch cycles and
 * a cross-seat forensic pass over PVE task indexes and the the watcher host journal. The
 * transport captures stderr for `isRefusal` classification either way; this
 * persists what it is already holding.
 *
 * stderr is preferred because it is where the wrapper writes its rejection (the
 * #175 path `die`s to stderr with no JSON payload at all), and stdout is the
 * fallback for an in-band error envelope. Both go through `boundedPayload`, so
 * the runner's UNTRUSTED output is redacted, control-stripped, and clamped
 * before it can reach a column.
 *
 * NOT used for a contract rejection: that branch throws fixed prose on purpose
 * (its classifier already knows the cause) and splicing runner output into it
 * would undo a deliberate boundary.
 */
export const runFailureMessage = traced(
	"runner.runFailureMessage",
	function runFailureMessage(code: number, stdout: string, stderr: string): string {
		const detail = boundedPayload(stderr.trim() ? stderr : stdout);
		return detail === "<no stdout>"
			? `runner_run failed (exit ${code})`
			: `runner_run failed (exit ${code}) -- ${detail}`;
	},
	// Args 1 and 2 are raw verb stdout/stderr. The RETURN interpolates
	// `boundedPayload`'s result, which `redactSecrets` does not fully sanitize
	// (see that wrap's note and issue #60), so it is masked for the same reason.
	// The exit code is the field worth seeing, and it survives in the `.failed`
	// line and at the call site.
	{ redact: { args: [1, 2], result: true } },
);

/** Tunables for the default transport (defaults suit production; tests inject). */
export interface Mcp2cliTransportOptions {
	/** Max `run` submission attempts across the box boot window (>= 1). */
	runReadyAttempts?: number;
	/** Delay between `run` retries, in ms. */
	runReadyDelayMs?: number;
	/** Delay between `done` retries taken for a transport fault, in ms. */
	doneRetryDelayMs?: number;
	/** Injectable sleep so tests advance the retry loop without real waiting. */
	sleep?: (ms: number) => Promise<void>;
}

/** Default transport that invokes `mcp2cli runner-boxes <verb> --params`. */
export class Mcp2cliRunnerTransport implements RunnerTransport {
	private readonly bin: string;
	private readonly timeoutMs: number;
	private readonly runReadyAttempts: number;
	private readonly runReadyDelayMs: number;
	private readonly doneRetryDelayMs: number;
	private readonly sleep: (ms: number) => Promise<void>;

	constructor(
		bin = "mcp2cli",
		timeoutMs = DEFAULT_VERB_TIMEOUT_MS,
		options: Mcp2cliTransportOptions = {},
	) {
		this.bin = bin;
		this.timeoutMs = timeoutMs;
		this.runReadyAttempts = Math.max(1, options.runReadyAttempts ?? DEFAULT_RUN_READY_ATTEMPTS);
		this.runReadyDelayMs = Math.max(0, options.runReadyDelayMs ?? DEFAULT_RUN_READY_DELAY_MS);
		this.doneRetryDelayMs = Math.max(0, options.doneRetryDelayMs ?? DEFAULT_DONE_RETRY_DELAY_MS);
		this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
	}

	protected async invoke(
		verb: string,
		params: Record<string, unknown>,
		timeoutMs: number,
	): Promise<{ code: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn(runnerBoxArgv(this.bin, verb, params), {
			stdout: "pipe",
			stderr: "pipe",
		});

		// Bound wall-clock time explicitly. Aborting the spawn is not enough: on
		// kill, `proc.exited` resolves (it does not reject) and a grandchild that
		// keeps the stdout pipe open would let the stream read hang forever. So we
		// race the whole invocation against a timer, then hard-kill the process
		// tree on timeout and reject with a clear diagnostic.
		let timer: ReturnType<typeof setTimeout> | undefined;
		const timeout = new Promise<never>((_resolve, reject) => {
			timer = setTimeout(() => {
				proc.kill("SIGKILL");
				reject(new Error(`runner-boxes ${verb} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
		});
		const complete = (async () => {
			const [code, stdout, stderr] = await Promise.all([
				proc.exited,
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			return { code, stdout, stderr };
		})();

		try {
			return await Promise.race([complete, timeout]);
		} finally {
			if (timer !== undefined) {
				clearTimeout(timer);
			}
		}
	}

	async needed(size: string, jobId: string, count: number): Promise<RunnerAllocation> {
		const { code, stdout, stderr } = await this.invoke(
			"runner_needed",
			{
				size,
				job_id: jobId,
				count,
			},
			NEEDED_TIMEOUT_MS,
		);
		if (code !== 0 || hasErrorPayload(stdout)) {
			return neededError(size, code, stdout, stderr);
		}
		const boxes = parseBoxes(stdout, size);
		if (boxes.length === 0) {
			// A clean (non-error) empty allocation. parseBoxes found no in-pool box on
			// the ok-gated success path; parsePlacedBoxes re-parses through the
			// refusal-tolerant unwrap so any partial `placed` box that slipped past the
			// success parse is still surfaced to be reaped, and a genuinely empty
			// allocation still yields `[]`.
			return {
				ok: false,
				refused: true,
				reason: "no runner box allocated",
				placed: parsePlacedBoxes(stdout, size),
			};
		}
		return { ok: true, boxes };
	}

	async run(params: RunnerRunParams): Promise<void> {
		// `needed` returns the vmid before the container is exec-ready, so early
		// `run` submissions fail fast with a bare non-zero exit. `run`'s own success
		// is the readiness signal, so resubmit the SAME request across the boot
		// window until the box accepts it; a failed `run` never launched the job, so
		// a later successful attempt is the one and only launch.
		//
		// Only a bare not-ready exit is retried. A STRUCTURED failure is not a boot
		// race and retrying wastes the window: a transport-fault / in-band error
		// payload (`hasErrorPayload`), a capacity refusal (`isRefusal`), or a
		// CONTRACT rejection such as an unknown runtime (`isContractRejection`)
		// stops the loop immediately so the caller reaps and records without delay.
		// sf#384: a script route must NAME model and effort; refused here, before the
		// first `invoke`, because a box is already allocated and held: every attempt
		// at a doomed submission costs the boot window on a live box (the #175 cost). It is also the only place the mismatch can be caught
		// at all — the MCP boundary silently DROPS undeclared params, so a
		// script-plus-model submission would otherwise be a success-shaped no-op with
		// no signal that the routing was wrong.
		const routeViolation = runRouteViolation(params);
		if (routeViolation) {
			throw new Error(`runner_run ${routeViolation}`);
		}
		let lastCode = 0;
		let lastOutput = "";
		let lastStderr = "";
		for (let attempt = 1; attempt <= this.runReadyAttempts; attempt++) {
			const { code, stdout, stderr } = await this.invoke(
				"runner_run",
				runnerRunArgs(params),
				this.timeoutMs,
			);
			if (code === 0 && !hasErrorPayload(stdout)) {
				return;
			}
			const combined = `${stdout}\n${stderr}`;
			if (isContractRejection(combined)) {
				// Name the classifier that made this terminal. A bare exit code reads
				// as a boot race and sends an operator to check the box; this says the
				// wrapper refused the runtime. Bounded and fixed — never raw
				// stdout/stderr, which is untrusted runner output.
				throw new Error("runner_run contract rejection: unsupported runtime");
			}
			if (hasErrorPayload(stdout) || isRefusal(combined)) {
				throw new Error(runFailureMessage(code, stdout, stderr));
			}
			lastCode = code;
			lastOutput = stdout;
			lastStderr = stderr;
			if (attempt < this.runReadyAttempts && this.runReadyDelayMs > 0) {
				await this.sleep(this.runReadyDelayMs);
			}
		}
		throw new Error(runFailureMessage(lastCode, lastOutput, lastStderr));
	}

	/**
	 * List the fleet's boxes and their attribution stamps.
	 *
	 * SENDS `{}`. The verb takes NO parameters — verified 2026-08-17 against the
	 * live server signature (`runner-boxes-mcp/.../server.py`, `def runner_list()`).
	 * That check is not optional politeness: the MCP tool boundary SILENTLY DROPS
	 * params a server does not declare, so an invented argument here would be a
	 * no-op that reads as configuration and produces a P0 the way it did on #175.
	 * Do not add one.
	 *
	 * A non-zero exit or an in-band error payload THROWS rather than returning an
	 * empty list. The two are not interchangeable to a caller: `[]` means the fleet
	 * reported no boxes, and swallowing a failure into `[]` would let a
	 * reconciliation conclude "nothing is stranded" from a read that never
	 * happened. Callers that must survive a read outage catch this explicitly.
	 */
	async list(): Promise<ListedBox[]> {
		const { code, stdout, stderr } = await this.invoke("runner_list", {}, this.timeoutMs);
		if (code !== 0 || hasErrorPayload(stdout)) {
			throw new Error(
				`runner_list failed (exit ${code}) -- ${boundedPayload(stderr.trim() ? stderr : stdout)}`,
			);
		}
		return parseListedBoxes(stdout);
	}

	async startBandMember(vmid: number): Promise<void> {
		await this.bandVerb(
			"runner_forge_up",
			{ vmid },
			Math.max(this.timeoutMs, RUNNER_FORGE_UP_TIMEOUT_MS),
		);
	}

	async stopBandMember(vmid: number): Promise<void> {
		await this.bandVerb(
			"runner_forge_down",
			{ vmid, force: false },
			Math.max(this.timeoutMs, RUNNER_STOP_TIMEOUT_MS),
		);
	}

	async listBand(band: "forge"): Promise<ListedBox[]> {
		const stdout = await this.bandVerb("runner_list", { band });
		const slots = parseForgeSlots(stdout);
		return slots.length > 0 ? slots : parseListedBoxes(stdout);
	}

	/** One forge-band verb: refusal text (any exit) throws `RunnerBandRefusedError`. */
	private async bandVerb(
		verb: string,
		params: Record<string, unknown>,
		timeoutMs = this.timeoutMs,
	): Promise<string> {
		const { code, stdout, stderr } = await this.invoke(verb, params, timeoutMs);
		const combined = `${stdout}\n${stderr}`;
		if (isRefusal(combined)) {
			throw new RunnerBandRefusedError(`${verb} refused -- ${boundedPayload(combined.trim())}`);
		}
		if (code !== 0 || hasErrorPayload(stdout)) {
			throw new Error(
				`${verb} failed (exit ${code}) -- ${boundedPayload(stderr.trim() ? stderr : stdout)}`,
			);
		}
		return stdout;
	}

	async done(vmid: number, jobId?: string): Promise<RunnerDoneOutcome> {
		// Reap is the one verb where giving up costs a permanent leak: the caller
		// owns a live box, and an unreaped box holds its pool slot forever. A
		// transport fault means the verb never ran, so the box is still there and
		// the call is safe to repeat -- `done` is idempotent (reaping an
		// already-gone vmid is not an error). Retry ONLY that class; a verb that
		// genuinely ran and failed still throws on the first attempt, because
		// repeating it would not change the answer.
		//
		// Bounded, not infinite: a daemon that is down rather than cold must
		// surface as a failure the operator sees, not a hang.
		let lastCode = 0;
		let lastOut = "";
		let lastErr = "";
		for (let attempt = 1; attempt <= DONE_TRANSPORT_ATTEMPTS; attempt++) {
			const { code, stdout, stderr } = await this.invoke(
				"runner_done",
				runnerDoneArgs(vmid, jobId),
				this.timeoutMs,
			);
			lastCode = code;
			lastOut = stdout;
			lastErr = stderr;
			if (code === 0 && !hasErrorPayload(stdout)) {
				if (attempt > 1) {
					log("info", "runner.transport.done_recovered_after_transport_fault", {
						vmid,
						attempt,
					});
				}
				return;
			}
			const refusal = parseDoneRefusal(`${stdout}\n${stderr}`);
			if (refusal) return refusal;
			if (!isTransportFault(stdout, stderr) || attempt === DONE_TRANSPORT_ATTEMPTS) {
				break;
			}
			log("warn", "runner.transport.done_transport_fault_retrying", { vmid, attempt });
			await this.sleep(this.doneRetryDelayMs);
		}
		// A transport fault that survived every attempt is NOT a proven failed
		// reap -- the outcome is unknown and the box may still be live. Say which
		// it was, so a caller (and an operator reading the log) can tell "this box
		// is gone" from "nobody knows, go look".
		if (isTransportFault(lastOut, lastErr)) {
			throw new Error(
				`runner_done outcome UNKNOWN for vmid ${vmid}: transport fault after ${DONE_TRANSPORT_ATTEMPTS} attempts (exit ${lastCode}) -- the box may still be live and holding a pool slot`,
			);
		}
		// Name WHICH signal failed the reap. `runner_done failed (exit 0)` is
		// self-contradictory on its face: exit 0 means the process
		// succeeded and `hasErrorPayload` rejected the stdout, but the message
		// reads as a success mislabelled a failure, and it discards the only
		// evidence that separates an over-triggering predicate from a genuine
		// in-band failure. Carry the payload, bounded and redacted, so the next
		// occurrence is diagnosable instead of inferable.
		if (lastCode === 0) {
			throw new Error(
				`runner_done failed for vmid ${vmid}: exit 0 with an in-band error payload on stdout -- ${boundedPayload(lastOut)}`,
			);
		}
		throw new Error(`runner_done failed (exit ${lastCode}) -- ${boundedPayload(lastOut)}`);
	}
}

/**
 * Adjudicate a `runner_needed` invocation that exited non-zero or carried an
 * in-band error payload. Extracted from `Mcp2cliRunnerTransport.needed` purely to
 * keep that method within the function ceiling; the three outcomes and their
 * order are unchanged.
 *
 * Returns a clean capacity REFUSAL (carrying any partial placement so the caller
 * can reap it), or throws — `RunnerAllocationUnknownError` for a transport fault,
 * where the verb generally completed server-side and placed a box whose vmid was
 * never returned, and a plain error for a verb that ran and failed.
 */
function neededError(size: string, code: number, stdout: string, stderr: string): RunnerAllocation {
	const combined = `${stdout}\n${stderr}`;
	if (isRefusal(combined)) {
		// Partial placement: the verb can REFUSE yet have already powered on
		// in-pool boxes, surfacing them as `vmid=` lines on stdout (the README
		// notes an error result — and a timed-out one — still carries placed
		// `vmid=` lines). Parse them through the SAME pool-range guard used for
		// a success so an out-of-pool/template 9900 id is never surfaced, and
		// hand them to the caller so it can reap and strand nothing.
		return {
			ok: false,
			refused: true,
			reason: "runner capacity unavailable",
			placed: parsePlacedBoxes(stdout, size),
		};
	}
	// A transport fault on ALLOCATION is the dangerous shape: the verb
	// generally completes server-side and places a box, but the response
	// carries no vmid, so nothing can name it to reap it. That is the #79
	// leak, and it is NOT interchangeable with a verb that ran and failed
	// (which placed nothing and leaves nothing to find). Mark it so the
	// caller can say so instead of collapsing both to "runner unavailable".
	if (isTransportFault(stdout, stderr)) {
		throw new RunnerAllocationUnknownError(
			`runner_needed outcome UNKNOWN: transport fault (exit ${code}) -- a box may have been placed with no vmid returned`,
		);
	}
	// Carry what the verb said, the way `runFailureMessage` does for `runner_run`
	// (SOF-8143): on sf-fleet-01 the bare `runner_needed failed (exit 1)` hid a
	// stderr of `Unknown service: "runner-boxes"` -- the whole answer. stderr
	// first, stdout as the fallback, both through `boundedPayload` (redacted,
	// control-stripped, clamped).
	const detail = boundedPayload(stderr.trim() ? stderr : stdout);
	throw new Error(
		detail === "<no stdout>"
			? `runner_needed failed (exit ${code})`
			: `runner_needed failed (exit ${code}) -- ${detail}`,
	);
}
