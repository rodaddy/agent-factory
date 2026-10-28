import { describe, expect, test } from "bun:test";
import { resolveForgejoDeployment } from "../../src/forgejo/config";
import { resolveForgejoToken } from "../../src/forgejo/credentials";

const validEnv = {
	FORGEJO_API_URL: "https://forge.example.internal/api/v1",
	FORGEJO_WEB_URL: "https://forge.example.internal",
	FORGEJO_CLONE_BASE: "https://forge.example.internal",
} as NodeJS.ProcessEnv;

describe("Forgejo runtime configuration", () => {
	test("accepts the exact deployed HTTPS endpoint contract", () => {
		expect(resolveForgejoDeployment(validEnv)).toEqual({
			ok: true,
			config: {
				apiUrl: "https://forge.example.internal/api/v1",
				webUrl: "https://forge.example.internal",
				cloneBase: "https://forge.example.internal",
			},
		});
	});

	test("rejects missing, HTTP, alternate-host, and path-drift values", () => {
		for (const apiUrl of [
			undefined,
			"http://forge.example.internal/api/v1",
			"https://evil.example/api/v1",
			"https://forge.example.internal",
		]) {
			const result = resolveForgejoDeployment({ ...validEnv, FORGEJO_API_URL: apiUrl });
			expect(result.ok).toBe(false);
		}
	});

	test("Forgejo token resolution is isolated and has no GitHub or gh fallback", () => {
		expect(
			resolveForgejoToken({
				GITHUB_TOKEN: "github-secret",
				GH_TOKEN: "other-github-secret",
			}),
		).toEqual({
			ok: false,
			error: "no Forgejo token available: set FORGEJO_TOKEN (no gh CLI fallback)",
		});
		expect(resolveForgejoToken({ FORGEJO_TOKEN: "forge-secret" })).toEqual({
			ok: true,
			token: "forge-secret",
		});
	});
});
