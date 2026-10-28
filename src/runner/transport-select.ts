/**
 * @module runner/transport-select
 * @description The runner-transport SELECTION seam: read the environment, decide
 *   which `RunnerTransport` implementation the process gets, and fail closed when
 *   the HTTP path is asked for but not configured.
 *
 *   Selection is not transport behavior. It lives here rather than in
 *   `transport-http.ts` because that module sits at the 500-code-line
 *   `lint:size` bound, and because choosing an implementation is a distinct
 *   concern from being one: the transports know how to talk to the gateway, this
 *   knows which of them the operator asked for.
 *
 *   `transport-http.ts` re-exports both symbols, so every existing importer
 *   (`src/service.ts`, `src/prepush/command.ts`, `src/doctor/command.ts`,
 *   `src/compat/command.ts`, and the test) is unaffected by the move.
 *
 * @outputs
 *   - `RUNNER_TRANSPORT_ENV` -- the env var that selects the transport
 *   - `createRunnerTransport` -- construct the selected transport, or fail closed
 *
 * @dependencies
 *   - ../log -- the one logger, and the traced() wrapper
 *   - ./transport -- the mcp2cli implementation and the shared contract type
 *   - ./transport-http -- the HTTP implementation and its config-fault type
 */
import { log, traced } from "../log";
import { Mcp2cliRunnerTransport, type RunnerTransport } from "./transport";
import {
	HttpRunnerTransport,
	type HttpTransportOptions,
	RunnerTransportConfigError,
} from "./transport-http";

/** Env var selecting the runner transport. Anything but `http` keeps mcp2cli. */
export const RUNNER_TRANSPORT_ENV = "RUNNER_TRANSPORT";

/**
 * The selection seam (ticket deliverable 1: "rollback is a config change, not a
 * revert").
 *
 * `RUNNER_TRANSPORT=http` selects {@link HttpRunnerTransport} from
 * `RUNNER_BOXES_HTTP_URL` + `RUNNER_BOXES_HTTP_TOKEN`. ANYTHING ELSE — unset,
 * `mcp2cli`, a typo — constructs today's `Mcp2cliRunnerTransport` with no
 * arguments, exactly as every call site does now.
 *
 * `http` with a missing URL or token FAILS CLOSED with
 * {@link RunnerTransportConfigError}. It never falls back to mcp2cli: see that
 * class's docblock for why a silent fallback is the dangerous option.
 *
 * The token is read from the environment HERE and handed straight to the
 * constructor. It is never logged, never placed in argv, and never written into a
 * result — which is also the concrete reason the HTTP path is preferable to the
 * spawn it replaces, where a credential would have to cross a command line.
 */
export const createRunnerTransport = traced(
	"runner.createRunnerTransport",
	function createRunnerTransport(
		env: Record<string, string | undefined> = process.env,
		options: HttpTransportOptions = {},
	): RunnerTransport {
		if (env[RUNNER_TRANSPORT_ENV] !== "http") {
			return new Mcp2cliRunnerTransport();
		}
		const url = env.RUNNER_BOXES_HTTP_URL?.trim();
		const token = env.RUNNER_BOXES_HTTP_TOKEN?.trim();
		if (!url) {
			throw new RunnerTransportConfigError(
				`${RUNNER_TRANSPORT_ENV}=http requires RUNNER_BOXES_HTTP_URL`,
			);
		}
		if (!token) {
			// Names the variable, never its value.
			throw new RunnerTransportConfigError(
				`${RUNNER_TRANSPORT_ENV}=http requires RUNNER_BOXES_HTTP_TOKEN`,
			);
		}
		log("info", "runner.transport.selected", { transport: "http", endpoint_configured: true });
		return new HttpRunnerTransport(url, token, options);
	},
	// Arg 0 DEFAULTS TO THE WHOLE process.env, which holds
	// RUNNER_BOXES_HTTP_TOKEN. It arrives as a bare positional, and summarize()
	// masks on object KEYS, so nothing would mask it without this.
	{ redact: { args: [0] } },
);
