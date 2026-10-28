/**
 * @module tests/actions/forge-plan
 * @description The plan builders and the executor agree (D25): a plan built by
 *   forge-plan.ts is accepted and performed by forge-exec.mjs against a fake forge, byte for byte;
 *   the comment builder's marker probe recognises the comment the forge lists after a lost
 *   response, so it is not posted twice; and an empty plan is refused at render time.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	commentWrite,
	labelsWrite,
	type PlannedWrite,
	renderPlan,
	statusWrite,
} from "../../scripts/actions/forge-plan";
import { testTmpBase } from "../support/test-temp";

/** The one performer of a plan; every run below goes through it. */
const EXECUTOR = join(import.meta.dir, "../../scripts/actions/forge-exec.mjs");
const NODE = ["/opt/homebrew/opt/node@24/bin/node", "/usr/local/opt/node@24/bin/node"].find(
	existsSync,
);
const REPO = "rodaddy/demo";
const SHA = "b".repeat(40);

type Post = { path: string; body: unknown };
let server: ReturnType<typeof Bun.serve>;
let posts: Post[] = [];
let comments: { body: string }[] = [];
let failFirstComment = false;
/** The next comment POST fails BEFORE the forge stores it: the write never landed. */
let dropFirstComment = false;
let dir: string;

beforeAll(() => {
	dir = mkdtempSync(join(testTmpBase(), "forge-plan-"));
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname.replace(/^\/api\/v1/, "");
			if (req.method === "GET") {
				return Response.json(path.endsWith("/comments") ? comments : []);
			}
			const body = await req.json();
			posts.push({ path, body });
			if (path.endsWith("/comments")) {
				if (dropFirstComment) {
					dropFirstComment = false;
					return new Response("bad gateway", { status: 502 });
				}
				comments.push(body as { body: string });
				if (failFirstComment && comments.length === 1)
					return new Response("bad gateway", { status: 502 });
			}
			return Response.json({}, { status: 201 });
		},
	});
});
afterAll(() => {
	server.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

async function perform(
	writes: PlannedWrite[],
	failFirst: boolean,
	opts: { seed?: { body: string }[]; dropFirst?: boolean } = {},
) {
	posts = [];
	comments = [...(opts.seed ?? [])];
	failFirstComment = failFirst;
	dropFirstComment = opts.dropFirst ?? false;
	const planFile = join(dir, `plan-${crypto.randomUUID()}.json`);
	writeFileSync(planFile, renderPlan(writes));
	const proc = Bun.spawn([NODE ?? "node", EXECUTOR], {
		env: {
			PATH: process.env.PATH ?? "",
			API: `http://127.0.0.1:${server.port}/api/v1`,
			REPO,
			TOKEN: "forge-plan-test-token",
			PLAN_FILE: planFile,
			FORGE_WRITE_BACKOFF_MS: "1",
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	return { code, lines: stdout.split("\n").flatMap((l) => (l ? [JSON.parse(l)] : [])) };
}

test("the executor performs exactly the writes the builders produce, in order", async () => {
	const writes = [
		commentWrite(REPO, 7, "review verdict <!-- pr-review -->"),
		statusWrite(REPO, SHA, {
			state: "success",
			context: "factory/pr-review",
			description: "approved",
			target_url: "https://forge.example.internal/rodaddy/demo/actions/runs/1",
		}),
		labelsWrite(REPO, 7, ["triaged", "p2"]),
	];
	const { code, lines } = await perform(writes, false);
	expect(code).toBe(0);
	expect(lines.map((l) => l.ok)).toEqual([true, true, true]);
	expect(posts).toEqual(writes.map((w) => ({ path: w.path, body: w.body })));
});

test("a lost comment response is found by the builder's marker probe and not posted twice", async () => {
	const { code, lines } = await perform([commentWrite(REPO, 7, "lost on the wire")], true);
	expect(code).toBe(0);
	expect(lines).toHaveLength(1);
	expect(lines[0].reason).toBe("already applied");
	expect(comments).toHaveLength(1);
});

test("a comment that only CONTAINS the planned body does not suppress the retry", async () => {
	const planned = "review verdict <!-- pr-review -->";
	const seed = [{ body: `quoted: ${planned} -- and more` }];
	const { code, lines } = await perform([commentWrite(REPO, 7, planned)], false, {
		seed,
		dropFirst: true,
	});
	expect(code).toBe(0);
	expect(lines).toHaveLength(1);
	expect(lines[0]).toMatchObject({ ok: true, attempt: 2, reason: "" });
	expect(comments).toEqual([...seed, { body: planned }]);
});

test("renderPlan refuses an empty plan", () => {
	expect(() => renderPlan([])).toThrow();
});
