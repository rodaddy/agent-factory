/**
 * @module tests/infra/dispatch
 * @description Tests for the dedicated infra-static exact-SHA dispatch helper.
 *  They prove the concrete contract is rendered, LANDED as the
 *   digest-bound job.md, and the returned bootstrap binds that exact landed file;
 *   and that every fault (null body, landing throw) fails closed without landing
 *   or returning a bootstrap. The real landing path is exercised over a throwaway
 *   mkdtemp collab root so the test is hermetic and does NOT depend on the ambient
 *   git checkout or cwd (an on-box runner previously caught ambient-dependent
 *   tests). The helper itself runs NO git in-process — the exact commit is fetched
 *   inside the landed contract — so no fixture repo is needed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareInfraStaticDispatch } from "../../src/infra/dispatch";
import { type GateSelection, STATIC_GATES } from "../../src/infra/gates";
import { type BodyLandingStager, LocalBodyLandingStager } from "../../src/prepush/stage";

const REPO = "rtech/rtech-infra";
const SHA = "d".repeat(40);
const JOB_ID = "rw-infra-static-dispatchtest";

function full(): GateSelection {
	return { gates: [...STATIC_GATES], fullEscalation: true, reason: "full" };
}
function narrow(gates: GateSelection["gates"]): GateSelection {
	return { gates, fullEscalation: false, reason: "narrow" };
}

describe("prepareInfraStaticDispatch — lands the concrete exact-SHA contract", () => {
	let collabRoot: string;

	beforeEach(async () => {
		collabRoot = await mkdtemp(join(tmpdir(), "rw-infra-collab-"));
	});
	afterEach(async () => {
		await rm(collabRoot, { recursive: true, force: true });
	});

	test("lands the concrete contract and returns a bootstrap digest-bound to it", async () => {
		const stager = new LocalBodyLandingStager(collabRoot);
		const prepared = await prepareInfraStaticDispatch({
			stager,
			repository: REPO,
			provider: "github",
			sha: SHA,
			runnerJobId: JOB_ID,
			selection: full(),
			itemNumber: 914,
		});
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;

		// The landed job.md carries the FULL concrete contract (fixed launcher, fixed
		// per-gate commands, the fixed depth-1 fetch of the exact SHA).
		const landedPath = join(collabRoot, "runners", "jobs", JOB_ID, "input", "job.md");
		const landed = await readFile(landedPath, "utf8");
		expect(landed).toContain("sudo bwrap");
		expect(landed).toContain("shellcheck");
		expect(landed).toContain(`https://github.com/${REPO}.git ${SHA}`);
		// The dispatched item reaches the result spec, so the landed contract tells
		// the runner to claim the identity the read boundary expects.
		expect(landed).toContain("- `item_number`: 914");

		// The bootstrap binds the EXACT landed bytes: it embeds the SHA-256 of job.md
		// and points at the same job's runner-side path.
		const digest = createHash("sha256").update(landed, "utf8").digest("hex");
		expect(prepared.bootstrap).toContain(digest);
		expect(prepared.bootstrap).toContain(`/mnt/share/runners/jobs/${JOB_ID}/input/job.md`);
	});

	test("a narrow selection lands ONLY the selected gate command", async () => {
		const stager = new LocalBodyLandingStager(collabRoot);
		const prepared = await prepareInfraStaticDispatch({
			stager: stager,
			repository: REPO,
			provider: "github",
			sha: SHA,
			runnerJobId: JOB_ID,
			selection: narrow(["scripts"]),
		});
		expect(prepared.ok).toBe(true);
		const landed = await readFile(
			join(collabRoot, "runners", "jobs", JOB_ID, "input", "job.md"),
			"utf8",
		);
		expect(landed).toContain("shellcheck");
		// The unselected gate's COMMAND, not the bare tool name: since sf#592 the
		// fixed setup writes the pinned `/work/lintrc/ansible-lint.yml` config for
		// every selection (author-owned text, not a gate command), so a bare
		// substring would match that filename and stop testing what it names.
		expect(landed).not.toContain("ansible-lint -f pep8");
		expect(landed).not.toContain("actionlint");
	});

	test("lands the Forgejo-managed target with the fixed Forgejo clone base", async () => {
		const stager = new LocalBodyLandingStager(collabRoot);
		const prepared = await prepareInfraStaticDispatch({
			stager,
			repository: REPO,
			provider: "forgejo",
			sha: SHA,
			runnerJobId: JOB_ID,
			selection: full(),
		});
		expect(prepared.ok).toBe(true);
		const landed = await readFile(
			join(collabRoot, "runners", "jobs", JOB_ID, "input", "job.md"),
			"utf8",
		);
		expect(landed).toContain(`https://forge.example.internal/${REPO}.git ${SHA}`);
	});
});

describe("prepareInfraStaticDispatch — fails closed", () => {
	/** A stager that records how many times it was asked to land. */
	function spyStager(): { stager: BodyLandingStager; landed: () => number } {
		let count = 0;
		return {
			landed: () => count,
			stager: {
				land: async (jobId: string) => {
					count++;
					return {
						jobBodyPath: `/collab/${jobId}/job.md`,
						runnerJobBodyPath: `/mnt/share/${jobId}/job.md`,
					};
				},
			},
		};
	}

	test("an empty gate selection renders null and never lands or dispatches", async () => {
		const spy = spyStager();
		const prepared = await prepareInfraStaticDispatch({
			stager: spy.stager,
			repository: REPO,
			provider: "github",
			sha: SHA,
			runnerJobId: JOB_ID,
			selection: narrow([]),
		});
		expect(prepared.ok).toBe(false);
		expect(spy.landed()).toBe(0);
	});

	test("an unsafe job id renders null and never lands", async () => {
		const spy = spyStager();
		const prepared = await prepareInfraStaticDispatch({
			stager: spy.stager,
			repository: REPO,
			provider: "github",
			sha: SHA,
			runnerJobId: "../escape",
			selection: full(),
		});
		expect(prepared.ok).toBe(false);
		expect(spy.landed()).toBe(0);
	});

	test("a non-owner/repo repository renders null and never lands", async () => {
		const spy = spyStager();
		const prepared = await prepareInfraStaticDispatch({
			stager: spy.stager,
			repository: "not-a-repo",
			provider: "github",
			sha: SHA,
			runnerJobId: JOB_ID,
			selection: full(),
		});
		expect(prepared.ok).toBe(false);
		expect(spy.landed()).toBe(0);
	});

	test("a landing throw fails closed with a bounded reason", async () => {
		const stager: BodyLandingStager = {
			land: async () => {
				throw new Error("collab share unavailable");
			},
		};
		const prepared = await prepareInfraStaticDispatch({
			stager,
			repository: REPO,
			provider: "github",
			sha: SHA,
			runnerJobId: JOB_ID,
			selection: full(),
		});
		expect(prepared.ok).toBe(false);
		if (prepared.ok) return;
		expect(prepared.reason).toContain("collab share unavailable");
	});
});
