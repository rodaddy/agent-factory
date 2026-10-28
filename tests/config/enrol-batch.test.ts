/**
 * @file Tests for batch build-bump enrolment.
 *
 * The acceptance clause these pin, verbatim from the issue: "The batch path
 * refuses cleanly on a malformed declaration and names which app, without
 * applying the rest partially."
 *
 * So the assertions are about WHICH app is named and about the additions being
 * EMPTY on refusal -- never about a count of successes. A test that only counted
 * would pass against a partial apply, which is the exact defect.
 */
import { describe, expect, test } from "bun:test";
import {
	type EnrolDeclaration,
	planEnrolBatch,
	renderEnrolYaml,
} from "../../src/config/enrol-batch";
import { configSchema } from "../../src/config/schema";

/**
 * A config with the minimum the schema demands plus one already-enrolled repo,
 * so the already-enrolled path and the cross-repository image collision both
 * have something real to collide with.
 */
function baseConfig(): { repositories: unknown[] } {
	return {
		repositories: [
			{
				name: "rodaddy/web-ops",
				provider: "forgejo",
				checks: "static-only",
				build_bump: {
					images: [{ name: "web-ops", environments: [{ name: "live", app_dirs: ["ops"] }] }],
					tag_pattern: "v*",
				},
			},
		],
	};
}

/** A well-formed declaration for an app that is not yet enrolled. */
function goodDecl(repository: string, image: string, dir: string): EnrolDeclaration {
	return { repository, image, appDirs: [dir] };
}

describe("planEnrolBatch", () => {
	test("enrols every declaration when all of them are well formed", () => {
		const result = planEnrolBatch(baseConfig(), [
			goodDecl("rodaddy/web-alpha", "web-alpha", "alpha"),
			goodDecl("rodaddy/web-beta", "web-beta", "beta"),
			goodDecl("rodaddy/web-gamma", "web-gamma", "gamma"),
		]);
		expect(result.applied).toBe(true);
		expect(result.outcomes.map((o) => o.ok)).toEqual([true, true, true]);
		expect(result.additions.map((a) => a.name)).toEqual([
			"rodaddy/web-alpha",
			"rodaddy/web-beta",
			"rodaddy/web-gamma",
		]);
	});

	test("the generated block always uses the images[] form with one live environment", () => {
		const result = planEnrolBatch(baseConfig(), [
			goodDecl("rodaddy/web-alpha", "alpha-img", "alpha-dir"),
		]);
		expect(result.applied).toBe(true);
		const entry = result.additions[0];
		expect(entry?.build_bump.images.map((i) => i.name)).toEqual(["alpha-img"]);
		expect(entry?.build_bump.images[0]?.environments.map((e) => e.name)).toEqual(["live"]);
		expect(entry?.build_bump.images[0]?.environments[0]?.app_dirs).toEqual(["alpha-dir"]);
		expect(entry?.build_bump.tag_pattern).toBe("v*");
	});

	test("one malformed app_dir refuses the WHOLE batch and names only that app", () => {
		// A path-traversing app dir is the security case: entries reach the bump
		// script's `--app` argument, so the schema's regex is the boundary.
		const result = planEnrolBatch(baseConfig(), [
			goodDecl("rodaddy/web-alpha", "web-alpha", "alpha"),
			{ repository: "rodaddy/web-evil", image: "web-evil", appDirs: ["../../etc/passwd"] },
			goodDecl("rodaddy/web-gamma", "web-gamma", "gamma"),
		]);
		expect(result.applied).toBe(false);
		// NOTHING is returned to write, even though two declarations were fine.
		expect(result.additions).toEqual([]);
		const refused = result.outcomes.filter((o) => !o.ok);
		expect(refused.map((o) => o.repository)).toEqual(["rodaddy/web-evil"]);
		// The reason names the offending field, not just "invalid".
		expect(refused[0]?.ok === false && refused[0].reason).toContain("app_dirs");
		// The other two are still reported as individually fine, so the operator
		// knows the batch failed on one app and not on theirs.
		expect(result.outcomes.filter((o) => o.ok).map((o) => o.repository)).toEqual([
			"rodaddy/web-alpha",
			"rodaddy/web-gamma",
		]);
	});

	test("an already-enrolled repository refuses and names itself", () => {
		const result = planEnrolBatch(baseConfig(), [goodDecl("rodaddy/web-ops", "web-ops", "ops")]);
		expect(result.applied).toBe(false);
		expect(result.additions).toEqual([]);
		const first = result.outcomes[0];
		expect(first?.ok).toBe(false);
		expect(first?.repository).toBe("rodaddy/web-ops");
		expect(first?.ok === false && first.reason).toContain("already enrolled");
	});

	test("two declarations claiming the same image collide inside one batch", () => {
		// Neither declaration collides with the existing config; they collide with
		// EACH OTHER. Validating them independently would let the pair through, so
		// this pins that each candidate is checked against the ones already accepted.
		const result = planEnrolBatch(baseConfig(), [
			goodDecl("rodaddy/web-alpha", "shared-image", "alpha"),
			goodDecl("rodaddy/web-beta", "shared-image", "beta"),
		]);
		expect(result.applied).toBe(false);
		expect(result.additions).toEqual([]);
		expect(result.outcomes.filter((o) => !o.ok).map((o) => o.repository)).toEqual([
			"rodaddy/web-beta",
		]);
	});

	test("an empty declaration list applies nothing rather than succeeding vacuously", () => {
		const result = planEnrolBatch(baseConfig(), []);
		expect(result.applied).toBe(false);
		expect(result.additions).toEqual([]);
	});

	test("the accepted additions parse against the real config schema", () => {
		// The planner claims validity by construction; this proves the claim against
		// the same schema the deployed watcher loads, assembled the way the CLI
		// assembles it.
		const base = baseConfig();
		const result = planEnrolBatch(base, [
			goodDecl("rodaddy/web-alpha", "web-alpha", "alpha"),
			goodDecl("rodaddy/web-beta", "web-beta", "beta"),
		]);
		expect(result.applied).toBe(true);
		// `poll_interval_minutes` is the one other required top-level key. The
		// planner supplies a placeholder internally so a partial document still
		// validates; a real config has it, so the test assembles a real one.
		const merged = {
			poll_interval_minutes: 15,
			...base,
			repositories: [...base.repositories, ...result.additions],
		};
		const parsed = configSchema.safeParse(merged);
		expect(parsed.success).toBe(true);
	});
});

describe("renderEnrolYaml", () => {
	test("renders a block that round-trips back through the config schema", async () => {
		const { parse: parseYaml } = await import("yaml");
		const result = planEnrolBatch(baseConfig(), [
			goodDecl("rodaddy/web-alpha", "web-alpha", "alpha"),
		]);
		expect(result.applied).toBe(true);
		const yaml = renderEnrolYaml(result.additions);
		// Rendering is hand-rolled, so the only honest test is to parse the output
		// and validate it -- not to compare it to an expected string, which would
		// pin the formatting instead of the meaning.
		const reparsed = parseYaml(`poll_interval_minutes: 15\nrepositories:\n${yaml}`);
		const parsed = configSchema.safeParse(reparsed);
		expect(parsed.success).toBe(true);
		if (!parsed.success) return;
		const entry = parsed.data.repositories[0];
		expect(entry?.name).toBe("rodaddy/web-alpha");
		expect(entry?.build_bump?.images?.[0]?.environments?.[0]?.app_dirs).toEqual(["alpha"]);
	});

	test("renders nothing for an empty addition list", () => {
		expect(renderEnrolYaml([])).toBe("");
	});
});
