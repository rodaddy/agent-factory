/**
 * @module tests/doctor/gateway-probe
 * @description Hermetic tests for the gateway reachability probe.
 *
 *   THE DISTINCTION THIS PROBE EXISTS TO MAKE. During the 35 h outage of
 *   2026-09-08 the gateway CT was stopped, and `doctor` reported
 *   "runner did not accept the job" (the box probe, retired sf#830) — true, and useless: it reads
 *   as a runner-side rejection when the gateway was not answering at all. A
 *   reachability probe separates *nothing is listening* from *something is
 *   listening and said no*, which are different pages for an operator.
 *
 *   A 401 is therefore a PASS. The probe asks one question — is a gateway
 *   answering on the configured URL — and an auth challenge answers it
 *   affirmatively. Treating 401 as a failure would make the probe a credential
 *   check wearing a reachability name, and would fire on a token rotation while
 *   the gateway was perfectly healthy.
 *
 *   No network: `fetch` is injected.
 */
import { describe, expect, test } from "bun:test";
import { resolveProbeGatewayUrl } from "../../src/doctor/command";
import { type ProbeSeams, probeGatewayReachable } from "../../src/doctor/probe";

/** A recognizable secret sentinel; it must NEVER appear in any probe detail. */
const SENTINEL_TOKEN = "ghp_SENTINEL_TOKEN_DO_NOT_LEAK_0000000000";

/** The configured gateway URL, carrying a token in userinfo to prove it is never echoed. */
const URL_WITH_SECRET = `http://user:${SENTINEL_TOKEN}@10.0.20.63:7180/mcp`;

/** Seams with a fetch that answers with a fixed status. */
function answering(status: number): ProbeSeams {
	return {
		gatewayUrl: "http://10.0.20.63:7180/mcp",
		fetch: async () => new Response("", { status }),
	};
}

/** Seams with a fetch that rejects the way a refused connection does. */
function refusing(message: string): ProbeSeams {
	return {
		gatewayUrl: "http://10.0.20.63:7180/mcp",
		fetch: async () => {
			throw new Error(message);
		},
	};
}

describe("probeGatewayReachable", () => {
	test("a 401 is a PASS: something is listening and demanding auth", async () => {
		const probe = await probeGatewayReachable(answering(401));
		expect(probe.name).toBe("gateway-reachable");
		expect(probe.ok).toBe(true);
	});

	test("a 200 is a PASS", async () => {
		const probe = await probeGatewayReachable(answering(200));
		expect(probe.ok).toBe(true);
	});

	test("a 500 is a PASS for reachability: the gateway answered", async () => {
		// Deliberate. This probe reports REACHABILITY, and a 5xx proves the port
		// is served. The dispatch probe is what judges whether it works.
		const probe = await probeGatewayReachable(answering(500));
		expect(probe.ok).toBe(true);
	});

	test("a refused connection is a FAIL — the outage case", async () => {
		const probe = await probeGatewayReachable(refusing("connect ECONNREFUSED 10.0.20.63:7180"));
		expect(probe.ok).toBe(false);
		expect(probe.detail).toContain("did not answer");
	});

	test("a DNS failure is a FAIL", async () => {
		const probe = await probeGatewayReachable(refusing("getaddrinfo ENOTFOUND gateway.invalid"));
		expect(probe.ok).toBe(false);
	});

	test("an mcp2cli deployment is a PASS and says it is not configured", async () => {
		// No HTTP gateway is in this deployment's dispatch path. Failing here would
		// make `doctor` red on a correctly-configured box that simply does not use
		// this transport. This is the ONLY pass-without-probing case.
		const probe = await probeGatewayReachable({ gatewayTarget: { mode: "mcp2cli" } });
		expect(probe.ok).toBe(true);
		expect(probe.detail).toContain("not configured");
	});

	test("HTTP dispatch with NO url configured is a FAIL, not a pass", async () => {
		// The blind spot inside the blind-spot fix (review of 5b18e7e). A box with
		// RUNNER_TRANSPORT=http and a blank RUNNER_BOXES_HTTP_URL dispatches
		// nothing, and both states used to collapse to `undefined` — so the probe
		// read it as "this deployment has no gateway" and passed. Intending gateway
		// dispatch and having no gateway address is broken, and must say so.
		const probe = await probeGatewayReachable({
			gatewayTarget: { mode: "http", url: undefined },
			fetch: async () => {
				throw new Error("must not be called: there is no URL to fetch");
			},
		});
		expect(probe.ok).toBe(false);
		expect(probe.detail).toContain("no gateway URL");
	});

	test("the detail never echoes the URL, which can carry a credential", async () => {
		const probe = await probeGatewayReachable({
			gatewayUrl: URL_WITH_SECRET,
			fetch: async () => {
				throw new Error(`connect ECONNREFUSED ${URL_WITH_SECRET}`);
			},
		});
		expect(probe.ok).toBe(false);
		expect(probe.detail).not.toContain(SENTINEL_TOKEN);
		expect(probe.detail).not.toContain("user:");
		expect(probe.detail.length).toBeLessThanOrEqual(200);
	});

	test("a hung gateway fails rather than hanging the doctor run", async () => {
		// The probe must bound its own wait. A gateway that accepts the connection
		// and never answers is the shape that turns a smoke into a stall.
		const probe = await probeGatewayReachable({
			gatewayUrl: "http://10.0.20.63:7180/mcp",
			fetch: async (_url: string, init?: { signal?: AbortSignal }) => {
				return await new Promise<Response>((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () =>
						reject(new Error("The operation was aborted.")),
					);
				});
			},
			gatewayTimeoutMs: 25,
		});
		expect(probe.ok).toBe(false);
		expect(probe.detail).toContain("did not answer");
	});
});

/**
 * The PRODUCTION wiring for the probe's URL.
 *
 * This had no coverage at all: `tests/doctor/command.test.ts` injects
 * `gatewayUrl` through seams, so the env read — the only thing that makes the
 * probe non-inert on a real box — could be deleted with the whole suite green.
 * Combined with absent-URL-is-PASS, deleting it would make the probe report
 * "gateway not configured" on every real run: a green light that means nothing.
 */
describe("resolveProbeGatewayUrl", () => {
	test("reads the URL when this process actually uses the HTTP transport", () => {
		expect(
			resolveProbeGatewayUrl({
				RUNNER_TRANSPORT: "http",
				RUNNER_BOXES_HTTP_URL: "http://10.0.20.63:7180/mcp",
			}),
		).toEqual({ mode: "http", url: "http://10.0.20.63:7180/mcp" });
	});

	test("ignores a STALE url when the process dispatches over mcp2cli", () => {
		// `createRunnerTransport` only selects the HTTP gateway on
		// RUNNER_TRANSPORT=http. Probing the URL regardless would green-light a
		// gateway that is nowhere in the dispatch path.
		expect(
			resolveProbeGatewayUrl({
				RUNNER_TRANSPORT: "mcp2cli",
				RUNNER_BOXES_HTTP_URL: "http://stale.invalid:7180/mcp",
			}),
		).toEqual({ mode: "mcp2cli" });
	});

	test("an unset transport means mcp2cli, so no gateway is probed", () => {
		expect(
			resolveProbeGatewayUrl({ RUNNER_BOXES_HTTP_URL: "http://stale.invalid:7180/mcp" }),
		).toEqual({ mode: "mcp2cli" });
	});

	test("http transport with no url is a MISCONFIGURATION, not an opt-out", () => {
		// Distinct from mcp2cli: the deployment chose gateway dispatch and gave no
		// address. The probe fails on this rather than reporting not-configured.
		expect(resolveProbeGatewayUrl({ RUNNER_TRANSPORT: "http" })).toEqual({
			mode: "http",
			url: undefined,
		});
	});

	test("a whitespace-only url is the misconfiguration, not a usable address", () => {
		expect(
			resolveProbeGatewayUrl({ RUNNER_TRANSPORT: "http", RUNNER_BOXES_HTTP_URL: "   " }),
		).toEqual({ mode: "http", url: undefined });
	});
});

/**
 * The TRACE side of the same secret-safety question (P1 of the review of 0665d86).
 *
 * The probe's detail strings are deliberately fixed so no URL reaches the report,
 * and the tests above prove that. They prove nothing about `traced()`, which
 * emits `.enter`/`.exit` lines carrying the ARGUMENTS — and in production
 * `resolveProbeGatewayUrl` is handed the entire `process.env`, which holds
 * RUNNER_BOXES_HTTP_TOKEN next to the URL it reads.
 *
 * pino writes to fd 2 and `rootLogger` is module-private, so this has to spawn a
 * child with LOG_LEVEL=debug and read its stderr NDJSON. An in-process spy on
 * `process.stdout.write` captures NOTHING here and reads as a clean result —
 * which is exactly how a broken probe once certified five live leaks as safe.
 * Hence the positive control below: the instrument must be shown capable of
 * catching a leak before its silence is evidence of anything.
 */
describe("resolveProbeGatewayUrl trace redaction", () => {
	const SENTINEL = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

	/** Run a snippet in a child bun with debug logging on; return its stderr NDJSON. */
	async function emitted(snippet: string): Promise<string> {
		const proc = Bun.spawn(["bun", "-e", snippet], {
			cwd: new URL("../..", import.meta.url).pathname,
			env: { ...process.env, LOG_LEVEL: "debug" },
			stderr: "pipe",
			stdout: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		return stderr;
	}

	test("POSITIVE CONTROL: the harness can see a secret when one is really there", async () => {
		// Without this, a clean stderr below could mean "redacted" OR "captured
		// nothing". An unredacted traced function proves the capture path works.
		const out = await emitted(`
			const { traced } = await import("./src/log.ts");
			const leak = traced("test.leak", function leak(env) { return env.SECRET_ISH; });
			leak({ SECRET_ISH: "${SENTINEL}" });
		`);
		expect(out).toContain("test.leak.enter");
		expect(out).toContain(SENTINEL);
	});

	test("the env bag never reaches a trace line, token or otherwise", async () => {
		const out = await emitted(`
			const { resolveProbeGatewayUrl } = await import("./src/doctor/command.ts");
			resolveProbeGatewayUrl({
				RUNNER_TRANSPORT: "http",
				RUNNER_BOXES_HTTP_URL: "http://10.0.20.63:7180/mcp",
				RUNNER_BOXES_HTTP_TOKEN: "${SENTINEL}",
			});
		`);
		// The wrap ran...
		expect(out).toContain("doctor.resolveProbeGatewayUrl.enter");
		// ...and arg 0 was masked wholesale, so no env value appears at all.
		expect(out).not.toContain(SENTINEL);
		expect(out).not.toContain("RUNNER_BOXES_HTTP_TOKEN");
	});

	test("the probe's own seams never reach the trace either", async () => {
		// The SIBLING hole, found by the review of 9d44361. `resolveProbeGatewayUrl`
		// was redacted while `probeGatewayReachable` — which RECEIVES that URL in its
		// seams object — was left matching its five peer probes. That symmetry was
		// the wrong reading: the peers take seams holding only closures, and this one
		// takes an operator-set string. Probed before the fix: a `?access_token=`
		// value appeared verbatim on `.enter`.
		for (const url of [
			`http://user:${SENTINEL}@10.0.20.63:7180/mcp`,
			`http://10.0.20.63:7180/mcp?access_token=${SENTINEL}`,
			`http://10.0.20.63:7180/mcp#${SENTINEL}`,
		]) {
			const out = await emitted(`
				const { probeGatewayReachable } = await import("./src/doctor/probe.ts");
				await probeGatewayReachable({
					gatewayUrl: ${JSON.stringify(url)},
					gatewayTimeoutMs: 30,
					fetch: async () => { throw new Error("refused"); },
				});
			`);
			expect(out).toContain("doctor.probeGatewayReachable.enter");
			expect(out).not.toContain(SENTINEL);
		}
	});

	test("the resolved URL never reaches the trace, in EITHER credential shape", async () => {
		// `summarize()` scrubs `://userinfo@`, so the first shape below was already
		// covered. The second was not: a credential in a QUERY STRING survives that
		// scrub intact. This repo puts no credential in a query string — every
		// client uses an Authorization header — but the value comes from
		// RUNNER_BOXES_HTTP_URL, which an operator sets, and what this codebase
		// does with its own URLs does not constrain what lands in that variable.
		// So the result is redacted wholesale rather than relying on the shape.
		for (const url of [
			`http://user:${SENTINEL}@10.0.20.63:7180/mcp`,
			`http://10.0.20.63:7180/mcp?access_token=${SENTINEL}`,
			`http://10.0.20.63:7180/mcp#${SENTINEL}`,
		]) {
			const out = await emitted(`
				const { resolveProbeGatewayUrl } = await import("./src/doctor/command.ts");
				resolveProbeGatewayUrl({
					RUNNER_TRANSPORT: "http",
					RUNNER_BOXES_HTTP_URL: ${JSON.stringify(url)},
				});
			`);
			expect(out).toContain("doctor.resolveProbeGatewayUrl.exit");
			expect(out).not.toContain(SENTINEL);
		}
	});
});
