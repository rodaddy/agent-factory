/**
 * @module config/enrol-cli
 * @description The `enrol` subcommand: read a declarations file, plan the
 *   batch, and either append every accepted block to the config or write
 *   nothing at all.
 *
 *   The CLI is deliberately thin. All judgment lives in
 *   `./enrol-batch` (`planEnrolBatch`), which is where the tests point; this
 *   module owns only file I/O, the exit code, and the operator-readable
 *   report. Splitting it that way is what lets the all-or-none property be
 *   tested without a filesystem.
 *
 * @outputs
 *   - `runEnrolCommand` -- argv -> process exit code
 *
 * @dependencies
 *   - yaml -- parse the declarations file and the target config
 *   - ./enrol-batch -- the planner and the YAML renderer
 *   - ../log -- the one logger
 */
import { parse as parseYaml } from "yaml";
import { errorMessage, log, traced } from "../log";
import {
	type EnrolDeclaration,
	type EnrolOutcome,
	planEnrolBatch,
	renderEnrolYaml,
} from "./enrol-batch";

/** Default config file, the tracked canonical one the Ansible role renders. */
const DEFAULT_CONFIG = "config/repos.yml";

/** Parsed CLI arguments. */
type EnrolArgs = {
	readonly declarationsPath: string;
	readonly configPath: string;
	readonly dryRun: boolean;
};

/**
 * Parse argv.
 *
 * `--dry-run` is not a courtesy flag: the whole point of this command is that a
 * malformed declaration writes nothing, so an operator needs a way to see the
 * per-app verdict before the write happens at all.
 */
function parseArgs(
	args: readonly string[],
): { ok: true; args: EnrolArgs } | { ok: false; error: string } {
	let declarationsPath: string | undefined;
	let configPath = DEFAULT_CONFIG;
	let dryRun = false;

	for (let i = 0; i < args.length; i += 1) {
		const arg = args[i];
		if (arg === "--dry-run") {
			dryRun = true;
		} else if (arg === "--config") {
			const next = args[i + 1];
			if (next === undefined) return { ok: false, error: "--config requires a path" };
			configPath = next;
			i += 1;
		} else if (arg !== undefined && !arg.startsWith("--")) {
			if (declarationsPath !== undefined) {
				return { ok: false, error: "exactly one declarations file is accepted" };
			}
			declarationsPath = arg;
		} else {
			return { ok: false, error: `unknown option: ${String(arg)}` };
		}
	}

	if (declarationsPath === undefined) {
		return { ok: false, error: "usage: enrol <declarations.yml> [--config <path>] [--dry-run]" };
	}
	return { ok: true, args: { declarationsPath, configPath, dryRun } };
}

/**
 * Coerce one parsed YAML entry into a declaration.
 *
 * A malformed ENTRY is refused here rather than handed to the planner with
 * missing fields, because a declaration that names no repository cannot be
 * named in a refusal, and "names which app refused" is the acceptance clause
 * this command exists to satisfy. An entry with no usable repository name is
 * therefore a whole-file refusal, not a per-app one.
 */
function readDeclarations(
	parsed: unknown,
): { ok: true; declarations: EnrolDeclaration[] } | { ok: false; error: string } {
	if (!Array.isArray(parsed)) {
		return { ok: false, error: "the declarations file must be a YAML list of app declarations" };
	}
	const declarations: EnrolDeclaration[] = [];
	for (let i = 0; i < parsed.length; i += 1) {
		const raw = parsed[i];
		if (typeof raw !== "object" || raw === null) {
			return { ok: false, error: `declaration ${i + 1} is not a mapping` };
		}
		const entry = raw as Record<string, unknown>;
		const repository = entry.repository;
		if (typeof repository !== "string" || repository.length === 0) {
			return {
				ok: false,
				error: `declaration ${i + 1} has no \`repository\`, so a refusal could not name it`,
			};
		}
		const image = entry.image;
		const appDirs = entry.app_dirs;
		declarations.push({
			repository,
			// A missing image or app_dirs is NOT refused here. It is passed through as
			// an empty value so the config schema refuses it and the report names the
			// app plus the exact field -- one validation authority, not two.
			image: typeof image === "string" ? image : "",
			appDirs: Array.isArray(appDirs) ? appDirs.map((d) => String(d)) : [],
			...(typeof entry.environment === "string" ? { environment: entry.environment } : {}),
			...(typeof entry.tag_pattern === "string" ? { tagPattern: entry.tag_pattern } : {}),
		});
	}
	if (declarations.length === 0) {
		return { ok: false, error: "the declarations file contains no declarations" };
	}
	return { ok: true, declarations };
}

/**
 * Append rendered YAML to a config's `repositories:` list.
 *
 * Appends at the END of the file rather than at a computed insertion point. The
 * target file carries an Ansible-managed block, and a YAML list does not care
 * about order, so the simplest correct edit is the one that cannot corrupt the
 * managed markers.
 */
function appendToConfig(configText: string, yaml: string): string {
	const trimmed = configText.endsWith("\n") ? configText : `${configText}\n`;
	return `${trimmed}${yaml}`;
}

/** Both files read, parsed, and shaped -- or a bounded reason they were not. */
type EnrolInputs = {
	readonly declarations: readonly EnrolDeclaration[];
	readonly configText: string;
	readonly configObject: Record<string, unknown>;
};

/**
 * Read and parse both files.
 *
 * Its own function for a reason beyond the line budget: EVERY failure here is
 * exit 2 with nothing written, so keeping the whole "could not even get to a
 * plan" stage in one place makes that property visible rather than scattered
 * across the command body.
 */
async function loadInputs(
	declarationsPath: string,
	configPath: string,
): Promise<{ ok: true; inputs: EnrolInputs } | { ok: false; error: string }> {
	const declFile = Bun.file(declarationsPath);
	if (!(await declFile.exists())) {
		return { ok: false, error: `declarations file not found: ${declarationsPath}` };
	}
	const configFile = Bun.file(configPath);
	if (!(await configFile.exists())) {
		return { ok: false, error: `config file not found: ${configPath}` };
	}

	let declarationsRaw: unknown;
	let configText: string;
	let configRaw: unknown;
	try {
		declarationsRaw = parseYaml(await declFile.text());
		configText = await configFile.text();
		configRaw = parseYaml(configText);
	} catch (err) {
		// The message is the parse fault only. Neither file's contents are echoed:
		// the config carries credentials in its own right.
		log("error", "config.enrol.parse_failed", { cause: errorMessage(err) });
		return { ok: false, error: "a YAML file could not be parsed; nothing was written" };
	}

	const read = readDeclarations(declarationsRaw);
	if (!read.ok) return { ok: false, error: read.error };
	if (typeof configRaw !== "object" || configRaw === null) {
		return { ok: false, error: `config file is not a mapping: ${configPath}` };
	}
	return {
		ok: true,
		inputs: {
			declarations: read.declarations,
			configText,
			configObject: configRaw as Record<string, unknown>,
		},
	};
}

/**
 * Print the per-app verdict.
 *
 * Printed whether or not the write happens, and on stdout rather than through
 * the key=value logger: this is the deliverable an operator reads, and an
 * operator reading only this knows exactly which app refused.
 */
function printReport(outcomes: readonly EnrolOutcome[]): void {
	for (const outcome of outcomes) {
		if (outcome.ok) {
			process.stdout.write(`ok      ${outcome.repository} -> image ${outcome.image}\n`);
		} else {
			process.stdout.write(`REFUSED ${outcome.repository}: ${outcome.reason}\n`);
		}
	}
}

/**
 * Run `enrol`.
 *
 * @param args - argv after the `enrol` selector
 * @returns 0 when every declaration was enrolled, 1 when any refused (and
 *   nothing was written), 2 on a usage error, 3 on a local I/O fault.
 *
 * Exit 1 on ANY refusal is the contract, even when nine of ten apps were fine:
 * the run did not do what it was asked, and a zero exit would let a batch
 * script move on.
 */
export const runEnrolCommand = traced(
	"config.runEnrolCommand",
	async function runEnrolCommand(args: readonly string[]): Promise<number> {
		const parsedArgs = parseArgs(args);
		if (!parsedArgs.ok) {
			process.stderr.write(`${parsedArgs.error}\n`);
			return 2;
		}
		const { declarationsPath, configPath, dryRun } = parsedArgs.args;

		const loaded = await loadInputs(declarationsPath, configPath);
		if (!loaded.ok) {
			process.stderr.write(`${loaded.error}\n`);
			return 2;
		}
		const { declarations, configText, configObject } = loaded.inputs;

		const plan = planEnrolBatch(configObject, declarations);

		printReport(plan.outcomes);

		const refused = plan.outcomes.filter((o) => !o.ok).length;
		if (!plan.applied) {
			log("warn", "config.enrol.refused", {
				declarations: plan.outcomes.length,
				refused,
				config: configPath,
			});
			process.stderr.write(
				`${refused} of ${plan.outcomes.length} declarations refused; nothing was written to ${configPath}\n`,
			);
			return 1;
		}

		if (dryRun) {
			process.stdout.write(`\n${renderEnrolYaml(plan.additions)}`);
			process.stdout.write(
				`dry run: ${plan.additions.length} declarations would be appended to ${configPath}\n`,
			);
			return 0;
		}

		try {
			await Bun.write(configPath, appendToConfig(configText, renderEnrolYaml(plan.additions)));
		} catch (err) {
			log("error", "config.enrol.write_failed", { config: configPath, cause: errorMessage(err) });
			process.stderr.write(`config file could not be written: ${configPath}\n`);
			return 3;
		}

		log("info", "config.enrol.applied", { enrolled: plan.additions.length, config: configPath });
		process.stdout.write(`\nenrolled ${plan.additions.length} applications in ${configPath}\n`);
		return 0;
	},
);
