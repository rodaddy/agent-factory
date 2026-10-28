/**
 * @module results/bundle-inspector
 * @description The production `BundleInspector` for the change-ingest trust
 *   boundary. `change-ingest` states the four gates a runner-proposed
 *   change must pass; three of them are answered by git, and this is the module
 *   that actually asks it. Without it the boundary is proven only against test
 *   doubles that decide their own answers, which cannot demonstrate that a real
 *   `git bundle` is well-formed, rooted where the watcher dispatched, or scoped
 *   to the files it claims.
 *
 *   EVERY READ IS QUARANTINED. A bundle is untrusted bytes from a box running a
 *   coding agent with permissions bypassed, so its objects are never fetched
 *   into the watcher's own repository. Each inspection runs against a scratch
 *   clone the caller owns and can discard, under a `refs/rw-verify/` namespace
 *   that collides with nothing, and every invocation is a fixed argv with the
 *   bundle path in a terminal position — never a shell string, so a crafted
 *   path is an argument and not a command.
 *
 *   The inspector REPORTS; it never decides. `change-ingest` owns every verdict.
 *   A git failure here surfaces as a thrown error or a `false`, which that
 *   module turns into a bounded rejection.
 *
 * @outputs
 *   - `LocalBundleInspector` -- git-backed inspector over a scratch repository
 *   - `VERIFY_REF` -- the quarantined ref a bundle tip is fetched to
 *
 * @dependencies
 *   - ../log -- structured, credential-free failure logging
 *   - ./change-ingest -- the `BundleInspector` contract being implemented
 */
import { bounded, log } from "../log";
import type { BundleInspector } from "./change-ingest";

/**
 * The single ref every bundle tip is fetched to. Namespaced under
 * `refs/rw-verify/` so it can never collide with a real branch or tag, and
 * fixed rather than per-job because each inspection owns its scratch repository
 * and the ref is overwritten on the next fetch.
 */
export const VERIFY_REF = "refs/rw-verify/tip";

/** A prerequisite line in `git bundle verify` output: a 40-64 char hex sha. */
const PREREQ_SHA = /^([0-9a-f]{40,64})\b/i;

/**
 * Git-backed inspector. Every method runs one fixed-argv `git` invocation in
 * `scratchRepoDir`, a repository the CALLER creates and discards — typically a
 * bare clone of the managed repo at the dispatched base. It must never be the
 * watcher's own checkout: `changedPaths` writes a ref into whatever repository
 * it is pointed at.
 */
export class LocalBundleInspector implements BundleInspector {
	constructor(private readonly scratchRepoDir: string) {}

	/**
	 * `git bundle verify` — true only when git itself accepts the bundle as
	 * well-formed AND every prerequisite it names is already present in the
	 * scratch repository. A non-zero exit is a `false`, not a throw: a corrupt
	 * bundle is an expected outcome at this boundary, not an operational fault.
	 */
	async verify(bundlePath: string): Promise<boolean> {
		const result = await this.git(["bundle", "verify", "--quiet", "--", bundlePath]);
		if (result.exitCode !== 0) {
			log("warn", "change.inspector.verify_failed", {
				exit_code: result.exitCode,
				stderr: bounded(result.stderr),
			});
			return false;
		}
		return true;
	}

	/**
	 * The commits the bundle requires to already exist. Read from
	 * `git bundle verify`'s own listing rather than by parsing the bundle's
	 * binary header: the header format is git's internal business, and
	 * re-implementing a reader for it would be owned surface for a question git
	 * already answers.
	 *
	 * The listing is prose plus ref lines, so only lines that BEGIN with a hex
	 * sha are taken and the prose is ignored — anchored, so a ref name that
	 * merely contains a sha cannot contribute one. Note that `verify` reports a
	 * prerequisite only while it is missing-or-present in this repository; this
	 * runs against a scratch clone that contains the dispatched base, which is
	 * exactly the condition `change-ingest` then checks the list against.
	 */
	async requiredBases(bundlePath: string): Promise<string[]> {
		const result = await this.git(["bundle", "verify", "--", bundlePath]);
		if (result.exitCode !== 0) {
			throw new Error("git bundle verify failed while reading prerequisites");
		}
		// Prerequisites appear under "The bundle requires this ref:"; contained refs
		// under "The bundle contains this ref:". Both are `<sha> <name>` lines, and
		// only the requires-block is wanted, so the section header is tracked rather
		// than harvesting every sha in the output.
		const bases: string[] = [];
		let inRequires = false;
		for (const line of result.stdout.split("\n")) {
			if (/requires? th(is|ese) ref/i.test(line)) {
				inRequires = true;
				continue;
			}
			if (/contains? th(is|ese) ref|hash algorithm/i.test(line)) {
				inRequires = false;
				continue;
			}
			const match = inRequires ? PREREQ_SHA.exec(line.trim()) : null;
			if (match?.[1]) {
				bases.push(match[1].toLowerCase());
			}
		}
		return bases;
	}

	/**
	 * EVERY path the bundle's commits touch, relative to the repository root —
	 * the union over its history, not the net base-to-tip diff.
	 *
	 * The difference is a bypass, not a nicety. `diff-tree base tip` compares two
	 * trees, so a bundle whose first commit adds `.github/workflows/ci.yml` and
	 * whose second removes it reports NO workflow path: the net change is zero
	 * and the scope gate never fires, while the bundle's history plainly modified
	 * CI. Since the gate refuses a change that TOUCHES a CI path, the question it
	 * must ask is what the commits touched, which is `log --name-only` over the
	 * range. Verified against git 2.54 by building exactly that add-then-revert
	 * bundle; see the test of the same name.
	 *
	 * `-m` so a merge commit reports its paths against each parent rather than
	 * being skipped, which would restore the same hole via a merge.
	 *
	 * The bundle's objects must exist locally before they can be diffed, so its
	 * tip is fetched into the scratch repository under `VERIFY_REF`.
	 *
	 * The ref is then resolved rather than the fetch's exit code being trusted
	 * alone. Measured against git 2.54: with this EXPLICIT `HEAD:` refspec a
	 * bundle carrying no `HEAD` fails loudly (exit 128, "couldn't find remote
	 * ref"), but a wildcard refspec matching nothing exits ZERO having fetched
	 * nothing. The peel to `^{commit}` also rejects a ref pointing at a non-commit
	 * object, which a bundle can legitimately carry (an annotated tag). Both would
	 * otherwise produce an empty path list, and empty is indistinguishable from
	 * "this change touches no files" — a rejection either way, so it fails closed,
	 * but under a reason that hides the real fault.
	 *
	 * `diff-tree` is the plumbing form: `git diff` requires a work tree and the
	 * scratch repository is normally bare. `-z` because a path may contain any
	 * byte except NUL, and the newline-delimited form would split such a path
	 * into two.
	 */
	async changedPaths(bundlePath: string, baseSha: string): Promise<string[]> {
		await this.fetchTip(bundlePath);

		const diff = await this.git([
			"log",
			"--format=",
			"--name-only",
			"-m",
			"-z",
			`${baseSha}..${VERIFY_REF}`,
		]);
		if (diff.exitCode !== 0) {
			log("warn", "change.inspector.diff_failed", {
				exit_code: diff.exitCode,
				stderr: bounded(diff.stderr),
			});
			throw new Error("git log over the bundle's commit range failed");
		}
		// Deduplicated: a path touched by several commits in the range is still one
		// changed path, and MAX_CHANGED_FILES counts paths rather than edits.
		return [...new Set(diff.stdout.split("\0").filter((path) => path.length > 0))];
	}

	/**
	 * Whether the bundle's tip DESCENDS from `baseSha`. A
	 * bundle header is untrusted bytes: it can name the dispatched base as its
	 * prerequisite while carrying an orphan `HEAD`, and `bundle verify` plus the
	 * prerequisite check both pass for that. An orphan tip also hides deletions
	 * from the scope gate, since `log base..tip` then lists only added paths.
	 * `merge-base --is-ancestor` exits 0 for yes and 1 for no; anything else is a
	 * fault and throws.
	 */
	async isAncestor(bundlePath: string, baseSha: string): Promise<boolean> {
		await this.fetchTip(bundlePath);
		const result = await this.git(["merge-base", "--is-ancestor", baseSha, VERIFY_REF]);
		if (result.exitCode === 0 || result.exitCode === 1) {
			return result.exitCode === 0;
		}
		log("warn", "change.inspector.ancestry_failed", {
			exit_code: result.exitCode,
			stderr: bounded(result.stderr),
		});
		throw new Error("git merge-base --is-ancestor failed");
	}

	/**
	 * Fetch the bundle's `HEAD` to `VERIFY_REF`, then resolve the ref rather than
	 * trusting the fetch's exit code alone (see `changedPaths`).
	 */
	private async fetchTip(bundlePath: string): Promise<void> {
		const fetched = await this.git([
			"fetch",
			"--no-write-fetch-head",
			"--force",
			"--",
			bundlePath,
			`HEAD:${VERIFY_REF}`,
		]);
		if (fetched.exitCode !== 0) {
			log("warn", "change.inspector.fetch_failed", {
				exit_code: fetched.exitCode,
				stderr: bounded(fetched.stderr),
			});
			throw new Error("git fetch from the bundle failed");
		}
		const tip = await this.git(["rev-parse", "--verify", "--quiet", `${VERIFY_REF}^{commit}`]);
		if (tip.exitCode !== 0 || tip.stdout.trim().length === 0) {
			// Exit zero with no ref: the bundle carried nothing matching HEAD.
			throw new Error("bundle carried no tip commit to compare");
		}
	}

	/** One fixed-argv git invocation in the scratch repository. Never a shell. */
	private async git(
		args: readonly string[],
	): Promise<{ exitCode: number; stdout: string; stderr: string }> {
		const proc = Bun.spawn(["git", ...args], {
			cwd: this.scratchRepoDir,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				// A bundle is untrusted input; refuse any interactive or credential
				// prompt rather than letting an inspection block forever on one.
				GIT_TERMINAL_PROMPT: "0",
				// `requiredBases` reads git's own English prose to find the
				// prerequisite block. On a host with a non-English locale and git's
				// translation catalogs installed, that prose is localized, the section
				// never matches, and a bundle's real base silently reads as absent. Pin
				// the locale so the output this code parses is the output it was
				// written against.
				LC_ALL: "C",
				LANG: "C",
			},
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		return { exitCode, stdout, stderr };
	}
}
