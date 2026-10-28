import { describe, expect, test } from "bun:test";
import { parsePullRequestEvent } from "../../fleet/plugins/forge-pr/logic.js";
import { reviewPrOnce } from "../../fleet/plugins/forge-pr/sweep.js";

// Code-only review: with codeOnlyReview on, each reviewer of a
// mixed PR is told which changed paths are docs and reviews only the rest.
const SHA = "a".repeat(40);
const BLOCK = "Docs, not reviewed (Rico 2026-10-07)";
const b64 = (s: string) => Buffer.from(s).toString("base64");

// A file at head: [path, mode, first line].
type F = [string, string, string];
function harness(files: F[], over: Record<string, unknown> = {}, ignore: string | null = null) {
	const created: Array<{ title: string; description: string }> = [];
	const logs: string[] = [];
	const state = new Map<string, unknown>();
	const forgeGet = async (path: string) => {
		const m = path.match(/^\/repos\/rodaddy\/demo\/contents\/(.+)\?ref=(.+)$/);
		if (m?.[1] === ".factoryignore") {
			if (ignore == null) throw Object.assign(new Error("nf"), { reason: "404" });
			return { type: "file", content: b64(ignore), encoding: "base64" };
		}
		const f = files.find(([p]) => p === decodeURIComponent(m?.[1] ?? ""));
		if (f) return { content: b64(`${f[2]}\nbody\n`), encoding: "base64" };
		if (path.startsWith("/repos/rodaddy/demo/git/trees/"))
			return { tree: files.map(([p, mode]) => ({ path: p, mode, type: "blob" })) };
		throw new Error(`unrouted ${path}`);
	};
	const deps = {
		cfg: {
			reviewerAgentId: "rev",
			triageAgentId: "tri",
			pairReview: true as boolean,
			codeOnlyReview: true as boolean,
		},
		listTitles: async () => created.map((t) => t.title),
		postComment: async () => undefined,
		stateGet: async (k: string) => state.get(k) ?? null,
		stateSet: async (k: string, v: unknown) => void state.set(k, v),
		log: (l: string) => void logs.push(l),
		createTask: async (task: (typeof created)[number]) => {
			created.push(task);
			return { id: `new-${created.length}` };
		},
		seatLoad: async () =>
			new Map([
				["g", 0],
				["c", 0],
			]),
		seatsOf: async () =>
			new Map([
				[
					"sf-giraud",
					{
						id: "g",
						status: "idle",
						adapterType: "pi_local",
						adapterConfig: { model: "fleet-proxy/claude-sonnet-5-5", thinking: "medium" },
					},
				],
				[
					"sf-colter",
					{
						id: "c",
						status: "idle",
						adapterType: "pi_local",
						adapterConfig: { model: "fleet-proxy/gpt-6.1-sol", thinking: "low" },
					},
				],
			]),
		listFiles: async () => files.map(([filename]) => ({ filename, additions: 1, deletions: 0 })),
		forgeGet,
		...over,
	};
	return { deps, created, logs };
}
const ev = () => {
	const F3 = "```";
	const e = parsePullRequestEvent(
		{ "x-forgejo-event": "pull_request" },
		{
			action: "opened",
			number: 7,
			repository: { full_name: "rodaddy/demo" },
			pull_request: {
				head: { sha: SHA },
				base: { ref: "main" },
				html_url: "https://forge.example.internal/rodaddy/demo/pulls/7",
				title: "Mixed",
				body: `## Test plan\n${F3}\nbun test\n${F3}\n\n## Backout\nRevert it.\n`,
				user: { login: "rico" },
			},
		},
		["rodaddy/demo"],
	);
	if (!e) throw new Error("fixture must parse");
	return e;
};
// The doc paths listed in a task description, in order.
const listed = (d: string) =>
	d
		.slice(d.indexOf(BLOCK))
		.split("\n")
		.filter((l) => l.startsWith("- `"))
		.map((l) => l.slice(3, -1));

const MIXED: F[] = [
	["src/a.ts", "100644", "export {}"],
	["_DOCS/x.md", "100644", "# X"],
	["README.md", "100644", "# Demo"],
];

describe("reviewers of a mixed PR get the docs to skip (codeOnlyReview)", () => {
	test("both pair tasks list exactly the doc paths, sorted", async () => {
		const h = harness(MIXED);
		expect((await reviewPrOnce(h.deps, ev())).outcome).toBe("created");
		expect(h.created).toHaveLength(2);
		for (const t of h.created) {
			expect(t.description).toContain(BLOCK);
			expect(listed(t.description)).toEqual(["README.md", "_DOCS/x.md"]);
		}
	});

	test("refused names, an executable .md and a shebang .md are never listed", async () => {
		const files: F[] = [
			["src/a.ts", "100644", "export {}"],
			["fleet/skills/foo/SKILL.md", "100644", "# Skill"],
			["fleet/agents/x/AGENTS.md", "100644", "# Agent"],
			["docs/run.md", "100755", "# Run"],
			["docs/sh.md", "100644", "#!/bin/sh"],
			["docs/ok.md", "100644", "# Ok"],
		];
		const h = harness(files, {}, "**/*.md\n");
		await reviewPrOnce(h.deps, ev());
		for (const t of h.created) expect(listed(t.description)).toEqual(["docs/ok.md"]);
	});

	test("switch off: no docs block", async () => {
		const h = harness(MIXED, {
			cfg: { reviewerAgentId: "rev", triageAgentId: "tri", pairReview: true },
		});
		await reviewPrOnce(h.deps, ev());
		expect(h.created).toHaveLength(2);
		for (const t of h.created) expect(t.description).not.toContain(BLOCK);
	});

	test("pairReview off: the legacy task has no docs block", async () => {
		const h = harness(MIXED, {
			cfg: { reviewerAgentId: "rev", triageAgentId: "tri", codeOnlyReview: true },
		});
		await reviewPrOnce(h.deps, ev());
		expect(h.created.map((t) => t.title)).toEqual(["Review rodaddy/demo#7 @ aaaaaaa"]);
		expect(h.created[0]?.description).not.toContain(BLOCK);
	});

	test("a Forge read error: full review, and the log line is written", async () => {
		const h = harness(MIXED, {
			forgeGet: async () => Promise.reject(Object.assign(new Error("x"), { reason: "502" })),
		});
		await reviewPrOnce(h.deps, ev());
		expect(h.created).toHaveLength(2);
		for (const t of h.created) expect(t.description).not.toContain(BLOCK);
		expect(h.logs).toContain(
			"forge-pr: docs list failed rodaddy/demo#7 @ aaaaaaa: 502 (full review)",
		);
	});

	test("over 200 doc paths: no docs block", async () => {
		const many: F[] = Array.from({ length: 201 }, (_, i) => [`_DOCS/d${i}.md`, "100644", "# D"]);
		const h = harness([["src/a.ts", "100644", "export {}"], ...many]);
		await reviewPrOnce(h.deps, ev());
		expect(h.created).toHaveLength(2);
		for (const t of h.created) expect(t.description).not.toContain(BLOCK);
	});
});
