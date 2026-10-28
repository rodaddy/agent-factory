/**
 * @module imagebuild/images
 * @description The ONE place a `build_bump` block is turned into the images a
 *   tag builds. Every consumer — intake (one candidate row per image),
 *   the bump pass (an image's own environments) — reads the block through here,
 *   so the legacy single-image shape and the `images` shape cannot drift apart
 *   between lanes.
 *
 *   A block WITHOUT `images` is exactly one image: the repository's short name
 *   built from the root Dockerfile, carrying the block's own `environments`. That is
 *   what every enrolment before sf#645 meant, and it is what the 0020 backfill
 *   wrote onto every pre-existing candidate row.
 *
 * @outputs
 *   - `BuildBumpImage` -- one image: name, dockerfile, its `environments`
 *   - `buildBumpImagesFor` -- the images a repository's block declares
 *   - `buildBumpImageNamed` -- one of them, by image name
 */
import type { BuildBumpImageConfig } from "../config/build-bump-images";
import type { WatcherConfig } from "../config/schema";
import { traced } from "../log";

export type BuildBumpBlock = NonNullable<WatcherConfig["repositories"][number]["build_bump"]>;
export type BuildBumpImage = BuildBumpImageConfig;

/**
 * The images one repository's `build_bump` block declares, in declaration order.
 *
 * @param repository - `<owner>/<repo>`, whose short name is the legacy image name
 * @param bump - the repository's `build_bump` block
 */
export const buildBumpImagesFor = traced(
	"imagebuild.buildBumpImagesFor",
	function buildBumpImagesFor(repository: string, bump: BuildBumpBlock): BuildBumpImage[] {
		if (bump.images) return bump.images;
		const name = repository.slice(repository.indexOf("/") + 1);
		return [
			{
				name,
				dockerfile: "Dockerfile",
				...(bump.environments ? { environments: bump.environments } : {}),
			},
		];
	},
);

/** One declared image by name, or `undefined` when the block no longer names it. */
export const buildBumpImageNamed = traced(
	"imagebuild.buildBumpImageNamed",
	function buildBumpImageNamed(
		repository: string,
		bump: BuildBumpBlock,
		image: string,
	): BuildBumpImage | undefined {
		return buildBumpImagesFor(repository, bump).find((candidate) => candidate.name === image);
	},
);
