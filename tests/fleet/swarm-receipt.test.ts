import { describe, expect, test } from "bun:test";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import {
	type SwarmReceiptAuthority,
	type SwarmReceiptExpected,
	verifySwarmReceipt,
} from "../../fleet/lib/swarm-receipt.js";

const hash = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
const keys = generateKeyPairSync("ed25519");
const NOW = Date.parse("2026-10-09T12:00:00Z");
const ID = "receipt-1976";
const CHECK = { id: "typecheck", definitionSha256: hash("protected typecheck definition") };
const binding = {
	repositoryId: 160,
	repositoryFullName: "rodaddy/software-factory",
	workItemId: "SOF-1976",
	baseSha: "a".repeat(40),
	headSha: "b".repeat(40),
	manifestSha256: hash("complete changed files"),
	packetSha256: hash("trusted fixed blind packet"),
};

function fixture() {
	const expected: SwarmReceiptExpected = {
		...binding,
		policyVersion: "factory-swarm/v1",
		latestFindings: [],
		requiredChecks: [CHECK],
		authorPrincipal: "author",
		nowMs: NOW,
	};
	const records = capturedRecords();
	const receipt = signedReceipt(records);
	const evidence = new Map<string, string | Uint8Array>();
	let envelope: unknown;
	const privilegedReads: string[] = [];
	const authority: SwarmReceiptAuthority = {
		publicKeys: new Map([["adjudicator", keys.publicKey]]),
		readReceipt: async () => envelope,
		readExecution: async (id) => {
			privilegedReads.push(id);
			return records[id] ?? null;
		},
		readEvidence: async (digest) => evidence.get(digest) ?? null,
	};
	const seal = (payload = JSON.stringify(receipt)) => {
		envelope = {
			keyId: "adjudicator",
			payload,
			signature: sign(null, Buffer.from(payload), keys.privateKey).toString("base64"),
		};
	};
	seal();
	return {
		expected,
		receipt,
		records,
		evidence,
		authority,
		seal,
		privilegedReads,
		setEnvelope: (value: unknown) => {
			envelope = value;
		},
		verify: () => verifySwarmReceipt(ID, expected, authority),
	};
}

function capturedRecords() {
	const records: Record<string, Record<string, unknown>> = {};
	for (const [runId, model, effort, principal] of [
		["sol-run", "gpt-6.1-sol", "low", "sol-executor"],
		["sonnet-run", "claude-sonnet-5-5", "medium", "sonnet-executor"],
		["check-run", null, null, "sol-executor"],
	] as const) {
		records[runId] = {
			...binding,
			runId,
			kind: runId === "check-run" ? "check" : "blind-review",
			checkIdentity: runId === "check-run" ? CHECK : null,
			captureSource: "executor",
			completed: true,
			exitCode: 0,
			terminalStatus: "success",
			fatalError: false,
			principal,
			resolvedModel: model,
			resolvedEffort: effort,
			startedAt: "2026-10-09T11:00:00Z",
			finishedAt: "2026-10-09T11:30:00Z",
			report: `${runId}: captured output, no findings`,
			findings: [],
		};
	}
	return records;
}

function signedReceipt(records: Record<string, Record<string, unknown>>) {
	const lane = (runId: string, model: string, effort: string) => ({
		runId,
		model,
		effort,
		reportSha256: hash(String(records[runId]?.report)),
	});
	const receipt: Record<string, unknown> = {
		...binding,
		latestFindingsSha256: hash("[]"),
		schemaVersion: 1,
		id: ID,
		reviewedSha: binding.headSha,
		fixedSha: null,
		policyVersion: "factory-swarm/v1",
		issuedAt: "2026-10-09T11:45:00Z",
		expiresAt: "2026-10-09T13:00:00Z",
		lanes: [
			lane("sol-run", "gpt-6.1-sol", "low"),
			lane("sonnet-run", "claude-sonnet-5-5", "medium"),
		],
		checkRunIds: [{ runId: "check-run", reportSha256: hash(String(records["check-run"]?.report)) }],
		dispositions: [],
	};
	return receipt;
}

type Fixture = ReturnType<typeof fixture>;
function item<T>(values: Record<string, T> | T[], key: string | number): T {
	const value = (values as Record<string | number, T>)[key];
	if (value === undefined) throw new Error("missing fixture item");
	return value;
}
const fail = (reason: string) => ({ ok: false, reason });
function finding(
	f: Fixture,
	severity: string,
	decision = "open",
	evidenceSha256: string | null = null,
) {
	item(f.records, "sol-run").findings = [{ id: "sol-run:f1", severity }];
	f.receipt.dispositions = [{ findingId: "sol-run:f1", severity, decision, evidenceSha256 }];
	f.seal();
}
function adjudication(findingId = "sol-run:f1", disposition = "resolved") {
	return {
		...binding,
		schemaVersion: 1,
		findingId,
		severity: "P1",
		disposition,
		adjudicatorPrincipal: "independent-adjudicator",
		acceptedEvidenceRef: "protected-evidence-123",
	};
}

describe("signed swarm receipt ingest (sf1976 cut1)", () => {
	test("required check set rejects an unrelated trivial successful execution", async () => {
		const f = fixture();
		item(f.records, "check-run").report = "x";
		item(f.receipt.checkRunIds as Array<Record<string, unknown>>, 0).reportSha256 = hash("x");
		delete item(f.records, "check-run").checkIdentity;
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("lane"));
	});
	test("finding-bound adjudication refuses an arbitrary stored review report", async () => {
		const f = fixture();
		const report = String(item(f.records, "sol-run").report);
		const digest = hash(report);
		finding(f, "P1", "resolved", digest);
		f.evidence.set(digest, report);
		expect<unknown>(await f.verify()).toEqual(fail("evidence"));
	});
	test("required check definitions reject missing, substituted and duplicated sets", async () => {
		const f = fixture();
		const lint = { id: "lint", definitionSha256: hash("protected lint definition") };
		f.expected.requiredChecks = [CHECK, lint];
		expect<unknown>(await f.verify()).toEqual(fail("lane"));
		f.records["lint-run"] = {
			...item(f.records, "check-run"),
			runId: "lint-run",
			checkIdentity: lint,
		};
		(f.receipt.checkRunIds as unknown[]).push({
			runId: "lint-run",
			reportSha256: hash(String(item(f.records, "lint-run").report)),
		});
		f.seal();
		expect((await f.verify()).ok).toBe(true);
		for (const checkIdentity of [
			null,
			{ ...lint, definitionSha256: hash("trivial command") },
			{ ...lint, id: "other" },
			CHECK,
		]) {
			item(f.records, "lint-run").checkIdentity = checkIdentity;
			expect<unknown>(await f.verify()).toEqual(fail("lane"));
		}
		item(f.records, "lint-run").checkIdentity = lint;
		item(f.records, "sol-run").checkIdentity = CHECK;
		expect<unknown>(await f.verify()).toEqual(fail("lane"));
		for (const requiredChecks of [undefined, [], [CHECK, CHECK]]) {
			const expected = { ...f.expected, requiredChecks } as unknown as SwarmReceiptExpected;
			expect<unknown>(await verifySwarmReceipt(ID, expected, f.authority)).toEqual(fail("invalid"));
		}
	});
	test("adjudication is bound to the head, finding, decision and independent principal", async () => {
		for (const patch of [
			{ repositoryId: 161 },
			{ workItemId: "other-work" },
			{ headSha: "c".repeat(40) },
			{ findingId: "sol-run:other" },
			{ disposition: "refuted" },
			{ severity: "P0" },
			{ adjudicatorPrincipal: "author" },
			{ adjudicatorPrincipal: "sol-executor" },
			{ adjudicatorPrincipal: "sonnet-executor" },
			{ acceptedEvidenceRef: "" },
			{ extra: true },
		]) {
			const f = fixture();
			const bytes = JSON.stringify({ ...adjudication(), ...patch });
			const digest = hash(bytes);
			finding(f, "P1", "resolved", digest);
			f.evidence.set(digest, bytes);
			expect<unknown>(await f.verify()).toEqual(fail("evidence"));
		}
		const f = fixture();
		const bytes = JSON.stringify(adjudication());
		const digest = hash(bytes);
		finding(f, "P1", "resolved", digest);
		item(f.records, "sonnet-run").findings = [{ id: "sonnet-run:f2", severity: "P1" }];
		(f.receipt.dispositions as unknown[]).push({
			findingId: "sonnet-run:f2",
			severity: "P1",
			decision: "resolved",
			evidenceSha256: digest,
		});
		f.evidence.set(digest, bytes);
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("evidence"));
	});
	test("latest findings cannot be omitted or silently replaced (latest guard mutation sentinel)", async () => {
		const f = fixture();
		f.expected.latestFindings = [{ id: "prior-run:open", severity: "P1" }];
		expect<unknown>(await f.verify()).toEqual(fail("binding"));
		f.receipt.latestFindingsSha256 = hash('[["prior-run:open","P1"]]');
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("findings"));
		f.receipt.dispositions = [
			{ findingId: "prior-run:open", severity: "P1", decision: "open", evidenceSha256: null },
		];
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("findings"));
	});
	test("latest resolved findings and new final findings form one complete disposition set", async () => {
		const f = fixture();
		f.expected.latestFindings = [{ id: "prior-run:fixed", severity: "P1" }];
		f.receipt.latestFindingsSha256 = hash('[["prior-run:fixed","P1"]]');
		finding(f, "P2");
		const evidence = JSON.stringify(adjudication("prior-run:fixed"));
		const digest = hash(evidence);
		(f.receipt.dispositions as unknown[]).push({
			findingId: "prior-run:fixed",
			severity: "P1",
			decision: "resolved",
			evidenceSha256: digest,
		});
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("evidence"));
		f.evidence.set(digest, evidence);
		expect<unknown>(await f.verify()).toEqual({ ok: true, receipt: f.receipt });
	});
	test("latest findings digest is order-independent and binds severities and membership", async () => {
		const f = fixture();
		f.expected.latestFindings = [
			{ id: "prior-run:z", severity: "P3" },
			{ id: "prior-run:a", severity: "P2" },
		];
		f.receipt.latestFindingsSha256 = hash('[["prior-run:a","P2"],["prior-run:z","P3"]]');
		f.receipt.dispositions = f.expected.latestFindings.map(({ id, severity }) => ({
			findingId: id,
			severity,
			decision: "open",
			evidenceSha256: null,
		}));
		f.seal();
		expect((await f.verify()).ok).toBe(true);
		f.expected.latestFindings.reverse();
		expect((await f.verify()).ok).toBe(true);
		f.receipt.latestFindingsSha256 = hash("[]");
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("binding"));
		f.receipt.latestFindingsSha256 = hash('[["prior-run:a","P2"],["prior-run:z","P3"]]');
		f.seal();
		item(f.expected.latestFindings, 0).severity = "P1";
		expect<unknown>(await f.verify()).toEqual(fail("binding"));
	});
	test("initial latest findings must be explicit, qualified, unique and bounded", async () => {
		for (const latestFindings of [
			undefined,
			[{ id: "unqualified", severity: "P2" }],
			[
				{ id: "prior-run:x", severity: "P2" },
				{ id: "prior-run:x", severity: "P2" },
			],
			Array.from({ length: 513 }, (_, i) => ({ id: `prior-run:f${i}`, severity: "P2" })),
		]) {
			const f = fixture();
			const expected = { ...f.expected, latestFindings } as SwarmReceiptExpected;
			expect<unknown>(await verifySwarmReceipt(ID, expected, f.authority)).toEqual(fail("invalid"));
		}
		const f = fixture();
		delete f.receipt.latestFindingsSha256;
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("invalid"));
	});
	test("one disposition covers overlapping latest and final findings without hiding conflicts", async () => {
		const f = fixture();
		f.expected.latestFindings = [{ id: "sol-run:f1", severity: "P2" }];
		f.receipt.latestFindingsSha256 = hash('[["sol-run:f1","P2"]]');
		finding(f, "P2");
		expect((await f.verify()).ok).toBe(true);
		item(f.records, "sol-run").findings = [{ id: "sol-run:f1", severity: "P1" }];
		expect<unknown>(await f.verify()).toEqual(fail("findings"));
	});
	test("terminal success and fatal-error-free capture are required even at exit zero (status mutation sentinel)", async () => {
		for (const runId of ["sol-run", "check-run"]) {
			for (const patch of [
				{ terminalStatus: undefined },
				{ terminalStatus: "error" },
				{ terminalStatus: "aborted" },
				{ terminalStatus: "truncated" },
				{ terminalStatus: "malformed" },
				{ fatalError: undefined },
				{ fatalError: true },
				{ fatalError: "false" },
			]) {
				const f = fixture();
				Object.assign(item(f.records, runId), patch);
				expect<unknown>(await f.verify()).toEqual(fail("lane"));
			}
		}
	});
	test("normalized error status blocks error-only output, not report keywords", async () => {
		const f = fixture();
		item(f.records, "sol-run").report = '{"type":"error","error":"upstream disconnected"}';
		item(f.receipt.lanes as Array<Record<string, unknown>>, 0).reportSha256 = hash(
			String(item(f.records, "sol-run").report),
		);
		f.seal();
		item(f.records, "sol-run").fatalError = true;
		expect<unknown>(await f.verify()).toEqual(fail("lane"));
		item(f.records, "sol-run").fatalError = false;
		item(f.records, "sol-run").report = "Review of transport error handling completed successfully";
		item(f.receipt.lanes as Array<Record<string, unknown>>, 0).reportSha256 = hash(
			String(item(f.records, "sol-run").report),
		);
		f.seal();
		expect((await f.verify()).ok).toBe(true);
	});

	test("accepts real Ed25519 signatures and captured reviews/checks at the final head", async () => {
		const f = fixture();
		f.receipt.fixedSha = binding.headSha;
		f.seal();
		expect<unknown>(await f.verify()).toEqual({ ok: true, receipt: f.receipt });
	});
	test("rejects a forged payload before any execution read (signature mutation sentinel)", async () => {
		const f = fixture();
		const original = JSON.stringify(f.receipt);
		const payload = `${original}\n`;
		f.setEnvelope({
			keyId: "adjudicator",
			payload,
			signature: sign(null, Buffer.from(original), keys.privateKey).toString("base64"),
		});
		expect<unknown>(await f.verify()).toEqual(fail("signature"));
		expect(f.privilegedReads).toEqual([]);
	});
	test("unknown issuer, wrong trusted key, private key and non-Ed25519 key fail closed", async () => {
		const f = fixture();
		f.authority.publicKeys = new Map();
		expect<unknown>(await f.verify()).toEqual(fail("issuer"));
		expect(f.privilegedReads).toEqual([]);
		f.authority.publicKeys = new Map([["adjudicator", generateKeyPairSync("ed25519").publicKey]]);
		expect<unknown>(await f.verify()).toEqual(fail("signature"));
		for (const key of [
			keys.privateKey,
			generateKeyPairSync("ec", { namedCurve: "prime256v1" }).publicKey,
		]) {
			f.authority.publicKeys = new Map([["adjudicator", key]]);
			expect<unknown>(await f.verify()).toEqual(fail("issuer"));
		}
	});
	test("missing, unreadable or malformed protected receipts never throw", async () => {
		const f = fixture();
		f.setEnvelope(null);
		expect<unknown>(await f.verify()).toEqual(fail("missing"));
		for (const value of [{}, "uploaded report", { keyId: "x", payload: 4, signature: "x" }]) {
			f.setEnvelope(value);
			expect<unknown>(await f.verify()).toEqual(fail("invalid"));
		}
		f.authority.readReceipt = async () => {
			throw new Error("store unavailable");
		};
		expect<unknown>(await f.verify()).toEqual(fail("read_error"));
	});
	test("receipt references cannot be paths, URLs or uploaded envelopes", async () => {
		const f = fixture();
		for (const id of [
			"../receipt",
			"https://issuer/x",
			JSON.stringify(f.receipt),
			"",
			"x".repeat(129),
		])
			expect<unknown>(await verifySwarmReceipt(id, f.expected, f.authority)).toEqual(
				fail("invalid"),
			);
	});
	test("invalid JSON, unknown authority fields, oversize payload and malformed signature are rejected", async () => {
		const f = fixture();
		for (const payload of [
			"{",
			JSON.stringify({ ...f.receipt, verdict: "approved" }),
			" ".repeat(131073),
		]) {
			f.seal(payload);
			expect<unknown>(await f.verify()).toEqual(fail("invalid"));
		}
		f.setEnvelope({
			keyId: "adjudicator",
			payload: JSON.stringify(f.receipt),
			signature: "not base64",
		});
		expect<unknown>(await f.verify()).toEqual(fail("invalid"));
	});
	for (const [field, wrong] of Object.entries({
		id: "other-receipt",
		repositoryId: 161,
		repositoryFullName: "rodaddy/other",
		workItemId: "SOF-other",
		baseSha: "c".repeat(40),
		headSha: "d".repeat(40),
		manifestSha256: hash("partial files"),
		packetSha256: hash("author persuasion"),
		reviewedSha: "c".repeat(40),
		fixedSha: "c".repeat(40),
	})) {
		test(`rejects signed wrong ${field} (binding mutation sentinel)`, async () => {
			const f = fixture();
			f.receipt[field] = wrong;
			f.seal();
			expect<unknown>(await f.verify()).toEqual(fail("binding"));
		});
	}
	test("wrong policy and noncanonical integer/SHA bindings are invalid", async () => {
		for (const patch of [
			{ policyVersion: "factory-swarm/v0" },
			{ repositoryId: "160" },
			{ headSha: "B".repeat(40) },
		]) {
			const f = fixture();
			Object.assign(f.receipt, patch);
			f.seal();
			expect<unknown>(await f.verify()).toEqual(fail("invalid"));
		}
	});
	test("expired, future, inverted and invalid timestamps fail closed", async () => {
		for (const patch of [
			{ expiresAt: "2026-10-09T12:00:00Z" },
			{ issuedAt: "2026-10-09T12:01:00Z" },
			{ expiresAt: "2026-10-09T11:40:00Z" },
		]) {
			const f = fixture();
			Object.assign(f.receipt, patch);
			f.seal();
			expect<unknown>(await f.verify()).toEqual(fail("stale"));
		}
		const f = fixture();
		f.receipt.issuedAt = "yesterday";
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("invalid"));
	});
	for (const [field, wrong] of Object.entries({
		repositoryId: 161,
		repositoryFullName: "rodaddy/other",
		workItemId: "SOF-other",
		baseSha: "c".repeat(40),
		headSha: "c".repeat(40),
		manifestSha256: hash("incomplete"),
		packetSha256: hash("different packet"),
		runId: "other-run",
	})) {
		test(`rejects executor substitution of ${field}`, async () => {
			const f = fixture();
			item(f.records, "sol-run")[field] = wrong;
			expect<unknown>(await f.verify()).toEqual(fail("binding"));
		});
	}
	test("claims in reports cannot substitute resolved model or effort", async () => {
		for (const patch of [{ resolvedModel: "gpt-6-luna" }, { resolvedEffort: "high" }]) {
			const f = fixture();
			Object.assign(item(f.records, "sol-run"), patch);
			expect<unknown>(await f.verify()).toEqual(fail("lane"));
		}
		const f = fixture();
		const lanes = f.receipt.lanes as Array<Record<string, unknown>>;
		item(lanes, 1).model = "gpt-6.1-sol";
		item(lanes, 1).effort = "low";
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("lane"));
	});
	test("two independent non-author principals and all distinct run IDs are required", async () => {
		for (const principal of ["sol-executor", "author"]) {
			const f = fixture();
			item(f.records, "sonnet-run").principal = principal;
			expect<unknown>(await f.verify()).toEqual(fail("lane"));
		}
		for (const target of ["lane", "check"]) {
			const f = fixture();
			const refs = f.receipt[target === "lane" ? "lanes" : "checkRunIds"] as Array<
				Record<string, unknown>
			>;
			item(refs, target === "lane" ? 1 : 0).runId = "sol-run";
			f.seal();
			expect<unknown>(await f.verify()).toEqual(fail("lane"));
		}
	});
	test("empty, oversized, failed, unfinished and uploaded review records cannot count", async () => {
		for (const patch of [
			{ report: " " },
			{ report: "x".repeat(262145) },
			{ exitCode: 1 },
			{ completed: false },
			{ captureSource: "upload" },
			{ captureSource: "mock" },
			{ unexpected: true },
		]) {
			const f = fixture();
			Object.assign(item(f.records, "sol-run"), patch);
			expect<unknown>(await f.verify()).toEqual(fail("lane"));
		}
	});
	test("altered report bytes cannot replace the signed immutable review artifact", async () => {
		const f = fixture();
		item(f.records, "sol-run").report = "different captured output";
		expect<unknown>(await f.verify()).toEqual(fail("lane"));
	});
	test("execution chronology must complete before issue time", async () => {
		for (const patch of [
			{ startedAt: "2026-10-09T11:31:00Z" },
			{ finishedAt: "2026-10-09T11:46:00Z" },
			{ finishedAt: "2026-10-10T11:00:00Z" },
		]) {
			const f = fixture();
			Object.assign(item(f.records, "sol-run"), patch);
			expect<unknown>(await f.verify()).toEqual(fail("lane"));
		}
	});
	test("checks require bound immutable output, successful final head and non-author capture", async () => {
		for (const patch of [
			{ headSha: "a".repeat(40) },
			{ packetSha256: hash("other") },
			{ report: "altered" },
			{ report: "" },
			{ exitCode: 2 },
			{ kind: "blind-review" },
			{ principal: "author" },
		]) {
			const f = fixture();
			Object.assign(item(f.records, "check-run"), patch);
			expect((await f.verify()).ok).toBe(false);
		}
		const f = fixture();
		f.receipt.checkRunIds = [];
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("invalid"));
	});
	test("missing execution, malformed records and reader exceptions cannot become green", async () => {
		const f = fixture();
		delete f.records["sol-run"];
		expect<unknown>(await f.verify()).toEqual(fail("lane"));
		f.authority.readExecution = async () => {
			throw new Error("denied");
		};
		expect<unknown>(await f.verify()).toEqual(fail("read_error"));
	});
	for (const severity of ["P0", "P1"]) {
		test(`open ${severity} blocks acceptance`, async () => {
			const f = fixture();
			finding(f, severity);
			expect<unknown>(await f.verify()).toEqual(fail("findings"));
		});
	}
	test("missing finding disposition is not a clean review (finding mutation sentinel)", async () => {
		const f = fixture();
		finding(f, "P1");
		f.receipt.dispositions = [];
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("findings"));
	});
	test("all and only executor-qualified findings require one severity-matching disposition", async () => {
		for (const mode of ["extra", "duplicate", "severity", "unqualified", "second-lane"]) {
			const f = fixture();
			finding(f, "P2");
			const ds = f.receipt.dispositions as Array<Record<string, unknown>>;
			if (mode === "extra") ds.push({ ...ds[0], findingId: "sol-run:extra" });
			if (mode === "duplicate") ds.push({ ...ds[0] });
			if (mode === "severity") item(ds, 0).severity = "P3";
			if (mode === "unqualified")
				item(f.records, "sol-run").findings = [{ id: "f1", severity: "P2" }];
			if (mode === "second-lane")
				item(f.records, "sonnet-run").findings = [{ id: "sonnet-run:f2", severity: "P3" }];
			f.seal();
			expect<unknown>(await f.verify()).toEqual(fail("findings"));
		}
	});
	test("resolved and refuted findings require nonempty protected evidence with its actual digest", async () => {
		for (const decision of ["resolved", "refuted"]) {
			const f = fixture();
			const bytes = new TextEncoder().encode(JSON.stringify(adjudication("sol-run:f1", decision)));
			const digest = hash(bytes);
			finding(f, "P1", decision, digest);
			expect<unknown>(await f.verify()).toEqual(fail("evidence"));
			f.evidence.set(digest, "wrong bytes");
			expect<unknown>(await f.verify()).toEqual(fail("evidence"));
			f.evidence.set(digest, bytes);
			expect((await f.verify()).ok).toBe(true);
			finding(f, "P1", decision);
			expect<unknown>(await f.verify()).toEqual(fail("evidence"));
		}
	});
	test("empty, oversized or unreadable evidence cannot close findings", async () => {
		const f = fixture();
		const digest = hash("");
		finding(f, "P1", "resolved", digest);
		for (const evidence of ["", "x".repeat(1048577)]) {
			f.evidence.set(digest, evidence);
			expect<unknown>(await f.verify()).toEqual(fail("evidence"));
		}
		f.authority.readEvidence = async () => {
			throw new Error("denied");
		};
		expect<unknown>(await f.verify()).toEqual(fail("read_error"));
	});
	test("unresolved P2/P3 remain unchanged and visible in the accepted signed receipt", async () => {
		const f = fixture();
		finding(f, "P2");
		item(f.records, "sonnet-run").findings = [{ id: "sonnet-run:f2", severity: "P3" }];
		(f.receipt.dispositions as unknown[]).push({
			findingId: "sonnet-run:f2",
			severity: "P3",
			decision: "open",
			evidenceSha256: null,
		});
		f.seal();
		expect<unknown>(await f.verify()).toEqual({ ok: true, receipt: f.receipt });
	});
	test("bounded reference and finding counts refuse missing lanes and oversized collections", async () => {
		for (const patch of [
			{ lanes: [] },
			{
				checkRunIds: Array.from({ length: 33 }, (_, i) => ({
					runId: `check-${i}`,
					reportSha256: hash("x"),
				})),
			},
			{
				dispositions: Array.from({ length: 513 }, (_, i) => ({
					findingId: `sol-run:f${i}`,
					severity: "P2",
					decision: "open",
					evidenceSha256: null,
				})),
			},
		]) {
			const f = fixture();
			Object.assign(f.receipt, patch);
			f.seal();
			expect<unknown>(await f.verify()).toEqual(fail("invalid"));
		}
		const f = fixture();
		item(f.records, "sol-run").findings = Array.from({ length: 257 }, (_, i) => ({
			id: `sol-run:f${i}`,
			severity: "P2",
		}));
		expect<unknown>(await f.verify()).toEqual(fail("lane"));
	});
	test("payload byte limit rejects otherwise-valid signed JSON above the cap", async () => {
		const f = fixture();
		const json = JSON.stringify(f.receipt);
		f.seal(json.padEnd(131072));
		expect((await f.verify()).ok).toBe(true);
		f.seal(json.padEnd(131073));
		expect<unknown>(await f.verify()).toEqual(fail("invalid"));
	});
	test("report byte limit rejects a signed multibyte report below the character cap", async () => {
		const f = fixture();
		const lane = item(f.receipt.lanes as Array<Record<string, unknown>>, 0);
		const report = "é".repeat(131072);
		item(f.records, "sol-run").report = report;
		lane.reportSha256 = hash(report);
		f.seal();
		expect((await f.verify()).ok).toBe(true);
		item(f.records, "sol-run").report = `${report}é`;
		lane.reportSha256 = hash(`${report}é`);
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("lane"));
	});
	test("duplicate checks or executor findings cannot become unambiguous dispositions", async () => {
		const f = fixture();
		const checks = f.receipt.checkRunIds as unknown[];
		checks.push(checks[0]);
		f.seal();
		expect<unknown>(await f.verify()).toEqual(fail("lane"));
		const g = fixture();
		finding(g, "P2");
		item(g.records, "sol-run").findings = [
			{ id: "sol-run:f1", severity: "P2" },
			{ id: "sol-run:f1", severity: "P2" },
		];
		expect<unknown>(await g.verify()).toEqual(fail("findings"));
	});
});
