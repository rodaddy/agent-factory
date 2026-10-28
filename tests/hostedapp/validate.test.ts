/**
 * Functional tests for the hosted-app validator at its public boundary: YAML
 * text in, a result union or an exit code out. The fixtures are the two
 * examples from the proposal, so a schema change that breaks the documented
 * shape goes red here.
 */
import { describe, expect, test } from "bun:test";
import type { Declaration, RegistryEntry } from "../../src/hostedapp/schema";
import {
	checkIdentity,
	deepMerge,
	type Problem,
	runHostedAppCommand,
	type ValidateResult,
	validateDeclaration,
	validateRegistryEntry,
} from "../../src/hostedapp/validate";

/** The problems of a failed result; a passing or harness result fails the test. */
function problems<T>(r: ValidateResult<T>): Problem[] {
	if (r.ok || !("problems" in r)) throw new Error(`expected problems, got ${JSON.stringify(r)}`);
	return r.problems;
}

const DECL_PATH = "tests/hostedapp/fixtures/declaration.yaml";
const ENTRY_PATH = "tests/hostedapp/fixtures/registry-entry.yaml";

/** The proposal's declaration example, as text. */
async function declarationText(): Promise<string> {
	return await Bun.file(DECL_PATH).text();
}

/** The proposal's registry-entry example, as text. */
async function entryText(): Promise<string> {
	return await Bun.file(ENTRY_PATH).text();
}

/** Parse the fixture declaration, failing the test if it is not valid. */
async function fixtureDeclaration(): Promise<Declaration> {
	const r = validateDeclaration(await declarationText());
	if (!r.ok) throw new Error(`fixture declaration invalid: ${JSON.stringify(r)}`);
	return r.value;
}

/** Parse the fixture registry entry, failing the test if it is not valid. */
async function fixtureEntry(): Promise<RegistryEntry> {
	const r = validateRegistryEntry(await entryText());
	if (!r.ok) throw new Error(`fixture entry invalid: ${JSON.stringify(r)}`);
	return r.value;
}

describe("validateDeclaration", () => {
	test("accepts the proposal's declaration example", async () => {
		const r = validateDeclaration(await declarationText());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.name).toBe("linkedin-automation");
		expect(r.value.targets.map((t) => t.name)).toEqual(["uat", "prod"]);
	});

	test("reports an unknown key with its YAML path", () => {
		const r = validateDeclaration("schema: hosted-app/v1\nbogus: 1\n");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(
			problems(r).some((p) => p.path.includes("bogus") && p.message.startsWith("unknown key")),
		).toBe(true);
	});

	test("malformed YAML is a harness error, not invalid content and not a throw", () => {
		const r = validateDeclaration("schema: [unterminated\n");
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect("harness" in r && r.harness.startsWith("not valid YAML")).toBe(true);
	});

	test("an override that is invalid after merging fails, naming the merged path", async () => {
		const text = (await declarationText()).replace(
			'      runtime:\n        resources:\n          limits: { cpu: "1", memory: 1Gi }',
			"      runtime:\n        port: 70000",
		);
		const r = validateDeclaration(text);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(problems(r).some((p) => p.path.startsWith("targets.prod.merged.runtime.port"))).toBe(
			true,
		);
	});

	test("an override naming a key outside the allowlist fails naming the key", async () => {
		const text = (await declarationText()).replace(
			"        - { host: linkedin-uat.rtech.internal, public: false }",
			"        - { host: linkedin-uat.rtech.internal, public: false }\n      image:\n        build: { containerfile: Other }",
		);
		const r = validateDeclaration(text);
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(problems(r).some((p) => p.message === "overrides may not name image")).toBe(true);
	});
});

describe("deepMerge", () => {
	test("maps merge key by key and lists replace whole", () => {
		expect(deepMerge({ a: { x: 1, y: 2 }, l: [1, 2] }, { a: { y: 3 }, l: [9] })).toEqual({
			a: { x: 1, y: 3 },
			l: [9],
		});
	});

	test("a scalar override replaces a scalar", () => {
		expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
	});
});

describe("validateRegistryEntry", () => {
	test("accepts the proposal's registry example", async () => {
		const r = validateRegistryEntry(await entryText());
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.value.state).toBe("active");
	});
});

describe("checkIdentity", () => {
	test("the two fixtures agree", async () => {
		expect(checkIdentity(await fixtureDeclaration(), await fixtureEntry())).toEqual([]);
	});

	test("a name mismatch is reported", async () => {
		const entry = { ...(await fixtureEntry()), name: "other-app" };
		expect(checkIdentity(await fixtureDeclaration(), entry).some((p) => p.path === "name")).toBe(
			true,
		);
	});

	test("a repo owner mismatch is reported", async () => {
		const entry = { ...(await fixtureEntry()), repo: "someone/linkedin-automation" };
		expect(checkIdentity(await fixtureDeclaration(), entry).some((p) => p.path === "repo")).toBe(
			true,
		);
	});

	test("an entry target the declaration does not declare is reported", async () => {
		const base = await fixtureEntry();
		const entry = {
			...base,
			targets: [...base.targets, { name: "dev" as const, merge: "auto" as const }],
		};
		expect(
			checkIdentity(await fixtureDeclaration(), entry).some((p) =>
				p.message.includes("not declared"),
			),
		).toBe(true);
	});

	test("a missing accepted image is reported", async () => {
		const base = await fixtureEntry();
		const entry = {
			...base,
			accepted: { ...base.accepted, images: { uat: base.accepted.images.uat as never } },
		};
		expect(
			checkIdentity(await fixtureDeclaration(), entry).some(
				(p) => p.path === "accepted.images.prod",
			),
		).toBe(true);
	});

	test("a tag that does not match tag_pattern is reported", async () => {
		const base = await fixtureEntry();
		const uat = base.accepted.images.uat as { tag?: string; image: string };
		const entry = {
			...base,
			accepted: {
				...base.accepted,
				images: { ...base.accepted.images, uat: { ...uat, tag: "0.3.0" } },
			},
		};
		const problems = checkIdentity(await fixtureDeclaration(), entry);
		expect(
			problems.some(
				(p) => p.path === "accepted.images.uat.tag" && p.message.includes("tag_pattern"),
			),
		).toBe(true);
	});

	test("a pinned declaration needs no tag", async () => {
		const decl = await fixtureDeclaration();
		const pinned: Declaration = {
			...decl,
			image: { pinned: { ref: `ghcr.io/x@sha256:${"a".repeat(64)}` } },
		};
		const base = await fixtureEntry();
		const entry = {
			...base,
			accepted: {
				...base.accepted,
				images: {
					uat: { image: `ghcr.io/x@sha256:${"a".repeat(64)}` },
					prod: { image: `ghcr.io/x@sha256:${"a".repeat(64)}` },
				},
			},
		};
		expect(checkIdentity(pinned, entry)).toEqual([]);
	});
});

describe("runHostedAppCommand", () => {
	test("a valid declaration plus registry exits 0", async () => {
		expect(await runHostedAppCommand(["validate", DECL_PATH, "--registry", ENTRY_PATH])).toBe(0);
	});

	test("a valid declaration alone exits 0", async () => {
		expect(await runHostedAppCommand(["validate", DECL_PATH])).toBe(0);
	});

	test("--registry-only validates the entry alone and exits 0", async () => {
		expect(await runHostedAppCommand(["validate", "--registry-only", ENTRY_PATH])).toBe(0);
	});

	test("schema prints a JSON object schema and exits 0", async () => {
		expect(await runHostedAppCommand(["schema"])).toBe(0);
	});

	test("a missing file is a harness error, exit 3", async () => {
		expect(await runHostedAppCommand(["validate", "tests/hostedapp/fixtures/nope.yaml"])).toBe(3);
	});

	test("an unknown subcommand and an unknown option are harness errors", async () => {
		expect(await runHostedAppCommand(["explode"])).toBe(3);
		expect(await runHostedAppCommand(["validate", DECL_PATH, "--wat"])).toBe(3);
		expect(await runHostedAppCommand(["validate", DECL_PATH, "--registry"])).toBe(3);
	});

	test("an invalid declaration exits 1", async () => {
		// A committed fixture: the sandbox checkout is read-only, so tests write nothing.
		const path = `${import.meta.dir}/fixtures/invalid-declaration.yaml`;
		expect(await runHostedAppCommand(["validate", path])).toBe(1);
	});

	test("an invalid registry entry under --registry-only exits 1", async () => {
		const path = `${import.meta.dir}/fixtures/invalid-registry-entry.yaml`;
		expect(await runHostedAppCommand(["validate", "--registry-only", path])).toBe(1);
	});

	test("malformed YAML exits 3, the harness code, not 1", async () => {
		const path = `${import.meta.dir}/fixtures/malformed.yaml`;
		expect(await runHostedAppCommand(["validate", path])).toBe(3);
		expect(await runHostedAppCommand(["validate", "--registry-only", path])).toBe(3);
	});

	test("schema with any argument is bad usage (3)", async () => {
		expect(await runHostedAppCommand(["schema", "--unexpected"])).toBe(3);
	});

	test("--registry-only with a declaration path, or a repeated mode flag, is bad usage (3)", async () => {
		expect(await runHostedAppCommand(["validate", DECL_PATH, "--registry-only", ENTRY_PATH])).toBe(
			3,
		);
		expect(
			await runHostedAppCommand([
				"validate",
				DECL_PATH,
				"--registry",
				ENTRY_PATH,
				"--registry",
				ENTRY_PATH,
			]),
		).toBe(3);
	});
});

describe("checkIdentity with a pinned image", () => {
	const digest = `@sha256:${"c".repeat(64)}`;

	async function pinnedPair(acceptedImage: string): Promise<[Declaration, RegistryEntry]> {
		const declText = (await declarationText()).replace(
			/image:\n {2}build:[\s\S]*?\n(?=\n|runtime:)/,
			`image:\n  pinned:\n    ref: reg/demo:v9${digest}\n`,
		);
		const d = validateDeclaration(declText);
		if (!d.ok) throw new Error(`pinned fixture invalid: ${JSON.stringify(d)}`);
		const entryText_ = (await entryText()).replace(/image: .*/g, `image: ${acceptedImage}`);
		const e = validateRegistryEntry(entryText_);
		if (!e.ok) throw new Error(`pinned entry invalid: ${JSON.stringify(e)}`);
		return [d.value, e.value];
	}

	test("an accepted image equal to the pinned ref passes", async () => {
		const [d, e] = await pinnedPair(`reg/demo:v9${digest}`);
		expect(checkIdentity(d, e)).toEqual([]);
	});

	test("an accepted image with a different digest is a mismatch, one line per target", async () => {
		const [d, e] = await pinnedPair(`reg/demo:v9@sha256:${"d".repeat(64)}`);
		const found = checkIdentity(d, e);
		expect(found.length).toBe(e.targets.length);
		expect(found.every((p) => p.path.endsWith(".image") && p.message.includes("pinned ref"))).toBe(
			true,
		);
	});
});
