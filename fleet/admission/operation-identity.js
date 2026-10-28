// The operation identity mapper. The admission decision treats a new
// key or a new fingerprint as permission to start, so whoever builds them is
// part of the enforcement. This module builds them from trusted facts only:
// the caller must source every field from a record a model cannot write, and
// a title, a description, an origin or a status never reaches a key or a
// fingerprint. Anything it cannot map holds once and is reported; it is never
// guessed and never passed through. Pure: no I/O, no clock, no module state.
import { admit, holdOnce, inputFingerprint } from "./operation-admission.js";
import { validateReviewParentBinding } from "./review-parent-binding.js";

/** The two authorized reviewer slots. A seat, an assignee, an account or a model name is not a slot. */
export const REVIEW_FAMILIES = Object.freeze(["claude", "gpt"]);

const HEX40 = /^[0-9a-f]{40}$/;
const REPO = /^[\w.-]+\/[\w.-]+$/;
const PR = /^[1-9]\d*$/;
const ORIGINAL_KINDS = ["review", "review-parent", "merge", "routine", "work"];
const enc = encodeURIComponent;
// A lone surrogate makes `encodeURIComponent` throw, so an id carrying one is not a usable id.
const LONE_SURROGATE = /\p{Cs}/u;
const filled = (v) => typeof v === "string" && v !== "" && !LONE_SURROGATE.test(v);
const hold = (cause) => ({ ok: false, cause });
const mapped = (kind, key, root, fingerprint, firstAttemptOnly) => ({
	ok: true,
	kind,
	key,
	root,
	fingerprint,
	...(firstAttemptOnly === true ? { firstAttemptOnly: true } : {}),
});

// The pull request an operation belongs to, or null. `7` and `"7"` are one PR; repo case is not identity.
function pullRoot(facts) {
	const { repo, pr } = facts;
	if (typeof repo !== "string" || !REPO.test(repo)) return null;
	const isNumber = typeof pr === "number" && Number.isSafeInteger(pr) && pr > 0;
	if (!isNumber && !(typeof pr === "string" && PR.test(pr))) return null;
	return `${enc(facts.companyId)}:pr:${enc(repo.toLowerCase())}#${String(pr)}`;
}

function resolveReview(facts) {
	const root = pullRoot(facts);
	if (root === null) return hold("identity_missing");
	if (!REVIEW_FAMILIES.includes(facts.family)) return hold("review_slot_unknown");
	if (typeof facts.headSha !== "string" || !HEX40.test(facts.headSha)) return hold("input_missing");
	// A base sha and a review-policy revision are not inputs: nothing records either, and an optional input appearing later would be permission.
	const fingerprint = inputFingerprint({ head: facts.headSha });
	return mapped("review", `${root}:review:${facts.family}`, root, fingerprint);
}

function resolveReviewParent(facts) {
	// Child starts belong to the admitted parent's executor, never this operation.
	if (facts.family !== undefined) return hold("review_parent_child");
	let binding;
	try {
		binding = validateReviewParentBinding(facts.binding);
	} catch {
		return hold("review_parent_binding_invalid");
	}
	if (binding.companyId !== facts.companyId || binding.parentIssueId !== facts.issueId) {
		return hold("review_parent_binding_mismatch");
	}
	// Protected work lineage survives PR replacement and slug rename; a new alias,
	// task recreation or base movement never buys another execution of a spent head.
	const root = `${enc(binding.companyId)}:repository:${binding.repositoryId}:work:${enc(binding.workItemId)}`;
	return mapped(
		"review-parent",
		`${root}:review-parent`,
		root,
		inputFingerprint({ head: binding.headSha }),
	);
}

function resolveMerge(facts) {
	const root = pullRoot(facts);
	if (root === null) return hold("identity_missing");
	if (typeof facts.headSha !== "string" || !HEX40.test(facts.headSha)) return hold("input_missing");
	const evidence = facts.evidence;
	const complete = evidence !== null && typeof evidence === "object" && evidence.complete === true;
	if (!complete || !filled(evidence.revision)) return hold("merge_evidence_missing");
	const fingerprint = inputFingerprint({ head: facts.headSha, evidence: evidence.revision });
	return mapped("merge", `${root}:merge`, root, fingerprint);
}

// Each authorized occurrence is its own operation: one in flight or left uncertain does not
// block the next, and a retry or a re-wake of the same occurrence is the same operation.
function resolveRoutine(facts) {
	if (!filled(facts.routineId)) return hold("identity_missing");
	if (facts.periodicAuthorized !== true) return hold("routine_not_authorized");
	if (!filled(facts.occurrenceId)) return hold("occurrence_missing");
	const root = `${enc(facts.companyId)}:routine:${enc(facts.routineId)}`;
	const fingerprint = inputFingerprint({ occurrence: facts.occurrenceId });
	return mapped("routine", `${root}:occurrence:${enc(facts.occurrenceId)}`, root, fingerprint);
}

// A first operation with no accepted revision yet still starts once; after that only an
// accepted requirement revision or an accepted dependency revision changes the fingerprint.
// Work with no accepted requirement revision starts once and never again, and a dependency
// revision counts only for work that carries a requirement revision.
function resolveWork(facts) {
	const { workId, subOperation, rootWorkId, requirementRevision } = facts;
	if (!filled(workId) || !filled(subOperation)) return hold("identity_missing");
	const given = facts.dependencyRevisions;
	if (given !== undefined && !(Array.isArray(given) && given.every(filled))) {
		return hold("input_missing");
	}
	const unrevised = requirementRevision === undefined;
	if (!unrevised && !filled(requirementRevision)) return hold("input_missing");
	if (unrevised && given !== undefined && given.length > 0) return hold("input_missing");
	const company = enc(facts.companyId);
	const fingerprint = inputFingerprint({
		requirement: unrevised ? null : requirementRevision,
		dependencies: [...new Set(given ?? [])].sort(),
	});
	return mapped(
		"work",
		`${company}:work:${enc(workId)}:${enc(subOperation)}`,
		`${company}:work:${enc(filled(rootWorkId) ? rootWorkId : workId)}`,
		fingerprint,
		unrevised,
	);
}

// Never throws and never builds a diagnostic key. Reads only the fields named per kind.
function resolve(facts) {
	if (!filled(facts.companyId)) return hold("identity_missing");
	if (facts.kind === "review") return resolveReview(facts);
	if (facts.kind === "review-parent") return resolveReviewParent(facts);
	if (facts.kind === "merge") return resolveMerge(facts);
	if (facts.kind === "routine") return resolveRoutine(facts);
	if (facts.kind === "work") return resolveWork(facts);
	if (facts.kind === "recovery") {
		// Recovery is the original operation, not fresh work; a recovery of a recovery is the caller's to resolve first.
		const original = facts.original;
		if (original === null || typeof original !== "object") return hold("identity_missing");
		if (!ORIGINAL_KINDS.includes(original.kind)) return hold("identity_missing");
		if (original.companyId !== facts.companyId) return hold("identity_missing");
		return resolve(original);
	}
	return hold("unknown_kind");
}

/**
 * Maps trusted facts to `{ ok: true, kind, key, root, fingerprint }`, or to
 * `{ ok: false, cause, diagnosticKey }` when they do not name one operation.
 * `issueId` and `agentId` name the diagnostic record and nothing else: they
 * never enter the key, root or fingerprint of a mapped operation. Throws when
 * `facts` is not an object or carries neither.
 */
export function mapOperation(facts) {
	if (facts === null || typeof facts !== "object") {
		throw new TypeError("operation-identity: facts must be an object");
	}
	if (!filled(facts.issueId) && !filled(facts.agentId)) {
		throw new TypeError("operation-identity: facts need an issueId or an agentId");
	}
	const op = resolve(facts);
	if (op.ok) return op;
	const company = filled(facts.companyId) ? facts.companyId : "unknown";
	const subject = filled(facts.issueId)
		? `issue:${enc(facts.issueId)}`
		: `agent:${enc(facts.agentId)}`;
	return { ok: false, cause: op.cause, diagnosticKey: `${enc(company)}:unmapped:${subject}` };
}

/**
 * Maps `facts`, then admits. `request` is { source, paid, release? } and carries
 * no key and no fingerprint. An unpaid request attaches without mapping and
 * without reading the store: it starts no model, so it needs no identity. A
 * task that cannot be mapped holds once under its diagnostic key.
 */
export async function admitOperation(store, facts, request) {
	if (request.paid !== true) return admit(store, { source: request.source, paid: request.paid });
	const op = mapOperation(facts);
	if (op.ok === false) return holdOnce(store, op.diagnosticKey, op.cause);
	// A caller's `verified` flag is never forwarded: no release verifier exists in this cut
	// (it is sf#1827's), so every release holds as unverified.
	const release = request.release ? { id: request.release.id, verified: false } : undefined;
	return admit(store, {
		source: request.source,
		paid: true,
		key: op.key,
		fingerprint: op.fingerprint,
		firstAttemptOnly: op.firstAttemptOnly === true,
		release,
	});
}
