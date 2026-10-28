/**
 * @module tests/fleet/board-link
 * @description `fleet/bin/board-link`, which puts the Forge item a board task
 *   is about on the task as a work product and labels, run as a real child
 *   process against a fake board. `BOARD_LINK_UNDER_TEST` points the suite at
 *   a mutated copy of the script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT =
	process.env.BOARD_LINK_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/board-link");
const PR = "https://forge.example.internal/rtech/Some-Repo/pulls/46";

interface Seen {
	method: string;
	path: string;
	authorization: string | null;
	run: string | null;
	body: unknown;
}

interface Label {
	id: string;
	name: string;
	color?: string;
}

const seen: Seen[] = [];
let products: Record<string, unknown>[] = [];
let labels: Label[] = [];
let issueLabelIds: string[] = [];
/** A label another employee creates between this run's read and its write. */
let racedLabel = "";
/** Another employee replaces the task's whole label set right after our write. */
let clobberOnce = false;
let server: ReturnType<typeof Bun.serve>;
let api = "";
// Locks live in a temp directory: a test must not write into the checkout or $HOME.
const lockDir = mkdtempSync(join(tmpdir(), "board-link-locks-"));

/** Whether `port` can be bound on loopback right now. */
function isFree(port: number): Promise<boolean> {
	return new Promise((done) => {
		const probe = createServer();
		probe.once("error", () => done(false));
		probe.listen(port, "127.0.0.1", () => probe.close(() => done(true)));
	});
}

/** First free port in 7150-7179; the forge-post suite owns 7120-7149. */
async function freePort(): Promise<number> {
	for (let port = 7150; port <= 7179; port++) {
		if (await isFree(port)) return port;
	}
	throw new Error("no free port in 7150-7179");
}

function env(overrides: Record<string, string | undefined> = {}): Record<string, string> {
	const base: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		PAPERCLIP_API_URL: api,
		PAPERCLIP_API_KEY: "k-1",
		PAPERCLIP_COMPANY_ID: "co-1",
		BOARD_LINK_SETTLE: "0",
		BOARD_LINK_LOCK_DIR: lockDir,
		...overrides,
	};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

async function run(args: string[], options: { env?: Record<string, string> } = {}) {
	const child = Bun.spawn([Bun.which("bash") ?? "/bin/bash", SCRIPT, ...args], {
		env: options.env ?? env(),
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

function writes(): Seen[] {
	return seen.filter((request) => request.method !== "GET");
}

beforeAll(async () => {
	server = Bun.serve({
		port: await freePort(),
		hostname: "127.0.0.1",
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const text = await request.text();
			const body = text === "" ? null : JSON.parse(text);
			seen.push({
				method: request.method,
				path,
				authorization: request.headers.get("authorization"),
				run: request.headers.get("x-paperclip-run-id"),
				body,
			});
			if (path.includes("boom")) return Response.json({ error: "boom" }, { status: 500 });
			if (path.endsWith("/work-products")) {
				if (request.method === "GET") return Response.json(products);
				const made = { id: `wp-${products.length + 1}`, ...body };
				products.push(made);
				return Response.json(made, { status: 201 });
			}
			if (path === "/api/companies/co-1/labels") {
				if (request.method === "GET") return Response.json(labels);
				// The real board refuses a duplicate name with a 500 (probed 2026-10-01).
				if (body.name === racedLabel) {
					labels.push({ id: "l-raced", name: racedLabel });
					racedLabel = "";
					return Response.json({ error: "Internal server error" }, { status: 500 });
				}
				if (labels.some((label) => label.name === body.name)) {
					return Response.json({ error: "Internal server error" }, { status: 500 });
				}
				const made = { id: `l-${labels.length + 1}`, ...body };
				labels.push(made);
				return Response.json(made, { status: 201 });
			}
			if (request.method === "PATCH") {
				issueLabelIds = body.labelIds;
				if (clobberOnce) {
					clobberOnce = false;
					issueLabelIds = ["l-other"];
				}
				return Response.json({ labelIds: issueLabelIds });
			}
			return Response.json({ id: "i-1", labelIds: issueLabelIds });
		},
	});
	api = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server.stop(true);
	rmSync(lockDir, { recursive: true, force: true });
});

beforeEach(() => {
	seen.length = 0;
	products = [];
	labels = [];
	issueLabelIds = [];
	racedLabel = "";
	clobberOnce = false;
});

describe("board-link", () => {
	test("a pull request becomes a primary work product and three labels", async () => {
		labels = [{ id: "l-old", name: "kind:pr" }];
		issueLabelIds = ["l-keep"];
		const result = await run(["i-1", PR, "kind:review"], {
			env: env({ PAPERCLIP_RUN_ID: "run-9" }),
		});
		expect(result.stderr).toBe("");
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe(
			"work_product=wp-1 state=created labels=repo:rtech/some-repo,kind:pr,kind:review",
		);
		expect(products).toEqual([
			{
				id: "wp-1",
				type: "pull_request",
				provider: "forgejo",
				title: "rtech/Some-Repo#46",
				url: PR,
				externalId: "rtech/Some-Repo#46",
				status: "active",
				isPrimary: true,
			},
		]);
		expect(labels.map((label) => label.name)).toEqual([
			"kind:pr",
			"repo:rtech/some-repo",
			"kind:review",
		]);
		// The label that existed is reused, and the label already on the task stays.
		expect([...issueLabelIds].sort()).toEqual(["l-2", "l-3", "l-keep", "l-old"]);
		for (const request of seen) {
			expect(request.authorization).toBe("Bearer k-1");
			expect(request.run).toBe("run-9");
		}
	});

	test("a second run changes nothing: no work product, no label, no update", async () => {
		expect((await run(["i-1", PR])).code).toBe(0);
		seen.length = 0;
		const result = await run(["i-1", PR]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe(
			"work_product=wp-1 state=unchanged labels=repo:rtech/some-repo,kind:pr",
		);
		expect(writes()).toEqual([]);
		expect(products).toHaveLength(1);
	});

	test("an issue is a document work product labelled kind:issue, not primary beside a primary", async () => {
		products = [{ id: "wp-0", provider: "forgejo", externalId: "o/r#1", isPrimary: true }];
		const result = await run(["i-1", "https://forge.example.internal/o/r/issues/7"]);
		expect(result.code).toBe(0);
		expect(products[1]).toMatchObject({ type: "document", externalId: "o/r#7", isPrimary: false });
		expect(labels.map((label) => label.name)).toEqual(["repo:o/r", "kind:issue"]);
	});

	test("a label named twice, or one it adds by itself, is created once", async () => {
		const result = await run(["i-1", PR, "kind:pr", "kind:review", "kind:review"]);
		expect(result.code).toBe(0);
		expect(labels.map((label) => label.name)).toEqual([
			"repo:rtech/some-repo",
			"kind:pr",
			"kind:review",
		]);
		expect(result.stdout.trim()).toEndWith("labels=repo:rtech/some-repo,kind:pr,kind:review");
	});

	test("a label another employee creates meanwhile is used, not an error", async () => {
		racedLabel = "kind:pr";
		const result = await run(["i-1", PR]);
		expect(result.code).toBe(0);
		expect(result.stderr).toContain("created by someone else meanwhile");
		expect(labels.filter((label) => label.name === "kind:pr")).toHaveLength(1);
		expect(issueLabelIds).toContain("l-raced");
	});

	test("labels replaced by another writer right after ours are written again, theirs kept", async () => {
		clobberOnce = true;
		const result = await run(["i-1", PR]);
		expect(result.code).toBe(0);
		expect([...issueLabelIds].sort()).toEqual(["l-1", "l-2", "l-other"]);
		expect(writes().filter((request) => request.method === "PATCH")).toHaveLength(2);
	});

	test("a writer holding the task's lock makes the next one wait before it reads", async () => {
		const held = join(lockDir, "board-link-i-1");
		mkdirSync(held);
		const pending = run(["i-1", PR]);
		await Bun.sleep(700);
		const beforeRelease = seen.filter((request) => request.path === "/api/issues/i-1").length;
		rmdirSync(held);
		const result = await pending;
		expect(beforeRelease).toBe(0);
		expect(result.code).toBe(0);
		expect(issueLabelIds).toHaveLength(2);
	});

	test("without PAPERCLIP_RUN_ID no run header is sent", async () => {
		expect((await run(["i-1", PR])).code).toBe(0);
		expect(seen.every((request) => request.run === null)).toBe(true);
	});

	test("missing PAPERCLIP_COMPANY_ID is exit 3 and nothing is sent", async () => {
		const result = await run(["i-1", PR], { env: env({ PAPERCLIP_COMPANY_ID: undefined }) });
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("PAPERCLIP_COMPANY_ID");
		expect(seen).toHaveLength(0);
	});

	test("a URL on another host, or not a pull request or issue, is exit 2 and nothing is sent", async () => {
		for (const url of [
			"https://example.com/o/r/pulls/1",
			"https://forge.example.internal/o/r/src/branch/main",
			"https://forge.example.internal/o/r/pulls/1/files",
		]) {
			const result = await run(["i-1", url]);
			expect(result.code).toBe(2);
			expect(result.stderr).toContain("usage: board-link");
		}
		expect(seen).toHaveLength(0);
	});

	test("a bad label is exit 2 and nothing is sent", async () => {
		const result = await run(["i-1", PR, "Has Space"]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("bad label");
		expect(seen).toHaveLength(0);
	});

	test("HTTP 500 from the board is exit 1 with the status on stderr", async () => {
		const result = await run(["boom", PR]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("HTTP 500");
		expect(result.stdout).toBe("");
		expect(writes()).toEqual([]);
	});

	test("the key never appears in argv", () => {
		const text = readFileSync(SCRIPT, "utf8");
		expect(text).not.toContain('-H "Authorization');
		expect(text).toContain('printf \'header = "Authorization: Bearer %s"');
	});
});
