import { describe, expect, test } from "bun:test";
import { buildBumpEnvironments, resolvedEnvironments } from "../../src/config/build-bump-images";
import {
	configSchema,
	jobTemplateConfigSchema,
	repositoryConfigSchema,
} from "../../src/config/schema";

/**
 * The build-bump enrollment block (child of sf#533), reshaped by
 * `_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §1-2 into an ORDERED ENVIRONMENT LIST.
 *
 * `build_bump` is the per-repository opt-in for the k3s build-bump lane. Absent
 * means NOT ENROLLED — there is deliberately no derived boolean, because every
 * consumer reads the presence of the block itself. The `app_dirs` regex is the
 * security boundary: entries are interpolated into the bump script's `--app`
 * argument, so a `/` or `..` must never survive this boundary.
 *
 * The removed keys are pinned by REFUSAL tests: `app_dirs`, `prod_app_dirs`, and
 * `prod` are gone from the block, and `.strict()` is what makes a config still
 * carrying one fail loudly instead of being silently ignored. There is no legacy
 * mapping — the deploy that ships this schema ships the rewritten `repos.yml`.
 */
describe("repositoryConfigSchema build_bump enrollment", () => {
	const base = { name: "acme/web-bb-landing", provider: "forgejo", checks: "static-only" };
	const env = (over: Record<string, unknown> = {}) => ({ name: "live", app_dirs: ["x"], ...over });

	test("absent block means the repository is not enrolled", () => {
		const result = repositoryConfigSchema.safeParse({ ...base });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.build_bump).toBeUndefined();
		}
	});

	test("accepts a minimal single-environment block and defaults tag_pattern", () => {
		const result = repositoryConfigSchema.safeParse({
			...base,
			build_bump: { environments: [{ name: "live", app_dirs: ["bb-landing"] }] },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.build_bump?.environments).toEqual([
				{ name: "live", app_dirs: ["bb-landing"] },
			]);
			expect(result.data.build_bump?.tag_pattern).toBe("v*");
		}
	});

	test("accepts the two-level shape with explicit promote and marker", () => {
		const result = repositoryConfigSchema.safeParse({
			...base,
			build_bump: {
				environments: [
					{ name: "uat", app_dirs: ["portal-uat"], promote: "tag" },
					{ name: "prod", app_dirs: ["portal-prod"], promote: "marker", marker: "prod" },
				],
				tag_pattern: "release-*",
			},
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.build_bump?.tag_pattern).toBe("release-*");
			expect(result.data.build_bump?.environments?.[1]?.marker).toBe("prod");
		}
	});

	// The removed keys (BUILD_BUMP_ENVIRONMENTS.md §2). `.strict()` is the
	// mechanism: a config that still carries one is REFUSED, never ignored.
	test("refuses the removed keys app_dirs, prod_app_dirs, and prod", () => {
		for (const removed of [
			{ app_dirs: ["bb-landing-uat"] },
			{ prod_app_dirs: ["bb-landing-prod"] },
			{ prod: "manual" },
			{ prod: "auto" },
		]) {
			const result = repositoryConfigSchema.safeParse({ ...base, build_bump: removed });
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(JSON.stringify(result.error.issues)).toContain("unrecognized_keys");
			}
		}
		// And beside a valid environments list, so the refusal is the KEY, not the
		// absence of a target.
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [env()], app_dirs: ["y"] },
			}).success,
		).toBe(false);
	});

	test("rejects an empty environments array and an empty app_dirs array", () => {
		expect(
			repositoryConfigSchema.safeParse({ ...base, build_bump: { environments: [] } }).success,
		).toBe(false);
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [{ name: "live", app_dirs: [] }] },
			}).success,
		).toBe(false);
	});

	test("requires app_dirs on an environment", () => {
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [{ name: "live" }] },
			}).success,
		).toBe(false);
	});

	// BUILD-ONLY enrolment. A block with no environments and no images
	// is VALID: the repository owns no app directory, its tags build and push an
	// image, and another repository consumes that image by tag (rtech-mcps ->
	// rtech-mcps-servers, pinned in mcp2cli's Dockerfile). Enrolment is the
	// block's PRESENCE -- intake reads that plus provider plus tag match, and
	// never reads the environments.
	test("accepts a build_bump with no environments (build-only enrolment)", () => {
		const result = repositoryConfigSchema.safeParse({ ...base, build_bump: {} });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.build_bump?.environments).toBeUndefined();
			expect(result.data.build_bump?.images).toBeUndefined();
			// The defaults still apply, so the build side is fully specified.
			expect(result.data.build_bump?.tag_pattern).toBe("v*");
		}
	});

	test("rejects more than 10 environments and more than 10 app_dirs", () => {
		const environments = Array.from({ length: 11 }, (_, i) => ({
			name: `e${i}`,
			app_dirs: [`app-${i}`],
		}));
		expect(
			repositoryConfigSchema.safeParse({ ...base, build_bump: { environments } }).success,
		).toBe(false);
		const app_dirs = Array.from({ length: 11 }, (_, i) => `app-${i}`);
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [env({ app_dirs })] },
			}).success,
		).toBe(false);
	});

	test("rejects an environment name that is not a DNS label of at most 16", () => {
		for (const name of ["Live", "a_b", "-a", "a-", "a.b", "", "a".repeat(17)]) {
			expect(
				repositoryConfigSchema.safeParse({ ...base, build_bump: { environments: [env({ name })] } })
					.success,
			).toBe(false);
		}
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [env({ name: "a".repeat(16) })] },
			}).success,
		).toBe(true);
	});

	test("rejects a promote value outside the enum and a structured marker", () => {
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [env({ promote: "newest" })] },
			}).success,
		).toBe(false);
		for (const marker of ["refs/tags/prod", "../prod", "-f", "pro d", ""]) {
			expect(
				repositoryConfigSchema.safeParse({
					...base,
					build_bump: {
						environments: [env(), { name: "prod", app_dirs: ["p"], marker }],
					},
				}).success,
			).toBe(false);
		}
	});

	// The security boundary: these entries reach the bump script's --app argument.
	test("rejects an app_dir carrying a path separator", () => {
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [env({ app_dirs: ["apps/bb-landing"] })] },
			}).success,
		).toBe(false);
	});

	test("rejects an app_dir carrying traversal", () => {
		for (const app_dirs of [["../secrets"], [".."]]) {
			expect(
				repositoryConfigSchema.safeParse({
					...base,
					build_bump: { environments: [env({ app_dirs })] },
				}).success,
			).toBe(false);
		}
		// A `..` SUBSTRING is accepted and harmless while `/` is refused. Pinned so
		// the boundary's real shape is a test, not a comment a consumer over-reads.
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [env({ app_dirs: ["bb..landing"] })] },
			}).success,
		).toBe(true);
	});

	test("rejects an option-shaped, shell-shaped, or over-long app_dir", () => {
		for (const bad of [
			"-rf",
			"--app",
			"-",
			"--app=evil",
			"bb landing",
			"bb;rm",
			"bb$(x)",
			"bb|x",
			"",
			"a".repeat(101),
		]) {
			expect(
				repositoryConfigSchema.safeParse({
					...base,
					build_bump: { environments: [env({ app_dirs: [bad] })] },
				}).success,
			).toBe(false);
		}
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [env({ app_dirs: ["a".repeat(100)] })] },
			}).success,
		).toBe(true);
	});

	test("rejects a tag_pattern with more than one glob", () => {
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [env()], tag_pattern: "v*.*" },
			}).success,
		).toBe(false);
	});

	test("rejects a tag_pattern carrying a ref path", () => {
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [env()], tag_pattern: "refs/tags/v*" },
			}).success,
		).toBe(false);
	});

	test("rejects an option-shaped or match-everything tag_pattern", () => {
		// This pattern SELECTS the tag a later lane passes as `--tag`, so a pattern
		// that can enroll option-shaped tags is refused at this boundary. The same
		// anchor makes a bare `*` unconfigurable.
		for (const bad of ["-*", "--target", "--dry-run", "-", "*", "*v"]) {
			expect(
				repositoryConfigSchema.safeParse({
					...base,
					build_bump: { environments: [env()], tag_pattern: bad },
				}).success,
			).toBe(false);
		}
	});

	test("rejects a tag_pattern that is empty, leading-dot, or over 50 characters", () => {
		for (const bad of ["", ".hidden", `${"v".repeat(50)}*`]) {
			expect(
				repositoryConfigSchema.safeParse({
					...base,
					build_bump: { environments: [env()], tag_pattern: bad },
				}).success,
			).toBe(false);
		}
	});

	test("stays strict inside the block", () => {
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [env()], backdoor: true },
			}).success,
		).toBe(false);
	});

	test("stays strict inside an environment", () => {
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { environments: [env({ target: "uat" })] },
			}).success,
		).toBe(false);
	});

	test("the block validates through the full config document", () => {
		const result = configSchema.safeParse({
			poll_interval_minutes: 15,
			repositories: [
				{ ...base, build_bump: { environments: [{ name: "live", app_dirs: ["bb-landing"] }] } },
			],
		});
		expect(result.success).toBe(true);

		const rejected = configSchema.safeParse({
			poll_interval_minutes: 15,
			repositories: [{ ...base, build_bump: { environments: [env({ app_dirs: ["apps/x"] })] } }],
		});
		expect(rejected.success).toBe(false);
	});
});

/**
 * The ORDERED-LIST invariants (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §2). Each
 * message below is pinned by exactly one test, because the messages are the
 * contract a config author reads when a `repos.yml` is refused.
 */
describe("buildBumpEnvironments invariants (BUILD_BUMP_ENVIRONMENTS §2)", () => {
	const messages = (list: unknown[]): string[] => {
		const result = buildBumpEnvironments.safeParse(list);
		expect(result.success).toBe(false);
		return result.success ? [] : result.error.issues.map((issue) => issue.message);
	};

	test("refuses a repeated environment name", () => {
		expect(
			messages([
				{ name: "live", app_dirs: ["a"] },
				{ name: "live", app_dirs: ["b"] },
			]),
		).toContain("environment 'live' is declared twice");
	});

	test("refuses an app dir claimed by two environments", () => {
		expect(
			messages([
				{ name: "uat", app_dirs: ["shared"] },
				{ name: "prod", app_dirs: ["shared"] },
			]),
		).toContain("app_dirs entry 'shared' belongs to more than one environment");
	});

	test("refuses a marker used by two environments", () => {
		expect(
			messages([
				{ name: "uat", app_dirs: ["a"] },
				{ name: "prod", app_dirs: ["b"], marker: "ship" },
				{ name: "edge", app_dirs: ["c"], marker: "ship" },
			]),
		).toContain("marker 'ship' is used by more than one environment");
	});

	test("refuses a later environment promoting by tag", () => {
		expect(
			messages([
				{ name: "uat", app_dirs: ["a"] },
				{ name: "prod", app_dirs: ["b"], promote: "tag" },
			]),
		).toContain("only the first environment may promote by tag");
	});

	test("refuses the first environment promoting by marker", () => {
		expect(messages([{ name: "uat", app_dirs: ["a"], promote: "marker" }])).toContain(
			"the first environment must promote by tag",
		);
	});

	test("refuses a marker on an environment that promotes by tag", () => {
		expect(messages([{ name: "uat", app_dirs: ["a"], marker: "uat" }])).toContain(
			"environment 'uat' sets marker but promotes by tag",
		);
		// Explicit `promote: tag` at index 0 carries the same refusal.
		expect(messages([{ name: "uat", app_dirs: ["a"], promote: "tag", marker: "uat" }])).toContain(
			"environment 'uat' sets marker but promotes by tag",
		);
	});

	test("accepts the shapes those invariants leave legal", () => {
		expect(buildBumpEnvironments.safeParse([{ name: "live", app_dirs: ["a"] }]).success).toBe(true);
		expect(
			buildBumpEnvironments.safeParse([
				{ name: "uat", app_dirs: ["a"], promote: "tag" },
				{ name: "prod", app_dirs: ["b"], promote: "marker", marker: "prod" },
			]).success,
		).toBe(true);
	});
});

/**
 * `resolvedEnvironments` is the ONE place a consumer learns what an unstated
 * `promote`/`marker` means, because the defaults are POSITIONAL and so cannot
 * be zod field defaults.
 */
describe("resolvedEnvironments applies the positional defaults", () => {
	test("index 0 promotes by tag, every later index by a marker named after itself", () => {
		expect(
			resolvedEnvironments([
				{ name: "uat", app_dirs: ["a"] },
				{ name: "prod", app_dirs: ["b"] },
				{ name: "edge", app_dirs: ["c"], marker: "ship" },
			]),
		).toEqual([
			{ name: "uat", app_dirs: ["a"], promote: "tag", marker: "uat" },
			{ name: "prod", app_dirs: ["b"], promote: "marker", marker: "prod" },
			{ name: "edge", app_dirs: ["c"], promote: "marker", marker: "ship" },
		]);
	});

	test("an explicit promote is never overwritten", () => {
		expect(
			resolvedEnvironments([{ name: "uat", app_dirs: ["a"], promote: "tag" }])[0]?.promote,
		).toBe("tag");
	});
});

describe("repositoryConfigSchema PR review ownership", () => {
	const base = { name: "rodaddy/example", provider: "github", checks: "standard" };

	test("omitted keeps the existing watcher-owned behavior", () => {
		const result = repositoryConfigSchema.safeParse(base);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.pr_review).toBeUndefined();
		}
	});

	test("accepts explicit true and false values", () => {
		const enabled = repositoryConfigSchema.safeParse({ ...base, pr_review: true });
		const optedOut = repositoryConfigSchema.safeParse({ ...base, pr_review: false });
		expect(enabled.success).toBe(true);
		expect(optedOut.success).toBe(true);
		if (enabled.success && optedOut.success) {
			expect(enabled.data.pr_review).toBe(true);
			expect(optedOut.data.pr_review).toBe(false);
		}
	});

	test("rejects a non-boolean value", () => {
		expect(repositoryConfigSchema.safeParse({ ...base, pr_review: "false" }).success).toBe(false);
	});

	// pr_review_runtime sf#476, prepush_runtime sf#828, triage_runtime sf#476 D18,
	// verb_runtime sf#829, implement_runtime sf#826: one rule, five fields.
	test("each *_runtime field: absent means box, accepts box and actions, rejects others", () => {
		for (const field of [
			"pr_review_runtime",
			"prepush_runtime",
			"triage_runtime",
			"verb_runtime",
			"implement_runtime",
		] as const) {
			const absent = repositoryConfigSchema.safeParse(base);
			const box = repositoryConfigSchema.safeParse({ ...base, [field]: "box" });
			const actions = repositoryConfigSchema.safeParse({
				...base,
				provider: "forgejo",
				[field]: "actions",
			});
			expect({ field, ok: absent.success && box.success && actions.success }).toEqual({
				field,
				ok: true,
			});
			if (absent.success && box.success && actions.success) {
				expect(absent.data[field] ?? "box").toBe("box");
				expect(box.data[field]).toBe("box");
				expect(actions.data[field]).toBe("actions");
			}
			const bad = { ...base, [field]: "both" };
			expect({ field, ok: repositoryConfigSchema.safeParse(bad).success }).toEqual({
				field,
				ok: false,
			});
		}
	});

	test("pr_review_status: accepts advisory and enforcing, rejects others", () => {
		const forgejo = { ...base, provider: "forgejo" };
		const advisory = repositoryConfigSchema.safeParse({ ...forgejo, pr_review_status: "advisory" });
		const enforcing = repositoryConfigSchema.safeParse({
			...forgejo,
			pr_review_status: "enforcing",
		});
		expect(advisory.success && enforcing.success).toBe(true);
		if (advisory.success && enforcing.success) {
			expect(advisory.data.pr_review_status).toBe("advisory");
			expect(enforcing.data.pr_review_status).toBe("enforcing");
		}
		const loud = { ...forgejo, pr_review_status: "loud" };
		expect(repositoryConfigSchema.safeParse(loud).success).toBe(false);
	});
});

/**
 * The push-mode guard.
 *
 * `return_mode: "push"` is selectable in the enum but the mode is inert: no
 * least-privilege runner git identity exists and nothing ingests a push-mode
 * hand-back. The schema therefore refuses the combination unless the template
 * also carries an explicit `push_identity_ready: true`, so the mode cannot be
 * reached by editing one enum value.
 */
describe("jobTemplateConfigSchema push guard", () => {
	test("rejects return_mode push with no opt-in, naming sf#67 and the prerequisite", () => {
		const result = jobTemplateConfigSchema.safeParse({
			id: "implement",
			return_mode: "push",
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			const messages = result.error.issues.map((i) => i.message).join("\n");
			expect(messages).toContain("sf#67");
			expect(messages).toContain("push_identity_ready");
			expect(messages).toContain("least-privilege runner git identity");
			// The refusal is attributed to the field that carries the bad value.
			expect(result.error.issues.some((i) => i.path.join(".") === "return_mode")).toBe(true);
		}
	});

	test("rejects return_mode push when the opt-in is explicitly false", () => {
		const result = jobTemplateConfigSchema.safeParse({
			id: "implement",
			return_mode: "push",
			push_identity_ready: false,
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.map((i) => i.message).join("\n")).toContain("sf#67");
		}
	});

	test("accepts return_mode push when the opt-in is present", () => {
		const result = jobTemplateConfigSchema.safeParse({
			id: "implement",
			return_mode: "push",
			push_identity_ready: true,
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.return_mode).toBe("push");
			expect(result.data.push_identity_ready).toBe(true);
		}
	});

	test("leaves patch mode unaffected, with or without the opt-in field", () => {
		const explicit = jobTemplateConfigSchema.safeParse({
			id: "pr-review",
			return_mode: "patch",
		});
		expect(explicit.success).toBe(true);

		// The default path: a template naming no mode is still `patch` and valid.
		const defaulted = jobTemplateConfigSchema.safeParse({ id: "pr-review" });
		expect(defaulted.success).toBe(true);
		if (defaulted.success) {
			expect(defaulted.data.return_mode).toBe("patch");
			expect(defaulted.data.push_identity_ready).toBeUndefined();
		}

		// The opt-in flag is inert for patch: it neither enables nor blocks it.
		const flagged = jobTemplateConfigSchema.safeParse({
			id: "pr-review",
			return_mode: "patch",
			push_identity_ready: true,
		});
		expect(flagged.success).toBe(true);
	});

	test("still rejects an unknown key alongside the new field", () => {
		const result = jobTemplateConfigSchema.safeParse({
			id: "implement",
			return_mode: "push",
			push_identity_ready: true,
			backdoor: true,
		});
		expect(result.success).toBe(false);
	});

	test("the guard fires through the full config document, not just the template", () => {
		const base = {
			poll_interval_minutes: 15,
			repositories: [{ name: "rodaddy/x", provider: "forgejo" }],
		};
		const rejected = configSchema.safeParse({
			...base,
			job_templates: [{ id: "implement", return_mode: "push" }],
		});
		expect(rejected.success).toBe(false);
		if (!rejected.success) {
			expect(rejected.error.issues.map((i) => i.message).join("\n")).toContain("sf#67");
		}

		const accepted = configSchema.safeParse({
			...base,
			job_templates: [{ id: "implement", return_mode: "push", push_identity_ready: true }],
		});
		expect(accepted.success).toBe(true);
	});
});

/**
 * One repository, several images, each carrying its own ORDERED
 * ENVIRONMENT LIST (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §2). rtech-mcps ships
 * four Containerfiles and produces four images; `images` lets one tag build
 * each and bump each image's own app directories. The security boundaries are
 * the same class as `app_dirs`: an image name lands in a DNS label and a
 * registry path, a dockerfile lands in Kaniko's `--dockerfile=` inside the
 * cloned context.
 */
describe("repositoryConfigSchema build_bump.images", () => {
	const base = { name: "rodaddy/rtech-mcps", provider: "forgejo", checks: "static-only" };
	const images = [
		{
			name: "mcp-gitingest",
			dockerfile: "servers/gitingest/Containerfile",
			environments: [{ name: "live", app_dirs: ["mcp-gitingest"] }],
		},
		{ name: "mcp-unifi", dockerfile: "unifi-network-mcp/Containerfile" },
	];

	test("accepts a list of images, each with its own dockerfile and environments", () => {
		const result = repositoryConfigSchema.safeParse({ ...base, build_bump: { images } });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.build_bump?.images?.[0]?.dockerfile).toBe(
				"servers/gitingest/Containerfile",
			);
			expect(result.data.build_bump?.images?.[0]?.environments?.[0]?.app_dirs).toEqual([
				"mcp-gitingest",
			]);
			expect(result.data.build_bump?.images?.[1]?.environments).toBeUndefined();
			expect(result.data.build_bump?.environments).toBeUndefined();
		}
	});

	test("accepts a two-environment image: the rare multi-level shape", () => {
		const result = repositoryConfigSchema.safeParse({
			...base,
			build_bump: {
				images: [
					{
						name: "acme-portal",
						environments: [
							{ name: "uat", app_dirs: ["acme-portal-uat"] },
							{ name: "prod", app_dirs: ["acme-portal-prod"] },
						],
					},
				],
			},
		});
		expect(result.success).toBe(true);
	});

	test("an image's dockerfile defaults to the root Dockerfile", () => {
		const result = repositoryConfigSchema.safeParse({
			...base,
			build_bump: { images: [{ name: "mcp-proxmox" }] },
		});
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.build_bump?.images?.[0]?.dockerfile).toBe("Dockerfile");
		}
	});

	test("refuses images beside the top-level environments: targets live in one place", () => {
		const result = repositoryConfigSchema.safeParse({
			...base,
			build_bump: { images, environments: [{ name: "live", app_dirs: ["x"] }] },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.map((issue) => issue.message)).toContain(
				"images carry their own environments; the top-level environments list must be absent",
			);
		}
	});

	test("refuses an empty images list and more than ten", () => {
		expect(repositoryConfigSchema.safeParse({ ...base, build_bump: { images: [] } }).success).toBe(
			false,
		);
		const many = Array.from({ length: 11 }, (_, i) => ({ name: `img-${i}` }));
		expect(
			repositoryConfigSchema.safeParse({ ...base, build_bump: { images: many } }).success,
		).toBe(false);
	});

	test("refuses a repeated image name", () => {
		const result = repositoryConfigSchema.safeParse({
			...base,
			build_bump: { images: [{ name: "a" }, { name: "a", dockerfile: "b/Containerfile" }] },
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.map((issue) => issue.message)).toContain(
				"image 'a' is declared twice",
			);
		}
	});

	test("refuses an app dir claimed by two images: one bump PR per app dir", () => {
		// One directory is one manifest tree: two images bumping it would rewrite
		// the same fleet lines to two tags. The rule holds ACROSS environments, not
		// just within one.
		const result = repositoryConfigSchema.safeParse({
			...base,
			build_bump: {
				images: [
					{ name: "a", environments: [{ name: "uat", app_dirs: ["shared"] }] },
					{ name: "b", environments: [{ name: "live", app_dirs: ["shared"] }] },
				],
			},
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.issues.map((issue) => issue.message)).toContain(
				"app_dirs entry 'shared' belongs to more than one image",
			);
		}
		// The SAME image naming a directory once is the normal enrolment.
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: {
					images: [{ name: "a", environments: [{ name: "uat", app_dirs: ["shared"] }] }],
				},
			}).success,
		).toBe(true);
	});

	test("refuses a dockerfile that could leave the cloned context or read as an option", () => {
		for (const dockerfile of [
			"../Dockerfile",
			"a/../Dockerfile",
			"/Dockerfile",
			"-f",
			"a b/Dockerfile",
			"",
			`${"a/".repeat(120)}Dockerfile`,
		]) {
			expect(
				repositoryConfigSchema.safeParse({
					...base,
					build_bump: { images: [{ name: "a", dockerfile }] },
				}).success,
			).toBe(false);
		}
		expect(
			repositoryConfigSchema.safeParse({
				...base,
				build_bump: { images: [{ name: "a", dockerfile: "docker/Dockerfile.prod" }] },
			}).success,
		).toBe(true);
	});

	test("refuses an image name that is not a lowercase DNS label the render accepts", () => {
		for (const name of ["Mcp", "a_b", "-a", "a-", "a.b", "a".repeat(52), ""]) {
			expect(
				repositoryConfigSchema.safeParse({ ...base, build_bump: { images: [{ name }] } }).success,
			).toBe(false);
		}
	});

	test("refuses the removed per-image keys app_dirs and prod_app_dirs", () => {
		for (const removed of [{ app_dirs: ["x"] }, { prod_app_dirs: ["x"] }]) {
			const result = repositoryConfigSchema.safeParse({
				...base,
				build_bump: { images: [{ name: "a", ...removed }] },
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(JSON.stringify(result.error.issues)).toContain("unrecognized_keys");
			}
		}
	});

	test("an image's environments are validated like the top-level list", () => {
		for (const environments of [
			[],
			[{ name: "live", app_dirs: ["apps/x"] }],
			[{ name: "live", app_dirs: [".."] }],
			[{ name: "live", app_dirs: ["a".repeat(101)] }],
			[{ name: "live", app_dirs: ["x"], promote: "marker" }],
		]) {
			expect(
				repositoryConfigSchema.safeParse({
					...base,
					build_bump: { images: [{ name: "a", environments }] },
				}).success,
			).toBe(false);
		}
	});
});

/**
 * sf#812: `provider` is REQUIRED. A repository or audit schedule that names no
 * provider used to default silently to `github`, so a Forge repo that forgot the
 * key was watched on the wrong forge. It now fails validation, and the message
 * names the repository so the operator can find the entry.
 */
describe("provider fails closed", () => {
	const minimalConfig = (repo: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
		poll_interval_minutes: 15,
		repositories: [repo],
		...extra,
	});

	test("a repository entry without provider fails, naming the repository", () => {
		const result = configSchema.safeParse(minimalConfig({ name: "rodaddy/open-brain" }));
		expect(result.success).toBe(false);
		if (!result.success) {
			const messages = result.error.issues.map((i) => i.message).join("; ");
			expect(messages).toContain("rodaddy/open-brain");
			expect(messages).toContain("provider");
		}
	});

	test("an explicit github provider stays valid (D8: dormant, not removed)", () => {
		const result = repositoryConfigSchema.safeParse({ name: "rodaddy/x", provider: "github" });
		expect(result.success).toBe(true);
	});
});

describe("metrics_scrape_allow", () => {
	const base = {
		poll_interval_minutes: 15,
		repositories: [{ name: "rodaddy/x", provider: "forgejo" }],
	};

	test("absent defaults to an empty list: today's loopback-only /metrics", () => {
		const result = configSchema.safeParse(base);
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.metrics_scrape_allow).toEqual([]);
		}
	});

	test("accepts bare IPv4/IPv6 addresses and CIDRs", () => {
		const allow = ["10.0.20.5", "10.0.0.0/16", "fd00::1", "fd00::/8"];
		const result = configSchema.safeParse({ ...base, metrics_scrape_allow: allow });
		expect(result.success).toBe(true);
		if (result.success) {
			expect(result.data.metrics_scrape_allow).toEqual(allow);
		}
	});

	test.each([
		"not-an-ip",
		"10.0.0.0/33",
		"fd00::/129",
		"10.0.0.0/",
		"10.0.0.0/8/8",
		"host.example",
	])("rejects %p", (entry) => {
		const result = configSchema.safeParse({ ...base, metrics_scrape_allow: [entry] });
		expect(result.success).toBe(false);
	});
});

describe("repositoryConfigSchema static_runtime", () => {
	const base = { name: "rodaddy/example", provider: "forgejo", checks: "static-only" };

	test("absent (the box default) and box both parse, so the Actions dispatch stays off", () => {
		const absent = repositoryConfigSchema.safeParse(base);
		const box = repositoryConfigSchema.safeParse({ ...base, static_runtime: "box" });
		expect(absent.success && absent.data.static_runtime).toBeUndefined();
		expect(box.success && box.data.static_runtime).toBe("box");
	});

	test("accepts actions and rejects anything else", () => {
		const actions = repositoryConfigSchema.safeParse({ ...base, static_runtime: "actions" });
		expect(actions.success && actions.data.static_runtime).toBe("actions");
		expect(repositoryConfigSchema.safeParse({ ...base, static_runtime: "runner" }).success).toBe(
			false,
		);
	});
});

/**
 * Every `*_runtime: actions` flag hands the lane to a Forgejo Actions workflow,
 * so it needs a Forgejo repository: on a GitHub repository reconcile queues no
 * box job and no workflow exists to dispatch, so the lane silently disappears
 * (factory pr-review verdicts on PRs 889 and 896, group E of the MAP #810 sweep).
 * The schema refuses the pair, naming the repository and the flag.
 */
describe("runtime actions flags need a Forgejo provider (sweep-E)", () => {
	const flags = [
		"static_runtime",
		"pr_review_runtime",
		"implement_runtime",
		"triage_runtime",
		"verb_runtime",
		"prepush_runtime",
	] as const;

	for (const flag of flags) {
		test(`${flag}: actions on a github repository is refused, naming the repo`, () => {
			const result = repositoryConfigSchema.safeParse({
				name: "rodaddy/example",
				provider: "github",
				[flag]: "actions",
			});
			expect(result.success).toBe(false);
			if (!result.success) {
				expect(result.error.issues.map((issue) => issue.message)).toContain(
					`repository rodaddy/example: ${flag}: actions requires provider forgejo (got github)`,
				);
			}
		});

		test(`${flag}: actions on forgejo and box on github both parse`, () => {
			const forgejo = { name: "rodaddy/example", provider: "forgejo", [flag]: "actions" };
			const github = { name: "rodaddy/example", provider: "github", [flag]: "box" };
			expect(repositoryConfigSchema.safeParse(forgejo).success).toBe(true);
			expect(repositoryConfigSchema.safeParse(github).success).toBe(true);
		});
	}

	test("the full config document refuses the pair too", () => {
		const result = configSchema.safeParse({
			poll_interval_minutes: 15,
			repositories: [{ name: "rodaddy/example", provider: "github", triage_runtime: "actions" }],
		});
		expect(result.success).toBe(false);
	});
});
