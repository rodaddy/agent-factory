/**
 * @module config/load
 * @description Load and validate the watcher configuration from an explicit
 *   YAML path. Parsing and validation happen at the boundary and return a
 *   structured result rather than throwing, so callers handle a bad config
 *   deliberately. Errors are bounded and never echo secrets or full file
 *   contents. `config/repos.yml` is the TRACKED canonical watcher config,
 *   rendered onto the watcher host by a deploy role and changed by PR (see
 *   `_DOCS/REPO_ENROLMENT_SOP.md`); `config/repos.example.yml` documents the
 *   schema; `--config <path>` selects a private file for a local run.
 *
 * @outputs
 *   - `loadConfig` -- read + parse + validate a config file into a result union
 *   - `LoadConfigResult` -- discriminated success/failure result
 *
 * @dependencies
 *   - yaml -- YAML parsing
 *   - ./schema -- the strict Zod config schema
 */
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { errorMessage, log } from "../log";
import { configSchema, type WatcherConfig } from "./schema";

/** Discriminated result of a config load: never throws for expected failures. */
export type LoadConfigResult = { ok: true; config: WatcherConfig } | { ok: false; error: string };

/** Compact, path-qualified rendering of Zod issues for operator diagnostics. */
function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((i) => {
			const path = i.path.length > 0 ? i.path.join(".") : "(root)";
			return `${path}: ${i.message}`;
		})
		.join("; ");
}

/**
 * Load, parse, and validate the config at `path`.
 *
 * @param path - explicit filesystem path to the YAML config
 * @returns a success result with the typed config, or a failure result with a
 *   bounded error message. Missing file, malformed YAML, and schema violations
 *   are all reported as `ok: false`, never thrown.
 */
export async function loadConfig(path: string): Promise<LoadConfigResult> {
	const file = Bun.file(path);
	if (!(await file.exists())) {
		return { ok: false, error: `config file not found: ${path}` };
	}

	let raw: string;
	try {
		raw = await file.text();
	} catch (err) {
		// The returned message stays fixed and path-only; the read fault (permissions,
		// a directory, an I/O error) is only visible here.
		log("error", "config.load.read_failed", { path, cause: errorMessage(err) });
		return { ok: false, error: `config file could not be read: ${path}` };
	}

	let parsed: unknown;
	try {
		parsed = parseYaml(raw);
	} catch (err) {
		const reason = err instanceof Error ? err.message : "invalid YAML";
		return { ok: false, error: `config is not valid YAML: ${reason}` };
	}

	const result = configSchema.safeParse(parsed);
	if (!result.success) {
		return { ok: false, error: `invalid config: ${formatIssues(result.error)}` };
	}

	return { ok: true, config: result.data };
}
