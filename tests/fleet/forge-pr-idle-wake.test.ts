import { describe, expect, test } from "bun:test";
import {
	type IdleWakeAgent,
	type IdleWakeIssue,
	WAKE_COOLDOWN_MS,
	wakeIdleSeats,
	wakeOnRunEnd,
} from "../../fleet/plugins/forge-pr/idle-wake.js";

const NOW = Date.parse("2026-10-07T18:30:00Z");

function harness(
	agents: IdleWakeAgent[],
	issues: Record<string, IdleWakeIssue[]>,
	state: Record<string, unknown> = {},
) {
	const invoked: Array<{ agentId: string; prompt: string; reason: string; issueId?: string }> = [];
	const lines: string[] = [];
	const deps = {
		listAgents: async () => agents,
		listIssues: async (agentId: string, status: string) =>
			(issues[agentId] ?? []).filter((i) => i.status === status),
		invoke: async (agentId: string, opts: { prompt: string; reason: string; issueId?: string }) => {
			invoked.push({ agentId, ...opts });
			return { runId: "r1" };
		},
		stateGet: async (k: string) => state[k],
		stateSet: async (k: string, v: unknown) => {
			state[k] = v;
		},
		now: () => NOW,
		log: (l: string) => lines.push(l),
	};
	return { deps, invoked, lines, state };
}

const todo = (id: string, createdAt: string, status = "todo"): IdleWakeIssue => ({
	id,
	identifier: id,
	title: `task ${id}`,
	status,
	createdAt,
});

describe("wakeIdleSeats", () => {
	test("an idle seat with todo work is invoked once, naming its oldest task", async () => {
		const h = harness([{ id: "a1", name: "Adams", status: "idle" }], {
			a1: [todo("SOF-9", "2026-10-07T12:00:00Z"), todo("SOF-3", "2026-10-07T09:00:00Z")],
		});
		expect(await wakeIdleSeats(h.deps)).toBe(1);
		expect(h.invoked).toHaveLength(1);
		expect(h.invoked[0]?.agentId).toBe("a1");
		expect(h.invoked[0]?.prompt).toContain("SOF-3");
		expect(h.lines).toEqual([expect.stringContaining("Adams SOF-3")]);
		expect(h.state["idle-wake:a1"]).toEqual({ at: NOW, task: "SOF-3" });
	});

	// SOF-11432: a run woken without an issue has no source issue, so the board
	// refuses every cross-issue write it makes (cross_issue_influence_run_context_required).
	test("the wake names the oldest task's issue id so the run is issue-scoped", async () => {
		const h = harness([{ id: "a1", status: "idle" }], {
			a1: [
				{ ...todo("SOF-9", "2026-10-07T12:00:00Z"), id: "uuid-9" },
				{ ...todo("SOF-3", "2026-10-07T09:00:00Z"), id: "uuid-3" },
			],
		});
		expect(await wakeIdleSeats(h.deps)).toBe(1);
		expect(h.invoked[0]?.issueId).toBe("uuid-3");
	});

	test("a running seat with pending work is not invoked by the sweep", async () => {
		const h = harness([{ id: "a1", status: "running" }], {
			a1: [todo("SOF-1", "2026-10-07T09:00:00Z")],
		});
		expect(await wakeIdleSeats(h.deps)).toBe(0);
		expect(h.invoked).toHaveLength(0);
	});

	test("a paused seat is not invoked", async () => {
		const h = harness([{ id: "a1", status: "paused" }], {
			a1: [todo("SOF-1", "2026-10-07T09:00:00Z")],
		});
		expect(await wakeIdleSeats(h.deps)).toBe(0);
		expect(h.invoked).toHaveLength(0);
	});

	test("a seat woken 1 minute ago is not invoked by the sweep", async () => {
		const h = harness(
			[{ id: "a1", status: "idle" }],
			{ a1: [todo("SOF-1", "2026-10-07T09:00:00Z")] },
			{ "idle-wake:a1": { at: NOW - 60 * 1000, task: "SOF-1" } },
		);
		expect(await wakeIdleSeats(h.deps)).toBe(0);
		expect(h.invoked).toHaveLength(0);
	});

	test("a seat with only blocked or backlog work is not invoked", async () => {
		const h = harness([{ id: "a1", status: "idle" }], {
			a1: [
				todo("SOF-1", "2026-10-07T09:00:00Z", "blocked"),
				todo("SOF-2", "2026-10-07T09:00:00Z", "backlog"),
			],
		});
		expect(await wakeIdleSeats(h.deps)).toBe(0);
		expect(h.invoked).toHaveLength(0);
	});

	test("in_progress with a live run is not work to wake for; without one it is", async () => {
		const live = {
			...todo("SOF-1", "2026-10-07T09:00:00Z", "in_progress"),
			activeRun: { status: "running" },
		};
		const h = harness([{ id: "a1", status: "idle" }], { a1: [live] });
		expect(await wakeIdleSeats(h.deps)).toBe(0);
		const h2 = harness([{ id: "a1", status: "idle" }], {
			a1: [todo("SOF-2", "2026-10-07T09:00:00Z", "in_progress")],
		});
		expect(await wakeIdleSeats(h2.deps)).toBe(1);
	});

	test("a failed invoke logs, records nothing, and the next seat is still woken", async () => {
		const h = harness(
			[
				{ id: "a1", status: "idle" },
				{ id: "a2", status: "idle" },
			],
			{ a1: [todo("SOF-1", "2026-10-07T09:00:00Z")], a2: [todo("SOF-2", "2026-10-07T09:00:00Z")] },
		);
		const ok = h.deps.invoke;
		h.deps.invoke = async (id, opts) => {
			if (id === "a1") throw new Error("paused");
			return ok(id, opts);
		};
		expect(await wakeIdleSeats(h.deps)).toBe(1);
		expect(h.state["idle-wake:a1"]).toBeUndefined();
		expect(h.invoked.map((i) => i.agentId)).toEqual(["a2"]);
	});
});

describe("wakeOnRunEnd: a run ending wakes that seat at once", () => {
	const runEnd = (
		agent: IdleWakeAgent | null,
		issues: IdleWakeIssue[],
		state: Record<string, unknown> = {},
	) => {
		const h = harness(agent ? [agent] : [], agent ? { [agent.id]: issues } : {}, state);
		return { ...h, deps: { ...h.deps, getAgent: async () => agent } };
	};

	test("(a) an idle seat holding a todo task is invoked once, naming its oldest task", async () => {
		const h = runEnd({ id: "a1", name: "Adams", status: "idle" }, [
			{ ...todo("SOF-9", "2026-10-07T12:00:00Z"), id: "uuid-9" },
			{ ...todo("SOF-3", "2026-10-07T09:00:00Z"), id: "uuid-3" },
		]);
		expect(await wakeOnRunEnd({ agentId: "a1", runId: "run-1" }, h.deps)).toBe(true);
		expect(h.invoked).toHaveLength(1);
		expect(h.invoked[0]?.agentId).toBe("a1");
		expect(h.invoked[0]?.prompt).toContain("SOF-3");
		expect(h.invoked[0]?.issueId).toBe("uuid-3");
	});

	test("the sweep's cooldown does not hold back a run-end wake on another task", async () => {
		const h = runEnd({ id: "a1", status: "idle" }, [todo("SOF-2", "2026-10-07T09:00:00Z")], {
			"idle-wake:a1": { at: NOW - 1000, task: "SOF-1" },
		});
		expect(await wakeOnRunEnd({ agentId: "a1", runId: "run-1" }, h.deps)).toBe(true);
		expect(h.invoked).toHaveLength(1);
		expect(h.invoked[0]?.prompt).toContain("SOF-2");
	});

	test("(b) the same run-end event delivered twice invokes once", async () => {
		const h = runEnd({ id: "a1", status: "idle" }, [todo("SOF-1", "2026-10-07T09:00:00Z")]);
		const ev = { agentId: "a1", runId: "run-1" };
		expect(await wakeOnRunEnd(ev, h.deps)).toBe(true);
		expect(await wakeOnRunEnd(ev, h.deps)).toBe(false);
		expect(h.invoked).toHaveLength(1);
	});

	// A run that ends without moving its task (the seat declined or waits) would
	// otherwise start the next paid run at once, in a loop (PR 1888 review, P1).
	// The run here outlasts WAKE_COOLDOWN_MS, so a cooldown alone would not hold.
	test("the same task after a run longer than the cooldown is left to the sweep", async () => {
		const h = runEnd({ id: "a1", status: "idle" }, [todo("SOF-1", "2026-10-07T09:00:00Z")]);
		expect(await wakeOnRunEnd({ agentId: "a1", runId: "run-1" }, h.deps)).toBe(true);
		h.deps.now = () => NOW + WAKE_COOLDOWN_MS + 60_000;
		expect(await wakeOnRunEnd({ agentId: "a1", runId: "run-2" }, h.deps)).toBe(false);
		expect(h.invoked).toHaveLength(1);
		expect(
			await wakeIdleSeats({ ...h.deps, listAgents: async () => [{ id: "a1", status: "idle" }] }),
		).toBe(1);
		expect(h.invoked).toHaveLength(2);
	});

	test("a different task after a run end wakes at once, inside the cooldown", async () => {
		const h = runEnd({ id: "a1", status: "idle" }, [todo("SOF-2", "2026-10-07T09:00:00Z")], {
			"idle-wake:a1": { task: "SOF-1", at: NOW - 1000 },
		});
		expect(await wakeOnRunEnd({ agentId: "a1", runId: "run-2" }, h.deps)).toBe(true);
		expect(h.invoked[0]?.prompt).toContain("SOF-2");
	});

	test("two overlapping run-end deliveries for one seat invoke once", async () => {
		const h = runEnd({ id: "a1", status: "idle" }, [todo("SOF-1", "2026-10-07T09:00:00Z")]);
		const ev = { agentId: "a1", runId: "run-1" };
		const got = await Promise.all([wakeOnRunEnd(ev, h.deps), wakeOnRunEnd(ev, h.deps)]);
		expect(got.filter(Boolean)).toHaveLength(1);
		expect(h.invoked).toHaveLength(1);
	});

	// The host emits the run event before it sets the seat idle
	// (finalizeAgentStatus), so the ended run's seat still reads running.
	test("a seat still reading running with pending work is woken, issue-scoped to its oldest task", async () => {
		const h = runEnd({ id: "a1", name: "Adams", status: "running" }, [
			{ ...todo("SOF-9", "2026-10-07T12:00:00Z"), id: "uuid-9" },
			{ ...todo("SOF-3", "2026-10-07T09:00:00Z"), id: "uuid-3" },
		]);
		expect(await wakeOnRunEnd({ agentId: "a1", runId: "run-1" }, h.deps)).toBe(true);
		expect(h.invoked).toHaveLength(1);
		expect(h.invoked[0]?.prompt).toContain("SOF-3");
		expect(h.invoked[0]?.issueId).toBe("uuid-3");
	});

	test("a paused, error or terminated seat with pending work is not woken", async () => {
		for (const status of ["paused", "error", "terminated"]) {
			const h = runEnd({ id: "a1", status }, [todo("SOF-1", "2026-10-07T09:00:00Z")]);
			expect(await wakeOnRunEnd({ agentId: "a1", runId: "run-1" }, h.deps)).toBe(false);
			expect(h.invoked).toHaveLength(0);
		}
	});

	test("a running seat whose oldest task is the memo's task is not woken", async () => {
		const h = runEnd({ id: "a1", status: "running" }, [todo("SOF-1", "2026-10-07T09:00:00Z")], {
			"idle-wake:a1": { at: NOW - 1000, task: "SOF-1" },
		});
		expect(await wakeOnRunEnd({ agentId: "a1", runId: "run-1" }, h.deps)).toBe(false);
		expect(h.invoked).toHaveLength(0);
	});

	test("(d) a seat with no pending work invokes nothing", async () => {
		const h = runEnd({ id: "a1", status: "idle" }, [
			todo("SOF-1", "2026-10-07T09:00:00Z", "blocked"),
			todo("SOF-2", "2026-10-07T09:00:00Z", "done"),
			{ ...todo("SOF-3", "2026-10-07T08:00:00Z", "in_progress"), activeRun: { status: "running" } },
		]);
		expect(await wakeOnRunEnd({ agentId: "a1", runId: "run-1" }, h.deps)).toBe(false);
		expect(h.invoked).toHaveLength(0);
	});

	test("a board error is logged by name and never thrown", async () => {
		const h = runEnd({ id: "a1", status: "idle" }, []);
		h.deps.getAgent = async () => {
			throw new TypeError("board down");
		};
		expect(await wakeOnRunEnd({ agentId: "a1", runId: "run-1" }, h.deps)).toBe(false);
		expect(h.lines).toEqual(["run-wake: a1 failed: TypeError"]);
	});
});

test("the sweep backstop cooldown is 2 minutes", () => {
	expect(WAKE_COOLDOWN_MS).toBe(2 * 60 * 1000);
});
