/**
 * @module tests/fleet/ask-nagatha
 * @description `fleet/bin/ask-nagatha`, run as a real child process against a
 *   fake librarian and a fake Paperclip board (`Bun.serve`). The fake board's
 *   webhook files the issue with the plugin's own logic.js, so the CLI's issue
 *   lookup is checked against the title the plugin really writes.
 *   `ASK_NAGATHA_UNDER_TEST` points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { askTask, parseAsk } from "../../fleet/plugins/ask/logic.js";

const SCRIPT =
	process.env.ASK_NAGATHA_UNDER_TEST ?? resolve(import.meta.dir, "../../fleet/bin/ask-nagatha");
// Built at runtime so no credential-looking literal sits in the file.
const KEY = ["fake", "board", "key", String(Date.now())].join("-");
const TOKEN = ["fake", "ask", "token", String(Date.now() + 1)].join("-");
const COMPANY = "co-1";
const NAGATHA = "agent-nagatha";
const QUESTION = "where is the k3s SOP index?";

interface Issue {
	id: string;
	identifier: string;
	title: string;
	description: string;
	status: string;
	assigneeAgentId: string;
	createdAt: string;
}
interface Comment {
	id: string;
	issueId: string;
	body: string;
	authorAgentId: string | null;
}

let libHits: unknown[] = [];
let libRequests: { method: string; path: string; body: unknown }[] = [];
let boardRequests: { method: string; path: string; headers: Headers; body: unknown }[] = [];
let issues: Issue[] = [];
let comments: Comment[] = [];
/** Comment polls before Nagatha answers; -1 never. */
let answerAfter = 1;
let commentPolls = 0;
/** Issue-list calls that still miss a just-filed issue (the worker is slow). */
let hideNew = 0;
let pending: Issue[] = [];
/** Status the webhook files with; "done" means she answered and closed it fast. */
let newStatus = "todo";
let library: ReturnType<typeof Bun.serve>;
let board: ReturnType<typeof Bun.serve>;

function seed() {
	libHits = [];
	libRequests = [];
	boardRequests = [];
	issues = [];
	comments = [];
	answerAfter = 1;
	commentPolls = 0;
	hideNew = 0;
	pending = [];
	newStatus = "todo";
}

const hit = (score: number, file: string, line: number) => ({
	docid: "#abc",
	score,
	file: `qmd://Development/rtech-infra/${file}?index=development`,
	line,
	title: "k3s SOPs",
	snippet: "@@ -2,4 @@ (1 before, 210 after)\n**This index is generated**",
});

function newIssue(question: string, n: number): Issue {
	const task = askTask(parseAsk({ question, asker: "seed" }), { assigneeAgentId: NAGATHA });
	return {
		id: `iss-${n}`,
		identifier: `SOF-${2000 + n}`,
		...task,
		createdAt: new Date(Date.now() - (n === 0 ? 3_600_000 : 0)).toISOString(),
	};
}

beforeAll(() => {
	let polls = 0;
	library = Bun.serve({
		port: 0,
		async fetch(req) {
			const path = new URL(req.url).pathname;
			const body = req.method === "POST" ? await req.json() : undefined;
			libRequests.push({ method: req.method, path, body });
			if (req.method === "POST" && path === "/jobs") {
				polls = 0;
				return Response.json({ id: "job-1", lane: "query", position: 0 });
			}
			if (req.method === "GET" && path === "/jobs/job-1/result") {
				polls++;
				if (polls === 1) return Response.json({ state: "running" }, { status: 202 });
				const stdout = Buffer.from(JSON.stringify(libHits)).toString("base64");
				return Response.json({ state: "done", result: { exit_code: 0, stdout, stderr: "" } });
			}
			return new Response("nf", { status: 404 });
		},
	});
	board = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const path = url.pathname;
			const body = req.method === "POST" ? await req.json() : undefined;
			boardRequests.push({ method: req.method, path, headers: req.headers, body });
			if (req.method === "POST" && path === "/api/plugins/rodaddy.ask/webhooks/ask") {
				// The host answers {deliveryId, status} only; the worker's result is dropped.
				if (req.headers.get("x-ask-token") !== TOKEN)
					return Response.json(
						{ deliveryId: "d-1", status: "failed", error: "ask: token check failed" },
						{ status: 502 },
					);
				const ask = parseAsk(body);
				const issue = newIssue(ask.question, issues.length + pending.length + 1);
				issue.description = askTask(ask, { assigneeAgentId: NAGATHA }).description;
				issue.status = newStatus;
				pending.push(issue);
				return Response.json({ deliveryId: "d-1", status: "success" });
			}
			if (req.headers.get("authorization") !== `Bearer ${KEY}`)
				return new Response("no", { status: 401 });
			// An agent key may not read the board-admin plugin endpoints.
			if (path.startsWith("/api/plugins")) return new Response("forbidden", { status: 403 });
			if (path === `/api/companies/${COMPANY}/agents`)
				return Response.json([
					{ id: "agent-bishop", name: "Bishop" },
					{ id: NAGATHA, name: "Nagatha" },
				]);
			if (path === `/api/companies/${COMPANY}/issues`) {
				if (hideNew > 0) hideNew--;
				else issues.push(...pending.splice(0));
				const a = url.searchParams.get("assigneeAgentId");
				const s = url.searchParams.get("status");
				return Response.json(issues.filter((i) => i.assigneeAgentId === a && i.status === s));
			}
			const m = path.match(/^\/api\/issues\/([^/]+)\/comments$/);
			if (m) {
				commentPolls++;
				if (answerAfter >= 0 && commentPolls >= answerAfter && !comments.length) {
					comments.push(
						{
							id: "c1",
							issueId: m[1] as string,
							body: "ANSWER: not me",
							authorAgentId: "agent-bishop",
						},
						{
							id: "c2",
							issueId: m[1] as string,
							body: "ANSWER: the index is rtech-infra/_DOCS/sops/k3s/README.md:3",
							authorAgentId: NAGATHA,
						},
					);
				}
				return Response.json(comments.filter((c) => c.issueId === m[1]));
			}
			return new Response("nf", { status: 404 });
		},
	});
});
afterAll(() => {
	library.stop(true);
	board.stop(true);
});
beforeEach(seed);

async function run(args: string[], extra: Record<string, string> = {}) {
	const p = Bun.spawn([SCRIPT, ...args], {
		env: {
			PATH: process.env.PATH ?? "",
			HOME: "/nonexistent-ask-home",
			LIBRARIAN_URL: `http://127.0.0.1:${library.port}`,
			PAPERCLIP_API_URL: `http://127.0.0.1:${board.port}`,
			PAPERCLIP_API_KEY: KEY,
			PAPERCLIP_COMPANY_ID: COMPANY,
			ASK_TOKEN: TOKEN,
			ASK_POLL_SECONDS: "0.05",
			...extra,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	const all = stdout + stderr;
	expect(all).not.toContain(KEY);
	expect(all).not.toContain(TOKEN);
	return { stdout, stderr, code };
}

const json = (stdout: string) => JSON.parse(stdout.trim().split("\n").at(-1) as string);

describe("ask-nagatha", () => {
	test("--librarian-only answers from canon without touching the board", async () => {
		libHits = [hit(0.4, "x.md", 9), hit(0.9, "_DOCS/sops/k3s/README.md", 3)];
		const r = await run([QUESTION, "--librarian-only", "--json"]);
		expect(r.code).toBe(0);
		const out = json(r.stdout);
		expect(out.answered_by).toBe("librarian");
		expect(out.issue).toBeNull();
		expect(out.citations[0]).toBe("qmd://Development/rtech-infra/_DOCS/sops/k3s/README.md:3");
		expect(boardRequests.length).toBe(0);
		const job = libRequests.find((q) => q.method === "POST");
		expect(job?.path).toBe("/jobs");
		expect(job?.body).toEqual({
			job_class: "query",
			collection: "rtech-infra",
			cwd: "/opt/dev/rtech-infra",
			args: [
				"query",
				"--index",
				"development",
				"-c",
				"Development",
				"--path",
				"rtech-infra/",
				"--format",
				"json",
				"--",
				QUESTION,
			],
		});
		expect(libRequests.some((q) => q.path === "/search")).toBe(false);
	});

	test("human output carries path:line citations", async () => {
		libHits = [hit(0.9, "_DOCS/sops/k3s/README.md", 3)];
		const r = await run([QUESTION, "--librarian-only"]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("answered_by: librarian");
		expect(r.stdout).toContain("qmd://Development/rtech-infra/_DOCS/sops/k3s/README.md:3");
	});

	test("by default even a top-score hit goes to Nagatha with the hits attached (qmd scores are rank-based)", async () => {
		libHits = [hit(1.0, "_DOCS/sops/k3s/README.md", 3)];
		issues.push(newIssue(QUESTION, 0)); // an older ask of the same question
		hideNew = 9; // the before-list (7 calls) and the first find round miss the new issue
		const r = await run([QUESTION, "--json", "--asker", "tester"]);
		expect(r.code).toBe(0);
		const out = json(r.stdout);
		expect(out.answered_by).toBe("nagatha");
		expect(out.answer).toBe("ANSWER: the index is rtech-infra/_DOCS/sops/k3s/README.md:3");
		expect(out.citations).toEqual(["rtech-infra/_DOCS/sops/k3s/README.md:3"]);
		expect(out.issue.identifier).toBe("SOF-2002"); // not SOF-2000, the older ask
		expect(out.issue.url).toBe(`http://127.0.0.1:${board.port}/SOF/issues/SOF-2002`);
		const hook = boardRequests.find((q) => q.path.endsWith("/webhooks/ask"));
		expect(hook?.headers.get("x-ask-token")).toBe(TOKEN);
		expect(hook?.headers.get("authorization")).toBeNull();
		expect(hook?.headers.get("x-ask-company")).toBe(COMPANY);
		expect(boardRequests.some((q) => q.path.startsWith("/api/plugins") && q.method === "GET")).toBe(
			false,
		);
		expect(hook?.body).toEqual({
			question: QUESTION,
			asker: "tester",
			hits: [
				{
					path: "qmd://Development/rtech-infra/_DOCS/sops/k3s/README.md",
					line: 3,
					snippet: "@@ -2,4 @@ (1 before, 210 after)\n**This index is generated**",
				},
			],
		});
	});

	test("--direct skips the librarian", async () => {
		const r = await run(["--direct", QUESTION, "--json"]);
		expect(r.code).toBe(0);
		expect(json(r.stdout).answered_by).toBe("nagatha");
		expect(libRequests.length).toBe(0);
		const hook = boardRequests.find((q) => q.path.endsWith("/webhooks/ask"));
		expect(hook?.body).toMatchObject({ question: QUESTION, hits: [] });
	});

	test("an ask she already answered and closed is still found", async () => {
		newStatus = "done";
		const r = await run(["--direct", "--no-wait", QUESTION]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("filed for Nagatha: SOF-2001");
	});

	test("no PAPERCLIP_COMPANY_ID is exit 1 naming it", async () => {
		const r = await run(["--direct", QUESTION], { PAPERCLIP_COMPANY_ID: "" });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("set PAPERCLIP_COMPANY_ID");
	});

	test("--no-wait returns the identifier without polling comments", async () => {
		const r = await run(["--direct", "--no-wait", QUESTION]);
		expect(r.code).toBe(0);
		expect(r.stdout).toContain("filed for Nagatha: SOF-2001");
		expect(commentPolls).toBe(0);
	});

	test("no answer before --timeout exits 3 with the issue link", async () => {
		answerAfter = -1;
		const r = await run(["--direct", "--timeout", "0.5", QUESTION]);
		expect(r.code).toBe(3);
		expect(r.stdout).toContain(`/SOF/issues/SOF-2001`);
	});

	test("a refused token is exit 1 and names the refusal, not the token", async () => {
		const r = await run(["--direct", QUESTION], { ASK_TOKEN: `${TOKEN}-wrong` });
		expect(r.code).toBe(1);
		expect(r.stderr).toContain("HTTP 502");
		expect(r.stderr).toContain("token check failed");
		expect(issues.length).toBe(0);
	});

	test("an unreachable librarian is exit 1; bad usage is exit 2", async () => {
		const down = await run([QUESTION], { LIBRARIAN_URL: "http://127.0.0.1:9" });
		expect(down.code).toBe(1);
		expect(down.stderr).toContain("librarian unreachable");
		expect((await run([])).code).toBe(2);
		expect((await run([QUESTION, "--timeout", "nope"])).code).toBe(2);
	});
});
