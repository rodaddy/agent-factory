/** Trusted controller commands only. Inputs are protected executor/preparer records,
 * never reviewer uploads or board verdicts. No process/model is launched here. */
import { createHash } from "node:crypto";
import { z } from "zod";
import { bindingKeys, envelopeSchema, expectedSchema, ref } from "../lib/swarm-receipt-schema.ts";
import { verifySwarmReceipt } from "../lib/swarm-receipt.ts";
import { parseReviewCapture, type CaptureExpected } from "../review/capture.ts";
import { parsePreparationManifest } from "../review/preparation-contract.ts";
import {
	createReviewReceiptAuthority,
	finishForgeReview,
	type ReviewAdmissionHost,
	type ReviewReady,
	reviewTargetSchema,
} from "./review-admission.ts";
import { reviewRoundKey } from "./review-rounds.js";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const captureId = z.string().uuid();
const latestSchema = z
	.strictObject({
		round: z.number().int().positive(),
		runId: ref,
		findingsRevision: z.string().min(1).max(512),
		finishedAt: z.number().int().positive(),
	})
	.nullable();
const preparedSchema = z.strictObject({
	target: reviewTargetSchema,
	expected: expectedSchema.omit({ nowMs: true }),
	latest: latestSchema,
	context: z.record(z.string(), z.unknown()),
	identities: z.strictObject({ claude: z.unknown(), gpt: z.unknown() }),
});
const stoppedSchema = z.object({
	collectorComplete: z.literal(true),
	result: z.literal("success"),
	exitStatus: z.literal(0),
	startedAt: z.number().int().positive(),
	finishedAt: z.number().int().positive(),
	packetFileSha256: z.string().regex(/^[a-f0-9]{64}$/),
	termination: z.strictObject({
		exitCode: z.literal(0),
		signal: z.null(),
		timedOut: z.literal(false),
		truncated: z.literal(false),
	}),
});
export interface ControllerArtifacts {
	read(kind: string, id: string): unknown;
	readCapture(
		id: string,
		lane: "claude" | "gpt",
		file: "run.json" | "collector.json" | "events.jsonl" | "stderr.txt",
	): Uint8Array;
	readManifest(id: string): Uint8Array;
	readIssued(id: string): unknown;
	/** Durable publication: ready is an atomic current pointer; evidence is immutable. */
	publish(kind: string, id: string, value: unknown): void;
}
const object = (bytes: Uint8Array) =>
	JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));

function captureLane(
	store: ControllerArtifacts,
	id: string,
	lane: "claude" | "gpt",
	prepared: z.infer<typeof preparedSchema>,
) {
	const run = stoppedSchema.parse(object(store.readCapture(id, lane, "run.json")));
	z.object({ complete: z.literal(true) }).parse(
		object(store.readCapture(id, lane, "collector.json")),
	);
	const events = store.readCapture(id, lane, "events.jsonl");
	const stderr = store.readCapture(id, lane, "stderr.txt");
	const expected = prepared.identities[lane] as CaptureExpected;
	const parsed = parseReviewCapture(events, expected, run.termination);
	if (!parsed.ok) throw new Error(`capture_${parsed.reason}`);
	const c = parsed.capture;
	if (c.actualIdentity.nonce !== prepared.context.nonce) throw new Error("capture_nonce");
	const binding = Object.fromEntries(bindingKeys.map((key) => [key, prepared.expected[key]]));
	return {
		collectorComplete: true,
		captureId: id,
		lane,
		packetFileSha256: run.packetFileSha256,
		eventsSha256: c.eventsSha256,
		stderrSha256: hash(stderr),
		eventsBytes: events.byteLength,
		termination: run.termination,
		execution: {
			...binding,
			runId: c.actualIdentity.childRunId,
			kind: "blind-review",
			checkIdentity: null,
			captureSource: c.captureSource,
			completed: c.completed,
			exitCode: c.exitCode,
			terminalStatus: c.terminalStatus,
			fatalError: c.fatalError,
			principal: `review-work-${lane}`,
			resolvedModel: c.actualIdentity.model,
			resolvedEffort: c.actualIdentity.thinking,
			startedAt: new Date(run.startedAt * 1000).toISOString(),
			finishedAt: new Date(run.finishedAt * 1000).toISOString(),
			report: c.reportText,
			findings: c.report.findings.map((f) => ({
				id: `${c.actualIdentity.childRunId}:${f.id}`,
				severity: f.severity,
			})),
		},
	};
}

/** Validate actual sealed captures and existing protected check/adjudication records,
 * then publish ready LAST. A failed check writes no readiness marker. */
export async function collectReview(
	host: ReviewAdmissionHost,
	store: ControllerArtifacts,
	rawId: string,
) {
	const id = captureId.parse(rawId);
	const prepared = preparedSchema.parse(store.read("prepared", id));
	const { target, expected, context } = prepared;
	if (
		["repositoryId", "repositoryFullName", "headSha", "baseSha"].some(
			(key) => target[key as keyof typeof target] !== expected[key as keyof typeof expected],
		)
	)
		throw new Error("prepared_binding");
	const manifest = store.readManifest(id);
	if (
		hash(manifest) !== expected.manifestSha256 ||
		!parsePreparationManifest(manifest, {
			repo: target.repositoryFullName,
			pr: target.pr,
			headSha: target.headSha,
			baseSha: target.baseSha,
		}).ok
	)
		throw new Error("prepared_manifest");
	const envelope = envelopeSchema.parse(store.readIssued(id));
	const signed = JSON.parse(envelope.payload);
	if (
		signed.schema !== "review-attestation/v1" ||
		signed.captureId !== id ||
		context.captureId !== id
	)
		throw new Error("capture_binding");
	const receiptId = ref.parse(signed.id);
	const captures = [
		captureLane(store, id, "claude", prepared),
		captureLane(store, id, "gpt", prepared),
	];
	const authority = createReviewReceiptAuthority(host.authority, (kind, key) => {
		if (kind === "receipts" && key === receiptId) return envelope;
		if (kind === "attestation-contexts" && key === receiptId) return context;
		if (kind === "executions") {
			const capture = captures.find((c) => c.execution.runId === key);
			if (capture) return capture;
		}
		return store.read(kind, key);
	});
	const verified = await verifySwarmReceipt(
		receiptId,
		{ ...expected, nowMs: host.now() },
		authority,
	);
	if (!verified.ok) throw new Error(`receipt_${verified.reason}`);
	for (const c of captures) store.publish("executions", c.execution.runId, c);
	store.publish("receipts", receiptId, envelope);
	store.publish("attestation-contexts", receiptId, context);
	const ready: ReviewReady = { receiptId, expected, latest: prepared.latest };
	store.publish("ready", `${target.repositoryId}-${target.pr}-${target.headSha}`, ready);
	return { action: "published" as const, receiptId };
}

const terminalSchema = z.strictObject({
	target: reviewTargetSchema,
	workItemId: ref,
	runId: ref,
	reservationVersion: z.number().int().positive(),
	completion: z.union([
		z.strictObject({ uncertain: z.literal(true) }),
		z.strictObject({
			result: z.enum(["approved", "changes_requested", "failed", "cancelled"]),
			highestSeverity: z.enum(["P0", "P1", "P2", "P3"]).nullable(),
			findingsRevision: z.string().min(1).max(512),
			finishedAt: z.number().int().positive(),
			reconciled: z.literal(true).optional(),
		}),
	]),
});

/** Root executor/controller supplies terminal facts. The token comes from the
 * PostgreSQL reservation, never from the plugin's scheduling snapshot. */
export async function completeProtectedReview(
	host: ReviewAdmissionHost,
	store: ControllerArtifacts,
	rawId: string,
) {
	const id = ref.parse(rawId);
	const terminal = terminalSchema.parse(store.read("terminals", id));
	if (terminal.runId !== id) throw new Error("terminal_binding");
	const key = reviewRoundKey({ ...terminal.target, workItemId: terminal.workItemId });
	const record = await host.rounds.read(key);
	const active = record?.rounds.at(-1);
	if (
		!active ||
		active.runId !== id ||
		active.reservationVersion !== terminal.reservationVersion ||
		active.headSha !== terminal.target.headSha ||
		active.baseSha !== terminal.target.baseSha ||
		active.pr !== terminal.target.pr
	)
		return { action: "hold" as const, cause: "reservation_stale" };
	return finishForgeReview(
		host,
		{ key, runId: active.runId, version: active.reservationVersion },
		terminal.completion,
	);
}
