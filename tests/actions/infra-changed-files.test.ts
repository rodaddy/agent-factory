import { describe, expect, test } from "bun:test";
import { planInfraGates } from "../../scripts/actions/infra-gates";
import type { ForgeClient } from "../../src/forge/boundary";
import { createForgejoClient } from "../../src/forgejo/client";
import { readChangedFilesForSha } from "../../src/infra/changed-files";

const BASE = "a".repeat(40);
const HEAD = "b".repeat(40);
const names = (n: number) => Array.from({ length: n }, (_, i) => ({ filename: `scripts/${i}.sh` }));
type Fixture = {
	files?: readonly unknown[];
	count?: unknown;
	total?: string | null;
	head?: string;
	finalHead?: string;
	base?: string;
	finalBase?: string;
	fail?: boolean;
};
function fake(f: Fixture = {}) {
	let reads = 0;
	const files = f.files ?? names(1);
	return createForgejoClient("fake", {
		baseUrl: "https://forge.invalid/api/v1",
		maxRetries: 0,
		fetch: async (input) => {
			const url = new URL(input);
			if (f.fail) throw new Error("offline");
			if (!url.pathname.endsWith("/files")) {
				reads++;
				return Response.json({
					changed_files: f.count,
					head: { sha: reads > 1 ? (f.finalHead ?? f.head ?? HEAD) : (f.head ?? HEAD) },
					base: { sha: reads > 1 ? (f.finalBase ?? f.base ?? BASE) : (f.base ?? BASE) },
				});
			}
			const page = Number(url.searchParams.get("page"));
			const limit = Number(url.searchParams.get("limit"));
			return Response.json(files.slice((page - 1) * limit, page * limit), {
				headers: f.total === null ? {} : { "X-Total-Count": f.total ?? String(files.length) },
			});
		},
	});
}
const read = (f: Fixture, pullNumber: number | undefined = 7) =>
	readChangedFilesForSha({
		client: fake(f),
		repository: "rtech/rtech-infra",
		base: BASE,
		sha: HEAD,
		provider: "forgejo",
		pullNumber,
	});

describe("Forgejo changed-file completeness", () => {
	test("proven complete PR narrows the real gate plan", async () => {
		const plan = await planInfraGates({}, "rtech/rtech-infra", BASE, HEAD, undefined, {
			client: fake({ count: 1 }),
			pullNumber: 7,
		});
		expect(plan.fullEscalation).toBe(false);
		expect(plan.gates.map((g) => g.gate)).toEqual(["scripts"]);
	});
	test("three pages are combined before narrowing", async () => {
		const files = names(123);
		expect(await read({ files, count: 123 })).toMatchObject({
			indeterminate: false,
			paths: files.map((f) => f.filename),
		});
	});
	test.each([
		["count mismatch", { count: 2 }, "X-Total-Count"],
		["missing changed_files", {}, "changed_files count missing"],
		["head drift before read", { count: 1, head: BASE }, "head SHA differs"],
		["head drift during pagination", { count: 1, finalHead: BASE }, "head SHA differs"],
		["base differs from the selected base", { count: 1, base: "c".repeat(40) }, "base SHA differs"],
		[
			"base retargeted during pagination",
			{ count: 1, finalBase: "c".repeat(40) },
			"base SHA differs",
		],
		["network failure", { count: 1, fail: true }, "API or network error"],
		["missing header", { count: 1, total: null }, "API or network error"],
		[
			"duplicate filenames",
			{ count: 2, files: [names(1)[0], names(1)[0]] },
			"distinct files count",
		],
		["malformed entry", { count: 1, files: [{}] }, "malformed file entry"],
	] as const)("%s stays indeterminate", async (_label, fixture, reason) => {
		const result = await read(fixture);
		expect(result.indeterminate).toBe(true);
		expect(result.paths).toEqual([]);
		expect(result.reason).toContain(reason);
	});
	test("rename retains old and new paths without counting the old path as another file", async () => {
		expect(
			await read({
				count: 1,
				files: [{ filename: "scripts/new.sh", previous_filename: "roles/old.yml" }],
			}),
		).toMatchObject({ indeterminate: false, paths: ["scripts/new.sh", "roles/old.yml"] });
	});
	test("push with no PR number keeps the compare fail-safe", async () => {
		const client = { getPage: async () => ({ body: { files: names(1) }, next: null }) };
		const result = await readChangedFilesForSha({
			client: client as unknown as ForgeClient,
			repository: "o/r",
			base: BASE,
			sha: HEAD,
			provider: "forgejo",
		});
		expect(result.indeterminate).toBe(true);
		expect(result.reason).toContain("Forgejo compare completeness is unproven");
	});
});
