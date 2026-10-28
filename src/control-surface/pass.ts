/**
 * @module control-surface/pass
 * @description The observe -> resolve -> log pass: a label flip
 *   is observed, a job is resolved deterministically, a decision is LOGGED, and
 *   in dry-run mode NOTHING is dispatched. This is the mode that makes the
 *   surface testable before the verb jobs exist — the whole point of the
 *   clause is that the control surface can be exercised end to end while the
 *   things it would eventually trigger are still unwritten.
 *
 *   Dry run is the DEFAULT (`dryRun` defaults to true). A pass that dispatches
 *   unless told not to is one omitted argument away from firing a real job while
 *   someone is testing; defaulting to safe means the dangerous behavior must be
 *   asked for explicitly. Dispatch is additionally injected rather than imported,
 *   so a dry run cannot reach a dispatcher it was never handed.
 *
 *   Two invariants matter more than the happy path and are asserted separately
 *   by the done-means check, because either alone is satisfiable by a stub:
 *   the pass DECIDED (a decision was logged naming the resolved job), and it did
 *   NOT ACT (the dispatch boundary recorded zero calls). An implementation that
 *   does nothing at all satisfies "zero dispatches" perfectly, which is why the
 *   decision log is the control.
 *
 *   k-board remains the work-state authority. This pass reads labels and
 *   records decisions; it writes no `fleet.tasks` row and moves no card.
 *
 * @outputs
 *   - `ControlSurfaceEvent` -- one observed label flip
 *   - `ControlSurfaceDecision` -- the logged decision record
 *   - `ControlSurfacePassResult` -- the decisions a pass produced
 *   - `runControlSurfacePass` -- observe, resolve, log; dispatch only when asked
 *
 * @dependencies
 *   - ./boundary -- the semantic control-surface contract
 *   - ./resolve -- deterministic label -> job resolution
 *   - ./vocabulary -- board column -> lifecycle state
 */
import { traced } from "../log";
import type { ControlSurface } from "./boundary";
import { type LabelDecision, resolveLabelDecision } from "./resolve";
import { type ColumnState, columnStateFor } from "./vocabulary";

/** One observed label flip on one item. */
export interface ControlSurfaceEvent {
	readonly repository: string;
	readonly item: number;
	/** The label observed to have flipped, when the caller knows it. */
	readonly label?: string;
}

/** The record a pass logs for each event. Bounded and secret-free. */
export interface ControlSurfaceDecision {
	readonly repository: string;
	readonly item: number;
	readonly observedLabels: readonly string[];
	readonly column: string | null;
	readonly columnState: ColumnState | null;
	readonly decision: LabelDecision;
	/** True when this pass ran in dry-run mode and dispatched nothing. */
	readonly dryRun: boolean;
	/** True only when a dispatch actually happened. */
	readonly dispatched: boolean;
}

export interface ControlSurfacePassResult {
	readonly decisions: readonly ControlSurfaceDecision[];
}

export interface ControlSurfacePassOptions {
	/** The backend-agnostic surface to read through. */
	readonly surface: ControlSurface;
	/** The events to process. */
	readonly events?: readonly ControlSurfaceEvent[];
	/**
	 * The dispatch boundary. Called ONLY when `dryRun` is false and a job
	 * resolved. Injected so a dry run cannot reach a dispatcher at all.
	 */
	readonly dispatch?: (decision: ControlSurfaceDecision) => unknown | Promise<unknown>;
	/** Defaults to TRUE — the safe mode is the one you get by omission. */
	readonly dryRun?: boolean;
	/** Where decisions are recorded. Defaults to collecting them in the result. */
	readonly log?: (decision: ControlSurfaceDecision) => void;
}

/** Read the item's current labels, tolerating a backend that cannot answer. */
async function observeLabels(
	surface: ControlSurface,
	event: ControlSurfaceEvent,
): Promise<string[]> {
	try {
		const labels = await surface.readLabels({
			repository: event.repository,
			item: event.item,
		});
		return Array.isArray(labels) ? labels : [];
	} catch {
		// A backend that cannot answer is "no labels observed", never a crashed
		// pass: the reconciler must survive one unreachable repository.
		return event.label ? [event.label] : [];
	}
}

/** Read the item's board column, tolerating a backend that cannot answer. */
async function observeColumn(
	surface: ControlSurface,
	event: ControlSurfaceEvent,
): Promise<string | null> {
	try {
		return await surface.readColumn({ repository: event.repository, item: event.item });
	} catch {
		return null;
	}
}

/**
 * Observe each event, resolve a job deterministically, and LOG a decision. In
 * dry-run mode (the default) `dispatch` is never called, for any event, whether
 * or not a job resolved.
 */
export const runControlSurfacePass = traced(
	"control-surface.runControlSurfacePass",
	async function runControlSurfacePass(
		options: ControlSurfacePassOptions,
	): Promise<ControlSurfacePassResult> {
		const { surface, events = [], dispatch, dryRun = true, log } = options;
		const decisions: ControlSurfaceDecision[] = [];

		for (const event of events) {
			const observedLabels = await observeLabels(surface, event);
			const column = await observeColumn(surface, event);
			const resolved = resolveLabelDecision(observedLabels);

			const shouldDispatch = !dryRun && resolved.job !== null && typeof dispatch === "function";
			const decision: ControlSurfaceDecision = {
				repository: event.repository,
				item: event.item,
				observedLabels,
				column,
				columnState: columnStateFor(column),
				decision: resolved,
				dryRun,
				dispatched: shouldDispatch,
			};

			// The decision is logged BEFORE any dispatch, so a dispatch that throws
			// still leaves the observation on the record.
			decisions.push(decision);
			log?.(decision);

			if (shouldDispatch) {
				await dispatch?.(decision);
			}
		}

		return { decisions };
	},
);
