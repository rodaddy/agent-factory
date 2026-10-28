/**
 * @module tests/fleet/forge-pr-merge-sweep
 * @description sf#1730. The forge-pr sweep files the missing Merge task for an
 *   approved head (Chang, high), once, capped per tick, never for an older head,
 *   and runSweep reaches heads it has already seen. The verdict itself is
 *   tests/fleet/forge-pr-merge-verdict.test.ts.
 */
import { describe, expect, test } from "bun:test";
import { fileMergeTasks, MERGE_CAP, runSweep } from "../../fleet/plugins/forge-pr/sweep.js";

const repo = "rodaddy/demo";
const SHA = "a".repeat(40);
const OLD = "b".repeat(40);
const url = (n: number) => `https://forge.example.internal/${repo}/pulls/${n}`;
const head = (n: number, sha = SHA) => ({ repo, number: n, headSha: sha, url: url(n) });
const SEATS: Record<string, string> = {
	"sf-chang": "ag-chang",
	"sf-smythe": "ag-smythe",
	"sf-adams": "ag-adams",
	"sf-czajka": "ag-czajka",
};
type Issue = {
	id: string;
	identifier?: string;
	title: string;
	status: string;
	description?: string;
};
type Comment = { id: string; authorAgentId: string; body: string; createdAt: string };
type Created = {
	task: { title: string; description: string; assigneeAgentId: string; priority?: string };
	repo?: string;
};
const review = (n: number, sha: string, id: string): Issue => ({
	id,
	identifier: `SOF-${id}`,
	title: `Review ${repo}#${n} @ ${sha.slice(0, 7)}`,
	status: "done",
	description: `PR: ${url(n)}\nHead SHA: \`${sha}\``,
});
const said = (n: number, sha: string, verdict: string, at = "2026-10-07T10:00:00Z"): Comment => ({
	id: `c-${n}-${verdict}-${at}`,
	authorAgentId: "ag-adams",
	body: `## Review of ${repo}#${n} at ${sha.slice(0, 7)}\n\nverdict: ${verdict}\n`,
	createdAt: at,
});

const harness = (issues: Issue[], comments: Record<string, Comment[]> = {}) => {
	const state = new Map<string, unknown>();
	const created: Created[] = [];
	const deps = {
		companyId: "co",
		stateGet: async (k: string) => state.get(k) ?? null,
		stateSet: async (k: string, v: unknown) => void state.set(k, v),
		// As the installed host answers: the SDK drops `q`, so the
		// lookup is by the PR (origin/project); every task of the PR comes back.
		listIssues: async (_q: string, r?: string, n?: number) =>
			issues.filter((i) => r !== undefined && i.title.includes(` ${r}#${n} `)),
		listComments: async (id: string) => comments[id] ?? [],
		findAgent: async (login: string) => SEATS[login] ?? null,
		createTask: async (task: Created["task"], r?: string) => {
			created.push({ task, repo: r });
			const { title, description } = task;
			issues.push({ id: `new-${created.length}`, title, description, status: "todo" });
			return { id: `new-${created.length}` };
		},
		log: (_l: string) => {},
	};
	return { deps, created, state };
};

describe("the sweep files the missing Merge task", () => {
	for (const verdict of ["approve", "approve-with-fixes"]) {
		test(`an ${verdict} head with no Merge task gets one, Chang, high`, async () => {
			const h = harness([review(5, SHA, "r5")], { r5: [said(5, SHA, verdict)] });
			expect(await fileMergeTasks(h.deps, [head(5)])).toBe(1);
			expect(h.created.length).toBe(1);
			const c = h.created[0];
			expect(c?.repo).toBe(repo);
			expect(c?.task.title).toBe(`Merge ${repo}#5 @ aaaaaaa`);
			expect(c?.task.assigneeAgentId).toBe("ag-chang");
			expect(c?.task.priority).toBe("high");
			expect(String(c?.task.description)).toContain(`verdict: ${verdict}`);
			// Once per head: the next tick files nothing.
			expect(await fileMergeTasks(h.deps, [head(5)])).toBe(0);
			expect(h.created.length).toBe(1);
		});
	}
	for (const status of ["done", "cancelled", "blocked"]) {
		test(`an existing Merge task (${status}) means none`, async () => {
			const merge = { id: "m", title: `Merge ${repo}#5 @ aaaaaaa`, status };
			const h = harness([review(5, SHA, "r5"), merge], { r5: [said(5, SHA, "approve")] });
			expect(await fileMergeTasks(h.deps, [head(5)])).toBe(0);
			expect(h.created).toEqual([]);
		});
	}
	test("a fix-first head gets none; a later fix-first beats an earlier approve", async () => {
		const h = harness([review(5, SHA, "r5"), review(6, SHA, "r6")], {
			r5: [said(5, SHA, "fix-first")],
			r6: [said(6, SHA, "approve"), said(6, SHA, "fix-first", "2026-10-07T11:00:00Z")],
		});
		expect(await fileMergeTasks(h.deps, [head(5), head(6)])).toBe(0);
		expect(h.created).toEqual([]);
	});
	test("an approve on an OLDER head gets none", async () => {
		const h = harness([review(5, OLD, "r-old"), review(5, SHA, "r-new")], {
			"r-old": [said(5, OLD, "approve")],
			"r-new": [],
		});
		expect(await fileMergeTasks(h.deps, [head(5)])).toBe(0);
		expect(h.created).toEqual([]);
	});
	test(`at most ${MERGE_CAP} Merge tasks per tick; the rest are filed next tick`, async () => {
		const ns = Array.from({ length: 12 }, (_, i) => i + 1);
		const h = harness(
			ns.map((n) => review(n, SHA, `r${n}`)),
			Object.fromEntries(ns.map((n) => [`r${n}`, [said(n, SHA, "approve")]])),
		);
		const heads = ns.map((n) => head(n));
		expect(MERGE_CAP).toBe(10);
		expect(await fileMergeTasks(h.deps, heads)).toBe(10);
		expect(await fileMergeTasks(h.deps, heads)).toBe(2);
		expect(h.created.length).toBe(12);
	});
	test("one head that throws does not stop a later head; the failure is logged", async () => {
		const h = harness([review(5, SHA, "r5"), review(6, SHA, "r6")], {
			r6: [said(6, SHA, "approve")],
		});
		const logs: string[] = [];
		const deps = {
			...h.deps,
			log: (l: string) => void logs.push(l),
			listComments: async (id: string) => {
				if (id === "r5") throw new Error("board read failed");
				return h.deps.listComments(id);
			},
		};
		expect(await fileMergeTasks(deps, [head(5), head(6)])).toBe(1);
		expect(h.created.map((c) => c.task.title)).toEqual([`Merge ${repo}#6 @ aaaaaaa`]);
		expect(logs.some((l) => l.includes(`merge task failed ${repo}#5@`))).toBe(true);
	});
	test("runSweep: a head reviewed on one tick and approved before the next gets its Merge task", async () => {
		const BASE = "https://forge.invalid/api/v1";
		const fetch = async (u: string) => {
			const path = u.slice(BASE.length);
			let body: unknown = [];
			if (path.includes("type=pulls"))
				body = [{ number: 5, updated_at: "t1", repository: { full_name: repo }, pull_request: {} }];
			else if (path === `/repos/${repo}/pulls/5`)
				body = {
					number: 5,
					title: "t",
					html_url: url(5),
					user: { login: "operator" },
					head: { sha: SHA },
				};
			return new Response(JSON.stringify(body), { status: 200 });
		};
		const comments: Record<string, Comment[]> = {};
		const h = harness([], comments);
		const deps = {
			...h.deps,
			fetch,
			baseUrl: BASE,
			token: "t",
			repos: [repo],
			now: () => Date.parse("2026-10-07T00:00:00Z"),
			repoTier: async () => 1,
			listTitles: async () => [],
			cfg: { reviewerAgentId: "ag-smythe", triageAgentId: "t" },
		};
		await runSweep(deps);
		expect(h.created.map((c) => c.task.title)).toEqual([`Review ${repo}#5 @ aaaaaaa`]);
		// The lead approves on the board; the PR itself is unchanged (same updated_at).
		comments["new-1"] = [said(5, SHA, "approve")];
		await runSweep(deps);
		expect(h.created.map((c) => c.task.title)).toEqual([
			`Review ${repo}#5 @ aaaaaaa`,
			`Merge ${repo}#5 @ aaaaaaa`,
		]);
	});
});
