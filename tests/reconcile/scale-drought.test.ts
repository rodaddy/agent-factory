/**
 * @module tests/reconcile/scale-drought
 * @description Hermetic tests for the dispatch-drought escalation.
 *
 *   THE OUTAGE THIS ENCODES. On 2026-09-08 the runner-boxes gateway stopped and
 *   `runForgeRunnerScale` failed every pass for 35 h. Each failure was one log
 *   line and nothing read it, so the factory dispatched nothing for a day and a
 *   half without telling anyone. The fix is not "log louder": it is to COUNT
 *   consecutive failures and raise the `[monitoring-critical]` egress that
 *   already exists once the count proves this is not a transient.
 *
 *   THE THRESHOLD IS THE DESIGN. One failed pass is noise — the gateway
 *   restarts, a lease flaps, a box is mid-provision. The alert must not fire on
 *   that, and it must fire well before 35 h. At a 15-minute poll interval the
 *   threshold here is ~45 minutes of total silence.
 *
 *   A SUCCESS RESETS THE COUNT. Otherwise a slow drip of unrelated transients
 *   across days eventually crosses the line and pages a human about a healthy
 *   system, which trains them to ignore the page.
 */
import { beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { ForgeRunnerFleetConfig, WatcherConfig } from "../../src/config/schema";
import type { AlertDelivery } from "../../src/observability/critical-alert";
import * as criticalAlert from "../../src/observability/critical-alert";
import {
	type ForgeRunnerScaleDeps,
	runForgeRunnerScale,
} from "../../src/reconcile/forge-runner-scale";
import {
	DISPATCH_DROUGHT_THRESHOLD,
	DISPATCH_WINDOW_PASSES,
	recordScaleFailure,
	recordScaleSuccess,
	resetScaleDroughtState,
	runScaleStepWithDroughtTracking,
} from "../../src/reconcile/scale-drought";

/**
 * Collect the alerts a run would have raised, instead of calling a forge.
 *
 * Reports `delivered` by default, which is the HEALTHY forge case: the issue was
 * opened and a human can see it. The undelivered shapes get their own sinks
 * below, because they are a different behaviour and not a different value.
 */
function collector() {
	const raised: { alertClass: string; cause: string }[] = [];
	return {
		raised,
		raise: async (failure: { alertClass: string; cause: string }): Promise<AlertDelivery> => {
			raised.push(failure);
			return { delivered: true, how: "opened" };
		},
	};
}

beforeEach(() => {
	resetScaleDroughtState();
});

describe("dispatch-drought escalation", () => {
	test("a single failure does not raise: one bad pass is a transient", async () => {
		const c = collector();
		await recordScaleFailure(new Error("gateway refused"), c.raise);
		expect(c.raised.length).toBe(0);
	});

	test("the threshold is above 1 so a transient cannot page a human", () => {
		expect(DISPATCH_DROUGHT_THRESHOLD).toBeGreaterThan(1);
	});

	test("consecutive failures reaching the threshold raise exactly one alert", async () => {
		const c = collector();
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD; i++) {
			await recordScaleFailure(new Error("connect ECONNREFUSED"), c.raise);
		}
		expect(c.raised.length).toBe(1);
		expect(c.raised[0]?.alertClass).toContain("dispatch");
	});

	test("further failures past the threshold do not re-raise", async () => {
		// The egress dedupes on its own, but a caller that hammers it every pass
		// for 35 h turns one incident into a forge-write storm.
		const c = collector();
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD + 5; i++) {
			await recordScaleFailure(new Error("still down"), c.raise);
		}
		expect(c.raised.length).toBe(1);
	});

	test("a success resets the count, so transients never accumulate into a page", async () => {
		const c = collector();
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD - 1; i++) {
			await recordScaleFailure(new Error("flap"), c.raise);
		}
		recordScaleSuccess();
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD - 1; i++) {
			await recordScaleFailure(new Error("flap"), c.raise);
		}
		expect(c.raised.length).toBe(0);
	});

	test("one lucky success does NOT re-arm the alert mid-incident", async () => {
		// Re-arming on a single success is what turns one ongoing incident into a
		// page every few passes. Sustained health is required; see the recovery
		// test below for the case that DOES re-arm.
		const c = collector();
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD; i++) {
			await recordScaleFailure(new Error("outage one"), c.raise);
		}
		recordScaleSuccess();
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD; i++) {
			await recordScaleFailure(new Error("same outage"), c.raise);
		}
		expect(c.raised.length).toBe(1);
	});

	test("a credential in the thrown message is redacted before it reaches the issue", async () => {
		// The sentinel must have the SHAPE of a real token, because that is what
		// `redactSecrets` matches on. An underscore-laden placeholder passes
		// straight through and would make this test assert nothing — it did, on the
		// first version of this file.
		const c = collector();
		const sentinel = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD; i++) {
			await recordScaleFailure(new Error(`auth failed with ${sentinel}`), c.raise);
		}
		expect(c.raised.length).toBe(1);
		const cause = c.raised[0]?.cause ?? "";
		expect(cause).not.toContain(sentinel);
		expect(cause).toContain("[REDACTED]");
		expect(cause.length).toBeLessThanOrEqual(800);
	});

	test("a FAILED escalation does not suppress the next one (review of 3203e17)", async () => {
		// THE WORST SHAPE, and it survived the first version of this module. The
		// latch was set BEFORE awaiting the sink, so a forge write that threw
		// silenced the alert for the life of the process — and a forge write is
		// most likely to fail DURING the infrastructure outage this exists to
		// report. Probed on the original: 0 alerts from 5 later failures.
		const throwing = async () => {
			throw new Error("forge unreachable during the outage");
		};
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD; i++) {
			await recordScaleFailure(new Error("down"), throwing);
		}
		const c = collector();
		await recordScaleFailure(new Error("still down"), c.raise);
		expect(c.raised.length).toBe(1);
	});

	test("a flapping gateway escalates even though successes break the run", async () => {
		// The other shape the consecutive counter cannot see. Probed on the first
		// version: 100 cycles of fail/fail/success produced 200 failed passes and
		// ZERO alerts — ~50 h of two-thirds-dead dispatch, longer than the outage.
		const c = collector();
		for (let cycle = 0; cycle < 20; cycle++) {
			await recordScaleFailure(new Error("flap"), c.raise);
			await recordScaleFailure(new Error("flap"), c.raise);
			recordScaleSuccess();
		}
		expect(c.raised.length).toBeGreaterThan(0);
	});

	test("a flapping gateway does not re-page on every third pass", async () => {
		// The cost of fixing the above naively: if a success re-armed the latch,
		// one ongoing incident would page every few passes forever.
		const c = collector();
		for (let cycle = 0; cycle < 20; cycle++) {
			await recordScaleFailure(new Error("flap"), c.raise);
			await recordScaleFailure(new Error("flap"), c.raise);
			recordScaleSuccess();
		}
		expect(c.raised.length).toBe(1);
	});

	test("a real recovery re-arms the alert for a genuinely new outage", async () => {
		const c = collector();
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD; i++) {
			await recordScaleFailure(new Error("outage one"), c.raise);
		}
		expect(c.raised.length).toBe(1);
		// Sustained health, not one lucky pass: the window must actually clear.
		for (let i = 0; i < DISPATCH_WINDOW_PASSES; i++) {
			recordScaleSuccess();
		}
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD; i++) {
			await recordScaleFailure(new Error("outage two"), c.raise);
		}
		expect(c.raised.length).toBe(2);
	});

	test("a queue-read failure counts as a failed pass, not a silent skip", async () => {
		// FINDING 3 of the review of 3203e17. `runForgeRunnerScale` swallows a
		// queue-read throw inside `readWaiting`, warns, and returns normally — so
		// the try/catch in `service-cycle` never fires and the counter stays at
		// zero. Dispatch is equally dead in that shape (no scaling action is
		// taken), so it degraded to exactly the pre-fix behaviour: a warn line
		// nobody reads. `runForgeRunnerScale` now reports whether the pass
		// actually happened, and the caller counts a skip as a failure.
		const c = collector();
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD; i++) {
			await recordScaleFailure(new Error("forge runner scale skipped: queue read failed"), c.raise);
		}
		expect(c.raised.length).toBe(1);
	});

	test("the PRODUCTION default sink is wired to the real egress, not a no-op", async () => {
		// FINDINGS 5/6 of the review of 3203e17. Every other test in this file
		// injects its own sink, so `defaultSink` — the only path production takes —
		// was exercised by nothing: its body could be emptied and the whole suite
		// stayed green. That is exactly the silent-no-op class `raiseClassAlert`
		// was added to prevent, left unguarded.
		//
		// Called with NO sink argument, so the real default runs. With no alert
		// target bound, `raiseCriticalAlert` returns without a network call, so
		// this is hermetic; what it proves is that the default path REACHES that
		// decision instead of being an empty function.
		const seen: string[] = [];
		const spy = spyOn(criticalAlert, "raiseClassAlert").mockImplementation(
			async (f): Promise<AlertDelivery> => {
				seen.push(f.alertClass);
				return { delivered: true, how: "opened" };
			},
		);
		try {
			for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD; i++) {
				await recordScaleFailure(new Error("down"));
			}
		} finally {
			spy.mockRestore();
		}
		expect(seen.length).toBe(1);
		expect(seen[0]).toContain("dispatch");
	});

	test("a forge outage that swallows the alert does NOT latch the drought", async () => {
		// P1 of the review of 0665d86, and the sharpest failure this module can have.
		//
		// `raiseCriticalAlert` NEVER THROWS by design — an unconfigured target, a
		// failed forge write, and an unprovable dedupe scan all resolve normally.
		// The first version of this latch set `escalated = true` whenever the sink
		// RESOLVED, so it could not tell "issue filed" from "forge down, nothing
		// filed". That is not a corner case: the forge write is among the most
		// likely things to fail during the very infrastructure outage this alert
		// exists for, and a latch set then suppresses every later retry for the
		// LIFE OF THE PROCESS. The 35 h outage would have gone unreported again,
		// this time with monitoring code in place that believed it had reported.
		//
		// The earlier test below injects a REJECTING sink, which the try/catch
		// already handled. This one injects the shape production actually takes:
		// resolve, report undelivered. Against the resolution-latching version this
		// test fails — 1 attempt, then permanent silence.
		let attempts = 0;
		const forgeDown = async (): Promise<AlertDelivery> => {
			attempts += 1;
			return { delivered: false, why: "failed" };
		};
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD + 4; i++) {
			await recordScaleFailure(new Error("gateway down"), forgeDown);
		}
		// Every pass at or past the threshold retries, because none of them landed.
		expect(attempts).toBe(5);
	});

	test("an unprovable dedupe scan does not latch, but a found issue does", async () => {
		// The two dedupe outcomes are NOT the same, and collapsing them is how the
		// original bug reads as correct. `found` means an issue for this class is
		// open on the forge right now — the operator can see it, so latching is
		// right and re-posting would add nothing. `indeterminate` means the scan
		// could not prove absence and deliberately posted NOTHING; nobody has been
		// shown anything, so latching there is the silent-failure bug wearing the
		// dedupe's clothes.
		let calls = 0;
		const unprovable = async (): Promise<AlertDelivery> => {
			calls += 1;
			return { delivered: false, why: "indeterminate" };
		};
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD + 2; i++) {
			await recordScaleFailure(new Error("down"), unprovable);
		}
		expect(calls).toBe(3);

		resetScaleDroughtState();
		let deduped = 0;
		const alreadyOpen = async (): Promise<AlertDelivery> => {
			deduped += 1;
			return { delivered: true, how: "deduped" };
		};
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD + 2; i++) {
			await recordScaleFailure(new Error("down"), alreadyOpen);
		}
		// Latched on the first delivery: the issue exists and the human can see it.
		expect(deduped).toBe(1);
	});

	test("an unconfigured alert target never latches a drought that nobody saw", async () => {
		// The off-by-default posture is correct for the EGRESS and wrong as a latch.
		// A deployment with no `[monitoring-critical]` target configured makes zero
		// forge calls — so if that counted as having alerted, the drought would be
		// marked handled on a box where handling it is impossible. It must keep
		// trying, so that binding a target later starts working immediately.
		let calls = 0;
		const unconfigured = async (): Promise<AlertDelivery> => {
			calls += 1;
			return { delivered: false, why: "unconfigured" };
		};
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD + 2; i++) {
			await recordScaleFailure(new Error("down"), unconfigured);
		}
		expect(calls).toBe(3);
	});

	test("an alert egress that throws never propagates into the pass", async () => {
		// This runs inside an error sink. Throwing here would turn a monitoring
		// gap into an outage of the thing doing the monitoring.
		const throwing = async (): Promise<AlertDelivery> => {
			throw new Error("forge unreachable");
		};
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD; i++) {
			await recordScaleFailure(new Error("down"), throwing);
		}
		expect(true).toBe(true);
	});
});

/**
 * THE ADAPTER, not the counter (P2 of the review of a25fea4).
 *
 * Every test above calls `recordScaleFailure` directly, which proves the
 * counting rules and NOTHING about whether the production caller ever reaches
 * them. `runScaleStepWithDroughtTracking` is what the service cycle actually
 * runs, and it owns the three-way outcome decision: a throw and a `skipped` both
 * count as failures, `disabled` counts as nothing, and a `ran` pass that applied
 * none of its requested actions counts as a failure too. Delete any one of those
 * branches and the tests above stay green — which is exactly the shape of gate
 * that certifies a deleted subject.
 */
describe("runScaleStepWithDroughtTracking", () => {
	/**
	 * Deps that satisfy the scale pass, with every knob a test needs to break.
	 *
	 * The vmids MUST be in the forge band (9101-9150, `src/runner/bands.ts`) AND
	 * registered as `forge-runner-<vmid>`: the pass drops strays and unregistered
	 * vmids, so anything else yields an empty group and a healthy do-nothing
	 * outcome. That is a test that asserts nothing while looking right.
	 *
	 * Default shape: one label group, 9101 and 9102 both stopped (running 0 is
	 * under `floor`), so the pass attempts a start.
	 */
	function deps(over: Partial<ForgeRunnerScaleDeps> = {}): ForgeRunnerScaleDeps {
		return {
			readForge: async () => ({
				waiting: [],
				runners: [
					{ name: "forge-runner-9101", status: "offline", labels: ["docker"] },
					{ name: "forge-runner-9102", status: "offline", labels: ["docker"] },
				],
			}),
			listBand: async () => [
				{ vmid: 9101, status: "stopped" },
				{ vmid: 9102, status: "stopped" },
			],
			readRunnerStatus: async () => "idle",
			startMember: async () => undefined,
			stopMember: async () => undefined,
			onWarn: () => undefined,
			idleSince: new Map(),
			offlineSince: new Map(),
			now: () => 0,
			...over,
		};
	}

	/** Steady state: 9101 running and Forge-idle, nothing waiting, floor met. */
	const nothingToDo: Partial<ForgeRunnerScaleDeps> = {
		readForge: async () => ({
			waiting: [],
			runners: [{ name: "forge-runner-9101", status: "idle", labels: ["docker"] }],
		}),
		listBand: async () => [{ vmid: 9101, status: "running" }],
	};

	const refuseStart: Partial<ForgeRunnerScaleDeps> = {
		startMember: async () => {
			throw new Error("gateway refused start");
		},
	};

	const fleet: ForgeRunnerFleetConfig = {
		floor: 1,
		standby_label: "docker",
		cap: 4,
		idle_minutes: 20,
	};
	const config = { forge_runner_fleet: fleet } as Partial<WatcherConfig> as WatcherConfig;

	/** Drive N passes through the adapter and report how many alerts were raised. */
	async function passes(count: number, over: Partial<ForgeRunnerScaleDeps> = {}): Promise<number> {
		const c = collector();
		for (let i = 0; i < count; i++) {
			await runScaleStepWithDroughtTracking({
				config,
				resolveDeps: () => deps(over),
				onError: () => undefined,
				sink: c.raise,
			});
		}
		return c.raised.length;
	}

	test("a gateway refusing EVERY start is a failed pass, not a successful one", async () => {
		// THE OUTAGE SHAPE, and the one that defeated the whole feature. A dead
		// gateway throws on each `startMember`; `applyActions` catches and warns
		// per member, so the pass returned `{status:"ran"}` and the adapter called
		// `recordScaleSuccess()` — resetting the drought counter on every pass of
		// the very outage it was written to catch. Probed on a25fea4 before the
		// fix: two stopped members, both starts throwing, outcome `{"status":"ran"}`.
		const outcome = await runForgeRunnerScale(config, deps(refuseStart));
		expect(outcome.status).toBe("ran");
		if (outcome.status === "ran") {
			expect(outcome.attempted).toBeGreaterThan(0);
			expect(outcome.applied).toBe(0);
		}
		const raised = await passes(DISPATCH_DROUGHT_THRESHOLD, refuseStart);
		expect(raised).toBe(1);
	});

	test("a pass with nothing to do is healthy and never escalates", async () => {
		// The counterpart that stops the fix from over-firing. `desired === running`
		// is the steady state of a correctly-sized fleet, and counting "attempted
		// nothing" as a failure would page every pass on a healthy system — the
		// exact alert-fatigue failure the threshold exists to prevent.
		expect(await runForgeRunnerScale(config, deps(nothingToDo))).toEqual({
			status: "ran",
			attempted: 0,
			applied: 0,
		});
		const raised = await passes(DISPATCH_DROUGHT_THRESHOLD + 5, nothingToDo);
		expect(raised).toBe(0);
	});

	test("a throwing band list is a skipped pass with one warn, and counts as a failure", async () => {
		// sf#1080: a gateway that cannot list the band is "no reading", the same as a
		// failed Forge read -- skipped, never escaping the pass as a throw.
		const listDown: Partial<ForgeRunnerScaleDeps> = {
			listBand: async () => {
				throw new Error("fleet inventory exploded");
			},
		};
		const warns: string[] = [];
		const outcome = await runForgeRunnerScale(config, {
			...deps(listDown),
			onWarn: (m) => warns.push(m),
		});
		expect(outcome).toEqual({ status: "skipped", reason: "band list failed" });
		expect(warns).toHaveLength(1);
		expect(warns[0]).toContain("fleet inventory exploded");
		const raised = await passes(DISPATCH_DROUGHT_THRESHOLD, listDown);
		expect(raised).toBe(1);
	});

	test("a skipped pass counts as a failure through the adapter", async () => {
		// A queue read that yields no usable depth. `runForgeRunnerScale` catches
		// it internally and returns `skipped`, so the adapter's try/catch never
		// fires — it has to read the outcome to count this.
		const queueDown: Partial<ForgeRunnerScaleDeps> = {
			readForge: async () => {
				throw new Error("queue read failed");
			},
		};
		expect((await runForgeRunnerScale(config, deps(queueDown))).status).toBe("skipped");
		const raised = await passes(DISPATCH_DROUGHT_THRESHOLD, queueDown);
		expect(raised).toBe(1);
	});

	test("a disabled fleet is not a drought", async () => {
		// Opting out of fleet scaling is a configuration choice, not a failure.
		const c = collector();
		for (let i = 0; i < DISPATCH_DROUGHT_THRESHOLD + 3; i++) {
			await runScaleStepWithDroughtTracking({
				config: {} as Partial<WatcherConfig> as WatcherConfig,
				resolveDeps: () => deps(),
				onError: () => undefined,
				sink: c.raise,
			});
		}
		expect(c.raised.length).toBe(0);
	});
});
