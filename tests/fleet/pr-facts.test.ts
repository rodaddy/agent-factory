/**
 * @module tests/fleet/pr-facts
 * @description `fleet/bin/pr-facts`, the one read a seat makes for a
 *   pull request's facts, run as a real child process against a fake Forge:
 *   file pagination and the truncation cap, a missing commit status, the
 *   latest verdict comment found or absent, and the token kept out of argv and
 *   output. `PR_FACTS_UNDER_TEST` points the suite at a mutated copy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT =
	process.env.PR_FACTS_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/pr-facts");
const TOKEN = ["fake", "forge", "value", "1690"].join("-");
const SHA = "a".repeat(40);

/** `count` fake changed files, numbered from 1. */
const files = (count: number) =>
	Array.from({ length: count }, (_, i) => ({
		filename: `src/f${i + 1}.ts`,
		additions: i + 1,
		deletions: 1,
	}));
const FILES: Record<string, ReturnType<typeof files>> = {
	"o/r": files(60),
	"o/big": files(230),
	"o/nostat": files(1),
};

const comment = (login: string, hour: number, body: string) => ({
	user: { login },
	created_at: `2026-10-06T${hour}:00:00Z`,
	body,
});
const OLD = "**agent:** czajka · x\n## Review of o/r#7 at bbbbbbb\nverdict: fix-first\n";
const NEW = `**agent:** adams · x\n## Review of o/r#7 at ${SHA}\nverdict: approve-with-fixes\n`;
const INLINE = "fine, but verdict: approve is not on its own line";
const COMMENTS: Record<string, unknown[]> = {
	"o/r": [
		comment("harness", 10, OLD),
		comment("harness", 11, NEW),
		comment("rodaddy0", 12, INLINE),
	],
	"o/big": [comment("x", 10, "no verdict here")],
};

const seen: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let api = "";

/** Whether `port` can be bound on loopback right now. */
function isFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

/** First free port in 7150-7179 (7141 is reserved and outside it). */
async function freePort(): Promise<number> {
	for (let port = 7150; port <= 7179; port++) {
		if (await isFree(port)) return port;
	}
	throw new Error("no free port in 7150-7179");
}

function pull(repo: string) {
	const all = FILES[repo] ?? [];
	return {
		title: "feat: thing",
		state: "open",
		merged: false,
		draft: false,
		mergeable: true,
		body: "## Backout\nrevert\n\n## Test plan\nbun test\n",
		user: { login: "bishop" },
		base: { ref: "main" },
		head: { ref: "feat/x", sha: SHA },
		labels: [{ name: "kind:fix" }, { name: "size:s" }],
		additions: all.reduce((n, f) => n + f.additions, 0),
		deletions: all.length,
		changed_files: all.length,
	};
}

const STATUS = {
	state: "failure",
	statuses: [
		{ context: "factory/prepush", status: "success" },
		{ context: "factory/pr-review", status: "failure" },
	],
};

const fixtureDir = mkdtempSync(join(tmpdir(), "pr-facts-test-"));
const argvLog = join(fixtureDir, "curl-argv.log");

beforeAll(async () => {
	// A curl on PATH that logs its argv, then runs the real one.
	const shim = join(fixtureDir, "curl");
	const real = Bun.which("curl") ?? "/usr/bin/curl";
	writeFileSync(
		shim,
		`#!/usr/bin/env bash\nprintf '%s\\n' "$*" >> '${argvLog}'\nexec '${real}' "$@"\n`,
	);
	chmodSync(shim, 0o755);

	server = Bun.serve({
		port: await freePort(),
		hostname: "127.0.0.1",
		fetch(request) {
			const url = new URL(request.url);
			seen.push(`${url.pathname}${url.search}`);
			if (request.headers.get("authorization") !== `token ${TOKEN}`) {
				return Response.json({ message: "unauthorized" }, { status: 401 });
			}
			const [, repo = "", rest = ""] = url.pathname.match(/^\/repos\/([^/]+\/[^/]+)\/(.*)$/) ?? [];
			if (repo === "o/fail") return Response.json({ message: "boom" }, { status: 500 });
			if (rest === "pulls/7") return Response.json(pull(repo));
			if (rest === "pulls/7/files") {
				const limit = Number(url.searchParams.get("limit") ?? 30);
				const page = Number(url.searchParams.get("page") ?? 1);
				return Response.json((FILES[repo] ?? []).slice((page - 1) * limit, page * limit));
			}
			if (rest === `commits/${SHA}/status` && repo !== "o/nostat") return Response.json(STATUS);
			if (rest === "issues/7/comments") return Response.json(COMMENTS[repo] ?? []);
			return Response.json({ message: "not found" }, { status: 404 });
		},
	});
	api = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
	rmSync(fixtureDir, { recursive: true, force: true });
});

beforeEach(() => {
	seen.length = 0;
	writeFileSync(argvLog, "");
});

async function run(args: string[], drop?: string) {
	const env: Record<string, string> = {
		PATH: `${fixtureDir}:${process.env.PATH}`,
		FORGEJO_API_URL: api,
		FORGEJO_TOKEN: TOKEN,
	};
	if (drop) delete env[drop];
	// The bash on PATH: Apple's /bin/bash 3.2 is not a supported runtime here.
	const child = Bun.spawn([Bun.which("bash") ?? "/bin/bash", SCRIPT, ...args], {
		env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

describe("pr-facts", () => {
	test("one compact JSON object: PR facts, files across two pages, status and latest verdict", async () => {
		const result = await run(["o/r", "7"]);
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout.trim().split("\n")).toHaveLength(1);
		const facts = JSON.parse(result.stdout);
		expect(facts).toMatchObject({
			title: "feat: thing",
			state: "open",
			merged: false,
			draft: false,
			author: "bishop",
			base: "main",
			head: { ref: "feat/x", sha: SHA },
			mergeable: true,
			labels: ["kind:fix", "size:s"],
			totals: { changed_files: 60, additions: 1830, deletions: 60 },
			truncated: false,
		});
		expect(facts.body).toContain("## Test plan");
		expect(facts.files).toHaveLength(60);
		expect(facts.files[59]).toEqual({ path: "src/f60.ts", additions: 60, deletions: 1 });
		expect(seen).toContain("/repos/o/r/pulls/7/files?limit=50&page=2");
		expect(seen).not.toContain("/repos/o/r/pulls/7/files?limit=50&page=3");
		expect(facts.status).toEqual({
			state: "failure",
			contexts: [
				{ context: "factory/prepush", state: "success" },
				{ context: "factory/pr-review", state: "failure" },
			],
		});
		expect(facts.verdict).toEqual({
			author: "harness",
			agent: "adams",
			created: "2026-10-06T11:00:00Z",
			verdict: "approve-with-fixes",
			sha: SHA,
		});
	});

	test("more files than the cap: the list stops at 200, truncated is true, no verdict is null", async () => {
		const facts = JSON.parse((await run(["o/big", "7"])).stdout);
		expect(facts.files).toHaveLength(200);
		expect(facts.truncated).toBe(true);
		expect(facts.totals.changed_files).toBe(230);
		expect(facts.verdict).toBeNull();
	});

	test("no commit status for the head is status null, not a failure", async () => {
		const result = await run(["o/nostat", "7"]);
		expect(result.code).toBe(0);
		const facts = JSON.parse(result.stdout);
		expect(facts.status).toBeNull();
		expect(facts.truncated).toBe(false);
		expect(facts.verdict).toBeNull();
	});

	test("refusals: HTTP 500 is exit 1, bad arguments exit 2, missing token exit 3", async () => {
		const failed = await run(["o/fail", "7"]);
		expect(failed.code).toBe(1);
		expect(failed.stderr).toContain("HTTP 500");
		expect(failed.stdout).toBe("");
		seen.length = 0;
		for (const args of [["o/r;x", "7"], ["o/r", "7x"], ["o/r"]]) {
			const result = await run(args);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("usage: pr-facts");
		}
		const noToken = await run(["o/r", "7"], "FORGEJO_TOKEN");
		expect(noToken.code).toBe(3);
		expect(noToken.stderr).toContain("FORGEJO_TOKEN");
		expect(seen).toHaveLength(0);
	});

	test("the token never reaches curl's argv or the output, and every request authenticates", async () => {
		const result = await run(["o/r", "7"]);
		expect(result.code).toBe(0);
		const argv = readFileSync(argvLog, "utf8");
		expect(argv.split("\n").filter(Boolean).length).toBeGreaterThanOrEqual(4);
		expect(argv).not.toContain(TOKEN);
		expect(result.stdout + result.stderr).not.toContain(TOKEN);
		expect((await run(["o/fail", "7"])).stderr).not.toContain(TOKEN);
	});
});
