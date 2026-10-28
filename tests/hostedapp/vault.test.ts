/**
 * Functional tests for the Vaultwarden referential check (lane 832a):
 * the envelope parser returns key NAMES only and treats a fuzzy match to a
 * different item as missing, and `validate --referential` fails on a missing
 * item or a missing key. Every lookup here is a fake; nothing calls mcp2cli.
 */
import { describe, expect, test } from "bun:test";
import {
	checkVaultReferences,
	runHostedAppCommand,
	validateDeclaration,
} from "../../src/hostedapp/validate";
import { keyNamesOf, type VaultLookup } from "../../src/hostedapp/vault";

const DECL_PATH = "tests/hostedapp/fixtures/declaration.yaml";

/** A fake lookup over a fixed item -> key-names map; absent items are missing. */
function fakeLookup(items: Record<string, string[]>): VaultLookup {
	return async (item) =>
		Object.hasOwn(items, item)
			? { status: "found", keys: items[item] ?? [] }
			: { status: "missing" };
}

/** Every item and key the fixture declaration references. */
const COMPLETE = {
	"Example App - app": ["SESSION_SECRET", "LINKEDIN_COOKIE", "notes"],
	"Example App - db": ["password"],
};

describe("keyNamesOf", () => {
	test("returns the field names of an exact match, never a value", () => {
		const r = keyNamesOf(
			{
				success: true,
				result: { name: "X - app", matchType: "exact", fields: { API_KEY: "s3cret" } },
			},
			"X - app",
		);
		expect(r).toEqual({ status: "found", keys: ["API_KEY"] });
		expect(JSON.stringify(r)).not.toContain("s3cret");
	});

	test("a fuzzy match to a different item is missing, not found", () => {
		const r = keyNamesOf(
			{ success: true, result: { name: "Other - item", matchType: "fuzzy", fields: { k: "v" } } },
			"X - app",
		);
		expect(r).toEqual({ status: "missing" });
	});

	test("an unexpected body is an error", () => {
		expect(keyNamesOf("nope", "X - app").status).toBe("error");
	});
});

describe("checkVaultReferences", () => {
	test("every item and key present -> no problems", async () => {
		const decl = validateDeclaration(await Bun.file(DECL_PATH).text());
		if (!decl.ok) throw new Error("fixture invalid");
		expect(await checkVaultReferences(decl.value, fakeLookup(COMPLETE))).toEqual({
			ok: true,
			problems: [],
		});
	});

	test("a missing item is a problem at its YAML path", async () => {
		const decl = validateDeclaration(await Bun.file(DECL_PATH).text());
		if (!decl.ok) throw new Error("fixture invalid");
		const lookup = fakeLookup({ "Example App - db": ["password"] });
		const r = await checkVaultReferences(decl.value, lookup);
		expect(r).toEqual({
			ok: true,
			problems: [
				{
					path: "secrets.0.vaultwarden_item",
					message: "Vaultwarden item Example App - app not found",
				},
			],
		});
	});

	test("a missing key is a problem at its YAML path", async () => {
		const decl = validateDeclaration(await Bun.file(DECL_PATH).text());
		if (!decl.ok) throw new Error("fixture invalid");
		const lookup = fakeLookup({ ...COMPLETE, "Example App - app": ["SESSION_SECRET"] });
		const r = await checkVaultReferences(decl.value, lookup);
		expect(r).toEqual({
			ok: true,
			problems: [
				{
					path: "secrets.0.keys.1",
					message: "key LINKEDIN_COOKIE not in Vaultwarden item Example App - app",
				},
			],
		});
	});

	test("a missing database password item is a problem", async () => {
		const decl = validateDeclaration(await Bun.file(DECL_PATH).text());
		if (!decl.ok) throw new Error("fixture invalid");
		const lookup = fakeLookup({
			"Example App - app": COMPLETE["Example App - app"],
		});
		const r = await checkVaultReferences(decl.value, lookup);
		expect(r.ok && r.problems.map((p) => p.path)).toEqual(["database.password_item"]);
	});
});

describe("validate --referential", () => {
	test("all references resolve -> exit 0", async () => {
		expect(
			await runHostedAppCommand(["validate", DECL_PATH, "--referential"], {
				vaultLookup: fakeLookup(COMPLETE),
			}),
		).toBe(0);
	});

	test("a missing item -> exit 1", async () => {
		expect(
			await runHostedAppCommand(["validate", DECL_PATH, "--referential"], {
				vaultLookup: fakeLookup({}),
			}),
		).toBe(1);
	});

	test("a lookup error -> harness error, exit 3", async () => {
		expect(
			await runHostedAppCommand(["validate", DECL_PATH, "--referential"], {
				vaultLookup: async () => ({ status: "error", error: "mcp2cli failed" }),
			}),
		).toBe(3);
	});

	test("without the flag the lookup is never called", async () => {
		let called = false;
		const lookup: VaultLookup = async () => {
			called = true;
			return { status: "missing" };
		};
		expect(await runHostedAppCommand(["validate", DECL_PATH], { vaultLookup: lookup })).toBe(0);
		expect(called).toBe(false);
	});
});
