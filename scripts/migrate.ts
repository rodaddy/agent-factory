#!/usr/bin/env bun
/**
 * @module scripts/migrate
 * @description Versioned SQL migration runner for production deployments of
 *   software-factory. Reads `.sql` files from `drizzle/`, tracks applied
 *   migrations by checksum in `schema_migrations`, and applies new ones in
 *   filename order inside a transaction each. Ported from an earlier platform
 *   runner; uses the built-in Bun.sql driver.
 *
 *   Usage:
 *     DATABASE_URL=postgres://... bun run scripts/migrate.ts [--dry-run]
 *
 *   `MIGRATION_FILES` (comma-separated basenames) restricts the set applied,
 *   for CI that classifies additive vs breaking changes. When unset, every
 *   unapplied file in `drizzle/` is applied.
 *
 * @dependencies
 *   - bun (SQL, CryptoHasher) -- driver and hashing
 *   - node:fs, node:path -- migration file discovery
 */
import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { SQL } from "bun";
import { RUNNER_BOXES } from "../src/runner/bands";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
	console.error("ERROR: DATABASE_URL environment variable is required");
	process.exit(1);
}

const dryRun = process.argv.includes("--dry-run");
const migrationsDir = join(import.meta.dir, "..", "drizzle");
const sql = new SQL(DATABASE_URL);

/** Redact credentials from a connection string for logging. */
function redactUrl(url: string): string {
	return url.replace(/\/\/[^@]*@/, "//***@");
}

/**
 * Create the runner-owned applied-migration ledger before reading migration
 * files. Generated baseline SQL intentionally omits this table's CREATE DDL.
 */
async function ensureTrackingTable(): Promise<void> {
	// A dry run must not write, and `CREATE TABLE IF NOT EXISTS` is a write: it
	// leaves a table behind on an empty database, so a command advertised as
	// read-only silently changes the schema it was asked to inspect. Skip the DDL
	// and let `getApplied` treat a missing ledger as empty instead.
	if (dryRun) {
		return;
	}
	await sql`
		CREATE TABLE IF NOT EXISTS schema_migrations (
			version     TEXT PRIMARY KEY,
			checksum    TEXT NOT NULL,
			applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
		)
	`;
}

function hashContent(content: string): string {
	return new Bun.CryptoHasher("sha256").update(content).digest("hex");
}

/**
 * PostgreSQL `undefined_table` (42P01) — the ONE ledger-read failure a dry run may
 * treat as "nothing applied yet". Matched on the SQLSTATE rather than message
 * text, which is localized and driver-dependent.
 */
function isUndefinedTable(err: unknown): boolean {
	if (typeof err !== "object" || err === null) {
		return false;
	}
	// Bun.sql puts its OWN identifier in `code` (`ERR_POSTGRES_SERVER_ERROR`) and
	// the PostgreSQL SQLSTATE in `errno` — verified against a live server, because
	// the obvious `code === "42P01"` reads correctly and never matches. `code` is
	// still accepted for a driver that reports the SQLSTATE the conventional way.
	const { code, errno } = err as { code?: unknown; errno?: unknown };
	return errno === "42P01" || code === "42P01";
}

/** Map of already-applied version -> checksum. */
async function getApplied(): Promise<Map<string, string>> {
	try {
		const rows = await sql`SELECT version, checksum FROM schema_migrations ORDER BY version`;
		return new Map(rows.map((r: { version: string; checksum: string }) => [r.version, r.checksum]));
	} catch (err) {
		// Only a dry run may reach a database with no ledger, because that is the one
		// mode that deliberately skips creating it. An ABSENT ledger means "nothing
		// applied yet" and every file correctly reports as WOULD APPLY.
		//
		// Narrow to exactly that error. Swallowing every failure here would report a
		// confident, wrong migration plan whenever the database is unreachable or the
		// role simply lacks SELECT — the run would print WOULD APPLY for migrations
		// that are already applied, and exit 0 having inspected nothing.
		if (dryRun && isUndefinedTable(err)) {
			return new Map();
		}
		throw err;
	}
}

/** Resolve the ordered list of migration basenames to consider. */
function getMigrationFiles(): string[] {
	const envFiles = process.env.MIGRATION_FILES;
	if (envFiles) {
		const files = envFiles
			.split(",")
			.map((f) => f.trim())
			.filter(Boolean);
		for (const f of files) {
			if (f.includes("/") || f.includes("\\") || f.includes("..")) {
				throw new Error(`Invalid migration filename (path traversal rejected): ${f}`);
			}
		}
		return files;
	}
	try {
		return readdirSync(migrationsDir)
			.filter((f) => f.endsWith(".sql"))
			.sort();
	} catch {
		console.log("No drizzle/ directory found");
		return [];
	}
}

/**
 * Seed `runner_boxes` from the stated inventory in `src/runner/bands.ts`.
 *
 * Runs here rather than on service startup because the inventory is schema-shaped
 * data: it changes when a band is renumbered, which is a migration event, not a
 * per-boot one. A daemon that re-seeded on every start would also be a daemon
 * that could rewrite addressing under a running job.
 *
 * Idempotent. `ON CONFLICT` refreshes the addressing columns but deliberately
 * never touches `held_by_job_id`/`held_at` — re-seeding must not silently release
 * a box some job is currently holding. Releasing is `releaseRunnerBox`'s job.
 *
 * Every value is bound as a parameter, never interpolated: this is the one place
 * the inventory reaches SQL, and a hand-built VALUES string here would be an
 * injection seam fed by a file that gets edited whenever the fleet grows.
 */
async function seedRunnerBoxes(): Promise<void> {
	if (RUNNER_BOXES.length === 0) {
		throw new Error("runner box inventory is empty; refusing to seed");
	}
	if (dryRun) {
		console.log(`\n  WOULD SEED: runner_boxes (${RUNNER_BOXES.length} stated boxes)`);
		return;
	}
	console.log(`\n  SEEDING: runner_boxes (${RUNNER_BOXES.length} stated boxes) ...`);
	// One transaction: a partially seeded inventory is worse than an unseeded one,
	// because allocation would resolve some boxes and silently reject others.
	await sql.begin(async (tx: SQL) => {
		for (const box of RUNNER_BOXES) {
			await tx`
				INSERT INTO runner_boxes (vmid, band, mac, ip, allocatable)
				VALUES (${box.vmid}, ${box.band}, ${box.mac}, ${box.ip}, ${box.allocatable})
				ON CONFLICT (vmid) DO UPDATE SET
					band = excluded.band,
					mac = excluded.mac,
					ip = excluded.ip,
					allocatable = excluded.allocatable,
					updated_at = now()
			`;
		}
	});
	console.log(`  seeded: runner_boxes`);
}

async function main(): Promise<void> {
	console.log(`software-factory migration runner${dryRun ? " (DRY RUN)" : ""}`);
	console.log(`Database: ${redactUrl(DATABASE_URL ?? "")}`);

	await ensureTrackingTable();
	const applied = await getApplied();
	const files = getMigrationFiles();

	// No early return here. The seed below must run even when there is nothing to
	// apply: `MIGRATION_FILES=""` or an empty `drizzle/` would otherwise exit 0
	// having left `runner_boxes` empty, and allocation cannot see an inventory
	// that was never written. A skipped seed that reports success is the same
	// silent-absence failure as an uninstalled pre-push hook.
	if (files.length === 0) {
		console.log("No migration files to process.");
	}

	let appliedCount = 0;
	let skippedCount = 0;

	for (const file of files) {
		const version = basename(file);
		const filePath = join(migrationsDir, version);
		const content = readFileSync(filePath, "utf-8");
		const checksum = hashContent(content);

		if (applied.has(version)) {
			if (applied.get(version) !== checksum) {
				throw new Error(`Migration checksum drift: ${version}`);
			}
			console.log(`  SKIP (already applied): ${version}`);
			skippedCount++;
			continue;
		}

		if (dryRun) {
			console.log(`  WOULD APPLY: ${version} (${checksum})`);
			appliedCount++;
			continue;
		}

		console.log(`  APPLYING: ${version} ...`);
		try {
			await sql.begin(async (tx: SQL) => {
				await tx.unsafe(content);
				await tx`
					INSERT INTO schema_migrations (version, checksum)
					VALUES (${version}, ${checksum})
				`;
			});
			console.log(`  applied: ${version}`);
			appliedCount++;
		} catch (err) {
			console.error(`  FAILED: ${version} (transaction rolled back)`);
			console.error(err);
			await sql.end();
			process.exit(1);
		}
	}

	// After the schema exists. The table is created by a migration and filled here,
	// so a fresh deploy never leaves an empty inventory that allocation cannot see.
	await seedRunnerBoxes();

	console.log(`\nDone. Applied: ${appliedCount}, Skipped: ${skippedCount}`);
	await sql.end();
}

main().catch((err) => {
	console.error("Migration runner failed:", err);
	process.exit(1);
});
