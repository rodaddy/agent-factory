/**
 * @module hostedapp/land
 * @description `hosted-app land`: walk every entry in a hosted-apps registry
 *   checkout, fetch each app's declaration from its product repo at the
 *   ACCEPTED ref, prove the fetched bytes are the accepted bytes, and render
 *   every accepted target into a k3s-deploy checkout. This is the step between
 *   the registry (what is accepted) and the deploy repo (what Argo applies).
 *
 *   The declaration is fetched, never read from disk, because the accepted ref
 *   is the only authority on what was reviewed — a working copy could have
 *   drifted. The sha256 gate is what makes the fetch trustworthy: bytes that do
 *   not hash to `accepted.declaration_sha256` are refused before any render, so
 *   a compromised or moved ref cannot reach the deploy repo.
 *
 *   One bad app never stops the run. A failing entry, a drifted declaration, or
 *   a 404 is one `FAIL` row and the loop continues, so a registry with ten apps
 *   lands the nine that are good and reports the one that is not.
 *
 * @outputs
 *   - `landRegistry` -- the offline core: registry dir + fetch seam -> summary
 *   - `runHostedAppLand` -- the `hosted-app land` CLI subcommand
 *
 * @dependencies
 *   - ./fetch -- the injected read seam and raw-URL construction
 *   - ./render -- `renderTarget` / `writeRendered`, reused unchanged
 *   - ./validate -- `validateRegistryEntry`, `validateDeclaration`, `checkIdentity`
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { traced } from "../log";
import { type FetchText, type FetchTextResult, rawUrl } from "./fetch";
import { mergeTarget, renderTarget, writeRendered } from "./render";
import type { Declaration, RegistryEntry } from "./schema";
import {
	checkIdentity,
	type Problem,
	validateDeclaration,
	validateRegistryEntry,
} from "./validate";

/** How one target was landed: a directory that did not exist, or one that did. */
export type TargetKind = "new" | "update";

/** One landed target, as it appears in the machine summary. */
export interface LandedTarget {
	name: string;
	kind: TargetKind;
	dir: string;
}

/** One app's outcome: rendered, refused, or skipped as retired. */
export interface LandedApp {
	name: string;
	repo: string;
	ref: string;
	targets: LandedTarget[];
	verdict: "pass" | "fail" | "skip";
	problems: string[];
}

/** The whole run: every app's outcome plus the counts the CLI prints. */
export interface LandSummary {
	apps: LandedApp[];
	rendered: number;
	failed: number;
	skipped: number;
}

/** A harness error aborts the whole run (exit 3) rather than failing one app. */
export class LandHarnessError extends Error {}

/** The name of the machine summary written into the k3s-deploy checkout. */
export const SUMMARY_FILE = ".hosted-app-land.json";

/** Options for `landRegistry`; grouped so the call stays under the param cap. */
export interface LandOptions {
	registryDir: string;
	deployDir: string;
	forgeApi: string;
	token: string;
	fetchText: FetchText;
	app?: string;
}

/** Render a validation problem as the CLI's `<path> -- <message>` line. */
function line(problem: Problem): string {
	return `${problem.path} -- ${problem.message}`;
}

/** Lowercase hex sha256 of `text`, the hash the registry entry pins. */
export const sha256 = traced(
	"hostedapp.sha256",
	function sha256(text: string): string {
		const hasher = new Bun.CryptoHasher("sha256");
		hasher.update(text);
		return hasher.digest("hex");
	},
	// ARG 0 ONLY. The call site hashes FETCHED DECLARATION TEXT (the drift gate in
	// `acceptedDeclaration`), so arg 0 is the whole document including its
	// `runtime.env` lines, as one string with no key to match. The result is a
	// 64-hex digest -- the one thing here that is safe by construction, and the
	// value the trace exists to show.
	{ redact: { args: [0] } },
);

/** List `apps/*.yaml` in the registry checkout, sorted; unreadable is harness. */
async function registryFiles(registryDir: string, app?: string): Promise<string[]> {
	const dir = join(registryDir, "apps");
	let names: string[];
	try {
		names = await readdir(dir);
	} catch {
		throw new LandHarnessError(`registry apps directory could not be read: ${dir}`);
	}
	const yaml = names.filter((n) => n.endsWith(".yaml")).sort();
	const wanted = app === undefined ? yaml : yaml.filter((n) => n === `${app}.yaml`);
	if (app !== undefined && wanted.length === 0) {
		throw new LandHarnessError(`--app ${app}: no apps/${app}.yaml in the registry`);
	}
	return wanted.map((n) => join(dir, n));
}

/** True when `path` is an existing directory; anything else is `false`. */
async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch {
		return false;
	}
}

/** A fetch that failed at the transport (status 0) is a harness error. */
function requireHttp(result: FetchTextResult, url: string): FetchTextResult {
	if (!result.ok && result.status === 0) {
		throw new LandHarnessError(`fetch transport failure for ${url}: ${result.error}`);
	}
	return result;
}

/** Fetch one repo path at the entry's accepted ref through the injected seam. */
async function fetchAt(
	entry: RegistryEntry,
	path: string,
	opts: LandOptions,
): Promise<FetchTextResult> {
	const url = rawUrl(opts.forgeApi, entry.repo, path, entry.accepted.ref);
	return requireHttp(await opts.fetchText(url, opts.token), url);
}

/** Fetch every config file the merged declaration mounts, keyed by its name. */
async function fetchConfigs(
	decl: Declaration,
	entry: RegistryEntry,
	opts: LandOptions,
): Promise<{ ok: true; configs: Map<string, string> } | { ok: false; problems: string[] }> {
	const base = dirname(entry.declaration);
	const configs = new Map<string, string>();
	const problems: string[] = [];
	for (const file of decl.config_files) {
		const path = base === "." ? file.path : `${base}/${file.path}`;
		const result = await fetchAt(entry, path, opts);
		if (result.ok) configs.set(file.name, result.text);
		else problems.push(`config_files.${file.name} -- not found at ${entry.accepted.ref}: ${path}`);
	}
	return problems.length > 0 ? { ok: false, problems } : { ok: true, configs };
}

/** A failed app row, ready to append to the summary. */
function failed(entry: RegistryEntry, problems: string[]): LandedApp {
	return {
		name: entry.name,
		repo: entry.repo,
		ref: entry.accepted.ref,
		targets: [],
		verdict: "fail",
		problems,
	};
}

/**
 * Render every registry target, then write ALL of them into the deploy checkout.
 * Files are staged until the last target has rendered, so an app that fails on
 * its second target leaves nothing from its first on disk: a FAIL row means no
 * partial render exists for that app. A write that fails is a harness error.
 */
async function landTargets(
	decl: Declaration,
	entry: RegistryEntry,
	opts: LandOptions,
): Promise<{ ok: true; targets: LandedTarget[] } | { ok: false; problems: string[] }> {
	const targets: LandedTarget[] = [];
	const staged: ReadonlyMap<string, string>[] = [];
	for (const target of entry.targets) {
		const merged = decl.targets.some((t) => t.name === target.name)
			? mergeTarget(decl, target.name)
			: decl;
		const configs = await fetchConfigs(merged, entry, opts);
		if (!configs.ok) return configs;
		const rendered = renderTarget(decl, entry, target.name, configs.configs);
		if (!rendered.ok) return { ok: false, problems: rendered.problems.map(line) };
		const dir = `manifests/apps/${decl.name}-${target.name}`;
		const kind: TargetKind = (await isDirectory(join(opts.deployDir, dir))) ? "update" : "new";
		staged.push(rendered.files);
		targets.push({ name: target.name, kind, dir });
	}
	for (const files of staged) {
		try {
			await writeRendered(files, opts.deployDir);
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new LandHarnessError(`deploy checkout not writable: ${opts.deployDir}: ${reason}`);
		}
	}
	return { ok: true, targets };
}

/** Fetch and prove the declaration for one entry, or return its FAIL problems. */
async function acceptedDeclaration(
	entry: RegistryEntry,
	opts: LandOptions,
): Promise<{ ok: true; decl: Declaration } | { ok: false; problems: string[] }> {
	const fetched = await fetchAt(entry, entry.declaration, opts);
	if (!fetched.ok) {
		return { ok: false, problems: [`declaration not found at ${entry.accepted.ref}`] };
	}
	const digest = sha256(fetched.text);
	if (digest !== entry.accepted.declaration_sha256) {
		const accepted = entry.accepted.declaration_sha256.slice(0, 8);
		return {
			ok: false,
			problems: [`declaration drift: accepted ${accepted} fetched ${digest.slice(0, 8)}`],
		};
	}
	const decl = validateDeclaration(fetched.text);
	if (!decl.ok) {
		return { ok: false, problems: "harness" in decl ? [decl.harness] : decl.problems.map(line) };
	}
	const identity = checkIdentity(decl.value, entry);
	if (identity.length > 0) return { ok: false, problems: identity.map(line) };
	return { ok: true, decl: decl.value };
}

/** Land one registry entry: validate, skip, fetch, prove, render. */
async function landEntry(text: string, file: string, opts: LandOptions): Promise<LandedApp> {
	const entry = validateRegistryEntry(text);
	if (!entry.ok) {
		const problems = "harness" in entry ? [entry.harness] : entry.problems.map(line);
		return { name: file, repo: "", ref: "", targets: [], verdict: "fail", problems };
	}
	const value = entry.value;
	if (value.state === "retired") {
		return {
			name: value.name,
			repo: value.repo,
			ref: value.accepted.ref,
			targets: [],
			verdict: "skip",
			problems: [],
		};
	}
	const decl = await acceptedDeclaration(value, opts);
	if (!decl.ok) return failed(value, decl.problems);
	const landed = await landTargets(decl.decl, value, opts);
	if (!landed.ok) return failed(value, landed.problems);
	return {
		name: value.name,
		repo: value.repo,
		ref: value.accepted.ref,
		targets: landed.targets,
		verdict: "pass",
		problems: [],
	};
}

/** Read one registry file; unreadable at this point is a harness error. */
async function readEntry(path: string): Promise<string> {
	const file = Bun.file(path);
	if (!(await file.exists())) throw new LandHarnessError(`registry entry unreadable: ${path}`);
	return await file.text();
}

/**
 * Land every registry entry into the deploy checkout.
 *
 * @param opts - registry and deploy directories, Forge base, token, fetch seam
 * @returns one row per app plus the run counts
 * @throws LandHarnessError when a directory or a transport fails the whole run
 */
export const landRegistry = traced(
	"hostedapp.landRegistry",
	async function landRegistry(opts: LandOptions): Promise<LandSummary> {
		const files = await registryFiles(opts.registryDir, opts.app);
		if (files.length > 0 && opts.token.length === 0) {
			throw new LandHarnessError("FORGE_TOKEN is not set and a declaration fetch is needed");
		}
		const apps: LandedApp[] = [];
		for (const path of files) {
			apps.push(await landEntry(await readEntry(path), path, opts));
		}
		return {
			apps,
			rendered: apps.filter((a) => a.verdict === "pass").length,
			failed: apps.filter((a) => a.verdict === "fail").length,
			skipped: apps.filter((a) => a.verdict === "skip").length,
		};
	},
	// NO REDACTION, and this one was checked rather than assumed. The Forge token
	// arrives as `opts.token` -- a named KEY on a plain object, which is exactly the
	// shape summarize() masks. Probed: summarize([{registryDir, token:"m2c_SECRET",
	// fetchText}]) returned `"token":"[REDACTED]"`. The result is the summary: app
	// names, repos, refs, verdicts and problem strings, no declaration content.
);
