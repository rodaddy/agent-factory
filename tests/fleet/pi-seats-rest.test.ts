/**
 * @module tests/fleet/pi-seats-rest
 * @description The Pi seat profiles for the remaining Paperclip agents
 *   (after the pilot). Each profile is run through
 *   `fleet/bin/pi-employee` against a fake `pi`, so it passes the launcher's
 *   own validation and its extensions resolve. Only the allowed writers carry
 *   write/edit (four-writer rule). No profile names a model: the board's model
 *   is the one selector, served live by the fleet-proxy-models extension.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const FLEET = resolve(import.meta.dir, "../../fleet");
const LAUNCHER = join(FLEET, "bin", "pi-employee");
const PIN = JSON.parse(readFileSync(join(FLEET, "pi", "versions.json"), "utf8"))[
	"@earendil-works/pi-coding-agent"
] as string;

const SEATS = [
	"simms",
	"ski",
	"giraud",
	"kapoor",
	"frey",
	"greene",
	"nagatha",
	"colter",
	"czajka",
	"grudzien",
	"jarrett",
	"kong",
	"reed",
	"friedlander",
	"perkins",
	"desai",
	"chotek",
	"nagatha-ops",
	"combot-a",
];
// Four-writer rule: only these seats change code (Bishop is a pilot seat).
// Nagatha's juniors, Combot C (profile nagatha-ops) and Combot A, open PRs.
const WRITERS = new Set(["nagatha", "nagatha-ops", "combot-a"]);
const READ_ONLY = ["read", "grep", "find", "ls", "bash"];
const WRITER = [...READ_ONLY, "write", "edit"];

let scratch = "";
let fakePi = "";

beforeAll(() => {
	scratch = mkdtempSync(join(testTmpBase(), "pi-seats-rest-"));
	fakePi = join(scratch, "fake-pi");
	writeFileSync(
		fakePi,
		`#!/bin/sh\nif [ "$1" = "--version" ]; then echo "pi ${PIN}"; exit 0; fi\nprintf '%s\\n' "$@" > "$FAKE_PI_OUT"\nprintf '%s\\n' "$PI_CODING_AGENT_DIR" > "$FAKE_PI_OUT.agentdir"\n`,
	);
	chmodSync(fakePi, 0o755);
});
afterAll(() => {
	if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function profileOf(seat: string): {
	tools: string[];
	extensions: string[];
} {
	return JSON.parse(readFileSync(join(FLEET, "pi", "profiles", `${seat}.json`), "utf8"));
}

describe("remaining seat profiles", () => {
	for (const seat of SEATS) {
		test(`${seat}: the launcher accepts it; live catalog then fleet-guard first; tools passed through`, async () => {
			const out = join(scratch, `argv-${seat}.txt`);
			const p = Bun.spawn([LAUNCHER, "--mode", "json", "--tools", "read,write", "-p", "go"], {
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

	test("only the allowed writers carry write/edit", () => {
		for (const seat of SEATS) {
			const tools = profileOf(seat).tools;
			if (WRITERS.has(seat)) expect(tools).toEqual(WRITER);
			else expect(tools).toEqual(READ_ONLY);
		}
	});

	test("no profile names a model or family: the board's model is the selector", () => {
		for (const seat of SEATS) expect(Object.keys(profileOf(seat))).not.toContain("models");
	});
});

// Nagatha's juniors: Combot C (board key
// infra-ops, login sf-nagatha-ops, profile nagatha-ops) and Combot A (board key
// infra-ops-claude, profile combot-a) carry the writer tools so they can open
// PRs. sf#1742 review P2 still holds: each is its own seat, never Nagatha's
// agentDir.
const JUNIORS: [string, string][] = [
	["nagatha-ops", "infra-ops"],
	["combot-a", "infra-ops-claude"],
];
describe.each(JUNIORS)("%s: a dedicated writer seat under Nagatha", (seat, boardKey) => {
	const EXTENSIONS = [
		"pi-extensions/fleet-guard/index.ts",
		"pi-extensions/langfuse-trace/index.ts",
	];

	async function launch(employee: string) {
		const out = join(scratch, `ops-argv-${employee}.txt`);
		const p = Bun.spawn([LAUNCHER, "--mode", "json", "--tools", "read", "-p", "go"], {
			env: {
				PATH: process.env.PATH ?? "",
				HOME: scratch,
				PI_EMPLOYEE_FLEET_ROOT: FLEET,
				PI_EMPLOYEE_PI_BIN: fakePi,
				FLEET_EMPLOYEE: employee,
				FAKE_PI_OUT: out,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const [stderr, code] = await Promise.all([new Response(p.stderr).text(), p.exited]);
		return { stderr, code, out };
	}

	test("the launcher accepts the pinned Pi: writer tools, own agentDir, guard then trace", async () => {
		const r = await launch(seat);
		expect(r.stderr).toBe("");
		expect(r.code).toBe(0);
		const argv = readFileSync(r.out, "utf8").trim().split("\n");
		expect(argv.slice(0, 7)).toEqual([
			"-ne",
			"-e",
			join(FLEET, "pi-extensions", "fleet-proxy-models", "index.ts"),
			...EXTENSIONS.flatMap((e) => ["-e", join(FLEET, e)]),
		]);
		// The adapter asked for read only; the profile replaces it with the writer set.
		expect(argv.filter((a) => a === "--tools")).toHaveLength(1);
		expect(argv[argv.indexOf("--tools") + 1]).toBe(WRITER.join(","));
		expect(readFileSync(`${r.out}.agentdir`, "utf8").trim()).toBe(
			join(scratch, ".pi", "seats", seat),
		);
	});

	test("the profile is its own: writer tools, own agentDir, never Nagatha's", () => {
		const ops = profileOf(seat) as { tools: string[]; extensions: string[]; agentDir?: string };
		expect(ops).toEqual({ tools: WRITER, extensions: EXTENSIONS, agentDir: `~/.pi/seats/${seat}` });
		const nagatha = profileOf("nagatha") as { agentDir?: string };
		expect(ops.agentDir).not.toBe(nagatha.agentDir ?? "~/.pi/seats/nagatha");
	});

	test("the board key is not a second identity: it has no profile and is refused", async () => {
		const r = await launch(boardKey);
		expect(r.code).toBe(3);
		expect(r.stderr).toContain(`${boardKey}.json: not found`);
	});
});
