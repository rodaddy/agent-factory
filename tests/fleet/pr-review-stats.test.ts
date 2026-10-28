/**
 * @module tests/fleet/pr-review-stats
 * @description `fleet/bin/pr-review-stats`, PR size against review speed, run
 *   as a real child process against a fake Forge (`Bun.serve`).
 *   `PR_REVIEW_STATS_UNDER_TEST` points the suite at a mutated copy.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const SCRIPT =
	process.env.PR_REVIEW_STATS_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/bin/pr-review-stats");
// Built at runtime so no credential-looking literal sits in the file.
const TOKEN = ["fake", "forge", "token", String(Date.now())].join("-");
const R = "/api/v1/repos/o/r";

const at = (day: number, hour: number) =>
	new Date(Date.UTC(2026, 9, day, hour)).toISOString().replace(".000Z", "Z");
const pr = (
	n: number,
	base: string,
	head: string,
	open: number[],
	merged: number[],
	body = "",
) => ({
	number: n,
	body,
	base: { ref: base },
	head: { ref: head },
	created_at: at(open[0] as number, open[1] as number),
	merged_at: at(merged[0] as number, merged[1] as number),
	closed_at: at(merged[0] as number, merged[1] as number),
	updated_at: at(merged[0] as number, merged[1] as number),
});

// #1 is one 840-line change; #2-#4 are a stack of three 350s; #5 is outside the window.
// #6 merges main into release, #7 is 900 lines on a parent outside the window, and
// #8 is a fork PR whose head is also named s1: none of them may join a stack.
const PULLS = [
	pr(1, "main", "big", [2, 0], [2, 10], "Fixes https://git.example/o/r/issues/77"),
	pr(2, "main", "s1", [3, 0], [3, 5]),
	pr(3, "s1", "s2", [3, 1], [3, 6]),
	pr(4, "s2", "s3", [3, 2], [3, 8]),
	{ ...pr(5, "main", "old", [1, 0], [1, 1]), closed_at: "2026-09-01T00:00:00Z" },
	pr(6, "release", "main", [4, 0], [4, 1]),
	pr(7, "gone", "orphan", [4, 0], [4, 2]),
	{ ...pr(8, "main", "s1", [4, 0], [4, 3]), head: { ref: "s1", repo: { full_name: "fork/r" } } },
];
const f = (filename: string, additions: number, deletions = 0) => ({
	filename,
	additions,
	deletions,
});
const FILES: Record<number, unknown[]> = {
	1: [
		f("src/a.ts", 300, 50),
		f("src/b.ts", 100),
		f("src/c.ts", 50),
		f("tests/c.test.ts", 390, 700),
		f("README.md", 500),
		f("docs/notes.txt", 40),
		f("bun.lock", 900),
	],
	2: [f("src/s1.ts", 350)],
	3: [f("src/s2.ts", 350)],
	4: [f("src/s3.ts", 350)],
	7: [f("src/o.ts", 900)],
};
const c = (id: number, login: string, hour: number, body: string) => ({
	id,
	user: { login },
	created_at: at(2, hour),
	body,
});
const COMMENTS: Record<number, unknown[]> = {
	1: [
		c(1, "rico", 1, "verdict: fix-first"),
		c(2, "sf-smythe", 2, "## Review\nverdict: fix-first\n"),
		c(3, "sf-smythe", 3, "the last verdict: approve was early"),
		c(4, "factory", 5, "verdict: approve"),
		c(5, "factory", 1, "verdict: fix-first"),
	],
};

let status = 200;
let paths: string[] = [];
let forge: ReturnType<typeof Bun.serve>;

function page(items: unknown[], url: URL) {
	const limit = Number(url.searchParams.get("limit") ?? 30);
	const p = Number(url.searchParams.get("page") ?? 1);
	return Response.json(items.slice((p - 1) * limit, p * limit));
}

beforeAll(() => {
	forge = Bun.serve({
		port: 0,
		fetch(req) {
			const url = new URL(req.url);
			paths.push(`${req.method} ${url.pathname}`);
			if (req.method !== "GET") return new Response("no writes", { status: 405 });
			const auth = req.headers.get("authorization");
			if (auth !== `token ${TOKEN}`) return new Response("unauthorized", { status: 401 });
			// The error body echoes the token, so only the scrub keeps it off stderr.
			if (status !== 200) return new Response(`boom ${auth}`, { status });
			if (url.pathname === R) return Response.json({ default_branch: "main" });
			if (url.pathname === `${R}/pulls`) return page(PULLS, url);
			const m = url.pathname.match(/\/(pulls|issues)\/(\d+)\/(files|commits|comments)$/);
			const n = Number(m?.[2]);
			if (m?.[3] === "files") return page(FILES[n] ?? [], url);
			if (m?.[3] === "commits")
				return page(
					[1, 2, 3, 4].slice(0, n === 1 ? 4 : 1).map((i) => ({ sha: `${n}-${i}` })),
					url,
				);
			if (m?.[3] === "comments") return page(COMMENTS[n] ?? [], url);
			return new Response("not found", { status: 404 });
		},
	});
});
afterAll(() => forge.stop(true));
beforeEach(() => {
	status = 200;
	paths = [];
});

async function run(args: string[]) {
	const p = Bun.spawn([SCRIPT, "--repo", "o/r", "--since", "2026-10-01", ...args], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: "/nonexistent-pr-review-stats-home",
			FORGEJO_API_URL: `http://127.0.0.1:${forge.port}/api/v1`,
			FORGEJO_TOKEN: TOKEN,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	expect(stdout + stderr).not.toContain(TOKEN);
	return { stdout, stderr, code };
}

async function rows() {
	const r = await run(["--json"]);
	expect(r.code).toBe(0);
	const out = r.stdout
		.trim()
		.split("\n")
		.map((l) => JSON.parse(l) as Record<string, unknown>);
	return new Map(out.map((l) => [l.number as number, l]));
}

describe("pr-review-stats", () => {
	test("added counts additions only and skips docs and lockfiles", async () => {
		const byN = await rows();
		expect(byN.get(1)?.added).toBe(840);
		expect(byN.get(2)?.added).toBe(350);
		expect(byN.has(5)).toBe(false);
	});

	test("slices pack whole files at 400 added lines", async () => {
		const byN = await rows();
		expect(byN.get(1)?.slices).toBe(3);
		expect(byN.get(2)?.slices).toBe(1);
	});

	test("the first verdict is the company's; fix-firsts count sf- and factory", async () => {
		const one = (await rows()).get(1);
		expect(one?.first_verdict_h).toBe(2);
		expect(one?.fixfirst_rounds).toBe(2);
		expect(one?.head_pushes).toBe(4);
		expect(one?.open_to_merge_h).toBe(10);
		expect(one?.group).toBe("77");
	});

	test("a stack of three PRs is one change: summed lines, first open to last merge", async () => {
		const byN = await rows();
		expect([2, 3, 4].map((n) => byN.get(n)?.stack_id)).toEqual([2, 2, 2]);
		expect([2, 3, 4].map((n) => byN.get(n)?.group)).toEqual(["2", "s1", "s2"]);
		expect([1, 6, 7, 8].map((n) => byN.get(n)?.stack_id)).toEqual([1, 6, 7, 8]);
		expect([1, 2, 7].map((n) => byN.get(n)?.stack_whole)).toEqual([true, true, false]);
		const r = await run([]);
		expect(r.code).toBe(0);
		expect(r.stdout).toMatch(/single 801-1200\s+1\s+10\.0\s+2\.0\n/);
		expect(r.stdout).toMatch(/stack 801-1200\s+1\s+8\.0\s+0\.0\n/);
		expect(r.stdout).toContain("over 800 added lines: 2/7 (29%)");
		expect(paths.every((p) => p.startsWith("GET "))).toBe(true);
	});

	test("Forge 500: exit 3, the token in the error body is scrubbed", async () => {
		status = 500;
		const r = await run([]);
		expect(r.code).toBe(3);
		expect(r.stdout).toBe("");
		expect(r.stderr).toContain("HTTP 500");
		expect(r.stderr).toContain("boom token ***");
	});
});
