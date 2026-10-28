import { describe, expect, test } from "bun:test";
import { parsePullRequestEvent, roundDecision } from "../../fleet/plugins/forge-pr/logic.js";
import * as P from "../../fleet/plugins/forge-pr/preflight.js";
import { reviewPrOnce, runSweep } from "../../fleet/plugins/forge-pr/sweep.js";

const F = "```";
const SHA = "c".repeat(40);
const KEY = `rodaddy/demo#7@${SHA}`;
const PLAN = `## Test plan\n${F}\nbun test\n${F}\n`;
const doc = (backout: string, plan = PLAN) =>
	`## Summary\nA thing.\n\n${plan}\n## Backout\n${backout}\n`;
const GOOD = doc("Revert the merge commit.");
const file = (filename: string, n: number) => ({ filename, additions: n, deletions: 0 });
const small = [file("src/a.ts", 5)];
const check = (body: string, files = small) => P.preflight({ body, files });
const fails = (...reasons: string[]) => ({ ok: false, reasons });
const RECEIPT = "big change without a rehearsal receipt";
const TOO_LARGE = (n: number) => `too large to review: ${n} added lines (at most 1200)`;
const RECEIPT_DOC = doc(`${F}\n$ revert\nok\n${F}`);

describe("preflight rules", () => {
	test("a small PR with both sections passes", () => expect(check(GOOD)).toEqual({ ok: true }));
	test("a missing, empty, or comment-only Backout fails", () => {
		for (const body of [`## Summary\nx\n\n${PLAN}`, doc(""), doc("<!-- how to undo -->\n  ")])
			expect(check(body)).toEqual(fails("missing backout plan"));
	});
	test("a missing Test plan, or one whose fenced block is empty, fails", () => {
		const emptyFence = doc("Revert it.", `## Test plan\nRan:\n${F}\n\n${F}\n`);
		for (const body of ["## Backout\nRevert it.\n", emptyFence])
			expect(check(body)).toEqual(fails("missing test plan"));
	});
	test("slices follow review-dispatch step 2: whole files, at most 400 lines each", () => {
		expect(P.sliceCount([file("a", 400), file("b", 1)])).toBe(2);
		expect(P.sliceCount(Array.from({ length: 9 }, (_, i) => file(`f${i}`, 1)))).toBe(1);
		const three = [file("a", 401), file("b", 401), file("c", 401)];
		expect(check(RECEIPT_DOC, three)).toEqual(fails(TOO_LARGE(1203)));
	});
	test("deletions never count: 50 added and 3000 deleted is 1 slice and passes", () => {
		const files = [{ filename: "src/a.ts", additions: 50, deletions: 3000 }];
		expect(P.sliceCount(files)).toBe(1);
		expect(check(GOOD, files)).toEqual({ ok: true });
	});
	test("only the total gates: over 1200 added lines is refused, slice count never is", () => {
		const four = [file("a", 400), file("b", 400), file("c", 400), file("d", 1)];
		expect(check(RECEIPT_DOC, four)).toEqual(fails(TOO_LARGE(1201)));
		expect(check(RECEIPT_DOC, [file("a", 1201)])).toEqual(fails(TOO_LARGE(1201)));
		expect(check(RECEIPT_DOC, [file("a", 400), file("b", 400), file("c", 400)])).toEqual({
			ok: true,
		});
		const fourSmall = [file("a", 201), file("b", 201), file("c", 201), file("d", 201)];
		expect(check(RECEIPT_DOC, fourSmall)).toEqual({ ok: true });
	});
	test("the too-large comment states its fix once", () => {
		const r = check(RECEIPT_DOC, [file("a", 400), file("b", 400), file("c", 400), file("d", 400)]);
		const out = P.preflightComment(r.ok ? [] : r.reasons);
		expect(out.split("split it into PRs").length - 1).toBe(1);
	});
	test("the big-change threshold: 400 lines pass, 401 fail without a receipt", () => {
		expect(P.BIG_CHANGE_LINES).toBe(400);
		const full = { filename: "src/a.ts", additions: 400, deletions: 400 };
		expect(check(GOOD, [full])).toEqual({ ok: true });
		expect(check(GOOD, [full, file("src/b.ts", 1)])).toEqual(fails(RECEIPT));
	});
	test("a risky path at 5 lines fails without a receipt, top-level or nested", () => {
		expect(P.RISKY_PATHS).toEqual(["migrations", "infra", "deploy", ".forgejo", "k8s"]);
		for (const p of ["deploy/app.yml", "apps/api/migrations/001.sql", ".forgejo/workflows/x.yml"])
			expect(check(GOOD, [file(p, 5)])).toEqual(fails(RECEIPT));
		expect(check(GOOD, [file("src/deployer.ts", 5)])).toEqual({ ok: true });
	});
	test("receipt forms: fence plus output, or a URL; a bare fence does not count", () => {
		const risky = [file("k8s/app.yaml", 5)];
		const output = doc(`Rehearsed:\n${F}\n$ kubectl rollout undo\nrolled back\n${F}`);
		expect(check(output, risky)).toEqual({ ok: true });
		expect(
			check(doc("Rehearsed: https://forge.example.internal/r/d/actions/runs/9"), risky),
		).toEqual({
			ok: true,
		});
		expect(check(doc(`Rehearsed:\n${F}\n$ kubectl rollout undo\n${F}`), risky)).toEqual(
			fails(RECEIPT),
		);
	});
	test("a heading inside a code fence is not a section", () => {
		const fenced = `## Summary\nExample body:\n${F}md\n## Backout\nRevert it.\n## Test plan\n${F}\n`;
		expect(check(fenced)).toEqual(fails("missing backout plan", "missing test plan"));
	});
	test("files past the read cap fail the preflight instead of going unread", async () => {
		const page = (n: number) => Array.from({ length: 50 }, (_, i) => file(`f${n}-${i}`, 0));
		let calls = 0;
		const files = await P.pullFiles(async () => page(++calls), "rodaddy/demo", 7);
		expect(calls).toBe(20);
		expect(check(GOOD, files)).toEqual(fails("too large to review: more than 1000 changed files"));
		const short = await P.pullFiles(async (p) => (p.endsWith("page=1") ? page(1) : []), "r/d", 7);
		expect(check(GOOD, short)).toEqual({ ok: true });
	});
});

const prJson = (prBody: string) => ({
	number: 7,
	head: { sha: SHA },
	html_url: "https://forge.example.internal/rodaddy/demo/pulls/7",
	title: "Add thing",
	body: prBody,
	user: { login: "rico" },
});
const parse = (prBody: string, action = "opened", changes = {}) => {
	const b = { action, changes, number: 7, repository: { full_name: "rodaddy/demo" } };
	const ev = parsePullRequestEvent(
		{ "x-forgejo-event": "pull_request" },
		{ ...b, pull_request: prJson(prBody) },
		["rodaddy/demo"],
	);
	if (!ev || (action === "edited" && !ev.bodyEdit)) throw new Error("fixture must parse");
	return ev;
};
const bodyEdit = (prBody: string) => parse(prBody, "edited", { body: { from: "x" } });

function harness(recorded?: unknown) {
	const state = new Map<string, unknown>(recorded ? [[KEY, recorded]] : []);
	const created: Array<{ title: string }> = [];
	const comments: string[] = [];
	const reads: number[] = [];
	const deps = {
		cfg: { reviewerAgentId: "rev", triageAgentId: "tri" },
		listTitles: async () => created.map((t) => t.title),
		postComment: async (_r: string, _n: number, b: string) => void comments.push(b),
		stateGet: async (k: string) => state.get(k) ?? null,
		stateSet: async (k: string, v: unknown) => void state.set(k, v),
		log: () => undefined,
		createTask: async (task: { title: string }) => {
			created.push(task);
			return { id: `new-${created.length}` };
		},
		listFiles: async () => {
			reads.push(1);
			return small;
		},
	};
	return { deps, state, created, comments, reads };
}

describe("preflight wiring in reviewPrOnce", () => {
	const failing = parse(doc(""));
	test("a fail posts one comment, creates no task, records the reasons", async () => {
		const h = harness();
		expect((await reviewPrOnce(h.deps, failing)).outcome).toBe("preflight");
		expect(h.created).toEqual([]);
		expect(h.comments).toHaveLength(1);
		expect(h.comments[0]?.startsWith("verdict: fix-first (preflight)")).toBe(true);
		expect(h.comments[0]).toContain("missing backout plan");
		const reasons = ["missing backout plan"];
		expect(h.state.get(KEY)).toEqual({ preflight: "failed", reasons, commented: true });
		// The board titles roundDecision counts hold no round for this head.
		expect(roundDecision(await h.deps.listTitles(), "rodaddy/demo", 7)).toBe("create");
		await reviewPrOnce(h.deps, failing); // same head, same failure: no second comment
		expect(h.comments).toHaveLength(1);
	});
	test("a body edit after the fix creates the review task", async () => {
		const h = harness();
		await reviewPrOnce(h.deps, failing);
		const r = await reviewPrOnce(h.deps, bodyEdit(GOOD));
		expect(r).toEqual({ key: KEY, outcome: "created", issueId: "new-1" });
		expect(h.created.map((t) => t.title)).toEqual([`Review rodaddy/demo#7 @ ${SHA.slice(0, 7)}`]);
		expect(h.state.get(KEY)).toEqual({ issueId: "new-1" });
	});
	test("a body edit on a normally reviewed head creates nothing", async () => {
		const h = harness({ issueId: "old" });
		expect((await reviewPrOnce(h.deps, bodyEdit(GOOD))).outcome).toBe("duplicate");
		expect(h.created).toEqual([]);
		expect(h.reads).toEqual([]);
	});
	test("a failed files read skips the preflight and reviews as before", async () => {
		const h = harness();
		h.deps.listFiles = async () => Promise.reject(Object.assign(new Error("x"), { reason: "502" }));
		expect((await reviewPrOnce(h.deps, failing)).outcome).toBe("created");
	});
});

test("the sweep reads the files on its path, posts fix-first, creates no review", async () => {
	const BASE = "https://x/api/v1";
	const posts: string[] = [];
	const created: unknown[] = [];
	const routes: Record<string, unknown> = {
		"/repos/issues/search?state=open&type=pulls&limit=50&page=1": [
			{ number: 7, updated_at: "u1", repository: { full_name: "rodaddy/demo" } },
		],
		"/repos/rodaddy/demo/pulls/7": prJson(doc("")),
		"/repos/rodaddy/demo/pulls/7/files?limit=50&page=1": small,
	};
	const fetch = async (url: string, init?: RequestInit) => {
		if (init?.method === "POST") posts.push(String(init.body));
		return Response.json(init?.method === "POST" ? {} : (routes[url.slice(BASE.length)] ?? []));
	};
	const state = new Map<string, unknown>();
	const r = await runSweep({
		...{ fetch, baseUrl: BASE, token: "t", repos: ["rodaddy/demo"], now: () => 0, preflight: true },
		stateGet: async (k) => state.get(k) ?? null,
		stateSet: async (k, v) => void state.set(k, v),
		createTask: async (t) => ({ id: String(created.push(t)) }),
		listTitles: async () => [],
		repoTier: async () => 1,
		cfg: { reviewerAgentId: "r", triageAgentId: "t" },
		log: () => undefined,
	});
	expect(r.stopped).toBe(false);
	expect(created).toEqual([]);
	expect(posts).toHaveLength(1);
	expect(posts[0]).toContain("verdict: fix-first (preflight)");
});

describe("the bar counts what forge-pr-open counts", () => {
	const SNAP = file("drizzle/meta/0031_snapshot.json", 5944);
	test("a drizzle snapshot is left out; 1300 code lines still fail", () => {
		expect(check(RECEIPT_DOC, [file("src/a.ts", 1084), SNAP])).toEqual({ ok: true });
		expect(check(RECEIPT_DOC, [file("src/a.ts", 1300), SNAP])).toEqual(
			fails(
				"too large to review: 1300 added lines (at most 1200; 5944 lockfile, doc or generated lines not counted)",
			),
		);
	});
	test("a lockfile and a doc are left out; a renamed doc still counts", () => {
		const files = [file("src/a.ts", 1100), file("bun.lock", 500), file("docs/a.md", 500)];
		expect(check(RECEIPT_DOC, files)).toEqual({ ok: true });
		const renamed = { ...file("docs/b.md", 200), status: "renamed" };
		const r = check(RECEIPT_DOC, [...files, renamed]);
		expect(r.ok ? [] : r.reasons[0]).toStartWith("too large to review: 1300 added lines");
	});
});

describe("GENERATED markers at the head in reviewPrOnce", () => {
	const blob = (path: string) => ({ path, type: "blob" });
	const routes: Record<string, unknown> = {
		[`/repos/rodaddy/demo/git/trees/${SHA}?recursive=true&per_page=1000&page=1`]: {
			tree: [blob("src/a.ts"), blob("gen/GENERATED"), blob("gen/api.json")],
		},
		[`/repos/rodaddy/demo/contents/gen/GENERATED?ref=${SHA}`]: marker(
			"# made by gen.ts\napi.json\n",
		),
	};
	function marker(text: string, size = Buffer.byteLength(text)) {
		return { encoding: "base64", size, content: Buffer.from(text).toString("base64") };
	}
	const withMarker = (m: unknown) => async (p: string) =>
		p.includes("/contents/") ? m : routes[p];
	const big = [file("src/a.ts", 1100), file("gen/api.json", 500)];
	const run = (forgeGet: (p: string) => Promise<unknown>) => {
		const h = harness();
		Object.assign(h.deps, { listFiles: async () => big, forgeGet });
		return reviewPrOnce(h.deps, parse(RECEIPT_DOC)).then((r) => ({ ...r, comments: h.comments }));
	};
	test("a GENERATED-listed file is left out of the count", async () => {
		const r = await run(async (p) => routes[p] ?? Promise.reject(new Error(`no route ${p}`)));
		expect(r.outcome).toBe("created");
	});
	test("a failed marker read counts every file", async () => {
		const r = await run(async (p) =>
			p.includes("/contents/")
				? Promise.reject(Object.assign(new Error("x"), { reason: "502" }))
				: routes[p],
		);
		expect(r.outcome).toBe("preflight");
		expect(r.comments[0]).toContain("too large to review: 1600 added lines");
	});
	test("a marker line that is not a bare name exempts nothing", async () => {
		const r = await run(withMarker(marker("api.json\n..\n")));
		expect(r.outcome).toBe("preflight");
		expect(r.comments[0]).toContain("too large to review: 1600 added lines");
	});
	test("a marker shorter than its size exempts nothing", async () => {
		const r = await run(withMarker(marker("api.json\n", 4096)));
		expect(r.outcome).toBe("preflight");
		expect(r.comments[0]).toContain("too large to review: 1600 added lines");
	});
	test("a tree over 1000 entries is read to total_count", async () => {
		// Live Forgejo shape: truncated on every page, the page past the end has no tree.
		const page = (n: number) =>
			`/repos/rodaddy/demo/git/trees/${SHA}?recursive=true&per_page=1000&page=${n}`;
		const filler = Array.from({ length: 998 }, (_, i) => blob(`src/f${i}.ts`));
		const paged: Record<string, unknown> = {
			[page(1)]: {
				tree: [blob("src/a.ts"), ...filler, blob("gen/api.json")],
				truncated: true,
				total_count: 1001,
			},
			[page(2)]: { tree: [blob("gen/GENERATED")], truncated: true, total_count: 1001 },
			[page(3)]: { tree: null, truncated: false, total_count: 1001 },
			[`/repos/rodaddy/demo/contents/gen/GENERATED?ref=${SHA}`]: marker("api.json\n"),
		};
		const r = await run(async (p) => paged[p] ?? Promise.reject(new Error(`no route ${p}`)));
		expect(r.outcome).toBe("created");
	});
	test("a tree read past total_count counts every file", async () => {
		// A server that ignores page serves page 1 again: 2000 entries read of 1500.
		const filler = Array.from({ length: 997 }, (_, i) => blob(`src/f${i}.ts`));
		const same = {
			tree: [blob("src/a.ts"), ...filler, blob("gen/GENERATED"), blob("gen/api.json")],
			truncated: true,
			total_count: 1500,
		};
		const r = await run(async (p) =>
			p.includes("/contents/")
				? marker("api.json\n")
				: p.includes("/git/trees/")
					? same
					: undefined,
		);
		expect(r.outcome).toBe("preflight");
		expect(r.comments[0]).toContain("too large to review: 1600 added lines");
	});
	test("a repeated tree page counts every file", async () => {
		// Pages 1 and 2 are the same 1000 entries: 2000 read equals total_count 2000.
		const filler = Array.from({ length: 997 }, (_, i) => blob(`src/f${i}.ts`));
		const same = {
			tree: [blob("src/a.ts"), ...filler, blob("gen/GENERATED"), blob("gen/api.json")],
			truncated: true,
			total_count: 2000,
		};
		const r = await run(async (p) =>
			p.includes("/contents/")
				? marker("api.json\n")
				: p.includes("/git/trees/")
					? same
					: undefined,
		);
		expect(r.outcome).toBe("preflight");
		expect(r.comments[0]).toContain("too large to review: 1600 added lines");
	});
});
