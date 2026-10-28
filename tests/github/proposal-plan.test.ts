/**
 * @module tests/github/proposal-plan
 * @description Tests for the change-proposal plan: the branch name the
 *   watcher will push is derived only from a validated integer, never from
 *   runner output, so these pin that derivation and the fail-closed behaviour
 *   for anything that is not a usable item number.
 */
import { describe, expect, test } from "bun:test";
import { PROPOSAL_BRANCH_PREFIX, proposalBranchFor } from "../../src/github/publication";
import { VERB_IDS } from "../../src/jobs/verb-dispatch";
import { IMPLEMENT_TEMPLATE_ID } from "../../src/templates/registry";

describe("proposalBranchFor", () => {
	test("keeps non-verb proposals on the existing rw branch", () => {
		expect(proposalBranchFor(42, IMPLEMENT_TEMPLATE_ID)).toBe("rw/issue-42");
		expect(proposalBranchFor(1, "repository-validate")).toBe("rw/issue-1");
	});

	test("derives an allowlisted verb branch from the verb and item number", () => {
		for (const verb of VERB_IDS) {
			expect(proposalBranchFor(42, verb)).toBe(`verb/${verb}-42`);
		}
	});

	test("only non-verb branches sit inside the reserved rw prefix", () => {
		// The rw prefix is what branch protection scopes on for implement proposals;
		// verb proposals have their own reviewed namespace.
		for (const n of [1, 7, 999, 1_000_000]) {
			expect(proposalBranchFor(n, IMPLEMENT_TEMPLATE_ID)?.startsWith(PROPOSAL_BRANCH_PREFIX)).toBe(
				true,
			);
		}
	});

	test("fails closed for anything that is not a positive integer", () => {
		// A null forces the caller to refuse rather than push to a guessed ref.
		for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(proposalBranchFor(bad, "newapp")).toBeNull();
		}
	});

	test("cannot be influenced by runner-supplied item or verb strings", () => {
		// The item signature takes a number, so injection would have to survive
		// coercion. The verb component is emitted only for the fixed allowlist.
		expect(proposalBranchFor(Number("42; rm -rf /"), "newapp")).toBeNull();
		expect(proposalBranchFor(Number("../../main"), "newapp")).toBeNull();
		expect(proposalBranchFor(Number("main"), "newapp")).toBeNull();
		expect(proposalBranchFor(42, "newapp/../../main")).toBe("rw/issue-42");
	});
});
