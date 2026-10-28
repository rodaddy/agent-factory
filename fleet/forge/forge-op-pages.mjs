// forge-op-pages: `forge op --all-pages`, the more-hint on a full page, and the token-scope pre-flight that
// `forge op` and `forge api` share (design comment 83103).
// https://forge.example.internal/rodaddy/development/issues/992

// Token scopes a session account carries (inlined: the account creator that defines them is not in this export).
const SCOPES = ["write:repository", "write:issue", "read:user", "write:organization"];
import { Usage } from "./forge-op.mjs";

const CAP = 200;
// Path prefix -> token scope family, first match wins; anything unlisted is misc and never pre-flighted.
const FAMILIES = [
	["admin", ["/admin"]],
	["notification", ["/notifications", "/repos/{owner}/{repo}/notifications"]],
	["package", ["/packages"]],
	["activitypub", ["/activitypub"]],
	["issue", ["/repos/{owner}/{repo}/issues", "/repos/{owner}/{repo}/labels", "/repos/{owner}/{repo}/milestones",
		"/repos/issues/search"]],
	["repository", ["/repos", "/repositories", "/topics/search", "/user/repos", "/user/starred", "/user/subscriptions",
		"/users/{username}/repos", "/users/{username}/starred", "/users/{username}/subscriptions", "/org/{org}/repos"]],
	["organization", ["/orgs", "/teams", "/user/orgs", "/users/{username}/orgs", "/user/teams"]],
	["user", ["/user", "/users"]],
];

export function family(path) {
	const hit = FAMILIES.find(([, list]) => list.some((p) => path === p || path.startsWith(`${p}/`)));
	return hit?.[0] ?? "misc";
}

/** Exit 3 before the network when the session token's scopes cannot reach the op; an employee's token
 * scopes are unknown, an elevated token carries `all`, and --anon sends none, so all three skip. */
export function preflight(ctx, op, flags = {}) {
	if (flags.anon || ctx.elevated || ctx.employee?.()) return;
	const fam = family(op.path);
	const level = op.method === "GET" ? "read" : "write";
	if (fam === "misc" || SCOPES.includes(`${level}:${fam}`) || SCOPES.includes(`write:${fam}`)) return;
	throw new Usage(`needs ${level}:${fam}; session tokens carry ${SCOPES.join(" ")}`);
}

/** The size param of a paged op (per_page, limit, or null for none); undefined when the op takes no page. */
function sizeParam(op) {
	const has = (n) => op.params.some((p) => p.in === "query" && p.name === n);
	return has("page") ? (["per_page", "limit"].find(has) ?? null) : undefined;
}

/** null for a bare-array response, the one array property of an object response, else undefined. */
function arrayKey(spec, op) {
	const deref = (s, kind) => (s?.$ref ? spec[kind]?.[s.$ref.split("/").pop()] : s);
	const schema = deref(deref(op.responses["200"], "responses")?.schema, "definitions");
	if (schema?.type === "array") return null;
	const keys = Object.entries(schema?.properties ?? {}).filter(([, v]) => v.type === "array").map(([k]) => k);
	return keys.length === 1 ? keys[0] : undefined;
}

const queryOf = (url, key) => {
	const kv = (url.split("?")[1] ?? "").split("&").find((s) => s.startsWith(`${key}=`));
	return kv === undefined ? undefined : decodeURIComponent(kv.slice(key.length + 1));
};

/** url with key=value last, any earlier key= dropped; the other params keep their encoding. */
function setQuery(url, key, value) {
	const [path, q = ""] = url.split("?");
	const kept = q.split("&").filter((kv) => kv && !kv.startsWith(`${key}=`));
	return `${path}?${[...kept, `${key}=${value}`].join("&")}`;
}

/** The asked size, capped at the server's max_response_items (a larger one comes back short), else that max. */
function pageSize(op, url, meta) {
	const max = meta.max_response_items || 50, asked = Number(queryOf(url, sizeParam(op)));
	return asked > 0 ? Math.min(asked, max) : max;
}

const pageOf = (url) => Number(queryOf(url, "page") ?? 1);
const itemsOf = (json, key) => (key === null ? json : json?.[key]);

/** Exit 3 before any call for --all-pages that cannot apply; {key} for a paged op, undefined for one call. */
export function checkPages(spec, op, flags, kind) {
	if (flags.out !== undefined || flags.raw || kind !== "json") throw new Usage("--all-pages wants a JSON op without --out or --raw");
	if (sizeParam(op) === undefined) return undefined;
	const key = arrayKey(spec, op);
	if (key === undefined) throw new Usage(`--all-pages cannot merge ${op.id}: no single array property`);
	return { key };
}

/** The last page: a short (or, with no size param, empty) page, the total reached, X-HasMore false, or no next link. */
function last(res, got, size, total) {
	const h = (k) => res.headers.get(k);
	if (size === undefined ? got === 0 : got < size) return true;
	if (h("x-total-count") !== null && total >= Number(h("x-total-count"))) return true;
	if (h("x-hasmore") === "false") return true;
	return h("link") !== null && !/rel="next"/.test(h("link"));
}

/** Every page from page= (default 1), merged and printed as one JSON value; `get(url)` -> [res, json]. */
export async function allPages(ctx, op, url, { key }, meta, get) {
	const param = sizeParam(op), size = param ? pageSize(op, url, meta) : undefined;
	if (param) url = setQuery(url, param, size);
	let first;
	const items = [];
	for (let n = pageOf(url), i = 0; i < CAP; n++, i++) {
		const [res, json] = await get(setQuery(url, "page", n));
		const list = itemsOf(json, key) ?? [];
		if (!Array.isArray(list)) throw new Error(`${op.method} ${url}: page ${n} holds no array`);
		first ??= json;
		items.push(...list);
		if (last(res, list.length, size, items.length)) {
			ctx.stdout(JSON.stringify(key === null ? items : { ...first, [key]: items }, null, 2));
			return 0;
		}
	}
	throw new Usage(`pagination cap hit (${CAP} pages); narrow the query or start at a later page=`);
}

/** Without --all-pages: a full page of a paged op prints `forge: more: page=<N+1>` on stderr. */
export function moreHint(ctx, spec, op, url, meta, json) {
	const key = sizeParam(op) ? arrayKey(spec, op) : undefined;
	const list = key === undefined ? undefined : itemsOf(json, key);
	if (Array.isArray(list) && list.length === pageSize(op, url, meta)) ctx.stderr(`forge: more: page=${pageOf(url) + 1}`);
}
