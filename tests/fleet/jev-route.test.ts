/**
 * @module tests/fleet/jev-route
 * @description `fleet/skills/jev-route/bin/jev-route`, run as a real
 *   child process against a fake Forge with no Jev key: deterministic senior
 *   factors, the junior paths, the `jev: unavailable` reading, and that the
 *   token never reaches the output, and that a Forge host only a curlrc
 *   `resolve` pin can reach is still read (SOF-1525). `JEV_ROUTE_UNDER_TEST`
 *   points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.JEV_ROUTE_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/skills/jev-route/bin/jev-route");
const TOKEN = "tok-secret-1169";

const FILES: Record<string, { filename: string; additions: number; deletions: number }[]> = {
	"1": [{ filename: ".forgejo/workflows/x.yml", additions: 3, deletions: 1 }],
	"2": [{ filename: "_DOCS/notes.md", additions: 10, deletions: 2 }],
	"3": [{ filename: "src/util/format.ts", additions: 20, deletions: 5 }],
	"4": [{ filename: "fleet/skills/review-dispatch/SKILL.md", additions: 4, deletions: 1 }],
};

let server: ReturnType<typeof Bun.serve>;
let api = "";
const auths: (string | null)[] = [];

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			auths.push(req.headers.get("authorization"));
			const m = new URL(req.url).pathname.match(/^\/repos\/o\/r\/pulls\/(\d+)(\/files)?$/);
			const files = m === null ? undefined : FILES[m[1] ?? ""];
			if (m === null || files === undefined)
				return new Response("body-must-not-leak", { status: 404 });
			if (m[2]) return Response.json(files);
			return Response.json({ number: Number(m[1]), title: `pr ${m[1]}` });
		},
	});
	api = `http://127.0.0.1:${server.port}`;
});
afterAll(() => server.stop(true));

const REAL_CURL = Bun.which("curl") ?? "/usr/bin/curl";

/**
 * A `curl` shim first on the child's PATH: its first `times` calls exit `exit`
 * with curl's own error line, later calls run the real curl. Every call is
 * counted in a file, so a test sees how many attempts the script made.
 */
function curlShim(exit: number, times: number) {
	const dir = mkdtempSync(join(testTmpBase(), "jev-route-curl-"));
	const count = join(dir, "calls");
	writeFileSync(count, "");
	const shim = join(dir, "curl");
	writeFileSync(
		shim,
		`#!/bin/sh
echo x >> '${count}'
n=$(wc -l < '${count}')
if [ "$n" -le ${times} ]; then
  case ${exit} in
    6) echo "curl: (6) Could not resolve host: forge.example" >&2 ;;
    7) echo "curl: (7) Failed to connect to forge.example port 443: Connection refused" >&2 ;;
    22) echo "curl: (22) The requested URL returned error: 404" >&2 ;;
  esac
  exit ${exit}
fi
exec '${REAL_CURL}' "$@"
`,
	);
	chmodSync(shim, 0o755);
	return {
		env: { PATH: `${dir}:${process.env.PATH ?? ""}`, JEV_ROUTE_RETRY_WAIT: "0" },
		calls: () => readFileSync(count, "utf8").split("\n").filter(Boolean).length,
		done: () => rmSync(dir, { recursive: true, force: true }),
	};
}

/** Async spawn: a sync spawn would block the fake Forge living in this same process. */
async function run(args: string[], extra: Record<string, string> = {}) {
	const p = Bun.spawn(["python3", SCRIPT, ...args], {
		env: { PATH: process.env.PATH ?? "", FORGEJO_API_URL: api, FORGEJO_TOKEN: TOKEN, ...extra },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, stdout, stderr, json: code === 0 ? JSON.parse(stdout) : null };
}

describe("jev-route", () => {
	test("a workflow file routes senior with humanRequired", async () => {
		const r = await run(["o/r", "1"]);
		expect(r.code).toBe(0);
		expect(r.json.pair).toBe("senior");
		expect(r.json.humanRequired).toBe(true);
		expect(auths.at(-1)).toBe(`token ${TOKEN}`);
	});

	test("docs-only with last verdict approve-with-fixes routes junior", async () => {
		const r = await run(["o/r", "2", "--last-verdict", "approve-with-fixes"]);
		expect(r.json.pair).toBe("junior");
		expect(r.json.humanRequired).toBe(false);
	});

	test("--seniors-loaded on a plain diff routes junior; without it, senior", async () => {
		expect((await run(["o/r", "3", "--seniors-loaded"])).json.pair).toBe("junior");
		expect((await run(["o/r", "3"])).json.pair).toBe("senior");
	});

	test("jev reads unavailable without a key, and the token never appears", async () => {
		const r = await run(["o/r", "3"]);
		expect(r.json.jev).toBe("unavailable");
		expect(r.stdout + r.stderr).not.toContain(TOKEN);
	});

	test("reads Forge through a curlrc resolve pin when the name has no DNS answer", async () => {
		// The fleet box's Pi-holes refuse it under load; ~/.curlrc
		// pins Forge's address, so the read must go through curl to see the pin.
		const home = mkdtempSync(join(testTmpBase(), "jev-route-curlrc-"));
		try {
			writeFileSync(join(home, ".curlrc"), `resolve = forge.invalid:${server.port}:127.0.0.1\n`);
			const r = await run(["o/r", "1"], {
				FORGEJO_API_URL: `http://forge.invalid:${server.port}`,
				CURL_HOME: home,
			});
			expect(r.stderr).toBe("");
			expect(r.code).toBe(0);
			expect(r.json.pair).toBe("senior");
			expect(auths.at(-1)).toBe(`token ${TOKEN}`);
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("jev-route reviewers: Jev decides one reviewer or two", () => {
	/** A Jev that answers `score` with `confidence` (levels: 0 low, 1 medium, 2 high). */
	const jev = (score: number, confidence: number) => ({
		PYTHONPATH: resolve(import.meta.dir, "fixtures/jev-route-jev"),
		TYPESAFE_API_KEY: "jev-key-test",
		FAKE_JEV_SCORE: String(score),
		FAKE_JEV_CONFIDENCE: String(confidence),
	});

	test("a docs-only (LIGHT) change gets one reviewer, even with Jev unavailable", async () => {
		const r = await run(["o/r", "2"]);
		expect(r.json.depth).toBe("LIGHT");
		expect(r.json.jev).toBe("unavailable");
		expect(r.json.reviewers).toBe(1);
	});

	test("a STANDARD change Jev confidently reads low gets one reviewer", async () => {
		const r = await run(["o/r", "3"], jev(0, 0.9));
		expect(r.json.depth).toBe("STANDARD");
		expect(r.json.jev.level).toBe("low");
		expect(r.json.jev.confident).toBe(true);
		expect(r.json.reviewers).toBe(1);
	});

	test("Jev low but not confident gets two", async () => {
		const r = await run(["o/r", "3"], jev(0, 0.4));
		expect(r.json.jev.level).toBe("low");
		expect(r.json.jev.confident).toBe(false);
		expect(r.json.reviewers).toBe(2);
	});

	test("Jev confident medium on a STANDARD change gets two", async () => {
		const r = await run(["o/r", "3"], jev(1, 0.9));
		expect(r.json.jev.level).toBe("medium");
		expect(r.json.reviewers).toBe(2);
	});

	test("Jev unavailable on a STANDARD change is no signal: two", async () => {
		const r = await run(["o/r", "3"]);
		expect(r.json.jev).toBe("unavailable");
		expect(r.json.reviewers).toBe(2);
	});

	test("any senior factor gets two, even when Jev confidently reads low", async () => {
		const r = await run(["o/r", "1"], jev(0, 0.95));
		expect(r.json.jev.level).toBe("low");
		expect(r.json.depth).toBe("FULL");
		expect(r.json.reviewers).toBe(2);
	});

	test("a senior factor with no human factor gets two, even when Jev confidently reads low", async () => {
		const r = await run(["o/r", "4"], jev(0, 0.95));
		expect(r.json.humanRequired).toBe(false);
		expect(r.json.jev.level).toBe("low");
		expect(r.json.depth).toBe("FULL");
		expect(r.json.reviewers).toBe(2);
	});

	test("a docs-only change Jev confidently reads medium gets two", async () => {
		const r = await run(["o/r", "2"], jev(1, 0.9));
		expect(r.json.depth).toBe("LIGHT");
		expect(r.json.jev.level).toBe("medium");
		expect(r.json.reviewers).toBe(2);
	});

	test("a docs-only change Jev reads high without confidence gets two", async () => {
		const r = await run(["o/r", "2"], jev(2, 0.5));
		expect(r.json.depth).toBe("LIGHT");
		expect(r.json.jev.confident).toBe(false);
		expect(r.json.reviewers).toBe(2);
	});

	test("a docs-only change Jev reads low without confidence gets two", async () => {
		const r = await run(["o/r", "2"], jev(0, 0.4));
		expect(r.json.depth).toBe("LIGHT");
		expect(r.json.jev.confident).toBe(false);
		expect(r.json.reviewers).toBe(2);
	});

	test("a docs-only change Jev confidently reads low gets one", async () => {
		const r = await run(["o/r", "2"], jev(0, 0.9));
		expect(r.json.depth).toBe("LIGHT");
		expect(r.json.reviewers).toBe(1);
	});

	test("a last verdict of fix-first forces two on an otherwise one-reviewer change", async () => {
		const r = await run(["o/r", "2", "--last-verdict", "fix-first"], jev(0, 0.9));
		expect(r.json.depth).toBe("LIGHT");
		expect(r.json.reviewers).toBe(2);
	});
});

describe("jev-route Forge read failures (SOF-1721)", () => {
	test("a failed name lookup (curl 6) on the first attempt is retried and the second succeeds", async () => {
		const shim = curlShim(6, 1);
		try {
			const r = await run(["o/r", "1"], shim.env);
			expect(r.code).toBe(0);
			expect(r.json.pair).toBe("senior");
			expect(r.stderr).toContain("curl exit 6: curl: (6) Could not resolve host");
			expect(r.stderr).toContain("retry 1/2");
			expect(shim.calls()).toBe(3); // pull read failed once and retried, then the files read
			expect(r.stdout + r.stderr).not.toContain(TOKEN);
		} finally {
			shim.done();
		}
	});

	test("a lookup that keeps failing stops after two retries and names the reason", async () => {
		const shim = curlShim(6, 99);
		try {
			const r = await run(["o/r", "1"], shim.env);
			expect(r.code).toBe(2);
			expect(r.stderr).toContain("retry 2/2");
			expect(r.stderr).not.toContain("retry 3/");
			expect(r.stderr).toMatch(/failed: curl exit 6: curl: \(6\) Could not resolve host/);
			expect(shim.calls()).toBe(3);
		} finally {
			shim.done();
		}
	});

	test("a refused connection (curl 7) is retried and its reason reported", async () => {
		const shim = curlShim(7, 99);
		try {
			const r = await run(["o/r", "1"], shim.env);
			expect(r.code).toBe(2);
			expect(r.stderr).toContain("retry 2/2");
			expect(r.stderr).toMatch(/failed: curl exit 7: .*Connection refused/);
			expect(shim.calls()).toBe(3);
		} finally {
			shim.done();
		}
	});

	test("a refused connection against a real closed port is retried through the real curl", async () => {
		const closed = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
		const url = `http://127.0.0.1:${closed.port}`;
		closed.stop(true);
		const r = await run(["o/r", "1"], { FORGEJO_API_URL: url, JEV_ROUTE_RETRY_WAIT: "0" });
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("retry 2/2");
		expect(r.stderr).toMatch(/failed: curl exit 7: /);
	});

	test("an HTTP error (curl 22) is never retried", async () => {
		const shim = curlShim(22, 99);
		try {
			const r = await run(["o/r", "1"], shim.env);
			expect(r.code).toBe(2);
			expect(r.stderr).toContain(
				"failed: curl exit 22: curl: (22) The requested URL returned error: 404",
			);
			expect(r.stderr).not.toContain("retry");
			expect(shim.calls()).toBe(1);
		} finally {
			shim.done();
		}
	});

	test("a real HTTP 404 is never retried and the body never leaks", async () => {
		const before = auths.length;
		const r = await run(["o/r", "404"], { JEV_ROUTE_RETRY_WAIT: "0" });
		expect(r.code).toBe(2);
		expect(r.stderr).toContain("failed: curl exit 22");
		expect(r.stderr).not.toContain("retry");
		expect(r.stderr).not.toContain("body-must-not-leak");
		expect(auths.length - before).toBe(1);
	});
});
