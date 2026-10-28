/**
 * @module tests/github/eligibility
 * @description Pins `itemIneligibilityReason`: the one place the
 *   queue-time and publish-time gates learn WHY an item-level write is refused.
 *   `isItemEligible` must stay exactly its null test, so a reason that is
 *   introduced without changing eligibility cannot change a decision.
 */
import { describe, expect, test } from "bun:test";
import { isItemEligible, itemIneligibilityReason } from "../../src/github/eligibility";

const SHA = "deadbeef";

describe("itemIneligibilityReason", () => {
	test("an open issue is eligible: no reason", () => {
		const input = { kind: "issue", state: "open", headSha: null, jobSha: SHA };
		expect(itemIneligibilityReason(input)).toBeNull();
		expect(isItemEligible(input)).toBe(true);
	});

	test("an open PR on the job SHA is eligible: no reason", () => {
		const input = { kind: "pull", state: "open", headSha: SHA, jobSha: SHA };
		expect(itemIneligibilityReason(input)).toBeNull();
		expect(isItemEligible(input)).toBe(true);
	});

	test("a closed or merged item is `closed`, whatever its kind", () => {
		for (const state of ["closed", "merged", null]) {
			for (const kind of ["issue", "pull"]) {
				const input = { kind, state, headSha: SHA, jobSha: SHA };
				expect(itemIneligibilityReason(input)).toBe("closed");
				expect(isItemEligible(input)).toBe(false);
			}
		}
	});

	test("an open PR whose head moved is `stale-head`", () => {
		for (const headSha of ["feed0000feed", null]) {
			const input = { kind: "pull", state: "open", headSha, jobSha: SHA };
			expect(itemIneligibilityReason(input)).toBe("stale-head");
			expect(isItemEligible(input)).toBe(false);
		}
	});

	test("an open item of an unknown kind is `unknown-kind`", () => {
		const input = { kind: "discussion", state: "open", headSha: null, jobSha: SHA };
		expect(itemIneligibilityReason(input)).toBe("unknown-kind");
		expect(isItemEligible(input)).toBe(false);
	});
});
