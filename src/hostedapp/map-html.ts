/**
 * @module hostedapp/map-html
 * @description Render a `MapModel` as one self-contained HTML page: inline CSS,
 *   no external assets, no JavaScript, every value HTML-escaped. Kept apart from
 *   `./map` so the model can be asserted without parsing HTML, and so neither
 *   file approaches this repo's 500-line budget.
 *
 *   NO SCRIPT, DELIBERATELY. The page is read by an operator and by whatever
 *   later serves it; a table needs no behaviour, and the values it interpolates
 *   come from repository content and a cluster snapshot — untrusted input that
 *   an escaping-only surface bounds completely.
 *
 * @outputs
 *   - `renderMapHtml` -- `MapModel` -> a complete HTML document
 *
 * @dependencies
 *   - ./map -- the model shape and the no-snapshot text
 *   - ../log -- the one logger, for the traced() wrapper
 */

import { traced } from "../log";
import type { MapModel, MapRow, UnregisteredRow } from "./map";
import { NO_SNAPSHOT } from "./map";

/** Escape a string for safe HTML text/attribute interpolation. */
export const escapeHtml = traced(
	"hostedapp.escapeHtml",
	function escapeHtml(value: string): string {
		return value
			.replace(/&/g, "&amp;")
			.replace(/</g, "&lt;")
			.replace(/>/g, "&gt;")
			.replace(/"/g, "&quot;")
			.replace(/'/g, "&#39;");
	},
);

const STYLE = `
:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 2rem; }
h1 { font-size: 1.3rem; }
h2 { font-size: 1.05rem; margin-top: 2rem; }
table { border-collapse: collapse; width: 100%; margin-top: 1rem; font-size: 0.85rem; }
th, td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #8884; vertical-align: top; }
th { font-weight: 600; }
th.group { border-bottom: 2px solid #8888; }
.declared { background: #1a7f3712; }
.rendered { background: #0969da12; }
.running { background: #8250df12; }
.counts { margin: 0; padding: 0; list-style: none; display: flex; flex-wrap: wrap; gap: 1rem; }
.counts li { border: 1px solid #8884; border-radius: 0.4rem; padding: 0.3rem 0.7rem; }
.counts .n { font-weight: 700; font-size: 1.1rem; display: block; }
.badge { display: inline-block; padding: 0.05rem 0.4rem; border-radius: 0.4rem; font-size: 0.75rem; margin: 0 0.2rem 0.2rem 0; }
.warn { background: #bf8700; color: #fff; }
.bad { background: #cf222e; color: #fff; }
.ok { background: #1a7f37; color: #fff; }
.muted { color: #8888; }
.mono { font-family: ui-monospace, monospace; word-break: break-all; }
`.trim();

/** A `<td>` carrying already-escaped inner HTML. */
function cell(html: string, cls?: string): string {
	return cls === undefined ? `<td>${html}</td>` : `<td class="${cls}">${html}</td>`;
}

/** Escape a value, rendering an empty one as a muted em dash. */
function text(value: string | undefined): string {
	return value === undefined || value === "" ? '<span class="muted">—</span>' : escapeHtml(value);
}

/** The Rendered group's two cells for one row. */
function renderedCells(row: MapRow): string {
	if (!row.rendered.application && !row.rendered.manifests) {
		return (
			cell('<span class="badge warn">not rendered</span>', "rendered") +
			cell('<span class="muted">—</span>', "rendered")
		);
	}
	const parts: string[] = [];
	parts.push(
		row.rendered.application
			? '<span class="badge ok">apps/</span>'
			: '<span class="badge warn">no apps/</span>',
	);
	parts.push(
		row.rendered.manifests
			? '<span class="badge ok">manifests/</span>'
			: '<span class="badge warn">no manifests/</span>',
	);
	return (
		cell(parts.join(" "), "rendered") +
		cell(`<span class="mono">${text(row.rendered.image)}</span>`, "rendered")
	);
}

/** The Running group's three cells for one row. */
function runningCells(row: MapRow, hasSnapshot: boolean): string {
	if (!hasSnapshot) {
		const unknown = `<span class="muted">${escapeHtml(NO_SNAPSHOT)}</span>`;
		return cell(unknown, "running") + cell(unknown, "running") + cell(unknown, "running");
	}
	if (row.running === undefined) {
		return (
			cell('<span class="badge warn">not running</span>', "running") +
			cell('<span class="muted">—</span>', "running") +
			cell('<span class="muted">—</span>', "running")
		);
	}
	const health = row.running.health === "Healthy" ? "ok" : "warn";
	return (
		cell(
			`<span class="badge ${health}">${escapeHtml(row.running.health)}</span> ` +
				`${escapeHtml(row.running.sync)}`,
			"running",
		) +
		cell(`<span class="mono">${text(row.running.revision)}</span>`, "running") +
		cell(`<span class="mono">${text(row.running.images.join(", "))}</span>`, "running")
	);
}

/** The disagreement badges for one row, or a muted dash when there are none. */
function badges(row: MapRow): string {
	if (row.disagreements.length === 0) return '<span class="muted">—</span>';
	return row.disagreements.map((d) => `<span class="badge bad">${escapeHtml(d)}</span>`).join(" ");
}

/** One `<tr>`: an invalid entry collapses to its file name and first problem. */
function renderRow(row: MapRow, hasSnapshot: boolean): string {
	if (row.verdict === "invalid") {
		return (
			`<tr>${cell(escapeHtml(row.app))}${cell('<span class="badge bad">invalid</span>')}` +
			`<td colspan="11">${text(row.problem)}</td></tr>`
		);
	}
	return (
		`<tr>${cell(escapeHtml(row.app))}${cell(escapeHtml(row.target))}` +
		cell(escapeHtml(row.declared.repo), "declared") +
		cell(`<span class="mono">${text(row.declared.ref)}</span>`, "declared") +
		cell(`${text(row.declared.on)} / ${text(row.declared.by)}`, "declared") +
		cell(`${text(row.declared.state)} / ${text(row.declared.merge)}`, "declared") +
		cell(`<span class="mono">${text(row.declared.image)}</span>`, "declared") +
		renderedCells(row) +
		runningCells(row, hasSnapshot) +
		cell(badges(row)) +
		"</tr>"
	);
}

const HEAD_GROUPS =
	'<tr><th class="group" colspan="2"></th>' +
	'<th class="group declared" colspan="5">Declared</th>' +
	'<th class="group rendered" colspan="2">Rendered</th>' +
	'<th class="group running" colspan="3">Running</th>' +
	'<th class="group"></th></tr>';

const HEAD_COLUMNS =
	"<tr><th>app</th><th>target</th>" +
	"<th>repo</th><th>ref</th><th>accepted</th><th>state / merge</th><th>accepted image</th>" +
	"<th>files</th><th>rendered image</th>" +
	"<th>health / sync</th><th>revision</th><th>running image</th>" +
	"<th>disagreements</th></tr>";

/** The trailing table of Applications running under a dropped target. */
function unregisteredTable(rows: readonly UnregisteredRow[]): string {
	if (rows.length === 0) return "";
	const body = rows
		.map(
			(r) =>
				`<tr>${cell(escapeHtml(r.app.name))}${cell(escapeHtml(r.matchedApp))}` +
				`${cell(escapeHtml(r.target))}` +
				`${cell(`<span class="badge bad">running but not in registry</span>`)}` +
				`${cell(`<span class="mono">${text(r.app.images.join(", "))}</span>`)}</tr>`,
		)
		.join("");
	return (
		"<h2>Unregistered</h2>" +
		"<p>Argo Applications whose name matches a registry app at a target the " +
		"registry no longer lists.</p>" +
		"<table><thead><tr><th>application</th><th>app</th><th>target</th>" +
		"<th>disagreement</th><th>running image</th></tr></thead>" +
		`<tbody>${body}</tbody></table>`
	);
}

/** The counts strip at the top of the page. */
function countsList(model: MapModel): string {
	const c = model.counts;
	const items: [string, number][] = [
		["apps", c.apps],
		["targets", c.targets],
		["rendered", c.rendered],
		["running healthy", c.runningHealthy],
		["disagreements", c.disagreements],
		["invalid entries", c.invalid],
	];
	const li = items
		.map(([label, n]) => `<li><span class="n">${n}</span>${escapeHtml(label)}</li>`)
		.join("");
	return `<ul class="counts">${li}</ul>`;
}

/** The provenance line: when the page was generated, and from which shas. */
function provenance(model: MapModel): string {
	const parts = [`generated ${escapeHtml(model.generatedAt)}`];
	parts.push(
		`registry ${model.registrySha === undefined ? "unknown" : escapeHtml(model.registrySha)}`,
	);
	parts.push(
		`k3s-deploy ${model.k3sDeploySha === undefined ? "unknown" : escapeHtml(model.k3sDeploySha)}`,
	);
	if (!model.hasSnapshot) parts.push(escapeHtml(NO_SNAPSHOT));
	return `<p class="muted">${parts.join(" · ")}</p>`;
}

/**
 * Render the model as one self-contained HTML document.
 *
 * @param model - the built map
 * @returns a complete HTML page: inline CSS, no scripts, everything escaped
 */
export const renderMapHtml = traced(
	"hostedapp.renderMapHtml",
	function renderMapHtml(model: MapModel): string {
		const body =
			model.rows.length === 0
				? "<p>The registry declares no applications.</p>"
				: "<table><thead>" +
					HEAD_GROUPS +
					HEAD_COLUMNS +
					"</thead><tbody>" +
					model.rows.map((r) => renderRow(r, model.hasSnapshot)).join("") +
					"</tbody></table>";
		return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Hosted apps</title>
<style>${STYLE}</style>
</head>
<body>
<h1>Hosted apps</h1>
${provenance(model)}
${countsList(model)}
${body}
${unregisteredTable(model.unregistered)}
</body>
</html>
`;
	},
);
