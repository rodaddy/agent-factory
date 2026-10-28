/**
 * @module hostedapp/hosts
 * @description The hostname-claim half of `hosted-app validate --referential`
 *   (lane 832c). A hostname is CLAIMED by an app when the k3s-deploy
 *   checkout already routes or certifies it: an IngressRoute `Host(\`...\`)`
 *   match or a Certificate `dnsNames` entry under `manifests/apps/<slug>/`,
 *   the same shapes `emit.ts` renders. The registry entries carry no hosts of
 *   their own (the registry schema is closed and names none); their hosts
 *   reach k3s-deploy only as those rendered manifests, so the checkout is the
 *   one claim source and the owning app is the `<name>-<target>` directory.
 *
 *   #895: the walk covers all of `manifests/**`; a file at any depth under
 *   `manifests/apps/<slug>/` belongs to `<slug>`, one elsewhere to its top-level
 *   dir, named `<dir> (non-app)`.
 *
 *   A declaration host passes when it is unclaimed or claimed only by one of
 *   this app's own `<name>-<target>` directories; claimed by any other app it
 *   is a problem naming both. Reading is local files only, no cluster calls.
 *
 * @outputs
 *   - `collectHostClaims` -- k3s-deploy checkout -> host -> owning app dirs
 *   - `checkHostnameClaims` -- declaration + claims -> problems
 *   - `HostClaimsRootMissing` -- the checkout has no `manifests/apps` (exit 3)
 *
 * @dependencies
 *   - yaml -- parse the rendered multi-document manifests
 *   - ../log -- the one logger, for the traced() wrapper
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { parseAllDocuments } from "yaml";
import { traced } from "../log";
import type { Declaration } from "./schema";
import type { Problem } from "./validate";

/** host -> every owner (app slug, or `<dir> (non-app)`) that routes or certifies it. */
export type HostClaims = Map<string, string[]>;

/** Pull every `Host(\`x\`)` argument out of a Traefik match expression. */
function hostsInMatch(match: unknown): string[] {
	if (typeof match !== "string") return [];
	return [...match.matchAll(/Host\(`([^`]+)`\)/g)].map((m) => m[1] ?? "");
}

/** The hosts one parsed manifest document claims; other kinds claim none. */
function hostsInDoc(doc: unknown): string[] {
	if (typeof doc !== "object" || doc === null) return [];
	const { kind, spec } = doc as { kind?: unknown; spec?: Record<string, unknown> };
	if (spec === undefined || spec === null) return [];
	if (kind === "Certificate" && Array.isArray(spec.dnsNames)) {
		return spec.dnsNames.filter((h): h is string => typeof h === "string");
	}
	if (kind === "IngressRoute" && Array.isArray(spec.routes)) {
		return spec.routes.flatMap((r) => hostsInMatch((r as { match?: unknown }).match));
	}
	return [];
}

/** True for a Node fs error with this `code`. */
function isFsError(err: unknown, code: string): boolean {
	return err instanceof Error && (err as NodeJS.ErrnoException).code === code;
}

/** The k3s-deploy checkout has no `manifests/apps`: a harness error, never "no claims". */
export class HostClaimsRootMissing extends Error {
	override name = "HostClaimsRootMissing";
}

/** Every `.yaml`/`.yml` file under `dir` at any depth, relative to `dir`, sorted. */
async function yamlFilesDeep(dir: string): Promise<string[]> {
	const all = await readdir(dir, { recursive: true, withFileTypes: true });
	return all
		.filter((e) => e.isFile() && (e.name.endsWith(".yaml") || e.name.endsWith(".yml")))
		.map((e) => relative(dir, join(e.parentPath, e.name)))
		.sort();
}

/** Owner of a manifest path relative to `manifests/`: an app slug, or a non-app top dir. */
function ownerOf(relPath: string): string | undefined {
	const parts = relPath.split(sep);
	if (parts.length < 2) return undefined;
	if (parts[0] === "apps") return parts.length >= 3 ? parts[1] : undefined;
	return `${parts[0]} (non-app)`;
}

/** Record `owner` as a claimant of `host`, once. */
function addClaim(claims: HostClaims, host: string, owner: string): void {
	const owners = claims.get(host) ?? [];
	if (!owners.includes(owner)) owners.push(owner);
	claims.set(host, owners);
}

/**
 * Read every hostname the k3s-deploy checkout already claims.
 *
 * @param k3sDeployDir - the k3s-deploy checkout root
 * @returns host -> the `manifests/apps/<slug>` directories that claim it
 */
export const collectHostClaims = traced(
	"hostedapp.collectHostClaims",
	async function collectHostClaims(k3sDeployDir: string): Promise<HostClaims> {
		const claims: HostClaims = new Map();
		const manifestsDir = join(k3sDeployDir, "manifests");
		const appsDir = join(manifestsDir, "apps");
		// A missing root would pass every host silently; any other fs error propagates.
		const appsStat = await stat(appsDir).catch((err: unknown) => {
			if (isFsError(err, "ENOENT")) {
				throw new HostClaimsRootMissing(`k3s-deploy ${appsDir} not found`);
			}
			throw err;
		});
		if (!appsStat.isDirectory()) {
			throw Object.assign(new Error(`${appsDir} is not a directory`), { code: "ENOTDIR" });
		}
		for (const rel of await yamlFilesDeep(manifestsDir)) {
			const owner = ownerOf(rel);
			if (owner === undefined) continue;
			const text = await readFile(join(manifestsDir, rel), "utf8");
			for (const doc of parseAllDocuments(text)) {
				for (const host of hostsInDoc(doc.toJS())) addClaim(claims, host, owner);
			}
		}
		return claims;
	},
);

/** Every host the declaration names, top level and per-target override, with its path. */
function declaredHosts(decl: Declaration): { path: string; host: string }[] {
	const out = decl.hostnames.map((h, i) => ({ path: `hostnames.${i}.host`, host: h.host }));
	for (const target of decl.targets) {
		const list = target.overrides?.hostnames;
		if (!Array.isArray(list)) continue;
		list.forEach((h, i) => {
			const host = (h as { host?: unknown } | null)?.host;
			if (typeof host !== "string") return;
			out.push({ path: `targets.${target.name}.overrides.hostnames.${i}.host`, host });
		});
	}
	return out;
}

/**
 * Check that no declared host is already claimed by a different app.
 *
 * @param decl - the validated declaration
 * @param claims - the k3s-deploy claims from `collectHostClaims`
 * @returns one problem per host another app claims; empty when all are free or own
 */
export const checkHostnameClaims = traced(
	"hostedapp.checkHostnameClaims",
	function checkHostnameClaims(decl: Declaration, claims: HostClaims): Problem[] {
		const own = new Set(decl.targets.map((t) => `${decl.name}-${t.name}`));
		const problems: Problem[] = [];
		for (const { path, host } of declaredHosts(decl)) {
			const others = (claims.get(host) ?? []).filter((slug) => !own.has(slug));
			if (others.length === 0) continue;
			problems.push({
				path,
				message: `host ${host} is already claimed by ${others.join(", ")}, not ${decl.name}`,
			});
		}
		return problems;
	},
	// ARG 0 ONLY: the parsed declaration carries the `runtime.env` bag that
	// survives summarize() (see `deepMerge` in ./validate). The claims map and
	// the result are hostnames and app directory names -- DNS, not secrets.
	{ redact: { args: [0] } },
);
