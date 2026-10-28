/** Inert policy only: identity, receipt verification and terminal facts come from trusted adapters. */
export interface ReviewIdentity {
	companyId: string;
	/** Stable Forge repository id, not an owner/name or board issue id. */
	repositoryId: number;
	/** Protected lineage mapping supplied by the caller; unknown/replacement ambiguity must hold. */
	workItemId: string;
	pr: number;
	headSha: string;
	baseSha: string;
}
export interface LatestReview {
	round: number;
	runId: string;
	findingsRevision: string;
	finishedAt: number;
}
export interface ReceiptBinding extends ReviewIdentity {
	/** Required for round three onward and for a previously evaluated head. */
	latest: LatestReview | null;
}
export interface VerifiedReviewReceipt extends ReceiptBinding {
	id: string;
	/** Trusted issuer timestamp in milliseconds; not a caller's clock. */
	issuedAt: number;
}
/** Must authenticate the issuer, actual approved pair execution and complete dispositions.
 * Return null for invalid evidence. Errors propagate; neither path reserves work. */
export type VerifyReviewReceipt = (
	receiptId: string,
	expectedBinding: ReceiptBinding,
) => Promise<VerifiedReviewReceipt | null>;
export interface ReviewRequest extends ReviewIdentity {
	runId: string;
	receiptId?: string;
}
export interface ReviewReservation {
	key: string;
	runId: string;
	/** Version at reservation, retained across uncertainty for trusted reconciliation. */
	version: number;
}
export type ReviewResult = "approved" | "changes_requested" | "failed" | "cancelled";
export interface ReviewCompletion {
	result: ReviewResult;
	highestSeverity: "P0" | "P1" | "P2" | "P3" | null;
	findingsRevision: string;
	finishedAt: number;
	/** Trusted reconciliation alone can terminalize uncertain execution. */
	reconciled?: boolean;
}
export interface ReviewRound {
	round: number;
	runId: string;
	pr: number;
	headSha: string;
	baseSha: string;
	receiptId: string | null;
	legacy?: true;
	issuedAt: number;
	reservationVersion: number;
	state: "reserved" | "uncertain" | "terminal";
	completion?: ReviewCompletion & { outcome: ReviewResult | "fix_first" };
}
export interface ReviewRoundRecord {
	historySource?: string;
	key: string;
	workItemId: string;
	version: number;
	rounds: ReviewRound[];
}
/** Same durable CAS shape as operation-admission; caller owns persistence. */
export interface ReviewRoundStore {
	read(key: string): Promise<ReviewRoundRecord | null | undefined>;
	compareAndSet(key: string, version: number, next: ReviewRoundRecord): Promise<boolean>;
}
export type ReviewCause =
	| "history_conflict"
	| "lineage_unknown"
	| "receipt_required"
	| "receipt_invalid"
	| "receipt_consumed"
	| "round_in_flight"
	| "execution_uncertain"
	| "run_already_used"
	| "run_binding_mismatch"
	| "head_base_mismatch"
	| "reservation_stale"
	| "reconciliation_required"
	| "contention";
export type ReviewDecision =
	| { action: "start" | "attach"; reservation: ReviewReservation; round: number }
	| { action: "hold"; cause: ReviewCause };
export type CompletionDecision =
	| { action: "recorded"; state: "terminal" | "uncertain"; record: ReviewRoundRecord }
	| { action: "hold"; cause: ReviewCause };
/** Canonical root survives replacement PRs; it excludes PR/event/comment/assignment identities. */
export function reviewRoundKey(
	identity: Pick<ReviewIdentity, "companyId" | "repositoryId" | "workItemId">,
): string;
export function reserveReviewRound(
	store: ReviewRoundStore,
	request: ReviewRequest,
	verifyReceipt: VerifyReviewReceipt,
): Promise<ReviewDecision>;
/** Never pass untrusted request prose or run callbacks as trusted completion facts. */
export function completeReviewRound(
	store: ReviewRoundStore,
	reservation: ReviewReservation,
	completion: ReviewCompletion | { uncertain: true },
): Promise<CompletionDecision>;
export type HistoricalReviewRound = Pick<
	ReviewRound,
	"runId" | "pr" | "headSha" | "baseSha" | "issuedAt"
> & { completion?: ReviewCompletion };
export function importReviewHistory(
	store: ReviewRoundStore,
	identity: Pick<ReviewIdentity, "companyId" | "repositoryId" | "workItemId">,
	source: string,
	history: HistoricalReviewRound[],
): Promise<{ action: "imported" | "existing" } | { action: "hold"; cause: "history_conflict" }>;
