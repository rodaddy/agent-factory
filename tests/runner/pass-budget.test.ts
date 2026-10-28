import { describe, expect, test } from "bun:test";
import { createPassBudget, settleReservation } from "../../src/runner/pass-budget";

describe("settleReservation refunds only on proof of no box", () => {
	test("a proven-no-box outcome refunds; every other outcome keeps the slot", () => {
		const budget = createPassBudget(1);
		expect(budget.take()).toBe(true);
		settleReservation(budget, { status: "queued", provenNoBox: true });
		expect(budget.remaining()).toBe(1);
		expect(budget.take()).toBe(true);
		settleReservation(budget, { status: "error" });
		expect(budget.remaining()).toBe(0);
		settleReservation(budget, { status: "dispatched" });
		expect(budget.remaining()).toBe(0);
		settleReservation(undefined, { status: "skipped", provenNoBox: true });
	});
});

describe("refund gives a reserved slot back, never below zero", () => {
	test("take, refund, take again fits in a cap of one", () => {
		const budget = createPassBudget(1);
		expect(budget.take()).toBe(true);
		expect(budget.take()).toBe(false);
		budget.refund();
		expect(budget.remaining()).toBe(1);
		expect(budget.take()).toBe(true);
	});

	test("a refund with nothing taken leaves the budget at its cap", () => {
		const budget = createPassBudget(2);
		budget.refund();
		expect(budget.remaining()).toBe(2);
	});
});

describe("createPassBudget", () => {
	test("spends exactly max slots and then refuses", () => {
		const budget = createPassBudget(3);
		expect(budget.max).toBe(3);
		expect(budget.remaining()).toBe(3);
		expect([budget.take(), budget.take(), budget.take()]).toEqual([true, true, true]);
		expect(budget.remaining()).toBe(0);
		expect(budget.take()).toBe(false);
		expect(budget.remaining()).toBe(0);
	});

	test("a malformed cap fails closed", () => {
		for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			const budget = createPassBudget(bad);
			expect(budget.max).toBe(0);
			expect(budget.take()).toBe(false);
		}
		expect(createPassBudget(2.9).max).toBe(2);
	});
});
