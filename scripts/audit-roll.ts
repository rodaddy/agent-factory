/**
 * @module scripts/audit-roll
 * @description The random audit roll (ledger L-007): the controller runs
 *   this once at each merge pass, and roughly one pass in five it names an
 *   already-accepted lane report for an auditor lane to re-check.
 *
 *   L-007's finding is that truthfulness of report fields cannot be verified
 *   per-report. `scripts/check-lane-report.ts` (L-002) proves SHAPE — all 11
 *   fields present, `red` carrying evidence — and says nothing about whether
 *   `deviations: none` is true. `scripts/check-harvest-binding.ts` (L-003)
 *   proves a report's filename was CITED in the contract, never that the lesson
 *   was transcribed faithfully. Auditing every report re-creates the flat
 *   ceremony cost L-005 removes. The RLVR economics fix is a spot check: at
 *   ~20%, the expected cost of fabricating a field exceeds the cost of
 *   disclosing the thing being hidden, and the per-report cost stays zero.
 *
 *   **The operator caveat is BINDING and is the reason this exits 0 always.**
 *   The audit is the backstop BEHIND the schema validator and the harvest
 *   binding — never the primary control, or it degrades into security theatre
 *   at 1-in-5, refusing four passes in five for nothing and being routed around
 *   on the fifth. So this script is advisory by construction: it is NOT in the
 *   `bun run check` chain, it has no failure mode that refuses, and an empty or
 *   missing reports directory is loud rather than fatal. A future edit that
 *   gives it a non-zero exit has made it the primary control the ruling
 *   forbids; `tests/scripts/audit-roll.test.ts` pins that as executable.
 *
 *   Randomness is real and injected, not seeded. A seeded or date-derived roll
 *   is predictable, and a predictable audit prices fabrication at zero on the
 *   passes known to be misses — the whole mechanism is the UNCERTAINTY. The
 *   injection exists so tests can force a hit and a miss (the
 *   `scripts/land.ts` injected-boundary shape, done-means rule 11); the CLI
 *   entry wires `Math.random`.
 *
 *   What a hit obliges is CONTROLLER work, specified in
 *   `_DOCS/controller-contract.md`: dispatch an auditor lane before the next
 *   merge pass. Nothing here dispatches anything — automating the auditor is an
 *   explicit non-goal, because which findings matter is judgment.
 *
 * @outputs
 *   - always exit 0
 *   - `audit-roll: SKIP (rolled N of 5)` on a miss
 *   - `audit-roll: AUDIT <basename> (rolled N of 5)` on a hit
 *   - `audit-roll: 0 reports to audit (directory empty)` when there is nothing
 *     to pick, including when the directory is absent
 *
 * @dependencies
 *   - node:fs — read the committed reports directory
 */
import { readdirSync } from "node:fs";

/**
 * The directory of committed lane reports, relative to the working directory.
 * The same directory `check-lane-report.ts` and `check-harvest-binding.ts`
 * sweep: the audit re-checks reports that have already been ACCEPTED, which is
 * exactly the set living here.
 */
export const DEFAULT_DIR = "_reports/lane-reports";

/**
 * Environment variable overriding the reports directory, matching the
 * convention in `scripts/check-harvest-binding.ts` and
 * `scripts/check-tightenings-budget.ts`. Author-owned and read only here: it
 * exists so tests can point at a fixture directory instead of the live one,
 * which would otherwise couple every fixture to whichever reports happen to be
 * committed today.
 */
export const AUDIT_DIR_ENV = "AUDIT_ROLL_REPORTS_DIR";

/** Faces on the die. Five faces is the ~20% rate ledger L-007 ratified. */
export const ROLL_FACES = 5;

/**
 * The face that triggers an audit. Any single face gives the same 1-in-5 rate;
 * naming it as a constant keeps the tests from hard-coding a magic number and
 * makes the "exactly one face hits" property visible.
 */
export const HIT_FACE = 1;

/**
 * The injected randomness boundary: a function returning a value in `[0, 1)`,
 * the `Math.random` contract. Injected rather than seeded — see the module note
 * on why a predictable roll prices fabrication at zero.
 */
export type RandomSource = () => number;

/** A line sink, so tests capture output instead of the process writing it. */
export type Sink = (line: string) => void;

/** Everything the roll needs: the directory, the randomness, and its sink. */
export interface AuditRollOptions {
	readonly dir: string;
	readonly random: RandomSource;
	readonly out: Sink;
}

/**
 * Report files in `dir`: `*.md`, excluding `README.md`, in stable sorted order.
 * A directory that cannot be read yields an empty list rather than throwing —
 * the roll is advisory, so an absent directory is a loud nothing-to-audit, not
 * a failure. Sorted so the uniform pick is over a deterministic ordering and a
 * forced index in a test names a predictable file.
 */
function reportFiles(dir: string): string[] {
	let entries: string[];
	try {
		entries = readdirSync(dir);
	} catch {
		return [];
	}
	return entries.filter((name) => name.endsWith(".md") && name !== "README.md").sort();
}

/**
 * Roll the die and, on a hit, name one report uniformly. Returns the process
 * exit code, which is ALWAYS 0 — the caveat, expressed as the only return this
 * function has.
 */
export function auditRoll(options: AuditRollOptions): number {
	// Emptiness is judged BEFORE the die, and this ordering is load-bearing.
	// Checking it only on a hit makes the "nothing to audit" signal itself
	// random: four passes in five would print a cheerful SKIP over a directory
	// the roll could never have audited, and a misconfigured path would take an
	// expected five merge passes to surface. That is the trap #84 shape — a
	// silently absent gate looking identical to a passing one — reintroduced
	// through the roll instead of through a missing hook. The die is not
	// consulted at all here, so the RNG is drawn exactly zero times.
	const files = reportFiles(options.dir);
	if (files.length === 0) {
		options.out("audit-roll: 0 reports to audit (directory empty)");
		return 0;
	}

	const roll = Math.floor(options.random() * ROLL_FACES) + 1;

	if (roll !== HIT_FACE) {
		options.out(`audit-roll: SKIP (rolled ${roll} of ${ROLL_FACES})`);
		return 0;
	}

	// Clamped rather than trusted: `Math.random()` is `[0, 1)`, but the source is
	// injected and an out-of-contract value would index past the end and print an
	// empty basename — a hit that names nothing reads exactly like a hit that
	// named something.
	const index = Math.min(
		files.length - 1,
		Math.max(0, Math.floor(options.random() * files.length)),
	);
	options.out(`audit-roll: AUDIT ${files[index]} (rolled ${roll} of ${ROLL_FACES})`);
	return 0;
}

if (import.meta.main) {
	const dir = process.env[AUDIT_DIR_ENV]?.trim() || DEFAULT_DIR;
	// No `.catch` wrapper is needed because nothing here is async, but the
	// failure mode done-means rule 7 names still applies in the other direction:
	// a throw must not become a non-zero exit that turns the backstop into a
	// gate. `reportFiles` already swallows the only I/O that can throw.
	process.exitCode = auditRoll({
		dir,
		random: () => Math.random(),
		out: (line) => {
			console.log(line);
		},
	});
}
