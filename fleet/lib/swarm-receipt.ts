import { createHash, KeyObject, verify } from "node:crypto";
import type { z } from "zod";
import {
	bridgeReviewAttestation,
	type ReviewAttestationReaders,
} from "./review-attestation-bridge.ts";
import {
	adjudicationSchema,
	bindingKeys,
	envelopeSchema,
	executionSchema,
	expectedSchema,
	MAX_EVIDENCE_BYTES,
	MAX_PAYLOAD_BYTES,
	MAX_REPORT_BYTES,
	receiptSchema,
	ref,
	SWARM_REVIEW_POLICY,
} from "./swarm-receipt-schema.ts";

export type SwarmReceipt = z.infer<typeof receiptSchema>;
export type SwarmReceiptExpected = z.infer<typeof expectedSchema>;
export type SwarmExecution = z.infer<typeof executionSchema>;
export type SwarmAdjudication = z.infer<typeof adjudicationSchema>;
export type SwarmReceiptReason =
	| "missing"
	| "invalid"
	| "signature"
	| "issuer"
	| "stale"
	| "binding"
	| "lane"
	| "evidence"
	| "findings"
	| "read_error";
export type SwarmReceiptResult =
	| { ok: true; receipt: SwarmReceipt }
	| { ok: false; reason: SwarmReceiptReason };

/** Trusted configuration only: none of these readers or keys may come from a request.
 * Records and adjudicator signatures must be protected from authors/reviewers by
 * the caller's storage/issuer boundary. This module does not create that separation
 * or attest provider execution from a captureSource/model string. The protected
 * executor supplies truthful terminalStatus/fatalError values: success requires
 * fully parsed, untruncated output and normal successful termination, never an
 * aborted, malformed, transport/tool-error-only or incomplete stream. Fatal tool
 * or stream failures set fatalError even when the child exits 0.
 * expected.latestFindings comes from the trusted latest factory findings snapshot.
 * expected.requiredChecks comes from protected check definitions, never the receipt.
 * Check identities attest the executor's configured definition, not report keywords.
 * Its signed digest is SHA-256 of UTF-8 JSON sorted [id,severity] tuples, ordered
 * by ascending id using JavaScript string comparison (not locale ordering).
 */
export interface SwarmReceiptAuthority extends Partial<ReviewAttestationReaders> {
	publicKeys: ReadonlyMap<string, KeyObject>;
	/** Execution attesters cannot sign native factory receipts. Separate trust domain. */
	attestationPublicKeys?: ReadonlyMap<string, KeyObject>;
	readReceipt(id: string): Promise<unknown>;
	readExecution(runId: string): Promise<unknown>;
	/** Protected UTF-8 JSON SwarmAdjudication bytes, addressed by their digest.
	 * The independent adjudicator must truthfully accept the referenced evidence;
	 * a signature/digest does not establish that record issuer's honesty. */
	readEvidence(sha256: string): Promise<unknown>;
}

const fail = (reason: SwarmReceiptReason): SwarmReceiptResult => ({ ok: false, reason });
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const unique = (ids: string[]) => new Set(ids).size === ids.length;
const sameBinding = (
	a: SwarmReceiptExpected,
	b: SwarmReceipt | SwarmExecution | SwarmAdjudication,
) => bindingKeys.every((key) => a[key] === b[key]);

function authentic(envelope: z.infer<typeof envelopeSchema>, keys: ReadonlyMap<string, KeyObject>) {
	const key = keys.get(envelope.keyId);
	if (!(key instanceof KeyObject) || key.type !== "public" || key.asymmetricKeyType !== "ed25519")
		return "issuer" as const;
	if (
		envelope.keyId.startsWith("ed25519:") &&
		envelope.keyId !== `ed25519:${hash(key.export({ type: "spki", format: "der" }))}`
	)
		return "issuer" as const;
	const signature = Buffer.from(envelope.signature, "base64");
	if (signature.toString("base64") !== envelope.signature) return "invalid" as const;
	return verify(null, Buffer.from(envelope.payload, "utf8"), key, signature) ? null : "signature";
}

function latestFindingsDigest(findings: SwarmReceiptExpected["latestFindings"]) {
	const pairs = findings.map(({ id, severity }) => [id, severity] as const);
	pairs.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
	return hash(JSON.stringify(pairs));
}

function receiptProblem(id: string, receipt: SwarmReceipt, expected: SwarmReceiptExpected) {
	const issued = Date.parse(receipt.issuedAt);
	const expires = Date.parse(receipt.expiresAt);
	const checks: Array<[boolean, SwarmReceiptReason]> = [
		[
			!sameBinding(expected, receipt) ||
				receipt.id !== id ||
				receipt.policyVersion !== expected.policyVersion ||
				receipt.latestFindingsSha256 !== latestFindingsDigest(expected.latestFindings),
			"binding",
		],
		[
			receipt.reviewedSha !== expected.headSha ||
				(receipt.fixedSha !== null && receipt.fixedSha !== expected.headSha),
			"binding",
		],
		[issued > expected.nowMs || expires <= expected.nowMs || expires <= issued, "stale"],
		[!unique([...receipt.lanes, ...receipt.checkRunIds].map((r) => r.runId)), "lane"],
		[
			Object.values(SWARM_REVIEW_POLICY).some(
				(policy) =>
					!receipt.lanes.some((l) => l.model === policy.model && policy.efforts.includes(l.effort)),
			),
			"lane",
		],
	];
	return checks.find(([failed]) => failed)?.[1] ?? null;
}

function executionProblem(
	record: SwarmExecution,
	expected: SwarmReceiptExpected,
	receipt: SwarmReceipt,
) {
	const checks: Array<[boolean, SwarmReceiptReason]> = [
		[!sameBinding(expected, record), "binding"],
		[record.principal === expected.authorPrincipal, "lane"],
		[Buffer.byteLength(record.report, "utf8") > MAX_REPORT_BYTES, "lane"],
		[
			Date.parse(record.startedAt) > Date.parse(record.finishedAt) ||
				Date.parse(record.finishedAt) > Date.parse(receipt.issuedAt),
			"lane",
		],
	];
	return checks.find(([failed]) => failed)?.[1] ?? null;
}

async function executionRecords(
	receipt: SwarmReceipt,
	expected: SwarmReceiptExpected,
	authority: SwarmReceiptAuthority,
	captured?: ReadonlyMap<string, SwarmExecution>,
): Promise<{ reason: SwarmReceiptReason } | { records: SwarmExecution[] }> {
	const records: SwarmExecution[] = [];
	for (const artifact of [...receipt.lanes, ...receipt.checkRunIds]) {
		const parsed = executionSchema.safeParse(
			captured?.get(artifact.runId) ?? (await authority.readExecution(artifact.runId)),
		);
		if (!parsed.success) return { reason: "lane" as const };
		const record = parsed.data;
		if (record.runId !== artifact.runId) return { reason: "binding" as const };
		const problem = executionProblem(record, expected, receipt);
		if (problem) return { reason: problem };
		if (hash(record.report) !== artifact.reportSha256) return { reason: "lane" as const };
		records.push(record);
	}
	return { records };
}

function laneProblem(
	records: SwarmExecution[],
	receipt: SwarmReceipt,
	expected: SwarmReceiptExpected,
) {
	const reviews = records.slice(0, 2);
	const valid = reviews.every((record, index) => {
		const lane = receipt.lanes[index];
		return (
			lane &&
			record.kind === "blind-review" &&
			record.checkIdentity === null &&
			record.resolvedModel === lane.model &&
			record.resolvedEffort === lane.effort
		);
	});
	const checks = records.slice(2);
	const required = new Map(
		expected.requiredChecks.map((check) => [check.id, check.definitionSha256]),
	);
	return (
		!valid ||
		!unique(reviews.map((r) => r.principal)) ||
		checks.length !== required.size ||
		!unique(checks.map((r) => r.checkIdentity?.id ?? "")) ||
		checks.some(
			(r) =>
				r.kind !== "check" ||
				r.findings.length !== 0 ||
				!r.checkIdentity ||
				required.get(r.checkIdentity.id) !== r.checkIdentity.definitionSha256,
		)
	);
}

function findingsProblem(
	receipt: SwarmReceipt,
	records: SwarmExecution[],
	expected: SwarmReceiptExpected,
) {
	const reviews = records.slice(0, 2);
	const findings = reviews.flatMap((r) => r.findings);
	const dispositions = new Map(receipt.dispositions.map((d) => [d.findingId, d]));
	const required = [...expected.latestFindings, ...findings];
	const valid = required.every((f) => dispositions.get(f.id)?.severity === f.severity);
	const qualified = reviews.every((r) => r.findings.every((f) => f.id.startsWith(`${r.runId}:`)));
	const checks = [
		!unique(findings.map((f) => f.id)),
		dispositions.size !== receipt.dispositions.length,
		new Set(required.map((f) => f.id)).size !== dispositions.size,
		!valid,
		!qualified,
		receipt.dispositions.some(
			(d) => d.decision === "open" && (d.severity === "P0" || d.severity === "P1"),
		),
	];
	return checks.some(Boolean);
}

function adjudicationRecord(value: unknown, digest: string): SwarmAdjudication | null {
	if (typeof value !== "string" && !(value instanceof Uint8Array)) return null;
	const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
	if (bytes.byteLength === 0 || bytes.byteLength > MAX_EVIDENCE_BYTES || hash(bytes) !== digest)
		return null;
	try {
		const parsed = adjudicationSchema.safeParse(JSON.parse(Buffer.from(bytes).toString("utf8")));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

async function evidenceProblem(
	receipt: SwarmReceipt,
	authority: SwarmReceiptAuthority,
	expected: SwarmReceiptExpected,
	records: SwarmExecution[],
) {
	const participants = new Set([expected.authorPrincipal, ...records.map((r) => r.principal)]);
	for (const disposition of receipt.dispositions.filter((d) => d.decision !== "open")) {
		const digest = disposition.evidenceSha256;
		if (digest === null) return true;
		const record = adjudicationRecord(await authority.readEvidence(digest), digest);
		if (
			!record ||
			!sameBinding(expected, record) ||
			record.findingId !== disposition.findingId ||
			record.severity !== disposition.severity ||
			record.disposition !== disposition.decision ||
			participants.has(record.adjudicatorPrincipal)
		)
			return true;
	}
	return false;
}

async function verifyStored(
	id: string,
	expected: SwarmReceiptExpected,
	authority: SwarmReceiptAuthority,
): Promise<SwarmReceiptResult> {
	const stored = await authority.readReceipt(id);
	if (stored === null || stored === undefined) return fail("missing");
	const envelope = envelopeSchema.safeParse(stored);
	if (!envelope.success || Buffer.byteLength(envelope.data.payload, "utf8") > MAX_PAYLOAD_BYTES)
		return fail("invalid");

	let payload: unknown;
	try {
		payload = JSON.parse(envelope.data.payload);
	} catch {
		return fail("invalid");
	}
	const isAttestation =
		payload !== null &&
		typeof payload === "object" &&
		"schema" in payload &&
		payload.schema === "review-attestation/v1";
	const keys = isAttestation ? authority.attestationPublicKeys : authority.publicKeys;
	if (!keys) return fail("issuer");
	const signatureProblem = authentic(envelope.data, keys);
	if (signatureProblem) return fail(signatureProblem);
	// Only after verifying the original signed bytes may protected host context
	// add factory bindings. No re-signing or unsigned input fallback is allowed.
	const bridged = await bridgeReviewAttestation(payload, authority);
	if (bridged) payload = bridged.receipt;
	const parsed = receiptSchema.safeParse(payload);
	if (!parsed.success) return fail("invalid");
	const receipt = parsed.data;
	const problem = receiptProblem(id, receipt, expected);
	if (problem) return fail(problem);
	// Keep the original reader receiver: authorities may use prototype methods/private state.
	const executions = await executionRecords(receipt, expected, authority, bridged?.executions);
	if ("reason" in executions) return fail(executions.reason);
	if (laneProblem(executions.records, receipt, expected)) return fail("lane");
	if (findingsProblem(receipt, executions.records, expected)) return fail("findings");
	if (await evidenceProblem(receipt, authority, expected, executions.records))
		return fail("evidence");
	return { ok: true, receipt };
}

/** Verify a protected signed receipt against captured executions and findings.
 * @param receiptId Safe opaque store reference, never an uploaded envelope/report.
 * @param expected Trusted immutable binding, author identity and verifier clock.
 * @param authority Trusted protected readers and adjudicator public-key registry.
 * @returns A verified receipt (including open P2/P3) or a stable failure reason.
 * @throws Never for malformed inputs or reader failures; no signing/issuance API.
 */
export async function verifySwarmReceipt(
	receiptId: unknown,
	expected: SwarmReceiptExpected,
	authority: SwarmReceiptAuthority,
): Promise<SwarmReceiptResult> {
	try {
		const id = ref.safeParse(receiptId);
		const config = expectedSchema.safeParse(expected);
		if (!id.success || !config.success) return fail("invalid");
		return await verifyStored(id.data, config.data, authority);
	} catch {
		// Do not expose storage/crypto exception text to the untrusted submitter.
		return fail("read_error");
	}
}
