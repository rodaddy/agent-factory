/**
 * @module tests/fh/authorized-integration
 * @description Offline fixture tests for the Forgejo Authorized Integration form
 * parsers and body builder. The snippets model the small markup shapes
 * consumed by the operator script, so these tests never contact the forge.
 */
import { describe, expect, test } from "bun:test";
import {
	absorbInto,
	asPath,
	audienceOf,
	buildCreateBody,
	cookiePairOf,
	csrfOf,
	flashOf,
	nameOf,
} from "../../scripts/fh/authorized-integration";

const AUDIENCE = "u:7:123e4567-e89b-12d3-a456-426614174000";

describe("authorized-integration HTML parsers", () => {
	test("finds CSRF in a form field before the cookie fallback", () => {
		expect(
			csrfOf(
				'<form><input type="hidden" name="_csrf" value="form-token"></form>',
				() => "cookie-token",
			),
		).toBe("form-token");
	});

	test("finds CSRF in a meta tag", () => {
		expect(csrfOf('<meta name="_csrf" content="meta-token">', () => undefined)).toBe("meta-token");
	});

	test("falls back to the session cookie and returns empty when absent", () => {
		const jar = new Map([["_csrf", "cookie-token"]]);
		expect(csrfOf("<form></form>", jar.get.bind(jar))).toBe("cookie-token");
		expect(csrfOf("<form></form>", () => undefined)).toBe("");
	});

	test("absorbs a cookie pair and skips malformed Set-Cookie lines", () => {
		const jar = new Map<string, string>();
		const response = {
			headers: {
				getSetCookie: () => [
					"session=abc=123; Path=/; HttpOnly",
					"malformed-without-equals",
					"=missing-name; Path=/",
				],
			},
		} as unknown as Response;

		absorbInto(jar, response);
		expect(jar).toEqual(new Map([["session", "abc=123"]]));
		expect(cookiePairOf("session=abc=123; Path=/")).toEqual(["session", "abc=123"]);
		expect(cookiePairOf("malformed-without-equals")).toBeUndefined();
	});

	test("extracts flash, negative, and error text, capped at four entries", () => {
		const html = `
			<div class="flash success">Created integration</div>
			<div class="negative">Name is already used</div>
			<div class="error">Description is required</div>
			<div class="flash">Choose at least one scope</div>
			<div class="error">Fifth message is ignored</div>
		`;

		expect(flashOf(html)).toEqual([
			"Created integration",
			"Name is already used",
			"Description is required",
			"Choose at least one scope",
		]);
	});

	test("finds the audience from the input value or the u:id:uuid fallback", () => {
		expect(audienceOf(`<input name="audience" value="${AUDIENCE}">`)).toBe(AUDIENCE);
		expect(audienceOf(`<p>Generated audience: ${AUDIENCE}</p>`)).toBe(AUDIENCE);
	});

	test("extracts the integration name from the edit form", () => {
		expect(nameOf('<input name="name" value="software-factory lanes">')).toBe(
			"software-factory lanes",
		);
		expect(nameOf("<form></form>")).toBe("");
	});

	test("strips the base origin and passes a bare path through", () => {
		const base = "https://forge.example.test";
		expect(asPath(`${base}/user/settings/authorized-integrations`, base)).toBe(
			"/user/settings/authorized-integrations",
		);
		expect(asPath("/user/settings/authorized-integrations", base)).toBe(
			"/user/settings/authorized-integrations",
		);
	});
});

describe("authorized-integration create body", () => {
	test("preserves the form fields and repeated values while omitting empty CSRF", () => {
		const repo = "rodaddy/software-factory";
		const scopes = ["write:issue", "write:repository"] as const;
		const body = buildCreateBody({
			csrf: "",
			name: "software-factory lanes",
			description: "fixture description",
			repo,
			scopes,
		});

		expect([...body.entries()]).toEqual([
			["name", "software-factory lanes"],
			["description", "fixture description"],
			["source_repo", repo],
			["workflow_file", ""],
			["git_ref", ""],
			["resource", "repo-specific"],
			["selected_repo", repo],
			["scope", "write:issue"],
			["scope", "write:repository"],
		]);
		expect(body.has("_csrf")).toBe(false);
		expect(body.getAll("selected_repo")).toEqual([repo]);
		expect(body.getAll("scope")).toEqual([...scopes]);
	});

	test("includes a non-empty CSRF token", () => {
		const body = buildCreateBody({
			csrf: "form-token",
			name: "name",
			description: "description",
			repo: "owner/repo",
			scopes: [],
		});

		expect(body.get("_csrf")).toBe("form-token");
	});
});
