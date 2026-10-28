/** Expected profiles only; actual child execution requires separate trusted receipts. */
export interface ReviewParentChildren {
	readonly gpt: { readonly model: "gpt-6.1-sol"; readonly effort: "low" };
	readonly claude: { readonly model: "claude-sonnet-5-5"; readonly effort: "medium" };
}
export interface ReviewParentTrustedFacts {
	readonly companyId: string;
	readonly repositoryId: number;
	/** Existing protected host-registry association; never inferred from an issue body or author choice. */
	readonly workItemId: string;
	readonly repo: string;
	readonly pr: number;
	readonly parentIssueId: string;
	readonly headSha: string;
	readonly baseSha: string;
}
export interface ReviewParentBinding extends ReviewParentTrustedFacts {
	readonly version: 1;
	readonly kind: "review-parent";
	readonly children: ReviewParentChildren;
}
export interface ReviewParentStateKey {
	readonly scopeKind: "company";
	readonly scopeId: string;
	readonly namespace: "forge-pr";
	readonly stateKey: string;
}
export const REVIEW_PARENT_CHILDREN: ReviewParentChildren;
/** Caller must supply host-owned facts. Throws on missing, invalid or additional fields. */
export function buildReviewParentBinding(trusted: ReviewParentTrustedFacts): ReviewParentBinding;
export function validateReviewParentBinding(value: unknown): ReviewParentBinding;
export function reviewParentStateKey(
	companyId: string,
	parentIssueId: string,
): ReviewParentStateKey;
export function verifyReviewParentBindingReadback(
	value: unknown,
	expected: ReviewParentBinding,
): ReviewParentBinding;
/** Reader must be bound to the known installed plugin; no caller-supplied plugin ID. */
export function readReviewParentBinding(
	readState: (key: ReviewParentStateKey) => Promise<unknown>,
	expected: ReviewParentBinding,
): Promise<ReviewParentBinding>;
