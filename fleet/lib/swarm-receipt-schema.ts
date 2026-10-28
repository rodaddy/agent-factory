import { z } from "zod";

export const MAX_PAYLOAD_BYTES = 131_072;
export const MAX_REPORT_BYTES = 262_144;
export const MAX_EVIDENCE_BYTES = 1_048_576;
export const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
const sha = z.string().regex(/^[a-f0-9]{40}$/);
export const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const timestamp = z.iso.datetime({ offset: true }).max(35);
const severity = z.enum(["P0", "P1", "P2", "P3"]);
const findingId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_:-]{0,255}$/);
const latestFindingSchema = z.strictObject({
	id: findingId.regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}:[A-Za-z0-9_:-]+$/),
	severity,
});
const latestFindingsSchema = z
	.array(latestFindingSchema)
	.max(512)
	.refine((findings) => new Set(findings.map((f) => f.id)).size === findings.length);
export const bindingShape = {
	repositoryId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
	repositoryFullName: z
		.string()
		.max(255)
		.regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	workItemId: ref,
	baseSha: sha,
	headSha: sha,
	manifestSha256: digest,
	packetSha256: digest,
};
export const bindingKeys = Object.keys(bindingShape) as Array<keyof typeof bindingShape>;
const checkIdentitySchema = z.strictObject({ id: ref, definitionSha256: digest });
const artifactSchema = z.strictObject({ runId: ref, reportSha256: digest });
const laneSchema = artifactSchema.extend({
	model: z.string().min(1).max(128),
	effort: z.string().min(1).max(32),
});
const dispositionSchema = z.strictObject({
	findingId,
	severity,
	decision: z.enum(["resolved", "refuted", "open"]),
	evidenceSha256: digest.nullable(),
});
export const adjudicationSchema = z.strictObject({
	...bindingShape,
	schemaVersion: z.literal(1),
	findingId,
	severity,
	disposition: z.enum(["resolved", "refuted"]),
	adjudicatorPrincipal: ref,
	acceptedEvidenceRef: ref,
});
export const receiptSchema = z.strictObject({
	...bindingShape,
	latestFindingsSha256: digest,
	schemaVersion: z.literal(1),
	id: ref,
	reviewedSha: sha,
	fixedSha: sha.nullable(),
	policyVersion: z.literal("factory-swarm/v1"),
	issuedAt: timestamp,
	expiresAt: timestamp,
	lanes: z.array(laneSchema).length(2),
	checkRunIds: z.array(artifactSchema).min(1).max(32),
	dispositions: z.array(dispositionSchema).max(512),
});
export const expectedSchema = z.strictObject({
	...bindingShape,
	policyVersion: z.literal("factory-swarm/v1"),
	latestFindings: latestFindingsSchema,
	requiredChecks: z
		.array(checkIdentitySchema)
		.min(1)
		.max(32)
		.refine((checks) => new Set(checks.map((check) => check.id)).size === checks.length),
	authorPrincipal: ref,
	nowMs: z.number().finite().int().min(0).max(8_640_000_000_000_000),
});
export const envelopeSchema = z.strictObject({
	keyId: z.union([ref, z.string().regex(/^ed25519:[a-f0-9]{64}$/)]),
	payload: z.string().min(1).max(MAX_PAYLOAD_BYTES),
	signature: z
		.string()
		.length(88)
		.regex(/^[A-Za-z0-9+/]{86}==$/),
});
export const executionSchema = z.strictObject({
	...bindingShape,
	runId: ref,
	kind: z.enum(["blind-review", "check"]),
	checkIdentity: checkIdentitySchema.nullable(),
	captureSource: z.literal("executor"),
	completed: z.literal(true),
	exitCode: z.literal(0),
	terminalStatus: z.literal("success"),
	fatalError: z.literal(false),
	principal: ref,
	resolvedModel: z.string().max(128).nullable(),
	resolvedEffort: z.string().max(32).nullable(),
	startedAt: timestamp,
	finishedAt: timestamp,
	report: z
		.string()
		.min(1)
		.max(MAX_REPORT_BYTES)
		.refine((value) => value.trim().length > 0),
	findings: z.array(z.strictObject({ id: findingId, severity })).max(256),
});

/** factory-swarm/v1 supports requested LOW Sonnet and existing MEDIUM captures.
 * Effort must match the signed and protected resolved value; never normalize it. */
export const SWARM_REVIEW_POLICY = {
	gpt: { model: "gpt-6.1-sol", efforts: ["low"] as readonly string[] },
	claude: { model: "claude-sonnet-5-5", efforts: ["low", "medium"] as readonly string[] },
} as const;
