/** Trusted host boundary for forge-pr. Agent prose never supplies lineage or evidence. */
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import {
	type SwarmReceiptAuthority,
	type SwarmReceiptExpected,
	verifySwarmReceipt,
} from "../lib/swarm-receipt.ts";
import type { AdmissionCASStore } from "./operation-admission-store.js";
import {
	completeReviewRound,
	type HistoricalReviewRound,
	importReviewHistory,
	type ReceiptBinding,
	type ReviewCompletion,
	type ReviewReservation,
	type ReviewRoundStore,
	reserveReviewRound,
	reviewRoundKey,
} from "./review-rounds.js";

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const ref = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/);
export const reviewTargetSchema = z.strictObject({
	companyId: z.string().min(1).max(128),
	repositoryId: z.number().int().positive(),
	repositoryFullName: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/),
	pr: z.number().int().positive(),
	headSha: sha,
	baseSha: sha,
});
export type ReviewTarget = z.infer<typeof reviewTargetSchema>;
interface Alias {
	key: string;
	version: number;
	companyId: string;
	repositoryId: number;
	repositoryFullName: string;
	pr: number;
	workItemId: string;
	headSha: string;
	baseSha: string;
	patchSha256: string;
	treeSha: string;
}
export interface ReviewReady {
	receiptId: string;
	expected: Omit<SwarmReceiptExpected, "nowMs">;
	latest: ReceiptBinding["latest"];
}
export interface ReviewAdmissionHost {
	aliases: AdmissionCASStore<Alias>;
	rounds: ReviewRoundStore;
	authority: SwarmReceiptAuthority;
	readReady(target: ReviewTarget, workItemId: string): Promise<ReviewReady | null>;
	now(): number;
}
const aliasKey = (t: Pick<ReviewTarget, "companyId" | "repositoryId" | "pr">) =>
	`review-alias:v1:${encodeURIComponent(t.companyId)}:${t.repositoryId}:${t.pr}`;
const hold = (cause: string) => ({ action: "hold" as const, cause });

/** A successful stop is insufficient when collector completion is missing. */
export function completeCollectedExecution(value: unknown): unknown {
	if (
		!value ||
		typeof value !== "object" ||
		!("collectorComplete" in value) ||
		value.collectorComplete !== true ||
		!("execution" in value)
	) {
		throw new Error("collector incomplete");
	}
	return value.execution;
}

/** Compose receipt readers for the installed command and injected boundary tests.
 * @param keys Protected key registries with separate factory and execution issuers.
 * @param readArtifact Protected host reader; never selected by request input.
 * @returns Authority consumed by the public admission verifier.
 */
export function createReviewReceiptAuthority(
	keys: Pick<SwarmReceiptAuthority, "publicKeys" | "attestationPublicKeys">,
	readArtifact: (
		kind: "receipts" | "attestation-contexts" | "executions" | "evidence",
		id: string,
	) => unknown,
): SwarmReceiptAuthority {
	return {
		...keys,
		readReceipt: async (id) => readArtifact("receipts", id),
		readAttestationContext: async (id) => readArtifact("attestation-contexts", id),
		readCapturedReview: async (id) => readArtifact("executions", id),
		readExecution: async (id) => completeCollectedExecution(readArtifact("executions", id)),
		readEvidence: async (id) => {
			const value = readArtifact("evidence", id);
			if (typeof value !== "string") throw new Error("evidence bytes required");
			return value;
		},
	};
}

/** Called only by the privileged registration command. A replacement supplies its
 * existing protected ID; omission is an explicit operator declaration of new work. */
export async function registerReviewWork(
	host: Pick<ReviewAdmissionHost, "aliases" | "rounds">,
	input: {
		target: ReviewTarget;
		workItemId?: string;
		patchSha256: string;
		treeSha: string;
		historyComplete: true;
		history: HistoricalReviewRound[];
	},
) {
	const target = reviewTargetSchema.parse(input.target);
	if (
		input.historyComplete !== true ||
		!/^[a-f0-9]{64}$/.test(input.patchSha256) ||
		!/^[a-f0-9]{40}$/.test(input.treeSha)
	)
		throw new Error("review-admission: incomplete trusted registration");
	const key = aliasKey(target);
	const existing = await host.aliases.read(key);
	const workItemId = ref.parse(input.workItemId ?? existing?.workItemId ?? randomUUID());
	if (
		existing &&
		(existing.workItemId !== workItemId ||
			existing.repositoryFullName !== target.repositoryFullName)
	)
		return hold("lineage_conflict");
	const source = createHash("sha256").update(JSON.stringify(input.history)).digest("hex");
	const imported = await importReviewHistory(
		host.rounds,
		{ ...target, workItemId },
		source,
		input.history,
	);
	if (imported.action === "hold") return imported;
	if (existing) return { action: "registered" as const, workItemId };
	const next = {
		...target,
		key,
		version: 1,
		workItemId,
		patchSha256: input.patchSha256,
		treeSha: input.treeSha,
	};
	if (await host.aliases.compareAndSet(key, 0, next))
		return { action: "registered" as const, workItemId };
	const winner = await host.aliases.read(key);
	return winner?.workItemId === workItemId
		? { action: "registered" as const, workItemId }
		: hold("lineage_conflict");
}

/** Called by the actual forge-pr bridge before any review task can be created. */
export async function admitForgeReview(host: ReviewAdmissionHost, raw: unknown) {
	const target = reviewTargetSchema.parse(raw);
	const alias = await host.aliases.read(aliasKey(target));
	if (
		!alias ||
		alias.companyId !== target.companyId ||
		alias.repositoryId !== target.repositoryId ||
		alias.pr !== target.pr ||
		alias.repositoryFullName !== target.repositoryFullName
	)
		return hold("lineage_unknown");
	const history = await host.rounds.read(
		reviewRoundKey({ ...target, workItemId: alias.workItemId }),
	);
	if (!history?.historySource) return hold("history_unknown");
	const ready = await host.readReady(target, alias.workItemId);
	if (!ready) return hold("receipt_required");
	const identity = { ...target, workItemId: alias.workItemId };
	// A stable receipt-bound attempt lets a persisted partial pair resume without
	// treating a replayed webhook or a replacement PR as a new paid round.
	const runId = createHash("sha256")
		.update(
			JSON.stringify([
				alias.workItemId,
				target.pr,
				target.headSha,
				target.baseSha,
				ready.receiptId,
			]),
		)
		.digest("hex");
	const decision = await reserveReviewRound(
		host.rounds,
		{ ...identity, runId, receiptId: ready.receiptId },
		async (id, binding) => {
			const expected = ready.expected;
			if (
				expected.repositoryId !== target.repositoryId ||
				expected.repositoryFullName !== target.repositoryFullName ||
				expected.workItemId !== alias.workItemId ||
				expected.headSha !== target.headSha ||
				expected.baseSha !== target.baseSha ||
				JSON.stringify(binding.latest) !== JSON.stringify(ready.latest)
			)
				return null;
			const result = await verifySwarmReceipt(
				id,
				{ ...expected, nowMs: host.now() },
				host.authority,
			);
			return result.ok
				? { ...binding, id: result.receipt.id, issuedAt: Date.parse(result.receipt.issuedAt) }
				: null;
		},
	);
	return decision.action === "hold" ? decision : { ...decision, workItemId: alias.workItemId };
}

/** Only the privileged completion/reconciliation command supplies terminal facts. */
export function finishForgeReview(
	host: Pick<ReviewAdmissionHost, "rounds">,
	token: ReviewReservation,
	completion: ReviewCompletion | { uncertain: true },
) {
	return completeReviewRound(host.rounds, token, completion);
}
