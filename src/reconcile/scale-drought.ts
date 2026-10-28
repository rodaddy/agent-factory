/**
 * @module reconcile/scale-drought
 * @description Escalate a DISPATCH DROUGHT: consecutive `runForgeRunnerScale`
 *   failures, counted, raising the `[monitoring-critical]` egress once the count
 *   proves the failure is not a transient.
 *
 *   THE OUTAGE THIS EXISTS FOR. On 2026-09-08 16:05 EDT the runner-boxes gateway
 *   CT stopped. `runForgeRunnerScale` failed on every pass for 35 h, each failure
 *   producing one log line into a journal nobody was reading, and the factory
 *   dispatched no job for a day and a half. It was found by hand on 2026-09-10.
 *  The machinery to page a human already existed — this is the
 *   counter that decides when to use it.
 *
 *   WHY A COUNTER AND NOT AN ALERT PER FAILURE. One failed pass is ordinary: the
 *   gateway restarts, a lease flaps, a box is mid-provision. Alerting on that
 *   trains the operator to ignore the alert, which is worse than not having it.
 *   Alerting only after N consecutive failures distinguishes "the fleet hiccuped"
 *   from "nothing has dispatched since yesterday", which is the distinction the
 *   outage turned on.
 *
 *   A SUCCESS RESETS THE COUNT, deliberately. Without a reset, a slow drip of
 *   unrelated transients across days eventually crosses the threshold and pages
 *   about a healthy system.
 *
 *   Module-level state is the right shape here and not an accident: the watcher
 *   is one long-lived single-flight process, the count is per-process by
 *   definition, and a restart SHOULD clear it — a fresh process has not yet
 *   observed a drought. `resetScaleDroughtState` exists for tests.
 *
 * @outputs
 *   - `DISPATCH_DROUGHT_THRESHOLD` -- consecutive failures before escalating
 *   - `recordScaleFailure` -- count one failure; raise once at the threshold
 *   - `recordScaleSuccess` -- clear the count
 *   - `resetScaleDroughtState` -- test seam
 *
 * @dependencies
 *   - ../log -- the one logger, bounded error messages, and traced()
 *   - ../observability/critical-alert -- the existing dedupe-ing alert egress
 *   - ../results/ingest -- redactSecrets, before a cause becomes a forge document
 */
import type { WatcherConfig } from "../config/schema";
import { errorMessage, log, traced } from "../log";
import {
	type AlertDelivery,
	type CriticalFailure,
	raiseClassAlert,
} from "../observability/critical-alert";
import { redactSecrets } from "../results/ingest";
import { type ForgeRunnerScaleDeps, runForgeRunnerScale } from "./forge-runner-scale";

/**
 * Consecutive failed scale passes before the drought is escalated.
 *
 * Three, against the deployed 15-minute poll interval, is ~45 minutes of total
 * dispatch silence — far below the 35 h that went unnoticed, and far above a
 * single flapping pass. The unit is PASSES rather than minutes because the
 * counter lives in the pass loop and a wall-clock bound would need a second
 * source of truth for how often that loop runs.
 */
export const DISPATCH_DROUGHT_THRESHOLD = 3;

/**
 * The rolling window, in passes, over which a FLAPPING gateway is judged.
 *
 * The consecutive counter alone misses the shape that matters just as much as a
 * clean outage: a gateway that answers one pass in three. Probed against the
 * first version of this module — 100 cycles of fail/fail/success produced 200
 * failed passes and ZERO alerts, because every third success reset the run. At
 * the deployed 15-minute interval that is ~50 hours of two-thirds-dead dispatch,
 * longer than the 35 h outage this module was written for, in total silence.
 *
 * So a success clears the CONSECUTIVE run but does not erase the window: if most
 * of the recent passes failed, dispatch is not working, whatever the pattern.
 */
export const DISPATCH_WINDOW_PASSES = 12;

/** Failures within the window that mean dispatch is broken even without a clean run. */
export const DISPATCH_WINDOW_FAILURE_THRESHOLD = 8;

/**
 * The stable alert class; also the dedupe identity, so it carries no varying part.
 *
 * "IS UNHEALTHY" RATHER THAN "HAS FAILED EVERY PASS", because two different
 * shapes raise this one alert and the second contradicts the stronger wording: a
 * flapping gateway escalates at 8 failures in 12 passes, where four passes
 * demonstrably succeeded. This string is the operator-facing issue TITLE, so the
 * overstatement would send someone looking for a total outage that the evidence
 * does not show. The precise counts live in the cause body, which is where a
 * varying number belongs — the class must stay constant or the dedupe splits one
 * incident across several issues.
 */
const DROUGHT_ALERT_CLASS = "dispatch drought: runner scaling is unhealthy";

/** Consecutive failures observed since the last success, per process. */
let consecutiveFailures = 0;

/**
 * The last `DISPATCH_WINDOW_PASSES` outcomes, oldest first: `true` is a failure.
 * This is what catches a flapping gateway that the consecutive counter cannot.
 */
let recentOutcomes: boolean[] = [];

/** True once this drought has been escalated, so it is not re-raised each pass. */
let escalated = false;

/** Record one pass outcome into the rolling window. */
function pushOutcome(failed: boolean): void {
	recentOutcomes.push(failed);
	if (recentOutcomes.length > DISPATCH_WINDOW_PASSES) {
		recentOutcomes.shift();
	}
}

/** Failures currently inside the rolling window. */
function windowFailures(): number {
	return recentOutcomes.filter(Boolean).length;
}

/**
 * The alert egress shape this module needs; the real one is `raiseCriticalAlert`.
 *
 * It returns an `AlertDelivery` rather than `void` because the latch below turns
 * on delivery, and a sink that reports only "I resolved" cannot distinguish a
 * filed issue from a forge outage that swallowed it.
 */
type AlertSink = (failure: CriticalFailure) => Promise<AlertDelivery>;

/**
 * The production sink: whatever `[monitoring-critical]` target this process
 * bound at boot, or inert when none is configured.
 *
 * It must go through `raiseClassAlert` rather than calling `raiseCriticalAlert`
 * with an explicit target, because the bound target is module-private to
 * `critical-alert` — passing `undefined` here would compile, read correctly, and
 * make this entire escalation a silent no-op in production.
 */
const defaultSink: AlertSink = async (failure) => {
	return await raiseClassAlert(failure);
};

/**
 * Record one failed scaling pass, and escalate when the drought is established.
 *
 * NEVER THROWS. This is called from an error sink mid-pass; a throw here would
 * turn a monitoring gap into an outage of the thing doing the monitoring. The
 * alert egress is already best-effort, and its own failure is caught again here
 * rather than trusted.
 *
 * @param error - the thrown value from the failed pass
 * @param sink - the alert egress; production omits it
 */
export const recordScaleFailure = traced(
	"reconcile.recordScaleFailure",
	async function recordScaleFailure(error: unknown, sink: AlertSink = defaultSink): Promise<void> {
		consecutiveFailures += 1;
		pushOutcome(true);
		const inWindow = windowFailures();
		log("warn", "reconcile.scale_drought.failure", {
			consecutive: consecutiveFailures,
			threshold: DISPATCH_DROUGHT_THRESHOLD,
			window_failures: inWindow,
			window_threshold: DISPATCH_WINDOW_FAILURE_THRESHOLD,
		});
		// EITHER shape escalates: a clean run of failures, OR a window that is mostly
		// failures even though successes keep breaking the run. The second is the
		// flapping gateway, which the consecutive counter alone cannot see.
		const drought = consecutiveFailures >= DISPATCH_DROUGHT_THRESHOLD;
		const flapping = inWindow >= DISPATCH_WINDOW_FAILURE_THRESHOLD;
		if ((!drought && !flapping) || escalated) {
			return;
		}
		// LATCH ONLY ON CONFIRMED DELIVERY, which is NOT the same as "the await
		// returned". `raiseCriticalAlert` never throws by design: an unconfigured
		// target, a failed forge write, and a dedupe scan that cannot prove absence
		// all resolve normally. Latching on resolution therefore silences every
		// later retry for the life of the process during exactly the infrastructure
		// outage this alert exists for — the forge write is the most likely thing to
		// fail while the gateway is down. So the sink reports whether an issue is
		// actually visible, and only that sets the latch. The egress dedupes, so
		// retrying next pass is cheap; going silent is not.
		try {
			const delivery = await sink({
				alertClass: DROUGHT_ALERT_CLASS,
				// REDACTED, not merely bounded. `errorMessage` returns a thrown value's
				// message verbatim, and this cause is written into a forge-hosted issue
				// body — the one place in this path where untrusted text becomes a
				// durable public document. A gateway auth failure quotes its own
				// credential often enough that this is the expected case, not a
				// pathological one. `redactSecrets` is a finite pattern list (issue
				// #60), so this reduces the exposure rather than eliminating it.
				cause: redactSecrets(
					`${consecutiveFailures} consecutive scaling passes failed ` +
						`(${inWindow} of the last ${recentOutcomes.length} passes failed). ` +
						`Last cause: ${errorMessage(error)}`,
				),
			});
			if (!delivery.delivered) {
				// `escalated` stays FALSE, so the next pass retries. See the note above.
				log("warn", "reconcile.scale_drought.escalation_undelivered", { why: delivery.why });
				return;
			}
			escalated = true;
			log("error", "reconcile.scale_drought.escalated", {
				consecutive: consecutiveFailures,
				delivery: delivery.how,
			});
		} catch (err) {
			// A sink that throws anyway (a test fake, or a future egress) is the same
			// case as an undelivered one: the latch stays FALSE and the next pass retries.
			log("warn", "reconcile.scale_drought.escalation_failed", { cause: errorMessage(err) });
		}
	},
	// Arg 0 is a thrown value from a pass handling repository content, and arg 1 is
	// a closure. The counts worth seeing are in the log lines above.
	{ redact: { args: [0, 1] } },
);

/**
 * Record a successful scaling pass.
 *
 * A success always clears the CONSECUTIVE run — that is what makes an isolated
 * transient harmless. It does NOT automatically clear the escalation latch: a
 * flapping gateway produces a success every few passes, and re-arming on each
 * one would let the alert fire over and over for a single ongoing incident.
 *
 * The latch clears only once the rolling window is mostly healthy again, which
 * is the same evidence that made the alert fire in the first place. That is what
 * lets a genuinely NEW outage page again after a real recovery, without a
 * flapping one paging every third pass.
 */
export const recordScaleSuccess = traced(
	"reconcile.recordScaleSuccess",
	function recordScaleSuccess(): void {
		if (consecutiveFailures > 0) {
			log("info", "reconcile.scale_drought.recovered", { after: consecutiveFailures });
		}
		consecutiveFailures = 0;
		pushOutcome(false);
		// RE-ARM ONLY ON A FULLY HEALTHY WINDOW. "Not currently failing enough to
		// alert" is a weaker condition and re-arms one pass after an alert, which
		// turns a single incident into a repeating page. Requiring the whole window
		// clean means the alert fires again only for an outage that follows a real
		// recovery.
		if (escalated && recentOutcomes.length >= DISPATCH_WINDOW_PASSES && windowFailures() === 0) {
			escalated = false;
		}
	},
);

/**
 * Run one scaling pass and account for its outcome (step 9b of the cycle).
 *
 * THE THREE OUTCOMES ARE NOT TWO. A pass that THREW and a pass that SKIPPED
 * leave dispatch equally starved, and only the throw was ever counted — the skip
 * returned normally, so the caller's try/catch never fired and the drought
 * counter stayed at zero through a queue-read outage. `disabled` is the third
 * and is not a failure at all: the deployment opted out of fleet scaling, and
 * counting it would page every pass on a correctly-configured system.
 *
 * Lives here rather than in `service-cycle.ts` because the drought accounting is
 * the interesting half, and because that module sits against its size bound.
 */
export const runScaleStepWithDroughtTracking = traced(
	"reconcile.runScaleStepWithDroughtTracking",
	async function runScaleStepWithDroughtTracking(step: {
		config: WatcherConfig;
		resolveDeps: () => ForgeRunnerScaleDeps;
		onError: (error: unknown) => void;
		/**
		 * The alert egress, for tests. Production omits it and gets `defaultSink`.
		 *
		 * It exists because the OUTCOME DECISION below is the part worth testing —
		 * which of three statuses counts as a failed pass — and that decision was
		 * reachable only through the module-level counter before this seam, so every
		 * branch of it could be deleted with the suite green (review of a25fea4).
		 */
		sink?: AlertSink;
	}): Promise<void> {
		const sink = step.sink ?? defaultSink;
		try {
			const outcome = await runForgeRunnerScale(step.config, step.resolveDeps());
			if (outcome.status === "skipped") {
				await recordScaleFailure(new Error(`forge runner scale skipped: ${outcome.reason}`), sink);
			} else if (outcome.status === "ran") {
				// A PASS THAT DECIDED TO ACT AND APPLIED NOTHING IS A FAILED PASS.
				// `applyActions` catches each member error and warns, so a gateway
				// refusing every start returns `ran` — the exact shape of the outage
				// this counter exists for, resetting the counter on every pass of it.
				// A pass that attempted nothing is healthy: the fleet already matched
				// the desired size, which is the steady state, not a failure.
				if (outcome.attempted > 0 && outcome.applied === 0) {
					await recordScaleFailure(
						new Error(`forge runner scale applied none of ${outcome.attempted} requested actions`),
						sink,
					);
				} else {
					recordScaleSuccess();
				}
			}
		} catch (e) {
			// COUNT the failure, do not merely report it. The 35 h outage ran
			// unnoticed because every pass failed into `onError`, whose whole reach
			// is a log line. `recordScaleFailure` never throws back into the pass.
			await recordScaleFailure(e, sink);
			step.onError(e);
		}
	},
	// The step carries config and closures; the counts worth seeing are logged.
	{ redact: { args: [0] } },
);

/** Clear the per-process counters. A test seam; production never calls it. */
export const resetScaleDroughtState = traced(
	"reconcile.resetScaleDroughtState",
	function resetScaleDroughtState(): void {
		consecutiveFailures = 0;
		recentOutcomes = [];
		escalated = false;
	},
);
