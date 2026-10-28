// sf#1827: inert parent-round policy over the caller's durable CAS store.
// No signer, model, clock or event wiring lives here. The trusted receipt adapter
// owns issuer/pair execution/disposition verification; the caller owns trusted
// identity and reconciliation. A start decision is valid only after CAS lands.
const MAX_CONTENTION = 5;
const SHA = /^[a-f0-9]{40}$/;
const STATES = new Set(["reserved", "uncertain", "terminal"]);
const RESULTS = new Set(["approved", "changes_requested", "failed", "cancelled"]);
const SEVERITIES = new Set([null, "P0", "P1", "P2", "P3"]);

function text(value, limit = 512) {
	return typeof value === "string" && value.length > 0 && value.length <= limit;
}
function positive(value) {
	return Number.isSafeInteger(value) && value > 0;
}
function invalid(message) {
	throw new TypeError(`review-rounds: ${message}`);
}
function hold(cause) {
	return { action: "hold", cause };
}

/** Root uses protected lineage, never PR/event/board/comment identities. */
export function reviewRoundKey(identity) {
	if (!text(identity.companyId) || !positive(identity.repositoryId) || !text(identity.workItemId)) {
		invalid("trusted company, repository id and work-item lineage are required");
	}
	return `${encodeURIComponent(identity.companyId)}:review-rounds:repo:${identity.repositoryId}:work:${encodeURIComponent(identity.workItemId)}`;
}
function requestIdentity(request) {
	const key = reviewRoundKey(request);
	if (
		!positive(request.pr) ||
		!text(request.runId) ||
		!SHA.test(request.headSha) ||
		!SHA.test(request.baseSha)
	) {
		invalid("PR, parent run id and full lowercase head/base SHAs are required");
	}
	return key;
}
function completionValid(value) {
	return (
		value &&
		RESULTS.has(value.result) &&
		SEVERITIES.has(value.highestSeverity) &&
		text(value.findingsRevision) &&
		positive(value.finishedAt) &&
		(value.reconciled === undefined || typeof value.reconciled === "boolean")
	);
}
function recordValid(record, key) {
	if (!record) return;
	if (
		record.key !== key ||
		!text(record.workItemId) ||
		!positive(record.version) ||
		!Array.isArray(record.rounds) ||
		(record.rounds.length === 0 && !record.historySource)
	)
		invalid("corrupt review record");
	const runs = new Set();
	const receipts = new Set();
	for (const [index, round] of record.rounds.entries()) {
		if (
			!roundValid(round, index, record) ||
			runs.has(round.runId) ||
			(round.receiptId !== null && receipts.has(round.receiptId))
		) {
			invalid("corrupt review round");
		}
		runs.add(round.runId);
		receipts.add(round.receiptId);
	}
}
function roundValid(round, index, record) {
	if (
		!round ||
		round.round !== index + 1 ||
		!text(round.runId) ||
		!positive(round.pr) ||
		!(
			text(round.receiptId) ||
			(round.receiptId === null && round.legacy === true && record.historySource)
		) ||
		!SHA.test(round.headSha) ||
		!SHA.test(round.baseSha) ||
		!positive(round.issuedAt) ||
		!positive(round.reservationVersion) ||
		round.reservationVersion > record.version ||
		!STATES.has(round.state)
	)
		return false;
	if (index < record.rounds.length - 1 && round.state !== "terminal") return false;
	if (round.state !== "terminal") return round.completion === undefined;
	return (
		completionValid(round.completion) &&
		round.completion.finishedAt >= round.issuedAt &&
		round.completion.outcome === outcome(round.completion)
	);
}
function outcome(completion) {
	if (completion.highestSeverity === "P0" || completion.highestSeverity === "P1")
		return "fix_first";
	return completion.result;
}
function reservation(key, round) {
	return { key, runId: round.runId, version: round.reservationVersion };
}
function existingDecision(record, request) {
	const active = record?.rounds.at(-1);
	if (active?.state === "uncertain") return hold("execution_uncertain");
	if (active?.state === "reserved") return inFlight(record.key, active, request);
	if (record?.rounds.some((round) => round.runId === request.runId))
		return hold("run_already_used");
	if (
		record?.rounds.some(
			(round) => round.headSha === request.headSha && round.baseSha !== request.baseSha,
		)
	) {
		return hold("head_base_mismatch");
	}
	if (!text(request.receiptId)) return hold("receipt_required");
	if (record?.rounds.some((round) => round.receiptId === request.receiptId))
		return hold("receipt_consumed");
	return null;
}
function inFlight(key, active, request) {
	if (active.runId !== request.runId) return hold("round_in_flight");
	if (
		active.pr !== request.pr ||
		active.headSha !== request.headSha ||
		active.baseSha !== request.baseSha
	) {
		return hold("run_binding_mismatch");
	}
	return { action: "attach", reservation: reservation(key, active), round: active.round };
}
function expectedBinding(record, request) {
	const prior = record?.rounds.at(-1);
	const needsRelease =
		(record?.rounds.length ?? 0) >= 2 ||
		record?.rounds.some((round) => round.headSha === request.headSha);
	const latest = needsRelease
		? {
				round: prior.round,
				runId: prior.runId,
				findingsRevision: prior.completion.findingsRevision,
				finishedAt: prior.completion.finishedAt,
			}
		: null;
	return {
		companyId: request.companyId,
		repositoryId: request.repositoryId,
		workItemId: request.workItemId,
		pr: request.pr,
		headSha: request.headSha,
		baseSha: request.baseSha,
		latest,
	};
}
function matchesLatest(actual, expected) {
	if (expected === null) return actual === null;
	return (
		actual?.round === expected.round &&
		actual?.runId === expected.runId &&
		actual?.findingsRevision === expected.findingsRevision &&
		actual?.finishedAt === expected.finishedAt
	);
}
function receiptValid(receipt, receiptId, expected) {
	if (!receipt || receipt.id !== receiptId || !positive(receipt.issuedAt)) return false;
	for (const field of ["companyId", "repositoryId", "workItemId", "pr", "headSha", "baseSha"]) {
		if (receipt[field] !== expected[field]) return false;
	}
	if (!matchesLatest(receipt.latest, expected.latest)) return false;
	return expected.latest === null || receipt.issuedAt > expected.latest.finishedAt;
}
function nextReservation(record, request, key, receipt) {
	const version = (record?.version ?? 0) + 1;
	const round = {
		round: (record?.rounds.length ?? 0) + 1,
		runId: request.runId,
		pr: request.pr,
		headSha: request.headSha,
		baseSha: request.baseSha,
		receiptId: receipt.id,
		issuedAt: receipt.issuedAt,
		reservationVersion: version,
		state: "reserved",
	};
	return {
		key,
		workItemId: request.workItemId,
		...(record?.historySource ? { historySource: record.historySource } : {}),
		version,
		rounds: [...(record?.rounds ?? []), round],
	};
}

/** Verification may happen again after a lost CAS; no paid work happens here.
 * Each retry re-reads the latest trusted findings before constructing the binding.
 * Verify adapter receives a detached copy so it cannot mutate policy expectations. */
export async function reserveReviewRound(store, request, verifyReceipt) {
	const input = { ...request };
	if (!text(input.workItemId)) return hold("lineage_unknown");
	const key = requestIdentity(input);
	for (let attempt = 0; attempt < MAX_CONTENTION; attempt++) {
		const record = await store.read(key);
		recordValid(record, key);
		if (record && record.workItemId !== input.workItemId)
			invalid("work-item lineage disagrees with record");
		const existing = existingDecision(record, input);
		if (existing) return existing;
		const expected = expectedBinding(record, input);
		const receipt = await verifyReceipt(input.receiptId, structuredClone(expected));
		if (!receiptValid(receipt, input.receiptId, expected)) return hold("receipt_invalid");
		const next = nextReservation(record, input, key, receipt);
		if (await store.compareAndSet(key, record?.version ?? 0, next)) {
			const round = next.rounds.at(-1);
			return { action: "start", reservation: reservation(key, round), round: round.round };
		}
	}
	return hold("contention");
}
function completionDecision(record, token, completion) {
	const active = record?.rounds.at(-1);
	if (
		!active ||
		active.state === "terminal" ||
		active.runId !== token.runId ||
		active.reservationVersion !== token.version
	)
		return hold("reservation_stale");
	if (active.state === "uncertain" && completion.reconciled !== true) {
		return hold("reconciliation_required");
	}
	return null;
}
function nextCompletion(record, value) {
	const active = record.rounds.at(-1);
	const state = value.uncertain === true ? "uncertain" : "terminal";
	const completion = state === "terminal" ? { ...value, outcome: outcome(value) } : undefined;
	if (completion && completion.finishedAt < active.issuedAt) invalid("completion precedes receipt");
	const round = { ...active, state, completion };
	return { ...record, version: record.version + 1, rounds: [...record.rounds.slice(0, -1), round] };
}

/** Completion facts are trusted, not extracted from review prose. An uncertain
 * attempt keeps its count and receipt spent until explicit trusted reconciliation.
 * Old reservation versions/run ids can never terminalize a later reservation. */
export async function completeReviewRound(store, token, completion) {
	if (!text(token.key, 16384) || !text(token.runId) || !positive(token.version))
		invalid("invalid reservation");
	if (completion?.uncertain !== true && !completionValid(completion))
		invalid("invalid trusted completion");
	const input = { ...completion };
	const reservationToken = { ...token };
	for (let attempt = 0; attempt < MAX_CONTENTION; attempt++) {
		const record = await store.read(reservationToken.key);
		recordValid(record, reservationToken.key);
		const refused = completionDecision(record, reservationToken, input);
		if (refused) return refused;
		const next = nextCompletion(record, input);
		if (await store.compareAndSet(reservationToken.key, record.version, next)) {
			return { action: "recorded", state: next.rounds.at(-1).state, record: next };
		}
	}
	return hold("contention");
}

/** Operator-supplied complete history, never inferred from titles or an empty read.
 * Historical rounds carry no invented receipt. Import is insert-only and repeatable;
 * a different snapshot cannot overwrite a live ledger, including after new rounds. */
export async function importReviewHistory(store, identity, source, history) {
	const key = reviewRoundKey(identity);
	if (!/^[a-f0-9]{64}$/.test(source) || !Array.isArray(history))
		invalid("invalid history snapshot");
	const next = {
		key,
		workItemId: identity.workItemId,
		version: 1,
		historySource: source,
		rounds: history.map((round, index) => ({
			...round,
			round: index + 1,
			receiptId: null,
			legacy: true,
			reservationVersion: 1,
			state: round.completion ? "terminal" : "uncertain",
			...(round.completion
				? { completion: { ...round.completion, outcome: outcome(round.completion) } }
				: {}),
		})),
	};
	recordValid(next, key);
	if (await store.compareAndSet(key, 0, next)) return { action: "imported" };
	const current = await store.read(key);
	recordValid(current, key);
	if (current?.historySource === source) return { action: "existing" };
	return hold("history_conflict");
}
