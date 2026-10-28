/**
 * @module results/change-ingest
 * @description The trust boundary for a runner-proposed change. A result's
 *   `change` block is a CLAIM made by an untrusted process: the runner box runs a
 *   coding agent with permissions bypassed, over repository content that is
 *   itself untrusted review input. Nothing in that claim may be acted on until it
 *   is independently proven here.
 *
 *   Four independent gates, each of which fails closed:
 *
 *   1. **Confinement.** The bundle must be a SINGLE safe filename inside the
 *      job's OWN output directory on the share. The schema bounds
 *      `bundle_path`'s length; only this module proves it is not a traversal, an
 *      absolute path, or nested behind a directory the runner could swap.
 *   2. **Snapshot.** The bytes are taken once through an `O_NOFOLLOW`
 *      descriptor, size-checked by `fstat` on that OPEN descriptor, and copied
 *      to a watcher-owned path. This is what makes the later gates meaningful:
 *      verifying a runner-controlled path and then re-resolving that same path
 *      in four subprocesses verifies one artifact and uses another.
 *
 *      The bytes land at a QUARANTINE path (`<snapshotPath>.unverified`), never
 *      directly at the verified `snapshotPath`. Only an `ok` verdict renames the
 *      quarantine file into `snapshotPath`; every rejection unlinks it. So the
 *      verified path — the exact path `results/proposal-pass`'s `snapshotExists`
 *      probes to decide a proposal candidate, and the one `service.ts` documents
 *      as "durable proof that a change was actually produced AND verified" — never
 *      holds unverified bytes at any instant, not even during gates 3–4. A
 *      rejected bundle (e.g. one caught touching a CI-workflow path at gate 4) is
 *      therefore never one loader change away from being pushable.
 *   3. **Provenance.** `git bundle verify` must pass, and the bundle's required
 *      base must be the EXACT `base_sha` the watcher dispatched — not a SHA the
 *      runner chose. A bundle that applies onto some other commit describes work
 *      the watcher never asked for.
 *   4. **Scope.** No path touched ANYWHERE in the bundle's history may be a CI
 *      workflow path — not merely no net change to one. A runner that can
 *      rewrite CI can grant itself authority on the next run, so this is
 *      enforced here rather than by the instruction text in the job body — a
 *      prompt is not a security control.
 *
 *   The module answers one question — may this change become a branch? — and
 *   performs no mutation itself: it never pushes, never opens a proposal, and
 *   never writes to the repository.
 *
 * @outputs
 *   - `verifyChangeBundle` -- run every gate over one claimed change
 *   - `ChangeVerification` -- the discriminated verdict
 *   - `WORKFLOW_PATH_PREFIXES` -- the CI paths no change may touch
 *   - `MAX_BUNDLE_BYTES` / `MAX_CHANGED_FILES` -- the hard ceilings
 *
 * @dependencies
 *   - node:fs/promises -- O_NOFOLLOW open + fstat + the owned-copy write
 *   - node:path -- containment-safe joining
 *   - ../log -- structured, credential-free rejection logging
 *   - ./schema -- the bounded change claim being verified
 */
import { constants } from "node:fs";
import { open, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, sep } from "node:path";
import { errorMessage, log, traced } from "../log";
import type { ResultChange } from "./schema";

/**
 * CI workflow directories no proposed change may touch, for EITHER forge. A
 * runner that can write these can rewrite the checks that gate its own work and
 * escalate itself on the next run, so this is a hard refusal rather than a
 * finding — there is no legitimate implement-lane reason to edit them.
 */
export const WORKFLOW_PATH_PREFIXES = [
	".github/workflows/",
	".forgejo/workflows/",
	".gitea/workflows/", // Forgejo also runs this dir as its Gitea-compat fallback (#813).
	// THIS repo's CI is not a workflow file. Issue #18 deliberately retired GitHub
	// Actions here, and the reviewed replacement is the exact-SHA pre-push receipt
	// gate: `prepush validate` runs the command set in a sandboxed runner and the
	// hook proves a passing receipt bound to the exact clean HEAD.
	//
	// So listing only the two workflow directories protects the CI of every repo
	// EXCEPT this one. A change touching the hook, its installer, or the
	// executable acceptance spec rewrites the checks that gate the runner's own
	// work -- precisely the escalation this list exists to refuse -- while passing
	// the gate untouched.
	"_githooks/",
	"scripts/install-hooks.sh",
	"specs/",
	// The same hole in rtech-infra, whose implement lane is enabled as of #187.
	// Its `_githooks/pre-push` holds almost no logic: it DELEGATES to
	// `scripts/identity-verify-gate.sh --pre-push`. Covering only `_githooks/`
	// there would leave the gate's actual body writable and the refusal above
	// cosmetic. `scripts/identity-policy-check` is the `repository-policy` gate
	// that `specs/identity-service-lifecycle.verify.sh` runs -- a separate entry
	// point, not called by the hook, but a check the runner's own work passes
	// through, so it is refused on the same escalation grounds.
	"scripts/identity-verify-gate.sh",
	"scripts/identity-policy-check",
] as const;

/** Hard ceiling on a bundle, checked before the file is read. */
export const MAX_BUNDLE_BYTES = 32 * 1024 * 1024;

/** Hard ceiling on how many files one proposed change may touch. */
export const MAX_CHANGED_FILES = 500;

/** The verdict for one claimed change. Only `ok` may proceed to publication. */
export type ChangeVerification =
	| { status: "ok"; bundlePath: string; changedFiles: string[] }
	| { status: "rejected"; reason: string };

/** The bounded git surface this module needs, injected so tests need no repo. */
export interface BundleInspector {
	/** `git bundle verify` — resolves true only when the bundle is well-formed. */
	verify(bundlePath: string): Promise<boolean>;
	/** The commit(s) the bundle requires to already exist (its prerequisites). */
	requiredBases(bundlePath: string): Promise<string[]>;
	/** Paths the bundle's commits touch, relative to the repository root. */
	changedPaths(bundlePath: string, baseSha: string): Promise<string[]>;
	/** Whether the bundle's tip descends from `baseSha` (an orphan tip does not). */
	isAncestor(bundlePath: string, baseSha: string): Promise<boolean>;
}

/** Inputs for one verification. Every value is watcher-derived except `change`. */
export interface VerifyChangeParams {
	/** The untrusted claim from the runner's result. */
	change: ResultChange;
	/** The job's own output directory on the share — the confinement root. */
	jobOutputDir: string;
	/** The EXACT base SHA the watcher dispatched. Never taken from the result. */
	dispatchedBaseSha: string;
	/**
	 * A watcher-owned path the runner cannot write, where the bundle's bytes come
	 * to rest ONLY on an `ok` verdict. During verification the bytes live at the
	 * quarantine sibling `<snapshotPath>.unverified`; every git invocation reads
	 * that, so the artifact cannot change between being verified and being used,
	 * and the verified `snapshotPath` never holds unverified bytes. Neither
	 * path may already exist — the copy uses `wx` and the promote uses `rename`.
	 */
	snapshotPath: string;
	/** The git surface. */
	inspector: BundleInspector;
}

/**
 * Resolve the claimed bundle path strictly inside the job's own output
 * directory. Returns null for an absolute path, a traversal, a nested path, or
 * anything that normalizes outside the root.
 *
 * NESTING IS REFUSED OUTRIGHT, which is what closes the check-then-use race. A
 * multi-component path forces this module to validate intermediate directories
 * and then hand the same STRING to a series of subprocesses that each re-resolve
 * it. The runner owns the write side of its own output directory, so it can swap
 * a validated parent for a symlink in between — and no amount of pre-checking a
 * path fixes a path that is resolved again later.
 *
 * A single segment removes the window rather than narrowing it: there is no
 * intermediate component to swap, and the leaf is opened once with `O_NOFOLLOW`
 * and consumed through that descriptor. `results/share-reader` already takes
 * exactly this position with `isSafeSegment`, and a runner writing its bundle
 * beside its other artifacts loses nothing by it.
 *
 * The trailing-separator prefix comparison is kept as defence: without it a
 * sibling directory like `<root>-evil` satisfies a bare `startsWith(root)`.
 */
function confine(jobOutputDir: string, claimed: string): string | null {
	// An absolute path is never a share-relative artifact path; reject before
	// join(), which would otherwise discard the root entirely.
	if (claimed.length === 0 || isAbsolute(claimed)) {
		return null;
	}
	// A NUL byte truncates the path at the syscall layer, so a value that looks
	// contained here could open a different file. Refuse it outright.
	if (claimed.includes("\0")) {
		return null;
	}
	// One safe segment only — no separator, no `.`/`..`, no exotic bytes.
	if (!/^[A-Za-z0-9._-]+$/.test(claimed) || claimed === "." || claimed === "..") {
		return null;
	}
	const resolved = normalize(join(jobOutputDir, claimed));
	const rootPrefix = normalize(jobOutputDir) + sep;
	return resolved.startsWith(rootPrefix) ? resolved : null;
}

/**
 * Copy the claimed bundle into a watcher-owned file and return that path, or
 * null if it cannot be trusted.
 *
 * This is the fix for check-then-use. Validating a path and then handing the
 * STRING to `git` re-resolves it: between the check and each of the four git
 * invocations, the runner — which owns the write side of its output directory —
 * can substitute what that name refers to. Every guard written against the path
 * is only as good as the path still meaning the same thing later, and it does
 * not have to.
 *
 * So the bytes are taken ONCE, through a descriptor:
 *   - `O_NOFOLLOW` refuses a symlinked leaf at open time (ELOOP) rather than
 *     following it, the same flag and reason as `results/share-reader`.
 *   - `fstat` on the OPEN descriptor decides regular-file-ness and size, so the
 *     answer describes the object actually opened, not whatever the name points
 *     at by the time a second syscall runs.
 *   - the content is copied to a watcher-owned path the runner cannot reach, and
 *     every later git call reads THAT.
 *
 * `confine()` having already refused nested paths means there is no intermediate
 * component left to swap; this closes the leaf.
 */
async function snapshotBundle(
	claimedPath: string,
	destPath: string,
): Promise<{ status: "ok" } | { status: "rejected"; reason: string }> {
	let handle: Awaited<ReturnType<typeof open>> | null = null;
	try {
		handle = await open(claimedPath, constants.O_RDONLY | constants.O_NOFOLLOW);
		const stats = await handle.stat();
		if (!stats.isFile()) {
			log("warn", "change.ingest.rejected", { reason: "bundle_not_regular_file" });
			return { status: "rejected", reason: "bundle path is not a regular file" };
		}
		if (stats.size > MAX_BUNDLE_BYTES) {
			log("warn", "change.ingest.rejected", { reason: "bundle_too_large", size: stats.size });
			return { status: "rejected", reason: "bundle exceeds the size ceiling" };
		}
		// Read through the descriptor, never by reopening the name.
		const buffer = Buffer.alloc(stats.size);
		await handle.read(buffer, 0, stats.size, 0);
		await writeFile(destPath, buffer, { flag: "wx", mode: 0o600 });
		return { status: "ok" };
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		// ELOOP is a symlinked leaf; both it and an absent file read as unusable.
		log("warn", "change.ingest.rejected", {
			reason: code === "ELOOP" ? "bundle_is_symlink" : "bundle_stat_failed",
			error: errorMessage(error),
		});
		return { status: "rejected", reason: "bundle is unreadable" };
	} finally {
		await handle?.close();
	}
}

/** True when a changed path lands in a CI workflow directory, on either forge. */
export const touchesWorkflowPath = traced(
	"results.touchesWorkflowPath",
	function touchesWorkflowPath(path: string): boolean {
		// Compare on a normalized, forward-slash form so `.github\workflows\x` or
		// `./.github/workflows/x` cannot slip past a naive prefix test.
		const unified = normalize(path).split(sep).join("/").replace(/^\.\//, "");
		return WORKFLOW_PATH_PREFIXES.some((prefix) => unified.startsWith(prefix));
	},
);

/**
 * Prove a claimed change is safe to turn into a branch, or reject it with a
 * bounded reason. Every rejection is logged with a fixed reason code; the
 * runner's raw claim is never interpolated into a log line, because a crafted
 * path is exactly the kind of value that should not land in the operator's logs
 * verbatim.
 */
async function verifyChangeBundleImpl(params: VerifyChangeParams): Promise<ChangeVerification> {
	const { change, jobOutputDir, dispatchedBaseSha, snapshotPath, inspector } = params;

	if (!change.bundle_path) {
		// Push mode declares a branch instead; that path is verified against the
		// forge, not here, and is gated on the runner git identity.
		return { status: "rejected", reason: "change declares no bundle to verify" };
	}

	// Gate 1 — confinement. Proven before any filesystem access.
	const bundlePath = confine(jobOutputDir, change.bundle_path);
	if (bundlePath === null) {
		log("warn", "change.ingest.rejected", { reason: "bundle_path_not_confined" });
		return { status: "rejected", reason: "bundle path escapes the job output directory" };
	}

	// Gate 2 — take the bytes ONCE, through a descriptor, into a watcher-owned
	// QUARANTINE file. Gates 3–4 read the quarantine path, so the runner cannot
	// change what is being verified after it has been verified — AND the verified
	// `snapshotPath` never holds unverified bytes, because bytes only reach it via
	// the promote on `ok` below.
	const quarantinePath = quarantinePathFor(snapshotPath);
	const snapshot = await snapshotBundle(bundlePath, quarantinePath);
	if (snapshot.status === "rejected") {
		return snapshot;
	}

	// From here the quarantine file exists. Every rejection must remove it so a
	// rejected bundle leaves nothing at either the quarantine or the verified path;
	// `discard` unlinks the single quarantine file (never a recursive
	// remove, never a runner-supplied path — it is derived from the watcher-owned
	// snapshot path) and forwards the verdict unchanged.
	const discard = async (verdict: {
		status: "rejected";
		reason: string;
	}): Promise<ChangeVerification> => {
		await unlink(quarantinePath).catch(() => {
			// A missing quarantine file is already the desired end state; anything
			// else is logged so an operator can reclaim a stranded file, but it must
			// not turn a rejection into a throw that a caller could read as passing.
			log("warn", "change.ingest.quarantine_cleanup_failed", {});
		});
		return verdict;
	};

	// Gate 3 — provenance. The bundle must be well-formed AND rooted on the exact
	// commit the watcher dispatched.
	const provenance = await verifyProvenance({
		quarantinePath,
		declaredBaseSha: change.base_sha,
		dispatchedBaseSha,
		inspector,
	});
	if (provenance !== null) {
		return discard(provenance);
	}

	// Gate 4 — scope.
	const scope = await verifyScope({ quarantinePath, dispatchedBaseSha, inspector });
	if (scope.status === "rejected") {
		return discard(scope);
	}
	const changedFiles = scope.changedFiles;

	// Every gate passed — PROMOTE the quarantine file into the verified path. The
	// rename is atomic on one filesystem (quarantine is a sibling of snapshotPath),
	// so the verified path appears only once, already holding fully-verified bytes.
	// A rename failure is a rejection, not a pass, and the quarantine file is
	// unlinked so nothing unverified is left behind either.
	try {
		await rename(quarantinePath, snapshotPath);
	} catch (error) {
		log("warn", "change.ingest.rejected", {
			reason: "snapshot_promote_failed",
			error: errorMessage(error),
		});
		return discard({ status: "rejected", reason: "verified snapshot could not be finalized" });
	}

	return { status: "ok", bundlePath: snapshotPath, changedFiles };
}

/**
 * `traced()` build-phase wrapper for {@link verifyChangeBundleImpl}.
 *
 * Kept in the `nameImpl` form because the body is long enough that re-indenting
 * it into a function expression would bury the change in whitespace; the `as
 * typeof` preserves the exact declared signature.
 */
export const verifyChangeBundle = traced(
	"results.verifyChangeBundle",
	verifyChangeBundleImpl,
) as typeof verifyChangeBundleImpl;

/**
 * Gate 3 — provenance. The bundle must be well-formed AND rooted on the exact
 * commit the watcher dispatched. Returns `null` when the gate passes, or the
 * bounded rejection the caller discards the quarantine file with.
 */
async function verifyProvenance(args: {
	quarantinePath: string;
	declaredBaseSha: string;
	dispatchedBaseSha: string;
	inspector: VerifyChangeParams["inspector"];
}): Promise<{ status: "rejected"; reason: string } | null> {
	const { quarantinePath, declaredBaseSha, dispatchedBaseSha, inspector } = args;
	try {
		if (!(await inspector.verify(quarantinePath))) {
			log("warn", "change.ingest.rejected", { reason: "bundle_verify_failed" });
			return { status: "rejected", reason: "git bundle verify failed" };
		}
	} catch (error) {
		log("warn", "change.ingest.rejected", {
			reason: "bundle_verify_error",
			error: errorMessage(error),
		});
		return { status: "rejected", reason: "git bundle verify errored" };
	}

	// The runner's own `base_sha` is a claim; it must agree with what we
	// dispatched. Checked case-insensitively but WITHOUT truncation — a prefix
	// match would let a runner satisfy the check with a shorter unrelated sha.
	if (declaredBaseSha.toLowerCase() !== dispatchedBaseSha.toLowerCase()) {
		log("warn", "change.ingest.rejected", { reason: "base_sha_mismatch" });
		return {
			status: "rejected",
			reason: "declared base does not match the dispatched base",
		};
	}

	let bases: string[];
	try {
		bases = await inspector.requiredBases(quarantinePath);
	} catch (error) {
		log("warn", "change.ingest.rejected", {
			reason: "bundle_bases_error",
			error: errorMessage(error),
		});
		return { status: "rejected", reason: "bundle prerequisites unreadable" };
	}
	// A bundle with NO prerequisite is a full history, not an increment on the
	// dispatched commit — it could carry an entirely unrelated tree.
	if (bases.length === 0) {
		log("warn", "change.ingest.rejected", { reason: "bundle_has_no_base" });
		return { status: "rejected", reason: "bundle declares no base commit" };
	}
	const normalizedDispatched = dispatchedBaseSha.toLowerCase();
	if (!bases.every((b) => b.toLowerCase() === normalizedDispatched)) {
		log("warn", "change.ingest.rejected", { reason: "bundle_base_not_dispatched" });
		return { status: "rejected", reason: "bundle is not rooted on the dispatched base" };
	}

	return verifyAncestry(quarantinePath, dispatchedBaseSha, inspector);
}

/**
 * The prerequisite list is read from the bundle HEADER, which is untrusted
 * bytes: a forged header can name the dispatched base while HEAD is an orphan.
 * Only git's ancestry answer over the fetched tip proves the
 * change actually builds on the base. `null` when it does.
 */
async function verifyAncestry(
	quarantinePath: string,
	dispatchedBaseSha: string,
	inspector: VerifyChangeParams["inspector"],
): Promise<{ status: "rejected"; reason: string } | null> {
	let descends: boolean;
	try {
		descends = await inspector.isAncestor(quarantinePath, dispatchedBaseSha);
	} catch (error) {
		log("warn", "change.ingest.rejected", {
			reason: "bundle_ancestry_error",
			error: errorMessage(error),
		});
		return { status: "rejected", reason: "bundle ancestry unreadable" };
	}
	if (!descends) {
		log("warn", "change.ingest.rejected", { reason: "bundle_tip_not_descendant" });
		return { status: "rejected", reason: "bundle tip does not descend from the dispatched base" };
	}

	return null;
}

/**
 * Gate 4 — scope. The change must touch at least one file, no more than
 * `MAX_CHANGED_FILES`, and no CI workflow path.
 */
async function verifyScope(args: {
	quarantinePath: string;
	dispatchedBaseSha: string;
	inspector: VerifyChangeParams["inspector"];
}): Promise<{ status: "ok"; changedFiles: string[] } | { status: "rejected"; reason: string }> {
	const { quarantinePath, dispatchedBaseSha, inspector } = args;
	let changedFiles: string[];
	try {
		changedFiles = await inspector.changedPaths(quarantinePath, dispatchedBaseSha);
	} catch (error) {
		log("warn", "change.ingest.rejected", {
			reason: "changed_paths_error",
			error: errorMessage(error),
		});
		return { status: "rejected", reason: "changed paths unreadable" };
	}
	if (changedFiles.length === 0) {
		return { status: "rejected", reason: "change touches no files" };
	}
	if (changedFiles.length > MAX_CHANGED_FILES) {
		log("warn", "change.ingest.rejected", {
			reason: "too_many_changed_files",
			count: changedFiles.length,
		});
		return { status: "rejected", reason: "change touches too many files" };
	}
	const workflowHit = changedFiles.find(touchesWorkflowPath);
	if (workflowHit !== undefined) {
		// Logged as a fixed reason WITHOUT the path: this is the escalation attempt
		// case, and the count is enough for an operator to investigate the job.
		log("warn", "change.ingest.rejected", { reason: "touches_ci_workflow" });
		return { status: "rejected", reason: "change modifies a CI workflow path" };
	}
	return { status: "ok", changedFiles };
}

/**
 * The quarantine sibling of a verified snapshot path. Kept a SIBLING (same
 * directory, `.unverified` suffix) so the promote is a same-filesystem `rename`,
 * which is atomic, and so the quarantine name is never one `results/proposal-pass`
 * `snapshotExists` probes — that only ever checks `snapshotPathFor`, i.e. the
 * verified path itself. Exported so the caller can clear a stale quarantine file
 * from a crashed prior attempt before it retries — the copy uses `wx` and would
 * otherwise fail forever on a leftover.
 */
export const quarantinePathFor = traced(
	"results.quarantinePathFor",
	function quarantinePathFor(snapshotPath: string): string {
		return `${snapshotPath}.unverified`;
	},
);
