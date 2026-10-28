/**
 * @module scripts/fh/actions-metrics
 * @description Mirror every Forgejo Actions run in this repo to one queryable
 *   JSONL line each — run, workflow, sha, event, status, start, wall — plus the
 *   pr-review verdict and engine attempt count where they exist.
 *
 *   WHY A MIRROR AND NOT A COMMENT. "Every workflow posts one line somewhere
 *   queryable" is the item, and a Forge comment is not a metric store: it is
 *   prose attached to one item, with no way to ask "how many pr-review runs
 *   took three engine attempts last week". Forgejo 16.0.1 exposes a per-run
 *   listing (`/actions/tasks`, probed live 2026-08-31: 200, with `run_number`,
 *   `head_sha`, `status`, `workflow_id`, `run_started_at`, `updated_at`) and NO
 *   job-log API at all, so wall time is computable from the run row while
 *   anything produced INSIDE a job is invisible from outside it. The commit
 *   status is the one durable, API-queryable write a job makes besides a
 *   comment, which is why `factory/pr-review` carries the verdict in its state
 *   and the attempt count in its description — this script reads them back out.
 *
 *   Runs of `issue-triage.yml` and `factory-smoke.yml` therefore carry no
 *   verdict and no attempts, and that is accepted rather than papered over:
 *   those lanes write no status of their own, and inventing a carrier for them
 *   is a change to those lanes, not to this reader.
 *
 *   SECRETS. The token arrives as `FORGEJO_TOKEN_FILE`, a PATH to a file — never
 *   the token itself, because argv is world-readable in `ps`. It reaches the
 *   `Authorization` header and nothing else: no URL, no log line, no output row.
 *
 * @outputs
 *   - `wallSeconds` -- start/end ISO strings -> whole seconds, null when unusable
 *   - `attemptsOf` -- a status description -> the `(attempts=N)` count or null
 *   - `verdictOf` -- a `factory/pr-review` status -> approve | fix-first | error
 *   - `runNumberOf` -- a status target_url -> the run number it names, or null
 *   - `prReviewStatus` -- statuses (+ a run number) -> THAT run's status; a
 *     rerun on one sha writes two, so the join is per run, not per sha
 *   - `buildRow` -- one task row (+ its statuses) -> the emitted metric object
 *   - CLI: `bun scripts/fh/actions-metrics.ts [out.jsonl]`
 *     env `FORGEJO_TOKEN_FILE` (required), `FH_REPO`, `FH_API`.
 *     Default output `_reports/actions/runs.jsonl`. Exit 0 on success, 2 on a
 *     missing token file, 1 when the API refused.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/** The default forge API root. Overridden by `FH_API` for a probe against another host. */
export const DEFAULT_API = "https://forge.example.internal/api/v1";

/** The commit-status context the pr-review lane writes. */
export const PR_REVIEW_CONTEXT = "factory/pr-review";

/** The workflow whose runs carry a verdict and an attempt count. */
export const PR_REVIEW_WORKFLOW = "pr-review.yml";

/** The page size used when walking `/actions/tasks`. */
export const PAGE_SIZE = 50;

/** The fields of a task row this module actually reads. */
export type TaskRow = {
	run_number?: number;
	workflow_id?: string;
	head_sha?: string;
	event?: string;
	status?: string;
	run_started_at?: string;
	updated_at?: string;
};

/** The fields of a commit-status row this module actually reads. */
export type StatusRow = {
	context?: string;
	status?: string;
	description?: string;
	/** `.../actions/runs/<run_number>` — which RUN wrote this status. */
	target_url?: string;
	created_at?: string;
};

export type MetricRow = {
	run: number | null;
	workflow: string | null;
	sha: string | null;
	event: string | null;
	status: string | null;
	started: string | null;
	wall_s: number | null;
	verdict?: string | null;
	attempts?: number | null;
};

/**
 * Wall time in whole seconds.
 *
 * Returns null rather than 0 for anything unusable — a missing timestamp, an
 * unparseable one, or an end before the start — because 0 is a legitimate
 * measurement (a run that finished inside the same second) and using it as the
 * error value makes a broken row indistinguishable from a fast one.
 */
export function wallSeconds(start: unknown, end: unknown): number | null {
	if (typeof start !== "string" || typeof end !== "string") return null;
	const a = Date.parse(start);
	const b = Date.parse(end);
	if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
	if (b < a) return null;
	return Math.round((b - a) / 1000);
}

/**
 * The `(attempts=N)` suffix `describeStatus` appends, read back.
 *
 * Anchored to the END of the description so a review whose own text contains
 * the phrase cannot be mistaken for the suffix this factory wrote.
 */
export function attemptsOf(description: unknown): number | null {
	if (typeof description !== "string") return null;
	const match = /\(attempts=(\d+)\)\s*$/.exec(description);
	if (match === null) return null;
	const n = Number(match[1]);
	return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * The verdict a `factory/pr-review` status stands for.
 *
 * Derived from the STATE, not from the description text: the state is the
 * machine-readable half of the status and the one a required check binds to,
 * while the description is prose that has already changed shape once (this
 * change added a suffix to it). Forgejo names the state field `status` in its
 * commit-status rows — verified against the live API 2026-08-31 — which is why
 * this reads `status` and not `state`.
 */
export function verdictOf(row: StatusRow | undefined): string | null {
	if (row === undefined) return null;
	if (row.status === "success") return "approve";
	if (row.status === "failure") return "fix-first";
	if (row.status === "error") return "error";
	return null;
}

/**
 * The run number a status\'s `target_url` points at, or null.
 *
 * The workflow builds that URL as `.../actions/runs/${{ github.run_number }}`,
 * so the trailing path segment IS the run number — the one field on a commit
 * status that says which run wrote it.
 */
export function runNumberOf(targetUrl: unknown): number | null {
	if (typeof targetUrl !== "string") return null;
	const match = /\/actions\/runs\/(\d+)\/?$/.exec(targetUrl);
	if (match === null) return null;
	const n = Number(match[1]);
	return Number.isInteger(n) && n >= 0 ? n : null;
}

/**
 * The `factory/pr-review` status belonging to a given RUN, if it wrote one.
 *
 * A sha is not a run. Re-running the lane on an unchanged commit — the ordinary
 * case after a flaky engine call — writes a SECOND `factory/pr-review` status
 * on the same sha, and joining on sha alone gave both runs whichever one the
 * array happened to yield first: two rows, one verdict, one attempt count, and
 * no way to see that the rerun differed. The `target_url` names the
 * run, so it is the join key.
 *
 * FALLBACK, and why it is not just "the first match". Statuses written before
 * the target_url convention carry no run number, and a caller with no run
 * number at all (an ad-hoc query) still wants an answer. Both fall back to the
 * NEWEST status by `created_at` — the most recent state of the check is the
 * least wrong single answer — and to array order only when even that is absent,
 * since the forge returns newest first.
 */
export function prReviewStatus(
	statuses: readonly StatusRow[],
	runNumber?: number | null,
): StatusRow | undefined {
	const ours = statuses.filter((row) => row.context === PR_REVIEW_CONTEXT);
	if (ours.length === 0) return undefined;
	if (typeof runNumber === "number") {
		const exact = ours.find((row) => runNumberOf(row.target_url) === runNumber);
		if (exact !== undefined) return exact;
	}
	// Newest first. `Date.parse` of a missing or unparseable stamp is NaN, which
	// loses every comparison, so an undated row sorts to the back rather than
	// displacing a dated one.
	let newest = ours[0] as StatusRow;
	let newestAt = Number.NEGATIVE_INFINITY;
	for (const row of ours) {
		const at = Date.parse(row.created_at ?? "");
		if (Number.isFinite(at) && at > newestAt) {
			newestAt = at;
			newest = row;
		}
	}
	return newest;
}

/**
 * One task row (plus the commit statuses on its sha) as the emitted metric.
 *
 * `verdict` and `attempts` are present ONLY for pr-review runs. A triage or
 * smoke run omits the keys entirely rather than carrying explicit nulls, so a
 * consumer can tell "this lane does not report a verdict" apart from "this run
 * was supposed to and did not".
 */
export function buildRow(task: TaskRow, statuses: readonly StatusRow[]): MetricRow {
	const row: MetricRow = {
		run: typeof task.run_number === "number" ? task.run_number : null,
		workflow: typeof task.workflow_id === "string" ? task.workflow_id : null,
		sha: typeof task.head_sha === "string" ? task.head_sha : null,
		event: typeof task.event === "string" ? task.event : null,
		status: typeof task.status === "string" ? task.status : null,
		started: typeof task.run_started_at === "string" ? task.run_started_at : null,
		wall_s: wallSeconds(task.run_started_at, task.updated_at),
	};
	if (task.workflow_id !== PR_REVIEW_WORKFLOW) return row;
	const status = prReviewStatus(statuses, row.run);
	row.verdict = verdictOf(status);
	row.attempts = attemptsOf(status?.description);
	return row;
}

/** The JSONL body for a set of rows, one object per line and a trailing newline. */
export function renderJsonl(rows: readonly MetricRow[]): string {
	return rows.map((row) => JSON.stringify(row)).join("\n") + (rows.length > 0 ? "\n" : "");
}

if (import.meta.main) {
	const outPath = process.argv[2] ?? "_reports/actions/runs.jsonl";
	const tokenFile = process.env.FORGEJO_TOKEN_FILE;
	if (tokenFile === undefined || tokenFile === "") {
		process.stderr.write(
			"actions-metrics: FORGEJO_TOKEN_FILE is required (a PATH to the token, never the token itself)\n",
		);
		process.exit(2);
	}
	// Read once into memory. It reaches the Authorization header and nowhere else.
	const token = readFileSync(tokenFile, "utf8").trim();
	const api = process.env.FH_API ?? DEFAULT_API;
	const repo = process.env.FH_REPO ?? "rodaddy/software-factory";
	const headers = { Authorization: `token ${token}` };

	async function getJson(path: string): Promise<unknown> {
		const res = await fetch(`${api}${path}`, { headers });
		if (!res.ok) {
			// The status and the path only: neither carries the token.
			process.stderr.write(`actions-metrics: GET ${path} failed with ${res.status}\n`);
			process.exit(1);
		}
		return res.json();
	}

	const tasks: TaskRow[] = [];
	for (let page = 1; ; page += 1) {
		const body = await getJson(`/repos/${repo}/actions/tasks?limit=${PAGE_SIZE}&page=${page}`);
		const runs = (body as { workflow_runs?: unknown }).workflow_runs;
		if (!Array.isArray(runs) || runs.length === 0) break;
		tasks.push(...(runs as TaskRow[]));
	}

	// One statuses call per DISTINCT sha, not per run: a push and its pull
	// request produce several runs on the same commit, and the statuses on that
	// commit are the same set for all of them.
	const shas = new Set(
		tasks
			.filter((task) => task.workflow_id === PR_REVIEW_WORKFLOW)
			.flatMap((task) => (typeof task.head_sha === "string" ? [task.head_sha] : [])),
	);
	const statusesBySha = new Map<string, StatusRow[]>();
	for (const sha of shas) {
		// Probed live 2026-08-31: this route answers 200 on this forge.
		const body = await getJson(`/repos/${repo}/commits/${sha}/statuses`);
		statusesBySha.set(sha, Array.isArray(body) ? (body as StatusRow[]) : []);
	}

	const rows = tasks.map((task) => buildRow(task, statusesBySha.get(task.head_sha ?? "") ?? []));
	mkdirSync(dirname(outPath), { recursive: true });
	writeFileSync(outPath, renderJsonl(rows));
	process.stderr.write(`actions-metrics: ${rows.length} runs -> ${outPath}\n`);
}
