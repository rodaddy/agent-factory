// Types for operation-admission.js (plain ESM, pure; the caller owns the store).
export type TerminalOutcome =
	| "succeeded"
	| "failed"
	| "guard_refused"
	| "cancelled"
	| "paused_409"
	| "auth_401";
export type AdmissionState = "reserved" | "terminal" | "uncertain" | "unmapped";
export type AdmissionAction = "start" | "attach" | "hold" | "reconcile";
export type AdmissionSource = "wake" | "manual" | "recovery" | "resume";

/** One per operation key, durable in the caller's store. */
export interface AdmissionRecord {
	key: string;
	fingerprint: string;
	state: AdmissionState;
	outcome: TerminalOutcome | null;
	/** Paid starts ever admitted for the key. Never decreases. */
	attempts: number;
	holdAnnounced: boolean;
	/** Unresolved causes already announced for this attempt; absent on legacy records. */
	unresolvedAnnouncedCauses?: ("attempt_in_flight" | "upstream_uncertain")[];
	consumedReleases: string[];
	/** Every fingerprint a paid start was ever admitted on for the key. Never shrinks. */
	spentFingerprints: string[];
	version: number;
}
/** The one visible record for a task that could not be mapped to an operation. */
export interface UnmappedRecord {
	key: string;
	state: "unmapped";
	cause: string;
	holdAnnounced: true;
	version: number;
}
export interface AdmissionRelease {
	id: string;
	verified: boolean;
}
export interface AdmissionRequest {
	key: string;
	fingerprint: string;
	/** Never changes the decision. */
	source: AdmissionSource;
	paid: boolean;
	/** Set by the mapper for work with no accepted revision: it starts on a new key and never again. */
	firstAttemptOnly?: boolean;
	release?: AdmissionRelease;
}
export interface AdmissionResult {
	action: AdmissionAction;
	cause: string;
	/** True on the one hold the caller should tell a human about. */
	announce: boolean;
	/** The record to store; the same object as the input record when nothing changes. */
	next: AdmissionRecord | UnmappedRecord | null;
}
export interface AdmissionStore {
	read: (key: string) => Promise<AdmissionRecord | UnmappedRecord | null | undefined>;
	/** expectedVersion is 0 for an absent record. */
	compareAndSet: (
		key: string,
		expectedVersion: number,
		next: AdmissionRecord | UnmappedRecord,
	) => Promise<boolean>;
}
/** How a stored run ended: still live, ended with an outcome, or unknown upstream. */
export type RunEnd = { live: true } | { outcome: TerminalOutcome } | { uncertain: true };

export const TERMINAL_OUTCOMES: readonly TerminalOutcome[];
/** sha256 hex of the canonical JSON of the verified relevant inputs. */
export function inputFingerprint(relevant: unknown): string;
/** First matching rule wins; see the module for the rules. */
export function decide(record: AdmissionRecord | null, request: AdmissionRequest): AdmissionResult;
/** The record after an attempt ends or goes uncertain; an uncertain record ends only with `reconciled: true`. Throws on any other transition. */
export function settle(
	record: AdmissionRecord,
	result: { outcome: TerminalOutcome; reconciled?: true } | { uncertain: true },
): AdmissionRecord;
/** Read, decide and reserve with compare-and-set; holds with `store_contention` after 5 lost rounds. An unpaid request never touches the store. */
export function admit(store: AdmissionStore, request: AdmissionRequest): Promise<AdmissionResult>;
/** Maps how a stored run ended to what `settle` accepts. Never returns `reconciled`. */
export function classifyRunEnd(run?: { status?: string | null; errorCode?: string | null }): RunEnd;
/** Records an unmappable task once per cause; always holds, never overwrites an admission record. */
export function holdOnce(
	store: AdmissionStore,
	key: string,
	cause: string,
): Promise<AdmissionResult>;

export interface AdmissionOwnerRun {
	id: string;
	status: string;
	contextSnapshot: {
		admission?: { key: string; fingerprint: string; attempts: number; runId: string };
	};
	/** False only when the server has excluded live/native continuation. */
	continuation?: boolean;
	upstream?: "ended" | "never_started" | "unknown";
}
export function ownsAdmission(record: AdmissionRecord, run: AdmissionOwnerRun): boolean;
/** Bounded CAS recovery; ambiguous or absent trusted evidence holds. Errors propagate. */
export function reconcileAdmission(
	store: AdmissionStore,
	key: string,
	readEvidence: (record: AdmissionRecord) => Promise<AdmissionOwnerRun[]>,
): Promise<void>;
