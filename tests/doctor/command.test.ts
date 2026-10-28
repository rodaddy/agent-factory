/**
 * @module tests/doctor/command
 * @description Hermetic tests for the doctor CLI adapter. They exercise the
 *   report + exit-code logic with FAKE seams (no live token) and
 *   assert: all-pass yields exit 0 with a PASS line per probe; ANY probe
 *   failing yields a non-zero exit with a FAIL line; the arg parser rejects bad
 *   options; and the token sentinel never appears in the printed report. The
 *   status-health probe is exercised against a REAL scratch database (withTestDb)
 *   so its passing path is covered end to end.
 */
import { describe, expect, test } from "bun:test";
import { parseDoctorArgs, runDoctor, runDoctorCommand } from "../../src/doctor/command";
import type { ProbeSeams } from "../../src/doctor/probe";
import { withTestDb } from "../db/helpers";

const SENTINEL_TOKEN = "ghp_SENTINEL_TOKEN_DO_NOT_LEAK_0000000000";
const CONFIG_PATH = "config/repos.example.yml";

/** Collect stdout/stderr lines from a doctor run. */
function capture() {
	const out: string[] = [];
	const err: string[] = [];
	return {
		io: { stdout: (m: string) => out.push(m), stderr: (m: string) => err.push(m) },
		out,
		err,
	};
}

describe("parseDoctorArgs", () => {
	test("defaults the config path and parses --config", () => {
		expect(parseDoctorArgs([])).toEqual({ ok: true, configPath: "config/repos.yml" });
		expect(parseDoctorArgs(["--config", "x.yml"])).toEqual({ ok: true, configPath: "x.yml" });
	});
	test("rejects a missing --config value and unknown options", () => {
		expect(parseDoctorArgs(["--config"]).ok).toBe(false);
		expect(parseDoctorArgs(["--bogus"]).ok).toBe(false);
	});
	test("the retired box probe's --size option is refused", () => {
		expect(parseDoctorArgs(["--size", "medium"]).ok).toBe(false);
	});
});

describe("runDoctor report + exit code", () => {
	test("all four probes pass yields exit 0 and a PASS line per probe", async () => {
		await withTestDb(async (db) => {
			const seams: ProbeSeams = {
				createDb: () => ({ db, client: { end: async () => undefined } }),
				resolveForgejoToken: () => ({ ok: true, token: SENTINEL_TOKEN }),
				createForgejoClient: () =>
					({
						get: async () => ({
							status: 200,
							data: { version: "16.0.1" },
							link: null,
							rateRemaining: null,
						}),
					}) as never,
			};
			const { io, out } = capture();
			const code = await runDoctor({ configPath: CONFIG_PATH, seams }, io);
			expect(code).toBe(0);
			const report = out.join("\n");
			expect(report).toContain("[PASS] postgres");
			expect(report).toContain("[PASS] forge-read");
			expect(report).toContain("[PASS] status-health");
			expect(report).toContain("[PASS] gateway-reachable");
			expect(report).not.toContain("runner-dispatch");
			expect(report).toContain("4/4 probes passed");
			expect(report).not.toContain(SENTINEL_TOKEN);
		});
	});

	test("a single failing probe yields a non-zero exit and a FAIL line", async () => {
		await withTestDb(async (db) => {
			const seams: ProbeSeams = {
				createDb: () => ({ db, client: { end: async () => undefined } }),
				resolveForgejoToken: () => ({ ok: false, error: "no token" }),
			};
			const { io, out } = capture();
			const code = await runDoctor({ configPath: CONFIG_PATH, seams }, io);
			expect(code).not.toBe(0);
			expect(out.join("\n")).toContain("[FAIL] forge-read");
			expect(out.join("\n")).toContain("3/4 probes passed");
		});
	});

	test("a dead gateway fails the doctor run by name", async () => {
		// THE OUTAGE CASE. On 2026-09-08 the gateway CT was stopped for 35 h and a
		// `doctor` run would have passed. Every other probe is healthy here; only the
		// gateway is refusing, and that alone must turn the run red — and say
		// "gateway", not "runner did not accept the job".
		await withTestDb(async (db) => {
			const seams: ProbeSeams = {
				createDb: () => ({ db, client: { end: async () => undefined } }),
				resolveForgejoToken: () => ({ ok: true, token: SENTINEL_TOKEN }),
				createForgejoClient: () =>
					({
						get: async () => ({
							status: 200,
							data: { version: "16.0.1" },
							link: null,
							rateRemaining: null,
						}),
					}) as never,
				gatewayUrl: "http://10.0.20.63:7180/mcp",
				fetch: async () => {
					throw new Error("connect ECONNREFUSED 10.0.20.63:7180");
				},
			};
			const { io, out } = capture();
			const code = await runDoctor({ configPath: CONFIG_PATH, seams }, io);
			expect(code).not.toBe(0);
			const report = out.join("\n");
			expect(report).toContain("[FAIL] gateway-reachable");
			expect(report).toContain("3/4 probes passed");
		});
	});

	test("returns 1 when the config cannot be loaded", async () => {
		const { io } = capture();
		const code = await runDoctor({ configPath: "does/not/exist.yml" }, io);
		expect(code).toBe(1);
	});
});

/**
 * The COMMAND-level wiring, which had no test at all.
 *
 * `runDoctor` is exercised above with injected seams, so the env read inside
 * `runDoctorCommand` — the only thing that makes the gateway probe non-inert on
 * a real box — could be deleted with the entire suite green. Combined with
 * absent-URL-is-PASS, deleting it turns the probe into a permanent green light.
 */
describe("runDoctorCommand gateway wiring", () => {
	test("the gateway URL comes from the ENVIRONMENT, proven by the report", async () => {
		// Asserting `resolveProbeGatewayUrl(process.env)` here would prove nothing:
		// that is the helper in isolation, and the defect is the COMMAND not calling
		// it. So this runs the real command and reads its printed verdict. Delete
		// the env read and the probe reports "not configured" (a PASS), which this
		// test rejects.
		const priorTransport = process.env.RUNNER_TRANSPORT;
		const priorUrl = process.env.RUNNER_BOXES_HTTP_URL;
		process.env.RUNNER_TRANSPORT = "http";
		process.env.RUNNER_BOXES_HTTP_URL = "http://127.0.0.1:7199/mcp";
		try {
			await withTestDb(async (db) => {
				const { io, out } = capture();
				await runDoctorCommand(["--config", CONFIG_PATH], io, {
					createDb: () => ({ db, client: { end: async () => undefined } }),
					resolveForgejoToken: () => ({ ok: true, token: SENTINEL_TOKEN }),
					createForgejoClient: () =>
						({
							get: async () => ({
								status: 200,
								data: { version: "16.0.1" },
								link: null,
								rateRemaining: null,
							}),
						}) as never,
					fetch: async () => {
						throw new Error("connect ECONNREFUSED 127.0.0.1:7199");
					},
				});
				const report = out.join("\n");
				expect(report).toContain("[FAIL] gateway-reachable");
				expect(report).not.toContain("not configured");
			});
		} finally {
			if (priorTransport === undefined) delete process.env.RUNNER_TRANSPORT;
			else process.env.RUNNER_TRANSPORT = priorTransport;
			if (priorUrl === undefined) delete process.env.RUNNER_BOXES_HTTP_URL;
			else process.env.RUNNER_BOXES_HTTP_URL = priorUrl;
		}
	});
});

/**
 * The MISCONFIGURED deployment, end to end (review of 5b18e7e).
 *
 * `RUNNER_TRANSPORT=http` with a blank `RUNNER_BOXES_HTTP_URL` is a box that
 * intends gateway dispatch and has no gateway address, so it dispatches nothing.
 * Both that and "this deployment uses mcp2cli" used to collapse to an undefined
 * URL, and the probe reads undefined as not-configured — a PASS. The doctor
 * therefore reported a box that could never dispatch as healthy, which is the
 * same blind spot sf#692 exists to close, one layer in.
 */
describe("runDoctorCommand gateway misconfiguration", () => {
	test("http transport with a blank URL fails the run by name", async () => {
		const priorTransport = process.env.RUNNER_TRANSPORT;
		const priorUrl = process.env.RUNNER_BOXES_HTTP_URL;
		process.env.RUNNER_TRANSPORT = "http";
		process.env.RUNNER_BOXES_HTTP_URL = "   ";
		try {
			await withTestDb(async (db) => {
				const { io, out } = capture();
				const code = await runDoctorCommand(["--config", CONFIG_PATH], io, {
					createDb: () => ({ db, client: { end: async () => undefined } }),
					resolveForgejoToken: () => ({ ok: true, token: SENTINEL_TOKEN }),
					createForgejoClient: () =>
						({
							get: async () => ({
								status: 200,
								data: { version: "16.0.1" },
								link: null,
								rateRemaining: null,
							}),
						}) as never,
					fetch: async () => {
						throw new Error("must not be called: there is no URL to fetch");
					},
				});
				const report = out.join("\n");
				expect(code).not.toBe(0);
				expect(report).toContain("[FAIL] gateway-reachable");
				// And it must NOT claim the deployment simply has no gateway.
				expect(report).not.toContain("not configured for this deployment");
			});
		} finally {
			if (priorTransport === undefined) delete process.env.RUNNER_TRANSPORT;
			else process.env.RUNNER_TRANSPORT = priorTransport;
			if (priorUrl === undefined) delete process.env.RUNNER_BOXES_HTTP_URL;
			else process.env.RUNNER_BOXES_HTTP_URL = priorUrl;
		}
	});
});
