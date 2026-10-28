/**
 * @module scripts/land
 * @description The machine-owned `land` verb (ledger L-004): the
 *   zero-judgment landing sequence, run by a script instead of by the head.
 *
 *   L-004's finding is that "the head never absorbs lane work" is the
 *   most-violated controller obligation — landing mechanics were absorbed on
 *   #223, #224, #226 and #228, self-reported each time. The sequence contains no
 *   judgment at all, so the fix DISSOLVES the work rather than policing it:
 *   environment beats prose, the same lesson `TMPDIR` taught. The head's
 *   remaining act is invoking this.
 *
 *   Eight steps, in order: preflight refusals → PR body read → receipt → push →
 *   PR → merge → closure verify → teardown → receipt summary. The preflight
 *   refusals include the cwd containment check, which fires before every
 *   other step because the state it protects is the process's own working
 *   directory rather than anything the sequence observes. Any step failing stops
 *   the sequence HARD with the observed state printed. There are no retries and
 *   no cleanup of a partially-landed state — that is controller judgment and is
 *   deliberately out of scope, because a script that half-unwinds a landing is
 *   making exactly the decision this verb exists to avoid making.
 *
 *   **Location independence.** No step reads the process's working
 *   directory. Every git step pins `-C <worktree>`, and every forge step is
 *   addressed by an `owner/name` slug resolved ONCE in the preflight from the
 *   worktree's own `origin` URL. The invariant that matters is the direction of
 *   derivation: the slug comes from origin, never from the cwd, so the verb
 *   targets the repository the worktree belongs to no matter where the process
 *   is standing. An origin whose host is not the configured forge clone base is
 *   refused there rather than guessed at — a wrong slug would target somebody
 *   else's repository.
 *
 *   **Push shape (AGENTS.md standing ruling 1).** The runner lane is
 *   deliberately over-privileged, so SHAPE is the control that still holds when
 *   privilege does not: the refspec is fully qualified on both sides and derived
 *   from the branch git itself reported, the remote is named explicitly, and
 *   neither `--force` nor `--mirror` appears anywhere. Shape constraints work
 *   regardless of privilege and matter MORE when the credential is broad.
 *
 *   **Structure.** Sequencing and validation are pure logic over an INJECTED
 *   command runner and an INJECTED forge, so the whole sequence is driven by
 *   tests with fakes and never touches git or a live forge. The CLI entry at the
 *   bottom wires the real `Bun.spawn`-based runner and the real Forgejo adapter.
 *
 * @outputs
 *   - exit 0 with the receipt summary on stdout when the branch is landed
 *   - exit 2 for an invocation refusal (bad arguments, a cwd inside the target
 *     worktree, or a missing forge token), before any command runs
 *   - exit non-zero naming the failed step and the observed state on stderr
 *
 * @dependencies
 *   - the injected runner for every command; the module spawns nothing itself
 *   - the injected forge for every pull-request and issue call
 *   - `realpathSync` for the #232 cwd containment check only — a filesystem
 *     canonicalization, not a spawn, and injectable via `LandOptions.realpath`
 *   - `readFileSync` for the `--body-file` read, after the preflight
 */

import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { resolveForgejoToken } from "../src/forgejo/credentials";
import { SLUG_SEGMENT as SEGMENT, approvedApiUrl, forgejoLandForge } from "./land-forge";
import type { LandForge } from "./land-forge";

export type { LandForge } from "./land-forge";

/** What a command returned: exit code plus its captured streams. */
export interface CommandResult {
	readonly code: number;
	readonly stdout: string;
	readonly stderr: string;
}

/**
 * The injected execution boundary. Takes a full argv (`["git", "-C", …]`) and
 * resolves with the result. This is the ONLY way the sequence touches the
 * outside world for git, which is what makes the sequence itself testable.
 */
export type CommandRunner = (argv: readonly string[], opts?: RunOptions) => Promise<CommandResult>;

/**
 * Per-command options. `forgeCredential` hands the child the forge token:
 * children run WITHOUT it by default (PR #690 review round 2 P1), because git
 * hooks and any bun child could read an inherited `FORGEJO_TOKEN`. The one
 * child that needs it is the repo's own `prepush validate`, whose
 * comparison-base step reads canonical main through the forge.
 */
export interface RunOptions {
	readonly forgeCredential?: boolean;
	/** The child's working directory; the parent's when absent. */
	readonly cwd?: string;
}

/** A line sink, so tests capture output instead of the process writing it. */
export type Sink = (line: string) => void;

/**
 * Resolve a path to its canonical form. Injected for the same reason the runner
 * is: the cwd refusal must be drivable from a fixture without a real
 * symlink on disk. The default reads the filesystem — a syscall, never a spawn.
 */
export type PathResolver = (path: string) => string;

/** Reads the `--body-file` contents. Injected so tests need no file on disk. */
export type FileReader = (path: string) => string;

/** The forge base the origin URL must belong to, when none is configured. */
export const DEFAULT_CLONE_BASE = "https://forge.example.internal";

/** Everything `land` needs: both boundaries, the caller's argv, and its sinks. */
export interface LandOptions {
	readonly runner: CommandRunner;
	readonly forge: LandForge;
	readonly args: readonly string[];
	readonly stdout: Sink;
	readonly stderr: Sink;
	/** The invoking process's working directory. Defaults to `process.cwd()`. */
	readonly cwd?: string;
	/** Canonicalizes both paths before the containment test. */
	readonly realpath?: PathResolver;
	/** Reads the PR body file. Defaults to a UTF-8 `readFileSync`. */
	readonly readFile?: FileReader;
	/** The clone base whose host every origin must match. */
	readonly cloneBase?: string;
	/**
	 * The checkout whose `src/index.ts` runs the receipt. Defaults to this
	 * script's own checkout: the receipt child is the one child handed the
	 * forge token, so it runs TRUSTED code, never the
	 * candidate branch's copy in the worktree. The worktree is its cwd only.
	 * Unset, the validator is THIS script's own checkout (round 6 P0): the
	 * tree the operator chose to run `land` from, never anything read off the
	 * target worktree's git metadata, which the candidate controls. Set or
	 * defaulted, the root is refused when it lies at or inside the worktree, and
	 * when the worktree is not a linked worktree of that same checkout.
	 */
	readonly validatorRoot?: string;
}

/** The validated invocation, after argument parsing has refused bad input. */
interface Parsed {
	readonly worktree: string;
	readonly title: string;
	readonly bodyFile: string;
	readonly issue?: number;
}

/** Branch names this verb refuses to land FROM. */
const PROTECTED_BRANCHES = new Set(["main", "master"]);

/**
 * The three `origin` URL shapes a Forgejo remote is written in. Each captures
 * the host so the caller can compare it against the configured clone base:
 * a slug parsed off an unexpected host would address a repository on a forge
 * this verb has no business writing to.
 */
const ORIGIN_SHAPES: readonly RegExp[] = [
	/^https:\/\/([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
	/^ssh:\/\/git@([^/\s]+)\/([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
	/^git@([^:\s]+):([^/\s]+)\/([^/\s]+?)(?:\.git)?$/,
];

/** The hostname of a clone base (no port), or the string itself when hostless. */
function hostnameOf(base: string): string {
	try {
		return new URL(base).hostname;
	} catch {
		return base
			.trim()
			.replace(/^[a-z+]+:\/\//, "")
			.replace(/\/.*$/, "")
			.replace(/:\d+$/, "");
	}
}

/**
 * The hostname of a captured SSH origin host, port dropped. THE PORT POLICY
 * (PR #690 rounds 1 and 7): the forge's SSH endpoint is a distinct listener
 * (`git-ssh.example.internal:2222` style) that the HTTPS clone base says nothing
 * about, so the two SSH shapes are compared by hostname alone.
 */
function sshHostname(host: string): string {
	return host.replace(/:\d+$/, "");
}

/**
 * The authority (`host[:port]`, a default port elided) of an HTTPS URL, or
 * undefined when the string is not one. The HTTPS origin shape addresses the
 * clone base's own listener, so its whole authority must equal the base's
 * (round 7 P2): a clone base on `:8443` writes `:8443` into every origin it
 * hands out, and `:443` spelled out is the port left implicit.
 */
function httpsAuthorityOf(url: string): string | undefined {
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "https:") return undefined;
		if (parsed.username !== "" || parsed.password !== "") return undefined;
		return parsed.host;
	} catch {
		return undefined;
	}
}

/**
 * Parse an `origin` URL into the `owner/name` slug every forge call addresses.
 * Returns undefined on anything unrecognised OR on a host that is not the clone
 * base's, so the caller refuses with the observed string rather than sending a
 * malformed or foreign value to the forge.
 */
export function parseOriginSlug(url: string, cloneBase: string): string | undefined {
	const trimmed = url.trim();
	for (const shape of ORIGIN_SHAPES) {
		const match = shape.exec(trimmed);
		if (match === null) continue;
		const [, host, owner, name] = match;
		if (host === undefined || owner === undefined || name === undefined) return undefined;
		if (trimmed.startsWith("https://")) {
			const authority = httpsAuthorityOf(`https://${host}`);
			if (authority === undefined || authority !== httpsAuthorityOf(cloneBase)) return undefined;
		} else if (sshHostname(host) !== hostnameOf(cloneBase)) {
			return undefined;
		}
		if (!SEGMENT.test(owner) || !SEGMENT.test(name)) return undefined;
		return `${owner}/${name}`;
	}
	return undefined;
}

/**
 * An origin URL as it may be printed: userinfo, query and fragment removed
 * (round 7 P1). A refused origin is echoed so the operator can see which remote
 * was read, and `https://user:password@host/...` is a real shape git accepts —
 * the refusal must name the host without the credential reaching stderr or a
 * CI log.
 */
function redactOrigin(observed: string): string {
	return observed
		.replace(/^((?:[a-z+]+:\/\/)?)[^@/\s]*@/i, "$1<userinfo>@")
		.replace(/[?#].*$/s, "");
}

/**
 * Parse and validate argv. Returns a message instead of a parse on refusal, so
 * a bad invocation cannot reach a command: every refusal here happens before the
 * runner is called even once.
 */
export function parseArgs(args: readonly string[]): Parsed | { error: string } {
	const values = new Map<string, string>();
	for (let i = 0; i < args.length; i += 1) {
		const flag = args[i];
		if (flag !== undefined && flag.startsWith("--")) {
			const next = args[i + 1];
			if (next === undefined || next.startsWith("--")) {
				return { error: `land: ${flag} requires a value` };
			}
			values.set(flag, next);
			i += 1;
		}
	}

	const worktree = values.get("--worktree");
	if (worktree === undefined) return { error: "land: --worktree <path> is required" };
	const title = values.get("--title");
	if (title === undefined) return { error: "land: --title <text> is required" };
	const bodyFile = values.get("--body-file");
	if (bodyFile === undefined) return { error: "land: --body-file <path> is required" };

	const rawIssue = values.get("--issue");
	if (rawIssue === undefined) return { worktree, title, bodyFile };
	// Validated as an integer at the boundary: the number addresses a forge
	// resource, and #226's lesson is that an inferred or loosely-parsed value is
	// where a landing sequence goes wrong. `Number.parseInt` alone would accept
	// `12; rm -rf /` as 12, so the whole string must match.
	if (!/^\d+$/.test(rawIssue)) {
		return { error: `land: --issue must be a positive integer, got \`${rawIssue}\`` };
	}
	return { worktree, title, bodyFile, issue: Number.parseInt(rawIssue, 10) };
}

/**
 * The default resolver: canonicalize, falling back to the path AS GIVEN when it
 * cannot be resolved. A non-existent `--worktree` is a real invocation this verb
 * must still reach its own `preflight/worktree` refusal for, which names the
 * missing path properly — crashing the containment check on ENOENT would replace
 * a good diagnosis with a stack trace.
 */
const defaultRealpath: PathResolver = (path) => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

/**
 * True when `inner` IS `outer` or sits beneath it, compared segment-wise.
 *
 * Segment-wise, never `startsWith`: a sibling `…/l004-notes` shares the string
 * prefix `…/l004` without being inside it, and refusing a legitimate invocation
 * over a string coincidence is its own defect. Trailing separators are stripped
 * first so `…/l004/` and `…/l004` are the same directory.
 */
function isInside(inner: string, outer: string): boolean {
	const strip = (p: string): string => (p.length > 1 ? p.replace(/\/+$/, "") : p);
	const a = strip(inner);
	const b = strip(outer);
	return a === b || a.startsWith(`${b}/`);
}

/**
 * The refusal that must fire before EVERY step, including the read-only
 * preflight probes.
 *
 * The defect it prevents: step 7 removes the worktree, so a process whose cwd
 * was inside it inherits a deleted working directory, and the step-8 spawn then
 * fails with `ENOENT … posix_spawn 'git'` — which reads as a missing `git`
 * binary and misdirects diagnosis entirely. The landing itself SUCCEEDED; only
 * the summary lied, and the summary is the artifact the head reads instead of
 * re-running the steps.
 *
 * It happened twice in one evening by two different routes — invoking from
 * inside the directory, and `bun run --cwd <worktree> scripts/land.ts` from
 * outside, which moves the process cwd inside the target regardless of where the
 * operator is standing. Two routes into one state is why this is a refusal
 * rather than operator discipline, and why the message names the RULE: the verb
 * is location-independent by design, so the remedy is to run it from anywhere
 * else. Spawning every command with an explicit safe cwd was considered and
 * rejected — it hides the operator error instead of naming it, and every other
 * refusal in this verb names its rule.
 *
 * This is a pure path comparison over two strings and one filesystem
 * canonicalization. It issues no command, so it cannot itself depend on the cwd
 * it is judging.
 */
function refuseCwdInsideWorktree(
	cwd: string,
	worktree: string,
	resolve: PathResolver,
): string | undefined {
	const resolvedCwd = resolve(cwd);
	const resolvedWorktree = resolve(worktree);
	if (!isInside(resolvedCwd, resolvedWorktree)) return undefined;
	return [
		"land: refusing to run from inside the worktree being landed.",
		`land:   cwd:      ${resolvedCwd}`,
		`land:   worktree: ${resolvedWorktree}`,
		"land: teardown removes that directory under the running process, and the",
		"land: next command then fails with ENOENT on its own binary, reporting a",
		"land: successful landing as FAILED. The verb is location-independent by",
		"land: design: run it from anywhere outside the worktree, and do not pass",
		"land: `bun run --cwd <worktree>` — that moves the cwd inside the target.",
	].join("\n");
}

/**
 * The receipt child is handed the forge token, so the checkout whose
 * `src/index.ts` it runs must be trusted and must OWN the worktree (PR #690
 * rounds 4 and 6 P0). A root at or inside the worktree would run candidate
 * code with the credential; a worktree whose primary checkout is some other
 * tree either belongs to an untrusted repository or was pointed at the wrong
 * validator, and in both cases the receipt must not run. Every path is
 * realpath-resolved first, so a symlink into the worktree is the worktree.
 */
function refuseUntrustedValidator(
	validatorRoot: string,
	worktree: string,
	primary: string,
	resolve: PathResolver,
): StepFailure | undefined {
	const resolvedRoot = resolve(validatorRoot);
	const resolvedWorktree = resolve(worktree);
	if (isInside(resolvedRoot, resolvedWorktree)) {
		return {
			step: "preflight/validator",
			observed: `the validator root ${resolvedRoot} is at or inside the worktree being landed (${resolvedWorktree}); the receipt would run candidate code with the forge credential`,
		};
	}
	const resolvedPrimary = resolve(primary);
	if (!isInside(resolvedPrimary, resolvedRoot) || !isInside(resolvedRoot, resolvedPrimary)) {
		return {
			step: "preflight/validator",
			observed: `the worktree's primary checkout is ${resolvedPrimary}, not the trusted validator checkout ${resolvedRoot}; the receipt runs only for a worktree of the checkout it validates from`,
		};
	}
	return undefined;
}

/** A step's failure: which step, and the state that was observed. */
interface StepFailure {
	readonly step: string;
	readonly observed: string;
}

/**
 * The trusted checkout must say it owns the worktree. The
 * common-dir probe reads the worktree's own `.git` file, which the candidate
 * controls: a `gitdir:` naming a crafted directory whose `commondir` points at
 * the trusted checkout satisfies that probe with the worktree registered
 * nowhere. So the ownership claim is re-read from the trusted side — `git
 * worktree list --porcelain` run IN the validator root — and the worktree must
 * appear there, realpath-compared. A list that fails or is empty refuses.
 */
async function refuseUnregisteredWorktree(
	runner: CommandRunner,
	validatorRoot: string,
	worktree: string,
	resolve: PathResolver,
): Promise<StepFailure | undefined> {
	const listed = await run(runner, ["git", "-C", validatorRoot, "worktree", "list", "--porcelain"]);
	if (listed.code !== 0) {
		return {
			step: "preflight/validator",
			observed: `the trusted validator checkout ${validatorRoot} cannot list its worktrees: ${listed.stderr || listed.stdout || "no output"}`,
		};
	}
	const resolvedWorktree = resolve(worktree);
	const registered = listed.stdout
		.split("\n")
		.filter((line) => line.startsWith("worktree "))
		.map((line) => resolve(line.slice("worktree ".length)));
	if (registered.includes(resolvedWorktree)) return undefined;
	return {
		step: "preflight/validator",
		observed: `${resolvedWorktree} is not a worktree registered in the trusted validator checkout ${validatorRoot}; its own git metadata named that checkout, but the checkout does not list it, and the receipt runs only for a worktree the validator owns`,
	};
}

/** Format a failure as the two lines a stopped sequence prints. */
function fail(stderr: Sink, failure: StepFailure): number {
	stderr(`land: FAILED at ${failure.step}`);
	stderr(`land: observed: ${failure.observed}`);
	return 1;
}

/** Run one command, returning its result. Trimmed streams for readability. */
async function run(
	runner: CommandRunner,
	argv: readonly string[],
	opts?: RunOptions,
): Promise<CommandResult> {
	const result = await runner(argv, opts);
	return { ...result, stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

/** The state the preflight establishes before anything may be mutated. */
interface Preflight {
	readonly branch: string;
	readonly head: string;
	readonly primary: string;
	/** The `owner/name` slug every forge call addresses. */
	readonly repo: string;
}

/** Message text for the origin refusal, naming the rule and the expected host. */
function originRefusal(observed: string, cloneBase: string): string {
	return `origin \`${redactOrigin(observed)}\` is not a repository on ${hostnameOf(cloneBase)} — every forge step addresses an \`owner/name\` slug derived from origin, and a slug on another host would target a different repository`;
}

/**
 * Steps 1 and 2's read-only half: prove the worktree is a registered git
 * worktree, its tree is clean, and its branch is a landable feature branch.
 * Every failure here returns before the caller reaches a mutating step — this
 * function issues only read commands, which is what makes "nothing mutated" a
 * property of the ORDER rather than of each check remembering to be careful.
 */
async function preflight(
	runner: CommandRunner,
	worktree: string,
	cloneBase: string,
): Promise<Preflight | StepFailure> {
	const inside = await run(runner, ["git", "-C", worktree, "rev-parse", "--is-inside-work-tree"]);
	if (inside.code !== 0 || inside.stdout !== "true") {
		return {
			step: "preflight/worktree",
			observed: `\`${worktree}\` is not a registered git worktree: ${inside.stderr || inside.stdout}`,
		};
	}

	const common = await run(runner, ["git", "-C", worktree, "rev-parse", "--git-common-dir"]);
	if (common.code !== 0 || common.stdout.length === 0) {
		return {
			step: "preflight/worktree",
			observed: `cannot resolve the primary checkout for \`${worktree}\`: ${common.stderr}`,
		};
	}

	const status = await run(runner, ["git", "-C", worktree, "status", "--porcelain"]);
	if (status.code !== 0) {
		return { step: "preflight/clean", observed: `git status failed: ${status.stderr}` };
	}
	if (status.stdout.length > 0) {
		return {
			step: "preflight/clean",
			observed: `the tree is not clean:\n${status.stdout}`,
		};
	}

	const branchRef = await run(runner, ["git", "-C", worktree, "symbolic-ref", "--short", "HEAD"]);
	if (branchRef.code !== 0 || branchRef.stdout.length === 0) {
		return {
			step: "preflight/branch",
			observed: `HEAD is detached: ${branchRef.stderr || "no symbolic ref"}`,
		};
	}
	const branch = branchRef.stdout;
	if (PROTECTED_BRANCHES.has(branch)) {
		return {
			step: "preflight/branch",
			observed: `refusing to land from the protected branch \`${branch}\``,
		};
	}

	const headRef = await run(runner, ["git", "-C", worktree, "rev-parse", "HEAD"]);
	if (headRef.code !== 0 || headRef.stdout.length === 0) {
		return { step: "preflight/branch", observed: `cannot resolve HEAD: ${headRef.stderr}` };
	}

	// The repo slug is resolved HERE, in the read-only half, so an unrecognised
	// origin refuses before the push rather than after it. The invariant:
	// the slug is derived from the worktree's own origin, NEVER from the process
	// working directory — the cwd this verb REQUIRES (#232 — anywhere outside the
	// worktree) need not be a git repository at all, and a tool that infers its
	// target repository from the cwd left a branch already on the remote with no
	// PR. Read with `-C <worktree>` like every other git step, because resolving
	// it from an unpinned `git remote` would move the same cwd coupling one step
	// earlier instead of removing it.
	const origin = await run(runner, ["git", "-C", worktree, "remote", "get-url", "origin"]);
	if (origin.code !== 0 || origin.stdout.length === 0) {
		return {
			step: "preflight/origin",
			observed: `cannot read the origin URL for \`${worktree}\`: ${origin.stderr || "no output"}`,
		};
	}
	const repo = parseOriginSlug(origin.stdout, cloneBase);
	if (repo === undefined) {
		return { step: "preflight/origin", observed: originRefusal(origin.stdout, cloneBase) };
	}

	// The primary checkout is the git common dir's parent — derived, never
	// assumed, because `git worktree remove` run from inside the worktree being
	// removed is the classic failure of this step.
	const primary = common.stdout.replace(/\/\.git\/?$/, "").replace(/\/\.git\/worktrees\/.*$/, "");

	return { branch, head: headRef.stdout, primary, repo };
}

/** Narrow a preflight result to its failure shape. */
function isFailure(value: Preflight | StepFailure): value is StepFailure {
	return "step" in value;
}

/** Step 3: push the branch with a fully-qualified refspec and no force. */
async function push(
	runner: CommandRunner,
	worktree: string,
	branch: string,
): Promise<StepFailure | undefined> {
	const refspec = `refs/heads/${branch}:refs/heads/${branch}`;
	const result = await run(runner, ["git", "-C", worktree, "push", "-u", "origin", refspec]);
	if (result.code !== 0) {
		return { step: "push", observed: `git push failed: ${result.stderr || result.stdout}` };
	}
	return undefined;
}

/** What `openAndMerge` established once the pull request has landed. */
interface Landed {
	readonly url: string;
	readonly number: number;
}

/**
 * Steps 4 and 5: open the PR, capture its number, merge by that number.
 *
 * Both calls address the `owner/name` slug the preflight resolved from origin,
 * and the create pins `head` to the branch the preflight resolved. An
 * unpinned head is how a landing opens and squash-merges a PR for the wrong
 * branch: the second manifestation on the #235 thread was a retry from the
 * primary checkout, where the head branch came from THAT checkout's checked-out
 * branch — another session's — and was stopped only by a pre-existing PR on it.
 */
async function openAndMerge(
	forge: LandForge,
	parsed: Parsed,
	target: { repo: string; branch: string; base: string },
	body: string,
): Promise<Landed | StepFailure> {
	const { repo, branch, base } = target;
	let created: { number: number; url: string };
	try {
		created = await forge.createPullRequest(repo, {
			head: branch,
			base,
			title: parsed.title,
			body,
		});
	} catch (error) {
		return { step: "pr-create", observed: `opening the pull request failed: ${message(error)}` };
	}
	if (!Number.isInteger(created.number) || created.number <= 0) {
		return {
			step: "pr-create",
			observed: `the forge returned no usable pull-request number: \`${String(created.number)}\``,
		};
	}
	// The receipt names the PR by its URL; a landing with no link is not a
	// landing anyone can follow. Refused BEFORE the merge.
	if (!isHttpsUrl(created.url)) {
		return {
			step: "pr-create",
			observed: `the forge returned no usable pull-request URL for #${created.number}: \`${created.url}\``,
		};
	}

	// Merged by the CAPTURED number, never by inference from the branch — the
	// #226 lesson, where branch inference mid-compound mis-parsed.
	let merged: Awaited<ReturnType<LandForge["mergePullRequest"]>>;
	try {
		merged = await forge.mergePullRequest(repo, created.number);
	} catch (error) {
		return { step: "merge", observed: `merging PR #${created.number} failed: ${message(error)}` };
	}
	if (!merged.merged) {
		return {
			step: "merge",
			observed: `PR #${created.number} was not merged: ${merged.reason}`,
		};
	}
	return { url: created.url, number: created.number };
}

/** True for an absolute https URL, the only shape a PR link is accepted in. */
function isHttpsUrl(value: string): boolean {
	try {
		return new URL(value).protocol === "https:";
	} catch {
		return false;
	}
}

/** Render an unknown thrown value as a single readable line. */
function message(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Step 6's PR half: assert merged WITH a merge SHA, never assume it. */
async function verifyPr(
	forge: LandForge,
	repo: string,
	number: number,
): Promise<{ mergeSha: string } | StepFailure> {
	let state: { merged: boolean; mergeCommitSha: string | null };
	try {
		state = await forge.getPullRequestMergeState(repo, number);
	} catch (error) {
		return { step: "verify/pr", observed: `reading PR #${number} failed: ${message(error)}` };
	}
	if (state.merged !== true) {
		return { step: "verify/pr", observed: `PR #${number} reports merged=false, not landed` };
	}
	const sha = state.mergeCommitSha;
	if (typeof sha !== "string" || sha.length === 0) {
		// One clause, not two: a merged flag without the commit it names is the
		// unverified assumption this verb exists to remove.
		return {
			step: "verify/pr",
			observed: `PR #${number} reports merged but carries no merge commit SHA`,
		};
	}
	return { mergeSha: sha };
}

/** Step 6's issue half: assert the named issue is `closed`. */
async function verifyIssue(
	forge: LandForge,
	repo: string,
	issue: number,
): Promise<{ state: string } | StepFailure> {
	let observed: { state: string };
	try {
		observed = await forge.getIssueState(repo, issue);
	} catch (error) {
		return { step: "verify/issue", observed: `reading issue #${issue} failed: ${message(error)}` };
	}
	// The forge's own lowercase vocabulary, compared exactly. A case-insensitive
	// compare would accept a value from a different API's vocabulary and report a
	// state this verb never confirmed.
	if (observed.state !== "closed") {
		return {
			step: "verify/issue",
			observed: `issue #${issue} state is ${observed.state || "unknown"}, not closed`,
		};
	}
	return { state: observed.state };
}

/** Step 7: remove the worktree from the PRIMARY checkout, then list. */
async function teardown(
	runner: CommandRunner,
	primary: string,
	worktree: string,
	stdout: Sink,
): Promise<StepFailure | undefined> {
	const removed = await run(runner, ["git", "-C", primary, "worktree", "remove", worktree]);
	if (removed.code !== 0) {
		return {
			step: "teardown",
			observed: `git worktree remove failed: ${removed.stderr || removed.stdout}`,
		};
	}
	const listed = await run(runner, ["git", "-C", primary, "worktree", "list"]);
	if (listed.code !== 0) {
		return { step: "teardown", observed: `git worktree list failed: ${listed.stderr}` };
	}
	stdout("land: worktrees after teardown:");
	stdout(listed.stdout);
	return undefined;
}

/**
 * Run the whole landing sequence. Returns the process exit code; writes the
 * receipt summary to `stdout` on success and the failed step plus observed
 * state to `stderr` otherwise.
 */
export async function land(options: LandOptions): Promise<number> {
	const { runner, forge, args, stdout, stderr } = options;

	const parsed = parseArgs(args);
	if ("error" in parsed) {
		stderr(parsed.error);
		stderr("usage: land --worktree <path> --title <t> --body-file <f> [--issue <n>]");
		return 2;
	}

	// Before ANY step, including the read-only probes: the containment test needs
	// only the parsed `--worktree`, and exit 2 groups it with the other
	// invocation refusals rather than with a step that observed live state.
	const cwdRefusal = refuseCwdInsideWorktree(
		options.cwd ?? process.cwd(),
		parsed.worktree,
		options.realpath ?? defaultRealpath,
	);
	if (cwdRefusal !== undefined) {
		for (const line of cwdRefusal.split("\n")) stderr(line);
		return 2;
	}

	const pre = await preflight(runner, parsed.worktree, options.cloneBase ?? DEFAULT_CLONE_BASE);
	if (isFailure(pre)) return fail(stderr, pre);

	// The validator the receipt will run is THIS script's own checkout, or an
	// explicit `validatorRoot`, resolved to an absolute path ONCE against this
	// process's cwd (rounds 5 and 6): that one value feeds the checks and the
	// receipt argv, and the child's cwd (the worktree) never enters into it.
	// Two refusals fire HERE, before the forge is contacted and before the
	// credential is issued to any child: a root at or inside the worktree, and
	// a worktree whose primary checkout (from its own git metadata, which the
	// candidate controls) is not that trusted root.
	const validatorRoot = resolve(
		options.cwd ?? process.cwd(),
		options.validatorRoot ?? resolve(import.meta.dir, ".."),
	);
	const validatorRefusal = refuseUntrustedValidator(
		validatorRoot,
		parsed.worktree,
		resolve(parsed.worktree, pre.primary),
		options.realpath ?? defaultRealpath,
	);
	if (validatorRefusal !== undefined) return fail(stderr, validatorRefusal);
	const registration = await refuseUnregisteredWorktree(
		runner,
		validatorRoot,
		parsed.worktree,
		options.realpath ?? defaultRealpath,
	);
	if (registration !== undefined) return fail(stderr, registration);

	// The body is read AFTER the preflight and BEFORE the push, so an unreadable
	// file refuses with nothing pushed. The forge takes the body as a value, not
	// as a file path, so this read is the step that would otherwise fail with the
	// branch already on the remote.
	let body: string;
	try {
		body = (options.readFile ?? ((p: string) => readFileSync(p, "utf8")))(parsed.bodyFile);
	} catch (error) {
		return fail(stderr, {
			step: "pr-body",
			observed: `cannot read --body-file \`${parsed.bodyFile}\`: ${message(error)}`,
		});
	}

	// The base is the repository's own default branch, read from the forge:
	// what `gh pr create` did, and what a repository whose
	// default is `master` or a release branch needs. Read BEFORE the receipt and
	// the push (round 3 P1): a branch that IS the default would push and then
	// fail on a same-head-and-base create, with the branch already on the remote.
	let base: string;
	try {
		base = await forge.getDefaultBranch(pre.repo);
	} catch (error) {
		return fail(stderr, {
			step: "preflight/base",
			observed: `cannot read the default branch of ${pre.repo}: ${message(error)}`,
		});
	}
	if (pre.branch === base) {
		return fail(stderr, {
			step: "preflight/base",
			observed: `refusing to land from \`${pre.branch}\`, the repository's default branch`,
		});
	}

	// The receipt child runs the validator from the TRUSTED checkout resolved
	// above, with the worktree as its cwd: it is the one
	// child handed the forge token, and the candidate branch's own
	// `src/index.ts` must never run with it.
	const receipt = await run(
		runner,
		["bun", `${validatorRoot}/src/index.ts`, "prepush", "validate"],
		{ forgeCredential: true, cwd: parsed.worktree },
	);
	if (receipt.code !== 0) {
		return fail(stderr, {
			step: "receipt",
			observed: `prepush validate failed: ${receipt.stderr || receipt.stdout}`,
		});
	}

	const pushed = await push(runner, parsed.worktree, pre.branch);
	if (pushed !== undefined) return fail(stderr, pushed);

	const pr = await openAndMerge(forge, parsed, { repo: pre.repo, branch: pre.branch, base }, body);
	if ("step" in pr) return fail(stderr, pr);

	const prVerdict = await verifyPr(forge, pre.repo, pr.number);
	if ("step" in prVerdict) return fail(stderr, prVerdict);

	let issueState = "n/a (no --issue given)";
	if (parsed.issue !== undefined) {
		const issueVerdict = await verifyIssue(forge, pre.repo, parsed.issue);
		if ("step" in issueVerdict) return fail(stderr, issueVerdict);
		issueState = `#${parsed.issue} ${issueVerdict.state}`;
	}

	const tornDown = await teardown(runner, pre.primary, parsed.worktree, stdout);
	if (tornDown !== undefined) return fail(stderr, tornDown);

	stdout("land: receipt summary");
	stdout(`  branch:    ${pre.branch}`);
	stdout(`  head:      ${pre.head}`);
	stdout(`  pr:        ${pr.url}`);
	stdout(`  merge-sha: ${prVerdict.mergeSha}`);
	stdout(`  issue:     ${issueState}`);
	stdout(`  worktree:  ${parsed.worktree} removed`);
	return 0;
}

/**
 * The real execution boundary: spawn the command, capture both streams, and
 * report a spawn failure as a non-zero result rather than throwing — a thrown
 * spawn error mid-sequence would lose the step context the sequence prints.
 */
/**
 * A forge credential variable: any name carrying a forge-token stem as a whole
 * `_`-delimited segment, case-insensitively. Exact names alone were
 * not enough: the fleet exports organization-scoped tokens
 * (`FORGEJO_TOKEN_RODADDY`, `FORGEJO_TOKEN_RTECH`, …), `FORGEJO_TOKEN_FILE`
 * points at one, and `FORGE_TOKEN` is read by the hosted-app lane, so each of
 * them crossed into every child. The `_`/edge anchoring keeps an unrelated
 * name such as `HIGH_TOKEN` from matching the `GH_TOKEN` stem.
 */
const CREDENTIAL_VARIABLE = /(?:^|_)(?:FORGEJO|FORGE|GITHUB|GH)_TOKEN(?:_|$)/i;

export function isForgeCredentialVariable(name: string): boolean {
	return CREDENTIAL_VARIABLE.test(name);
}

/**
 * The environment a child is spawned with: the parent's, minus every forge
 * credential variable, plus `FORGEJO_TOKEN` ONLY for a child that was asked
 * for it (PR #690 review round 2 P1). Pure, so a test can prove the token is
 * absent for git and present for the receipt child without spawning either.
 */
export function childEnvironment(
	base: Record<string, string | undefined>,
	token: string,
	forgeCredential: boolean,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(base)) {
		if (value === undefined || isForgeCredentialVariable(key)) continue;
		env[key] = value;
	}
	if (forgeCredential) env.FORGEJO_TOKEN = token;
	return env;
}

export const spawnRunnerWith =
	(token: string): CommandRunner =>
	async (argv, opts) => {
		try {
			const proc = Bun.spawn([...argv], {
				stdout: "pipe",
				stderr: "pipe",
				cwd: opts?.cwd,
				env: childEnvironment(process.env, token, opts?.forgeCredential === true),
			});
			const [stdout, stderr] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
			]);
			const code = await proc.exited;
			return { code, stdout, stderr };
		} catch (error) {
			return { code: 127, stdout: "", stderr: message(error) };
		}
	};

if (import.meta.main) {
	// A top-level `await` with NO `.catch` exits 0 on crash — a named trap in
	// `scripts/done-means/README.md` rule 7, and it would make this verb report a
	// successful landing while having landed nothing. Both the resolved code and
	// a thrown error map to a non-zero exit, and the error is printed rather than
	// swallowed.
	main()
		.then((code) => {
			process.exitCode = code;
		})
		.catch((error: unknown) => {
			console.error(`land: crashed: ${message(error)}`);
			process.exitCode = 1;
		});
}

/**
 * The CLI entry's own wiring, kept out of `land` so the sequence never resolves
 * a credential. A missing token refuses with exit 2 — grouped with the other
 * invocation refusals — before any command runs, and the token value itself
 * reaches only the client constructor: never an argv, a log line, or an error.
 */
async function main(): Promise<number> {
	const token = resolveTokenOrRefuse();
	if (token === undefined) return 2;
	const cloneBase = process.env.FORGEJO_CLONE_BASE ?? DEFAULT_CLONE_BASE;
	// The API URL is where the token goes: HTTPS, on the clone base's host, or
	// refuse with exit 2 before any client exists.
	const api = approvedApiUrl(cloneBase, process.env.FORGEJO_API_URL);
	if (!api.ok) {
		console.error(`land: ${api.error}`);
		return 2;
	}
	return land({
		runner: spawnRunnerWith(token),
		forge: forgejoLandForge(token, api.url),
		args: Bun.argv.slice(2),
		stdout: (line) => console.log(line),
		stderr: (line) => console.error(line),
		cloneBase,
	});
}

/** Read the forge token, printing the refusal (never the value) when absent. */
function resolveTokenOrRefuse(): string | undefined {
	// The resolver reads `FORGEJO_TOKEN` and returns a bounded failure whose text
	// never carries the value. Only this entry ever touches a credential.
	const resolved = resolveForgejoToken();
	if (resolved.ok) return resolved.token;
	console.error(`land: ${resolved.error}`);
	return undefined;
}
