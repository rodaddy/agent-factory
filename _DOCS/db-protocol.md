# software-factory DB Protocol

The watcher keeps its durable state in PostgreSQL. This document is the
enforced contract for how the schema is defined and how it changes. It follows
an earlier platform DDL protocol, scaled to one service and one database.

## Environments

| Environment | Host | Purpose |
|---|---|---|
| Local test | Homebrew PostgreSQL, `127.0.0.1:5432` | Throwaway per-run test databases. |
| Local dev | PostgreSQL on loopback, `127.0.0.1:5432`, a persistent dev database | Persistent; accumulates real reconciliation data before cutover. |
| Production | A PostgreSQL database on a separate hub host | Network-reached, NOT loopback; connection supplied through the managed environment. The database host authorizes the watcher host in its `pg_hba`. |
| Prod scratch | A scratch PostgreSQL cluster on the hub host | Disposable; all test scratch churn. `fsync=off`, trust-on-LAN. |

The connection string is always read from `DATABASE_URL`. No host, user, or
password is committed to this repository.

## Single source of truth

- **All structure is modeled in `src/db/schema.ts`.** Do not add handwritten
  `CREATE TABLE` / `ALTER TABLE` outside generated migrations, except the
  migration runner's `schema_migrations` bootstrap described below.
- Drizzle exists to keep the schema and tables consistent so structure cannot
  drift or change ad hoc. Treat table definitions as fixed templates that
  changes flow through, mirroring the service's fixed-job-template ethos.

## Migration policy

Repository identity is provider-qualified in durable state:
`(provider, full_name)` is unique, with `provider` defaulting to `github`.
Migration `0001_repositories_provider.sql` backfills every pre-provider row to
GitHub before replacing the old bare-name uniqueness boundary. Operators must
apply the committed migration normally; never relabel existing rows to Forgejo
as a shortcut. Forgejo repositories are inserted/reconciled with
`provider = 'forgejo'`.

### Local development

- Iterate fast. Sync `schema.ts` straight to the local dev database with
  `bun run db:push` (Drizzle Kit push).
- `schema.ts` remains the only schema model. Local push is a development
  convenience, never a deployment mechanism.

### Production

- **Every schema change ships a generated Drizzle migration.** Change
  `schema.ts`, run `bun run db:generate`, commit the generated SQL.
- `drizzle/meta` must know every file in `drizzle/`. The
  "drizzle meta parity" tests in `tests/db/migrate.test.ts` fail when the
  journal misses a file or when the migrated schema differs from a
  `drizzle-kit push` of `schema.ts`. If a migration was hand-written anyway,
  re-baseline without new SQL: run `bun run db:generate`, rename its
  `meta/NNNN_snapshot.json` to the hand-written file's index, delete the
  generated SQL, and add the hand-written tag to `_journal.json`. A second
  `db:generate` must then report "No schema changes".
- Migrations are applied with `bun run db:migrate` (idempotent and checksum
  tracked). The same committed files replay verbatim against the production
  database reached through its loopback `DATABASE_URL`.
- A checksum mismatch for a present/selected applied file is a hard failure.
  Restore the reviewed migration bytes or ship a new migration; never rewrite the
  ledger to make drift pass.
- The runner does not currently reject an applied ledger version whose SQL file
  is absent. Applied files are therefore immutable and must never be deleted from
  `drizzle/`.
- **Never `db:push` against anything that will be deployed.**

### Runner-owned tracking table

`scripts/migrate.ts` creates `schema_migrations(version, checksum, applied_at)`
before it reads or applies migration files. The table is still modeled exactly
in `src/db/schema.ts` and retained in `drizzle/meta/0000_snapshot.json`, so
future Drizzle generations see the full live schema. The executable production
baseline omits only `CREATE TABLE "schema_migrations"`; regenerating the
baseline must preserve this exception.

## Schema standards (ENFORCED)

- **Timestamps are always `timestamptz`.** In Drizzle:
  `timestamp("col", { withTimezone: true })`. Bare `timestamp()` is rejected.
- **Naming:** tables `snake_case`, plural; columns `snake_case`; unique
  indexes `<table>_<cols>_key`; plain indexes `<table>_<cols>_idx`.
- **Primary keys:** `integer("id").primaryKey().generatedAlwaysAsIdentity()`.
- **Index-first.** Any query with `WHERE`/`ORDER BY`/`JOIN` on a growing table
  must have a matching index declared in `schema.ts` in the same change. No
  ad-hoc raw-SQL indexes.
- **Idempotency keys are explicit.** The `jobs` uniqueness key
  (`repository_id`, `item_id`, `sha`, `job_type`) is the guarantee dispatch,
  ingest, and pre-push validation depend on.
- **Pre-push receipts are not database rows.** Receipt version 3 lives beneath
  the Git common directory and binds `provider`, canonical HTTPS `host`,
  `repository`, and exact `sha`; old version-2 receipts fail schema validation
  and must be regenerated.

## What NOT to do

- Do not run `psql -c "ALTER TABLE ..."` or hand-apply SQL against any database.
- Do not hand-write migration SQL — generate it from `schema.ts`, then apply
  only the documented tracking-table omission when producing a new baseline.
- Do not commit credentials, hosts, or connection strings.
- Do not skip the production migration file — if there is no file in `drizzle/`,
  CI cannot apply it to production.
