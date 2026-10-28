import { describe, expect, test } from "bun:test";
import type { ForgeClient } from "../../src/forge/boundary";
import { ForgeRegistry } from "../../src/forge/registry";

const deployment = {
	apiUrl: "https://forge.example.internal/api/v1",
	webUrl: "https://forge.example.internal",
	cloneBase: "https://forge.example.internal",
} as const;

function client(provider: "github" | "forgejo"): ForgeClient {
	return { provider } as ForgeClient;
}

describe("ForgeRegistry credential and endpoint isolation", () => {
	test("does not resolve Forgejo credentials for a GitHub-only registry use", async () => {
		let forgejoTokenCalls = 0;
		const registry = new ForgeRegistry({
			resolveGitHubToken: async () => ({ ok: true, token: "github-token" }),
			resolveForgejoToken: () => {
				forgejoTokenCalls++;
				return { ok: false, error: "missing" };
			},
			createGitHubClient: () => client("github"),
		});
		expect((await registry.clientFor("github")).ok).toBe(true);
		expect(forgejoTokenCalls).toBe(0);
	});

	test("uses only the Forgejo resolver and validated API URL for Forgejo", async () => {
		let githubTokenCalls = 0;
		let baseUrl = "";
		const registry = new ForgeRegistry({
			forgejoDeployment: deployment,
			resolveGitHubToken: async () => {
				githubTokenCalls++;
				return { ok: false, error: "must not run" };
			},
			resolveForgejoToken: () => ({ ok: true, token: "forgejo-token" }),
			createForgejoClient: (_token, opts) => {
				baseUrl = opts.baseUrl ?? "";
				return client("forgejo");
			},
		});
		const result = await registry.clientFor("forgejo");
		expect(result.ok).toBe(true);
		expect(githubTokenCalls).toBe(0);
		expect(baseUrl).toBe(deployment.apiUrl);
	});

	test("fails closed before token resolution when endpoint config is absent", async () => {
		let tokenCalls = 0;
		const registry = new ForgeRegistry({
			resolveForgejoToken: () => {
				tokenCalls++;
				return { ok: true, token: "forgejo-token" };
			},
		});
		expect(await registry.clientFor("forgejo")).toEqual({
			ok: false,
			error: "Forgejo endpoint configuration is unavailable",
		});
		expect(tokenCalls).toBe(0);
	});
});
