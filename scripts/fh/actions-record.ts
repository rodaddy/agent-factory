/**
 * @module scripts/fh/actions-record
 * @description Generate the run table for `_DOCS/forgejo-actions-record.md`
 *   from `GET /api/v1/repos/<owner>/<repo>/actions/tasks`, so the record is no
 *   longer hand-kept.
 *
 *   SECRETS. The token arrives as env `FORGEJO_TOKEN`, never argv. It reaches
 *   the `Authorization` header and nothing else.
 *
 * @outputs
 *   - `formatWall` -- start/end ISO strings -> `XmYYs`, `?` when unusable
 *   - `renderRecordTable` -- task rows + filters -> markdown table, newest first
 *   - CLI: `bun scripts/fh/actions-record.ts --repo <o/r> [--since <iso>]
 *     [--jobs a,b] [--pages N]`; env `FORGEJO_TOKEN` (required), `FH_API`.
 *     Exit 0 on success, 3 on a missing token, non-2xx, or malformed body.
 */
import { parseArgs } from "node:util";
import { traced } from "../../src/log";

const DEFAULT_API = "https://forge.example.internal/api/v1";
const PAGE_SIZE = 50;

/** The fields of a `/actions/tasks` row this module reads. */
export type RecordTask = {
	id?: number;
	name?: string;
	run_number?: number;
	status?: string;
	head_sha?: string;
	display_title?: string;
	created_at?: string;
	updated_at?: string;
	url?: string;
};

/** Filters for `renderRecordTable`. */
export type RecordOpts = { sinceIso?: string; jobs?: string[] };

const HEADER = "| run | task | job | sha7 | status | wall | title |\n|---|---|---|---|---|---|---|";

function formatWallImpl(start?: string, end?: string): string {
	const ms = Date.parse(end ?? "") - Date.parse(start ?? "");
	if (!Number.isFinite(ms) || ms < 0) return "?";
	const secs = Math.round(ms / 1000);
	return `${Math.floor(secs / 60)}m${String(secs % 60).padStart(2, "0")}s`;
}

export const formatWall = traced("fh.record.formatWall", formatWallImpl);

const cell = (v: unknown): string =>
	String(v ?? "")
		.replace(/\|/g, "\\|")
		.replace(/\n/g, " ");

function rowOf(t: RecordTask): string {
	const run = t.url ? `[${t.run_number ?? "?"}](${t.url})` : cell(t.run_number);
	const sha = cell(t.head_sha).slice(0, 7);
	const wall = formatWallImpl(t.created_at, t.updated_at);
	return `| ${run} | ${cell(t.id)} | ${cell(t.name)} | ${sha} | ${cell(t.status)} | ${wall} | ${cell(t.display_title)} |`;
}

function keep(t: RecordTask, opts: RecordOpts): boolean {
	if (opts.sinceIso && Date.parse(t.created_at ?? "") < Date.parse(opts.sinceIso)) return false;
	if (opts.sinceIso && !Number.isFinite(Date.parse(t.created_at ?? ""))) return false;
	return !opts.jobs || opts.jobs.length === 0 || opts.jobs.includes(t.name ?? "");
}

function renderRecordTableImpl(tasks: RecordTask[], opts: RecordOpts): string {
	const rows = tasks
		.filter((t) => keep(t, opts))
		.sort(
			(a, b) =>
				Date.parse(b.created_at ?? "") - Date.parse(a.created_at ?? "") ||
				(b.id ?? 0) - (a.id ?? 0),
		)
		.map(rowOf);
	return `${[HEADER, ...rows].join("\n")}\n`;
}

export const renderRecordTable = traced("fh.record.renderRecordTable", renderRecordTableImpl, {
	redact: { result: true },
});

class CliError extends Error {}

async function fetchPage(
	api: string,
	repo: string,
	token: string,
	page: number,
): Promise<RecordTask[]> {
	const res = await fetch(`${api}/repos/${repo}/actions/tasks?limit=${PAGE_SIZE}&page=${page}`, {
		headers: { Authorization: `token ${token}`, Accept: "application/json" },
	});
	if (!res.ok) throw new CliError(`GET actions/tasks page ${page}: HTTP ${res.status}`);
	const body = (await res.json().catch(() => null)) as { workflow_runs?: unknown } | null;
	if (!body || !Array.isArray(body.workflow_runs)) {
		throw new CliError(`GET actions/tasks page ${page}: body has no workflow_runs array`);
	}
	body.workflow_runs.forEach((entry, i) => {
		if (!isTask(entry))
			throw new CliError(`GET actions/tasks page ${page}: entry ${i} is malformed`);
	});
	return body.workflow_runs as RecordTask[];
}

const NUM_KEYS = ["id", "run_number"] as const;
const STR_KEYS = ["name", "status", "created_at", "updated_at", "url"] as const;
const OPT_STR_KEYS = ["head_sha", "display_title"] as const;

function isTask(v: unknown): v is RecordTask {
	if (typeof v !== "object" || v === null) return false;
	const o = v as Record<string, unknown>;
	return (
		NUM_KEYS.every((k) => typeof o[k] === "number") &&
		STR_KEYS.every((k) => typeof o[k] === "string") &&
		OPT_STR_KEYS.every((k) => o[k] === undefined || typeof o[k] === "string")
	);
}

async function main(): Promise<void> {
	const { values } = parseArgs({
		options: {
			repo: { type: "string" },
			since: { type: "string" },
			jobs: { type: "string" },
			pages: { type: "string" },
		},
	});
	const token = process.env.FORGEJO_TOKEN;
	if (!token) throw new CliError("FORGEJO_TOKEN is not set");
	if (!values.repo || !/^[\w.-]+\/[\w.-]+$/.test(values.repo))
		throw new CliError("--repo <owner/repo> required");
	// An unparseable cutoff would filter nothing and look like a real table.
	if (values.since !== undefined && !Number.isFinite(Date.parse(values.since)))
		throw new CliError(`--since ${values.since} is not an ISO date`);
	const pages = Math.max(1, Number.parseInt(values.pages ?? "4", 10) || 4);
	const api = process.env.FH_API ?? DEFAULT_API;
	const tasks: RecordTask[] = [];
	for (let p = 1; p <= pages; p++) {
		const batch = await fetchPage(api, values.repo, token, p);
		tasks.push(...batch);
		if (batch.length < PAGE_SIZE) break;
	}
	const jobs = values.jobs ? values.jobs.split(",").filter(Boolean) : undefined;
	process.stdout.write(renderRecordTableImpl(tasks, { sinceIso: values.since, jobs }));
}

if (import.meta.main) {
	main().catch((err: unknown) => {
		const msg = err instanceof Error ? err.message : String(err);
		process.stderr.write(`actions-record: ${msg.split("\n")[0]}\n`);
		process.exitCode = 3;
	});
}
