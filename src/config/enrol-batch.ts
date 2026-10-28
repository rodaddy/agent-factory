/**
 * @file Batch build-bump enrolment: N declarations in, one all-or-nothing
 *   config edit out, with a named refusal per app.
 *
 * @why
 *   Mission 3 has 45 unenrolled applications and an explicit
 *   instruction not to onboard them one at a time. It asks for two things this
 *   module owns: a declaration per app that GENERATES the enrolment block
 *   rather than having it hand-written, and a batch path that reports per-app
 *   success or refusal and "never a partial silent apply".
 *
 *   PARTIAL APPLY IS THE FAILURE MODE, not a convenience. A run that enrols
 *   eight of ten apps and exits non-zero leaves the operator guessing which
 *   eight, and the config is the file the Ansible role renders onto the watcher host.
 *  So validation for EVERY declaration completes before
 *   anything is written, and a single refusal writes nothing at all.
 *
 *   VALIDATION IS DELEGATED, NEVER REIMPLEMENTED. Each generated block is
 *   checked by assembling a candidate config and handing it to the SAME
 *   `configSchema` the deployed watcher loads. That is deliberate: `app_dirs`
 *   regexes are a security boundary (they reach the bump script's `--app`
 *   argument), the ordered-environment invariants live in
 *   `buildBumpEnvironments`, and duplicate-image ownership is a cross-repository
 *   refinement. A second copy of those rules here would drift, and the drift
 *   would be silent.
 *
 * @dependencies
 *   - ./schema -- configSchema, the one authority on a valid enrolment
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { configSchema } from "./schema";
import { traced } from "../log";

/**
 * One app's enrolment intent, as an operator writes it.
 *
 * Deliberately flatter than the config block it produces: an operator knows the
 * source repository, the image its manifests pin, and the app directory. The
 * `images[]`-versus-single-image choice, the environment ordering, and the
 * YAML shape are this module's job, not theirs.
 */
export type EnrolDeclaration = {
	/** Owner-qualified Forge repository, e.g. `rodaddy/web-ops`. */
	readonly repository: string;
	/** Image name the manifests pin, e.g. `web-ops`. */
	readonly image: string;
	/**
	 * Manifest directories for the FIRST environment, in `rtech/k3s-deploy`.
	 * For a suffix-less app this directory IS production
	 * (`PROD_DEPLOY_SOP.md` section 2).
	 */
	readonly appDirs: readonly string[];
	/** First environment's name. Defaults to `live` for a single-level app. */
	readonly environment?: string;
	/** Tag glob. Defaults to the `v*` every pilot repository already tags with. */
	readonly tagPattern?: string;
};

/** What happened to one declaration. `ok: false` always names the app. */
export type EnrolOutcome =
	| { readonly ok: true; readonly repository: string; readonly image: string }
	| { readonly ok: false; readonly repository: string; readonly reason: string };

/** The whole run. `applied` is false whenever any outcome refused. */
export type EnrolBatchResult = {
	readonly applied: boolean;
	readonly outcomes: readonly EnrolOutcome[];
	/** Repositories to add, in declaration order. Empty when nothing applied. */
	readonly additions: readonly EnrolledRepository[];
};

/** The generated config entry for one enrolled repository. */
export type EnrolledRepository = {
	readonly name: string;
	readonly provider: "forgejo";
	readonly checks: "static-only";
	readonly build_bump: {
		readonly images: readonly {
			readonly name: string;
			readonly environments: readonly {
				readonly name: string;
				readonly app_dirs: readonly string[];
			}[];
		}[];
		readonly tag_pattern: string;
	};
};

/** Default first-environment name for a single-level app. */
const DEFAULT_ENVIRONMENT = "live";
/** Default tag glob. */
const DEFAULT_TAG_PATTERN = "v*";

/**
 * Generate the config entry for one declaration.
 *
 * Always the `images[]` form, never the single-image shorthand. The shorthand
 * derives the image name from the repository's SHORT NAME, and every app
 * enrolled so far has an image or app directory that differs from it
 * (`rodaddy/web-ops` -> image `web-ops` -> app dir `ops`). Being explicit costs
 * three lines and removes a whole class of mis-targeted bump.
 */
function generate(decl: EnrolDeclaration): EnrolledRepository {
	return {
		name: decl.repository,
		provider: "forgejo",
		checks: "static-only",
		build_bump: {
			images: [
				{
					name: decl.image,
					environments: [
						{
							name: decl.environment ?? DEFAULT_ENVIRONMENT,
							app_dirs: [...decl.appDirs],
						},
					],
				},
			],
			tag_pattern: decl.tagPattern ?? DEFAULT_TAG_PATTERN,
		},
	};
}

/**
 * Placeholder poll interval used ONLY to make a partial document parseable.
 *
 * `poll_interval_minutes` is the one required top-level key besides
 * `repositories`, and a caller validating a declaration may legitimately hold a
 * document that lacks it. Without this, EVERY declaration would refuse with
 * "poll_interval_minutes: expected number, received undefined" -- a reason that
 * names a field the operator never touched and hides the real defect. It is
 * never written anywhere: the planner returns repository entries only.
 */
const PLACEHOLDER_POLL_INTERVAL = 15;

/**
 * Assemble the candidate config handed to `configSchema`.
 *
 * The caller's own top-level values are preserved so their real settings take
 * part in validation; only a MISSING required key is filled. Filling a key the
 * caller DID set would validate a config that does not exist.
 */
function candidateConfig(
	existing: Record<string, unknown>,
	repositories: readonly unknown[],
): Record<string, unknown> {
	const candidate: Record<string, unknown> = { ...existing, repositories: [...repositories] };
	if (typeof candidate.poll_interval_minutes !== "number") {
		candidate.poll_interval_minutes = PLACEHOLDER_POLL_INTERVAL;
	}
	return candidate;
}

/** First Zod issue, path-qualified, so a refusal names the offending field. */
function firstIssue(error: {
	issues: readonly { path: readonly PropertyKey[]; message: string }[];
}): string {
	const issue = error.issues[0];
	if (!issue) return "rejected by the config schema";
	const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
	return `${path}: ${issue.message}`;
}

/**
 * Validate every declaration against the existing config, then report.
 *
 * @param existing - the current config object, already parsed from YAML. Passed
 *   as the raw shape rather than a `WatcherConfig` because the caller may hold
 *   a document it intends to write back.
 * @param declarations - one per app, in the order the operator listed them.
 * @returns every outcome, and the additions ONLY when all of them passed.
 *
 * Each declaration is checked against the existing config PLUS the declarations
 * already accepted in this run. That ordering matters: two declarations naming
 * the same image is exactly the collision `refineBuildBumpImages` exists to
 * catch, and checking them independently would let the pair through.
 */
export const planEnrolBatch = traced(
	"config.planEnrolBatch",
	function planEnrolBatch(
		existing: { readonly repositories?: readonly unknown[] } & Record<string, unknown>,
		declarations: readonly EnrolDeclaration[],
	): EnrolBatchResult {
		const outcomes: EnrolOutcome[] = [];
		const additions: EnrolledRepository[] = [];
		const baseRepositories = Array.isArray(existing.repositories) ? existing.repositories : [];

		for (const decl of declarations) {
			const alreadyEnrolled = baseRepositories.some(
				(r) =>
					typeof r === "object" &&
					r !== null &&
					(r as { name?: unknown }).name === decl.repository &&
					(r as { build_bump?: unknown }).build_bump !== undefined,
			);
			if (alreadyEnrolled) {
				// Not an error and not a silent skip: an operator re-running a batch
				// wants to be told which apps were already done.
				outcomes.push({
					ok: false,
					repository: decl.repository,
					reason: "already enrolled: the repository already carries a build_bump block",
				});
				continue;
			}

			const entry = generate(decl);
			// The candidate config is the real one plus everything accepted so far,
			// so cross-repository refinements see the whole picture.
			const candidate = candidateConfig(existing as Record<string, unknown>, [
				...baseRepositories,
				...additions,
				entry,
			]);
			const parsed = configSchema.safeParse(candidate);
			if (!parsed.success) {
				outcomes.push({ ok: false, repository: decl.repository, reason: firstIssue(parsed.error) });
				continue;
			}

			additions.push(entry);
			outcomes.push({ ok: true, repository: decl.repository, image: decl.image });
		}

		const applied = outcomes.every((o) => o.ok) && outcomes.length > 0;
		// ALL OR NOTHING. Returning the additions on a partial run is how a caller
		// writes eight of ten apps and leaves the operator guessing.
		return { applied, outcomes, additions: applied ? additions : [] };
	},
);

/**
 * Render the accepted additions as YAML to append to a config's repositories
 * list.
 *
 * Hand-rolled rather than via a YAML serializer, and that is a judgment call
 * worth stating: the target file carries load-bearing comments and an
 * Ansible-managed block, so round-tripping it through a serializer would
 * reformat the whole document. This emits only the new entries, in the flow
 * style the file already uses, which makes the diff reviewable.
 */
export const renderEnrolYaml = traced(
	"config.renderEnrolYaml",
	function renderEnrolYaml(additions: readonly EnrolledRepository[]): string {
		const lines: string[] = [];
		for (const repo of additions) {
			lines.push(`  - name: ${repo.name}`);
			lines.push(`    provider: ${repo.provider}`);
			lines.push(`    checks: ${repo.checks}`);
			lines.push("    build_bump:");
			lines.push("      images:");
			for (const image of repo.build_bump.images) {
				lines.push(`        - name: ${image.name}`);
				lines.push("          environments:");
				for (const env of image.environments) {
					lines.push(`            - { name: ${env.name}, app_dirs: [${env.app_dirs.join(", ")}] }`);
				}
			}
			lines.push(`      tag_pattern: "${repo.build_bump.tag_pattern}"`);
		}
		return lines.length > 0 ? `${lines.join("\n")}\n` : "";
	},
);
