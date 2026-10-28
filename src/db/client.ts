/**
 * @module db/client
 * @description Database connection factory for the watcher. Structure lives in
 *   `schema.ts`; this module only wires Drizzle onto the built-in Bun.sql
 *   driver. The connection string comes from the environment (`DATABASE_URL`)
 *   and is never committed. Locally it points at the Homebrew PostgreSQL
 *   server; in production it points at the LXC PostgreSQL host supplied by the
 *   deployment environment, not this repository.
 *
 * @outputs
 *   - `resolveDatabaseUrl` -- read and require DATABASE_URL from the environment
 *   - `createDb` -- build a validated Drizzle client bound to Bun.sql
 *   - `WatcherDb` -- Drizzle database type for consumers
 *
 * @dependencies
 *   - bun (SQL) -- built-in PostgreSQL driver
 *   - drizzle-orm/bun-sql -- Drizzle adapter for Bun.sql
 *   - ./validate-connection -- protocol/SSL validation
 *   - ./schema -- table definitions
 */
import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import { traced } from "../log";
import * as schema from "./schema";
import { validateConnectionString } from "./validate-connection";

/**
 * Resolve the connection string from the environment. Fails loudly with a
 * bounded message (no value echoed) when it is absent.
 */
function resolveDatabaseUrlImpl(env: NodeJS.ProcessEnv = process.env): string {
	const url = env.DATABASE_URL?.trim();
	if (!url) {
		throw new Error(
			"DATABASE_URL is not set. Provide it through the environment; " +
				"never commit database credentials.",
		);
	}
	return url;
}

export const resolveDatabaseUrl = traced("db.resolveDatabaseUrl", resolveDatabaseUrlImpl, {
	redact: { args: [0], result: true },
});

/**
 * Bounded timeouts for the Postgres client. Postgres is the one outbound call
 * that was previously unbounded, so a wedged database could block the
 * single-flight reconcile loop, the status query, and the doctor `SELECT 1`
 * indefinitely. GitHub calls (10s AbortController) and the runner transport
 * (90s wall-clock) are already bounded; these mirror that house style with
 * small fixed constants. No retry/pool machinery — this is a single-operator
 * service.
 *
 * Each option bounds a *different* failure mode; they are not interchangeable:
 *   - CONNECT_TIMEOUT bounds establishing a TCP/handshake connection only.
 *   - POOL_WAIT_TIMEOUT bounds waiting for a pooled connection to free up
 *     (Bun's `idleTimeout`; default 0 = unbounded — a real gap to close).
 *   - STATEMENT_TIMEOUT bounds a query that hangs *after* a connection is
 *     established (a wedged mid-flight query). CONNECT/POOL bounds do NOT
 *     cover this; only the Postgres server-side `statement_timeout` does.
 */
/** Bound establishing a connection (seconds). Bun `connectionTimeout`. */
const CONNECT_TIMEOUT_SECONDS = 10;
/** Bound waiting for a pooled connection to become available (seconds). Bun `idleTimeout`. */
const POOL_WAIT_TIMEOUT_SECONDS = 10;
/**
 * Bound a query already in flight (milliseconds). Applied server-side via the
 * Postgres `statement_timeout` runtime parameter, set per connection through
 * Bun's `connection` config. Generous over any legitimate query but finite so a
 * wedged query cannot block a reconcile pass forever.
 */
const STATEMENT_TIMEOUT_MS = 30_000;

/** Build a Drizzle client bound to Bun.sql for the given connection string. */
function createDbImpl(connectionString: string = resolveDatabaseUrl()) {
	validateConnectionString(connectionString);
	const client = new SQL(connectionString, {
		connectionTimeout: CONNECT_TIMEOUT_SECONDS,
		idleTimeout: POOL_WAIT_TIMEOUT_SECONDS,
		// Postgres server-side statement_timeout (ms as a string per PG config).
		// This is the only bound that covers a query hung after connect.
		connection: { statement_timeout: String(STATEMENT_TIMEOUT_MS) },
	});
	return { db: drizzle(client, { schema }), client };
}

export const createDb = traced("db.createDb", createDbImpl);

export type WatcherDb = ReturnType<typeof createDb>["db"];
