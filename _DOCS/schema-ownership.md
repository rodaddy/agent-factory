# Schema Ownership Map

Every Drizzle table lives in `src/db/schema.ts` and is owned by the single
`software-factory` service. This service is deliberately one process with one
database; there is no cross-service ownership to coordinate.

> **Manually maintained** — update this file when adding or modifying tables.

| Export Name | DB Table (snake_case) | Purpose |
|---|---|---|
| `repositories` | `repositories` | Configured repositories the watcher reconciles. |
| `reconciliationCursors` | `reconciliation_cursors` | Incremental read cursors per repo and resource. |
| `githubItems` | `github_items` | Normalized issues and pull requests seen in a sweep. |
| `jobs` | `jobs` | Units of runner work; idempotent per (repo, item, sha, type). |
| `auditScheduleSlots` | `audit_schedule_slots` | Idempotency ledger for watcher-driven audit schedule slots. |
| `jobAttempts` | `job_attempts` | Per-dispatch attempt records with runner identity and the provider-attested `observed_model`. |
| `resultPostings` | `result_postings` | Bounded inbound result-artifact ingest state. |
| `githubPostings` | `github_postings` | Durable outbound GitHub publication plans (labels/comment/check) with retry + dedupe state. |
| `shadowPublications` | `shadow_publications` | Shadow-mode ledger of GitHub writes intentionally not sent. |
| `runnerBoxes` | `runner_boxes` | Every placeable runner box, one row per VMID. The authority for runner addressing; MAC and IP are stated, never derived. |
| `schemaMigrations` | `schema_migrations` | Runner-owned applied-migration ledger with version, checksum, and applied timestamp. |

`result_postings` records the *inbound* ingest of a runner artifact; `github_postings`
owns the *outbound* GitHub write intent (approved label transitions, one deduplicated
comment, one exact-SHA check) and its retry lifecycle. They are deliberately distinct
tables. `github_postings` is keyed `(job_id, kind, target)` for idempotency and joins to
`jobs` → `github_items` / `repositories` for the authoritative repository, item number,
and SHA — the plan never trusts a runner-chosen target.

`schema_migrations` is the one executable-DDL ownership exception. It remains
fully modeled in `src/db/schema.ts` and Drizzle snapshot metadata, but
`scripts/migrate.ts` creates it before reading migration files. The generated
production baseline therefore omits only its `CREATE TABLE` statement. When
regenerating a baseline, preserve that omission so the runner can record the
baseline checksum without colliding with migration SQL.

## The migration authority is `scripts/migrate.ts`, not `drizzle/meta/`

`scripts/migrate.ts` is the ONLY thing that applies DDL here. It enumerates
`drizzle/*.sql` with `readdirSync` + a `.sql` filter, orders by filename, and
tracks each file by SHA checksum in `schema_migrations` — refusing to proceed on
checksum drift. It never opens `drizzle/meta/_journal.json` or a
`drizzle/meta/*_snapshot.json`.

**`drizzle/meta/` is therefore NON-AUTHORITATIVE in this repo.** Those files are
`drizzle-kit generate` bookkeeping, and a `.sql` migration hand-written or landed
without a matching snapshot entry is applied correctly and completely by the
runner regardless — journal drift is inert at runtime.

It is not inert at AUTHORING time. A future `drizzle-kit generate` diffs
`src/db/schema.ts` against the newest snapshot it can see, so a stale snapshot
makes it re-emit DDL that is already applied in production. Two rules follow:

- Nothing reads `drizzle/meta/` to decide what to apply. Do not add a check,
  gate, or verify-script assertion that treats the journal as state.
- `drizzle/meta` must reflect every `.sql` file in `drizzle/` before
  `drizzle-kit generate` runs; the "drizzle meta parity" tests in
  `tests/db/migrate.test.ts`
 
  fail when it does not. A migration hand-written anyway is re-baselined per
  `_DOCS/db-protocol.md` (Production), never left outside the journal.

See `_DOCS/db-protocol.md` for how these change.
