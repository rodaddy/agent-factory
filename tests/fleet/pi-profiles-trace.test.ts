/**
 * @module tests/fleet/pi-profiles-trace
 * @description Pi tracing T3: every seat profile in
 *   `fleet/pi/profiles/` loads fleet-guard first and the langfuse-trace
 *   extension second, so every Pi seat is traced once its Langfuse env is set.
 *   Each profile also runs through `fleet/bin/pi-employee` against a fake `pi`,
 *   which proves both extension paths resolve and keep that order on argv.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const FLEET = resolve(import.meta.dir, "../../fleet");
const PROFILES = join(FLEET, "pi", "profiles");
const LAUNCHER = join(FLEET, "bin", "pi-employee");
const PIN = JSON.parse(readFileSync(join(FLEET, "pi", "versions.json"), "utf8"))[
	"@earendil-works/pi-coding-agent"
] as string;
const EXTENSIONS = ["pi-extensions/fleet-guard/index.ts", "pi-extensions/langfuse-trace/index.ts"];
const SEATS = readdirSync(PROFILES)
	.filter((f) => f.endsWith(".json"))
	.map((f) => f.slice(0, -".json".length));

let scratch = "";
let fakePi = "";

beforeAll(() => {
	scratch = mkdtempSync(join(testTmpBase(), "pi-profiles-trace-"));
	fakePi = join(scratch, "fake-pi");
	writeFileSync(
		fakePi,
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi ${PIN}"; exit 0; fi\nprintf '%s\\n' "$@" > "$FAKE_PI_OUT"\n`,
	);
	chmodSync(fakePi, 0o755);
});
afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe("every seat profile loads fleet-guard then langfuse-trace", () => {
	test("there are seat profiles to check", () => {
		expect(SEATS.length).toBeGreaterThan(20);
	});

	for (const seat of SEATS) {
		test(`${seat}: profile and launcher argv carry both extensions in order`, async () => {
			const profile = JSON.parse(readFileSync(join(PROFILES, `${seat}.json`), "utf8"));
			expect(profile.extensions).toEqual(EXTENSIONS);
			const out = join(scratch, `argv-${seat}.txt`);
			const p = Bun.spawn([LAUNCHER, "--mode", "json", "-p", "go"], {
				env: {
					PATH: process.env.PATH ?? "",
					HOME: scratch,
					PI_EMPLOYEE_FLEET_ROOT: FLEET,
					PI_EMPLOYEE_PI_BIN: fakePi,
					FLEET_EMPLOYEE: seat,
					FAKE_PI_OUT: out,
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
			expect(stderr).toBe("");
			expect(code).toBe(0);
			const argv = readFileSync(out, "utf8").trim().split("\n");
			// The launcher always loads fleet-proxy-models first, then the profile's extensions.
			expect(argv.slice(0, 7)).toEqual([
				"-ne",
				"-e",
				join(FLEET, "pi-extensions", "fleet-proxy-models", "index.ts"),
				...EXTENSIONS.flatMap((e) => ["-e", join(FLEET, e)]),
			]);
		});
	}
});
