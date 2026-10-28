/**
 * @module src/jev/harvest
 * @description Turn this repo's "Fix round" review tables into labelled Jev
 *   examples. Every reviewed PR records one row per finding with a
 *   disposition; that disposition is the ground truth for "defect" versus
 *   "hardening ask". Pure functions, no I/O: `scripts/jev/harvest.ts` reads Forge.
 */

export interface FixRow {
	round: number;
	severity: string;
	finding: string;
	disposition: string;
	evidence: string;
}
export interface Example {
	fields: Record<string, string>;
	expect: string;
}

const HEADING = /^## (?:Fix round|Round) (\d+)/;
const SEPARATOR_CELL = /^:?-+:?$/;

/** The cells of one table line: split on `|` outside a backtick span, trimmed. */
function splitCells(line: string): string[] {
	const cells: string[] = [];
	let cell = "";
	let inCode = false;
	for (const ch of line) {
		if (ch === "`") inCode = !inCode;
		if (ch === "|" && !inCode) {
			cells.push(cell.trim());
			cell = "";
		} else {
			cell += ch;
		}
	}
	cells.push(cell.trim());
	// A table line opens and closes with `|`, which leaves an empty cell at each end.
	if (cells[0] === "") cells.shift();
	if (cells[cells.length - 1] === "") cells.pop();
	return cells;
}

function isFixRoundHeader(cells: string[]): boolean {
	const [a, b, c, d] = cells;
	return (
		cells.length === 4 &&
		a === "#" &&
		b === "Finding" &&
		c === "Disposition" &&
		(d === "Evidence" || d === "Reason")
	);
}

/** Every row of every fix-round table in one comment body. */
export function parseFixRounds(body: string): FixRow[] {
	const lines = body.split("\n").map((l) => l.trimEnd());
	const rows: FixRow[] = [];
	for (let i = 0; i < lines.length; i++) {
		const heading = HEADING.exec(lines[i] ?? "");
		if (heading === null) continue;
		const round = Number(heading[1]);
		// The table is the first `|` line under this heading, before any other heading.
		let at = i + 1;
		while (at < lines.length && !lines[at]?.startsWith("|") && !lines[at]?.startsWith("#")) at++;
		const header = lines[at] ?? "";
		if (!header.startsWith("|") || !isFixRoundHeader(splitCells(header))) continue;
		for (at++; at < lines.length && lines[at]?.startsWith("|"); at++) {
			const cells = splitCells(lines[at] ?? "");
			if (cells.length > 0 && cells.every((c) => SEPARATOR_CELL.test(c))) continue;
			rows.push({
				round,
				severity: cells[0] ?? "",
				finding: cells[1] ?? "",
				disposition: cells[2] ?? "",
				evidence: cells[3] ?? "",
			});
		}
	}
	return rows;
}

/** The label a recorded disposition stands for, or null when it cannot be read. */
export function labelForDisposition(disposition: string): "defect" | "hardening ask" | null {
	const d = disposition.trim().toLowerCase();
	// `accepted` is a true finding, deferred: still a defect.
	if (d.startsWith("fixed") || d.startsWith("accepted")) return "defect";
	if (d.startsWith("disagree")) return "hardening ask";
	return null;
}

/** Deterministic split: an item whose number is divisible by 5 is held out. */
export function isHeldOut(itemNumber: number): boolean {
	return itemNumber % 5 === 0;
}

/** One example per readable row; unreadable rows are counted, never guessed. */
export function examplesFrom(
	prTitle: string,
	rows: FixRow[],
): { examples: Example[]; skipped: number } {
	const examples: Example[] = [];
	let skipped = 0;
	for (const row of rows) {
		const label = labelForDisposition(row.disposition);
		if (label === null || row.finding === "") {
			skipped++;
			continue;
		}
		examples.push({
			fields: { pr_title: prTitle, severity: row.severity, finding: row.finding },
			expect: label,
		});
	}
	return { examples, skipped };
}
