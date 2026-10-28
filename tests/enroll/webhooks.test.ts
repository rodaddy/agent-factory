/**
 * Tests for per-repo Forgejo webhooks. Offline: a recording
 * fake HookApi, a fixture config under the portable test temp base, and an
 * injected fetch for the live API.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RepositoryConfig } from "../../src/config/schema";
import {
	type ExistingHook,
	ensureRepoHook,
	eventsFor,
	FACTORY_HOOK_URL,
	type HookApi,
	liveHookApi,
	runWebhooksCommand,
} from "../../src/enroll/webhooks";
import { testTmpBase } from "../support/test-temp";

type Call = { verb: string; repo: string; args: unknown[] };

function fakeApi(
	hooks: Record<string, ExistingHook[]>,
	calls: Call[],
	failOn: string[] = [],
): HookApi {
	return {
		list: async (repo) => {
			calls.push({ verb: "list", repo, args: [] });
			if (failOn.includes(repo)) throw new Error("forge hook list failed: HTTP 500");
			return hooks[repo] ?? [];
		},
		create: async (repo, events, secret) => {
			calls.push({ verb: "create", repo, args: [[...events], secret] });
			return 77;
		},
		patch: async (repo, id, events) => {
			calls.push({ verb: "patch", repo, args: [id, [...events]] });
		},
	};
}

const hook = (id: number, events: string[], active = true, url = FACTORY_HOOK_URL) => ({
	id,
	url,
	events,
	active,
});

const repo = (extra: object): RepositoryConfig =>
	({ name: "a/b", provider: "forgejo", ...extra }) as unknown as RepositoryConfig;

describe("eventsFor", () => {
	test("plain, build_bump, and implement_label repos, sorted", () => {
		expect(eventsFor(repo({}))).toEqual(["pull_request", "pull_request_sync"]);
		expect(eventsFor(repo({ build_bump: {} }))).toEqual([
			"create",
			"pull_request",
			"pull_request_sync",
			"push",
		]);
		expect(eventsFor(repo({ implement_label: "go" }))).toEqual([
			"issue_comment",
			"issue_label",
			"issues",
			"pull_request",
			"pull_request_sync",
		]);
	});

	test("Actions triage needs issues events; box triage polls and needs none", () => {
		// src/hooks/issue-triage.ts dispatches only on an `issues` opened/reopened delivery.
		expect(eventsFor(repo({ triage: true, triage_runtime: "actions" }))).toEqual([
			"issues",
			"pull_request",
			"pull_request_sync",
		]);
		expect(eventsFor(repo({ triage: true }))).toEqual(["pull_request", "pull_request_sync"]);
		expect(eventsFor(repo({ triage: false, triage_runtime: "actions" }))).toEqual([
			"pull_request",
			"pull_request_sync",
		]);
	});
});

describe("ensureRepoHook", () => {
	const NEED = ["create", "pull_request"];

	test("no hook -> create with the secret and events", async () => {
		const calls: Call[] = [];
		const r = await ensureRepoHook(fakeApi({}, calls), "a/b", NEED, {
			secret: "s",
			dryRun: false,
		});
		expect(r).toEqual({ kind: "created", id: 77, events: NEED });
		expect(calls[1]).toEqual({ verb: "create", repo: "a/b", args: [NEED, "s"] });
	});

	test("no hook and no secret -> refused, create not called", async () => {
		const calls: Call[] = [];
		const r = await ensureRepoHook(fakeApi({}, calls), "a/b", NEED, { dryRun: false });
		expect(r).toEqual({ kind: "refused", reason: "FORGE_WEBHOOK_SECRET unset" });
		expect(calls.map((c) => c.verb)).toEqual(["list"]);
	});

	test("existing subset -> patch with the union, added listed", async () => {
		const calls: Call[] = [];
		const api = fakeApi({ "a/b": [hook(9, ["pull_request", "issues"]), hook(4, ["push"])] }, calls);
		const r = await ensureRepoHook(api, "a/b", NEED, { secret: "s", dryRun: false });
		expect(r).toEqual({ kind: "updated", id: 4, added: NEED });
		expect(calls[1]).toEqual({
			verb: "patch",
			repo: "a/b",
			args: [4, ["create", "pull_request", "push"]],
		});
	});

	test("existing superset -> ok, no patch (never removes)", async () => {
		const calls: Call[] = [];
		const api = fakeApi({ "a/b": [hook(3, ["create", "issues", "pull_request"])] }, calls);
		const r = await ensureRepoHook(api, "a/b", NEED, { dryRun: false });
		expect(r).toEqual({ kind: "ok", id: 3 });
		expect(calls.map((c) => c.verb)).toEqual(["list"]);
	});

	test("inactive hook with all events -> patch", async () => {
		const calls: Call[] = [];
		const api = fakeApi({ "a/b": [hook(3, NEED, false)] }, calls);
		const r = await ensureRepoHook(api, "a/b", NEED, { dryRun: false });
		expect(r).toEqual({ kind: "updated", id: 3, added: [] });
		expect(calls[1]?.verb).toBe("patch");
	});

	test("a hook at another URL is ignored", async () => {
		const calls: Call[] = [];
		const api = fakeApi({ "a/b": [hook(3, NEED, true, "http://elsewhere/hook")] }, calls);
		const r = await ensureRepoHook(api, "a/b", NEED, { secret: "s", dryRun: false });
		expect(r.kind).toBe("created");
	});

	test("dry run -> would-*, no create/patch", async () => {
		const calls: Call[] = [];
		const api = fakeApi({ "x/y": [hook(5, ["push"])] }, calls);
		expect(await ensureRepoHook(api, "a/b", NEED, { secret: "s", dryRun: true })).toEqual({
			kind: "would-create",
			events: NEED,
		});
		expect(await ensureRepoHook(api, "x/y", NEED, { secret: "s", dryRun: true })).toEqual({
			kind: "would-update",
			id: 5,
			added: NEED,
		});
		expect(calls.every((c) => c.verb === "list")).toBe(true);
	});
});

describe("runWebhooksCommand", () => {
	const dir = mkdtempSync(join(testTmpBase(), "rw-enroll-webhooks-"));
	const config = join(dir, "repos.yml");
	writeFileSync(
		config,
		[
			"poll_interval_minutes: 15",
			"repositories:",
			"  - name: a/one",
			"    provider: forgejo",
			"  - name: a/two",
			"    provider: forgejo",
			"  - name: a/gh",
			"    provider: github",
			"",
		].join("\n"),
	);

	async function run(args: string[], failOn: string[] = []) {
		const calls: Call[] = [];
		const lines: string[] = [];
		const code = await runWebhooksCommand(["--webhooks", "--config", config, ...args], {
			token: () => "t",
			hooks: () => fakeApi({}, calls, failOn),
			secret: () => "s",
			out: (l) => lines.push(l),
		});
		return { code, lines, calls };
	}

	test("--repo filters to the named forgejo repos", async () => {
		const { code, lines } = await run(["--dry-run", "--repo", "a/two"]);
		expect(code).toBe(0);
		expect(lines).toEqual(["a/two: would create events=pull_request,pull_request_sync"]);
	});

	test("an unknown --repo is exit 2", async () => {
		expect((await run(["--repo", "a/gh"])).code).toBe(2);
	});

	test("one repo's list throwing prints failed, the rest still run, exit 1", async () => {
		const { code, lines } = await run([], ["a/one"]);
		expect(code).toBe(1);
		expect(lines).toEqual([
			"a/one: failed: forge hook list failed: HTTP 500",
			"a/two: created hook 77 events=pull_request,pull_request_sync",
		]);
	});

	test("no token is exit 3", async () => {
		const code = await runWebhooksCommand(["--webhooks", "--config", config], {
			token: () => {
				throw new Error("no Forge token");
			},
			out: () => {},
		});
		expect(code).toBe(3);
	});
});

describe("liveHookApi", () => {
	type Seen = { url: string; init: RequestInit };
	function api(seen: Seen[], status: number, body: unknown): HookApi {
		return liveHookApi("TOKEN123", "https://forge.test/api/v1", async (url, init) => {
			seen.push({ url, init });
			return new Response(JSON.stringify(body), { status });
		});
	}

	test("token only in the Authorization header; list shape-checks hooks", async () => {
		const seen: Seen[] = [];
		const hooks = await api(seen, 200, [
			{ id: 1, active: true, events: ["push"], config: { url: FACTORY_HOOK_URL } },
			{ id: "bad" },
		]).list("a/b");
		expect(hooks).toEqual([hook(1, ["push"])]);
		expect(seen[0]?.url).toBe("https://forge.test/api/v1/repos/a/b/hooks?limit=50");
		expect(seen[0]?.url).not.toContain("TOKEN123");
		expect((seen[0]?.init.headers as Record<string, string> | undefined)?.Authorization).toBe(
			"token TOKEN123",
		);
	});

	test("PATCH body has no config key", async () => {
		const seen: Seen[] = [];
		await api(seen, 200, {}).patch("a/b", 4, ["push"]);
		expect(seen[0]?.init.method).toBe("PATCH");
		expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ active: true, events: ["push"] });
	});

	test("non-2xx throws with the status, never the body", async () => {
		const seen: Seen[] = [];
		const err = await api(seen, 403, { message: "SECRET-BODY" })
			.create("a/b", ["push"], "s")
			.catch((e: Error) => e);
		expect(String(err)).toContain("forge hook create failed: HTTP 403");
		expect(String(err)).not.toContain("SECRET-BODY");
	});
});
