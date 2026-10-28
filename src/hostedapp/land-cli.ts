/**
 * @module hostedapp/land-cli
 * @description The CLI shell around `landRegistry`: argument parsing, the row
 *   and summary lines on stdout, the machine summary file, and the exit
 *   grammar. Kept apart from `land.ts` so the landing loop stays testable as a
 *   pure function of its inputs and the injected fetch, with no process state.
 *
 * @outputs
 *   - `parseLandArgs` -- the argument list -> options or a usage error
 *   - `runHostedAppLand` -- the `hosted-app land` subcommand
 *
 * @dependencies
 *   - ./land -- the landing loop and its summary shape
 *   - ./fetch -- the live read seam and the default Forge base
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { join } from "node:path";
import { traced } from "../log";
import { DEFAULT_FORGE_API, type FetchText, forgeFetchText } from "./fetch";
import {
	type LandedApp,
	LandHarnessError,
	type LandSummary,
	landRegistry,
	SUMMARY_FILE,
} from "./land";

const LAND_USAGE = `Usage:
  software-factory hosted-app land --registry-dir <dir> --k3s-deploy-dir <dir> \\
      [--app <name>] [--forge-api <url>]

Reads FORGE_TOKEN from the environment. Exit codes: 0 every app landed,
1 one or more apps failed, 3 harness error.`;

/** Parsed form of the `land` argument list. */
export type LandArgs =
	| { ok: true; registryDir: string; deployDir: string; forgeApi: string; app?: string }
	| { ok: false; error: string };

/** The options `land` knows; anything else is a usage error, never a default. */
const LAND_OPTIONS = new Set(["--registry-dir", "--k3s-deploy-dir", "--app", "--forge-api"]);

/** Parse the args after the `land` selector; every known option takes one value. */
export const parseLandArgs = traced(
	"hostedapp.parseLandArgs",
	function parseLandArgs(args: readonly string[]): LandArgs {
		const opts: Record<string, string> = {};
		for (let i = 0; i < args.length; i++) {
			const token = args[i];
			if (token === undefined) continue;
			if (!LAND_OPTIONS.has(token)) {
				return { ok: false, error: `unknown option: ${token}\n${LAND_USAGE}` };
			}
			if (opts[token.slice(2)] !== undefined) {
				return { ok: false, error: `${token} given more than once\n${LAND_USAGE}` };
			}
			const value = args[i + 1];
			if (value === undefined) return { ok: false, error: `${token} requires a value` };
			opts[token.slice(2)] = value;
			i++;
		}
		const registryDir = opts["registry-dir"];
		const deployDir = opts["k3s-deploy-dir"];
		if (registryDir === undefined || deployDir === undefined) {
			return { ok: false, error: LAND_USAGE };
		}
		const forgeApi = opts["forge-api"] ?? DEFAULT_FORGE_API;
		const app = opts.app;
		return app === undefined
			? { ok: true, registryDir, deployDir, forgeApi }
			: { ok: true, registryDir, deployDir, forgeApi, app };
	},
);

/** The stdout row for one app: PASS with its targets, FAIL, or SKIP. */
export const appRow = traced("hostedapp.appRow", function appRow(app: LandedApp): string {
	if (app.verdict === "skip") return `SKIP -- ${app.name}: retired`;
	if (app.verdict === "fail") {
		const problems = app.problems.map((p) => `${p}\n`).join("");
		return `${problems}FAIL -- ${app.name}: not landed`;
	}
	const targets = app.targets.map((t) => `${t.name}(${t.kind})`).join(", ");
	return `PASS -- ${app.name}: rendered ${targets}`;
});

/** Write the machine summary beside the landed apps in the deploy checkout. */
async function writeSummary(summary: LandSummary, deployDir: string): Promise<void> {
	const body = JSON.stringify({ apps: summary.apps }, null, 2);
	await Bun.write(join(deployDir, SUMMARY_FILE), `${body}\n`);
}

/**
 * Run `hosted-app land`.
 *
 * @param args - the argument list after the `land` selector
 * @param fetchText - the read seam; the live Forge fetch by default
 * @returns 0 every app landed, 1 one or more failed, 3 harness error
 */
export const runHostedAppLand = traced(
	"hostedapp.runHostedAppLand",
	async function runHostedAppLand(
		args: readonly string[],
		fetchText: FetchText = forgeFetchText,
	): Promise<number> {
		const parsed = parseLandArgs(args);
		if (!parsed.ok) {
			process.stderr.write(`${parsed.error}\n`);
			return 3;
		}
		let summary: LandSummary;
		try {
			summary = await landRegistry({
				registryDir: parsed.registryDir,
				deployDir: parsed.deployDir,
				forgeApi: parsed.forgeApi,
				token: process.env.FORGE_TOKEN ?? "",
				fetchText,
				...(parsed.app === undefined ? {} : { app: parsed.app }),
			});
		} catch (error) {
			if (error instanceof LandHarnessError) {
				process.stderr.write(`${error.message}\n`);
				return 3;
			}
			throw error;
		}
		for (const app of summary.apps) process.stdout.write(`${appRow(app)}\n`);
		try {
			await writeSummary(summary, parsed.deployDir);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			process.stderr.write(`summary file not writable: ${parsed.deployDir}: ${reason}\n`);
			return 3;
		}
		const verdict = summary.failed > 0 ? "FAIL" : "PASS";
		process.stdout.write(
			`RESULT ${verdict} -- ${summary.rendered} app(s) rendered, ` +
				`${summary.failed} failed, ${summary.skipped} skipped\n`,
		);
		return summary.failed > 0 ? 1 : 0;
	},
);
