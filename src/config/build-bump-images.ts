/**
 * @module config/build-bump-images
 * @description The `images` half of a `build_bump` enrolment and the
 *   ENVIRONMENTS primitive every enrolment declares
 *   (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §1-2): ONE repository, SEVERAL images,
 *   each image an ORDERED LIST of environments. rtech-mcps ships four
 *   Containerfiles and publishes four images (`mcp-gitingest`, `mcp-amazon`,
 *   `mcp-proxmox`, `mcp-unifi`) from one tag; the single-image shape — the
 *   repository's short name built from the root Dockerfile — assumed one
 *   repository tag is one image, and enrolled rtech-mcps as a build of
 *   `rtech-mcps-servers` that nothing consumes any more.
 *
 *   AN ENVIRONMENT IS A PROMOTION RULE, NOT A NAME THE CODE KNOWS. The first
 *   environment in a list follows the VERSION TAG stream (`promote: tag`);
 *   every later one follows a MOVABLE TAG named after itself
 *   (`promote: marker`, `marker` defaulting to the environment `name`). So the
 *   common case is one environment, one line, and no marker, while a
 *   multi-level repository declares as many levels as it has. No string "uat"
 *   or "prod" appears in this module: the words live only in configuration.
 *
 *   TWO SECURITY BOUNDARIES, THE SAME CLASS AS `app_dirs`. An image NAME lands
 *   in the Kaniko Job's `generateName` and `app` label and in the registry
 *   path, so it is the lowercase RFC 1123 DNS label the render would refuse
 *   otherwise (`src/imagebuild/job.ts`), short enough for `build-<name>-` plus
 *   the generated suffix to fit a label. A DOCKERFILE lands in Kaniko's
 *   `--dockerfile=` inside the cloned context: refusing a leading `/` or `-`,
 *   any `..` segment, and whitespace is what keeps it a file inside the checkout
 *   and not an option or an escape. An ENVIRONMENT NAME is the same class again
 *   — it is a DNS label, max 16, matching the hosted-app registry target rule
 *   (`src/hostedapp/schema.ts` `dns1123(16)`) — and a MARKER is a plain tag
 *   name read back from the forge's tag listing.
 *
 *   TARGETS LIVE IN ONE PLACE. A block declaring `images` may not also carry
 *   the top-level `environments`: each image names its own. An app directory
 *   belongs to at most one environment across the WHOLE repository, because the
 *   bump script rewrites every fleet image line under that directory to ONE
 *   tag — two environments sharing a directory would open two PRs for the same
 *   manifest.
 *
 * @outputs
 *   - `buildBumpAppDirs` -- the plain app-directory list
 *   - `buildBumpEnvironmentSchema`, `buildBumpEnvironments` -- one environment,
 *     and the ordered list with its invariants
 *   - `resolvedEnvironments` -- the list with `promote`/`marker` defaults applied
 *   - `buildBumpImageSchema` -- one declared image
 *   - `refineBuildBumpImages` -- the cross-field rules over a whole block
 */
import { z } from "zod";

/** `build-<name>-` plus the 5-character generated suffix must fit a 63-char label. */
const IMAGE_NAME_MAX = 51;

/** An environment name is the hosted-app registry target rule: a DNS label, max 16. */
const ENVIRONMENT_NAME_MAX = 16;

/**
 * Plain app directory names an environment owns.
 * The regex is the SECURITY BOUNDARY: entries reach the bump script's `--app`
 * argument, so `/`, `..`, whitespace, and an option-shaped leading `-` are
 * refused here, not downstream.
 */
export const buildBumpAppDirs = z
	.array(
		z
			.string()
			.max(100)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a plain app directory name"),
	)
	.min(1)
	.max(10);

/**
 * ONE environment: a name, the app directories it owns, and how it promotes.
 *
 * `promote` and `marker` are optional because their defaults are POSITIONAL and
 * therefore cannot be expressed by a field default — index 0 promotes by tag,
 * every later index by a marker named after itself. `resolvedEnvironments`
 * applies them.
 */
export const buildBumpEnvironmentSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(ENVIRONMENT_NAME_MAX)
			.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "must be a lowercase DNS label"),
		app_dirs: buildBumpAppDirs,
		promote: z.enum(["tag", "marker"]).optional(),
		marker: z
			.string()
			.min(1)
			.max(100)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a plain tag name")
			.optional(),
	})
	.strict();

export type BuildBumpEnvironment = z.infer<typeof buildBumpEnvironmentSchema>;

/** An environment with its positional defaults applied. */
export interface ResolvedBuildBumpEnvironment extends BuildBumpEnvironment {
	promote: "tag" | "marker";
	marker: string;
}

/**
 * Apply the POSITIONAL defaults: the first environment promotes by the version
 * tag stream, every later one by a movable tag named after itself. Pure, and the
 * single place any consumer learns what an unstated `promote`/`marker` means.
 */
export function resolvedEnvironments(
	list: readonly BuildBumpEnvironment[],
): ResolvedBuildBumpEnvironment[] {
	return list.map((env, index) => {
		const promote = env.promote ?? (index === 0 ? "tag" : "marker");
		return { ...env, promote, marker: env.marker ?? env.name };
	});
}

/**
 * The ordered environment list, with the invariants a test pins by message.
 *
 * Exactly ONE environment may follow the version-tag stream and it must be the
 * first: that is what makes "the newest tag" a single unambiguous entry point
 * and every later level a deliberate marker move.
 */
export const buildBumpEnvironments = z
	.array(buildBumpEnvironmentSchema)
	.min(1)
	.max(10)
	.superRefine((list, ctx) => {
		const issue = (message: string) => ctx.addIssue({ code: "custom", message });
		const names = new Set<string>();
		for (const env of list) {
			if (names.has(env.name)) issue(`environment '${env.name}' is declared twice`);
			names.add(env.name);
		}
		const dirOwner = new Map<string, string>();
		for (const env of list) {
			for (const dir of env.app_dirs) {
				const holder = dirOwner.get(dir);
				if (holder !== undefined && holder !== env.name) {
					issue(`app_dirs entry '${dir}' belongs to more than one environment`);
				}
				dirOwner.set(dir, env.name);
			}
		}
		const resolved = resolvedEnvironments(list);
		const markerOwner = new Map<string, string>();
		for (const env of resolved) {
			if (env.promote !== "marker") continue;
			const holder = markerOwner.get(env.marker);
			if (holder !== undefined && holder !== env.name) {
				issue(`marker '${env.marker}' is used by more than one environment`);
			}
			markerOwner.set(env.marker, env.name);
		}
		for (const [index, env] of list.entries()) {
			if (index > 0 && env.promote === "tag")
				issue("only the first environment may promote by tag");
			if (index === 0 && env.promote === "marker")
				issue("the first environment must promote by tag");
		}
		for (const [index, env] of list.entries()) {
			if (env.marker !== undefined && resolved[index]?.promote === "tag") {
				issue(`environment '${env.name}' sets marker but promotes by tag`);
			}
		}
	});

export const buildBumpImageSchema = z
	.object({
		name: z
			.string()
			.min(1)
			.max(IMAGE_NAME_MAX)
			.regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/, "must be a lowercase DNS label"),
		dockerfile: z
			.string()
			.min(1)
			.max(200)
			.regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "must be a plain repo-relative path")
			.refine((path) => !path.split("/").includes(".."), {
				message: "must not contain a '..' segment",
			})
			.default("Dockerfile"),
		environments: buildBumpEnvironments.optional(),
	})
	.strict();

export type BuildBumpImageConfig = z.infer<typeof buildBumpImageSchema>;

interface ImagesBlock {
	images?: BuildBumpImageConfig[];
	environments?: BuildBumpEnvironment[];
}

/** The cross-field rules a block with `images` must satisfy (see the header). */
export function refineBuildBumpImages(bump: ImagesBlock, ctx: z.RefinementCtx): void {
	const images = bump.images;
	if (!images) return;
	const issue = (message: string) => ctx.addIssue({ code: "custom", path: ["images"], message });
	if (bump.environments !== undefined) {
		issue("images carry their own environments; the top-level environments list must be absent");
	}
	const names = new Set<string>();
	for (const image of images) {
		if (names.has(image.name)) issue(`image '${image.name}' is declared twice`);
		names.add(image.name);
	}
	// ONE owner per directory across EVERY image's environments (PR #688 round
	// 1): each bump rewrites the same manifest tree, so two images naming one
	// directory — in any environment — would send two tags to it.
	const owner = new Map<string, string>();
	for (const image of images) {
		for (const env of image.environments ?? []) {
			for (const dir of env.app_dirs) {
				const holder = owner.get(dir);
				if (holder !== undefined && holder !== image.name) {
					issue(`app_dirs entry '${dir}' belongs to more than one image`);
				}
				owner.set(dir, image.name);
			}
		}
	}
}
