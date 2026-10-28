/**
 * @module tests/actions/call-engine-attempts-file
 * @description The engine step's attempt count leaving the job through a file.
 *
 *   These drive the CLI as a SUBPROCESS rather than importing `callEngine`,
 *   because the behaviour under test lives in the `import.meta.main` block: the
 *   pure function is deliberately unchanged and knows nothing about the file.
 *   Exercising it through the module's exports would prove nothing about the
 *   path the workflow actually runs.
 *
 *   The load-bearing property is that the count is written on BOTH paths. A run
 *   that took three attempts and still failed is exactly the run the metric
 *   exists to surface, so writing only on success would blind the mirror to the
 *   worst cases.
 *
 *   Offline: the failure case points the engine at a closed local port and the
 *   success case at a bun server on an ephemeral one. Fixtures go under the
 *   repo's portable temp base (`tests/support/test-temp`), never `/tmp`.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { testTmpBase } from "../support/test-temp";

const CLI = new URL("../../scripts/actions/call-engine.ts", import.meta.url).pathname;

const OK_REPLY = JSON.stringify({ choices: [{ message: { content: "verdict: approve\n" } }] });

async function scratchDir(): Promise<string> {
	return mkdtemp(join(await testTmpBase(), "call-engine-attempts-"));
}

describe("the CLI's ENGINE_ATTEMPTS_FILE", () => {
	test("records the winning attempt on the success path", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response(OK_REPLY) });
		const attemptsFile = join(await scratchDir(), "attempts");
		try {
			const proc = Bun.spawn(["bun", CLI], {
				stdin: new TextEncoder().encode("{}"),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH ?? "",
					ENGINE_URL: `http://127.0.0.1:${server.port}`,
					CLIPROXY_API_KEY: "probe-key",
					ENGINE_ATTEMPTS_FILE: attemptsFile,
				},
			});
			expect(await proc.exited).toBe(0);
			expect(readFileSync(attemptsFile, "utf8")).toBe("1");
		} finally {
			server.stop(true);
		}
	}, 30_000);

	test("records the final attempt on the failure path too", async () => {
		const attemptsFile = join(await scratchDir(), "attempts");
		const proc = Bun.spawn(["bun", CLI], {
			stdin: new TextEncoder().encode("{}"),
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH ?? "",
				// A closed port: every attempt throws, so all three are spent.
				ENGINE_URL: "http://127.0.0.1:1",
				CLIPROXY_API_KEY: "probe-key",
				ENGINE_BACKOFF_MS: "1,2",
				ENGINE_ATTEMPTS_FILE: attemptsFile,
			},
		});
		expect(await proc.exited).toBe(22);
		expect(readFileSync(attemptsFile, "utf8")).toBe("3");
	}, 30_000);

	test("an empty setting writes nothing and leaves the exit code alone", async () => {
		const proc = Bun.spawn(["bun", CLI], {
			stdin: new TextEncoder().encode("{}"),
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH ?? "",
				ENGINE_URL: "http://127.0.0.1:1",
				CLIPROXY_API_KEY: "probe-key",
				ENGINE_BACKOFF_MS: "1,2",
				ENGINE_ATTEMPTS_FILE: "",
			},
		});
		expect(await proc.exited).toBe(22);
	}, 30_000);

	// The metric is a by-product. Losing it must never turn a completed review
	// into a failed job, which is what an unguarded write would do.
	test("an unwritable path does not turn a completed call into a failed one", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response(OK_REPLY) });
		try {
			const proc = Bun.spawn(["bun", CLI], {
				stdin: new TextEncoder().encode("{}"),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH ?? "",
					ENGINE_URL: `http://127.0.0.1:${server.port}`,
					CLIPROXY_API_KEY: "probe-key",
					ENGINE_ATTEMPTS_FILE: join(await scratchDir(), "no", "such", "dir", "attempts"),
				},
			});
			const stdout = await new Response(proc.stdout).text();
			expect(await proc.exited).toBe(0);
			expect(stdout).toContain("verdict: approve");
		} finally {
			server.stop(true);
		}
	}, 30_000);
});

// sf#810: "attempts=1" on a failed run was read as "the engine answered". The
// failure class leaves the step through its own file so the failure() step can
// say WHY: `timeout:<ms>`, `http:<code>`, or `network`.
describe("the CLI's ENGINE_FAILURE_FILE and ENGINE_ATTEMPTS", () => {
	test("ENGINE_ATTEMPTS=2 stops after two retryable 503s and records http:503:retryable", async () => {
		let hits = 0;
		const server = Bun.serve({
			port: 0,
			fetch: () => {
				hits += 1;
				return new Response("upstream sad", { status: 503 });
			},
		});
		const dir = await scratchDir();
		try {
			const proc = Bun.spawn(["bun", CLI], {
				stdin: new TextEncoder().encode("{}"),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH ?? "",
					ENGINE_URL: `http://127.0.0.1:${server.port}`,
					CLIPROXY_API_KEY: "probe-key",
					ENGINE_BACKOFF_MS: "1,2",
					ENGINE_ATTEMPTS: "2",
					ENGINE_ATTEMPTS_FILE: join(dir, "attempts"),
					ENGINE_FAILURE_FILE: join(dir, "failure"),
				},
			});
			expect(await proc.exited).toBe(22);
			expect(hits).toBe(2);
			expect(readFileSync(join(dir, "attempts"), "utf8")).toBe("2");
			expect(readFileSync(join(dir, "failure"), "utf8")).toBe("http:503:retryable");
		} finally {
			server.stop(true);
		}
	}, 30_000);

	test("a dead engine records network", async () => {
		const dir = await scratchDir();
		const proc = Bun.spawn(["bun", CLI], {
			stdin: new TextEncoder().encode("{}"),
			stdout: "pipe",
			stderr: "pipe",
			env: {
				PATH: process.env.PATH ?? "",
				ENGINE_URL: "http://127.0.0.1:1",
				CLIPROXY_API_KEY: "probe-key",
				ENGINE_BACKOFF_MS: "1,2",
				ENGINE_ATTEMPTS: "2",
				ENGINE_FAILURE_FILE: join(dir, "failure"),
			},
		});
		expect(await proc.exited).toBe(22);
		expect(readFileSync(join(dir, "failure"), "utf8")).toBe("network");
	}, 30_000);

	for (const [status, klass, hits] of [
		[408, "http:408:retryable", 2],
		[401, "http:401:final", 1],
	] as const) {
		test(`a ${status} records ${klass} after ${hits} attempt(s)`, async () => {
			let seen = 0;
			const server = Bun.serve({
				port: 0,
				fetch: () => {
					seen += 1;
					return new Response("no", { status });
				},
			});
			const dir = await scratchDir();
			try {
				const proc = Bun.spawn(["bun", CLI], {
					stdin: new TextEncoder().encode("{}"),
					stdout: "pipe",
					stderr: "pipe",
					env: {
						PATH: process.env.PATH ?? "",
						ENGINE_URL: `http://127.0.0.1:${server.port}`,
						CLIPROXY_API_KEY: "probe-key",
						ENGINE_BACKOFF_MS: "1,2",
						ENGINE_ATTEMPTS: "2",
						ENGINE_FAILURE_FILE: join(dir, "failure"),
					},
				});
				expect(await proc.exited).toBe(22);
				expect(seen).toBe(hits);
				expect(readFileSync(join(dir, "failure"), "utf8")).toBe(klass);
			} finally {
				server.stop(true);
			}
		});
	}

	test("a success writes no failure file", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response(OK_REPLY) });
		const dir = await scratchDir();
		try {
			const proc = Bun.spawn(["bun", CLI], {
				stdin: new TextEncoder().encode("{}"),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH ?? "",
					ENGINE_URL: `http://127.0.0.1:${server.port}`,
					CLIPROXY_API_KEY: "probe-key",
					ENGINE_FAILURE_FILE: join(dir, "failure"),
				},
			});
			expect(await proc.exited).toBe(0);
			expect(existsSync(join(dir, "failure"))).toBe(false);
		} finally {
			server.stop(true);
		}
	}, 30_000);
});

// sf#1680 (D25): the job that holds the engine key must not hold the Langfuse
// keys. LANE_TRACE_OUT records the spans to a file and touches no SDK client.
describe("the CLI's LANE_TRACE_OUT", () => {
	test("with no Langfuse env it records the trace file and never builds the SDK client", async () => {
		const server = Bun.serve({ port: 0, fetch: () => new Response(OK_REPLY) });
		const out = join(await scratchDir(), "trace");
		const run = (extra: Record<string, string>) =>
			Bun.spawn(["bun", CLI], {
				stdin: new TextEncoder().encode("{}"),
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH ?? "",
					ENGINE_URL: `http://127.0.0.1:${server.port}`,
					CLIPROXY_API_KEY: "probe-key",
					LANE: "pr-review",
					...extra,
				},
			});
		try {
			const proc = run({ LANE_TRACE_OUT: out });
			const stderr = await new Response(proc.stderr).text();
			expect(await proc.exited).toBe(0);
			expect(stderr).toContain("lane.trace.recorded");
			// The live path's markers: it says `disabled` without keys, `enabled` with.
			expect(stderr).not.toContain("lane.trace.disabled");
			expect(stderr).not.toContain("lane.trace.enabled");
			const files = readdirSync(out);
			expect(files.length).toBe(1);
			const { batch } = JSON.parse(readFileSync(join(out, files[0] ?? ""), "utf8"));
			expect(batch.map((e: { type: string }) => e.type)).toEqual([
				"trace-create",
				"generation-create",
			]);
			expect(JSON.stringify(batch)).not.toContain("probe-key");

			// Control: the same run without LANE_TRACE_OUT takes the live path.
			const live = run({});
			expect(await new Response(live.stderr).text()).toContain("lane.trace.disabled");
			expect(await live.exited).toBe(0);
		} finally {
			server.stop(true);
		}
	}, 30_000);
});
