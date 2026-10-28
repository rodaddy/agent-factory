/**
 * @module tests/fleet/forge-vendored
 * @description `fleet/forge/` is Development's `forge` CLI copied
 *   byte-exact so `fleet/deploy` ships it to the boxes. Every file there must
 *   equal Development's `_ob/bin/<name>` at the commit its README names, mode
 *   included. Skipped where the Development checkout is absent (CI runners).
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const DIR = resolve(import.meta.dir, "../../fleet/forge");
const DEVELOPMENT = process.env.FORGE_VENDOR_DEVELOPMENT ?? "";
const present = DEVELOPMENT !== "" && existsSync(join(DEVELOPMENT, ".git"));
const sha = /Development commit ([0-9a-f]{40})/.exec(
	readFileSync(join(DIR, "README.md"), "utf8"),
)?.[1];

describe("fleet/forge vendored copy", () => {
	test("README and VENDORED name the same full Development commit", () => {
		const markerSha = /^Development _ob\/bin @ ([0-9a-f]{40})\n?$/.exec(
			readFileSync(join(DIR, "VENDORED"), "utf8"),
		)?.[1];
		expect(sha).toBeDefined();
		expect(markerSha).toBe(sha);
	});

	// Every sibling forge imports must be vendored too; one missing file fails the load on the boxes.
	test("forge loads from the vendored directory alone", () => {
		const run = Bun.spawnSync(["node", join(DIR, "forge"), "--help"]);
		expect({ exit: run.exitCode, err: run.stderr.toString().slice(0, 200) }).toEqual({
			exit: 0,
			err: "",
		});
	});

	const name = present
		? "every file equals Development's _ob/bin copy at the README commit"
		: `skipped: no Development checkout at ${DEVELOPMENT}`;
	test.skipIf(!present)(name, () => {
		expect(sha).toBeDefined();
		const names = readdirSync(DIR).filter((n) => n !== "README.md" && n !== "VENDORED");
		expect(names.length).toBeGreaterThan(0);
		const tree = Bun.spawnSync(["git", "-C", DEVELOPMENT, "ls-tree", `${sha}`, "_ob/bin/"]);
		const modes = new Map(
			tree.stdout
				.toString()
				.trim()
				.split("\n")
				.map((l) => {
					const [meta, path] = l.split("\t");
					return [path?.replace("_ob/bin/", "") ?? "", meta?.split(" ")[0] ?? ""] as const;
				}),
		);
		for (const name of names) {
			const show = Bun.spawnSync(["git", "-C", DEVELOPMENT, "show", `${sha}:_ob/bin/${name}`]);
			expect({ name, exit: show.exitCode }).toEqual({ name, exit: 0 });
			const same = Buffer.compare(Buffer.from(show.stdout), readFileSync(join(DIR, name))) === 0;
			expect({ name, same }).toEqual({ name, same: true });
			const exec = (statSync(join(DIR, name)).mode & 0o100) !== 0;
			expect({ name, exec }).toEqual({ name, exec: modes.get(name) === "100755" });
		}
	});
});
