import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { testArchiveDir, testTmpBase } from "../support/test-temp.ts";
import { issuerProof, withIssuerArchive } from "./support/receipt-issuer-proof.ts";

test("issuer proof refuses a different source HEAD before importing issuer code", async () => {
	await expect(issuerProof(process.cwd())).rejects.toThrow(
		"issuer proof source must be clean at f1d63efa",
	);
});

test("issuer archive preserves proof failure and cleanup diagnostics", async () => {
	const original = new Error("original issuer assertion");
	for (const code of ["EXDEV", "ENOENT"]) {
		const cleanup = Object.assign(new Error(code), { code });
		try {
			await withIssuerArchive(
				"retained-fixture",
				async () => {
					throw original;
				},
				() => {
					throw cleanup;
				},
			);
			throw new Error("must reject");
		} catch (error) {
			expect(error).toBeInstanceOf(AggregateError);
			const combined = error as AggregateError;
			expect(combined.cause).toBe(original);
			expect(combined.errors).toEqual([original, cleanup]);
			expect(combined.message).toContain("retained-fixture");
		}
	}
});

test("successful issuer proof still reports archival failure", async () => {
	await expect(
		withIssuerArchive(
			"retained-fixture",
			async () => "proof",
			() => {
				throw new Error("EXDEV");
			},
		),
	).rejects.toThrow("issuer archive failed; fixture retained at retained-fixture");
});

test("issuer archive moves real fixture bytes and preserves result or original failure", async () => {
	for (const fails of [false, true]) {
		const root = mkdtempSync(join(testTmpBase(), "issuer-archive-test-"));
		writeFileSync(join(root, "proof.txt"), "evidence");
		const original = new Error("proof failed");
		const result = withIssuerArchive(root, async () => {
			if (fails) throw original;
			return "proof";
		});
		if (fails) await expect(result).rejects.toBe(original);
		else expect(await result).toBe("proof");
		expect(existsSync(root)).toBe(false);
		expect(readFileSync(join(testArchiveDir(), basename(root), "proof.txt"), "utf8")).toBe(
			"evidence",
		);
	}
});
