/**
 * @module tests/db/client
 * @description Proves `createDb` binds the Postgres client with bounded
 *   timeouts. Postgres was the one outbound call with
 *   no explicit bound; a wedged database could block the reconcile loop, the
 *   status query, and the doctor probe indefinitely. These tests run against
 *   the local PostgreSQL server (127.0.0.1:5432) and assert the two things a
 *   consumer actually depends on: the server-side `statement_timeout` is set to
 *   the configured value, and a query that exceeds it is genuinely aborted.
 *
 * @dependencies
 *   - ../../src/db/client -- the factory under test
 *   - drizzle-orm -- the bounded probe queries
 */

import { afterEach, describe, expect, test } from "bun:test";
import { SQL } from "bun";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sql";
import { createDb } from "../../src/db/client";
import { resolveAdminUrl } from "./helpers";

// Resolved through the SHARED resolver, not a private default. This file
// previously inlined `?? "postgres://127.0.0.1:5432/postgres"`, which read the
// env override but skipped step 2 of the precedence — the machine config at
// `~/.config/software-factory/test-db.json`. On a workstation that has that
// config precisely so test churn stays OFF the local instance, these two tests
// were the only thing in the suite still dialling loopback, and they failed at
// connect while every other db test passed against the configured target.
// The sandbox case is unchanged: no env and no config file still
// falls through to the local default, which is what the receipt gate needs.
const LOCAL_URL = resolveAdminUrl(process.env);

describe("createDb bounded timeouts", () => {
	let open: ReturnType<typeof createDb> | undefined;

	afterEach(async () => {
		await open?.client.end();
		open = undefined;
	});

	test("applies the production statement_timeout to the connection", async () => {
		open = createDb(LOCAL_URL);
		const rows = await open.db.execute<{ statement_timeout: string }>(sql`SHOW statement_timeout`);
		// createDb sets STATEMENT_TIMEOUT_MS = 30_000; Postgres reports it as "30s".
		expect(rows[0]?.statement_timeout).toBe("30s");
	});

	test("aborts a query that exceeds statement_timeout", async () => {
		// Exercise the SAME mechanism createDb installs — a server-side
		// `statement_timeout` set through Bun's per-connection `connection`
		// config, queried through the same drizzle surface — but at 100ms so the
		// abort proof runs in well under a second instead of waiting on the
		// production 30s. Proves a query wedged after connect is genuinely
		// cancelled, which connect/pool bounds cannot do. (Bun's SQLState-carrying
		// error is re-wrapped by drizzle-orm as "Failed query: ...", so this
		// asserts rejection rather than matching the raw "statement timeout" text.)
		const client = new SQL(LOCAL_URL, {
			connection: { statement_timeout: "100" },
		});
		const bounded = drizzle(client);
		try {
			await bounded.execute(sql`SELECT pg_sleep(2)`);
			throw new Error("expected statement_timeout to cancel pg_sleep");
		} catch (error) {
			// Drizzle preserves Bun's PostgresError as `cause`. Bun exposes the
			// PostgreSQL SQLSTATE as `errno`; 57014 is query_canceled, so unrelated
			// connection/auth/syntax failures cannot pass here.
			expect((error as { cause?: { errno?: string } }).cause?.errno).toBe("57014");
		} finally {
			await client.end();
		}
	});
});
