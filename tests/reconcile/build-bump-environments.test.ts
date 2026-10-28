/**
 * @module tests/reconcile/build-bump-environments
 * @description Table-driven tests for the PURE build-bump environment selection
 *   (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §6) at ONE, TWO, and THREE environments.
 *   They assert: the tag-stream branch takes the newest BUILT candidate by forge
 *   commit date with NULLs last and id DESC as the tiebreak; a single-environment
 *   repository IGNORES any marker row that happens to exist; a marker branch
 *   deploys whichever version tag shares the marker's commit even when it is
 *   OLDER than the newest (`allowOlder: true`); a marker on a commit with no
 *   matching version tag is `marker-unmatched` rather than silence; a marker on a
 *   `failed` candidate names that candidate as `marker-unbuilt`; a marker whose
 *   commit carries only a tag failing `tag_pattern` is `marker-unmatched`; and
 *   three environments resolve independently, an environment's `marker` override
 *   reading its OWN row.
 *
 *   MUTATION RECEIPTS: flipping the tag branch's DESC order to ASC
 *   failed "newest built by date wins"; dropping the `matchesTagPattern` call in
 *   the marker branch failed "marker sha whose only tag fails the pattern".
 *   sf#729 lane: reverting the tiebreak to `a.id - b.id` failed "two UNDATED
 *   built rows pick the LATER row" and "equal dates break by id DESC".
 */
import { describe, expect, test } from "bun:test";
import type { WatcherConfig } from "../../src/config/schema";
import type { BuildBumpCandidateRow, BuildBumpMarkerRow } from "../../src/db/schema";
import {
	desiredCandidateFor,
	environmentsOf,
	type ResolvedEnvironment,
} from "../../src/reconcile/build-bump-environments";

const REPO = "rodaddy/x";
const IMAGE = "x";

/**
 * One candidate row. `date` is the forge commit date as an ISO day, and `null`
 * is the "unknown" the sort must place LAST rather than treat as old.
 */
function row(args: {
	id: number;
	tag: string;
	sha: string;
	status?: string;
	date?: string | null;
}): BuildBumpCandidateRow {
	return {
		id: args.id,
		repository: REPO,
		tag: args.tag,
		sha: args.sha,
		image: IMAGE,
		dockerfile: "Dockerfile",
		status: args.status ?? "built",
		createdAt: new Date("2026-09-01T00:00:00Z"),
		buildJobName: null,
		buildStartedAt: null,
		buildFinishedAt: null,
		buildReason: null,
		tagCreatedAt: args.date === null || args.date === undefined ? null : new Date(args.date),
	} as BuildBumpCandidateRow;
}

/** One movable-tag row: the marker's NAME and the COMMIT sha it resolves to. */
function marker(name: string, sha: string): BuildBumpMarkerRow {
	return {
		id: 1,
		repository: REPO,
		marker: name,
		sha,
		seenAt: new Date("2026-09-01T00:00:00Z"),
	} as BuildBumpMarkerRow;
}

const tagEnv = (name: string): ResolvedEnvironment => ({
	name,
	appDirs: [`${name}-app`],
	promote: "tag",
});
const markerEnv = (name: string, mark = name): ResolvedEnvironment => ({
	name,
	appDirs: [`${name}-app`],
	promote: "marker",
	marker: mark,
});

interface Case {
	name: string;
	env: ResolvedEnvironment;
	candidates: BuildBumpCandidateRow[];
	markers: BuildBumpMarkerRow[];
	pattern?: string;
	expect: (got: ReturnType<typeof desiredCandidateFor>) => void;
}

const bumpOf =
	(tag: string, allowOlder: boolean) => (got: ReturnType<typeof desiredCandidateFor>) => {
		expect(got.kind).toBe("bump");
		if (got.kind !== "bump") return;
		expect(got.candidate.tag).toBe(tag);
		expect(got.allowOlder).toBe(allowOlder);
	};
const noneOf = () => (got: ReturnType<typeof desiredCandidateFor>) => {
	expect(got.kind).toBe("none");
};

// ---- one environment: the common case, tag stream only, markers never read ----
const v57 = row({ id: 1, tag: "v0.2.57", sha: "aaa", date: "2026-09-01T00:00:00Z" });
const v61 = row({ id: 2, tag: "v0.2.61", sha: "bbb", date: "2026-09-05T00:00:00Z" });

const oneEnvironment: Case[] = [
	{
		name: "one environment: newest built by date wins",
		env: tagEnv("e1"),
		candidates: [v57, v61],
		markers: [],
		expect: bumpOf("v0.2.61", false),
	},
	{
		name: "one environment: a NULL commit date sorts LAST, never newest",
		env: tagEnv("e1"),
		candidates: [row({ id: 9, tag: "v9.9.9", sha: "ccc", date: null }), v57],
		markers: [],
		expect: bumpOf("v0.2.57", false),
	},
	{
		name: "one environment: equal dates break by id DESC, the later observation",
		env: tagEnv("e1"),
		candidates: [
			row({ id: 8, tag: "v1.0.1", sha: "d2", date: "2026-09-05T00:00:00Z" }),
			row({ id: 3, tag: "v1.0.0", sha: "d1", date: "2026-09-05T00:00:00Z" }),
		],
		markers: [],
		expect: bumpOf("v1.0.1", false),
	},
	{
		// The the watcher host symptom (644dd3d9): every row predates migration 0021, so
		// every date is NULL and the tiebreak alone decides. An ASCENDING tiebreak
		// named the OLDEST built candidate — mcp2cli desired v0.3.18 while v0.3.20
		// was already built.
		name: "one environment: two UNDATED built rows pick the LATER row (sf#729)",
		env: tagEnv("e1"),
		candidates: [
			row({ id: 1, tag: "v0.3.18", sha: "u1", date: null }),
			row({ id: 2, tag: "v0.3.20", sha: "u2", date: null }),
		],
		markers: [],
		expect: bumpOf("v0.3.20", false),
	},
	{
		// The tiebreak NEVER overrides a known date: NULL stays last even when its
		// row is the later observation, because NULL is "unknown" and not "new".
		name: "one environment: a DATED older row beats an UNDATED later row",
		env: tagEnv("e1"),
		candidates: [
			row({ id: 50, tag: "v2.0.0", sha: "n1", date: null }),
			row({ id: 4, tag: "v1.9.0", sha: "n2", date: "2026-01-01T00:00:00Z" }),
		],
		markers: [],
		expect: bumpOf("v1.9.0", false),
	},
	{
		name: "one environment: nothing built yet is none",
		env: tagEnv("e1"),
		candidates: [
			row({ id: 1, tag: "v0.1.0", sha: "aaa", status: "pending", date: "2026-09-01T00:00:00Z" }),
		],
		markers: [],
		expect: noneOf(),
	},
	{
		name: "one environment: a marker row present is IGNORED",
		env: tagEnv("e1"),
		candidates: [v57, v61],
		markers: [marker("prod", "aaa")],
		expect: bumpOf("v0.2.61", false),
	},
];

// ---- two environments: a tag stream and a movable tag over the same rows ----
const twoEnvironments: Case[] = [
	{
		name: "two environments: the tag-stream level picks the newest built",
		env: tagEnv("first"),
		candidates: [v57, v61],
		markers: [marker("second", "aaa")],
		expect: bumpOf("v0.2.61", false),
	},
	{
		name: "two environments: the marker level with NO marker row never moves",
		env: markerEnv("second"),
		candidates: [v57, v61],
		markers: [],
		expect: noneOf(),
	},
	{
		name: "two environments: a marker on the older sha deploys the OLDER version",
		env: markerEnv("second"),
		candidates: [v57, v61],
		markers: [marker("second", "aaa")],
		expect: bumpOf("v0.2.57", true),
	},
	{
		name: "two environments: a marker on a sha with no candidate is marker-unmatched",
		env: markerEnv("second"),
		candidates: [v57, v61],
		markers: [marker("second", "zzz")],
		expect: (got) => {
			expect(got).toEqual({ kind: "marker-unmatched", marker: "second", sha: "zzz" });
		},
	},
	{
		name: "two environments: a marker on a failed candidate is marker-unbuilt",
		env: markerEnv("second"),
		candidates: [
			row({ id: 4, tag: "v0.3.0", sha: "fff", status: "failed", date: "2026-09-06T00:00:00Z" }),
		],
		markers: [marker("second", "fff")],
		expect: (got) => {
			expect(got.kind).toBe("marker-unbuilt");
			if (got.kind !== "marker-unbuilt") return;
			expect(got.candidate.tag).toBe("v0.3.0");
			expect(got.candidate.status).toBe("failed");
		},
	},
	{
		name: "two environments: marker sha whose only tag fails the pattern is marker-unmatched",
		env: markerEnv("second"),
		candidates: [row({ id: 5, tag: "release-7", sha: "ggg", date: "2026-09-07T00:00:00Z" })],
		markers: [marker("second", "ggg")],
		pattern: "v*",
		expect: (got) => {
			expect(got).toEqual({ kind: "marker-unmatched", marker: "second", sha: "ggg" });
		},
	},
];

// ---- three environments: one tag stream, two independent movable tags ----
const threeCandidates = [
	row({ id: 1, tag: "v1.0.0", sha: "s1", date: "2026-09-01T00:00:00Z" }),
	row({ id: 2, tag: "v1.1.0", sha: "s2", date: "2026-09-02T00:00:00Z" }),
	row({ id: 3, tag: "v1.2.0", sha: "s3", date: "2026-09-03T00:00:00Z" }),
];
const threeMarkers = [marker("mid", "s2"), marker("last", "s1"), marker("stage", "s3")];

const threeEnvironments: Case[] = [
	{
		name: "three environments: the tag level takes the newest",
		env: tagEnv("early"),
		candidates: threeCandidates,
		markers: threeMarkers,
		expect: bumpOf("v1.2.0", false),
	},
	{
		name: "three environments: the middle level reads its OWN marker",
		env: markerEnv("mid"),
		candidates: threeCandidates,
		markers: threeMarkers,
		expect: bumpOf("v1.1.0", true),
	},
	{
		name: "three environments: the last level reads its own, older marker",
		env: markerEnv("last"),
		candidates: threeCandidates,
		markers: threeMarkers,
		expect: bumpOf("v1.0.0", true),
	},
	{
		name: "three environments: a renamed marker reads the renamed row, not the name row",
		env: markerEnv("mid", "stage"),
		candidates: threeCandidates,
		markers: threeMarkers,
		expect: bumpOf("v1.2.0", true),
	},
];

describe("desiredCandidateFor", () => {
	for (const c of [...oneEnvironment, ...twoEnvironments, ...threeEnvironments]) {
		test(c.name, () => {
			c.expect(desiredCandidateFor(c.env, c.candidates, c.markers, c.pattern ?? "v*"));
		});
	}
});

/** A config with one repository whose `build_bump` block is supplied verbatim. */
function config(buildBump?: Record<string, unknown>): WatcherConfig {
	const repo: Record<string, unknown> = { name: REPO, provider: "forgejo" };
	if (buildBump) repo.build_bump = buildBump;
	return { repositories: [repo] } as unknown as WatcherConfig;
}

describe("environmentsOf", () => {
	test("no build_bump block is not-enrolled", () => {
		expect(environmentsOf(config(), REPO, IMAGE)).toBe("not-enrolled");
	});

	test("an unknown repository is not-enrolled", () => {
		expect(environmentsOf(config({}), "rodaddy/other", IMAGE)).toBe("not-enrolled");
	});

	test("an image the images list does not name is not-enrolled", () => {
		const cfg = config({ images: [{ name: "a", environments: [{ name: "e", app_dirs: ["d"] }] }] });
		expect(environmentsOf(cfg, REPO, "b")).toBe("not-enrolled");
	});

	test("neither environments nor images is build-only", () => {
		expect(environmentsOf(config({}), REPO, IMAGE)).toBe("build-only");
	});

	test("an images entry with no environments is build-only", () => {
		expect(environmentsOf(config({ images: [{ name: IMAGE }] }), REPO, IMAGE)).toBe("build-only");
	});

	test("images are found BY NAME and own their own environments", () => {
		const cfg = config({
			images: [
				{ name: "a", environments: [{ name: "ea", app_dirs: ["da"] }] },
				{ name: "b", environments: [{ name: "eb", app_dirs: ["db"] }] },
			],
		});
		expect(environmentsOf(cfg, REPO, "b")).toEqual([
			{ name: "eb", appDirs: ["db"], promote: "tag" },
		]);
	});

	test("without images the image is the repository SHORT NAME and reads the top-level list", () => {
		const cfg = config({ environments: [{ name: "only", app_dirs: ["d"] }] });
		expect(environmentsOf(cfg, REPO, IMAGE)).toEqual([
			{ name: "only", appDirs: ["d"], promote: "tag" },
		]);
		expect(environmentsOf(cfg, REPO, "x-servers")).toBe("not-enrolled");
	});

	test("positional defaults: index 0 promotes by tag, every later one by a marker named after itself", () => {
		const cfg = config({
			environments: [
				{ name: "a", app_dirs: ["da"] },
				{ name: "b", app_dirs: ["db"] },
				{ name: "c", app_dirs: ["dc"], marker: "stage" },
			],
		});
		expect(environmentsOf(cfg, REPO, IMAGE)).toEqual([
			{ name: "a", appDirs: ["da"], promote: "tag" },
			{ name: "b", appDirs: ["db"], promote: "marker", marker: "b" },
			{ name: "c", appDirs: ["dc"], promote: "marker", marker: "stage" },
		]);
	});
});
