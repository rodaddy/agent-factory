import { describe, expect, test } from "bun:test";
import type { LabelJobEntry } from "../../src/control-surface";
import {
	COLUMN_VOCABULARY,
	columnStateFor,
	LABEL_JOB_REGISTRY,
	resolveLabelDecision,
} from "../../src/control-surface";
import { JOB_TEMPLATE_IDS } from "../../src/templates/registry";

describe("label vocabulary", () => {
	test("is runtime-enumerable data with at least one entry", () => {
		expect(Array.isArray(LABEL_JOB_REGISTRY)).toBe(true);
		expect(LABEL_JOB_REGISTRY.length).toBeGreaterThan(0);
	});

	test("names only job templates that are already allowlisted in code", () => {
		// The vocabulary may only NARROW the closed template allowlist. A row
		// naming a template that does not exist would propose an undispatchable
		// job that fails far from here, at the runner boundary.
		for (const entry of LABEL_JOB_REGISTRY) {
			if (entry.job !== null) {
				expect(JOB_TEMPLATE_IDS as readonly string[]).toContain(entry.job);
			}
		}
	});

	test("carries no duplicate label tokens", () => {
		const labels = LABEL_JOB_REGISTRY.map((e) => e.label);
		expect(new Set(labels).size).toBe(labels.length);
	});

	test("keeps rtech-infra's existing factory-implement opt-in bound to the implement lane", () => {
		const row = LABEL_JOB_REGISTRY.find((e) => e.label === "factory-implement");
		expect(row?.job).toBe("implement-issue");
	});
});

describe("resolveLabelDecision", () => {
	test("resolves an exact vocabulary label to its job template", () => {
		const decision = resolveLabelDecision(["factory-triage"]);
		expect(decision.job).toBe("issue-triage");
		expect(decision.label).toBe("factory-triage");
	});

	test("returns an explicit no-decision for an unknown label, never a throw", () => {
		const decision = resolveLabelDecision(["not-a-factory-label"]);
		expect(decision).not.toBeNull();
		expect(decision.job).toBeNull();
		expect(decision.reason.length).toBeGreaterThan(0);
	});

	test("returns an explicit no-decision for no labels at all", () => {
		const decision = resolveLabelDecision([]);
		expect(decision.job).toBeNull();
		expect(decision.reason).toContain("no labels");
	});

	test("treats null and undefined input as no labels rather than crashing", () => {
		expect(resolveLabelDecision(null).job).toBeNull();
		expect(resolveLabelDecision(undefined).job).toBeNull();
	});

	test("resolves parameterized deploy and spin-down labels through the verb registry", () => {
		const deploy = resolveLabelDecision(["deploy:paperless"]);
		expect(deploy.label).toBe("deploy:");
		expect(deploy.parameter).toBe("paperless");
		expect(deploy.job).toBe("newapp");

		const spindown = resolveLabelDecision(["spindown:paperless"]);
		expect(spindown.label).toBe("spindown:");
		expect(spindown.parameter).toBe("paperless");
		expect(spindown.job).toBe("newapp-down");
	});

	test("does not match a bare verb prefix carrying no parameter", () => {
		const decision = resolveLabelDecision(["deploy:"]);
		expect(decision.label).toBeNull();
		expect(decision.job).toBeNull();
	});

	test("prefers an exact match over a parameterized one regardless of order", () => {
		// Determinism by construction, not by iteration accident: the parameterized
		// row is listed FIRST here, and the exact row must still win.
		const registry: LabelJobEntry[] = [
			{ label: "x:", job: "issue-triage", parameterized: true, note: "prefix" },
			{ label: "x:y", job: "pr-review", note: "exact" },
		];
		expect(resolveLabelDecision(["x:y"], registry).job).toBe("pr-review");
	});

	test("is deterministic — the same labels yield the same decision every time", () => {
		const first = resolveLabelDecision(["factory-review", "unrelated"]);
		const second = resolveLabelDecision(["factory-review", "unrelated"]);
		expect(second).toEqual(first);
	});
});

describe("columnStateFor", () => {
	test("maps the recorded Project 11 status names to lifecycle states", () => {
		expect(columnStateFor("Todo")).toBe("queued");
		expect(columnStateFor("In Progress")).toBe("dispatched");
		expect(columnStateFor("In Review")).toBe("receipted");
		expect(columnStateFor("Blocked")).toBe("held");
	});

	test("maps a board that names its columns for the states directly", () => {
		expect(columnStateFor("queued")).toBe("queued");
		expect(columnStateFor("held")).toBe("held");
	});

	test("is case-insensitive and trims surrounding whitespace", () => {
		expect(columnStateFor("  in progress  ")).toBe("dispatched");
	});

	test("returns null for an unmapped column rather than guessing", () => {
		expect(columnStateFor("Icebox")).toBeNull();
	});

	test("returns null for a null or non-string column", () => {
		expect(columnStateFor(null)).toBeNull();
		expect(columnStateFor(undefined)).toBeNull();
	});

	test("every vocabulary value is one of the four lifecycle states", () => {
		for (const state of Object.values(COLUMN_VOCABULARY)) {
			expect(["queued", "dispatched", "receipted", "held"]).toContain(state);
		}
	});
});
