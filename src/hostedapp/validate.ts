/**
 * @module hostedapp/validate
 * @description Validate a repo's `hosted-app.yaml` declaration and its registry
 *   entry, and check that the two agree on identity. Parsing and validation
 *   happen at the boundary and return structured results rather than throwing,
 *   so the CLI can map them onto the exit grammar: 0 valid, 1 invalid (every
 *   problem printed as `<yaml.path> -- <message>`), 3 harness error (file
 *   unreadable, not YAML). No network calls unless `--referential` is given:
 *   then the declaration's Vaultwarden items and keys are looked up through
 *   the injected `VaultLookup` seam, and with `--registry` each
 *   accepted build image's tag is resolved through the injected
 *   `RegistryFetch` seam and its digest compared (lane 832b), and with
 *   `--k3s-deploy-dir` each declared host must be unclaimed or claimed by
 *   this app in that checkout (lane 832c).
 *
 * @outputs
 *   - `validateDeclaration` / `validateRegistryEntry` -- text -> result union
 *   - `checkIdentity` -- cross-document agreement, as FAIL lines
 *   - `checkVaultReferences` -- declared Vaultwarden items/keys exist
 *   - `checkImageDigests` -- accepted image tags exist with the accepted digest
 *   - `runHostedAppCommand` -- CLI subcommand returning a process exit code
 *
 * @dependencies
 *   - yaml -- YAML parsing
 *   - ./schema -- the strict Zod schemas
 *   - ./vault -- the Vaultwarden key-name lookup seam
 *   - ./registry -- the image-registry digest seam
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { traced } from "../log";
import { checkHostnameClaims, collectHostClaims, HostClaimsRootMissing } from "./hosts";
import { forgeRegistryFetch, imagePath, type RegistryFetch, resolveImageDigest } from "./registry";
import {
	type Declaration,
	declarationJsonSchema,
	declarationSchema,
	type RegistryEntry,
	registryEntrySchema,
	tagPatternMatches,
} from "./schema";
import { mcp2cliVaultLookup, type VaultLookup } from "./vault";

/** One validation problem, rendered as `<yaml.path> -- <message>`. */
export type Problem = { path: string; message: string };

/** Result of validating one document: valid value, or the problems found. */
export type ValidateResult<T> =
	| { ok: true; value: T }
	| { ok: false; problems: Problem[] }
	| { ok: false; harness: string };

/** Render a Zod issue path as a dotted YAML path, `(root)` when empty. */
function pathOf(parts: readonly PropertyKey[]): string {
	return parts.length === 0 ? "(root)" : parts.map((p) => String(p)).join(".");
}

/** Flatten Zod issues into problems, surfacing unrecognized keys by name. */
function problemsOf(error: z.ZodError): Problem[] {
	return error.issues.map((issue) => {
		if (issue.code === "unrecognized_keys") {
			const keys = issue.keys.join(", ");
			return { path: pathOf([...issue.path, keys]), message: `unknown key: ${keys}` };
		}
		return { path: pathOf(issue.path), message: issue.message };
	});
}

/** Parse YAML, distinguishing a harness error (bad YAML) from invalid content. */
function parseDocument(text: string): { ok: true; data: unknown } | { ok: false; error: string } {
	try {
		return { ok: true, data: parseYaml(text) };
	} catch (err) {
		return { ok: false, error: err instanceof Error ? err.message : "invalid YAML" };
	}
}

/** Deep-merge an override map over a base: maps merge key by key, lists replace. */
export const deepMerge = traced(
	"hostedapp.deepMerge",
	function deepMerge(base: unknown, override: unknown): unknown {
		if (
			typeof base !== "object" ||
			base === null ||
			Array.isArray(base) ||
			typeof override !== "object" ||
			override === null ||
			Array.isArray(override)
		) {
			return override;
		}
		const out: Record<string, unknown> = { ...(base as Record<string, unknown>) };
		for (const [key, value] of Object.entries(override as Record<string, unknown>)) {
			out[key] = key in out ? deepMerge(out[key], value) : value;
		}
		return out;
	},
	// BOTH ENDS, and the reason is DEPTH, not key naming. Both sides are raw
	// declaration documents, whose `runtime.env` is an arbitrary operator-authored
	// env bag -- a key nobody reviewing this file gets to name in advance. It sits
	// at `runtime.env.<KEY>`, which is depth 3 on the argument array, and
	// summarize() masks by key word at every depth but only for words in its fixed
	// SECRET_WORDS list. Probed: summarize() on a declaration carrying
	// `runtime.env` masked `API_TOKEN` but emitted `STRIPE_SK: "sk_live_DEADBEEF"`
	// and `DB_PW: "hunter2"` verbatim. The function also RECURSES on itself, so
	// each nested call re-emits the same subtree at its own `.enter`.
	{ redact: { args: [0, 1], result: true } },
);

/**
 * Validate a declaration document, then re-validate each target's merged form.
 *
 * @param text - the raw YAML text of `hosted-app.yaml`
 * @returns the parsed declaration, or every problem found with its YAML path
 */
export const validateDeclaration = traced(
	"hostedapp.validateDeclaration",
	function validateDeclaration(text: string): ValidateResult<Declaration> {
		const parsed = parseDocument(text);
		if (!parsed.ok) return { ok: false, harness: `not valid YAML: ${parsed.error}` };

		const result = declarationSchema.safeParse(parsed.data);
		if (!result.success) return { ok: false, problems: problemsOf(result.error) };

		// The merged per-target declaration must satisfy the same schema, so an
		// override cannot smuggle in a shape the top level would have rejected.
		const problems: Problem[] = [];
		const raw = parsed.data as Record<string, unknown>;
		for (const target of result.data.targets) {
			if (target.overrides === undefined) continue;
			const merged = deepMerge(
				{ ...raw, targets: [{ name: target.name }] },
				target.overrides,
			) as Record<string, unknown>;
			merged.targets = [{ name: target.name }];
			const check = declarationSchema.safeParse(merged);
			if (!check.success) {
				for (const p of problemsOf(check.error)) {
					problems.push({ path: `targets.${target.name}.merged.${p.path}`, message: p.message });
				}
			}
		}
		return problems.length > 0 ? { ok: false, problems } : { ok: true, value: result.data };
	},
	// BOTH ENDS. Arg 0 is the declaration's raw YAML TEXT -- a single string, so no
	// key exists for summarize() to match, and `runtime.env` lands on the wire as
	// plain YAML lines. The `ok: true` result is that same document parsed, where
	// the env bag is only masked for keys in the fixed SECRET_WORDS list (probed on
	// `deepMerge` above: `STRIPE_SK` and `DB_PW` survived). `.failed` is
	// unaffected, and the problem lists stay visible on the validate path because
	// a refusal carries YAML paths and messages, not values.
	{ redact: { args: [0], result: true } },
);

/**
 * Validate a registry entry document.
 *
 * @param text - the raw YAML text of `apps/<name>.yaml`
 * @returns the parsed entry, or every problem found with its YAML path
 */
export const validateRegistryEntry = traced(
	"hostedapp.validateRegistryEntry",
	function validateRegistryEntry(text: string): ValidateResult<RegistryEntry> {
		const parsed = parseDocument(text);
		if (!parsed.ok) return { ok: false, harness: `not valid YAML: ${parsed.error}` };

		const result = registryEntrySchema.safeParse(parsed.data);
		if (!result.success) return { ok: false, problems: problemsOf(result.error) };
		return { ok: true, value: result.data };
	},
	// ARG ONLY. The registry entry's schema is closed and carries no secret-bearing
	// field -- repo, a 40-hex ref, a sha256, image digests, `by`/`on`, `state`, and
	// free-text `notes`; every object is `.strict()`, so an unreviewed key cannot
	// appear in the parsed RESULT at all. The raw TEXT is still masked because this
	// function is fed by `forgeFetchText` on a path the caller controls, and a
	// misaimed fetch (a declaration, a .env committed beside the entry) arrives
	// here as an arbitrary string before the schema ever rejects it.
	{ redact: { args: [0] } },
);

/**
 * Check that a registry entry and a declaration describe the same application.
 *
 * @param decl - the validated declaration
 * @param entry - the validated registry entry
 * @returns one problem per disagreement; empty when the two agree
 */
export const checkIdentity = traced(
	"hostedapp.checkIdentity",
	function checkIdentity(decl: Declaration, entry: RegistryEntry): Problem[] {
		const problems: Problem[] = [];
		if (entry.name !== decl.name) {
			problems.push({
				path: "name",
				message: `registry name ${entry.name} does not match declaration name ${decl.name}`,
			});
		}
		const owner = entry.repo.split("/")[0];
		if (owner !== decl.owner) {
			problems.push({
				path: "repo",
				message: `registry repo owner ${owner} does not match declaration owner ${decl.owner}`,
			});
		}
		entry.targets.forEach((t, i) => {
			problems.push(...checkTargetIdentity(decl, entry, t.name, i));
		});
		return problems;
	},
	// ARG 0 ONLY. Arg 0 is the parsed declaration, carrying the `runtime.env` bag
	// that survives summarize() (probed on `deepMerge` above). Arg 1 is the closed
	// registry entry, and the RESULT is a problem list built here from names, owners
	// and YAML paths only -- it never copies a declaration VALUE, so masking it
	// would cost the one thing this trace is for.
	{ redact: { args: [0] } },
);

/** Check one registry target against the declaration: declared, imaged, tagged. */
function checkTargetIdentity(
	decl: Declaration,
	entry: RegistryEntry,
	name: string,
	index: number,
): Problem[] {
	if (!decl.targets.some((t) => t.name === name)) {
		return [
			{
				path: `targets.${index}.name`,
				message: `target ${name} is not declared in the declaration`,
			},
		];
	}
	const accepted = Object.hasOwn(entry.accepted.images, name)
		? entry.accepted.images[name]
		: undefined;
	if (accepted === undefined) {
		return [{ path: `accepted.images.${name}`, message: `no accepted image for target ${name}` }];
	}
	if (decl.image.pinned !== undefined) {
		if (accepted.image === decl.image.pinned.ref) return [];
		return [
			{
				path: `accepted.images.${name}.image`,
				message: `accepted image does not match the pinned ref ${decl.image.pinned.ref}`,
			},
		];
	}
	const path = `accepted.images.${name}.tag`;
	if (accepted.tag === undefined) {
		return [{ path, message: "tag is required for an image.build declaration" }];
	}
	const pattern = decl.image.build?.tag_pattern ?? "v*";
	if (!tagPatternMatches(pattern, accepted.tag)) {
		return [{ path, message: `tag ${accepted.tag} does not match tag_pattern ${pattern}` }];
	}
	return [];
}

/**
 * Check that every Vaultwarden item and key the declaration names exists.
 *
 * @param decl - the validated declaration
 * @param lookup - the key-name seam; tests inject a fake
 * @returns the problems found, or the first lookup error as a harness error
 */
export const checkVaultReferences = traced(
	"hostedapp.checkVaultReferences",
	async function checkVaultReferences(
		decl: Declaration,
		lookup: VaultLookup,
	): Promise<{ ok: true; problems: Problem[] } | { ok: false; harness: string }> {
		const problems: Problem[] = [];
		for (const [i, secret] of decl.secrets.entries()) {
			const found = await lookup(secret.vaultwarden_item);
			if (found.status === "error") return { ok: false, harness: found.error };
			if (found.status === "missing") {
				problems.push({
					path: `secrets.${i}.vaultwarden_item`,
					message: `Vaultwarden item ${secret.vaultwarden_item} not found`,
				});
				continue;
			}
			secret.keys.forEach((key, k) => {
				if (found.keys.includes(key)) return;
				problems.push({
					path: `secrets.${i}.keys.${k}`,
					message: `key ${key} not in Vaultwarden item ${secret.vaultwarden_item}`,
				});
			});
		}
		if (decl.database !== undefined) {
			const found = await lookup(decl.database.password_item);
			if (found.status === "error") return { ok: false, harness: found.error };
			if (found.status === "missing") {
				problems.push({
					path: "database.password_item",
					message: `Vaultwarden item ${decl.database.password_item} not found`,
				});
			}
		}
		return { ok: true, problems };
	},
	// ARG 0 ONLY: the parsed declaration carries the `runtime.env` bag that
	// survives summarize() (probed on `deepMerge` above). The result holds item
	// names, key names and YAML paths -- never a value.
	{ redact: { args: [0] } },
);

/**
 * Check that each accepted build image's tag exists and resolves to the
 * digest the registry entry accepted. A pinned declaration is skipped: its
 * ref may name any registry, and checkIdentity already binds it exactly.
 *
 * @param decl - the validated declaration
 * @param entry - the validated registry entry
 * @param fetchHead - the registry HEAD seam; tests inject a fake
 * @returns the problems found, or the first lookup error as a harness error
 */
export const checkImageDigests = traced(
	"hostedapp.checkImageDigests",
	async function checkImageDigests(
		decl: Declaration,
		entry: RegistryEntry,
		fetchHead: RegistryFetch,
	): Promise<{ ok: true; problems: Problem[] } | { ok: false; harness: string }> {
		const problems: Problem[] = [];
		if (decl.image.build === undefined) return { ok: true, problems };
		for (const [name, accepted] of Object.entries(entry.accepted.images)) {
			if (accepted.tag === undefined) continue;
			const path = `accepted.images.${name}`;
			const image = imagePath(accepted.image);
			const found = await resolveImageDigest(fetchHead, image, accepted.tag);
			if (found.status === "error") return { ok: false, harness: found.error };
			if (found.status === "missing") {
				problems.push({
					path: `${path}.tag`,
					message: `tag ${accepted.tag} not found for ${image}`,
				});
				continue;
			}
			const want = accepted.image.slice(accepted.image.indexOf("@") + 1);
			if (found.digest !== want) {
				problems.push({
					path: `${path}.image`,
					message: `registry digest ${found.digest} for ${image}:${accepted.tag} does not match accepted ${want}`,
				});
			}
		}
		return { ok: true, problems };
	},
	// ARG 0 (the declaration's `runtime.env` bag, see `deepMerge`) and ARG 2 (the
	// fetch closes over the Forge token). The entry and result carry image
	// names, tags and digests only.
	{ redact: { args: [0, 2] } },
);

/** Injected seams for `runHostedAppCommand`; tests pass fakes, the CLI passes none. */
type Deps = { vaultLookup?: VaultLookup; registryFetch?: RegistryFetch };

/** Run the referential checks; 0 when all resolve, else the exit code to return. */
async function runReferential(
	decl: Declaration,
	deps: Deps,
	k3sDeployDir?: string,
): Promise<number> {
	const refs = await checkVaultReferences(decl, deps.vaultLookup ?? mcp2cliVaultLookup);
	if (!refs.ok) return reportFailure(refs);
	if (refs.problems.length > 0) return reportProblems(refs.problems);
	if (k3sDeployDir === undefined) {
		process.stderr.write("NOTE -- hostname claims skipped: no --k3s-deploy-dir given\n");
		return 0;
	}
	let claims: Awaited<ReturnType<typeof collectHostClaims>>;
	try {
		claims = await collectHostClaims(k3sDeployDir);
	} catch (err) {
		if (!(err instanceof HostClaimsRootMissing)) throw err;
		process.stderr.write(`${err.message}\n`);
		return 3;
	}
	const hosts = checkHostnameClaims(decl, claims);
	return hosts.length > 0 ? reportProblems(hosts) : 0;
}

/** Run the image-digest check; the live fetch reads FORGE_TOKEN, or FORGEJO_TOKEN. */
async function runImageReferential(
	decl: Declaration,
	entry: RegistryEntry,
	deps: Deps,
): Promise<number> {
	let fetchHead = deps.registryFetch;
	if (fetchHead === undefined) {
		const token = process.env.FORGE_TOKEN || process.env.FORGEJO_TOKEN || "";
		if (token === "") {
			process.stderr.write("FORGE_TOKEN (or FORGEJO_TOKEN) is empty; the registry HEAD needs it\n");
			return 3;
		}
		fetchHead = forgeRegistryFetch(token);
	}
	const images = await checkImageDigests(decl, entry, fetchHead);
	if (!images.ok) return reportFailure(images);
	return images.problems.length > 0 ? reportProblems(images.problems) : 0;
}

/** Print problems then the FAIL summary, and return exit code 1. */
function reportProblems(problems: readonly Problem[]): number {
	for (const p of problems) process.stdout.write(`${p.path} -- ${p.message}\n`);
	process.stdout.write(`RESULT FAIL -- ${problems.length} problem(s)\n`);
	return 1;
}

/** Map a failed result onto the exit grammar: harness error 3, invalid content 1. */
function reportFailure(result: { problems: Problem[] } | { harness: string }): number {
	if ("harness" in result) {
		process.stderr.write(`${result.harness}\n`);
		return 3;
	}
	return reportProblems(result.problems);
}

/** Read a file as text; a missing or unreadable file is a harness error. */
async function readText(
	path: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
	try {
		const file = Bun.file(path);
		if (!(await file.exists())) return { ok: false, error: `file not found: ${path}` };
		return { ok: true, text: await file.text() };
	} catch {
		return { ok: false, error: `file could not be read: ${path}` };
	}
}

const USAGE = `Usage:
  software-factory hosted-app validate <declaration.yaml> [--registry <entry.yaml>] [--referential]
      [--k3s-deploy-dir <dir>]
  software-factory hosted-app validate --registry-only <entry.yaml>
  software-factory hosted-app schema

Exit codes: 0 valid, 1 invalid, 3 harness error.`;

/** Parsed form of the `validate` argument list. */
type ValidateArgs =
	| {
			ok: true;
			declPath?: string;
			registryPath?: string;
			registryOnly: boolean;
			referential: boolean;
			k3sDeployDir?: string;
	  }
	| { ok: false; error: string };

/** Parse the args after the `validate` selector into paths and the mode flag. */
function parseValidateArgs(args: readonly string[]): ValidateArgs {
	let declPath: string | undefined;
	let registryPath: string | undefined;
	let registryOnly = false;
	let referential = false;
	let k3sDeployDir: string | undefined;
	for (let i = 0; i < args.length; i++) {
		const token = args[i];
		if (token === undefined) continue;
		if (token === "--registry" || token === "--registry-only") {
			const value = args[i + 1];
			if (value === undefined) return { ok: false, error: `${token} requires a path` };
			if (registryPath !== undefined) return { ok: false, error: `${token} given twice\n${USAGE}` };
			registryPath = value;
			registryOnly = token === "--registry-only";
			i++;
			continue;
		}
		if (token === "--k3s-deploy-dir") {
			k3sDeployDir = args[i + 1];
			if (k3sDeployDir === undefined) return { ok: false, error: `${token} requires a path` };
			i++;
			continue;
		}
		if (token === "--referential") {
			referential = true;
			continue;
		}
		if (token.startsWith("--") || declPath !== undefined) {
			return { ok: false, error: `unknown option: ${token}\n${USAGE}` };
		}
		declPath = token;
	}
	if (registryOnly && declPath !== undefined) {
		return { ok: false, error: `--registry-only takes no declaration path\n${USAGE}` };
	}
	if (registryOnly && referential) {
		return { ok: false, error: `--referential needs a declaration path\n${USAGE}` };
	}
	return { ok: true, declPath, registryPath, registryOnly, referential, k3sDeployDir };
}

/** Validate a registry entry on its own; the registry repo's CI path. */
async function validateRegistryOnly(registryPath: string): Promise<number> {
	const file = await readText(registryPath);
	if (!file.ok) {
		process.stderr.write(`${file.error}\n`);
		return 3;
	}
	const entry = validateRegistryEntry(file.text);
	if (!entry.ok) return reportFailure(entry);
	process.stdout.write(`RESULT PASS -- ${entry.value.name} registry entry valid\n`);
	return 0;
}

/** Print the declaration JSON Schema; any extra argument is bad usage. */
function runSchema(args: readonly string[]): number {
	if (args.length !== 1) {
		process.stderr.write(`schema takes no arguments\n${USAGE}\n`);
		return 3;
	}
	process.stdout.write(`${JSON.stringify(declarationJsonSchema(), null, 2)}\n`);
	return 0;
}

/**
 * Run the `hosted-app` subcommand.
 *
 * @param args - the argument list after the `hosted-app` selector
 * @param deps - injected seams; `vaultLookup` defaults to the live mcp2cli lookup
 * @returns 0 valid, 1 invalid, 3 harness error (unreadable file, bad usage)
 */
export const runHostedAppCommand = traced(
	"hostedapp.runHostedAppCommand",
	async function runHostedAppCommand(args: readonly string[], deps: Deps = {}): Promise<number> {
		const sub = args[0];
		if (sub === "schema") return runSchema(args);
		if (sub !== "validate") {
			process.stderr.write(`${USAGE}\n`);
			return 3;
		}

		const parsed = parseValidateArgs(args.slice(1));
		if (!parsed.ok) {
			process.stderr.write(`${parsed.error}\n`);
			return 3;
		}
		const { declPath, registryPath, registryOnly, referential, k3sDeployDir } = parsed;

		if (registryOnly) {
			if (registryPath === undefined) return 3;
			return await validateRegistryOnly(registryPath);
		}

		if (declPath === undefined) {
			process.stderr.write(`${USAGE}\n`);
			return 3;
		}
		const declFile = await readText(declPath);
		if (!declFile.ok) {
			process.stderr.write(`${declFile.error}\n`);
			return 3;
		}
		const decl = validateDeclaration(declFile.text);
		if (!decl.ok) return reportFailure(decl);

		const refCode = referential ? await runReferential(decl.value, deps, k3sDeployDir) : 0;
		if (refCode !== 0) return refCode;

		if (registryPath === undefined) {
			process.stdout.write(`RESULT PASS -- ${decl.value.name} declaration valid\n`);
			return 0;
		}

		const entryFile = await readText(registryPath);
		if (!entryFile.ok) {
			process.stderr.write(`${entryFile.error}\n`);
			return 3;
		}
		const entry = validateRegistryEntry(entryFile.text);
		if (!entry.ok) return reportFailure(entry);

		const identity = checkIdentity(decl.value, entry.value);
		if (identity.length > 0) return reportProblems(identity);
		const imageCode = referential ? await runImageReferential(decl.value, entry.value, deps) : 0;
		if (imageCode !== 0) return imageCode;

		process.stdout.write(
			`RESULT PASS -- ${decl.value.name} declaration valid, registry entry valid, identity matches\n`,
		);
		return 0;
	},
);
