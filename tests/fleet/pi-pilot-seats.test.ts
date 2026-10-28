/**
 * @module tests/fleet/pi-pilot-seats
 * @description The four Pi pilot seat profiles (Bishop, Smythe, Adams, Chang;
 *   sf#1493). Each real profile is run through
 *   `fleet/bin/pi-employee` against a fake `pi` (the launcher's own test
 *   idiom), so it passes the launcher's validation and its extensions resolve.
 *   Reviewers carry no write/edit tool (four-writer rule).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const FLEET = resolve(import.meta.dir, "../../fleet");
const LAUNCHER = join(FLEET, "bin", "pi-employee");
const SEATS = ["bishop", "smythe", "adams", "chang"] as const;
const REVIEWERS = ["smythe", "adams", "chang"] as const;
const PIN = JSON.parse(readFileSync(join(FLEET, "pi", "versions.json"), "utf8"))[
	"@earendil-works/pi-coding-agent"
] as string;

let scratch = "";
let fakePi = "";

beforeAll(() => {
	scratch = mkdtempSync(join(testTmpBase(), "pi-pilot-seats-"));
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

async function spawn(cmd: string[], env: Record<string, string>) {
	const p = Bun.spawn(cmd, {
		env: { PATH: process.env.PATH ?? "", HOME: scratch, ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { stdout, stderr, code };
}

function profileOf(seat: string): {
	tools: string[];
	extensions: string[];
} {
	return JSON.parse(readFileSync(join(FLEET, "pi", "profiles", `${seat}.json`), "utf8"));
}

describe("pilot seat profiles", () => {
	for (const seat of SEATS) {
		test(`${seat}: the launcher accepts it; live catalog then fleet-guard first; tools passed through`, async () => {
			const out = join(scratch, `argv-${seat}.txt`);
			const r = await spawn([LAUNCHER, "--mode", "json", "--tools", "read,write", "-p", "go"], {
				PI_EMPLOYEE_FLEET_ROOT: FLEET,
				PI_EMPLOYEE_PI_BIN: fakePi,
				FLEET_EMPLOYEE: seat,
				FAKE_PI_OUT: out,
			});
			expect(r.stderr).toBe("");
			expect(r.code).toBe(0);
			const argv = readFileSync(out, "utf8").trim().split("\n");
			expect(argv.slice(0, 5)).toEqual([
				"-ne",
				"-e",
				join(FLEET, "pi-extensions", "fleet-proxy-models", "index.ts"),
				"-e",
				join(FLEET, "pi-extensions", "fleet-guard", "index.ts"),
			]);
			expect(argv[argv.indexOf("--tools") + 1]).toBe(profileOf(seat).tools.join(","));
		});
	}

	test("reviewers have no write/edit; bishop has both", () => {
		for (const seat of REVIEWERS) {
			const tools = profileOf(seat).tools;
			expect(tools).not.toContain("write");
			expect(tools).not.toContain("edit");
		}
		expect(profileOf("bishop").tools).toEqual(expect.arrayContaining(["write", "edit"]));
	});

	test("no profile names a model or family: the board's model is the selector", () => {
		for (const seat of SEATS) expect(Object.keys(profileOf(seat))).not.toContain("models");
	});
});
