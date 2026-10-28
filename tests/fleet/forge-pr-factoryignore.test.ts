import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import * as FI from "../../fleet/plugins/forge-pr/factoryignore.js";
import { parsePullRequestEvent } from "../../fleet/plugins/forge-pr/logic.js";
import { reviewPrOnce } from "../../fleet/plugins/forge-pr/sweep.js";
import { testTmpBase } from "../support/test-temp";

const F = "```";
const SHA = "c".repeat(40);
const BODY = `## Test plan\n${F}\nbun test\n${F}\n\n## Backout\nRevert it.\n`;
const doc = (path: string, extra: Partial<FI.FileFacts> = {}) => ({
	path,
	mode: "100644",
	firstLine: "# A heading",
	...extra,
});
const run = (factoryignore: string | null, ...files: FI.FileFacts[]) =>
	FI.classify({ factoryignore, files });

describe("the non-code classifier", () => {
	test("each refused-set entry is refused even when .factoryignore lists it", () => {
		const refused = [
			".factoryignore",
			"fleet/skills/x/SKILL.md",
			"AGENTS.md",
			"docs/CLAUDE.md",
			"docs/prompt-notes.md",
			"fleet/hooks/notes.md",
			".forgejo/notes.md",
			".github/notes.md",
			"config.json",
			"bun.lock",
			"pnpm-lock.yaml",
		];
		const listed = ["*", ...refused].join("\n");
		for (const path of refused) {
			const v = run(listed, doc(path));
			expect(v.nonCode).toBe(false);
			expect(v.refused.map((r) => r.path)).toEqual([path]);
		}
		// The .factoryignore line that matches a refused path is named.
		expect(run("*\n_DOCS/**", doc("_DOCS/x/SKILL.md")).patterns).toEqual(["*", "_DOCS/**"]);
	});
	test("a shebang .txt and an executable .md are refused", () => {
		const v = run(
			"*",
			doc("notes/run.txt", { firstLine: "#!/bin/sh" }),
			doc("notes/a.md", { mode: "100755" }),
		);
		expect(v.nonCode).toBe(false);
		expect(v.refused).toEqual([
			{ path: "notes/run.txt", reason: "shebang" },
			{ path: "notes/a.md", reason: "executable bit" },
		]);
	});
	test("the built-in default applies with no .factoryignore", () => {
		expect(run(null, doc("_DOCS/a/b.md"), doc("README.md"), doc("_reports/x.md")).nonCode).toBe(
			true,
		);
		const v = run(null, doc("_DOCS/a.md"), doc("notes/a.md"));
		expect(v).toMatchObject({ nonCode: false, code: ["notes/a.md"] });
	});
	test("the pattern `*` plus a .ts edit is code", () => {
		const v = run("*", doc("README.md"), doc("src/a.ts", { firstLine: "export {};" }));
		expect(v).toMatchObject({ nonCode: false, code: ["src/a.ts"], refused: [] });
	});
	test("a file whose mode or first line is unknown is refused", () => {
		expect(run(null, doc("README.md", { mode: undefined })).nonCode).toBe(false);
		expect(run(null, doc("README.md", { firstLine: undefined })).nonCode).toBe(false);
	});
});

const b64 = (s: string) => Buffer.from(s).toString("base64");
const reject = (reason: string) => Promise.reject(Object.assign(new Error(reason), { reason }));

// One blob at one ref: its git mode and its text.
type Blob = { mode: string; body: string };
type Side = Record<string, Blob>;
type Changed = string | { filename: string; previous_filename?: string };
const DOC: Blob = { mode: "100644", body: "# Title\nbody\n" };
const nameOf = (c: Changed) => (typeof c === "string" ? c : c.filename);

// A PR changing `changed` on rodaddy/demo; base `main` holds baseIgnore and the
// head holds headIgnore as .factoryignore (null: no file). Each changed path is
// a plain doc at base and head unless sides says otherwise. ignoreReply
// replaces the base .factoryignore read.
function harness(
	changed: Changed[],
	baseIgnore: string | null,
	headIgnore: string | null = null,
	opts: { base?: Side; head?: Side; ignoreReply?: () => Promise<unknown> } = {},
) {
	const created: Array<{ title: string; assigneeAgentId: string; priority: string }> = [];
	const comments: string[] = [];
	const state = new Map<string, unknown>();
	const all = Object.fromEntries(changed.map((c) => [nameOf(c), DOC]));
	const sides: Record<string, Side> = {
		main: opts.base ?? all,
		[SHA]: opts.head ?? all,
	};
	const ignoreAt: Record<string, string | null> = { main: baseIgnore, [SHA]: headIgnore };
	const forgeGet = async (path: string) => {
		const m = path.match(/^\/repos\/rodaddy\/demo\/contents\/(.+)\?ref=(.+)$/);
		const ref = decodeURIComponent(m?.[2] ?? "");
		if (m?.[1] === ".factoryignore") {
			if (ref === "main" && opts.ignoreReply) return opts.ignoreReply();
			const text = ignoreAt[ref];
			return text == null ? reject("404") : { type: "file", content: b64(text) };
		}
		if (m) {
			const blob = sides[ref]?.[decodeURIComponent(m[1] ?? "")];
			return blob ? { type: "file", content: b64(blob.body) } : reject("404");
		}
		const t = path.match(/^\/repos\/rodaddy\/demo\/git\/trees\/([^?]+)\?/);
		if (t) {
			const side = sides[decodeURIComponent(t[1] ?? "")] ?? {};
			return {
				tree: Object.entries(side).map(([p, b]) => ({ path: p, mode: b.mode, type: "blob" })),
			};
		}
		throw new Error(`unrouted ${path}`);
	};
	const files = changed.map((c) => ({
		...(typeof c === "string" ? { filename: c } : c),
		additions: 1,
		deletions: 0,
	}));
	const deps = {
		cfg: { reviewerAgentId: "rev", triageAgentId: "tri", scriptedNonCode: true as boolean },
		listTitles: async () => created.map((t) => t.title),
		postComment: async (_r: string, _n: number, b: string) => void comments.push(b),
		stateGet: async (k: string) => state.get(k) ?? null,
		stateSet: async (k: string, v: unknown) => void state.set(k, v),
		log: () => undefined,
		createTask: async (task: (typeof created)[number]) => {
			created.push(task);
			return { id: `new-${created.length}` };
		},
		listFiles: async () => files,
		forgeGet,
		findAgent: async (login: string) => (login === "sf-chang" ? "chang" : null),
	};
	return { deps, created, comments, state, ev: (n = changed.length) => ev(n) };
}
const ev = (changedFiles: number) => {
	const ev = parsePullRequestEvent(
		{ "x-forgejo-event": "pull_request" },
		{
			action: "opened",
			number: 7,
			repository: { full_name: "rodaddy/demo" },
			pull_request: {
				head: { sha: SHA },
				base: { ref: "main" },
				html_url: "https://forge.example.internal/rodaddy/demo/pulls/7",
				title: "Docs",
				body: BODY,
				user: { login: "rico" },
				changed_files: changedFiles,
			},
		},
		["rodaddy/demo"],
	);
	if (!ev) throw new Error("fixture must parse");
	return ev;
};
const REVIEW = `Review rodaddy/demo#7 @ ${SHA.slice(0, 7)}`;
const MERGE = `Merge rodaddy/demo#7 @ ${SHA.slice(0, 7)}`;

// The PR got the normal review task and no scripted comment.
async function expectNormal(h: ReturnType<typeof harness>, e = h.ev()) {
	expect((await reviewPrOnce(h.deps, e)).outcome).toBe("created");
	expect(h.created.map((t) => t.title)).toEqual([REVIEW]);
	expect(h.comments).toEqual([]);
}

describe("the review fast path in reviewPrOnce", () => {
	test("an all-.md PR gets the scripted verdict and a Merge task, no review task", async () => {
		const h = harness(["_DOCS/a.md", "README.md"], null);
		expect((await reviewPrOnce(h.deps, h.ev())).outcome).toBe("scripted");
		expect(h.comments).toHaveLength(1);
		expect(h.comments[0]?.split("\n")[0]).toBe("verdict: approve (scripted: non-code)");
		expect(h.created.map((t) => [t.title, t.assigneeAgentId, t.priority])).toEqual([
			[MERGE, "chang", "high"],
		]);
		await reviewPrOnce(h.deps, h.ev()); // the same head again: nothing new
		expect([h.comments.length, h.created.length]).toEqual([1, 1]);
	});
	test("with scriptedNonCode unset an all-.md PR gets a normal review task", async () => {
		const h = harness(["_DOCS/a.md", "README.md"], null);
		h.deps.cfg = { reviewerAgentId: "rev", triageAgentId: "tri" } as typeof h.deps.cfg;
		await expectNormal(h);
	});
	test("a SKILL.md plus README PR gets a normal review task", async () => {
		await expectNormal(harness(["fleet/skills/x/SKILL.md", "README.md"], "*.md"));
	});
	test("the pattern `*` plus a .ts edit gets a review task", async () => {
		await expectNormal(harness(["README.md", "src/a.ts"], "*"));
	});
	test("a head-branch .factoryignore is ignored", async () => {
		await expectNormal(harness(["notes/a.md"], null, "*"));
	});
	test("no Chang seat or a failed read goes the normal path", async () => {
		const h = harness(["README.md"], null);
		h.deps.findAgent = async () => null;
		await expectNormal(h);
		const r = harness(["README.md"], null);
		r.deps.forgeGet = async () => reject("502");
		await expectNormal(r);
	});
	test("clearing the exec bit on README is still refused (base mode counts)", async () => {
		const base = { "README.md": { mode: "100755", body: "# Title\n" } };
		await expectNormal(harness(["README.md"], null, null, { base }));
	});
	test("an executable README at head is refused", async () => {
		const head = { "README.md": { mode: "100755", body: "# Title\n" } };
		await expectNormal(harness(["README.md"], null, null, { head }));
	});
	test("removing a shebang from README is still refused (base first line counts)", async () => {
		const base = { "README.md": { mode: "100644", body: "#!/bin/sh\necho hi\n" } };
		await expectNormal(harness(["README.md"], null, null, { base }));
	});
	test("a #! README at head is refused", async () => {
		const head = { "README.md": { mode: "100644", body: "#!/bin/sh\necho hi\n" } };
		await expectNormal(harness(["README.md"], null, null, { head }));
	});
	test("a rename from SKILL.md to a doc is refused", async () => {
		const c = { filename: "_DOCS/notes.md", previous_filename: "fleet/skills/x/SKILL.md" };
		const both = { "fleet/skills/x/SKILL.md": DOC };
		await expectNormal(harness([c], null, null, { base: both, head: { "_DOCS/notes.md": DOC } }));
	});
	test("a deleted doc is read at base: a #! one is refused, a plain one is scripted", async () => {
		const bad = { "_DOCS/old.md": { mode: "100644", body: "#!/bin/sh\n" } };
		await expectNormal(harness(["_DOCS/old.md"], null, null, { base: bad, head: {} }));
		const ok = harness(["_DOCS/old.md"], null, null, { head: {} });
		expect((await reviewPrOnce(ok.deps, ok.ev())).outcome).toBe("scripted");
	});
	test("a path on neither side is unreadable and refused", async () => {
		await expectNormal(harness(["README.md"], null, null, { base: {}, head: {} }));
	});
	test("a 502 on .factoryignore alone goes the normal path", async () => {
		await expectNormal(harness(["README.md"], null, null, { ignoreReply: () => reject("502") }));
	});
	test("a 2xx .factoryignore that is not a file with string content goes the normal path", async () => {
		for (const reply of [
			[{ type: "file", name: "a" }],
			{ type: "dir", content: b64("*") },
			{ type: "file", content: null },
			{ type: "symlink", content: b64("*") },
		])
			await expectNormal(harness(["README.md"], null, null, { ignoreReply: async () => reply }));
	});
	test("a file list at the 1000 cap or short of changed_files goes the normal path", async () => {
		const many = Array.from({ length: 1000 }, (_, i) => `_DOCS/d${i}.md`);
		const big = harness(many, null);
		// Zero-line changes, so the preflight's size rules pass and only the cap decides.
		const list = many.map((filename) => ({ filename, additions: 0, deletions: 0 }));
		big.deps.listFiles = async () => list;
		await expectNormal(big);
		const h = harness(["README.md"], null);
		await expectNormal(h, h.ev(2));
		const none = harness(["README.md"], null);
		const e = none.ev();
		delete (e as { changedFiles?: number }).changedFiles;
		await expectNormal(none, e);
	});
});

// The deployed plugin dir has no node_modules/ignore: the
// plugin's module graph must still load and every PR gets the normal review.
// Skipped when the temp base has an ancestor node_modules that resolves `ignore`
// (for example ~/node_modules on a dev Mac): the harness cannot hide it there.
const ignoreResolvesFromTmp = (() => {
	try {
		Bun.resolveSync("ignore", testTmpBase());
		return true;
	} catch {
		return false;
	}
})();
test.skipIf(ignoreResolvesFromTmp)(
	"the forge-pr module graph loads without the `ignore` package",
	async () => {
		const src = join(import.meta.dir, "../../fleet/plugins/forge-pr");
		const dir = mkdtempSync(join(testTmpBase(), "sf1730-noignore-"));
		try {
			for (const f of readdirSync(src))
				if (f.endsWith(".js")) copyFileSync(join(src, f), join(dir, f));
			let resolvable = true;
			try {
				Bun.resolveSync("ignore", dir);
			} catch {
				resolvable = false;
			}
			if (resolvable) throw new Error(`harness: ignore resolves from ${dir}`);
			const script = `
const { reviewPrOnce } = await import(${JSON.stringify(join(dir, "sweep.js"))});
const tasks = [];
const r = await reviewPrOnce({
	cfg: { reviewerAgentId: "rev", triageAgentId: "tri", scriptedNonCode: true },
	listTitles: async () => [], postComment: async () => {}, log: () => {},
	stateGet: async () => null, stateSet: async () => {},
	createTask: async (t) => (tasks.push(t.title), { id: "t1" }),
	listFiles: async () => [{ filename: "README.md", additions: 1, deletions: 0 }],
	forgeGet: async () => { throw Object.assign(new Error("404"), { reason: "404" }); },
	findAgent: async () => "chang",
}, ${JSON.stringify(ev(1))});
console.log(JSON.stringify([r.outcome, tasks]));
`;
			// --no-install: bun would otherwise auto-install `ignore` from its cache and
			// hide the missing package that Node hits in the deployed plugin dir.
			const p = Bun.spawnSync([process.execPath, "--no-install", "-e", script], { cwd: dir });
			const out = p.stdout.toString().trim();
			expect({ code: p.exitCode, out, err: p.stderr.toString().slice(0, 400) }).toMatchObject({
				code: 0,
				out: JSON.stringify(["created", [REVIEW]]),
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	},
);

// A Forge read through nonCodeVerdict: no .factoryignore, each ref's tree
// either complete in one page or truncated on every page without the file.
const forge = (trees: Record<string, "has" | "lacks" | "truncated">) => async (path: string) => {
	if (path.includes("/contents/.factoryignore"))
		throw Object.assign(new Error("404"), { reason: "404" });
	const tree = path.match(/\/git\/trees\/([^?]+)\?/);
	if (tree) {
		const kind = trees[decodeURIComponent(tree[1] ?? "")];
		if (kind === "truncated")
			return { tree: [{ path: "other.md", mode: "100644" }], truncated: true };
		return {
			tree: kind === "has" ? [{ path: "README.md", mode: "100644" }] : [],
			truncated: false,
		};
	}
	if (path.includes("/contents/README.md"))
		return { type: "file", content: Buffer.from("# Readme\n").toString("base64") };
	throw new Error(`unexpected read ${path}`);
};
const verdict = (trees: Record<string, "has" | "lacks" | "truncated">) =>
	FI.nonCodeVerdict(forge(trees), "o/r", { baseRef: "main", headSha: "abc" }, [
		{ filename: "README.md" },
	]);

describe("nonCodeVerdict over an incomplete tree (PR 1803 review P2)", () => {
	test("a path missing from a truncated base tree is refused", async () => {
		expect((await verdict({ abc: "has", main: "truncated" })).nonCode).toBe(false);
	});
	test("a path missing from a truncated head tree is refused", async () => {
		expect((await verdict({ abc: "truncated", main: "has" })).nonCode).toBe(false);
	});
	test("a path missing from a complete base tree is an added file", async () => {
		expect((await verdict({ abc: "has", main: "lacks" })).nonCode).toBe(true);
	});
});
