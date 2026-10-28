/**
 * @module observability/build-bump-alert
 * @description The build-bump lane's one wake-a-human signal
 *   (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §8): a (candidate, app_dir) pair that has
 *   spent THREE invocations and is still `pending` raises a
 *   `[monitoring-critical]` issue through the existing critical-alert egress.
 *
 *   WHY `attempts` IS THE SIGNAL AND NOT A STATUS. §6 removed the harness retry
 *   budget: a `harness` outcome returns the pair to `pending` EVERY time, so the
 *   lane now self-heals once the fault is removed and no pair ever lands in a
 *   terminal `failed` anyone could alert on. That is the right behaviour — the
 *   `--allow-older` flag reaching an un-deployed checkout fixes itself the moment
 *   the checkout advances — but it means the only remaining evidence of a pair
 *   that is genuinely stuck is a counter going up forever, in a database on a
 *   loopback-only box. Without this pass the honest description of a wedged bump
 *   is "silent, indefinitely".
 *
 *   THREE, because a bump runs once per reconcile pass: one failure is noise, two
 *   is a coincidence, three is thirty minutes of a lane not converging. It is the
 *   same number §10 item 4 pins as the acceptance property.
 *
 *   `pending` ONLY. `opened` and `refused` are the terminal states, and a
 *   `refused` pair is the script judging the request rather than failing at it —
 *   `ALREADY_AT_TAG` IS convergence. Alerting on either would page an operator
 *   for a lane that is working.
 *
 *   THE DEDUPE IDENTITY IS (repository, app_dir) AND NOTHING ELSE. The alert
 *   class is the string `raiseCriticalAlert` slugs into its marker, so anything
 *   varying that lands in it splits one incident across many issues — an attempt
 *   count would open a fresh issue every pass, which is the exact flood that
 *   function exists to prevent. The reason travels as the CAUSE, which is body
 *   text and not part of the key.
 *
 *   IT CLEARS BY CONVERGING, NOT BY CLOSING. §8's "clears when the pair
 *   converges" is satisfied by the dedupe: a converged pair leaves `pending` and
 *   simply stops matching, so nothing is raised again. This module never closes
 *   an issue — the operator closes it, and a still-broken pair re-opens one on
 *   the next pass because the marker scan then finds nothing.
 *
 *   AN ALERT IS SCOPED TO WHAT THE PASS WOULD ACT ON NOW, NOT TO HISTORY. Both
 *   filters read rows that OUTLIVE the state that produced them: a `pending` pair
 *   keeps its attempt count after its repository is un-enrolled, and a `failed`
 *   candidate keeps its requeue count after the marker moved to another commit.
 *   Every pass those rows satisfy the thresholds again, and the dedupe then hides
 *   the fact that the signal is false rather than fixing it — one open issue for a
 *   lane that is doing nothing, which is worse than silence because it is
 *   indistinguishable from a real one. So the counted rows are intersected with
 *   the DESIRED SET: the enrolled (repository, image, environment) list the
 *   status view enumerates, each resolved through `desiredCandidateFor`, the same
 *   selector the bump pass itself uses. A pair alerts only when its candidate is
 *   an environment's current desired candidate AND that environment lists the
 *   pair's `app_dir`; a candidate alerts only when it is the `marker-unbuilt`
 *   answer of a current marker environment. Nothing historical survives that.
 *
 *   THE EGRESS HAS NO CLOSE VERB. `./critical-alert` raises and dedupes; it never
 *   closes an issue and never will (read it — the only forge write is the issue
 *   POST). So "clears when the pair converges" (§8) means exactly this: a
 *   converged — or un-enrolled, or re-pointed — state stops MATCHING, nothing is
 *   raised again, and the open issue is closed by a HUMAN. That is the same
 *   lifecycle every other `[monitoring-critical]` alert has, `reconcile pass
 *   error` included: the alert is the wake-up, the operator owns the close.
 *
 *   THE SECOND SIGNAL: A MARKER ON A CANDIDATE THAT WILL NOT BUILD. A pair row
 *   only ever exists once a candidate is `built`, so the stuck-pair scan above is
 *   blind to the case where the BUILD is what keeps failing. §6 has the bump pass
 *   re-queue a `failed` candidate a marker needs, every pass, forever — correct,
 *   because the fault may be transient — but a permanent build failure then spends
 *   one Kaniko Job per cycle with no pair row, no alert, and a `/status.json`
 *   entry indistinguishable from an environment nobody placed a marker on.
 *   `build_bump_candidates.requeues` is the counter that made that loop
 *   observable, and `unbuiltCandidates` is the same three-pass threshold applied
 *   to it. The requeue is never stopped: this raises a human, not a terminal state.
 *
 * @outputs
 *   - `stuckPairs` -- the pure filter: which rows have earned an alert
 *   - `unbuiltCandidates` -- the pure filter for re-queued, never-built candidates
 *   - `desiredScope` -- the pure desired set both filters are intersected with
 *   - `scopedStuckPairs` -- the pure scoping step for pairs
 *   - `scopedUnbuiltCandidates` -- the pure scoping step for candidates
 *   - `buildBumpAlertClass` -- the (repository, app_dir) dedupe identity
 *   - `buildBumpUnbuiltAlertClass` -- the (repository, tag) dedupe identity
 *   - `runBuildBumpAlerts` -- read both signals and raise one alert each
 *   - `StuckPairRow` -- the bounded row shape the filter and the query share
 *   - `UnbuiltCandidateRow` -- the bounded candidate shape the second scan shares
 *   - `DesiredScope` -- the two identity sets the scoping step matches against
 *
 * @dependencies
 *   - drizzle-orm -- the candidate/pair join and the bounded enrolment reads
 *   - ../config/build-bump-images -- `resolvedEnvironments`, the positional defaults
 *   - ../config/schema -- the loaded configuration the enrolment is read from
 *   - ../db/schema, ../db/client -- the build_bump tables and the db type
 *   - ../reconcile/build-bump-environments -- `desiredCandidateFor`, the ONE selector
 *   - ../status/build-bump-status -- `enrolledEnvironments`, the ONE enumeration
 *   - ./critical-alert -- the ONE `[monitoring-critical]` egress
 */
import { eq, inArray } from "drizzle-orm";
import { resolvedEnvironments } from "../config/build-bump-images";
import type { WatcherConfig } from "../config/schema";
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
import { enrolledEnvironments } from "../status/build-bump-status";
import { type CriticalAlertTarget, raiseCriticalAlert } from "./critical-alert";

// Re-exported so a caller wiring THIS pass names one module rather than two: the
// target is this function's second argument, and `service-cycle` holds it only to
// hand it here.
export type { CriticalAlertTarget };

/**
 * Invocations a pair may spend before it is considered stuck.
 *
 * A bump is invoked at most once per reconcile pass, so this is "three passes in
 * a row produced nothing terminal" — the §10 item 4 acceptance property.
 */
const STUCK_ATTEMPTS = 3;

/** Hard bound on the reason text that reaches the alert body. */
const MAX_CAUSE_CHARS = 200;

/**
 * The candidate statuses a re-queued-but-unbuilt alert applies to.
 *
 * Everything except `built`. The bump pass re-queues `failed` -> `pending`, so a
 * counted row is found in whichever phase of that cycle the scan happens to
 * catch; only `built` means the candidate converged.
 */
const UNBUILT_STATUSES = ["pending", "building", "failed"];

/**
 * One pair row, narrowed to what the alert decision needs.
 *
 * `repository` comes from the CANDIDATE, not the pair: `build_bump_bumps` keys on
 * `candidate_id` and holds no repository of its own, so the join is what makes an
 * alert nameable at all.
 */
export interface StuckPairRow {
	repository: string;
	/**
	 * The candidate this pair bumps. Carried so the scoping step can ask whether
	 * this exact candidate is what an environment wants RIGHT NOW — a pair whose
	 * candidate has been superseded reads identically to a live one on every other
	 * field, which is half of why the historical read alerted falsely.
	 */
	candidateId: number;
	appDir: string;
	status: string;
	attempts: number;
	/** The pair's last fixed reason string, or null if it has not failed yet. */
	reason: string | null;
}

/**
 * The pairs that have earned an alert: `pending`, and at or past the threshold.
 *
 * PURE, and separated from the query deliberately — this is the whole of the
 * decision, and a db test proving the join would otherwise be the only place the
 * threshold and the status rule were exercised together.
 *
 * `>=` rather than `===` because a pair keeps counting past three (§6 removed
 * terminality), so an equality check would alert once and then go quiet on the
 * pair that is failing hardest. Re-raising is free: `raiseCriticalAlert` dedupes.
 *
 * @param rows - candidate-joined pair rows
 * @returns the subset worth waking someone for, input order preserved
 */
export const stuckPairs = traced(
	"observability.stuckPairs",
	function stuckPairs(rows: readonly StuckPairRow[]): StuckPairRow[] {
		return rows.filter((row) => row.status === "pending" && row.attempts >= STUCK_ATTEMPTS);
	},
);

/**
 * One candidate row, narrowed to what the unbuilt decision needs.
 *
 * `status` is the CANDIDATE lifecycle (`pending` | `building` | `built` |
 * `failed`), not the pair one, and `requeues` counts only the marker-driven
 * `failed` -> `pending` transitions §6 performs.
 */
export interface UnbuiltCandidateRow {
	/**
	 * The candidate's own id. Carried so the scoping step can ask whether a marker
	 * still points at THIS row — the requeue counter is never reset, so after a
	 * marker moves the old row is indistinguishable from the live one without it.
	 */
	id: number;
	repository: string;
	tag: string;
	status: string;
	requeues: number;
	/** Why the last build attempt failed — a fixed reason string, or null. */
	buildReason: string | null;
}

/**
 * The candidates that have earned an alert: re-queued at least three times and
 * still not built.
 *
 * PURE, and separated from the query for the same reason `stuckPairs` is — the
 * threshold and the status rule are the whole decision, and a db test would
 * otherwise be the only place they were exercised together.
 *
 * `built` is EXCLUDED and is the only exclusion: a candidate that eventually
 * built converged, whatever it cost to get there, and the pair scan owns
 * everything after that point. `pending` and `building` are included alongside
 * `failed` because the pass re-queues to `pending` — a scan that waited for
 * `failed` again would see the row only in the narrow window between build
 * attempts and alert on whichever pass happened to land there.
 *
 * @param rows - candidate rows for enrolled repositories
 * @returns the subset worth waking someone for, input order preserved
 */
export const unbuiltCandidates = traced(
	"observability.unbuiltCandidates",
	function unbuiltCandidates(rows: readonly UnbuiltCandidateRow[]): UnbuiltCandidateRow[] {
		return rows.filter(
			(row) => row.requeues >= STUCK_ATTEMPTS && UNBUILT_STATUSES.includes(row.status),
		);
	},
);

/** The key separator for the pair identity; a tab occurs in neither half. */
const SCOPE_SEP = "\t";

/**
 * The identity of one (candidate, app_dir) pair an environment currently wants.
 *
 * A STRING rather than a tuple because the scoping step is a set membership test
 * and a tuple would compare by reference. The separator is a tab: an app
 * directory is a plain name by schema and a candidate id is an integer, so
 * neither half can contain one and the key cannot be forged by collision.
 */
function pairKey(candidateId: number, appDir: string): string {
	return `${candidateId}${SCOPE_SEP}${appDir}`;
}

/**
 * What the pass would act on RIGHT NOW, as two membership sets.
 *
 * Built from the enrolled (repository, image, environment) list and the same
 * `desiredCandidateFor` selector the bump pass runs — never from the alert rows
 * themselves, which is the whole point: a row that no longer appears here is a
 * row the pass has stopped touching, whatever its counters still say.
 */
export interface DesiredScope {
	/** `pairKey(candidateId, appDir)` for every pair an environment currently wants. */
	pairs: ReadonlySet<string>;
	/** Candidate ids that are the `marker-unbuilt` answer of a current marker environment. */
	unbuilt: ReadonlySet<number>;
}

/** One enrolled (repository, image) and the rows the selector needs for it. */
export interface ScopeInput {
	/** The environments this (repository, image) declares, positional defaults unapplied. */
	environments: readonly Parameters<typeof resolvedEnvironments>[0][number][];
	/** Candidate rows narrowed to this (repository, image). */
	candidates: readonly BuildBumpCandidateRow[];
	/** Marker rows narrowed to this repository. */
	markers: readonly BuildBumpMarkerRow[];
	/** The enrolment's `tag_pattern`, re-applied on the marker branch. */
	tagPattern: string;
}

/**
 * The desired set, computed purely from enrolment and rows.
 *
 * PURE and exported deliberately: this is the whole of the new decision, and a
 * db test proving the queries would otherwise be the only place "an un-enrolled
 * repository contributes nothing" and "a moved marker drops its old candidate"
 * were exercised. It takes the enrolment already narrowed per (repository,
 * image) so it needs no config lookup of its own and stays testable without one.
 *
 * A `bump` answer contributes one pair key per app directory of the environment —
 * every directory, not the first: the status view reports a representative pair
 * and this must not, because a stuck pair on the second directory is exactly as
 * wedged as one on the first. A `marker-unbuilt` answer contributes the candidate
 * id instead, because no pair row can exist before the image does.
 *
 * @param inputs - one entry per enrolled (repository, image)
 * @returns the two identity sets the scoping steps match against
 */
export const desiredScope = traced(
	"observability.desiredScope",
	function desiredScope(inputs: readonly ScopeInput[]): DesiredScope {
		const pairs = new Set<string>();
		const unbuilt = new Set<number>();
		for (const input of inputs) {
			for (const env of resolvedEnvironments(input.environments)) {
				const resolved: ResolvedEnvironment =
					env.promote === "tag"
						? { name: env.name, appDirs: [...env.app_dirs], promote: "tag" }
						: {
								name: env.name,
								appDirs: [...env.app_dirs],
								promote: "marker",
								marker: env.marker,
							};
				const desired = desiredCandidateFor(
					resolved,
					[...input.candidates],
					[...input.markers],
					input.tagPattern,
				);
				if (desired.kind === "bump") {
					for (const dir of env.app_dirs) pairs.add(pairKey(desired.candidate.id, dir));
				} else if (desired.kind === "marker-unbuilt") {
					unbuilt.add(desired.candidate.id);
				}
			}
		}
		return { pairs, unbuilt };
	},
);

/**
 * The stuck pairs an environment still wants: the counted rows intersected with
 * the desired set.
 *
 * PURE, and a SEPARATE step from `stuckPairs` rather than a widened filter. The
 * threshold rule and the "is this live" rule fail for different reasons and are
 * pinned by different tests; folding them together would mean a test for one
 * silently covered the other.
 *
 * @param rows - the rows `stuckPairs` already selected
 * @param scope - the desired set for this pass
 * @returns the subset an environment currently wants, input order preserved
 */
export const scopedStuckPairs = traced(
	"observability.scopedStuckPairs",
	function scopedStuckPairs(rows: readonly StuckPairRow[], scope: DesiredScope): StuckPairRow[] {
		return rows.filter((row) => scope.pairs.has(pairKey(row.candidateId, row.appDir)));
	},
);

/**
 * The unbuilt candidates a marker still points at: the counted rows intersected
 * with the desired set.
 *
 * Separate from `unbuiltCandidates` for the same reason `scopedStuckPairs` is
 * separate from `stuckPairs`. A candidate whose marker moved keeps its requeue
 * count forever — nothing resets it — so without this the first permanently
 * failing build a repository ever had alerts for the life of the row.
 *
 * @param rows - the rows `unbuiltCandidates` already selected
 * @param scope - the desired set for this pass
 * @returns the subset a marker currently points at, input order preserved
 */
export const scopedUnbuiltCandidates = traced(
	"observability.scopedUnbuiltCandidates",
	function scopedUnbuiltCandidates(
		rows: readonly UnbuiltCandidateRow[],
		scope: DesiredScope,
	): UnbuiltCandidateRow[] {
		return rows.filter((row) => scope.unbuilt.has(row.id));
	},
);

/**
 * The dedupe identity for one unbuilt candidate.
 *
 * (repository, tag) and NOTHING else. The tag rather than the app directory,
 * because this failure is upstream of every directory the candidate would bump —
 * one image failed to build, and splitting that into one issue per app_dir would
 * report one fault as several. The requeue count and the build reason stay out
 * for the same reason they stay out of the pair class: a value that climbs every
 * pass in the dedupe key opens a fresh issue every pass.
 *
 * @param repository - `<owner>/<repo>` from the candidate row
 * @param tag - the version tag the marker selected
 */
export const buildBumpUnbuiltAlertClass = traced(
	"observability.buildBumpUnbuiltAlertClass",
	function buildBumpUnbuiltAlertClass(repository: string, tag: string): string {
		return `build-bump unbuilt ${repository} ${tag}`;
	},
);

/**
 * The dedupe identity for one stuck pair.
 *
 * (repository, app_dir) and NOTHING else — see the module docstring for why the
 * attempt count and the reason must stay out of it. Exported so a test can pin
 * the exact string rather than re-deriving the format it is asserting.
 *
 * @param repository - `<owner>/<repo>` from the candidate row
 * @param appDir - the `manifests/apps/<name>` directory the pair bumps
 */
export const buildBumpAlertClass = traced(
	"observability.buildBumpAlertClass",
	function buildBumpAlertClass(repository: string, appDir: string): string {
		return `build-bump stuck ${repository} ${appDir}`;
	},
);

/**
 * Raise one alert per pair that has spent three invocations without settling.
 *
 * @param db - watcher database
 * @param target - the configured alert destination, or `undefined` when off
 */
async function raiseStuckPairAlerts(
	db: WatcherDb,
	target: CriticalAlertTarget | undefined,
	scope: DesiredScope,
): Promise<void> {
	const rows = await db
		.select({
			repository: buildBumpCandidates.repository,
			candidateId: buildBumpBumps.candidateId,
			appDir: buildBumpBumps.appDir,
			status: buildBumpBumps.status,
			attempts: buildBumpBumps.attempts,
			reason: buildBumpBumps.reason,
		})
		.from(buildBumpBumps)
		.innerJoin(buildBumpCandidates, eq(buildBumpCandidates.id, buildBumpBumps.candidateId));

	for (const row of scopedStuckPairs(stuckPairs(rows), scope)) {
		await raiseCriticalAlert(target, {
			alertClass: buildBumpAlertClass(row.repository, row.appDir),
			// The reason is one of the lane's FIXED strings by construction
			// (`src/imagebuild/bump.ts`), never script text — bounded anyway,
			// because this value crosses into a forge-hosted document.
			cause: (row.reason ?? "no reason recorded").slice(0, MAX_CAUSE_CHARS),
		});
	}
}

/**
 * Raise one alert per candidate a marker has re-queued three times without it
 * ever building.
 *
 * A SEPARATE READ, not a join onto the pair scan: the whole point of this signal
 * is the case where NO pair row exists, so anything that reached these rows
 * through `build_bump_bumps` would filter out exactly what it is looking for.
 *
 * @param db - watcher database
 * @param target - the configured alert destination, or `undefined` when off
 */
async function raiseUnbuiltAlerts(
	db: WatcherDb,
	target: CriticalAlertTarget | undefined,
	scope: DesiredScope,
): Promise<void> {
	const rows = await db
		.select({
			id: buildBumpCandidates.id,
			repository: buildBumpCandidates.repository,
			tag: buildBumpCandidates.tag,
			status: buildBumpCandidates.status,
			requeues: buildBumpCandidates.requeues,
			buildReason: buildBumpCandidates.buildReason,
		})
		.from(buildBumpCandidates);

	for (const row of scopedUnbuiltCandidates(unbuiltCandidates(rows), scope)) {
		await raiseCriticalAlert(target, {
			alertClass: buildBumpUnbuiltAlertClass(row.repository, row.tag),
			// A build reason is a batch/v1 condition reason or one of the build
			// pass's fixed strings, never container output — bounded regardless,
			// because this value crosses into a forge-hosted document.
			cause: (row.buildReason ?? "build has not succeeded").slice(0, MAX_CAUSE_CHARS),
		});
	}
}

/**
 * Read the desired set for this pass: the enrolment, and the rows it selects on.
 *
 * THE SAME ENUMERATION `/status.json` USES (`enrolledEnvironments`) and the same
 * selector the bump pass uses (`desiredCandidateFor`, through `desiredScope`).
 * Not a re-derivation: a second copy of "what is enrolled" is how the alert and
 * the status view came to disagree in the first place.
 *
 * TWO READS, both bounded by the enrolled repository names, and both issued even
 * when no target is configured — the off-by-default path must exercise the same
 * queries as the configured one, or a query that only fails in production ships.
 *
 * @param db - watcher database
 * @param config - loaded watcher configuration, the enrolment source
 * @returns the identity sets the scoping steps match against
 */
async function readDesiredScope(db: WatcherDb, config: WatcherConfig): Promise<DesiredScope> {
	const enrolled = enrolledEnvironments(config.repositories);
	if (enrolled.length === 0) return { pairs: new Set(), unbuilt: new Set() };
	const names = [...new Set(enrolled.map((entry) => entry.repository))];
	const candidates = await db
		.select()
		.from(buildBumpCandidates)
		.where(inArray(buildBumpCandidates.repository, names));
	const markers = await db
		.select()
		.from(buildBumpMarkers)
		.where(inArray(buildBumpMarkers.repository, names));
	return desiredScope(
		enrolled.map((entry) => ({
			environments: entry.environments,
			candidates: candidates.filter(
				(row) => row.repository === entry.repository && row.image === entry.image,
			),
			markers: markers.filter((row) => row.repository === entry.repository),
			tagPattern: entry.tagPattern,
		})),
	);
}

/**
 * Raise one `[monitoring-critical]` alert per stuck pair, and one per candidate a
 * marker keeps re-queuing without it ever building.
 *
 * TWO SCANS, because they are blind to each other's failure. The pair scan can
 * only see a candidate that reached `built`; the unbuilt scan is the case where
 * the build itself is what never succeeds, which produces no pair row at all.
 *
 * NEVER THROWS BY CONSTRUCTION: `raiseCriticalAlert` catches everything and
 * returns `undefined`, so this pass cannot end the reconcile cycle it runs in.
 * Awaited rather than fired-and-forgotten so the pass's own timing reflects it
 * and a test can observe the raises without a tick dance.
 *
 * An unconfigured `target` still runs the query — one bounded read per pass — and
 * every raise then returns immediately without a forge call. Skipping the read
 * would make the off-by-default path diverge from the configured one, which is
 * how a query that only fails in production gets shipped.
 *
 * BOTH SCANS ARE SCOPED to the state the pass would act on now — see the module
 * docstring. The scope is read ONCE and shared: the two signals must agree about
 * what is enrolled, and re-reading would let them disagree across a write in
 * between.
 *
 * @param db - watcher database
 * @param target - the configured alert destination, or `undefined` when off
 * @param config - loaded watcher configuration, the enrolment the scope is built from
 */
export const runBuildBumpAlerts = traced(
	"observability.runBuildBumpAlerts",
	async function runBuildBumpAlerts(
		db: WatcherDb,
		target: CriticalAlertTarget | undefined,
		config: WatcherConfig,
	): Promise<void> {
		const scope = await readDesiredScope(db, config);
		await raiseStuckPairAlerts(db, target, scope);
		await raiseUnbuiltAlerts(db, target, scope);
	},
	// The target carries a credential-resolving closure.
	{ redact: { args: [1] } },
);
