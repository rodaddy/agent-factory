/**
 * @module tests/fleet/forge-pr-factoryignore-cli
 * @description `fleet/plugins/forge-pr/factoryignore-cli.js`,
 *   the read merge-check re-derives a non-code head with, run as a child process
 *   against a fake Forge. It prints one JSON line and exits 0 on a decision
 *   either way, 3 on any read error or a head that moved.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";

const CLI = resolve(import.meta.dir, "../../fleet/plugins/forge-pr/factoryignore-cli.js");
const TOKEN = ["fake", "forge", "value", "1730"].join("-");
const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
// PR number -> its changed files; 9 has a head that moved, 10 a failing files
// read, 12 a head and 13 a base that move while the files are read.
const FILES: Record<string, string[]> = {
	"1": ["_DOCS/notes.md", "README.md"],
	"2": ["_DOCS/AGENTS.md"],
	"3": ["src/index.ts"],
	"11": Array.from({ length: 1001 }, (_, i) => `_DOCS/note-${i}.md`),
	"12": ["_DOCS/notes.md"],
	"13": ["_DOCS/notes.md"],
	"9": ["_DOCS/notes.md"],
};
let server: ReturnType<typeof Bun.serve>;
let api = "";
const seen: string[] = [];
let moved = false;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const u = new URL(req.url);
			seen.push(`${u.pathname}?ref=${u.searchParams.get("ref") ?? ""}`);
			if (req.headers.get("authorization") !== `token ${TOKEN}`)
				return new Response("auth", { status: 401 });
			const pr = u.pathname.match(/^\/repos\/o\/r\/pulls\/(\d+)(\/files)?$/);
			if (pr?.[2]) {
				if (pr[1] === "10") return new Response("boom", { status: 500 });
				if (pr[1] === "12" || pr[1] === "13") moved = true;
				const page = Number(u.searchParams.get("page") ?? "1");
				const limit = Number(u.searchParams.get("limit") ?? "50");
				return Response.json(
					(FILES[pr[1] ?? ""] ?? [])
						.slice((page - 1) * limit, page * limit)
						.map((filename) => ({ filename, status: "changed" })),
				);
			}
			if (pr)
				return Response.json({
					number: Number(pr[1]),
					state: "open",
					head: { sha: pr[1] === "9" || (pr[1] === "12" && moved) ? "c".repeat(40) : HEAD },
					changed_files: FILES[pr[1] ?? ""]?.length ?? 0,
					base: { ref: "main", sha: pr[1] === "13" && moved ? "d".repeat(40) : BASE },
				});
			if (u.pathname.startsWith("/repos/o/r/git/trees/"))
				return Response.json({
					tree: Object.values(FILES)
						.flat()
						.map((path) => ({ path, mode: "100644" })),
					truncated: false,
				});
			if (u.pathname === "/repos/o/r/contents/.factoryignore")
				return new Response("nf", { status: 404 });
			if (u.pathname.startsWith("/repos/o/r/contents/"))
				return Response.json({ content: Buffer.from("# A heading\n").toString("base64") });
			return new Response("nf", { status: 404 });
		},
	});
	api = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

async function cli(n: number, env: Record<string, string> = {}, sha = HEAD) {
	const p = Bun.spawn([process.execPath, CLI, "o/r", String(n), sha], {
		env: { PATH: process.env.PATH ?? "", FORGEJO_API_URL: api, FORGEJO_TOKEN: TOKEN, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, stdout, stderr };
}

describe("factoryignore-cli", () => {
	test("an all-docs head is nonCode true, read at the PR's base sha", async () => {
		seen.length = 0;
		const r = await cli(1);
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({ nonCode: true, refused: [], base: BASE });
		expect(r.stdout.trim().split("\n")).toHaveLength(1);
		// .factoryignore comes from the base, never the head.
		expect(seen).toContain(`/repos/o/r/contents/.factoryignore?ref=${BASE}`);
		expect(seen).toContain(`/repos/o/r/contents/_DOCS/notes.md?ref=${HEAD}`);
	});
	test("a refused path is nonCode false and names the path, exit 0", async () => {
		const r = await cli(2);
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout)).toEqual({
			nonCode: false,
			refused: [{ path: "_DOCS/AGENTS.md", reason: "refused name" }],
			base: BASE,
		});
	});
	test("a code path is nonCode false, exit 0", async () => {
		const r = await cli(3);
		expect(r.code).toBe(0);
		expect(JSON.parse(r.stdout).nonCode).toBe(false);
	});
	test("a head that moved is exit 3 with no decision", async () => {
		const r = await cli(9);
		expect(r.code).toBe(3);
		expect(r.stdout).toBe("");
	});
	test("a truncated file list is exit 3 with no decision", async () => {
		const r = await cli(11);
		expect(r.code).toBe(3);
		expect(r.stdout).toBe("");
	});
	test("a head that moves between PR reads is exit 3 with no decision", async () => {
		moved = false;
		const r = await cli(12);
		expect(r.code).toBe(3);
		expect(r.stdout).toBe("");
	});
	test("a base that moves between PR reads is exit 3 with no decision", async () => {
		moved = false;
		const r = await cli(13);
		expect(r.code).toBe(3);
		expect(r.stdout).toBe("");
	});
	test("a failed read is exit 3, and the token is never printed", async () => {
		const r = await cli(10);
		expect(r.code).toBe(3);
		expect(r.stdout).toBe("");
		const bad = await cli(1, { FORGEJO_TOKEN: "wrong-value" });
		expect(bad.code).toBe(3);
		for (const out of [r.stdout, r.stderr, bad.stderr]) expect(out).not.toContain(TOKEN);
		for (const out of [bad.stdout, bad.stderr]) expect(out).not.toContain("wrong-value");
	});
	test("bad arguments or missing env are exit 2", async () => {
		expect((await cli(1, {}, "short")).code).toBe(2);
		expect((await cli(1, { FORGEJO_TOKEN: "" })).code).toBe(2);
	});
});
