// Pure contract for protected forge-pr plugin state. These helpers do not
// authenticate a caller: only the trusted host/producer may supply facts or
// a state reader. Agent-authored issue fields are never a source of authority.
export const REVIEW_PARENT_CHILDREN = Object.freeze({
	gpt: Object.freeze({ model: "gpt-6.1-sol", effort: "low" }),
	claude: Object.freeze({ model: "claude-sonnet-5-5", effort: "medium" }),
});

const FIELDS = [
	"companyId",
	"repositoryId",
	"workItemId",
	"repo",
	"pr",
	"parentIssueId",
	"headSha",
	"baseSha",
];
const HEX40 = /^[0-9a-f]{40}$/;
const REPO = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const ID = /^[^\s\p{Cs}]{1,512}$/u;
const fail = (reason) => {
	throw new TypeError(`review-parent-binding: ${reason}`);
};

function exact(value, fields) {
	if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
	const proto = Object.getPrototypeOf(value);
	if (proto !== Object.prototype && proto !== null) return false;
	const keys = Reflect.ownKeys(value);
	return (
		keys.length === fields.length &&
		fields.every(
			(key) =>
				Object.hasOwn(value, key) &&
				Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), "value"),
		)
	);
}

function identity(value) {
	if (
		typeof value.companyId !== "string" ||
		!ID.test(value.companyId) ||
		typeof value.workItemId !== "string" ||
		!ID.test(value.workItemId) ||
		typeof value.parentIssueId !== "string" ||
		!ID.test(value.parentIssueId)
	)
		fail("invalid issue/company identity");
	if (
		!Number.isSafeInteger(value.repositoryId) ||
		value.repositoryId <= 0 ||
		!Number.isSafeInteger(value.pr) ||
		value.pr <= 0
	)
		fail("invalid repository/PR identity");
	if (typeof value.repo !== "string" || !REPO.test(value.repo.toLowerCase()))
		fail("invalid repository slug");
	if (
		typeof value.headSha !== "string" ||
		!HEX40.test(value.headSha) ||
		typeof value.baseSha !== "string" ||
		!HEX40.test(value.baseSha)
	)
		fail("full head/base required");
	return Object.fromEntries(
		FIELDS.map((key) => [key, key === "repo" ? value.repo.toLowerCase() : value[key]]),
	);
}

/** Build only from fresh trusted Forge facts and the server-created issue ID. */
export function buildReviewParentBinding(trusted) {
	if (!exact(trusted, FIELDS)) fail("unexpected or missing trusted fields");
	return Object.freeze({
		version: 1,
		kind: "review-parent",
		...identity(trusted),
		children: REVIEW_PARENT_CHILDREN,
	});
}

/** Validate stored JSON; returns a detached, deeply immutable canonical value. */
export function validateReviewParentBinding(value) {
	if (
		!exact(value, ["version", "kind", ...FIELDS, "children"]) ||
		value.version !== 1 ||
		value.kind !== "review-parent"
	)
		fail("invalid binding schema");
	const fields = identity(value);
	if (fields.repo !== value.repo) fail("stored slug must be normalized");
	if (!exact(value.children, ["gpt", "claude"])) fail("fixed child pair required");
	for (const family of ["gpt", "claude"]) {
		const slot = value.children[family];
		const expected = REVIEW_PARENT_CHILDREN[family];
		if (
			!exact(slot, ["model", "effort"]) ||
			slot.model !== expected.model ||
			slot.effort !== expected.effort
		)
			fail("fixed child profile required");
	}
	return Object.freeze({
		version: 1,
		kind: "review-parent",
		...fields,
		children: REVIEW_PARENT_CHILDREN,
	});
}

/** Fixed reverse lookup shared by the producer and trusted server facts loader. */
export function reviewParentStateKey(companyId, parentIssueId) {
	if (
		typeof companyId !== "string" ||
		!ID.test(companyId) ||
		typeof parentIssueId !== "string" ||
		!ID.test(parentIssueId)
	)
		fail("invalid state identity");
	return Object.freeze({
		scopeKind: "company",
		scopeId: companyId,
		namespace: "forge-pr",
		stateKey: `review-parent:v1:${encodeURIComponent(parentIssueId)}`,
	});
}

/** A binding cannot silently replace the original base, head or any other fact. */
export function verifyReviewParentBindingReadback(value, expected) {
	const original = validateReviewParentBinding(expected);
	const stored = validateReviewParentBinding(value);
	if (JSON.stringify(stored) !== JSON.stringify(original)) fail("binding mismatch");
	return stored;
}

/** readState must be installed-plugin scoped; storage errors propagate and hold. */
export async function readReviewParentBinding(readState, expected) {
	const original = validateReviewParentBinding(expected);
	return verifyReviewParentBindingReadback(
		await readState(reviewParentStateKey(original.companyId, original.parentIssueId)),
		original,
	);
}
