import { describe, expect, test } from "bun:test";
import {
	buildReviewParentBinding,
	readReviewParentBinding,
	reviewParentStateKey,
	validateReviewParentBinding,
	verifyReviewParentBindingReadback,
} from "../../fleet/admission/review-parent-binding.js";

const trusted = {
	companyId: "company-1",
	repositoryId: 42,
	workItemId: "work-7",
	repo: "Rodaddy/Software-Factory",
	pr: 7,
	parentIssueId: "parent-1",
	headSha: "a".repeat(40),
	baseSha: "b".repeat(40),
};

describe("protected parent review binding", () => {
	test("builds a normalized immutable pair and reads the exact issue-scoped record", async () => {
		const expected = buildReviewParentBinding(trusted);
		expect(expected.repo).toBe("rodaddy/software-factory");
		expect(expected.children).toEqual({
			gpt: { model: "gpt-6.1-sol", effort: "low" },
			claude: { model: "claude-sonnet-5-5", effort: "medium" },
		});
		expect(Object.isFrozen(expected.children.gpt)).toBe(true);
		expect(Object.isFrozen(expected)).toBe(true);
		const keys: unknown[] = [];
		const stored = JSON.parse(JSON.stringify(expected));
		const read = await readReviewParentBinding(async (key) => {
			keys.push(key);
			return stored;
		}, expected);
		expect(keys).toEqual([
			{
				scopeKind: "company",
				scopeId: "company-1",
				namespace: "forge-pr",
				stateKey: "review-parent:v1:parent-1",
			},
		]);
		expect(read).toEqual(expected);
		stored.baseSha = "c".repeat(40);
		expect(read.baseSha).toBe(trusted.baseSha);
		expect(reviewParentStateKey("company-1", "parent/1").stateKey).toBe(
			"review-parent:v1:parent%2F1",
		);
	});

	test("holds absent or malformed identities and never infers them from task metadata", () => {
		for (const input of [
			{ ...trusted, repositoryId: "42" },
			{ ...trusted, workItemId: undefined },
			{ ...trusted, pr: 0 },
			{ ...trusted, parentIssueId: "" },
			{ ...trusted, companyId: "company\uD800" },
			{ ...trusted, repo: "../software-factory" },
			{ ...trusted, headSha: "aaaaaaa" },
			{ ...trusted, baseSha: undefined },
			{ ...trusted, originKind: "plugin:forge-pr", title: "Review #7" },
		]) {
			expect(() => buildReviewParentBinding(input as typeof trusted)).toThrow();
		}
		expect(() => validateReviewParentBinding(null)).toThrow();
		const valid = buildReviewParentBinding(trusted);
		for (const value of [
			{ ...valid, version: 2 },
			{ ...valid, repo: trusted.repo },
			{ ...valid, children: { gpt: valid.children.gpt } },
			{ ...valid, children: { ...valid.children, gpt: { model: "other", effort: "low" } } },
			{
				...valid,
				children: { ...valid.children, claude: { model: "claude-sonnet-5-5", effort: "low" } },
			},
			{ ...valid, trusted: true, actorAgentId: "attacker" },
		]) {
			expect(() => validateReviewParentBinding(value)).toThrow();
		}
	});

	test("readback rejects every changed authority field and propagates storage failure", async () => {
		const expected = buildReviewParentBinding(trusted);
		for (const changes of [
			{ companyId: "company-2" },
			{ repositoryId: 43 },
			{ workItemId: "author-selected-new-work" },
			{ repo: "rodaddy/another" },
			{ pr: 8 },
			{ parentIssueId: "parent-2" },
			{ headSha: "c".repeat(40) },
			{ baseSha: "c".repeat(40) },
		]) {
			expect(() =>
				verifyReviewParentBindingReadback({ ...expected, ...changes }, expected),
			).toThrow("binding mismatch");
		}
		await expect(readReviewParentBinding(async () => undefined, expected)).rejects.toThrow();
		await expect(
			readReviewParentBinding(async () => {
				throw new Error("store unavailable");
			}, expected),
		).rejects.toThrow("store unavailable");
	});
});
