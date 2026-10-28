/**
 * @module tests/fleet/task-route
 * @description `fleet/bin/task-route` (spread the work over the
 *   cheap seats), run as a real child process. Board state comes from a fake
 *   `seat-load` written to a scratch dir and named by `TASK_ROUTE_SEAT_LOAD`; it
 *   prints fixed JSON lines (the board reads are tested in seat-load.test.ts).
 *   The roster reaches the script as `--file /dev/stdin`.
 *   `TASK_ROUTE_UNDER_TEST` points the suite at a mutated copy.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.TASK_ROUTE_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/task-route");

type Seat = { name: string; status: string; model: string | null; skills: string[]; open: number };
const LUNA = "fleet-proxy/gpt-6-luna";
const SOL = "fleet-proxy/gpt-6.1-sol";
const HAIKU = "fleet-proxy/claude-haiku-5";
const SONNET = "fleet-proxy/claude-sonnet-5-5";
const OPUS = "fleet-proxy/claude-opus-5-5";

const SEATS: Seat[] = [
	// tier: a loaded tier-1 seat beats an idle tier-2 seat
	{ name: "Busy Luna", status: "running", model: LUNA, skills: ["s-tier"], open: 3 },
	{ name: "Idle Sonnet", status: "idle", model: SONNET, skills: ["s-tier"], open: 0 },
	// load inside one tier
	{ name: "Two", status: "idle", model: LUNA, skills: ["s-load"], open: 2 },
	{ name: "One", status: "idle", model: LUNA, skills: ["s-load"], open: 1 },
	// name breaks a tie (Bravo listed first)
	{ name: "Bravo", status: "idle", model: LUNA, skills: ["s-tie"], open: 0 },
	{ name: "Alpha", status: "idle", model: LUNA, skills: ["s-tie"], open: 0 },
	// paused and excluded seats
	{ name: "Paused", status: "paused", model: LUNA, skills: ["s-pause"], open: 0 },
	{ name: "Author", status: "idle", model: LUNA, skills: ["s-pause"], open: 0 },
	{ name: "Loaded Sol", status: "idle", model: SOL, skills: ["s-pause"], open: 5 },
	// opus only when marked
	{ name: "Opus Seat", status: "idle", model: OPUS, skills: ["s-opus", "s-opus-only"], open: 0 },
	{ name: "Sonnet Seat", status: "idle", model: SONNET, skills: ["s-opus"], open: 4 },
	// family
	{ name: "Haiku Seat", status: "idle", model: HAIKU, skills: ["s-fam"], open: 0 },
	{ name: "Sol Seat", status: "idle", model: SOL, skills: ["s-fam"], open: 3 },
	// review pair: second call, gpt minus the author and the first reviewer
	{ name: "Pair Haiku", status: "idle", model: HAIKU, skills: ["s-pair"], open: 0 },
	{ name: "Pair Author", status: "idle", model: LUNA, skills: ["s-pair"], open: 0 },
	{ name: "Pair First", status: "idle", model: LUNA, skills: ["s-pair"], open: 1 },
	{ name: "Pair Sol", status: "idle", model: SOL, skills: ["s-pair"], open: 6 },
	// every holder unusable
	{ name: "Broken", status: "error", model: LUNA, skills: ["s-down"], open: 0 },
	{ name: "Gone", status: "terminated", model: LUNA, skills: ["s-down"], open: 0 },
	// unknown model counts as expensive
	{ name: "Mystery", status: "idle", model: null, skills: ["s-unknown"], open: 0 },
	{ name: "Known Sol", status: "idle", model: SOL, skills: ["s-unknown"], open: 9 },
];

const idOf = (name: string) => `agent-${name.toLowerCase().replace(/ /g, "-")}`;

// agents.json shape: keyed seats with name and skills. "Ghost" has no live agent.
const ROSTER = JSON.stringify(
	Object.fromEntries([
		...SEATS.map((s) => [idOf(s.name), { name: s.name, skills: s.skills }]),
		["ghost", { name: "Ghost", skills: ["s-down"] }],
	]),
);

// What seat-load prints: one line per board agent.
const SEAT_LINES = SEATS.map(({ skills, ...s }) => JSON.stringify({ id: idOf(s.name), ...s })).join(
	"\n",
);

let scratch = "";
let fakeSeatLoad = "";
let forge: ReturnType<typeof Bun.serve>;
const source = "https://forge.example.internal/rodaddy/demo/issues/70002102";
const complete =
	"## Files to read\nsrc/app.ts\n## Files to change\nsrc/app.ts\n## Acceptance\n```sh\nbun test\n```\nExpected: exit 0\n## Non-goals\nDo not deploy.";
const heldComments: unknown[] = [];
const queued: unknown[] = [];

beforeAll(() => {
	forge = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/comments")) {
				if (req.method === "POST") heldComments.push(await req.json());
				return Response.json(req.method === "POST" ? {} : heldComments);
			}
			if (path.includes("/companies/")) {
				if (req.method === "POST") queued.push(await req.json());
				return Response.json(req.method === "POST" ? { id: "write-spec" } : queued);
			}
			return Response.json({
				body: path.endsWith("/8") ? "## Files to read\nsrc/app.ts" : complete,
			});
		},
	});
	scratch = mkdtempSync(join(testTmpBase(), "task-route-"));
	fakeSeatLoad = join(scratch, "seat-load");
	const fail = `if [ -n "$FAKE_EXIT" ]; then echo "seat-load: board unreachable" >&2; exit "$FAKE_EXIT"; fi`;
	writeFileSync(fakeSeatLoad, `#!/bin/sh\n${fail}\ncat <<'EOF'\n${SEAT_LINES}\nEOF\n`);
	chmodSync(fakeSeatLoad, 0o755);
});
afterAll(() => {
	forge.stop(true);
	if (scratch) renameSync(scratch, join(testArchiveDir(), scratch.split("/").at(-1) as string));
});

async function run(args: string[], extra: Record<string, string> = {}, roster = ROSTER) {
	const p = Bun.spawn([SCRIPT, "--file", "/dev/stdin", "--issue", source, ...args], {
		env: {
			PATH: process.env.PATH ?? "",
			TASK_ROUTE_SEAT_LOAD: fakeSeatLoad,
			FORGEJO_API_URL: `${forge.url}api/v1`,
			FORGEJO_TOKEN: "fake-forge",
			PAPERCLIP_API_URL: String(forge.url),
			PAPERCLIP_BOARD_TOKEN: "fake-board",
			PAPERCLIP_COMPANY_ID: "demo",
			RTECH_TEMP_ROOT: scratch,
			...extra,
		},
		stdin: new Blob([roster]),
		stdout: "pipe",
		stderr: "pipe",
	});
	const out = Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
	const [[stdout, stderr], code] = await Promise.all([out, p.exited]);
	return { stdout, stderr, code };
}

function picked(stdout: string) {
	const lines = stdout.trim().split("\n");
	expect(lines.length).toBe(1);
	return JSON.parse(lines[0] ?? "") as { model: string | null } & Record<string, unknown>;
}

describe("task-route picks the cheapest qualified, least-loaded seat", () => {
	test("a loaded tier-1 seat beats an idle tier-2 seat", async () => {
		const r = await run(["--skill", "s-tier"]);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toEqual({
			agentId: idOf("Busy Luna"),
			name: "Busy Luna",
			model: LUNA,
			tier: 1,
			load: 3,
		});
		expect(r.stderr).toBe("");
	});

	test("the least-loaded seat inside one tier", async () => {
		const r = await run(["--skill", "s-load"]);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toMatchObject({ name: "One", load: 1, tier: 1 });
	});

	test("name breaks a tie", async () => {
		const r = await run(["--skill", "s-tie"]);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toMatchObject({ name: "Alpha", load: 0 });
	});
});

describe("task-route never picks a paused or excluded seat", () => {
	test("paused is skipped, --exclude (any case) is skipped, the loaded sol seat is picked", async () => {
		const r = await run(["--skill", "s-pause", "--exclude", "aUTHOR"]);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toMatchObject({ name: "Loaded Sol", tier: 2, load: 5 });
	});

	test("without the exclude the author is picked, proving the exclude did the work", async () => {
		const r = await run(["--skill", "s-pause"]);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toMatchObject({ name: "Author" });
	});

	test("error, terminated and no live agent: exit 1, all paused", async () => {
		const r = await run(["--skill", "s-down"]);
		expect(r.code).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("task-route: no seat holds s-down: all paused\n");
	});
});

describe("task-route picks Opus only when marked", () => {
	test("a cheaper seat wins over an idle opus seat", async () => {
		const r = await run(["--skill", "s-opus"]);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toMatchObject({ name: "Sonnet Seat", tier: 2, load: 4 });
		expect(r.stderr).toBe("");
	});

	test("only opus holds the skill: picked, with the fallback line on stderr", async () => {
		const r = await run(["--skill", "s-opus-only"]);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toMatchObject({ name: "Opus Seat", tier: 3, model: OPUS });
		expect(r.stderr).toBe("task-route: fallback: no cheaper seat holds s-opus-only\n");
	});

	test("--needs-opus keeps only the opus seat", async () => {
		const r = await run(["--skill", "s-opus", "--needs-opus"]);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toMatchObject({ name: "Opus Seat", tier: 3 });
	});

	test("an unknown model is tier 3: the loaded sol seat wins", async () => {
		const r = await run(["--skill", "s-unknown"]);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toMatchObject({ name: "Known Sol", tier: 2, load: 9 });
	});
});

describe("task-route --family", () => {
	test("gpt never returns a claude model, even a cheaper one", async () => {
		const r = await run(["--skill", "s-fam", "--family", "gpt"]);
		expect(r.code).toBe(0);
		const got = picked(r.stdout);
		expect(got).toMatchObject({ name: "Sol Seat", tier: 2 });
		expect(got.model).not.toContain("claude");
	});

	test("anthropic keeps the claude seat", async () => {
		const r = await run(["--skill", "s-fam", "--family", "anthropic"]);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toMatchObject({ name: "Haiku Seat", tier: 1 });
	});

	test("gpt with two excludes returns the remaining gpt seat, never the cheaper claude one", async () => {
		const r = await run([
			"--skill",
			"s-pair",
			"--family",
			"gpt",
			"--exclude",
			"Pair Author",
			"--exclude",
			"pair first",
		]);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toMatchObject({ name: "Pair Sol", model: SOL, load: 6 });
	});

	test("a redacted board model (null) falls back to the roster's declared model", async () => {
		// Agent-scoped list reads return adapterConfig {}: seat-load prints model null.
		const redacted = join(scratch, "seat-load-redacted");
		const lines = ["R Haiku", "R Sol"].map((name) =>
			JSON.stringify({ id: idOf(name), name, status: "idle", model: null, open: 0 }),
		);
		writeFileSync(redacted, `#!/bin/sh\ncat <<'EOF'\n${lines.join("\n")}\nEOF\n`);
		chmodSync(redacted, 0o755);
		const roster = JSON.stringify({
			"r-haiku": { name: "R Haiku", skills: ["s-red"], model: HAIKU },
			"r-sol": { name: "R Sol", skills: ["s-red"], model: SOL },
		});
		const r = await run(
			["--skill", "s-red", "--family", "gpt"],
			{ TASK_ROUTE_SEAT_LOAD: redacted },
			roster,
		);
		expect(r.code).toBe(0);
		expect(picked(r.stdout)).toMatchObject({ name: "R Sol", model: SOL, tier: 2 });
	});

	test("gpt over a claude-only skill is exit 1", async () => {
		const r = await run(["--skill", "s-opus-only", "--family", "gpt"]);
		expect(r.code).toBe(1);
		expect(r.stdout).toBe("");
	});
});

describe("task-route exit grammar", () => {
	test("unknown skill: exit 1, no seat holds", async () => {
		const r = await run(["--skill", "no-such-skill"]);
		expect(r.code).toBe(1);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("task-route: no seat holds no-such-skill\n");
	});

	test("seat-load exits 3: task-route exits 3 and passes its stderr through", async () => {
		const r = await run(["--skill", "s-tier"], { FAKE_EXIT: "3" });
		expect(r.code).toBe(3);
		expect(r.stdout).toBe("");
		expect(r.stderr).toBe("seat-load: board unreachable\n");
	});

	test("bad usage: exit 2", async () => {
		expect((await run(["--bogus"])).code).toBe(2);
		expect((await run([])).code).toBe(2);
		expect((await run(["--skill", "s-tier", "--family", "llama"])).code).toBe(2);
	});

	test("unreadable agents.json: exit 2 before seat-load runs", async () => {
		const r = await run(["--skill", "s-tier", "--file", "/nonexistent/agents.json"], {
			FAKE_EXIT: "3",
		});
		expect(r.code).toBe(2);
		expect(r.stderr).not.toContain("seat-load");
	});
});

test("incomplete source holds before seat-load and queues an unassigned spec", async () => {
	const result = await run(["--skill", "s-tier", "--issue", source.replace("/70002102", "/8")], {
		FAKE_EXIT: "3",
	});
	expect(result.code).toBe(1);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("spec-ready held");
	expect(result.stderr).not.toContain("board unreachable");
	expect(heldComments).toHaveLength(1);
	expect(queued).toHaveLength(1);
	expect(queued[0]).toMatchObject({ status: "backlog", originKind: "spec-ready" });
	expect(queued[0]).not.toHaveProperty("assigneeAgentId");
});
