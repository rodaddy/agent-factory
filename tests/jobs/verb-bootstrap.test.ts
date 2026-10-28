/**
 * @module tests/jobs/verb-bootstrap
 * @description Tests for the sf#306 verb staging seam: the full rendered verb
 *   body is LANDED as the job-scoped `job.md` on the share and only a tiny
 *   executable bootstrap travels inline through `runner_run`.
 *
 *   THE FIXTURE IS A REAL RENDERED BODY. `tests/fixtures/verb/
 *   rendered-verb-body-r4.sh` is the run-4 body of the first citizenship run
 *   — the one mcp2cli refused inline twice, after allocating a
 *   box each time. Testing the fix against a synthetic oversized string would
 *   prove only that the code handles a string of that length; this proves it
 *   handles THE string.
 *
 *   It is REGENERATED, not frozen: sf#309 drove the real `renderVerbScriptBody`
 *   with the run-4 manifest (`rails-manifest-r4.yml`) and the run's own pinned
 *   inputs, so the fixture tracks what the renderer emits TODAY rather than
 *   decaying into a historical string no code path can still produce. That is
 *   why it is 29,098 bytes here and 28,191 at run 4 — sf#309 turned the ignored
 *   `-c safe.directory` flags into two global-config lines, and sf#311 swapped
 *   both `cp -a` for `cp -R` and made the compile call an explicit `bash`
 *   invocation; sf#596 regenerated it again (30,719 bytes), which also folded in
 *   the sf#579 failsafe trap that had landed in the renderer without a
 *   regeneration — the fixture had been stale for six days while this test was
 *   green, which is exactly the decay the procedure below exists to prevent.
 *   invocation. Hand-editing it is how a fixture goes stale while every test
 *   stays green.
 *
 *   TO REGENERATE (the exact procedure, all inputs recoverable from the
 *   fixture's own header block):
 *     `renderVerbScriptBody({ verb: "newapp",
 *      repository: "rtech/rtech-infra", itemNumber: 795, app: "hello",
 *      manifest: { content: <rails-manifest-r4.yml verbatim>,
 *                  sha256: "0605d25a…f0f7" },
 *      k3sBaseSha: "9c1e951a53008664a85656cd47c5dbe4ea2a6c1c",
 *      enginePath: "/mnt/share/checkouts/rtech-infra",
 *      k3sCheckoutPath: "/mnt/share/checkouts/k3s-deploy" })`
 *   THE TRAILING-NEWLINE CONVENTION: the renderer's last section already ends
 *   in an empty element, so the returned string ends `}"\n`. The fixture FILE is
 *   that string plus ONE MORE newline — it ends `}"\n\n` and is one byte longer
 *   than the render. Verified by reproduction at sf#311: writing the render
 *   unchanged reproduced the sf#309 fixture minus exactly its final blank line.
 *   Then re-pin the digest and BOTH counts asserted below; the regeneration diff
 *   must contain only the rendered lines the change touched, and that diff is
 *   the provenance proof.
 *
 *   The landing runs for real against a throwaway collab root under the repo's
 *   own temp workspace (never `/tmp`, which is sandbox-local and invisible across
 *   runner/host boundaries), so the atomic write and the byte-identity claim are
 *   exercised rather than stubbed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { prepareVerbDispatch, renderVerbBootstrapScript } from "../../src/jobs/verb-bootstrap";
import { RUNNER_JOB_TRANSPORT_CAP } from "../../src/prepush/body-constants";
import { type BodyLandingStager, LocalBodyLandingStager } from "../../src/prepush/stage";
import { testArchiveDir, testTmpBase } from "../support/test-temp";

const JOB_ID = "rw-newapp-306stagingtest";
const FIXTURE = join(import.meta.dir, "..", "fixtures", "verb", "rendered-verb-body-r4.sh");

/** The exact bytes the live run rendered — read from disk, never reconstructed. */
async function realRenderedBody(): Promise<string> {
	return await readFile(FIXTURE, "utf8");
}

describe("verb dispatch staging", () => {
	let collabRoot: string;

	beforeEach(async () => {
		const scratch = join(testTmpBase(), "_scratch");
		await mkdir(scratch, { recursive: true });
		collabRoot = await mkdtemp(join(scratch, "verb-collab-"));
	});
	afterEach(async () => {
		// AGENTS.md: an agent never runs a recursive/forced delete. The throwaway
		// collab root is MOVED into the repo's `_archive/` bucket instead.
		//
		// The destination name uses `mkdtemp`, NOT a timestamp. These tests each run
		// in well under a millisecond, so `Date.now()` collides between two teardowns
		// and the second `rename` lands on an existing NON-EMPTY directory — which is
		// `ENOTEMPTY`, not an overwrite. That produced a ~1-in-5 flake attributed to
		// whichever test happened to run second.
		const destination = await mkdtemp(join(testArchiveDir(), "verb-collab-"));
		await rename(collabRoot, join(destination, "collab"));
	});

	test("the real 28k run-4 body is refused inline and is what this fixture carries", async () => {
		const body = await realRenderedBody();

		// C-fixture-identity: this is THE body the live run shape produces, not a
		// stand-in — REGENERATED from the real `renderVerbScriptBody` at sf#309 and
		// never hand-edited, which is how a fixture goes stale silently. The digest
		// is over the raw file bytes.
		expect(createHash("sha256").update(body, "utf8").digest("hex")).toBe(
			"b2f0180df211b2ba1e50278c8017e0ecc105151a7b3638febd12d69bb4e49706",
		);
		// BYTES vs CHARS, and the difference is real: the body is 29,098 bytes on disk
		// but 29,020 UTF-8 characters, because its prose carries multi-byte em-dashes.
		// The mcp2cli cap governs the JSON STRING length, so the char count is the one
		// that decides the refusal — and both are pinned here so neither number can
		// drift unnoticed. (Run 4 landed at 28,191/28,115; sf#309 replaced the ignored
		// `-c safe.directory` flags with two global-config lines for 28,237/28,161;
		// sf#311 swapped both `cp -a` for `cp -R` and made the compile call an explicit
		// `bash` invocation, adding the comments that explain why. It only ever grew,
		// which keeps the cap assertion below honest.)
		expect(Buffer.byteLength(body, "utf8")).toBe(30_780);
		expect(body.length).toBe(30_702);
		// And it is decisively over the transport cap the staging exists to respect.
		expect(body.length).toBeGreaterThan(RUNNER_JOB_TRANSPORT_CAP);
	});

	test("lands the full body and submits a bootstrap UNDER the transport cap", async () => {
		const body = await realRenderedBody();
		const stager = new LocalBodyLandingStager(collabRoot);

		const prepared = await prepareVerbDispatch({ stager, runnerJobId: JOB_ID, body });
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;

		// THE CLAIM sf#306 OWNS: what travels inline is under the cap the live run hit.
		// Compared against the CONSTANT, never a re-declared literal, so a future cap
		// change moves this assertion with it.
		expect(prepared.bootstrap.length).toBeLessThan(RUNNER_JOB_TRANSPORT_CAP);

		// The full contract reached the share at the shared job-scoped path.
		const landedPath = join(collabRoot, "runners", "jobs", JOB_ID, "input", "job.md");
		const landed = await readFile(landedPath, "utf8");
		expect(landed).toBe(body);

		// The bootstrap names that exact runner-side path and nothing caller-shaped.
		expect(prepared.bootstrap).toContain(`/mnt/share/runners/jobs/${JOB_ID}/input/job.md`);
	});

	test("the staged job.md is BYTE-IDENTICAL to the rendered body", async () => {
		const body = await realRenderedBody();
		const stager = new LocalBodyLandingStager(collabRoot);

		const prepared = await prepareVerbDispatch({ stager, runnerJobId: JOB_ID, body });
		expect(prepared.ok).toBe(true);

		const landedPath = join(collabRoot, "runners", "jobs", JOB_ID, "input", "job.md");
		const landedBytes = await readFile(landedPath);

		// Byte-for-byte, not "contains" and not a normalized string compare: the
		// bootstrap's digest guard refuses the file on a single differing byte, so an
		// off-by-one trailing newline here would fail closed on every live dispatch.
		expect(new Uint8Array(landedBytes)).toEqual(new Uint8Array(Buffer.from(body, "utf8")));

		// No transient temp file survives the atomic write.
		const inputDir = join(collabRoot, "runners", "jobs", JOB_ID, "input");
		expect(await readdir(inputDir)).toEqual(["job.md"]);
	});

	test("the bootstrap digest binds the EXACT landed bytes", async () => {
		const body = await realRenderedBody();
		const stager = new LocalBodyLandingStager(collabRoot);

		const prepared = await prepareVerbDispatch({ stager, runnerJobId: JOB_ID, body });
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;

		const landedPath = join(collabRoot, "runners", "jobs", JOB_ID, "input", "job.md");
		const landedDigest = createHash("sha256")
			.update(await readFile(landedPath))
			.digest("hex");

		// The digest the box will recompute must be the digest of what is on disk. A
		// bootstrap bound to anything else fails closed on every dispatch — the exact
		// shape of the sf#301 manifest-digest defect, one layer out.
		expect(prepared.bootstrap).toContain(`expected_sha256=${landedDigest}`);
	});

	test("the bootstrap is EXECUTABLE bash, not agent prose", async () => {
		const body = await realRenderedBody();
		const stager = new LocalBodyLandingStager(collabRoot);

		const prepared = await prepareVerbDispatch({ stager, runnerJobId: JOB_ID, body });
		expect(prepared.ok).toBe(true);
		if (!prepared.ok) return;

		// The wrapper EXECS a script-runtime body (`script) /bin/bash /work/job/job.md`,
		// rtech-infra scripts/runner-job:250). A prose bootstrap would die on its first
		// English line under `set -e` — the sf#301 defect, reintroduced at the bootstrap.
		expect(prepared.bootstrap.startsWith("#!/usr/bin/env bash\n")).toBe(true);
		expect(prepared.bootstrap).toContain("set -euo pipefail");
		expect(prepared.bootstrap).toContain('exec /bin/bash "$staged_job"');

		// And it PARSES: written to the share, checked with the real tool.
		const scriptPath = join(collabRoot, "bootstrap.sh");
		await Bun.write(scriptPath, prepared.bootstrap);
		const parsed = Bun.spawnSync(["bash", "-n", scriptPath]);
		expect(parsed.exitCode).toBe(0);
	});

	test("a landing fault fails closed and returns no bootstrap", async () => {
		const body = await realRenderedBody();
		const throwing: BodyLandingStager = {
			land: async () => {
				throw new Error("share unreachable");
			},
		};

		expect(await prepareVerbDispatch({ stager: throwing, runnerJobId: JOB_ID, body })).toEqual({
			ok: false,
			reason: "share unreachable",
		});
	});

	test("an unsafe job id yields no bootstrap and lands nothing", async () => {
		const body = await realRenderedBody();
		let landed = 0;
		const counting: BodyLandingStager = {
			land: async () => {
				landed++;
				return { jobBodyPath: "/x", runnerJobBodyPath: "/x" };
			},
		};

		const prepared = await prepareVerbDispatch({
			stager: counting,
			runnerJobId: "../escape",
			body,
		});
		expect(prepared).toEqual({
			ok: false,
			reason: "verb bootstrap could not be bound to the landed body",
		});
		// The refusal happens BEFORE the landing, so a traversing id never reaches the
		// filesystem at all.
		expect(landed).toBe(0);
	});

	test("renderVerbBootstrapScript refuses a non-SHA-256 digest", () => {
		expect(renderVerbBootstrapScript(JOB_ID, "not-a-digest")).toBeNull();
		expect(renderVerbBootstrapScript(JOB_ID, "A".repeat(64))).toBeNull();
		expect(renderVerbBootstrapScript(JOB_ID, "a".repeat(64))).not.toBeNull();
	});
});
