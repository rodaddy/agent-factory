/**
 * Functional tests for the image-digest referential check (lane 832b):
 * `resolveImageDigest` maps a registry HEAD onto found/missing/error, and
 * `validate --referential --registry` fails on a missing tag (1), a digest
 * mismatch (1), and a lookup error (3). Every fetch here is a fake.
 */
import { describe, expect, test } from "bun:test";
import { imagePath, type RegistryFetch, resolveImageDigest } from "../../src/hostedapp/registry";
import { runHostedAppCommand } from "../../src/hostedapp/validate";
import type { VaultLookup } from "../../src/hostedapp/vault";

const DECL_PATH = "tests/hostedapp/fixtures/declaration.yaml";
const ENTRY_PATH = "tests/hostedapp/fixtures/registry-entry.yaml";
const ACCEPTED = "sha256:aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff0000000011111111";
const OTHER = `sha256:${"0".repeat(64)}`;

/** A fake HEAD over a fixed path -> response map; absent paths are 404. */
function fakeFetch(map: Record<string, { status: number; digest: string | null }>): RegistryFetch {
	return async (path) => map[path] ?? { status: 404, digest: null };
}

const MANIFEST = "/v2/rtech/linkedin-automation/manifests/v0.3.0";

/** Every Vaultwarden reference in the fixture resolves, so only images decide. */
const allVault: VaultLookup = async () => ({
	status: "found",
	keys: ["SESSION_SECRET", "LINKEDIN_COOKIE", "password"],
});

/** Run `validate --referential --registry` quietly, returning the exit code. */
async function run(registryFetch: RegistryFetch): Promise<number> {
	const out = process.stdout.write;
	const err = process.stderr.write;
	process.stdout.write = () => true;
	process.stderr.write = () => true;
	try {
		return await runHostedAppCommand(
			["validate", DECL_PATH, "--registry", ENTRY_PATH, "--referential"],
			{ vaultLookup: allVault, registryFetch },
		);
	} finally {
		process.stdout.write = out;
		process.stderr.write = err;
	}
}

describe("imagePath", () => {
	test("strips host, tag and digest", () => {
		expect(imagePath(`10.0.20.58:3000/rtech/linkedin-automation:v0.3.0@${ACCEPTED}`)).toBe(
			"rtech/linkedin-automation",
		);
	});
});

describe("resolveImageDigest", () => {
	test("200 with a digest header -> found", async () => {
		const f = fakeFetch({ [MANIFEST]: { status: 200, digest: ACCEPTED } });
		expect(await resolveImageDigest(f, "rtech/linkedin-automation", "v0.3.0")).toEqual({
			status: "found",
			digest: ACCEPTED,
		});
	});

	test("404 -> missing", async () => {
		expect(await resolveImageDigest(fakeFetch({}), "rtech/x", "v1")).toEqual({
			status: "missing",
		});
	});

	test("401 or a thrown fetch -> error", async () => {
		const denied = fakeFetch({ "/v2/rtech/x/manifests/v1": { status: 401, digest: null } });
		expect((await resolveImageDigest(denied, "rtech/x", "v1")).status).toBe("error");
		const thrown: RegistryFetch = async () => {
			throw new Error("ECONNREFUSED");
		};
		expect((await resolveImageDigest(thrown, "rtech/x", "v1")).status).toBe("error");
	});
});

describe("validate --referential image digest", () => {
	test("tag found, digest matches the accepted digest -> 0", async () => {
		expect(await run(fakeFetch({ [MANIFEST]: { status: 200, digest: ACCEPTED } }))).toBe(0);
	});

	test("tag found, digest differs -> 1", async () => {
		expect(await run(fakeFetch({ [MANIFEST]: { status: 200, digest: OTHER } }))).toBe(1);
	});

	test("tag missing -> 1", async () => {
		expect(await run(fakeFetch({}))).toBe(1);
	});

	test("lookup error -> 3", async () => {
		expect(await run(fakeFetch({ [MANIFEST]: { status: 500, digest: null } }))).toBe(3);
	});
});
