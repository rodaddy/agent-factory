import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rename, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { PACKET_LANE_IDS } from "../../src/packets/registry";
import { PACKET_SCAFFOLD_MARKER } from "../../src/packets/schema";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "make-packet.ts");
const created: string[] = [];

afterEach(async () => {
	for (const dir of created.splice(0)) {
		await rename(dir, join(testArchiveDir(), `${basename(dir)}-${crypto.randomUUID()}`));
	}
});

/** A throwaway output directory the script scaffolds into instead of real `packets/`. */
async function outDir(): Promise<string> {
	const dir = await mkdtemp(join(testTmpBase(), "rw-make-packet-"));
	created.push(dir);
	return dir;
}

/** Run the script with `args`, writing into `dir`. */
function run(args: readonly string[], dir: string) {
	const result = Bun.spawnSync(["bun", "run", SCRIPT, ...args], {
		env: { ...process.env, MAKE_PACKET_OUT_DIR: dir },
	});
	return {
		exitCode: result.exitCode,
		stdout: result.stdout.toString(),
		stderr: result.stderr.toString(),
	};
}

describe("make-packet CLI", () => {
	test("scaffolds a new lane's packet", async () => {
		const dir = await outDir();
		const result = run(["brand-new-lane"], dir);
		expect(result.exitCode).toBe(0);
		expect(existsSync(join(dir, "brand-new-lane.md"))).toBe(true);
		expect(await readFile(join(dir, "brand-new-lane.md"), "utf8")).toContain(
			PACKET_SCAFFOLD_MARKER,
		);
	});

	test("--force DOES overwrite an existing file for a lane nobody declares", async () => {
		// The legitimate --force case: replacing a half-written stub. This is the
		// control for the refusal below — it proves the refusal is about the lane
		// being DECLARED, not about --force being broken outright.
		const dir = await outDir();
		await writeFile(join(dir, "half-written.md"), "authored prose\n", "utf8");
		const result = run(["half-written", "--force"], dir);
		expect(result.exitCode).toBe(0);
		const written = await readFile(join(dir, "half-written.md"), "utf8");
		expect(written).toContain(PACKET_SCAFFOLD_MARKER);
		expect(written).not.toContain("authored prose");
	});

	test("REFUSES a declared PACKET_LANE_IDS lane even under --force", async () => {
		// A declared lane is a live dispatch target: overwriting its packet swaps a
		// running agent's whole system prompt for text the loader then refuses.
		const dir = await outDir();
		const lane = PACKET_LANE_IDS[0];
		await writeFile(join(dir, `${lane}.md`), "authored prose\n", "utf8");
		const result = run([lane, "--force"], dir);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("declared PACKET_LANE_IDS lane");
		// And it did not write: the authored file is untouched.
		expect(await readFile(join(dir, `${lane}.md`), "utf8")).toBe("authored prose\n");
	});

	test("refuses a declared lane WITHOUT --force too, naming the lane not the file", async () => {
		const dir = await outDir();
		const lane = PACKET_LANE_IDS[0];
		const result = run([lane], dir);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("declared PACKET_LANE_IDS lane");
		expect(existsSync(join(dir, `${lane}.md`))).toBe(false);
	});

	test("refuses to overwrite an existing packet without --force", async () => {
		const dir = await outDir();
		await writeFile(join(dir, "existing.md"), "authored prose\n", "utf8");
		const result = run(["existing"], dir);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("already exists");
		expect(await readFile(join(dir, "existing.md"), "utf8")).toBe("authored prose\n");
	});

	test("REJECTS extra positional args instead of silently scaffolding only the first", async () => {
		const dir = await outDir();
		const result = run(["alpha", "beta"], dir);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("expected exactly one lane id");
		// Neither was written — the caller re-runs with one id rather than believing
		// both landed.
		expect(existsSync(join(dir, "alpha.md"))).toBe(false);
		expect(existsSync(join(dir, "beta.md"))).toBe(false);
	});

	test("--help prints usage and exits 0 without writing", async () => {
		const dir = await outDir();
		const result = run(["--help"], dir);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain("usage: bun run scripts/make-packet.ts");
		expect(result.stdout).toContain("--force");
	});

	test("the 'wrote' message names the path it ACTUALLY wrote, not a hardcoded packets/", async () => {
		// Under MAKE_PACKET_OUT_DIR the message used to read `wrote packets/x.md`
		// while the file landed in the override dir — it named a file the run never
		// created, which is the operator reading a receipt for the wrong path.
		const dir = await outDir();
		const result = run(["path-echo"], dir);
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toContain(`wrote ${join(dir, "path-echo.md")}`);
		expect(result.stdout).not.toContain("wrote packets/path-echo.md");
	});

	test("rejects a non-kebab-case lane id before any write", async () => {
		const dir = await outDir();
		const result = run(["Not_Kebab"], dir);
		expect(result.exitCode).toBe(1);
		expect(result.stderr).toContain("must be kebab-case");
		expect(existsSync(join(dir, "Not_Kebab.md"))).toBe(false);
	});
});
