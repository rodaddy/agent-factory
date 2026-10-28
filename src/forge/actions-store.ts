/**
 * @module forge/actions-store
 * @description Durable tracking of dispatched Forgejo Actions runs (
 *   lane 476a) in `forge_runs`. The webhook receiver calls these on
 *   `workflow_run` events in 476b; nothing is wired here yet.
 *
 * @outputs
 *   - `recordDispatch` -- insert one dispatched run; null when (repo, run_id) is already recorded
 *   - `claimDispatch` -- atomically insert a dispatched row unless a live one matches
 *   - `releaseDispatch` -- mark a claimed row `failure` after its POST failed
 *   - `findDispatch` -- id of a live (not failure/cancelled) recorded dispatch matching a query, or null
 *   - `recordRunState` -- move a recorded run's state by (repo, run_id); returns rows updated
 *   - `settleRunById` -- move one still-`dispatched` row's state by primary key
 *   - `touchRunById` -- stamp updated_at on a checked, unsettled row so settle rotates
 *   - `hasOpenVerbDispatch` -- a non-failed verb.yml dispatch exists for (repo, item, verb, manifest)
 *   - `DISPATCH_STALE_MINUTES` -- default window after which an id-less `dispatched` row is not live
 *   - `inputsObject` -- a forge_runs.inputs value (object, or pre-sf#911 JSON text) as an object
 *   - `toRunState` -- map a Forgejo run status into the closed `ForgeRunState` set
 *
 * @dependencies
 *   - ../db/schema -- forge_runs
 *   - ../db/client -- WatcherDb
 *   - ../log -- traced()
 */
import { and, eq, notInArray, sql } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { type ForgeRunState, forgeRuns } from "../db/schema";
import { traced } from "../log";

export interface DispatchRecord {
	repo: string;
	workflow: string;
	runId: number | null;
	targetSha: string;
	inputs: Record<string, string>;
}

/** Insert one dispatched run. Returns the row id, or null when (repo, run_id) already exists. */
export const recordDispatch = traced(
	"forge.recordDispatch",
	async function recordDispatch(db: WatcherDb, rec: DispatchRecord): Promise<number | null> {
		const rows = await db
			.insert(forgeRuns)
			.values({
				repo: rec.repo,
				workflow: rec.workflow,
				runId: rec.runId,
				targetSha: rec.targetSha,
				// The JSON text bound as ::text, then cast: handing the object (or a bare:
				// :jsonb param) to bun-sql lands a jsonb STRING scalar (probed).
				inputs: sql`(${JSON.stringify(rec.inputs)}::text)::jsonb`,
				state: "dispatched",
			})
			.onConflictDoNothing()
			.returning({ id: forgeRuns.id });
		return rows[0]?.id ?? null;
	},
);

/** A live-dispatch lookup: host repo, workflow file, target sha, and the inputs a row must contain. */
export interface DispatchQuery {
	repo: string;
	workflow: string;
	targetSha: string;
	inputs: Record<string, string>;
}

/**
 * Minutes after which a `dispatched` row that never got a run id stops counting
 * as live for dedupe (sweep-F, PR 902): the dispatch never produced a run (the
 * #808 guard's class), so it must not block a retry forever.
 */
export const DISPATCH_STALE_MINUTES = 30;

/** Live for dedupe: not a terminal failure, and not a stale id-less `dispatched` row. */
function liveDispatch(staleMinutes: number) {
	return and(
		notInArray(forgeRuns.state, ["failure", "cancelled"]),
		sql`not (${forgeRuns.state} = 'dispatched' and ${forgeRuns.runId} is null and ${forgeRuns.dispatchedAt} < now() - make_interval(mins => ${staleMinutes}::int))`,
	);
}

/**
 * `inputs` as a jsonb object in SQL. Rows written before sf#911 hold a jsonb
 * STRING scalar of the JSON text; new rows hold an object. Both shapes match.
 */
const INPUTS_OBJECT = sql`(case when jsonb_typeof(${forgeRuns.inputs}) = 'string' then (${forgeRuns.inputs} #>> '{}')::jsonb else ${forgeRuns.inputs} end)`;

/**
 * The id of a recorded dispatch matching `query` (every `inputs` key equal as
 * text) whose state is not `failure` or `cancelled` and that is not a stale
 * id-less `dispatched` row, or null.
 */
export const findDispatch = traced(
	"forge.findDispatch",
	async function findDispatch(
		db: WatcherDb,
		query: DispatchQuery,
		staleMinutes: number = DISPATCH_STALE_MINUTES,
	): Promise<number | null> {
		return findDispatchOn(db, query, staleMinutes);
	},
);

/** The executor a dispatch lookup runs on: the db itself or an open transaction. */
type DispatchReader = Pick<WatcherDb, "select">;

async function findDispatchOn(
	db: DispatchReader,
	query: DispatchQuery,
	staleMinutes: number,
): Promise<number | null> {
	const rows = await db
		.select({ id: forgeRuns.id })
		.from(forgeRuns)
		.where(
			and(
				eq(forgeRuns.repo, query.repo),
				eq(forgeRuns.workflow, query.workflow),
				eq(forgeRuns.targetSha, query.targetSha),
				...Object.entries(query.inputs).map(
					([key, value]) => sql`${INPUTS_OBJECT} ->> ${key} = ${value}`,
				),
				liveDispatch(staleMinutes),
			),
		)
		.limit(1);
	return rows[0]?.id ?? null;
}

/**
 * Atomically claim a dispatch: under a transaction-scoped advisory
 * lock on (repo, workflow, target sha), insert a `dispatched` row unless a live
 * one matching `match` exists. Returns the new row id, or null when a live
 * dispatch already holds the key, so two concurrent callers cannot both win.
 */
export const claimDispatch = traced(
	"forge.claimDispatch",
	async function claimDispatch(
		db: WatcherDb,
		rec: DispatchRecord,
		match: Record<string, string>,
		staleMinutes: number = DISPATCH_STALE_MINUTES,
	): Promise<number | null> {
		return db.transaction(async (tx) => {
			await tx.execute(
				sql`select pg_advisory_xact_lock(hashtextextended(${rec.repo} || '|' || ${rec.workflow} || '|' || ${rec.targetSha}, 0))`,
			);
			const live = await findDispatchOn(
				tx,
				{ repo: rec.repo, workflow: rec.workflow, targetSha: rec.targetSha, inputs: match },
				staleMinutes,
			);
			if (live !== null) {
				return null;
			}
			const rows = await tx
				.insert(forgeRuns)
				.values({
					repo: rec.repo,
					workflow: rec.workflow,
					runId: rec.runId,
					targetSha: rec.targetSha,
					// Same ::text then ::jsonb cast as recordDispatch.
					inputs: sql`(${JSON.stringify(rec.inputs)}::text)::jsonb`,
					state: "dispatched",
				})
				// An already-recorded (repo, run_id) is not a new claim (PR 1037 review).
				.onConflictDoNothing()
				.returning({ id: forgeRuns.id });
			return rows[0]?.id ?? null;
		});
	},
);

/** Release a claimed dispatch whose POST failed: state `failure`. Returns rows updated. */
export const releaseDispatch = traced(
	"forge.releaseDispatch",
	async function releaseDispatch(db: WatcherDb, id: number): Promise<number> {
		const rows = await db
			.update(forgeRuns)
			.set({ state: "failure", updatedAt: sql`now()` })
			// Only a still-unsettled claim; never overwrite a settled run (PR 1037 review).
			.where(and(eq(forgeRuns.id, id), eq(forgeRuns.state, "dispatched")))
			.returning({ id: forgeRuns.id });
		return rows.length;
	},
);

/** Set the state of the run recorded as (repo, runId). Returns the number of rows updated. */
export const recordRunState = traced(
	"forge.recordRunState",
	async function recordRunState(
		db: WatcherDb,
		repo: string,
		runId: number,
		state: ForgeRunState,
	): Promise<number> {
		const rows = await db
			.update(forgeRuns)
			.set({ state, updatedAt: sql`now()` })
			.where(and(eq(forgeRuns.repo, repo), eq(forgeRuns.runId, runId)))
			.returning({ id: forgeRuns.id });
		return rows.length;
	},
);

/** Settle the row `id` to `state` while it is still `dispatched`. Returns rows updated. */
export const settleRunById = traced(
	"forge.settleRunById",
	async function settleRunById(db: WatcherDb, id: number, state: ForgeRunState): Promise<number> {
		const rows = await db
			.update(forgeRuns)
			.set({ state, updatedAt: sql`now()` })
			.where(and(eq(forgeRuns.id, id), eq(forgeRuns.state, "dispatched")))
			.returning({ id: forgeRuns.id });
		return rows.length;
	},
);

/**
 * Stamp `updated_at` on a still-`dispatched` row the settle pass checked but
 * could not settle, so the next pass (least recently checked first) reaches
 * other rows instead of re-reading the same slice.
 */
export const touchRunById = traced(
	"forge.touchRunById",
	async function touchRunById(db: WatcherDb, id: number): Promise<number> {
		const rows = await db
			.update(forgeRuns)
			.set({ updatedAt: sql`now()` })
			.where(and(eq(forgeRuns.id, id), eq(forgeRuns.state, "dispatched")))
			.returning({ id: forgeRuns.id });
		return rows.length;
	},
);

/** The identity of one verb.yml dispatch, as its `inputs` carry it. */
export interface VerbDispatchKey {
	repo: string;
	item: number;
	verb: string;
	manifestSha: string;
}

/**
 * True when forge_runs already holds a verb.yml dispatch for this (repo, item,
 * verb, manifest) whose state is not a terminal failure (`failure`/`cancelled`).
 * The Actions-path dedup: a re-surfaced item must not dispatch verb.yml again.
 *
 * Reads through `INPUTS_OBJECT`, so pre-sf#911 string-scalar rows still match.
 */
export const hasOpenVerbDispatch = traced(
	"forge.hasOpenVerbDispatch",
	async function hasOpenVerbDispatch(
		db: WatcherDb,
		key: VerbDispatchKey,
		staleMinutes: number = DISPATCH_STALE_MINUTES,
	): Promise<boolean> {
		const obj = INPUTS_OBJECT;
		const rows = await db
			.select({ id: forgeRuns.id })
			.from(forgeRuns)
			.where(
				and(
					eq(forgeRuns.workflow, "verb.yml"),
					sql`${obj}->>'repo' = ${key.repo}`,
					sql`${obj}->>'item' = ${String(key.item)}`,
					sql`${obj}->>'verb' = ${key.verb}`,
					sql`${obj}->>'manifest_sha' = ${key.manifestSha}`,
					liveDispatch(staleMinutes),
				),
			)
			.limit(1);
		return rows.length > 0;
	},
);

/**
 * A `forge_runs.inputs` value as an object: new rows are already objects, rows
 * written before sf#911 are the JSON text of one. Anything else yields {}.
 */
export const inputsObject = traced(
	"forge.inputsObject",
	function inputsObject(raw: unknown): Record<string, unknown> {
		let value = raw;
		if (typeof value === "string") {
			try {
				value = JSON.parse(value);
			} catch {
				return {};
			}
		}
		if (value !== null && typeof value === "object" && !Array.isArray(value)) {
			return value as Record<string, unknown>;
		}
		return {};
	},
);

/** Map a Forgejo run status to the closed state set; `blocked` waits, anything unrecognized is unknown. */
export const toRunState = traced(
	"forge.toRunState",
	function toRunState(status: string): ForgeRunState {
		switch (status) {
			case "success":
			case "failure":
			case "cancelled":
			case "running":
			case "waiting":
				return status;
			case "blocked":
				return "waiting";
			default:
				return "unknown";
		}
	},
);
