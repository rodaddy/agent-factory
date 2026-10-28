/**
 * @module reconcile/build-bump-intake
 * @description Turn the tags on build-bump-enrolled repositories into deduped
 *   candidate rows (child of sf#533).
 *
 *   ENROLMENT IS THE BLOCK'S PRESENCE. A repository is enrolled by carrying a
 *   `build_bump` block in its config entry — there is deliberately no
 *   derived boolean, so enrolment cannot drift from a second field. A repository
 *   without the block is not listed at all: it costs no forge read.
 *
 *   THE FORGE IS THE INPUT, NEVER A WEBHOOK. Each enrolled repository's tags are
 *   RE-READ from the forge every pass. A webhook delivery only ever wakes
 *   reconciliation; its payload never becomes a candidate, so a spoofed or
 *   replayed delivery cannot introduce a tag the forge does not carry.
 *
 *   DEDUPE LIVES IN THE UNIQUE INDEX. Intake re-reads the same newest-first page
 *   every cycle, so every insert is `ON CONFLICT DO NOTHING` on
 *   `(repository, tag, sha, image)`. A second pass over an unchanged forge
 *   inserts nothing. The sha is part of the key deliberately: a tag force-moved
 *   to a different commit is a NEW candidate rather than a silent no-op.
 *
 *   ONE ROW PER IMAGE. A repository declaring `images` gets one
 *   candidate per image for each matching tag, each carrying its own dockerfile;
 *   a legacy block is one image, the short name from the root Dockerfile
 *   (`src/imagebuild/images.ts` is the one place that distinction is made).
 *
 *   MARKERS ARE A PROJECTION, REBUILT EVERY PASS
 *   (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §4). For every marker some environment
 *   of that repository's enrolment declares, the tag of that exact name is
 *   resolved BY NAME against the forge and upserted at its commit sha; a marker
 *   the forge answers 404 for has its row DELETED, and a marker whose read
 *   FAILS is left alone. The candidate LISTING is not consulted: it is one
 *   bounded page of the newest 50 tags, and a marker's commit may be
 *   arbitrarily old, so page membership would delete a live marker on any
 *   repository carrying more than 50 tags. There is nothing to append to — moving a
 *   marker backwards onto an older version is a legitimate deploy of that
 *   version — so the table holds the forge's CURRENT position and no history.
 *   A tag no environment declares is never stored: the declared set is the
 *   allowlist, so a repository cannot grow marker rows by pushing tags.
 *
 *   A FAILED READ SKIPS, IT DOES NOT THROW. The lister returns `null` for a
 *   non-200, a network error, or a malformed body; that repository is skipped for
 *   this pass with one bounded warning, the same posture the cycle already takes
 *   for a read failure. Throwing would abort the sibling repositories too.
 *
 * @outputs
 *   - `BuildBumpIntakeDeps` -- the injected lister and warning sink
 *   - `matchesTagPattern` -- the pure anchored-glob match over a bare tag name
 *   - `declaredMarkers` -- the marker names an enrolment's environments declare
 *   - `runBuildBumpIntake` -- record each enrolled repository's matching tags
 *
 * @dependencies
 *   - ../config/build-bump-images -- the positional promote/marker defaults
 *   - ../config/schema -- the managed repositories and their `build_bump` blocks
 *   - ../db/schema -- build_bump_candidates, build_bump_markers
 *   - ../forgejo/tags -- the trusted per-repository tag re-read
 *   - ../log -- the shared traced() build-phase wrapper
 */
import { and, eq, isNull, notInArray } from "drizzle-orm";
import { resolvedEnvironments } from "../config/build-bump-images";
import type { WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import { buildBumpCandidates, buildBumpMarkers } from "../db/schema";
import type { ForgejoTag } from "../forgejo/tags";
import { type BuildBumpBlock, buildBumpImagesFor } from "../imagebuild/images";
import { log, traced } from "../log";

/** The seams one pass drives; both injected so the pass is hermetic in tests. */
export interface BuildBumpIntakeDeps {
	/** Re-read a repository's tags from the forge; `null` means the read failed. */
	listTags: (repository: string) => Promise<ForgejoTag[] | null>;
	/**
	 * Resolve ONE named tag on a repository — the MARKER path, deliberately not
	 * the listing. `"absent"` is the forge's 404; `null` is a failed read, and
	 * the two must stay distinct because only the first deletes a marker row.
	 */
	readTag: (repository: string, name: string) => Promise<ForgejoTag | "absent" | null>;
	/** Bounded warning sink for a skipped repository. */
	onWarn?: (message: string) => void;
}

/**
 * Match a bare tag NAME against a `tag_pattern`.
 *
 * The config boundary already guarantees the pattern is anchored, contains at
 * most one `*`, and carries no `/` (src/config/schema.ts). Those guarantees are
 * what let this be a literal prefix/suffix test rather than a regex conversion:
 * building a regex from config text would re-introduce every metacharacter the
 * config regex exists to refuse.
 *
 * The length guard is what stops a prefix and suffix OVERLAPPING on a short name
 * — a name SHORTER than prefix + suffix is one where `startsWith` and `endsWith`
 * can both be true only by SHARING characters. `v*v` must not match `v`, where
 * both hold over the same single character. It is not a guard against the star
 * matching nothing: `*` matching the empty string is legitimate glob behaviour,
 * so `v*` matches `v` and `v*.0` matches `v.0` (three characters, prefix 1 +
 * suffix 2, nothing shared), while `v*.0` correctly refuses `v0`.
 */
export const matchesTagPattern = traced(
	"reconcile.matchesTagPattern",
	function matchesTagPattern(name: string, pattern: string): boolean {
		const star = pattern.indexOf("*");
		if (star === -1) {
			return name === pattern;
		}
		const prefix = pattern.slice(0, star);
		const suffix = pattern.slice(star + 1);
		return (
			name.startsWith(prefix) &&
			name.endsWith(suffix) &&
			name.length >= prefix.length + suffix.length
		);
	},
);

/**
 * Record every enrolled repository's matching tags as candidate rows.
 *
 * Runs as its own cycle step BEFORE `dispatchPendingJobs`, so a tag observed this
 * pass is available to the lane that consumes candidates without waiting a full
 * poll interval. It dispatches nothing itself and advances no cursor.
 *
 * @param db - watcher database
 * @param config - loaded watcher configuration (owns the `build_bump` blocks)
 * @param deps - the injected tag lister and warning sink
 */
export const runBuildBumpIntake = traced(
	"reconcile.runBuildBumpIntake",
	async function runBuildBumpIntake(
		db: WatcherDb,
		config: WatcherConfig,
		deps: BuildBumpIntakeDeps,
	): Promise<void> {
		for (const repo of config.repositories) {
			const bump = repo.build_bump;
			// ABSENT MEANS NOT ENROLLED. No block, no forge read.
			if (!bump) {
				continue;
			}
			// Only Forgejo has a tag reader today. A non-Forgejo enrolled repository is
			// a config statement the factory cannot honour yet, so it is warned ONCE per
			// pass and skipped rather than silently ignored or coerced onto a reader
			// that speaks a different wire shape.
			if (repo.provider !== "forgejo") {
				warn(
					deps,
					`build-bump intake skipped ${repo.name}: provider ${repo.provider} has no tag reader`,
				);
				continue;
			}

			const tags = await deps.listTags(repo.name);
			if (tags === null) {
				// SKIP, never throw: the lister already logged the cause, and one
				// unreachable repository must not stop the rest of this pass.
				warn(deps, `build-bump intake skipped ${repo.name}: tag read failed`);
				continue;
			}

			const matching = tags.filter((tag) => matchesTagPattern(tag.name, bump.tag_pattern));
			if (matching.length > 0) {
				await insertCandidates(db, repo.name, bump, matching);
			}
			// EVERY PASS, even one that matched no version tag: a marker can move or
			// be deleted without any new version tag appearing, and the projection
			// must follow the forge either way.
			await reconcileMarkers(db, repo.name, bump, deps);
		}
	},
);

/** Record this pass's matching tags as candidates; the unique index dedupes. */
async function insertCandidates(
	db: WatcherDb,
	repository: string,
	bump: BuildBumpBlock,
	matching: readonly ForgejoTag[],
): Promise<void> {
	const images = buildBumpImagesFor(repository, bump);
	await db
		.insert(buildBumpCandidates)
		.values(
			matching.flatMap((tag) =>
				images.map((image) => ({
					repository,
					// The COMMIT sha the lister already mapped — never a tag object id.
					tag: tag.name,
					sha: tag.commitSha,
					image: image.name,
					dockerfile: image.dockerfile,
					// The forge's commit date, the only honest recency order.
					// Absent degrades to NULL, which every selection sorts LAST rather
					// than treating as old.
					tagCreatedAt: tag.commitCreatedAt,
				})),
			),
		)
		.onConflictDoNothing({
			target: [
				buildBumpCandidates.repository,
				buildBumpCandidates.tag,
				buildBumpCandidates.sha,
				buildBumpCandidates.image,
			],
		});
	await backfillTagDates(db, repository, matching);
}

/**
 * Give the rows migration 0021 left NULL the date the forge is already sending.
 *
 * `insertCandidates` is ON CONFLICT DO NOTHING, so a row that predates the
 * column NEVER learns its date from an insert — and 39 such rows were observed
 * on the watcher host, where an all-NULL repository fell back on the id tiebreak and
 * selected an OLD tag (mcp2cli desired v0.3.18 while v0.3.20 was built). The
 * update is bounded to rows that are still NULL, so a row that already carries a
 * date is never rewritten and the steady state touches nothing.
 */
async function backfillTagDates(
	db: WatcherDb,
	repository: string,
	matching: readonly ForgejoTag[],
): Promise<void> {
	for (const tag of matching) {
		if (!tag.commitCreatedAt) continue;
		const changed = await db
			.update(buildBumpCandidates)
			.set({ tagCreatedAt: tag.commitCreatedAt })
			.where(
				and(
					eq(buildBumpCandidates.repository, repository),
					eq(buildBumpCandidates.tag, tag.name),
					eq(buildBumpCandidates.sha, tag.commitSha),
					isNull(buildBumpCandidates.tagCreatedAt),
				),
			)
			.returning({ id: buildBumpCandidates.id });
		// Only a row that actually changed is logged: every steady-state pass sees
		// the same tags, and logging a no-op would be one line per tag per cycle.
		if (changed.length > 0) {
			log("info", "build_bump_intake.tag_date_backfilled", { repository, tag: tag.name });
		}
	}
}

/**
 * The marker names a repository's enrolment declares, across the top-level
 * environment list and every image's own list, with the POSITIONAL defaults
 * applied by `resolvedEnvironments` — so an unstated later environment declares
 * a marker named after itself, and the version-tag stream declares none.
 *
 * Pure, and the allowlist the rebuild is limited to: a marker absent from this
 * set is never stored no matter what tags the repository carries.
 */
export const declaredMarkers = traced(
	"reconcile.buildBumpIntake.declaredMarkers",
	function declaredMarkers(bump: BuildBumpBlock): string[] {
		const lists = [bump.environments, ...(bump.images ?? []).map((image) => image.environments)];
		const markers = new Set<string>();
		for (const list of lists) {
			if (!list) continue;
			for (const env of resolvedEnvironments(list)) {
				if (env.promote === "marker") markers.add(env.marker);
			}
		}
		return [...markers];
	},
);

/**
 * Rebuild `build_bump_markers` for one repository by resolving each declared
 * marker BY NAME: present on the forge is upserted at its commit sha, a 404 is
 * deleted, and a FAILED read changes nothing.
 *
 * NOT from the candidate listing. That listing is one bounded page of the newest
 * 50 tags, and a marker is a movable tag whose commit may be arbitrarily old, so
 * on a repository with more than 50 tags a live `prod` marker sits on page two
 * and "not in the page" read as "not on the forge" deleted its row every single
 * pass — an environment that could then never move. Membership in a page is not
 * evidence about a named tag; only a named lookup is.
 */
async function reconcileMarkers(
	db: WatcherDb,
	repository: string,
	bump: BuildBumpBlock,
	deps: BuildBumpIntakeDeps,
): Promise<void> {
	const declared = declaredMarkers(bump);
	for (const marker of declared) {
		const tag = await deps.readTag(repository, marker);
		// A FAILED read is not an absence. Leaving the row exactly as it is keeps a
		// transient forge error from deleting a marker the forge still carries —
		// the next pass re-reads and converges either way.
		if (tag === null) {
			log("warn", "build_bump_intake.marker_read_failed", { repository, marker });
			continue;
		}
		if (tag === "absent") {
			const deleted = await db
				.delete(buildBumpMarkers)
				.where(
					and(eq(buildBumpMarkers.repository, repository), eq(buildBumpMarkers.marker, marker)),
				)
				.returning({ id: buildBumpMarkers.id });
			if (deleted.length > 0) {
				log("info", "build_bump_intake.marker_cleared", { repository, marker });
			}
			continue;
		}
		const [existing] = await db
			.select({ sha: buildBumpMarkers.sha })
			.from(buildBumpMarkers)
			.where(and(eq(buildBumpMarkers.repository, repository), eq(buildBumpMarkers.marker, marker)));
		await db
			.insert(buildBumpMarkers)
			.values({ repository, marker, sha: tag.commitSha, seenAt: new Date() })
			.onConflictDoUpdate({
				target: [buildBumpMarkers.repository, buildBumpMarkers.marker],
				set: { sha: tag.commitSha, seenAt: new Date() },
			});
		// An UNCHANGED sha is silent: the steady state is every pass observing the
		// same marker, and logging that would be one line per marker per pass.
		if (existing?.sha !== tag.commitSha) {
			log("info", "build_bump_intake.marker_set", { repository, marker });
		}
	}

	await removeUndeclaredMarkers(db, repository, declared);
}

/**
 * Delete every row for `repository` whose marker is not in the declared set.
 *
 * The loop above is only HALF the rebuild: it can clear a marker the FORGE
 * dropped, and nothing in it clears a marker the CONFIGURATION dropped. A row
 * whose environment was renamed or removed would otherwise outlive its
 * declaration forever and keep selecting a version for an environment that no
 * longer exists. The table is a projection of the enrolment, so the declared set
 * is the allowlist in BOTH directions.
 *
 * The empty case is branched deliberately: drizzle's `notInArray` with an empty
 * list is invalid SQL, and an enrolment declaring no marker at all (the
 * single-environment common case) means EVERY row for the repository is
 * undeclared.
 */
async function removeUndeclaredMarkers(
	db: WatcherDb,
	repository: string,
	declared: string[],
): Promise<void> {
	const removed = await db
		.delete(buildBumpMarkers)
		.where(
			declared.length === 0
				? eq(buildBumpMarkers.repository, repository)
				: and(
						eq(buildBumpMarkers.repository, repository),
						notInArray(buildBumpMarkers.marker, declared),
					),
		)
		.returning({ id: buildBumpMarkers.id });
	if (removed.length > 0) {
		log("info", "build_bump_intake.marker_undeclared_removed", {
			repository,
			removed: removed.length,
		});
	}
}

/** Emit one bounded skip warning through the injected sink and the log. */
function warn(deps: BuildBumpIntakeDeps, message: string): void {
	log("warn", "build_bump_intake.skipped", { reason: message });
	deps.onWarn?.(message);
}
