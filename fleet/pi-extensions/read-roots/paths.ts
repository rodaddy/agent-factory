/**
 * @module fleet/pi-extensions/read-roots/paths
 * @description The path logic of the read-roots fence (SOF-10922), kept
 *   apart so it can be checked against Pi's own resolver. Pi's tools do not
 *   open a path as written: Pi 1.0.3's `resolveToCwd` (all of read, grep,
 *   find, ls) turns Unicode spaces into a space, strips one leading `@`,
 *   expands `~` and decodes `file://`. When the path does not exist,
 *   `resolveReadPath` (read only) also tries an AM/PM narrow-space form, the
 *   NFD form, `'` as U+2019, and NFD plus U+2019. A fence that judges the
 *   written path can allow one file while Pi opens another.
 *   These helpers give the fence the paths Pi may really open.
 *
 *   Inert: nothing imports this module until the read-roots extension does.
 */
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type Env = Record<string, string | undefined>;

/** Pi 1.0.3 `utils/paths.js` UNICODE_SPACES: each becomes a plain space before Pi opens the path. */
const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const NON_ASCII = /[^\x20-\x7E]/;

/** True when the path has any character outside printable ASCII. */
export function hasNonAscii(p: string): boolean {
	return NON_ASCII.test(p);
}

/** `~` and `~/` against HOME; anything else as given. */
export function expandHome(p: string, env: Env): string {
	const home = env.HOME || homedir();
	return p === "~" ? home : p.startsWith("~/") ? join(home, p.slice(2)) : p;
}

/**
 * The absolute path Pi 1.0.3's `resolveToCwd` opens for `given` from `cwd`:
 * Unicode spaces to a space, one leading `@` stripped, `~`/`~/` against
 * HOME, `file://` decoded, then resolved against the cwd. Throws on a
 * `file://` URL Node cannot decode (a host part), as Pi would.
 */
export function piResolve(given: string, cwd: string, env: Env): string {
	let p = given.replace(UNICODE_SPACES, " ");
	if (p.startsWith("@")) p = p.slice(1);
	p = p.startsWith("file://") ? fileURLToPath(p) : expandHome(p, env);
	return isAbsolute(p) ? resolve(p) : resolve(cwd, p);
}

/**
 * Every path Pi 1.0.3's `resolveReadPath` may open for `resolved`: the path
 * itself, then each fallback it tries when that does not exist, in Pi's
 * order, duplicates dropped. A fence judges all of them, so it never depends
 * on which one exists at the moment it looks.
 */
export function readCandidates(resolved: string): string[] {
	const nfd = resolved.normalize("NFD");
	const curly = (s: string) => s.replace(/'/g, "\u2019");
	return [
		...new Set([
			resolved,
			resolved.replace(/ (AM|PM)\./gi, "\u202F$1."),
			nfd,
			curly(resolved),
			curly(nfd),
		]),
	];
}

/** realpath of `p`, or of its nearest existing ancestor with the rest re-joined. */
export function realish(p: string): string {
	let cur = resolve(p);
	const rest: string[] = [];
	for (;;) {
		try {
			return join(realpathSync(cur), ...rest.reverse());
		} catch {
			const up = dirname(cur);
			if (up === cur) return resolve(p);
			rest.push(cur.slice(up.length).replace(/^\/+/, ""));
			cur = up;
		}
	}
}

/** True when the realpath of `path` is, or is under, one of `roots` (already realpaths). */
export function within(path: string, roots: string[]): boolean {
	const real = realish(path);
	return roots.some((r) => real === r || real.startsWith(r.endsWith(sep) ? r : r + sep));
}
