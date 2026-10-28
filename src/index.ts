/**
 * @module index
 * @description CLI entrypoint for software-factory. `run()` is a pure argument
 *   dispatcher for help/version/unknown so it stays trivially testable; the
 *   `watch` command starts the long-running reconciliation service with
 *   graceful shutdown on SIGINT/SIGTERM, and `reconcile once` runs a single
 *   reconciliation cycle (with an optional `--shadow`) and then exits without
 *   starting the status server or the interval scheduler.
 *
 * @outputs
 *   - `run` -- pure arg dispatcher returning an exit code
 *   - `parseOnceArgs` / `isReconcileOnce` / `reconcileOnceRest` -- one-shot parsing
 *   - `runOnceExitCode` -- one `reconcile once` cycle mapped to its exit code
 *   - `VERSION` / `HELP`
 */

import { runEnrolCommand } from "./config/enrol-cli";
import { runDoctorCommand } from "./doctor/command";
import { runEnrollCommand } from "./enroll/cli";
import { runPublishCommand } from "./github/publish-command";
import { runHostedApp } from "./hostedapp/command";
import { errorClass, errorMessage, log, traced } from "./log";
import { runPrepushCommand } from "./prepush/command";
import { defaultOnError } from "./observability/critical-alert";
import { type RunOnceOptions, runOnce, startService } from "./service";

export const VERSION = "0.1.0";

export const HELP = `software-factory ${VERSION}

Usage: software-factory [command] [--help] [--version]

Commands:
  watch             Run the reconciliation loop (startup pass, then every interval)
  reconcile once    Run exactly one reconciliation pass, then exit (no server)
  prepush status <sha>  Show the factory/prepush status Forge holds for a commit
  doctor            Run the deployed-path smoke probes and report PASS/FAIL
  doctor deploy-verdicts --since <iso8601>
                    Require a posted verdict for every lane that dispatched since <iso8601>
  hosted-app validate <declaration.yaml> [--registry <entry.yaml>]
                    Validate a repo hosted-app declaration and its registry entry
  hosted-app render <declaration.yaml> --registry <entry.yaml> --target <t> --out <dir>
                    Render one target's k3s-deploy app directory
  hosted-app land --registry-dir <dir> --k3s-deploy-dir <dir> [--app <name>]
                    Render every accepted registry entry into a k3s-deploy checkout
  hosted-app schema Print the JSON Schema for the declaration
  publish redrive-check <positive-job-id>
                    Re-arm one failed check for the next publisher pass
  enrol <declarations.yml> [--config <path>] [--dry-run]
                    Enrol N applications for build-bump from one declarations
                    file: every declaration is validated first and a single
                    refusal writes nothing, naming which app refused
  enroll --derive [--k3s-deploy-dir <dir>] [--dry-run]
                    Derive the tag-rail enrolment plan from k3s-deploy and
                    print the enroll-app command for each off-rail app;
                    without --dry-run the commands are executed one at a
                    time, stopping at the first failure
  enroll --webhooks [--repo <owner/name>]... [--config <path>] [--dry-run]
                    Ensure each managed Forgejo repo has its own webhook to the
                    watcher with the events its config needs (union with
                    existing; never removes an event)

Options:
  --config <path>   Path to the YAML config (default: config/repos.yml)
  --shadow          (reconcile once) record intended GitHub writes to the shadow
                    ledger instead of posting them
  -h, --help        Show this help
  -v, --version     Show the version`;

/** Parse `--config <path>` and `--shadow` from a `reconcile once` arg list. */
export function parseOnceArgs(args: readonly string[]):
	| {
			ok: true;
			configPath?: string;
			shadow: boolean;
	  }
	| { ok: false; error: string } {
	let configPath: string | undefined;
	let shadow = false;
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === "--shadow") {
			shadow = true;
			continue;
		}
		if (token === "--config") {
			const value = args[i + 1];
			if (value === undefined) {
				return { ok: false, error: "--config requires a path" };
			}
			configPath = value;
			i++;
			continue;
		}
		return { ok: false, error: `unknown option: ${token}` };
	}
	return { ok: true, configPath, shadow };
}

/** True when the args select the one-shot `reconcile once` (or `once`) command. */
export function isReconcileOnce(args: readonly string[]): boolean {
	return (args[0] === "reconcile" && args[1] === "once") || args[0] === "once";
}

/** The sub-args (options) that follow the `reconcile once`/`once` selector. */
export function reconcileOnceRest(args: readonly string[]): readonly string[] {
	if (args[0] === "reconcile") {
		return args.slice(2);
	}
	return args.slice(1);
}

/** Pure dispatcher for the non-service commands. Returns a process exit code. */
export function run(args: readonly string[]): number {
	// Help and version are the CLI's OWN output, not log events: they belong on
	// stdout in their exact requested form, because a caller may parse `--version`
	// and a human reads `--help`. Routing them through the stderr key=value logger
	// would corrupt both. They write directly instead of via `console` so the
	// service keeps a single, greppable convention for everything that IS a log
	// line.
	if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
		process.stdout.write(`${HELP}\n`);
		return 0;
	}

	if (args.includes("--version") || args.includes("-v")) {
		process.stdout.write(`${VERSION}\n`);
		return 0;
	}

	if (args[0] === "watch") {
		// The watch command is handled asynchronously in the entrypoint below.
		return 0;
	}

	if (isReconcileOnce(args)) {
		// The one-shot reconcile command is handled asynchronously below.
		return 0;
	}

	if (args[0] === "prepush") {
		// The prepush command is handled asynchronously in the entrypoint below.
		return 0;
	}

	if (args[0] === "doctor") {
		// The doctor command is handled asynchronously in the entrypoint below.
		return 0;
	}

	if (args[0] === "publish") {
		// The publish command is handled asynchronously in the entrypoint below.
		return 0;
	}

	if (args[0] === "hosted-app") {
		// The hosted-app command is handled asynchronously in the entrypoint below.
		return 0;
	}

	if (args[0] === "enrol" || args[0] === "enroll") {
		// The enrol command is handled asynchronously in the entrypoint below.
		return 0;
	}

	// A rejected invocation IS a log event. `args[0]` is caller-supplied, so it goes
	// through the logger's bounding rather than being interpolated raw.
	log("error", "cli.unknown_argument", { argument: args[0] });
	process.stderr.write("Run with --help for usage.\n");
	return 2;
}

/**
 * Run one cycle via `runOnce` and map it to the `reconcile once` exit code.
 *
 * Exit 0 only on a clean cycle. A repository that failed (`failCount > 0`) or any
 * step that reported through `onError` makes it 1, with one log line naming the
 * counts so the non-zero exit is never silent. A cycle-level throw still
 * propagates; the entrypoint maps it to its own non-zero exit.
 *
 * @param opts - the same options `runOnce` takes; `onError` is still called
 * @returns 0 for a clean cycle, 1 otherwise
 */
export const runOnceExitCode = traced(
	"index.runOnceExitCode",
	async (opts: RunOnceOptions = {}): Promise<number> => {
		const sink = opts.onError ?? defaultOnError;
		let errorCount = 0;
		const onError = (error: unknown): void => {
			errorCount++;
			sink(error);
		};
		const result = await runOnce({ ...opts, onError });
		if (result.failCount === 0 && errorCount === 0) return 0;
		log("error", "reconcile.once.failed", {
			fail_count: result.failCount,
			error_count: errorCount,
			ok_count: result.okCount,
		});
		return 1;
	},
);

/** Run one reconciliation pass then exit; maps failures to a non-zero code. */
async function reconcileOnce(rest: readonly string[]): Promise<number> {
	const parsed = parseOnceArgs(rest);
	if (!parsed.ok) {
		process.stderr.write(`${parsed.error}\n`);
		return 2;
	}
	return runOnceExitCode({ configPath: parsed.configPath, shadow: parsed.shadow });
}

/** Start the service and wire graceful shutdown on termination signals. */
async function watch(): Promise<void> {
	const handle = await startService();
	const shutdown = async (): Promise<void> => {
		await handle.stop();
		process.exit(0);
	};
	process.on("SIGINT", () => void shutdown());
	process.on("SIGTERM", () => void shutdown());
}

if (import.meta.main) {
	// Crash visibility (STANDARDS-observability "Crash visibility"): an unlogged
	// crash leaves nothing to diagnose. These fire only on a real fault — the
	// success path (help/version/normal exit) never reaches them, so
	// `--version` stderr stays empty. Log the class (message may carry a secret)
	// plus the safe message, then exit non-zero.
	process.on("uncaughtException", (err) => {
		log("error", "process.uncaught_exception", {
			error_class: errorClass(err),
			error: errorMessage(err),
		});
		process.exit(1);
	});
	process.on("unhandledRejection", (reason) => {
		log("error", "process.unhandled_rejection", {
			error_class: errorClass(reason),
			error: errorMessage(reason),
		});
		process.exit(1);
	});

	const args = Bun.argv.slice(2);
	if (args[0] === "watch") {
		watch().catch((err) => {
			const msg = err instanceof Error ? err.message : "unknown error";
			process.stderr.write(`failed to start watcher: ${msg}\n`);
			process.exit(1);
		});
	} else if (isReconcileOnce(args)) {
		reconcileOnce(reconcileOnceRest(args))
			.then((code) => {
				process.exitCode = code;
			})
			.catch((err) => {
				const msg = err instanceof Error ? err.message : "unknown error";
				process.stderr.write(`reconcile once failed: ${msg}\n`);
				process.exitCode = 1;
			});
	} else if (args[0] === "prepush") {
		runPrepushCommand(args.slice(1))
			.then((code) => {
				process.exitCode = code;
			})
			.catch(() => {
				process.stderr.write("prepush status failed at a local I/O boundary\n");
				process.exitCode = 1;
			});
	} else if (args[0] === "doctor") {
		runDoctorCommand(args.slice(1))
			.then((code) => {
				process.exitCode = code;
			})
			.catch(() => {
				process.stderr.write("doctor smoke failed at a local I/O boundary\n");
				process.exitCode = 1;
			});
	} else if (args[0] === "publish") {
		runPublishCommand(args.slice(1))
			.then((code) => {
				process.exitCode = code;
			})
			.catch(() => {
				process.stderr.write("publish redrive-check failed at a local I/O boundary\n");
				process.exitCode = 1;
			});
	} else if (args[0] === "hosted-app") {
		runHostedApp(args.slice(1))
			.then((code) => {
				process.exitCode = code;
			})
			.catch(() => {
				process.stderr.write("hosted-app validation failed at a local I/O boundary\n");
				process.exitCode = 3;
			});
	} else if (args[0] === "enrol") {
		runEnrolCommand(args.slice(1))
			.then((code) => {
				process.exitCode = code;
			})
			.catch(() => {
				process.stderr.write("enrolment failed at a local I/O boundary; nothing was written\n");
				process.exitCode = 3;
			});
	} else if (args[0] === "enroll") {
		runEnrollCommand(args.slice(1)).then(
			(code) => {
				process.exitCode = code;
			},
			() => {
				process.exitCode = 3;
			},
		);
	} else {
		process.exitCode = run(args);
	}
}
