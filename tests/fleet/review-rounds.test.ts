import { describe, expect, test } from "bun:test";
import { createAdmissionStore } from "../../fleet/admission/operation-admission-store.js";
import {
	completeReviewRound,
	reserveReviewRound,
	reviewRoundKey,
	type ReceiptBinding,
	type ReviewCompletion,
	type ReviewDecision,
	type ReviewRequest,
	type ReviewReservation,
	type ReviewRoundRecord,
	type ReviewRoundStore,
	type VerifiedReviewReceipt,
} from "../../fleet/admission/review-rounds.js";

// Compile-time bridge only: constructing this adapter performs no database queries.
const typedStore: ReviewRoundStore = createAdmissionStore<ReviewRoundRecord>({
	companyId: "company",
	query: async () => [],
});
void typedStore;

const HEAD = "a".repeat(40);
const BASE = "b".repeat(40);
const identity = {
	companyId: "company",
	repositoryId: 12,
	workItemId: "trusted-lineage-1827",
	pr: 23,
	headSha: HEAD,
	baseSha: BASE,
};
const request = (runId: string, headSha = HEAD): ReviewRequest => ({ ...identity, runId, headSha });
const binding = (headSha = HEAD, latest: ReceiptBinding["latest"] = null): ReceiptBinding => ({
	...identity,
	headSha,
	latest,
});
const completion = (
	finishedAt: number,
	findingsRevision = `findings-${finishedAt}`,
): ReviewCompletion => ({
	result: "approved",
	highestSeverity: null,
	findingsRevision,
	finishedAt,
});

// Fake CAS is a public-boundary policy test, not proof of the production database or issuer.
function storeFor(rows = new Map<string, ReviewRoundRecord>()): ReviewRoundStore {
	return {
		async read(key) {
			const row = rows.get(key);
			return row ? structuredClone(row) : undefined;
		},
		async compareAndSet(key, version, next) {
			if ((rows.get(key)?.version ?? 0) !== version) return false;
			rows.set(key, structuredClone(next));
			return true;
		},
	};
}
function fixture() {
	const rows = new Map<string, ReviewRoundRecord>();
	const receipts = new Map<string, VerifiedReviewReceipt>();
	const store = storeFor(rows);
	const verify = async (id: string) => receipts.get(id) ?? null;
	const add = (id: string, issuedAt: number, expected = binding()) => {
		receipts.set(id, { ...expected, id, issuedAt });
		return id;
	};
	const reserve = (input: ReviewRequest) => reserveReviewRound(store, input, verify);
	return { rows, receipts, store, verify, add, reserve };
}
function reservation(decision: ReviewDecision): ReviewReservation {
	if (decision.action === "hold") throw new Error(`unexpected hold: ${decision.cause}`);
	return decision.reservation;
}
async function twoRounds(f: ReturnType<typeof fixture>) {
	const first = reservation(await f.reserve({ ...request("one"), receiptId: f.add("local-1", 1) }));
	await completeReviewRound(f.store, first, completion(10));
	const secondHead = "c".repeat(40);
	const second = reservation(
		await f.reserve({
			...request("two", secondHead),
			receiptId: f.add("local-2", 11, binding(secondHead)),
		}),
	);
	await completeReviewRound(f.store, second, completion(20));
	return { round: 2, runId: "two", findingsRevision: "findings-20", finishedAt: 20 };
}

describe("durable parent review-round policy (inert)", () => {
	test("requires verified exact-head/base evidence before either initial paid start", async () => {
		const f = fixture();
		expect(await f.reserve(request("no-proof"))).toEqual({
			action: "hold",
			cause: "receipt_required",
		});
		const forged = { ...request("forged"), receiptId: "invented", verified: true };
		expect(await f.reserve(forged)).toEqual({ action: "hold", cause: "receipt_invalid" });
		f.add("wrong-base", 1, { ...binding(), baseSha: "d".repeat(40) });
		expect(await f.reserve({ ...request("wrong"), receiptId: "wrong-base" })).toEqual({
			action: "hold",
			cause: "receipt_invalid",
		});
		expect(f.rows.size).toBe(0);
		const first = reservation(await f.reserve({ ...request("one"), receiptId: f.add("valid", 1) }));
		await completeReviewRound(f.store, first, completion(10));
		expect(await f.reserve(request("two", "c".repeat(40)))).toEqual({
			action: "hold",
			cause: "receipt_required",
		});
		expect(f.rows.get(first.key)?.rounds).toHaveLength(1);
	});

	test("two rounds then hold; latest findings and fresh evidence release exactly one more", async () => {
		const f = fixture();
		const latest = await twoRounds(f);
		const head = "d".repeat(40);
		expect(await f.reserve(request("three", head))).toEqual({
			action: "hold",
			cause: "receipt_required",
		});
		for (const [id, issuedAt, prior] of [
			["old-time", 20, latest],
			["old-findings", 21, { ...latest, findingsRevision: "findings-10" }],
			["no-dispositions", 21, null],
		] as const) {
			f.add(id, issuedAt, binding(head, prior));
			expect(await f.reserve({ ...request("three", head), receiptId: id })).toEqual({
				action: "hold",
				cause: "receipt_invalid",
			});
		}
		const receiptId = f.add("release", 21, binding(head, latest));
		const next = await f.reserve({ ...request("three", head), receiptId });
		expect(next.action).toBe("start");
		await completeReviewRound(f.store, reservation(next), completion(30));
		expect(await f.reserve({ ...request("four", head), receiptId })).toEqual({
			action: "hold",
			cause: "receipt_consumed",
		});
		expect(f.rows.get(reservation(next).key)?.rounds).toHaveLength(3);
	});

	test("same-head fresh events cannot spend the second round without a release receipt", async () => {
		const f = fixture();
		const first = reservation(await f.reserve({ ...request("one"), receiptId: f.add("local", 1) }));
		await completeReviewRound(f.store, first, { ...completion(10), highestSeverity: "P1" });
		const row = f.rows.get(first.key);
		expect(row?.rounds[0]?.completion?.outcome).toBe("fix_first");
		f.add("mere-event", 11);
		expect(await f.reserve({ ...request("new-event"), receiptId: "mere-event" })).toEqual({
			action: "hold",
			cause: "receipt_invalid",
		});
		const latest = { round: 1, runId: "one", findingsRevision: "findings-10", finishedAt: 10 };
		const changedBase = { ...binding(HEAD, latest), baseSha: "e".repeat(40) };
		f.add("base-changed", 11, changedBase);
		expect(
			await f.reserve({
				...request("base-change"),
				baseSha: changedBase.baseSha,
				receiptId: "base-changed",
			}),
		).toEqual({
			action: "hold",
			cause: "head_base_mismatch",
		});
		expect(
			(
				await f.reserve({
					...request("retry"),
					receiptId: f.add("fixed", 11, binding(HEAD, latest)),
				})
			).action,
		).toBe("start");
	});

	test("replacement PR keeps the lineage budget; unknown lineage never reserves", async () => {
		const f = fixture();
		const latest = await twoRounds(f);
		const head = "d".repeat(40);
		const replacement = { ...request("replacement", head), pr: 99 };
		expect(reviewRoundKey(replacement)).toBe(reviewRoundKey(identity));
		expect(await f.reserve({ ...replacement, workItemId: "" })).toEqual({
			action: "hold",
			cause: "lineage_unknown",
		});
		const prior = structuredClone([...f.rows.values()][0]);
		f.add("unreleased", 21, { ...binding(head), pr: 99 });
		expect(await f.reserve({ ...replacement, receiptId: "unreleased" })).toEqual({
			action: "hold",
			cause: "receipt_invalid",
		});
		expect(f.rows.get(reviewRoundKey(identity))).toEqual(prior);
		const receiptId = f.add("linked-release", 21, { ...binding(head, latest), pr: 99 });
		const next = await f.reserve({ ...replacement, receiptId });
		expect(next.action).toBe("start");
		expect(f.rows.get(reservation(next).key)?.rounds).toHaveLength(3);
	});

	test("parallel heads share one root; restart attaches replay and cannot duplicate consumption", async () => {
		const f = fixture();
		const a = { ...request("one"), receiptId: f.add("a", 1) };
		const head = "c".repeat(40);
		const b = { ...request("two", head), receiptId: f.add("b", 1, binding(head)) };
		const restart = storeFor(f.rows);
		const results = await Promise.all([f.reserve(a), reserveReviewRound(restart, b, f.verify)]);
		expect(results.filter((result) => result.action === "start")).toHaveLength(1);
		expect(results.filter((result) => result.action === "hold")).toHaveLength(1);
		const winner = results.find((result) => result.action === "start");
		if (!winner || winner.action === "hold") throw new Error("no start");
		const input = winner.reservation.runId === "one" ? a : b;
		expect(await reserveReviewRound(restart, input, f.verify)).toEqual({
			...winner,
			action: "attach",
		});
		expect(
			await reserveReviewRound(restart, { ...input, baseSha: "e".repeat(40) }, f.verify),
		).toEqual({
			action: "hold",
			cause: "run_binding_mismatch",
		});
		expect(f.rows.get(winner.reservation.key)?.rounds).toHaveLength(1);
	});

	test("uncertainty holds through restart until trusted reconciliation; stale completion loses", async () => {
		const f = fixture();
		const first = reservation(await f.reserve({ ...request("one"), receiptId: f.add("local", 1) }));
		expect((await completeReviewRound(f.store, first, { uncertain: true })).action).toBe(
			"recorded",
		);
		const restart = storeFor(f.rows);
		expect(await reserveReviewRound(restart, request("two"), f.verify)).toEqual({
			action: "hold",
			cause: "execution_uncertain",
		});
		expect(await completeReviewRound(restart, first, completion(10))).toEqual({
			action: "hold",
			cause: "reconciliation_required",
		});
		await completeReviewRound(restart, first, { ...completion(10), reconciled: true });
		const second = reservation(
			await f.reserve({
				...request("two", "c".repeat(40)),
				receiptId: f.add("second", 11, binding("c".repeat(40))),
			}),
		);
		for (const stale of [
			first,
			{ ...second, version: first.version },
			{ ...second, runId: "wrong" },
		]) {
			expect(await completeReviewRound(restart, stale, completion(20))).toEqual({
				action: "hold",
				cause: "reservation_stale",
			});
		}
		expect(f.rows.get(second.key)?.rounds.at(-1)?.state).toBe("reserved");
		await completeReviewRound(restart, second, completion(20));
		expect(f.rows.get(second.key)?.rounds).toHaveLength(2);
	});

	test("receipt replay, reused run, repository mismatch and verifier failure do not mutate", async () => {
		const f = fixture();
		const first = reservation(await f.reserve({ ...request("one"), receiptId: f.add("used", 1) }));
		await completeReviewRound(f.store, first, completion(10));
		const before = structuredClone(f.rows.get(first.key));
		expect(await f.reserve({ ...request("two", "c".repeat(40)), receiptId: "used" })).toEqual({
			action: "hold",
			cause: "receipt_consumed",
		});
		expect(await f.reserve({ ...request("one"), receiptId: f.add("fresh", 11) })).toEqual({
			action: "hold",
			cause: "run_already_used",
		});
		expect(await f.reserve({ ...request("other"), repositoryId: 99, receiptId: "fresh" })).toEqual({
			action: "hold",
			cause: "receipt_invalid",
		});
		await expect(
			reserveReviewRound(f.store, { ...request("failure"), receiptId: "fresh" }, async () => {
				throw new Error("issuer unavailable");
			}),
		).rejects.toThrow("issuer unavailable");
		expect(f.rows.get(first.key)).toEqual(before);
		expect(f.rows.size).toBe(1);
	});

	test("root ignores board events, fails closed on invalid identity and bounded CAS contention", async () => {
		expect(reviewRoundKey({ ...identity, companyId: "a:b" })).not.toBe(
			reviewRoundKey({ ...identity, companyId: "a%3Ab" }),
		);
		expect(() => reviewRoundKey({ ...identity, repositoryId: 0 })).toThrow();
		const f = fixture();
		const input = {
			...request("one"),
			boardIssueId: "new",
			assignee: "other",
			receiptId: f.add("ok", 1),
		};
		let attempts = 0;
		const losing: ReviewRoundStore = {
			read: f.store.read,
			async compareAndSet() {
				attempts++;
				return false;
			},
		};
		expect(await reserveReviewRound(losing, input, f.verify)).toEqual({
			action: "hold",
			cause: "contention",
		});
		expect(attempts).toBe(5);
		expect(f.rows.size).toBe(0);
	});
});
