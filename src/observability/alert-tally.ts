/**
 * @module observability/alert-tally
 * @description The process-local count behind `factory_alert_deliveries_total`.
 *  `raiseCriticalAlert` is the ONE alert egress, so it records every
 *   `AlertDelivery` it returns here and nothing else does: the counter cannot
 *   drift from the outcomes the callers see. Process-local like the host-conflict
 *   tally — a restart zeroes it, which a Prometheus counter reset handles.
 *
 * @outputs
 *   - `recordAlertDelivery` -- count one outcome
 *   - `alertDeliveryTally` -- a copy of the counts, for the status snapshot
 *
 * @dependencies
 *   - ../log -- `traced`
 */
import { traced } from "../log";

const tally = { delivered: 0, undelivered: 0 };

/** Count one `AlertDelivery` by its `delivered` flag. */
export const recordAlertDelivery = traced(
	"observability.recordAlertDelivery",
	function recordAlertDelivery(delivery: { delivered: boolean }): void {
		if (delivery.delivered) tally.delivered += 1;
		else tally.undelivered += 1;
	},
);

/** The counts since process start, as a fresh object the caller may keep. */
export const alertDeliveryTally = traced(
	"observability.alertDeliveryTally",
	function alertDeliveryTally(): { delivered: number; undelivered: number } {
		return { ...tally };
	},
);
