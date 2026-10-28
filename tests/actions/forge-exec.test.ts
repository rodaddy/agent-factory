/**
 * @module tests/actions/forge-exec
 * @description The credential job's write executor (D25), run by Node against a fake
 *   forge: a bad plan is refused whole before anything is sent, a write whose response was lost is
 *   probed (every page) before a retry so it never lands twice, a probe that cannot answer never
 *   re-posts, a caller-caused 4xx is final, a stalled body fails on the attempt deadline, and the
 *   token never reaches stdout or stderr.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT = join(import.meta.dir, "../../scripts/actions/forge-exec.mjs");
const NODE = ["/opt/homebrew/opt/node@24/bin/node", "/usr/local/opt/node@24/bin/node"].find(
	existsSync,
);
const TOKEN = "forge-exec-secret-token-91f3";
const REPO = "rodaddy/demo";
const SHA = "a".repeat(40);

type Store = { comments: { body: string }[]; seen: { method: string; auth: string | null }[] };
type Handler = (req: Request, url: URL, store: Store) => Promise<Response> | Response;
let server: ReturnType<typeof Bun.serve>;
let handler: Handler = () => new Response("unset", { status: 500 });
let store: Store = { comments: [], seen: [] };
let dir: string;
beforeAll(() => {
	dir = mkdtempSync(join(testTmpBase(), "forge-exec-"));
	server = Bun.serve({
		port: 0,
		fetch(req) {
			store.seen.push({ method: req.method, auth: req.headers.get("authorization") });
			return handler(req, new URL(req.url), store);
		},
	});
});
afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});
async function run(writes: unknown[], h: Handler) {
	handler = h;
	store = { comments: [], seen: [] };
	const planFile = join(dir, `plan-${crypto.randomUUID()}.json`);
	writeFileSync(planFile, JSON.stringify({ v: 1, writes }));
	const proc = Bun.spawn([NODE ?? "node", SCRIPT], {
		env: {
			PATH: process.env.PATH ?? "",
			API: `http://127.0.0.1:${server.port}/api/v1`,
			REPO,
			TOKEN,
			PLAN_FILE: planFile,
			FORGE_WRITE_BACKOFF_MS: "10",
			FORGE_WRITE_ATTEMPT_TIMEOUT_MS: "300",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	// (f) the token reaches only the Authorization header, never an output stream.
	expect(stdout).not.toContain(TOKEN);
	expect(stderr).not.toContain(TOKEN);
	return { code, stderr, lines: stdout.split("\n").flatMap((l) => (l ? [JSON.parse(l)] : [])) };
}
const commentPath = `/repos/${REPO}/issues/7/comments`;
const comment = {
	path: commentPath,
	body: { body: "hello <!-- mark-1 -->" },
	probe: { kind: "comment", issue: 7, marker: "<!-- mark-1 -->" },
};
const created = () => Response.json({}, { status: 201 });
const line = (status: number, attempt: number, reason = "") => ({
	path: commentPath,
	ok: status < 300,
	status,
	attempt,
	reason,
});

describe("forge-exec", () => {
	test("a comment and a status both 201 -> exit 0, two ok lines, token sent as the header", async () => {
		const ctx = { context: "factory/x", target_url: "https://x/1", state: "success" };
		const status = {
			path: `/repos/${REPO}/statuses/${SHA}`,
			body: ctx,
			probe: { kind: "status", sha: SHA, ...ctx },
		};
		const out = await run([comment, status], created);
		expect(out.code).toBe(0);
		expect(out.lines).toEqual([line(201, 1), { ...line(201, 1), path: status.path }]);
		expect(store.seen.map((s) => s.auth)).toEqual([`token ${TOKEN}`, `token ${TOKEN}`]);
	});

	test("a plan outside the allowlist is refused before anything is sent", async () => {
		const st = { kind: "status", sha: SHA, context: "c", target_url: "u", state: "success" };
		const at1 = `/repos/${REPO}/issues/1`;
		const bad = [
			{ ...comment, path: "/repos/other/repo/issues/1/comments" }, // r1 another repo
			{ ...comment, path: at1, probe: null }, // r2 off the allowlist
			{ ...comment, probe: st }, // r3 a probe that cannot guard its write
			{ ...comment, path: `${at1}/comments`, probe: { kind: "comment", issue: 2, marker: "m" } },
			{ ...comment, method: "DELETE" }, // r5 an unknown key
		];
		for (const write of bad) {
			const out = await run([comment, write], created);
			expect([out.code, out.lines, store.seen]).toEqual([2, [], []]);
			expect(out.stderr).toStartWith("forge-exec: refused, nothing sent:");
		}
	});

	test("a POST stored but answered too late is probed, not re-posted", async () => {
		const probed = Promise.withResolvers<void>();
		const out = await run([comment], async (req, url, s) => {
			if (req.method === "GET") {
				expect(url.searchParams.get("since")).not.toBeNull();
				probed.resolve();
				return Response.json(s.comments);
			}
			s.comments.push((await req.json()) as { body: string });
			return probed.promise.then(created); // held until the probe arrives, never a duration
		});
		expect(out.code).toBe(0);
		expect(out.lines).toEqual([{ ...line(0, 1, "already applied"), ok: true }]);
		expect(store.comments).toHaveLength(1);
	});

	test("a probe that cannot answer never re-posts: exit 1, probe inconclusive, one POST", async () => {
		const out = await run([comment], () => Response.json({}, { status: 500 }));
		expect(out.code).toBe(1);
		expect(out.lines).toEqual([line(500, 20, "probe inconclusive")]);
		expect(store.seen.filter((s) => s.method === "POST")).toHaveLength(1);
	});

	test("the probe pages: a marker on page 2 is found, not re-posted", async () => {
		const probed = Promise.withResolvers<void>();
		const earlier = Array.from({ length: 60 }, (_, i) => ({ body: `earlier ${i}` }));
		const out = await run([comment], async (req, url, s) => {
			if (req.method === "GET") {
				probed.resolve();
				const page = Number(url.searchParams.get("page"));
				const limit = Number(url.searchParams.get("limit"));
				return Response.json([...earlier, ...s.comments].slice((page - 1) * limit, page * limit));
			}
			s.comments.push((await req.json()) as { body: string });
			return probed.promise.then(created);
		});
		expect(out.code).toBe(0);
		expect(out.lines).toEqual([{ ...line(0, 1, "already applied"), ok: true }]);
		expect(store.comments).toHaveLength(1);
	});

	test("a 422 is final: exit 1 and no retry", async () => {
		const out = await run([comment, comment], () => Response.json({}, { status: 422 }));
		expect(out.code).toBe(1);
		expect(out.lines).toEqual([line(422, 1, "http 422")]);
		expect(store.seen).toHaveLength(1);
	});

	test("a 500 then 201, with a probe that finds nothing, is ok on attempt 2", async () => {
		let posts = 0;
		const out = await run([comment], (req) => {
			if (req.method === "GET") return Response.json([]);
			posts += 1;
			return Response.json({}, { status: posts === 1 ? 500 : 201 });
		});
		expect(out.code).toBe(0);
		expect(out.lines).toEqual([line(201, 2)]);
		expect(store.seen.map((s) => s.method)).toEqual(["POST", "GET", "POST"]);
	});

	test("a 201 whose body never finishes fails on the attempt deadline", async () => {
		const started = Date.now();
		const out = await run([{ ...comment, probe: null }], () => {
			const body = new ReadableStream({ start: (c) => c.enqueue(new TextEncoder().encode("{")) });
			return new Response(body, { status: 201, headers: { "content-type": "application/json" } });
		});
		expect(out.code).toBe(1);
		expect(out.lines).toHaveLength(1);
		expect(out.lines[0].ok).toBe(false);
		expect(out.lines[0].reason).toStartWith("Error: attempt timed out after 300 ms");
		expect(Date.now() - started).toBeLessThan(5_000);
	});
});
