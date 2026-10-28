import { describe, expect, test } from "bun:test";
import {
	type AdmissionRecord,
	type AdmissionRequest,
	type AdmissionResult,
	type AdmissionStore,
	type TerminalOutcome,
	admit,
	classifyRunEnd,
	holdOnce,
	inputFingerprint,
	settle,
} from "../../fleet/admission/operation-admission.js";

type Records = Map<string, AdmissionRecord>;

const KEY = "c1:test:operation-1";
const FP = inputFingerprint({ head: "aaa", base: "main" });
const FP2 = inputFingerprint({ head: "bbb", base: "main" });

function fakeStore(records: Records): AdmissionStore {
	return {
		read: async (key) => records.get(key),
		compareAndSet: async (key, expectedVersion, next) => {
			if ((records.get(key)?.version ?? 0) !== expectedVersion) return false;
			records.set(key, next as AdmissionRecord);
			return true;
		},
	};
}

// The first two readers both read before either writes.
function racingStore(records: Records): AdmissionStore {
	const base = fakeStore(records);
	let readers = 0;
	let open = () => {};
	const bothRead = new Promise<void>((resolve) => {
		open = resolve;
	});
	return {
		...base,
		read: async (key) => {
			const seen = records.get(key);
			readers += 1;
			if (readers >= 2) open();
			await bothRead;
			return seen;
		},
	};
}

function harness(records: Records = new Map(), store: AdmissionStore = fakeStore(records)) {
	const provider = {
		starts: 0,
		start() {
			this.starts += 1;
		},
	};
	const holds: AdmissionResult[] = [];
	const dispatch = async (request: AdmissionRequest) => {
		const got = await admit(store, request);
		if (got.action === "start") provider.start();
		if (got.announce) holds.push(got);
		return got;
	};
	const end = (result: Parameters<typeof settle>[1], key = KEY) => {
		const record = records.get(key);
		if (!record) throw new Error(`no record for ${key}`);
		records.set(key, settle(record, result));
	};
	return { records, provider, holds, dispatch, end };
}

const wake = (extra: Record<string, unknown> = {}): AdmissionRequest => ({
	key: KEY,
	fingerprint: FP,
	source: "wake",
	paid: true,
	...extra,
});

describe("operation admission", () => {
	test("duplicate, reordered and concurrent wakes for unchanged input start once", async () => {
		const records: Records = new Map();
		const h = harness(records, racingStore(records));
		const got = await Promise.all([h.dispatch(wake({ runId: "r1" })), h.dispatch(wake())]);
		expect(got.filter((g) => g.action === "start")).toHaveLength(1);
		const reordered = inputFingerprint({ base: "main", head: "aaa" });
		await h.dispatch(wake({ fingerprint: reordered, runId: "r3", reason: "second delivery" }));
		await h.dispatch(wake({ runId: "r2", reason: "first delivery" }));
		h.end({ outcome: "succeeded" });
		await h.dispatch(wake({ runId: "r2", reason: "first delivery" }));
		expect(h.provider.starts).toBe(1);
	});

	test("a restarted dispatcher over the same store starts nothing more", async () => {
		const first = harness();
		await first.dispatch(wake());
		expect(first.provider.starts).toBe(1);
		const inFlight = harness(first.records);
		await inFlight.dispatch(wake());
		first.end({ outcome: "failed" });
		const afterEnd = harness(first.records);
		await afterEnd.dispatch(wake());
		expect(inFlight.provider.starts + afterEnd.provider.starts).toBe(0);
	});

	test("an ended attempt is not restarted by cooldown expiry, a comment, a new run id or a new reason", async () => {
		const outcomes: TerminalOutcome[] = ["guard_refused", "cancelled", "paused_409", "auth_401"];
		for (const outcome of outcomes) {
			const h = harness();
			await h.dispatch(wake({ now: 1_000 }));
			h.end({ outcome });
			await h.dispatch(wake({ now: 1_000 + 24 * 60 * 60 * 1000 }));
			await h.dispatch(wake({ updatedAt: "2026-10-09T12:00:00Z", commentId: "c-77" }));
			await h.dispatch(wake({ runId: "run-2" }));
			await h.dispatch(wake({ reason: "idle with 1 assigned task(s)" }));
			expect(h.provider.starts).toBe(1);
			expect(h.holds.map((x) => x.cause)).toEqual([`unchanged_after_${outcome}`]);
		}
	});

	test("a changed fingerprint after an ended attempt starts once more, and repeating it starts nothing", async () => {
		const h = harness();
		await h.dispatch(wake());
		h.end({ outcome: "failed" });
		const changed = await h.dispatch(wake({ fingerprint: FP2 }));
		expect(changed.cause).toBe("input_changed");
		expect(h.provider.starts).toBe(2);
		await h.dispatch(wake({ fingerprint: FP2 }));
		h.end({ outcome: "failed" });
		await h.dispatch(wake({ fingerprint: FP2 }));
		expect(h.provider.starts).toBe(2);
		expect(inputFingerprint(JSON.parse('{"__proto__":{"head":"aaa"}}'))).not.toBe(
			inputFingerprint(JSON.parse('{"__proto__":{"head":"bbb"}}')),
		);
	});

	test("an uncertain attempt is reconciled, never restarted, whatever the input or release", async () => {
		const h = harness();
		await h.dispatch(wake());
		h.end({ uncertain: true });
		const got = [
			await h.dispatch(wake()),
			await h.dispatch(wake({ fingerprint: FP2 })),
			await h.dispatch(wake({ release: { id: "rel-1", verified: true } })),
		];
		expect(got.map((g) => g.action)).toEqual(["reconcile", "reconcile", "reconcile"]);
		expect(h.provider.starts).toBe(1);
	});

	test("manual, recovery and resume are held like a wake, and an unpaid request attaches", async () => {
		const h = harness();
		await h.dispatch(wake());
		h.end({ outcome: "cancelled" });
		const held = await h.dispatch(wake());
		for (const source of ["manual", "recovery", "resume"]) {
			const got = await h.dispatch(wake({ source }));
			expect([source, got.action, got.cause]).toEqual([source, held.action, held.cause]);
		}
		expect(held.action).toBe("hold");
		const before = h.records.get(KEY);
		const unpaid = await h.dispatch(wake({ paid: false, fingerprint: FP2 }));
		expect(unpaid.action).toBe("attach");
		expect(h.records.get(KEY)).toBe(before as AdmissionRecord);
		expect(h.provider.starts).toBe(1);
	});

	test("an unverified release holds, a verified one starts once, and its id cannot be reused", async () => {
		const h = harness();
		await h.dispatch(wake());
		h.end({ outcome: "failed" });
		const unverified = await h.dispatch(wake({ release: { id: "rel-1", verified: false } }));
		expect([unverified.action, unverified.cause]).toEqual(["hold", "release_unverified"]);
		expect(h.provider.starts).toBe(1);
		const noId = await h.dispatch(wake({ release: { verified: true } }));
		expect([noId.action, noId.cause]).toEqual(["hold", "release_unverified"]);
		expect(h.provider.starts).toBe(1);
		const released = await h.dispatch(wake({ release: { id: "rel-1", verified: true } }));
		expect([released.action, released.cause]).toEqual(["start", "release_consumed"]);
		h.end({ outcome: "failed" });
		const reused = await h.dispatch(wake({ release: { id: "rel-1", verified: true } }));
		expect([reused.action, reused.cause]).toEqual(["hold", "release_already_consumed"]);
		expect(h.provider.starts).toBe(2);
	});

	test("an input that already had its attempt is not run again when it comes back", async () => {
		const h = harness();
		await h.dispatch(wake());
		h.end({ outcome: "failed" });
		await h.dispatch(wake({ fingerprint: FP2 }));
		h.end({ outcome: "failed" });
		await h.dispatch(wake());
		await h.dispatch(wake({ fingerprint: FP2 }));
		await h.dispatch(wake());
		expect(h.provider.starts).toBe(2);
		expect(h.holds.map((x) => x.cause)).toEqual(["input_already_attempted"]);
	});

	test("a paid request without a key or fingerprint, or a record in an unknown state, never starts", async () => {
		const h = harness();
		await expect(h.dispatch(wake({ fingerprint: undefined }))).rejects.toThrow();
		await expect(h.dispatch(wake({ fingerprint: "" }))).rejects.toThrow();
		await expect(h.dispatch(wake({ key: "" }))).rejects.toThrow();
		await h.dispatch(wake());
		h.end({ outcome: "failed" });
		await expect(h.dispatch(wake({ fingerprint: undefined }))).rejects.toThrow();
		const stored = h.records.get(KEY) as AdmissionRecord;
		h.records.set(KEY, { ...stored, state: "garbage" } as unknown as AdmissionRecord);
		await expect(h.dispatch(wake())).rejects.toThrow();
		expect(h.provider.starts).toBe(1);
	});

	test("a reservation whose attempt died is reconciled and then held, never restarted", async () => {
		const h = harness();
		await h.dispatch(wake());
		h.end({ uncertain: true });
		const unknown = await h.dispatch(wake());
		expect(unknown.action).toBe("reconcile");
		expect(() => h.end({ outcome: "cancelled" })).toThrow();
		expect(() =>
			h.end(classifyRunEnd({ status: "cancelled" }) as Parameters<typeof settle>[1]),
		).toThrow();
		expect((await h.dispatch(wake())).action).toBe("reconcile");
		h.end({ outcome: "failed", reconciled: true });
		const held = [await h.dispatch(wake()), await h.dispatch(wake())];
		expect(held.map((g) => g.action)).toEqual(["hold", "hold"]);
		expect(h.provider.starts).toBe(1);
		expect(h.holds.map((x) => x.cause)).toEqual(["upstream_uncertain", "unchanged_after_failed"]);
		expect(() => h.end({ outcome: "failed" })).toThrow();
	});

	test("a cancellation without stop proof holds a changed head behind reconcile", async () => {
		const h = harness();
		await h.dispatch(wake());
		h.end(
			classifyRunEnd({ status: "cancelled", errorCode: "agent_paused" }) as Parameters<
				typeof settle
			>[1],
		);
		const changed = await h.dispatch(wake({ fingerprint: FP2 }));
		expect([changed.action, changed.cause]).toEqual(["reconcile", "upstream_uncertain"]);
		expect(h.provider.starts).toBe(1);
		h.end({ outcome: "cancelled", reconciled: true });
		expect((await h.dispatch(wake({ fingerprint: FP2 }))).action).toBe("start");
		expect(h.provider.starts).toBe(2);
	});

	test("a store that never accepts the write holds with store_contention", async () => {
		const records: Records = new Map();
		const h = harness(records, { ...fakeStore(records), compareAndSet: async () => false });
		const got = await h.dispatch(wake());
		expect([got.action, got.cause]).toEqual(["hold", "store_contention"]);
		expect(h.provider.starts).toBe(0);
	});

	test("an unpaid request attaches without reading the store", async () => {
		const refuse = async (): Promise<never> => {
			throw new Error("the store must not be touched");
		};
		const got = await admit({ read: refuse, compareAndSet: refuse }, wake({ paid: false }));
		expect(got.action).toBe("attach");
		const store = { read: refuse, compareAndSet: refuse };
		await expect(admit(store, wake({ paid: undefined }))).rejects.toThrow();
		await expect(admit(store, wake({ paid: 1 }))).rejects.toThrow();
	});

	test("a run that ended without the server knowing the provider's result is uncertain", () => {
		const ends = [
			{ status: "running" },
			{ status: "succeeded" },
			{ status: "interrupted", errorCode: "adapter_failed" },
			{ status: "timed_out" },
			{ status: "failed", errorCode: "process_lost" },
			{ status: "failed", errorCode: "adapter_failed" },
			{ status: "cancelled" },
			{},
		];
		expect(ends.map((end) => classifyRunEnd(end))).toEqual([
			{ live: true },
			{ outcome: "succeeded" },
			{ uncertain: true },
			{ uncertain: true },
			{ uncertain: true },
			{ outcome: "failed" },
			{ uncertain: true },
			{ uncertain: true },
		]);
	});

	test("an unmapped task is recorded and reported once per reason", async () => {
		const records: Records = new Map();
		const store = fakeStore(records);
		const h = harness(records, store);
		const unmapped = "c1:unmapped:issue:i1";
		const announced = [
			await holdOnce(store, unmapped, "unknown_kind"),
			await holdOnce(store, unmapped, "unknown_kind"),
			await holdOnce(store, unmapped, "identity_missing"),
			await holdOnce(store, unmapped, "identity_missing"),
		];
		expect(announced.map((g) => [g.action, g.announce])).toEqual([
			["hold", true],
			["hold", false],
			["hold", true],
			["hold", false],
		]);
		await expect(holdOnce(store, "", "unknown_kind")).rejects.toThrow();
		await h.dispatch(wake());
		const reserved = records.get(KEY);
		const got = await holdOnce(store, KEY, "unknown_kind");
		expect([got.action, got.announce]).toEqual(["hold", false]);
		expect(records.get(KEY)).toBe(reserved as AdmissionRecord);
	});
});
