/**
 * sf#179 seam 3 — VERIFY BEFORE KILL.
 *
 * `reap()` already proves DB ownership through the claim-scoped release. This
 * adds a fleet-side identity check on top of it: if `runner_list` says the box
 * is stamped with a DIFFERENT job id than the holder we are reaping for, the
 * box belongs to someone else and must not be powered off.
 *
 * THE DEGRADATION DIRECTION IS THE POINT, and it is deliberately asymmetric:
 *
 *  - A PROVEN MISMATCH fails CLOSED — skip the power-off.
 *  - Every ambiguous answer (box unstamped, box absent from the list, the list
 *    call itself throwing) fails OPEN — proceed on the DB-claim proof that was
 *    already sufficient before this seam existed.
 *
 * Failing closed on ambiguity would mean a fleet-read outage makes every reap
 * impossible, and an unreapable pool is 25 VMIDs wide. The identity check is
 * defence in depth on an already-proven claim, never a second gate that can
 * veto it.
 */
import { describe, expect, test } from "bun:test";
import { claimRunnerBox, seedRunnerBoxes } from "../../src/db/repos";
import { reap } from "../../src/runner/dispatch";
import type {
	ListedBox,
	RunnerAllocation,
	RunnerRunParams,
	RunnerTransport,
} from "../../src/runner/transport";
import { withTestDb } from "../db/helpers";

const HOLDER = "rw-pr-review-ours";
const VMID = 9001;

/**
 * A transport whose `list` is scripted and whose `done` calls are RECORDED.
 *
 * `done` recording is the load-bearing assertion for this seam: the outcome
 * string alone cannot distinguish "skipped the power-off" from "powered it off
 * and then said skipped", and it is the power-off that kills live work.
 */
function verifyTransport(list: () => Promise<ListedBox[]>): RunnerTransport & {
	doneVmids: number[];
	doneCalls: Array<{ vmid: number; jobId: string | undefined }>;
	listCalls: number;
} {
	const doneVmids: number[] = [];
	const doneCalls: Array<{ vmid: number; jobId: string | undefined }> = [];
	const self = {
		startBandMember: async () => {
			throw new Error("not implemented");
		},
		stopBandMember: async () => {
			throw new Error("not implemented");
		},
		listBand: async (): Promise<ListedBox[]> => {
			throw new Error("not implemented");
		},
		doneVmids,
		doneCalls,
		listCalls: 0,
		needed: async (): Promise<RunnerAllocation> => ({ ok: false, refused: true, reason: "n/a" }),
		run: async (_p: RunnerRunParams) => {},
		done: async (vmid: number, jobId?: string) => {
			doneVmids.push(vmid);
			doneCalls.push({ vmid, jobId });
		},
		list: async () => {
			self.listCalls += 1;
			return await list();
		},
	};
	return self;
}

/** One listed box, defaulting to the vmid under test. */
function listed(overrides: Partial<ListedBox> = {}): ListedBox {
	return {
		vmid: VMID,
		status: "running",
		name: `CT${VMID}`,
		jobId: null,
		spawnIso: null,
		...overrides,
	};
}

describe("reap — a PROVEN identity mismatch fails closed", () => {
	test("returns skipped-identity-mismatch and NEVER calls done()", async () => {
		await withTestDb(async (db) => {
			await seedRunnerBoxes(db);
			// The DB claim is genuinely ours, so the pre-existing ownership proof
			// PASSES. Only the fleet stamp disagrees — which is precisely the case
			// this seam exists to catch.
			expect(await claimRunnerBox(db, VMID, HOLDER)).toBe(true);
			const transport = verifyTransport(async () => [
				listed({ jobId: "rw-someone-elses-job", spawnIso: "2026-08-17T04:00:00Z" }),
			]);

			const outcome = await reap(db, transport, VMID, HOLDER);

			expect(outcome).toBe("skipped-identity-mismatch");
			// THE assertion. A box powered off here is another job's work killed.
			expect(transport.doneVmids).toEqual([]);
		});
	});
});

describe("reap — ambiguity fails OPEN on the already-proven DB claim", () => {
	test("an UNSTAMPED box (jobId null) still reaps", async () => {
		await withTestDb(async (db) => {
			await seedRunnerBoxes(db);
			expect(await claimRunnerBox(db, VMID, HOLDER)).toBe(true);
			const transport = verifyTransport(async () => [listed({ jobId: null })]);

			expect(await reap(db, transport, VMID, HOLDER)).toBe("reaped");
			expect(transport.doneVmids).toEqual([VMID]);
		});
	});

	test("a vmid ABSENT from the list still reaps", async () => {
		await withTestDb(async (db) => {
			await seedRunnerBoxes(db);
			expect(await claimRunnerBox(db, VMID, HOLDER)).toBe(true);
			const transport = verifyTransport(async () => [
				listed({ vmid: 9002, jobId: "rw-other", name: "runner-16" }),
			]);

			expect(await reap(db, transport, VMID, HOLDER)).toBe("reaped");
			expect(transport.doneVmids).toEqual([VMID]);
		});
	});

	test("list() THROWING still reaps — a fleet-read outage cannot block every reap", async () => {
		await withTestDb(async (db) => {
			await seedRunnerBoxes(db);
			expect(await claimRunnerBox(db, VMID, HOLDER)).toBe(true);
			const transport = verifyTransport(async () => {
				throw new Error("CONNECTION_ERROR: failed to communicate with local daemon");
			});

			expect(await reap(db, transport, VMID, HOLDER)).toBe("reaped");
			expect(transport.doneVmids).toEqual([VMID]);
		});
	});

	test("a MATCHING stamp reaps, and the box is powered off", async () => {
		await withTestDb(async (db) => {
			await seedRunnerBoxes(db);
			expect(await claimRunnerBox(db, VMID, HOLDER)).toBe(true);
			const transport = verifyTransport(async () => [listed({ jobId: HOLDER })]);

			expect(await reap(db, transport, VMID, HOLDER)).toBe("reaped");
			expect(transport.doneVmids).toEqual([VMID]);
			expect(transport.doneCalls).toEqual([{ vmid: VMID, jobId: HOLDER }]);
		});
	});
});

describe("reap — the verify runs only where it can mean something", () => {
	test("an UNSCOPED reap (no expectedHolder) does not consult the list", async () => {
		await withTestDb(async (db) => {
			await seedRunnerBoxes(db);
			// The surplus/partial-allocation callers pass no holder: there is no claim
			// to race and no identity to compare against, so a list read here would
			// buy nothing and cost a fleet round trip on every reap.
			const transport = verifyTransport(async () => [listed({ jobId: "rw-whoever" })]);

			expect(await reap(db, transport, VMID)).toBe("reaped");
			expect(transport.listCalls).toBe(0);
			expect(transport.doneVmids).toEqual([VMID]);
			expect(transport.doneCalls).toEqual([{ vmid: VMID, jobId: undefined }]);
		});
	});

	test("an UNPROVEN DB claim short-circuits before the list is consulted", async () => {
		await withTestDb(async (db) => {
			await seedRunnerBoxes(db);
			// A newer attempt holds the claim. The pre-existing guard already refuses
			// here, and it must keep refusing on its own terms — the identity check is
			// additive and may never turn a skip into a reap.
			expect(await claimRunnerBox(db, VMID, "rw-newer-attempt")).toBe(true);
			const transport = verifyTransport(async () => [listed({ jobId: HOLDER })]);

			expect(await reap(db, transport, VMID, HOLDER)).toBe("skipped-unproven-ownership");
			expect(transport.doneVmids).toEqual([]);
			expect(transport.listCalls).toBe(0);
		});
	});
});

describe("reap — the verb's ownership refusal is a skip, not an error", () => {
	test("logs once and never retries without the job id", async () => {
		const here = new URL(".", import.meta.url).pathname;
		const snippet = `
import { claimRunnerBox, seedRunnerBoxes } from "${here}../../src/db/repos.ts";
import { reap } from "${here}../../src/runner/dispatch.ts";
import { withTestDb } from "${here}../db/helpers.ts";

await withTestDb(async (db) => {
  const vmid = 9001;
  const ours = "rw-infra-static-OURS";
  await seedRunnerBoxes(db);
  if (!(await claimRunnerBox(db, vmid, ours))) throw new Error("claim failed");
  const doneCalls = [];
  const outcome = await reap(db, {
    needed: async () => ({ ok: false, refused: true, reason: "n/a" }),
    run: async () => {},
    list: async () => [{ vmid, status: "running", name: "runner-18", jobId: ours, spawnIso: null }],
    done: async (doneVmid, jobId) => {
      doneCalls.push({ vmid: doneVmid, jobId });
      return { refused: true, ownerJobId: "rw-infra-static-OTHER" };
    },
  }, vmid, ours);
  process.stdout.write(JSON.stringify({ outcome, doneCalls }));
});
`;
		const proc = Bun.spawn(["bun", "-e", snippet], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, LOG_LEVEL: "", RODADDY_WATCHER_DEBUG: "" },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		expect(exitCode).toBe(0);
		expect(JSON.parse(stdout)).toEqual({
			outcome: "skipped-identity-mismatch",
			doneCalls: [{ vmid: VMID, jobId: "rw-infra-static-OURS" }],
		});
		const refused = stderr
			.split("\n")
			.filter((line) => line.trim().startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>)
			.filter((line) => line.msg === "runner.reap_refused_by_verb");
		expect(refused).toHaveLength(1);
		expect(refused[0]).toMatchObject({
			level: "warn",
			vmid: String(VMID),
			runner_job_id: "rw-infra-static-OURS",
			verb_job_id: "rw-infra-static-OTHER",
		});
	}, 60000);
});
