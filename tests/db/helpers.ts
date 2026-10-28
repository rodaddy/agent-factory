/**
 * @module tests/db/helpers
 * @description Test harness for the durable state model. Creates a uniquely
 *   named throwaway database on a scratch PostgreSQL server, carrying the
 *   current schema from `src/db/schema.ts`, and drops it on teardown so each
 *   test is isolated and can never drift from the schema source.
 *
 *   SCHEMA IS PUSHED ONCE, THEN CLONED. Each `withTestDb` used to
 *   spawn its own `bunx drizzle-kit push --force`. At 316 call sites that is 316
 *   subprocesses per suite, and N parallel worktree lanes multiplied it into
 *   observed load 15-24 on 14 cores. Now the schema is pushed into a single
 *   TEMPLATE database and every test gets `CREATE DATABASE ... TEMPLATE`, an
 *   in-server file copy measured at 26ms against the live scratch cluster.
 *
 *   The template is named for a sha256 of `src/db/schema.ts`, so its identity IS
 *   the schema version: editing the schema names a template that does not exist,
 *   which pushes a fresh one, and no invalidation step can be forgotten.
 *
 *   PARALLEL LANES SHARE THE CLUSTER, so "if absent, push" is not sufficient —
 *   two lanes starting together both read absent and both push. The build is
 *   serialized by a session-level `pg_advisory_lock` keyed on the same
 *   fingerprint, with the existence check repeated inside the lock. See
 *   `ensureTemplateDatabase` for why the lock lives in the cluster and why it is
 *   session-level rather than a marker row.
 *
 *   ADMIN CONNECTION RESOLUTION. The admin URL used only to
 *   create/drop the scratch database is resolved ONCE at module init, in this
 *   order:
 *     1. `TEST_ADMIN_DATABASE_URL` env — explicit per-run override.
 *     2. Machine config: JSON at `~/.config/software-factory/test-db.json`,
 *        key `adminDatabaseUrl` (string). A MISSING file falls through silently
 *        (the normal sandbox case). An unreadable/unparseable file, or a
 *        present-but-non-string key, FAILS LOUDLY — a corrupted config silently
 *        falling back to the default would put CREATE/DROP DATABASE churn back on
 *        a shared instance, the exact cross-tenant damage #136 exists to prevent.
 *     3. Default `postgres://127.0.0.1:5432/postgres`.
 *
 *   WHY the default stays local: the receipt-gate sandbox provisions its own
 *   ephemeral in-sandbox PostgreSQL with no network and no config file, and must
 *   keep working with neither env nor machine config present.
 *
 *   WHY a broken config is loud, not lenient: the shared Mac
 *   `127.0.0.1:5432` instance co-hosts Open Brain; test CREATE/DROP DATABASE
 *   churn co-located there drove observed OB latency from ms into the tens of
 *   seconds. Silently defaulting on a corrupt config would reintroduce exactly
 *   that damage, so a config that is present-but-broken stops the run.
 *
 *   The live dev target on this network is the fleet-hub scratch cluster
 *   (`postgres://postgres@10.0.20.74:5433/postgres`) — a second PG cluster,
 *   fsync off, disposable, trust-on-LAN by design (it holds only throwaway test
 *   scratch, so a credential would protect nothing). A dev machine points the
 *   harness there via the machine config file, no shell-profile edits.
 *
 *   TIMEOUT CONTRACT. Every test using this harness performs real
 *   work — `CREATE DATABASE`, a `drizzle-kit push` subprocess, then
 *   `DROP DATABASE ... WITH (FORCE)` — whose cost is dominated by PostgreSQL
 *   fsync latency on the HOST DISK, not by the candidate under test. That is
 *   ~1s on a local NVMe, but an observed checkpoint sync on a runner box reached
 *   4.42s, crossing bun's 5000ms default per-test timeout. When it crossed, bun
 *   killed the timed-out test's children, so `drizzle-kit push` died on SIGTERM
 *   and surfaced as `drizzle-kit push failed (exit 143)` — an "Unhandled error
 *   between tests" that cascaded into unrelated failures and produced a
 *   nondeterministic failure count for one unchanged SHA.
 *
 *   The bound therefore lives in the `test` script in `package.json`
 *   (`bun test --timeout=30000`), NOT in `bunfig.toml`: bun 1.3.13 does NOT honor
 *   `[test] timeout` from `bunfig.toml` (verified — a 6s test still died at
 *   5000ms with it set), so a config-file bound would be silently ineffective.
 *   Run `bun test` directly and DB tests inherit the 5000ms default again; use
 *   `bun run test` (or pass `--timeout`) when running them by hand.
 *
 * @outputs
 *   - `withTestDb` -- run a callback against a fresh, migrated scratch database
 *   - `withEmptyTestDatabase` -- run a callback against a fresh empty database
 *
 * @dependencies
 *   - bun (SQL, spawn) -- driver and drizzle-kit invocation
 *   - drizzle-orm/bun-sql -- runtime client bound to the scratch database
 *   - ../../src/db/schema -- table definitions under test
 */
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "../../src/db/schema";

/** Default admin URL — the local `postgres` database on loopback. */
const DEFAULT_ADMIN_URL = "postgres://127.0.0.1:5432/postgres";

/** Path (relative to home) of the machine config that redirects test churn. */
const MACHINE_CONFIG_RELATIVE_PATH = ".config/software-factory/test-db.json";

/**
 * Synchronous file reader seam. Injectable so `resolveAdminUrl` can be covered
 * without touching the real home dir; the default reads UTF-8 text from disk.
 */
export type ReadConfigFile = (path: string) => string;

const defaultReadConfigFile: ReadConfigFile = (path) => readFileSync(path, "utf8");

/**
 * Resolve the admin connection URL used ONLY to create/drop scratch databases.
 * Pure over its inputs; see the module doc for the full precedence and the #136
 * rationale. Precedence: env override → machine config → local default.
 *
 * A missing machine-config file falls through to the default silently (the
 * sandbox case). A file that exists but cannot be read or parsed, or whose
 * `adminDatabaseUrl` is present but not a string, throws — naming the path and
 * the problem — rather than silently churning a shared instance.
 *
 * @param env - environment map to read `TEST_ADMIN_DATABASE_URL` from
 * @param readConfigFile - synchronous file reader seam (defaults to `readFileSync`)
 */
export function resolveAdminUrl(
	env: Record<string, string | undefined>,
	readConfigFile: ReadConfigFile = defaultReadConfigFile,
): string {
	const override = env.TEST_ADMIN_DATABASE_URL;
	if (override !== undefined && override !== "") {
		return override;
	}

	const configPath = join(homedir(), MACHINE_CONFIG_RELATIVE_PATH);
	let raw: string;
	try {
		raw = readConfigFile(configPath);
	} catch (err) {
		// A MISSING file is the normal sandbox case: fall through to the default.
		if ((err as NodeJS.ErrnoException).code === "ENOENT") {
			return DEFAULT_ADMIN_URL;
		}
		// Present but unreadable (permissions, I/O) is a real fault — be loud.
		throw new Error(
			`test-db machine config at ${configPath} could not be read: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch (err) {
		throw new Error(
			`test-db machine config at ${configPath} is not valid JSON: ${
				err instanceof Error ? err.message : String(err)
			}`,
		);
	}

	const value = (parsed as Record<string, unknown> | null)?.adminDatabaseUrl;
	if (value === undefined) {
		// Key absent — treat as "no redirect configured", fall through to default.
		return DEFAULT_ADMIN_URL;
	}
	if (typeof value !== "string") {
		throw new Error(
			`test-db machine config at ${configPath} has a non-string "adminDatabaseUrl" (got ${typeof value}); expected a connection string`,
		);
	}
	return value;
}

const ADMIN_URL = resolveAdminUrl(process.env);

/**
 * Open an admin connection that holds AT MOST ONE backend.
 *
 * `new SQL(url)` opens a POOL, not a connection: probed against the live scratch
 * cluster, a default `SQL` running three concurrent statements occupied 11
 * backends while `max: 1` occupied one. Administrative work here is strictly
 * sequential — a create, a drop, a catalog read — so a pool buys nothing and
 * costs a lot.
 *
 * It costs a lot because the cluster is SHARED by parallel lanes and
 * `max_connections` is 60 (probed; 28 already in use by other tenants). N lanes
 * each holding a 10-backend pool exhausts that, and the failure surfaces as
 * SQLSTATE `53300` `"sorry, too many clients already"` — observed killing lanes
 * in a 6-lane cold-start run before this cap was added. Capping at one keeps a
 * lane's admin footprint proportional to what it actually uses.
 */
function adminConnection(): SQL {
	return new SQL({ url: ADMIN_URL, max: 1 });
}

/** Swap the database name (final path segment) of the admin URL. */
function scratchUrl(dbName: string): string {
	const url = new URL(ADMIN_URL);
	url.pathname = `/${dbName}`;
	return url.toString();
}

/**
 * Exit code bun reports for a child it terminated with SIGTERM (128 + 15). When
 * a test exceeds its timeout, bun kills the spawned `drizzle-kit` process, so
 * this code means "the HARNESS killed the push", never "the candidate's schema
 * is invalid".
 */
const SIGTERM_EXIT_CODE = 143;

/**
 * Push the live schema into the scratch database with drizzle-kit.
 *
 * Distinguishes a HARNESS fault from a CANDIDATE fault. A real schema
 * error exits non-zero with diagnostics on stderr. Exit 143 with empty stderr
 * instead means bun terminated this subprocess because the enclosing test hit its
 * timeout — a property of host disk/fsync latency, not of the schema under test.
 * Reporting both identically made a nondeterministic infrastructure stall look
 * like a deterministic candidate failure, so the message now names the owning
 * layer explicitly.
 */
async function pushSchema(databaseUrl: string): Promise<void> {
	const proc = Bun.spawn(["bunx", "drizzle-kit", "push", "--force"], {
		env: { ...process.env, DATABASE_URL: databaseUrl },
		stdout: "pipe",
		stderr: "pipe",
	});
	const code = await proc.exited;
	if (code !== 0) {
		const err = await new Response(proc.stderr).text();
		if (code === SIGTERM_EXIT_CODE && err.trim().length === 0) {
			throw new Error(
				`drizzle-kit push was terminated by the test harness (exit ${code}, SIGTERM) before it could report a schema error. ` +
					"This is a HARNESS/INFRASTRUCTURE fault, not a candidate schema failure: the enclosing test exceeded its timeout " +
					"(usually slow PostgreSQL fsync on the host disk) and bun killed this subprocess. " +
					"Raise the test timeout in bunfig.toml rather than treating this as a schema defect.",
			);
		}
		throw new Error(`drizzle-kit push failed (exit ${code}): ${err}`);
	}
}

/**
 * SQLSTATE `55006` (`object_in_use`). `CREATE DATABASE ... TEMPLATE t` REFUSES
 * while any session is connected to `t`, with
 * `source database "t" is being accessed by other users`.
 *
 * READ THE FIELD NAME (repo canon): Bun.sql puts SQLSTATE in `errno`, NOT
 * `code` — probed against the live scratch cluster (PostgreSQL 18.4), where
 * `code` is the generic `"ERR_POSTGRES_SERVER_ERROR"` for every server error and
 * only `errno` carries `"55006"`. Keying on `code` compiles, reads correctly,
 * and never matches.
 */
const SQLSTATE_OBJECT_IN_USE = "55006";

/**
 * SQLSTATE `42P04` (`duplicate_database`). Emitted when a racing lane created
 * the template between our existence check and our own `CREATE DATABASE`. It is
 * the BENIGN outcome of the race — the other lane is building the very database
 * we wanted — so it is swallowed and we wait for that build to finish. Same
 * `errno`-not-`code` rule as above.
 */
const SQLSTATE_DUPLICATE_DATABASE = "42P04";

/** Read the SQLSTATE off a Bun.sql error. See the constants above for why `errno`. */
function sqlState(err: unknown): string | undefined {
	const value = (err as { errno?: unknown } | null)?.errno;
	return typeof value === "string" ? value : undefined;
}

/**
 * Fingerprint of the schema SOURCE, used as the template database's identity.
 *
 * `src/db/schema.ts` has no local imports (verified — its only imports are from
 * `drizzle-orm`), so its own bytes are the complete schema definition and
 * hashing that one file cannot miss a change. A schema edit therefore yields a
 * DIFFERENT template name, which no cluster has, which forces a fresh push. The
 * template is never mutated in place and never needs invalidating: stale
 * templates are simply unreferenced.
 *
 * Truncated to 16 hex chars to stay inside PostgreSQL's 63-byte identifier
 * limit with room for the prefix; collision risk over a handful of concurrent
 * schema versions is nil.
 */
const SCHEMA_FINGERPRINT = createHash("sha256")
	.update(readFileSync(join(import.meta.dir, "../../src/db/schema.ts")))
	.digest("hex")
	.slice(0, 16);

/** Name of the shared, schema-versioned template database. */
const TEMPLATE_DB = `sf_tpl_${SCHEMA_FINGERPRINT}`;

/**
 * Advisory-lock key derived from the same fingerprint, so lanes on DIFFERENT
 * schema versions never block each other while lanes on the SAME version
 * serialize. PostgreSQL advisory-lock keys are signed 64-bit; take 15 hex chars
 * (60 bits) to stay comfortably positive.
 */
const TEMPLATE_LOCK_KEY = BigInt(`0x${SCHEMA_FINGERPRINT.slice(0, 15)}`);

/**
 * Does `dbName` exist on the cluster right now?
 *
 * Deliberately queried through a caller-supplied connection so the existence
 * check and the subsequent create can share one session — and therefore one
 * advisory lock — with no window in between.
 */
async function databaseExists(admin: SQL, dbName: string): Promise<boolean> {
	const rows = await admin.unsafe("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
	return rows.length > 0;
}

/**
 * Ensure the schema-versioned template database exists and carries the current
 * schema, pushing it AT MOST ONCE per cluster per schema version.
 *
 * THE RACE THIS EXISTS TO CLOSE. The naive shape — "if absent,
 * push" — is not safe under the parallel lanes this repo actually runs: two
 * worktrees starting together both read "absent" and both push, which is the
 * saturation the fix is meant to remove, and the second push can land on a
 * half-built template. Serialization is therefore a real requirement, not
 * defensive garnish.
 *
 * HOW IT IS SERIALIZED. A session-level `pg_advisory_lock` on a key derived
 * from the schema fingerprint. The lock lives in the CLUSTER, which is the one
 * thing every parallel lane demonstrably shares — a file lock or an in-process
 * flag would not be seen across worktrees or across `bun test` processes.
 * Session-level (not transaction-level) means PostgreSQL releases it when the
 * connection drops, so a lane killed mid-push cannot wedge every other lane;
 * that crash-safety is why a marker ROW would be the wrong instrument.
 *
 * The check is re-run INSIDE the lock (double-checked): the loser of the race
 * finds the template already built by the winner and pushes nothing. A
 * `42P04` from a create that slipped through is likewise treated as "someone
 * else is building it", not as an error.
 *
 * Idempotent by construction on top of that: the template name is a pure
 * function of the schema bytes, so re-running against an existing template is a
 * no-op rather than a repair.
 */
async function ensureTemplateDatabase(): Promise<void> {
	const admin = adminConnection();
	try {
		// Fast path: already built by this run, an earlier run, or another lane.
		// Costs one indexed catalog read and takes no lock at all, which is what
		// keeps the steady state cheap.
		if (await databaseExists(admin, TEMPLATE_DB)) {
			return;
		}

		await admin.unsafe(`SELECT pg_advisory_lock(${TEMPLATE_LOCK_KEY})`);
		try {
			// Double-check under the lock — this is the branch the loser of the
			// race takes, and the reason two lanes never both push.
			if (await databaseExists(admin, TEMPLATE_DB)) {
				return;
			}

			// Build under a TEMPORARY name and rename on success, so a push that
			// dies halfway can never leave a half-populated database sitting at
			// the name every other lane clones from. The template only becomes
			// visible under its real name once its schema is complete.
			const building = `${TEMPLATE_DB}_building_${process.pid}`;
			await admin.unsafe(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`);
			await admin.unsafe(`CREATE DATABASE ${building}`);
			try {
				await pushSchema(scratchUrl(building));
				await admin.unsafe(`ALTER DATABASE ${building} RENAME TO ${TEMPLATE_DB}`);
			} catch (err) {
				await admin.unsafe(`DROP DATABASE IF EXISTS ${building} WITH (FORCE)`);
				// Another lane won and published the template first: benign, and
				// its content is equivalent because the name IS the schema hash.
				if (sqlState(err) === SQLSTATE_DUPLICATE_DATABASE) {
					return;
				}
				throw err;
			}
		} finally {
			await admin.unsafe(`SELECT pg_advisory_unlock(${TEMPLATE_LOCK_KEY})`);
		}
	} finally {
		await admin.end();
	}
}

/**
 * How many times to retry a clone that lost to a transient `55006`.
 *
 * `CREATE DATABASE ... TEMPLATE` refuses while ANY session is connected to the
 * template. Nothing in this harness connects to it after the build, but the
 * build's own connection and other lanes' catalog activity leave a short window,
 * so a bounded retry converts a rare parallel-lane collision into a delay rather
 * than a failed suite. A clone measured 26ms against the live scratch cluster.
 */
const CLONE_RETRY_LIMIT = 10;

/** Backoff between clone retries, in milliseconds. */
const CLONE_RETRY_DELAY_MS = 100;

/**
 * Create `dbName` as a clone of the schema template.
 *
 * Retries ONLY on `55006` (`object_in_use`) — a transient statement about who is
 * connected to the template, never about the schema. Any other failure is real
 * and propagates immediately, so a genuine defect is not buried under retries.
 */
async function cloneFromTemplate(admin: SQL, dbName: string): Promise<void> {
	for (let attempt = 0; ; attempt += 1) {
		try {
			await admin.unsafe(`CREATE DATABASE ${dbName} TEMPLATE ${TEMPLATE_DB}`);
			return;
		} catch (err) {
			if (sqlState(err) !== SQLSTATE_OBJECT_IN_USE || attempt >= CLONE_RETRY_LIMIT) {
				throw err;
			}
			await Bun.sleep(CLONE_RETRY_DELAY_MS); // fixed-sleep-ok: retry backoff on 55006, no event or clock signals the template is free
		}
	}
}

let counter = 0;

/**
 * Run `fn` against a uniquely named empty throwaway database. The name is
 * generated entirely by this helper, and only that database is dropped during
 * teardown.
 *
 * @param fn - receives the scratch database connection URL
 */
export async function withEmptyTestDatabase<T>(
	fn: (databaseUrl: string) => Promise<T>,
): Promise<T> {
	const dbName = `rw_migration_test_${randomUUID().replaceAll("-", "")}`;
	const admin = adminConnection();
	try {
		await admin.unsafe(`CREATE DATABASE ${dbName}`);
	} finally {
		await admin.end();
	}

	try {
		return await fn(scratchUrl(dbName));
	} finally {
		const cleanup = adminConnection();
		try {
			await cleanup.unsafe(`DROP DATABASE ${dbName} WITH (FORCE)`);
		} finally {
			await cleanup.end();
		}
	}
}

/**
 * Run `fn` against a fresh, migrated throwaway database. The database is always
 * dropped afterward, even on failure. Returns whatever `fn` returns.
 *
 * @param fn - receives a Drizzle client bound to the scratch database
 */
export async function withTestDb<T>(
	fn: (db: ReturnType<typeof drizzle<typeof schema>>) => Promise<T>,
): Promise<T> {
	counter += 1;
	const dbName = `rw_test_${process.pid}_${counter}`;

	await ensureTemplateDatabase();

	const admin = adminConnection();
	try {
		await admin.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
		await cloneFromTemplate(admin, dbName);
	} finally {
		await admin.end();
	}

	const url = scratchUrl(dbName);
	const client = new SQL(url);
	const db = drizzle(client, { schema });
	try {
		return await fn(db);
	} finally {
		await client.end();
		const cleanup = adminConnection();
		await cleanup.unsafe(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
		await cleanup.end();
	}
}
