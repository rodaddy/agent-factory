// The idle-seat waker. Seats run with timer heartbeats off and wake
// only on an event, so a task assigned while the seat sat at its run cap
// starts nothing and nobody re-wakes the seat when a slot frees. A seat's run
// ending wakes that seat at once (wakeOnRunEnd); the cron sweep
// (wakeIdleSeats) is the backstop for a lost event.

/** A seat woken this recently is left alone by the sweep, so a seat that declines is not hammered. */
export const WAKE_COOLDOWN_MS = 2 * 60 * 1000;
const LIVE_RUN = new Set(["queued", "running"]);
/** Seat statuses the sweep wakes. */
const SWEEP_STATUSES = new Set(["idle"]);
// The host emits the run event before it sets the seat idle (finalizeAgentStatus).
const RUN_END_STATUSES = new Set(["idle", "running"]);

const wakeKey = (agentId) => `idle-wake:${agentId}`;
const at = (issue) => {
	const t = Date.parse(issue?.createdAt ?? "");
	return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
};

// Work the seat should be doing: todo, or in_progress with no live run.
// blocked and backlog are not work to wake for.
function pending(issues) {
	return issues.filter(
		(i) =>
			i?.status === "todo" ||
			(i?.status === "in_progress" && !(i.activeRun && LIVE_RUN.has(i.activeRun.status))),
	);
}

// The one-seat check both paths share: a seat whose status is in `statuses`
// and holds pending work yields its oldest task; anything else yields null.
async function oldestWork(agent, deps, statuses) {
	if (!statuses.has(agent?.status) || typeof agent.id !== "string") return null;
	const lists = await Promise.all(["todo", "in_progress"].map((s) => deps.listIssues(agent.id, s)));
	const work = pending(lists.flatMap((l) => (Array.isArray(l) ? l : [])));
	if (work.length === 0) return null;
	const oldest = work.reduce((a, b) => (at(b) < at(a) ? b : a));
	return { oldest, count: work.length, task: oldest.identifier ?? oldest.id };
}

// Invokes the seat naming its oldest task; true when the invoke went through.
async function invokeSeat(agent, found, deps, reason) {
	try {
		await deps.invoke(agent.id, {
			prompt:
				`You are idle and hold assigned work. Start with ${found.task}: ${found.oldest.title ?? ""}`.trim(),
			reason,
			// The run must be bound to the task (SOF-11432): a run with no source
			// issue has every cross-issue write refused by the board.
			issueId: found.oldest.id,
		});
	} catch (err) {
		deps.log(`idle-wake: ${agent.name ?? agent.id} ${found.task} failed: ${err?.name || "Error"}`);
		return false;
	}
	await deps.stateSet(wakeKey(agent.id), { at: deps.now(), task: found.task });
	deps.log(`idle-wake: ${agent.name ?? agent.id} ${found.task} ${reason}`);
	return true;
}

/**
 * deps: listAgents(), listIssues(agentId, status), invoke(agentId, { prompt, reason, issueId }),
 * stateGet(key), stateSet(key, value), now(), log(line).
 * Returns the number of seats woken.
 */
export async function wakeIdleSeats(deps) {
	const agents = await deps.listAgents();
	let woken = 0;
	for (const agent of Array.isArray(agents) ? agents : []) {
		if (!SWEEP_STATUSES.has(agent?.status) || typeof agent.id !== "string") continue;
		const last = await deps.stateGet(wakeKey(agent.id));
		if (typeof last?.at === "number" && deps.now() - last.at < WAKE_COOLDOWN_MS) continue;
		const found = await oldestWork(agent, deps, SWEEP_STATUSES);
		if (!found) continue;
		if (await invokeSeat(agent, found, deps, `idle with ${found.count} assigned task(s) (sf#1799)`))
			woken += 1;
	}
	return woken;
}

// Seats with a run-end wake in flight in this worker: an overlapping event for
// the same seat wakes nothing, since the memo is written only after the invoke.
const inflight = new Set();

/**
 * A run ended (agent.run.finished/failed/cancelled): wake that one seat at once
 * if it is idle or still reads running from the run that just ended, and holds
 * pending work. A run that ends on the task its seat
 * was last woken for (by either path) means the seat declined or waits: this
 * path never re-wakes it, and the sweep re-wakes it after WAKE_COOLDOWN_MS. A
 * different task wakes at once. A redelivered event finds the same task, so it
 * wakes nothing.
 * deps: getAgent(agentId) plus the wakeIdleSeats deps except listAgents.
 * Returns true when the seat was woken. Never throws.
 */
export async function wakeOnRunEnd(event, deps) {
	const agentId = event?.agentId;
	const runId = event?.runId;
	if (typeof agentId !== "string" || inflight.has(agentId)) return false;
	inflight.add(agentId);
	try {
		const agent = await deps.getAgent(agentId);
		const found = await oldestWork(agent, deps, RUN_END_STATUSES);
		if (!found) return false;
		const last = await deps.stateGet(wakeKey(agentId));
		if (last?.task === found.task) return false;
		const reason = `run ${runId ?? "?"} ended, idle with ${found.count} assigned task(s)`;
		return await invokeSeat(agent, found, deps, reason);
	} catch (err) {
		deps.log(`run-wake: ${agentId} failed: ${err?.name || "Error"}`);
		return false;
	} finally {
		inflight.delete(agentId);
	}
}
