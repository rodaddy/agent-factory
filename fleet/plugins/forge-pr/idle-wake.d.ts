// Types for idle-wake.js (plain ESM, injected deps so tests need no board).
export interface IdleWakeAgent {
	id: string;
	name?: string;
	status: string;
}
export interface IdleWakeIssue {
	id: string;
	identifier?: string | null;
	title?: string;
	status: string;
	createdAt?: string | Date;
	activeRun?: { status: string } | null;
}
export interface IdleWakeDeps {
	listAgents: () => Promise<IdleWakeAgent[]>;
	listIssues: (agentId: string, status: "todo" | "in_progress") => Promise<IdleWakeIssue[]>;
	/** issueId is the oldest task's id; the wake must be bound to it (SOF-11432). */
	invoke: (
		agentId: string,
		opts: { prompt: string; reason: string; issueId: string },
	) => Promise<unknown>;
	stateGet: (key: string) => Promise<unknown>;
	stateSet: (key: string, value: unknown) => Promise<void>;
	now: () => number;
	log: (line: string) => void;
}
export interface RunEndDeps extends Omit<IdleWakeDeps, "listAgents"> {
	getAgent: (agentId: string) => Promise<IdleWakeAgent | null>;
}
export interface RunEndEvent {
	agentId?: string;
	runId?: string;
}
/** A seat woken this recently is not woken again by the sweep. */
export const WAKE_COOLDOWN_MS: number;
/** Wakes each idle seat holding todo (or run-less in_progress) work, at most once; returns the count. */
export function wakeIdleSeats(deps: IdleWakeDeps): Promise<number>;
/** Wakes the ended run's seat at once if idle with pending work, unless that task is the one it was last woken for (the sweep retries it). Never throws. */
export function wakeOnRunEnd(event: RunEndEvent, deps: RunEndDeps): Promise<boolean>;
