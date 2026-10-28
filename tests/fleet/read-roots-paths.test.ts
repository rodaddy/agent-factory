/**
 * @module tests/fleet/read-roots-paths
 * @description The read-roots path helpers (SOF-10922): Pi 1.0.3's
 *   normalization (`piResolve`), its read fallbacks (`readCandidates`), and
 *   realpath containment (`within`) against symlinks out of a root whose
 *   names Pi reaches from another spelling. One test imports
 *   the pinned Pi's own `resolveReadPath` and checks that, for each escape,
 *   Pi would open the outside file and some candidate is outside the root.
 *   Pi comes from this repo's own devDependency, pinned exactly to
 *   `fleet/pi/versions.json`, so the check runs everywhere `bun install` ran
 *   (CI included) and never skips. A pin bump that is not mirrored in
 *   package.json fails here.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import {
	expandHome,
	hasNonAscii,
	piResolve,
	readCandidates,
	realish,
	within,
} from "../../fleet/pi-extensions/read-roots/paths";
import { testTmpBase } from "../support/test-temp";

const FLEET = resolve(import.meta.dir, "../../fleet");

let scratch = "";
let home = "";
let root = "";
let outside = "";

beforeAll(() => {
	scratch = mkdtempSync(join(testTmpBase(), "read-roots-paths-"));
	home = join(scratch, "home");
	root = join(home, "src/repo");
	outside = join(home, ".ssh");
	mkdirSync(join(root, "docs"), { recursive: true });
	writeFileSync(join(root, "docs/facts.md"), "facts\n");
	mkdirSync(outside, { recursive: true });
	writeFileSync(join(outside, "id_ed25519"), "not a key\n");
	symlinkSync(outside, join(root, "keys"));
	symlinkSync(outside, join(root, "my keys"));
	symlinkSync(join(outside, "id_ed25519"), join(root, "curly\u2019.env"));
	symlinkSync(outside, join(root, "cafe\u0301"));
	symlinkSync(join(outside, "id_ed25519"), join(root, "shot 10\u202FAM.png"));
});
afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const roots = () => [realpathSync(root)];
/** Some path Pi may open for `p` (as the fence would judge it) is outside the root. */
const escapes = (p: string) =>
	readCandidates(piResolve(p, root, { HOME: home })).some((c) => !within(c, roots()));

describe("piResolve: Pi 1.0.3 resolveToCwd", () => {
	test("Unicode spaces, one @, ~, file://, relative", () => {
		const env = { HOME: home };
		expect(piResolve("a\u00A0b\u2009c\u202Fd\u205Fe\u3000f", root, env)).toBe(
			join(root, "a b c d e f"),
		);
		expect(piResolve("@docs/x.md", root, env)).toBe(join(root, "docs/x.md"));
		expect(piResolve("@@x", root, env)).toBe(join(root, "@x"));
		expect(piResolve("~", root, env)).toBe(home);
		expect(piResolve("~/x", root, env)).toBe(join(home, "x"));
		expect(piResolve(`file://${join(home, "y")}`, root, env)).toBe(join(home, "y"));
		expect(piResolve("docs/../../x", root, env)).toBe(join(home, "src/x"));
		expect(() => piResolve("file://evil-host/etc/hosts", root, env)).toThrow();
	});
	test("expandHome leaves other paths alone", () => {
		expect(expandHome("~user/x", { HOME: "/h" })).toBe("~user/x");
		expect(expandHome("/a", { HOME: "/h" })).toBe("/a");
	});
	test("hasNonAscii", () => {
		expect(hasNonAscii("/a/b c.md")).toBe(false);
		expect(hasNonAscii("/a/r\u00E9sum\u00E9")).toBe(true);
		expect(hasNonAscii("/a\u00A0b")).toBe(true);
		expect(hasNonAscii("/a\tb")).toBe(true);
	});
});

describe("readCandidates: Pi 1.0.3 resolveReadPath fallbacks", () => {
	test("in Pi's order, duplicates dropped", () => {
		expect(readCandidates("/r/plain.md")).toEqual(["/r/plain.md"]);
		expect(readCandidates("/r/it's 1 PM.png")).toEqual([
			"/r/it's 1 PM.png",
			"/r/it's 1\u202FPM.png",
			"/r/it\u2019s 1 PM.png",
		]);
		expect(readCandidates("/r/caf\u00E9")).toEqual(["/r/caf\u00E9", "/r/cafe\u0301"]);
		expect(readCandidates("/r/caf\u00E9's")).toEqual([
			"/r/caf\u00E9's",
			"/r/cafe\u0301's",
			"/r/caf\u00E9\u2019s",
			"/r/cafe\u0301\u2019s",
		]);
	});
});

describe("within: realpath containment", () => {
	test("inside, the root itself, and a missing file inside", () => {
		expect(within(join(root, "docs/facts.md"), roots())).toBe(true);
		expect(within(root, roots())).toBe(true);
		expect(within(join(root, "docs/missing.md"), roots())).toBe(true);
	});
	test("a symlink out, a prefix sibling, a parent", () => {
		expect(within(join(root, "keys/id_ed25519"), roots())).toBe(false);
		expect(within(`${root}-evil/x`, roots())).toBe(false);
		expect(within(home, roots())).toBe(false);
	});
	test("realish resolves the nearest existing ancestor", () => {
		expect(realish(join(root, "keys/nope/deeper"))).toBe(
			join(realpathSync(outside), "nope/deeper"),
		);
	});
});

describe("every reviewer escape is caught", () => {
	for (const [label, p] of [
		["no-break space onto a symlink out", "my\u00A0keys/id_ed25519"],
		["ideographic space onto a symlink out", "my\u3000keys/id_ed25519"],
		["NFC spelling of an NFD symlink out", "caf\u00E9/id_ed25519"],
		["ASCII quote, U+2019 symlink out", "curly'.env"],
		["AM/PM, U+202F symlink out", "shot 10 AM.png"],
	] as const) {
		test(label, () => expect(escapes(p)).toBe(true));
	}
	test("a plain path inside stays inside", () => expect(escapes("docs/facts.md")).toBe(false));

	const PI_PKG = resolve(import.meta.dir, "../../node_modules/@earendil-works/pi-coding-agent");
	test("the installed Pi devDependency is the fleet pin", () => {
		const pin = JSON.parse(readFileSync(join(FLEET, "pi/versions.json"), "utf8"))[
			"@earendil-works/pi-coding-agent"
		];
		const version = JSON.parse(readFileSync(join(PI_PKG, "package.json"), "utf8")).version;
		expect(version).toBe(pin);
	});
	test("against the pinned Pi's own resolveReadPath", async () => {
		const file = join(PI_PKG, "dist/core/tools/path-utils.js");
		expect(existsSync(file)).toBe(true);
		const { resolveReadPath } = (await import(file)) as {
			resolveReadPath: (p: string, cwd: string) => string;
		};
		const out = realpathSync(outside);
		for (const p of [
			join(root, "my\u00A0keys/id_ed25519"),
			join(root, "caf\u00E9/id_ed25519"),
			join(root, "curly'.env"),
			join(root, "shot 10 AM.png"),
		]) {
			// Pi really opens the outside file, and the helpers see it.
			expect(realpathSync(resolveReadPath(p, root)).startsWith(out)).toBe(true);
			expect(escapes(p)).toBe(true);
		}
	});
	test("`..` after a symlink: Pi collapses it lexically, exactly as piResolve does", async () => {
		// pr-review on #1919 (d35cb52) said Pi keeps `..` in an absolute path, so
		// `<root>/keys/../x` would open `<outside>/../x`. Pi 1.0.3's resolvePath
		// runs node's path.resolve on absolute paths too, which collapses `..`
		// before any symlink is followed; grep/find/ls use the same resolveToCwd.
		const { resolveReadPath, resolveToCwd } = (await import(
			join(PI_PKG, "dist/core/tools/path-utils.js")
		)) as Record<"resolveReadPath" | "resolveToCwd", (p: string, cwd: string) => string>;
		for (const p of [
			`${join(root, "keys")}/../docs/facts.md`,
			"keys/../docs/facts.md",
			`${join(root, "keys")}/../../repo/docs/facts.md`,
		]) {
			const ours = piResolve(p, root, { HOME: home });
			expect(resolveReadPath(p, root)).toBe(ours);
			expect(resolveToCwd(p, root)).toBe(ours);
			expect(readFileSync(resolveReadPath(p, root), "utf8")).toBe("facts\n");
			expect(escapes(p)).toBe(false);
		}
	});
});
