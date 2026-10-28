/**
 * The cross-lane guard against distro-release package pins in job packet bodies.
 *
 * Every runner lane apt-installs its required tools by fixed author-owned NAME.
 * None may pin a Debian packaging revision, because such a string encodes a
 * distro release (`deb12` = bookworm, `pgdg12` = the PGDG build for bookworm)
 * and becomes unsatisfiable the moment the golden image moves. That is exactly
 * what happened on the 2026-08-02 trixie cutover: every lane failed at
 * setup, including the pre-push receipt gate, which is this repository's CI —
 * so the defect blocked its own fix from being pushed.
 *
 * These tests render the REAL body of every remaining lane (compat and the doctor
 * deploy-smoke box retired with sf#830) and scan the emitted text,
 * rather than asserting on the constants alone. A lane that stops using the
 * shared constant and inlines its own pinned string is still caught.
 */
import { describe, expect, test } from "bun:test";
import { renderInfraStaticJobBody } from "../../src/infra/body";
import { STATIC_GATES } from "../../src/infra/gates";
import { renderPrepushJobBody } from "../../src/prepush/body";
import { RUNNER_BUBBLEWRAP_PACKAGE, RUNNER_POSTGRESQL_PACKAGE } from "../../src/runner/packages";

const REPO = "rtech/rtech-infra";
const SHA = "c".repeat(40);

/**
 * A realistic UUID-suffixed job id, matching what `newRunnerJobId` actually
 * emits. Deliberately NOT a short test literal: every lane body is bounded by a
 * fail-closed char budget, and a short id understates the rendered length. A
 * short id here once hid a real overflow of a lane's char cap (the render
 * returned `null` in production while these tests stayed green).
 */
const JOB_UUID = "cb72002b-6b9e-4a5b-89e2-303e1cb72716";

/**
 * Any Debian/PGDG release-suffixed version spec, e.g. `=0.8.0-2+deb12u1` or
 * `=18.4-1.pgdg13+1`. Deliberately matches deb13/pgdg13 too: pinning the NEW
 * release is the identical time bomb, just aimed at the next cutover.
 */
const RELEASE_PINNED_SPEC = /=[\w.+~:-]*(?:deb|pgdg)\d+/i;

/** Every lane's rendered body, named for a legible failure message. */
function renderedBodies(): ReadonlyArray<readonly [string, string]> {
	const bodies: Array<readonly [string, string]> = [];

	const prepush = renderPrepushJobBody(REPO, SHA, `rw-repo-validate-${JOB_UUID}`);
	if (prepush === null) throw new Error("expected a non-null prepush body");
	bodies.push(["prepush", prepush]);

	const infra = renderInfraStaticJobBody({
		repository: REPO,
		provider: "github",
		sha: SHA,
		jobId: `rw-infra-static-${JOB_UUID}`,
		selection: { gates: [...STATIC_GATES], fullEscalation: true, reason: "full" },
	});
	if (infra === null) throw new Error("expected a non-null infra body");
	bodies.push(["infra", infra]);

	return bodies;
}

describe("runner packet package pins — the image is the version authority", () => {
	test("the shared constants are bare package names carrying no version pin", () => {
		expect(RUNNER_BUBBLEWRAP_PACKAGE).toBe("bubblewrap");
		expect(RUNNER_POSTGRESQL_PACKAGE).toBe("postgresql-18");
		for (const name of [RUNNER_BUBBLEWRAP_PACKAGE, RUNNER_POSTGRESQL_PACKAGE]) {
			expect(name).not.toContain("=");
			expect(name).not.toMatch(RELEASE_PINNED_SPEC);
		}
	});

	test("no lane body pins a distro-release package version", () => {
		for (const [lane, body] of renderedBodies()) {
			const offending = body
				.split("\n")
				.filter((line) => RELEASE_PINNED_SPEC.test(line))
				.join("\n");
			expect(`${lane}: ${offending}`).toBe(`${lane}: `);
		}
	});

	test("no lane body names a Debian release, so an image upgrade cannot strand it", () => {
		for (const [lane, body] of renderedBodies()) {
			expect(`${lane}:${body}`).not.toContain("deb12");
			expect(`${lane}:${body}`).not.toContain("deb13");
			expect(`${lane}:${body}`).not.toContain("pgdg12");
			expect(`${lane}:${body}`).not.toContain("pgdg13");
			expect(`${lane}:${body.toLowerCase()}`).not.toContain("bookworm");
		}
	});

	test("every sandboxed lane still installs bubblewrap by its fixed author-owned name", () => {
		for (const [lane, body] of renderedBodies()) {
			// The prepush lane wraps its install line, so `install -y` and the package
			// name are separated by a newline plus indentation. Collapse whitespace
			// before matching rather than asserting on an exact one-line substring.
			const flat = body.replace(/\s+/g, " ");
			expect(`${lane}: ${flat}`).toContain(`sudo apt-get install -y ${RUNNER_BUBBLEWRAP_PACKAGE}`);
			// The authorization to install remains narrow: exactly the named package(s).
			expect(`${lane}: ${flat.toLowerCase()}`).toContain("install no other package");
		}
	});

	test("the prepush lane keeps the PostgreSQL MAJOR version, which the name carries", () => {
		const prepush = renderPrepushJobBody(REPO, SHA, `rw-repo-validate-${JOB_UUID}`);
		if (prepush === null) throw new Error("expected a non-null prepush body");
		// The major is the load-bearing part: the receipt must attest the version
		// Development actually runs, not whatever the base image happens to ship.
		expect(prepush).toContain(RUNNER_POSTGRESQL_PACKAGE);
		expect(prepush).toContain("postgresql-18");
		expect(prepush).not.toContain("postgresql-15");
		expect(prepush).not.toContain("postgresql-17");
	});

	test("every lane still renders within its fail-closed body budget at a real job id", () => {
		// The budgets fail CLOSED: an oversize render returns `null`, and the lane then
		// refuses to dispatch at all. Editing packet prose is the way that happens by
		// accident. Assert the renders are non-null (renderedBodies throws otherwise).
		const bodies = renderedBodies();
		expect(bodies).toHaveLength(2);
	});
});
