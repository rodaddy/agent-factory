/**
 * @module tests/reconcile/sweep-scope
 * @description One sweep, ONE cap: the operator's
 *   `maxDispatchPerPass` is resolved once, by the same rule the generic pass
 *   applies, and both the shared budget and the generic shortlist read that one
 *   number. Two independent parsings let a cap outside the generic pass's clamp
 *   bound the two lanes differently.
 */
import { describe, expect, test } from "bun:test";
import { MAX_DISPATCH_PER_PASS, resolveDispatchCap } from "../../src/reconcile/dispatch-pass";
import { createSweepScope } from "../../src/reconcile/sweep-scope";

const NOW = new Date("2026-09-10T00:00:00.000Z");

describe("createSweepScope resolves the cap once, by the generic pass's rule", () => {
	test("absent means the operator default, and the budget carries exactly it", () => {
		const scope = createSweepScope({}, NOW);
		expect(scope.maxDispatchPerPass).toBe(MAX_DISPATCH_PER_PASS);
		expect(scope.passBudget.max).toBe(MAX_DISPATCH_PER_PASS);
	});

	test("a cap above the clamp is clamped for BOTH the budget and the shortlist", () => {
		const scope = createSweepScope({ maxDispatchPerPass: 9000 }, NOW);
		expect(scope.maxDispatchPerPass).toBe(resolveDispatchCap(9000));
		expect(scope.passBudget.max).toBe(scope.maxDispatchPerPass);
		expect(scope.maxDispatchPerPass).toBe(5000);
	});

	test("a cap of zero resolves to the generic pass's floor of one, not a closed budget", () => {
		const scope = createSweepScope({ maxDispatchPerPass: 0 }, NOW);
		expect(scope.maxDispatchPerPass).toBe(1);
		expect(scope.passBudget.remaining()).toBe(1);
	});

	test("a shared budget is used as given; the cap still reports the resolved number", () => {
		const shared = createSweepScope({ maxDispatchPerPass: 3 }, NOW);
		const scope = createSweepScope({ maxDispatchPerPass: 3 }, NOW, {
			passBudget: shared.passBudget,
		});
		expect(scope.passBudget).toBe(shared.passBudget);
		expect(scope.maxDispatchPerPass).toBe(3);
	});
});

describe("resolveDispatchCap normalizes to a finite integer before clamping", () => {
	test("NaN is the operator default, not a NaN LIMIT", () => {
		expect(resolveDispatchCap(Number.NaN)).toBe(MAX_DISPATCH_PER_PASS);
		const scope = createSweepScope({ maxDispatchPerPass: Number.NaN }, NOW);
		expect(scope.passBudget.max).toBe(MAX_DISPATCH_PER_PASS);
	});

	test("a fraction is floored, so the shortlist LIMIT and the budget agree", () => {
		expect(resolveDispatchCap(2.7)).toBe(2);
		const scope = createSweepScope({ maxDispatchPerPass: 2.7 }, NOW);
		expect(scope.passBudget.max).toBe(2);
		expect(scope.passBudget.remaining()).toBe(2);
	});

	test("an infinite cap clamps like any oversized one", () => {
		expect(resolveDispatchCap(Number.POSITIVE_INFINITY)).toBe(5000);
		expect(resolveDispatchCap(Number.NEGATIVE_INFINITY)).toBe(1);
	});
});
