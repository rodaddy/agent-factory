import { log, traced } from "../log";
import {
	boundedPayload,
	DEFAULT_RUN_READY_ATTEMPTS,
	DEFAULT_RUN_READY_DELAY_MS,
	isContractRejection,
	type RunnerRunParams,
} from "./transport";

export type HttpRunFailureSource = "http" | "json-rpc" | "tool" | "prose";

export interface HttpRunResult {
	failure: string | null;
	structuredFailure: boolean;
	failureSource: HttpRunFailureSource | null;
}

interface HttpRunRetryOptions {
	params: RunnerRunParams;
	call: () => Promise<HttpRunResult>;
	sleep: (ms: number) => Promise<void>;
}

/** Retry only the observed vmid-visibility race within the shared run-ready budget. */
export const runWithHttpBootRetry = traced(
	"runner.runWithHttpBootRetry",
	async function runWithHttpBootRetry(options: HttpRunRetryOptions): Promise<void> {
		let lastFailure = "";
		for (let attempt = 1; attempt <= DEFAULT_RUN_READY_ATTEMPTS; attempt++) {
			const result = await options.call();
			if (!result.failure) {
				return;
			}
			if (!isRunNotFoundAnswer(result)) {
				throwRunFailure(result);
			}
			lastFailure = result.failure;
			if (attempt === DEFAULT_RUN_READY_ATTEMPTS) {
				break;
			}
			log("warn", "runner.transport_http.run_not_found_retrying", {
				vmid: options.params.vmid,
				attempt,
			});
			await options.sleep(DEFAULT_RUN_READY_DELAY_MS);
		}
		throw new Error(
			`runner_run failed after ${DEFAULT_RUN_READY_ATTEMPTS} attempts -- ${boundedPayload(lastFailure)}`,
		);
	},
);

/** The only tool answer the HTTP path may treat as a transient boot race. */
function isRunNotFoundAnswer(result: HttpRunResult): boolean {
	if (!result.failure) {
		return false;
	}
	if (result.failureSource !== "tool" && result.failureSource !== "prose") {
		return false;
	}
	return result.failure.includes("not found on any reachable node");
}

/** Preserve the pre-sf#372 terminal error behavior for every other failure. */
function throwRunFailure(result: HttpRunResult): never {
	if (!result.failure) {
		throw new Error("runner_run failed -- <no stdout>");
	}
	if (!result.structuredFailure && isContractRejection(result.failure)) {
		throw new Error("runner_run contract rejection: unsupported runtime");
	}
	throw new Error(`runner_run failed -- ${boundedPayload(result.failure)}`);
}
