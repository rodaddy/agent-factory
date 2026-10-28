// Inert producer authorization schemas; no storage reads or paid-start wiring.
import { z } from "zod";

const id = z
	.string()
	.min(1)
	.max(512)
	.regex(/^[^\s\p{Cs}]+$/u);
const scope = { companyId: id, issueId: id };
const work = z
	.object({
		kind: z.literal("work"),
		...scope,
		workId: id,
		rootWorkId: id,
		subOperation: id,
		requirementRevision: id.optional(),
		dependencyRevisions: z.array(id).max(128).optional(),
	})
	.strict();
const routine = z
	.object({
		kind: z.literal("routine"),
		companyId: id,
		routineId: id,
		triggerId: id,
		routineRevisionId: id,
	})
	.strict();
export const authorizationSchema = z
	.object({
		schema: z.literal("operation-authorization/v1"),
		facts: z.discriminatedUnion("kind", [work, routine]),
	})
	.strict();
export const producerKey = (kind, subject) =>
	`producer:v1:${z.enum(["issue", "routine", "approval"]).parse(kind)}:${encodeURIComponent(id.parse(subject))}`;
export const routineAuthorizationKey = (f) =>
	`${producerKey("routine", f.routineId)}:${encodeURIComponent(id.parse(f.triggerId))}`;
export function parseAuthorizationRecord(value, key, companyId) {
	const record = z
		.object({
			key: z.literal(key),
			version: z.literal(1),
			approvalId: id,
			decidedByUserId: id,
			payload: authorizationSchema,
		})
		.strict()
		.parse(value);
	if (key !== producerKey("approval", record.approvalId))
		throw new Error("producer_approval_mismatch");
	if (record.payload.facts.companyId !== companyId) throw new Error("producer_company_mismatch");
	return record;
}
