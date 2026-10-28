/**
 * @module doctor/command
 * @description CLI adapter for the deployed-path smoke (`doctor`). It
 *   composes the probes over the EXISTING service seams (config load, db
 *   factory, Forgejo credential/client, status query, gateway target), runs them, prints a bounded per-probe PASS/FAIL report, and
 *   returns an exit code: 0 iff every probe passed, non-zero otherwise. It makes
 *   the read-only Forge call (`GET /version`); it never exercises a forge write
 *   endpoint, mutates infrastructure, or dispatches a runner job (the box probe
 *   was retired with sf#830, D10).
 *
 *   The probe seams are injectable (mirroring `composeService`) so tests exercise
 *   the report + exit-code logic with fakes and no live database, token, or box.
 *
 * @outputs
 *   - `runDoctorCommand` -- parse args, run the probes, print the report, exit-code
 *   - `DoctorIo` -- injectable stdout/stderr sink
 *
 * @dependencies
 *   - ../config/load -- the SAME config loader the service uses
 *   - ./probe -- the probes
 */
import { loadConfig } from "../config/load";
import { traced } from "../log";
import { DEPLOY_VERDICTS_USAGE, runDeployVerdictsCommand } from "./deploy-verdicts";
import {
	configHasForgejoRepo,
	type ProbeResult,
	type ProbeSeams,
	probeForgejoRead,
	probeForgeRead,
	probeGatewayReachable,
	probePostgres,
	probeStatusHealth,
} from "./probe";

/** Injectable output sink. */
export interface DoctorIo {
	stdout(message: string): void;
	stderr(message: string): void;
}

const processIo: DoctorIo = {
	stdout: (message) => process.stdout.write(`${message}\n`),
	stderr: (message) => process.stderr.write(`${message}\n`),
};

const DEFAULT_CONFIG_PATH = "config/repos.yml";

/** Options for the doctor run (config path and test seams). */
export interface DoctorOptions {
	configPath?: string;
	/** Injectable probe seams. Production leaves these unset. */
	seams?: ProbeSeams;
	/** Clock seam for the status-health snapshot timestamp. */
	now?: () => Date;
}

/** Parse `--config <path>`. */
export const parseDoctorArgs = traced(
	"doctor.parseDoctorArgs",
	function parseDoctorArgs(
		args: readonly string[],
	): { ok: true; configPath: string } | { ok: false; error: string } {
		let configPath = DEFAULT_CONFIG_PATH;
		for (let i = 0; i < args.length; i++) {
			const token = args[i];
			const value = args[i + 1];
			if (token === "--config") {
				if (value === undefined) {
					return { ok: false, error: "--config requires a path" };
				}
				configPath = value;
				i++;
				continue;
			}
			return { ok: false, error: `unknown option: ${token}` };
		}
		return { ok: true, configPath };
	},
);

/**
 * What this process's dispatch configuration says about a gateway.
 *
 * THREE STATES, NOT TWO. `mcp2cli` means no gateway is in the dispatch path at
 * all, so there is nothing to probe and nothing wrong. `http` with a url is the
 * ordinary case. `http` WITHOUT a url is a misconfiguration — the deployment
 * selected gateway dispatch and gave the gateway no address — and collapsing it
 * into the first state is what let it read as healthy.
 */
export type GatewayProbeTarget = { mode: "mcp2cli" } | { mode: "http"; url: string | undefined };

/**
 * The gateway target the probe should ask about, derived from the same two env
 * vars `createRunnerTransport` selects on.
 *
 * BOTH env vars, matching `createRunnerTransport`'s own selection: the URL alone
 * is not the condition. `RUNNER_TRANSPORT` anything-but-`http` means the process
 * uses `Mcp2cliRunnerTransport` and the URL — stale or not — is not in the
 * dispatch path, so probing it would report on a gateway nothing uses.
 *
 * Exported so the production wiring has a test seam: taking `env` as a parameter
 * is what makes it checkable without mutating the real environment.
 */
export const resolveProbeGatewayUrl = traced(
	"doctor.resolveProbeGatewayUrl",
	function resolveProbeGatewayUrl(env: Record<string, string | undefined>): GatewayProbeTarget {
		if (env.RUNNER_TRANSPORT?.trim() !== "http") {
			return { mode: "mcp2cli" };
		}
		const url = env.RUNNER_BOXES_HTTP_URL?.trim();
		// HTTP SELECTED WITH NO URL IS A MISCONFIGURATION, NOT AN OPT-OUT. Both
		// previously collapsed to `undefined`, and the probe reads absent as "this
		// deployment does not use a gateway" — a PASS. So a box that intends HTTP
		// dispatch and has a blank RUNNER_BOXES_HTTP_URL dispatched nothing and the
		// doctor called it healthy, which is the same blind spot in a new place
		// (review of 5b18e7e). The two states are now distinct.
		if (!url) {
			return { mode: "http", url: undefined };
		}
		return { mode: "http", url };
	},
	// ARG 0 IS THE WHOLE `process.env` IN PRODUCTION (see the call site below),
	// which holds RUNNER_BOXES_HTTP_TOKEN alongside the URL this reads. Key-based
	// masking does cover that token today — it is named like a secret — but the
	// convention in this repo does not lean on that: `createRunnerTransport`
	// (`src/runner/transport-select.ts:83`) reads the SAME two env vars and
	// redacts arg 0, and 9 of the 10 env-reading traced functions here do the
	// same, including ones whose keys are not secret at all. Depending on every
	// future env key being well-named is the weaker rule.
	//
	// THE RESULT IS REDACTED TOO, which is stricter than this repo's own URLs
	// need and deliberately so. `summarize()` scrubs `://userinfo@` from every
	// string (`src/log.ts:322`), and every client here sends its token as an
	// Authorization header — a sweep for `?token=`-shaped credentials across
	// `src/`, `config/`, and `tests/` returns nothing. But this value comes from
	// RUNNER_BOXES_HTTP_URL, which an OPERATOR sets: what this codebase does
	// with its own URLs does not constrain what someone puts in that variable,
	// and a credential in a query string or fragment survives the userinfo
	// scrub intact. The log line loses nothing that matters — whether a gateway
	// was resolved at all is the question, and `doctor`'s own report prints the
	// verdict — so the weaker rule is not worth defending.
	{ redact: { args: [0], result: true } },
);

/** Format one probe result as a fixed PASS/FAIL line. */
function formatProbe(result: ProbeResult): string {
	const badge = result.ok ? "PASS" : "FAIL";
	return `[${badge}] ${result.name}: ${result.detail}`;
}

/**
 * Run the probes and print a bounded PASS/FAIL report. Returns 0 iff every
 * probe passed, non-zero otherwise. The db from the postgres probe is reused by
 * the status-health probe and the underlying client is closed once at the end.
 */
export const runDoctor = traced(
	"doctor.runDoctor",
	async function runDoctor(opts: DoctorOptions, io: DoctorIo): Promise<number> {
		const configPath = opts.configPath ?? DEFAULT_CONFIG_PATH;
		const loaded = await loadConfig(configPath);
		if (!loaded.ok) {
			io.stderr(loaded.error);
			return 1;
		}
		const config = loaded.config;
		const seams = opts.seams ?? {};
		const nowIso = (opts.now?.() ?? new Date()).toISOString();

		const results: ProbeResult[] = [];

		// Probe (a) postgres: build the db once; reuse it for probe (c).
		const pg = await probePostgres(seams);
		results.push(pg.probe);
		try {
			// Probe (b) forge-read (read-only /version on Forge; token never surfaced).
			results.push(await probeForgeRead(seams));
			// Probe (b') forgejo-read: ONLY when the config manages a forgejo repo, so a
			// GitHub-only deployment is never asked for a Forgejo token. Read-only GET
			// /user against the deployed Forgejo host; the token is never surfaced.
			if (configHasForgejoRepo(config)) {
				results.push(await probeForgejoRead(seams));
			}
			// Probe (c) status-health: reuse probe (a)'s db.
			results.push(await probeStatusHealth(pg.db, nowIso));
			// Probe (e) gateway-reachable: is anything listening at the
			// configured gateway? The 2026-09-08 outage ran 35 h without it.
			results.push(await probeGatewayReachable(seams));
		} finally {
			await pg.close();
		}

		io.stdout("software-factory doctor — deployed-path smoke");
		for (const result of results) {
			io.stdout(formatProbe(result));
		}
		const passed = results.filter((r) => r.ok).length;
		const allOk = passed === results.length;
		io.stdout(`${passed}/${results.length} probes passed`);
		return allOk ? 0 : 1;
	},
);

/**
 * CLI entrypoint for `doctor`. Parses args, wires the production seams (the
 * gateway target), runs the probes, and returns the
 * process exit code.
 */
export const runDoctorCommand = traced(
	"doctor.runDoctorCommand",
	async function runDoctorCommand(
		args: readonly string[],
		io: DoctorIo = processIo,
		seedSeams: ProbeSeams = {},
	): Promise<number> {
		// `doctor deploy-verdicts --since <iso>`: the job-completes verify.
		if (args[0] === "deploy-verdicts") {
			return runDeployVerdictsCommand(args.slice(1), io);
		}
		if (args.includes("--help") || args.includes("-h")) {
			io.stdout("Usage: software-factory doctor [--config <path>]");
			io.stdout(`       ${DEPLOY_VERDICTS_USAGE.replace("Usage: ", "")}`);
			return 0;
		}
		const parsed = parseDoctorArgs(args);
		if (!parsed.ok) {
			io.stderr(parsed.error);
			io.stderr("Usage: software-factory doctor [--config <path>]");
			return 2;
		}
		// Wire the production seams unless a test supplied them.
		const seams: ProbeSeams = {
			...seedSeams,
			// The gateway this process would REALLY dispatch through, which is BOTH
			// env vars and not just the URL: `createRunnerTransport` uses the HTTP
			// gateway only when RUNNER_TRANSPORT=http, so a stale RUNNER_BOXES_HTTP_URL
			// left on an mcp2cli deployment would otherwise have the probe
			// green-lighting a URL that is nowhere in the dispatch path.
			//
			// The TARGET rather than a bare url, so the probe can tell "no gateway in
			// this deployment" (fine) from "gateway dispatch selected, no address
			// given" (broken). A plain `string | undefined` cannot express that.
			gatewayTarget: seedSeams.gatewayTarget ?? resolveProbeGatewayUrl(process.env),
		};
		return runDoctor({ configPath: parsed.configPath, seams }, io);
	},
);
