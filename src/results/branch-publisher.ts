/**
 * @module results/branch-publisher
 * @description Push a VERIFIED change bundle to the forge as the watcher's own
 *   watcher-derived proposal branch. This is the step between
 *   `results/change-ingest`
 *   proving a bundle safe and `github/publish` opening a proposal for it — the
 *   proposal path documents its input as "an already-pushed branch", and this is
 *   what pushes it.
 *
 *   The credential lives HERE, on the watcher, and never on the runner. In
 *   `patch` mode the runner hands back a bundle and holds no write credential at
 *   all, so the only process that can write to the forge is the one that already
 *   proved the change is in scope.
 *
 *   Everything dangerous is settled before this runs. `verifyChangeBundle` has
 *   already proved confinement, the dispatched base, the workflow-path exclusion,
 *   and the size/count ceilings, and it copied the bytes to a watcher-owned
 *   snapshot the runner cannot rewrite. This module re-derives the ref name from
 *   the integer item number rather than trusting any string that came back, and
 *   pushes exactly one ref, without force.
 *
 * @outputs
 *   - `pushVerifiedBranch` -- push a verified bundle as one non-force ref
 *   - `BranchPushOutcome` -- bounded result of that push
 *   - `GitRunner` -- the injected git surface
 *
 * @dependencies
 *   - ../log -- bounded, redacted logging
 *   - ../github/publication -- the watcher-derived branch naming
 */

import { proposalBranchFor } from "../github/publication";
import { errorMessage, log, traced } from "../log";

/** The bounded result of publishing a branch. */
export type BranchPushOutcome =
	| { status: "pushed"; branch: string; headSha: string }
	| { status: "rejected"; reason: string };

/** One fixed-argv git invocation. Never a shell. */
export interface GitRunner {
	run(
		args: readonly string[],
		options: { cwd: string; credential?: string },
	): Promise<{ exitCode: number; stdout: string; stderr: string }>;
}

export interface PushVerifiedBranchParams {
	/** The watcher-owned snapshot `verifyChangeBundle` produced. Never the runner path. */
	snapshotPath: string;
	/** A scratch clone of the target repository the watcher owns. */
	scratchRepoDir: string;
	/** The EXACT base SHA the watcher dispatched, already matched by verification. */
	dispatchedBaseSha: string;
	/** The item this change implements. */
	itemNumber: number;
	/** The trusted job type that selects verb vs non-verb naming. */
	jobType: string;
	/** The push remote. Watcher-resolved, never runner-supplied. */
	remote: string;
	/** The forge write credential. Never logged; passed to git, never interpolated. */
	credential: string;
	git: GitRunner;
}

/**
 * The single branch this module is allowed to write, derived from the validated
 * item number and trusted job type. A runner-supplied branch name cannot reach
 * git: it is not an input here at all. Null when the item number does not yield a
 * valid branch, which refuses the push outright.
 *
 * The destination is always spelled `refs/heads/<branch>` at the push. A short
 * refspec lets git resolve the destination against its own ref-matching rules,
 * which can land the write on a ref other than the one intended; the fully
 * qualified form removes that ambiguity.
 */
function pushBranchFor(itemNumber: number, jobType: string): string | null {
	return proposalBranchFor(itemNumber, jobType);
}

/**
 * Push a verified bundle as the watcher's branch for `itemNumber`.
 *
 * Fetches the bundle's commits into a watcher-owned scratch repository, then
 * pushes exactly one ref. Never `--force`: a non-fast-forward push is refused by
 * the forge, which is the property that stops a re-run from rewriting a branch a
 * human has already taken forward.
 */
async function pushVerifiedBranchImpl(
	params: PushVerifiedBranchParams,
): Promise<BranchPushOutcome> {
	// One derivation, used for both the refusal and the destination. Rebuilding the
	// name a second way would be a second source of truth that could drift from the
	// one `publish.ts` re-derives and authorizes against.
	const branch = pushBranchFor(params.itemNumber, params.jobType);
	if (branch === null) {
		return { status: "rejected", reason: "item number does not yield a valid branch" };
	}

	// Read the bundle through the watcher-owned snapshot, then resolve it to an
	// immutable sha. Only that sha is pushed, so nothing else in the scratch repo's
	// state can be published by accident.
	const fetched = await params.git.run(["fetch", "--no-tags", params.snapshotPath, "HEAD"], {
		cwd: params.scratchRepoDir,
	});
	if (fetched.exitCode !== 0) {
		return { status: "rejected", reason: "could not read the verified bundle" };
	}

	const head = await params.git.run(["rev-parse", "FETCH_HEAD"], { cwd: params.scratchRepoDir });
	const headSha = head.stdout.trim();
	if (head.exitCode !== 0 || !/^[0-9a-f]{40,64}$/.test(headSha)) {
		return { status: "rejected", reason: "verified bundle has no resolvable head" };
	}

	// Defence in depth over `verifyChangeBundle`, which already matched the base.
	// The snapshot is watcher-owned and the check is one cheap command, so re-prove
	// the ancestry HERE rather than trusting that the artifact between the two
	// steps is the same one.
	const ancestry = await params.git.run(
		["merge-base", "--is-ancestor", params.dispatchedBaseSha, headSha],
		{ cwd: params.scratchRepoDir },
	);
	if (ancestry.exitCode !== 0) {
		log("warn", "branch.push.rejected", {
			reason: "not_descended_from_dispatched_base",
			item_number: params.itemNumber,
		});
		return { status: "rejected", reason: "change is not descended from the dispatched base" };
	}

	// Push the RESOLVED SHA, never the symbolic `FETCH_HEAD`. FETCH_HEAD is a
	// repository-wide mutable ref: a concurrent call sharing this scratch repo can
	// fetch its own bundle between the rev-parse above and this push, and the
	// symbolic form would then publish THAT commit under this item's branch while
	// this function reports the sha it verified. Pushing the immutable sha makes
	// the bytes that were ancestry-checked the exact bytes that land.
	const pushed = await params.git.run(
		["push", "--no-tags", params.remote, `${headSha}:refs/heads/${branch}`],
		{
			cwd: params.scratchRepoDir,
			credential: params.credential,
		},
	);
	if (pushed.exitCode !== 0) {
		// A non-fast-forward rejection lands here and is CORRECT: the branch already
		// moved, and rewriting it is exactly what this lane must never do.
		log("warn", "branch.push.failed", {
			branch,
			item_number: params.itemNumber,
			// The message can echo a credential-bearing remote URL, so only the class.
			cause: errorMessage(new Error(pushed.exitCode === 1 ? "rejected" : "push failed")),
		});
		return { status: "rejected", reason: "push was refused by the forge" };
	}

	log("info", "branch.push.ok", { branch, item_number: params.itemNumber, head_sha: headSha });
	return { status: "pushed", branch, headSha };
}

/**
 * `traced()` build-phase wrapper for {@link pushVerifiedBranchImpl}.
 *
 * Kept in the `nameImpl` form because the body is long; the `as typeof`
 * preserves the exact declared signature. The single argument is masked: it
 * carries the live forge write credential, and a trace of it is exactly the
 * leak the rest of this module is built to avoid.
 */
export const pushVerifiedBranch = traced("results.pushVerifiedBranch", pushVerifiedBranchImpl, {
	redact: { args: [0] },
}) as typeof pushVerifiedBranchImpl;

/**
 * The production `GitRunner`: one fixed-argv git invocation, never a shell.
 *
 * The credential is answered by a `credential.helper` that reads it from the
 * child's ENVIRONMENT — never from argv, and never embedded in the remote URL.
 * Both of those leak: argv is world-readable in process listings, and a
 * credential-bearing URL ends up in `.git/config`, in git's own error text, and
 * in any log line that echoes the remote.
 *
 * The env is a real improvement over argv but is not airtight: on Linux a
 * same-uid process can read `/proc/<pid>/environ`. That is acceptable here
 * because the watcher owns its own host, and it is the reason the value is
 * scoped to the one invocation that needs it rather than exported process-wide.
 */
function createGitRunnerImpl(): GitRunner {
	return {
		run: async (args, options) => {
			const credentialArgs = options.credential
				? // `credential.helper` is MULTI-VALUED. Setting one here only APPENDS to
					// whatever the operator's global/system config already declares, and on
					// success git offers the approved credential to every helper in the
					// list — so a global `osxkeychain` would be handed this token and
					// persist it far outside the one child process that needed it. The
					// empty value RESETS the list first; that is the documented way to
					// discard inherited helpers, and it must come before the real one.
					[
						"-c",
						"credential.helper=",
						"-c",
						'credential.helper=!f() { echo "username=x-access-token"; echo "password=$GIT_WATCHER_TOKEN"; }; f',
						// Never let a successful push write the credential back out to any
						// store, belt-and-braces with the reset above.
						"-c",
						"credential.interactive=never",
					]
				: [];
			const proc = Bun.spawn(["git", ...credentialArgs, ...args], {
				cwd: options.cwd,
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					// Refuse any interactive prompt rather than blocking forever on one.
					GIT_TERMINAL_PROMPT: "0",
					// Pin the locale: this module and its callers parse git's output.
					LC_ALL: "C",
					LANG: "C",
					...(options.credential ? { GIT_WATCHER_TOKEN: options.credential } : {}),
				},
			});
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { exitCode, stdout, stderr };
		},
	};
}

/** `traced()` build-phase wrapper for {@link createGitRunnerImpl}. */
export const createGitRunner = traced(
	"results.createGitRunner",
	createGitRunnerImpl,
) as typeof createGitRunnerImpl;
