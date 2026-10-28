/**
 * @module reconcile/build-bump-bump
 * @description The build-bump BUMP pass, rewritten to RECONCILE DESIRED
 *   STATE PER ENVIRONMENT (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §6): for every
 *   enrolled (repository, image), for every environment that repository
 *   declares, compute the candidate that environment WANTS and drive one pair
 *   per app directory toward it.
 *
 *   THE PASS ROUTES ON THE ENVIRONMENT OBJECT, NEVER ON A SHAPE. The previous
 *   version decided by matching the shape of a `LaneDisposition` — and once
 *   routed production directories through the auto-merging seam because two
 *   dispositions happened to carry the same `appDirs` field. An environment is
 *   an ORDERED, NAMED promotion rule now: `promote: tag` follows the version-tag
 *   stream, `promote: marker` follows a movable tag and may legitimately move
 *   BACKWARDS, which is why only that answer carries `allowOlder`. No
 *   environment NAME appears here at all; the words live only in configuration.
 *
 *   SELECTION IS PURE, THIS MODULE IS THE I/O. `environmentsOf` and
 *   `desiredCandidateFor` (`build-bump-environments.ts`) read rows and decide;
 *   this module loads the rows, drives the pairs, and writes back. The pair
 *   state machine — claim, invoke, record — is `build-bump-bump-pairs.ts`.
 *
 *   NOT FINDING A CANDIDATE IS FOUR DIFFERENT ANSWERS, and each gets a different
 *   act: `none` is the normal quiet state, `marker-unmatched` is a misplaced
 *   marker (warn ONCE per pass per repository/marker/sha, so a permanently
 *   misplaced marker does not print every cycle), `marker-unbuilt` names a
 *   candidate the pass may RE-QUEUE when it is `failed` — that requeue is how a
 *   marker moved onto a build that failed converges without an operator — and
 *   `bump` is the one that invokes.
 *
 *   THE PASS NEVER SEES A TOKEN. `deps.bump` is a closure composed in
 *   `service.ts` with the credential already captured, so the credential-fetch
 *   boundary stays at the composition root and no test of this pass can be
 *   satisfied by a token reaching it. `bump: null` is the unconfigured posture —
 *   one bounded warn and return, the mirror of the build pass's null kube client.
 *
 * @outputs
 *   - `MAX_BUMPS_PER_PASS` -- how many invocations one pass may spend
 *   - `BuildBumpBumpDeps` / `claimPairAttempt` -- re-exported from the pair module
 *   - `runBuildBumpBump` -- one bump pass over every enrolled environment
 *
 * @dependencies
 *   - ../db/schema -- build_bump_candidates / build_bump_markers
 *   - ../log -- log and the shared traced() wrapper
 *   - ./build-bump-environments -- the PURE selection half (§6.1)
 *   - ./build-bump-bump-pairs -- the pair state machine (§6.2-6.3)
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import { type BuildBumpCandidateRow, buildBumpCandidates, buildBumpMarkers } from "../db/schema";
import { log, traced } from "../log";
import {
	type BuildBumpBumpDeps,
	claimPairAttempt,
	drivePair,
	type PassContext,
	recoverStaleInvocations,
	reopenSuperseded,
	warn,
} from "./build-bump-bump-pairs";
import {
	type Desired,
	desiredCandidateFor,
	environmentsOf,
	type ResolvedEnvironment,
} from "./build-bump-environments";

export type { BuildBumpBumpDeps };
export { claimPairAttempt };

/**
 * How many INVOCATIONS one pass may spend. Each one clones a deploy repository
 * and opens a PR, so the cap bounds forge pressure the same way the build pass
 * bounds cluster pressure; the table is the queue and the next pass takes the rest.
 */
export const MAX_BUMPS_PER_PASS = 5;

/** Separator for composite in-memory keys; never a legal character in either half. */
const KEY_SEP = String.fromCharCode(0);

/** One enrolled (repository, image) with every candidate row the pass read for it. */
interface ImageGroup {
	repository: string;
	image: string;
	candidates: BuildBumpCandidateRow[];
}

/** Group every candidate row by (repository, image), preserving row order. */
function groupByImage(rows: BuildBumpCandidateRow[]): ImageGroup[] {
	const groups = new Map<string, ImageGroup>();
	for (const row of rows) {
		const key = `${row.repository}${KEY_SEP}${row.image}`;
		const existing = groups.get(key);
		if (existing) existing.candidates.push(row);
		else groups.set(key, { repository: row.repository, image: row.image, candidates: [row] });
	}
	return [...groups.values()];
}

/** The `tag_pattern` of one enrolled repository, re-applied on the marker branch. */
function tagPatternOf(config: WatcherConfig, repository: string): string {
	const bump = config.repositories.find((entry) => entry.name === repository)?.build_bump;
	return bump?.tag_pattern ?? "v*";
}

/**
 * Re-queue a `failed` candidate a marker environment needs, guarded on the
 * status this pass read. Anything else — already `pending`, already `building` —
 * is left alone: the build pass owns it and will reach it.
 *
 * THE COUNTER IS PART OF THE SAME GUARDED UPDATE, never a second statement. It
 * increments exactly when the status transition wins, so it counts requeues this
 * pass actually performed rather than requeues it attempted — two passes racing
 * the same row produce one transition and one increment.
 *
 * The retry stays UNBOUNDED (§6 has no terminality here): a permanent build
 * failure under a placed marker is requeued every pass forever, which is correct
 * behaviour and also the defect, because it is otherwise silent — no pair row is
 * created, so the stuck-pair alert matches nothing. The count is what makes the
 * loop visible to §8's alert and to `/status.json`, without ever stopping it.
 */
async function requeueFailed(ctx: PassContext, candidate: BuildBumpCandidateRow): Promise<void> {
	if (candidate.status !== "failed") return;
	const updated = await ctx.db
		.update(buildBumpCandidates)
		.set({
			status: "pending",
			buildReason: null,
			buildFinishedAt: null,
			requeues: sql`${buildBumpCandidates.requeues} + 1`,
		})
		.where(and(eq(buildBumpCandidates.id, candidate.id), eq(buildBumpCandidates.status, "failed")))
		.returning({ id: buildBumpCandidates.id, requeues: buildBumpCandidates.requeues });
	const row = updated.at(0);
	if (row) {
		log("info", "build_bump_bump.marker_requeued", {
			candidate_id: row.id,
			requeues: row.requeues,
		});
	}
}

/** Warn once per pass per (repository, marker, sha) about a marker with no version tag. */
function warnUnmatched(ctx: PassContext, repository: string, marker: string, sha: string): void {
	const key = `${repository}${KEY_SEP}${marker}${KEY_SEP}${sha}`;
	if (ctx.warnedMarkers.has(key)) return;
	ctx.warnedMarkers.add(key);
	warn(
		ctx.deps,
		"build_bump_bump.marker_unmatched",
		`${repository} marker ${marker} at ${sha} matches no version tag`,
	);
}

/** Drive one environment toward its desired candidate. Returns invocations spent. */
async function driveEnvironment(
	ctx: PassContext,
	group: ImageGroup,
	env: ResolvedEnvironment,
	budget: { desired: Desired; remaining: number },
): Promise<number> {
	const { desired, remaining } = budget;
	if (desired.kind === "none") return 0;
	if (desired.kind === "marker-unmatched") {
		warnUnmatched(ctx, group.repository, desired.marker, desired.sha);
		return 0;
	}
	if (desired.kind === "marker-unbuilt") {
		await requeueFailed(ctx, desired.candidate);
		return 0;
	}
	// A MARKER MAY MOVE BACKWARDS AND THEN FORWARDS AGAIN, and the pair key is
	// (candidate_id, app_dir) for all time — so the row for the tag the marker has
	// returned to is still terminal from the first time. Re-open it when a later
	// bump of the same directory has superseded it; a `tag` environment never
	// moves backwards, so it never reopens and its terminal rows stay terminal.
	if (env.promote === "marker") {
		for (const appDir of env.appDirs) {
			await reopenSuperseded(ctx, desired.candidate.id, appDir);
		}
	}
	let spent = 0;
	for (const appDir of env.appDirs) {
		if (spent >= remaining) break;
		const invoked = await drivePair(ctx, {
			candidate: desired.candidate,
			appDir,
			target: env.name,
			allowOlder: desired.allowOlder,
		});
		if (invoked) spent += 1;
	}
	return spent;
}

/** Drive every environment of one enrolled (repository, image). Returns invocations spent. */
async function driveImage(
	ctx: PassContext,
	config: WatcherConfig,
	group: ImageGroup,
	remaining: number,
): Promise<number> {
	const environments = environmentsOf(config, group.repository, group.image);
	if (environments === "not-enrolled") {
		// Built under an enrolment that has since been removed. No row change:
		// re-enrolling must not find a fabricated terminal row waiting.
		warn(
			ctx.deps,
			"build_bump_bump.not_enrolled",
			`${group.repository} image ${group.image}: no longer enrolled`,
		);
		return 0;
	}
	// BUILD-ONLY: enrolled to build and push an image another repository consumes
	// by pin. Nothing bumps a manifest, here or later — a silent, correct no-op.
	if (environments === "build-only") return 0;

	const markers = await ctx.db
		.select()
		.from(buildBumpMarkers)
		.where(eq(buildBumpMarkers.repository, group.repository));
	const pattern = tagPatternOf(config, group.repository);
	let spent = 0;
	for (const env of environments) {
		if (spent >= remaining) break;
		const desired = desiredCandidateFor(env, group.candidates, markers, pattern);
		spent += await driveEnvironment(ctx, group, env, { desired, remaining: remaining - spent });
	}
	return spent;
}

/**
 * One bump pass: for every enrolled (repository, image) that has candidates, for
 * every environment it declares, reconcile toward the candidate that environment
 * wants — up to `maxPerPass` invocations.
 *
 * Runs as its own cycle step IMMEDIATELY AFTER `runBuildBumpBuild`, so a build
 * that completed this pass bumps in the same cycle. It dispatches no factory job
 * and advances no cursor.
 *
 * @param db - watcher database
 * @param config - the managed repositories and their `build_bump` blocks
 * @param deps - the injected invoke seam, paths, receipt sink, clock, warn sink
 */
export const runBuildBumpBump = traced(
	"reconcile.runBuildBumpBump",
	async function runBuildBumpBump(
		db: WatcherDb,
		config: WatcherConfig,
		deps: BuildBumpBumpDeps,
	): Promise<void> {
		const bump = deps.bump;
		if (bump === null) {
			// Not an error: a factory without the bump credential simply does not run
			// this rail. One warning, no row touched.
			warn(deps, "build_bump_bump.unconfigured", "build_bump_bump.unconfigured");
			return;
		}
		const ctx: PassContext = {
			db,
			deps,
			bump,
			now: (deps.now ?? (() => new Date()))(),
			warnedMarkers: new Set<string>(),
		};
		const cap = deps.maxPerPass ?? MAX_BUMPS_PER_PASS;
		await recoverStaleInvocations(ctx);

		// EVERY candidate, not only the built ones: a marker environment reads a
		// `failed` row to re-queue it, and the pure selector needs the whole set to
		// decide which answer applies (§6.1).
		const rows = await db
			.select()
			.from(buildBumpCandidates)
			.where(inArray(buildBumpCandidates.status, ["pending", "building", "built", "failed"]))
			.orderBy(asc(buildBumpCandidates.id));

		let spent = 0;
		for (const group of groupByImage(rows)) {
			if (spent >= cap) break;
			spent += await driveImage(ctx, config, group, cap - spent);
		}
	},
);
