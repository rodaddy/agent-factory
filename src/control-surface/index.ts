/**
 * @module control-surface
 * @description The factory's CONTROL SURFACE (k3s-era node N2): issues +
 *   labels + board columns read as a state machine, behind a backend-agnostic
 *   seam. An operator drives the factory by labelling an issue and moving a
 *   card; this module is the boundary that turns those two observations into a
 *   deterministic decision.
 *
 *   The four pieces, and why each is separate:
 *
 *   - `vocabulary` — the label/column table as DATA. Enumerable at runtime so
 *     the done-means check can bind it to `_DOCS/control-surface.md` and refuse
 *     an undocumented trigger.
 *   - `boundary` — the three NAMED semantic operations (`readLabels`,
 *     `readColumn`, `proposeLabelWrite`). No URL, no REST verb, no GraphQL
 *     document appears in a signature, which is what makes the same call correct
 *     against GitHub REST + Project 11 GraphQL today and Forgejo later.
 *   - `registry` — resolves one surface per backend, fail-closed and enumerable.
 *   - `pass` — observe -> resolve -> log, dispatching nothing in dry-run mode.
 *
 *   Standing constraints this module is written to and does not relax: no AI in
 *   the execution path (resolution is a pure function); k-board stays the
 *   work-state authority (#68 — this reads labels and logs decisions, it writes
 *   no `fleet.tasks` row); `/status.json` is untouched (additive-only for its
 *   consumers); and no new environment key is introduced, per the deployable-
 *   state audit's finding that current `main` adds zero.
 *
 * @outputs
 *   - the vocabulary (`LABEL_JOB_REGISTRY`, `COLUMN_VOCABULARY`, `columnStateFor`)
 *   - the contract (`ControlSurface` and its argument/result types)
 *   - the registry (`createControlSurfaceRegistry`)
 *   - the GitHub backend (`createGitHubControlSurface`)
 *   - resolution (`resolveLabelDecision`) and the pass (`runControlSurfacePass`)
 *
 * @dependencies
 *   - ./vocabulary, ./boundary, ./registry, ./github-backend, ./resolve, ./pass
 */
export type {
	ControlSurface,
	ControlSurfaceRef,
	LabelWriteProposal,
	LabelWriteResult,
} from "./boundary";
export type { GitHubControlSurfaceDeps, ProjectColumnReader } from "./github-backend";
export { createGitHubControlSurface } from "./github-backend";
export type {
	ControlSurfaceDecision,
	ControlSurfaceEvent,
	ControlSurfacePassOptions,
	ControlSurfacePassResult,
} from "./pass";
export { runControlSurfacePass } from "./pass";
export type { ControlSurfaceRegistryDeps, ControlSurfaceResult } from "./registry";
export { ControlSurfaceRegistry, createControlSurfaceRegistry } from "./registry";
export type { LabelDecision } from "./resolve";
export { resolveLabelDecision } from "./resolve";
export type { ColumnState, LabelJobEntry } from "./vocabulary";
export { COLUMN_STATES, COLUMN_VOCABULARY, columnStateFor, LABEL_JOB_REGISTRY } from "./vocabulary";
