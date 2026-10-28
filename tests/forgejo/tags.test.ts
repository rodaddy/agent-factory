/**
 * @module tests/forgejo/tags
 * @description Hermetic tests for the Forgejo tag reader. The load-
 *   bearing one is the ANNOTATED-TAG case: the fixture's `id` (the tag object's
 *   own sha) DIFFERS from `commit.sha`, so a reader mapping the wrong field
 *   cannot pass. The rest pin the single bounded page request and the fail-closed
 *   `null` on a non-200, a throwing client, and a malformed body.
 *
 *   `readForgejoTag` is the NAMED lookup the markers path uses. Its load-bearing
 *   cases are the three-way outcome — tag / `"absent"` on a 404 / `null` on any
 *   other failure — because only `"absent"` may delete a marker row, and the
 *   deployed client delivers its 404 as a THROWN flattened message rather than a
 *   returned status.
 */
import { describe, expect, test } from "bun:test";
import type { ForgeClient, ForgeResponse } from "../../src/forge/boundary";
import { listForgejoTags, readForgejoTag } from "../../src/forgejo/tags";

/** A client whose `get` returns a fixed response and records the path. */
function client(respond: (path: string) => ForgeResponse<unknown> | Promise<never>): {
	client: ForgeClient;
	paths: string[];
} {
	const paths: string[] = [];
	const c = {
		provider: "forgejo" as const,
		get: async (path: string) => {
			paths.push(path);
			return respond(path);
		},
	} as unknown as ForgeClient;
	return { client: c, paths };
}

const ok = (body: unknown): ForgeResponse<unknown> => ({
	status: 200,
	data: body,
	link: null,
	rateRemaining: null,
});

describe("listForgejoTags", () => {
	test("maps the COMMIT sha, never the annotated tag object's own id", async () => {
		const tagObjectSha = "1".repeat(40);
		const commitSha = "2".repeat(40);
		const { client: c } = client(() =>
			ok([
				{
					name: "v1.2.3",
					message: "release",
					// The ANNOTATED-TAG TRAP: `id` is the tag object, `commit.sha` the commit.
					id: tagObjectSha,
					commit: { sha: commitSha, url: "https://example.invalid", created: "2026-09-01" },
				},
			]),
		);

		const tags = await listForgejoTags(c, "rodaddy/x");

		expect(tags).toEqual([{ name: "v1.2.3", commitSha, commitCreatedAt: new Date("2026-09-01") }]);
		expect(tags?.[0]?.commitSha).not.toBe(tagObjectSha);
	});

	test("carries the commit date when the forge sends a parsable one", async () => {
		const { client: c } = client(() =>
			ok([
				{
					name: "v1.2.3",
					commit: { sha: "a".repeat(40), created: "2026-09-01T12:34:56Z" },
				},
			]),
		);

		const tags = await listForgejoTags(c, "rodaddy/x");

		expect(tags?.[0]?.commitCreatedAt).toEqual(new Date("2026-09-01T12:34:56Z"));
	});

	test("degrades a junk commit date to absent rather than an Invalid Date", async () => {
		// An `Invalid Date` would compare and serialize as garbage everywhere
		// downstream, so the field must be ABSENT instead.
		const { client: c } = client(() =>
			ok([{ name: "v1.2.3", commit: { sha: "b".repeat(40), created: "not-a-date" } }]),
		);

		const tags = await listForgejoTags(c, "rodaddy/x");

		expect(tags?.[0]?.commitCreatedAt).toBeUndefined();
		expect(tags).toEqual([{ name: "v1.2.3", commitSha: "b".repeat(40) }]);
	});

	test("omits the commit date when the forge omits the field", async () => {
		const { client: c } = client(() => ok([{ name: "v1.2.3", commit: { sha: "c".repeat(40) } }]));

		const tags = await listForgejoTags(c, "rodaddy/x");

		expect(tags?.[0]?.commitCreatedAt).toBeUndefined();
		expect(tags).toEqual([{ name: "v1.2.3", commitSha: "c".repeat(40) }]);
	});

	test("one tag's null, empty, or non-string date degrades only THAT tag", async () => {
		// THE DEFECT. A `created` typed `string` at the boundary
		// made a single odd tag invalidate the WHOLE array, so the read returned
		// null and the repository's intake was blocked every pass by one tag it did
		// not even need a date for. The date is degradable; the LIST is not.
		const { client: c } = client(() =>
			ok([
				{ name: "v1.0.0", commit: { sha: "a".repeat(40), created: null } },
				{ name: "v1.1.0", commit: { sha: "b".repeat(40), created: "" } },
				{ name: "v1.2.0", commit: { sha: "c".repeat(40), created: 1757000000 } },
				{ name: "v1.3.0", commit: { sha: "d".repeat(40), created: "2026-09-01T12:34:56Z" } },
			]),
		);

		const tags = await listForgejoTags(c, "rodaddy/x");

		expect(tags).toEqual([
			{ name: "v1.0.0", commitSha: "a".repeat(40) },
			{ name: "v1.1.0", commitSha: "b".repeat(40) },
			{ name: "v1.2.0", commitSha: "c".repeat(40) },
			{
				name: "v1.3.0",
				commitSha: "d".repeat(40),
				commitCreatedAt: new Date("2026-09-01T12:34:56Z"),
			},
		]);
	});

	test("requests exactly one bounded page", async () => {
		const { client: c, paths } = client(() => ok([]));

		await listForgejoTags(c, "rodaddy/x");

		expect(paths).toEqual(["/repos/rodaddy/x/tags?page=1&limit=50"]);
	});

	test("returns null on a non-200 rather than an empty list", async () => {
		const { client: c } = client(() => ({
			status: 404,
			data: [],
			link: null,
			rateRemaining: null,
		}));

		// null and [] must NOT read the same: [] means "no tags", null means "unknown".
		expect(await listForgejoTags(c, "rodaddy/x")).toBeNull();
	});

	test("returns null when the client throws", async () => {
		const { client: c } = client(() => Promise.reject(new Error("network down")));

		expect(await listForgejoTags(c, "rodaddy/x")).toBeNull();
	});

	test("returns null on a body that is not the expected shape", async () => {
		// A tag entry carrying only the tag-object `id` and no `commit` is exactly the
		// malformed case: it must FAIL, never fall back to `id`.
		const { client: c } = client(() => ok([{ name: "v1.2.3", id: "3".repeat(40) }]));

		expect(await listForgejoTags(c, "rodaddy/x")).toBeNull();
	});

	test("ignores unknown fields a forge upgrade may add", async () => {
		const { client: c } = client(() =>
			ok([{ name: "v9", commit: { sha: "4".repeat(40) }, brand_new_field: true }]),
		);

		expect(await listForgejoTags(c, "rodaddy/x")).toEqual([
			{ name: "v9", commitSha: "4".repeat(40) },
		]);
	});
});

describe("readForgejoTag", () => {
	test("parses a 200 into the tag, carrying the COMMIT sha and its date", async () => {
		const tagObjectSha = "1".repeat(40);
		const commitSha = "2".repeat(40);
		const { client: c } = client(() =>
			ok({
				name: "prod",
				// The ANNOTATED-TAG TRAP again: the named read shares the list's parser,
				// so a marker's sha is the commit's, never the tag object's.
				id: tagObjectSha,
				commit: { sha: commitSha, created: "2026-09-01T12:34:56Z" },
			}),
		);

		const tag = await readForgejoTag(c, "rodaddy/x", "prod");

		expect(tag).toEqual({
			name: "prod",
			commitSha,
			commitCreatedAt: new Date("2026-09-01T12:34:56Z"),
		});
	});

	test("a null date degrades the marker's date, it does not fail the read", async () => {
		// The named read shares `toForgejoTag`, so the same degradation holds — and
		// here the stake is higher: a `null` returning `null` from the read is
		// "unknown", which leaves the marker row untouched forever.
		const { client: c } = client(() =>
			ok({ name: "prod", commit: { sha: "5".repeat(40), created: null } }),
		);

		expect(await readForgejoTag(c, "rodaddy/x", "prod")).toEqual({
			name: "prod",
			commitSha: "5".repeat(40),
		});
	});

	test("requests exactly the named-tag path, URL-encoded", async () => {
		const { client: c, paths } = client(() => ok({ name: "a/b", commit: { sha: "a".repeat(40) } }));

		await readForgejoTag(c, "rodaddy/x", "release/prod");

		// The name is encoded HERE, so a marker carrying a slash cannot walk the path.
		expect(paths).toEqual(["/repos/rodaddy/x/tags/release%2Fprod"]);
	});

	test("returns 'absent' on a 404 — the forge does not carry this tag", async () => {
		const { client: c } = client(() => ({
			status: 404,
			data: null,
			link: null,
			rateRemaining: null,
		}));

		expect(await readForgejoTag(c, "rodaddy/x", "prod")).toBe("absent");
	});

	test("returns 'absent' when the deployed client THROWS its flattened 404", async () => {
		// The production ForgejoClient never returns a non-2xx: it throws
		// `Forgejo request failed: HTTP 404`. Reading that as a failure instead of an
		// absence would strand a deleted marker's row forever.
		const { client: c } = client(() =>
			Promise.reject(new Error("Forgejo request failed: HTTP 404")),
		);

		expect(await readForgejoTag(c, "rodaddy/x", "prod")).toBe("absent");
	});

	test("returns null on a 500 — unknown is NOT absent", async () => {
		// The distinction is load-bearing: only "absent" deletes a marker row.
		const { client: c } = client(() => ({
			status: 500,
			data: null,
			link: null,
			rateRemaining: null,
		}));

		expect(await readForgejoTag(c, "rodaddy/x", "prod")).toBeNull();
	});

	test("returns null when the client throws a non-404", async () => {
		const { client: c } = client(() => Promise.reject(new Error("network error")));

		expect(await readForgejoTag(c, "rodaddy/x", "prod")).toBeNull();
	});

	test("returns null on a body that is not the expected shape", async () => {
		const { client: c } = client(() => ok({ name: "prod", id: "3".repeat(40) }));

		expect(await readForgejoTag(c, "rodaddy/x", "prod")).toBeNull();
	});

	test("omits the commit date when the forge omits the field", async () => {
		const { client: c } = client(() => ok({ name: "prod", commit: { sha: "c".repeat(40) } }));

		expect(await readForgejoTag(c, "rodaddy/x", "prod")).toEqual({
			name: "prod",
			commitSha: "c".repeat(40),
		});
	});
});
