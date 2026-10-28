/**
 * @module reconcile/follow-through
 * @description ONE place decides whether the next reconcile pass runs on the
 *   short 20 s cadence instead of waiting for the `poll_interval_minutes` sweep
 *   (sf#1076 rows 0b/0c, and the found defect from the 2026-09-30 OOM session).
 *
 *   The scheduler consults this after every pass. Two independent things are in
 *   flight often enough to need it, and both share ONE delay deliberately —
 *   the short cadence is a property of the loop, not of either caller, and two
 *   different short delays would make the observed pass spacing unexplainable:
 *
 *     1. The build-bump rail: a build still running, a bump PR opened and
 *        unmerged, or a merged bump awaiting its Argo hard refresh
 *        (`build-bump-merge-watch`).
 *     2. A large OOM re-run whose `forgejo-mvp-large` slot the band scaler has
 *        not placed yet (`oom-retry`). The re-run is dispatched inside the band
 *        listing of the pass that reports the OOM, so that pass cannot see its
 *        own re-run's waiting job; without a follow-through the slot waits for
 *        the 15-minute sweep, measured at 11 to 21 minutes on 2026-09-30.
 *
 *     3. The Forge runner band is busy (SOF-10517): the last band pass saw a
 *        waiting job a band group can run, or a slot beyond the standing one
 *        running. The band serves EVERY repo but only a managed repo's webhook
 *        wakes a pass, so an unmanaged repo's self-hosted CI waited for the
 *        15-minute sweep (2026-10-07 15:02-16:00Z, ForgeCIQueueWait p90 97 s).
 *
 *   The first two are DB reads, so a watcher restart between the dispatch and
 *   the placement still follows through. The third is in-process
 *   (`./band-busy`); the startup pass sets it again within one pass.
 *
 * @outputs
 *   - `passFollowThroughDelay` -- the three predicates as one delay
 *   - `followThroughSink` -- that delay bound to a db and an environment, as the
 *     scheduler's `followThrough` hook
 *
 * @dependencies
 *   - ../db/client -- WatcherDb
 *   - ./argo-refresh -- createArgoRefresher, to answer "is Argo configured"
 *   - ./build-bump-merge-watch -- the rail's own predicate and the shared delay
 *   - ./oom-retry -- the large-re-run predicate
 *   - ./band-busy -- the band-busy predicate
 *   - ../log -- traced()
 */
import type { WatcherDb } from "../db/client";
import { traced } from "../log";
import { createArgoRefresher } from "./argo-refresh";
import { forgeBandBusy } from "./band-busy";
import { FOLLOW_THROUGH_DELAY_MS, followThroughDelay } from "./build-bump-merge-watch";
import { oomRetryInFlight } from "./oom-retry";

/**
 * `FOLLOW_THROUGH_DELAY_MS` while anything is in flight, else `null` (the
 * scheduler's "no follow-up, wait for the sweep").
 *
 * The rail is asked first only because it was here first; the three are a
 * plain OR and the answer cannot depend on the order.
 */
async function passFollowThroughDelayImpl(
	db: WatcherDb,
	now: Date,
	argoConfigured: boolean,
): Promise<number | null> {
	const rail = await followThroughDelay(db, now, argoConfigured);
	if (rail !== null) {
		return rail;
	}
	if (forgeBandBusy()) {
		return FOLLOW_THROUGH_DELAY_MS;
	}
	return (await oomRetryInFlight(db, now)) ? FOLLOW_THROUGH_DELAY_MS : null;
}

export const passFollowThroughDelay = traced(
	"reconcile.passFollowThroughDelay",
	passFollowThroughDelayImpl,
	{ redact: { args: [0] } },
);

/**
 * The scheduler's `followThrough` hook, bound to one db and one environment.
 *
 * `argoConfigured` is resolved ONCE here, at wiring time, rather than per pass:
 * it is a deployment fact, and the rail's Argo-pending window must not start
 * mattering halfway through a process's life. The environment is a parameter so
 * a test can wire a configured and an unconfigured sink without touching
 * `process.env`.
 */
function followThroughSinkImpl(
	db: WatcherDb,
	env: NodeJS.ProcessEnv,
): () => Promise<number | null> {
	const argoConfigured = createArgoRefresher(env) !== null;
	return () => passFollowThroughDelay(db, new Date(), argoConfigured);
}

/**
 * BOTH arguments are redacted: `env` is `process.env` at the only live
 * call site, so an untraced second argument would print every secret the
 * watcher holds onto the `.enter` line at debug level.
 */
export const followThroughSink = traced("reconcile.followThroughSink", followThroughSinkImpl, {
	redact: { args: [0, 1] },
});
