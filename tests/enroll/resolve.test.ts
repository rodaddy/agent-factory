/**
 * Tests for the enroll source-repo resolver (lane 831b). Offline: the
 * injected FetchText serves a URL map, and a URL absent from the map is a 404.
 * The cases mirror the 791a inventory: a plain repo, a renamed repo that 301s,
 * a missing repo, a repo with no tags, and a tag stream that is not the image's.
 */
import { describe, expect, test } from "bun:test";
import { parseImage, resolveSource } from "../../src/enroll/resolve";
import type { FetchText } from "../../src/hostedapp/fetch";

const API = "https://forge.test/api/v1";
const TAGS = "tags?page=1&limit=50";

function tagsJson(names: string[]): string {
	return JSON.stringify(names.map((name, i) => ({ name, commit: { sha: `sha${i}` } })));
}

function urlMap(map: Record<string, string>): { fetch: FetchText; urls: string[] } {
	const urls: string[] = [];
	const fetch: FetchText = async (url) => {
		urls.push(url);
		const text = map[url];
		return text === undefined ? { ok: false, status: 404, error: "HTTP 404" } : { ok: true, text };
	};
	return { fetch, urls };
}

describe("parseImage", () => {
	test("splits host/owner/name:tag and drops a digest", () => {
		expect(parseImage("10.0.20.58:3000/rodaddy/hook-probe:v0.2.2@sha256:854e")).toEqual({
			owner: "rodaddy",
			name: "hook-probe",
			tag: "v0.2.2",
		});
	});
	test("a hub image with no registry host is not parseable", () => {
		expect(parseImage("maximhq/bifrost:v2.0.0")).toBeNull();
	});
});

describe("resolveSource", () => {
	test("found: the family matching the image tag, and its newest tag", async () => {
		const { fetch } = urlMap({
			[`${API}/repos/acme/web-bb-landing`]: JSON.stringify({
				full_name: "acme/web-bb-landing",
			}),
			[`${API}/repos/acme/web-bb-landing/${TAGS}`]: tagsJson(["prod", "v0.18.5", "v0.17.3"]),
		});
		const result = await resolveSource(
			fetch,
			"t",
			"10.0.20.58:3000/acme/web-bb-landing:v0.17.3",
			API,
		);
		expect(result).toEqual({
			status: "found",
			repo: "acme/web-bb-landing",
			tagFamily: "vN.N.N",
			latestTag: "v0.18.5",
		});
	});

	test("301-followed: the canonical repo is the redirected full_name", async () => {
		const { fetch, urls } = urlMap({
			// fetch follows the 301, so the old path answers with the renamed repo's body.
			[`${API}/repos/rodaddy/web-ops`]: JSON.stringify({ full_name: "rtech/web-ops" }),
			[`${API}/repos/rtech/web-ops/${TAGS}`]: tagsJson(["prod-web-ops-v0.1.5", "web-ops-v0.1.5"]),
		});
		const result = await resolveSource(
			fetch,
			"t",
			"forge.example.internal/rodaddy/web-ops:v0.1.5",
			API,
		);
		expect(result).toEqual({
			status: "found",
			repo: "rtech/web-ops",
			tagFamily: "prod-web-ops-vN.N.N",
			latestTag: "prod-web-ops-v0.1.5",
		});
		expect(urls).toContain(`${API}/repos/rtech/web-ops/${TAGS}`);
	});

	test("no-repo: Forge answers 404", async () => {
		const { fetch } = urlMap({});
		const result = await resolveSource(
			fetch,
			"t",
			"forge.example.internal/rtech/press:v0.1.0",
			API,
		);
		expect(result).toMatchObject({ status: "refused", reason: "no-repo" });
	});

	test("no-tags: the repo exists with zero tags", async () => {
		const { fetch } = urlMap({
			[`${API}/repos/rtech/browser-pool`]: JSON.stringify({ full_name: "rodaddy/browser-pool" }),
			[`${API}/repos/rodaddy/browser-pool/${TAGS}`]: "[]",
		});
		const result = await resolveSource(
			fetch,
			"t",
			"forge.example.internal/rtech/browser-pool:v0.1.2",
			API,
		);
		expect(result).toMatchObject({ status: "refused", reason: "no-tags" });
	});

	test("stream-mismatch: tags exist but none has the image tag's shape", async () => {
		const { fetch } = urlMap({
			[`${API}/repos/rtech/documenso`]: JSON.stringify({ full_name: "rtech/documenso" }),
			[`${API}/repos/rtech/documenso/${TAGS}`]: tagsJson(["v2.17.0", "v2.16.0"]),
		});
		const result = await resolveSource(
			fetch,
			"t",
			"forge.example.internal/rtech/documenso:v2.17.0-sign.1",
			API,
		);
		expect(result).toMatchObject({ status: "refused", reason: "stream-mismatch" });
	});

	test("a non-404 repo read throws instead of refusing", async () => {
		const fetch: FetchText = async () => ({ ok: false, status: 0, error: "connection refused" });
		await expect(
			resolveSource(fetch, "t", "forge.example.internal/rtech/x:v1.0.0", API),
		).rejects.toThrow("connection refused");
	});
});
