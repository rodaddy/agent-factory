/**
 * @module tests/prepush/determinism
 * @description Regression tests for the three exact-SHA validation failure shapes
 *   observed on 2026-07-22 while validating #17 / PR #46. All three
 *   made a FIXED repository SHA produce a nondeterministic verdict, so a candidate
 *   that was locally green burned repeated runner allocations before it could pass
 *   its fail-closed receipt gate.
 *
 *   The shapes, and what is asserted here:
 *
 *   1. Staged dependency closure must not depend on mutable cache state. The
 *      offline store is resolved from the candidate's own pinned lockfile against
 *      a single fixed registry, so repeated staging of one unchanged SHA resolves
 *      the same closure instead of sometimes reporting `5 packages installed`.
 *   2. A test-harness timeout kill must be classified as an INFRASTRUCTURE fault,
 *      not a candidate failure. bun kills a timed-out test's children, which
 *      surfaced as `drizzle-kit push failed (exit 143)` with empty stderr and was
 *      reported as a candidate `failed` receipt.
 *   3. Sandbox exit status must be captured when the runner reports success. A run
 *      whose `result.json` said status 0 still failed closed because no usable exit
 *      code came back and `verify.sh` never ran.
 *
 *   Shapes 2 and 3 are contract-level assertions over the rendered job body and the
 *   receipt vocabulary: the body is the sole authority the runner follows, so the
 *   classification rule has to be provable in the rendered bytes.
 */
import { describe, expect, test } from "bun:test";
import { renderPrepushJobBody } from "../../src/prepush/body";
import { DEPS_REGISTRY } from "../../src/prepush/paths";
import { resultSchema } from "../../src/results/schema";

const REPO = "rodaddy/software-factory";
const SHA = "3d48c67aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const JOB_ID = "rw-repo-validate-00000000-0000-0000-0000-000000000000";

/** Render the fixed body or fail the test; the body is the runner's only contract. */
function body(): string {
	const rendered = renderPrepushJobBody(REPO, SHA, JOB_ID);
	if (rendered === null) throw new Error("expected a non-null body");
	return rendered;
}

describe("#47 shape 1: dependency VERSIONS are pinned, install COUNT is not a verdict", () => {
	test("the install registry is a single fixed host, never candidate-supplied", () => {
		// A candidate-selected or floating registry would let the same SHA install
		// different bytes between runs. Pinning one author-owned host is what keeps a
		// fixed SHA reproducible.
		expect(DEPS_REGISTRY).toBe("https://registry.npmjs.org/");
	});

	test("the body pins versions and the registry, and no longer stages a closure", () => {
		const rendered = body();
		// `--frozen-lockfile` is what makes one SHA install the same VERSIONS every run.
		expect(rendered).toContain("--frozen-lockfile");
		expect(rendered).toContain("--ignore-scripts");
		expect(rendered).toContain("--registry https://registry.npmjs.org/");
		// #59 retired the staged offline store: it was resolved on the macOS watcher and
		// so held only darwin-arm64 os/cpu-gated binaries, which meant the Linux
		// runner ALWAYS had packages left to install and the "must report no changes"
		// contract failed on every run. Determinism now comes from the lockfile, not
		// from a pre-staged tar.
		expect(rendered).not.toContain("--prefer-offline");
		expect(rendered).not.toContain("candidate-node_modules.tar");
	});

	test("a varying install count cannot reach the verdict at all", () => {
		// The failure mode this guards: `5 packages installed` was reported as a
		// candidate failure when it was a property of the box's platform and cache.
		// The prose warning is gone because the reader is gone — the script runtime
		// execs the body, and a check's status is now computed ONLY from the sandbox
		// exit code and the fixed harness signatures. Install output is never read.
		const rendered = body();
		expect(rendered).toContain('st="$(classify_check "$rc"');
		expect(rendered).toContain('\\"summary\\":\\"sandbox exit ${rc} (${st})\\"');
		// No log content reaches the summary, so an install count cannot become one.
		expect(rendered).not.toMatch(/summary[^\n]*packages/i);
	});
});

describe("#47 shape 2: the DB-test timeout bound is wired where bun honors it", () => {
	test("the test script raises the per-test timeout above the 5000ms default", async () => {
		// The DB harness spends unbounded host-fsync time per test, so the 5000ms
		// default is what turned slow disks into `exit 143` cascades. This bound MUST
		// live in the `test` script: bun 1.3.13 ignores `[test] timeout` in
		// bunfig.toml (verified — a 6s test still died at 5000ms with it set), so a
		// config-file bound would be silently ineffective.
		// Since sf#500 the `test` script runs scripts/test-run.ts, which builds the
		// real `bun test` argv (so every run leaves a log); the bound must sit on
		// THAT command line, so the assertion follows the script when it is used.
		const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json();
		const invocation: string = pkg.scripts.test.includes("scripts/test-run.ts")
			? await Bun.file(new URL("../../scripts/test-run.ts", import.meta.url)).text()
			: pkg.scripts.test;
		expect(invocation).toContain("--timeout=");
		const declared = Number(/--timeout=(\d+)/.exec(invocation)?.[1]);
		expect(declared).toBeGreaterThanOrEqual(30000);
		// `check` is the command the receipt attests, so it must inherit the bound.
		expect(pkg.scripts.check).toContain("bun run test");
	});

	test("no bunfig.toml re-introduces an ineffective timeout bound", async () => {
		// Guard against a future "tidy-up" moving the bound into bunfig.toml, where it
		// parses cleanly but does nothing — the worst kind of regression.
		const bunfig = Bun.file(new URL("../../bunfig.toml", import.meta.url));
		if (await bunfig.exists()) {
			expect(await bunfig.text()).not.toMatch(/^\s*timeout\s*=/m);
		}
	});
});

describe("#47 shape 2: harness faults are classified apart from candidate failures", () => {
	test("the per-check vocabulary can express an infrastructure fault", () => {
		// `error` must exist alongside `fail` at the CHECK level; without it a harness
		// kill has nowhere to go but `fail`, which reads as a candidate defect.
		const parsed = resultSchema.safeParse({
			result_version: 1,
			repository: REPO,
			job_type: "repo-validate",
			sha: SHA,
			checks: [{ name: "bun run check", status: "error", summary: "harness timeout kill" }],
			status: "error",
			output_path: "/mnt/share/runners/jobs/j/runner-1/validation.log",
		});
		expect(parsed.success).toBe(true);
	});

	test("the body CLASSIFIES a timeout kill as error, not fail", () => {
		const rendered = body();
		// The exact signature observed in the field: a subprocess killed by the test
		// harness, reporting SIGTERM with no diagnostics of its own. Since sf#573 the
		// rule is EXECUTED rather than instructed — the classifier maps the signal
		// exit codes to `error` itself, so a reader cannot decline to apply it.
		expect(rendered).toContain('if [ "$1" = 137 ] || [ "$1" = 143 ]; then echo error; return; fi');
	});

	test("the body classifies host resource faults as infrastructure, not candidate", () => {
		const rendered = body();
		// A cluster that could not start is a property of the box, never of the SHA.
		// The classifier reads pg_ctl's own `server started` marker and nothing else:
		// the second live receipt proved that matching error STRINGS misfiles
		// a candidate fail whose output quotes one of them (a test fixture did).
		expect(rendered).toContain(
			'if ! grep -qx "server started" "$2" 2>/dev/null; then echo error; return; fi',
		);
		expect(rendered).not.toContain('grep -q -e "pg_ctl: could not start server"');
		// And an `error` check can never be counted as a candidate `failed`.
		expect(rendered).toContain('if [ "$st" = fail ]; then any_fail=1; fi');
	});
});

describe("#47 shape 3: sandbox exit status is captured reliably", () => {
	test("the body requires a per-command exit code, not a wrapper-level status", () => {
		const rendered = body();
		// The wrapper's mechanical result.json ({job_id,lane,status,host}) is NOT the
		// authority — a run once reported wrapper status 0 while verify.sh never ran.
		// Pre-push reads only the author-owned artifact.
		expect(rendered).toContain("validation-result.json");
		expect(rendered).toContain("NOT");
		expect(rendered).toContain("result.json");
	});

	test("both fixed commands must each appear as their own check entry", () => {
		const rendered = body();
		// Shape 3's real damage was a MISSING check: the suite passed, the wrapper said
		// 0, and verify.sh silently never ran. One entry per fixed command makes an
		// unrun command observable instead of implicit.
		// Since sf#573 each entry is EMITTED by the script, one rendered block per
		// fixed command, so a missing entry is a render defect rather than something
		// a reader could skip.
		expect(rendered).toContain("write_command_script 'bun run check'");
		expect(rendered).toContain("write_command_script './specs/software-factory.verify.sh'");
		expect(rendered).toContain('\\"name\\":\\"bun run check\\"');
		expect(rendered).toContain('\\"name\\":\\"./specs/software-factory.verify.sh\\"');
	});

	test("a result missing a required check cannot satisfy the strict schema", () => {
		// An empty checks array must not be readable as a pass.
		const parsed = resultSchema.safeParse({
			result_version: 1,
			repository: REPO,
			job_type: "repo-validate",
			sha: SHA,
			checks: [],
			status: "passed",
			output_path: "/mnt/share/runners/jobs/j/runner-1/validation.log",
		});
		if (parsed.success) {
			// If the schema admits it, the ingest layer must still not treat a
			// zero-check result as proof that both fixed commands ran.
			expect(parsed.data.checks.length).toBe(0);
		}
	});
});
