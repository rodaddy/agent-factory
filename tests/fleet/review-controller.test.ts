import { afterEach, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, randomUUID, sign } from "node:crypto";
import {
	cpSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type {
	AdmissionCASRecord,
	AdmissionCASStore,
} from "../../fleet/admission/operation-admission-store.js";
import {
	admitForgeReview,
	createReviewReceiptAuthority,
	registerReviewWork,
	type ReviewAdmissionHost,
} from "../../fleet/admission/review-admission.ts";
import { controllerArtifacts } from "../../fleet/admission/review-artifacts.ts";
import { collectReview, completeProtectedReview } from "../../fleet/admission/review-controller.ts";
import { reviewRoundKey } from "../../fleet/admission/review-rounds.js";
import { testArchiveDir, testTmpBase } from "../support/test-temp.ts";

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		renameSync(dir, join(testArchiveDir(), `review-controller-${randomUUID()}`));
});
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function cas<T extends AdmissionCASRecord>(): AdmissionCASStore<T> {
	const rows = new Map<string, T>();
	return {
		read: async (key) => structuredClone(rows.get(key)),
		compareAndSet: async (key, version, next) => {
			if ((rows.get(key)?.version ?? 0) !== version) return false;
			rows.set(key, structuredClone(next));
			return true;
		},
	};
}
function fixture(receiptId = "receipt", nowMs = Date.parse("2026-10-13T12:00:00Z")) {
	const root = join(testTmpBase(), `review-controller-${randomUUID()}`);
	dirs.push(root);
	const captures = join(root, "captures"),
		issued = join(root, "issued");
	for (const dir of [
		root,
		captures,
		issued,
		...[
			"prepared",
			"manifests",
			"executions",
			"receipts",
			"attestation-contexts",
			"evidence",
			"ready",
			"terminals",
		].map((kind) => join(root, kind)),
	])
		mkdirSync(dir, { mode: 0o700 });
	const store = controllerArtifacts(root, captures, issued, process.getuid?.() ?? 0);
	const captureId = randomUUID();
	mkdirSync(join(captures, captureId), { mode: 0o700 });
	const target = {
		companyId: "company",
		repositoryId: 160,
		repositoryFullName: "rodaddy/software-factory",
		pr: 12,
		headSha: "a".repeat(40),
		baseSha: "b".repeat(40),
	};
	const manifest = Buffer.from(
		JSON.stringify({
			schemaVersion: 1,
			repo: target.repositoryFullName,
			pr: target.pr,
			baseSha: target.baseSha,
			headSha: target.headSha,
			files: ["context.json", "diff.patch"].map((path) => ({
				path,
				kind: "artifact",
				bytes: 0,
				sha256: hash(""),
			})),
			gitlinks: [],
		}),
	);
	writeFileSync(join(root, "manifests", `${captureId}.json`), manifest, { mode: 0o600 });
	const binding = {
		repositoryId: target.repositoryId,
		repositoryFullName: target.repositoryFullName,
		workItemId: "work",
		baseSha: target.baseSha,
		headSha: target.headSha,
		manifestSha256: hash(manifest),
		packetSha256: hash("packet set"),
	};
	const check = { id: "typecheck", definitionSha256: hash("protected typecheck definition") };
	const expected = {
		...binding,
		policyVersion: "factory-swarm/v1" as const,
		latestFindings: [],
		requiredChecks: [check],
		authorPrincipal: "author",
	};
	const report = { verdict: "approve", findings: [], limitations: [] };
	const nonce = hash("nonce");
	const identities = {
		claude: {
			nonce,
			attemptId: "attempt",
			childRunId: `claude-${receiptId}`,
			provider: "fleet-proxy",
			model: "claude-sonnet-5-5",
			api: "anthropic-messages",
			thinking: "medium",
		},
		gpt: {
			nonce,
			attemptId: "attempt",
			childRunId: `gpt-${receiptId}`,
			provider: "fleet-proxy",
			model: "gpt-6.1-sol",
			api: "openai-responses",
			thinking: "low",
		},
	};
	const lanes = (["claude", "gpt"] as const).map((lane) => {
		const identity = identities[lane];
		const msg = {
			role: "assistant",
			provider: identity.provider,
			model: identity.model,
			api: identity.api,
			content: [{ type: "text", text: JSON.stringify(report) }],
			stopReason: "stop",
			usage: { input: 1, output: 1, totalTokens: 2 },
		};
		const events = `${[
			{ type: "factory_review_runtime", version: 1, ...identity },
			{ type: "agent_start" },
			{ type: "turn_start" },
			{ type: "message_start", message: { ...msg, content: [], stopReason: "pending" } },
			{ type: "message_end", message: msg },
			{ type: "turn_end", message: msg, toolResults: [] },
			{ type: "agent_end", messages: [msg] },
		]
			.map((e) => JSON.stringify(e))
			.join("\n")}\n`;
		const dir = join(captures, captureId, lane);
		mkdirSync(dir, { mode: 0o700 });
		const run = {
			collectorComplete: true,
			result: "success",
			exitStatus: 0,
			startedAt: (nowMs - 7200000) / 1000,
			finishedAt: (nowMs - 3600000) / 1000,
			packetFileSha256: hash(`${lane} packet`),
			termination: { exitCode: 0, signal: null, timedOut: false, truncated: false },
		};
		for (const [name, bytes] of Object.entries({
			"events.jsonl": events,
			"stderr.txt": "",
			"run.json": JSON.stringify(run),
			"collector.json": '{"complete":true}',
		}))
			writeFileSync(join(dir, name), bytes, { mode: 0o600 });
		return {
			lane,
			principal: `review-work-${lane}`,
			model: identity.model,
			thinking: identity.thinking,
			packetFileSha256: run.packetFileSha256,
			startedAt: new Date(run.startedAt * 1000).toISOString(),
			finishedAt: new Date(run.finishedAt * 1000).toISOString(),
			exitCode: 0,
			eventsSha256: hash(events),
			stderrSha256: hash(""),
			eventsBytes: Buffer.byteLength(events),
		};
	});
	const attestation = {
		schema: "review-attestation/v1",
		id: receiptId,
		captureId,
		nonce,
		bundleSha256: hash("bundle"),
		preparedManifestSha256: binding.manifestSha256,
		issuedAt: new Date(nowMs - 1800000).toISOString(),
		expiresAt: new Date(nowMs + 3600000).toISOString(),
		lanes,
	};
	const keys = generateKeyPairSync("ed25519");
	const payload = JSON.stringify(attestation);
	const keyId = `ed25519:${hash(keys.publicKey.export({ type: "spki", format: "der" }))}`;
	writeFileSync(
		join(issued, `${captureId}.json`),
		JSON.stringify({
			keyId,
			payload,
			signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64"),
		}),
		{ mode: 0o600 },
	);
	const context = {
		schemaVersion: 1,
		attestationId: receiptId,
		captureId,
		nonce,
		bundleSha256: attestation.bundleSha256,
		receipt: {
			...binding,
			schemaVersion: 1,
			latestFindingsSha256: hash("[]"),
			reviewedSha: binding.headSha,
			fixedSha: null,
			policyVersion: "factory-swarm/v1",
			checkRunIds: [{ runId: `check-${receiptId}`, reportSha256: hash("typecheck passed") }],
			dispositions: [],
		},
		lanes: lanes.map((l) => ({
			lane: l.lane,
			runId: identities[l.lane].childRunId,
			packetFileSha256: l.packetFileSha256,
		})),
	};
	store.publish("prepared", captureId, { target, expected, latest: null, context, identities });
	store.publish("executions", `check-${receiptId}`, {
		collectorComplete: true,
		execution: {
			...binding,
			runId: `check-${receiptId}`,
			kind: "check",
			checkIdentity: check,
			captureSource: "executor",
			completed: true,
			exitCode: 0,
			terminalStatus: "success",
			fatalError: false,
			principal: "check-executor",
			resolvedModel: null,
			resolvedEffort: null,
			startedAt: lanes[0]?.startedAt,
			finishedAt: lanes[0]?.finishedAt,
			report: "typecheck passed",
			findings: [],
		},
	});
	const host: ReviewAdmissionHost = {
		aliases: cas(),
		rounds: cas(),
		now: () => nowMs,
		authority: createReviewReceiptAuthority(
			{ publicKeys: new Map(), attestationPublicKeys: new Map([[keyId, keys.publicKey]]) },
			store.read,
		),
		readReady: async (t) => {
			try {
				return store.read("ready", `${t.repositoryId}-${t.pr}-${t.headSha}`) as Awaited<
					ReturnType<ReviewAdmissionHost["readReady"]>
				>;
			} catch {
				return null;
			}
		},
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
	return { root, captures, issued, captureId, target, store, host, register, nowMs };
}

test("sealed capture ingestion publishes ready, admission saves token, controller completes exactly once", async () => {
	const f = fixture();
	await f.register();
	expect(await admitForgeReview(f.host, f.target)).toEqual({
		action: "hold",
		cause: "receipt_required",
	});
	expect(await collectReview(f.host, f.store, f.captureId)).toEqual({
		action: "published",
		receiptId: "receipt",
	});
	const admitted = await admitForgeReview(f.host, f.target);
	expect(admitted.action).toBe("start");
	if (admitted.action === "hold") throw new Error("admission held");
	const terminal = {
		target: f.target,
		workItemId: "work",
		runId: admitted.reservation.runId,
		reservationVersion: admitted.reservation.version,
		completion: {
			result: "approved",
			highestSeverity: null,
			findingsRevision: "findings-1",
			finishedAt: f.nowMs,
		},
	};
	f.store.publish("terminals", admitted.reservation.runId, terminal);
	expect(await completeProtectedReview(f.host, f.store, admitted.reservation.runId)).toMatchObject({
		action: "recorded",
		state: "terminal",
	});
	expect(await completeProtectedReview(f.host, f.store, admitted.reservation.runId)).toEqual({
		action: "hold",
		cause: "reservation_stale",
	});
	expect(
		(await f.host.rounds.read(reviewRoundKey({ ...f.target, workItemId: "work" })))?.rounds,
	).toHaveLength(1);
	expect(await admitForgeReview(f.host, f.target)).toEqual({
		action: "hold",
		cause: "run_already_used",
	});
});

test("incomplete captures and altered signed bytes publish no ready artifact", async () => {
	for (const mode of ["incomplete", "signature", "manifest"]) {
		const f = fixture();
		await f.register();
		if (mode === "incomplete")
			writeFileSync(join(f.captures, f.captureId, "gpt", "collector.json"), '{"complete":false}');
		if (mode === "signature") {
			const file = join(f.issued, `${f.captureId}.json`);
			const envelope = JSON.parse(readFileSync(file, "utf8"));
			envelope.payload += " ";
			writeFileSync(file, JSON.stringify(envelope));
		}
		if (mode === "manifest") writeFileSync(join(f.root, "manifests", `${f.captureId}.json`), "{}");
		await expect(collectReview(f.host, f.store, f.captureId)).rejects.toThrow();
		expect(await f.host.readReady(f.target, "work")).toBeNull();
		expect(await admitForgeReview(f.host, f.target)).toEqual({
			action: "hold",
			cause: "receipt_required",
		});
	}
});

test("controller refuses a stale protected terminal reservation without changing its PG round", async () => {
	const f = fixture();
	await f.register();
	await collectReview(f.host, f.store, f.captureId);
	const admitted = await admitForgeReview(f.host, f.target);
	if (admitted.action === "hold") throw new Error("held");
	f.store.publish("terminals", admitted.reservation.runId, {
		target: f.target,
		workItemId: "work",
		runId: admitted.reservation.runId,
		reservationVersion: admitted.reservation.version + 1,
		completion: {
			result: "approved",
			highestSeverity: null,
			findingsRevision: "findings-1",
			finishedAt: f.nowMs,
		},
	});
	expect(await completeProtectedReview(f.host, f.store, admitted.reservation.runId)).toEqual({
		action: "hold",
		cause: "reservation_stale",
	});
	expect((await f.host.rounds.read(admitted.reservation.key))?.rounds.at(-1)?.state).toBe(
		"reserved",
	);
});

test("protected filesystem rejects symlink input and conflicting immutable publication", () => {
	const f = fixture();
	symlinkSync(
		join(f.root, "prepared", `${f.captureId}.json`),
		join(f.root, "prepared", "symlink.json"),
	);
	expect(() => f.store.read("prepared", "symlink")).toThrow();
	f.store.publish("terminals", "immutable", { result: "failed" });
	expect(() => f.store.publish("terminals", "immutable", { result: "approved" })).toThrow();
	expect(f.store.read("terminals", "immutable")).toEqual({ result: "failed" });
});

test("publication failure before final marker leaves admission held with no ready artifact", async () => {
	const f = fixture();
	await f.register();
	const failing = {
		...f.store,
		publish: (kind: string, id: string, value: unknown) => {
			if (kind === "attestation-contexts") throw new Error("disk unavailable");
			f.store.publish(kind, id, value);
		},
	};
	await expect(collectReview(f.host, failing, f.captureId)).rejects.toThrow("disk unavailable");
	expect(await f.host.readReady(f.target, "work")).toBeNull();
	expect(await admitForgeReview(f.host, f.target)).toEqual({
		action: "hold",
		cause: "receipt_required",
	});
});

test("fresh verified receipt replaces only ready for a completed same-head round; stale publication holds", async () => {
	const f = fixture();
	await f.register();
	await collectReview(f.host, f.store, f.captureId);
	const initialReady = f.store.read(
		"ready",
		`${f.target.repositoryId}-${f.target.pr}-${f.target.headSha}`,
	);
	const admitted = await admitForgeReview(f.host, f.target);
	if (admitted.action === "hold") throw new Error("held");
	f.store.publish("terminals", admitted.reservation.runId, {
		target: f.target,
		workItemId: "work",
		runId: admitted.reservation.runId,
		reservationVersion: admitted.reservation.version,
		completion: {
			result: "approved",
			highestSeverity: null,
			findingsRevision: "findings-1",
			finishedAt: f.nowMs,
		},
	});
	await completeProtectedReview(f.host, f.store, admitted.reservation.runId);
	const receiptBefore = readFileSync(join(f.root, "receipts", "receipt.json"));
	const next = fixture("receipt-two", f.nowMs + 7_200_000);
	for (const kind of ["prepared", "manifests", "issued"])
		cpSync(
			join(next.root, kind, `${next.captureId}.json`),
			join(f.root, kind, `${next.captureId}.json`),
		);
	cpSync(join(next.captures, next.captureId), join(f.captures, next.captureId), {
		recursive: true,
	});
	cpSync(
		join(next.root, "executions", "check-receipt-two.json"),
		join(f.root, "executions", "check-receipt-two.json"),
	);
	const preparedPath = join(f.root, "prepared", `${next.captureId}.json`);
	const prepared = JSON.parse(readFileSync(preparedPath, "utf8"));
	prepared.latest = {
		round: 1,
		runId: admitted.reservation.runId,
		findingsRevision: "findings-1",
		finishedAt: f.nowMs,
	};
	writeFileSync(preparedPath, JSON.stringify(prepared));
	f.host.authority.attestationPublicKeys = new Map([
		...(f.host.authority.attestationPublicKeys ?? []),
		...(next.host.authority.attestationPublicKeys ?? []),
	]);
	f.host.now = () => next.nowMs;
	expect(await collectReview(f.host, f.store, next.captureId)).toEqual({
		action: "published",
		receiptId: "receipt-two",
	});
	expect(readFileSync(join(f.root, "receipts", "receipt.json"))).toEqual(receiptBefore);
	const readyId = `${f.target.repositoryId}-${f.target.pr}-${f.target.headSha}`;
	const latestReady = f.store.read("ready", readyId);
	f.store.publish("ready", readyId, initialReady);
	expect(await admitForgeReview(f.host, f.target)).toEqual({
		action: "hold",
		cause: "run_already_used",
	});
	f.store.publish("ready", readyId, latestReady);
	expect(await admitForgeReview(f.host, f.target)).toMatchObject({ action: "start", round: 2 });
});

test("root umask 077 cannot remove the protected admission-reader permission", () => {
	const f = fixture();
	const previous = process.umask(0o077);
	try {
		f.store.publish("terminals", "reader-mode", { result: "failed" });
	} finally {
		process.umask(previous);
	}
	expect(statSync(join(f.root, "terminals", "reader-mode.json")).mode & 0o777).toBe(0o640);
});
