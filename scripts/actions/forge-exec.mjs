/**
 * @module scripts/actions/forge-exec
 * @description Perform a COMPUTED Forge write plan, and nothing else (D25: a job that
 *   holds a credential runs no repository code). The credential job runs only this file, later
 *   embedded byte-for-byte as `node --input-type=module -e`, so it imports nothing from the repo
 *   or a package: Node built-ins and global `fetch` only.
 *
 *   Mirrors `postForge` (forge-write.ts, PR #684): 5xx, 408/425/429 or a lost response is re-asked
 *   on its fixed backoff, other 4xx is final, each attempt has a deadline that covers the body, and
 *   BEFORE every retry the probe reads the forge back so a lost response never posts twice. The
 *   probe answers landed, absent or unknown; only absent re-posts, and unknown waits and asks again
 *   (it never counts as absent). `probe: null` gets ONE attempt. The whole plan is checked before
 *   anything is sent.
 *
 * @inputs env `API` (base, no trailing slash), `REPO` (owner/name), `TOKEN`, `PLAN_FILE`
 *   (`{"v":1,"writes":[{"path","body","probe"}]}`); test seams `FORGE_WRITE_BACKOFF_MS`,
 *   `FORGE_WRITE_ATTEMPT_TIMEOUT_MS` (ignored unless a non-negative integer).
 * @outputs stdout one JSON line per write `{"path","ok","status","attempt","reason"}`; stderr
 *   diagnostics, never the token or a body; exit 0 all ok, 1 a write failed (run stops), 2 plan
 *   refused or env missing (nothing sent).
 */
import { readFileSync } from "node:fs";

/** The schedule, copied from forge-write.ts: 20 x 30 s outlasts the measured 8m42s quiesce. */
const FORGE_WRITE_ATTEMPTS = 20;
const FORGE_WRITE_BACKOFF_MS = 30_000;
const FORGE_WRITE_ATTEMPT_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 262_144;
const MAX_WRITES = 50;
/** A comment probe lists rows created from this long before the first attempt. */
const PROBE_SINCE_SLACK_MS = 5_000;
/** A paged probe reads this many rows a page and at most this many pages, else it is unknown. */
const PROBE_PAGE_ROWS = 50;
const PROBE_MAX_PAGES = 20;

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const API_RE = /^https?:\/\/[^\s/?#]+(\/[^\s?#]*)?$/;
const SUFFIX_RE =
	/^(?:issues\/([1-9][0-9]{0,15})\/(comments|labels)|statuses\/([0-9a-f]{40})|pulls)$/;

const str = (v) => typeof v === "string" && v.length > 0;
const issue = (v) => Number.isSafeInteger(v) && v > 0;

/** Per probe kind: the write it guards, its fields, its list (paged unless `paged: false`), and
 * when the list proves it landed. A status row carries its state as `status`, not `state`
 * (Forgejo CommitStatus JSON). */
const PROBES = {
	comment: {
		write: "comments",
		fields: { issue, marker: str },
		list: (p, since) => `issues/${p.issue}/comments?since=${encodeURIComponent(since)}`,
		landed: (rows, p) => rows.some((r) => typeof r?.body === "string" && r.body.includes(p.marker)),
	},
	/** Landed only on a comment whose trimmed body EQUALS the planned one; a comment that merely
	 * contains it (a quote, a longer reply) is a different comment and must not suppress a retry. */
	identical_comment: {
		write: "comments",
		fields: { issue, body: str },
		list: (p, since) => `issues/${p.issue}/comments?since=${encodeURIComponent(since)}`,
		landed: (rows, p) =>
			rows.some((r) => typeof r?.body === "string" && r.body.trim() === p.body.trim()),
	},
	status: {
		write: "statuses",
		fields: { sha: str, context: str, target_url: str, state: str },
		list: (p) => `commits/${p.sha}/statuses`,
		landed: (rows, p) =>
			rows.some(
				(r) => r?.context === p.context && r?.target_url === p.target_url && r?.status === p.state,
			),
	},
	labels: {
		write: "labels",
		fields: { issue, names: (v) => Array.isArray(v) && v.length > 0 && v.every(str) },
		list: (p) => `issues/${p.issue}/labels`,
		paged: false,
		landed: (rows, p) => p.names.every((n) => rows.some((r) => r?.name === n)),
	},
	pull: {
		write: "pulls",
		fields: { head: str },
		list: () => "pulls?state=open",
		landed: (rows, p) => rows.some((r) => r?.head?.ref === p.head),
	},
};

class Refusal extends Error {}

const diag = (line) => void process.stderr.write(`forge-exec: ${line}\n`);
const isObject = (v) => typeof v === "object" && v !== null && !Array.isArray(v);

function exactKeys(obj, keys, where) {
	for (const k of Object.keys(obj))
		if (!keys.includes(k)) throw new Refusal(`${where}: unknown key ${k}`);
	for (const k of keys) if (!Object.hasOwn(obj, k)) throw new Refusal(`${where}.${k}: missing`);
}

function seam(name, fallback) {
	const n = Number(process.env[name]?.trim() || Number.NaN);
	return Number.isInteger(n) && n >= 0 ? n : fallback;
}

function readEnv() {
	const env = {};
	for (const name of ["API", "REPO", "TOKEN", "PLAN_FILE"]) {
		if (!process.env[name]) throw new Refusal(`environment ${name} is missing`);
		env[name] = process.env[name];
	}
	if (!API_RE.test(env.API) || env.API.endsWith("/")) throw new Refusal("API is not a base URL");
	if (!REPO_RE.test(env.REPO)) throw new Refusal("REPO is not owner/name");
	if (/\s/.test(env.TOKEN)) throw new Refusal("TOKEN carries whitespace");
	return env;
}

/** One write: an allowlisted path under /repos/$REPO/, a bounded body, a matching probe. */
function checkWrite(write, repo, where) {
	if (!isObject(write)) throw new Refusal(`${where}: must be an object`);
	exactKeys(write, ["path", "body", "probe"], where);
	const prefix = `/repos/${repo}/`;
	const m =
		typeof write.path === "string" && write.path.startsWith(prefix)
			? SUFFIX_RE.exec(write.path.slice(prefix.length))
			: null;
	if (!m) throw new Refusal(`${where}.path: not an allowlisted endpoint under /repos/$REPO/`);
	const kind = m[2] ?? (m[3] ? "statuses" : "pulls");
	if (!isObject(write.body)) throw new Refusal(`${where}.body: must be an object`);
	const body = JSON.stringify(write.body);
	if (Buffer.byteLength(body) > MAX_BODY_BYTES) throw new Refusal(`${where}.body: too large`);
	const p = write.probe;
	if (p !== null) {
		if (!isObject(p) || !Object.hasOwn(PROBES, p.kind))
			throw new Refusal(`${where}.probe: unknown`);
		const spec = PROBES[p.kind];
		exactKeys(p, ["kind", ...Object.keys(spec.fields)], `${where}.probe`);
		for (const [k, ok] of Object.entries(spec.fields)) {
			if (!ok(p[k])) throw new Refusal(`${where}.probe.${k}: invalid`);
		}
		if (spec.write !== kind) throw new Refusal(`${where}.probe: cannot guard a ${kind} write`);
		const same = String(p.issue ?? m[1]) === String(m[1]) && (p.sha ?? m[3]) === m[3];
		if (!same) throw new Refusal(`${where}.probe: names another issue or sha than its write`);
	}
	return { path: write.path, body, probe: p };
}

function checkPlan(plan, repo) {
	if (!isObject(plan)) throw new Refusal("plan: must be a JSON object");
	exactKeys(plan, ["v", "writes"], "plan");
	if (plan.v !== 1) throw new Refusal("plan.v: must be 1");
	const w = plan.writes;
	if (!Array.isArray(w) || w.length === 0 || w.length > MAX_WRITES) {
		throw new Refusal(`plan.writes: must hold 1 to ${MAX_WRITES} writes`);
	}
	return w.map((write, i) => checkWrite(write, repo, `writes[${i}]`));
}

const reasonFor = (e) => (e instanceof Error ? `${e.name}: ${e.message}` : String(e)).slice(0, 200);
const isRetryable = (s) => s === 408 || s === 425 || s === 429 || s >= 500;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One request under one deadline that also covers reading the body; a thrown fetch, a stalled
 * body, or the deadline is `thrown`. The body is returned for a probe to parse, never logged. */
async function requestOnce(url, init, timeoutMs) {
	const controller = new AbortController();
	const timer = setTimeout(
		() => controller.abort(new Error(`attempt timed out after ${timeoutMs} ms`)),
		timeoutMs,
	);
	try {
		const res = await fetch(url, { ...init, redirect: "error", signal: controller.signal });
		const text = await res.text();
		return { kind: "response", status: res.status, ok: res.ok, text };
	} catch (error) {
		return { kind: "thrown", reason: reasonFor(controller.signal.reason ?? error) };
	} finally {
		clearTimeout(timer);
	}
}

/** One page of a probe list: an array of rows, or a thrown Error saying why it is unreadable. */
async function readRows(url, ctx) {
	const out = await requestOnce(url, { method: "GET", headers: ctx.headers }, ctx.timeoutMs);
	if (out.kind === "thrown") throw new Error(out.reason);
	if (!out.ok) throw new Error(`http ${out.status}`);
	const rows = JSON.parse(out.text);
	if (!Array.isArray(rows)) throw new Error("not a JSON array");
	return rows;
}

/** Did the write land? "landed", "absent", or "unknown" when the forge could not say: a page that
 * fails to read, or more than PROBE_MAX_PAGES full pages. Unknown is never treated as absent. */
async function probeWrite(write, ctx) {
	if (write.probe === null) return "absent";
	const spec = PROBES[write.probe.kind];
	const base = `${ctx.API}/repos/${ctx.REPO}/${spec.list(write.probe, ctx.since)}`;
	const paged = spec.paged !== false;
	try {
		for (let page = 1; page <= (paged ? PROBE_MAX_PAGES : 1); page += 1) {
			const sep = base.includes("?") ? "&" : "?";
			const url = paged ? `${base}${sep}limit=${PROBE_PAGE_ROWS}&page=${page}` : base;
			const rows = await readRows(url, ctx);
			if (spec.landed(rows, write.probe)) return "landed";
			if (!paged || rows.length < PROBE_PAGE_ROWS) return "absent";
		}
		diag(`${write.path}: probe list ran past ${PROBE_MAX_PAGES} pages`);
	} catch (error) {
		diag(`${write.path}: could not ask whether it landed (${reasonFor(error)})`);
	}
	return "unknown";
}

/** One write with postForge's retry-and-probe schedule. */
async function performWrite(write, env, schedule) {
	const headers = {
		Authorization: `token ${env.TOKEN}`,
		"Content-Type": "application/json",
	};
	const since = new Date(Date.now() - PROBE_SINCE_SLACK_MS).toISOString();
	const ctx = { ...env, ...schedule, headers, since };
	const attempts = write.probe === null ? 1 : schedule.attempts;
	let status = 0;
	let reason = "no attempt was made";
	let posted = 0; // the attempt of the last POST
	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		if (posted > 0) {
			// A retry asks first: a response lost AFTER the forge stored the write must not post twice.
			const answer = await probeWrite(write, ctx);
			if (answer === "landed") {
				diag(`${write.path} landed on attempt ${posted} after all; not re-asked`);
				return { ok: true, status, attempt: posted, reason: "already applied" };
			}
			if (answer === "unknown") {
				if (attempt === attempts) break;
				diag(`${write.path} attempt ${attempt}/${attempts}: probe inconclusive; not re-posted`);
				await sleep(schedule.backoffMs);
				continue;
			}
		}
		posted = attempt;
		const init = { method: "POST", headers, body: write.body };
		const out = await requestOnce(`${env.API}${write.path}`, init, schedule.timeoutMs);
		const retryable = out.kind === "thrown" || isRetryable(out.status);
		if (out.kind === "response" && out.ok)
			return { ok: true, status: out.status, attempt, reason: "" };
		status = out.kind === "response" ? out.status : 0;
		reason = out.kind === "response" ? `http ${status}` : out.reason;
		if (!retryable || attempt === attempts) {
			// A lost FINAL response is probed once more; unknown is a failure.
			const answer = retryable ? await probeWrite(write, ctx) : "absent";
			if (answer === "landed") return { ok: true, status, attempt, reason: "already applied" };
			if (answer === "unknown") break;
			diag(`${write.path} failed after ${attempt} attempts: ${reason}`);
			return { ok: false, status, attempt, reason };
		}
		diag(`${write.path} attempt ${attempt}/${attempts} failed (${reason}); retrying`);
		await sleep(schedule.backoffMs);
	}
	diag(`${write.path} failed: probe inconclusive after ${attempts} attempts (last: ${reason})`);
	return { ok: false, status, attempt: attempts, reason: "probe inconclusive" };
}

async function main() {
	let env;
	let writes;
	try {
		env = readEnv();
		let plan;
		try {
			plan = JSON.parse(readFileSync(env.PLAN_FILE, "utf8"));
		} catch (error) {
			throw new Refusal(`PLAN_FILE unreadable or not JSON (${reasonFor(error)})`);
		}
		writes = checkPlan(plan, env.REPO);
	} catch (error) {
		if (!(error instanceof Refusal)) throw error;
		diag(`refused, nothing sent: ${error.message}`);
		return 2;
	}
	const schedule = {
		attempts: FORGE_WRITE_ATTEMPTS,
		backoffMs: seam("FORGE_WRITE_BACKOFF_MS", FORGE_WRITE_BACKOFF_MS),
		timeoutMs: seam("FORGE_WRITE_ATTEMPT_TIMEOUT_MS", FORGE_WRITE_ATTEMPT_TIMEOUT_MS),
	};
	for (const write of writes) {
		const { ok, status, attempt, reason } = await performWrite(write, env, schedule);
		process.stdout.write(`${JSON.stringify({ path: write.path, ok, status, attempt, reason })}\n`);
		if (!ok) return 1;
	}
	return 0;
}

process.exitCode = await main();
