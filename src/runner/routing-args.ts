/**
 * @module runner/routing-args
 * @description The ONE `runner_run` argument builder both transports send:
 *   exactly the keys the v2 server declares, routing included. Since
 *   rtech-infra#1051/#1063 (a fleet host deploy, 2026-08-25) the server REQUIRES
 *   `model`, `effort`, `engine_base_url`, and `engine_auth_header_name` and
 *   refuses a fieldless run at the schema layer; the HTTP path used to strip
 *   them, which took the watcher host dispatch down. The routing keys spread
 *   conditionally so the wire stays exact — `resolveRuntimeRoute`
 *   guarantees every submission names them before a box is held.
 *
 * @outputs
 *   - `runnerRunArgs` -- the `runner_run` argument object for a submission
 */

import { traced } from "../log";
import type { RunnerRunParams } from "./transport";

/**
 * Build the `runner_run` argument object: EXACTLY the keys the v2 server declares.
 *
 * Not redacted: `engineEndpoint` carries a base URL and a header NAME, never the
 * header's value, and no other field is a credential.
 */
export const runnerRunArgs = traced(
	"runner.runnerRunArgs",
	function runnerRunArgs(params: RunnerRunParams): Record<string, unknown> {
		return {
			vmid: params.vmid,
			job_id: params.jobId,
			job: params.job,
			runtime: params.runtime ?? "claude",
			max_turns: params.maxTurns ?? 30,
			...(params.model !== undefined ? { model: params.model } : {}),
			...(params.effort !== undefined ? { effort: params.effort } : {}),
			...(params.engineEndpoint !== undefined
				? {
						engine_base_url: params.engineEndpoint.baseUrl,
						engine_auth_header_name: params.engineEndpoint.authHeaderName,
					}
				: {}),
		};
	},
);
