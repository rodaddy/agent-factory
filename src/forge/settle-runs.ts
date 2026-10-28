/**
 * @module forge/settle-runs
 * @description Settle `dispatched` forge_runs from the commit status their
 *   workflow posts. Forgejo 16 dispatch returns no run id, so
 *   `recordRunState` never fires and every row stays `dispatched`, which makes
 *   the postings-absence alert fire by construction. Once per cycle this pass
 *   reads the status context each mapped workflow posts on its target sha and,
 *   when the NEWEST such status posted at or after the dispatch is terminal,
 *   moves the row to that state. Pending or absent leaves the row alone; a forge
 *   read failure for one row is logged and skipped, never thrown.
 *
 * @outputs
 *   - `WORKFLOW_CONTEXT` -- the workflows this pass settles, and the context each posts
 *   - `statusToRunState` -- a terminal commit status as a `ForgeRunState`, or null;
 *     `error` (the lane could not run) settles to `cancelled`, no verdict, so
 *     the postings-absence alert still sees the lane as unposted
 *   - `selectDueRuns` -- dispatched rows of mapped workflows, 2 min to 24 h old
 *   - `settleForgeRuns` -- one settle pass over injected store/reader seams
 *   - `runSettleForgeRunsStep` -- the isolated cycle step over the real db/client
 *
 * @dependencies
 *   - ./actions-store -- settleRunById, toRunState
 *   - ../db/schema -- forge_runs
 *   - ../log -- traced(), log()
 */
import { and, asc, eq, gt, inArray, lt, sql } from "drizzle-orm";
import type { WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import { type ForgeRunState, forgeRuns } from "../db/schema";
import { errorClass, log, traced } from "../log";
import { settleRunById, toRunState, touchRunById } from "./actions-store";
import type { ForgeClient } from "./boundary";

/** The workflows this pass settles, and the commit-status context each posts. */
export const WORKFLOW_CONTEXT: Readonly<Record<string, string>> = {
	"prepush.yml": "factory/prepush",
	"pr-review.yml": "factory/pr-review",
	"infra-static.yml": "factory/infra-static",
};

/** One dispatched row, as the pass needs it. */
export interface DueRun {
	id: number;
	repo: string;
	workflow: string;
	targetSha: string;
	inputs: unknown;
	dispatchedAt: Date;
}

interface CommitStatus {
	id?: number;
	context?: string;
	status?: string;
	state?: string;
	description?: string;
	created_at?: string;
}

export interface SettleDeps {
	listDue: () => Promise<DueRun[]>;
	readStatuses: (repo: string, sha: string) => Promise<unknown[]>;
	settle: (id: number, state: ForgeRunState) => Promise<number>;
	/** Mark a checked-but-unsettled row so the next pass reaches other rows first. */
	touch: (id: number) => Promise<unknown>;
}

/**
 * A terminal commit status as a run state; null for pending or anything unrecognized.
 * `error` means the lane could not run; it settles to `cancelled`, the terminal
 * no-verdict state, so the postings-absence alert still sees the lane as
 * unposted.
 */
export const statusToRunState = traced(
	"forge.statusToRunState",
	function statusToRunState(status: string, description: string): ForgeRunState | null {
		if (status === "error") return "cancelled";
		if (status === "warning") {
			return description.startsWith("pr-review skipped") ? "success" : "failure";
		}
		const state = toRunState(status);
		return state === "success" || state === "failure" ? state : null;
	},
);

/** The (repo, sha) the workflow posts its status on: its `repo`/`head_sha` inputs, else the row. */
function statusTarget(run: DueRun): { repo: string; sha: string } {
	const raw = typeof run.inputs === "string" ? JSON.parse(run.inputs) : run.inputs;
	const inputs = (raw ?? {}) as Record<string, unknown>;
	const repo = typeof inputs.repo === "string" && inputs.repo ? inputs.repo : run.repo;
	const sha =
		typeof inputs.head_sha === "string" && inputs.head_sha ? inputs.head_sha : run.targetSha;
	return { repo, sha };
}

/** The newest status with `context` created at or after `since`, or null. */
function newestSince(rows: unknown[], context: string, since: Date): CommitStatus | null {
	let best: CommitStatus | null = null;
	let bestAt = -1;
	for (const row of rows as CommitStatus[]) {
		if (row?.context !== context) continue;
		const at = Date.parse(row.created_at ?? "");
		if (!Number.isFinite(at) || at < since.getTime()) continue;
		if (at > bestAt || (at === bestAt && (row.id ?? 0) > (best?.id ?? 0))) {
			best = row;
			bestAt = at;
		}
	}
	return best;
}

/** Settle one row; returns which counter it lands in. `reads` shares one read per (repo, sha) within a pass. */
async function settleOne(
	deps: SettleDeps,
	run: DueRun,
	reads: Map<string, Promise<unknown[]>>,
): Promise<"settled" | "pending"> {
	const context = WORKFLOW_CONTEXT[run.workflow] ?? "";
	const { repo, sha } = statusTarget(run);
	const key = `${repo}@${sha}`;
	if (!reads.has(key)) reads.set(key, deps.readStatuses(repo, sha));
	const rows = (await reads.get(key)) ?? [];
	const newest = newestSince(rows, context, run.dispatchedAt);
	if (newest === null) return "pending";
	const state = statusToRunState(newest.status ?? newest.state ?? "", newest.description ?? "");
	if (state === null) return "pending";
	await deps.settle(run.id, state);
	return "settled";
}

/** One settle pass. Rows of unmapped workflows are skipped unread. */
export const settleForgeRuns = traced(
	"forge.settleForgeRuns",
	async function settleForgeRuns(deps: SettleDeps) {
		const counts = { checked: 0, settled: 0, pending: 0, failed: 0 };
		const reads = new Map<string, Promise<unknown[]>>();
		for (const run of await deps.listDue()) {
			if (!Object.hasOwn(WORKFLOW_CONTEXT, run.workflow)) continue;
			counts.checked++;
			try {
				const outcome = await settleOne(deps, run, reads);
				counts[outcome]++;
				if (outcome === "pending") await deps.touch(run.id);
			} catch (e) {
				counts.failed++;
				log("warn", "forge.settle_runs.read_failed", { id: run.id, error: errorClass(e) });
				await deps.touch(run.id).catch(() => undefined);
			}
		}
		if (counts.checked > 0) log("info", "forge.settle_runs", counts);
		return counts;
	},
);

/** Dispatched rows of mapped workflows, 2 min to 24 h old, least recently checked first, at most 50. */
export const selectDueRuns = traced(
	"forge.selectDueRuns",
	async function selectDueRuns(db: WatcherDb): Promise<DueRun[]> {
		return db
			.select({
				id: forgeRuns.id,
				repo: forgeRuns.repo,
				workflow: forgeRuns.workflow,
				targetSha: forgeRuns.targetSha,
				inputs: forgeRuns.inputs,
				dispatchedAt: forgeRuns.dispatchedAt,
			})
			.from(forgeRuns)
			.where(
				and(
					eq(forgeRuns.state, "dispatched"),
					inArray(forgeRuns.workflow, Object.keys(WORKFLOW_CONTEXT)),
					lt(forgeRuns.dispatchedAt, sql`now() - interval '2 minutes'`),
					gt(forgeRuns.dispatchedAt, sql`now() - interval '24 hours'`),
				),
			)
			.orderBy(asc(forgeRuns.updatedAt))
			.limit(50);
	},
	{ redact: { args: [0] } },
);

/** sf#1636: the step reads Forge at most once per this window. Process-local: a restart may run one early. */
export const SETTLE_EVERY_MS = 5 * 60_000;
let lastSettleAt: number | null = null;

/** Whether the step is due at `now` (ms); a due call claims the window. A clock that went backwards is due. */
function settleDue(now: number): boolean {
	if (lastSettleAt !== null && now >= lastSettleAt && now - lastSettleAt < SETTLE_EVERY_MS)
		return false;
	lastSettleAt = now;
	return true;
}

/**
 * The cycle step: isolated, a failure reaches `onError` and never aborts the
 * cycle. Runs at most once per `SETTLE_EVERY_MS`; a skipped cycle is a no-op.
 */
export const runSettleForgeRunsStep = traced(
	"forge.runSettleForgeRunsStep",
	async function runSettleForgeRunsStep(deps: {
		db: WatcherDb;
		config: WatcherConfig;
		clientFor: (repository: string) => Promise<ForgeClient | null>;
		onError: (e: unknown) => void;
		/** Clock in ms, for the sf#1636 cadence. */
		now?: () => number;
	}): Promise<void> {
		if (!settleDue((deps.now ?? Date.now)())) return;
		try {
			// Every Forgejo repo shares the ONE Forgejo client (as reconcile/stale-pending).
			const first = deps.config.repositories.find((r) => r.provider === "forgejo");
			const client = first ? await deps.clientFor(first.name) : null;
			if (client === null) return;
			await settleForgeRuns({
				listDue: () => selectDueRuns(deps.db),
				readStatuses: (repo, sha) =>
					client.paginate<unknown>(`/repos/${repo}/commits/${sha}/statuses?limit=50`, 5),
				settle: (id, state) => settleRunById(deps.db, id, state),
				touch: (id) => touchRunById(deps.db, id),
			});
		} catch (e) {
			deps.onError(e);
		}
	},
	{ redact: { args: [0] } },
);
