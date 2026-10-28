/**
 * @module enroll/cli
 * @description The `enroll --derive` subcommand (lane 831c). Derives the
 *   fleet plan from a k3s-deploy checkout (`derivePlan`), resolves each imaged
 *   row's Forge source repo (`resolveSource`), and prints one line per non-infra
 *   dir plus the exact `_ob/bin/enroll-app enroll` command for every row whose
 *   source repo was found and is not yet on the rail. Per D19 it never writes
 *   config/repos.yml. `--dry-run` prints and writes nothing. The bare form
 *   (lane 831d) then runs those enroll-app commands one at a time through the
 *   `run` seam, stopping at the first non-zero exit (exit 1, app named; a
 *   failed app is never re-run). After each app enrols, its source repo gets its
 *   own factory webhook (./webhooks); a hook failure is printed
 *   and makes the exit 1 after the remaining apps run. `enroll --webhooks`
 *   routes to `runWebhooksCommand`. An unreadable tree, a missing token, or a
 *   failed Forge read is exit 3.
 *
 * @outputs
 *   - `runEnrollCommand` -- argv -> process exit code, over injectable deps
 *
 * @dependencies
 *   - ./derive -- the planner
 *   - ./resolve -- the source-repo resolver
 *   - ../hostedapp/fetch -- the live FetchText and the default Forge API
 *   - ../log -- the traced() wrapper
 *   - ./webhooks -- per-repo webhook install and the live token
 */
import { join } from "node:path";
import { DEFAULT_FORGE_API, type FetchText, forgeFetchText } from "../hostedapp/fetch";
import { errorClass, errorMessage, traced } from "../log";
import { type DeriveRow, DNS_LABEL, derivePlan } from "./derive";
import { type ResolveResult, resolveSource } from "./resolve";
import {
	ensureRepoHook,
	type HookApi,
	hookLine,
	liveHookApi,
	liveToken,
	runWebhooksCommand,
} from "./webhooks";

/** A rail enrolment is a build_bump repo: tag (create), tag push, and the PR lanes. */
const RAIL_EVENTS = ["create", "pull_request", "pull_request_sync", "push"];

/** Injectable seams; the defaults are the live ones. */
export type EnrollDeps = {
	fetchText?: FetchText;
	/** Return the Forge token; throw when none can be had. Never printed. */
	token?: () => string;
	api?: string;
	out?: (line: string) => void;
	/** Run one enroll-app invocation (its args, after the binary); resolve to its exit code. */
	run?: (argv: readonly string[]) => Promise<number>;
	/** The Forge webhook seam; defaults to liveHookApi over the token. */
	hooks?: HookApi;
	/** FORGE_WEBHOOK_SECRET; never printed. */
	secret?: () => string | undefined;
};

/** The repo root, from this file (src/enroll/cli.ts), so no path depends on the cwd. */
const REPO_ROOT = join(import.meta.dir, "..", "..");
const DEFAULT_K3S_DEPLOY_DIR = join(REPO_ROOT, "..", "k3s-deploy");
/** The Development root; enroll-app runs from here so a bare checkout name resolves as a sibling repo. */
const DEV_ROOT = join(REPO_ROOT, "..");

/** The live runner: Development's _ob/bin/enroll-app, output streamed to this terminal. */
async function liveRun(argv: readonly string[]): Promise<number> {
	const proc = Bun.spawn([join(DEV_ROOT, "_ob", "bin", "enroll-app"), ...argv], {
		cwd: DEV_ROOT,
		stdio: ["inherit", "inherit", "inherit"],
	});
	return await proc.exited;
}

type EnrollArgs = { k3sDeployDir: string; dryRun: boolean };

const USAGE =
	"usage: enroll --derive [--k3s-deploy-dir <path>] [--dry-run]\n       enroll --webhooks [--repo <owner/name>]... [--config <path>] [--dry-run]\n  --k3s-deploy-dir defaults to ../k3s-deploy relative to the software-factory repo root";

function parseArgs(args: readonly string[]): EnrollArgs | string {
	let derive = false;
	let dryRun = false;
	let k3sDeployDir = DEFAULT_K3S_DEPLOY_DIR;
	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--derive") derive = true;
		else if (arg === "--dry-run") dryRun = true;
		else if (arg === "--k3s-deploy-dir" && args[i + 1] !== undefined) {
			k3sDeployDir = args[i + 1] as string;
			i += 1;
		} else return `unknown or incomplete option: ${arg}`;
	}
	return derive ? { k3sDeployDir, dryRun } : "enroll requires --derive";
}

/** The app name enroll-app takes: the dir minus its `-uat`/`-prod` stage suffix. */
function appName(dir: string): string {
	return dir.replace(/-(uat|prod)$/, "");
}

function rowLine(row: DeriveRow, result: ResolveResult | null): string {
	const source =
		result === null
			? `- (${row.reason})`
			: result.status === "found"
				? `${result.repo} latest=${result.latestTag}`
				: `refused ${result.reason}: ${result.detail}`;
	return `${row.dir}  image=${row.image ?? "-"}  source=${source}  onRail=${row.onRail}`;
}

/** The enroll-app args for a found, off-rail row, or null. */
function enrollArgv(row: DeriveRow, result: ResolveResult | null): string[] | null {
	if (result?.status !== "found" || row.onRail) return null;
	const checkout = result.repo.split("/")[1] ?? result.repo;
	const app = appName(row.dir);
	// Re-asserted here: this line is pasted into a shell, so nothing unvalidated reaches it.
	if (!DNS_LABEL.test(app) || !/^[A-Za-z0-9_][A-Za-z0-9._-]*$/.test(checkout)) return null;
	return ["enroll", checkout, "--app", app];
}

type Planned = { argv: string[]; repo: string };
type ApplyDeps = {
	run: (argv: readonly string[]) => Promise<number>;
	hooks: HookApi;
	secret: string | undefined;
	out: (line: string) => void;
};

/** Install one enrolled app's source-repo hook; print the outcome; false on refused/failed. */
async function installHook(repo: string, deps: ApplyDeps): Promise<boolean> {
	try {
		const outcome = await ensureRepoHook(deps.hooks, repo, RAIL_EVENTS, {
			secret: deps.secret,
			dryRun: false,
		});
		deps.out(`  ${repo}: ${hookLine(outcome)}`);
		return outcome.kind !== "refused";
	} catch (error) {
		deps.out(`  ${repo}: failed: ${errorMessage(error)}`);
		return false;
	}
}

/** Run each planned enroll-app argv in order; stop at the first non-zero exit or spawn throw (1), naming the app. A hook failure is exit 1 after every app runs. */
async function applyPlan(planned: readonly Planned[], deps: ApplyDeps): Promise<number> {
	const { run, out } = deps;
	let hookFailed = false;
	for (const { argv, repo } of planned) {
		const app = argv[3] ?? "";
		let code: number;
		try {
			code = await run(argv);
		} catch (error) {
			// Class and errno code only: a spawn error message quotes the binary path.
			const errno = (error as { code?: unknown } | null)?.code;
			const detail =
				typeof errno === "string" ? `${errorClass(error)} ${errno}` : errorClass(error);
			process.stderr.write(
				`enroll-app could not start for ${app}: ${detail}; stopped, later apps not run\n`,
			);
			return 1;
		}
		if (code !== 0) {
			out(`enroll-app failed for ${app} (exit ${code}); stopped, later apps not run`);
			return 1;
		}
		out(`enrolled ${app}`);
		if (!(await installHook(repo, deps))) hookFailed = true;
	}
	return hookFailed ? 1 : 0;
}

/** Apply the plan with the live defaults filled in for any unset seam. */
async function applyWithDeps(
	planned: readonly Planned[],
	token: string,
	deps: EnrollDeps,
	out: (line: string) => void,
): Promise<number> {
	return await applyPlan(planned, {
		run: deps.run ?? liveRun,
		hooks: deps.hooks ?? liveHookApi(token, deps.api ?? DEFAULT_FORGE_API),
		secret: (deps.secret ?? (() => process.env.FORGE_WEBHOOK_SECRET))(),
		out,
	});
}

async function runEnrollCommandImpl(
	args: readonly string[],
	deps: EnrollDeps = {},
): Promise<number> {
	const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
	if (!args.includes("--webhooks")) return await runDerive(args, deps, out);
	const hooks = deps.hooks;
	const factory = hooks === undefined ? undefined : () => hooks;
	return await runWebhooksCommand(args, { ...deps, hooks: factory, out });
}

async function runDerive(
	args: readonly string[],
	deps: EnrollDeps,
	out: (line: string) => void,
): Promise<number> {
	const parsed = parseArgs(args);
	if (typeof parsed === "string") {
		process.stderr.write(`${parsed}\n${USAGE}\n`);
		return 2;
	}
	let rows: DeriveRow[];
	let token: string;
	try {
		rows = derivePlan(parsed.k3sDeployDir);
		token = (deps.token ?? liveToken)();
	} catch (error) {
		const message = errorMessage(error);
		process.stderr.write(`${message.startsWith("enroll") ? "" : "enroll --derive: "}${message}\n`);
		return 3;
	}
	const fetchText = deps.fetchText ?? forgeFetchText;
	const printed = new Map<string, string>();
	const planned: Planned[] = [];
	const apps = rows.filter((row) => row.reason !== "infra");
	out(`plan: ${apps.length} app dirs; ${rows.length - apps.length} infra dirs skipped`);
	for (const row of apps) {
		let result: ResolveResult | null = null;
		try {
			if (row.image !== null) {
				result = await resolveSource(fetchText, token, row.image, deps.api ?? DEFAULT_FORGE_API);
			}
		} catch (error) {
			process.stderr.write(`enroll --derive: ${row.dir}: ${errorMessage(error)}\n`);
			return 3;
		}
		out(rowLine(row, result));
		const argv = enrollArgv(row, result);
		// A uat/prod pair shares one app name; enroll-app takes it once. The first (sorted)
		// dir's checkout wins and a disagreeing checkout is named on stderr.
		const kept = printed.get(appName(row.dir));
		if (argv !== null && kept === undefined) {
			printed.set(appName(row.dir), argv[1] ?? "");
			if (result?.status === "found") planned.push({ argv, repo: result.repo });
			out(`  _ob/bin/enroll-app ${argv.join(" ")}`);
		} else if (argv !== null && kept !== argv[1]) {
			process.stderr.write(
				`enroll --derive: ${row.dir} resolves to ${argv[1]}, not ${kept}; enrolled ${kept}\n`,
			);
		}
	}
	return parsed.dryRun ? 0 : await applyWithDeps(planned, token, deps, out);
}

/** argv -> exit code: 0 plan printed (and applied), 1 an enroll-app run failed, 2 bad usage, 3 unreadable tree / no token / Forge read failed. */
export const runEnrollCommand = traced("enroll.runEnrollCommand", runEnrollCommandImpl, {
	// Arg 1 carries the token getter, the fetch seam, and the runner.
	redact: { args: [1] },
});
