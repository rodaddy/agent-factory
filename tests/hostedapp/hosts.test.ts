/**
 * Functional tests for the hostname-claim referential check (lane 832c):
 * hosts are extracted from a k3s-deploy checkout's IngressRoute `Host()`
 * matches and Certificate `dnsNames`, keyed by the owning app directory, and
 * `validate --referential --k3s-deploy-dir` fails only on a host claimed by a
 * DIFFERENT app. Unclaimed and self-claimed hosts pass.
 */
import { describe, expect, test } from "bun:test";
import { checkHostnameClaims, collectHostClaims } from "../../src/hostedapp/hosts";
import { runHostedAppCommand, validateDeclaration } from "../../src/hostedapp/validate";
import type { VaultLookup } from "../../src/hostedapp/vault";

const DECL_PATH = "tests/hostedapp/fixtures/declaration.yaml";
const FREE = "tests/hostedapp/fixtures/k3s-deploy-free";
const TAKEN = "tests/hostedapp/fixtures/k3s-deploy-taken";

/** A vault fake where every item exists with every key, so only hosts can fail. */
const allFound: VaultLookup = async () => ({
	status: "found",
	keys: ["SESSION_SECRET", "LINKEDIN_COOKIE", "password"],
});

/** Parse the fixture declaration, failing the test if it does not validate. */
async function fixtureDecl() {
	const r = validateDeclaration(await Bun.file(DECL_PATH).text());
	if (!r.ok) throw new Error("fixture declaration invalid");
	return r.value;
}

/** Run `validate` quietly, returning the exit code and everything printed. */
async function run(args: string[]): Promise<{ code: number; out: string }> {
	const out = process.stdout.write;
	const err = process.stderr.write;
	let text = "";
	const capture = (chunk: string | Uint8Array) => {
		text += String(chunk);
		return true;
	};
	process.stdout.write = capture as typeof process.stdout.write;
	process.stderr.write = capture as typeof process.stderr.write;
	try {
		return { code: await runHostedAppCommand(args, { vaultLookup: allFound }), out: text };
	} finally {
		process.stdout.write = out;
		process.stderr.write = err;
	}
}

describe("collectHostClaims", () => {
	test("reads IngressRoute Host() matches and Certificate dnsNames per app dir", async () => {
		const claims = await collectHostClaims(FREE);
		expect(claims.get("linkedin.example.net")).toEqual(["linkedin-automation-prod"]);
		expect(claims.get("other.example.net")).toEqual(["other-app-prod"]);
		expect(claims.get("www.other.example.net")).toEqual(["other-app-prod"]);
		expect(claims.get("certonly.example.net")).toEqual(["other-app-prod"]);
	});
});

describe("checkHostnameClaims", () => {
	test("unclaimed and self-claimed hosts pass", async () => {
		expect(checkHostnameClaims(await fixtureDecl(), await collectHostClaims(FREE))).toEqual([]);
	});

	test("a host claimed by a different app fails naming both apps", async () => {
		const problems = checkHostnameClaims(await fixtureDecl(), await collectHostClaims(TAKEN));
		expect(problems).toEqual([
			{
				path: "targets.uat.overrides.hostnames.0.host",
				message:
					"host linkedin-uat.rtech.internal is already claimed by other-app-uat, not linkedin-automation",
			},
		]);
	});
});

describe("validate --referential --k3s-deploy-dir", () => {
	test("unclaimed and self-claimed hosts exit 0", async () => {
		const r = await run(["validate", DECL_PATH, "--referential", "--k3s-deploy-dir", FREE]);
		expect(r.code).toBe(0);
	});

	test("a host claimed by another app exits 1 naming both apps", async () => {
		const r = await run(["validate", DECL_PATH, "--referential", "--k3s-deploy-dir", TAKEN]);
		expect(r.code).toBe(1);
		expect(r.out).toContain("other-app-uat");
		expect(r.out).toContain("linkedin-automation");
	});

	test("without --k3s-deploy-dir the hostname check is skipped with a note", async () => {
		const r = await run(["validate", DECL_PATH, "--referential"]);
		expect(r.code).toBe(0);
		expect(r.out).toContain("hostname claims skipped");
	});
});

describe("validate --referential --registry token guard", () => {
	test("an empty FORGE_TOKEN and FORGEJO_TOKEN exit 3 before any registry HEAD", async () => {
		const saved = { a: process.env.FORGE_TOKEN, b: process.env.FORGEJO_TOKEN };
		process.env.FORGE_TOKEN = "";
		delete process.env.FORGEJO_TOKEN;
		try {
			const r = await run([
				"validate",
				DECL_PATH,
				"--registry",
				"tests/hostedapp/fixtures/registry-entry.yaml",
				"--referential",
			]);
			expect(r.code).toBe(3);
			expect(r.out).toContain("FORGE_TOKEN (or FORGEJO_TOKEN) is empty");
		} finally {
			if (saved.a === undefined) delete process.env.FORGE_TOKEN;
			else process.env.FORGE_TOKEN = saved.a;
			if (saved.b !== undefined) process.env.FORGEJO_TOKEN = saved.b;
		}
	});
});

describe("collectHostClaims fs errors (verdict sweep H, PR 892)", () => {
	const MISSING = "tests/hostedapp/fixtures/k3s-deploy-does-not-exist";
	const APPS_FILE = "tests/hostedapp/fixtures/k3s-deploy-apps-file";

	test("a missing manifests/apps root rejects with a named reason, never an empty claim set", async () => {
		await expect(collectHostClaims(MISSING)).rejects.toThrow(/manifests\/apps not found/);
	});

	test("any other fs error on the root propagates (manifests/apps is a file: ENOTDIR)", async () => {
		await expect(collectHostClaims(APPS_FILE)).rejects.toMatchObject({ code: "ENOTDIR" });
	});

	test("validate --referential exits 3 naming the missing k3s-deploy manifests root", async () => {
		const r = await run(["validate", DECL_PATH, "--referential", "--k3s-deploy-dir", MISSING]);
		expect(r.code).toBe(3);
		expect(r.out).toContain("manifests/apps not found");
	});
});

describe("collectHostClaims walks all of manifests/**", () => {
	test("a nested app file counts under its slug", async () => {
		const claims = await collectHostClaims(FREE);
		expect(claims.get("ops.example.test")).toEqual(["ops"]);
	});

	test("a host claimed by a non-app dir fails naming both owners", async () => {
		const decl = await fixtureDecl();
		const first = decl.hostnames[0];
		if (first === undefined) throw new Error("fixture declaration has no hostnames");
		const withAuth = { ...decl, hostnames: [{ ...first, host: "auth.example.test" }] };
		expect(checkHostnameClaims(withAuth, await collectHostClaims(FREE))).toEqual([
			{
				path: "hostnames.0.host",
				message:
					"host auth.example.test is already claimed by authentik (non-app), not linkedin-automation",
			},
		]);
	});
});
