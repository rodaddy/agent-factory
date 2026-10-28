/**
 * @module reconcile/band-busy
 * @description SOF-10517: whether the LAST Forge runner band pass saw the band
 *   busy -- a waiting job some band group can run, or a running slot beyond the
 *   ones the band always holds (the standing slot and the idle-standby floor).
 *
 *   WHY IT EXISTS. The band scaler only runs inside a reconcile pass, and a pass
 *   runs early only for a MANAGED-repo webhook or a follow-through. The band
 *   serves every repo, so self-hosted CI from an unmanaged repo waited for the
 *   15-minute sweep before the scaler even saw it (2026-10-07 15:02-16:00Z:
 *   ~340 unmanaged deliveries, all `woken=false`, ForgeCIQueueWait p90 97 s).
 *   `reconcile/follow-through` reads this flag and keeps the 20 s cadence while
 *   the band is busy, so a burst is scaled up within a pass and the extra slots
 *   are taken down `idle_minutes` after it ends, not 15 minutes later.
 *
 *   IN-PROCESS, like the scaler's own idle-since maps: a restart starts at
 *   `false`, and the startup pass sets it again within one pass. A pass that
 *   could not read the queue or the band reports `false`, so a Forge or gateway
 *   outage falls back to the sweep instead of retrying every 20 s.
 *
 * @outputs
 *   - `noteForgeBandBusy` -- the scaler's per-pass report
 *   - `forgeBandBusy` -- the follow-through's read
 *
 * @dependencies
 *   - ../log -- traced()
 */
import { traced } from "../log";

let busy = false;

/** Record what the band pass just saw. Called once per pass that ran or was skipped. */
export const noteForgeBandBusy = traced("reconcile.noteForgeBandBusy", (value: boolean): void => {
	busy = value;
});

/** True when the last band pass saw demand it can serve or an extra slot up. */
export const forgeBandBusy = traced("reconcile.forgeBandBusy", (): boolean => busy);
