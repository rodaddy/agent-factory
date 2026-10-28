/**
 * @module bus/side-channels
 * @description The watcher's NATS side channels as one lifecycle: connecting the
 *   bus from the environment, starting and stopping the durable results
 *   consumer, and draining the bus at shutdown.
 *
 *   Extracted from `service.ts` when the startup-stage guard
 *   pushed that file past its size limit. The grouping is not arbitrary — these
 *   five functions share ONE property that `service.ts` depends on and that a
 *   reader has to be able to check in one place: NONE of them is fatal. A bus
 *   that will not connect, a consumer that will not attach, and a drain that
 *   throws on the way down are all DEGRADED, never a refused boot or an aborted
 *   shutdown, because the share read path and the webhook receiver keep working
 *   without any of them.
 *
 * @outputs
 *   - `createBusFromEnv` -- connect the bus, or explain why it stayed off
 *   - `redactBusUrl` -- the two url fields a log line may carry
 *   - `closeBus` -- drain the bus, swallowing a failed drain
 *   - `startResultsConsumerOrNone` / `stopResultsConsumer` -- the consumer's ends
 *   - `wakePassOnStoredResult` -- a fresh stored row asks for an early pass
 *   - `ResultsConsumerHandle` -- what a started consumer hands back
 *
 * @dependencies
 *   - ./nats -- the bus client
 *   - ./results-consumer -- the durable pull consumer
 *   - ../log -- structured logging and error classification
 */
import { readFileSync } from "node:fs";
import type { WatcherDb } from "../db/client";
import { errorClass, log, traced } from "../log";
import { createNatsBus, type NatsBus } from "./nats";
import { startResultsConsumer } from "./results-consumer";

/**
 * Connect the NATS bus, or explain why it stayed off.
 *
 * BOTH `NATS_URL` and `NATS_NKEY_FILE` are required, and either one alone is a
 * stated `bus.nats.disabled` rather than a silent no-op: a half-configured bus
 * that quietly publishes nothing is exactly the failure an operator cannot see.
 *
 * A connect failure is NOT fatal. The webhook receiver's job is to store the
 * delivery durably, and it must keep doing that when the cluster is unreachable
 * — so the failure is logged by CLASS and the service continues with no bus.
 *
 * The seed is read here, trimmed (an env file's trailing newline would otherwise
 * be part of the key), and never logged — not the bytes, not the file's
 * contents. Only the URL appears in a log line.
 *
 * @returns the bus, or undefined when it is disabled or could not connect
 */
export const createBusFromEnv = traced(
	"bus.createBusFromEnv",
	async function createBusFromEnv(): Promise<NatsBus | undefined> {
		const url = process.env.NATS_URL?.trim() || undefined;
		const seedFile = process.env.NATS_NKEY_FILE?.trim() || undefined;
		if (url === undefined || seedFile === undefined) {
			const missing =
				url === undefined && seedFile === undefined
					? "NATS_URL and NATS_NKEY_FILE unset"
					: url === undefined
						? "NATS_URL unset"
						: "NATS_NKEY_FILE unset";
			log("info", "bus.nats.disabled", { reason: missing });
			return undefined;
		}
		try {
			const seed = new TextEncoder().encode(readFileSync(seedFile, "utf8").trim());
			const bus = await createNatsBus({ url, nkeySeed: seed });
			log("info", "bus.nats.enabled", redactBusUrl(url));
			return bus;
		} catch (err) {
			log("error", "bus.nats.connect_failed", {
				error_class: errorClass(err),
				...redactBusUrl(url),
			});
			return undefined;
		}
	},
);

/**
 * Reduce `NATS_URL` to the two fields a log line actually needs.
 *
 * The nats client ACCEPTS a `nats://user:pass@host:4222` url, so logging the
 * env value verbatim put a password on stderr and into every shipper downstream
 * of it. Host and port answer "which cluster" — the only
 * question this line exists to answer — and the userinfo is dropped rather than
 * masked, because a masked credential still tells a reader one was configured
 * without telling them anything useful.
 *
 * An unparseable url yields a constant. Echoing a "url" that failed to parse
 * would put the raw string back in the log, which is exactly the leak.
 *
 * @param url - the configured server url, untrusted and possibly credentialed
 */
function redactBusUrlImpl(url: string): Record<string, string> {
	try {
		const parsed = new URL(url);
		return { host: parsed.hostname, port: parsed.port };
	} catch {
		return { url: "unparseable" };
	}
}

export const redactBusUrl = traced("bus.redactBusUrl", redactBusUrlImpl) as typeof redactBusUrlImpl;

/**
 * Drain the bus if one is connected, swallowing a failed drain.
 *
 * A shutdown must not be aborted by a side channel: the deliveries are already
 * durably stored, so the worst case of a failed drain is a lost republish, and
 * throwing here would skip the observability flush that follows it.
 *
 * @param bus - the connected bus, or undefined when it is disabled
 */
export const closeBus = traced(
	"bus.closeBus",
	async function closeBus(bus: NatsBus | undefined): Promise<void> {
		if (bus === undefined) return;
		try {
			await bus.close();
		} catch (err) {
			log("warn", "bus.nats.close_failed", { error_class: errorClass(err) });
		}
	},
);

/** The running consumer, or undefined when the bus is off or it failed to start. */
export type ResultsConsumerHandle = { stop(): Promise<void> } | undefined;

/**
 * Start the results consumer, or explain why the watcher runs without one.
 *
 * NOT fatal on failure, and that is the whole point of the separate function:
 * the share read path is untouched and the webhook publisher is untouched, so a
 * consumer that cannot attach costs freshness, never correctness. Refusing to
 * boot over it would turn a degraded side channel into an outage.
 *
 * @param bus - the connected bus, or undefined when it is disabled
 * @param db - the watcher database every accepted message is inserted into
 * @param wake - the scheduler's trigger surface: every batch that
 *   stored a fresh row rings it through {@link wakePassOnStoredResult}
 * @returns the handle to stop at shutdown, or undefined
 */
export const startResultsConsumerOrNone = traced(
	"bus.startResultsConsumerOrNone",
	async function startResultsConsumerOrNone(
		bus: NatsBus | undefined,
		db: WatcherDb,
		wake?: { trigger(): Promise<void> },
	): Promise<ResultsConsumerHandle> {
		if (bus === undefined) return undefined;
		const onStored = wake === undefined ? undefined : () => wakePassOnStoredResult(wake);
		try {
			const handle = await startResultsConsumer({ bus, db, onStored });
			log("info", "bus.results.consumer_started", {
				stream: "FACTORY_JOBS",
				durable: "watcher-ingest",
			});
			return handle;
		} catch (err) {
			log("error", "bus.results.consumer_failed", { error_class: errorClass(err) });
			return undefined;
		}
	},
);

/**
 * Ask the scheduler for an early pass because a fresh runner artifact is in
 * `bus_results`.
 *
 * The trigger is the scheduler's COALESCING one — the same seam the status
 * server's doorbell and the Forge webhook ring — so a burst of stored rows
 * during a running pass collapses into one follow-up and never a third pass.
 * Fire-and-forget on purpose: the consumer loop that rings this must not wait
 * on, or be broken by, a pass. A rejected trigger is logged by class, the same
 * posture as `status.doorbell.wake_failed`, and a scheduler that is not yet
 * started or already stopping simply returns without a pass, which is correct
 * on both edges (the initial pass will read the row; a stopping watcher owes
 * nothing).
 *
 * @param scheduler - the scheduler's trigger surface
 */
function wakePassOnStoredResultImpl(scheduler: { trigger(): Promise<void> }): void {
	try {
		scheduler.trigger().catch((err: unknown) => {
			log("warn", "bus.results.wake_failed", { error_class: errorClass(err) });
		});
	} catch (err) {
		log("warn", "bus.results.wake_failed", { error_class: errorClass(err), sync: true });
	}
}

export const wakePassOnStoredResult = traced(
	"bus.wakePassOnStoredResult",
	wakePassOnStoredResultImpl,
) as typeof wakePassOnStoredResultImpl;

/**
 * Stop the consumer loop, swallowing a failed stop.
 *
 * A shutdown must not be aborted by a side channel: an unacked message is simply
 * redelivered on the next boot, and throwing here would skip the bus close and
 * the observability flush that follow.
 *
 * @param handle - the running consumer, or undefined
 */
export const stopResultsConsumer = traced(
	"bus.stopResultsConsumer",
	async function stopResultsConsumer(handle: ResultsConsumerHandle): Promise<void> {
		if (handle === undefined) return;
		try {
			await handle.stop();
		} catch (err) {
			log("warn", "bus.results.consumer_stop_failed", { error_class: errorClass(err) });
		}
	},
);
