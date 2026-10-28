/**
 * @module reconcile/scheduler
 * @description Single-flight scheduler for the reconciliation pass. Runs one
 *   pass at startup, then on the configured interval, and guarantees only one
 *   pass runs at a time. The two entry points differ deliberately:
 *
 *   - An **interval tick** that lands while a pass is running is *skipped*
 *     entirely — the periodic sweep is authoritative and self-heals on the next
 *     tick, so there is no value in queueing a catch-up.
 *   - An explicit **`trigger()`** (e.g. an event doorbell) that lands while a
 *     pass is running instead marks exactly *one* pending explicit rerun. When
 *     the current pass finishes, the scheduler runs one follow-up pass in the
 *     same single-flight lifecycle. Any number of explicit triggers arriving
 *     during one in-flight pass collapse into that single follow-up: a doorbell
 *     ring that arrives after the current pass may already have swept its target
 *     is never lost, but a burst of rings never fans out into a burst of passes.
 *
 *   A single scheduler lifecycle is *bounded*: the initial pass plus **at most
 *   one** explicit follow-up. Triggers that arrive during that guaranteed
 *   follow-up do not chain a third pass or extend the same lifecycle forever;
 *   instead they arm one deferred relaunch that starts a FRESH lifecycle (via
 *   `trigger()`) after `wakeCooldownMs` (default 5 s), so a wake is never
 *   dropped until the next interval tick. Any burst during the follow-up
 *   collapses into that one relaunch. This preserves max-concurrency-one and the
 *   single guaranteed follow-up for rings observed during the initial pass, while
 *   ruling out an unbounded rerun chain under sustained triggering.
 *
 *   An optional `followThrough` hook is consulted after every pass; when it
 *   resolves to a number of milliseconds, the same single deferred slot is armed
 *   for that delay (earliest due time wins). The scheduler knows nothing about
 *   why — the service decides (e.g. a build still running).
 *
 *   Lifecycle correctness is enforced *structurally* by an explicit phase state
 *   machine (`Idle → Starting → Active → Stopping → Stopped`) plus three shared
 *   promises — `startPromise`, `stopPromise`, and the per-lifecycle `inFlight`
 *   deferred. The critical invariant is that the `inFlight` sentinel is
 *   published **before** `run()` is invoked (execution is kicked in a microtask
 *   after the sentinel is assigned), so a `run()` body that synchronously calls
 *   `trigger()` before its first `await` observes an in-flight pass and
 *   coalesces into the single follow-up rather than racing a second concurrent
 *   pass. `stop()` marks the phase synchronously, clears the interval, and
 *   returns one shared promise that awaits BOTH the complete start operation and
 *   any in-flight lifecycle, so restart after an awaited `stop()` is
 *   deterministic and cannot be resurrected by a racing `start()`.
 *
 * @outputs
 *   - `Scheduler` -- start/stop/trigger a single-flight reconciliation loop
 *
 * @dependencies
 *   - ./pass -- the bounded pass this schedules
 */
import { errorMessage, log } from "../log";
import type { PassResult } from "./pass";

/** A bounded pass invocation the scheduler drives. */
export type PassRunner = () => Promise<PassResult>;

export interface SchedulerOptions {
	/** Interval between passes, in minutes. */
	intervalMinutes: number;
	/** The pass to run. */
	run: PassRunner;
	/**
	 * Called immediately BEFORE each pass body runs — the loop's liveness seam.
	 *
	 * Deliberately separate from `onResult`, and deliberately BEFORE rather than
	 * after: the claim it feeds is that the LOOP is turning, not that work
	 * succeeded. A pass that starts and then throws, hangs, or takes the process
	 * down with it has still turned the loop, and if only completions were recorded
	 * a watcher whose every pass fails would be indistinguishable from one whose
	 * scheduler stopped firing — the exact conflation #252 exists to remove.
	 *
	 * Invoked through the same never-let-it-escape posture as `onError`: a throwing
	 * sink is a monitoring fault and must not abort the pass it is observing.
	 */
	onPassStart?: () => void;
	/** Called with each completed pass result (e.g. for logging). */
	onResult?: (result: PassResult) => void;
	/** Called when a pass throws unexpectedly. */
	onError?: (error: unknown) => void;
	/** Timer seam for tests. Defaults to setInterval/clearInterval. */
	setInterval?: (fn: () => void, ms: number) => ReturnType<typeof setInterval>;
	clearInterval?: (handle: ReturnType<typeof setInterval>) => void;
	/** Timer seam for the deferred-relaunch slot. Defaults to setTimeout/clearTimeout. */
	setTimeout?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
	clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
	/** Clock seam (ms). Defaults to Date.now. */
	now?: () => number;
	/** Delay before relaunching a wake that landed during the follow-up. Default 5_000. */
	wakeCooldownMs?: number;
	/**
	 * Consulted after every pass. A number arms the deferred slot for that many
	 * ms; null arms nothing. A throw is reported via onError and never aborts.
	 */
	followThrough?: () => Promise<number | null>;
}

/**
 * The scheduler's lifecycle phase. Legal transitions:
 *
 *   Idle    → Starting            (start on a quiescent scheduler)
 *   Starting → Active             (startup pass drained, interval installed)
 *   Starting → Stopping           (stop raced startup)
 *   Active  → Stopping            (stop on a running scheduler)
 *   Stopping → Stopped            (start operation + in-flight lifecycle drained)
 *   Stopped → Starting            (explicit restart after an awaited stop)
 *
 * There is no `Idle → Active` shortcut and no way to leave `Stopping` except by
 * reaching `Stopped`; a `start()` observed during `Stopping`/`Stopped` (before
 * the stop promise is awaited) is a no-op and cannot resurrect scheduling.
 */
type Phase = "idle" | "starting" | "active" | "stopping" | "stopped";

/** A promise plus its resolver, used for the in-flight lifecycle sentinel. */
interface Deferred {
	promise: Promise<void>;
	resolve: () => void;
	reject: (reason?: unknown) => void;
}

function deferred(): Deferred {
	let resolve: () => void = () => {};
	let reject: (reason?: unknown) => void = () => {};
	const promise = new Promise<void>((r, j) => {
		resolve = r;
		reject = j;
	});
	return { promise, resolve, reject };
}

/** Single-flight reconciliation loop. */
export class Scheduler {
	private readonly intervalMs: number;
	private readonly run: PassRunner;
	private readonly onPassStart?: () => void;
	private readonly onResult?: (result: PassResult) => void;
	private readonly onError?: (error: unknown) => void;
	private readonly setIntervalImpl: NonNullable<SchedulerOptions["setInterval"]>;
	private readonly clearIntervalImpl: NonNullable<SchedulerOptions["clearInterval"]>;
	private readonly setTimeoutImpl: NonNullable<SchedulerOptions["setTimeout"]>;
	private readonly clearTimeoutImpl: NonNullable<SchedulerOptions["clearTimeout"]>;
	private readonly now: () => number;
	private readonly wakeCooldownMs: number;
	private readonly followThrough?: () => Promise<number | null>;

	/** The single deferred-relaunch slot; both null when unarmed. */
	private deferredHandle: ReturnType<typeof setTimeout> | null = null;
	private deferredDueAt: number | null = null;

	/** Explicit lifecycle phase — the single source of truth for legal states. */
	private phase: Phase = "idle";

	private handle: ReturnType<typeof setInterval> | null = null;

	/**
	 * The current lifecycle's sentinel. Assigned **before** `run()` is invoked,
	 * so a synchronous `trigger()` inside `run()` (before its first `await`) sees
	 * a pass already in flight and coalesces instead of racing a second pass.
	 * `null` exactly when no pass is executing.
	 */
	private inFlight: Deferred | null = null;

	/**
	 * The in-progress (or completed) start operation. `stop()` awaits this so it
	 * cannot resolve before a startup pass — even one still blocked — has drained.
	 * Repeated/concurrent `start()` calls share this single promise.
	 */
	private startPromise: Promise<void> | null = null;

	/**
	 * The single shared stop promise. All `stop()` callers await the same one; it
	 * awaits BOTH `startPromise` and any in-flight lifecycle before resolving.
	 */
	private stopPromise: Promise<void> | null = null;

	/**
	 * True when an explicit `trigger()` arrived while a pass was already running.
	 * At most one is remembered: repeated explicit triggers during one in-flight
	 * pass collapse into a single follow-up. Interval ticks never set this.
	 */
	private pendingExplicit = false;

	constructor(opts: SchedulerOptions) {
		this.intervalMs = opts.intervalMinutes * 60_000;
		this.run = opts.run;
		this.onPassStart = opts.onPassStart;
		this.onResult = opts.onResult;
		this.onError = opts.onError;
		this.setIntervalImpl = opts.setInterval ?? ((fn, ms) => setInterval(fn, ms));
		this.clearIntervalImpl = opts.clearInterval ?? ((h) => clearInterval(h));
		this.setTimeoutImpl = opts.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
		this.clearTimeoutImpl = opts.clearTimeout ?? ((h) => clearTimeout(h));
		this.now = opts.now ?? (() => Date.now());
		this.wakeCooldownMs = opts.wakeCooldownMs ?? 5_000;
		this.followThrough = opts.followThrough;
	}

	/** True while a pass is executing. */
	get running(): boolean {
		return this.inFlight !== null;
	}

	/** True while the deferred-relaunch slot is armed. */
	get deferredArmed(): boolean {
		return this.deferredHandle !== null;
	}

	/**
	 * Arm the single deferred-relaunch slot. Earliest due time wins: an armed
	 * slot due at or before now+delayMs is kept; otherwise it is replaced.
	 */
	private armDeferred(delayMs: number): void {
		const dueAt = this.now() + delayMs;
		if (
			this.deferredHandle !== null &&
			this.deferredDueAt !== null &&
			this.deferredDueAt <= dueAt
		) {
			return;
		}
		this.clearDeferred();
		this.deferredDueAt = dueAt;
		this.deferredHandle = this.setTimeoutImpl(() => {
			this.deferredHandle = null;
			this.deferredDueAt = null;
			// trigger() no-ops unless starting/active; a rejected lifecycle was already
			// reported through onError.
			void this.trigger().catch(() => {});
		}, delayMs);
	}

	/** Clear the deferred slot, if armed. */
	private clearDeferred(): void {
		if (this.deferredHandle !== null) {
			this.clearTimeoutImpl(this.deferredHandle);
		}
		this.deferredHandle = null;
		this.deferredDueAt = null;
	}

	/** Consult followThrough after a pass; never lets it abort the drain loop. */
	private async consultFollowThrough(): Promise<void> {
		if (!this.followThrough || this.stoppingOrStopped()) {
			return;
		}
		try {
			const delay = await this.followThrough();
			if (typeof delay === "number" && !this.stoppingOrStopped()) {
				this.armDeferred(delay);
			}
		} catch (err) {
			this.reportError(err);
		}
	}

	private stoppingOrStopped(): boolean {
		return this.phase === "stopping" || this.phase === "stopped";
	}

	/**
	 * Start the loop: run once immediately, then on the interval. Returns once
	 * the startup pass has completed so callers can observe the first result.
	 * Interval ticks use the skip-while-busy path, not the explicit rerun path.
	 *
	 * Idempotent and serialized: concurrent or repeated `start()` calls share one
	 * startup pass and install one interval. A `start()` observed while a stop is
	 * pending (`stopping`/`stopped` before the stop promise is awaited) is a
	 * no-op and cannot resurrect scheduling. Restart is supported only from a
	 * fully quiescent `idle` scheduler — after an awaited `stop()` resets the
	 * phase to `idle`, a fresh `start()` runs one new startup pass.
	 */
	async start(): Promise<void> {
		// Only a fully quiescent (idle) scheduler may (re)start. `starting`/`active`
		// share the existing startup; `stopping`/`stopped` are pending shutdown and
		// must not be resurrected. Any non-idle phase no-ops onto the live promise.
		if (this.phase !== "idle") {
			// Return the in-progress startup if one exists so concurrent starters all
			// observe the same completion; otherwise there is nothing to await.
			return this.startPromise ?? Promise.resolve();
		}
		this.phase = "starting";
		const startPromise = this.runStart();
		this.startPromise = startPromise;
		return startPromise;
	}

	/** The body of a single startup operation, shared by all concurrent starters. */
	private async runStart(): Promise<void> {
		// Run the startup pass through the single-flight lifecycle. If a synchronous
		// trigger fires inside `run()`, it coalesces onto this same lifecycle. Note
		// `stop()` owns clearing `startPromise` (via runStop's reset to idle); this
		// body only advances the phase and installs the interval.
		await this.launch();
		// stop() may have raced the startup pass. Do not install an interval once
		// shutdown has begun; leave the scheduler in its stopping/stopped path.
		if (this.phase !== "starting") {
			return;
		}
		this.handle = this.setIntervalImpl(() => {
			this.tick();
		}, this.intervalMs);
		this.phase = "active";
	}

	/**
	 * Interval-tick path. If a pass is already running, the tick is *skipped* —
	 * the periodic sweep is authoritative and the next tick self-heals, so there
	 * is no follow-up to queue. Only fires while `active`.
	 */
	private tick(): void {
		if (this.phase !== "active" || this.inFlight) {
			return;
		}
		// Interval ticks have no caller to observe a rejected lifecycle. execute()
		// already reported the original pass error through onError; consume only the
		// terminal rejection here so it cannot become an unhandled promise.
		void this.launch().catch(() => {});
	}

	/**
	 * Explicit trigger path (e.g. an event doorbell). If a pass is already
	 * running, mark exactly one pending follow-up and coalesce onto the in-flight
	 * pass; repeated explicit triggers during that pass collapse into that single
	 * follow-up. Otherwise start a pass immediately (only while `starting`/
	 * `active`). A stopping/stopped scheduler does nothing — it neither queues nor
	 * reruns.
	 */
	async trigger(): Promise<void> {
		if (this.phase !== "starting" && this.phase !== "active") {
			return;
		}
		if (this.inFlight) {
			this.pendingExplicit = true;
			return this.inFlight.promise;
		}
		return this.launch();
	}

	/**
	 * Start the single-flight lifecycle. The `inFlight` sentinel is published
	 * **synchronously here, before `run()` is ever invoked** — `execute()` is
	 * kicked in a microtask so no user `run()` code can execute before the
	 * sentinel is visible. This guarantees a synchronous `trigger()` inside
	 * `run()` (before its first `await`) observes the in-flight pass and coalesces
	 * into the single follow-up, keeping max concurrency at one.
	 */
	private launch(): Promise<void> {
		const gate = deferred();
		this.inFlight = gate;
		this.pendingExplicit = false;
		// Kick execution in a microtask so the sentinel above is already published
		// before any `run()` body runs. Mirror execute()'s actual outcome onto the
		// published gate and attach both handlers to the detached execution promise.
		void Promise.resolve()
			.then(() => this.execute())
			.then(gate.resolve, gate.reject);
		return gate.promise;
	}

	/**
	 * Drive the lifecycle: run the initial pass, then at most ONE explicit
	 * follow-up, serially, so only one pass is ever in flight. A burst of triggers
	 * during the initial pass collapses into that single follow-up; triggers
	 * during the follow-up do NOT chain a third pass — they arm one deferred
	 * relaunch of a fresh lifecycle after `wakeCooldownMs`. Settles the sentinel with the drain's outcome when it completes.
	 */
	private async execute(): Promise<void> {
		// The lifecycle owes at most one explicit follow-up. `followupUsed` flips the
		// instant that follow-up starts, so triggers landing during it are ignored.
		let followupUsed = false;
		// Set when the loop ends only because the follow-up was already spent while
		// a wake was pending; captured before the finally clears pendingExplicit.
		let wakeDropped = false;
		try {
			let keepDraining = true;
			while (keepDraining) {
				this.pendingExplicit = false;
				// Liveness is stamped BEFORE the pass body, and outside the
				// try/catch below only in the sense that it cannot be skipped by one: a
				// pass that throws has still started, and its start is the evidence the
				// loop is turning. `reportPassStart` swallows a throwing sink itself.
				this.reportPassStart();
				try {
					const result = await this.run();
					this.onResult?.(result);
				} catch (err) {
					this.reportError(err);
				}
				await this.consultFollowThrough();
				// Owe another pass only when an explicit trigger landed, shutdown has
				// not begun, and this lifecycle has not already spent its one follow-up.
				const owed = this.pendingExplicit && !this.stoppingOrStopped();
				keepDraining = owed && !followupUsed;
				wakeDropped = owed && followupUsed;
				if (keepDraining) {
					followupUsed = true;
				}
			}
		} finally {
			this.inFlight = null;
			this.pendingExplicit = false;
		}
		if (wakeDropped && !this.stoppingOrStopped()) {
			// A new lifecycle via trigger(), after a short cooldown: never dropped.
			log("debug", "scheduler.wake_deferred", { delayMs: this.wakeCooldownMs });
			this.armDeferred(this.wakeCooldownMs);
		}
	}

	/**
	 * Stamp the pass-start liveness seam without ever letting it abort the
	 * pass it observes. Same untrusted-sink posture as `reportError`: a monitoring
	 * hook that throws must not stop the reconciliation loop, because a liveness
	 * recorder that can KILL the loop it reports on is worse than no recorder — it
	 * converts an observability fault into the outage it exists to detect.
	 */
	private reportPassStart(): void {
		try {
			this.onPassStart?.();
		} catch (sinkErr) {
			// The pass proceeds regardless; the cost is one un-stamped start, which
			// surfaces on its own as a stale /healthz if it keeps happening.
			log("debug", "scheduler.pass_start_sink_failed", { cause: errorMessage(sinkErr) });
		}
	}

	/**
	 * Invoke the caller's error sink without ever letting it abort the tick/drain
	 * loop. A monitoring/logging sink is untrusted here: if it throws, that throw
	 * must not escape the drain loop and take down the scheduler lifecycle. Swallow
	 * any exception it raises.
	 */
	private reportError(error: unknown): void {
		try {
			this.onError?.(error);
		} catch (sinkErr) {
			// A faulty sink must not abort the tick. Nothing safe to do with a
			// logging-sink failure except drop it — debug, because the pass failure the
			// sink was handed is the operator-visible one.
			log("debug", "scheduler.sink_failed", { cause: errorMessage(sinkErr) });
		}
	}

	/**
	 * Stop scheduling new passes and await both the (possibly still-blocked) start
	 * operation and the in-flight lifecycle so shutdown does not overlap or
	 * abandon work mid-flight. Marks the phase `stopping` **synchronously** before
	 * yielding, clears the interval immediately, and returns one shared promise.
	 * Idempotent: repeated `stop()` calls await the same promise. When it
	 * resolves, the phase is `idle`, so an immediate restart is deterministic.
	 */
	async stop(): Promise<void> {
		if (this.stopPromise) {
			return this.stopPromise;
		}
		// A never-started or fully quiescent scheduler is already stopped. Returning
		// here also avoids assigning a stale already-resolved stop promise when
		// runStop() would otherwise complete synchronously before assignment.
		if (
			this.phase === "idle" &&
			this.startPromise === null &&
			this.inFlight === null &&
			this.handle === null
		) {
			return;
		}
		// Mark stopping synchronously so any start/trigger racing this call sees a
		// pending shutdown before it can schedule anything.
		this.phase = "stopping";
		this.pendingExplicit = false;
		// Clear the interval synchronously; a startup still in flight will observe
		// `phase !== "starting"` and never install a fresh one.
		if (this.handle !== null) {
			this.clearIntervalImpl(this.handle);
			this.handle = null;
		}
		this.clearDeferred();
		const stopPromise = this.runStop();
		this.stopPromise = stopPromise;
		return stopPromise;
	}

	/** Await the start operation and in-flight lifecycle, then reset to idle. */
	private async runStop(): Promise<void> {
		// Await BOTH the complete start operation (even a blocked startup pass) and
		// any in-flight lifecycle. Awaiting startPromise alone would still leave the
		// startup pass draining; awaiting inFlight covers a lifecycle started by an
		// interval tick or trigger with no outstanding start.
		let failed = false;
		let failure: unknown;
		try {
			const start = this.startPromise;
			if (start) {
				try {
					await start;
				} catch (err) {
					failed = true;
					failure = err;
				}
			}
			const flight = this.inFlight;
			if (flight) {
				try {
					await flight.promise;
				} catch (err) {
					if (!failed) {
						failed = true;
						failure = err;
					}
				}
			}
		} finally {
			// Fully drained. Reset even after rejection so a failed lifecycle cannot
			// poison the next start. Clearing stopPromise last preserves shared stop().
			this.phase = "idle";
			this.startPromise = null;
			this.stopPromise = null;
		}
		if (failed) {
			throw failure;
		}
	}
}
