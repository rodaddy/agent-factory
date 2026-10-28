/**
 * @module drizzle.config
 * @description Drizzle Kit configuration for the watcher. Points at the single
 *   schema source (`src/db/schema.ts`) and emits generated migrations to
 *   `drizzle/`. The connection string is read from `DATABASE_URL` at run time;
 *   no host or credential is committed. See _DOCS/db-protocol.md for the
 *   phase-gated push/generate policy.
 *
 * @dependencies
 *   - drizzle-kit -- defineConfig
 */
import { defineConfig } from "drizzle-kit";

export default defineConfig({
	dialect: "postgresql",
	schema: "./src/db/schema.ts",
	out: "./drizzle",
	dbCredentials: {
		url: process.env.DATABASE_URL ?? "",
	},
	strict: true,
	verbose: true,
});
