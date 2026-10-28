/**
 * @module tests/github/credentials
 * @description The GitHub token resolver reads the environment ONLY.
 *   The `gh auth token` fallback is gone: Forge is the factory's git provider and
 *   `FORGEJO_TOKEN` is its credential, so a gh CLI shell-out could only ever
 *   supply a token for the read-only mirror while looking like the primary path.
 *   These tests pin the env precedence, the fixed secret-free failure text, and
 *   — the point of the change — that NO subprocess is spawned when the
 *   environment carries no token.
 */
import { describe, expect, test } from "bun:test";
import { resolveGitHubToken } from "../../src/github/credentials";

describe("resolveGitHubToken", () => {
	test("returns GITHUB_TOKEN when present", async () => {
		const result = await resolveGitHubToken({ GITHUB_TOKEN: "  env-token  " } as NodeJS.ProcessEnv);
		expect(result).toEqual({ ok: true, token: "env-token" });
	});

	test("falls back to GH_TOKEN when GITHUB_TOKEN is absent", async () => {
		const result = await resolveGitHubToken({ GH_TOKEN: "gh-env-token" } as NodeJS.ProcessEnv);
		expect(result).toEqual({ ok: true, token: "gh-env-token" });
	});

	test("treats a whitespace-only value as absent", async () => {
		const result = await resolveGitHubToken({ GITHUB_TOKEN: "   " } as NodeJS.ProcessEnv);
		expect(result.ok).toBe(false);
	});

	test("fails closed with the fixed, secret-free error and no gh CLI fallback", async () => {
		const result = await resolveGitHubToken({} as NodeJS.ProcessEnv);
		expect(result).toEqual({
			ok: false,
			error:
				"no GitHub token available: set GITHUB_TOKEN for the read-only mirror; the factory's forge credential is FORGEJO_TOKEN (no gh CLI fallback)",
		});
	});

	test("spawns NO subprocess when the environment carries no token", async () => {
		const realSpawn = Bun.spawn;
		const spawned: string[][] = [];
		// A fake that RECORDS rather than answers: if the resolver still shells out,
		// the recorded argv fails the assertion instead of silently succeeding.
		(Bun as unknown as { spawn: unknown }).spawn = (cmd: string[]) => {
			spawned.push(cmd);
			throw new Error("no subprocess may be spawned by the token resolver");
		};
		try {
			const result = await resolveGitHubToken({} as NodeJS.ProcessEnv);
			expect(result.ok).toBe(false);
		} finally {
			(Bun as unknown as { spawn: unknown }).spawn = realSpawn;
		}
		expect(spawned).toEqual([]);
	});
});
