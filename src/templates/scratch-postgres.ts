/**
 * @module templates/scratch-postgres
 * @description The ONE definition of the job-local scratch PostgreSQL cluster a
 *   lane brings up so this repository's database-backed tests can run on a runner
 *   box. Two lanes render it: the exact-SHA receipt body
 *   (`prepush/body-sections.ts`, inside its bwrap sandbox script) and the
 *   implement body (`templates/registry.ts`, in the agent's own shell).
 *
 *   IT IS SHARED SO THE TWO CANNOT DRIFT. The receipt lane had these
 *   lines and the implement lane had none, so every implement job failed the 542
 *   database-backed tests — "the runner PostgreSQL service rejected authentication
 *   for the available local roles" — and no PR ever opened. Copying the block
 *   would have re-created the same divergence one constant change later.
 *
 *   The registry selects this block for the exact `rodaddy/software-factory`
 *   repository identity. Other consumers retain generic dependency installation
 *   without this repository-specific database setup.
 *
 *   Every value is an author literal — port, data dir, socket dir, and bindir all
 *   default to the reviewed `prepush/body-constants` values and are never sourced
 *   from repository content, config, or runner output.
 *
 * @outputs
 *   - `ScratchPostgresPaths` -- the job-local locations the cluster uses
 *   - `scratchPostgresLines` -- the initdb/pg_ctl/trap lines, indented as asked
 *
 * @dependencies
 *   - ../prepush/body-constants -- the fixed port/data/sock/bindir literals. That
 *     module is a leaf over author constants, so this stays a leaf too.
 *   - ../log -- `traced`, per this repo's exported-function tracing convention
 */
import { traced } from "../log";
import {
	PREPUSH_RUNNER_PG_BINDIR,
	PREPUSH_RUNNER_PG_DATA,
	PREPUSH_RUNNER_PG_PORT,
	PREPUSH_RUNNER_PG_SOCK,
} from "../prepush/body-constants";

/** The job-local cluster locations, defaulted to the reviewed fixed literals. */
export interface ScratchPostgresPaths {
	/** The cluster data directory (the receipt suffixes the job id onto it). */
	pgData?: string;
	/** The unix socket directory (likewise job-suffixed by the receipt). */
	pgSock?: string;
	/** The loopback port the cluster listens on. */
	port?: string;
	/** The directory holding the PostgreSQL 18 server binaries. */
	bindir?: string;
}

/**
 * The bring-up/stop lines for the scratch cluster: create the data dir once with
 * trust auth for a `postgres` superuser, start it on loopback only, and stop it
 * from an EXIT trap so it never leaks past the command that needed it.
 *
 * `indent` is prefixed to every line so a caller can place the block inside a
 * fenced code block at its own depth; the receipt renders it at three spaces.
 */
export const scratchPostgresLines = traced(
	"templates.scratchPostgresLines",
	function scratchPostgresLines(paths: ScratchPostgresPaths = {}, indent = ""): string[] {
		const pgData = paths.pgData ?? PREPUSH_RUNNER_PG_DATA;
		const pgSock = paths.pgSock ?? PREPUSH_RUNNER_PG_SOCK;
		const port = paths.port ?? PREPUSH_RUNNER_PG_PORT;
		const bindir = paths.bindir ?? PREPUSH_RUNNER_PG_BINDIR;
		return [
			`if [ ! -f ${pgData}/PG_VERSION ]; then`,
			`  ${bindir}/initdb -D ${pgData} \\`,
			"    --auth=trust --username=postgres >/dev/null",
			"fi",
			`${bindir}/pg_ctl -D ${pgData} \\`,
			`  -o "-p ${port} -k ${pgSock} \\`,
			"    -c listen_addresses=127.0.0.1" + '" \\',
			"  -w start",
			`trap '${bindir}/pg_ctl -D ${pgData} \\`,
			"  -m immediate -w stop' EXIT",
		].map((line) => `${indent}${line}`);
	},
);

/** The directories initdb and the socket need, created before the bring-up. */
export const scratchPostgresMkdirLine = traced(
	"templates.scratchPostgresMkdirLine",
	function scratchPostgresMkdirLine(paths: ScratchPostgresPaths = {}): string {
		const pgData = paths.pgData ?? PREPUSH_RUNNER_PG_DATA;
		const pgSock = paths.pgSock ?? PREPUSH_RUNNER_PG_SOCK;
		return `mkdir -p ${pgData} ${pgSock}`;
	},
);

/** The connection URL the checks read, for a cluster on the given port. */
export const scratchPostgresUrl = traced(
	"templates.scratchPostgresUrl",
	function scratchPostgresUrl(port: string = PREPUSH_RUNNER_PG_PORT): string {
		return `postgres://postgres@127.0.0.1:${port}/postgres`;
	},
);
