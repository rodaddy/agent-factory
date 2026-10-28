/**
 * @module tests/fleet/review-bundle
 * @description `fleet/review/bundle/install.sh`, run as a
 *   real child process, non-root, against a throwaway `REVIEW_JOBS_PREFIX` and
 *   `REVIEW_JOBS_PI_PACKAGE`. Fixture tarballs are built here with `tar`, never
 *   by `build.sh` (which needs network), and carry a MANIFEST.json shaped like
 *   build.sh's. The installer runs under `umask 000`, so the group/other-write
 *   assertion fails unless the installer strips it.
 *   Mutation run: `INSTALL_UNDER_TEST=<copy with one check removed>` turns the
 *   case covering that check red.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.INSTALL_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/review/bundle/install.sh");
const T = 30_000;
const EXECUTABLES = new Set(["pi/bin/pi", "factory/bin/review-prepare", "issuer/bin/review-issue"]);
/** The Pi version every fixture MANIFEST.json records; the fake host Pi matches it. */
const PI_VERSION = "1.1.0";
/** Root ignores the chmod denials the failure cases rely on. */
const AS_ROOT = process.getuid?.() === 0;
let root = "";
let piPackage = "";
let count = 0;

beforeAll(() => {
	const base = process.env.RTECH_TEMP_ROOT?.trim() || testTmpBase();
	mkdirSync(base, { recursive: true });
	root = mkdtempSync(join(base, "review-bundle-"));
	piPackage = join(root, "pi-package.json");
	writeFileSync(
		piPackage,
		`${JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: PI_VERSION })}\n`,
	);
});
afterAll(() => {
	if (root) rmSync(root, { recursive: true, force: true });
});

const sha256 = (data: string | Buffer) => new Bun.CryptoHasher("sha256").update(data).digest("hex");

/**
 * A bundle stage with world-writable modes and a MANIFEST.json listing every
 * file at its installed mode; `variant` changes the content.
 */
function stage(variant: string, piVersion = PI_VERSION): string {
	const dir = join(root, `stage-${++count}`);
	const files: Record<string, string> = {
		"pi/bin/pi": `#!/bin/sh\necho ${variant}\n`,
		"extensions/review-scope/index.ts": `export default "${variant}";\n`,
		"factory/bin/review-prepare": `#!/bin/sh\necho ${variant}\n`,
		"issuer/bin/review-issue": `#!/bin/sh\necho ${variant}\n`,
		"factory/fixed-review-prompt.txt": `prompt ${variant}\n`,
	};
	for (const [rel, body] of Object.entries(files)) {
		mkdirSync(join(dir, rel, ".."), { recursive: true });
		writeFileSync(join(dir, rel), body);
		chmodSync(join(dir, rel), 0o666);
	}
	for (const d of [
		"pi",
		"pi/bin",
		"extensions",
		"extensions/review-scope",
		"factory",
		"factory/bin",
		"issuer",
		"issuer/bin",
	]) {
		chmodSync(join(dir, d), 0o777);
	}
	const entries = Object.entries(files).map(([path, body]) => ({
		path,
		sha256: sha256(body),
		mode: EXECUTABLES.has(path) ? "0755" : "0644",
	}));
	writeFileSync(
		join(dir, "MANIFEST.json"),
		`${JSON.stringify({ schemaVersion: 1, pi: { version: piVersion }, files: entries })}\n`,
	);
	return dir;
}

function pack(dir: string): { tgz: string; sha: string } {
	const tgz = `${dir}.tar.gz`;
	const r = Bun.spawnSync(["tar", "-czf", tgz, "-C", dir, ...readdirSync(dir).sort()], {
		env: { ...process.env, COPYFILE_DISABLE: "1" },
	});
	expect(r.exitCode).toBe(0);
	return { tgz, sha: sha256(readFileSync(tgz)) };
}

/** A prefix shaped like the play leaves it: factory/ and issuer/ exist, and issuer/ holds a play-owned file. */
function prefix(): string {
	const p = join(root, `prefix-${++count}`);
	mkdirSync(join(p, "factory"), { recursive: true });
	mkdirSync(join(p, "issuer"), { recursive: true });
	writeFileSync(join(p, "issuer", "signing.pub"), "play-owned\n");
	return p;
}

function install(p: string, tgz: string, sha: string) {
	const r = Bun.spawnSync(["bash", "-c", 'umask 000; exec bash "$0" "$@"', SCRIPT, tgz, sha], {
		env: { ...process.env, REVIEW_JOBS_PREFIX: p, REVIEW_JOBS_PI_PACKAGE: piPackage },
	});
	return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((n) => {
		const p = join(dir, n);
		return lstatSync(p).isDirectory() ? [p, ...walk(p)] : [p];
	});
}

const dotEntries = (p: string) => readdirSync(p).filter((n) => n.startsWith("."));

/** Installs `bad` over a prefix holding a good "old" install; expects exit 1 and no change. */
function expectRefusedOverOld(bad: string, why: string) {
	const p = prefix();
	const good = pack(stage("old"));
	expect(install(p, good.tgz, good.sha).code).toBe(0);
	const before = readFileSync(join(p, "INSTALLED"), "utf8");
	const { tgz, sha } = pack(bad);
	const r = install(p, tgz, sha);
	expect(r.err).toContain(why);
	expect(r.code).toBe(1);
	expect(readFileSync(join(p, "pi/bin/pi"), "utf8")).toContain("old");
	expect(readFileSync(join(p, "INSTALLED"), "utf8")).toBe(before);
	expect(dotEntries(p)).toEqual([]);
}

test(
	"a wrong expected sha256 exits 1 and nothing appears under the prefix",
	() => {
		const p = prefix();
		const { tgz } = pack(stage("a"));
		const r = install(p, tgz, "0".repeat(64));
		expect(r.code).toBe(1);
		expect(r.err).toContain("sha256 mismatch");
		expect(readdirSync(p).sort()).toEqual(["factory", "issuer"]);
		expect(readdirSync(join(p, "factory"))).toEqual([]);
	},
	T,
);

test(
	"a symlink at pi/bin/pi exits 1 and nothing is replaced",
	() => {
		const bad = stage("evil");
		rmSync(join(bad, "pi/bin/pi"));
		symlinkSync("/usr/bin/env", join(bad, "pi/bin/pi"));
		expectRefusedOverOld(bad, "link");
	},
	T,
);

test(
	"a member under issuer/ other than issuer/bin/* is outside the bundle layout: exits 1 and nothing is replaced",
	() => {
		const bad = stage("evil");
		writeFileSync(join(bad, "issuer", "signing.key"), "evil\n");
		expectRefusedOverOld(bad, "member outside the bundle layout");
	},
	T,
);

test(
	"a file that differs from its MANIFEST.json entry exits 1 and nothing is replaced",
	() => {
		const bad = stage("evil");
		writeFileSync(join(bad, "factory/fixed-review-prompt.txt"), "swapped after the manifest\n");
		expectRefusedOverOld(bad, "differs from MANIFEST.json");
	},
	T,
);

test(
	"a bundle built for another Pi version exits 1 and nothing is replaced",
	() => {
		expectRefusedOverOld(stage("evil", "9.9.9"), `host Pi is ${PI_VERSION}`);
	},
	T,
);

test.skipIf(AS_ROOT)(
	"a failed rename rolls every swapped path back and exits 3",
	() => {
		const p = prefix();
		const good = pack(stage("old"));
		expect(install(p, good.tgz, good.sha).code).toBe(0);
		const before = readFileSync(join(p, "INSTALLED"), "utf8");
		const next = pack(stage("new"));
		// factory/bin cannot leave a read-only factory/: the third rename fails.
		chmodSync(join(p, "factory"), 0o555);
		try {
			const r = install(p, next.tgz, next.sha);
			expect(r.err).toContain("rolled back");
			expect(r.code).toBe(3);
		} finally {
			chmodSync(join(p, "factory"), 0o755);
		}
		expect(readFileSync(join(p, "pi/bin/pi"), "utf8")).toContain("old");
		expect(readFileSync(join(p, "extensions/review-scope/index.ts"), "utf8")).toContain("old");
		expect(readFileSync(join(p, "factory/bin/review-prepare"), "utf8")).toContain("old");
		expect(readFileSync(join(p, "INSTALLED"), "utf8")).toBe(before);
		expect(dotEntries(p)).toEqual([]);
	},
	T,
);

test(
	"an INSTALLED that is not a regular file refuses with nothing swapped",
	() => {
		const p = prefix();
		const good = pack(stage("old"));
		expect(install(p, good.tgz, good.sha).code).toBe(0);
		const manifest = readFileSync(join(p, "MANIFEST.json"), "utf8");
		// mv would move the receipt INTO a directory and exit 0.
		rmSync(join(p, "INSTALLED"));
		mkdirSync(join(p, "INSTALLED"));
		const next = pack(stage("new"));
		const r = install(p, next.tgz, next.sha);
		expect(r.err).toContain("is not a regular file");
		expect(r.err.trim().split("\n").length).toBe(1);
		expect(r.code).toBe(1);
		expect(lstatSync(join(p, "INSTALLED")).isDirectory()).toBe(true);
		expect(readFileSync(join(p, "pi/bin/pi"), "utf8")).toContain("old");
		expect(readFileSync(join(p, "extensions/review-scope/index.ts"), "utf8")).toContain("old");
		expect(readFileSync(join(p, "factory/bin/review-prepare"), "utf8")).toContain("old");
		expect(readFileSync(join(p, "factory/fixed-review-prompt.txt"), "utf8")).toBe("prompt old\n");
		expect(readFileSync(join(p, "MANIFEST.json"), "utf8")).toBe(manifest);
		expect(dotEntries(p)).toEqual([]);
	},
	T,
);

test(
	"a good tarball installs without group/other write, records INSTALLED and MANIFEST.json, and keeps .prev-* on reinstall",
	() => {
		const p = prefix();
		const first = pack(stage("one"));
		const r = install(p, first.tgz, first.sha);
		expect(r.code).toBe(0);
		expect(readFileSync(join(p, "factory/bin/review-prepare"), "utf8")).toContain("one");
		expect(readFileSync(join(p, "factory/fixed-review-prompt.txt"), "utf8")).toBe("prompt one\n");
		expect(existsSync(join(p, "extensions/review-scope/index.ts"))).toBe(true);
		for (const f of walk(p)) expect(`${f} ${lstatSync(f).mode & 0o022}`).toBe(`${f} 0`);
		const mode = (rel: string) => (lstatSync(join(p, rel)).mode & 0o7777).toString(8);
		expect(mode("pi/bin/pi")).toBe("755");
		expect(mode("factory/bin/review-prepare")).toBe("755");
		expect(mode("issuer/bin/review-issue")).toBe("755");
		expect(mode("factory/fixed-review-prompt.txt")).toBe("644");
		const installed = readFileSync(join(p, "INSTALLED"), "utf8");
		expect(installed).toContain(`sha256=${first.sha}\n`);
		expect(installed).toContain(
			`manifest_sha256=${sha256(readFileSync(join(p, "MANIFEST.json")))}\n`,
		);
		expect(r.out).toContain(`sha256=${first.sha}`);

		const second = pack(stage("two"));
		expect(install(p, second.tgz, second.sha).code).toBe(0);
		const backup = (name: string) => {
			const re = new RegExp(`^\\.prev-\\d{8}T\\d{6}Z-${second.sha.slice(0, 12)}-${name}$`);
			const hits = readdirSync(p).filter((n) => re.test(n));
			expect(hits.length).toBe(1);
			return join(p, hits[0] as string);
		};
		expect(readFileSync(join(p, "pi/bin/pi"), "utf8")).toContain("two");
		expect(readFileSync(join(backup("pi"), "bin/pi"), "utf8")).toContain("one");
		expect(readFileSync(join(backup("factory-bin"), "review-prepare"), "utf8")).toContain("one");
		expect(readFileSync(join(p, "issuer/bin/review-issue"), "utf8")).toContain("two");
		expect(readFileSync(join(backup("issuer-bin"), "review-issue"), "utf8")).toContain("one");
		expect(readFileSync(backup("MANIFEST.json"), "utf8")).toContain(sha256("prompt one\n"));
		expect(readFileSync(join(p, "INSTALLED"), "utf8")).toContain(`sha256=${second.sha}\n`);
		expect(readFileSync(join(p, "issuer/signing.pub"), "utf8")).toBe("play-owned\n");
	},
	T,
);

test(
	"a missing issuer/ refuses with nothing swapped",
	() => {
		const p = prefix();
		const good = pack(stage("old"));
		expect(install(p, good.tgz, good.sha).code).toBe(0);
		const before = readFileSync(join(p, "INSTALLED"), "utf8");
		rmSync(join(p, "issuer"), { recursive: true });
		const next = pack(stage("new"));
		const r = install(p, next.tgz, next.sha);
		expect(r.err).toContain(`missing ${p}/issuer`);
		expect(r.code).toBe(1);
		expect(existsSync(join(p, "issuer"))).toBe(false);
		expect(readFileSync(join(p, "pi/bin/pi"), "utf8")).toContain("old");
		expect(readFileSync(join(p, "INSTALLED"), "utf8")).toBe(before);
		expect(dotEntries(p)).toEqual([]);
	},
	T,
);
