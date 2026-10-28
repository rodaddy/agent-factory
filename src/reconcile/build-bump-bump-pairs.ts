/**
 * @module reconcile/build-bump-bump-pairs
 * @description The PAIR STATE MACHINE half of the build-bump bump pass
 *   (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §6.2-6.3): one (candidate, app_dir) row
 *   driven from `pending` through one invocation to a terminal state. The
 *   SELECTION half — which candidate an environment wants — is
 *   `build-bump-environments.ts`, and the pass that joins them is
 *   `build-bump-bump.ts`.
 *
 *   THE CLAIM IS ONE CONDITIONAL UPDATE. The increment is not a bookkeeping
 *   write after a read — it IS the claim: a single
 *   `UPDATE ... SET attempts = attempts + 1 WHERE id = ? AND status = 'pending'
 *   AND attempts = ? RETURNING attempts`. Two overlapping passes race on that one
 *   statement and exactly one gets a row back, so exactly one bump PR opens per
 *   (candidate, app_dir); the loser invokes nothing. Claiming BEFORE the call is
 *   what bounds a lost response — the trap this repo already paid for on runner
 *   allocation — so a lost response costs one attempt rather than an unbounded
 *   retry loop.
 *
 *   ONLY `opened` AND `refused` ARE TERMINAL. Exit 1 means the bump itself is
 *   wrong for this pair and the same inputs deterministically reproduce it, so a
 *   retry is churn. A HARNESS outcome is the environment, not the judgement, and
 *   the environment gets fixed — so the pair returns to `pending` EVERY time and
 *   the next pass tries again (§6.3). `attempts` keeps counting and is the alert
 *   signal (§8); it is no longer a terminal condition, because a pair that stops
 *   retrying is a deploy that silently never lands. The stale-recovery path
 *   returns an abandoned `invoking` row to `pending` for the same reason.
 *
 *   `ALREADY_AT_TAG` IS CONVERGENCE, NOT A FAULT. It is recorded `refused` like
 *   any other exit-1 reason — the pair is done — but logged at info under its own
 *   event, so a repository sitting at its desired tag does not read as a failure.
 *
 *   THE RECEIPT IS BEST-EFFORT AND BOUNDED. A forge comment failing must not
 *   un-open a PR that exists, so a throw is warned and the row stays `opened`.
 *
 * @outputs
 *   - `BuildBumpBumpDeps` -- the injected invoke seam, paths, receipt sink, clock
 *   - `PassContext` -- what one pass holds constant across its rows
 *   - `warn` -- the bounded warning sink shared with the pass
 *   - `claimPairAttempt` -- the compare-and-swap claim on one pair row
 *   - `recoverStaleInvocations` -- abandoned invocations back to `pending`
 *   - `reopenSuperseded` -- a terminal pair a later bump of the same dir overtook
 *   - `drivePair` -- one (candidate, app_dir) pair through one invocation
 *
 * @dependencies
 *   - ../db/schema -- build_bump_bumps row type and table
 *   - ../imagebuild/bump -- the outcome vocabulary (the invoke itself is injected)
 *   - ../log -- bounded/errorClass/log and the shared traced() wrapper
 */
import { and, eq, lte, ne, or, sql } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import {
	type BuildBumpBumpRow,
	type BuildBumpCandidateRow,
	buildBumpBumps,
	buildBumpCandidates,
} from "../db/schema";
import type { BumpInput, BumpOutcome } from "../imagebuild/bump";
import { bounded, errorClass, log, traced } from "../log";

/** An invocation older than this is treated as lost and made retryable. */
const INVOCATION_TIMEOUT_MS = 15 * 60 * 1000;

/** Max characters of a posted receipt body. */
const MAX_RECEIPT_BYTES = 1024;

/** The seams one pass drives; all injected so the pass is hermetic in tests. */
export interface BuildBumpBumpDeps {
	/**
	 * The invoke seam, or `null` when the lane is unconfigured. The credential is
	 * captured INSIDE this closure by the composition root, so this pass — and
	 * every test of it — never holds a token.
	 */
	bump: ((input: BumpInput) => Promise<BumpOutcome>) | null;
	/** Path to `open-bump-pr.sh` on the watcher's disk. Given, never computed here. */
	scriptPath: string;
	/** Root under which each invocation gets its own scratch directory. */
	workdirRoot: string;
	/** Best-effort receipt sink on the opened PR. A failure is warned, never retried. */
	postReceipt?: (repository: string, pr: number, body: string) => Promise<void>;
	/** Clock seam, so terminal timestamps are assertable without sleeping. */
	now?: () => Date;
	/** Bounded warning sink for a skipped row or a failed receipt. */
	onWarn?: (message: string) => void;
	/** Invocation cap for this pass. */
	maxPerPass?: number;
}

/** Everything one pass holds constant across its rows, `now` read once. */
export interface PassContext {
	db: WatcherDb;
	deps: BuildBumpBumpDeps;
	bump: (input: BumpInput) => Promise<BumpOutcome>;
	now: Date;
	/** `(repository, marker, sha)` keys already warned about this pass (§6.1). */
	warnedMarkers: Set<string>;
}

/** Emit one bounded warning through the injected sink and the log. */
export const warn = traced(
	"reconcile.buildBumpBumpWarn",
	function warn(deps: BuildBumpBumpDeps, event: string, message: string): void {
		log("warn", event, { reason: bounded(message) });
		deps.onWarn?.(message);
	},
);

/**
 * Find or create the row for one (candidate, app) pair. The insert is
 * `ON CONFLICT DO NOTHING` then a re-select, so a concurrent pass produces no
 * second row and no second invocation — the unique index is what enforces it.
 */
async function pairRow(
	ctx: PassContext,
	candidateId: number,
	appDir: string,
): Promise<BuildBumpBumpRow | undefined> {
	await ctx.db
		.insert(buildBumpBumps)
		.values({ candidateId, appDir, status: "pending", attempts: 0 })
		.onConflictDoNothing();
	const found = await ctx.db
		.select()
		.from(buildBumpBumps)
		.where(and(eq(buildBumpBumps.candidateId, candidateId), eq(buildBumpBumps.appDir, appDir)));
	return found[0];
}

/** The bounded receipt body: identifiers and one fixed line, nothing else. */
function receiptBody(candidate: BuildBumpCandidateRow, appDir: string): string {
	const lines = [
		`repository: ${candidate.repository}`,
		`tag: ${candidate.tag}`,
		`sha: ${candidate.sha}`,
		`image: ${candidate.image}`,
		`app_dir: ${appDir}`,
		`build_job: ${candidate.buildJobName ?? "none"}`,
		"opened by software-factory build-bump (sf#544)",
	];
	return bounded(lines.join(" | "), MAX_RECEIPT_BYTES);
}

/** Post the receipt best-effort. A throw is warned; the PR is already open. */
async function postReceipt(
	ctx: PassContext,
	candidate: BuildBumpCandidateRow,
	receipt: { appDir: string; repository: string; pr: number },
): Promise<void> {
	const sink = ctx.deps.postReceipt;
	if (!sink) return;
	try {
		await sink(receipt.repository, receipt.pr, receiptBody(candidate, receipt.appDir));
	} catch (error) {
		warn(ctx.deps, "build_bump_bump.receipt_failed", `pr ${receipt.pr}: ${errorClass(error)}`);
	}
}

/**
 * Apply one outcome to the pair's row. `attempts` was already incremented by the
 * claim, and a `harness` outcome always returns the row to `pending`.
 */
async function applyOutcome(
	ctx: PassContext,
	row: BuildBumpBumpRow,
	outcome: BumpOutcome,
): Promise<void> {
	const set = (next: Partial<typeof buildBumpBumps.$inferInsert>) =>
		ctx.db.update(buildBumpBumps).set(next).where(eq(buildBumpBumps.id, row.id));
	if (outcome.kind === "opened") {
		await set({
			status: "opened",
			pr: outcome.pr,
			url: outcome.url,
			// A prior harness outcome left its reason here; an opened pair has no
			// reason, so the terminal record must clear it rather than inherit it.
			reason: null,
			startedAt: null,
			finishedAt: ctx.now,
			// SETTLEMENT ORDER, not just a duration marker: `reopenSuperseded` reads
			// it to tell an older record from the one that overtook it.
			settledAt: ctx.now,
		});
		return;
	}
	if (outcome.kind === "refused") {
		// TERMINAL: the same inputs produce the same refusal, so a retry is churn.
		await set({
			status: "refused",
			reason: outcome.reason,
			startedAt: null,
			finishedAt: ctx.now,
			settledAt: ctx.now,
		});
		return;
	}
	// HARNESS: the environment, not the judgement. Back to `pending`, every time.
	// `settledAt` stays NULL — nothing settled, so nothing can supersede it.
	await set({
		status: "pending",
		reason: bounded(outcome.reason),
		startedAt: null,
		finishedAt: null,
		settledAt: null,
	});
}

/** A settled record ordered against another; NULL sorts older than any set value. */
function settledBefore(row: BuildBumpBumpRow, other: BuildBumpBumpRow): boolean {
	if (!other.settledAt) return false;
	if (!row.settledAt) return true;
	return row.settledAt.getTime() < other.settledAt.getTime();
}

/** Only a converged record may be re-driven; a real refusal stays terminal. */
function reopenable(row: BuildBumpBumpRow): boolean {
	if (row.status === "opened") return true;
	return row.status === "refused" && row.reason === "ALREADY_AT_TAG";
}

/** The reopenable predicate as SQL, so the superseder set matches `reopenable`. */
const reopenableSql = or(
	eq(buildBumpBumps.status, "opened"),
	and(eq(buildBumpBumps.status, "refused"), eq(buildBumpBumps.reason, "ALREADY_AT_TAG")),
);

/** What identifies a pair's deploy target beyond the directory name. */
interface PairScope {
	repository: string;
	image: string;
}

/**
 * The candidate's own (repository, image). A pair's identity is that PLUS the
 * directory: `app_dir` is a plain name, and two enrolled repositories may
 * legitimately own directories of the same name.
 */
async function pairScope(ctx: PassContext, candidateId: number): Promise<PairScope | undefined> {
	const found = await ctx.db
		.select({ repository: buildBumpCandidates.repository, image: buildBumpCandidates.image })
		.from(buildBumpCandidates)
		.where(eq(buildBumpCandidates.id, candidateId));
	return found[0];
}

/**
 * The row that overtook this one, or `undefined`. A SUPERSEDER is any row for the
 * same (repository, image, app_dir) that is itself CONVERGED — `opened` or
 * `refused ALREADY_AT_TAG`, the same predicate `reopenable` applies — and settled
 * LATER than this one.
 *
 * A converged refusal counts: `ALREADY_AT_TAG` says the directory was carrying
 * that other tag, which invalidates this row's claim exactly as an opened PR
 * does. Selecting only `opened` strands prod whenever the newer bump converged
 * (marker v2 -> v1 while v2's PR is unmerged, so v1 settles `ALREADY_AT_TAG`,
 * then back to v2: no superseder found, no movement and no alert).
 */
async function findSuperseder(
	ctx: PassContext,
	row: BuildBumpBumpRow,
	appDir: string,
	scope: PairScope,
): Promise<BuildBumpBumpRow | undefined> {
	const sameTarget = await ctx.db
		.select({ bump: buildBumpBumps })
		.from(buildBumpBumps)
		.innerJoin(buildBumpCandidates, eq(buildBumpCandidates.id, buildBumpBumps.candidateId))
		.where(
			and(
				eq(buildBumpBumps.appDir, appDir),
				eq(buildBumpCandidates.repository, scope.repository),
				eq(buildBumpCandidates.image, scope.image),
				ne(buildBumpBumps.id, row.id),
				reopenableSql,
			),
		);
	return sameTarget.map((r) => r.bump).find((other) => settledBefore(row, other));
}

/**
 * Re-open one (candidate, app_dir) pair whose terminal record has been SUPERSEDED
 * by a later converged bump of the same (repository, image, app_dir). Returns
 * whether it re-opened.
 *
 * THE PAIR KEY IS (candidate_id, app_dir) FOR ALL TIME, and that is what strands a
 * marker environment: a marker moving prod v2 -> v1 -> v2 finds v2's row still
 * `opened` from the first move, `drivePair` refuses a non-`pending` row, and prod
 * sits on v1 forever with no signal. The record is not wrong — it truthfully says
 * v2 WAS deployed — it is merely STALE, and what makes it stale is another row for
 * the same target converging after it.
 *
 * ONLY A CONVERGED RECORD REOPENS, AND ONLY A CONVERGED RECORD SUPERSEDES.
 * `opened` and `refused ALREADY_AT_TAG` both mean "this directory was carrying
 * this tag"; a `refused BAD_TARGET` or `PATTERN_DRIFT` means the bump itself is
 * wrong for that pair and the same inputs reproduce it, so it neither reopens nor
 * displaces anything, and acting on one would be exactly the churn loop
 * terminality exists to prevent. `attempts` is deliberately left alone: the alert
 * signal counts invocations spent on a pair, and a legitimate re-deploy is a new
 * invocation.
 */
export const reopenSuperseded = traced(
	"reconcile.reopenSuperseded",
	async function reopenSuperseded(
		ctx: PassContext,
		candidateId: number,
		appDir: string,
	): Promise<boolean> {
		const found = await ctx.db
			.select()
			.from(buildBumpBumps)
			.where(and(eq(buildBumpBumps.candidateId, candidateId), eq(buildBumpBumps.appDir, appDir)));
		const row = found[0];
		if (!row || row.status === "pending") return false;
		if (!reopenable(row)) return false;

		const scope = await pairScope(ctx, candidateId);
		if (!scope) return false;
		const superseder = await findSuperseder(ctx, row, appDir, scope);
		if (!superseder) return false;

		// Guarded on the status THIS caller read, so a pass that raced ahead and
		// already re-opened (or moved the row on) does not get a second reopen.
		const updated = await ctx.db
			.update(buildBumpBumps)
			.set({
				status: "pending",
				pr: null,
				url: null,
				reason: null,
				startedAt: null,
				// `finished_at` is NULL while `pending`; leaving the superseded
				// settlement's finish time would make a pending row carry one.
				finishedAt: null,
				settledAt: null,
				// The merge-watch record belongs to the superseded PR. Left
				// set, the next PR on this row is never polled, never counts as in
				// flight, and its merge never hard-refreshes Argo.
				mergedAt: null,
				prClosedAt: null,
				argoRefreshedAt: null,
			})
			.where(and(eq(buildBumpBumps.id, row.id), eq(buildBumpBumps.status, row.status)))
			.returning({ id: buildBumpBumps.id });
		if (updated.length !== 1) return false;
		log("info", "build_bump_bump.marker_reopened", {
			candidate_id: candidateId,
			app_dir: appDir,
			superseded_by_candidate: superseder.candidateId,
			superseded_by_pr: superseder.pr,
		});
		return true;
	},
);

/**
 * THE CLAIM, as one conditional update. Returns the RETURNED attempts count when
 * this caller owns the invocation, or `undefined` when it does not — the row moved
 * on or is no longer `pending`. Exported so the compare-and-swap can be exercised
 * deterministically against a stale read, rather than only through a
 * timing-dependent overlap of two passes.
 */
export const claimPairAttempt = traced(
	"reconcile.claimPairAttempt",
	async function claimPairAttempt(
		db: WatcherDb,
		row: BuildBumpBumpRow,
		now: Date = new Date(),
	): Promise<number | undefined> {
		const claimed = await db
			.update(buildBumpBumps)
			.set({
				attempts: sql`${buildBumpBumps.attempts} + 1`,
				status: "invoking",
				startedAt: now,
			})
			.where(
				and(
					eq(buildBumpBumps.id, row.id),
					eq(buildBumpBumps.status, "pending"),
					// COMPARE-AND-SWAP on the attempts this caller read. A concurrent pass
					// that already claimed has moved the count on, so this matches nothing
					// — which is what makes one invocation per claim, not one per pass.
					eq(buildBumpBumps.attempts, row.attempts),
				),
			)
			.returning({ attempts: buildBumpBumps.attempts });
		if (claimed.length !== 1) return undefined;
		return claimed[0]?.attempts;
	},
);

/**
 * Recover invocations whose process disappeared before it persisted an outcome.
 * An abandoned row returns to `pending`, never to `failed`: attempts is the
 * alert signal now, and a pair that stops retrying never converges.
 */
export const recoverStaleInvocations = traced(
	"reconcile.recoverStaleInvocations",
	async function recoverStaleInvocations(ctx: PassContext): Promise<void> {
		const staleBefore = new Date(ctx.now.getTime() - INVOCATION_TIMEOUT_MS);
		await ctx.db
			.update(buildBumpBumps)
			.set({ status: "pending", startedAt: null, reason: "stale invocation" })
			.where(
				and(eq(buildBumpBumps.status, "invoking"), lte(buildBumpBumps.startedAt, staleBefore)),
			);
	},
);

/** Log one outcome with identifiers only; `ALREADY_AT_TAG` reads as convergence. */
function logOutcome(
	candidate: BuildBumpCandidateRow,
	appDir: string,
	target: string,
	outcome: BumpOutcome,
): void {
	const converged = outcome.kind === "refused" && outcome.reason === "ALREADY_AT_TAG";
	const event = converged ? "build_bump_bump.converged" : `build_bump_bump.${outcome.kind}`;
	log("info", event, {
		candidate_id: candidate.id,
		repository: candidate.repository,
		tag: candidate.tag,
		image: candidate.image,
		app_dir: appDir,
		target,
		...(outcome.kind === "opened" ? { pr: outcome.pr } : { reason: bounded(outcome.reason) }),
	});
}

/** One pair's invocation inputs, grouped so `drivePair` stays at three parameters. */
export interface PairTarget {
	candidate: BuildBumpCandidateRow;
	appDir: string;
	/** The environment name, rendered by the wrapper into the PR title and body. */
	target: string;
	/** Skip the wrapper's `OLDER_TAG` guard: a marker move is explicit. */
	allowOlder: boolean;
}

/** Drive one (candidate, app) pair, or skip it. Returns whether it invoked. */
export const drivePair = traced(
	"reconcile.drivePair",
	async function drivePair(ctx: PassContext, pair: PairTarget): Promise<boolean> {
		const { candidate, appDir } = pair;
		const row = await pairRow(ctx, candidate.id, appDir);
		if (!row) return false;
		// Cheap skip on the stale read; the conditional update below is the real gate.
		if (row.status !== "pending") return false;

		// THE CLAIM. One conditional update: whoever's increment lands first owns the
		// invocation, and a pass that another already claimed or that has since gone
		// terminal gets no row back and calls nothing.
		const attempts = await claimPairAttempt(ctx.db, row, ctx.now);
		if (attempts === undefined) return false;

		// The image is NOT an argument of the bump: the
		// reviewed script rewrites EVERY fleet-registry `image:` line under the app
		// directory after proving the new tag exists for each of them. The
		// ENVIRONMENT selected which directories to bump; the directory's own
		// manifests name the images to rewrite.
		const outcome = await ctx.bump({
			scriptPath: ctx.deps.scriptPath,
			candidate: { repository: candidate.repository, tag: candidate.tag, sha: candidate.sha },
			appDir,
			workdir: `${ctx.deps.workdirRoot}/${candidate.id}-${appDir}`,
			target: pair.target,
			allowOlder: pair.allowOlder,
		});
		logOutcome(candidate, appDir, pair.target, outcome);
		await applyOutcome(ctx, row, outcome);
		if (outcome.kind === "opened") {
			await postReceipt(ctx, candidate, { appDir, repository: outcome.repository, pr: outcome.pr });
		}
		return true;
	},
);
