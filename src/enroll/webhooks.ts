/**
 * @module enroll/webhooks
 * @description Per-repo Forgejo webhooks to the watcher host (sf#417 row 0e of sf#1076).
 *   Forgejo system hook 2 is a single all-events backstop; each managed repo
 *   also gets its own webhook whose events come from that repo's config.
 *   `ensureRepoHook` makes a repo's factory hook carry AT LEAST the events its
 *   config needs: it creates one when absent and patches the union onto the
 *   lowest-id existing one, never removing an event (a narrower config view
 *   must not drop events another consumer relies on). The patch omits
 *   `config`, so the stored secret is kept. `runWebhooksCommand` is the
 *   `enroll --webhooks` subcommand over every forgejo repo in the config.
 *   The token and the secret are never printed or logged.
 *
 * @outputs
 *   - `FACTORY_HOOK_URL` -- the the watcher host receiver the hooks deliver to
 *   - `eventsFor` -- a repo's config -> its sorted webhook event list
 *   - `HookApi` / `ExistingHook` / `HookOutcome` -- the injectable Forge seam and results
 *   - `liveHookApi` -- the fetch-backed HookApi
 *   - `ensureRepoHook` -- create or widen one repo's factory hook
 *   - `hookLine` -- one outcome -> its printed line
 *   - `liveToken` -- FORGEJO_TOKEN, else one bin/forgejo-token fetch
 *   - `runWebhooksCommand` -- `enroll --webhooks` argv -> exit code
 *
 * @dependencies
 *   - ../config/load -- the watcher config loader
 *   - ../config/schema -- RepositoryConfig
 *   - ../hostedapp/fetch -- DEFAULT_FORGE_API
 *   - ../log -- errorMessage
 */
import { join } from "node:path";
import { loadConfig } from "../config/load";
import type { RepositoryConfig } from "../config/schema";
import { DEFAULT_FORGE_API } from "../hostedapp/fetch";
import { errorMessage, traced } from "../log";

export const FACTORY_HOOK_URL = "http://10.0.21.0:8787/hooks/forgejo";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/** The webhook events a repo's config needs: sorted, de-duplicated. */
function eventsForImpl(repo: RepositoryConfig): string[] {
	const events = new Set(["pull_request", "pull_request_sync"]);
	if (repo.build_bump !== undefined) for (const e of ["create", "push"]) events.add(e);
	if (repo.implement_label !== undefined) {
		for (const e of ["issues", "issue_label", "issue_comment"]) events.add(e);
	}
	// Actions triage is dispatched only from an `issues` delivery (hooks/issue-triage.ts); box triage polls.
	if (repo.triage === true && repo.triage_runtime === "actions") events.add("issues");
	return [...events].sort();
}

export type ExistingHook = { id: number; url: string; events: string[]; active: boolean };

/** The Forge calls, each given the full `owner/name`. */
export type HookApi = {
	list(repo: string): Promise<ExistingHook[]>;
	create(repo: string, events: readonly string[], secret: string): Promise<number>;
	patch(repo: string, id: number, events: readonly string[]): Promise<void>;
};

export type HookOutcome =
	| { kind: "created"; id: number; events: string[] }
	| { kind: "updated"; id: number; added: string[] }
	| { kind: "ok"; id: number }
	| { kind: "would-create"; events: string[] }
	| { kind: "would-update"; id: number; added: string[] }
	| { kind: "refused"; reason: string };

/** A hook from the list response, or null when it fails the shape check. */
function toHook(raw: unknown): ExistingHook | null {
	const h = raw as { id?: unknown; events?: unknown; active?: unknown; config?: { url?: unknown } };
	if (h === null || typeof h !== "object") return null;
	if (typeof h.id !== "number" || typeof h.active !== "boolean") return null;
	if (!Array.isArray(h.events) || !h.events.every((e) => typeof e === "string")) return null;
	const url = h.config?.url;
	if (typeof url !== "string") return null;
	return { id: h.id, url, events: h.events as string[], active: h.active };
}

type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

/** The live HookApi. The token rides the Authorization header only; a non-2xx throws with the status, never the body. */
function liveHookApiImpl(
	token: string,
	api: string = DEFAULT_FORGE_API,
	fetchImpl: FetchImpl = fetch,
): HookApi {
	async function call(verb: string, path: string, method: string, body?: unknown) {
		const res = await fetchImpl(`${api}${path}`, {
			method,
			headers: { Authorization: `token ${token}`, "Content-Type": "application/json" },
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(15_000),
		});
		if (!res.ok) throw new Error(`forge hook ${verb} failed: HTTP ${res.status}`);
		return res;
	}
	return {
		async list(repo) {
			const res = await call("list", `/repos/${repo}/hooks?limit=50`, "GET");
			const raw: unknown = await res.json();
			if (!Array.isArray(raw)) throw new Error("forge hook list failed: not an array");
			return raw.map(toHook).filter((h): h is ExistingHook => h !== null);
		},
		async create(repo, events, secret) {
			const body = {
				type: "forgejo",
				active: true,
				events,
				branch_filter: "*",
				config: { url: FACTORY_HOOK_URL, content_type: "json", secret },
			};
			const res = await call("create", `/repos/${repo}/hooks`, "POST", body);
			const id = ((await res.json()) as { id?: unknown }).id;
			if (typeof id !== "number") throw new Error("forge hook create failed: no id");
			return id;
		},
		async patch(repo, id, events) {
			await call("patch", `/repos/${repo}/hooks/${id}`, "PATCH", { active: true, events });
		},
	};
}

/** Create or widen `repo`'s factory hook so it carries at least `events`; never removes one. */
async function ensureRepoHookImpl(
	api: HookApi,
	repo: string,
	events: readonly string[],
	opts: { secret?: string; dryRun: boolean },
): Promise<HookOutcome> {
	const ours = (await api.list(repo))
		.filter((h) => h.url === FACTORY_HOOK_URL)
		.sort((a, b) => a.id - b.id);
	const hook = ours[0];
	if (hook === undefined) {
		if (opts.dryRun) return { kind: "would-create", events: [...events] };
		if (opts.secret === undefined || opts.secret === "") {
			return { kind: "refused", reason: "FORGE_WEBHOOK_SECRET unset" };
		}
		return {
			kind: "created",
			id: await api.create(repo, events, opts.secret),
			events: [...events],
		};
	}
	const added = events.filter((e) => !hook.events.includes(e));
	if (added.length === 0 && hook.active) return { kind: "ok", id: hook.id };
	if (opts.dryRun) return { kind: "would-update", id: hook.id, added };
	const union = [...new Set([...hook.events, ...events])].sort();
	await api.patch(repo, hook.id, union);
	return { kind: "updated", id: hook.id, added };
}

/** One outcome -> its printed line (without the repo prefix). */
function hookLineImpl(outcome: HookOutcome): string {
	switch (outcome.kind) {
		case "created":
			return `created hook ${outcome.id} events=${outcome.events.join(",")}`;
		case "updated":
			return `updated hook ${outcome.id} +${outcome.added.join(",")}`;
		case "ok":
			return `ok hook ${outcome.id}`;
		case "would-create":
			return `would create events=${outcome.events.join(",")}`;
		case "would-update":
			return `would update hook ${outcome.id} +${outcome.added.join(",")}`;
		case "refused":
			return `refused: ${outcome.reason}`;
	}
}

/** The live token: FORGEJO_TOKEN, else one bin/forgejo-token fetch. */
function liveTokenImpl(): string {
	const fromEnv = process.env.FORGEJO_TOKEN;
	if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
	const result = Bun.spawnSync([join(REPO_ROOT, "bin", "forgejo-token")], { stderr: "ignore" });
	const token = result.stdout.toString().trim();
	if (result.exitCode !== 0 || token === "") throw new Error("no Forge token");
	return token;
}

export type WebhooksDeps = {
	token?: () => string;
	/** Build the HookApi from the token; defaults to liveHookApi. */
	hooks?: (token: string) => HookApi;
	secret?: () => string | undefined;
	out?: (line: string) => void;
};

type WebhooksArgs = { configPath: string; repos: string[]; dryRun: boolean };

const WEBHOOKS_USAGE =
	"usage: enroll --webhooks [--repo <owner/name>]... [--config <path>] [--dry-run]";

function parseWebhooksArgs(args: readonly string[]): WebhooksArgs | string {
	const parsed: WebhooksArgs = {
		configPath: join(REPO_ROOT, "config", "repos.yml"),
		repos: [],
		dryRun: false,
	};
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		const next = args[i + 1];
		if (arg === "--webhooks") continue;
		if (arg === "--dry-run") parsed.dryRun = true;
		else if (arg === "--config" && next !== undefined) {
			parsed.configPath = next;
			i += 1;
		} else if (arg === "--repo" && next !== undefined) {
			parsed.repos.push(next);
			i += 1;
		} else return `unknown or incomplete option: ${arg}`;
	}
	return parsed;
}

/** The forgejo repos selected by `--repo` (all when none), or an error naming an unknown one. */
async function selectRepos(parsed: WebhooksArgs): Promise<RepositoryConfig[] | string> {
	const loaded = await loadConfig(parsed.configPath);
	if (!loaded.ok) return loaded.error;
	const forgejo = loaded.config.repositories.filter((r) => r.provider === "forgejo");
	if (parsed.repos.length === 0) return forgejo;
	const unknown = parsed.repos.find((name) => !forgejo.some((r) => r.name === name));
	if (unknown !== undefined) return `not a managed forgejo repository: ${unknown}`;
	return forgejo.filter((r) => parsed.repos.includes(r.name));
}

/** `enroll --webhooks` argv -> 0 all fine, 1 any refused/failed, 2 usage/unknown repo/bad config, 3 no token. */
async function runWebhooksCommandImpl(
	args: readonly string[],
	deps: WebhooksDeps = {},
): Promise<number> {
	const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
	const parsed = parseWebhooksArgs(args);
	const repos = typeof parsed === "string" ? parsed : await selectRepos(parsed);
	if (typeof parsed === "string" || typeof repos === "string") {
		process.stderr.write(`enroll --webhooks: ${repos as string}\n${WEBHOOKS_USAGE}\n`);
		return 2;
	}
	let api: HookApi;
	try {
		const token = (deps.token ?? liveToken)();
		api = (deps.hooks ?? liveHookApi)(token);
	} catch (error) {
		process.stderr.write(`enroll --webhooks: ${errorMessage(error)}\n`);
		return 3;
	}
	const secret = (deps.secret ?? (() => process.env.FORGE_WEBHOOK_SECRET))();
	let code = 0;
	for (const repo of repos) {
		try {
			const outcome = await ensureRepoHook(api, repo.name, eventsFor(repo), {
				secret,
				dryRun: parsed.dryRun,
			});
			if (outcome.kind === "refused") code = 1;
			out(`${repo.name}: ${hookLine(outcome)}`);
		} catch (error) {
			code = 1;
			out(`${repo.name}: failed: ${errorMessage(error)}`);
		}
	}
	return code;
}

export const eventsFor = traced("enroll.eventsFor", eventsForImpl);
export const liveHookApi = traced("enroll.liveHookApi", liveHookApiImpl, { redact: { args: [0] } });
export const ensureRepoHook = traced("enroll.ensureRepoHook", ensureRepoHookImpl, {
	redact: { args: [3] },
});
export const hookLine = traced("enroll.hookLine", hookLineImpl);
export const liveToken = traced("enroll.liveToken", liveTokenImpl, { redact: { result: true } });
export const runWebhooksCommand = traced("enroll.runWebhooksCommand", runWebhooksCommandImpl, {
	redact: { args: [1] },
});
