import { describe, expect, test } from "bun:test";
import { validateInput } from "../../scripts/actions/validate-inputs";
import { VERB_IDS } from "../../src/jobs/verb-dispatch";

describe("validateInput", () => {
	test("accepts the three shapes", () => {
		expect(validateInput("repo", "rtech/rtech-infra")).toBe(true);
		expect(validateInput("int", "42")).toBe(true);
		expect(validateInput("sha", "0123456789abcdef0123456789abcdef01234567")).toBe(true);
		expect(validateInput("level", "info")).toBe(true);
		expect(validateInput("level", "debug")).toBe(true);
	});

	test("refuses anything else", () => {
		for (const bad of ["rtech", "a/b/c", "../x", "a/.git", "a/b;rm", "a/b\n", ""]) {
			expect(validateInput("repo", bad)).toBe(false);
		}
		for (const bad of ["0", "-1", "1.5", "01", "1e3", "12 "]) {
			expect(validateInput("int", bad)).toBe(false);
		}
		for (const bad of ["0123456789ABCDEF0123456789abcdef01234567", "0123456", "main"]) {
			expect(validateInput("sha", bad)).toBe(false);
		}
		for (const bad of ["trace", "DEBUG", "info ", "", "warn"]) {
			expect(validateInput("level", bad)).toBe(false);
		}
		expect(validateInput("ref", "main")).toBe(false);
	});
});

describe("validateInput verb, label and sha256 kinds", () => {
	test("verb accepts exactly VERB_IDS and rejects a seventh verb", () => {
		for (const verb of VERB_IDS) {
			expect(validateInput("verb", verb)).toBe(true);
		}
		for (const bad of ["newsite", "NEWAPP", "newapp ", "newapp;x", "", "newapp-downx"]) {
			expect(validateInput("verb", bad)).toBe(false);
		}
	});

	test("label is a DNS label and sha256 is 64 lowercase hex", () => {
		expect(validateInput("label", "demo-app1")).toBe(true);
		for (const bad of ["-demo", "demo-", "Demo", "a.b", "", "a".repeat(64)]) {
			expect(validateInput("label", bad)).toBe(false);
		}
		expect(validateInput("sha256", "e".repeat(64))).toBe(true);
		for (const bad of ["e".repeat(40), "E".repeat(64), "e".repeat(65)]) {
			expect(validateInput("sha256", bad)).toBe(false);
		}
	});
});
