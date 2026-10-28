/**
 * @module db/validate-connection
 * @description Thin validation for PostgreSQL connection strings, mirroring the
 *   client-core house pattern. Ensures the URL uses a recognized postgres
 *   protocol and warns (non-breaking) when SSL is not configured in
 *   production. Intentionally does not echo the connection string.
 */

import { errorClass, log, traced } from "../log";

const VALID_PROTOCOLS = ["postgresql:", "postgres:"];

/**
 * Validate a PostgreSQL connection string.
 *
 * - Throws if the URL is not parseable or does not use a postgres protocol.
 * - Warns to stderr when `NODE_ENV=production` lacks an SSL parameter.
 *
 * The SSL check is a warning, not an error, to avoid disrupting local dev.
 */
function validateConnectionStringImpl(connectionString: string): void {
	let url: URL;
	try {
		url = new URL(connectionString);
	} catch (err) {
		// Class only, never the message: a URL parse error can quote the connection
		// string it failed on, password and all.
		log("error", "db.connection_string.unparseable", { error_class: errorClass(err) });
		throw new Error(
			"Invalid database connection string: not a valid URL. " +
				"Expected postgresql:// or postgres:// prefix.",
		);
	}

	if (!VALID_PROTOCOLS.includes(url.protocol)) {
		throw new Error(
			`Invalid database connection string protocol "${url.protocol}". ` +
				"Expected postgresql:// or postgres://.",
		);
	}

	if (process.env.NODE_ENV === "production") {
		const hasSSL =
			url.searchParams.has("ssl") ||
			url.searchParams.has("sslmode") ||
			connectionString.includes("sslmode=");
		if (!hasSSL) {
			// App logging, not CLI UX: a degraded/guard path (SSL absent in
			// production) is a warning line, not a bare stderr write. The
			// connection string is never included — the same no-secrets contract
			// as the unparseable branch above.
			log("warn", "db.connection_string.no_ssl_in_production", {
				remediation: "add ?sslmode=require",
			});
		}
	}
}

export const validateConnectionString = traced(
	"db.validateConnectionString",
	validateConnectionStringImpl,
);
