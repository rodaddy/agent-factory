/**
 * @module tests/scripts/audit-roll
 * @description Tests for the random audit roll (ledger L-007).
 *
 *   L-007 buys the truthfulness of report fields with economics rather than
 *   with per-report verification: a genuinely random ~1-in-5 re-check of an
 *   ALREADY-ACCEPTED report makes the expected cost of fabrication exceed the
 *   cost of disclosure. The operator caveat is binding — the audit is the
 *   BACKSTOP behind the schema validator (L-002) and the harvest binding
 *   (L-003), never the primary control — so the single most important property
 *   these tests pin is that the roll ALWAYS exits 0. A backstop that can refuse
 *   the chain has become the primary control the caveat forbids, and that is a
 *   behavioural regression no exit-code-agnostic assertion would catch.
 *
 *   Two boundaries are injected, for two different reasons. The RNG is injected
 *   because a genuinely random roll is otherwise untestable — the same reason
 *   `scripts/land.ts` injects its command runner (done-means rule 11): the pure
 *   sequence is driven by a fake and the CLI entry wires the real source. The
 *   reports directory is overridden by environment variable, matching
 *   `scripts/check-harvest-binding.ts` and `scripts/check-tightenings-budget.ts`,
 *   so no fixture depends on which reports happen to be committed today.
 *
 *   Every group asserts the exact output STRING, never merely the exit code.
 *   Exit code 0 is this script's only exit code, so an exit-code assertion here
 *   is worthless by construction: a totally broken roll that finds no reports,
 *   or that reads the wrong directory, also exits 0 and prints the loud-empty
 *   line. The `(rolled N of 5)` count string and the audited basename are what
 *   separate a working roll from a broken one — the done-means rule 13 shape,
 *   and the rule 10 mutation aimed at the SEARCH TARGET (the directory path) is
 *   detectable ONLY through the non-zero-count fixtures below (rule 8).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import {
	AUDIT_DIR_ENV,
	auditRoll,
	DEFAULT_DIR,
	HIT_FACE,
	ROLL_FACES,
} from "../../scripts/audit-roll";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "audit-roll.ts");

const created: string[] = [];

afterEach(async () => {
	for (const dir of created.splice(0)) {
		await rename(dir, join(testArchiveDir(), `${basename(dir)}-${crypto.randomUUID()}`));
	}
});

/** A throwaway directory holding fixture reports, archived after each test. */
async function fixtureDir(): Promise<string> {
	const dir = await mkdtemp(join(testTmpBase(), "rw-audit-roll-"));
	created.push(dir);
	return dir;
}

/**
 * A reports directory holding `names` as files. Written with real report-ish
 * content so nothing here depends on the files being empty.
 */
async function reportsDir(names: readonly string[]): Promise<string> {
	const dir = await fixtureDir();
	for (const name of names) {
		await writeFile(join(dir, name), `# Lane report — ${name}\n\n**lessons**: none\n`, "utf8");
	}
	return dir;
}

/** Collect output lines from a roll, with an RNG scripted to `values`. */
function rollWith(options: { readonly dir: string; readonly values: readonly number[] }): {
	readonly code: number;
	readonly lines: string[];
} {
	const lines: string[] = [];
	const queue = [...options.values];
	const code = auditRoll({
		dir: options.dir,
		// The fake THROWS on an unscripted call rather than returning a default
		// (done-means rule 11): a default 0 would make every sequence pass
		// regardless of how many times the roll actually consulted the source.
		random: () => {
			const next = queue.shift();
			if (next === undefined)
				throw new Error("audit-roll test: RNG called more times than scripted");
			return next;
		},
		out: (line) => lines.push(line),
	});
	return { code, lines };
}

/** The unit interval value that lands on face `face` of `ROLL_FACES`. */
function faceValue(face: number): number {
	return (face - 1) / ROLL_FACES + 1 / (ROLL_FACES * 2);
}

const THREE_REPORTS = [
	"2026-08-01-alpha-implementation.md",
	"2026-08-02-beta-implementation.md",
	"2026-08-03-gamma-implementation.md",
] as const;

describe("audit-roll — clause: a forced HIT names a real report", () => {
	test("a hit prints AUDIT with a basename that exists in the directory", async () => {
		const dir = await reportsDir(THREE_REPORTS);
		// Two draws on a hit: the roll, then the uniform pick.
		const result = rollWith({ dir, values: [faceValue(HIT_FACE), 0] });
		expect(result.code).toBe(0);
		const line = result.lines.join("\n");
		expect(line).toContain("audit-roll: AUDIT ");
		expect(line).toContain(`(rolled ${HIT_FACE} of ${ROLL_FACES})`);
		// The named report must be one that really exists — a hit naming a
		// fabricated or empty basename is the failure a substring check on
		// "AUDIT" alone would pass.
		const named = THREE_REPORTS.filter((name) => line.includes(name));
		expect(named).toHaveLength(1);

		// A directory holding exactly one report names that report, at any pick.
		const one = await reportsDir(["2026-08-08-only-one.md"]);
		const single = rollWith({ dir: one, values: [faceValue(HIT_FACE), 0.99] });
		expect(single.code).toBe(0);
		expect(single.lines.join("\n")).toContain("audit-roll: AUDIT 2026-08-08-only-one.md");
	});

	test("a hit never names README.md", async () => {
		const dir = await reportsDir([...THREE_REPORTS, "README.md"]);
		// Drive the pick across the whole range; README must never surface.
		for (let i = 0; i < ROLL_FACES * 4; i += 1) {
			const result = rollWith({ dir, values: [faceValue(HIT_FACE), i / (ROLL_FACES * 4)] });
			expect(result.lines.join("\n")).not.toContain("README.md");
		}
	});
});

describe("audit-roll — clause: a forced MISS skips, naming the roll", () => {
	test("every non-hit face prints SKIP with its own face number", async () => {
		const dir = await reportsDir(THREE_REPORTS);
		const misses = Array.from({ length: ROLL_FACES }, (_, i) => i + 1).filter(
			(face) => face !== HIT_FACE,
		);
		expect(misses).toHaveLength(ROLL_FACES - 1);
		for (const face of misses) {
			// A miss draws ONCE — no pick happens — so a second scripted value
			// would be left unused. Scripting exactly one value and letting the
			// fake throw on a second call pins that too.
			const result = rollWith({ dir, values: [faceValue(face)] });
			expect(result.code).toBe(0);
			expect(result.lines.join("\n")).toBe(`audit-roll: SKIP (rolled ${face} of ${ROLL_FACES})`);
		}
	});

	test("a miss names no report at all", async () => {
		const dir = await reportsDir(THREE_REPORTS);
		const missFace = HIT_FACE === 1 ? 2 : 1;
		const line = rollWith({ dir, values: [faceValue(missFace)] }).lines.join("\n");
		for (const name of THREE_REPORTS) expect(line).not.toContain(name);
		expect(line).not.toContain("AUDIT");
	});
});

describe("audit-roll — clause: the pick is uniform over every report", () => {
	test("forced sequences reach EVERY fixture report, none more than once", async () => {
		// The non-zero-count fixture that makes a wrong-directory mutation
		// detectable (done-means rules 8 and 10): a roll reading the wrong path
		// finds zero reports, prints the loud-empty line, and still exits 0.
		const dir = await reportsDir(THREE_REPORTS);
		const seen = new Set<string>();
		const samples = 60;
		for (let i = 0; i < samples; i += 1) {
			const line = rollWith({
				dir,
				values: [faceValue(HIT_FACE), i / samples],
			}).lines.join("\n");
			const named = THREE_REPORTS.find((name) => line.includes(name));
			expect(named).toBeDefined();
			if (named !== undefined) seen.add(named);
		}
		expect(seen.size).toBe(THREE_REPORTS.length);
	});

	test("a pick draw at the very top of the unit interval stays in range", async () => {
		// `Math.random()` is [0, 1) but a fake is not bound by that, and an
		// off-by-one index would read `undefined` and print an empty basename.
		const dir = await reportsDir(THREE_REPORTS);
		const line = rollWith({
			dir,
			values: [faceValue(HIT_FACE), 0.9999999],
		}).lines.join("\n");
		expect(line).toContain(THREE_REPORTS[THREE_REPORTS.length - 1] as string);
	});
});

describe("audit-roll — clause: an empty directory is LOUD, and still exit 0", () => {
	// Emptiness is judged BEFORE the die, so every fixture here scripts ZERO
	// RNG values and the fake throws if the roll consults randomness at all.
	// That is the assertion, not an incidental strictness: judging emptiness
	// only on a hit would make the "nothing to audit" signal itself random —
	// four passes in five would print SKIP over a directory that could never
	// have been audited, and a misconfigured path would take an expected five
	// merge passes to surface.

	test("zero reports prints the loud-empty line, drawing no randomness", async () => {
		const dir = await fixtureDir();
		const result = rollWith({ dir, values: [] });
		expect(result.code).toBe(0);
		expect(result.lines.join("\n")).toBe("audit-roll: 0 reports to audit (directory empty)");
	});

	test("a directory holding ONLY README.md counts as empty", async () => {
		const dir = await reportsDir(["README.md"]);
		const result = rollWith({ dir, values: [] });
		expect(result.code).toBe(0);
		expect(result.lines.join("\n")).toBe("audit-roll: 0 reports to audit (directory empty)");
	});

	test("a MISSING directory is loud and still exit 0, never a crash", async () => {
		// The roll is advisory. A directory that does not exist must not throw
		// its way to a non-zero exit through the CLI entry.
		const dir = join(await fixtureDir(), "does-not-exist");
		const result = rollWith({ dir, values: [] });
		expect(result.code).toBe(0);
		expect(result.lines.join("\n")).toBe("audit-roll: 0 reports to audit (directory empty)");
	});
});

describe("audit-roll — the binding caveat: NEVER a refusing gate", () => {
	test("exit code is 0 across every face, empty, and populated case", async () => {
		// The operator caveat made executable. If any future edit makes a hit,
		// a miss, an empty directory, or a missing directory refuse, this fails
		// — the audit would have become the primary control L-007 forbids.
		const populated = await reportsDir(THREE_REPORTS);
		const empty = await fixtureDir();
		const missing = join(empty, "nope");
		for (let face = 1; face <= ROLL_FACES; face += 1) {
			const values = face === HIT_FACE ? [faceValue(face), 0.5] : [faceValue(face)];
			expect(rollWith({ dir: populated, values }).code).toBe(0);
			// Empty and missing short-circuit before the die, so they draw
			// nothing regardless of which face this iteration would have rolled.
			expect(rollWith({ dir: empty, values: [] }).code).toBe(0);
			expect(rollWith({ dir: missing, values: [] }).code).toBe(0);
		}
	});

	test("the roll is NOT wired into the `bun run check` chain", async () => {
		// L-007's non-goal, asserted against the artifact rather than trusted:
		// the chain must not reference this script. A `check:` step invoking an
		// always-0 script would be harmless today and would become the hook a
		// later "make it refuse" edit hangs itself on.
		const pkg = (await Bun.file(join(import.meta.dir, "..", "..", "package.json")).json()) as {
			scripts: Record<string, string>;
		};
		for (const [name, command] of Object.entries(pkg.scripts)) {
			expect(`${name}=${command}`).not.toContain("audit-roll");
		}
	});
});

describe("audit-roll — the CLI entry", () => {
	/** Run the real script as a subprocess, with the directory override set. */
	function spawn(dir: string) {
		const result = Bun.spawnSync(["bun", "run", SCRIPT], {
			env: { ...process.env, [AUDIT_DIR_ENV]: dir },
		});
		return {
			exitCode: result.exitCode,
			output: `${result.stdout.toString()}${result.stderr.toString()}`,
		};
	}

	test("the real entry point exits 0 and prints exactly one roll line", async () => {
		// Real randomness, so the line is one of the two shapes — but it is
		// always ONE line and the exit is always 0.
		//
		// The loop runs until BOTH faces have actually been observed rather than
		// a fixed 12 times. A fixed count leaves coverage of the hit
		// branch to chance: 12 spawns miss every time with probability 0.8^12 ≈
		// 6.9%, so roughly one run in fourteen asserted exit 0 over MISSES ONLY
		// and never exercised the hit path this clause's title claims. Measured
		// directly: under an inverted-caveat mutation this clause stayed GREEN in
		// 1 of 10 repetitions, destabilising the mutation signature between 3 and
		// 4 of 16. Draining to a seen-both condition makes the hit branch a
		// guaranteed observation instead of a likely one, so the clause is red
		// under that mutation every time.
		const dir = await reportsDir(THREE_REPORTS);
		const shape = new RegExp(
			`^audit-roll: (SKIP \\(rolled \\d+ of ${ROLL_FACES}\\)|AUDIT \\S+\\.md \\(rolled ${HIT_FACE} of ${ROLL_FACES}\\))$`,
		);
		// Bounded so a genuinely broken roll that can never hit fails on the
		// seen-both assertion below instead of spinning forever. P(no hit in 200
		// draws) = 0.8^200 ≈ 4e-20 — small enough that a failure here is a real
		// defect, not a bad day.
		const maxSpawns = 200;
		let hits = 0;
		let misses = 0;
		let spawns = 0;
		while (spawns < maxSpawns && (hits === 0 || misses === 0)) {
			const result = spawn(dir);
			spawns += 1;
			// Asserted on EVERY spawn, hit or miss: this is the caveat at the CLI
			// boundary, and it must hold on every face rather than on the face
			// that happened to come up.
			expect(result.exitCode).toBe(0);
			const lines = result.output.trim().split("\n").filter(Boolean);
			expect(lines).toHaveLength(1);
			const line = lines[0] as string;
			expect(line).toMatch(shape);
			if (line.includes("AUDIT ")) hits += 1;
			else misses += 1;
		}
		// Both branches PROVEN exercised, not assumed. Without this the loop
		// could satisfy every assertion above while the hit path went untouched.
		expect(hits).toBeGreaterThan(0);
		expect(misses).toBeGreaterThan(0);
	});

	test("the real entry point is loud and exit 0 on an empty directory", async () => {
		const result = spawn(await fixtureDir());
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("audit-roll: 0 reports to audit (directory empty)");
	});

	test("the SHIPPED default directory is the committed reports directory", () => {
		// The SEARCH TARGET, asserted directly (done-means rule 10). Every
		// fixture above overrides the directory, so a mutation of the default
		// path is invisible to all of them: without this clause the roll could
		// ship pointed at a directory that does not exist, print the loud-empty
		// line on every real merge pass, and never audit anything — while the
		// whole suite stayed green.
		expect(DEFAULT_DIR).toBe("_reports/lane-reports");
	});
});
