import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { renderRecordTable, formatWall } from "../../scripts/fh/actions-record";

const SCRIPT = `${import.meta.dir}/../../scripts/fh/actions-record.ts`;

const task = (id: number, name: string, created: string, updated: string) => ({
	id,
	name,
	run_number: id + 100,
	status: "success",
	head_sha: "abcdef0123456789",
	display_title: `title ${id}`,
	created_at: created,
	updated_at: updated,
	url: `https://forge.example/runs/${id + 100}`,
});

const TASKS = [
	task(1, "review", "2026-09-01T00:00:00Z", "2026-09-01T00:01:05Z"),
	task(3, "triage", "2026-09-03T00:00:00Z", "2026-09-03T00:12:00Z"),
	task(2, "review", "2026-09-02T00:00:00Z", "2026-09-02T00:00:09Z"),
];

describe("renderRecordTable", () => {
	test("newest first, header, sha7, link", () => {
		const lines = renderRecordTable(TASKS, {}).trim().split("\n");
		expect(lines[0]).toBe("| run | task | job | sha7 | status | wall | title |");
		expect(lines).toHaveLength(5);
		expect(lines[2]).toBe(
			"| [103](https://forge.example/runs/103) | 3 | triage | abcdef0 | success | 12m00s | title 3 |",
		);
		expect(lines[3]).toContain("| 2 |");
		expect(lines[4]).toContain("| 1 |");
	});
	test("wall formatting", () => {
		expect(formatWall("2026-09-01T00:00:00Z", "2026-09-01T00:01:05Z")).toBe("1m05s");
		expect(formatWall("x", "2026-09-01T00:01:05Z")).toBe("?");
	});
	test("filters by since and jobs", () => {
		const since = renderRecordTable(TASKS, { sinceIso: "2026-09-02T00:00:00Z" });
		expect(since).not.toContain("| 1 | review");
		expect(since).toContain("| 2 | review");
		const jobs = renderRecordTable(TASKS, { jobs: ["triage"] });
		expect(jobs).toContain("| 3 | triage");
		expect(jobs).not.toContain("review");
	});
	test("title pipes are escaped", () => {
		const t = {
			...task(4, "review", "2026-09-04T00:00:00Z", "2026-09-04T00:00:01Z"),
			display_title: "a|b",
		};
		expect(renderRecordTable([t], {})).toContain("a\\|b");
	});
});

describe("CLI", () => {
	let server: ReturnType<typeof Bun.serve>;
	beforeAll(() => {
		server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: (req) => {
				const path = new URL(req.url).pathname;
				if (path.includes("/prim/")) return Response.json({ workflow_runs: [1, null] });
				if (path.includes("/bad/")) return Response.json({ nope: true });
				if (path.includes("/deny/")) return new Response("no", { status: 401 });
				return Response.json({ workflow_runs: TASKS, total_count: 3 });
			},
		});
	});
	afterAll(() => server.stop(true));

	const run = async (repo: string, extra: string[] = []) => {
		const proc = Bun.spawn(["bun", SCRIPT, "--repo", repo, "--pages", "1", ...extra], {
			env: {
				...process.env,
				FORGEJO_TOKEN: "dummy",
				FH_API: `http://127.0.0.1:${server.port}/api/v1`,
			},
			stdout: "pipe",
			stderr: "pipe",
		});
		const code = await proc.exited;
		return {
			code,
			out: await new Response(proc.stdout).text(),
			err: await new Response(proc.stderr).text(),
		};
	};

	test("a malformed body or an unparseable --since exits 3 with a reason", async () => {
		const r = await run("o/bad");
		expect(r.code).toBe(3);
		expect(r.err).toContain("workflow_runs");
		// An unparseable --since exits 3 instead of filtering nothing.
		const since = await run("o/good", ["--since", "yesterday-ish"]);
		expect(since.code).toBe(3);
		expect(since.err).toContain("--since yesterday-ish is not an ISO date");
		expect(since.out).toBe("");
	});
	test("a primitive or null entry exits 3 naming the entry", async () => {
		const r = await run("o/prim");
		expect(r.code).toBe(3);
		expect(r.err).toContain("entry");
		expect(r.out).toBe("");
	});
	test("non-2xx exits 3", async () => {
		const r = await run("o/deny");
		expect(r.code).toBe(3);
		expect(r.err).toContain("401");
	});
	test("good body prints the table", async () => {
		const r = await run("o/good");
		expect(r.code).toBe(0);
		expect(r.out).toContain("| run | task |");
	});
});
