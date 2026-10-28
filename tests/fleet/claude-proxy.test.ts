/**
 * @module tests/fleet/claude-proxy
 * @description `fleet/bin/claude-proxy`, run as a real child process against a
 *   fake Paperclip board (`Bun.serve`) that keeps the stored (unredacted) agents
 *   and secrets in memory and follows the installed board's semantics (2026.916.1):
 *   every agent GET is redacted (`redactAgentAdapterConfig`: env values become
 *   `{type:"plain",value:REDACTED}`, secret text in other string leaves is
 *   replaced in place); an agent PATCH restores only redacted env entries
 *   (`restoreRedactedAgentEnv`) and then shallow-merges top-level adapterConfig
 *   keys over the stored config; `PATCH /api/secrets/:id` parses a metadata-only
 *   schema, so a `value` is silently dropped; `POST /api/secrets/:id/rotate`
 *   stores the value and bumps `latestVersion`. Covers status, secret
 *   create/rotate with the key never in output, on/off changing exactly the two
 *   env keys in the STORED config, refusals that PATCH nobody, and usage; then
 *   `--via bifrost` (three keys, the cache headers, the `via` status field) and
 *   `route` (the literal model id on the board, `claudex/<id>` through Bifrost).
 *   `CLAUDE_PROXY_UNDER_TEST` points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRIPT =
	process.env.CLAUDE_PROXY_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/claude-proxy");
const BOARD_TOKEN = ["fake", "board", "value", "o2"].join("-");
const KEY = ["fake", "proxy", "key", String(Date.now())].join("-");
const COMPANY = "co-1";
const SECRET_NAME = "CLIProxyAPI - paperclip client key";
const BASE_URL = "https://codex-proxy.example.internal";
const REDACTED = "***REDACTED***";
const PROMPT = "You are {{agent.name}}. Call the API with Authorization: Bearer fixture123abc.";
const ARGS = ["--x", "--api-key=fixture456def", "--settings=s.json"];

type Env = Record<string, unknown>;
type Agent = {
	id: string;
	name: string;
	adapterType: string;
	adapterConfig: Record<string, unknown>;
};
type Secret = { id: string; name: string; value: string; latestVersion: number };

let agents: Agent[] = [];
let secrets: Secret[] = [];
let patches: Array<{ path: string; body: unknown }> = [];
let posts: Array<{ path: string; body: unknown }> = [];
let rotateBumps = true;
let server: ReturnType<typeof Bun.serve>;

const isObj = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function redactText(v: unknown): unknown {
	if (typeof v === "string")
		return v
			.replace(/(Authorization: ).*$/, `$1${REDACTED}`)
			.replace(/(--api-key=).*$/, `$1${REDACTED}`);
	if (Array.isArray(v)) return v.map(redactText);
	if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactText(x)]));
	return v;
}

/** The board's GET view of an adapterConfig. */
function redactConfig(c: Record<string, unknown>): Record<string, unknown> {
	const { env, ...rest } = c;
	const out = redactText(rest) as Record<string, unknown>;
	if (!isObj(env)) return out;
	const renv: Env = {};
	for (const [k, v] of Object.entries(env))
		renv[k] =
			isObj(v) && v.type === "secret_ref"
				? v
				: typeof v === "string" || (isObj(v) && v.type === "plain")
					? { type: "plain", value: REDACTED }
					: REDACTED;
	return { ...out, env: renv };
}

const view = (a: Agent): Agent => ({ ...a, adapterConfig: redactConfig(a.adapterConfig) });

/** The board's PATCH: restore redacted env entries, then shallow-merge over the stored config. */
function applyPatch(a: Agent, requested: Record<string, unknown>): void {
	let req = requested;
	const renv = requested.env;
	const eenv = a.adapterConfig.env;
	if (isObj(renv) && isObj(eenv)) {
		const restored: Env = { ...renv };
		for (const [k, v] of Object.entries(renv))
			if (isObj(v) && v.type === "plain" && v.value === REDACTED && k in eenv)
				restored[k] = eenv[k];
		req = { ...requested, env: restored };
	}
	a.adapterConfig = { ...a.adapterConfig, ...req };
}

function cfg(env: Env): Record<string, unknown> {
	return { model: "claude-opus", cwd: "/work", promptTemplate: PROMPT, extraArgs: [...ARGS], env };
}

function seed(): void {
	const sref = { type: "secret_ref", secretId: "sec-1", version: "latest" };
	agents = [
		{
			id: "a1",
			name: "Bishop",
			adapterType: "claude_local",
			adapterConfig: cfg({ FOO: { type: "plain", value: "foo-stored" }, RAW: "raw-stored" }),
		},
		{
			id: "a2",
			name: "Chotek",
			adapterType: "claude_local",
			adapterConfig: cfg({
				ANTHROPIC_BASE_URL: { type: "plain", value: BASE_URL },
				ANTHROPIC_AUTH_TOKEN: sref,
				BAR: "x",
			}),
		},
		{
			id: "a3",
			name: "Adams",
			adapterType: "claude_local",
			adapterConfig: cfg({ ANTHROPIC_BASE_URL: { type: "plain", value: BASE_URL } }),
		},
		{ id: "a4", name: "Ski", adapterType: "claude_local", adapterConfig: cfg({}) },
		{ id: "a5", name: "Nagatha", adapterType: "claude_local", adapterConfig: { model: "m" } },
		{ id: "a7", name: "Kong", adapterType: "claude_local", adapterConfig: cfg({}) },
		{ id: "a6", name: "Pippa", adapterType: "pi_local", adapterConfig: cfg({}) },
	];
	secrets = [{ id: "sec-1", name: SECRET_NAME, value: "old-stored-value", latestVersion: 1 }];
	patches = [];
	posts = [];
	rotateBumps = true;
}

const secretView = ({ id, name, latestVersion }: Secret) => ({ id, name, latestVersion });

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			if (req.headers.get("authorization") !== `Bearer ${BOARD_TOKEN}`)
				return new Response("no", { status: 401 });
			const path = new URL(req.url).pathname;
			const body = req.method === "GET" ? undefined : await req.json();
			if (req.method === "GET" && path === `/api/companies/${COMPANY}/agents`)
				return Response.json(agents.map(view));
			if (req.method === "GET" && path === `/api/companies/${COMPANY}/secrets`)
				return Response.json(secrets.map(secretView));
			let m = path.match(/^\/api\/agents\/([^/]+)$/);
			if (m) {
				const a = agents.find((x) => x.id === m?.[1]);
				if (!a) return new Response("nf", { status: 404 });
				if (req.method === "GET") return Response.json(view(a));
				if (req.method === "PATCH") {
					patches.push({ path, body });
					const ac = (body as { adapterConfig?: unknown }).adapterConfig;
					if (!isObj(ac)) return new Response("adapterConfig must be an object", { status: 422 });
					applyPatch(a, ac);
					return Response.json(view(a));
				}
			}
			if (req.method === "POST" && path === `/api/companies/${COMPANY}/secrets`) {
				posts.push({ path, body });
				const b = body as { name: string; value: string };
				const s = { id: "sec-new", name: b.name, value: b.value, latestVersion: 1 };
				secrets.push(s);
				return Response.json(secretView(s), { status: 201 });
			}
			m = path.match(/^\/api\/secrets\/([^/]+)\/rotate$/);
			if (m && req.method === "POST") {
				posts.push({ path, body });
				const s = secrets.find((x) => x.id === m?.[1]);
				if (!s) return new Response("nf", { status: 404 });
				const v = (body as { value?: unknown }).value;
				if (typeof v !== "string" || !v) return new Response("bad", { status: 400 });
				s.value = v;
				if (rotateBumps) s.latestVersion += 1;
				return Response.json(secretView(s));
			}
			m = path.match(/^\/api\/secrets\/([^/]+)$/);
			if (m && req.method === "PATCH") {
				// updateSecretSchema has no `value`: zod strips it and the route answers 200.
				patches.push({ path, body });
				const s = secrets.find((x) => x.id === m?.[1]);
				if (!s) return new Response("nf", { status: 404 });
				const b = body as { name?: string };
				if (typeof b.name === "string") s.name = b.name;
				return Response.json(secretView(s));
			}
			return new Response("nf", { status: 404 });
		},
	});
});
afterAll(() => server.stop(true));
beforeEach(seed);

async function run(args: string[], extra: Record<string, string> = {}) {
	const p = Bun.spawn([SCRIPT, ...args], {
		env: {
			PATH: process.env.PATH ?? "",
			PAPERCLIP_API_URL: `http://127.0.0.1:${server.port}`,
			PAPERCLIP_BOARD_TOKEN: BOARD_TOKEN,
			PAPERCLIP_COMPANY_ID: COMPANY,
			CLAUDE_PROXY_KEY_CMD: `printf %s ${KEY}`,
			...extra,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	const all = stdout + stderr;
	expect(all).not.toContain(BOARD_TOKEN);
	expect(all).not.toContain(KEY);
	return {
		stdout,
		stderr,
		code,
		lines: stdout.trim()
			? stdout
					.trim()
					.split("\n")
					.map((l) => JSON.parse(l))
			: [],
	};
}

const stored = (id: string) =>
	agents.find((a) => a.id === id)?.adapterConfig as Record<string, unknown>;
const envOf = (id: string) => (stored(id).env ?? {}) as Env;

describe("claude-proxy", () => {
	test("status reports on/off/partial, read-only", async () => {
		const r = await run(["status"]);
		expect(r.code).toBe(0);
		const by = Object.fromEntries(r.lines.map((l) => [l.name, l]));
		// Chotek is retired and Kong runs gpt-6.1-sol (2026-10-06): neither is a default.
		expect(Object.keys(by)).toEqual(["Bishop", "Adams", "Ski", "Nagatha"]);
		expect(by.Bishop.proxy).toBe("off");
		const c = await run(["status", "--agents", "Chotek"]);
		expect(c.lines.map((l) => [l.name, l.proxy])).toEqual([["Chotek", "on"]]);
		expect(by.Adams.proxy).toBe("partial");
		expect(by.Bishop.adapterType).toBe("claude_local");
		expect(by.Bishop.model).toBe("claude-opus");
		expect(patches).toHaveLength(0);
	});

	test("secret creates when absent, key never in output", async () => {
		secrets = [];
		const r = await run(["secret"]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([{ secret: SECRET_NAME, id: "sec-new", action: "created" }]);
		expect(posts[0]?.body).toEqual({ name: SECRET_NAME, provider: "local_encrypted", value: KEY });
	});

	test("secret rotates when present: the stored value changes and the version advances", async () => {
		const r = await run(["secret"]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([{ secret: SECRET_NAME, id: "sec-1", action: "rotated", version: 2 }]);
		expect(secrets[0]?.value).toBe(KEY);
		expect(secrets[0]?.latestVersion).toBe(2);
		expect(posts).toEqual([{ path: "/api/secrets/sec-1/rotate", body: { value: KEY } }]);
		expect(patches).toHaveLength(0);
	});

	test("secret refuses a rotate reply that shows no new version", async () => {
		rotateBumps = false;
		const r = await run(["secret"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("no new version");
		expect(r.lines).toEqual([]);
	});

	test("secret refuses an empty key", async () => {
		const r = await run(["secret"], { CLAUDE_PROXY_KEY_CMD: "printf ''" });
		expect(r.code).toBe(1);
		expect(patches).toHaveLength(0);
		expect(posts).toHaveLength(0);
		expect(secrets[0]?.value).toBe("old-stored-value");
	});

	test("on PATCHes env only and the stored config changes in exactly the two keys", async () => {
		const before = structuredClone(agents.map((a) => a.adapterConfig));
		const r = await run(["on"]);
		expect(r.code).toBe(0);
		expect(r.lines.map((l) => l.name)).toEqual(["Bishop", "Adams", "Ski", "Nagatha"]);
		expect(patches).toHaveLength(4);
		for (const l of r.lines) expect(l).toMatchObject({ proxy: "on", http: 200 });
		for (const p of patches)
			expect(Object.keys((p.body as { adapterConfig: object }).adapterConfig)).toEqual(["env"]);
		const added = {
			ANTHROPIC_BASE_URL: { type: "plain", value: BASE_URL },
			ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretId: "sec-1", version: "latest" },
		};
		expect(stored("a1")).toEqual({
			...(before[0] as Record<string, unknown>),
			env: { FOO: { type: "plain", value: "foo-stored" }, RAW: "raw-stored", ...added },
		});
		expect(stored("a1").promptTemplate).toBe(PROMPT);
		expect(stored("a1").extraArgs).toEqual(ARGS);
		expect(stored("a2")).toEqual(before[1] as Record<string, unknown>);
		expect(stored("a5")).toEqual({ model: "m", env: added });
	});

	test("on refuses when one agent is pi_local and PATCHes nobody", async () => {
		const r = await run(["on", "--agents", "Bishop,Pippa"]);
		expect(r.code).toBe(1);
		expect(patches).toHaveLength(0);
	});

	test("on refuses when the secret is missing", async () => {
		secrets = [];
		const r = await run(["on"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("secret");
		expect(patches).toHaveLength(0);
	});

	test("off removes exactly the two keys and leaves the rest of the stored config", async () => {
		const r = await run(["off", "--agents", "Chotek,Adams"]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([
			{ name: "Chotek", proxy: "off", http: 200 },
			{ name: "Adams", proxy: "off", http: 200 },
		]);
		expect(envOf("a2")).toEqual({ BAR: "x" });
		expect(envOf("a3")).toEqual({});
		for (const id of ["a2", "a3"]) {
			expect(stored(id).cwd).toBe("/work");
			expect(stored(id).model).toBe("claude-opus");
			expect(stored(id).promptTemplate).toBe(PROMPT);
			expect(stored(id).extraArgs).toEqual(ARGS);
		}
	});

	test("bad usage exits 2", async () => {
		expect((await run([])).code).toBe(2);
		expect((await run(["frob"])).code).toBe(2);
		expect((await run(["on", "--agents"])).code).toBe(2);
		expect((await run(["status", "--bogus"])).code).toBe(2);
	});
});

const BF_SECRET = "Bifrost - claudex virtual key";
const BF_URL = "https://bifrost.example.internal/anthropic";
const BF_HEADERS = "x-bf-cache-key: claudex-nocache\nx-bf-cache-no-store: true";
const plain = (value: string) => ({ type: "plain", value });
const BF_ENV = {
	ANTHROPIC_BASE_URL: plain(BF_URL),
	ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretId: "sec-bf", version: "latest" },
	ANTHROPIC_CUSTOM_HEADERS: plain(BF_HEADERS),
};
const PROXY_ENV = {
	ANTHROPIC_BASE_URL: plain(BASE_URL),
	ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretId: "sec-1", version: "latest" },
};
/** The env keys `route` adds for a bare model id and the id it emits. */
const routeEnv = (bare: string, emitted: string) => ({
	FLEET_MODEL: plain(bare),
	ANTHROPIC_DEFAULT_SONNET_MODEL: plain(`${emitted}[1m]`),
	ANTHROPIC_DEFAULT_SONNET_MODEL_NAME: plain(bare),
	ANTHROPIC_DEFAULT_SONNET_MODEL_DESCRIPTION: plain("Codex subscription route"),
	ANTHROPIC_DEFAULT_SONNET_MODEL_SUPPORTED_CAPABILITIES: plain(
		"effort,thinking,adaptive_thinking,interleaved_thinking",
	),
	CLAUDE_CODE_AUTO_COMPACT_WINDOW: plain("288000"),
	CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: plain("92"),
	CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: plain("1"),
	CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS: plain("1"),
});
const patchedConfig = (i: number) =>
	((patches[i]?.body ?? {}) as { adapterConfig: Record<string, unknown> }).adapterConfig;

describe("claude-proxy --via bifrost and route", () => {
	beforeEach(() => {
		secrets.push({ id: "sec-bf", name: BF_SECRET, value: "bf-stored-value", latestVersion: 1 });
	});

	test("on --via bifrost sets exactly the three keys and leaves the rest of the stored config", async () => {
		const before = structuredClone(stored("a1"));
		const r = await run(["on", "--via", "bifrost", "--agents", "Bishop,Nagatha"]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([
			{ name: "Bishop", proxy: "on", via: "bifrost", key: "shared", http: 200 },
			{ name: "Nagatha", proxy: "on", via: "bifrost", key: "shared", http: 200 },
		]);
		for (let i = 0; i < patches.length; i++) expect(Object.keys(patchedConfig(i))).toEqual(["env"]);
		expect(stored("a1")).toEqual({
			...before,
			env: { FOO: plain("foo-stored"), RAW: "raw-stored", ...BF_ENV },
		});
		expect(stored("a5")).toEqual({ model: "m", env: BF_ENV });
		const headers = (envOf("a1").ANTHROPIC_CUSTOM_HEADERS as { value: string }).value;
		expect(headers.split("\n")).toEqual([
			"x-bf-cache-key: claudex-nocache",
			"x-bf-cache-no-store: true",
		]);
		expect(JSON.stringify(patches)).not.toContain(KEY);
	});

	test("on --via bifrost refuses when the Bifrost secret is missing", async () => {
		secrets = secrets.filter((s) => s.name !== BF_SECRET);
		const r = await run(["on", "--via", "bifrost"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain(BF_SECRET);
		expect(patches).toHaveLength(0);
	});

	test("secret --via bifrost creates the Bifrost secret and leaves the proxy one", async () => {
		secrets = secrets.filter((s) => s.name !== BF_SECRET);
		const r = await run(["secret", "--via=bifrost"]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([{ secret: BF_SECRET, id: "sec-new", action: "created" }]);
		expect(posts).toEqual([
			{
				path: `/api/companies/${COMPANY}/secrets`,
				body: { name: BF_SECRET, provider: "local_encrypted", value: KEY },
			},
		]);
		expect(secrets[0]?.value).toBe("old-stored-value");
	});

	test("off --via bifrost removes exactly the three keys", async () => {
		stored("a1").env = { FOO: plain("foo-stored"), ...BF_ENV };
		const r = await run(["off", "--via", "bifrost", "--agents", "Bishop"]);
		expect(r.code).toBe(0);
		expect(envOf("a1")).toEqual({ FOO: plain("foo-stored") });
		expect(stored("a1").model).toBe("claude-opus");
	});

	test("status reports via bifrost, proxy, off and partial, read-only", async () => {
		stored("a4").env = { ...BF_ENV };
		const r = await run(["status", "--agents", "Bishop,Chotek,Adams,Ski"]);
		expect(r.code).toBe(0);
		const by = Object.fromEntries(r.lines.map((l) => [l.name, l]));
		expect(by.Bishop.via).toBe("off");
		expect(by.Chotek.via).toBe("proxy");
		expect(by.Adams.via).toBe("partial");
		expect(by.Ski.via).toBe("bifrost");
		expect(by.Chotek.proxy).toBe("on");
		expect(by.Ski.proxy).toBe("partial");
		const b = await run(["status", "--via", "bifrost", "--agents", "Chotek,Ski"]);
		expect(b.lines.map((l) => [l.name, l.via, l.proxy])).toEqual([
			["Chotek", "proxy", "partial"],
			["Ski", "bifrost", "on"],
		]);
		expect(patches).toHaveLength(0);
	});

	test("route on a proxy agent sends the bare id as the literal model", async () => {
		const before = structuredClone(stored("a2"));
		const r = await run(["route", "Chotek", "gpt-6-astra", "medium"]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([
			{ name: "Chotek", via: "proxy", model: "gpt-6-astra", effort: "medium", http: 200 },
		]);
		expect(patches).toHaveLength(1);
		expect(patchedConfig(0).model).toBe("gpt-6-astra");
		expect(JSON.stringify(patches)).not.toContain("sonnet");
		expect(stored("a2")).toEqual({
			...before,
			model: "gpt-6-astra",
			effort: "medium",
			env: { ...PROXY_ENV, BAR: "x", ...routeEnv("gpt-6-astra", "gpt-6-astra") },
		});
	});

	test("route on a Bifrost agent sends claudex/<id> as the literal model", async () => {
		stored("a4").env = { ...BF_ENV, KEEP: "k" };
		const r = await run(["route", "Ski", "gpt-6.1-sol", "xhigh"]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([
			{ name: "Ski", via: "bifrost", model: "claudex/gpt-6.1-sol", effort: "xhigh", http: 200 },
		]);
		expect(patches).toHaveLength(1);
		expect(patchedConfig(0).model).toBe("claudex/gpt-6.1-sol");
		expect(JSON.stringify(patches)).not.toContain("sonnet");
		expect(stored("a4").effort).toBe("xhigh");
		expect(envOf("a4")).toEqual({
			...BF_ENV,
			KEEP: "k",
			...routeEnv("gpt-6.1-sol", "claudex/gpt-6.1-sol"),
		});
		expect(stored("a4").promptTemplate).toBe(PROMPT);
	});

	test("route refuses a model or effort off the list, a pi_local agent, and an agent not on a route", async () => {
		const before = structuredClone(agents);
		expect((await run(["route", "Chotek", "gpt-4o", "high"])).code).toBe(2);
		// Hidden by the proxy (model_not_found), so never a route target.
		expect((await run(["route", "Chotek", "gpt-5.6-terra", "high"])).code).toBe(2);
		expect((await run(["route", "Chotek", "gpt-5.5", "high"])).code).toBe(2);
		expect((await run(["route", "Chotek", "claudex/gpt-6-astra", "high"])).code).toBe(2);
		expect((await run(["route", "Chotek", "gpt-6-astra", "extreme"])).code).toBe(2);
		expect((await run(["route", "Chotek", "gpt-6-astra"])).code).toBe(2);
		expect((await run(["route", "Chotek"])).code).toBe(2);
		expect((await run(["route", "Pippa", "gpt-6-astra", "high"])).code).toBe(1);
		expect((await run(["route", "Bishop", "gpt-6-astra", "high"])).code).toBe(1);
		expect((await run(["route", "Adams", "gpt-6-astra", "high"])).code).toBe(1);
		expect((await run(["route", "Nobody", "gpt-6-astra", "high"])).code).toBe(1);
		expect((await run(["route", "Bishop", "back"])).code).toBe(1);
		expect(patches).toHaveLength(0);
		expect(agents).toEqual(before);
	});

	test("route back restores claude-opus-5-5 at high, removes the GPT-route keys, keeps the rest", async () => {
		stored("a2").model = "gpt-6-astra";
		stored("a2").effort = "medium";
		stored("a2").env = { ...PROXY_ENV, BAR: "x", ...routeEnv("gpt-6-astra", "gpt-6-astra") };
		const r = await run(["route", "Chotek", "back"]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([
			{ name: "Chotek", via: "proxy", model: "claude-opus-5-5", effort: "high", http: 200 },
		]);
		expect(stored("a2").model).toBe("claude-opus-5-5");
		expect(stored("a2").effort).toBe("high");
		const sent = patchedConfig(0).env as Env;
		for (const k of Object.keys(sent))
			expect(k.startsWith("ANTHROPIC_DEFAULT_SONNET_MODEL")).toBe(false);
		for (const k of [
			"CLAUDE_CODE_AUTO_COMPACT_WINDOW",
			"CLAUDE_AUTOCOMPACT_PCT_OVERRIDE",
			"CLAUDE_CODE_ALWAYS_ENABLE_EFFORT",
			"CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS",
		])
			expect(k in sent).toBe(false);
		expect(envOf("a2")).toEqual({ ...PROXY_ENV, BAR: "x", FLEET_MODEL: plain("claude-opus-5-5") });
	});

	test("on --via bifrost prefixes a routed GPT model; on --via proxy and off strip it again", async () => {
		stored("a2").model = "gpt-6-astra";
		stored("a2").env = { ...PROXY_ENV, BAR: "x", ...routeEnv("gpt-6-astra", "gpt-6-astra") };
		expect((await run(["on", "--via", "bifrost", "--agents", "Chotek"])).code).toBe(0);
		expect(stored("a2").model).toBe("claudex/gpt-6-astra");
		expect(envOf("a2")).toEqual({
			...BF_ENV,
			BAR: "x",
			...routeEnv("gpt-6-astra", "claudex/gpt-6-astra"),
		});

		expect((await run(["on", "--via", "proxy", "--agents", "Chotek"])).code).toBe(0);
		expect(stored("a2").model).toBe("gpt-6-astra");
		expect(envOf("a2")).toEqual({
			...PROXY_ENV,
			BAR: "x",
			...routeEnv("gpt-6-astra", "gpt-6-astra"),
		});
		expect("ANTHROPIC_CUSTOM_HEADERS" in envOf("a2")).toBe(false);

		expect((await run(["on", "--via", "bifrost", "--agents", "Chotek"])).code).toBe(0);
		expect(stored("a2").model).toBe("claudex/gpt-6-astra");
		expect((await run(["off", "--via", "bifrost", "--agents", "Chotek"])).code).toBe(0);
		expect(stored("a2").model).toBe("gpt-6-astra");
		expect(envOf("a2")).toEqual({ BAR: "x", ...routeEnv("gpt-6-astra", "gpt-6-astra") });
	});

	test("an unknown --via is bad usage", async () => {
		expect((await run(["on", "--via", "direct"])).code).toBe(2);
		expect((await run(["status", "--via"])).code).toBe(2);
		expect(patches).toHaveLength(0);
	});
});

/** An employee's own Bifrost virtual key: board secret `bifrost-vk-<lowercase name>`. */
const OWN_ENV = {
	...BF_ENV,
	ANTHROPIC_AUTH_TOKEN: { type: "secret_ref", secretId: "sec-vk-bishop", version: "latest" },
};

describe("claude-proxy with an employee's own Bifrost key", () => {
	beforeEach(() => {
		secrets.push(
			{ id: "sec-bf", name: BF_SECRET, value: "bf-stored-value", latestVersion: 1 },
			{
				id: "sec-vk-bishop",
				name: "bifrost-vk-bishop",
				value: "vk-bishop-value",
				latestVersion: 1,
			},
		);
	});

	test("status counts a token on the agent's own key as via bifrost, proxy on", async () => {
		stored("a1").env = { ...OWN_ENV };
		const r = await run(["status", "--via", "bifrost", "--agents", "Bishop"]);
		expect(r.code).toBe(0);
		expect(r.lines.map((l) => [l.name, l.via, l.proxy])).toEqual([["Bishop", "bifrost", "on"]]);
		expect(patches).toHaveLength(0);
	});

	test("on --via bifrost uses the own key where it exists, else the shared one", async () => {
		const r = await run(["on", "--via", "bifrost", "--agents", "Bishop,Ski"]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([
			{ name: "Bishop", proxy: "on", via: "bifrost", key: "own", http: 200 },
			{ name: "Ski", proxy: "on", via: "bifrost", key: "shared", http: 200 },
		]);
		const tok = (i: number) =>
			((patchedConfig(i).env as Env).ANTHROPIC_AUTH_TOKEN as { secretId: string }).secretId;
		expect(tok(0)).toBe("sec-vk-bishop");
		expect(tok(1)).toBe("sec-bf");
	});

	test("on --via bifrost needs no shared secret when every agent has its own key", async () => {
		secrets = secrets.filter((s) => s.name !== BF_SECRET);
		const r = await run(["on", "--via", "bifrost", "--agents", "Bishop"]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([
			{ name: "Bishop", proxy: "on", via: "bifrost", key: "own", http: 200 },
		]);
		expect(envOf("a1").ANTHROPIC_AUTH_TOKEN).toEqual(OWN_ENV.ANTHROPIC_AUTH_TOKEN);
	});

	test("on --via bifrost dies naming the agent with neither key and patches nobody", async () => {
		secrets = secrets.filter((s) => s.name !== BF_SECRET);
		const r = await run(["on", "--via", "bifrost", "--agents", "Bishop,Ski"]);
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("Ski");
		expect(r.stderr).toContain(BF_SECRET);
		expect(patches).toHaveLength(0);
	});

	test("route works for an agent on its own key", async () => {
		stored("a1").env = { ...OWN_ENV };
		const r = await run(["route", "Bishop", "gpt-6.1-sol", "high"]);
		expect(r.code).toBe(0);
		expect(r.lines).toEqual([
			{ name: "Bishop", via: "bifrost", model: "claudex/gpt-6.1-sol", effort: "high", http: 200 },
		]);
		expect(envOf("a1")).toEqual({ ...OWN_ENV, ...routeEnv("gpt-6.1-sol", "claudex/gpt-6.1-sol") });
	});

	test("route back on an own-key agent sends no GPT-route key and keeps every other key", async () => {
		stored("a1").model = "claudex/gpt-6.1-sol";
		stored("a1").env = {
			...OWN_ENV,
			KEEP: "k",
			...routeEnv("gpt-6.1-sol", "claudex/gpt-6.1-sol"),
			ANTHROPIC_DEFAULT_SONNET_MODEL_EXTRA: plain("x"),
		};
		const r = await run(["route", "Bishop", "back"]);
		expect(r.code).toBe(0);
		const sent = patchedConfig(0).env as Env;
		expect(Object.keys(sent).sort()).toEqual(
			[...Object.keys(OWN_ENV), "FLEET_MODEL", "KEEP"].sort(),
		);
		expect(envOf("a1")).toEqual({ ...OWN_ENV, KEEP: "k", FLEET_MODEL: plain("claude-opus-5-5") });
		expect(stored("a1").model).toBe("claude-opus-5-5");
	});
});
