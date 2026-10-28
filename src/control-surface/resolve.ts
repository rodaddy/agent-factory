/**
 * @module control-surface/resolve
 * @description Deterministic label -> job resolution (and the
 *   standing "no AI in the execution path" constraint — rtech-infra ledger row
 *   36). Resolution is a pure function of the labels and the vocabulary table:
 *   the same input yields the same decision on every run, on every host, with no
 *   model, no network, and no clock.
 *
 *   The function NEVER throws and NEVER returns nullish. Both are failure modes
 *   #253 names by hand, and they are different defects: a throw crashes the pass
 *   that was merely reading an unrecognised label, while a silent nullish return
 *   is indistinguishable from "nothing happened" and loses the event. The
 *   contract is therefore an EXPLICIT no-decision — a decision object whose
 *   `job` is null and which carries a `reason` naming why — so the caller can
 *   log the observation either way.
 *
 *   Precedence is EXACT-MATCH BEFORE PREFIX, and first-listed wins among equals.
 *   That ordering is deterministic by construction rather than by iteration
 *   accident: `LABEL_JOB_REGISTRY` is scanned in declaration order for an exact
 *   hit before any parameterized stem is considered, so adding a `deploy:` verb
 *   row can never shadow an exact label added later.
 *
 * @outputs
 *   - `LabelDecision` -- the explicit decision object (job may be null)
 *   - `resolveLabelDecision` -- deterministic labels -> decision
 *
 * @dependencies
 *   - ./vocabulary -- the enumerable label -> job table
 *   - ../templates/registry -- the closed allowlist of job template ids
 */
import { traced } from "../log";
import type { JobTemplateId } from "../templates/registry";
import { LABEL_JOB_REGISTRY, type LabelJobEntry } from "./vocabulary";

/**
 * The result of resolving labels. ALWAYS an object: `job` null means no
 * dispatchable job, and `reason` says which of the several no-job cases it was.
 */
export interface LabelDecision {
	/** The allowlisted template proposed, or null for an explicit no-decision. */
	readonly job: JobTemplateId | null;
	/** The vocabulary label that matched, or null when none did. */
	readonly label: string | null;
	/** The parameter carried by a `deploy:<app>`-shaped label, when present. */
	readonly parameter: string | null;
	/** Why this decision was reached. Always populated when `job` is null. */
	readonly reason: string;
}

/** Find the first exact-match vocabulary row for any of `labels`. */
function matchExact(labels: readonly string[], rows: readonly LabelJobEntry[]) {
	for (const row of rows) {
		if (row.parameterized) {
			continue;
		}
		if (labels.includes(row.label)) {
			return { row, parameter: null as string | null };
		}
	}
	return null;
}

/** Find the first parameterized (`prefix:`) vocabulary row matching a label. */
function matchParameterized(labels: readonly string[], rows: readonly LabelJobEntry[]) {
	for (const row of rows) {
		if (!row.parameterized) {
			continue;
		}
		for (const label of labels) {
			if (label.startsWith(row.label) && label.length > row.label.length) {
				return { row, parameter: label.slice(row.label.length) };
			}
		}
	}
	return null;
}

/**
 * Resolve labels to a decision, deterministically. `registry` is injectable so a
 * test can drive a different vocabulary without touching the shipped table.
 */
export const resolveLabelDecision = traced(
	"control-surface.resolveLabelDecision",
	function resolveLabelDecision(
		labels: readonly string[] | null | undefined,
		registry: readonly LabelJobEntry[] = LABEL_JOB_REGISTRY,
	): LabelDecision {
		const present = Array.isArray(labels) ? labels.filter((l) => typeof l === "string") : [];
		if (present.length === 0) {
			return { job: null, label: null, parameter: null, reason: "no labels present on the item" };
		}

		const matched = matchExact(present, registry) ?? matchParameterized(present, registry);
		if (!matched) {
			return {
				job: null,
				label: null,
				parameter: null,
				reason: `no vocabulary entry matches any of: ${present.join(", ")}`,
			};
		}

		const { row, parameter } = matched;
		if (row.job === null) {
			return {
				job: null,
				label: row.label,
				parameter,
				reason: `label '${row.label}' is recognised but maps to no dispatchable job yet`,
			};
		}
		return { job: row.job, label: row.label, parameter, reason: `label '${row.label}' resolved` };
	},
);
