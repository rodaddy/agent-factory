import { expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import type {
	AdmissionCASRecord,
	AdmissionCASStore,
} from "../../fleet/admission/operation-admission-store.js";
import {
	admitForgeReview,
	createReviewReceiptAuthority,
	type ReviewAdmissionHost,
	registerReviewWork,
} from "../../fleet/admission/review-admission.ts";
import { reviewRoundKey } from "../../fleet/admission/review-rounds.js";
import { type SwarmReceiptAuthority, verifySwarmReceipt } from "../../fleet/lib/swarm-receipt.ts";
import { reviewAdmissionFor } from "../../fleet/plugins/forge-pr/review-admission.js";

const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const keys = generateKeyPairSync("ed25519");
const target = {
	companyId: "company",
	repositoryId: 160,
	repositoryFullName: "rodaddy/software-factory",
	pr: 10,
	headSha: "a".repeat(40),
	baseSha: "b".repeat(40),
};
function cas<T extends AdmissionCASRecord>(): AdmissionCASStore<T> {
	const rows = new Map<string, T>();
	return {
		read: async (k) => structuredClone(rows.get(k)),
		compareAndSet: async (k, v, next) => {
			if ((rows.get(k)?.version ?? 0) !== v) return false;
			rows.set(k, structuredClone(next));
			return true;
		},
	};
}
function fixture(thinking = "low") {
	const { companyId: _company, pr: _pr, ...identity } = target;
	const binding = {
		...identity,
		workItemId: "work",
		manifestSha256: hash("manifest"),
		packetSha256: hash("trusted review packet set"),
	};
	const check = { id: "typecheck", definitionSha256: hash("protected check definition") };
	const expected = {
		...binding,
		policyVersion: "factory-swarm/v1" as const,
		latestFindings: [],
		requiredChecks: [check],
		authorPrincipal: "author",
		nowMs: Date.parse("2026-10-12T12:00:00Z"),
	};
	const records = ["claude", "gpt", "check"].map((lane) => ({
		...binding,
		runId: lane,
		kind: lane === "check" ? "check" : "blind-review",
		checkIdentity: lane === "check" ? check : null,
		captureSource: "executor",
		completed: true,
		exitCode: 0,
		terminalStatus: "success",
		fatalError: false,
		principal: `review-work-${lane}`,
		resolvedModel: lane === "claude" ? "claude-sonnet-5-5" : lane === "gpt" ? "gpt-6.1-sol" : null,
		resolvedEffort: lane === "claude" ? thinking : lane === "gpt" ? "low" : null,
		startedAt: "2026-10-12T10:00:00Z",
		finishedAt: "2026-10-12T11:00:00Z",
		report: `${lane} report`,
		findings: [],
	}));
	const attestation = {
		schema: "review-attestation/v1",
		id: "receipt",
		captureId: "0b6e1f3a-7c2d-4e59-8a1b-3c4d5e6f7a8b",
		nonce: hash("nonce"),
		bundleSha256: hash("bundle"),
		preparedManifestSha256: binding.manifestSha256,
		issuedAt: "2026-10-12T11:30:00Z",
		expiresAt: "2026-10-12T13:00:00Z",
		lanes: records.slice(0, 2).map((r) => ({
			lane: r.runId,
			principal: r.principal,
			model: r.resolvedModel,
			thinking: r.resolvedEffort,
			packetFileSha256: hash(`${r.runId} packet`),
			startedAt: r.startedAt,
			finishedAt: r.finishedAt,
			exitCode: 0,
			eventsSha256: hash(`${r.runId} events`),
			stderrSha256: hash(""),
			eventsBytes: 88,
		})),
	};
	const receipt = {
		...binding,
		schemaVersion: 1,
		id: attestation.id,
		latestFindingsSha256: hash("[]"),
		reviewedSha: binding.headSha,
		fixedSha: null,
		policyVersion: "factory-swarm/v1",
		issuedAt: attestation.issuedAt,
		expiresAt: attestation.expiresAt,
		lanes: records.slice(0, 2).map((r) => ({
			runId: r.runId,
			model: r.resolvedModel,
			effort: r.resolvedEffort,
			reportSha256: hash(r.report),
		})),
		checkRunIds: [{ runId: "check", reportSha256: hash("check report") }],
		dispositions: [],
	};
	const {
		id: _id,
		issuedAt: _issued,
		expiresAt: _expires,
		lanes: _lanes,
		...factoryContext
	} = receipt;
	const context = {
		schemaVersion: 1,
		attestationId: attestation.id,
		captureId: attestation.captureId,
		nonce: attestation.nonce,
		bundleSha256: attestation.bundleSha256,
		receipt: factoryContext,
		lanes: attestation.lanes.map((l) => ({
			lane: l.lane,
			runId: l.lane,
			packetFileSha256: l.packetFileSha256,
		})),
	};
	const captures = attestation.lanes.map((lane, i) => ({
		collectorComplete: true,
		captureId: attestation.captureId,
		lane: lane.lane,
		packetFileSha256: lane.packetFileSha256,
		eventsSha256: lane.eventsSha256,
		stderrSha256: lane.stderrSha256,
		eventsBytes: lane.eventsBytes,
		termination: { exitCode: 0, signal: null, timedOut: false, truncated: false },
		execution: records[i],
	}));
	let envelope = {
		keyId: `ed25519:${hash(keys.publicKey.export({ type: "spki", format: "der" }))}`,
		payload: "",
		signature: "",
	};
	const seal = () => {
		const payload = JSON.stringify(attestation);
		envelope = {
			...envelope,
			payload,
			signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64"),
		};
	};
	seal();
	const attestationKeys = new Map([[envelope.keyId, keys.publicKey]]);
	const checkCapture = { collectorComplete: true, execution: records[2] };
	const authority = createReviewReceiptAuthority(
		{ publicKeys: new Map(), attestationPublicKeys: attestationKeys },
		(kind, id) => {
			if (kind === "receipts") return envelope;
			if (kind === "attestation-contexts") return context;
			if (kind === "executions")
				return id === "check" ? checkCapture : captures.find((c) => c.execution?.runId === id);
			return null;
		},
	);
	const host: ReviewAdmissionHost = {
		aliases: cas(),
		rounds: cas(),
		authority,
		now: () => expected.nowMs,
		readReady: async () => ({ receiptId: "receipt", expected, latest: null }),
	};
	const register = () =>
		registerReviewWork(host, {
			target,
			workItemId: "work",
			patchSha256: hash("patch"),
			treeSha: "c".repeat(40),
			historyComplete: true,
			history: [],
		});
	return {
		authority,
		attestationKeys,
		checkCapture,
		context,
		captures,
		records,
		attestation,
		expected,
		seal,
		envelope: () => envelope,
		host,
		register,
		verify: () => verifySwarmReceipt("receipt", expected, authority),
	};
}

test("signed issuer lanes plus independent protected context and checks release real Forge admission", async () => {
	for (const effort of ["low", "medium"]) {
		const f = fixture(effort);
		await f.register();
		const admit = reviewAdmissionFor(
			target.companyId,
			async (path) =>
				path.includes("/pulls/")
					? {
							state: "open",
							head: { sha: target.headSha },
							base: { sha: target.baseSha, repo: { id: target.repositoryId } },
						}
					: { id: target.repositoryId, full_name: target.repositoryFullName },
			(raw) => admitForgeReview(f.host, raw),
		);
		expect(
			await admit({
				repo: target.repositoryFullName,
				number: target.pr,
				headSha: target.headSha,
				action: "opened",
				title: "Review",
				url: "https://forge.example.internal/rodaddy/software-factory/pulls/10",
				author: "author",
				priority: "medium",
				priorityWhy: "default",
			}),
		).toMatchObject({ action: "start", round: 1, workItemId: "work" });
	}
});

test("class authority retains private-state readers through bridged adjudication", async () => {
	const f = fixture();
	const evidence = JSON.stringify({
		repositoryId: f.expected.repositoryId,
		repositoryFullName: f.expected.repositoryFullName,
		workItemId: f.expected.workItemId,
		baseSha: f.expected.baseSha,
		headSha: f.expected.headSha,
		manifestSha256: f.expected.manifestSha256,
		packetSha256: f.expected.packetSha256,
		schemaVersion: 1,
		findingId: "claude:f1",
		severity: "P2",
		disposition: "refuted",
		adjudicatorPrincipal: "independent-adjudicator",
		acceptedEvidenceRef: "protected-evidence",
	});
	Object.assign(f.records[0] ?? {}, { findings: [{ id: "claude:f1", severity: "P2" }] });
	Object.assign(f.context.receipt, {
		dispositions: [
			{
				findingId: "claude:f1",
				severity: "P2",
				decision: "refuted",
				evidenceSha256: hash(evidence),
			},
		],
	});
	class ClassAuthority implements SwarmReceiptAuthority {
		#delegate = f.authority;
		#evidence = new Map([[hash(evidence), evidence]]);
		get publicKeys() {
			return this.#delegate.publicKeys;
		}
		get attestationPublicKeys() {
			return this.#delegate.attestationPublicKeys;
		}
		readReceipt(id: string) {
			return this.#delegate.readReceipt(id);
		}
		readExecution(id: string) {
			return this.#delegate.readExecution(id);
		}
		async readAttestationContext(id: string) {
			return this.#delegate.readAttestationContext?.(id);
		}
		async readCapturedReview(id: string) {
			return this.#delegate.readCapturedReview?.(id);
		}
		async readEvidence(id: string) {
			return this.#evidence.get(id);
		}
	}
	const authority = new ClassAuthority();
	expect(await verifySwarmReceipt("receipt", f.expected, authority)).toMatchObject({ ok: true });
});

test("valid signature alone cannot manufacture factory trust", async () => {
	const f = fixture();
	f.authority.readAttestationContext = async () => null;
	expect((await f.verify()).ok).toBe(false);
});

test("tampered or unknown issuer never releases admission", async () => {
	for (const mode of ["signature", "key"]) {
		const f = fixture();
		await f.register();
		if (mode === "signature") f.envelope().payload += " ";
		else f.attestationKeys.clear();
		expect(await admitForgeReview(f.host, target)).toMatchObject({
			action: "hold",
			cause: "receipt_invalid",
		});
		expect(
			(await f.host.rounds.read(reviewRoundKey({ ...target, workItemId: "work" })))?.rounds,
		).toEqual([]);
	}
});

test("protected collector completion and known normal termination cannot be inferred", async () => {
	for (const patch of [
		{ collectorComplete: false },
		{ collectorComplete: undefined },
		{ termination: { exitCode: null, signal: null, timedOut: false, truncated: false } },
		{ termination: { exitCode: 0, signal: "SIGTERM", timedOut: false, truncated: false } },
		{ termination: { exitCode: 0, signal: null, timedOut: true, truncated: false } },
		{ termination: { exitCode: 0, signal: null, timedOut: false, truncated: true } },
	]) {
		const f = fixture();
		Object.assign(f.captures[0] ?? {}, patch);
		expect((await f.verify()).ok).toBe(false);
	}
});

test("signed nonce, packet, capture, bundle and manifest must match independent context", async () => {
	for (const field of ["nonce", "bundleSha256", "captureId"] as const) {
		const f = fixture();
		f.context[field] =
			field === "captureId" ? "1b6e1f3a-7c2d-4e59-8a1b-3c4d5e6f7a8b" : hash("wrong");
		expect((await f.verify()).ok).toBe(false);
	}
	const f = fixture();
	const lane = f.context.lanes[0];
	if (lane) lane.packetFileSha256 = hash("wrong");
	expect((await f.verify()).ok).toBe(false);
	for (const field of [
		"repositoryFullName",
		"workItemId",
		"headSha",
		"manifestSha256",
		"packetSha256",
	] as const) {
		const f = fixture();
		f.context.receipt[field] =
			field === "headSha"
				? "d".repeat(40)
				: field.endsWith("Sha256")
					? hash("wrong")
					: field === "repositoryFullName"
						? "rodaddy/other"
						: "other";
		expect((await f.verify()).ok).toBe(false);
	}
});

test("protected parser provenance, model, effort and fatal status must agree with signed capture", async () => {
	for (const field of ["eventsSha256", "stderrSha256", "packetFileSha256"] as const) {
		const f = fixture();
		const c = f.captures[0];
		if (c) c[field] = hash("wrong");
		expect((await f.verify()).ok).toBe(false);
	}
	for (const patch of [
		{ fatalError: true },
		{ resolvedEffort: "high" },
		{ principal: "author" },
		{ exitCode: null },
		{ terminalStatus: "error" },
	]) {
		const f = fixture();
		Object.assign(f.records[0] ?? {}, patch);
		expect((await f.verify()).ok).toBe(false);
	}
});

test("checks and findings remain mandatory after conversion", async () => {
	const f = fixture();
	const check = f.records[2];
	if (check) check.checkIdentity = { id: "trivial", definitionSha256: hash("trivial") };
	expect((await f.verify()).ok).toBe(false);
	const g = fixture();
	Object.assign(g.records[0] ?? {}, { findings: [{ id: "claude:f1", severity: "P1" }] });
	expect((await g.verify()).ok).toBe(false);
});

// Guards were mutation-tested: removing context equality or collector literal
// made their corresponding refusal test fail against this signed positive fixture.
test("execution-attester trust cannot authorize native factory receipts", async () => {
	const f = fixture();
	const positive = await f.verify();
	expect(positive.ok).toBe(true);
	if (!positive.ok) throw new Error("fixture failed");
	const payload = JSON.stringify(positive.receipt);
	Object.assign(f.envelope(), {
		payload,
		signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64"),
	});
	expect(await f.verify()).toEqual({ ok: false, reason: "issuer" });
});

test("low policy is explicit; medium is preserved and unsupported effort is refused", async () => {
	for (const effort of ["low", "medium", "high", "minimal"]) {
		const f = fixture(effort);
		const result = await f.verify();
		expect(result.ok).toBe(["low", "medium"].includes(effort));
		if (result.ok)
			expect(result.receipt.lanes.find((l) => l.model === "claude-sonnet-5-5")?.effort).toBe(
				effort,
			);
	}
});

test("check collector, report digest and final-head binding cannot be skipped", async () => {
	for (const mode of ["collector", "missing", "digest", "head"]) {
		const f = fixture();
		if (mode === "collector") f.checkCapture.collectorComplete = false;
		if (mode === "missing") f.checkCapture.execution = undefined;
		if (mode === "digest")
			f.context.receipt.checkRunIds[0] = { runId: "check", reportSha256: hash("different output") };
		if (mode === "head" && f.checkCapture.execution)
			f.checkCapture.execution.headSha = "d".repeat(40);
		expect((await f.verify()).ok).toBe(false);
	}
});

test("expired signed attestation and mismatched signed parser timestamps refuse", async () => {
	const f = fixture();
	f.attestation.expiresAt = "2026-10-12T11:45:00Z";
	f.seal();
	expect(await f.verify()).toEqual({ ok: false, reason: "stale" });
	const g = fixture();
	const lane = g.attestation.lanes[0];
	if (lane) lane.finishedAt = "2026-10-12T11:01:00Z";
	g.seal();
	expect((await g.verify()).ok).toBe(false);
});
