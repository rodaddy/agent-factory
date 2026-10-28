/**
 * @module runner/dispatch-util
 * @description The small, dependency-free helpers the dispatch path shares:
 *   mint a runner job id, shift a timestamp, bound a failure summary, and
 *   recognise a transport timeout.
 *
 *   They live apart from `./dispatch` because that module is AT the 500
 *   code-line `lint:size` bound and because none of these four touch a
 *   database, a transport, or a job — they are pure functions over a string, a
 *   date, and an error. `dispatch.ts` re-exports the three public ones, so
 *   every existing importer of that path is unaffected.
 *
 * @outputs
 *   - `newRunnerJobId` -- a unique, never-reused runner job id
 *   - `addMinutes` -- shift a timestamp without mutating the input
 *   - `bound` -- the ONE failure-summary truncation rule
 *   - `isTransportTimeout` -- did a verb time out, on either transport
 *
 * @dependencies
 *   - node:crypto -- randomUUID for the job id
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { randomUUID } from "node:crypto";
import { traced } from "../log";

/** Generate a unique runner job id that is never reused. */
export const newRunnerJobId = traced(
	"runner.newRunnerJobId",
	function newRunnerJobId(jobType: string): string {
		return `rw-${jobType}-${randomUUID()}`;
	},
);

/** Add minutes to a timestamp without mutating the input. */
export const addMinutes = traced(
	"runner.addMinutes",
	function addMinutes(base: Date, minutes: number): Date {
		return new Date(base.getTime() + minutes * 60_000);
	},
);

/**
 * Bound a failure summary defensively.
 *
 * Exported so `attempt-record` applies the SAME cap to the rows it writes: two
 * copies of a truncation rule drift, and a summary that escapes the bound is
 * exactly the unbounded-text-into-the-database shape this repo refuses.
 */
export const bound = traced(
	"runner.bound",
	function bound(value: string): string {
		const trimmed = value.replace(/\s+/g, " ").trim();
		return trimmed.length > 200 ? `${trimmed.slice(0, 197)}...` : trimmed;
	},
	// The argument is an unbounded pre-truncation failure summary arriving as a
	// bare positional, so summarize() -- which masks on object KEYS -- would log
	// it verbatim. The bounded RETURN value stays visible, which is the point.
	{ redact: { args: [0] } },
);

/**
 * Did a runner verb time out?
 *
 * Two spellings, because two transports raise it: the HTTP transport's
 * `AbortSignal.timeout` rejects with `name === "TimeoutError"`, while the
 * mcp2cli transport throws a plain `Error` reading `runner-boxes runner_done
 * timed out after <n>ms`. Deliberately narrow — this only ever widens `reap`
 * into a read-only probe, so a false NEGATIVE costs one held vmid for a pass
 * while a false positive would spend a `list()` on every ordinary failure.
 */
export const isTransportTimeout = traced(
	"runner.isTransportTimeout",
	function isTransportTimeout(err: unknown): boolean {
		return err instanceof Error && (err.name === "TimeoutError" || /timed out/i.test(err.message));
	},
);
