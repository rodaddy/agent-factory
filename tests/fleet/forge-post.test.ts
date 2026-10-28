/**
 * @module tests/fleet/forge-post
 * @description `fleet/bin/forge-post`, the one way a fleet employee
 *   writes to Forge, run as a real child process against a fake Forge: the
 *   identity line the script builds, every endpoint, and every refusal.
 *   `FORGE_POST_UNDER_TEST` points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT =
	process.env.FORGE_POST_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/forge-post");
const IDENTITY = "**agent:** triage · harness pi · model m-1 · Software Factory company";
const BODY = "He said \"hi\" and 'bye' with `code` and $HOME\nsecond line\n";

interface Seen {
	method: string;
	path: string;
	authorization: string | null;
	body: Record<string, string>;
}

const seen: Seen[] = [];
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

/** First free port in 7120-7149; 7141 is reserved and never bound. */
async function freePort(): Promise<number> {
	for (let port = 7120; port <= 7149; port++) {
		if (port !== 7141 && (await isFree(port))) return port;
	}
	throw new Error("no free port in 7120-7149");
}

function env(overrides: Record<string, string | undefined> = {}): Record<string, string> {
	const base: Record<string, string | undefined> = {
		PATH: process.env.PATH,
		FORGEJO_API_URL: api,
		FORGEJO_TOKEN: "t-1",
		FLEET_EMPLOYEE: "triage",
		FLEET_HARNESS: "pi",
		FLEET_MODEL: "m-1",
		...overrides,
	};
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value !== undefined) out[key] = value;
	}
	return out;
}

async function run(args: string[], options: { env?: Record<string, string>; stdin?: string } = {}) {
	// The bash on PATH: Homebrew's on the Mac, the system one on the fleet box
	// and in CI. Apple's /bin/bash 3.2 is not a supported runtime here.
	const child = Bun.spawn([Bun.which("bash") ?? "/bin/bash", SCRIPT, ...args], {
		env: options.env ?? env(),
		stdin: options.stdin === undefined ? "ignore" : new Blob([options.stdin]),
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

// Fixtures live in a temp directory: the receipt sandbox mounts the checkout
// read-only, and a test must not write into the tree it is testing.
const fixtureDir = mkdtempSync(join(tmpdir(), "forge-post-test-"));

async function bodyFile(text: string, name: string): Promise<string> {
	const path = join(fixtureDir, `${name}.txt`);
	await Bun.write(path, text);
	return path;
}

beforeAll(async () => {
	server = Bun.serve({
		port: await freePort(),
		hostname: "127.0.0.1",
		async fetch(request) {
			const path = new URL(request.url).pathname;
			seen.push({
				method: request.method,
				path,
				authorization: request.headers.get("authorization"),
				body: JSON.parse(await request.text()),
			});
			if (path.includes("fail")) return Response.json({ message: "boom" }, { status: 500 });
			return Response.json({ html_url: "http://fake/x" }, { status: 201 });
		},
	});
	api = `http://127.0.0.1:${server.port}`;
});

afterAll(async () => {
	server.stop(true);
	rmSync(fixtureDir, { recursive: true, force: true });
});

beforeEach(() => {
	seen.length = 0;
});

describe("forge-post", () => {
	test("comment posts the identity line, a blank line, then the body unchanged", async () => {
		const result = await run(["comment", "o/r", "7", await bodyFile(BODY, "c1")]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("http://fake/x");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.path).toBe("/repos/o/r/issues/7/comments");
		expect(seen[0]?.authorization).toBe("token t-1");
		expect(seen[0]?.body).toEqual({ body: `${IDENTITY}\n\n${BODY}` });
	});

	test("comment with PAPERCLIP_RUN_ID appends the run to the identity line", async () => {
		const result = await run(["comment", "o/r", "7", await bodyFile(BODY, "c2")], {
			env: env({ PAPERCLIP_RUN_ID: "run-9" }),
		});
		expect(result.code).toBe(0);
		const line = seen[0]?.body.body?.split("\n")[0];
		expect(line).toBe(`${IDENTITY} · run run-9`);
	});

	test("comment with FLEET_EFFORT names the effort on the identity line", async () => {
		const result = await run(["comment", "o/r", "7", await bodyFile(BODY, "c2e")], {
			env: env({ FLEET_EFFORT: "low" }),
		});
		expect(result.code).toBe(0);
		expect(seen[0]?.body.body?.split("\n")[0]).toBe(`${IDENTITY} · effort low`);
	});

	test("pr posts head, base, title, and a body ending with the identity line after ---", async () => {
		const result = await run([
			"pr",
			"o/r",
			"rw/issue-7",
			"main",
			'fix: the "thing"',
			await bodyFile(BODY, "c3"),
		]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("http://fake/x");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.path).toBe("/repos/o/r/pulls");
		expect(seen[0]?.body).toEqual({
			head: "rw/issue-7",
			base: "main",
			title: 'fix: the "thing"',
			body: `${BODY}\n\n---\n\n${IDENTITY}`,
		});
	});

	test("issue posts the title and a body ending with the identity line after ---", async () => {
		const result = await run(["issue", "o/r", "Steward: setup gaps", "-"], {
			stdin: BODY,
			env: env({ PAPERCLIP_RUN_ID: "run-9" }),
		});
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("http://fake/x");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.method).toBe("POST");
		expect(seen[0]?.path).toBe("/repos/o/r/issues");
		expect(seen[0]?.body).toEqual({
			title: "Steward: setup gaps",
			body: `${BODY}\n\n---\n\n${IDENTITY} · run run-9`,
		});
	});

	test("issue-edit replaces the body of that issue, stamped the same way", async () => {
		const result = await run(["issue-edit", "o/r", "12", await bodyFile(BODY, "c4")]);
		expect(result.code).toBe(0);
		expect(result.stdout.trim()).toBe("http://fake/x");
		expect(seen).toHaveLength(1);
		expect(seen[0]?.method).toBe("PATCH");
		expect(seen[0]?.path).toBe("/repos/o/r/issues/12");
		expect(seen[0]?.body).toEqual({ body: `${BODY}\n\n---\n\n${IDENTITY}` });
	});

	test("issue-edit with a non-numeric index is exit 2 and nothing is sent", async () => {
		const result = await run(["issue-edit", "o/r", "12x", await bodyFile(BODY, "c4b")]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("forge-post issue-edit");
		expect(seen).toHaveLength(0);
	});

	test("body from stdin with -", async () => {
		const result = await run(["comment", "o/r", "7", "-"], { stdin: BODY });
		expect(result.code).toBe(0);
		expect(seen[0]?.body).toEqual({ body: `${IDENTITY}\n\n${BODY}` });
	});

	test("missing FLEET_MODEL is exit 3 and nothing is sent", async () => {
		const result = await run(["comment", "o/r", "7", await bodyFile(BODY, "c5")], {
			env: env({ FLEET_MODEL: undefined }),
		});
		expect(result.code).toBe(3);
		expect(result.stderr).toContain("FLEET_MODEL");
		expect(seen).toHaveLength(0);
	});

	test("bad repo argument is exit 2 and nothing is sent", async () => {
		const result = await run(["comment", "o/r;x", "7", await bodyFile(BODY, "c6")]);
		expect(result.code).toBe(2);
		expect(result.stderr).toContain("usage: forge-post comment");
		expect(seen).toHaveLength(0);
	});

	test("HTTP 500 is exit 1 with the status on stderr", async () => {
		const result = await run(["comment", "o/fail", "7", await bodyFile(BODY, "c7")]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("HTTP 500");
		expect(result.stderr).toContain("boom");
		expect(result.stdout).toBe("");
		expect(seen).toHaveLength(1);
	});

	test("a 60001-byte body is exit 1 and nothing is sent", async () => {
		const result = await run(["comment", "o/r", "7", await bodyFile("a".repeat(60001), "c8")]);
		expect(result.code).toBe(1);
		expect(result.stderr).toContain("body too long");
		expect(seen).toHaveLength(0);
	});

	test("the token never appears in argv, and the request still authenticates", async () => {
		const text = readFileSync(SCRIPT, "utf8");
		expect(text).not.toContain('-H "Authorization');
		expect(text).toContain('--config <(printf \'header = "Authorization: token %s"');
		const result = await run(["comment", "o/r", "7", await bodyFile(BODY, "c9")]);
		expect(result.code).toBe(0);
		expect(seen[0]?.authorization).toBe("token t-1");
	});
});
