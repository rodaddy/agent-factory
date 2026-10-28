import { describe, expect, test } from "bun:test";
import type { ForgejoClient } from "../../src/forgejo/client";
import { resolveBuildBump } from "../../src/reconcile/build-bump-resolve";

const DEPLOYMENT = {
	ok: true as const,
	config: {
		apiUrl: "https://forge.example.internal/api/v1" as const,
		webUrl: "https://forge.example.internal" as const,
		cloneBase: "https://forge.example.internal" as const,
	},
};

describe("resolveBuildBump", () => {
	test("captures the resolved credential and routes receipts using the outcome repository", async () => {
		const writes: unknown[][] = [];
		let capturedToken = "";
		const resolved = resolveBuildBump({
			env: { BUILD_BUMP_SCRIPT: "/safe/script", FORGEJO_USER: "factory" },
			exists: () => true,
			resolveToken: () => ({ ok: true, token: "assembled-token" }),
			resolveDeployment: () => DEPLOYMENT,
			createClient: (token) => {
				capturedToken = token;
				return {
					write: async (...args: unknown[]) => writes.push(args),
				} as unknown as ForgejoClient;
			},
			run: async (_input, credential) => ({
				kind: "harness",
				reason: `${credential.user}:${credential.token}`,
			}),
		});
		const outcome = await resolved.bump?.({} as never);
		expect(outcome?.kind === "harness" ? outcome.reason : "").toBe("factory:assembled-token");
		await resolved.postReceipt?.("rtech/k3s-deploy", 12, "body");
		expect(capturedToken).toBe("assembled-token");
		expect(writes[0]?.[1]).toBe("/repos/rtech/k3s-deploy/issues/12/comments");
	});

	test("uses fixed disabled reasons and omits the sink when deployment is unresolved", () => {
		const secretPath = "/secret/operator/path";
		const reasons: string[] = [];
		expect(
			resolveBuildBump({
				env: { BUILD_BUMP_SCRIPT: secretPath },
				resolveToken: () => ({ ok: false, error: "missing" }),
				onInfo: (reason) => reasons.push(reason),
			}).bump,
		).toBeNull();
		expect(
			resolveBuildBump({
				env: { BUILD_BUMP_SCRIPT: secretPath },
				resolveToken: () => ({ ok: true, token: "x" }),
				exists: () => false,
				onInfo: (reason) => reasons.push(reason),
			}).bump,
		).toBeNull();
		expect(reasons).toEqual(["FORGEJO_TOKEN unset", "script absent"]);
		expect(reasons.join(" ")).not.toContain(secretPath);

		const unresolved = resolveBuildBump({
			env: {},
			resolveToken: () => ({ ok: true, token: "x" }),
			exists: () => true,
			resolveDeployment: () => ({ ok: false, error: "invalid endpoints" }),
		});
		expect(unresolved.postReceipt).toBeUndefined();
	});
});
