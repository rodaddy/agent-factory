/**
 * @module tests/reconcile/argo-refresh
 * @description Hermetic tests for the Argo hard-refresh client. A
 *   recording fake stands in for fetch; no network.
 */
import { describe, expect, test } from "bun:test";
import { createArgoRefresher } from "../../src/reconcile/argo-refresh";

interface Call {
	url: string;
	init: RequestInit | undefined;
}

function fakeFetch(status = 200, body = "{}") {
	const calls: Call[] = [];
	const impl = (async (input: string | URL | Request, init?: RequestInit) => {
		calls.push({ url: String(input), init });
		return new Response(body, { status });
	}) as unknown as typeof fetch;
	return { calls, impl };
}

describe("createArgoRefresher", () => {
	test("no token or a plain-http server disables the refresher", () => {
		const f = fakeFetch();
		expect(createArgoRefresher({}, f.impl)).toBeNull();
		expect(createArgoRefresher({ ARGOCD_TOKEN: "  " }, f.impl)).toBeNull();
		expect(
			createArgoRefresher({ ARGOCD_TOKEN: "t", ARGOCD_SERVER: "http://argocd.x" }, f.impl),
		).toBeNull();
	});

	test("GETs the exact hard-refresh URL on the default server with a bearer header", async () => {
		const f = fakeFetch();
		const refresh = createArgoRefresher({ ARGOCD_TOKEN: " tok-123 " }, f.impl);
		if (refresh === null) throw new Error("refresher unexpectedly disabled");
		await refresh("acme-portal-uat");
		expect(f.calls).toHaveLength(1);
		const call = f.calls[0];
		expect(call?.url).toBe(
			"https://argocd.example.internal/api/v1/applications/acme-portal-uat?refresh=hard",
		);
		expect(call?.init?.method).toBe("GET");
		const headers = call?.init?.headers as Record<string, string>;
		expect(headers.Authorization).toBe("Bearer tok-123");
		expect(headers.Accept).toBe("application/json");
		expect(call?.url).not.toContain("tok-123");
	});

	test("a trailing slash on ARGOCD_SERVER is stripped", async () => {
		const f = fakeFetch();
		const refresh = createArgoRefresher(
			{ ARGOCD_TOKEN: "t", ARGOCD_SERVER: "https://argo.example/" },
			f.impl,
		);
		await refresh?.("app");
		expect(f.calls[0]?.url).toBe("https://argo.example/api/v1/applications/app?refresh=hard");
	});

	test("a non-2xx throws the status and never the body", async () => {
		const f = fakeFetch(403, "SECRET-BODY-TEXT permission denied");
		const refresh = createArgoRefresher({ ARGOCD_TOKEN: "t" }, f.impl);
		const err = await refresh?.("app").then(
			() => null,
			(e: unknown) => e as Error,
		);
		expect(err?.message).toBe("argo refresh failed: HTTP 403");
		expect(err?.message).not.toContain("SECRET-BODY-TEXT");
	});

	test("a name that is not a DNS label is refused before any fetch", async () => {
		const f = fakeFetch();
		const refresh = createArgoRefresher({ ARGOCD_TOKEN: "t" }, f.impl);
		for (const bad of ["../x", "Bad_Name"]) {
			await expect(refresh?.(bad)).rejects.toThrow(
				"argo refresh refused: app name is not a DNS label",
			);
		}
		expect(f.calls).toHaveLength(0);
	});
});
