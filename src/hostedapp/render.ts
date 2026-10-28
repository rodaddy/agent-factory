/**
 * @module hostedapp/render
 * @description Render one target of a hosted-app declaration into the
 *   k3s-deploy app directory it deploys as: an Argo Application flat in
 *   `apps/`, and the manifest set under `manifests/apps/<name>-<target>/`.
 *   Rendering is pure and offline — declaration plus accepted registry entry
 *   in, a filename -> content map out — so the same inputs always render the
 *   same bytes and the result can be diffed before it is committed anywhere.
 *
 * @outputs
 *   - `renderTarget` -- (declaration, entry, target) -> Map<path, content>
 *   - `writeRendered` -- write that map beneath an output directory
 *   - `runHostedAppRender` -- the `hosted-app render` CLI subcommand
 *
 * @dependencies
 *   - ./schema, ./validate -- validated documents and the override merge
 *   - ./emit -- the per-file builders
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { traced } from "../log";
import type { RenderContext } from "./emit";
import * as emit from "./emit";
import { type Declaration, declarationSchema, type RegistryEntry } from "./schema";
import { checkIdentity, deepMerge, validateDeclaration, validateRegistryEntry } from "./validate";

/** Why a render could not be produced, as the CLI's `<path> -- <message>`. */
export type RenderProblem = { path: string; message: string };

/** A render either produced files, or found problems with its inputs. */
export type RenderResult =
	| { ok: true; files: Map<string, string> }
	| { ok: false; problems: RenderProblem[] };

/**
 * Apply a target's overrides to the declaration and re-validate the result.
 *
 * The merged form goes back through the schema rather than being trusted:
 * `validate` proves the same thing at the document boundary, and a renderer
 * that skipped it would emit manifests from a shape the validator rejects.
 */
export const mergeTarget = traced(
	"hostedapp.mergeTarget",
	function mergeTarget(decl: Declaration, target: string): Declaration {
		const entry = decl.targets.find((t) => t.name === target);
		if (entry?.overrides === undefined) return decl;
		const merged = deepMerge(decl, entry.overrides) as Record<string, unknown>;
		merged.targets = [{ name: target }];
		const result = declarationSchema.safeParse(merged);
		if (!result.success) {
			throw new Error(`merged declaration for target ${target} is invalid`);
		}
		return result.data;
	},
	// BOTH ENDS. Arg 0 is a declaration and the result is the MERGED declaration --
	// the same `runtime.env` bag that survived summarize() in the `deepMerge` probe,
	// on both sides of this call. Arg 1 is a bare target name and carries nothing,
	// but `redact.args` names indexes, so masking 0 is the whole of it.
	{ redact: { args: [0], result: true } },
);

/** Build the identity every emitted file shares. */
function contextFor(decl: Declaration, entry: RegistryEntry, target: string): RenderContext {
	const image = entry.accepted.images[target];
	if (image === undefined) throw new Error(`no accepted image for target ${target}`);
	// `-tls` and `-db` are the longest suffixes hung off the slug itself.
	return {
		name: decl.name,
		target,
		slug: emit.resourceName([decl.name, target], "name", 63 - "-tls".length),
		image: image.image,
		repo: entry.repo,
		ref: entry.accepted.ref,
		hash: entry.accepted.declaration_sha256,
		paused: entry.state !== "active",
	};
}

/** Reject a target the registry entry has not accepted, before any rendering. */
function targetProblems(decl: Declaration, entry: RegistryEntry, target: string): RenderProblem[] {
	const problems: RenderProblem[] = [];
	if (!decl.targets.some((t) => t.name === target)) {
		problems.push({ path: "targets", message: `target ${target} is not declared` });
	}
	if (!entry.targets.some((t) => t.name === target)) {
		problems.push({ path: "targets", message: `target ${target} is not in the registry entry` });
	}
	if (entry.accepted.images[target] === undefined) {
		problems.push({
			path: `accepted.images.${target}`,
			message: `no accepted image for target ${target}`,
		});
	}
	return problems;
}

/** Assemble the manifest files, in the order the kustomization lists them. */
function manifests(
	decl: Declaration,
	ctx: RenderContext,
	configs: ReadonlyMap<string, string>,
): Map<string, string> {
	const files = new Map<string, string>();
	files.set("namespace.yaml", emit.namespace(ctx));
	files.set("deployment.yaml", emit.deployment(decl, ctx));
	files.set("service.yaml", emit.service(decl, ctx));
	if (decl.storage.length > 0) files.set("pvc.yaml", emit.pvc(decl, ctx));
	if (decl.config_files.length > 0) files.set("configmap.yaml", emit.configmap(decl, ctx, configs));
	if (decl.cron.length > 0) files.set("cronjob.yaml", emit.cronjob(decl, ctx));
	if (decl.hostnames.length > 0) files.set("route.yaml", emit.route(decl, ctx));
	return files;
}

/**
 * Render one target into its k3s-deploy files.
 *
 * @param decl - the validated declaration, un-merged
 * @param entry - the validated registry entry carrying the accepted image
 * @param target - the target name to render
 * @param configs - config-file content by declared `name`; required when the
 *   declaration mounts config files, since content lives in the product repo
 * @returns the file map keyed by path relative to the output directory
 */
export const renderTarget = traced(
	"hostedapp.renderTarget",
	function renderTarget(
		decl: Declaration,
		entry: RegistryEntry,
		target: string,
		configs: ReadonlyMap<string, string> = new Map(),
	): RenderResult {
		const problems = targetProblems(decl, entry, target);
		if (problems.length > 0) return { ok: false, problems };

		const merged = mergeTarget(decl, target);
		// A generated name that no Kubernetes object could carry is an input
		// problem, reported like any other, not a crash out of the renderer.
		try {
			const ctx = contextFor(merged, entry, target);
			const missing = merged.config_files.filter((f) => !configs.has(f.name));
			if (missing.length > 0) {
				return {
					ok: false,
					problems: missing.map((f) => ({
						path: `config_files.${f.name}`,
						message: `config_files needs --source-dir: ${f.path} was not read`,
					})),
				};
			}

			const set = manifests(merged, ctx, configs);
			const files = new Map<string, string>();
			files.set(`apps/${ctx.slug}.yaml`, emit.application(ctx));
			const dir = `manifests/apps/${ctx.slug}`;
			for (const [name, content] of set) files.set(`${dir}/${name}`, content);
			files.set(`${dir}/kustomization.yaml`, emit.kustomization(ctx, [...set.keys()]));
			files.set(`${dir}/MANIFEST-NOTES.md`, emit.manifestNotes(merged, ctx));
			return { ok: true, files };
		} catch (error) {
			if (error instanceof emit.RenderError) {
				return { ok: false, problems: [{ path: error.path, message: error.message }] };
			}
			throw error;
		}
	},
	// BOTH ENDS. Arg 0 is the declaration (the env bag again) and arg 3 is the
	// CONFIG FILE CONTENT read out of the product repo -- a values file or an
	// app config, which is a normal place for a key. The result is the rendered
	// manifest set: `deployment.yaml` interpolates `runtime.env` and
	// `configmap.yaml` embeds those config bytes, so the output is strictly more
	// sensitive than the input. Arg 1 (registry entry) and arg 2 (target name) are
	// the only safe ones, and leaving them visible keeps the trace useful.
	{ redact: { args: [0, 3], result: true } },
);

/**
 * Write a rendered file map beneath `outDir`, creating parent directories.
 *
 * @param files - the map from `renderTarget`
 * @param outDir - the directory the paths are relative to
 * @returns the number of files written
 */
export const writeRendered = traced(
	"hostedapp.writeRendered",
	async function writeRendered(
		files: ReadonlyMap<string, string>,
		outDir: string,
	): Promise<number> {
		for (const [path, content] of files) {
			const full = join(outDir, path);
			await mkdir(dirname(full), { recursive: true });
			await Bun.write(full, content);
		}
		return files.size;
	},
	// ARG 0 ONLY. Arg 0 is the rendered manifest map from `renderTarget` -- the
	// same env-bearing `deployment.yaml` and configmap bytes, and a Map recurses
	// through summarize() by value, so the content would land on the wire. The
	// result is just `files.size`, a number, so the `.exit` line stays useful.
	{ redact: { args: [0] } },
);

/**
 * Parsed form of the `render` argument list.
 *
 * Exported because `parseRenderArgs` is now a traced `const`: an inferred const
 * type cannot name a module-private type, so leaving this unexported fails
 * `tsc` at the export rather than at the call site. No call site gains anything.
 */
export type RenderArgs =
	| { ok: true; declPath: string; registry: string; target: string; out: string; source?: string }
	| { ok: false; error: string };

const RENDER_USAGE = `Usage:
  software-factory hosted-app render <declaration.yaml> --registry <entry.yaml> \\
      --target <target> --out <dir> [--source-dir <path>]

--source-dir defaults to the directory holding the declaration; it is where
config_files paths are resolved from. Exit codes: 0 rendered, 1 invalid input
or unaccepted target, 3 harness error.`;

/** Parse the args after the `render` selector; every option takes a value. */
export const parseRenderArgs = traced(
	"hostedapp.parseRenderArgs",
	function parseRenderArgs(args: readonly string[]): RenderArgs {
		const opts: Record<string, string> = {};
		let declPath: string | undefined;
		for (let i = 0; i < args.length; i++) {
			const token = args[i];
			if (token === undefined) continue;
			if (token.startsWith("--")) {
				const value = args[i + 1];
				if (value === undefined) return { ok: false, error: `${token} requires a value` };
				opts[token.slice(2)] = value;
				i++;
				continue;
			}
			if (declPath !== undefined) return { ok: false, error: `unexpected argument: ${token}` };
			declPath = token;
		}
		const { registry, target, out } = opts;
		if (
			declPath === undefined ||
			registry === undefined ||
			target === undefined ||
			out === undefined
		) {
			return { ok: false, error: RENDER_USAGE };
		}
		const source = opts["source-dir"];
		return source === undefined
			? { ok: true, declPath, registry, target, out }
			: { ok: true, declPath, registry, target, out, source };
	},
);

/** Read every declared config file from `sourceDir`; missing ones are absent. */
async function readConfigs(decl: Declaration, sourceDir: string): Promise<Map<string, string>> {
	const configs = new Map<string, string>();
	for (const file of decl.config_files) {
		const handle = Bun.file(join(sourceDir, file.path));
		if (await handle.exists()) configs.set(file.name, await handle.text());
	}
	return configs;
}

/** Print problems then the FAIL summary, and return exit code 1. */
function fail(problems: readonly RenderProblem[]): number {
	for (const p of problems) process.stdout.write(`${p.path} -- ${p.message}\n`);
	process.stdout.write(`RESULT FAIL -- ${problems.length} problem(s)\n`);
	return 1;
}

/**
 * Map a failed validate result onto the exit grammar, matching `validate.ts`:
 * a harness error (unparseable YAML) is 3 on stderr, invalid content is 1.
 */
function failValidate(result: { problems: RenderProblem[] } | { harness: string }): number {
	if ("harness" in result) {
		process.stderr.write(`${result.harness}\n`);
		return 3;
	}
	return fail(result.problems);
}

/** Read a file as text; a missing or unreadable file is a harness error. */
async function readText(path: string): Promise<string | undefined> {
	const file = Bun.file(path);
	return (await file.exists()) ? await file.text() : undefined;
}

/**
 * Run `hosted-app render`.
 *
 * @param args - the argument list after the `render` selector
 * @returns 0 rendered, 1 invalid input or unaccepted target, 3 harness error
 */
export const runHostedAppRender = traced(
	"hostedapp.runHostedAppRender",
	async function runHostedAppRender(args: readonly string[]): Promise<number> {
		const parsed = parseRenderArgs(args);
		if (!parsed.ok) {
			process.stderr.write(`${parsed.error}\n`);
			return 3;
		}
		const declText = await readText(parsed.declPath);
		const entryText = await readText(parsed.registry);
		if (declText === undefined || entryText === undefined) {
			process.stderr.write(
				`file not found: ${declText === undefined ? parsed.declPath : parsed.registry}\n`,
			);
			return 3;
		}
		const decl = validateDeclaration(declText);
		if (!decl.ok) return failValidate(decl);
		const entry = validateRegistryEntry(entryText);
		if (!entry.ok) return failValidate(entry);
		const identity = checkIdentity(decl.value, entry.value);
		if (identity.length > 0) return fail(identity);

		// Read config files from the MERGED declaration: a target override may add
		// a config_files entry or change a path, and reading the base declaration
		// reports the added file missing while serving the base file's content.
		const sourceDir = parsed.source ?? dirname(parsed.declPath);
		const forTarget = decl.value.targets.some((t) => t.name === parsed.target)
			? mergeTarget(decl.value, parsed.target)
			: decl.value;
		const configs = await readConfigs(forTarget, sourceDir);
		const rendered = renderTarget(decl.value, entry.value, parsed.target, configs);
		if (!rendered.ok) return fail(rendered.problems);

		const count = await writeRendered(rendered.files, parsed.out);
		process.stdout.write(
			`RESULT PASS -- rendered ${decl.value.name}-${parsed.target} (${count} files)\n`,
		);
		return 0;
	},
);
