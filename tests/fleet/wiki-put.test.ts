/**
 * @module tests/fleet/wiki-put
 * @description `fleet/skills/repo-wiki/bin/wiki-put` run as a
 *   real child process against a fake Forge: POST for a missing page, PATCH for
 *   an existing one, base64 content, and the token never echoed. The fake
 *   mirrors Forgejo: a page is addressed by its `sub_url`, which can differ from
 *   its title (rtech/crm "How-to" lives at "How-to.-", SOF-10175), and the
 *   listing at /wiki/pages is paginated.
 *   `WIKI_PUT_UNDER_TEST` points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT =
	process.env.WIKI_PUT_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/skills/repo-wiki/bin/wiki-put");
const TOKEN = "sekrit-token-4242";
const BODY = "# Home\n\nWhat it is.\n";

interface Seen {
	method: string;
	path: string;
	authorization: string | null;
	body: Record<string, string> | null;
}

const seen: Seen[] = [];
/** Existing wiki pages, title -> sub_url, in listing order. */
const existing = new Map<string, string>();
let listingStatus = 200;
/** What GET /repos/o/r answers: a readable repo with or without its wiki, or 404. */
let repoState: "wiki" | "no-wiki" | "missing" = "wiki";
let server: ReturnType<typeof Bun.serve>;
let dir = "";
let file = "";

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		async fetch(req) {
			const url = new URL(req.url);
			const path = decodeURIComponent(url.pathname);
			const text = req.method === "GET" ? "" : await req.text();
			seen.push({
				method: req.method,
				path,
				authorization: req.headers.get("authorization"),
				body: text ? JSON.parse(text) : null,
			});
			if (req.method === "GET" && path === "/api/v1/repos/o/r") {
				if (repoState === "missing") return new Response("not found", { status: 404 });
				return Response.json({ full_name: "o/r", has_wiki: repoState === "wiki" });
			}
			if (req.method === "GET" && path === "/api/v1/repos/o/r/wiki/pages") {
				if (listingStatus !== 200) return new Response("no", { status: listingStatus });
				const page = Number(url.searchParams.get("page") ?? "1");
				const limit = Math.min(Number(url.searchParams.get("limit") ?? "50"), 50);
				const all = [...existing].map(([title, sub_url]) => ({ title, sub_url }));
				return Response.json(all.slice((page - 1) * limit, page * limit));
			}
			const m = /^\/api\/v1\/repos\/o\/r\/wiki\/page\/(.+)$/.exec(path);
			const known = m ? [...existing.values()].includes(m[1] ?? "") : false;
			if ((req.method === "GET" || req.method === "PATCH") && m) {
				return known
					? Response.json({ sub_url: m[1] })
					: new Response("not found", { status: 404 });
			}
			if (req.method === "POST" && path === "/api/v1/repos/o/r/wiki/new") {
				return Response.json({ title: "x" }, { status: 201 });
			}
			return new Response("bad route", { status: 400 });
		},
	});
	dir = mkdtempSync(join(tmpdir(), "wiki-put-"));
	file = join(dir, "page.md");
	writeFileSync(file, BODY);
});

afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
	seen.length = 0;
	existing.clear();
	listingStatus = 200;
	repoState = "wiki";
});

/** Run the script without blocking the event loop the fake Forge needs. */
async function run(title: string, path = file, api = `http://127.0.0.1:${server.port}/api/v1`) {
	const child = Bun.spawn([SCRIPT, "o/r", title, path], {
		env: { PATH: process.env.PATH ?? "", FORGEJO_API_URL: api, FORGEJO_TOKEN: TOKEN },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("wiki-put", () => {
	test("creates a missing page with POST and a base64 body", async () => {
		const r = await run("How-to");
		expect(r.exitCode).toBe(0);
		const post = seen.find((s) => s.method === "POST");
		expect(post?.path).toBe("/api/v1/repos/o/r/wiki/new");
		expect(post?.authorization).toBe(`token ${TOKEN}`);
		expect(post?.body?.title).toBe("How-to");
		expect(Buffer.from(post?.body?.content_base64 ?? "", "base64").toString()).toBe(BODY);
		expect(post?.body?.message).toBeTruthy();
		expect(seen.some((s) => s.method === "PATCH")).toBe(false);
	});

	test("updates an existing page with PATCH", async () => {
		existing.set("Home", "Home");
		const r = await run("Home");
		expect(r.exitCode).toBe(0);
		const patch = seen.find((s) => s.method === "PATCH");
		expect(patch?.path).toBe("/api/v1/repos/o/r/wiki/page/Home");
		expect(Buffer.from(patch?.body?.content_base64 ?? "", "base64").toString()).toBe(BODY);
		expect(seen.some((s) => s.method === "POST")).toBe(false);
	});

	test("the token never appears in output", async () => {
		existing.set("Home", "Home");
		const ok = await run("Home");
		const bad = await run("Home", join(dir, "missing.md"));
		const down = await run("Home", file, "http://127.0.0.1:1/api/v1");
		expect(ok.exitCode).toBe(0);
		expect(bad.exitCode).toBe(3);
		expect(down.exitCode).toBe(3);
		for (const r of [ok, bad, down]) {
			expect(r.stdout + r.stderr).not.toContain(TOKEN);
		}
	});

	test("updates a page whose sub_url differs from its title (SOF-10175)", async () => {
		// Live rtech/crm: title "How-to" at sub_url "How-to.-"; GET /page/How-to is 404.
		existing.set("Home", "Home");
		existing.set("How-to", "How-to.-");
		const r = await run("How-to");
		expect(r.exitCode).toBe(0);
		expect(r.stdout).toContain("PATCH");
		const patch = seen.find((s) => s.method === "PATCH");
		expect(patch?.path).toBe("/api/v1/repos/o/r/wiki/page/How-to.-");
		expect(patch?.body?.title).toBe("How-to");
		expect(Buffer.from(patch?.body?.content_base64 ?? "", "base64").toString()).toBe(BODY);
		expect(seen.some((s) => s.method === "POST")).toBe(false);
	});

	test("a title equal to another page's sub_url is not that page", async () => {
		// GET /page/How-to.- would answer 200 for "How-to"; the title decides, not the URL.
		existing.set("How-to", "How-to.-");
		const r = await run("How-to.-");
		expect(r.exitCode).toBe(0);
		expect(seen.some((s) => s.method === "PATCH")).toBe(false);
		const post = seen.find((s) => s.method === "POST");
		expect(post?.body?.title).toBe("How-to.-");
	});

	test("finds an existing page past the first listing page", async () => {
		for (let i = 0; i < 75; i++) existing.set(`Filler ${i}`, `Filler-${i}`);
		existing.set("How-to", "How-to.-");
		const r = await run("How-to");
		expect(r.exitCode).toBe(0);
		expect(seen.find((s) => s.method === "PATCH")?.path).toBe(
			"/api/v1/repos/o/r/wiki/page/How-to.-",
		);
		expect(seen.some((s) => s.method === "POST")).toBe(false);
	});

	test("a refused listing is a refusal, never a blind create", async () => {
		listingStatus = 403;
		const r = await run("How-to");
		expect(r.exitCode).toBe(1);
		expect(seen.some((s) => s.method === "POST" || s.method === "PATCH")).toBe(false);
	});

	test("a never-written wiki (listing 404, repo has_wiki) is created with POST (SOF-10638)", async () => {
		// Live rodaddy/quick-prompt: has_wiki=true, no .wiki.git yet, so Forgejo answers
		// /wiki/pages with 404 "no such file or directory". POST /wiki/new initializes it.
		listingStatus = 404;
		const r = await run("Home");
		expect(r.exitCode).toBe(0);
		const post = seen.find((s) => s.method === "POST");
		expect(post?.path).toBe("/api/v1/repos/o/r/wiki/new");
		expect(post?.body?.title).toBe("Home");
		expect(seen.some((s) => s.method === "PATCH")).toBe(false);
	});

	test("a listing 404 on a repo with its wiki off is a refusal, never a blind create", async () => {
		listingStatus = 404;
		repoState = "no-wiki";
		const r = await run("Home");
		expect(r.exitCode).toBe(1);
		expect(r.stderr).toContain("wiki disabled");
		expect(seen.some((s) => s.method === "POST" || s.method === "PATCH")).toBe(false);
	});

	test("a listing 404 on a repo we cannot read is a refusal, never a blind create", async () => {
		listingStatus = 404;
		repoState = "missing";
		const r = await run("Home");
		expect(r.exitCode).toBe(1);
		expect(seen.some((s) => s.method === "POST" || s.method === "PATCH")).toBe(false);
	});
});
