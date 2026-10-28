/**
 * @module tests/github/base-branch
 * @description Tests for base-branch resolution (Q4). The base decides
 *   which branch a proposed change targets, so these pin the two properties
 *   that matter: config wins over the forge, and everything else fails closed
 *   rather than guessing a plausible default.
 */
import { describe, expect, test } from "bun:test";
import type { ForgeClient } from "../../src/forge/boundary";
import {
	isFullCommitSha,
	isPlainBranchName,
	resolveBaseBranch,
	resolveBranchTipSha,
} from "../../src/github/base-branch";

/** A client whose repository lookup returns `body`, or throws when `throws`. */
function client(body: unknown, throws = false): ForgeClient {
	return {
		provider: "forgejo",
		get: async () => {
			if (throws) throw new Error("network down");
			return { status: 200, data: body, link: null, rateRemaining: null };
		},
		getPage: async () => ({ body: null, next: null }),
		paginate: async () => [],
		write: async () => ({ status: 200, data: null, link: null, rateRemaining: null }),
		postCommitCheck: async () => ({ status: "posted" as const }),
		findCommitCheck: async () => ({ status: "absent" as const }),
	} as unknown as ForgeClient;
}

describe("isPlainBranchName", () => {
	test("accepts ordinary branch names", () => {
		for (const b of ["main", "master", "develop", "release/2.0", "rw/issue-42", "v1.2.3"]) {
			expect(isPlainBranchName(b)).toBe(true);
		}
	});

	test("rejects anything that could escape a forge payload", () => {
		for (const b of [
			"",
			"refs/heads/main", // a ref path, not a branch name
			"/main", // absolute
			"../main", // traversal
			"a..b", // traversal fragment
			"main branch", // whitespace
			"main\nmaster", // newline injection
			"main;rm -rf /", // shell-shaped
			"x".repeat(256), // unbounded
		]) {
			expect(isPlainBranchName(b)).toBe(false);
		}
	});
});

describe("resolveBaseBranch", () => {
	test("configured value wins and the forge is not consulted", async () => {
		// The forge would answer `main`; config must take precedence, so a rename
		// on the forge cannot move the target under the watcher.
		const out = await resolveBaseBranch(client({ default_branch: "main" }), "r/x", "develop");
		expect(out).toBe("develop");
	});

	test("falls back to the forge default when nothing is configured", async () => {
		const out = await resolveBaseBranch(client({ default_branch: "trunk" }), "r/x");
		expect(out).toBe("trunk");
	});

	test("REJECTS a malformed configured value instead of falling through", async () => {
		// Falling back here would silently ignore an operator's explicit intent.
		const out = await resolveBaseBranch(client({ default_branch: "main" }), "r/x", "refs/heads/x");
		expect(out).toBeNull();
	});

	test("REJECTS a malformed default branch from the forge", async () => {
		// A remote response is data, not authority — validated at use.
		const out = await resolveBaseBranch(client({ default_branch: "../../etc" }), "r/x");
		expect(out).toBeNull();
	});

	test("fails closed on a missing or non-string default branch", async () => {
		expect(await resolveBaseBranch(client({}), "r/x")).toBeNull();
		expect(await resolveBaseBranch(client({ default_branch: 42 }), "r/x")).toBeNull();
		expect(await resolveBaseBranch(client(null), "r/x")).toBeNull();
	});

	test("fails closed when the forge is unreachable — never guesses main", async () => {
		// Guessing `main` is a plausible-looking way to target the wrong branch in a
		// repository that uses something else.
		const out = await resolveBaseBranch(client(null, true), "r/x");
		expect(out).toBeNull();
	});
});

/** A client capturing the requested path, returning `body` for any lookup. */
function tipClient(body: unknown, throws = false) {
	const paths: string[] = [];
	const c = {
		provider: "forgejo",
		get: async (path: string) => {
			paths.push(path);
			if (throws) throw new Error("network down");
			return { status: 200, data: body, link: null, rateRemaining: null };
		},
		getPage: async () => ({ body: null, next: null }),
		paginate: async () => [],
		write: async () => ({ status: 200, data: null, link: null, rateRemaining: null }),
		postCommitCheck: async () => ({ status: "posted" as const }),
		findCommitCheck: async () => ({ status: "absent" as const }),
	} as unknown as ForgeClient;
	return { client: c, paths };
}

const FULL = "aa11bb22cc33dd44ee55ff6600112233445566aa";

describe("isFullCommitSha", () => {
	test("accepts a full 40- or 64-char hex id and rejects an abbreviation", () => {
		expect(isFullCommitSha(FULL)).toBe(true);
		expect(isFullCommitSha("a".repeat(64))).toBe(true);
		// #65 compares the dispatched base in FULL; a prefix cannot be compared
		// exactly, so an abbreviated sha is not a dispatchable base.
		expect(isFullCommitSha("aa11bb2")).toBe(false);
		expect(isFullCommitSha("a".repeat(39))).toBe(false);
		expect(isFullCommitSha("z".repeat(40))).toBe(false);
		expect(isFullCommitSha("")).toBe(false);
	});
});

describe("resolveBranchTipSha", () => {
	test("reads GitHub's commit.sha", async () => {
		const { client: c } = tipClient({ commit: { sha: FULL } });
		expect(await resolveBranchTipSha(c, "rodaddy/x", "main")).toBe(FULL);
	});

	test("reads FORGEJO's commit.id, which has no sha field at all", async () => {
		// Verified against the live deployment (Forgejo 16.0.1+gitea-1.22.0): the
		// branch response embeds a PayloadCommit, whose id carries the sha and
		// which has no `sha` property. A GitHub-shaped reader returns undefined
		// here for EVERY Forgejo repository and fails closed for a reason that
		// looks like an outage rather than a shape mismatch.
		const { client: c } = tipClient({ commit: { id: FULL } });
		expect(await resolveBranchTipSha(c, "rodaddy/x", "main")).toBe(FULL);
	});

	test("normalizes an uppercase sha to lowercase", async () => {
		const { client: c } = tipClient({ commit: { sha: FULL.toUpperCase() } });
		expect(await resolveBranchTipSha(c, "rodaddy/x", "main")).toBe(FULL);
	});

	test("keeps the separators in a slashed branch name", async () => {
		// Encoding the whole name would send `release%2F1.x`, which is not the
		// path-routed form either forge documents.
		const { client: c, paths } = tipClient({ commit: { sha: FULL } });
		await resolveBranchTipSha(c, "rodaddy/x", "release/1.x");
		expect(paths[0]).toBe("/repos/rodaddy/x/branches/release/1.x");
	});

	test("FAILS CLOSED on a missing, malformed, or truncated tip", async () => {
		for (const body of [
			{},
			{ commit: {} },
			{ commit: { sha: 12345 } },
			{ commit: { sha: "aa11bb2" } }, // abbreviated: not comparable in full
			{ commit: { sha: "z".repeat(40) } }, // not hex
			null,
		]) {
			const { client: c } = tipClient(body);
			expect(await resolveBranchTipSha(c, "rodaddy/x", "main")).toBeNull();
		}
	});

	test("FAILS CLOSED when the lookup throws", async () => {
		const { client: c } = tipClient({ commit: { sha: FULL } }, true);
		expect(await resolveBranchTipSha(c, "rodaddy/x", "main")).toBeNull();
	});

	test("refuses an invalid branch name without making a request", async () => {
		const { client: c, paths } = tipClient({ commit: { sha: FULL } });
		expect(await resolveBranchTipSha(c, "rodaddy/x", "refs/heads/main")).toBeNull();
		expect(await resolveBranchTipSha(c, "rodaddy/x", "../escape")).toBeNull();
		expect(paths).toEqual([]);
	});
});
