/** Unresolved diagnostics are durable CAS acknowledgements, never new paid attempts.
 * RED proof: run against the unmodified admission module (announce is always false).
 */
import { expect, test } from "bun:test";
import { pathToFileURL } from "node:url";
import {
	type AdmissionRecord,
	type AdmissionStore,
	admit,
	settle,
} from "../../fleet/admission/operation-admission.js";

const request = { key: "diagnostic", fingerprint: "f1", paid: true, source: "wake" } as const;
function storeFor(initial: AdmissionRecord) {
	let record = initial;
	const store: AdmissionStore = {
		read: async () => record,
		compareAndSet: async (_key, version, next) => {
			if (record.version !== version) return false;
			record = next as AdmissionRecord;
			return true;
		},
	};
	return {
		store,
		get: () => record,
		set: (next: AdmissionRecord) => {
			record = next;
		},
	};
}
async function reserved() {
	const got = await admit({ read: async () => null, compareAndSet: async () => true }, request);
	return got.next as AdmissionRecord;
}
function restarted(record: AdmissionRecord) {
	// A fresh Node process loads only persisted JSON: no JS module state survives.
	const module = pathToFileURL(
		new URL("../../fleet/admission/operation-admission.js", import.meta.url).pathname,
	).href;
	const ran = Bun.spawnSync([
		"node",
		"--input-type=module",
		"-e",
		`
 const {admit}=await import(process.argv[1]);
 let record=JSON.parse(process.argv[2]);
 const store={read:async()=>record,compareAndSet:async(_k,v,n)=>{
 if(record.version!==v)return false;record=n;return true;}};
 const result=await admit(store,JSON.parse(process.argv[3]));
 process.stdout.write(JSON.stringify(result));
 `,
		module,
		JSON.stringify(record),
		JSON.stringify(request),
	]);
	expect(ran.exitCode, ran.stderr.toString()).toBe(0);
	return JSON.parse(ran.stdout.toString());
}

test("unresolved causes announce once across racing callers and restarted processes per attempt", async () => {
	const initial = await reserved(); // Legacy record has no optional diagnostic field.
	const h = storeFor(initial);
	let readers = 0;
	let open = () => {};
	const both = new Promise<void>((resolve) => {
		open = resolve;
	});
	const race: AdmissionStore = {
		...h.store,
		read: async () => {
			const seen = h.get();
			if (++readers === 2) open();
			await both;
			return seen;
		},
	};
	const got = await Promise.all([admit(race, request), admit(race, request)]);
	expect(got.map((r) => [r.action, r.cause])).toEqual([
		["hold", "attempt_in_flight"],
		["hold", "attempt_in_flight"],
	]);
	expect(got.filter((r) => r.announce)).toHaveLength(1);
	expect(h.get()).toEqual({
		...initial,
		unresolvedAnnouncedCauses: ["attempt_in_flight"],
		version: 2,
	});
	expect(restarted(h.get()).announce).toBe(false);
	h.set(settle(h.get(), { uncertain: true }));
	const uncertain = h.get();
	const announced = restarted(uncertain);
	expect([announced.action, announced.cause, announced.announce]).toEqual([
		"reconcile",
		"upstream_uncertain",
		true,
	]);
	h.set(announced.next);
	expect(h.get()).toEqual({
		...uncertain,
		unresolvedAnnouncedCauses: ["attempt_in_flight", "upstream_uncertain"],
		version: uncertain.version + 1,
	});
	expect(restarted(h.get()).announce).toBe(false);
	const unchanged = h.get();
	expect(
		(await admit(h.store, { ...request, fingerprint: "f2", release: { id: "r1", verified: true } }))
			.announce,
	).toBe(false);
	expect(h.get()).toBe(unchanged);
	h.set(settle(h.get(), { outcome: "failed", reconciled: true }));
	expect((await admit(h.store, request)).announce).toBe(true); // Terminal hold stays independent.
	expect((await admit(h.store, request)).announce).toBe(false);
	const next = await admit(h.store, { ...request, release: { id: "r1", verified: true } });
	expect([next.action, next.cause]).toEqual(["start", "release_consumed"]);
	expect(h.get()).toMatchObject({
		attempts: 2,
		consumedReleases: ["r1"],
		holdAnnounced: false,
		unresolvedAnnouncedCauses: [],
	});
	expect((await admit(h.store, request)).announce).toBe(true);
	h.set(settle(h.get(), { outcome: "succeeded" }));
	await admit(h.store, { ...request, fingerprint: "f2" });
	expect(h.get()).toMatchObject({
		attempts: 3,
		spentFingerprints: ["f1", "f2"],
		unresolvedAnnouncedCauses: [],
	});
	expect((await admit(h.store, { ...request, fingerprint: "f2" })).announce).toBe(true);
});

test("failed diagnostic persistence never announces or mutates the admitted attempt", async () => {
	const initial = settle(await reserved(), { uncertain: true });
	const h = storeFor(initial);
	const rejected = await admit({ ...h.store, compareAndSet: async () => false }, request);
	expect([rejected.action, rejected.cause, rejected.announce]).toEqual([
		"hold",
		"store_contention",
		false,
	]);
	expect(h.get()).toBe(initial);
	await expect(
		admit(
			{
				...h.store,
				compareAndSet: async () => {
					throw new Error("write unavailable");
				},
			},
			request,
		),
	).rejects.toThrow("write unavailable");
	expect(h.get()).toBe(initial);
	expect((await admit(h.store, request)).announce).toBe(true);
});
