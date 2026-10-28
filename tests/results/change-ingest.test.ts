/**
 * @module tests/results/change-ingest
 * @description Adversarial tests for the change-ingest trust boundary.
 *   The claim under test comes from a runner box running a coding agent with
 *   permissions bypassed over untrusted repository content, so these are
 *   written as attempted escapes rather than happy-path coverage: traversal,
 *   absolute paths, symlinks, NUL truncation, an unrelated base, and the CI
 *   workflow escalation the whole gate exists to stop.
 */
import { afterAll, describe, expect, test } from "bun:test";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
	type BundleInspector,
	MAX_CHANGED_FILES,
	quarantinePathFor,
	touchesWorkflowPath,
	verifyChangeBundle,
} from "../../src/results/change-ingest";
import { CHANGE_BUNDLE_NAME } from "../../src/templates/agent-lane";
import { testTmpBase } from "../support/test-temp";

const BASE = "cafebabecafebabecafebabecafebabecafebabe";

/** A job output dir containing a real (empty) bundle file. */
function jobDir(): string {
	const dir = mkdtempSync(join(testTmpBase(), "change-ingest-"));
	writeFileSync(join(dir, "change.bundle"), "PACK");
	return dir;
}

/** An inspector that passes every git gate, overridable per test. */
function inspector(overrides: Partial<BundleInspector> = {}): BundleInspector {
	return {
		verify: overrides.verify ?? (async () => true),
		requiredBases: overrides.requiredBases ?? (async () => [BASE]),
		changedPaths: overrides.changedPaths ?? (async () => ["src/index.ts"]),
		isAncestor: overrides.isAncestor ?? (async () => true),
	};
}

/**
 * A watcher-owned snapshot destination: a fresh directory per call, mirroring
 * production in being OUTSIDE the runner-writable job directory. The copy uses
 * `wx`, so the destination must not already exist — a shared counter in the
 * common temp base collides with leftovers from other test files.
 */
function snapshotDest(): string {
	const dir = mkdtempSync(join(testTmpBase(), "snapshot-"));
	snapshotDirs.push(dir);
	return join(dir, "snapshot.bundle");
}
const snapshotDirs: string[] = [];

afterAll(() => {
	for (const dir of snapshotDirs) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Run the boundary with sensible defaults. */
async function verify(
	dir: string,
	bundlePath: string,
	opts: {
		baseSha?: string;
		dispatched?: string;
		inspector?: BundleInspector;
		snapshotPath?: string;
	} = {},
) {
	return verifyChangeBundle({
		change: { base_sha: opts.baseSha ?? BASE, bundle_path: bundlePath },
		jobOutputDir: dir,
		dispatchedBaseSha: opts.dispatched ?? BASE,
		snapshotPath: opts.snapshotPath ?? snapshotDest(),
		inspector: opts.inspector ?? inspector(),
	});
}

describe("confinement", () => {
	test("accepts a bundle inside the job output directory", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle");
			expect(out.status).toBe("ok");
			if (out.status === "ok") {
				expect(out.changedFiles).toEqual(["src/index.ts"]);
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("the filename the implement template PINS is accepted by this gate", async () => {
		// The drift-pin. The template is the only place a runner learns the
		// hand-back contract, and it once asked for a "share-relative path" that
		// confine() could never accept — every compliant patch hand-back was
		// rejected as bundle_path_not_confined. Driving the pinned constant through
		// the REAL boundary (not a regex over prose) is what makes the instruction
		// and the enforced grammar unable to diverge silently again.
		const dir = mkdtempSync(join(testTmpBase(), "change-ingest-pinned-"));
		try {
			writeFileSync(join(dir, CHANGE_BUNDLE_NAME), "PACK");
			const out = await verify(dir, CHANGE_BUNDLE_NAME);
			expect(out.status).toBe("ok");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS traversal out of the job directory", async () => {
		const dir = jobDir();
		try {
			for (const p of ["../evil.bundle", "../../etc/passwd", "a/../../../out.bundle"]) {
				const out = await verify(dir, p);
				expect(out.status).toBe("rejected");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS an absolute path", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "/etc/passwd");
			expect(out.status).toBe("rejected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS a NUL byte, which would truncate the path at the syscall", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle\0../../etc/passwd");
			expect(out.status).toBe("rejected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS a symlink pointing outside the job directory", async () => {
		const dir = jobDir();
		const outside = mkdtempSync(join(testTmpBase(), "outside-"));
		try {
			writeFileSync(join(outside, "secret"), "x".repeat(64));
			symlinkSync(join(outside, "secret"), join(dir, "link.bundle"));
			// lstat does not follow the link, so this is refused as a non-regular file
			// rather than being measured or read through.
			const out = await verify(dir, "link.bundle");
			expect(out.status).toBe("rejected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("REJECTS a symlinked INTERMEDIATE directory, not just a symlinked leaf", async () => {
		// The leaf-symlink test above passes even without a parent-component check,
		// because the leaf open refuses it. This is the case that check exists for:
		// the leaf is a genuine regular file of legal size, and the escape happened
		// one component earlier. A runner owns the write side of its own job output
		// directory, so planting this link is squarely within its authority.
		const dir = jobDir();
		const outside = mkdtempSync(join(testTmpBase(), "outside-"));
		try {
			writeFileSync(join(outside, "other.bundle"), "x".repeat(64));
			symlinkSync(outside, join(dir, "out"));
			const out = await verify(dir, "out/other.bundle");
			expect(out.status).toBe("rejected");
			// And specifically for confinement -- not incidentally via some later gate.
			expect(out.status === "rejected" && out.reason).toContain("escapes the job output directory");
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});

	test("REJECTS a nested path even when every component is a real directory", async () => {
		// Nesting is refused OUTRIGHT rather than validated component by component.
		// A validated parent is only trustworthy until the next syscall: the runner
		// owns that directory and can replace it with a symlink after the check and
		// before any of the four git invocations re-resolve the same string. There
		// is no window to lose if there is no intermediate component, so a bundle
		// must be one filename beside the job's other artifacts.
		const dir = jobDir();
		try {
			mkdirSync(join(dir, "nested", "deeper"), { recursive: true });
			writeFileSync(join(dir, "nested", "deeper", "ok.bundle"), "x".repeat(64));
			const out = await verify(dir, "nested/deeper/ok.bundle");
			expect(out.status).toBe("rejected");
			expect(out.status === "rejected" && out.reason).toContain("escapes the job output directory");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("SNAPSHOTS the bundle, so a post-verification swap cannot change what is used", async () => {
		// The check-then-use fix, asserted as behavior: the verdict's bundlePath is
		// the watcher-owned copy, not the runner-supplied path, and its bytes are
		// the ones that existed at verification time even after the original is
		// overwritten.
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle");
			expect(out.status).toBe("ok");
			if (out.status !== "ok") return;
			expect(out.bundlePath).not.toBe(join(dir, "change.bundle"));
			// The runner rewrites its own file after the fact; the snapshot is unmoved.
			writeFileSync(join(dir, "change.bundle"), "TAMPERED");
			expect(readFileSync(out.bundlePath, "utf8")).toBe("PACK");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS a sibling directory sharing the root's prefix", async () => {
		// `<root>-evil` satisfies a naive startsWith(root) check; the trailing
		// separator comparison is what stops it.
		const dir = jobDir();
		try {
			const out = await verify(dir, "../" + dir.split("/").pop() + "-evil/x.bundle");
			expect(out.status).toBe("rejected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("provenance", () => {
	test("REJECTS a bundle whose declared base is not the dispatched base", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle", { baseSha: "d".repeat(40) });
			expect(out.status).toBe("rejected");
			if (out.status === "rejected") {
				expect(out.reason).toContain("dispatched base");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS a short-prefix base that is not a full match", async () => {
		// A prefix match would let a runner satisfy the gate with a shorter sha.
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle", { baseSha: BASE.slice(0, 8) });
			expect(out.status).toBe("rejected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS when git bundle verify fails", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle", {
				inspector: inspector({ verify: async () => false }),
			});
			expect(out.status).toBe("rejected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS a bundle with no prerequisite — a full unrelated history", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle", {
				inspector: inspector({ requiredBases: async () => [] }),
			});
			expect(out.status).toBe("rejected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS a bundle rooted on some other commit", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle", {
				inspector: inspector({ requiredBases: async () => ["f".repeat(40)] }),
			});
			expect(out.status).toBe("rejected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("provenance — ancestry", () => {
	test("REJECTS a tip that does not descend from the dispatched base", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle", {
				inspector: inspector({ isAncestor: async () => false }),
			});
			expect(out).toEqual({
				status: "rejected",
				reason: "bundle tip does not descend from the dispatched base",
			});
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS when the ancestry check itself errors", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle", {
				inspector: inspector({
					isAncestor: async () => {
						throw new Error("boom");
					},
				}),
			});
			expect(out).toEqual({ status: "rejected", reason: "bundle ancestry unreadable" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("scope — the CI escalation gate", () => {
	test("REJECTS a change touching a GitHub workflow", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle", {
				inspector: inspector({
					changedPaths: async () => ["src/a.ts", ".github/workflows/ci.yml"],
				}),
			});
			expect(out.status).toBe("rejected");
			if (out.status === "rejected") {
				expect(out.reason).toContain("CI workflow");
			}
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS a change touching a Forgejo workflow", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle", {
				inspector: inspector({ changedPaths: async () => [".forgejo/workflows/x.yml"] }),
			});
			expect(out.status).toBe("rejected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS a change touching a Gitea-compat workflow, same reason as Forgejo", async () => {
		// Forgejo also runs `.gitea/workflows/` as its Gitea-compat fallback, so a
		// runner writing there rewrites CI exactly as `.forgejo/workflows/` would.
		const reasonFor = async (path: string) => {
			const dir = jobDir();
			try {
				const out = await verify(dir, "change.bundle", {
					inspector: inspector({ changedPaths: async () => [path] }),
				});
				return out.status === "rejected" ? out.reason : `not rejected: ${out.status}`;
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		};
		const gitea = await reasonFor(".gitea/workflows/x.yml");
		expect(gitea).toContain("CI workflow");
		expect(gitea).toBe(await reasonFor(".forgejo/workflows/x.yml"));
		expect(touchesWorkflowPath("./.gitea/workflows/ci.yaml")).toBe(true);
	});

	test("workflow detection survives ./ and backslash forms", () => {
		expect(touchesWorkflowPath(".github/workflows/ci.yml")).toBe(true);
		expect(touchesWorkflowPath("./.github/workflows/ci.yml")).toBe(true);
		expect(touchesWorkflowPath(".forgejo/workflows/a.yml")).toBe(true);
		// A file merely NAMED like one is fine; only the directory is forbidden.
		expect(touchesWorkflowPath("docs/github-workflows.md")).toBe(false);
		expect(touchesWorkflowPath("src/workflows/engine.ts")).toBe(false);
	});

	test("refuses THIS repo's actual CI gate, which is not a workflow file", () => {
		// #18 retired GitHub Actions here; the real gate is the exact-SHA pre-push
		// receipt chain. A change touching it rewrites the checks that gate the
		// runner's own work -- the exact escalation the list exists to refuse.
		expect(touchesWorkflowPath("_githooks/pre-push")).toBe(true);
		expect(touchesWorkflowPath("scripts/install-hooks.sh")).toBe(true);
		expect(touchesWorkflowPath("specs/software-factory.verify.sh")).toBe(true);
		expect(touchesWorkflowPath("./_githooks/pre-commit")).toBe(true);
		// Still not over-broad: a doc or source file that merely mentions them is fine.
		expect(touchesWorkflowPath("docs/githooks.md")).toBe(false);
		expect(touchesWorkflowPath("src/prepush/validate.ts")).toBe(false);
	});

	test("refuses rtech-infra's gate scripts, which its pre-push delegates to", () => {
		// #187 enables the implement lane for rtech-infra. Its `_githooks/pre-push`
		// is a shim that runs `scripts/identity-verify-gate.sh --pre-push`, and
		// `scripts/identity-policy-check` is the `repository-policy` gate in its
		// verify spec. Covering only `_githooks/` would leave the gate bodies
		// writable, so the refusal there would be cosmetic.
		expect(touchesWorkflowPath("scripts/identity-verify-gate.sh")).toBe(true);
		expect(touchesWorkflowPath("scripts/identity-policy-check")).toBe(true);
		expect(touchesWorkflowPath("./scripts/identity-verify-gate.sh")).toBe(true);
		// Matching is `startsWith`, as it already is for `scripts/install-hooks.sh`,
		// so a longer name sharing the prefix is also refused. That errs closed and
		// is asserted rather than left as a surprise.
		expect(touchesWorkflowPath("scripts/identity-policy-check.md")).toBe(true);
		// Still not over-broad: neighbouring scripts and docs about them are fine.
		expect(touchesWorkflowPath("docs/identity-gate-agent-hooks.md")).toBe(false);
		expect(touchesWorkflowPath("scripts/infra-scan.py")).toBe(false);
		expect(touchesWorkflowPath("scripts/identity-other.sh")).toBe(false);
	});

	test("REJECTS a bundle whose change touches rtech-infra's identity gate", async () => {
		const dir = jobDir();
		try {
			const out = await verify(dir, "change.bundle", {
				inspector: inspector({
					changedPaths: async () => [
						"projects/ansible/inventory/hosts.yml",
						"scripts/identity-verify-gate.sh",
					],
				}),
			});
			expect(out.status).toBe("rejected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("REJECTS an empty change and an oversized one", async () => {
		const dir = jobDir();
		try {
			expect(
				(
					await verify(dir, "change.bundle", {
						inspector: inspector({ changedPaths: async () => [] }),
					})
				).status,
			).toBe("rejected");
			const many = Array.from({ length: MAX_CHANGED_FILES + 1 }, (_, i) => `src/f${i}.ts`);
			expect(
				(
					await verify(dir, "change.bundle", {
						inspector: inspector({ changedPaths: async () => many }),
					})
				).status,
			).toBe("rejected");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("push mode", () => {
	test("a change with no bundle is not verifiable here", async () => {
		const out = await verifyChangeBundle({
			change: { base_sha: BASE, branch: "rw/issue-1" },
			jobOutputDir: "/nonexistent",
			dispatchedBaseSha: BASE,
			snapshotPath: "/nonexistent/snapshot.bundle",
			inspector: inspector(),
		});
		expect(out.status).toBe("rejected");
	});
});

/**
 * #92 — a rejected bundle must leave NOTHING at the verified snapshot path.
 *
 * The bundle is snapshotted BEFORE gates 3–4 run (provenance, base, scope), so a
 * bundle rejected at a late gate — most sharply the CI-workflow escalation the
 * whole boundary exists to stop — was previously left sitting at exactly the path
 * `results/proposal-pass`'s `snapshotExists` probes to decide a proposal
 * candidate. It was one loader change away from pushable, and `service.ts`
 * documents that path as "durable proof that a change was actually produced AND
 * verified" — false on disk.
 *
 * The fix quarantines the bytes at `<snapshotPath>.unverified` and only an `ok`
 * verdict renames them into the verified path; every rejection unlinks the
 * quarantine file. So the verified path holds verified bytes or nothing, ever.
 */
describe("verified snapshot path invariant", () => {
	test("an OK verdict PROMOTES the bytes to the verified path and clears quarantine", async () => {
		const dir = jobDir();
		const snapshotPath = snapshotDest();
		try {
			const out = await verify(dir, "change.bundle", { snapshotPath });
			expect(out.status).toBe("ok");
			// The verified path holds the snapshotted bytes...
			expect(readFileSync(snapshotPath, "utf8")).toBe("PACK");
			// ...and the quarantine sibling is gone, not left beside it.
			expect(existsSync(quarantinePathFor(snapshotPath))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// One case per gate that rejects AFTER the snapshot is taken. Each must leave
	// NO file at the verified path and none at the quarantine path.
	const lateRejections: Array<[string, BundleInspector, { baseSha?: string }]> = [
		["git bundle verify fails", inspector({ verify: async () => false }), {}],
		["declared base mismatch", inspector(), { baseSha: "d".repeat(40) }],
		["bundle has no base", inspector({ requiredBases: async () => [] }), {}],
		["bundle rooted elsewhere", inspector({ requiredBases: async () => ["f".repeat(40)] }), {}],
		["change touches no files", inspector({ changedPaths: async () => [] }), {}],
		[
			"change touches a CI workflow — the escalation case",
			inspector({ changedPaths: async () => ["src/a.ts", ".github/workflows/ci.yml"] }),
			{},
		],
	];

	for (const [name, insp, opts] of lateRejections) {
		test(`REJECTED (${name}) leaves NO file at the verified path or quarantine`, async () => {
			const dir = jobDir();
			const snapshotPath = snapshotDest();
			try {
				const out = await verify(dir, "change.bundle", {
					snapshotPath,
					inspector: insp,
					baseSha: opts.baseSha,
				});
				expect(out.status).toBe("rejected");
				// The invariant the whole issue is about: the verified path is empty.
				expect(existsSync(snapshotPath)).toBe(false);
				// And the quarantine file was cleaned up, not stranded to block retries.
				expect(existsSync(quarantinePathFor(snapshotPath))).toBe(false);
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		});
	}

	test("a bundle rejected at snapshot time (symlinked leaf) writes NOTHING", async () => {
		// The early gate: the bytes are never taken, so there is nothing to clean —
		// assert the verified path stays empty here too, for completeness.
		const dir = jobDir();
		const outside = mkdtempSync(join(testTmpBase(), "outside-"));
		const snapshotPath = snapshotDest();
		try {
			writeFileSync(join(outside, "secret"), "x".repeat(64));
			symlinkSync(join(outside, "secret"), join(dir, "link.bundle"));
			const out = await verify(dir, "link.bundle", { snapshotPath });
			expect(out.status).toBe("rejected");
			expect(existsSync(snapshotPath)).toBe(false);
			expect(existsSync(quarantinePathFor(snapshotPath))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
			rmSync(outside, { recursive: true, force: true });
		}
	});
});
