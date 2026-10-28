/**
 * @module runner/trace-context
 * @description Produce the W3C `traceparent` a dispatch sends to a runner box,
 *   and narrow a transport to one that can carry it.
 *
 *   The transport has carried a `traceparent` field since sf#246 lane A and
 *   nothing ever produced a value for it, so a runner job could not be
 *   correlated with the dispatch that placed it. This module is that producer.
 *
 *   It lives beside the transport rather than inside it because both
 *   `transport-http.ts` and `dispatch.ts` sit near the 500-code-line bound, and
 *   a correlator is its own concern: the transport CARRIES one, the dispatch
 *   SETS one, neither needs to know how it is derived.
 *
 * @outputs
 *   - `traceparentFor` -- the `traceparent` for one attempt id
 *   - `carriesTraceparent` -- narrow a transport to one that accepts a correlator
 *
 * @dependencies
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { traced } from "../log";

/** A transport that can carry a W3C correlator on its outbound requests. */
export interface TraceparentCarrier {
	setTraceparent(value: string | undefined): void;
}

/**
 * Narrow a transport to one that can carry a correlator.
 *
 * `setTraceparent` is deliberately NOT on `RunnerTransport`: mcp2cli has no
 * `_meta` to put it in, and widening the interface would force a no-op method
 * onto a transport that cannot honour it — the shape the sf#246 lane A test
 * pins as "threads a correlator WITHOUT widening RunnerTransport". A producer
 * therefore ASKS. A `false` answer is ordinary, not degraded: that dispatch
 * carries no trace context, exactly as it did before this existed.
 */
export const carriesTraceparent = traced(
	"runner.carriesTraceparent",
	function carriesTraceparent(transport: unknown): transport is TraceparentCarrier {
		return (
			typeof transport === "object" &&
			transport !== null &&
			typeof (transport as { setTraceparent?: unknown }).setTraceparent === "function"
		);
	},
);

/**
 * The W3C `traceparent` for one dispatch, derived from the attempt id alone.
 *
 * WHY NOT `traceIdFor` (the Langfuse trace id). Two namespaces, and neither can
 * be the other:
 *   - `traceIdFor` returns `attempt-N-<host>`, which is not a legal W3C trace
 *     id (32 lowercase hex), and its host qualifier is only known at RESULT
 *     INGEST — which host reported — so it cannot exist when we dispatch.
 *   - `traceparent` must be `00-<32hex>-<16hex>-01` and travels WITH the
 *     request, so it must derive from what is in scope at dispatch.
 *
 * The attempt id is exactly that, and sf#179 is why: `recordAllocationIntent`
 * writes the attempt row BEFORE `transport.needed()`, so the dispatch path
 * already holds an attempt id before the verb it wants to correlate. No new
 * plumbing, no widened signature, no second identity to keep in step.
 *
 * DETERMINISTIC, not random: the same attempt always derives the same ids, so
 * nothing has to be stored to correlate later. An operator holding
 * `job_attempts.id` can recompute the value the runner was sent, and a requeue
 * gets a new attempt row and therefore a distinct trace — the same
 * per-attempt-not-per-job property `traceIdFor` has.
 */
export const traceparentFor = traced(
	"runner.traceparentFor",
	function traceparentFor(attemptId: number): string {
		if (!Number.isSafeInteger(attemptId) || attemptId <= 0) {
			throw new Error(`traceparentFor requires a positive attempt id, got ${attemptId}`);
		}
		// A serial primary key is small; left-pad into the fixed widths W3C
		// requires. Hex of the id is unique because the id is, and neither field
		// may be all-zero — which the positive-id guard above is what rules out.
		const hex = attemptId.toString(16);
		return `00-${hex.padStart(32, "0")}-${hex.padStart(16, "0")}-01`;
	},
);
