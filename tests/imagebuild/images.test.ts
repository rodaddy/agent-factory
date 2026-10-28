/**
 * @module tests/imagebuild/images
 * @description The one place a `build_bump` block is turned into the images a
 *   tag builds. A block without `images` is the legacy single-image
 *   shape: the repository's short name from the root Dockerfile, carrying the
 *   block's own `environments`. A block with `images` is taken verbatim.
 */
import { describe, expect, test } from "bun:test";
import { buildBumpImagesFor } from "../../src/imagebuild/images";

describe("buildBumpImagesFor", () => {
	test("a block without images is one image: the short name, the root Dockerfile, the block's environments", () => {
		const environments = [
			{ name: "uat", app_dirs: ["mcps-uat"] },
			{ name: "prod", app_dirs: ["mcps"] },
		];
		expect(
			buildBumpImagesFor("rodaddy/rtech-mcps", {
				tag_pattern: "v*",
				environments,
			}),
		).toEqual([
			{
				name: "rtech-mcps",
				dockerfile: "Dockerfile",
				environments,
			},
		]);
	});

	test("a build-only block is one image with no environments at all", () => {
		expect(buildBumpImagesFor("rodaddy/rtech-mcps", { tag_pattern: "v*" })).toEqual([
			{ name: "rtech-mcps", dockerfile: "Dockerfile" },
		]);
	});

	test("a block with images is those images, in declaration order", () => {
		const images = [
			{
				name: "mcp-gitingest",
				dockerfile: "servers/gitingest/Containerfile",
				environments: [{ name: "live", app_dirs: ["mcp-gitingest"] }],
			},
			{ name: "mcp-unifi", dockerfile: "unifi-network-mcp/Containerfile" },
		];
		expect(buildBumpImagesFor("rodaddy/rtech-mcps", { tag_pattern: "v*", images })).toEqual(images);
	});
});
