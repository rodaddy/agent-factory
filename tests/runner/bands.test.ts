/**
 * Runner box inventory. These tests exist because #78 was a LIVE production
 * defect: a hardcoded `>= 9901` floor rejected every VMID the fleet allocates,
 * so `parseBoxes` returned no boxes for a container that was genuinely running
 * while accepting ids that existed nowhere on the fleet.
 */
import { describe, expect, test } from "bun:test";
import {
	BAND_CEILING,
	isAllocatableVmid,
	lookupBox,
	RUNNER_BOXES,
	type RunnerBoxSpec,
} from "../../src/runner/bands";

describe("runner box inventory", () => {
	test("states the live fleet's addressing exactly", () => {
		// Verified against a REAL allocation on 2026-07-30:
		//   vmid=9001 host=node05 ip=10.0.21.1 mac=BC:24:11:90:00:01
		expect(lookupBox(9001)).toEqual({
			vmid: 9001,
			band: "pool",
			mac: "BC:24:11:90:00:01",
			ip: "10.0.21.1",
			allocatable: true,
		});
		// The orchestrator: 9000 % 100 = 0 -> .21.0, no special case needed.
		expect(lookupBox(9000)?.ip).toBe("10.0.21.0");
		expect(lookupBox(9000)?.allocatable).toBe(false);
	});

	test("the forge band 9101-9150 is stated, persistent, and never allocatable", () => {
		// sf#557 restores the band that sf#457 retired: it IS
		// the Forgejo CI/CD runner fleet. Members are STARTED and STOPPED by the
		// scaling pass, never handed out as ephemeral pool slots, so `allocatable` is
		// false for every one of them.
		expect(lookupBox(9101)).toEqual({
			vmid: 9101,
			band: "forge",
			mac: "BC:24:11:91:00:01",
			ip: "10.0.21.101",
			allocatable: false,
		});
		expect(lookupBox(9150)).toEqual({
			vmid: 9150,
			band: "forge",
			mac: "BC:24:11:91:00:50",
			ip: "10.0.21.150",
			allocatable: false,
		});
		expect(RUNNER_BOXES.filter((box) => box.band === "forge")).toHaveLength(50);
	});

	test("9001 and 9101 stay distinct in BOTH the MAC and the IP", () => {
		// Belt and braces by design: `vmid % 100` gives both NN=01, so the MAC's 4th
		// octet (`90` vs `91`) and the forge band's +100 IP offset each disambiguate
		// on their own. A misread in one field is caught by the other.
		const pool = lookupBox(9001) as RunnerBoxSpec;
		const forge = lookupBox(9101) as RunnerBoxSpec;
		expect(pool.mac).not.toBe(forge.mac);
		expect(pool.ip).not.toBe(forge.ip);
	});

	test("no MAC or IP collides across the whole inventory", () => {
		// A collision here is the outage the unique indexes exist to make impossible.
		const macs = new Set<string>();
		const ips = new Set<string>();
		for (const box of RUNNER_BOXES) {
			expect(macs.has(box.mac)).toBe(false);
			macs.add(box.mac);
			if (box.ip !== null) {
				expect(ips.has(box.ip)).toBe(false);
				ips.add(box.ip);
			}
		}
		expect(macs.size).toBe(RUNNER_BOXES.length);
	});

	test("templates are PRESENT and flagged, never merely absent", () => {
		// "9900 is a template" is a better answer than "9900 is unknown": the first is
		// the guard working, the second means a box may be stranded. Keeping template
		// rows is what lets the two be told apart.
		const base = lookupBox(9900);
		expect(base).toBeDefined();
		expect(base?.band).toBe("template");
		expect(base?.allocatable).toBe(false);
		expect(base?.ip).toBeNull();
		// The per-host staged copies are templates too, not pool boxes.
		expect(lookupBox(9901)?.band).toBe("template");
		expect(lookupBox(9902)?.band).toBe("template");
	});

	test("an unknown vmid is undefined, which is NOT the same as not-allocatable", () => {
		// The distinction #78 turns on. Both are "do not treat as a box", but only one
		// means a container may be running that nothing can name.
		expect(lookupBox(4242)).toBeUndefined();
		expect(lookupBox(12345)).toBeUndefined();
		expect(lookupBox(9900)).toBeDefined(); // known, just not allocatable

		// THE FOOTGUN: the retired old-scheme pool (9901-9925) now falls INSIDE the
		// template band, so those ids are known-but-not-allocatable rather than
		// unknown. A spawn into "pool slot 9921" would collide with a golden image.
		expect(lookupBox(9921)?.band).toBe("template");
		expect(isAllocatableVmid(9921)).toBe(false);
		expect(isAllocatableVmid(4242)).toBe(false);
		expect(isAllocatableVmid(9900)).toBe(false);
	});

	test("rejects non-integers rather than coercing them", () => {
		expect(lookupBox(Number.NaN)).toBeUndefined();
		expect(lookupBox(9001.5)).toBeUndefined();
		expect(isAllocatableVmid(Number.POSITIVE_INFINITY)).toBe(false);
	});

	test("band edges are allocatable and one past each edge is unknown", () => {
		for (const vmid of [9001, 9050]) {
			expect(isAllocatableVmid(vmid)).toBe(true);
		}
		// One past a ceiling is genuinely absent, not silently admitted.
		for (const vmid of [9051, 9100, 9151]) {
			expect(lookupBox(vmid)).toBeUndefined();
		}
	});

	test("no band exceeds the 99 ceiling", () => {
		// The ceiling is what keeps each band inside its own hundred-block, which is
		// what makes the MAC/IP schemes unambiguous. Widening past it is the dangerous
		// change, so it is asserted rather than assumed.
		const counts = new Map<string, number>();
		for (const box of RUNNER_BOXES) {
			counts.set(box.band, (counts.get(box.band) ?? 0) + 1);
		}
		for (const [band, count] of counts) {
			expect(count, `band ${band}`).toBeLessThanOrEqual(BAND_CEILING);
		}
	});

	test("every allocatable box has an address; every template has none", () => {
		for (const box of RUNNER_BOXES) {
			if (box.allocatable) {
				expect(box.ip, `vmid ${box.vmid}`).not.toBeNull();
			}
			if (box.band === "template") {
				expect(box.ip, `vmid ${box.vmid}`).toBeNull();
			}
		}
	});
});
