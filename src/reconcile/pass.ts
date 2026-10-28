/**
 * @module reconcile/pass
 * @description One bounded reconciliation pass. For each configured repository
 *   it reads changed GitHub items since the stored cursor, records normalized
 *   state, creates idempotent pending jobs, and advances the cursor ONLY after
 *   that repository's work fully succeeds. A single repository's failure is
 *   isolated — it is recorded as a safe summary and does not abort the others.
 *   The pass performs no GitHub writes and no runner dispatch.
 *
 *   The implement lane additionally refuses to queue while the issue's own
 *   proposal branch already has an OPEN pull request, because a finished job's
 *   proposal leaves no live job behind for the job-level dedupe to see.
 *
 * @outputs
 *   - `runPass` -- execute one pass over the configured repositories
 *   - `PassResult` / `RepoPassResult` -- structured, log-safe outcome
 *
 * @dependencies
 *   - ../forge/registry -- per-provider forge client resolution (mixed repos)
 *   - ../forge/read -- provider-aware incremental reads + open-proposal probe
 *   - ../db/repos -- transaction-safe writers
 *   - ../github/publication -- the watcher's own `rw/` proposal branch naming
 *   - ../log -- structured logging for the skip/probe outcomes
 *   - ../config/schema -- repository configuration
 */
import type { WatcherConfig } from "../config/schema";
import type { WatcherDb } from "../db/client";
import {
	createPendingJob,
	getCursor,
	hasLiveJobForItem,
	setCursor,
	upsertGithubItem,
	upsertRepository,
} from "../db/repos";
import type { ForgeClient } from "../forge/boundary";
import { findOpenProposalForHead, readChangedItems } from "../forge/read";
import type { ForgeRegistry } from "../forge/registry";
import { resolveBaseBranch, resolveBranchTipSha } from "../github/base-branch";
import { proposalBranchFor } from "../github/publication";
import type { NormalizedItem } from "../github/read";
import { log, traced } from "../log";
import { IMPLEMENT_TEMPLATE_ID, TRIAGE_TEMPLATE_ID } from "../templates/registry";

const CURSOR_RESOURCE = "issues";

/**
 * Map a repository's `checks` mode to the job type reconciliation queues. A
 * static-only repository (e.g. rtech-infra) queues the fixed `infra-static`
 * lane — the allowlisted static-validation template — while every other
 * repository queues `pr-review`. The job type must be a registered allowlisted
 * template or dispatch skips it; `infra-static` is registered in the fixed
 * template registry and must also be present in the config `job_templates`
 * allowlist (the double gate) to actually dispatch.
 *
 * Null when no box review job is queued: a repository that opted out with
 * `pr_review: false`, and a repository set to `pr_review_runtime: actions`,
 * which the pr-review Actions lane the webhook receiver dispatches reviews
 * instead (src/hooks/pr-review.ts reads the same flag), so a box
 * job would review it twice. Absent or `box` keeps the box review: the Actions
 * dispatch has no polling fallback yet (#417b), so a repo flips only after its
 * FORGE_TOKEN scope probe and one live dispatch receipt (476c). The same holds
 * for a static-only repository set to `static_runtime: actions` (
 * src/hooks/infra-static.ts reads the same flag): the Actions lane posts the
 * static verdict, so a box job would post a second one.
 */
function jobTypeForChecks(repo: WatcherConfig["repositories"][number]): string | null {
	if (repo.pr_review === false) {
		return null;
	}
	if (repo.checks === "static-only") {
		return repo.static_runtime === "actions" ? null : "infra-static";
	}
	return repo.pr_review_runtime === "actions" ? null : "pr-review";
}

/**
 * True when an item is an implement-lane candidate: an OPEN ISSUE carrying the
 * repository's configured opt-in label, matched EXACTLY.
 *
 * A pull request is never a candidate, even if labelled. The lane's whole
 * premise is turning a described task into a change; a PR already carries one,
 * and running it there would propose a change against a change.
 */
function isImplementCandidate(item: NormalizedItem, label: string): boolean {
	return item.kind === "issue" && item.state === "open" && item.labels.includes(label);
}

/**
 * True when an item is an issue-triage candidate: any OPEN ISSUE.
 *
 * There is deliberately NO label prerequisite — labelling is what triage DOES,
 * so gating it on a label already present would defeat the lane. A pull request
 * is never a candidate: triage classifies described work, and a PR is a change,
 * not a task to classify. The per-repository opt-in flag is the ONLY gate on
 * whether this runs at all, checked by the caller before this is consulted.
 */
function isTriageCandidate(item: NormalizedItem): boolean {
	return item.kind === "issue" && item.state === "open";
}

/**
 * Create one implement job for a labelled issue, resolving the base commit the
 * work must start from.
 *
 * BASE RESOLUTION IS THE POINT OF THIS FUNCTION. #65's provenance gate proves a
 * returned bundle applies to the EXACT commit the watcher handed out, comparing
 * in full and never by prefix. An issue carries no SHA of its own, so unless the
 * base is captured here there is nothing truthful to compare against later —
 * re-deriving the branch tip at ingest time would validate the bundle against
 * whatever the branch had moved to, which is not what was dispatched.
 *
 * Fails CLOSED and creates nothing when the base cannot be established. A job
 * with no real base is unverifiable by construction, so queueing one would spend
 * a runner to produce a change that must then be rejected.
 *
 * TWO dedupes guard this lane, and neither subsumes the other. The live-job
 * check bars a second run while one is IN FLIGHT. The open-proposal check bars
 * one after a run has FINISHED and left a proposal behind: at that point there
 * is no live job at all, the uniqueness key is the moving base tip, and the
 * labelled issue is still open and still re-read every pass — so without this
 * gate every later pass queued a fresh code-producing run against a change that
 * is already sitting in review (sf#570: sf#553 -> PR #569 -> duplicate job
 * 11309). The probe fails CLOSED: a pass that cannot PROVE no proposal is open
 * spends no runner, and the next pass simply re-asks. A closed-unmerged proposal
 * reads as absent, which is the intended re-run path.
 *
 * @returns true when a new job row was created.
 */
type EnqueueImplementJobArgs = {
	db: WatcherDb;
	client: ForgeClient;
	repo: WatcherConfig["repositories"][number];
	repositoryId: number;
	itemId: number;
	item: NormalizedItem;
	cache: BaseShaCache;
};

async function enqueueImplementJob({
	db,
	client,
	repo,
	repositoryId,
	itemId,
	item,
	cache,
}: EnqueueImplementJobArgs): Promise<boolean> {
	// DEDUPE ON THE ITEM, not on the uniqueness key, and do it BEFORE the base
	// lookup so a duplicate costs no forge round trip.
	//
	// `createPendingJob`'s conflict target is (repository, item, sha, job_type).
	// For this lane `sha` is the base branch TIP, which moves whenever anything
	// merges — so the target never matches and one unchanged labelled issue
	// queues a fresh code-producing run on every base movement. At a 15-minute
	// poll on an active repository that is an unbounded number of runners and
	// competing proposals for a single issue, growing with base-branch activity
	// rather than with anything the operator did. Found in review; reproduced
	// against the real database before fixing.
	if (await hasLiveJobForItem(db, repositoryId, itemId, IMPLEMENT_TEMPLATE_ID)) {
		return false;
	}

	// A FINISHED run leaves no live job, so the check above cannot see the
	// proposal it produced. Ask the forge whether this issue's own branch already
	// has one open, and fail closed on anything short of proven absence.
	const headBranch = proposalBranchFor(item.number, IMPLEMENT_TEMPLATE_ID);
	if (headBranch === null) {
		return false;
	}
	const proposal = await findOpenProposalForHead(client, repo.name, headBranch);
	if (proposal !== "absent") {
		if (proposal === "open") {
			log("info", "reconcile.implement_skipped_open_proposal", {
				repository: repo.name,
				item_number: item.number,
				head_branch: headBranch,
			});
		}
		// `unknown` already logged its own warn inside the probe.
		return false;
	}

	const baseSha = await cache.resolve(client, repo);
	if (baseSha === null) {
		// Already logged with a reason by the resolver; nothing is queued.
		return false;
	}
	return createPendingJob(db, {
		repositoryId,
		itemId,
		sha: baseSha,
		jobType: IMPLEMENT_TEMPLATE_ID,
	});
}

/**
 * Per-pass memo for a repository's base commit.
 *
 * Resolved ONCE per repository per pass, for two reasons. It avoids a forge
 * round trip per labelled issue, and more importantly it makes every implement
 * job queued in one pass share a single base — without it, two issues labelled
 * in the same pass could be dispatched against different commits if the branch
 * moved between them, which is a difference nobody asked for and nobody can see.
 *
 * The memo lives for ONE pass. Holding it longer would reintroduce the staleness
 * the dispatch-time capture exists to avoid.
 */
class BaseShaCache {
	private resolved: string | null | undefined;

	async resolve(
		client: ForgeClient,
		repo: WatcherConfig["repositories"][number],
	): Promise<string | null> {
		if (this.resolved !== undefined) {
			return this.resolved;
		}
		const branch = await resolveBaseBranch(client, repo.name, repo.proposal_base_branch);
		this.resolved = branch === null ? null : await resolveBranchTipSha(client, repo.name, branch);
		return this.resolved;
	}
}

/** Per-repository outcome. `error` is a bounded, secret-free summary. */
export interface RepoPassResult {
	repository: string;
	ok: boolean;
	itemsSeen: number;
	jobsCreated: number;
	error?: string;
}

/** Whole-pass outcome. Safe to log as-is. */
export interface PassResult {
	startedAt: string;
	durationMs: number;
	repositories: RepoPassResult[];
	okCount: number;
	failCount: number;
}

/** One open issue observed by the real incremental sweep, with its durable ids. */
export interface ObservedOpenIssue {
	repo: WatcherConfig["repositories"][number];
	repositoryId: number;
	itemId: number;
	item: NormalizedItem;
}

/** Additive observation seams for callers composing work around the sweep. */
export interface RunPassOptions {
	/** Current time as ISO-8601, injected for deterministic tests. */
	now: string;
	onOpenIssue?: (observed: ObservedOpenIssue) => void;
}

/**
 * Queue every lane one observed item qualifies for, returning how many jobs were
 * created.
 *
 * The three lanes are DELIBERATELY separate branches rather than one compound
 * predicate: each has its own opt-in, its own candidate rule, and — for the
 * implement lane — its own consequence (it produces CODE), so the conditions
 * under which each fires should be readable in one place.
 */
async function enqueueLanesForItem(args: {
	db: WatcherDb;
	client: ForgeClient;
	repo: WatcherConfig["repositories"][number];
	repositoryId: number;
	itemId: number;
	item: NormalizedItem;
	jobType: string | null;
	implementLabel: string | undefined;
	triageEnabled: boolean;
	baseShaCache: BaseShaCache;
}): Promise<number> {
	const { db, client, repo, repositoryId, itemId, item } = args;
	let created = 0;

	// Only open pull requests with a head SHA are validation candidates. A null
	// `jobType` (opted out, or Actions-reviewed) queues no review job; otherwise
	// it is `pr-review` or `infra-static` (see jobTypeForChecks).
	if (args.jobType !== null && item.kind === "pull" && item.state === "open" && item.headSha) {
		if (
			await createPendingJob(db, {
				repositoryId,
				itemId,
				sha: item.headSha,
				jobType: args.jobType,
			})
		) {
			created++;
		}
	}

	// The implement lane: an OPEN ISSUE carrying the repository's
	// configured opt-in label. Separate from the branch above rather than
	// folded into it — this lane produces CODE, and the conditions under
	// which that happens should be readable in one place instead of inferred
	// from a compound predicate shared with the review lane.
	if (args.implementLabel !== undefined && isImplementCandidate(item, args.implementLabel)) {
		const cache = args.baseShaCache;
		if (await enqueueImplementJob({ db, client, repo, repositoryId, itemId, item, cache })) {
			created++;
		}
	}

	// The issue-triage lane (lane C of #108): in an opted-in repository,
	// EVERY open issue without a triage job gets one — no label prerequisite,
	// because labelling is what triage does. An issue has no SHA of its own, so
	// the job's `sha` is "" and the existing dedup key
	// `(repository, item, sha, job_type)` bounds this to exactly one triage job
	// per issue. This is a REPORT lane whose result carries proposed labels the
	// factory filters at the publication boundary; it queues no code work and
	// needs no base resolution, so it stays out of the implement branch above.
	if (args.triageEnabled && isTriageCandidate(item)) {
		if (
			await createPendingJob(db, {
				repositoryId,
				itemId,
				sha: "",
				jobType: TRIAGE_TEMPLATE_ID,
			})
		) {
			created++;
		}
	}

	return created;
}

/**
 * Read this repository's changed items from its cursor, queue every lane each
 * item qualifies for, and advance the cursor.
 *
 * The cursor advances ONLY after the whole repository succeeded: a throw part-way
 * leaves it where it was, so the next pass re-reads the same window rather than
 * skipping past items nobody processed. Mutates `result` in place so a partial
 * sweep still reports what it did before failing.
 */
async function sweepRepoItems(args: {
	db: WatcherDb;
	client: ForgeClient;
	repo: WatcherConfig["repositories"][number];
	now: string;
	result: RepoPassResult;
	onOpenIssue?: RunPassOptions["onOpenIssue"];
}): Promise<void> {
	const { db, client, repo, now, result } = args;
	// The durable repository row is PROVIDER-QUALIFIED, so a GitHub and a Forgejo
	// `owner/repo` never collide on the bare full_name key.
	const repositoryId = await upsertRepository(db, repo.name, repo.checks, repo.provider);
	const cursor = await getCursor(db, repositoryId, CURSOR_RESOURCE);
	const read = await readChangedItems(client, repo.name, cursor, now);

	const jobType = jobTypeForChecks(repo);
	// Absent unless the operator opted this repository in. When absent the
	// implement branch is never entered, so no base lookup ever happens and a
	// repository that has not asked for the lane pays nothing for it.
	// A repository set to `implement_runtime: actions` is implemented by the
	// Actions lane the webhook receiver dispatches (src/hooks/implement.ts
	// reads the same flag), so a box job would run the lane twice.
	const implementLabel = repo.implement_runtime === "actions" ? undefined : repo.implement_label;
	// Whether the issue-triage lane is opted in for this repository. When
	// off (the default) the triage branch is never entered, so a repo that has not
	// asked for the lane queues no triage work and pays nothing for it.
	// A repository set to `triage_runtime: actions` is triaged by the Actions
	// lane the webhook receiver dispatches (src/hooks/issue-triage.ts
	// reads the same flag), so a box job would triage it twice.
	const triageEnabled = repo.triage === true && repo.triage_runtime !== "actions";
	const baseShaCache = new BaseShaCache();
	for (const item of read.items) {
		const itemId = await upsertGithubItem(db, {
			repositoryId,
			kind: item.kind,
			number: item.number,
			headSha: item.headSha,
			state: item.state,
			title: item.title,
			githubUpdatedAt: item.updatedAt,
		});
		result.itemsSeen++;
		if (item.kind === "issue" && item.state === "open") {
			args.onOpenIssue?.({ repo, repositoryId, itemId, item });
		}
		result.jobsCreated += await enqueueLanesForItem({
			db,
			client,
			repo,
			repositoryId,
			itemId,
			item,
			jobType,
			implementLabel,
			triageEnabled,
			baseShaCache,
		});
	}

	// Advance the cursor only after the whole repo succeeded.
	await setCursor(db, repositoryId, CURSOR_RESOURCE, read.nextCursor);
	result.ok = true;
}

/** Reconcile a single repository. Throws only to signal this repo failed. */
async function reconcileRepo(args: {
	db: WatcherDb;
	registry: ForgeRegistry;
	repo: WatcherConfig["repositories"][number];
	now: string;
	options: RunPassOptions;
}): Promise<RepoPassResult> {
	const { db, registry, repo, now, options } = args;
	const result: RepoPassResult = {
		repository: repo.name,
		ok: false,
		itemsSeen: 0,
		jobsCreated: 0,
	};
	try {
		// Resolve the client for THIS repository's forge. A missing forge credential
		// is isolated to that forge's repos: it fails this repo (surfaced as a bounded
		// error) without aborting the others in the mixed pass.
		const resolved = await registry.clientFor(repo.provider);
		if (!resolved.ok) {
			result.error = resolved.error;
			return result;
		}
		await sweepRepoItems({
			db,
			client: resolved.client,
			repo,
			now,
			result,
			onOpenIssue: options.onOpenIssue,
		});
	} catch (err) {
		result.error = err instanceof Error ? err.message : "unknown error";
	}
	return result;
}

/**
 * Run one reconciliation pass over all configured repositories.
 *
 * @param db - watcher database
 * @param registry - per-provider forge client registry (mixed GitHub/Forgejo)
 * @param config - loaded watcher configuration
 * @param options - injected pass options, including the deterministic `now`
 */
export const runPass = traced(
	"reconcile.runPass",
	async function runPass(
		db: WatcherDb,
		registry: ForgeRegistry,
		config: WatcherConfig,
		options: RunPassOptions,
	): Promise<PassResult> {
		const now = options.now;
		const start = Date.parse(now);
		const repositories: RepoPassResult[] = [];

		for (const repo of config.repositories) {
			repositories.push(await reconcileRepo({ db, registry, repo, now, options }));
		}

		const okCount = repositories.filter((r) => r.ok).length;
		return {
			startedAt: now,
			durationMs: Math.max(0, Date.now() - start),
			repositories,
			okCount,
			failCount: repositories.length - okCount,
		};
	},
);
