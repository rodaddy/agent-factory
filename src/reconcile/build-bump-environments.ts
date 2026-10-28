/**
 * @module reconcile/build-bump-environments
 * @description The PURE selection half of the build-bump bump pass
 *   (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §6): which environments an enrolled
 *   (repository, image) has, and which candidate each of them WANTS right now.
 *   No I/O, no database, no logging — the pass reads rows and writes rows, this
 *   module decides, so the selection is table-tested at one, two, and three
 *   environments instead of only through a live schema.
 *
 *   AN ENVIRONMENT IS A PROMOTION RULE, NOT A NAME THE CODE KNOWS. `promote:
 *   tag` follows the VERSION TAG stream and takes the newest built candidate;
 *   `promote: marker` follows a MOVABLE TAG and takes whichever version tag
 *   shares the marker's commit — which may legitimately be an OLDER version
 *   than the newest, which is why that answer carries `allowOlder: true` and
 *   the tag-stream answer never does. No environment name appears in this
 *   module: the words live only in configuration.
 *
 *   RECENCY IS THE FORGE COMMIT DATE, NEVER THE ROW ID. Both branches order
 *   `tagCreatedAt DESC NULLS LAST, id ASC` — the same order the candidate index
 *   carries — because NULL means "unknown", never "old", and row id runs in
 *   opposite directions for a repository enrolled in one batch versus one grown
 *   tag by tag.
 *
 *   NOT FINDING SOMETHING IS FOUR DIFFERENT ANSWERS, and the caller acts
 *   differently on each: `none` is the normal quiet state (no marker, or nothing
 *   built yet), `marker-unmatched` is a marker pointing at a commit this image
 *   has no matching version tag for (warn once), and `marker-unbuilt` names the
 *   candidate the caller may requeue. Collapsing them into `undefined` is what
 *   would make a misplaced marker indistinguishable from a converged repository.
 *
 * @outputs
 *   - `ResolvedEnvironment` -- one environment with its positional defaults applied
 *   - `environmentsOf` -- the environments an enrolled (repository, image) declares
 *   - `Desired` -- what one environment wants: a bump, nothing, or a named gap
 *   - `desiredCandidateFor` -- the desired answer for one environment
 *
 * @dependencies
 *   - ../config/build-bump-images -- the environment primitive and its defaults
 *   - ../config/schema -- the managed repositories and their `build_bump` blocks
 *   - ../db/schema -- the candidate and marker ROW TYPES only (no client)
 *   - ../log -- the shared traced() wrapper
 *   - ./build-bump-intake -- `matchesTagPattern`, the one anchored-glob match
 */
import { type BuildBumpEnvironment, resolvedEnvironments } from "../config/build-bump-images";
import type { WatcherConfig } from "../config/schema";
import type { BuildBumpCandidateRow, BuildBumpMarkerRow } from "../db/schema";
import { traced } from "../log";
import { matchesTagPattern } from "./build-bump-intake";

/**
 * One environment with its POSITIONAL defaults applied: `marker` is present iff
 * `promote` is `"marker"`, so a tag-stream environment cannot be read as
 * carrying a movable tag it does not have.
 */
export type ResolvedEnvironment =
	| { name: string; appDirs: string[]; promote: "tag" }
	| { name: string; appDirs: string[]; promote: "marker"; marker: string };

/** What one environment wants this pass. */
export type Desired =
	/** Drive this candidate through the pair state machine. */
	| { kind: "bump"; candidate: BuildBumpCandidateRow; allowOlder: boolean }
	/** Nothing to do, and nothing wrong: the normal quiet state. */
	| { kind: "none" }
	/** The marker points at a commit with no matching version tag for this image. */
	| { kind: "marker-unmatched"; marker: string; sha: string }
	/** The marker's candidate exists but is not built; the caller may requeue it. */
	| { kind: "marker-unbuilt"; candidate: BuildBumpCandidateRow };

/** `"not-enrolled"`: no `build_bump`, or no such image. `"build-only"`: enrolled to build, owning no app directory. */
type EnvironmentsResult = ResolvedEnvironment[] | "not-enrolled" | "build-only";

/** The repository's short name, the single-image convention (`refineRegistryImages`). */
function shortName(repository: string): string {
	return repository.slice(repository.indexOf("/") + 1);
}

/** Apply the positional defaults and drop `marker` from a tag-stream environment. */
function resolve(list: readonly BuildBumpEnvironment[]): ResolvedEnvironment[] {
	return resolvedEnvironments(list).map((env) =>
		env.promote === "tag"
			? { name: env.name, appDirs: [...env.app_dirs], promote: "tag" }
			: { name: env.name, appDirs: [...env.app_dirs], promote: "marker", marker: env.marker },
	);
}

/**
 * The environments one enrolled (repository, image) declares, in order.
 *
 * A block WITH `images` names the image explicitly and each image owns its own
 * list; a block WITHOUT names exactly one image, the repository's short name,
 * whose list is the block's top-level `environments`. An unknown repository, an
 * unenrolled one, and an image the block no longer names are the SAME answer —
 * `"not-enrolled"` — because the pass must not act on any of them.
 *
 * @param config - loaded watcher configuration
 * @param repository - `<owner>/<repo>` as the managed-repository config spells it
 * @param image - the image name a candidate row carries
 */
export const environmentsOf = traced(
	"reconcile.environmentsOf",
	function environmentsOf(
		config: WatcherConfig,
		repository: string,
		image: string,
	): EnvironmentsResult {
		const repo = config.repositories.find((entry) => entry.name === repository);
		const bump = repo?.build_bump;
		if (!bump) return "not-enrolled";
		let list: readonly BuildBumpEnvironment[] | undefined;
		if (bump.images) {
			const declared = bump.images.find((entry) => entry.name === image);
			if (!declared) return "not-enrolled";
			list = declared.environments;
		} else {
			if (image !== shortName(repository)) return "not-enrolled";
			list = bump.environments;
		}
		if (!list) return "build-only";
		return resolve(list);
	},
);

/**
 * The candidate order both branches share: newest forge commit date first, NULL
 * last because NULL is "unknown" and never "old", DESCENDING row id as the only
 * tiebreak.
 *
 * The tiebreak direction is load-bearing, not cosmetic. `tag_created_at` arrived
 * in migration 0021, so every row inserted before it is NULL — and an ASCENDING
 * tiebreak made the OLDEST row the "newest" candidate across a whole all-NULL
 * repository (observed on the watcher host after 644dd3d9: mcp2cli's desired was v0.3.18
 * while v0.3.19 and v0.3.20 were already built). A later row is a later
 * OBSERVATION of a tag, so when the dates tie — or are both unknown — the newer
 * row wins. Intake backfills the date as the forge supplies it, which retires
 * the tiebreak for those rows rather than relying on it.
 */
function byRecency(a: BuildBumpCandidateRow, b: BuildBumpCandidateRow): number {
	const left = a.tagCreatedAt?.getTime();
	const right = b.tagCreatedAt?.getTime();
	if (left !== right) {
		if (left === undefined) return 1;
		if (right === undefined) return -1;
		return right - left;
	}
	return b.id - a.id;
}

/** The newest `built` candidate, or `undefined` when nothing is built yet. */
function newestBuilt(
	candidates: readonly BuildBumpCandidateRow[],
): BuildBumpCandidateRow | undefined {
	return candidates
		.filter((row) => row.status === "built")
		.sort(byRecency)
		.at(0);
}

/**
 * The marker branch: the version tag sharing the marker's commit.
 *
 * Several rows can share one sha — the same commit tagged twice, or one tag
 * rebuilt — so a `built` row is preferred over any other status before the
 * recency order decides, and only then does the status of the chosen row say
 * whether this is a bump or a gap the caller may requeue.
 */
function desiredForMarker(
	marker: string,
	candidates: readonly BuildBumpCandidateRow[],
	markers: readonly BuildBumpMarkerRow[],
	tagPattern: string,
): Desired {
	const row = markers.find((entry) => entry.marker === marker);
	if (!row) return { kind: "none" };
	const matching = candidates
		.filter((entry) => entry.sha === row.sha && matchesTagPattern(entry.tag, tagPattern))
		.sort((a, b) => {
			const built = Number(b.status === "built") - Number(a.status === "built");
			return built !== 0 ? built : byRecency(a, b);
		});
	const chosen = matching.at(0);
	if (!chosen) return { kind: "marker-unmatched", marker, sha: row.sha };
	if (chosen.status !== "built") return { kind: "marker-unbuilt", candidate: chosen };
	return { kind: "bump", candidate: chosen, allowOlder: true };
}

/**
 * What one environment wants, given the rows the caller already narrowed to this
 * (repository, image) — and, for markers, to this repository.
 *
 * @param env - one resolved environment
 * @param candidates - candidate rows for this (repository, image)
 * @param markers - marker rows for this repository
 * @param tagPattern - the enrolment's `tag_pattern`, re-applied on the marker branch
 */
export const desiredCandidateFor = traced(
	"reconcile.desiredCandidateFor",
	function desiredCandidateFor(
		env: ResolvedEnvironment,
		candidates: BuildBumpCandidateRow[],
		markers: BuildBumpMarkerRow[],
		tagPattern: string,
	): Desired {
		if (env.promote === "marker") {
			return desiredForMarker(env.marker, candidates, markers, tagPattern);
		}
		const candidate = newestBuilt(candidates);
		return candidate ? { kind: "bump", candidate, allowOlder: false } : { kind: "none" };
	},
);
