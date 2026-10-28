/** Convert issuer execution facts only after signature verification. Factory context
 * and parser output are independent protected records, never fields from a request
 * or claims extracted from reviewer prose. No signing key is needed by this bridge. */
import { createHash } from "node:crypto";
import { z } from "zod";
import {
	digest,
	executionSchema,
	receiptSchema,
	ref,
	SWARM_REVIEW_POLICY,
	timestamp,
} from "./swarm-receipt-schema.ts";

const laneName = z.enum(["claude", "gpt"]);
const captureId = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const attestedLane = z.strictObject({
	lane: laneName,
	principal: ref,
	model: z.string().min(1).max(128),
	thinking: z.string().min(1).max(32),
	packetFileSha256: digest,
	startedAt: timestamp,
	finishedAt: timestamp,
	exitCode: z.literal(0),
	eventsSha256: digest,
	stderrSha256: digest,
	eventsBytes: z.number().int().positive().max(268_435_456),
});
const attestationSchema = z.strictObject({
	schema: z.literal("review-attestation/v1"),
	id: ref,
	captureId,
	issuedAt: timestamp,
	expiresAt: timestamp,
	nonce: digest,
	bundleSha256: digest,
	preparedManifestSha256: digest,
	lanes: z.array(attestedLane).length(2),
});
const contextSchema = z.strictObject({
	schemaVersion: z.literal(1),
	attestationId: ref,
	captureId,
	nonce: digest,
	bundleSha256: digest,
	receipt: receiptSchema.omit({ id: true, issuedAt: true, expiresAt: true, lanes: true }),
	lanes: z
		.array(z.strictObject({ lane: laneName, runId: ref, packetFileSha256: digest }))
		.length(2),
});
const capturedSchema = z.strictObject({
	collectorComplete: z.literal(true),
	captureId,
	lane: laneName,
	packetFileSha256: digest,
	eventsSha256: digest,
	stderrSha256: digest,
	eventsBytes: z.number().int().positive().max(268_435_456),
	termination: z.strictObject({
		exitCode: z.literal(0),
		signal: z.null(),
		timedOut: z.literal(false),
		truncated: z.literal(false),
	}),
	execution: executionSchema,
});

/** Installed host readers only. The context publisher binds the nonce, bundle,
 * per-lane packet set and prepared manifest to repo/work/head independently of
 * the issuer. The protected parser binds its report/findings, resolved model and
 * fatal status to the captured event/stderr digests and explicit termination.
 * These readers must not accept author/reviewer uploads or manufacture completion.
 * Context.receipt carries only protected factory bindings/checks/dispositions;
 * issuer times and lanes are derived here, not accepted from the context.
 * all existing factory receipt checks still run after the bridge validates it. */
export interface ReviewAttestationReaders {
	readAttestationContext(id: string): Promise<unknown>;
	readCapturedReview(runId: string): Promise<unknown>;
}

type Attestation = z.infer<typeof attestationSchema>;
type Context = z.infer<typeof contextSchema>;
type Captured = z.infer<typeof capturedSchema>;
function contextMatches(a: Attestation, c: Context) {
	return (
		c.attestationId === a.id &&
		c.captureId === a.captureId &&
		c.nonce === a.nonce &&
		c.bundleSha256 === a.bundleSha256 &&
		c.receipt.manifestSha256 === a.preparedManifestSha256 &&
		new Set(a.lanes.map((l) => l.lane)).size === 2 &&
		new Set(c.lanes.map((l) => l.lane)).size === 2 &&
		new Set(c.lanes.map((l) => l.runId)).size === 2
	);
}
function captureMatches(a: Attestation, lane: z.infer<typeof attestedLane>, c: Captured) {
	const r = c.execution;
	const policy = SWARM_REVIEW_POLICY[lane.lane];
	return (
		lane.model === policy.model &&
		policy.efforts.includes(lane.thinking) &&
		c.captureId === a.captureId &&
		c.lane === lane.lane &&
		c.packetFileSha256 === lane.packetFileSha256 &&
		c.eventsSha256 === lane.eventsSha256 &&
		c.stderrSha256 === lane.stderrSha256 &&
		c.eventsBytes === lane.eventsBytes &&
		r.kind === "blind-review" &&
		r.checkIdentity === null &&
		r.principal === lane.principal &&
		r.resolvedModel === lane.model &&
		r.resolvedEffort === lane.thinking &&
		r.startedAt === lane.startedAt &&
		r.finishedAt === lane.finishedAt
	);
}

/** @param payload Already authenticated original issuer payload, not caller JSON.
 * @param readers Independently protected context and parser records.
 * @returns Candidate plus captured execution snapshot, or null for native receipts.
 * @throws On missing, malformed or inconsistent bridge inputs; the public verifier
 * converts this to a refusal. This function alone NEVER approves a receipt. */
export async function bridgeReviewAttestation(
	payload: unknown,
	readers: Partial<ReviewAttestationReaders>,
) {
	if (
		!payload ||
		typeof payload !== "object" ||
		!("schema" in payload) ||
		payload.schema !== "review-attestation/v1"
	)
		return null;
	const a = attestationSchema.parse(payload);
	if (!readers.readAttestationContext || !readers.readCapturedReview)
		throw new Error("attestation readers required");
	const c = contextSchema.parse(await readers.readAttestationContext(a.id));
	if (!contextMatches(a, c)) throw new Error("attestation context mismatch");
	const executions = new Map<string, z.infer<typeof executionSchema>>();
	const lanes: z.infer<typeof receiptSchema>["lanes"] = [];
	for (const lane of a.lanes) {
		const binding = c.lanes.find((l) => l.lane === lane.lane);
		if (!binding || binding.packetFileSha256 !== lane.packetFileSha256)
			throw new Error("lane packet mismatch");
		const captured = capturedSchema.parse(await readers.readCapturedReview(binding.runId));

		if (!captureMatches(a, lane, captured) || captured.execution.runId !== binding.runId)
			throw new Error("capture mismatch");
		executions.set(binding.runId, captured.execution);
		lanes.push({
			runId: binding.runId,
			model: lane.model,
			effort: lane.thinking,
			reportSha256: createHash("sha256").update(captured.execution.report).digest("hex"),
		});
	}
	return {
		receipt: { ...c.receipt, id: a.id, issuedAt: a.issuedAt, expiresAt: a.expiresAt, lanes },
		executions,
	};
}
