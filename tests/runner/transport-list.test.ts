/**
 * `runner_list` table parsing.
 *
 * THE FIXTURE IS REAL. `LIVE_ENVELOPE` below is the verbatim stdout of one
 * read-only `mcp2cli runner-boxes runner_list --params '{}'` captured
 * 2026-08-17, not a hand-written approximation. That matters because the shape
 * this parser must survive is not obvious from the verb's docstring: every line
 * carries a `[hostname] ` prefix (added by the verb's own trailing `sed`),
 * including the per-host HEADER line, and the header repeats once per placement
 * host rather than appearing once at the top.
 */
import { describe, expect, test } from "bun:test";
import { parseForgeSlots, parseListedBoxes } from "../../src/runner/transport-boxes";

/** Verbatim capture, 2026-08-17, read-only `runner_list`. Two hosts, both unstamped. */
const LIVE_ENVELOPE = `{"success":true,"result":{"ok":true,"exit_code":0,"stdout":"[node05] VMID       Status     Lock         Name                 JOB_ID                                       SPAWN_ISO\\n[node05] 9002       stopped    destroyed    runner-16               -                                            -\\n[node06] VMID       Status     Lock         Name                 JOB_ID                                       SPAWN_ISO\\n[node06] 9004       stopped    destroyed    runner-24               -                                            -\\n","stderr":"","cmd":"/opt/dev/rtech-infra/scripts/runner-boxes list"}}`;

describe("parseListedBoxes — the real captured fixture", () => {
	test("parses both hosts' rows out of the live envelope", () => {
		const boxes = parseListedBoxes(LIVE_ENVELOPE);
		expect(boxes.map((b) => b.vmid)).toEqual([9002, 9004]);
	});

	test('maps the "-" stamp columns to null, never the literal dash', () => {
		const boxes = parseListedBoxes(LIVE_ENVELOPE);
		for (const box of boxes) {
			expect(box.jobId).toBeNull();
			expect(box.spawnIso).toBeNull();
		}
	});

	test("carries status and name off the fixed-width row", () => {
		const [first] = parseListedBoxes(LIVE_ENVELOPE);
		expect(first?.status).toBe("stopped");
		expect(first?.name).toBe("runner-16");
	});

	test("skips the per-host header line that repeats for every host", () => {
		// Two hosts means TWO header lines, both prefixed. A parser that only
		// skipped a single leading header would surface a bogus "VMID" row.
		expect(parseListedBoxes(LIVE_ENVELOPE)).toHaveLength(2);
	});
});

describe("parseListedBoxes — stamped and empty-Lock rows", () => {
	/**
	 * The EMPTY LOCK case, which the verb's own awk warns about in a comment:
	 * `pct list` is fixed-width and Lock is frequently blank, so positional
	 * left-to-right splitting shifts Name into Lock's slot on every unlocked box.
	 * Right-anchoring the two appended stamp columns is what survives it.
	 */
	const stamped = envelope(
		[
			"[node05] VMID       Status     Lock         Name                 JOB_ID                                       SPAWN_ISO",
			"[node05] 9007       running                 runner-25               rw-pr-review-abc123                          2026-08-17T04:10:00Z",
			"[node05] 9008       running    backup       runner-26               rw-triage-def456                             2026-08-17T04:12:00Z",
		].join("\\n"),
	);

	test("reads the job id and spawn stamp off an UNLOCKED row (empty Lock column)", () => {
		const boxes = parseListedBoxes(stamped);
		const box = boxes.find((b) => b.vmid === 9007);
		expect(box?.jobId).toBe("rw-pr-review-abc123");
		expect(box?.spawnIso).toBe("2026-08-17T04:10:00Z");
		// The empty-Lock shift defect surfaces here first: a left-positional parser
		// reads Name out of the Lock slot and returns "rw-pr-review-abc123".
		expect(box?.name).toBe("runner-25");
	});

	test("reads a LOCKED row's columns without shifting", () => {
		const box = parseListedBoxes(stamped).find((b) => b.vmid === 9008);
		expect(box?.jobId).toBe("rw-triage-def456");
		expect(box?.name).toBe("runner-26");
		expect(box?.status).toBe("running");
	});
});

describe("parseListedBoxes — envelope and input tolerance", () => {
	test("parses a BARE (non-enveloped) table string", () => {
		const bare =
			"[node05] VMID       Status     Lock         Name                 JOB_ID                                       SPAWN_ISO\n[node05] 9009       running                 runner-27               rw-x-1                                       2026-08-17T05:00:00Z";
		const [box] = parseListedBoxes(bare);
		expect(box?.vmid).toBe(9009);
		expect(box?.jobId).toBe("rw-x-1");
	});

	test("returns [] on empty stdout", () => {
		expect(parseListedBoxes("")).toEqual([]);
		expect(parseListedBoxes("   \n  ")).toEqual([]);
	});

	test("returns [] on a FAILED envelope rather than mining it for numbers", () => {
		expect(parseListedBoxes('{"success":false,"result":{"ok":false,"stdout":"9001 x"}}')).toEqual(
			[],
		);
	});
});

describe("parseListedBoxes — the #78 inventory guard SURFACES rather than drops", () => {
	/**
	 * The deliberate INVERSION of `parseBoxes`, and the whole point of the verb.
	 * On the ALLOCATION path an unknown vmid must never be surfaced as a usable
	 * box. On the RECONCILE path an unknown vmid is precisely what the operator
	 * needs named — dropping it reproduces the unattributable-box harm #78 exists
	 * to end, from the surfacing side.
	 */
	const withUnknown = envelope(
		[
			"[node05] VMID       Status     Lock         Name                 JOB_ID                                       SPAWN_ISO",
			"[node05] 9002       running                 runner-16               rw-known-1                                   2026-08-17T04:00:00Z",
			"[node05] 9900       running                 runner-28               rw-unknown-1                                 2026-08-17T04:01:00Z",
		].join("\\n"),
	);

	test("RETURNS a vmid the inventory does not mark allocatable", () => {
		const boxes = parseListedBoxes(withUnknown);
		expect(boxes.map((b) => b.vmid)).toEqual([9002, 9900]);
	});

	test("keeps the unknown box's job id, which is what names it for reaping", () => {
		const box = parseListedBoxes(withUnknown).find((b) => b.vmid === 9900);
		expect(box?.jobId).toBe("rw-unknown-1");
	});
});

/** Wrap an already-escaped inner stdout in the mcp2cli success envelope. */
function envelope(innerStdout: string): string {
	return `{"success":true,"result":{"ok":true,"exit_code":0,"stdout":"${innerStdout}\\n","stderr":""}}`;
}

const SLOT_SAMPLE = [
	"[node05] VMID       Status     Lock         Name                 JOB_ID                                       SPAWN_ISO",
	"[node05] 9102       running                 runner-21               -                                            -",
	"[slot] vmid=9106 status=absent lane=general",
	"[slot] vmid=9102 node=node02 status=running lane=general",
	"[slot] vmid=9103 node=- status=unknown lane=general",
	"",
].join("\n");
const SLOT_BOXES = [
	{ vmid: 9106, status: "absent", name: "CT9106", jobId: null, spawnIso: null },
	{ vmid: 9102, status: "running", name: "CT9102", jobId: null, spawnIso: null },
	{ vmid: 9103, status: "unknown", name: "CT9103", jobId: null, spawnIso: null },
];

describe("parseForgeSlots", () => {
	test("reads only the [slot] lines out of the mixed output", () => {
		expect(parseForgeSlots(SLOT_SAMPLE)).toEqual(SLOT_BOXES);
	});

	test("unwraps a successful envelope", () => {
		const env = JSON.stringify({
			success: true,
			result: { ok: true, exit_code: 0, stdout: SLOT_SAMPLE },
		});
		expect(parseForgeSlots(env)).toEqual(SLOT_BOXES);
	});

	test("a failed envelope yields no rows", () => {
		const env = JSON.stringify({
			success: true,
			result: { ok: false, exit_code: 1, stdout: SLOT_SAMPLE },
		});
		expect(parseForgeSlots(env)).toEqual([]);
	});

	test("no [slot] lines yields no rows", () => {
		expect(parseForgeSlots(LIVE_ENVELOPE)).toEqual([]);
	});

	test("reads oom_tasks ids; an empty or absent token adds nothing", () => {
		const text = [
			"[slot] vmid=9109 node=node02 status=running lane=gate oom_tasks=19234,19240",
			"[slot] vmid=9110 node=node03 status=running lane=gate oom_tasks=",
			"[slot] vmid=9111 status=absent lane=large",
		].join("\n");
		expect(parseForgeSlots(text)).toEqual([
			{
				vmid: 9109,
				status: "running",
				name: "CT9109",
				jobId: null,
				spawnIso: null,
				oomTasks: [19234, 19240],
			},
			{ vmid: 9110, status: "running", name: "CT9110", jobId: null, spawnIso: null },
			{ vmid: 9111, status: "absent", name: "CT9111", jobId: null, spawnIso: null },
		]);
	});
});
