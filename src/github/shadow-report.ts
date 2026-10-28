/**
 * @module github/shadow-report
 * @description Read the shadow-mode ledger and emit a bounded, human-readable
 *   comparison record. During a shadow period the publisher records what it WOULD
 *   have posted to GitHub into `shadow_publications` instead of posting it; this
 *   turns those rows into a per-item summary a human (or CI) can line up against
 *   the repository's OWN Actions result: for each item/commit it shows the
 *   intended check conclusion, the intended label transition, and the comment
 *   dedupe marker - plus whether the write WOULD have been a create or a dedupe.
 *
 *   The output is hard-bounded on every axis (rows read, items rendered, lines
 *   per item, characters per line) so a large ledger can never produce an
 *   unbounded report. Every value comes from already-bounded ledger columns - no
 *   raw runner output is read here.
 *
 * @outputs
 *   - `buildShadowReport` -- read the ledger into a bounded, ordered report
 *   - `renderShadowReport` -- format a report as a bounded plain-text block
 *   - `ShadowReport` / `ShadowReportItem` -- the structured report shapes
 *
 * @dependencies
 *   - drizzle-orm -- the bounded ledger read
 *   - ../db/schema -- shadow_publications
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { asc, inArray } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { shadowPublications } from "../db/schema";
import { traced } from "../log";

/** Hard cap on ledger rows scanned for one report. */
export const MAX_SHADOW_ROWS = 2000;
/** Hard cap on distinct items rendered into one report. */
export const MAX_REPORT_ITEMS = 200;
/** Hard cap on characters of any single rendered value. */
const MAX_VALUE_CHARS = 200;

/** One intended publication as recorded in the ledger, bounded for display. */
export interface ShadowEntry {
	kind: string;
	target: string;
	/**
	 * The publication action within the kind: `add`/`remove` for a label, the
	 * natural upsert for checks/comments. Null for pre-column ledger rows.
	 */
	action: string | null;
	/** `created` (would POST) or `deduped` (would PATCH the job's own prior write). */
	wouldAction: string;
	dedupeKey: string;
	/** Check-run conclusion, when the entry is a check. */
	conclusion: string | null;
}

/** The intended publications for one (repository, item/SHA) grouping. */
export interface ShadowReportItem {
	repository: string;
	itemNumber: number | null;
	sha: string | null;
	/** The intended check conclusion for the commit, when a check was recorded. */
	checkConclusion: string | null;
	/**
	 * The single label name that would be ADDED. Derived ONLY from the label row
	 * whose `action` is `add`, never from a removal — so a PASSED job renders the
	 * label it adds, not the last-processed removal.
	 */
	addedLabel: string | null;
	/** The label names that would be REMOVED (the fixed non-matching labels). */
	removedLabels: string[];
	/** The comment dedupe marker, when a comment write was recorded. */
	commentMarker: string | null;
	/** Every intended publication for this grouping, bounded. */
	entries: ShadowEntry[];
	/** True when the ledger was truncated at the per-item entry bound. */
	truncated: boolean;
}

/** A bounded shadow-vs-GitHub comparison report over one ledger scan. */
export interface ShadowReport {
	/** Ledger rows scanned (bounded by MAX_SHADOW_ROWS). */
	scanned: number;
	/** True when more ledger rows exist than were scanned. */
	scanTruncated: boolean;
	/** True when more distinct items exist than were rendered. */
	itemsTruncated: boolean;
	items: ShadowReportItem[];
}

/** Bound a single display value to a conservative length. */
function cap(value: string): string {
	return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS - 1)}\u2026` : value;
}

/** Group key for one (repository, item, SHA) publication target. */
function groupKey(repository: string, itemNumber: number | null, sha: string | null): string {
	return `${repository}\u0000${itemNumber ?? ""}\u0000${sha ?? ""}`;
}

/** One raw ledger row projected for the report. */
interface LedgerRow {
	kind: string;
	action: string | null;
	repository: string;
	itemNumber: number | null;
	sha: string | null;
	wouldAction: string;
	target: string;
	dedupeKey: string;
	conclusion: string | null;
}

/** A fresh, empty report item for the given (repo, item, SHA) grouping. */
function newItem(row: LedgerRow): ShadowReportItem {
	return {
		repository: cap(row.repository),
		itemNumber: row.itemNumber,
		sha: row.sha,
		checkConclusion: null,
		addedLabel: null,
		removedLabels: [],
		commentMarker: null,
		entries: [],
		truncated: false,
	};
}

/**
 * Fold one ledger row into its report item: set the salient per-kind fields (the
 * added label comes ONLY from an `add` row; removals accumulate separately) and
 * append the bounded entry list, noting per-item truncation.
 */
function enrichItem(item: ShadowReportItem, row: LedgerRow): void {
	if (row.kind === "check" && row.conclusion !== null) {
		item.checkConclusion = cap(row.conclusion);
	}
	if (row.kind === "label") {
		// The single ADD is the salient signal; every other fixed label is a removal.
		// Distinguish by the recorded action so a removal can never masquerade as the
		// added label (both `create` a ledger row).
		if (row.action === "add") {
			item.addedLabel = cap(row.target);
		} else if (row.action === "remove") {
			item.removedLabels.push(cap(row.target));
		}
	}
	if (row.kind === "comment") {
		item.commentMarker = cap(row.dedupeKey);
	}

	// Cap the per-item entry list; note truncation rather than dropping silently.
	if (item.entries.length < 32) {
		item.entries.push({
			kind: cap(row.kind),
			target: cap(row.target),
			action: row.action === null ? null : cap(row.action),
			wouldAction: cap(row.wouldAction),
			dedupeKey: cap(row.dedupeKey),
			conclusion: row.conclusion === null ? null : cap(row.conclusion),
		});
	} else {
		item.truncated = true;
	}
}

/**
 * Read the shadow ledger into a bounded, ordered comparison report.
 *
 * Rows are scanned oldest-first up to `MAX_SHADOW_ROWS`, grouped by
 * (repository, item, SHA), and each group's salient intended writes are
 * summarized. Grouping and per-group entry lists are hard-capped, and the report
 * flags every place a bound was hit so a truncation is never read as completeness.
 *
 * @param db - watcher database
 * @param maxRows - override the ledger scan cap (bounded to MAX_SHADOW_ROWS)
 */
export const buildShadowReport = traced(
	"github.buildShadowReport",
	async function buildShadowReport(
		db: WatcherDb,
		maxRows = MAX_SHADOW_ROWS,
	): Promise<ShadowReport> {
		const limit = Math.max(1, Math.min(maxRows, MAX_SHADOW_ROWS));
		// Read one row past the cap to detect (but never render) a truncated scan.
		const rows = await db
			.select({
				kind: shadowPublications.kind,
				action: shadowPublications.action,
				repository: shadowPublications.repository,
				itemNumber: shadowPublications.itemNumber,
				sha: shadowPublications.sha,
				wouldAction: shadowPublications.wouldAction,
				target: shadowPublications.target,
				dedupeKey: shadowPublications.dedupeKey,
				conclusion: shadowPublications.conclusion,
			})
			.from(shadowPublications)
			.orderBy(asc(shadowPublications.id))
			.limit(limit + 1);

		const scanTruncated = rows.length > limit;
		const scanned = Math.min(rows.length, limit);

		const groups = new Map<string, ShadowReportItem>();
		let itemsTruncated = false;

		for (let i = 0; i < scanned; i++) {
			const row = rows[i];
			if (row === undefined) continue;
			const key = groupKey(row.repository, row.itemNumber, row.sha);
			let item = groups.get(key);
			if (item === undefined) {
				if (groups.size >= MAX_REPORT_ITEMS) {
					// The distinct-item bound is hit; skip further NEW groups but keep
					// enriching the ones already rendered so their summaries stay complete.
					itemsTruncated = true;
					continue;
				}
				item = newItem(row);
				groups.set(key, item);
			}
			enrichItem(item, row);
		}

		return {
			scanned,
			scanTruncated,
			itemsTruncated,
			items: [...groups.values()],
		};
	},
);

/**
 * Format a shadow report as a bounded plain-text block a human or CI can diff
 * against the repository's own Actions result. Every shadow row for a PR carries
 * BOTH the trusted item number and SHA, so a PR's check and its label/comment
 * intent correlate into ONE per-item block rather than splitting apart:
 *
 *   rodaddy/open-brain #42 @abcdef1
 *     check:   conclusion=success
 *     label:   +watcher:passed (removes: watcher:failed, watcher:error, watcher:skipped)
 *     comment: marker=software-factory:comment:job-7 (deduped)
 *
 * The `+` label is the single ADD (from the ledger's `action=add` row); the
 * removals are the fixed non-matching labels. Every line is derived from
 * already-bounded ledger values.
 */
export const renderShadowReport = traced(
	"github.renderShadowReport",
	function renderShadowReport(report: ShadowReport): string {
		const lines: string[] = [];
		lines.push(
			`shadow report: ${report.items.length} item(s), ${report.scanned} ledger row(s) scanned` +
				(report.scanTruncated ? " (scan truncated)" : "") +
				(report.itemsTruncated ? " (items truncated)" : ""),
		);

		for (const item of report.items) {
			const head = [
				item.repository,
				item.itemNumber === null ? "" : `#${item.itemNumber}`,
				item.sha === null ? "" : `@${item.sha}`,
			]
				.filter(Boolean)
				.join(" ");
			lines.push(head);
			if (item.checkConclusion !== null) {
				lines.push(`  check:   conclusion=${item.checkConclusion}`);
			}
			if (item.addedLabel !== null) {
				const removes =
					item.removedLabels.length > 0 ? ` (removes: ${item.removedLabels.join(", ")})` : "";
				lines.push(`  label:   +${item.addedLabel}${removes}`);
			}
			if (item.commentMarker !== null) {
				// Surface whether the comment WOULD dedupe onto an existing marked comment.
				const commentEntry = item.entries.find((e) => e.kind === "comment");
				const action = commentEntry ? ` (${commentEntry.wouldAction})` : "";
				lines.push(`  comment: marker=${item.commentMarker}${action}`);
			}
			if (item.truncated) {
				lines.push("  \u2026 more entries omitted");
			}
		}

		return lines.join("\n");
	},
);

/**
 * Convenience: build a shadow report restricted to the given job ids only.
 *
 * Bounded on the same axes as `buildShadowReport`: the ledger scan is capped
 * (over-read by one to flag a truncated scan), the distinct-item map is capped at
 * `MAX_REPORT_ITEMS`, and every bound hit is surfaced (`scanTruncated` /
 * `itemsTruncated`) so a truncation is never read as completeness.
 *
 * @param db - watcher database
 * @param jobIds - the jobs to restrict the report to
 * @param maxRows - override the ledger scan cap (bounded to MAX_SHADOW_ROWS)
 */
export const buildShadowReportForJobs = traced(
	"github.buildShadowReportForJobs",
	async function buildShadowReportForJobs(
		db: WatcherDb,
		jobIds: readonly number[],
		maxRows = MAX_SHADOW_ROWS,
	): Promise<ShadowReport> {
		if (jobIds.length === 0) {
			return { scanned: 0, scanTruncated: false, itemsTruncated: false, items: [] };
		}
		const limit = Math.max(1, Math.min(maxRows, MAX_SHADOW_ROWS));
		// Read one row past the cap to detect a truncated scan, same as the sibling
		// builder — a bounded scan must never be reported as completeness.
		const rows = await db
			.select({
				kind: shadowPublications.kind,
				action: shadowPublications.action,
				repository: shadowPublications.repository,
				itemNumber: shadowPublications.itemNumber,
				sha: shadowPublications.sha,
				wouldAction: shadowPublications.wouldAction,
				target: shadowPublications.target,
				dedupeKey: shadowPublications.dedupeKey,
				conclusion: shadowPublications.conclusion,
			})
			.from(shadowPublications)
			.where(inArray(shadowPublications.jobId, [...jobIds]))
			.orderBy(asc(shadowPublications.id))
			.limit(limit + 1);

		const scanTruncated = rows.length > limit;
		const scanned = Math.min(rows.length, limit);

		const { items, itemsTruncated } = groupShadowRows(rows, scanned);

		return { scanned, scanTruncated, itemsTruncated, items };
	},
);

/**
 * Group the first `scanned` ledger rows by `(repository, item, sha)`.
 *
 * Bounded by `MAX_REPORT_ITEMS` DISTINCT items: past the cap, new groups are
 * skipped (and reported as truncated) but the already-rendered ones keep being
 * enriched, so no rendered summary is left partial by the bound.
 */
function groupShadowRows(
	rows: readonly LedgerRow[],
	scanned: number,
): { items: ShadowReportItem[]; itemsTruncated: boolean } {
	const groups = new Map<string, ShadowReportItem>();
	let itemsTruncated = false;
	for (let i = 0; i < scanned; i++) {
		const row = rows[i];
		if (row === undefined) continue;
		const key = groupKey(row.repository, row.itemNumber, row.sha);
		let item = groups.get(key);
		if (item === undefined) {
			if (groups.size >= MAX_REPORT_ITEMS) {
				itemsTruncated = true;
				continue;
			}
			item = newItem(row);
			groups.set(key, item);
		}
		enrichItem(item, row);
	}
	return { items: [...groups.values()], itemsTruncated };
}
