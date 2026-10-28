/**
 * @module control-surface/vocabulary
 * @description The label/column VOCABULARY as DATA. The control
 *   surface's whole premise is that an operator drives the factory by labelling
 *   an issue and moving a card — so the mapping from a label to an allowlisted
 *   job, and from a board column to a lifecycle state, must be a runtime-
 *   enumerable table rather than a chain of conditionals. A vocabulary that
 *   cannot be enumerated cannot be documented, diffed, or checked against the
 *   doc, and the done-means check binds the registry to `_DOCS/control-surface.md`
 *   at runtime precisely so the two cannot drift.
 *
 *   Every `job` here is an `JobTemplateId` from `templates/registry`, so this
 *   table can never name a template that is not already allowlisted in code. It
 *   is a NARROWING of that allowlist, never a widening: config's `job_templates`
 *   remains the second gate at dispatch, and resolution here proposes a template
 *   id, it does not authorize a run.
 *
 *   `factory-implement` is rtech-infra's EXISTING per-issue opt-in and is
 *   carried unchanged — this module documents the label the deployed config
 *   already reads (`implement_label` in `config/repos.yml`), it does not
 *   redefine it.
 *
 *   The `deploy:<app>` / `spindown:<app>` verb labels are PARAMETERIZED: the app
 *   name is the label's suffix. They resolve through this same registry to the
 *   deterministic `newapp` / `newapp-down` entry points; route and database
 *   projection stay inside the same compile-all engine path rather than growing a
 *   second label vocabulary.
 *
 *   `redeploy:<app>` is parameterized the SAME way and deliberately maps
 *   to NO job. It is a one-shot RE-RUN SIGNAL, not a verb: the operator adds it to
 *   an item whose `(repository, item, manifest.sha256, verb)` tuple is already
 *   terminal, and the watcher consumes it — removing it from the forge BEFORE it
 *   dispatches anything — so the ordinary `deploy:<app>` path then runs once more.
 *   `job: null` is what keeps it out of the dispatch allowlist entirely: the
 *   resolver reports an explicit no-decision for it, so a `redeploy:` label ALONE
 *   can never start a run. The verb it re-runs is still resolved from the item's
 *   own `deploy:`/`spindown:` label and still gated by config `job_templates`,
 *   which is why the one-shot label cannot become an arbitrary-verb escape hatch.
 *
 * @outputs
 *   - `LabelJobEntry` -- one vocabulary row
 *   - `LABEL_JOB_REGISTRY` -- the enumerable label -> job table
 *   - `REDEPLOY_LABEL_PREFIX` -- the `redeploy:` stem, as one shared constant
 *   - `redeployRequests` -- the app suffixes a label set is asking to re-run
 *   - `COLUMN_STATES` / `ColumnState` -- queued/dispatched/receipted/held
 *   - `COLUMN_VOCABULARY` -- board column name -> lifecycle state
 *   - `columnStateFor` -- resolve a column name to its lifecycle state
 *
 * @dependencies
 *   - ../templates/registry -- the closed allowlist of job template ids
 */
import { traced } from "../log";
import type { JobTemplateId } from "../templates/registry";

/**
 * One row of the label vocabulary. `job` is null for a label that is RECOGNISED
 * but not yet dispatchable, which is a different state from an unknown label and
 * is reported differently by the resolver.
 */
export interface LabelJobEntry {
	/** The exact, undecorated label token an operator writes on the issue. */
	readonly label: string;
	/** The allowlisted template this label proposes, or null when not yet built. */
	readonly job: JobTemplateId | null;
	/**
	 * True when the label carries a parameter as its suffix (`deploy:<app>`), so
	 * the resolver matches on the `<prefix>:` stem rather than the whole token.
	 */
	readonly parameterized?: boolean;
	/** Why the row exists, in one line. Mirrored by the taxonomy doc. */
	readonly note: string;
}

/**
 * The label -> job vocabulary. ENUMERABLE DATA, deliberately: the done-means
 * check reads this array at runtime and requires every label in it to be named
 * in `_DOCS/control-surface.md`, so adding a row without documenting it fails
 * the build rather than shipping an undocumented trigger.
 */
export const LABEL_JOB_REGISTRY: readonly LabelJobEntry[] = [
	{
		label: "factory-implement",
		job: "implement-issue",
		note: "rtech-infra's existing per-issue opt-in (#187); config `implement_label` is the deployed gate.",
	},
	{
		label: "factory-triage",
		job: "issue-triage",
		note: "Classify an issue and propose labels; report-only, never a change.",
	},
	{
		label: "factory-review",
		job: "pr-review",
		note: "Review a pull request; report-only.",
	},
	{
		label: "factory-validate",
		job: "repo-validate",
		note: "Repository validation lane.",
	},
	{
		label: "factory-infra-static",
		job: "infra-static",
		note: "rtech-infra fixed static gates over a candidate.",
	},
	{
		label: "deploy:",
		job: "newapp",
		parameterized: true,
		note: "Verb label `deploy:<app>` — dispatch the deterministic create projection through `newapp` (#255).",
	},
	{
		label: "spindown:",
		job: "newapp-down",
		parameterized: true,
		note: "Verb label `spindown:<app>` — dispatch the deterministic prune projection through `newapp-down` (#255).",
	},
	{
		label: "redeploy:",
		job: null,
		parameterized: true,
		note: "One-shot RE-RUN signal `redeploy:<app>` (sf#305) — consumed and removed before dispatch; maps to no job of its own.",
	},
] as const;

/**
 * The `redeploy:` stem, as ONE constant.
 *
 * The registry row above and every consumer read the same value, so the label an
 * operator writes, the label the resolver recognises, and the label the watcher
 * removes from the forge cannot drift into three nearly-identical strings.
 */
export const REDEPLOY_LABEL_PREFIX = "redeploy:";

/**
 * The apps a label set is asking to RE-RUN.
 *
 * Returns the exact label tokens alongside their app suffixes, because the
 * consumer needs both: the suffix says which verb row the signal is for, and the
 * verbatim token is what gets removed from the forge. Reconstructing the token
 * from the suffix would be a second spelling of the same string and is exactly
 * the drift `REDEPLOY_LABEL_PREFIX` exists to prevent.
 *
 * A bare `redeploy:` with no suffix is NOT a request. It names no app, so there
 * is nothing to re-run, and treating it as one would make an empty parameter mean
 * "every app" — the widest possible reading of the narrowest possible label.
 */
export const redeployRequests = traced(
	"control-surface.redeployRequests",
	function redeployRequests(
		labels: readonly string[] | null | undefined,
	): { label: string; app: string }[] {
		if (!Array.isArray(labels)) return [];
		const requests: { label: string; app: string }[] = [];
		for (const label of labels) {
			if (typeof label !== "string" || !label.startsWith(REDEPLOY_LABEL_PREFIX)) continue;
			const app = label.slice(REDEPLOY_LABEL_PREFIX.length);
			if (app.length === 0) continue;
			requests.push({ label, app });
		}
		return requests;
	},
);

/**
 * The lifecycle a board column expresses. These four are the
 * states the reconciler can distinguish; a column that maps to none of them is
 * not part of the control surface.
 */
export const COLUMN_STATES = ["queued", "dispatched", "receipted", "held"] as const;
export type ColumnState = (typeof COLUMN_STATES)[number];

/**
 * Board column name -> lifecycle state. The keys are the Project 11 Status
 * option NAMES recorded in rtech-infra `_DOCS/project-board.md`; the factory
 * reads a column's name, never its option id, so this table stays valid if the
 * board's ids are regenerated. Matching is case-insensitive at the resolver.
 */
export const COLUMN_VOCABULARY: Readonly<Record<string, ColumnState>> = {
	todo: "queued",
	backlog: "queued",
	"in progress": "dispatched",
	"in review": "receipted",
	done: "receipted",
	blocked: "held",
	// A board whose columns are named for the lifecycle states themselves maps
	// identically. Not a courtesy: Project 11's Status options are one board's
	// vocabulary, and a factory-owned board is free to name a column `queued`.
	// Without these rows such a column would read as UNMAPPED — the surface would
	// silently see no lifecycle state on a board that spells it exactly right.
	queued: "queued",
	dispatched: "dispatched",
	receipted: "receipted",
	held: "held",
};

/** Resolve a board column name to its lifecycle state, or null when unmapped. */
export const columnStateFor = traced(
	"control-surface.columnStateFor",
	function columnStateFor(column: string | null | undefined): ColumnState | null {
		if (typeof column !== "string") {
			return null;
		}
		return COLUMN_VOCABULARY[column.trim().toLowerCase()] ?? null;
	},
);
