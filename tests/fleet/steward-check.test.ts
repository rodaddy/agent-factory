/**
 * @module tests/fleet/steward-check
 * @description `fleet/skills/repo-steward/bin/steward-check` run as a
 *   real child process against a tiny fake Forge for one repo. Pins: a blank
 *   wiki and no topics fail, a description passes, a tag lag is detected, the
 *   output is JSON, and the token never leaks. `STEWARD_CHECK_UNDER_TEST`
 *   points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRIPT =
	process.env.STEWARD_CHECK_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/skills/repo-steward/bin/steward-check");
const TOKEN = "tok-SECRET-1185-do-not-leak";
const REPO = "acme/widget";

let server: ReturnType<typeof Bun.serve>;
let api = "";
let authSeen: (string | null)[] = [];
let failHooks = false;

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

const b64 = (s: string) => Buffer.from(s).toString("base64");

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			authSeen.push(req.headers.get("authorization"));
			const path = new URL(req.url).pathname.replace(/^\/api\/v1/, "");
			const base = `/repos/${REPO}`;
			if (path === base)
				return json({
					full_name: REPO,
					description: "A widget service",
					has_wiki: true,
					default_branch: "main",
					empty: false,
					archived: false,
					mirror: false,
				});
			if (path === `${base}/topics`) return json({ topics: [] });
			if (path === `${base}/readme` || path === `${base}/contents/README.md`)
				return json({ name: "README.md", content: b64("# widget") });
			if (path.startsWith(`${base}/wiki/`))
				return json({ message: "The target couldn't be found." }, 404);
			if (path === `${base}/tags`) return json([{ name: "v0.3.0", commit: { sha: "abc" } }]);
			if (path === `${base}/contents/VERSION`)
				return json({ name: "VERSION", content: b64("0.3.16\n") });
			if (path === `${base}/pulls`) return json([]);
			if (path === `${base}/branches`)
				return json([{ name: "main", commit: { timestamp: new Date().toISOString() } }]);
			if (path === `${base}/hooks`) return failHooks ? json({ message: "boom" }, 500) : json([]);
			return json({ message: "not found" }, 404);
		},
	});
	api = `http://127.0.0.1:${server.port}/api/v1`;
});

afterAll(() => server.stop(true));

interface Check {
	id: string;
	rule: string;
	status: "pass" | "fail" | "n/a" | "error";
	evidence: string;
	fix: "self" | "report";
}

async function run(): Promise<{ code: number; out: string; err: string }> {
	authSeen = [];
	const proc = Bun.spawn(["python3", SCRIPT, REPO, "--base-url", api], {
		env: { PATH: process.env.PATH ?? "", FORGEJO_TOKEN: TOKEN },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [out, err, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, out, err };
}

function byId(checks: Check[], id: string): Check {
	const c = checks.find((x) => x.id === id);
	if (!c) throw new Error(`no check ${id}`);
	return c;
}

describe("steward-check against a fake Forge", () => {
	test("emits parseable JSON for the repo and exits 0 with fails present", async () => {
		const { code, out } = await run();
		expect(code).toBe(0);
		const doc = JSON.parse(out);
		expect(doc.repo).toBe(REPO);
		expect(typeof doc.checkedAt).toBe("string");
		expect(Array.isArray(doc.checks)).toBe(true);
	});

	test("blank wiki and no topics fail; description passes", async () => {
		const checks: Check[] = JSON.parse((await run()).out).checks;
		expect(byId(checks, "wiki-home").status).toBe("fail");
		expect(byId(checks, "wiki-home").fix).toBe("self");
		expect(byId(checks, "topics").status).toBe("fail");
		// Forge needs admin to write topics and description, which the steward
		// does not have (SOF-8573): both are reported, never fixed.
		expect(byId(checks, "topics").fix).toBe("report");
		expect(byId(checks, "description").status).toBe("pass");
		expect(byId(checks, "description").fix).toBe("report");
	});

	test("tag lag: VERSION 0.3.16 vs latest tag v0.3.0 fails as report", async () => {
		const lag = byId(JSON.parse((await run()).out).checks, "tag-lag");
		expect(lag.status).toBe("fail");
		expect(lag.fix).toBe("report");
		expect(lag.evidence).toContain("0.3.16");
		expect(lag.evidence).toContain("0.3.0");
	});

	test("token goes in the header only, never stdout or stderr", async () => {
		const { out, err } = await run();
		expect(out).not.toContain(TOKEN);
		expect(err).not.toContain(TOKEN);
		expect(authSeen.length).toBeGreaterThan(0);
		expect(authSeen.every((a) => a === `token ${TOKEN}`)).toBe(true);
	});

	test("one failing Forge call marks its check error and the run goes on", async () => {
		failHooks = true;
		try {
			const { code, out } = await run();
			expect(code).toBe(0);
			const checks: Check[] = JSON.parse(out).checks;
			expect(checks.some((c) => c.status === "error" && c.evidence.includes("hooks"))).toBe(true);
			expect(byId(checks, "tag-lag").status).toBe("fail");
			expect(byId(checks, "description").status).toBe("pass");
		} finally {
			failHooks = false;
		}
	});
});
