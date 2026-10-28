/**
 * @module tests/scripts/land
 * @description Tests for the machine-owned `land` verb (ledger L-004;
 *   ported to the Forgejo API on sf#415).
 *
 *   L-004's finding is that "the head never absorbs lane work" was violated four
 *   times in one day on a sequence containing ZERO judgment. The fix dissolves
 *   the work rather than policing it, so what these tests must pin is the
 *   SEQUENCE — not the individual git commands, which are ordinary. Four
 *   properties carry the whole value:
 *
 *   1. **Refusals fire before anything mutates.** A preflight that runs after a
 *      push has already happened is not a preflight. Every refusal test asserts
 *      the call log contains no mutating call, so a reordering regression is
 *      visible even when the exit code stays correct.
 *   2. **A failed step stops the sequence HARD.** Failed validate → push never
 *      invoked; failed merge → teardown never invoked. Both are asserted against
 *      the call log rather than against stdout, because a message is easy to
 *      keep correct while the behaviour drifts.
 *   3. **The push shape obeys standing ruling 1.** Fully-qualified refspec on
 *      both sides, no `--force` and no `--mirror` in ANY argv of ANY call. The
 *      credential lane is deliberately over-privileged, so shape is the control
 *      that still works when privilege does not.
 *   4. **Every forge call addresses the slug derived from origin.** The slug
 *      comes from the worktree's own remote, never from the process working
 *      directory, and an origin on any other host refuses BEFORE the push.
 *
 *   No test touches real git or a live forge. Both boundaries are injected, and
 *   both fakes FAIL LOUDLY on an unscripted call rather than returning a
 *   default — a fake that answers "not scripted" as success would let the
 *   sequence measure its own harness (`scripts/done-means/README.md` rule 7),
 *   which is the exact shape this repo has already paid for.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join, resolve } from "node:path";
import {
	childEnvironment,
	isForgeCredentialVariable,
	land,
	parseOriginSlug,
	spawnRunnerWith,
} from "../../scripts/land";
import type { CommandResult, CommandRunner, LandForge, RunOptions } from "../../scripts/land";

/** One recorded command invocation: the full argv, as issued. */
type Call = string[];

/** The script under test, addressed absolutely so cwd never selects it. */
const SCRIPT = join(import.meta.dir, "..", "..", "scripts", "land.ts");

/**
 * One scripted response, matched against a call by a predicate over its argv.
 * A predicate rather than a string key because the interesting assertions are
 * about argv SHAPE (does any argv carry `--force`), and a key would force every
 * fixture to restate the exact command line the implementation happens to emit.
 */
interface Script {
	readonly when: (argv: Call) => boolean;
	readonly result: Partial<CommandResult>;
}

/**
 * Build a fake runner plus its call log.
 *
 * The unscripted behaviour is the point: an unmatched call THROWS. A fake that
 * returned `{ code: 0 }` for anything it did not recognise would make every
 * sequence test pass regardless of what the sequence actually ran, and would
 * turn a renamed step into a silent green. Rule 7 — a clause must not measure
 * its own harness.
 */
function fakeRunner(scripts: readonly Script[] = []): {
	runner: CommandRunner;
	calls: Call[];
	credentialed: Call[];
	optsOf: (RunOptions | undefined)[];
} {
	const calls: Call[] = [];
	// Every call that asked for the forge credential.
	const credentialed: Call[] = [];
	// The options each call was made with, aligned with `calls` by index.
	const optsOf: (RunOptions | undefined)[] = [];
	const runner: CommandRunner = async (argv, opts?: RunOptions) => {
		const recorded: Call = [...argv];
		calls.push(recorded);
		optsOf.push(opts);
		if (opts?.forgeCredential === true) credentialed.push(recorded);
		const match = scripts.find((s) => s.when(recorded));
		if (match === undefined) {
			throw new Error(`land test fake: unscripted call ${JSON.stringify(argv)}`);
		}
		return { code: 0, stdout: "", stderr: "", ...match.result };
	};
	return { runner, calls, credentialed, optsOf };
}

/** One recorded forge call: which method, which repository, and its arguments. */
interface ForgeCall {
	readonly method: string;
	readonly slug: string;
	readonly args: readonly unknown[];
}

/** What each forge method answers with, when the fixture scripts it at all. */
interface ForgeScript {
	readonly getDefaultBranch?: string | Error;
	readonly createPullRequest?: { number: number; url: string } | Error;
	readonly mergePullRequest?:
		| { merged: true; sha: string }
		| { merged: false; reason: string }
		| Error;
	readonly getPullRequestMergeState?: { merged: boolean; mergeCommitSha: string | null } | Error;
	readonly getIssueState?: { state: string } | Error;
}

/**
 * Build a fake forge plus its call log.
 *
 * Same contract as the runner fake and for the same reason: a method the
 * fixture did not script THROWS, so a sequence that reached a forge step it was
 * not supposed to reach fails loudly instead of sailing past on a default
 * success. This is the trap the ported tests are most exposed to — the forge
 * boundary has four methods where the old shape had one command name, and a
 * permissive fake would make every ordering assertion vacuous.
 */
function fakeForge(script: ForgeScript = {}): { forge: LandForge; forgeCalls: ForgeCall[] } {
	const forgeCalls: ForgeCall[] = [];
	function answer<T>(method: keyof ForgeScript, slug: string, args: readonly unknown[]): T {
		forgeCalls.push({ method, slug, args });
		const value = script[method];
		if (value === undefined) {
			throw new Error(`land test forge: unscripted ${method}(${slug}, ${JSON.stringify(args)})`);
		}
		if (value instanceof Error) throw value;
		return value as T;
	}
	const forge: LandForge = {
		async getDefaultBranch(slug) {
			return answer("getDefaultBranch", slug, []);
		},
		async createPullRequest(slug, pr) {
			return answer("createPullRequest", slug, [pr]);
		},
		async mergePullRequest(slug, number) {
			return answer("mergePullRequest", slug, [number]);
		},
		async getPullRequestMergeState(slug, number) {
			return answer("getPullRequestMergeState", slug, [number]);
		},
		async getIssueState(slug, number) {
			return answer("getIssueState", slug, [number]);
		},
	};
	return { forge, forgeCalls };
}

/** Match a call by its first two tokens, ignoring `-C <path>` when present. */
function verb(argv: Call): string {
	if (argv[0] === "git" && argv[1] === "-C") return `git ${argv[3] ?? ""}`;
	return `${argv[0] ?? ""} ${argv[1] ?? ""}`;
}

/** True when the call log holds a call whose verb matches `name`. */
function called(calls: readonly Call[], name: string): boolean {
	return calls.some((c) => verb(c) === name);
}

const WORKTREE = "/fixture/worktrees/l004";
const PRIMARY = "/fixture/software-factory";
/**
 * The checkout this test file (and so `scripts/land.ts`) lives in: the
 * default validator root, stated independently of the
 * script's own derivation so a regression to "wherever the child runs" shows.
 */
const THIS_CHECKOUT = resolve(import.meta.dir, "..", "..");
const CLONE_BASE = "https://forge.example.internal";
const PR_URL = "https://forge.example.internal/rodaddy/software-factory/pulls/999";
const PR_NUMBER = 999;
const MERGE_SHA = "feed0000";
const BODY = "the pull request body, read from --body-file\n";

/**
 * The origin URL the happy-path fixture scripts, in the SSH form a Forgejo
 * remote is commonly written in. The slug every forge call addresses is DERIVED
 * from this string, so the fixture states the URL and the assertions state the
 * derived slug; a test that hard-coded both independently would pass with the
 * parser removed.
 */
const ORIGIN_SSH = "git@forge.example.internal:rodaddy/software-factory.git";
const ORIGIN_SLUG = "rodaddy/software-factory";

/**
 * What `git worktree list --porcelain` prints from a checkout that owns the
 * fixture worktree: the primary first, then the linked worktree. The
 * registration check reads THIS, from the trusted side, never the worktree's
 * own metadata.
 */
const REGISTERED_PORCELAIN = [
	`worktree ${PRIMARY}`,
	"HEAD 0000000000000000000000000000000000000000",
	"branch refs/heads/main",
	"",
	`worktree ${WORKTREE}`,
	"HEAD abc1234def5678",
	"branch refs/heads/feat/l004-land-verb",
	"",
	"",
].join("\n");

/** Match the registration probe: a porcelain worktree list. */
function isRegistrationProbe(argv: Call): boolean {
	return argv.includes("worktree") && argv.includes("list") && argv.includes("--porcelain");
}

/** Match the `git remote get-url origin` probe wherever it appears in a log. */
function isRemoteProbe(argv: Call): boolean {
	return argv.includes("remote") && argv.includes("get-url");
}

/**
 * The default happy-path command script: every git command the full sequence
 * issues, each answered with the output a successful run would produce.
 * Individual tests override one entry to drive a specific failure, so a failure
 * fixture differs from the happy path by exactly the clause under test.
 */
function happyScripts(overrides: readonly Script[] = []): Script[] {
	return [
		...overrides,
		// Preflight probes.
		{
			when: (a) => a.includes("rev-parse") && a.includes("--is-inside-work-tree"),
			result: { stdout: "true\n" },
		},
		{
			when: (a) => a.includes("rev-parse") && a.includes("--git-common-dir"),
			result: { stdout: `${PRIMARY}/.git\n` },
		},
		{ when: (a) => a.includes("status") && a.includes("--porcelain"), result: { stdout: "" } },
		{ when: (a) => a.includes("symbolic-ref"), result: { stdout: "feat/l004-land-verb\n" } },
		{
			when: (a) => a.includes("rev-parse") && a.includes("HEAD"),
			result: { stdout: "abc1234def5678\n" },
		},
		// Origin URL: the slug every forge call addresses comes from here,
		// never from the ambient process cwd.
		{ when: isRemoteProbe, result: { stdout: `${ORIGIN_SSH}\n` } },
		// Receipt.
		{ when: (a) => a.includes("prepush"), result: { stdout: "receipt ok\n" } },
		// Push.
		{ when: (a) => a.includes("push"), result: { stdout: "" } },
		// Registration (round 7 P0): the trusted checkout's own worktree list
		// names the target. Scripted BEFORE the teardown list so the porcelain
		// form is answered here and the human form by the entry below.
		{ when: isRegistrationProbe, result: { stdout: REGISTERED_PORCELAIN } },
		// Teardown.
		{ when: (a) => a.includes("worktree") && a.includes("remove"), result: { stdout: "" } },
		{
			when: (a) => a.includes("worktree") && a.includes("list"),
			result: { stdout: `${PRIMARY}  abc1234 [main]\n` },
		},
	];
}

/** The forge script a fully successful landing produces. */
function happyForge(overrides: ForgeScript = {}): ForgeScript {
	return {
		getDefaultBranch: "main",
		createPullRequest: { number: PR_NUMBER, url: PR_URL },
		mergePullRequest: { merged: true, sha: MERGE_SHA },
		getPullRequestMergeState: { merged: true, mergeCommitSha: MERGE_SHA },
		getIssueState: { state: "closed" },
		...overrides,
	};
}

/**
 * A cwd OUTSIDE the fixture worktree, used by every test that is not about the
 * cwd refusal. Stated explicitly rather than inherited from `process.cwd()`:
 * the suite itself runs inside a worktree, and a test whose outcome depends on
 * where the test runner was launched is a flake generator.
 */
const OUTSIDE_CWD = "/fixture/elsewhere";

/** Run `land` with the standard fixture args plus any extras. */
async function runLand(
	scripts: readonly Script[],
	extraArgs: readonly string[] = [],
	cwd: string = OUTSIDE_CWD,
	forgeScript: ForgeScript = happyForge(),
): Promise<{
	code: number;
	calls: Call[];
	optsOf: (RunOptions | undefined)[];
	forgeCalls: ForgeCall[];
	stdout: string;
	stderr: string;
}> {
	const { runner, calls, optsOf } = fakeRunner(scripts);
	const { forge, forgeCalls } = fakeForge(forgeScript);
	const out: string[] = [];
	const err: string[] = [];
	const code = await land({
		runner,
		forge,
		cwd,
		cloneBase: CLONE_BASE,
		validatorRoot: PRIMARY,
		readFile: () => BODY,
		args: [
			"--worktree",
			WORKTREE,
			"--title",
			"feat: fixture",
			"--body-file",
			"/fixture/body.md",
			...extraArgs,
		],
		stdout: (line) => out.push(line),
		stderr: (line) => err.push(line),
	});
	return { code, calls, optsOf, forgeCalls, stdout: out.join("\n"), stderr: err.join("\n") };
}

/** Mutating git verbs: anything that changes state outside the worktree's read. */
const MUTATING = ["git push", "git worktree"];

/**
 * The four forge methods, listed so a refusal clause asserts each by NAME
 * rather than only that the log is empty — a fifth method added later is then
 * covered by the same clause the four are.
 */
const FORGE_METHODS = [
	"getDefaultBranch",
	"createPullRequest",
	"mergePullRequest",
	"getPullRequestMergeState",
	"getIssueState",
];

/** Assert the log holds no mutating git call and no forge call of ANY kind. */
function expectNothingMutated(calls: readonly Call[], forgeCalls: readonly ForgeCall[]): void {
	for (const call of calls) {
		// The registration probe (round 7 P0) is `git worktree list --porcelain`:
		// a read, and the one `git worktree` form a refusal may legitimately log.
		if (isRegistrationProbe(call)) continue;
		expect(MUTATING.includes(verb(call))).toBe(false);
	}
	expect(called(calls, "git push")).toBe(false);
	for (const method of FORGE_METHODS) {
		expect(forgeCalls.some((c) => c.method === method)).toBe(false);
	}
	expect(forgeCalls).toHaveLength(0);
}

describe("land — argument validation refuses before any call", () => {
	async function refuse(args: readonly string[]): Promise<{ code: number; calls: Call[] }> {
		const { runner, calls } = fakeRunner(happyScripts());
		const { forge } = fakeForge(happyForge());
		const code = await land({
			runner,
			forge,
			args,
			cloneBase: CLONE_BASE,
			readFile: () => BODY,
			stdout: () => {},
			stderr: () => {},
		});
		return { code, calls };
	}

	test("a missing --worktree refuses and runs NOTHING", async () => {
		const { code, calls } = await refuse(["--title", "t", "--body-file", "/fixture/body.md"]);
		expect(code).not.toBe(0);
		expect(calls).toHaveLength(0);
	});

	test("a missing --title refuses and runs NOTHING", async () => {
		const { code, calls } = await refuse([
			"--worktree",
			WORKTREE,
			"--body-file",
			"/fixture/body.md",
		]);
		expect(code).not.toBe(0);
		expect(calls).toHaveLength(0);
	});

	test("a missing --body-file refuses and runs NOTHING", async () => {
		const { code, calls } = await refuse(["--worktree", WORKTREE, "--title", "t"]);
		expect(code).not.toBe(0);
		expect(calls).toHaveLength(0);
	});

	test("a non-integer --issue refuses and runs NOTHING", async () => {
		// The verify step's #226 lesson is that an inferred value mis-parses. The
		// issue number is validated as an integer at the boundary so nothing
		// downstream interpolates caller text into a forge path.
		const { code, calls } = await refuse([
			"--worktree",
			WORKTREE,
			"--title",
			"t",
			"--body-file",
			"/fixture/body.md",
			"--issue",
			"12; rm -rf /",
		]);
		expect(code).not.toBe(0);
		expect(calls).toHaveLength(0);
	});
});

describe("land — invocation from inside the target worktree refuses", () => {
	// Twice in one evening, by two different operator routes, a fully
	// successful landing reported `FAILED at teardown`: the verb was invoked with
	// its cwd inside the worktree it was landing — once by the controller running
	// it from that directory, once via `bun run --cwd <worktree> scripts/land.ts`,
	// which moves the process cwd inside the target even when the operator is
	// standing elsewhere. Step 7 removes that directory, so the next spawn
	// inherits a deleted cwd and `posix_spawn` reports ENOENT for the BINARY,
	// misdirecting diagnosis toward a missing `git`. Two routes into the same
	// state is why the fix is a refusal rather than operator discipline.

	test("cwd EQUAL to the target worktree refuses and runs NOTHING", async () => {
		const { code, calls, stderr } = await runLand(happyScripts(), [], WORKTREE);
		expect(code).toBe(2);
		expect(calls).toHaveLength(0);
		expect(stderr).toContain(WORKTREE);
	});

	test("cwd INSIDE the target worktree refuses and runs NOTHING", async () => {
		const inside = `${WORKTREE}/scripts/nested`;
		const { code, calls, stderr } = await runLand(happyScripts(), [], inside);
		expect(code).toBe(2);
		expect(calls).toHaveLength(0);
		expect(stderr).toContain(inside);
	});

	test("the refusal names the rule and BOTH paths", async () => {
		const inside = `${WORKTREE}/src`;
		const { stderr } = await runLand(happyScripts(), [], inside);
		expect(stderr).toContain("cwd");
		expect(stderr).toContain(inside);
		expect(stderr).toContain(WORKTREE);
	});

	test("the refusal fires BEFORE the argument-validated steps, not after them", async () => {
		// Asserted as the absence of every step, mutating or read-only: the ticket's
		// clause is "refuse before ANY step". A refusal that still ran the preflight
		// probes would be invisible to an exit-code-only assertion.
		const { calls, forgeCalls } = await runLand(happyScripts(), ["--issue", "232"], WORKTREE);
		expect(called(calls, "git push")).toBe(false);
		expect(calls.some((c) => c.includes("prepush"))).toBe(false);
		expect(calls.some((c) => c.includes("rev-parse"))).toBe(false);
		expectNothingMutated(calls, forgeCalls);
	});

	test("control: an unrelated cwd, or a SIBLING sharing the name prefix, lands normally", async () => {
		// Rule 3 — a refusal group proves nothing without a healthy path.
		const { code, calls } = await runLand(happyScripts(), [], OUTSIDE_CWD);
		expect(code).toBe(0);
		expect(called(calls, "git push")).toBe(true);
		// The containment test is path-segment-wise, not `startsWith`: a sibling
		// `…/l004-notes` shares the prefix `…/l004` and is not inside it.
		const sibling = await runLand(happyScripts(), [], `${WORKTREE}-notes`);
		expect(sibling.code).toBe(0);
	});

	test("the check spawns nothing: a refusal with THROWING fakes still refuses", async () => {
		// done-means rule 7 — the containment test is a pure path comparison. A
		// runner scripted with NOTHING throws on any call, and the forge fake throws
		// on any method, so if the check consulted either boundary this test would
		// fail with a fake's error rather than return exit 2.
		const { runner, calls } = fakeRunner([]);
		const { forge, forgeCalls } = fakeForge({});
		const err: string[] = [];
		const code = await land({
			runner,
			forge,
			cwd: `${WORKTREE}/nested`,
			cloneBase: CLONE_BASE,
			readFile: () => BODY,
			args: ["--worktree", WORKTREE, "--title", "t", "--body-file", "/fixture/body.md"],
			stdout: () => {},
			stderr: (line) => err.push(line),
		});
		expect(code).toBe(2);
		expect(calls).toHaveLength(0);
		expect(forgeCalls).toHaveLength(0);
		expect(err.join("\n")).toContain(WORKTREE);
	});

	test("both paths are realpath-resolved before comparison; an unresolvable one falls back to the literal path", async () => {
		// A symlinked worktree path and a cwd expressed through the real path are
		// the same directory; comparing the strings as given would miss it.
		const realWorktree = "/fixture/real/l004";
		const { runner, calls } = fakeRunner(happyScripts());
		const { forge } = fakeForge(happyForge());
		const err: string[] = [];
		const code = await land({
			runner,
			forge,
			// The caller passes the SYMLINK path; the process cwd is the real one.
			cwd: `${realWorktree}/scripts`,
			realpath: (p) => (p === WORKTREE ? realWorktree : p),
			cloneBase: CLONE_BASE,
			readFile: () => BODY,
			args: ["--worktree", WORKTREE, "--title", "t", "--body-file", "/fixture/body.md"],
			stdout: () => {},
			stderr: (line) => err.push(line),
		});
		expect(code).toBe(2);
		expect(calls).toHaveLength(0);
		expect(err.join("\n")).toContain(realWorktree);

		// `realpathSync` throws ENOENT on a path that does not exist. The verb must
		// still reach its own `preflight/worktree` refusal, which names the missing
		// worktree properly, instead of dying on the containment check.
		const missing = await runLand(
			happyScripts([
				{
					when: (a) => a.includes("rev-parse") && a.includes("--is-inside-work-tree"),
					result: { code: 128, stderr: "fatal: not a git repository\n" },
				},
			]),
			[],
			OUTSIDE_CWD,
		);
		expect(missing.code).not.toBe(2);
		expect(missing.stderr).toContain("worktree");
		expect(missing.calls.length).toBeGreaterThan(0);
	});
});

describe("land — preflight refusals fire before any mutation", () => {
	test("a path that is not a registered worktree refuses, nothing mutated", async () => {
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts([
				{
					when: (a) => a.includes("rev-parse") && a.includes("--is-inside-work-tree"),
					result: { code: 128, stderr: "fatal: not a git repository\n" },
				},
			]),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("worktree");
		expectNothingMutated(calls, forgeCalls);
	});

	test("a dirty tree refuses, nothing mutated", async () => {
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts([
				{
					when: (a) => a.includes("status") && a.includes("--porcelain"),
					result: { stdout: " M scripts/land.ts\n?? notes.txt\n" },
				},
			]),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("clean");
		// The observed state is printed, not just the verdict.
		expect(stderr).toContain("scripts/land.ts");
		expectNothingMutated(calls, forgeCalls);
	});

	test("a detached HEAD refuses, nothing mutated", async () => {
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts([
				{
					when: (a) => a.includes("symbolic-ref"),
					result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref\n" },
				},
			]),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("detached");
		expectNothingMutated(calls, forgeCalls);
	});

	test("branch `main` refuses, nothing mutated", async () => {
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts([{ when: (a) => a.includes("symbolic-ref"), result: { stdout: "main\n" } }]),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("main");
		expectNothingMutated(calls, forgeCalls);
	});

	test("branch `master` refuses, nothing mutated", async () => {
		const { code, calls, forgeCalls } = await runLand(
			happyScripts([{ when: (a) => a.includes("symbolic-ref"), result: { stdout: "master\n" } }]),
		);
		expect(code).not.toBe(0);
		expectNothingMutated(calls, forgeCalls);
	});

	test("control: the same fixture with a feature branch reaches the push", async () => {
		const { code, calls } = await runLand(happyScripts());
		expect(code).toBe(0);
		expect(called(calls, "git push")).toBe(true);
	});
});

describe("land — the PR body is read before the push, never after it", () => {
	// The body reaches the forge as a VALUE, so the read is a step that can fail.
	// Placed after the preflight and before the push, an unreadable file refuses
	// with nothing on the remote; placed after the push it would leave the branch
	// pushed with no PR — the same half-landed state #235 was reported from.

	test("an unreadable --body-file refuses BEFORE the push and before any forge call", async () => {
		const { runner, calls } = fakeRunner(happyScripts());
		const { forge, forgeCalls } = fakeForge(happyForge());
		const err: string[] = [];
		const code = await land({
			runner,
			forge,
			cwd: OUTSIDE_CWD,
			validatorRoot: PRIMARY,
			cloneBase: CLONE_BASE,
			readFile: () => {
				throw new Error("ENOENT: no such file or directory, open '/fixture/body.md'");
			},
			args: ["--worktree", WORKTREE, "--title", "t", "--body-file", "/fixture/body.md"],
			stdout: () => {},
			stderr: (line) => err.push(line),
		});
		expect(code).not.toBe(0);
		expect(called(calls, "git push")).toBe(false);
		expect(calls.some((c) => c.includes("prepush"))).toBe(false);
		expect(forgeCalls).toHaveLength(0);
		expect(err.join("\n")).toContain("pr-body");
		expect(err.join("\n")).toContain("/fixture/body.md");
	});

	test("the body CONTENTS, not the path, are what the create receives", async () => {
		// A create that passed the path through would open a PR whose body is the
		// literal string `/fixture/body.md`.
		const { code, forgeCalls } = await runLand(happyScripts());
		expect(code).toBe(0);
		const create = forgeCalls.find((c) => c.method === "createPullRequest");
		const pr = create?.args[0] as { body?: string; head?: string; base?: string; title?: string };
		expect(pr?.body).toBe(BODY);
		expect(pr?.base).toBe("main");
		expect(pr?.title).toBe("feat: fixture");
	});

	test("the base is the repository's default branch as the forge reports it", async () => {
		const { code, forgeCalls } = await runLand(
			happyScripts(),
			[],
			OUTSIDE_CWD,
			happyForge({ getDefaultBranch: "master" }),
		);
		expect(code).toBe(0);
		const create = forgeCalls.find((c) => c.method === "createPullRequest");
		const pr = create?.args[0] as { base?: string } | undefined;
		expect(pr?.base).toBe("master");
	});

	test("no default branch from the forge stops the sequence before receipt, push and create", async () => {
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts(),
			[],
			OUTSIDE_CWD,
			happyForge({ getDefaultBranch: new Error("no default branch") }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("preflight/base");
		expect(calls.some((c) => c.includes("prepush"))).toBe(false);
		expect(called(calls, "git push")).toBe(false);
		expect(forgeCalls.some((c) => c.method === "createPullRequest")).toBe(false);
	});

	test("only the prepush receipt child is handed the forge credential", async () => {
		const { runner, calls, credentialed } = fakeRunner(happyScripts());
		const { forge } = fakeForge(happyForge());
		const code = await land({
			runner,
			forge,
			args: ["--worktree", WORKTREE, "--title", "feat: fixture", "--body-file", "/fixture/body.md"],
			stdout: () => {},
			stderr: () => {},
			cwd: OUTSIDE_CWD,
			cloneBase: CLONE_BASE,
			validatorRoot: PRIMARY,
			readFile: () => BODY,
		});
		expect(code).toBe(0);
		expect(called(calls, "git push")).toBe(true);
		expect(credentialed).toHaveLength(1);
		expect(credentialed[0]).toContain("prepush");
	});
});

describe("spawnRunnerWith: the real spawn boundary", () => {
	test("a credentialed child sees FORGEJO_TOKEN, a plain child sees no credential, and cwd is honoured", async () => {
		// A real spawn of `env` and `pwd`, so the environment and cwd proven here
		// are the ones a child actually receives, not the ones the fake recorded.
		// Assert on variable NAMES only. A failing matcher prints what it received,
		// and the raw `env` output carries the real inherited values (SOF-3156).
		const names = (stdout: string, part: string): string[] =>
			stdout
				.split("\n")
				.map((line) => line.slice(0, line.indexOf("=")))
				.filter((name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && name.includes(part));
		const runner = spawnRunnerWith("spawn-test-secret");
		const plain = await runner(["/usr/bin/env"]);
		expect(plain.code).toBe(0);
		expect(names(plain.stdout, "FORGEJO_TOKEN")).toEqual([]);
		expect(names(plain.stdout, "GITHUB_TOKEN")).toEqual([]);
		expect(names(plain.stdout, "GH_TOKEN")).toEqual([]);
		const credentialed = await runner(["/usr/bin/env"], { forgeCredential: true });
		expect(credentialed.stdout.split("\n").includes("FORGEJO_TOKEN=spawn-test-secret")).toBe(true);
		const where = await runner(["pwd"], { cwd: "/" });
		expect(where.stdout.trim()).toBe("/");
		const missing = await runner(["/nonexistent/binary"]);
		expect(missing.code).not.toBe(0);
	});
});

describe("childEnvironment", () => {
	test("strips every forge credential and adds FORGEJO_TOKEN only when asked", () => {
		const base = {
			PATH: "/bin",
			FORGEJO_TOKEN: "inherited",
			GITHUB_TOKEN: "gh1",
			GH_TOKEN: "gh2",
			HOME: "/h",
		};
		const plain = childEnvironment(base, "secret", false);
		expect(plain).toEqual({ PATH: "/bin", HOME: "/h" });
		const receipt = childEnvironment(base, "secret", true);
		expect(receipt).toEqual({ PATH: "/bin", HOME: "/h", FORGEJO_TOKEN: "secret" });
	});

	test("strips organization-scoped and variant forge credentials too", () => {
		// Synthetic values only: the fleet exports FORGEJO_TOKEN_<ORG> per
		// organization, and exact-name matching let every one reach every child.
		const base = {
			PATH: "/bin",
			HOME: "/h",
			FORGEJO_TOKEN_RODADDY: "synthetic-1",
			FORGEJO_TOKEN_RTECH: "synthetic-2",
			FORGEJO_TOKEN_KING: "synthetic-3",
			FORGEJO_TOKEN_ACME: "synthetic-4",
			FORGEJO_TOKEN_GLOBAL: "synthetic-5",
			FORGEJO_TOKEN_FILE: "/synthetic/path",
			FORGE_TOKEN: "synthetic-6",
			GITHUB_TOKEN_MIRROR: "synthetic-7",
			forgejo_token: "synthetic-8",
			HIGH_TOKEN: "not-a-forge-credential",
			FORGEJO_API_URL: "https://forge.example",
		};
		const kept = {
			PATH: "/bin",
			HOME: "/h",
			HIGH_TOKEN: "not-a-forge-credential",
			FORGEJO_API_URL: "https://forge.example",
		};
		expect(childEnvironment(base, "secret", false)).toEqual(kept);
		// The credentialed child gets exactly the one token it asked for, never
		// an unrelated organization's.
		expect(childEnvironment(base, "secret", true)).toEqual({ ...kept, FORGEJO_TOKEN: "secret" });
		expect(isForgeCredentialVariable("GH_TOKEN")).toBe(true);
		expect(isForgeCredentialVariable("FORGEJO_API_URL")).toBe(false);
	});
});

describe("spawnRunnerWith: scoped credentials do not cross the real spawn", () => {
	const SCOPED = ["FORGEJO_TOKEN_SYNTHETICORG", "FORGE_TOKEN", "GITHUB_TOKEN_SYNTHETIC"] as const;
	const saved = new Map<string, string | undefined>();
	beforeEach(() => {
		for (const name of SCOPED) {
			saved.set(name, process.env[name]);
			process.env[name] = "synthetic-scoped-value";
		}
	});
	afterEach(() => {
		for (const name of SCOPED) {
			const prior = saved.get(name);
			if (prior === undefined) delete process.env[name];
			else process.env[name] = prior;
		}
	});

	test("neither the plain nor the credentialed child sees a synthetic scoped token", async () => {
		// NAMES only, never values: a failing matcher prints what it received.
		const names = (stdout: string): string[] =>
			stdout
				.split("\n")
				.map((line) => line.slice(0, line.indexOf("=")))
				.filter((name) => (SCOPED as readonly string[]).includes(name));
		const runner = spawnRunnerWith("spawn-test-secret");
		const plain = await runner(["/usr/bin/env"]);
		expect(plain.code).toBe(0);
		expect(names(plain.stdout)).toEqual([]);
		const credentialed = await runner(["/usr/bin/env"], { forgeCredential: true });
		expect(credentialed.code).toBe(0);
		expect(names(credentialed.stdout)).toEqual([]);
	});
});

describe("land — the receipt gates the push", () => {
	test("a failed prepush validate aborts BEFORE push is ever invoked", async () => {
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts([
				{
					when: (a) => a.includes("prepush"),
					result: { code: 1, stderr: "receipt: HEAD is not clean\n" },
				},
			]),
		);
		expect(code).not.toBe(0);
		expect(called(calls, "git push")).toBe(false);
		// The default-branch read precedes the receipt (round 3 P1); nothing else.
		expect(forgeCalls.map((c) => c.method)).toEqual(["getDefaultBranch"]);
		expect(stderr).toContain("receipt");
		expect(stderr).toContain("HEAD is not clean");
	});

	test("an explicit validatorRoot that owns the worktree runs its validator with the worktree as cwd", async () => {
		// The receipt child is the one child handed the forge token, so the code
		// it runs is this script's own checkout, never the candidate branch's
		// src/index.ts; the worktree is only its working directory, so the SHA it
		// binds is still the one being pushed.
		const { calls, optsOf } = await runLand(happyScripts());
		const at = calls.findIndex((c) => c.includes("prepush"));
		expect(at).toBeGreaterThanOrEqual(0);
		expect(calls[at]).toEqual(["bun", `${PRIMARY}/src/index.ts`, "prepush", "validate"]);
		expect(calls[at]?.some((token) => token.includes(WORKTREE))).toBe(false);
		expect(optsOf[at]).toEqual({ forgeCredential: true, cwd: WORKTREE });
	});

	test("with no validatorRoot, the receipt runs THIS script's own checkout, and only for a worktree of that checkout (PR #690 rounds 4 and 6 P0)", async () => {
		// The trusted root is the checkout land.ts itself was run from, never
		// anything read off the target worktree's git metadata. The worktree must
		// be a linked worktree OF that checkout; here its common dir says so.
		const { runner, calls, optsOf } = fakeRunner(
			happyScripts([
				{
					when: (a) => a.includes("rev-parse") && a.includes("--git-common-dir"),
					result: { stdout: `${THIS_CHECKOUT}/.git\n` },
				},
			]),
		);
		const { forge } = fakeForge(happyForge());
		const code = await land({
			runner,
			forge,
			cwd: OUTSIDE_CWD,
			cloneBase: CLONE_BASE,
			realpath: (p) => p,
			readFile: () => BODY,
			args: ["--worktree", WORKTREE, "--title", "t", "--body-file", "/fixture/body.md"],
			stdout: () => {},
			stderr: () => {},
		});
		expect(code).toBe(0);
		const at = calls.findIndex((c) => c.includes("prepush"));
		expect(at).toBeGreaterThanOrEqual(0);
		expect(calls[at]).toEqual(["bun", `${THIS_CHECKOUT}/src/index.ts`, "prepush", "validate"]);
		expect(optsOf[at]).toEqual({ forgeCredential: true, cwd: WORKTREE });
	});

	test.each([
		["no validatorRoot, worktree of another checkout", undefined],
		["an explicit validatorRoot that does not own the worktree", "/fixture/other-checkout"],
	])(
		"%s refuses before any forge call: the receipt never runs a checkout the worktree's metadata named (PR #690 round 6 P0)",
		async (_name, validatorRoot) => {
			// The fixture worktree's common dir names PRIMARY. A validator that is
			// not PRIMARY must refuse: either the worktree belongs to an untrusted
			// repository, or the operator pointed the receipt at the wrong tree.
			const { runner, calls } = fakeRunner(happyScripts());
			const { forge, forgeCalls } = fakeForge(happyForge());
			const err: string[] = [];
			const code = await land({
				runner,
				forge,
				cwd: OUTSIDE_CWD,
				cloneBase: CLONE_BASE,
				validatorRoot,
				realpath: (p) => p,
				readFile: () => BODY,
				args: ["--worktree", WORKTREE, "--title", "t", "--body-file", "/fixture/body.md"],
				stdout: () => {},
				stderr: (line) => err.push(line),
			});
			expect(code).not.toBe(0);
			expect(err.join("\n")).toContain("preflight/validator");
			expect(err.join("\n")).toContain(PRIMARY);
			expect(calls.some((c) => c.includes("prepush"))).toBe(false);
			expect(forgeCalls).toHaveLength(0);
		},
	);

	test("registration is proved from the TRUSTED checkout with `worktree list --porcelain`, before the receipt", async () => {
		// The common-dir probe reads the worktree's own `.git` file, which the
		// candidate controls: a `gitdir:` pointing at a crafted directory whose
		// `commondir` names the trusted checkout passes that probe without the
		// worktree being registered anywhere. The trusted side has to say so.
		const { calls } = await runLand(happyScripts());
		const at = calls.findIndex(isRegistrationProbe);
		expect(at).toBeGreaterThanOrEqual(0);
		expect(calls[at]?.slice(0, 3)).toEqual(["git", "-C", PRIMARY]);
		expect(calls[at]?.some((token) => token.includes(WORKTREE))).toBe(false);
		const receipt = calls.findIndex((c) => c.includes("prepush"));
		expect(receipt).toBeGreaterThan(at);
	});

	test.each([
		["lists only the primary", `worktree ${PRIMARY}\nHEAD 0000\nbranch refs/heads/main\n\n`],
		["lists a sibling, not the target", `worktree ${PRIMARY}\n\nworktree ${WORKTREE}-other\n\n`],
		["is empty", ""],
	])(
		"a worktree whose metadata names the trusted checkout but whose trusted-side list %s refuses before any forge call (PR #690 round 7 P0)",
		async (_name, porcelain) => {
			const { code, calls, forgeCalls, stderr } = await runLand(
				happyScripts([{ when: isRegistrationProbe, result: { stdout: porcelain } }]),
			);
			expect(code).not.toBe(0);
			expect(stderr).toContain("preflight/validator");
			expect(stderr).toContain(WORKTREE);
			expect(calls.some((c) => c.includes("prepush"))).toBe(false);
			expectNothingMutated(calls, forgeCalls);
		},
	);

	test("a failing trusted-side list refuses rather than passing on an empty answer", async () => {
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts([
				{
					when: isRegistrationProbe,
					result: { code: 128, stderr: "fatal: not a git repository\n" },
				},
			]),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("preflight/validator");
		expect(stderr).toContain("not a git repository");
		expect(calls.some((c) => c.includes("prepush"))).toBe(false);
		expectNothingMutated(calls, forgeCalls);
	});

	test.each([WORKTREE, `${WORKTREE}/nested`])(
		"a validator root at or inside the worktree (%s) refuses before any forge call, receipt or push (PR #690 round 4 P0)",
		async (validatorRoot) => {
			const { runner, calls } = fakeRunner(happyScripts());
			const { forge, forgeCalls } = fakeForge(happyForge());
			const err: string[] = [];
			const code = await land({
				runner,
				forge,
				cwd: OUTSIDE_CWD,
				cloneBase: CLONE_BASE,
				validatorRoot,
				readFile: () => BODY,
				args: ["--worktree", WORKTREE, "--title", "t", "--body-file", "/fixture/body.md"],
				stdout: () => {},
				stderr: (line) => err.push(line),
			});
			expect(code).not.toBe(0);
			expect(err.join("\n")).toContain("preflight/validator");
			expect(calls.some((c) => c.includes("prepush"))).toBe(false);
			expect(called(calls, "git push")).toBe(false);
			expect(forgeCalls).toHaveLength(0);
		},
	);

	test("the validator root is realpath-resolved before the containment check", async () => {
		// A symlink that points into the worktree is the worktree.
		const { runner, calls } = fakeRunner(happyScripts());
		const { forge, forgeCalls } = fakeForge(happyForge());
		const err: string[] = [];
		const code = await land({
			runner,
			forge,
			cwd: OUTSIDE_CWD,
			cloneBase: CLONE_BASE,
			validatorRoot: "/fixture/link-to-candidate",
			realpath: (p) => (p === "/fixture/link-to-candidate" ? `${WORKTREE}/tools` : p),
			readFile: () => BODY,
			args: ["--worktree", WORKTREE, "--title", "t", "--body-file", "/fixture/body.md"],
			stdout: () => {},
			stderr: (line) => err.push(line),
		});
		expect(code).not.toBe(0);
		expect(err.join("\n")).toContain("preflight/validator");
		expect(calls.some((c) => c.includes("prepush"))).toBe(false);
		expect(forgeCalls).toHaveLength(0);
	});

	test("a relative validatorRoot is resolved against the PARENT cwd once, and that absolute path is what the receipt runs", async () => {
		// The child's cwd is the worktree, so a relative root left as-is would
		// resolve to <worktree>/src/index.ts inside the child: candidate code with
		// the token. The same absolute value must feed both the containment check
		// and the argv.
		const { runner, calls, optsOf } = fakeRunner(happyScripts());
		const { forge } = fakeForge(happyForge());
		const code = await land({
			runner,
			forge,
			cwd: PRIMARY,
			cloneBase: CLONE_BASE,
			validatorRoot: ".",
			readFile: () => BODY,
			args: ["--worktree", WORKTREE, "--title", "t", "--body-file", "/fixture/body.md"],
			stdout: () => {},
			stderr: () => {},
		});
		expect(code).toBe(0);
		const at = calls.findIndex((c) => c.includes("prepush"));
		expect(calls[at]).toEqual(["bun", `${PRIMARY}/src/index.ts`, "prepush", "validate"]);
		expect(optsOf[at]?.cwd).toBe(WORKTREE);
	});

	test.each([
		[
			"a relative validatorRoot that resolves into the worktree",
			"../worktrees/l004/tools",
			`${PRIMARY}/.git\n`,
		],
		["a relative git common dir when the worktree IS the primary checkout", undefined, ".git\n"],
	])(
		"%s refuses before any forge call (PR #690 round 5 P1)",
		async (_name, validatorRoot, commonDir) => {
			const { runner, calls } = fakeRunner(
				happyScripts([
					{
						when: (a) => a.includes("rev-parse") && a.includes("--git-common-dir"),
						result: { stdout: commonDir },
					},
				]),
			);
			const { forge, forgeCalls } = fakeForge(happyForge());
			const err: string[] = [];
			const code = await land({
				runner,
				forge,
				cwd: OUTSIDE_CWD,
				cloneBase: CLONE_BASE,
				validatorRoot,
				readFile: () => BODY,
				args: ["--worktree", WORKTREE, "--title", "t", "--body-file", "/fixture/body.md"],
				stdout: () => {},
				stderr: (line) => err.push(line),
			});
			expect(code).not.toBe(0);
			expect(err.join("\n")).toContain("preflight/validator");
			expect(calls.some((c) => c.includes("prepush"))).toBe(false);
			expect(forgeCalls).toHaveLength(0);
		},
	);

	test("a branch that IS the default branch refuses before receipt and push", async () => {
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts([{ when: (a) => a.includes("symbolic-ref"), result: { stdout: "develop\n" } }]),
			[],
			OUTSIDE_CWD,
			happyForge({ getDefaultBranch: "develop" }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("preflight/base");
		expect(stderr).toContain("develop");
		expect(calls.some((c) => c.includes("prepush"))).toBe(false);
		expect(called(calls, "git push")).toBe(false);
		expect(forgeCalls.map((c) => c.method)).toEqual(["getDefaultBranch"]);
	});
});

describe("land — push shape obeys standing ruling 1", () => {
	test("the refspec is fully qualified on BOTH sides", async () => {
		const { calls } = await runLand(happyScripts());
		const push = calls.find((c) => verb(c) === "git push");
		expect(push).toBeDefined();
		expect(push).toContain("refs/heads/feat/l004-land-verb:refs/heads/feat/l004-land-verb");
	});

	test("NO call in the whole sequence carries --force or --mirror", async () => {
		// Asserted over every argv rather than only the push, because a force
		// could be reintroduced at any step and the ruling is about the shape of
		// every write this verb performs.
		const { calls } = await runLand(happyScripts(), ["--issue", "229"]);
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call).not.toContain("--force");
			expect(call).not.toContain("--force-with-lease");
			expect(call).not.toContain("--mirror");
			expect(call).not.toContain("-f");
		}
	});

	test("the push names the remote explicitly and sets upstream", async () => {
		const { calls } = await runLand(happyScripts());
		const push = calls.find((c) => verb(c) === "git push");
		expect(push).toContain("origin");
		expect(push).toContain("-u");
	});
});

describe("land — every forge call addresses the origin slug, never the cwd", () => {
	// The invariant: the repository a forge call addresses is DERIVED from the
	// worktree's own `origin`, never from the process working directory. A tool
	// that inferred its target repository from the cwd is what left a branch
	// pushed with no PR on the third live landing — from the safe non-repo cwd the
	// #232 refusal now REQUIRES. The two earlier landings only worked because the
	// (now-refused) inside-the-worktree cwd happened to be a repo, so #232 exposed
	// a latent coupling rather than creating one.

	test("EVERY forge call carries the slug derived from the scripted origin", async () => {
		const { code, forgeCalls } = await runLand(happyScripts(), ["--issue", "235"]);
		expect(code).toBe(0);
		// A non-zero count, not just "every member passes": an empty set satisfies
		// a for-all vacuously, and the five forge steps are the point of the clause
		// (done-means rules 8 and 10 — count the items, do not trust the sweep).
		expect(forgeCalls).toHaveLength(5);
		expect(forgeCalls.map((c) => c.method)).toEqual([
			"getDefaultBranch",
			"createPullRequest",
			"mergePullRequest",
			"getPullRequestMergeState",
			"getIssueState",
		]);
		for (const call of forgeCalls) {
			expect(call.slug).toBe(ORIGIN_SLUG);
		}
	});

	test("the slug is DERIVED from the probe output, not a constant in the code", async () => {
		// A different fixture origin must produce a different slug. If the
		// implementation hard-coded `rodaddy/software-factory`, the previous clause
		// would pass and this one would fail — which is what makes the pair
		// evidence of a parser rather than of a coincidence.
		const { code, forgeCalls } = await runLand(
			happyScripts([
				{
					when: isRemoteProbe,
					result: { stdout: "git@forge.example.internal:someone/other-repo.git\n" },
				},
			]),
		);
		expect(code).toBe(0);
		expect(forgeCalls.length).toBeGreaterThan(0);
		for (const call of forgeCalls) {
			expect(call.slug).toBe("someone/other-repo");
		}
	});

	// All three Forgejo origin shapes, with and without the `.git` suffix,
	// resolve to the SAME slug. Each is a real input: HTTPS is what a browser
	// clone copies, the `git@host:` form is what an SSH clone writes, and the
	// `ssh://` form is what a non-default SSH port produces.
	const SHAPES: ReadonlyArray<readonly [string, string]> = [
		["HTTPS with .git", "https://forge.example.internal/rodaddy/software-factory.git"],
		["HTTPS without .git", "https://forge.example.internal/rodaddy/software-factory"],
		["scp-style SSH with .git", "git@forge.example.internal:rodaddy/software-factory.git"],
		["scp-style SSH without .git", "git@forge.example.internal:rodaddy/software-factory"],
		["ssh:// with .git", "ssh://git@forge.example.internal/rodaddy/software-factory.git"],
		["ssh:// without .git", "ssh://git@forge.example.internal/rodaddy/software-factory"],
	];

	for (const [label, url] of SHAPES) {
		test(`the ${label} origin form resolves to the same slug`, async () => {
			const { code, forgeCalls } = await runLand(
				happyScripts([{ when: isRemoteProbe, result: { stdout: `${url}\n` } }]),
				["--issue", "415"],
			);
			expect(code).toBe(0);
			expect(forgeCalls).toHaveLength(5);
			for (const call of forgeCalls) {
				expect(call.slug).toBe(ORIGIN_SLUG);
			}
		});
	}

	test("an ssh:// origin on the forge's SSH port resolves by HOSTNAME", async () => {
		const { code, forgeCalls } = await runLand(
			happyScripts([
				{
					when: isRemoteProbe,
					result: {
						stdout: "ssh://git@forge.example.internal:2222/rodaddy/software-factory.git\n",
					},
				},
			]),
			["--issue", "415"],
		);
		expect(code).toBe(0);
		expect(forgeCalls).toHaveLength(5);
		for (const call of forgeCalls) expect(call.slug).toBe(ORIGIN_SLUG);
	});

	test("an HTTPS origin carrying a port is refused: the clone base names none", async () => {
		const { code, forgeCalls, stderr } = await runLand(
			happyScripts([
				{
					when: isRemoteProbe,
					result: { stdout: "https://forge.example.internal:8443/rodaddy/software-factory.git\n" },
				},
			]),
			["--issue", "415"],
		);
		expect(code).not.toBe(0);
		expect(forgeCalls).toHaveLength(0);
		expect(stderr).toContain("forge.example.internal:8443");
	});

	test("a refused origin carrying userinfo is reported with the userinfo REDACTED", async () => {
		const { code, forgeCalls, stderr, stdout } = await runLand(
			happyScripts([
				{
					when: isRemoteProbe,
					result: {
						stdout: "https://deploy:hunter2@forge.example.internal/rodaddy/software-factory.git\n",
					},
				},
			]),
			["--issue", "415"],
		);
		expect(code).not.toBe(0);
		expect(forgeCalls).toHaveLength(0);
		expect(stderr).toContain("preflight/origin");
		expect(stderr).not.toContain("hunter2");
		expect(stderr).not.toContain("deploy:");
		expect(stdout).not.toContain("hunter2");
		expect(stderr).toContain("forge.example.internal");
	});

	test("a refused origin's query and fragment are not echoed", async () => {
		const { code, stderr } = await runLand(
			happyScripts([
				{
					when: isRemoteProbe,
					result: { stdout: "https://elsewhere.example/rodaddy/software-factory?token=abc#frag\n" },
				},
			]),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("elsewhere.example");
		expect(stderr).not.toContain("token=abc");
		expect(stderr).not.toContain("frag");
	});

	for (const bad of [
		"https://forge.example.internal/../software-factory.git",
		"https://forge.example.internal/rodaddy/software-factory?x=1",
		"https://forge.example.internal/rodaddy/soft%2Fware.git",
		"https://forge.example.internal/rodaddy/#frag",
	]) {
		test(`a crafted origin segment is refused before any forge call: ${bad}`, async () => {
			const { code, forgeCalls } = await runLand(
				happyScripts([{ when: isRemoteProbe, result: { stdout: `${bad}\n` } }]),
				["--issue", "415"],
			);
			expect(code).not.toBe(0);
			expect(forgeCalls).toHaveLength(0);
		});
	}

	test("the origin is read from the WORKTREE with -C, not from the ambient cwd", async () => {
		// The whole defect is a command reading the process's working directory.
		// Resolving the origin from an unpinned `git remote get-url` would move
		// the same coupling one step earlier instead of removing it.
		const { calls } = await runLand(happyScripts());
		const probe = calls.find(isRemoteProbe);
		expect(probe).toBeDefined();
		expect(probe?.[0]).toBe("git");
		expect(probe?.[1]).toBe("-C");
		expect(probe?.[2]).toBe(WORKTREE);
		expect(probe).toContain("origin");
	});

	test("the origin is resolved ONCE, not re-probed per forge step", async () => {
		const { calls } = await runLand(happyScripts(), ["--issue", "235"]);
		expect(calls.filter(isRemoteProbe)).toHaveLength(1);
	});

	test("a github.com origin refuses BEFORE the push, and nothing mutates", async () => {
		// The forge is forge.example.internal; a github.com remote is a read-only mirror
		// at best. Addressing it here would open a pull request on a repository
		// this verb has no business writing to, so the HOST is checked rather than
		// the shape alone — the HTTPS shape parses perfectly on either host.
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts([
				{
					when: isRemoteProbe,
					result: { stdout: "https://github.com/rodaddy/software-factory.git\n" },
				},
			]),
		);
		expect(code).not.toBe(0);
		expect(called(calls, "git push")).toBe(false);
		expect(calls.some((c) => c.includes("prepush"))).toBe(false);
		expectNothingMutated(calls, forgeCalls);
		expect(stderr).toContain("origin");
		expect(stderr).toContain("github.com/rodaddy/software-factory.git");
		// The expected host is named, so the operator can see what was wanted.
		expect(stderr).toContain("forge.example.internal");
	});

	test("an origin on a DIFFERENT forge host refuses too", async () => {
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts([
				{
					when: isRemoteProbe,
					result: { stdout: "https://git.example.invalid/rodaddy/software-factory.git\n" },
				},
			]),
		);
		expect(code).not.toBe(0);
		expect(called(calls, "git push")).toBe(false);
		expectNothingMutated(calls, forgeCalls);
		expect(stderr).toContain("git.example.invalid");
	});

	test("an unparseable origin refuses BEFORE the push, and nothing mutates", async () => {
		// Call-log absence, not the exit code (done-means rule 14): a refusal that
		// fires after the push has happened leaves the same non-zero code behind
		// while the branch is already on the remote.
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts([
				{ when: isRemoteProbe, result: { stdout: "ssh://example.invalid/not-a-remote\n" } },
			]),
		);
		expect(code).not.toBe(0);
		expect(called(calls, "git push")).toBe(false);
		expect(calls.some((c) => c.includes("prepush"))).toBe(false);
		expectNothingMutated(calls, forgeCalls);
		expect(stderr).toContain("origin");
		expect(stderr).toContain("ssh://example.invalid/not-a-remote");
	});

	test("a FAILED origin probe refuses before the push too", async () => {
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts([
				{
					when: isRemoteProbe,
					result: { code: 2, stderr: "error: No such remote 'origin'\n" },
				},
			]),
		);
		expect(code).not.toBe(0);
		expect(called(calls, "git push")).toBe(false);
		expect(forgeCalls).toHaveLength(0);
		expect(stderr).toContain("origin");
	});

	test("control: the healthy origin reaches the push and lands", async () => {
		const { code, calls, forgeCalls } = await runLand(happyScripts());
		expect(code).toBe(0);
		expect(called(calls, "git push")).toBe(true);
		expect(forgeCalls.length).toBeGreaterThan(0);
	});

	test("the create pins head to the branch the preflight resolved", async () => {
		// The second manifestation, recorded in the #235 thread: retried from the
		// PRIMARY checkout's cwd (a valid repo), the create inferred the HEAD
		// BRANCH from that checkout's checked-out branch — another session's — and
		// refused only because that branch already had a PR. Without an explicit
		// head, a cwd sitting on some other branch opens and squash-merges a PR for
		// the WRONG branch, so pinning it is as mandatory as pinning the slug.
		const { code, forgeCalls } = await runLand(happyScripts());
		expect(code).toBe(0);
		const create = forgeCalls.find((c) => c.method === "createPullRequest");
		// The value is the branch `symbolic-ref` reported, not a re-derivation.
		expect((create?.args[0] as { head?: string })?.head).toBe("feat/l004-land-verb");
	});

	test("head tracks the RESOLVED branch, so a different branch fixture moves it", async () => {
		// Same reasoning as the derived-slug clause: a hard-coded head value would
		// satisfy the clause above and fail here.
		const { code, calls, forgeCalls } = await runLand(
			happyScripts([
				{ when: (a) => a.includes("symbolic-ref"), result: { stdout: "fix/other\n" } },
			]),
		);
		expect(code).toBe(0);
		const create = forgeCalls.find((c) => c.method === "createPullRequest");
		expect((create?.args[0] as { head?: string })?.head).toBe("fix/other");
		// And the push refspec names the same branch — one resolved value, two uses.
		const push = calls.find((c) => verb(c) === "git push");
		expect(push).toContain("refs/heads/fix/other:refs/heads/fix/other");
	});
});

describe("land — merge uses the CAPTURED number, never an inference", () => {
	test("the merge names the number the create returned", async () => {
		// The #226 lesson: branch inference mid-compound mis-parsed. The number
		// comes from the create's own response and nowhere else.
		const { code, forgeCalls } = await runLand(happyScripts());
		expect(code).toBe(0);
		expect(forgeCalls.find((c) => c.method === "mergePullRequest")?.args).toEqual([PR_NUMBER]);
	});

	test("the merged number TRACKS the create, so a different fixture moves it", async () => {
		// A hard-coded number would satisfy the clause above and fail here.
		const { code, forgeCalls } = await runLand(
			happyScripts(),
			[],
			OUTSIDE_CWD,
			happyForge({ createPullRequest: { number: 4242, url: `${PR_URL}-alt` } }),
		);
		expect(code).toBe(0);
		expect(forgeCalls.find((c) => c.method === "mergePullRequest")?.args).toEqual([4242]);
		expect(forgeCalls.find((c) => c.method === "getPullRequestMergeState")?.args).toEqual([4242]);
	});

	test("a create returning no usable number aborts before the merge", async () => {
		const { code, forgeCalls, stderr } = await runLand(
			happyScripts(),
			[],
			OUTSIDE_CWD,
			happyForge({ createPullRequest: { number: Number.NaN, url: PR_URL } }),
		);
		expect(code).not.toBe(0);
		expect(forgeCalls.some((c) => c.method === "mergePullRequest")).toBe(false);
		expect(stderr).toContain("pr-create");
	});

	for (const url of [
		"",
		"not-a-url",
		"http://forge.example.internal/rodaddy/software-factory/pulls/9",
	]) {
		test(`a create with no usable https PR URL (${JSON.stringify(url)}) aborts BEFORE the merge`, async () => {
			const { code, forgeCalls, stderr } = await runLand(
				happyScripts(),
				[],
				OUTSIDE_CWD,
				happyForge({ createPullRequest: { number: 4242, url } }),
			);
			expect(code).not.toBe(0);
			expect(forgeCalls.some((c) => c.method === "mergePullRequest")).toBe(false);
			expect(stderr).toContain("no usable pull-request URL");
		});
	}

	test("a failed create aborts before the merge", async () => {
		const { code, forgeCalls, stderr } = await runLand(
			happyScripts(),
			[],
			OUTSIDE_CWD,
			happyForge({ createPullRequest: new Error("a pull request already exists") }),
		);
		expect(code).not.toBe(0);
		expect(forgeCalls.some((c) => c.method === "mergePullRequest")).toBe(false);
		expect(stderr).toContain("already exists");
	});
});

describe("land — a failed merge stops before teardown", () => {
	test("a REFUSED merge never invokes worktree remove", async () => {
		// A refusal is a result, not an exception: `not-mergeable` is an ordinary
		// state, and the sequence must stop on it exactly as hard as on a throw.
		const { code, calls, forgeCalls, stderr } = await runLand(
			happyScripts(),
			[],
			OUTSIDE_CWD,
			happyForge({ mergePullRequest: { merged: false, reason: "not-mergeable" } }),
		);
		expect(code).not.toBe(0);
		expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(false);
		expect(forgeCalls.some((c) => c.method === "getPullRequestMergeState")).toBe(false);
		expect(stderr).toContain("not-mergeable");
	});

	test("a THROWN merge never invokes worktree remove either", async () => {
		const { code, calls, stderr } = await runLand(
			happyScripts(),
			[],
			OUTSIDE_CWD,
			happyForge({ mergePullRequest: new Error("forge unreachable") }),
		);
		expect(code).not.toBe(0);
		expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(false);
		expect(stderr).toContain("forge unreachable");
	});

	test("control: a successful merge DOES reach teardown", async () => {
		const { code, calls } = await runLand(happyScripts());
		expect(code).toBe(0);
		expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(true);
	});
});

describe("land — closure is ASSERTED, not assumed", () => {
	test("a PR reporting merged=false fails, and teardown is not reached", async () => {
		// The merge call answering success does not prove the PR landed; the verify
		// step reads the forge's own state back, and an unmerged answer stops here.
		const { code, calls, stderr } = await runLand(
			happyScripts(),
			[],
			OUTSIDE_CWD,
			happyForge({ getPullRequestMergeState: { merged: false, mergeCommitSha: MERGE_SHA } }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("verify/pr");
		expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(false);
	});

	test("a merged PR carrying a NULL merge SHA fails", async () => {
		// "merged with a merge SHA" is one clause, not two: a flag without the
		// commit it names is exactly the unverified assumption L-004 removes.
		const { code, calls, stderr } = await runLand(
			happyScripts(),
			[],
			OUTSIDE_CWD,
			happyForge({ getPullRequestMergeState: { merged: true, mergeCommitSha: null } }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("merge commit SHA");
		expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(false);
	});

	test("a merged PR carrying an EMPTY merge SHA fails", async () => {
		const { code, stderr } = await runLand(
			happyScripts(),
			[],
			OUTSIDE_CWD,
			happyForge({ getPullRequestMergeState: { merged: true, mergeCommitSha: "" } }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("merge commit SHA");
	});

	test("with --issue, an issue still `open` fails and blocks teardown", async () => {
		const { code, calls, stderr } = await runLand(
			happyScripts(),
			["--issue", "229"],
			OUTSIDE_CWD,
			happyForge({ getIssueState: { state: "open" } }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("229");
		expect(stderr).toContain("open");
		expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(false);
	});

	test("with --issue, a `closed` issue passes and the receipt says closed", async () => {
		const { code, forgeCalls, stdout } = await runLand(happyScripts(), ["--issue", "229"]);
		expect(code).toBe(0);
		expect(forgeCalls.find((c) => c.method === "getIssueState")?.args).toEqual([229]);
		expect(stdout).toContain("#229 closed");
	});

	test("an UPPERCASE `CLOSED` state FAILS: the lowercase contract is the point", async () => {
		// The forge's own vocabulary is lowercase. A case-insensitive compare would
		// accept a value from a different API's vocabulary and report a state this
		// verb never actually confirmed — the class of defect L-004 removes.
		const { code, calls, stderr } = await runLand(
			happyScripts(),
			["--issue", "229"],
			OUTSIDE_CWD,
			happyForge({ getIssueState: { state: "CLOSED" } }),
		);
		expect(code).not.toBe(0);
		expect(stderr).toContain("verify/issue");
		expect(stderr).toContain("CLOSED");
		expect(calls.some((c) => c.includes("worktree") && c.includes("remove"))).toBe(false);
	});

	test("without --issue, no issue read is attempted at all", async () => {
		const { code, forgeCalls } = await runLand(happyScripts());
		expect(code).toBe(0);
		expect(forgeCalls.some((c) => c.method === "getIssueState")).toBe(false);
	});
});

describe("land — teardown resolves the primary from the git common dir", () => {
	test("worktree remove runs against the PRIMARY checkout, not the worktree", async () => {
		// `git worktree remove` run from inside the worktree being removed is the
		// classic failure; the primary is derived from `--git-common-dir`.
		const { calls } = await runLand(happyScripts());
		const remove = calls.find((c) => c.includes("worktree") && c.includes("remove"));
		expect(remove).toBeDefined();
		expect(remove).toContain(PRIMARY);
		expect(remove).toContain(WORKTREE);
	});

	test("`git worktree list` is printed after the removal", async () => {
		const { calls } = await runLand(happyScripts());
		const removeAt = calls.findIndex((c) => c.includes("worktree") && c.includes("remove"));
		const listAt = calls.findIndex(
			(c) => c.includes("worktree") && c.includes("list") && !isRegistrationProbe(c),
		);
		expect(removeAt).toBeGreaterThanOrEqual(0);
		expect(listAt).toBeGreaterThan(removeAt);
	});
});

describe("land — the happy path runs the steps in exact ticket order", () => {
	test("receipt → push → create → merge → verify pr → verify issue → teardown", async () => {
		const { code, calls, forgeCalls } = await runLand(happyScripts(), ["--issue", "229"]);
		expect(code).toBe(0);
		// Git steps in order, with the forge block between the push and the
		// teardown. Asserted as two ordered logs because the two boundaries record
		// separately; the fakes throw on anything unscripted, so neither log can
		// silently omit a step.
		const gitOrder = [
			calls.findIndex((c) => c.includes("prepush")),
			calls.findIndex((c) => verb(c) === "git push"),
			calls.findIndex((c) => c.includes("worktree") && c.includes("remove")),
			calls.findIndex(
				(c) => c.includes("worktree") && c.includes("list") && !isRegistrationProbe(c),
			),
		];
		for (const index of gitOrder) expect(index).toBeGreaterThanOrEqual(0);
		expect(gitOrder).toEqual([...gitOrder].sort((a, b) => a - b));
		expect(forgeCalls.map((c) => c.method)).toEqual([
			"getDefaultBranch",
			"createPullRequest",
			"mergePullRequest",
			"getPullRequestMergeState",
			"getIssueState",
		]);
	});

	test("the receipt summary names branch, HEAD SHA, PR URL, merge SHA, issue and worktree", async () => {
		const { code, stdout } = await runLand(happyScripts(), ["--issue", "229"]);
		expect(code).toBe(0);
		expect(stdout).toContain("feat/l004-land-verb");
		expect(stdout).toContain("abc1234def5678");
		expect(stdout).toContain(PR_URL);
		expect(stdout).toContain(MERGE_SHA);
		expect(stdout).toContain("229");
		expect(stdout).toContain("closed");
		expect(stdout).toContain(WORKTREE);
	});

	test("no retry: a failed step is attempted exactly once", async () => {
		// "No retries, no cleanup of a partially-landed state" is behaviour, not a
		// comment — a retry loop would leave the log holding two pushes.
		const { calls } = await runLand(
			happyScripts([
				{
					when: (a) => a.includes("push"),
					result: { code: 1, stderr: "fatal: rejected\n" },
				},
			]),
		);
		expect(calls.filter((c) => verb(c) === "git push")).toHaveLength(1);
	});

	test("no retry on the forge side either: one create, one merge", async () => {
		const { forgeCalls } = await runLand(happyScripts(), ["--issue", "229"]);
		expect(forgeCalls.filter((c) => c.method === "createPullRequest")).toHaveLength(1);
		expect(forgeCalls.filter((c) => c.method === "mergePullRequest")).toHaveLength(1);
	});
});

describe("land — the CLI entry exits non-zero on a thrown error", () => {
	// The named trap: a top-level `await` with no `.catch` exits 0 on crash, so
	// the verb would report success while having landed nothing. Driven as a real
	// process because the defect lives in the ENTRY wiring, which an in-process
	// call to `land()` cannot exercise. `--worktree` is absent, so argument
	// validation refuses before any git or forge call is reachable — this test
	// touches no live repository and no live forge.
	const ENV = { ...process.env, FORGEJO_TOKEN: "fixture-token-not-a-real-credential" };

	test("running the script with no arguments exits non-zero", () => {
		const result = Bun.spawnSync(["bun", "run", SCRIPT], { env: ENV });
		expect(result.exitCode).not.toBe(0);
	});

	test("the refusal names the missing argument on stderr", () => {
		const result = Bun.spawnSync(["bun", "run", SCRIPT], { env: ENV });
		const output = `${result.stdout.toString()}${result.stderr.toString()}`;
		expect(output).toContain("--worktree");
	});

	test("with NO token the entry refuses with exit 2 before anything runs", () => {
		// The credential is resolved in the entry, not in `land`, and its absence is
		// an invocation refusal like the argument ones. The refusal text names the
		// variable, never a value.
		const { FORGEJO_TOKEN: _omitted, ...noToken } = ENV;
		const result = Bun.spawnSync(["bun", "run", SCRIPT], { env: noToken });
		expect(result.exitCode).toBe(2);
		const output = `${result.stdout.toString()}${result.stderr.toString()}`;
		expect(output).toContain("FORGEJO_TOKEN");
	});
});

describe("parseOriginSlug — the HTTPS authority is the clone base's, port included", () => {
	// A deployment whose clone base carries a port writes that port into every
	// HTTPS origin; refusing it split the push target from the API target for a
	// valid configuration. The rule is now equality of the whole authority, with
	// the default port spelled out or left implicit meaning the same thing.
	const PORTED_BASE = "https://forge.example:8443";

	test("an HTTPS origin on the clone base's own port resolves", () => {
		expect(parseOriginSlug("https://forge.example:8443/o/r.git", PORTED_BASE)).toBe("o/r");
	});

	test("an HTTPS origin on the default port is refused when the clone base names another", () => {
		expect(parseOriginSlug("https://forge.example/o/r.git", PORTED_BASE)).toBeUndefined();
		expect(parseOriginSlug("https://forge.example:443/o/r.git", PORTED_BASE)).toBeUndefined();
	});

	test("an HTTPS origin on another port is refused when the clone base names one", () => {
		expect(parseOriginSlug("https://forge.example:9443/o/r.git", PORTED_BASE)).toBeUndefined();
	});

	test("the default HTTPS port spelled out equals the port left implicit", () => {
		expect(parseOriginSlug("https://forge.example.internal:443/o/r.git", CLONE_BASE)).toBe("o/r");
		expect(
			parseOriginSlug(
				"https://forge.example.internal/o/r.git",
				"https://forge.example.internal:443",
			),
		).toBe("o/r");
	});

	test("an ssh:// origin is still compared by hostname: the clone base names no SSH port", () => {
		// The SSH endpoint is a different listener from the HTTPS one, and the
		// clone base carries nothing to compare its port against.
		expect(parseOriginSlug("ssh://git@forge.example:2222/o/r.git", PORTED_BASE)).toBe("o/r");
		expect(parseOriginSlug("ssh://git@other.example:2222/o/r.git", PORTED_BASE)).toBeUndefined();
	});
});
