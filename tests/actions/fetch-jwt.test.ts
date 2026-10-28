/**
 * @module tests/actions/fetch-jwt
 * @description Functional tests for the Authorized-Integration token hop.
 *  The load-bearing properties: the audience is appended to the
 *   runner's endpoint and URL-encoded, the request token travels in the
 *   `Authorization` header and nowhere else, a non-2xx yields a reason carrying
 *   the STATUS and never the body, and neither the token nor the returned JWT
 *   ever reaches a reason string.
 *
 *   `fetchImpl` is injected, so no test touches the network. The CLI paths
 *   (missing env, exit 22, masking, `$GITHUB_OUTPUT`) are driven by spawning
 *   the script, which is the only way to observe its exit code and its stderr.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, rename } from "node:fs/promises";
import { basename, join } from "node:path";
import { fetchJwt, JWT_TIMEOUT_MS } from "../../scripts/actions/fetch-jwt";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const SCRIPT = new URL("../../scripts/actions/fetch-jwt.ts", import.meta.url).pathname;
const TOKEN = "request-token-do-not-log-4c1f";
const JWT = "eyJhbGciOiJSUzI1NiJ9.header.signature";
const AUD = "u:11:3e1c6a6e-b208-459b-afd2-2ca4ccf5b1b6";

/** A fetch fake that records what it was called with and returns one response. */
function fakeFetch(status: number, body: string) {
	const urls: string[] = [];
	const inits: RequestInit[] = [];
	const impl = (async (url: string, init: RequestInit) => {
		urls.push(String(url));
		inits.push(init);
		return new Response(body, { status, headers: { "Content-Type": "application/json" } });
	}) as unknown as typeof fetch;
	return { impl, urls, inits };
}

describe("fetchJwt", () => {
	test("a 2xx returns the token and asks the runner with the audience appended", async () => {
		const f = fakeFetch(200, JSON.stringify({ value: JWT, count: 1 }));
		const result = await fetchJwt({
			requestUrl: "http://127.0.0.1:9/token?x=1",
			requestToken: TOKEN,
			audience: AUD,
			fetchImpl: f.impl,
		});

		expect(result).toEqual({ ok: true, jwt: JWT });
		expect(f.urls).toEqual([`http://127.0.0.1:9/token?x=1&audience=${encodeURIComponent(AUD)}`]);
		const headers = f.inits[0]?.headers as Record<string, string>;
		expect(headers.Authorization).toBe(`bearer ${TOKEN}`);
	});

	test("an audience that would inject a parameter is encoded, not passed through", async () => {
		const f = fakeFetch(200, JSON.stringify({ value: JWT }));
		await fetchJwt({
			requestUrl: "http://127.0.0.1:9/token?x=1",
			requestToken: TOKEN,
			audience: "a&audience=b",
			fetchImpl: f.impl,
		});

		expect(f.urls[0]).toBe("http://127.0.0.1:9/token?x=1&audience=a%26audience%3Db");
	});

	test("a non-2xx reports the status and never the body or the token", async () => {
		const f = fakeFetch(401, JSON.stringify({ message: `bad token ${TOKEN}` }));
		const result = await fetchJwt({
			requestUrl: "http://127.0.0.1:9/token?x=1",
			requestToken: TOKEN,
			audience: AUD,
			fetchImpl: f.impl,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.reason).toBe("http 401");
		expect(result.reason).not.toContain(TOKEN);
		expect(result.reason).not.toContain("bad token");
	});

	test("a 2xx whose payload carries no value is a failure, not an empty token", async () => {
		const f = fakeFetch(200, JSON.stringify({ count: 0 }));
		const result = await fetchJwt({
			requestUrl: "http://127.0.0.1:9/token?x=1",
			requestToken: TOKEN,
			audience: AUD,
			fetchImpl: f.impl,
		});

		expect(result).toEqual({ ok: false, reason: "the id-token response carried no value" });
	});

	test("a thrown transport error becomes a reason that does not carry the token", async () => {
		const impl = (async () => {
			throw new Error("connect ECONNREFUSED 127.0.0.1:1");
		}) as unknown as typeof fetch;
		const result = await fetchJwt({
			requestUrl: "http://127.0.0.1:1/token?x=1",
			requestToken: TOKEN,
			audience: AUD,
			fetchImpl: impl,
		});

		expect(result.ok).toBe(false);
		if (result.ok) throw new Error("unreachable");
		expect(result.reason).toContain("ECONNREFUSED");
		expect(result.reason).not.toContain(TOKEN);
	});

	test("the request is bounded", () => {
		expect(JWT_TIMEOUT_MS).toBe(20_000);
	});
});

describe("fetch-jwt CLI", () => {
	test("a missing env var exits 3 and names the variable", async () => {
		const proc = Bun.spawn(["bun", SCRIPT], {
			env: { PATH: process.env.PATH ?? "", ACTIONS_ID_TOKEN_REQUEST_TOKEN: TOKEN, AUD },
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		expect(await proc.exited).toBe(3);
		expect(stderr).toContain("ACTIONS_ID_TOKEN_REQUEST_URL is required");
	});

	test("an unreachable endpoint exits 22 and never prints the request token", async () => {
		const proc = Bun.spawn(["bun", SCRIPT], {
			env: {
				PATH: process.env.PATH ?? "",
				ACTIONS_ID_TOKEN_REQUEST_URL: "http://127.0.0.1:1/?x=1",
				ACTIONS_ID_TOKEN_REQUEST_TOKEN: TOKEN,
				AUD,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		const stdout = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(22);
		expect(stderr).toContain("the id-token request failed");
		expect(stderr).not.toContain(TOKEN);
		expect(stdout).not.toContain(TOKEN);
	});

	test("a 2xx masks the token and appends it to both output files", async () => {
		const server = Bun.serve({
			port: 0,
			fetch: (req) =>
				req.headers.get("Authorization") === `bearer ${TOKEN}`
					? Response.json({ value: JWT })
					: new Response("no", { status: 403 }),
		});
		// The portable temp root: writable on the Mac and inside the sandboxed
		// pre-push runner (node_modules/.cache is not; receipt for 5e10144 refused).
		const dir = await mkdtemp(join(await testTmpBase(), "fetch-jwt-"));
		const gh = `${dir}/github_output`;
		const fj = `${dir}/forgejo_output`;
		await Bun.write(gh, "before=1\n");
		await Bun.write(fj, "");
		try {
			const proc = Bun.spawn(["bun", SCRIPT], {
				env: {
					PATH: process.env.PATH ?? "",
					ACTIONS_ID_TOKEN_REQUEST_URL: `http://127.0.0.1:${server.port}/token?x=1`,
					ACTIONS_ID_TOKEN_REQUEST_TOKEN: TOKEN,
					AUD,
					GITHUB_OUTPUT: gh,
					FORGEJO_OUTPUT: fj,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = await new Response(proc.stdout).text();
			expect(await proc.exited).toBe(0);
			expect(stdout).toBe(`::add-mask::${JWT}\n`);
			expect(await Bun.file(gh).text()).toBe(`before=1\njwt=${JWT}\n`);
			expect(await Bun.file(fj).text()).toBe(`jwt=${JWT}\n`);
		} finally {
			await server.stop(true);
			// Archive, never delete (Development policy): the fixture moves to _archive/.
			await rename(dir, join(await testArchiveDir(), basename(dir)));
		}
	});
});
