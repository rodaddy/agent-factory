import { describe, expect, test } from "bun:test";

describe("source integrity", () => {
	test("TypeScript source contains no NUL bytes", async () => {
		const files: string[] = [];
		for await (const file of new Bun.Glob("src/**/*.ts").scan(".")) {
			files.push(file);
		}
		const withNul: string[] = [];
		for (const file of files) {
			const bytes = new Uint8Array(await Bun.file(file).arrayBuffer());
			if (bytes.includes(0)) {
				withNul.push(file);
			}
		}
		expect(withNul).toEqual([]);
	});

	/**
	 * sf#333, mirroring sf#295's done-means on the dispatch side: the compiled Mac
	 * default ships 0 times. Job 5107 (2026-08-17) held on an ENOENT for exactly
	 * this literal, on an LXC. Absence must be an honest hold, never a Mac path.
	 */
	test("no Mac-local rtech-infra path is compiled into src/", async () => {
		const MAC_LOCAL_PATH = "/opt/dev/rtech-infra";
		const offenders: string[] = [];
		for await (const file of new Bun.Glob("src/**/*.ts").scan(".")) {
			if ((await Bun.file(file).text()).includes(MAC_LOCAL_PATH)) {
				offenders.push(file);
			}
		}
		expect(offenders).toEqual([]);
	});
});
