// Types for operation-identity.js (plain ESM, pure; trusted facts in, one operation or one hold out).
import type {
	AdmissionRelease,
	AdmissionResult,
	AdmissionSource,
	AdmissionStore,
} from "./operation-admission.js";
import type { ReviewParentBinding } from "./review-parent-binding.js";

/** On every variant. `issueId` and `agentId` name the diagnostic record only; a wider row may be passed. */
interface FactsBase {
	companyId?: string;
	issueId?: string;
	agentId?: string;
	[extra: string]: unknown;
}
export interface ReviewFacts extends FactsBase {
	kind: "review";
	repo?: string;
	pr?: number | string;
	/** One of REVIEW_FAMILIES. A seat, an assignee, an account or a model name is not a slot. */
	family?: string;
	headSha?: string;
}
export interface ReviewParentFacts extends FactsBase {
	kind: "review-parent";
	/** Read from installed-plugin protected state, never copied from issue metadata. */
	binding?: ReviewParentBinding;
}
export interface MergeFacts extends FactsBase {
	kind: "merge";
	repo?: string;
	pr?: number | string;
	headSha?: string;
	evidence?: { complete?: unknown; revision?: string };
}
export interface RoutineFacts extends FactsBase {
	kind: "routine";
	routineId?: string;
	periodicAuthorized?: boolean;
	occurrenceId?: string;
}
export interface WorkFacts extends FactsBase {
	kind: "work";
	workId?: string;
	subOperation?: string;
	rootWorkId?: string;
	requirementRevision?: string;
	dependencyRevisions?: string[];
}
export interface RecoveryFacts extends FactsBase {
	kind: "recovery";
	/** The operation being recovered; never itself a recovery. */
	original?: ReviewFacts | ReviewParentFacts | MergeFacts | RoutineFacts | WorkFacts;
}
/** Every field must come from a record a model cannot write. */
export type OperationFacts =
	| ReviewFacts
	| ReviewParentFacts
	| MergeFacts
	| RoutineFacts
	| WorkFacts
	| RecoveryFacts;

export interface MappedOperation {
	ok: true;
	/** A recovery maps to its original's kind. */
	kind: "review" | "review-parent" | "merge" | "routine" | "work";
	key: string;
	/** The PR, routine or root work item the operation belongs to. */
	root: string;
	fingerprint: string;
	/** Present only on work with no accepted requirement revision: it starts once, ever. */
	firstAttemptOnly?: true;
}
export interface UnmappedOperation {
	ok: false;
	cause: string;
	/** Where the one visible hold record for the task is stored. */
	diagnosticKey: string;
}
/** No key and no fingerprint: the mapper builds both. */
export interface OperationRequest {
	source: AdmissionSource;
	paid: boolean;
	/** `verified` is never forwarded; every release holds as unverified in this cut. */
	release?: AdmissionRelease;
}

/** The two authorized reviewer slots. */
export const REVIEW_FAMILIES: readonly ["claude", "gpt"];
/** Maps trusted facts to one operation, or to a hold cause. Throws without an `issueId` or an `agentId`. */
export function mapOperation(facts: OperationFacts): MappedOperation | UnmappedOperation;
/** Maps, then admits; an unmappable task holds once under its diagnostic key. An unpaid request attaches unmapped. */
export function admitOperation(
	store: AdmissionStore,
	facts: OperationFacts,
	request: OperationRequest,
): Promise<AdmissionResult>;
