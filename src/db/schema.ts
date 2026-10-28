/**
 * @module db/schema
 * @description Durable state model for one software-factory process. This file
 *   is the single source of truth for structure. Production changes ship as
 *   generated migrations; `db:push` remains local-development-only (see
 *   _DOCS/db-protocol.md). No credentials or host-specific values live here.
 *
 * @outputs
 *   - `repositories` -- configured repositories the watcher reconciles
 *   - `reconciliationCursors` -- incremental read cursors per repo/resource
 *   - `githubItems` -- normalized issues and pull requests observed in a sweep
 *   - `jobs` -- units of runner work, idempotent per (repo, item, sha, type)
 *   - `jobAttempts` -- per-dispatch attempt records with runner identity
 *   - `attemptEventStreams` -- the durable copy of each attempt's raw event stream
 *   - `forgeDeliveries` -- inbound forge webhook delivery replay key (dedupe)
 *   - `forgeRuns` -- dispatched Forgejo Actions runs and their state
 *   - `busResults` -- runner artifacts drained off the NATS `FACTORY_JOBS` stream
 *   - `resultPostings` -- bounded inbound runner result-artifact ingest state
 *   - `githubPostings` -- durable outbound GitHub label/comment/check plans
 *   - `shadowPublications` -- shadow-mode ledger of writes that were NOT sent
 *   - `runnerBoxes` -- every placeable runner box; the authority for runner addressing
 *   - `buildBumpMarkers` -- movable tags an environment promotes by; rebuilt each pass
 *   - `schemaMigrations` -- runner-owned applied-migration ledger
 *   - Row / NewRow types for each table
 *
 * @dependencies
 *   - drizzle-orm/pg-core -- Drizzle column, index, and table types
 */
import { relations, sql } from "drizzle-orm";
import {
	bigint,
	boolean,
	foreignKey,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	unique,
	uniqueIndex,
} from "drizzle-orm/pg-core";

// ---------- repositories ----------
/**
 * Configured repositories the watcher reconciles. One row per managed repo.
 * `checks` mirrors config/repos.yml (`standard` or `static-only`).
 *
 * `provider` is the durable forge identity (`github` or `forgejo`). The column
 * defaults to `github` so every pre-dual-forge row is unambiguously GitHub; a
 * config entry must name its provider explicitly, so no new row relies
 * on that default. Uniqueness is PROVIDER-QUALIFIED
 * (`provider, full_name`): the SAME `owner/repo` can exist once per forge, so a
 * GitHub `owner/repo` and a Forgejo `owner/repo` are distinct managed
 * repositories that never collide on the old bare `full_name` key.
 */
export const repositories = pgTable(
	"repositories",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		provider: text("provider").notNull().default("github"),
		fullName: text("full_name").notNull(),
		checks: text("checks").notNull().default("standard"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [uniqueIndex("repositories_provider_full_name_key").on(t.provider, t.fullName)],
);

export type RepositoryRow = typeof repositories.$inferSelect;
export type NewRepositoryRow = typeof repositories.$inferInsert;

// ---------- reconciliation_cursors ----------
/**
 * Incremental reconciliation cursors per repository and resource kind
 * (e.g. `issues`, `pulls`). Lets a sweep read only changed items.
 */
export const reconciliationCursors = pgTable(
	"reconciliation_cursors",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		repositoryId: integer("repository_id")
			.notNull()
			.references(() => repositories.id, { onDelete: "cascade" }),
		resource: text("resource").notNull(),
		cursor: text("cursor"),
		lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [uniqueIndex("reconciliation_cursors_repo_resource_key").on(t.repositoryId, t.resource)],
);

export type ReconciliationCursorRow = typeof reconciliationCursors.$inferSelect;
export type NewReconciliationCursorRow = typeof reconciliationCursors.$inferInsert;

// ---------- github_items ----------
/**
 * Normalized GitHub items observed during a sweep (issues and pull requests).
 * `headSha` is the commit a job targets when the item is a pull request.
 */
export const githubItems = pgTable(
	"github_items",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		repositoryId: integer("repository_id")
			.notNull()
			.references(() => repositories.id, { onDelete: "cascade" }),
		kind: text("kind").notNull(),
		number: integer("number").notNull(),
		headSha: text("head_sha"),
		state: text("state").notNull(),
		title: text("title"),
		githubUpdatedAt: timestamp("github_updated_at", { withTimezone: true }),
		observedAt: timestamp("observed_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("github_items_repo_kind_number_key").on(t.repositoryId, t.kind, t.number),
		index("github_items_repo_state_idx").on(t.repositoryId, t.state),
	],
);

export type GithubItemRow = typeof githubItems.$inferSelect;
export type NewGithubItemRow = typeof githubItems.$inferInsert;

// ---------- jobs ----------
/**
 * Units of work the watcher intends to dispatch to a runner box.
 *
 * The uniqueness key (repository, item, SHA, job type) is the idempotency
 * guarantee the dispatch, ingest, and pre-push flows depend on: a given check
 * for a given commit is created at most once. Items without a SHA (e.g. issue
 * triage) collapse to a single job per (repo, item, type) via the empty-string
 * default rather than NULL, so the unique constraint actually bites.
 */
export const jobs = pgTable(
	"jobs",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		repositoryId: integer("repository_id")
			.notNull()
			.references(() => repositories.id, { onDelete: "cascade" }),
		itemId: integer("item_id").references(() => githubItems.id, { onDelete: "set null" }),
		sha: text("sha").notNull().default(""),
		jobType: text("job_type").notNull(),
		status: text("status").notNull().default("pending"),
		/**
		 * Why this row was deliberately terminalized without a runner attempt.
		 * NULL preserves every existing job's requeue behavior; a value marks a
		 * watcher-owned terminal decision that infra-failure recovery must not revive.
		 */
		terminalReason: text("terminal_reason"),
		/**
		 * The `job_attempts` row that currently OWNS this job. Set when an
		 * attempt claims the job at dispatch, and CLEARED whenever the job returns to
		 * `pending` (a release, a capacity refusal, or the reclaimer re-pending a
		 * stranded row). Status is not a sufficient guard when two attempts of one job
		 * can be in flight — the reclaimer re-pends a stalled attempt's job and a
		 * newer attempt can then own it, so a late write from the stale attempt would
		 * satisfy a status guard perfectly while acting on a job it no longer owns.
		 * Every ownership-scoped transition (release/complete/fail) adds this column to
		 * its WHERE clause, so a write from a superseded attempt matches zero rows.
		 * A plain integer, deliberately NOT a foreign key: losing the marker fails
		 * safe (an ownerless job is reclaimable), so a constraint adds no safety.
		 */
		activeAttemptId: integer("active_attempt_id"),
		/**
		 * The k-board task this job was claimed FROM, when the job
		 * originated at the ready station rather than from a forge label. NULL for
		 * every label-triggered job, and that null IS the discriminator: the ruled
		 * board transitions (`review` on a proposal, `blocked` on a terminal failure)
		 * fire only for a job that carries a task id, so the pre-existing label path
		 * is byte-for-byte unchanged and the two triggers coexist until the owner retires
		 * the label.
		 *
		 * Deliberately a plain text column, NOT a foreign key: the authority for a
		 * task's existence is the k-board HTTP API, never this database, and a
		 * constraint here would assert a relationship this service is forbidden to
		 * verify by table read. Losing the marker fails SAFE — the job dispatches and
		 * completes exactly as a label-triggered job would, and the board simply does
		 * not learn about it.
		 */
		kboardTaskId: text("kboard_task_id"),
		/**
		 * The repository a proposed change must be rooted on, when it differs from
		 * this job's own dispatch repository. NULL for every job whose
		 * change targets the repository it was dispatched against — which is every
		 * job that existed before the deterministic k3s verbs.
		 *
		 * A verb job (`newapp`, `newroute`, `newdb`, …) is dispatched against a
		 * MANAGED repository's issue but renders a change for `rtech/k3s-deploy`.
		 * `change-verifier` proves a returned bundle descends from what the watcher
		 * dispatched, so it needs the k3s-deploy identity — not this job's own.
		 */
		changeBaseRepository: text("change_base_repository"),
		/**
		 * The exact commit a proposed change must descend from, when it differs
		 * from `sha`. NULL leaves the pre-existing behaviour untouched.
		 *
		 * DELIBERATELY NOT `sha`. `createPendingJob` dedups on
		 * (repository_id, item_id, sha, job_type), and `sha` holds the verb job's
		 * rails-manifest digest — the thing that decides whether this is the same
		 * work. Writing the k3s-deploy head there would break dedup in both
		 * directions: a manifest edit at an unchanged head would stop creating a
		 * job, and a head advance would duplicate a job for an unchanged manifest.
		 * The two identities are genuinely different questions, so they get two
		 * columns. (_DOCS/decisions-ledger.md L-013.)
		 */
		changeBaseSha: text("change_base_sha"),
		/** Earliest time a pending job may be dispatched again (capacity backoff). */
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("jobs_repo_item_sha_type_key").on(t.repositoryId, t.itemId, t.sha, t.jobType),
		index("jobs_status_idx").on(t.status),
		// The k-board pass's idempotency guard reads "is there already a LIVE job for
		// this task id?" on every ready task, every cycle, and the transition seams
		// read "does this job carry a task id?" — both are WHERE clauses on a growing
		// table, so the index ships in the same change (_DOCS/db-protocol.md,
		// index-first). Partial on NOT NULL: only board-claimed jobs are ever looked
		// up this way, and every label-triggered row would otherwise be dead weight
		// in the index.
		index("jobs_kboard_task_id_idx").on(t.kboardTaskId).where(sql`${t.kboardTaskId} IS NOT NULL`),
	],
);

export type JobRow = typeof jobs.$inferSelect;
export type NewJobRow = typeof jobs.$inferInsert;

// ---------- audit_schedule_slots ----------
/**
 * Idempotency ledger for watcher-driven audit schedules. One row per
 * (repository, audit_name, slot_key), where `slot_key` is the discrete time slot
 * `floor(now / interval_minutes)` the schedule evaluator computed. The row is
 * inserted with `onConflictDoNothing` BEFORE the audit's pending job is created;
 * only the pass that wins the fresh insert then creates the itemless job and
 * records its id here. This makes a given audit slot dispatch at most once no
 * matter how many passes race, WITHOUT relying on the jobs uniqueness key (which
 * collapses itemless/shaless audit jobs of the same type onto one row and so
 * could not distinguish successive slots).
 *
 * Every UNIQUE column is NOT NULL, so the constraint actually bites — it never
 * hits the nullable-column trap the `jobs` table works around with an
 * empty-string SHA default. `job_id` is nullable only as an audit trail: the
 * winning pass sets it, but a slot row is authoritative for "this slot was
 * claimed" the instant it exists, before the job id is written.
 */
export const auditScheduleSlots = pgTable(
	"audit_schedule_slots",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		repositoryId: integer("repository_id")
			.notNull()
			.references(() => repositories.id, { onDelete: "cascade" }),
		auditName: text("audit_name").notNull(),
		slotKey: text("slot_key").notNull(),
		/** The itemless job the winning pass created for this slot; audit trail only. */
		jobId: integer("job_id").references(() => jobs.id, { onDelete: "set null" }),
		/**
		 * Slot boundaries that had passed unclaimed when THIS fresh slot was claimed
		 * (the process was down across them). Recorded on the winning insert from the
		 * evaluator's pre-claim count so status can surface a missed audit independent
		 * of the just-claimed current slot key (HIGH-2). Bounded, never
		 * back-filled into a burst of jobs; 0 for a normal consecutive slot.
		 */
		missedCount: integer("missed_count").notNull().default(0),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("audit_schedule_slots_repo_audit_slot_key").on(
			t.repositoryId,
			t.auditName,
			t.slotKey,
		),
		index("audit_schedule_slots_repo_audit_idx").on(t.repositoryId, t.auditName),
	],
);

export type AuditScheduleSlotRow = typeof auditScheduleSlots.$inferSelect;
export type NewAuditScheduleSlotRow = typeof auditScheduleSlots.$inferInsert;

// ---------- job_attempts ----------
/**
 * One record per dispatch attempt for a job. Captures the runner identity and
 * a bounded, redacted failure summary without losing the underlying pending
 * job. A partial unique index keeps runner job IDs unique when present.
 */
export const jobAttempts = pgTable(
	"job_attempts",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		jobId: integer("job_id")
			.notNull()
			.references(() => jobs.id, { onDelete: "cascade" }),
		runnerJobId: text("runner_job_id"),
		runnerVmid: integer("runner_vmid"),
		status: text("status").notNull().default("submitted"),
		failureSummary: text("failure_summary"),
		/**
		 * The PROVIDER-ATTESTED model this attempt actually ran on, read
		 * from the agent event stream's `message_end.message.model` — the value the
		 * runtime recorded off the provider's own response envelope.
		 *
		 * NEVER an agent-authored field. In the #110 pilot the agent wrote
		 * `"observed_model": "ChatGPT"` into its own result document while the
		 * server attested `gpt-5.6-sol`; a model's claim about itself is runner
		 * output like any other and is not attestation.
		 *
		 * Nullable: every pre-#170 row predates the column, and a lane that writes
		 * no event stream (or one that is oversized/unparseable) simply has no
		 * attestation to record. Observational only — nothing reads this to make a
		 * dispatch, verification, or publication decision.
		 */
		observedModel: text("observed_model"),
		/**
		 * The Langfuse trace id this attempt's run was emitted under, so a
		 * db row reaches the trace in ONE query rather than by re-deriving an id
		 * format from source. Written by the ingest observer in the same UPDATE
		 * that stamps `observed_model`, from `traceIdFor` — the emitter's OWN
		 * function, never a re-spelling of its format (the #211 lesson: a second
		 * copy of a format is a second thing to drift).
		 *
		 * HOST-QUALIFIED (`attempt-N-<host>`), because results are per (job, host)
		 * and so are traces (the #86 shape). One attempt observed from two
		 * hosts emits two DISTINCT traces; this column records the FIRST one
		 * observed, on the same first-writer-wins guard `observed_model` uses.
		 *
		 * IDS ONLY — never a URL. The Langfuse host is LAN/tailnet-internal, so the
		 * base URL is environment, resolved at render time by whichever surface is
		 * allowed to know it (the status page). A stored URL would put an internal
		 * hostname into a column that outward-facing code paths read.
		 *
		 * Nullable: every pre-#184 row predates the column, and an attempt whose
		 * lane wrote no parseable event stream is never observed at all. Observational
		 * only — nothing reads this to make a dispatch, verification, or publication
		 * decision.
		 */
		traceId: text("trace_id"),
		/**
		 * The log level in force for this attempt: the first attempt runs
		 * at `info`, a respawn at `debug` (dispatch-time escalation, D15). Written
		 * by the dispatch path, where the attempt count is known.
		 *
		 * NOT NULL DEFAULT 'info': every pre-#708 attempt ran under the
		 * process-global level, which was info, so info is the honest backfill.
		 */
		level: text("level").notNull().default("info"),
		startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
		finishedAt: timestamp("finished_at", { withTimezone: true }),
	},
	(t) => [
		uniqueIndex("job_attempts_runner_job_id_key")
			.on(t.runnerJobId)
			.where(sql`${t.runnerJobId} IS NOT NULL`),
		index("job_attempts_job_idx").on(t.jobId),
	],
);

export type JobAttemptRow = typeof jobAttempts.$inferSelect;
export type NewJobAttemptRow = typeof jobAttempts.$inferInsert;

// ---------- attempt_event_streams ----------
/**
 * The DURABLE home of one attempt's raw agent event stream (`events.jsonl`,
 * sf#183). One row per attempt, holding the exact bytes ingest read off the
 * share.
 *
 * WHY POSTGRES AND NOT A FILE PATH. The ticket asked for a "durable
 * watcher-owned artifact path", and there is no such path: the collab share's
 * per-job directories carry NO retention guarantee (rtech-infra, 2026-08-17), so
 * a watcher-owned copy on the same share is the same no-guarantee class plus a
 * second unmanaged store to reconcile. The database is the one store this
 * process already backs up and already treats as durable state. The files remain
 * the raw record on the share while they live; this row is the copy that
 * outlives them. Losing Langfuse loses nothing (ratified #170 posture); losing
 * the share now loses nothing either.
 *
 * FIRST-WRITER-WINS, and the primary key IS the mechanism. Results are per
 * (job, host), so one attempt can be observed from several hosts and a
 * re-ingest after a restart re-reads the same DONE. `attempt_id` as PRIMARY KEY
 * plus `onConflictDoNothing` makes the FIRST stream read the durable record;
 * a later read never overwrites it, and there is no last-writer nondeterminism
 * to reason about. Do NOT weaken this to a plain index: PostgreSQL does not
 * deduplicate NULLs in a unique index, and a nullable unique column would admit
 * unbounded duplicate rows.
 *
 * `ON DELETE NO ACTION`, deliberately, NOT `cascade`. The point of the row is to
 * survive; a cascade would hand the raw record the exact lifetime the share
 * already fails to guarantee. Attempt rows are deleted in exactly one place in
 * this codebase — `retireAllocationIntent` (`src/runner/attempt-record.ts`),
 * scoped to an `allocating` intent row whose verb refused before any runner ran
 * — and such an attempt has no result, no ingest, and therefore never a stream
 * row, so the restriction cannot block that delete in practice. If a future
 * caller does need to delete an attempt that HAS a stream, that is a decision to
 * make explicitly, which is what `no action` forces.
 *
 * OBSERVATIONAL ONLY. Nothing reads this to make a dispatch, verification, or
 * publication decision. The content is UNTRUSTED runner output stored verbatim —
 * deliberately NOT redacted, because this is the raw record and redacting it
 * would make it a lossy mirror of a file that no longer exists. Any surface that
 * renders it owes its own bounding and redaction.
 */
export const attemptEventStreams = pgTable("attempt_event_streams", {
	/**
	 * The attempt whose stream this is. PK, so one row per attempt and the
	 * first-writer-wins guard is a constraint rather than a convention.
	 */
	attemptId: integer("attempt_id")
		.primaryKey()
		.references(() => jobAttempts.id, { onDelete: "no action" }),
	/** The exact bytes read off the share, unmodified. */
	content: text("content").notNull(),
	/** UTF-8 byte length of `content` as measured at the write boundary. */
	byteLength: integer("byte_length").notNull(),
	createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AttemptEventStreamRow = typeof attemptEventStreams.$inferSelect;
export type NewAttemptEventStreamRow = typeof attemptEventStreams.$inferInsert;

// ---------- result_postings ----------
/**
 * State of bounded inbound runner result-artifact ingestion. Records the runner
 * target and accepted/invalid outcome so restart reconciliation is idempotent.
 * Outbound GitHub labels, comments, and checks live in `github_postings`.
 * The target includes the runner job id as well as the reusable hostname, so a
 * stale result from a superseded attempt cannot overwrite a newer attempt's
 * artifact row while re-ingest of the same attempt remains idempotent.
 */
export const resultPostings = pgTable(
	"result_postings",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		jobId: integer("job_id")
			.notNull()
			.references(() => jobs.id, { onDelete: "cascade" }),
		target: text("target").notNull(),
		status: text("status").notNull().default("pending"),
		externalRef: text("external_ref"),
		outputPath: text("output_path"),
		/**
		 * The bounded per-check trail from the VERIFIED result, as JSON.
		 *
		 * Persisted at ingest so the proposal pass can display what the gate
		 * actually judged. It must NOT be re-read from the share at proposal time:
		 * the runner owns the write side of its own output directory, so a re-read
		 * could return a different trail than the one gate 0 reconciled, and the
		 * body would then advertise checks nobody verified.
		 *
		 * Nullable: every pre-#157 row predates the column, and every report-only
		 * lane's posting simply has no proposal to carry a trail into.
		 */
		checkTrail: text("check_trail"),
		postedAt: timestamp("posted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("result_postings_job_target_key").on(t.jobId, t.target),
		index("result_postings_job_idx").on(t.jobId),
	],
);

export type ResultPostingRow = typeof resultPostings.$inferSelect;
export type NewResultPostingRow = typeof resultPostings.$inferInsert;

// ---------- github_postings ----------
/**
 * Durable outbound GitHub publication plans (labels, one deduplicated comment,
 * one exact-SHA external check). Distinct from `result_postings`, which records
 * the *inbound* ingest of a runner artifact; this table owns the *outbound*
 * GitHub write intent and its retry lifecycle.
 *
 * A plan row is persisted before any network write so a restart can retry from
 * durable, already-bounded state without re-reading raw runner output. The join
 * to `jobs`/`github_items`/`repositories` is authoritative for repository, item
 * number, and SHA — the plan never trusts a runner-chosen target.
 *
 * The idempotency key is (job, kind, target): at most one plan per job per
 * publication kind (`label` / `comment` / `check`) and target (the label name
 * for labels, a fixed marker for the single comment/check). Re-deriving a plan
 * for the same result converges onto the existing row rather than duplicating.
 *
 * `status` moves `pending` -> `posted` (or `failed` after the retry budget is
 * spent). The reconciler processes each row inside a transaction that takes a
 * `FOR UPDATE` row lock held across the single remote write and the terminal
 * update, so two concurrent reconcilers can never publish the same row — the
 * loser blocks on the lock, then observes the terminal/not-due state and skips.
 * A crash before commit rolls the row back to `pending`; `dedupeKey` is a
 * deterministic GitHub-side marker so the crash-recovery re-post does not create
 * a visible duplicate: the reconciler recognizes its own prior write and records
 * it.
 */
export const githubPostings = pgTable(
	"github_postings",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		jobId: integer("job_id")
			.notNull()
			.references(() => jobs.id, { onDelete: "cascade" }),
		/** Publication kind: `label`, `comment`, or `check`. */
		kind: text("kind").notNull(),
		/** The publication action within the kind (e.g. `add`/`remove`, `upsert`). */
		action: text("action").notNull(),
		/**
		 * Idempotency target within (job, kind): the label name for labels, a fixed
		 * marker (`comment`/`check`) for the single comment/check. Combined with
		 * `job_id` and `kind` it is the unique publication identity.
		 */
		target: text("target").notNull(),
		status: text("status").notNull().default("pending"),
		/**
		 * Bounded, already-redacted plan payload (JSON) the reconciler posts as-is.
		 * Never raw runner output; produced by the fixed publication registry.
		 */
		payload: text("payload").notNull(),
		/**
		 * Deterministic GitHub-side dedupe marker (embedded in comment bodies /
		 * check external ids) so a re-post after a crash recognizes its own write.
		 */
		dedupeKey: text("dedupe_key").notNull(),
		/** External reference returned by GitHub (comment id, check-run id). */
		externalRef: text("external_ref"),
		/** Attempts already spent; bounded by the reconciler's retry budget. */
		attempts: integer("attempts").notNull().default(0),
		/** Earliest time a retryable plan may be attempted again. */
		nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
		/** Bounded, redacted failure summary from the last failed attempt. */
		lastError: text("last_error"),
		postedAt: timestamp("posted_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("github_postings_job_kind_target_key").on(t.jobId, t.kind, t.target),
		index("github_postings_status_idx").on(t.status),
	],
);

export type GithubPostingRow = typeof githubPostings.$inferSelect;
export type NewGithubPostingRow = typeof githubPostings.$inferInsert;

// ---------- shadow_publications ----------
/**
 * Shadow-mode ledger. When the publisher runs in shadow mode it records what it
 * WOULD have posted here — the intended GitHub write — instead of calling the
 * GitHub write APIs, so a bounded shadow period can be compared against the
 * repository's own Actions result without mutating GitHub. Dedupe reads still run
 * against real GitHub, so a shadow row carries the observed dedupe decision
 * (`created` vs `deduped`) exactly as the real path would have taken it.
 *
 * The row is a faithful, bounded snapshot of one plan's intended effect: the
 * publication kind, the resolved target, and the salient decodable fields (label
 * name, check conclusion, dedupe marker). It never carries raw runner output; the
 * payload it snapshots is the already-bounded, already-redacted stored plan.
 *
 * The idempotency key is (posting, would_action): re-running the shadow pass for
 * an already-recorded posting/action converges onto the existing row rather than
 * appending a duplicate ledger entry.
 */
export const shadowPublications = pgTable(
	"shadow_publications",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		/** The github_postings row this shadow entry stands in for. */
		postingId: integer("posting_id")
			.notNull()
			.references(() => githubPostings.id, { onDelete: "cascade" }),
		/** The job the posting belongs to, denormalized for compare-report joins. */
		jobId: integer("job_id")
			.notNull()
			.references(() => jobs.id, { onDelete: "cascade" }),
		/** Publication kind: `label`, `comment`, or `check`. */
		kind: text("kind").notNull(),
		/**
		 * The publication action within the kind. For labels this is the load-bearing
		 * `add`/`remove` distinction the ledger would otherwise lose (both would
		 * `create` a ledger row), so the compare report can name the single ADDED
		 * label rather than the last-processed removal. Checks/comments record their
		 * natural upsert action. Nullable for rows written before this column existed.
		 */
		action: text("action"),
		/** The resolved authoritative target (`owner/repo`). */
		repository: text("repository").notNull(),
		/** The trusted item number, when the plan targets an item. */
		itemNumber: integer("item_number"),
		/** The trusted SHA, when the plan targets a commit (checks). */
		sha: text("sha"),
		/**
		 * What the real path WOULD have done at the write boundary: `created` when the
		 * dedupe scan proved absence (a POST would run), `deduped` when it found the
		 * job's own prior marker (a PATCH would run).
		 */
		wouldAction: text("would_action").notNull(),
		/** The label name (labels), or the fixed comment/check marker. */
		target: text("target").notNull(),
		/** The deterministic GitHub-side dedupe marker the write would carry. */
		dedupeKey: text("dedupe_key").notNull(),
		/** The check-run conclusion (checks only). */
		conclusion: text("conclusion"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		unique("shadow_publications_posting_action_key").on(t.postingId, t.wouldAction),
		// Composite (job_id, id) serves the scoped ordered read the compare report
		// runs (`WHERE job_id IN (...) ORDER BY id`): the leading job_id satisfies
		// the filter and the trailing id satisfies the order without a sort.
		index("shadow_publications_job_id_id_idx").on(t.jobId, t.id),
	],
);

export type ShadowPublicationRow = typeof shadowPublications.$inferSelect;
export type NewShadowPublicationRow = typeof shadowPublications.$inferInsert;

// ---------- schema_migrations ----------
/**
 * Applied-migration ledger for the versioned (post-cutover) migration runner.
 * The runner creates this table before reading migrations, so generated
 * baseline SQL must omit only this table's executable DDL while retaining it in
 * Drizzle metadata. See _DOCS/db-protocol.md.
 */
export const schemaMigrations = pgTable("schema_migrations", {
	version: text("version").primaryKey(),
	checksum: text("checksum").notNull(),
	appliedAt: timestamp("applied_at", { withTimezone: true }).notNull().defaultNow(),
});

export type SchemaMigrationRow = typeof schemaMigrations.$inferSelect;

// ---------- runner_boxes ----------
/**
 * Every runner box the fleet can place, one row per VMID. THIS TABLE IS THE
 * AUTHORITY for runner addressing in this service.
 *
 * `mac` and `ip` are STATED, not derived. The fleet's addressing happens to
 * satisfy `NN = vmid % 100`, but that is how the numbers were CHOSEN, not how
 * they are used: no consumer recomputes an address, because `9001` and `9101`
 * both yield `NN=01` and every reimplementation of the band offset is a place to
 * get it subtly wrong. Read the row.
 *
 * A VMID absent from this table is UNKNOWN, which is a loud rejection — never
 * silently "not a box". Conflating those two answers is what strands a running
 * container that nothing can name.
 *
 * `heldByJobId` is deliberately a plain text column, NOT a foreign key to
 * `jobs`: a box can be held by a pre-push validation that has no job row, and a
 * claim must survive whatever happens to the job record. It records WHO holds the
 * box so a leak is a query rather than a manual `runner_list` expedition (
 * #79).
 *
 * A band tops out at 99 boxes by design. Needing more than that of one kind means
 * the workload has outgrown self-hosted Proxmox; it is NOT a reason to widen a
 * band into the next hundred-block, which would collide MAC and IP derivation.
 */
export const runnerBoxes = pgTable(
	"runner_boxes",
	{
		vmid: integer("vmid").primaryKey(),
		/** `pool` (ephemeral) | `forge` (persistent CI) | `template` | `service`. */
		band: text("band").notNull(),
		/** Stated literal, e.g. `BC:24:11:90:00:01`. Never computed. */
		mac: text("mac").notNull(),
		/** Stated literal, e.g. `10.0.21.1`. NULL for templates, which never serve one. */
		ip: text("ip"),
		/** False for templates and the service box: present so they are NAMED, not unknown. */
		allocatable: boolean("allocatable").notNull().default(false),
		/** Job/purpose currently holding this box; NULL when free. */
		heldByJobId: text("held_by_job_id"),
		heldAt: timestamp("held_at", { withTimezone: true }),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		// Two boxes on one address is a write failure, not a mystery outage.
		uniqueIndex("runner_boxes_ip_key").on(t.ip),
		uniqueIndex("runner_boxes_mac_key").on(t.mac),
		index("runner_boxes_band_allocatable_idx").on(t.band, t.allocatable),
	],
);

export type RunnerBoxRow = typeof runnerBoxes.$inferSelect;
export type NewRunnerBoxRow = typeof runnerBoxes.$inferInsert;

// ---------- relations ----------
export const repositoriesRelations = relations(repositories, ({ many }) => ({
	cursors: many(reconciliationCursors),
	items: many(githubItems),
	jobs: many(jobs),
}));

export const jobsRelations = relations(jobs, ({ one, many }) => ({
	repository: one(repositories, {
		fields: [jobs.repositoryId],
		references: [repositories.id],
	}),
	item: one(githubItems, { fields: [jobs.itemId], references: [githubItems.id] }),
	attempts: many(jobAttempts),
	postings: many(resultPostings),
	githubPostings: many(githubPostings),
}));

export const githubPostingsRelations = relations(githubPostings, ({ one }) => ({
	job: one(jobs, { fields: [githubPostings.jobId], references: [jobs.id] }),
}));

// ---------- forge_deliveries ----------
/**
 * Replay key for inbound Forgejo webhook deliveries.
 *
 * Forgejo retries a delivery it could not confirm, and a retry carries the SAME
 * `X-Forgejo-Delivery` id. Without a durable key the second copy is
 * indistinguishable from a second event, so the receiver would wake
 * reconciliation twice for one push. The unique index on
 * `(provider, delivery_id)` IS the dedupe mechanism: the receiver inserts with
 * `ON CONFLICT DO NOTHING RETURNING id`, and zero returned rows means "already
 * seen" — answered 200 and dropped, with no wake.
 *
 * `provider` is carried explicitly rather than assumed, because delivery ids are
 * only unique WITHIN a forge; a future second Forgejo-family source would
 * otherwise collide with this one on a bare `delivery_id` key.
 *
 * `payload` is the UNTRUSTED body exactly as received, stored for diagnosis and
 * replay. Nothing reads it to make a dispatch, verification, or publication
 * decision — the receiver's only decision is whether the payload's repository is
 * a managed one, and reconciliation re-reads the forge itself. Any surface that
 * renders this owes its own bounding and redaction.
 *
 * Additive: no existing table or column is touched.
 */
export const forgeDeliveries = pgTable(
	"forge_deliveries",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		/** Forge family the delivery came from; `forgejo` today. */
		provider: text("provider").notNull(),
		/** The forge's own delivery id — the replay key. */
		deliveryId: text("delivery_id").notNull(),
		/** Webhook event name as declared by the sending forge. */
		event: text("event").notNull(),
		/** `owner/repo` read out of the payload's `repository.full_name`. */
		repository: text("repository").notNull(),
		/** The raw webhook body, untrusted, stored verbatim. */
		payload: jsonb("payload").notNull(),
		receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [uniqueIndex("forge_deliveries_provider_delivery_id_key").on(t.provider, t.deliveryId)],
);

export type ForgeDeliveryRow = typeof forgeDeliveries.$inferSelect;
export type NewForgeDeliveryRow = typeof forgeDeliveries.$inferInsert;

// ---------- forge_runs ----------
/** The closed state set of a tracked Forgejo Actions run. */
export type ForgeRunState =
	| "dispatched"
	| "waiting"
	| "running"
	| "success"
	| "failure"
	| "cancelled"
	| "unknown";

/**
 * One Forgejo Actions run the watcher dispatched (lane 476a). Written by
 * `src/forge/actions-store.ts`: `recordDispatch` at dispatch time, then
 * `recordRunState` from the webhook receiver's `workflow_run` events.
 *
 * A dispatched row (476b, src/hooks/pr-review.ts) carries
 * `repo` = the workflow HOST repo, where the run lives, and the target repo in
 * `inputs.repo`; `run_id` is null and `state` is `dispatched` until 476c (the
 * `workflow_run` receiver) fills both.
 *
 * `run_id` is nullable because a dispatch may answer without run info; the
 * partial unique index on `(repo, run_id)` makes a re-record of a known run a
 * no-op while leaving id-less rows independent. `inputs` are the exact strings
 * dispatched, kept so a rerun can replay them.
 *
 * Additive: no existing table or column is touched.
 */
export const forgeRuns = pgTable(
	"forge_runs",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		/** `owner/repo` the workflow runs in. */
		repo: text("repo").notNull(),
		/** The workflow FILE name, e.g. `pr-review.yml`. */
		workflow: text("workflow").notNull(),
		/** The forge's run id; null until known. */
		runId: bigint("run_id", { mode: "number" }),
		/** The commit the run judges (trusted side: event payload or dispatch input). */
		targetSha: text("target_sha").notNull(),
		/** The dispatched `workflow_dispatch` inputs. */
		inputs: jsonb("inputs").notNull(),
		state: text("state").$type<ForgeRunState>().notNull().default("dispatched"),
		dispatchedAt: timestamp("dispatched_at", { withTimezone: true }).notNull().defaultNow(),
		updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("forge_runs_repo_run_id_key")
			.on(t.repo, t.runId)
			.where(sql`${t.runId} IS NOT NULL`),
	],
);

export type ForgeRunRow = typeof forgeRuns.$inferSelect;
export type NewForgeRunRow = typeof forgeRuns.$inferInsert;

// ---------- bus_results ----------
/**
 * Runner artifacts published on the NATS `FACTORY_JOBS` stream.
 *
 * A runner — the golden image, or an Actions step — publishes each artifact it
 * produced to `factory.jobs.<job_runner_id>.result` (bounded to 1 MiB), and the
 * watcher's consumer drains that stream into this table. The reconciler then
 * reads this table AHEAD of the collab share (`ShareResultReader`), so a job
 * whose artifacts arrived over the bus needs no share mount at all, while a job
 * whose runner still writes to the share reconciles exactly as before.
 *
 * Rows are per (job, host, artifact), never per job. Results are per (job,
 * host) — a key on `job_runner_id` alone would read one host's artifact for
 * another host's attempt (the shape PR #86 fixed) — and per ARTIFACT because a
 * single host writes several: the wrapper-owned `result.json`, a lane's own
 * named artifact, the wrapper verdict/envelope, and the optional event stream.
 *
 * The unique index on `(job_runner_id, hostname, artifact)` IS the re-publish
 * guard: a redelivered NATS message inserts `ON CONFLICT DO NOTHING`, so the
 * second copy of the same artifact is dropped rather than duplicating a host in
 * the reconciler's view. `msg_id` records the `Nats-Msg-Id` the message carried
 * and `subject` the subject it arrived on, for diagnosis only.
 *
 * `body` is the artifact's bytes as UTF-8 text, stored VERBATIM and UNTRUSTED.
 * Nothing here decides anything: the existing ingest pipeline — byte cap, strict
 * schema validation, named-artifact selection, `classifyMissing` — is unchanged
 * and remains the only thing that judges this content.
 *
 * Additive: no existing table or column is touched.
 */
export const busResults = pgTable(
	"bus_results",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		/** The runner job id the artifact belongs to (the subject's own token). */
		jobRunnerId: text("job_runner_id").notNull(),
		/** The runner host that produced it; results are per (job, host). */
		hostname: text("hostname").notNull(),
		/**
		 * The artifact filename the runner declared (`result.json`, or a named one),
		 * or the literal `DONE` for the completion marker.
		 *
		 * `DONE` is the bus equivalent of the share's `DONE` file: the runner
		 * publishes it as its LAST message for a (job, host), after every artifact,
		 * and its body may be empty. `BusResultReader.isDone` keys on that row and
		 * nothing else — an artifact row on its own attests nothing, because
		 * artifacts drain one message at a time in no guaranteed order.
		 */
		artifact: text("artifact").notNull(),
		/** The artifact bytes as UTF-8 text, verbatim and untrusted. */
		body: text("body").notNull(),
		/** The publishing message's `Nats-Msg-Id`; diagnosis only. */
		msgId: text("msg_id").notNull(),
		/** The NATS subject the message arrived on; diagnosis only. */
		subject: text("subject").notNull(),
		receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [
		uniqueIndex("bus_results_job_host_artifact_key").on(t.jobRunnerId, t.hostname, t.artifact),
	],
);

export type BusResultRow = typeof busResults.$inferSelect;
export type NewBusResultRow = typeof busResults.$inferInsert;

// ---------- build_bump_candidates ----------
/**
 * Tags on a build-bump-enrolled repository that intake has observed (
 * child of sf#533).
 *
 * A repository is enrolled by the PRESENCE of a `build_bump` block in its config
 * entry; intake re-reads that repository's tags FROM THE FORGE every
 * cycle and records each one matching the block's `tag_pattern` here. The forge
 * read is the trusted source: a webhook payload is never the input, so a spoofed
 * or replayed delivery cannot introduce a candidate the forge does not actually
 * carry.
 *
 * `sha` is the COMMIT sha the tag points at, NEVER the tag object's own id. For a
 * lightweight tag the two coincide; for an ANNOTATED tag they differ, and the tag
 * object's sha is not a commit anything downstream can build or check out. The
 * lister (`src/forgejo/tags.ts`) maps `commit.sha` for exactly this reason.
 *
 * The unique index on `(repository, tag, sha)` IS the dedupe mechanism: intake
 * re-reads the same newest-first page every cycle, so every insert is
 * `ON CONFLICT DO NOTHING` and a tag already recorded produces no second row. The
 * SHA is part of the key deliberately — a tag that is force-moved to a different
 * commit is a NEW candidate, not a silent no-op on the old row.
 *
 * `status` is the intake-side lifecycle marker; every row lands `pending` and
 * nothing in this issue advances it. The bump lane owns that transition.
 *
 * Additive: no existing table or column is touched.
 */
export const buildBumpCandidates = pgTable(
	"build_bump_candidates",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		/** `owner/repo` as it appears in the managed-repository config. */
		repository: text("repository").notNull(),
		/** The bare tag NAME as the forge reports it — never a ref path. */
		tag: text("tag").notNull(),
		/** The COMMIT sha the tag resolves to (`commit.sha`), never the tag object id. */
		sha: text("sha").notNull(),
		/**
		 * The image this row builds — the name under the registry owner.
		 * The legacy single-image enrolment is the repository's short name; an
		 * `images` enrolment records one row per declared image, so the four
		 * rtech-mcps images are four rows sharing repository, tag, and sha.
		 */
		image: text("image").notNull(),
		/** The Dockerfile inside the cloned context this row's Kaniko Job builds. */
		dockerfile: text("dockerfile").notNull().default("Dockerfile"),
		/**
		 * Lifecycle marker; always `pending` at insert. The vocabulary is
		 * `pending` -> `building` -> `built` | `failed`, and `failed` is TERMINAL:
		 * the build pass never retries or re-creates a failed candidate.
		 */
		status: text("status").notNull().default("pending"),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		/**
		 * The `metadata.name` the API server assigned the Kaniko Job, once one has
		 * been created or ADOPTED. NULL while `pending` — the Job's identity is not
		 * known before the create returns, and a lost create response is recovered
		 * by listing on the app+tag labels rather than by a name guessed here.
		 */
		buildJobName: text("build_job_name"),
		/** When the Job was created or adopted. Also the watch-timeout clock. */
		buildStartedAt: timestamp("build_started_at", { withTimezone: true }),
		/** When a terminal condition was observed. NULL until `built` or `failed`. */
		buildFinishedAt: timestamp("build_finished_at", { withTimezone: true }),
		/**
		 * Why a `failed` row failed: a batch/v1 condition reason
		 * (`BackoffLimitExceeded`, `DeadlineExceeded`), a bounded render refusal, or
		 * one of this pass's own fixed strings. Never response text.
		 */
		buildReason: text("build_reason"),
		/**
		 * The forge commit date of the tag (`commit.created`), which is the only
		 * honest recency order for candidates. NULL when the forge omits
		 * the field or sends something unparsable: NULL is "unknown", never "old",
		 * so every selection orders `tag_created_at DESC NULLS LAST, id DESC` — a
		 * later row is a later OBSERVATION of a tag, so it wins a tie.
		 *
		 * Row id is NOT a recency order and never was — it runs in opposite
		 * directions for a repository enrolled in one batch and one grown tag by
		 * tag (probed 2026-09-11).
		 */
		tagCreatedAt: timestamp("tag_created_at", { withTimezone: true }),
		/**
		 * How many times a marker environment has RE-QUEUED this candidate from
		 * `failed` back to `pending` (sf#719 §6, §8). Unbounded, and never a retry
		 * budget: the requeue is how a marker placed on a build that failed
		 * converges once the fault is removed, so it must not stop.
		 *
		 * It exists because that retry is otherwise INVISIBLE. A candidate whose
		 * build fails for a permanent reason is requeued every pass forever — one
		 * Kaniko Job per cycle — while no pair row is ever created, so the
		 * stuck-pair alert has nothing to match and `/status.json` reads exactly
		 * like an environment nobody put a marker on. This counter is the only
		 * evidence that loop is running: reaching 3 raises the alert (§8), and it
		 * is what the environment's status entry reports as `attempts`.
		 *
		 * NOT NULL DEFAULT 0 — unlike the readiness columns, zero is the honest
		 * value for every pre-existing row, because nothing had ever been counted
		 * under code that did not count. There is no "unknown" to preserve.
		 */
		requeues: integer("requeues").notNull().default(0),
	},
	(t) => [
		uniqueIndex("build_bump_candidates_repository_tag_sha_image_key").on(
			t.repository,
			t.tag,
			t.sha,
			t.image,
		),
		/**
		 * The selection order by status: newest commit date first, NULLS LAST as
		 * the readers order it, id as the tiebreak. 0021 created it NULLS FIRST
		 * (the DESC default); 0024 rebuilds it to this shape.
		 */
		index("build_bump_candidates_status_tag_created_idx").on(t.status, t.tagCreatedAt.desc(), t.id),
	],
);

export type BuildBumpCandidateRow = typeof buildBumpCandidates.$inferSelect;
export type NewBuildBumpCandidateRow = typeof buildBumpCandidates.$inferInsert;

// ---------- build_bump_bumps ----------
/**
 * One bump attempt per (candidate, app_dir) for the build-bump lane (
 * child of sf#533).
 *
 * A CHILD TABLE, not columns on `build_bump_candidates`, because the cardinality
 * is not one. An enrolled repository declares up to 10 `app_dirs`, the
 * bump script is invoked once per entry, and each invocation succeeds or refuses
 * on its own — `ALREADY_AT_TAG` for one app says nothing about the next. Folding
 * `pr`/`url`/`reason` onto the candidate row would keep only the last app's
 * answer and make terminality a property of the tag rather than of the pair the
 * script actually judged.
 *
 * `status` vocabulary: `pending` -> `opened` | `refused`. Those two are the ONLY
 * terminal states. A `refused` row carries the script's exit-1 leading token, and
 * the same inputs deterministically produce the same refusal, so retrying burns
 * the same work and hides the reason behind a churn loop. A HARNESS outcome is
 * the environment rather than the judgement, so it returns the row to `pending`
 * EVERY time and `attempts` is unbounded — a pair that stopped retrying would be
 * a deploy that silently never lands. `attempts` reaching 3 is the ALERT signal
 * (§8), never a terminal condition.
 *
 * `reason` holds a FIXED string only — a refusal token or one of the lane's own
 * harness strings. Script stdout/stderr text never reaches this column: it is
 * untrusted output that can quote the request, and the request's environment
 * carries the forge token.
 *
 * The unique index on `(candidate_id, app_dir)` is what makes terminality
 * enforceable: the bump pass re-reads Complete candidates every cycle, so the
 * insert is `ON CONFLICT DO NOTHING` and an already-judged pair produces no
 * second row and no second invocation.
 *
 * Additive: no existing table or column is touched.
 */
export const buildBumpBumps = pgTable(
	"build_bump_bumps",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		/** The observed tag this bump is for. */
		candidateId: integer("candidate_id").notNull(),
		/** One `manifests/apps/<name>` directory name, as configured. */
		appDir: text("app_dir").notNull(),
		/**
		 * Lifecycle marker; always `pending` at insert. The vocabulary is
		 * `pending` -> `opened` | `refused`, and those two are the only TERMINAL
		 * states for this (candidate, app) pair. A harness outcome returns the row
		 * to `pending` every time, so terminality is never reached by exhaustion.
		 */
		status: text("status").notNull().default("pending"),
		/** The opened PR's number on the deploy repository. NULL until `opened`. */
		pr: integer("pr"),
		/** The opened PR's URL. NULL until `opened`. */
		url: text("url"),
		/**
		 * Why a non-`opened` row ended where it did: a refusal token
		 * (`ALREADY_AT_TAG`, `REGISTRY_MISSING`, …) or one of the lane's own fixed
		 * harness strings. NEVER script output text.
		 */
		reason: text("reason"),
		/**
		 * Invocations spent on this pair. UNBOUNDED: a harness outcome returns the
		 * row to `pending` every time, so this count is the alert signal (3 attempts,
		 * §8), never a retry budget that exhausts into a terminal state.
		 */
		attempts: integer("attempts").notNull().default(0),
		/** When an invocation claim began. NULL outside the `invoking` state. */
		startedAt: timestamp("started_at", { withTimezone: true }),
		createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
		/** When the pair reached a terminal status. NULL while `pending`. */
		finishedAt: timestamp("finished_at", { withTimezone: true }),
		/**
		 * When this pair SETTLED terminally — set on every `opened`/`refused`
		 * record, left NULL by a harness outcome (which is not terminal).
		 *
		 * The ORDER of settlement is what makes a marker environment able to move
		 * backwards and then forwards again. The pair key is (candidate_id,
		 * app_dir) for all time, so a marker that moves prod v2 -> v1 -> v2 finds
		 * v2's row already terminal and would strand prod on v1 forever. Comparing
		 * this timestamp against the other rows for the same `app_dir` is how the
		 * pass knows v2's record was SUPERSEDED by a later bump and may be
		 * re-driven. NULL is "settled before this column existed", which sorts
		 * older than any set value — correct, because it predates every reopen.
		 */
		settledAt: timestamp("settled_at", { withTimezone: true }),
		/**
		 * The forge's merge time of this bump PR, set once when the merge
		 * watch sees `merged: true`. NULL means "not observed".
		 */
		mergedAt: timestamp("merged_at", { withTimezone: true }),
		/**
		 * Set when the bump PR is observed closed WITHOUT merging; stops
		 * the merge watch for this row. NULL means "not observed".
		 */
		prClosedAt: timestamp("pr_closed_at", { withTimezone: true }),
		/**
		 * When the factory's Argo hard refresh for this `app_dir` answered 2xx
		 * after the merge. NULL means "not observed".
		 */
		argoRefreshedAt: timestamp("argo_refreshed_at", { withTimezone: true }),
		/**
		 * Observed seconds from the new ReplicaSet being created to reaching its
		 * Ready count, for THIS bump. NULL means never measured.
		 *
		 * NULL and 0 are DIFFERENT CLAIMS: NULL is "no observation", 0 is
		 * "measured and instant". Nothing may default this to 0 — the rollback
		 * window drops its `2 x rolling_avg` term on NULL, and a default would
		 * silently pin that term to zero for every row that predates measurement.
		 */
		readySeconds: integer("ready_seconds"),
		/**
		 * Container restarts observed during that same readiness window.
		 * NULL when `readySeconds` is NULL: no window was observed, so there is
		 * nothing to have counted.
		 */
		readyRestartCount: integer("ready_restart_count"),
		/**
		 * How many pod observations the `readySeconds` value came from.
		 * `1` is a MEASUREMENT, not an average, and a reader must be able to tell
		 * the two apart. NULL when `readySeconds` is NULL.
		 */
		readySampleCount: integer("ready_sample_count"),
	},
	(t) => [
		uniqueIndex("build_bump_bumps_candidate_app_key").on(t.candidateId, t.appDir),
		/** Named as 0016 created it (Postgres default `_fkey`), sf#850. */
		foreignKey({
			name: "build_bump_bumps_candidate_id_fkey",
			columns: [t.candidateId],
			foreignColumns: [buildBumpCandidates.id],
		}),
	],
);

export type BuildBumpBumpRow = typeof buildBumpBumps.$inferSelect;
export type NewBuildBumpBumpRow = typeof buildBumpBumps.$inferInsert;

// ---------- build_bump_markers ----------
/**
 * One MOVABLE tag that some environment promotes by.
 *
 * REBUILT BY INTAKE EVERY PASS from the same tag listing the candidate rows come
 * from: markers present on the repository are upserted, markers no longer
 * present are deleted. The table is a projection of the forge as of the last
 * pass, never a history — moving a marker BACKWARDS onto an older version is a
 * legitimate deploy of that older version, so there is nothing here to append to
 * and no notion of a marker's previous position.
 *
 * `marker` is the movable tag's NAME (an environment's own name by default) and
 * `sha` the COMMIT sha it resolves to — the same `commit.sha` the candidate rows
 * carry, so the environment receives whichever version tag shares the marker's
 * commit. Only markers some environment actually declares are stored; every
 * other tag on the repository is ignored rather than recorded.
 */
export const buildBumpMarkers = pgTable(
	"build_bump_markers",
	{
		id: integer("id").primaryKey().generatedAlwaysAsIdentity(),
		/** `owner/repo` as it appears in the managed-repository config. */
		repository: text("repository").notNull(),
		/** The movable tag's bare NAME — never a ref path. */
		marker: text("marker").notNull(),
		/** The COMMIT sha the marker resolves to (`commit.sha`), never the tag object id. */
		sha: text("sha").notNull(),
		/** When the rebuild last observed this marker at this sha. */
		seenAt: timestamp("seen_at", { withTimezone: true }).notNull().defaultNow(),
	},
	(t) => [uniqueIndex("build_bump_markers_repository_marker_key").on(t.repository, t.marker)],
);

export type BuildBumpMarkerRow = typeof buildBumpMarkers.$inferSelect;
export type NewBuildBumpMarkerRow = typeof buildBumpMarkers.$inferInsert;
