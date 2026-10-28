/**
 * @module tests/infra/changed-files
 * @description Boundary-validation tests for the compare-bound changed-files
 *   reader (HIGH-2 / HIGH-2b) against a FAKE GitHubClient. The reader is
 *   bound to the IMMUTABLE `base..pinnedSHA` compare, so a push that advances the
 *   PR head can never change its result. These tests assert it reads ONLY each
 *   `filename` of the compare OBJECT's `files` array, does a SINGLE first-page read
 *   (the compare `files` array is NOT paginated and is capped at 300 files for the
 *   whole comparison), enforces the per-path length cap, validates the pinned SHA
 *   and base ref, treats a returned array at the documented 300-file cap as
 *   possibly-truncated => indeterminate (never narrowing from a truncated set), and
 *   translates every untrusted-read condition (API/network error, non-object body,
 *   missing/non-array files, malformed entry, no files) into the explicit
 *   `indeterminate` signal — never a throw and never a partial path list. No I/O,
 *   no git.
 */
import { describe, expect, test } from "bun:test";
import type { ForgeClient } from "../../src/forge/boundary";
import type { GitHubClient } from "../../src/github/client";
import {
	COMPARE_FILES_CAP,
	MAX_PATH_LENGTH,
	readChangedFilesForSha,
} from "../../src/infra/changed-files";

/** A minimal fake exposing only the one method the reader uses: `getPage`. */
function fakeClient(
	pages: (path: string) => { body: unknown; next: string | null } | Error,
): GitHubClient {
	return {
		async getPage<T>(pathOrUrl: string): Promise<{ body: T; next: string | null }> {
			const out = pages(pathOrUrl);
			if (out instanceof Error) {
				throw out;
			}
			return out as { body: T; next: string | null };
		},
	} as unknown as GitHubClient;
}

const REPO = "rtech/rtech-infra";
const BASE = "b".repeat(40);
const SHA = "a".repeat(40);

/** The compare endpoint returns an OBJECT carrying a first-page `files` array. */
function compare(files: unknown): { files: unknown } {
	return { files };
}

describe("readChangedFilesForSha — happy path (paths only)", () => {
	test("returns only filenames from the compare files array, ignoring patch/blob/status", async () => {
		const client = fakeClient(() => ({
			body: compare([
				{ filename: "scripts/x.sh", patch: "@@ evil @@", status: "modified", blob_url: "http://x" },
				{ filename: "roles/web/tasks/main.yml", contents_url: "http://y" },
			]),
			next: null,
		}));
		const r = await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA });
		expect(r.indeterminate).toBe(false);
		expect(r.paths).toEqual(["scripts/x.sh", "roles/web/tasks/main.yml"]);
	});

	test("the compare path is bound to base...pinnedSHA (not the PR head or a single commit)", async () => {
		let seen = "";
		const client = fakeClient((path) => {
			seen = path;
			return { body: compare([{ filename: "scripts/x.sh" }]), next: null };
		});
		await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA });
		expect(seen).toContain(`/repos/${REPO}/compare/${BASE}...${SHA}`);
	});

	test("the compare is a SINGLE first-page read; a stray next link is never followed", async () => {
		// HIGH-2b: the compare files array is not paginated, so even a (spurious)
		// next link must NOT trigger a second read. Only one call is made and the
		// single-page result narrows normally.
		let calls = 0;
		const client = fakeClient(() => {
			calls++;
			return { body: compare([{ filename: "scripts/x.sh" }]), next: "/spurious-next" };
		});
		const r = await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA });
		expect(calls).toBe(1);
		expect(r.indeterminate).toBe(false);
		expect(r.paths).toEqual(["scripts/x.sh"]);
	});
});

describe("readChangedFilesForSha — boundary validation", () => {
	test("Forgejo reads Compare.files without GitHub's 300 cap but escalates when completeness is unproven", async () => {
		const files = Array.from({ length: COMPARE_FILES_CAP + 25 }, (_, i) => ({
			filename: `scripts/s${i}.sh`,
		}));
		const client = fakeClient(() => ({ body: compare(files), next: null })) as ForgeClient;
		const r = await readChangedFilesForSha({
			client,
			repository: REPO,
			base: BASE,
			sha: SHA,
			provider: "forgejo",
		});
		expect(r.indeterminate).toBe(true);
		expect(r.reason).toContain("completeness is unproven");
	});

	test("an invalid repository is indeterminate, no read attempted", async () => {
		let called = false;
		const client = fakeClient(() => {
			called = true;
			return { body: compare([]), next: null };
		});
		const r = await readChangedFilesForSha({
			client,
			repository: "not-a-repo",
			base: BASE,
			sha: SHA,
		});
		expect(r.indeterminate).toBe(true);
		expect(called).toBe(false);
	});

	test("a non-exact-hex pinned SHA is indeterminate, no read attempted", async () => {
		let called = false;
		const client = fakeClient(() => {
			called = true;
			return { body: compare([]), next: null };
		});
		const r = await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: "NOTHEX" });
		expect(r.indeterminate).toBe(true);
		expect(called).toBe(false);
	});

	test("an unsafe base ref (traversal) is indeterminate, no read attempted", async () => {
		let called = false;
		const client = fakeClient(() => {
			called = true;
			return { body: compare([]), next: null };
		});
		const r = await readChangedFilesForSha({ client, repository: REPO, base: "../etc", sha: SHA });
		expect(r.indeterminate).toBe(true);
		expect(called).toBe(false);
	});

	test("a files array AT the documented 300-file cap is indeterminate (possibly truncated)", async () => {
		// HIGH-2b: the compare files array is capped at 300 for the whole comparison
		// with no way to fetch the remainder, so a returned array whose length is at
		// the cap must be treated as possibly-truncated => indeterminate => full
		// escalation, never narrowed.
		const files = Array.from({ length: COMPARE_FILES_CAP }, (_, i) => ({
			filename: `scripts/s${i}.sh`,
		}));
		const client = fakeClient(() => ({ body: compare(files), next: null }));
		const r = await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA });
		expect(r.indeterminate).toBe(true);
	});

	test("a files array just under the 300-file cap narrows normally", async () => {
		// One below the cap is a complete, trusted set: it maps through to paths.
		const files = Array.from({ length: COMPARE_FILES_CAP - 1 }, (_, i) => ({
			filename: `scripts/s${i}.sh`,
		}));
		const client = fakeClient(() => ({ body: compare(files), next: null }));
		const r = await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA });
		expect(r.indeterminate).toBe(false);
		expect(r.paths.length).toBe(COMPARE_FILES_CAP - 1);
	});

	test("an over-length path is indeterminate", async () => {
		const longPath = `scripts/${"a".repeat(MAX_PATH_LENGTH + 1)}.sh`;
		const client = fakeClient(() => ({ body: compare([{ filename: longPath }]), next: null }));
		const r = await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA });
		expect(r.indeterminate).toBe(true);
	});

	test("an API / network error (e.g. unreachable SHA 404) is translated to indeterminate", async () => {
		const client = fakeClient(() => new Error("GitHub request failed: HTTP 404"));
		const r = await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA });
		expect(r.indeterminate).toBe(true);
		expect(r.paths).toEqual([]);
	});

	test("a top-level array body (wrong shape for compare) is indeterminate", async () => {
		// The PR-files endpoint returns a top-level array; the compare endpoint does
		// not. A top-level array is the wrong shape and must fail closed.
		const client = fakeClient(() => ({ body: [{ filename: "scripts/x.sh" }], next: null }));
		expect(
			(await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA }))
				.indeterminate,
		).toBe(true);
	});

	test("a non-object body is indeterminate", async () => {
		const client = fakeClient(() => ({ body: "Not Found", next: null }));
		expect(
			(await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA }))
				.indeterminate,
		).toBe(true);
	});

	test("a compare object missing the files array is indeterminate", async () => {
		const client = fakeClient(() => ({ body: { message: "Not Found" }, next: null }));
		expect(
			(await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA }))
				.indeterminate,
		).toBe(true);
	});

	test("a non-array files is indeterminate", async () => {
		const client = fakeClient(() => ({ body: { files: "x" }, next: null }));
		expect(
			(await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA }))
				.indeterminate,
		).toBe(true);
	});

	test("a malformed entry (missing filename) is indeterminate", async () => {
		const client = fakeClient(() => ({ body: compare([{ status: "modified" }]), next: null }));
		expect(
			(await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA }))
				.indeterminate,
		).toBe(true);
	});

	test("a range with zero changed files is indeterminate", async () => {
		const client = fakeClient(() => ({ body: compare([]), next: null }));
		expect(
			(await readChangedFilesForSha({ client, repository: REPO, base: BASE, sha: SHA }))
				.indeterminate,
		).toBe(true);
	});
});
