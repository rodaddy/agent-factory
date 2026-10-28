import { describe, expect, test } from "bun:test";
import type { PassResult } from "../../src/reconcile/pass";
import { Scheduler } from "../../src/reconcile/scheduler";
import { until } from "../support/wait-until";

function emptyResult(): PassResult {
	return {
		startedAt: "2026-07-19T18:00:00Z",
		durationMs: 1,
		repositories: [],
		okCount: 0,
		failCount: 0,
	};
}

/** A promise plus its resolver, so a test can block then release a pass. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
	let resolve: () => void = () => {};
	const promise = new Promise<void>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

/** A controllable timer: capture the interval callback and fire it manually. */
function fakeTimer() {
	let cb: (() => void) | null = null;
	let cleared = false;
	return {
		setInterval: (fn: () => void) => {
			cb = fn;
			return 1 as unknown as ReturnType<typeof setInterval>;
		},
		clearInterval: () => {
			cleared = true;
		},
		tick: () => cb?.(),
		get cleared() {
			return cleared;
		},
	};
}

/** Controllable setTimeout/clearTimeout/now seams for the deferred slot. */
function fakeTimeouts() {
	let clock = 0;
	let nextId = 100;
	const pending: { id: number; ms: number; fn: () => void }[] = [];
	const cleared: number[] = [];
	const seams = {
		setTimeout: (fn: () => void, ms: number) => {
			const id = nextId++;
			pending.push({ id, ms, fn });
			return id as unknown as ReturnType<typeof setTimeout>;
		},
		clearTimeout: (h: ReturnType<typeof setTimeout>) => {
			const id = h as unknown as number;
			cleared.push(id);
			const i = pending.findIndex((t) => t.id === id);
			if (i >= 0) {
				pending.splice(i, 1);
			}
		},
		now: () => clock,
	};
	return {
		seams,
		pending,
		cleared,
		advance: (ms: number) => {
			clock += ms;
		},
		/** Fire (and remove) the pending timer at index i. */
		fire: (i: number) => {
			const [t] = pending.splice(i, 1);
			t?.fn();
		},
	};
}

/** Scheduler whose passes block on a swappable gate, counting concurrency. */
function gatedScheduler(extra: Partial<ConstructorParameters<typeof Scheduler>[0]> = {}) {
	// A release that lands before its pass starts is banked as a credit.
	const state = { runs: 0, active: 0, maxActive: 0, credits: 0 };
	const waiters: (() => void)[] = [];
	const timer = fakeTimer();
	const timeouts = fakeTimeouts();
	const s = new Scheduler({
		intervalMinutes: 15,
		run: async () => {
			state.runs++;
			state.active++;
			state.maxActive = Math.max(state.maxActive, state.active);
			if (state.credits > 0) {
				state.credits--;
			} else {
				await new Promise<void>((r) => waiters.push(r));
			}
			state.active--;
			return emptyResult();
		},
		setInterval: timer.setInterval,
		clearInterval: timer.clearInterval,
		...timeouts.seams,
		...extra,
	});
	/** Release the current (or next) pass. */
	const release = () => {
		const w = waiters.shift();
		if (w) {
			w();
		} else {
			state.credits++;
		}
	};
	return { s, state, timeouts, release };
}

// fixed-sleep-ok: asserts absence, no completion signal
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("Scheduler deferred relaunch", () => {
	test("0b: a trigger during the follow-up relaunches a new lifecycle after 5_000", async () => {
		const { s, state, timeouts, release } = gatedScheduler();
		const start = s.start();
		await until(() => state.runs === 1);
		expect(state.runs).toBe(1);
		void s.trigger(); // follow-up owed
		release();
		await until(() => state.runs === 2);
		expect(state.runs).toBe(2); // follow-up running
		void s.trigger(); // lands during the follow-up
		release();
		await start;
		await until(() => s.deferredArmed);
		expect(s.running).toBe(false);
		expect(s.deferredArmed).toBe(true);
		expect(timeouts.pending.map((t) => t.ms)).toEqual([5_000]);
		timeouts.fire(0);
		await until(() => state.runs === 3);
		expect(state.runs).toBe(3);
		expect(s.running).toBe(true); // a NEW lifecycle
		release();
		await until(() => !s.running);
		expect(state.maxActive).toBe(1);
		expect(s.deferredArmed).toBe(false);
		await s.stop();
	});

	test("0b: a burst of 5 triggers during the follow-up yields exactly one relaunch", async () => {
		const { s, state, timeouts, release } = gatedScheduler();
		const start = s.start();
		await until(() => state.runs === 1);
		void s.trigger();
		release();
		await until(() => state.runs === 2);
		for (let i = 0; i < 5; i++) {
			void s.trigger();
		}
		release();
		await start;
		await until(() => s.deferredArmed);
		expect(timeouts.pending).toHaveLength(1);
		timeouts.fire(0);
		await until(() => state.runs === 3);
		release();
		await until(() => !s.running);
		expect(state.runs).toBe(3);
		expect(timeouts.pending).toHaveLength(0);
		expect(state.maxActive).toBe(1);
		await s.stop();
	});

	test("stop() clears an armed deferred timer; a late fire runs no pass", async () => {
		const { s, state, timeouts, release } = gatedScheduler();
		const start = s.start();
		await until(() => state.runs === 1);
		void s.trigger();
		release();
		await until(() => state.runs === 2);
		void s.trigger();
		release();
		await start;
		await until(() => s.deferredArmed);
		const armed = timeouts.pending[0];
		expect(armed).toBeDefined();
		await s.stop();
		expect(timeouts.cleared).toContain(armed?.id as number);
		expect(s.deferredArmed).toBe(false);
		armed?.fn();
		await flush();
		expect(state.runs).toBe(2);
	});

	test("followThrough: number arms the slot, null arms nothing, throw reaches onError", async () => {
		let answer: number | null | Error = 20_000;
		const errors: unknown[] = [];
		const { s, state, timeouts, release } = gatedScheduler({
			followThrough: async () => {
				if (answer instanceof Error) {
					throw answer;
				}
				return answer;
			},
			onError: (e) => errors.push(e),
		});
		const start = s.start();
		await until(() => state.runs === 1);
		release();
		await start;
		expect(timeouts.pending.map((t) => t.ms)).toEqual([20_000]);
		timeouts.fire(0);
		answer = null;
		release();
		await until(() => state.runs === 2 && !s.running);
		expect(state.runs).toBe(2);
		expect(s.deferredArmed).toBe(false);
		answer = new Error("ft boom");
		void s.trigger();
		release();
		await until(() => state.runs === 3 && !s.running);
		expect(state.runs).toBe(3);
		expect(errors).toHaveLength(1);
		expect(s.running).toBe(false);
		answer = null;
		void s.trigger();
		release();
		await until(() => state.runs === 4);
		expect(state.runs).toBe(4); // still running after the throw
		await s.stop();
	});

	test("earliest wins: 20_000 then a dropped wake re-arms 5_000; 5_000 then 20_000 keeps 5_000", async () => {
		let answer: number | null = 20_000;
		const { s, state, timeouts, release } = gatedScheduler({ followThrough: async () => answer });
		const start = s.start();
		await until(() => state.runs === 1);
		void s.trigger();
		release(); // pass 1 ends -> followThrough arms 20_000
		await until(() => timeouts.pending.length === 1);
		expect(timeouts.pending.map((t) => t.ms)).toEqual([20_000]);
		const first = timeouts.pending[0]?.id as number;
		answer = null;
		void s.trigger(); // dropped wake during the follow-up
		release();
		await start;
		await until(() => timeouts.pending[0]?.ms === 5_000);
		expect(timeouts.cleared).toContain(first);
		expect(timeouts.pending.map((t) => t.ms)).toEqual([5_000]);
		// Now armed at 5_000; a later 20_000 request changes nothing.
		answer = 20_000;
		const armedId = timeouts.pending[0]?.id as number;
		timeouts.advance(1_000);
		const clearedBefore = timeouts.cleared.length;
		// Drive a pass whose followThrough asks for 20_000 without consuming the slot:
		// trigger() while idle launches a pass directly.
		void s.trigger();
		release();
		await until(() => state.runs === 3 && !s.running);
		expect(timeouts.pending.map((t) => t.id)).toEqual([armedId]);
		expect(timeouts.cleared.length).toBe(clearedBefore);
		await s.stop();
	});
});

describe("Scheduler", () => {
	test("runs a pass at startup", async () => {
		let runs = 0;
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await s.start();
		expect(runs).toBe(1);
		await s.stop();
	});

	test("runs again on an interval tick", async () => {
		let runs = 0;
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await s.start();
		timer.tick();
		await until(() => runs === 2);
		expect(runs).toBe(2);
		await s.stop();
	});

	test("only one pass runs at a time (single flight)", async () => {
		let active = 0;
		let maxActive = 0;
		const gate = deferred();
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				active++;
				maxActive = Math.max(maxActive, active);
				await gate.promise;
				active--;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});

		const startPromise = s.start();
		// While the startup pass is blocked, an interval tick must NOT start a
		// second concurrent pass.
		timer.tick();
		timer.tick();
		gate.resolve();
		await startPromise;
		expect(maxActive).toBe(1);
		await s.stop();
	});

	test("reports results via onResult", async () => {
		const results: PassResult[] = [];
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => ({ ...emptyResult(), okCount: 3 }),
			onResult: (r) => results.push(r),
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await s.start();
		expect(results.length).toBe(1);
		expect(results[0]?.okCount).toBe(3);
		await s.stop();
	});

	test("a throwing pass is reported via onError, not swallowed silently", async () => {
		let captured: unknown = null;
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				throw new Error("boom");
			},
			onError: (e) => {
				captured = e;
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await s.start();
		expect((captured as Error)?.message).toBe("boom");
		await s.stop();
	});

	test("a throwing onError sink does not abort the tick/drain loop or the lifecycle", async () => {
		let runs = 0;
		let installs = 0;
		let onErrorCalls = 0;
		let shouldFail = true;
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				if (shouldFail) {
					throw new Error("run failed");
				}
				return emptyResult();
			},
			// A faulty monitoring sink: it THROWS on the pass error. It must not escape the
			// drain loop and take down the scheduler tick/lifecycle — the swallow keeps the
			// pass isolated (mirroring reportError in dispatch-pass).
			onError: () => {
				onErrorCalls++;
				throw new Error("faulty logging sink");
			},
			setInterval: (fn: () => void) => {
				installs++;
				return timer.setInterval(fn);
			},
			clearInterval: timer.clearInterval,
		});

		// Startup SETTLES normally despite the throwing sink (no unhandled rejection),
		// and the interval is installed — the lifecycle is intact, not aborted.
		await s.start();
		expect(onErrorCalls).toBe(1);
		expect(installs).toBe(1);
		expect(s.running).toBe(false);

		// A later interval tick whose pass throws also isolates the sink's throw: the
		// drain loop keeps draining and the scheduler stays healthy.
		timer.tick();
		await until(() => onErrorCalls === 2 && !s.running);
		expect(onErrorCalls).toBe(2);

		// The scheduler still runs clean passes and stops/restarts deterministically.
		shouldFail = false;
		await s.trigger();
		await s.stop();
		expect(timer.cleared).toBe(true);
		expect(runs).toBeGreaterThanOrEqual(3);
	});

	test("stop before first start is a no-op and does not poison later shutdown", async () => {
		let runs = 0;
		let clears = 0;
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				return emptyResult();
			},
			setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
			clearInterval: () => {
				clears++;
			},
		});

		await s.stop();
		await s.start();
		expect(runs).toBe(1);
		await s.stop();
		expect(clears).toBe(1);
		await s.trigger();
		expect(runs).toBe(1);
	});

	test("stop() clears the timer and prevents further passes", async () => {
		let runs = 0;
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await s.start();
		await s.stop();
		expect(timer.cleared).toBe(true);
		await s.trigger();
		expect(runs).toBe(1); // startup only; post-stop trigger is a no-op
	});

	test("explicit triggers during one blocked pass coalesce into exactly one follow-up", async () => {
		// A doorbell ring that lands while a pass is in flight must not be lost: it
		// coalesces into exactly ONE follow-up pass. A burst of explicit triggers
		// during the same in-flight pass collapses into that single rerun — two
		// passes total (the blocked one + one follow-up), never a fan-out.
		let active = 0;
		let maxActive = 0;
		let runs = 0;
		let gate = deferred();
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				active++;
				maxActive = Math.max(maxActive, active);
				await gate.promise;
				active--;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});

		// Start the first pass and leave it blocked. The lifecycle publishes its
		// in-flight sentinel synchronously, but the pass body is kicked one microtask
		// later (so a synchronous trigger inside run() coalesces safely), so flush
		// once before observing the first run.
		const startPromise = s.start();
		await Promise.resolve();
		expect(runs).toBe(1);

		// Three explicit triggers arrive while the first pass is still in flight.
		// Each coalesces onto the in-flight pass and marks the single pending rerun.
		const t1 = s.trigger();
		const t2 = s.trigger();
		const t3 = s.trigger();

		// Release the first pass; a single follow-up should now run. Swap in a
		// fresh gate the follow-up will block on so we can observe it while it is
		// still in flight. Because start()/trigger() all coalesce onto the one
		// single-flight lifecycle, none of their promises resolve until the drain
		// (including the follow-up) completes — so we must NOT await them yet.
		const followupGate = deferred();
		const firstGate = gate;
		gate = followupGate;
		firstGate.resolve();
		// Let the drain loop start the follow-up and block on the new gate.
		await until(() => runs === 2);

		// Exactly one follow-up started, and never more than one pass at a time.
		expect(runs).toBe(2);
		expect(maxActive).toBe(1);

		// Release the follow-up; now the whole coalesced lifecycle resolves.
		followupGate.resolve();
		await Promise.all([startPromise, t1, t2, t3]);
		// Confirm the single follow-up did not chain a third pass.
		expect(runs).toBe(2);
		await s.stop();
		expect(runs).toBe(2);
	});

	test("an interval tick while busy produces no follow-up (skip, not queue)", async () => {
		// Interval ticks differ from explicit triggers: a tick landing while a pass
		// runs is skipped entirely, not queued. The next tick self-heals.
		let runs = 0;
		const gate = deferred();
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				await gate.promise;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});

		const startPromise = s.start();
		// Ticks while the startup pass is blocked are skipped, not queued.
		timer.tick();
		timer.tick();
		gate.resolve();
		await startPromise;
		// Give any (incorrectly) queued follow-up a chance to run.
		await new Promise((r) => setTimeout(r, 0)); // fixed-sleep-ok: asserts absence, no completion signal
		expect(runs).toBe(1);
		await s.stop();
	});

	test("a trigger arriving after the pass is stopped queues nothing", async () => {
		// A stopped scheduler neither queues nor reruns, even if the explicit
		// trigger raced the stop while a pass was still draining.
		let runs = 0;
		const gate = deferred();
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				await gate.promise;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});

		const startPromise = s.start();
		const stopPromise = s.stop();
		// Explicit trigger during shutdown must not schedule a follow-up.
		const late = s.trigger();
		gate.resolve();
		await Promise.all([startPromise, stopPromise, late]);
		expect(runs).toBe(1);
	});

	test("stop during startup does not install an interval after the pass drains", async () => {
		let runs = 0;
		const gate = deferred();
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				await gate.promise;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});

		const startPromise = s.start();
		const stopPromise = s.stop();
		gate.resolve();
		await Promise.all([startPromise, stopPromise]);
		timer.tick();
		await new Promise((r) => setTimeout(r, 0)); // fixed-sleep-ok: asserts absence, no completion signal
		expect(runs).toBe(1);
	});

	test("one lifecycle is bounded to the initial pass plus at most one follow-up (no unbounded rerun chain)", async () => {
		// Finding P2 (unbounded rerun chain). Explicit triggers arriving DURING the
		// guaranteed follow-up must NOT chain a third pass or extend the lifecycle
		// forever. Total passes for one lifecycle under sustained triggering is
		// exactly two: initial + one follow-up (sf#1076: then one deferred relaunch).
		let runs = 0;
		let gate = deferred();
		const timer = fakeTimer();
		const timeouts = fakeTimeouts();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				await gate.promise;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
			...timeouts.seams,
		});

		// Initial pass blocks. The pass body starts one microtask after start(), so
		// flush once before observing the first run.
		const startPromise = s.start();
		await Promise.resolve();
		expect(runs).toBe(1);

		// Trigger during the initial pass -> marks the one guaranteed follow-up.
		const t1 = s.trigger();

		// Release the initial pass; the follow-up starts and blocks on a fresh gate.
		const followupGate = deferred();
		const firstGate = gate;
		gate = followupGate;
		firstGate.resolve();
		await until(() => runs === 2);
		expect(runs).toBe(2); // follow-up started

		// Sustained triggering DURING the follow-up must not chain a third pass.
		const t2 = s.trigger();
		const t3 = s.trigger();
		const t4 = s.trigger();

		followupGate.resolve();
		await Promise.all([startPromise, t1, t2, t3, t4]);

		// Exactly two passes: the lifecycle did not rerun forever.
		expect(runs).toBe(2);

		// sf#1076 0b: the wakes seen during the follow-up are not dropped to the
		// interval tick; they arm ONE deferred relaunch as a fresh lifecycle.
		expect(s.deferredArmed).toBe(true);
		expect(timeouts.pending.map((t) => t.ms)).toEqual([5_000]);
		timeouts.fire(0);
		await until(() => runs === 3 && !s.running);
		expect(runs).toBe(3); // one relaunch, not a backlog
		expect(s.deferredArmed).toBe(false);
		await s.stop();
		expect(runs).toBe(3);
	});

	test("repeated start() on an active scheduler installs no duplicate interval and starts no extra pass", async () => {
		// Finding P2 (repeated/concurrent start). start() must be idempotent: a
		// second start on an already-active scheduler must not install a second
		// interval nor run an extra startup pass.
		let runs = 0;
		let installs = 0;
		const timer = { cb: null as (() => void) | null };
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				return emptyResult();
			},
			setInterval: (fn) => {
				installs++;
				timer.cb = fn;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: () => {},
		});

		await s.start();
		expect(runs).toBe(1);
		expect(installs).toBe(1);

		// Repeated starts on the active scheduler are no-ops.
		await s.start();
		await s.start();
		expect(runs).toBe(1);
		expect(installs).toBe(1);

		// The single installed interval still drives passes.
		timer.cb?.();
		await until(() => runs === 2);
		expect(runs).toBe(2);
		await s.stop();
	});

	test("concurrent start() calls serialize into a single startup, not two", async () => {
		// Two start() calls racing before the first resolves must not both run a
		// startup pass or both install an interval.
		let runs = 0;
		let installs = 0;
		const gate = deferred();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				await gate.promise;
				return emptyResult();
			},
			setInterval: (fn) => {
				installs++;
				void fn;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: () => {},
		});

		const a = s.start();
		const b = s.start(); // races the in-progress start
		gate.resolve();
		await Promise.all([a, b]);
		expect(runs).toBe(1);
		expect(installs).toBe(1);
		await s.stop();
	});

	test("start() racing an in-progress stop does not reset stopped or resume scheduling", async () => {
		// Finding P2. A start() that lands while a stop() is draining must not
		// resurrect the scheduler: no interval installed, and triggers stay no-ops.
		let runs = 0;
		let installs = 0;
		const gate = deferred();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				await gate.promise;
				return emptyResult();
			},
			setInterval: (fn) => {
				installs++;
				void fn;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: () => {},
		});

		const startPromise = s.start(); // startup pass blocks on the gate
		const stopPromise = s.stop(); // stop begins, marking stopped, draining
		const restart = s.start(); // races the in-progress stop
		gate.resolve();
		await Promise.all([startPromise, stopPromise, restart]);

		// Only the original startup pass ran; the racing start did not resume it.
		expect(runs).toBe(1);
		// The racing start installed no interval (stop won the race).
		expect(installs).toBe(0);
		// A trigger after this remains a no-op: the scheduler is still stopped.
		await s.trigger();
		expect(runs).toBe(1);
	});

	test("restart after a full stop is unambiguous and runs a fresh startup pass", async () => {
		// Restart is supported only when the scheduler is fully quiescent. After a
		// completed stop, a fresh start() runs a new startup pass and reinstalls the
		// interval exactly once.
		let runs = 0;
		let installs = 0;
		const timer = { cb: null as (() => void) | null };
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				return emptyResult();
			},
			setInterval: (fn) => {
				installs++;
				timer.cb = fn;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: () => {
				timer.cb = null;
			},
		});

		await s.start();
		await s.stop();
		expect(runs).toBe(1);
		expect(installs).toBe(1);

		// Fully stopped -> restart is unambiguous.
		await s.start();
		expect(runs).toBe(2);
		expect(installs).toBe(2);
		timer.cb?.();
		await until(() => runs === 3);
		expect(runs).toBe(3);
		await s.stop();
	});

	test("an installed interval starts a blocked pass; a second tick while busy yields no follow-up", async () => {
		// Finding P3 (false interval test). Complete startup, then drive the REAL
		// installed interval: the first tick starts a newly blocked pass, a second
		// tick while that pass is busy is skipped (not queued), and releasing proves
		// no follow-up chained from the skipped tick.
		let runs = 0;
		// Startup pass runs with a pre-resolved gate so start() completes cleanly.
		const startupGate = deferred();
		startupGate.resolve();
		let gate = startupGate;
		const timer = { cb: null as (() => void) | null };
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				await gate.promise;
				return emptyResult();
			},
			setInterval: (fn) => {
				timer.cb = fn;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: () => {},
		});

		// Startup pass completes cleanly so the interval is installed and idle.
		await s.start();
		expect(runs).toBe(1);

		// Fire the installed interval to start a fresh pass, then block it.
		const busyGate = deferred();
		gate = busyGate;
		timer.cb?.();
		await Promise.resolve();
		expect(runs).toBe(2); // interval started pass #2

		// A second interval tick while pass #2 is busy is skipped, not queued.
		timer.cb?.();
		await Promise.resolve();
		expect(runs).toBe(2); // still one in-flight, no concurrent start

		// Release pass #2; the skipped tick must NOT have queued a follow-up.
		busyGate.resolve();
		await until(() => !s.running);
		expect(runs).toBe(2);
		await s.stop();
	});

	test("a synchronous trigger inside run() coalesces into one serial follow-up (maxActive one)", async () => {
		// Structural single-flight guarantee. If the pass body calls trigger()
		// synchronously — before its first await — the in-flight sentinel must
		// already be published so the trigger coalesces onto the running lifecycle
		// instead of racing a second concurrent pass. Result: exactly two serial
		// passes, never overlapping.
		let active = 0;
		let maxActive = 0;
		let runs = 0;
		let s!: Scheduler;
		const timer = fakeTimer();
		s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				active++;
				maxActive = Math.max(maxActive, active);
				if (runs === 1) {
					// Synchronous re-entrant trigger, before any await in this body.
					void s.trigger();
				}
				await Promise.resolve();
				active--;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});

		await s.start();
		// Let the coalesced follow-up drain.
		await until(() => runs === 2 && !s.running);
		expect(runs).toBe(2); // initial pass + one coalesced follow-up
		expect(maxActive).toBe(1); // never two passes at once
		await s.stop();
		expect(runs).toBe(2); // no third pass chained
	});

	test("stop then immediate start before awaiting stop: racing start no-ops, restart after awaited stop succeeds once", async () => {
		// An idle, active scheduler is stopped and start() is called immediately —
		// before the stop promise is awaited. The racing start must no-op (the
		// scheduler is mid-shutdown and cannot be resurrected). After awaiting stop,
		// exactly one restart succeeds and reinstalls the interval once.
		let runs = 0;
		let installs = 0;
		const timer = { cb: null as (() => void) | null };
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				return emptyResult();
			},
			setInterval: (fn) => {
				installs++;
				timer.cb = fn;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: () => {
				timer.cb = null;
			},
		});

		// Reach the idle, active steady state.
		await s.start();
		expect(runs).toBe(1);
		expect(installs).toBe(1);

		// Stop, then start immediately without awaiting stop — the racing start must
		// not resurrect scheduling.
		const stopPromise = s.stop();
		const racingStart = s.start();
		await Promise.all([stopPromise, racingStart]);
		expect(runs).toBe(1); // racing start ran no pass
		expect(installs).toBe(1); // racing start installed no interval

		// After the awaited stop, one restart succeeds deterministically.
		await s.start();
		expect(runs).toBe(2);
		expect(installs).toBe(2);
		timer.cb?.();
		await until(() => runs === 3);
		expect(runs).toBe(3); // the reinstalled interval drives passes
		await s.stop();
	});

	test("blocked startup: awaiting stop alone is sufficient, then immediate restart succeeds", async () => {
		// stop() must await the COMPLETE start operation — even a startup pass still
		// blocked — through one shared stop promise. A caller awaits only stop()
		// (never the old start promise separately) and can then restart immediately.
		let runs = 0;
		let installs = 0;
		let gate = deferred();
		const timer = { cb: null as (() => void) | null };
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				await gate.promise;
				return emptyResult();
			},
			setInterval: (fn) => {
				installs++;
				timer.cb = fn;
				return 1 as unknown as ReturnType<typeof setInterval>;
			},
			clearInterval: () => {
				timer.cb = null;
			},
		});

		// Startup pass blocks; we deliberately do NOT await the start promise.
		const startPromise = s.start();
		await Promise.resolve(); // let the blocked pass body begin
		expect(runs).toBe(1);

		// Begin shutdown while startup is still blocked, then release the pass.
		const stopPromise = s.stop();
		gate.resolve();
		// Awaiting stop alone must drain the blocked startup pass. No separate await
		// of startPromise is required for correctness.
		await stopPromise;
		// The startup pass never reached `active`, so no interval was installed.
		expect(installs).toBe(0);

		// Immediate restart succeeds without waiting on the old start promise.
		gate = deferred();
		gate.resolve();
		await s.start();
		expect(runs).toBe(2);
		expect(installs).toBe(1);
		// The abandoned original start promise still resolves; nothing leaks.
		await startPromise;
		await s.stop();
	});

	test("stop() awaits the in-flight pass", async () => {
		let finished = false;
		const gate = deferred();
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				await gate.promise;
				finished = true;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});

		const startPromise = s.start();
		const stopPromise = s.stop();
		expect(finished).toBe(false);
		gate.resolve();
		await stopPromise;
		await startPromise;
		expect(finished).toBe(true);
	});
});

describe("Scheduler onPassStart — the loop-liveness seam", () => {
	test("fires BEFORE the pass body, once per pass", async () => {
		// The CALL LOG is the assertion (done-means README rule 11): the order of
		// these entries is the property, not merely the count.
		const events: string[] = [];
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				events.push("pass");
				return emptyResult();
			},
			onPassStart: () => events.push("start"),
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});

		await s.start();
		expect(events).toEqual(["start", "pass"]);

		timer.tick();
		await Promise.resolve();
		await Promise.resolve();
		await s.stop();
		// One start stamp per pass, always immediately before the body.
		expect(events).toEqual(["start", "pass", "start", "pass"]);
	});

	test("a pass that THROWS still stamped its start", async () => {
		// The property #252 turns on: liveness is about the loop turning, not about
		// the work succeeding. A watcher whose every pass fails must not look
		// identical to one whose scheduler stopped firing.
		const events: string[] = [];
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				events.push("pass-threw");
				throw new Error("pass exploded");
			},
			onPassStart: () => events.push("start"),
			onError: () => events.push("error"),
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});

		await s.start();
		await s.stop();
		expect(events).toEqual(["start", "pass-threw", "error"]);
	});

	test("a THROWING onPassStart sink does not abort the pass it observes", async () => {
		// A liveness recorder that can kill the loop it reports on is worse than no
		// recorder: it converts an observability fault into the outage it detects.
		let runs = 0;
		let starts = 0;
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				return emptyResult();
			},
			onPassStart: () => {
				starts++;
				throw new Error("faulty liveness sink");
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});

		await s.start();
		expect(starts).toBe(1);
		// The pass RAN despite the sink throwing, and startup settled normally.
		expect(runs).toBe(1);
		await s.stop();
	});

	test("a scheduler with no onPassStart behaves exactly as before", async () => {
		// The absence control: the seam is optional and adds no behaviour when unused.
		let runs = 0;
		const timer = fakeTimer();
		const s = new Scheduler({
			intervalMinutes: 15,
			run: async () => {
				runs++;
				return emptyResult();
			},
			setInterval: timer.setInterval,
			clearInterval: timer.clearInterval,
		});
		await s.start();
		expect(runs).toBe(1);
		await s.stop();
	});
});
