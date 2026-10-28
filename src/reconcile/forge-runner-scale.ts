/**
 * @module reconcile/forge-runner-scale
 * @description The ONE controller for the Forge runner band (band 9101-9150).
 *   Slots are EPHEMERAL: the gateway CLONES a
 *   slot up (`runner_forge_up`) and DESTROYS it down (`runner_forge_down`) after
 *   its job, and ONE warm standby is kept ready in the gate lane. This module is
 *   the policy only; the transport owns the verbs.
 *
 *   ABSENT MEANS DISABLED. With no `forge_runner_fleet` block the pass returns
 *   `disabled` and calls NO dependency — not the Forge reads, not the gateway.
 *
 *   IT RUNS ON EVERY RECONCILE CYCLE, AND A MANAGED-REPO WEBHOOK WAKES THAT
 *   CYCLE EARLY (`hooks/forgejo.ts`), so a new job is seen without waiting a
 *   poll interval. An UNMANAGED repo's CI wakes nothing, so each pass also
 *   reports through `deps.onBusy` whether the band is busy -- a waiting job some
 *   group covers, or more non-standing slots running than `floor` -- and
 *   `reconcile/follow-through` keeps the 20 s cadence while it is (SOF-10517).
 *
 *   DEMAND IS LABEL-AWARE. A job is satisfied only by ONE runner holding EVERY
 *   label in its `runs_on`, so members are grouped by identical sorted label set
 *   and a waiting job counts only for a group whose labels are a superset of its
 *   `runs_on`. Runner labels arrive NORMALIZED to bare names (the resolve module
 *   drops the `:docker://...` schema suffix), because jobs ask for bare names.
 *
 *   STANDBY. The group whose labels include `standby_label` keeps `floor` free
 *   members; every other group has floor 0. `free` = running and Forge-`idle`,
 *   plus running and `offline` for less than the dead grace (still booting).
 *   The dead grace is `dead_minutes`, or `idle_minutes` when it is absent.
 *
 *   STANDING. `fleet.standing` names ONE slot that is
 *   never taken down -- not when idle, not when dead (a dead standing slot is a
 *   warn every pass) -- and is brought up first, whenever it is absent, ahead
 *   of every group. It replaces the idle standby, so `floor` must be 0 with it.
 *
 *   DEMAND IS COUNTED ONCE PER PASS. Before any group acts, each waiting job is
 *   assigned to the FIRST eligible group with free room left (consuming it);
 *   a job no free member can take is UNMET and charged to the eligible group
 *   with a startable non-standing member and the fewest labels (else the first
 *   eligible group). A member carrying two label sets therefore serves a job
 *   once, not once per group it covers.
 *
 *   PER GROUP, PER PASS:
 *     - DEAD: a running member `offline` for >= the dead grace is taken down and
 *       is not free (counts against the down budget); never the standing slot.
 *     - UP the lowest startable (`absent` or `stopped`) non-standing member when
 *       `free < floor` or `unmet > 0`; at most one per group.
 *     - Otherwise DOWN, when nothing waits and `free > floor`, the highest member
 *       Forge-`idle` for >= `idle_minutes`. Its status is RE-READ first and it is
 *       kept unless still `idle`; a gateway `refused: busy` is a warn and a keep.
 *   An `unknown` slot is never acted on. Total ups are bounded by `cap - running`
 *   and MAX_ACTIONS_PER_PASS; total downs by MAX_ACTIONS_PER_PASS.
 *
 *   SLOTS IS THE CUTOVER FILTER. When `fleet.slots` is set, only those vmids are
 *   counted or acted on; the persistent 9101-9105 stay untouched until
 *   rtech-infra destroys them.
 *
 *   IDLE-SINCE AND OFFLINE-SINCE ARE IN-PROCESS STATE (`deps.idleSince`,
 *   `deps.offlineSince`, owned by the resolve module): set when a member is first
 *   seen running+idle / running+offline, cleared whenever it is not. A restart
 *   empties them, which only delays a down.
 *
 *   A FORGE READ FAILURE IS A NO-OP, NEVER A SCALE-DOWN. If either read fails,
 *   the pass makes zero actions, emits one bounded warn, and reports `skipped`
 *   so the drought tracker counts it.
 *
 *   MEMBERSHIP COMES FROM THE INVENTORY, NOT THE GATEWAY. A vmid outside the
 *   `forge` band rows in `bands.ts` is ignored with one warn. A band vmid
 *   with no registered `forge-runner-<vmid>` runner is ignored the same way.
 *
 *   NOTHING HERE THROWS INTO THE CYCLE on a member failure. A failed up or down
 *   is warned and counted (`attempted` vs `applied`).
 *
 * @outputs
 *   - `WaitingJob`, `ForgeRunner`, `ForgeSnapshot`, `ListedVmid` -- the seam shapes
 *   - `ForgeRunnerScaleDeps` -- the injected seams, clock, and in-process state
 *   - `runForgeRunnerScale` -- one scaling pass
 *
 * @dependencies
 *   - ../config/schema -- owns the optional `forge_runner_fleet` block
 *   - ../runner/bands -- the stated inventory that defines band membership
 *   - ../runner/transport -- `RunnerBandRefusedError` (a busy refusal)
 *   - ../log -- the shared structured logger and traced() wrapper
 */
import type { ForgeRunnerFleetConfig, WatcherConfig } from "../config/schema";
import { errorMessage, log, traced } from "../log";
import { RUNNER_BOXES } from "../runner/bands";
import { RunnerBandRefusedError } from "../runner/transport";

/** One Forge Actions job in `waiting` state: the labels it needs. */
export interface WaitingJob {
	readonly runs_on: readonly string[];
}

/** One registered Forge runner: `status` is `active` (busy), `idle`, or `offline`. */
export interface ForgeRunner {
	readonly name: string;
	readonly status: string;
	readonly labels: readonly string[];
}

/** Both Forge admin reads for one pass. */
export interface ForgeSnapshot {
	readonly waiting: readonly WaitingJob[];
	readonly runners: readonly ForgeRunner[];
}

/** One band slot as the gateway lists it: `absent | running | stopped | unknown`. */
export interface ListedVmid {
	vmid: number;
	status: string;
	/** Forgejo task ids a kernel OOM kill hit in this slot. */
	oomTasks?: number[];
}

/** The seams one pass drives; all injected so the pass is hermetic in tests. */
export interface ForgeRunnerScaleDeps {
	/** Waiting jobs and registered runners. A throw makes the pass `skipped`. */
	readForge: () => Promise<ForgeSnapshot>;
	/** The forge band's slots and their state, from the gateway. A throw makes the pass `skipped`. */
	listBand: () => Promise<ListedVmid[]>;
	/** Fresh Forge status of `forge-runner-<vmid>`, or null when not registered. */
	readRunnerStatus: (vmid: number) => Promise<string | null>;
	/** Bring a slot up (clone+start). May throw; the pass warns and continues. */
	startMember: (vmid: number) => Promise<void>;
	/** Take a slot down (destroy). A busy refusal throws `RunnerBandRefusedError`. */
	stopMember: (vmid: number) => Promise<void>;
	/** Bounded warning sink, for tests and for the caller's own log routing. */
	onWarn?: (message: string) => void;
	/** Once per pass that read the band: busy or not (SOF-10517). A skipped pass reports false. */
	onBusy?: (busy: boolean) => void;
	/** vmid -> epoch ms it was first seen running and idle. Mutated by the pass. */
	idleSince: Map<number, number>;
	/** vmid -> epoch ms it was first seen running and offline. Mutated by the pass. */
	offlineSince: Map<number, number>;
	/** Epoch ms clock. */
	now: () => number;
}

/** The fixed reason reported when the config block is absent. */
export const DISABLED_REASON = "forge_runner_fleet not configured";

/** Per-pass ceiling on operations in EACH direction. See the module note. */
const MAX_ACTIONS_PER_PASS = 3;

/** The vmids the inventory declares as the forge band. */
const FORGE_BAND_VMIDS: ReadonlySet<number> = new Set(
	RUNNER_BOXES.filter((box) => box.band === "forge").map((box) => box.vmid),
);

/** One band member: a listed band slot joined to its registered runner. */
interface Member {
	readonly vmid: number;
	readonly running: boolean;
	readonly startable: boolean;
	readonly forge: string;
	readonly labels: readonly string[];
}

/** Members sharing one sorted label set. */
interface Group {
	readonly key: string;
	readonly labels: ReadonlySet<string>;
	readonly members: readonly Member[];
}

/**
 * What one scaling pass actually did, so the caller can tell a pass that RAN
 * from one that silently did nothing. `skipped` means no reading, so no
 * decision; `ran` with `attempted > 0 && applied === 0` is the dead-gateway
 * shape; `ran` with `attempted === 0` is a healthy steady state. `disabled` is
 * an opt-out, never a failure.
 */
export type ForgeRunnerScaleOutcome =
	| { status: "ran"; attempted: number; applied: number }
	| { status: "disabled" }
	| { status: "skipped"; reason: string };

/** Emit one bounded warning to both the shared log and the injected sink. */
function warn(deps: ForgeRunnerScaleDeps, event: string, message: string): void {
	log("warn", event, { message });
	deps.onWarn?.(message);
}

/** Read both Forge admin endpoints, or `null` (with one warn) when either failed. */
async function readForge(deps: ForgeRunnerScaleDeps): Promise<ForgeSnapshot | null> {
	try {
		return await deps.readForge();
	} catch (e) {
		warn(
			deps,
			"forge_runner_scale.forge_read_failed",
			`forge runner scale skipped: forge admin read failed: ${errorMessage(e)}`,
		);
		return null;
	}
}

/** List the band through the gateway, or `null` (with one warn) when it threw. */
async function listBand(deps: ForgeRunnerScaleDeps): Promise<ListedVmid[] | null> {
	try {
		return await deps.listBand();
	} catch (e) {
		warn(
			deps,
			"forge_runner_scale.band_list_failed",
			`forge runner scale skipped: band list failed: ${errorMessage(e)}`,
		);
		return null;
	}
}

/**
 * Join the gateway's band listing to the registered runners. Strays outside the
 * inventory band and band vmids with no runner are dropped with one warn each;
 * vmids outside `fleet.slots` (when set) are dropped silently.
 */
function joinMembers(
	listed: readonly ListedVmid[],
	runners: readonly ForgeRunner[],
	fleet: ForgeRunnerFleetConfig,
	deps: ForgeRunnerScaleDeps,
): Member[] {
	const byName = new Map(runners.map((r) => [r.name, r]));
	const strays = listed.filter((b) => !FORGE_BAND_VMIDS.has(b.vmid));
	if (strays.length > 0) {
		warn(
			deps,
			"forge_runner_scale.unknown_members",
			`${strays.length} reported vmid(s) outside the forge band were ignored`,
		);
	}
	const managed = fleet.slots ? new Set(fleet.slots) : FORGE_BAND_VMIDS;
	const members: Member[] = [];
	const unregistered: number[] = [];
	for (const box of listed.filter((b) => FORGE_BAND_VMIDS.has(b.vmid) && managed.has(b.vmid))) {
		const runner = byName.get(`forge-runner-${box.vmid}`);
		if (!runner) {
			unregistered.push(box.vmid);
			continue;
		}
		members.push({
			vmid: box.vmid,
			running: box.status === "running",
			startable: box.status === "absent" || box.status === "stopped",
			forge: runner.status,
			labels: [...runner.labels].sort(),
		});
	}
	if (unregistered.length > 0) {
		warn(
			deps,
			"forge_runner_scale.unregistered_members",
			`band vmid(s) with no registered runner ignored: ${unregistered.sort((a, b) => a - b).join(",")}`,
		);
	}
	return members.sort((a, b) => a.vmid - b.vmid);
}

/**
 * SOF-10517: the band is busy while a waiting job is one some group can run, or
 * while more non-standing slots run than the floor holds. A job no group covers
 * is not band demand: counting it would hold the short cadence on work the
 * scaler can never place.
 */
function bandBusy(
	groups: readonly Group[],
	waiting: readonly WaitingJob[],
	members: readonly Member[],
	fleet: ForgeRunnerFleetConfig,
): boolean {
	if (waiting.some((job) => groups.some((g) => covers(g, job)))) {
		return true;
	}
	return members.filter((m) => m.running && m.vmid !== fleet.standing).length > fleet.floor;
}

/** Group members by identical sorted label set, in a stable key order. */
function groupMembers(members: readonly Member[]): Group[] {
	const groups = new Map<string, Member[]>();
	for (const m of members) {
		const key = m.labels.join(",");
		groups.set(key, [...(groups.get(key) ?? []), m]);
	}
	return [...groups.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([key, ms]) => ({ key, labels: new Set(ms[0]?.labels ?? []), members: ms }));
}

/** Set `since[vmid]` on first sight of `hit`, clear it whenever `hit` is false. */
function trackSince(since: Map<number, number>, vmid: number, hit: boolean, now: number): void {
	if (!hit) {
		since.delete(vmid);
	} else if (!since.has(vmid)) {
		since.set(vmid, now);
	}
}

/** Update idle-since and offline-since for every member. */
function trackState(members: readonly Member[], deps: ForgeRunnerScaleDeps): void {
	const now = deps.now();
	for (const m of members) {
		trackSince(deps.idleSince, m.vmid, m.running && m.forge === "idle", now);
		trackSince(deps.offlineSince, m.vmid, m.running && m.forge === "offline", now);
	}
}

/** True when a running member has been offline for at least the dead grace. */
function isDead(m: Member, fleet: ForgeRunnerFleetConfig, deps: ForgeRunnerScaleDeps): boolean {
	if (!m.running || m.forge !== "offline") {
		return false;
	}
	const now = deps.now();
	const grace = fleet.dead_minutes ?? fleet.idle_minutes;
	return now - (deps.offlineSince.get(m.vmid) ?? now) >= grace * 60_000;
}

/** Run one up or down, warn on failure, and report whether it landed. */
async function act(
	deps: ForgeRunnerScaleDeps,
	action: "up" | "down",
	vmid: number,
	fields: { reason: string; dead?: true },
): Promise<boolean> {
	try {
		await (action === "up" ? deps.startMember(vmid) : deps.stopMember(vmid));
		log("info", `forge_runner_scale.${action}`, { vmid, ...fields });
		if (action === "down") {
			deps.idleSince.delete(vmid);
			deps.offlineSince.delete(vmid);
		}
		return true;
	} catch (e) {
		const busy = action === "down" && e instanceof RunnerBandRefusedError;
		warn(
			deps,
			`forge_runner_scale.${action}_failed`,
			`forge runner ${action} ${busy ? "refused (kept)" : "failed"} for vmid ${vmid}: ${errorMessage(e)}`,
		);
		return false;
	}
}

/**
 * Pick and re-verify the one member of a group to take down, or null. Highest
 * vmid first among members idle for at least `idle_minutes`; each candidate's
 * Forge status is re-read and it is kept unless the fresh answer is still `idle`.
 */
async function stopCandidate(
	group: Group,
	fleet: ForgeRunnerFleetConfig,
	deps: ForgeRunnerScaleDeps,
): Promise<number | null> {
	const now = deps.now();
	const idle = group.members
		.filter((m) => m.running && m.forge === "idle" && m.vmid !== fleet.standing)
		.sort((a, b) => b.vmid - a.vmid);
	for (const m of idle) {
		const since = deps.idleSince.get(m.vmid) ?? now;
		if (now - since < fleet.idle_minutes * 60_000) {
			continue;
		}
		let fresh: string | null;
		try {
			fresh = await deps.readRunnerStatus(m.vmid);
		} catch (e) {
			warn(deps, "forge_runner_scale.reread_failed", `keep ${m.vmid}: ${errorMessage(e)}`);
			continue;
		}
		if (fresh === "idle") {
			return m.vmid;
		}
		log("info", "forge_runner_scale.keep", { vmid: m.vmid, forge: fresh });
	}
	return null;
}

/** Mutable per-pass budget and tally shared across groups. */
interface Tally {
	/** Starts left under MAX_ACTIONS_PER_PASS. */
	startsLeft: number;
	/** Room under `cap`; a successful dead take-down frees one. */
	capRoom: number;
	stopsLeft: number;
	attempted: number;
	applied: number;
}

/** Per-pass context handed to every group. */
interface PassCtx {
	readonly fleet: ForgeRunnerFleetConfig;
	readonly deps: ForgeRunnerScaleDeps;
	readonly tally: Tally;
}

/** Take down every dead member of a group, within the down budget. */
async function reapDead(dead: readonly Member[], reason: string, ctx: PassCtx): Promise<void> {
	const { deps, tally } = ctx;
	for (const m of dead) {
		if (tally.stopsLeft <= 0) {
			return;
		}
		tally.stopsLeft -= 1;
		tally.attempted += 1;
		if (await act(deps, "down", m.vmid, { reason, dead: true })) {
			tally.applied += 1;
			tally.capRoom += 1;
		}
	}
}

/** A group's free members: idle, or offline and not yet dead (still booting). */
function freeCount(
	group: Group,
	fleet: ForgeRunnerFleetConfig,
	deps: ForgeRunnerScaleDeps,
): number {
	return group.members.filter(
		(m) => m.running && (m.forge === "idle" || (m.forge === "offline" && !isDead(m, fleet, deps))),
	).length;
}

/** True when the group can satisfy a job's every `runs_on` label. */
function covers(group: Group, job: WaitingJob): boolean {
	return job.runs_on.every((l) => group.labels.has(l));
}

/**
 * Assign every waiting job ONCE across groups: to the first eligible group with
 * free room left, else as UNMET to the eligible group with a startable
 * non-standing member and the fewest labels (else the first eligible group).
 * Returns the unmet count per group key.
 */
function assignUnmet(
	groups: readonly Group[],
	waiting: readonly WaitingJob[],
	fleet: ForgeRunnerFleetConfig,
	deps: ForgeRunnerScaleDeps,
): Map<string, number> {
	const room = new Map(groups.map((g) => [g.key, freeCount(g, fleet, deps)]));
	const unmet = new Map<string, number>();
	for (const job of waiting) {
		const eligible = groups.filter((g) => covers(g, job));
		if (eligible.length === 0) {
			continue;
		}
		const taker = eligible.find((g) => (room.get(g.key) ?? 0) > 0);
		if (taker) {
			room.set(taker.key, (room.get(taker.key) ?? 0) - 1);
			continue;
		}
		const growable = eligible
			.filter((g) => g.members.some((m) => m.startable && m.vmid !== fleet.standing))
			.reduce<Group | undefined>(
				(best, g) => (best === undefined || g.labels.size < best.labels.size ? g : best),
				undefined,
			);
		const target = growable ?? eligible[0];
		if (target) {
			unmet.set(target.key, (unmet.get(target.key) ?? 0) + 1);
		}
	}
	return unmet;
}

/**
 * Handle the standing slot before any group: warn when it is not a managed
 * member, warn (and never act) when it is dead, and bring it up when startable.
 */
async function keepStanding(members: readonly Member[], ctx: PassCtx): Promise<void> {
	const { fleet, deps, tally } = ctx;
	const S = fleet.standing;
	if (S === undefined) {
		return;
	}
	const m = members.find((x) => x.vmid === S);
	if (!m) {
		warn(
			deps,
			"forge_runner_scale.standing_missing",
			`standing vmid ${S} is not a managed, registered band member`,
		);
		return;
	}
	if (isDead(m, fleet, deps)) {
		warn(
			deps,
			"forge_runner_scale.standing_dead",
			`standing vmid ${S} offline for >= the dead grace; never taken down`,
		);
		return;
	}
	if (!m.startable || tally.startsLeft <= 0 || tally.capRoom <= 0) {
		return;
	}
	tally.startsLeft -= 1;
	tally.capRoom -= 1;
	tally.attempted += 1;
	tally.applied += (await act(deps, "up", S, { reason: "standing" })) ? 1 : 0;
}

/** Decide and apply the dead take-downs and at most one up or down for one group. */
async function scaleGroup(
	group: Group,
	waitingJobs: readonly WaitingJob[],
	unmet: number,
	ctx: PassCtx,
): Promise<void> {
	const { fleet, deps, tally } = ctx;
	const floor = group.labels.has(fleet.standby_label) ? fleet.floor : 0;
	const waiting = waitingJobs.filter((j) => covers(group, j)).length;
	const running = group.members.filter((m) => m.running);
	const dead = running.filter((m) => isDead(m, fleet, deps));
	const free = freeCount(group, fleet, deps);
	const reason = `group=[${group.key}] running=${running.length} free=${free} floor=${floor} waiting=${waiting} unmet=${unmet}`;
	log("info", "forge_runner_scale.group", {
		group: group.key,
		running: running.length,
		free,
		floor,
		waiting,
		unmet,
	});

	await reapDead(
		dead.filter((m) => m.vmid !== fleet.standing),
		reason,
		ctx,
	);
	if (free < floor || unmet > 0) {
		const cand = group.members.find((m) => m.startable && m.vmid !== fleet.standing);
		if (!cand) {
			log("info", "forge_runner_scale.no_startable_member", { group: group.key });
		} else if (tally.startsLeft > 0 && tally.capRoom > 0) {
			tally.startsLeft -= 1;
			tally.capRoom -= 1;
			tally.attempted += 1;
			tally.applied += (await act(deps, "up", cand.vmid, { reason })) ? 1 : 0;
		}
		return;
	}
	if (waiting > 0 || free <= floor || tally.stopsLeft <= 0) {
		return;
	}
	const vmid = await stopCandidate(group, fleet, deps);
	if (vmid !== null) {
		tally.stopsLeft -= 1;
		tally.attempted += 1;
		tally.applied += (await act(deps, "down", vmid, { reason })) ? 1 : 0;
	}
}

/**
 * Run one scaling pass over the Forge runner band.
 *
 * @param config - loaded watcher configuration; owns the `forge_runner_fleet` block
 * @param deps - the injected Forge reads, gateway listing, up/down seams, and clock
 */
export const runForgeRunnerScale = traced(
	"reconcile.runForgeRunnerScale",
	async function runForgeRunnerScale(
		config: WatcherConfig,
		deps: ForgeRunnerScaleDeps,
	): Promise<ForgeRunnerScaleOutcome> {
		const fleet = config.forge_runner_fleet;
		if (!fleet) {
			log("debug", "forge_runner_scale.disabled", { reason: DISABLED_REASON });
			return { status: "disabled" };
		}
		const snapshot = await readForge(deps);
		const listed = snapshot === null ? null : await listBand(deps);
		if (snapshot === null || listed === null) {
			// Unknown is not zero: no reading, so no action in either direction, and
			// no short cadence either (an outage falls back to the sweep).
			deps.onBusy?.(false);
			const reason = snapshot === null ? "forge admin read failed" : "band list failed";
			return { status: "skipped", reason };
		}
		const members = joinMembers(listed, snapshot.runners, fleet, deps);
		trackState(members, deps);
		const runningTotal = members.filter((m) => m.running).length;
		const tally: Tally = {
			startsLeft: MAX_ACTIONS_PER_PASS,
			capRoom: Math.max(0, fleet.cap - runningTotal),
			stopsLeft: MAX_ACTIONS_PER_PASS,
			attempted: 0,
			applied: 0,
		};
		log("info", "forge_runner_scale.pass", {
			waiting: snapshot.waiting.length,
			members: members.length,
			running: runningTotal,
			floor: fleet.floor,
			standby_label: fleet.standby_label,
			cap: fleet.cap,
			idle_minutes: fleet.idle_minutes,
			dead_minutes: fleet.dead_minutes ?? fleet.idle_minutes,
		});
		const ctx: PassCtx = { fleet, deps, tally };
		await keepStanding(members, ctx);
		const groups = groupMembers(members);
		const unmet = assignUnmet(groups, snapshot.waiting, fleet, deps);
		deps.onBusy?.(bandBusy(groups, snapshot.waiting, members, fleet));
		for (const group of groups) {
			await scaleGroup(group, snapshot.waiting, unmet.get(group.key) ?? 0, ctx);
		}
		return { status: "ran", attempted: tally.attempted, applied: tally.applied };
	},
);
