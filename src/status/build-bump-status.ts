/**
 * @module status/build-bump-status
 * @description The build-bump lane's `/status.json` view
 *   (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §8): one entry per enrolled
 *   (repository, image, environment), carrying the tag its promotion rule
 *   currently selects and what the last attempt to reach it did.
 *
 *   THE LANE'S ONLY OPERATOR-VISIBLE SURFACE. Every other record of what an
 *   environment wants is a row in `build_bump_*` on a loopback-only box, and §6
 *   made the lane self-healing — a pair that fails returns to `pending` forever
 *   rather than landing in a terminal state — so without this, "stuck" and
 *   "quiet" are the same reading. §10 item 4 is the acceptance property: a forced
 *   failure SHOWS HERE within three passes.
 *
 *   ITS OWN MODULE rather than more functions in `./query`, because that file
 *   sits against the 500-line `max-lines` bound `lint:size` enforces and this
 *   view is a self-contained read with its own three tables. `query` calls one
 *   function and spreads the result.
 *
 *   DESIRED, NOT DEPLOYED. This reports what the promotion rule selects and what
 *   the newest pair row says happened; it never calls a forge or a cluster, so it
 *   cannot and does not claim anything is running.
 *
 * @outputs
 *   - `buildBumpStatuses` -- the per-environment view, read in three round trips
 *   - `BuildBumpStatus` -- one enrolled (repository, image, environment)
 *   - `BuildBumpRepositoryConfig` -- the enrolment slice this module reads
 *   - `enrolledEnvironments` -- the ONE enrolment enumeration, shared with the alert pass
 *   - `EnrolledEnvironment` -- one enrolled (repository, image) and its environment list
 *
 * @dependencies
 *   - drizzle-orm -- the three bounded reads
 *   - ../config/build-bump-images -- the environment primitive and its defaults
 *   - ../db/schema, ../db/client -- the build_bump tables and the db type
 *   - ../log -- `traced`, the span every exported function in this repo carries
 *   - ../reconcile/build-bump-environments -- `desiredCandidateFor`, the ONE selector
 */
import { asc, inArray } from "drizzle-orm";
import {
	type BuildBumpEnvironment,
	type ResolvedBuildBumpEnvironment,
	resolvedEnvironments,
} from "../config/build-bump-images";
import type { WatcherDb } from "../db/client";
import {
	type BuildBumpCandidateRow,
	type BuildBumpMarkerRow,
	buildBumpBumps,
	buildBumpCandidates,
	buildBumpMarkers,
} from "../db/schema";
import { traced } from "../log";
import {
	desiredCandidateFor,
	type ResolvedEnvironment,
} from "../reconcile/build-bump-environments";

/**
 * One enrolled (repository, image, environment) and what it currently wants.
 *
 * Every field is a bounded identifier, a number, or null. Nothing repository-
 * authored beyond the tag and app-directory names — both already constrained by
 * the config and intake boundaries — reaches this shape, and no reason string
 * here is anything but one of the lane's own fixed strings.
 */
export interface BuildBumpStatus {
	/** `<owner>/<repo>` as the managed-repository config spells it. */
	repository: string;
	/** The image this environment's manifests are pinned to. */
	image: string;
	/** The environment's own name — operator vocabulary, never known to the code. */
	environment: string;
	/**
	 * The tag the environment's promotion rule selects RIGHT NOW: the newest built
	 * candidate for a tag environment, or the candidate sharing the marker's commit
	 * for a marker one. Null when nothing qualifies, which is the normal state for
	 * a marker that has never been placed.
	 *
	 * A marker environment reports its tag even when that candidate has NOT built:
	 * the lane is actively re-queuing it, and reporting null would make a marker
	 * on a permanently failing build read as no marker at all. `lastOutcome` then
	 * carries the `unbuilt:` prefix that distinguishes the two.
	 */
	desiredTag: string | null;
	/**
	 * The commit the environment's movable tag points at. Null ONLY for a tag
	 * environment (which has no marker) and for a marker never placed — a marker
	 * pointing at a commit no version tag matches still reports its sha here, with
	 * `lastOutcome` carrying the `unmatched:` prefix, so the misplaced marker is
	 * distinguishable from the never-placed one.
	 */
	markerSha: string | null;
	/** The newest bump PR opened for this environment, or null if none ever was. */
	lastPr: number | null;
	/**
	 * That bump's fixed outcome reason, or null. Never script text.
	 *
	 * When the desired candidate has not built, this carries `unbuilt: <status>`
	 * (plus the build reason, when there is one) instead: there is no bump to
	 * report an outcome for, and silence there was the defect. When the marker
	 * matches no candidate at all it carries `unmatched: <sha>`, for the same
	 * reason — an all-null entry claimed no marker existed.
	 */
	lastOutcome: string | null;
	/**
	 * Invocations spent on the newest pair — or, when the desired candidate has
	 * not built and therefore has no pair, the times the pass has RE-QUEUED that
	 * candidate. THE GAUGE §8 alerts on at 3 in both cases: a value climbing here
	 * with no PR is the signature of a lane that is not converging.
	 */
	attempts: number;
}

/**
 * The slice of a managed-repository entry this module reads: its name and its
 * enrolment block. Structurally typed rather than importing `RepositoryConfig`,
 * so a test declares two literals instead of constructing a whole valid config.
 */
export interface BuildBumpRepositoryConfig {
	name: string;
	build_bump?: {
		environments?: readonly BuildBumpEnvironment[];
		images?: readonly { name: string; environments?: readonly BuildBumpEnvironment[] }[];
		tag_pattern?: string;
	};
}

/** The key separator for the in-memory pair index; a tab cannot occur in either half. */
const KEY_SEP = "\t";

/**
 * One enrolled (repository, image) and the environment list it declares.
 *
 * Named rather than inferred so the alert pass can import the shape without
 * importing the function's inferred return type through a `ReturnType` dance.
 */
export interface EnrolledEnvironment {
	/** `<owner>/<repo>` as the managed-repository config spells it. */
	repository: string;
	/** The image name a candidate row carries. */
	image: string;
	/** The enrolment's `tag_pattern`, defaulted to `v*`. */
	tagPattern: string;
	/** The environments this (repository, image) declares, in order. */
	environments: readonly BuildBumpEnvironment[];
}

/**
 * One enrolled (repository, image) and the environments it declares, flattened
 * out of the two enrolment shapes.
 *
 * A block WITH `images` names each image and each image owns its list; a block
 * WITHOUT names exactly one image, the repository's short name, whose list is the
 * block's top-level `environments`. The same mapping `environmentsOf` performs in
 * `src/reconcile/build-bump-environments.ts` — read there, not re-decided here.
 * A block declaring NEITHER list is BUILD-ONLY enrolment and yields nothing,
 * because it owns no app directory and therefore has no environment to report.
 *
 * EXPORTED so the §8 alert pass scopes itself to the SAME enumeration this view
 * reports (`src/observability/build-bump-alert.ts`). Two independent copies of
 * "what is enrolled" is exactly how an alert for a repository nobody enrolled any
 * more survives — the status view showed nothing and the alert fired anyway.
 *
 * @param repos - the managed-repository entries, enrolment slice only
 * @returns one entry per enrolled (repository, image), build-only omitted
 */
export const enrolledEnvironments = traced(
	"status.enrolledEnvironments",
	function enrolledEnvironments(
		repos: readonly BuildBumpRepositoryConfig[],
	): EnrolledEnvironment[] {
		const out: EnrolledEnvironment[] = [];
		for (const repo of repos) {
			const bump = repo.build_bump;
			if (!bump) continue;
			const tagPattern = bump.tag_pattern ?? "v*";
			const declared = bump.images
				? bump.images.map((image) => ({ image: image.name, environments: image.environments }))
				: [
						{
							image: repo.name.slice(repo.name.indexOf("/") + 1),
							environments: bump.environments,
						},
					];
			for (const entry of declared) {
				// Build-only: enrolled to build, owning no app directory.
				if (!entry.environments) continue;
				out.push({
					repository: repo.name,
					image: entry.image,
					tagPattern,
					environments: entry.environments,
				});
			}
		}
		return out;
	},
);

/** What one environment wants, as this view reports it. */
interface DesiredView {
	/** The candidate the promotion rule selects, if any. */
	candidate: BuildBumpCandidateRow | undefined;
	/** The marker's commit, or null for a tag environment and an unplaced marker. */
	markerSha: string | null;
	/**
	 * Set when the marker points at a commit no candidate for this image carries
	 * (§8's `marker_unmatched`). No candidate exists to name, but the marker DOES,
	 * and reporting it is what separates a misplaced marker from an unplaced one.
	 */
	unmatchedSha: string | null;
	/**
	 * Set when the selected candidate exists but has NOT built — the invisible
	 * state this view previously reported as "nothing desired" (§6, §8). Carries
	 * the candidate's own status and build reason, so the entry says WHY.
	 */
	unbuilt: { status: string; buildReason: string | null } | null;
}

/**
 * The candidate one environment wants, and the marker sha behind it.
 *
 * DELEGATED TO `desiredCandidateFor`, the pure selector the bump pass itself
 * uses, rather than re-deciding here. This module used to carry its own copy of
 * the rule and its own recency comparator, which is how the two views could drift
 * — and they HAD drifted in the case that matters most: a marker on a candidate
 * that will not build reported as an empty entry, indistinguishable from an
 * environment nobody had placed a marker on, while the pass was re-queuing that
 * candidate every cycle. Sharing the selector makes the status view and the pass
 * agree by construction, and `marker-unbuilt` becomes a state this view can name.
 *
 * `marker-unmatched` names no candidate — none matches — but it is NOT the same
 * state as "nothing desired". The marker sha is already computed here, and
 * reporting it with an `unmatched:` outcome is what stops a misplaced marker from
 * rendering as the all-null entry of an environment nobody has marked at all.
 */
function desiredForEnvironment(
	env: ResolvedBuildBumpEnvironment,
	candidates: readonly BuildBumpCandidateRow[],
	markers: readonly BuildBumpMarkerRow[],
	tagPattern: string,
): DesiredView {
	const resolved: ResolvedEnvironment =
		env.promote === "tag"
			? { name: env.name, appDirs: [...env.app_dirs], promote: "tag" }
			: { name: env.name, appDirs: [...env.app_dirs], promote: "marker", marker: env.marker };
	const markerSha =
		env.promote === "marker"
			? (markers.find((row) => row.marker === env.marker)?.sha ?? null)
			: null;
	const desired = desiredCandidateFor(resolved, [...candidates], [...markers], tagPattern);
	if (desired.kind === "bump") {
		return { candidate: desired.candidate, markerSha, unbuilt: null, unmatchedSha: null };
	}
	if (desired.kind === "marker-unbuilt") {
		return {
			candidate: desired.candidate,
			markerSha,
			unmatchedSha: null,
			unbuilt: {
				status: desired.candidate.status,
				buildReason: desired.candidate.buildReason,
			},
		};
	}
	if (desired.kind === "marker-unmatched") {
		return { candidate: undefined, markerSha, unbuilt: null, unmatchedSha: desired.sha };
	}
	return { candidate: undefined, markerSha: null, unbuilt: null, unmatchedSha: null };
}

/**
 * How an unbuilt desired candidate reads on `/status.json`.
 *
 * Prefixed `unbuilt:` so an operator can tell it apart from a bump refusal token
 * at a glance — this is the image never having been produced, not the bump script
 * judging a request. The build reason is one of the build pass's own fixed
 * strings (a batch/v1 condition reason or a bounded render refusal), never
 * container output.
 */
function unbuiltOutcome(unbuilt: { status: string; buildReason: string | null }): string {
	return `unbuilt: ${unbuilt.status}${unbuilt.buildReason ? `: ${unbuilt.buildReason}` : ""}`;
}

/**
 * How a marker matching no candidate reads on `/status.json`.
 *
 * Prefixed `unmatched:` for the same reason `unbuilt:` is: the sha is the only
 * fact there is, and an operator reading a bare sha could not tell which of the
 * two invisible states they were looking at.
 */
function unmatchedOutcome(sha: string): string {
	return `unmatched: ${sha}`;
}

/**
 * The build-bump lane's desired state, one entry per enrolled
 * (repository, image, environment) (§8).
 *
 * THREE READS, NOT ONE PER ENVIRONMENT. The tables are small and the alternative
 * — a query inside the environment loop — would issue one round trip per
 * environment per status request, on a page an operator refreshes. Everything
 * else is decided in memory from the same three result sets, so every entry
 * describes one instant rather than a state the database never held.
 *
 * The pair read is keyed on the environment's FIRST app_dir: a pair row exists
 * per (candidate, app_dir), and the first directory is the representative one
 * this snapshot reports rather than a fan-out an operator has to fold themselves.
 */
async function buildBumpStatusesImpl(
	db: WatcherDb,
	repos: readonly BuildBumpRepositoryConfig[],
): Promise<BuildBumpStatus[]> {
	const enrolled = enrolledEnvironments(repos);
	if (enrolled.length === 0) return [];
	const names = [...new Set(enrolled.map((entry) => entry.repository))];

	const candidates = await db
		.select()
		.from(buildBumpCandidates)
		.where(inArray(buildBumpCandidates.repository, names));
	const markerRows = await db
		.select()
		.from(buildBumpMarkers)
		.where(inArray(buildBumpMarkers.repository, names));
	// Ascending by id so the map ends holding the NEWEST row per (candidate, app).
	const pairRows = await db
		.select({
			candidateId: buildBumpBumps.candidateId,
			appDir: buildBumpBumps.appDir,
			pr: buildBumpBumps.pr,
			reason: buildBumpBumps.reason,
			attempts: buildBumpBumps.attempts,
		})
		.from(buildBumpBumps)
		.orderBy(asc(buildBumpBumps.id));
	const pairs = new Map(pairRows.map((row) => [`${row.candidateId}${KEY_SEP}${row.appDir}`, row]));

	return enrolled.flatMap((entry) =>
		entriesFor(
			entry,
			candidates.filter((row) => row.repository === entry.repository && row.image === entry.image),
			markerRows.filter((row) => row.repository === entry.repository),
			pairs,
		),
	);
}

export const buildBumpStatuses = traced(
	"status.buildBumpStatuses",
	buildBumpStatusesImpl,
) as typeof buildBumpStatusesImpl;

/**
 * One enrolled (repository, image)'s entries, one per environment it declares.
 *
 * AN UNBUILT DESIRED CANDIDATE IS AN ENTRY WITH CONTENT, not an empty one. It has
 * no pair row — none can exist before the image does — so the gauge it reports is
 * the candidate's own `requeues`, the count of times the pass has put a failed
 * build back in the queue for this marker. That is the number §8 alerts on at 3,
 * and reporting it here is what makes the same three-pass property observable to
 * an operator rather than only to the alert.
 */
function entriesFor(
	entry: EnrolledEnvironment,
	rows: readonly BuildBumpCandidateRow[],
	markers: readonly BuildBumpMarkerRow[],
	pairs: ReadonlyMap<string, { pr: number | null; reason: string | null; attempts: number }>,
): BuildBumpStatus[] {
	return resolvedEnvironments(entry.environments).map((env) => {
		const desired = desiredForEnvironment(env, rows, markers, entry.tagPattern);
		// The FIRST app_dir is the representative pair; `app_dirs` carries `.min(1)`,
		// so the index is safe by schema rather than by hope.
		const appDir = env.app_dirs[0];
		const pair =
			desired.candidate === undefined || appDir === undefined
				? undefined
				: pairs.get(`${desired.candidate.id}${KEY_SEP}${appDir}`);
		return {
			repository: entry.repository,
			image: entry.image,
			environment: env.name,
			desiredTag: desired.candidate?.tag ?? null,
			markerSha: desired.markerSha,
			lastPr: pair?.pr ?? null,
			lastOutcome: desired.unbuilt
				? unbuiltOutcome(desired.unbuilt)
				: desired.unmatchedSha
					? unmatchedOutcome(desired.unmatchedSha)
					: (pair?.reason ?? null),
			attempts: desired.unbuilt ? (desired.candidate?.requeues ?? 0) : (pair?.attempts ?? 0),
		};
	});
}
