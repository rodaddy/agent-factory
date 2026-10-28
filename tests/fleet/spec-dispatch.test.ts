/** Real dispatch boundaries against local Forge/board fixtures; no live seats. */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkSpec } from "../../fleet/bin/spec-ready-lib.ts";
import { allowWorkTask } from "../../fleet/plugins/spec-dispatch.js";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const source = "https://forge.example.internal/rodaddy/demo/issues/70002103";
const complete =
	"## Files to read\nsrc/app.ts\n## Files to change\nsrc/app.ts\n## Acceptance\n```sh\nbun test\n```\nExpected: exit 0\n## Non-goals\nDo not deploy.";
let body = complete;
let comments: { body: string }[] = [];
let boardTasks: Record<string, unknown>[] = [];
const labels: { name: string }[] = [];
let server: ReturnType<typeof Bun.serve>;
let scratch: string;
let mutations = 0;
let prBody = "Closes #70002103";
let paged = false;
const previousBoardEnv = { ...process.env };
let previousApi: string | undefined;
let previousToken: string | undefined;
let previousTemp: string | undefined;

beforeAll(() => {
	scratch = mkdtempSync(join(testTmpBase(), "spec-dispatch-"));
	previousApi = process.env.FORGEJO_API_URL;
	previousToken = process.env.FORGEJO_TOKEN;
	previousTemp = process.env.RTECH_TEMP_ROOT;
	process.env.RTECH_TEMP_ROOT = scratch;
	server = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			if (path.endsWith("/comments")) {
				if (req.method === "POST") comments.push((await req.json()) as { body: string });
				return Response.json(req.method === "POST" ? {} : comments);
			}
			if (path === "/api/issues/proposed") {
				if (req.method !== "GET") mutations++;
				return Response.json({
					id: "proposed",
					title: "Triage feature",
					description: source,
					status: "backlog",
				});
			}
			if (path.includes("/companies/")) {
				if (paged && req.method === "GET")
					return Response.json(
						new URL(req.url).searchParams.get("offset") === "0"
							? Array.from({ length: 1000 }, () => ({ originKind: "other" }))
							: boardTasks,
					);
				if (req.method === "POST") boardTasks.push((await req.json()) as Record<string, unknown>);
				return Response.json(req.method === "POST" ? { id: "created" } : boardTasks);
			}
			if (path.endsWith("/pulls/5")) return Response.json({ body: prBody });
			if (path.endsWith("/issues/5"))
				return Response.json({ body: "PR body without spec", labels });
			return Response.json({ body, labels });
		},
	});
	process.env.FORGEJO_API_URL = `${server.url}api/v1`;
	process.env.FORGEJO_TOKEN = "fixture-forge";
});
afterAll(() => {
	server.stop(true);
	for (const key of ["PAPERCLIP_API_URL", "PAPERCLIP_COMPANY_ID", "PAPERCLIP_BOARD_TOKEN"]) {
		const value = previousBoardEnv[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
	if (previousTemp === undefined) delete process.env.RTECH_TEMP_ROOT;
	else process.env.RTECH_TEMP_ROOT = previousTemp;
	if (previousApi === undefined) delete process.env.FORGEJO_API_URL;
	else process.env.FORGEJO_API_URL = previousApi;
	if (previousToken === undefined) delete process.env.FORGEJO_TOKEN;
	else process.env.FORGEJO_TOKEN = previousToken;
	renameSync(scratch, join(testArchiveDir(), scratch.split("/").at(-1) as string));
});
const ctx = {
	config: { get: async () => null },
	secrets: { resolve: async () => "fixture-forge" },
	issues: {
		list: async () => boardTasks,
		create: async (task: Record<string, unknown>) => {
			boardTasks.push(task);
			return task;
		},
	},
};

test("complete authoritative source allows the implementation task", async () => {
	expect(
		await allowWorkTask(ctx, "demo", { title: "Implement feature", description: source }),
	).toBe(true);
	expect(comments).toHaveLength(0);
	expect(boardTasks).toHaveLength(0);
});

test("incomplete source is held once across concurrent retries with one unassigned spec", async () => {
	body = "## Files to read\nsrc/app.ts";
	const task = { id: "held", title: " Add feature", description: source };
	expect(
		await Promise.all([allowWorkTask(ctx, "demo", task), allowWorkTask(ctx, "demo", task)]),
	).toEqual([false, false]);
	expect(await allowWorkTask(ctx, "demo", task)).toBe(false);
	expect(comments).toHaveLength(1);
	expect(comments[0]?.body).toContain("Files to change");
	expect(comments[0]?.body).toContain("Acceptance commands and expected outcomes");
	expect(comments[0]?.body).toContain("Non-goals");
	expect(boardTasks).toHaveLength(1);
	expect(boardTasks[0]).toMatchObject({ status: "backlog", originKind: "spec-ready" });
	expect(boardTasks[0]).not.toHaveProperty("assigneeAgentId");
});

test("task-new refuses NEEDS_SPEC despite a complete local ticket before assigned POST", async () => {
	body = complete;
	comments = [{ body: "jev issue-implementable v1 (advisory): NEEDS_SPEC clarify ownership" }];
	boardTasks = [];
	const sections = [
		"Problem",
		"Scope",
		"Threat model",
		"Blast radius",
		"What it might break",
		"Backout",
		"Test plan",
	];
	const ticket = join(scratch, "ticket.md");
	writeFileSync(
		ticket,
		`# Implement feature\n${source}\n${complete}\n## Done means\n\`\`\`sh\nbun test\n\`\`\`\nExpected: exit 0\n## Must not\nDo not deploy.\n${sections.map((name) => `## ${name}\nConcrete fixture contract.`).join("\n")}\n`,
	);
	const child = Bun.spawn(
		[
			process.env.TASK_NEW_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/task-new"),
			"--file",
			ticket,
			"--assignee",
			"cheap-seat",
		],
		{
			env: {
				...process.env,
				PAPERCLIP_API_URL: String(server.url),
				PAPERCLIP_COMPANY_ID: "demo",
				PAPERCLIP_BOARD_TOKEN: "fixture-board",
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const stderr = await new Response(child.stderr).text();
	expect(await child.exited).toBe(1);
	expect(stderr).toContain("spec-ready held");
	expect(boardTasks).toHaveLength(1);
	expect(boardTasks[0]).toMatchObject({ status: "backlog", originKind: "spec-ready" });
	expect(boardTasks[0]).not.toHaveProperty("assigneeAgentId");
	expect(comments).toHaveLength(2);
	expect(comments[1]?.body).toContain("Jev issue-implementable NEEDS_SPEC");
});

test("rework resolves its linked PR to the unique implementation issue", async () => {
	body = complete;
	comments = [];
	boardTasks = [];
	prBody = `Closes [source](${source}). Related https://forge.example.internal/rodaddy/demo/issues/6`;
	expect(
		await allowWorkTask(ctx, "demo", {
			title: "Rework demo#5",
			description: "https://forge.example.internal/rodaddy/demo/pulls/5",
		}),
	).toBe(true);
	expect(comments).toHaveLength(0);
});
test("a stale source lock cannot permanently block a later check", async () => {
	body = complete;
	comments = [];
	boardTasks = [];
	const { createHash } = await import("node:crypto");
	const { mkdirSync } = await import("node:fs");
	const lock = join(
		scratch,
		"software-factory/spec-ready-locks",
		createHash("sha256").update(source).digest("hex"),
	);
	mkdirSync(lock, { recursive: true });
	const owner = Bun.spawn(
		[
			process.platform === "darwin" ? "/opt/homebrew/bin/flock" : "/usr/bin/flock",
			`${lock}.flock`,
			process.execPath,
			"-e",
			"process.stdout.write(String(process.pid)); setInterval(() => {}, 1000)",
		],
		{ stdout: "pipe", stderr: "pipe" },
	);
	const reader = owner.stdout.getReader();
	const pid = Number(new TextDecoder().decode((await reader.read()).value));
	expect(pid).toBeGreaterThan(0);
	process.kill(pid, "SIGKILL");
	await owner.exited;
	expect(
		await allowWorkTask(ctx, "demo", { title: "Implement feature", description: source }),
	).toBe(true);
});

test("seat-lib gates proposed PATCH title before any assignment or wake", async () => {
	body = "incomplete";
	comments = [];
	boardTasks = [];
	mutations = 0;
	process.env.PAPERCLIP_API_URL = String(server.url);
	process.env.PAPERCLIP_COMPANY_ID = "demo";
	process.env.PAPERCLIP_BOARD_TOKEN = "fixture-board";
	const { board } = await import("../../fleet/bin/seat-lib.ts");
	await expect(
		board("PATCH", "/issues/proposed", {
			title: "Add feature",
			status: "todo",
			assigneeAgentId: "cheap-seat",
		}),
	).rejects.toThrow("spec-ready held");
	expect(mutations).toBe(0);
	expect(boardTasks).toHaveLength(1);
});

test("seat-lib finds an existing spec on later board pages", async () => {
	paged = true;
	body = "incomplete";
	comments = [];
	mutations = 0;
	boardTasks = [{ originKind: "spec-ready", originId: `${source}:${checkSpec(body).bodyHash}` }];
	process.env.PAPERCLIP_API_URL = String(server.url);
	process.env.PAPERCLIP_COMPANY_ID = "demo";
	process.env.PAPERCLIP_BOARD_TOKEN = "fixture-board";
	const { board } = await import("../../fleet/bin/seat-lib.ts");
	await expect(
		board("PATCH", "/issues/proposed", { title: "Add feature", status: "todo" }),
	).rejects.toThrow("spec-ready held");
	expect(boardTasks).toHaveLength(1);
	paged = false;
});

test("generated CI diagnosis bypasses admission while its implementation handoff holds", async () => {
	body = "incomplete";
	comments = [];
	boardTasks = [];
	for (const title of "Checks not green: rodaddy/demo#5 @ abcdef0|Fleet audit daily|Fleet audit weekly|Fleet audit 2026-10-13 daily|Fleet audit finding: excessive retries|Resolve merge-check read failure on rodaddy/demo#5".split(
		"|",
	))
		expect(await allowWorkTask(ctx, "demo", { title })).toBe(true);
	expect(await allowWorkTask(ctx, "demo", { title: "Script it: x", description: source })).toBe(
		false,
	);
});
