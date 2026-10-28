// forge-op: `forge find` and `forge op`, every Forgejo operation in the server's own swagger spec, which
// `forge api` also maps every path to. No operation is refused for being risky: the session token is the
// boundary. Three operations redirect, in op and api alike, to the forge verb that applies
// their bar. https://forge.example.internal/rodaddy/development/issues/992
// The spec is cached at ~/.cache/forge/swagger.v1.json and refreshed after 24 h; it is never committed.

import { createWriteStream, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import * as PAGES from "./forge-op-pages.mjs";

export { preflight } from "./forge-op-pages.mjs";

export const HOST = "https://forge.example.internal";
export const API = `${HOST}/api/v1`;
export class Usage extends Error {}
export class Http extends Error {}
const DAY = 24 * 3600 * 1000;
// Expected misses (a non-JSON reply, an unreadable optional file) are logged only under FORGE_DEBUG.
const log = { debug: (...a) => process.env.FORGE_DEBUG && process.stderr.write(`forge: debug: ${a.join(" ")}\n`) };
const parseJson = (text) => {
	try {
		return JSON.parse(text);
	} catch (err) {
		log.debug("not JSON:", err.message);
		return undefined;
	}
};

/** operationId -> the forge verb to use instead, because that verb applies a check the raw call skips. */
export const REDIRECT = {
	repoCreatePullRequest: "open PRs with 'forge pr create', which applies the PR bar",
	repoMergePullRequest: "merge with 'forge pr merge <repo> <n> --sha <head>', which pins the checked head",
	repoEditPullRequest: "edit a PR with 'forge pr edit', which checks a new body's Local review, or 'forge pr retarget|close|reopen'",
	issueEditIssue: "edit an issue with 'forge issue edit', which checks a new body's Local review when the issue is a PR, or 'forge issue close|reopen'",
};
const CHECKS = new Set(["orgIsMember", "orgIsPublicMember", "userCurrentCheckFollowing", "userCheckFollowing",
	"userCurrentCheckStarring"]);
// --anon: GETs (and the three render POSTs) under these public misc paths; everything else needs the token.
const ANON_POSTS = new Set(["renderMarkdown", "renderMarkdownRaw", "renderMarkup"]);
const ANON_PATHS = ["/version", "/settings/", "/markdown", "/markup", "/gitignore/", "/licenses", "/label/templates",
	"/nodeinfo", "/signing-key"];
// Path params that may hold a `/`, matched across segments when `forge api` maps a path to its operation.
const SLASHY = new Set(["filepath", "archive", "ref", "branch", "tag", "pageName", "basehead"]);

/** A path param, encoded: per `/` segment when it may hold one, else whole; an empty, . or .. segment
 * is a usage error, because fetch would resolve it to another endpoint. */
export function segments(name, value, slashy) {
	const parts = slashy ? String(value).split("/") : [String(value)];
	if (parts.some((p) => p === "" || p === "." || p === "..")) throw new Usage(`${name} must not be or hold an empty, . or .. segment, got '${value}'`);
	return parts.map(encodeURIComponent).join("/");
}

const mtimeOf =(file) => statSync(file, { throwIfNoEntry: false })?.mtimeMs;

async function fetchSpec(dir, file, fetch, now) {
	const get = async (url) => {
		const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
		if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
		return res.text();
	};
	const text = await get(`${HOST}/swagger.v1.json`);
	const spec = parseJson(text);
	if (!spec?.paths) throw new Error("the downloaded spec has no paths");
	let max = 50; // unauthenticated, like the spec itself; 50 when it is not readable
	try {
		max = parseJson(await get(`${API}/settings/api`))?.max_response_items || 50;
	} catch (err) {
		log.debug("settings/api unreadable, page size 50:", err.message);
	}
	mkdirSync(dir, { recursive: true });
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, text);
	renameSync(tmp, file);
	const meta = { fetched_at: new Date(now).toISOString(), version: spec.info?.version, max_response_items: max };
	writeFileSync(join(dir, "meta.json"), JSON.stringify(meta));
}

/** {spec, meta}: FORGE_SPEC_PATH when set, else the cache, refreshed when missing, forced or older than 24 h. */
export async function loadSpec({ env = {}, fetch, stderr, now = Date.now(), refresh = false }) {
	if (env.FORGE_SPEC_PATH) return { spec: JSON.parse(readFileSync(env.FORGE_SPEC_PATH, "utf8")), meta: {} };
	const dir = join(env.HOME ?? homedir(), ".cache", "forge");
	const file = join(dir, "swagger.v1.json");
	const mtime = mtimeOf(file);
	if (refresh || mtime === undefined || now - mtime > DAY) {
		try {
			await fetchSpec(dir, file, fetch, now);
		} catch (err) {
			const why = err?.cause?.code ?? err?.message ?? "error";
			if (mtime === undefined) throw new Usage(`no cached spec at ${file} and the refresh failed: ${why}`);
			stderr(`forge: warning: spec refresh failed (${why}); using the copy from ${new Date(mtime).toISOString()}`);
		}
	}
	let meta = {};
	try {
		meta = JSON.parse(readFileSync(join(dir, "meta.json"), "utf8"));
	} catch (err) {
		log.debug("no readable meta.json:", err.message);
	}
	return { spec: JSON.parse(readFileSync(file, "utf8")), meta };
}

/** lowercased operationId -> op; two ids that differ only by case make the spec unusable. */
export function index(spec) {
	const ops = new Map();
	const deref = (s) => (s?.$ref ? spec.definitions?.[s.$ref.split("/").pop()] : s);
	for (const [path, item] of Object.entries(spec.paths)) {
		for (const [method, o] of Object.entries(item)) {
			const key = o.operationId.toLowerCase();
			if (ops.has(key)) throw new Error(`spec: operationIds differ only by case: ${o.operationId}`);
			const params = o.parameters ?? [];
			const bodyParam = params.find((p) => p.in === "body");
			ops.set(key, { id: o.operationId, method: method.toUpperCase(), path, tags: o.tags ?? [],
				summary: o.summary ?? "", deprecated: !!o.deprecated, params: params.filter((p) => p !== bodyParam),
				bodyParam, body: deref(bodyParam?.schema), produces: o.produces, responses: o.responses ?? {} });
		}
	}
	return ops;
}

export function lookup(ops, id) {
	const op = ops.get(String(id).toLowerCase());
	if (!op) throw new Usage(`no operation '${id}' (forge find <words> searches)`);
	return op;
}

export function refusal(op) {
	return Object.hasOwn(REDIRECT, op.id) ? `refused: ${op.id} -- ${REDIRECT[op.id]}` : undefined;
}

/** The redirects, the only refusals `op` and `forge api` apply. */
export function guard(op) {
	const r = refusal(op);
	if (r) throw new Usage(r);
}

/** The operation a raw `forge api` path calls; a redirected match wins a tie, no match is exit 3. */
export function matchPath(ops, method, path) {
	const bare = path.split("?")[0].replace(/(.)\/+$/, "$1");
	// fetch reads a `\` as a `/`, so it separates segments here too.
	if (/(^|[/\\])(\.|%2e){1,2}([/\\]|$)/i.test(bare)) throw new Usage(`path must not hold . or .. segments, got '${path}'`);
	let best;
	for (const op of ops.values()) {
		if (op.method !== method) continue;
		const parts = op.path.split(/\{(\w+)\}/);
		const re = parts.map((s, i) => (i % 2 ? (SLASHY.has(s) ? ".+" : "[^/]+") : s.replace(/[.*+?^$()|[\]\\]/g, "\\$&")));
		if (!new RegExp(`^${re.join("")}$`).test(bare)) continue;
		const score = [!!refusal(op), parts.filter((_, i) => i % 2 === 0).join("").length];
		if (!best || score[0] > best[1][0] || (score[0] === best[1][0] && score[1] > best[1][1])) best = [op, score];
	}
	if (!best) throw new Usage(`no ${method} ${bare} in the Forgejo spec; forge api calls documented operations only`);
	return best[0];
}

export function kind(op) {
	const p = op.produces ?? [];
	if (p.some((t) => /octet-stream|zip|gzip/.test(t)) || op.responses["200"]?.schema?.type === "file") return "binary";
	return p.length && p.every((t) => t.startsWith("text/")) ? "text" : "json";
}

const enumOf = (p) => p.enum ?? p.items?.enum;
const typeOf = (s) => s?.type ?? s?.$ref?.split("/").pop() ?? "object";

function help(op) {
	const lines = [`${op.id} ${op.method} ${op.path} [${op.tags.join(",")}]${op.deprecated ? " deprecated" : ""}`];
	if (op.summary) lines.push(op.summary);
	if (refusal(op)) lines.push(refusal(op));
	for (const p of op.params) {
		const arr = p.type === "array" ? `[${p.items?.type}] ${p.collectionFormat ?? "csv"}` : "";
		const en = enumOf(p) ? ` enum:${enumOf(p).join("|")}` : "";
		lines.push(`  ${p.in} ${p.name} ${p.type}${arr}${p.required ? " required" : ""}${en}`);
	}
	if (op.bodyParam) {
		lines.push(`  body ${typeOf(op.body)}${op.bodyParam.required ? " required" : ""}`);
		for (const [k, v] of Object.entries(op.body?.properties ?? {})) {
			const req = op.body.required?.includes(k) ? " required" : "";
			lines.push(`    ${k} ${typeOf(v)}${req}${v.enum ? ` enum:${v.enum.join("|")}` : ""}`);
		}
	}
	lines.push(`produces: ${(op.produces ?? ["application/json"]).join(", ")}`);
	lines.push(`success: ${Object.keys(op.responses).filter((c) => /^[23]/.test(c)).join(" ")}`);
	return lines;
}

function put(obj, key, value) {
	if (Object.hasOwn(obj, key)) throw new Usage(`${key} given twice`);
	obj[key] = value;
}

function checkEnum(name, allowed, values) {
	const bad = allowed && values.find((v) => !allowed.map(String).includes(String(v)));
	if (bad !== undefined && bad !== false) throw new Usage(`${name} must be one of ${allowed.join("|")}, got '${bad}'`);
}

/** field=value of a --b64, --file or --form arg. */
function pair(flag, a) {
	const i = a.indexOf("=");
	if (i < 1) throw new Usage(`${flag} wants field=value, got '${a}'`);
	return [a.slice(0, i), a.slice(i + 1)];
}

function readBytes(path) {
	try {
		return readFileSync(path);
	} catch (err) {
		throw new Usage(`cannot read ${path}: ${err?.code ?? "error"}`);
	}
}

/** --file/--form: a FormData of the op's formData params (fetch sets the boundary), or undefined. */
function multipart(op, flags, given) {
	const files = flags.file ?? [], forms = flags.form ?? [];
	if (!files.length && !forms.length) return undefined;
	const names = op.params.filter((p) => p.in === "formData").map((p) => p.name);
	if (!names.length) throw new Usage(`${op.id} takes no multipart form`);
	if (files.length && flags["data-file"] !== undefined) throw new Usage("--file and --data-file do not combine");
	const fd = new FormData();
	for (const [flag, list] of [["--file", files], ["--form", forms]]) {
		for (const a of list) {
			const [k, v] = pair(flag, a);
			if (!names.includes(k)) throw new Usage(`unknown multipart field '${k}' for ${op.id} (fields: ${names.join(", ")})`);
			put(given, k, true);
			if (flag === "--file") fd.append(k, new Blob([readBytes(v)]), basename(v));
			else fd.append(k, v);
		}
	}
	return fd;
}

/** --b64 field=path: the file's bytes base64 into a top-level body field through toBody, or
 * [top, n, leaf, data] for a `top.n.leaf` field set into an array item after the merge. */
function b64(op, list, toBody) {
	const deep = [], seen = {};
	for (const a of list ?? []) {
		if (!op.bodyParam || ["string", "array"].includes(op.body?.type)) throw new Usage(`${op.id} takes no body`);
		const [k, file] = pair("--b64", a);
		const m = /^(\w+)(?:\.(\d+)\.(\w+))?$/.exec(k);
		if (!m) throw new Usage(`--b64 field is name or name.<n>.leaf, got '${k}'`);
		const prop = op.body?.properties?.[m[1]];
		if (m[2] && op.body?.properties && prop?.type !== "array") throw new Usage(`unknown array field '${m[1]}' for ${op.id}`);
		put(seen, k, true);
		const data = readBytes(file).toString("base64");
		if (m[2]) deep.push([m[1], Number(m[2]), m[3], data]);
		else toBody(k, data);
	}
	return deep;
}

function readBody(ctx, op, dataFile) {
	if (!op.bodyParam) throw new Usage(`${op.id} takes no body`);
	const text = ctx.readText(dataFile);
	const body = op.body?.type === "string" ? text : parseJson(text);
	if (body === undefined) throw new Usage(`--data-file ${dataFile} is not JSON`);
	return body;
}

/** Grammar rules 1-4 and 7-9 of the L13b design, plus --b64/--file/--form: args -> [url, body]. */
export function build(ctx, op, args, flags = {}) {
	const path = {}, query = {}, fields = {}, given = {}, dataFile = flags["data-file"];
	const props = op.body?.properties;
	const toBody = (key, value) => {
		const bad = !op.bodyParam || ["string", "array"].includes(op.body?.type) || (props && !Object.hasOwn(props, key));
		if (bad) throw new Usage(`unknown key '${key}' for ${op.id} (forge op ${op.id} --help lists them)`);
		checkEnum(key, props?.[key]?.enum, [value]);
		put(fields, key, value);
	};
	for (const a of args) {
		const m = /^([^=:]+)(:?=)(.*)$/s.exec(a);
		if (!m) throw new Usage(`expected key=value, body.key=value or key:=<json>, got '${a}'`);
		const [, raw, how, val] = m;
		const key = raw.startsWith("body.") ? raw.slice(5) : raw;
		const p = op.params.find((x) => x.name === key);
		if (how === ":=") {
			const v = parseJson(val);
			if (v === undefined) throw new Usage(`${key}:= needs a JSON value, got '${val}'`);
			toBody(key, v);
		} else if (raw !== key) toBody(key, val);
		else if (key === "repo" && op.params.some((x) => x.name === "owner" && x.in === "path") && /^\.$|\//.test(val)) {
			const [owner, repo] = ctx.repo(val).split("/");
			put(path, "owner", owner);
			put(path, "repo", repo);
		} else if (p?.in === "path") put(path, key, val);
		else if (p?.in === "query" && p.type === "array") (query[key] ??= []).push(val);
		else if (p?.in === "query") put(query, key, val);
		else if (p?.in === "formData") throw new Usage(`${key} is a multipart field; pass --form ${key}=value${p.type === "file" ? ` or --file ${key}=<path>` : ""}`);
		else toBody(key, val);
	}
	const deep = b64(op, flags.b64, toBody);
	let body = multipart(op, flags, given);
	if (dataFile !== undefined) body = readBody(ctx, op, dataFile);
	if (Object.keys(fields).length || deep.length) {
		if (body !== undefined && (typeof body !== "object" || Array.isArray(body) || body === null)) {
			throw new Usage(`--data-file ${dataFile} is not a JSON object, so key args cannot merge over it`);
		}
		body = { ...body, ...fields };
	}
	for (const [top, n, leaf, data] of deep) {
		if (!Array.isArray(body[top] ??= [])) throw new Usage(`${top} is not an array, so --b64 cannot set ${top}.${n}.${leaf}`);
		body[top][n] = { ...body[top][n], [leaf]: data };
	}
	checkParams(op, path, query, given, body);
	return [urlOf(op, path, query), body];
}

/** Rule 8: every required path, query, formData and body param is given, and enums hold. */
function checkParams(op, path, query, given, body) {
	for (const p of op.params) {
		const v = p.in === "path" ? path[p.name] : p.in === "query" ? query[p.name] : given[p.name];
		if (v === undefined && (p.required || p.in === "path")) throw new Usage(`missing required ${p.in} param '${p.name}' for ${op.id}`);
		if (v !== undefined) checkEnum(p.name, enumOf(p), [v].flat());
	}
	if (op.bodyParam?.required && body === undefined) throw new Usage(`${op.id} needs a body`);
	const missing = body && typeof body === "object" && op.body?.required?.find((k) => !Object.hasOwn(body, k));
	if (missing) throw new Usage(`missing required body param '${missing}' for ${op.id}`);
}

/** The op path with its params encoded, plus the query string. */
function urlOf(op, path, query) {
	const url = op.path.replace(/\{(\w+)\}/g, (_, k) => segments(k, path[k], SLASHY.has(k)));
	const q = [];
	for (const p of op.params.filter((x) => x.in === "query" && query[x.name] !== undefined)) {
		const k = encodeURIComponent(p.name), v = query[p.name];
		if (!Array.isArray(v)) q.push(`${k}=${encodeURIComponent(v)}`);
		else if (p.collectionFormat === "multi") q.push(...v.map((x) => `${k}=${encodeURIComponent(x)}`));
		else q.push(`${k}=${v.map(encodeURIComponent).join(",")}`);
	}
	return q.length ? `${url}?${q.join("&")}` : url;
}

/** --out: the body to <path> through a temp file renamed on success, or for `-` raw to stdout. */
async function save(ctx, res, path) {
	const src = res.body ? Readable.fromWeb(res.body) : Readable.from([]);
	if (path === "-") return await pipeline(src, ctx.stdoutRaw ?? process.stdout, { end: false }), 0;
	const tmp = `${path}.${process.pid}.tmp`;
	try {
		await pipeline(src, createWriteStream(tmp));
	} catch (err) {
		rmSync(tmp, { force: true });
		throw err;
	}
	renameSync(tmp, path);
	ctx.stdout(`${path} ${statSync(path).size} ${res.headers.get("content-type") ?? ""}`.trimEnd());
	return 0;
}

export const MOVED = new Set([301, 302, 303, 307, 308]);
const MAX_HOPS = 3;

/** A 3xx Location as an API path to re-send the same method and body to: same origin, under the API base,
 * at most MAX_HOPS; anything else is an Http error naming the Location, and nothing more is sent.
 * fetch's own follow would turn a 301/302 POST into a GET (seen live after a repo rename). */
export function moved(method, path, status, location, hop) {
	const fail = (why) => Object.assign(new Http(`${method} ${path}: HTTP ${status} ${why}`), { status });
	if (!location) throw fail("with no Location");
	if (hop >= MAX_HOPS) throw fail(`to ${location}: more than ${MAX_HOPS} redirects`);
	const to = new URL(location, `${API}${path}`), base = new URL(API);
	if (to.origin !== base.origin || !to.pathname.startsWith(`${base.pathname}/`)) throw fail(`to ${location}: not this Forge API, not followed`);
	return to.pathname.slice(base.pathname.length) + to.search;
}

/** One request: [res, text]; the text is left unread for a 2xx --out, which save() streams. A non-binary
 * op follows a same-origin 3xx with the same method and body (a 303 with a bare GET), one stderr line per hop. */
async function send(ctx, op, url, body, flags) {
	let method = op.method;
	const headers = { accept: (op.produces ?? ["application/json"]).join(", ") };
	if (!flags.anon) headers.authorization = `token ${await ctx.token()}`;
	if (flags.range !== undefined) headers.range = `bytes=${flags.range}`;
	const form = body instanceof FormData;
	if (body !== undefined && !form) headers["content-type"] = typeof body === "string" ? "text/plain" : "application/json";
	let sendBody = body === undefined || typeof body === "string" || form ? body : JSON.stringify(body);
	const binary = kind(op) === "binary";
	for (let hop = 0; ; hop++) {
		let res, text;
		try {
			res = await ctx.fetch(`${API}${url}`, { method, headers, body: sendBody,
				redirect: binary ? "follow" : "manual", signal: AbortSignal.timeout(30_000) });
			text = flags.out === undefined || res.status >= 300 ? await res.text() : undefined;
		} catch (err) {
			throw new Error(`${method} ${url}: ${err?.cause?.code ?? err?.name ?? "network error"}`);
		}
		if (binary || !MOVED.has(res.status)) return [res, text];
		const to = moved(method, url, res.status, res.headers.get("location"), hop);
		ctx.stderr(`forge: ${method} ${url} moved to ${to}; use the new name`);
		url = to;
		// 303 See Other means fetch the result with a GET; every other 3xx keeps the method and body.
		if (res.status === 303) {
			method = "GET";
			sendBody = undefined;
			delete headers["content-type"];
		}
	}
}

const httpError = (op, url, status, json) =>
	Object.assign(new Http(`${op.method} ${url}: HTTP ${status}${json?.message ? ` -- ${json.message}` : ""}`), { status });

/** A paged GET for --all-pages: [res, json], any non-2xx an Http error. */
async function page(ctx, op, url, flags) {
	const [res, text] = await send(ctx, op, url, undefined, flags);
	const json = text.trim() ? parseJson(text) : null;
	if (res.status >= 300) throw httpError(op, url, res.status, json);
	return [res, json];
}

/** One call printed; `after(json)` sees a JSON success. */
async function call(ctx, op, url, body, flags, after) {
	const [res, text] = await send(ctx, op, url, body, flags);
	if (text === undefined) return save(ctx, res, flags.out);
	const { status } = res, out = ctx.stdout;
	if (flags.raw) {
		out([`HTTP ${status}`, ...[...res.headers].map(([k, v]) => `${k}: ${v}`), "", text].join("\n"));
		return status >= 400 ? ctx.httpExit : 0;
	}
	if (CHECKS.has(op.id) && (status === 204 || status === 404)) return out(status === 204 ? "yes" : "no"), 0;
	const json = text.trim() ? parseJson(text) : null;
	if (status >= 400) throw httpError(op, url, status, json);
	if (status >= 300) return out(`HTTP ${status} ${res.headers.get("location") ?? ""}`.trimEnd()), 0;
	if (!text.trim()) return out(ctx.json ? JSON.stringify({ status }) : `HTTP ${status}`), 0;
	if (kind(op) === "text") return out(ctx.json ? JSON.stringify({ status, text }) : text.replace(/\n$/, "")), 0;
	if (json === undefined) throw new Error(`${op.method} ${url}: unreadable response`);
	after?.(json);
	return out(JSON.stringify(json, null, 2)), 0;
}

const VALUED = ["--data-file", "--out", "--range"], MULTI = ["--b64", "--file", "--form"];

/** The op flags, each at most once except the repeatable MULTI ones (arrays): rest -> [args, flags keyed by bare name]. */
function parseFlags(rest) {
	const args = [], flags = {};
	const once = (a, v) => {
		if (Object.hasOwn(flags, a.slice(2))) throw new Usage(`${a} given twice`);
		flags[a.slice(2)] = v;
	};
	for (let i = 0; i < rest.length; i++) {
		const a = rest[i];
		if (["--help", "--raw", "--anon", "--all-pages"].includes(a)) once(a, true);
		else if (![...VALUED, ...MULTI].includes(a)) {
			if (a.startsWith("--")) throw new Usage(`unknown flag '${a}'`);
			args.push(a);
		} else if (i + 1 >= rest.length) throw new Usage(`${a} needs a value`);
		else if (MULTI.includes(a)) (flags[a.slice(2)] ??= []).push(rest[++i]);
		else once(a, rest[++i]);
	}
	return [args, flags];
}

/** Exit 3 before any request: a binary op without --out, `--out -` on a terminal, a bad range, --anon off the misc ops. */
function checkFlags(ctx, o, flags) {
	if (flags.range !== undefined && !/^\d+-\d*$/.test(flags.range)) throw new Usage(`--range wants a-b, got '${flags.range}'`);
	if (kind(o) === "binary" && flags.out === undefined) throw new Usage("binary response; pass --out <path>");
	if (flags.out === "-" && (ctx.stdoutIsTTY ?? process.stdout.isTTY)) throw new Usage("--out - refuses a terminal; pass a file path");
	const pub = (o.method === "GET" || ANON_POSTS.has(o.id)) && ANON_PATHS.some((p) => o.path.startsWith(p));
	if (flags.anon && !pub) throw new Usage(`--anon is for the public misc operations only (${o.id} needs the token)`);
}

/** forge op <operationId> [key=value | body.key=value | key:=<json>]... [--data-file f] [--b64 f=path]...
 * [--file f=path]... [--form f=value]... [--out p] [--range a-b] [--anon] [--all-pages] [--raw] [--help] */
export async function op(ctx, [id, ...rest]) {
	if (id === undefined || id.startsWith("-")) throw new Usage("op needs an <operationId> (forge find <words> searches)");
	const { ops, spec, meta } = await ctx.spec();
	const o = lookup(ops, id);
	const [args, flags] = parseFlags(rest);
	if (flags.help) return help(o).forEach((l) => ctx.stdout(l)), 0;
	const [url, body] = build(ctx, o, args, flags);
	guard(o);
	PAGES.preflight(ctx, o, flags);
	checkFlags(ctx, o, flags);
	const paged = flags["all-pages"] ? PAGES.checkPages(spec, o, flags, kind(o)) : undefined;
	if (paged) return PAGES.allPages(ctx, o, url, paged, meta, (u) => page(ctx, o, u, flags));
	return call(ctx, o, url, body, flags, (json) => PAGES.moreHint(ctx, spec, o, url, meta, json));
}

/** forge find <word>... [--refresh] [--version] [--json]: at most 50 hits. */
export async function find(ctx, args) {
	const flags = new Set(args.filter((a) => a.startsWith("--")));
	const bad = [...flags].find((f) => !["--refresh", "--version", "--json"].includes(f));
	if (bad) throw new Usage(`unknown flag '${bad}'`);
	const words = args.filter((a) => !a.startsWith("--")).map((w) => w.toLowerCase());
	const { ops, meta, spec } = await ctx.spec(flags.has("--refresh"));
	if (flags.has("--version")) {
		ctx.stdout(`${meta.version ?? spec.info?.version} fetched ${meta.fetched_at ?? "?"} max_response_items ${meta.max_response_items ?? 50}`);
		if (!words.length) return 0;
	}
	if (!words.length) {
		if (flags.has("--refresh")) return 0;
		throw new Usage("find needs at least one word");
	}
	const hits = [...ops.values()].filter((o) => {
		const hay = [o.id, o.summary, o.path, ...o.tags].join(" ").toLowerCase();
		return words.every((w) => hay.includes(w));
	});
	if (!hits.length) throw new Usage(`no operation matches '${words.join(" ")}'`);
	if (hits.length > 50) ctx.stderr(`forge: ${hits.length} matches, showing 50; add words to narrow`);
	for (const o of hits.slice(0, 50)) {
		if (ctx.json || flags.has("--json")) {
			const entry = { operationId: o.id, method: o.method, path: o.path, tags: o.tags,
				deprecated: o.deprecated, parameters: o.params, body: o.bodyParam ? typeOf(o.body) : undefined };
			ctx.stdout(JSON.stringify(entry));
			continue;
		}
		ctx.stdout(`${o.id} ${o.method} ${o.path} [${o.tags.join(",")}]${o.deprecated ? " deprecated" : ""}`);
	}
	return 0;
}
