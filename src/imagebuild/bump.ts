/**
 * @module imagebuild/bump
 * @description The invoke + parse half of the build-bump lane: run
 *   rtech-infra's `open-bump-pr.sh` for one (candidate, app_dir) pair and turn
 *   its exit code, stdout, and stderr into one bounded outcome. The render and
 *   the SOP knowledge live with infra; this module only invokes the wrapper and
 *   reads its contract.
 *
 *   THE TARGET IS A VALIDATED PARAMETER, NOT AN ENUM. Per
 *   `_DOCS/BUILD_BUMP_ENVIRONMENTS.md` section 7, the wrapper accepts any plain
 *   target name and uses it for the PR title and body only; the `uat|prod` case
 *   statement and `BAD_TARGET` are gone from the script, so this module no
 *   longer holds a target constant or a second prod-only export. `target` is
 *   validated against the SAME anchored class as `--app` (max 16 chars), which
 *   is what keeps a target-shaped value from becoming a flag. Environment
 *   selection is now the CALLER's decision, made from operator-controlled
 *   enrolment config, never from a payload or forge content.
 *
 *   `allowOlder` IS AN EXPLICIT MARKER, NOT A DEFAULT. Without it the wrapper's
 *   `OLDER_TAG` guard refuses a backwards move on a version-tag stream; with it
 *   the guard is skipped and the PR body records `direction: explicit (marker)`.
 *   The flag is appended only when true, so the ordinary argv is byte-identical
 *   to the pre-marker shape.
 *
 *   ARGV IS VALIDATED BEFORE THE SPAWN, WITH FIXED MESSAGES. `sha`, `tag`,
 *   `app_dir`, `repository`, and `target` each match an anchored character class
 *   that is a SECURITY BOUNDARY, not tidiness: the leading-character class
 *   refuses every option-shaped value (`-rf`, `--target`) so a tag named `-x`
 *   cannot become a flag, and refusing `/` in an app dir is what prevents
 *   traversal. The classes are the same ones `src/config/schema.ts` already
 *   enforces on `app_dirs` and `tag_pattern`, one boundary further in. A refusal
 *   message NEVER echoes the offending input: it is untrusted forge content.
 *
 *   THE CHILD ENVIRONMENT IS CONSTRUCTED, NEVER INHERITED. The spawn passes
 *   exactly PATH, HOME, FORGE_TOKEN, and FORGE_USER. Handing the child
 *   `process.env` would hand an agent-authored script every other credential the
 *   watcher holds. The token arrives as a CALLER-SUPPLIED `BumpCredential` —
 *   this module never reads `process.env` for it, so the credential-fetch
 *   boundary stays with the caller and a test can prove where the token went.
 *   No argv element carries the credential, and the new ones do not change that.
 *
 *   FAILURE REASONS ARE FIXED STRINGS, NEVER SCRIPT TEXT — AND NEVER AN EXIT
 *   CODE. Exit 1 maps to the leading TOKEN of stderr's first line and nothing
 *   else (`unknown refusal` otherwise); EVERY OTHER non-zero code maps the same
 *   way against the harness vocabulary (`unknown harness` otherwise), per
 *   `_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §8. The literal `exit N` is gone: it named
 *   a number rather than a fault, so four unrelated failures shared one string
 *   and the operator learned nothing from the row. Log lines carry identifiers,
 *   the exit code, and the outcome kind — never the environment, the token, or
 *   raw stdout/stderr.
 *
 *   EXIT GRAMMAR (the script's, per sf#544). `0` = a PR was opened and the LAST
 *   non-empty stdout line is its JSON receipt. `1` = the bump is wrong, and that
 *   is TERMINAL per (candidate, app): the same inputs produce the same refusal,
 *   so a retry burns the same work and hides the reason behind a churn loop.
 *   Anything else — including exit 0 whose last line will not parse, a spawn
 *   failure, and the 10-minute timeout — is `harness`, which the CALLER may
 *   retry once after reconciliation. This module never retries.
 *
 * @outputs
 *   - `BumpCandidate` / `BumpCredential` -- the inputs, credential caller-supplied
 *   - `BumpInput` -- one invocation, carrying `target` and `allowOlder`
 *   - `BumpRefusal` / `HarnessReason` / `BumpOutcome` -- the bounded result vocabulary
 *   - `classifyRefusal` / `classifyHarness` -- stderr's leading token to a fixed string
 *   - `buildBumpArgv` -- pure argv construction for any validated target
 *   - `parseBumpStdout` -- pure last-line JSON receipt parsing
 *   - `classifyRefusal` -- stderr leading token to a fixed refusal
 *   - `BumpSpawn` / `spawnBumpScript` -- the injectable process seam
 *   - `runBump` -- one invocation, one outcome
 *
 * @dependencies
 *   - zod -- boundary validation of the untrusted script receipt
 *   - ../log -- log/bounded/errorClass and the shared traced() wrapper
 */
import { z } from "zod";
import { errorClass, log, traced } from "../log";

/** Per-invocation deadline. A wedged script must not hold a cycle open. */
const SPAWN_TIMEOUT_MS = 600_000;

/** Max bytes kept from each captured stream before truncation. */
const MAX_STREAM_BYTES = 64 * 1024;

/** Max length of a validated identifier-shaped argument. */
const MAX_ARG_LENGTH = 100;

/** Max length of a target name. The wrapper renders it into a PR title. */
const MAX_TARGET_LENGTH = 16;

/** A plain name: no `/`, no whitespace, no shell metacharacter, never option-shaped. */
const PLAIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** `owner/name`, each half a plain name. */
const REPOSITORY = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A full 40-hex COMMIT sha, never a tag object id and never abbreviated. */
const COMMIT_SHA = /^[0-9a-f]{40}$/;

/** One observed tag on an enrolled repository, as the bump lane reads it. */
export type BumpCandidate = { repository: string; tag: string; sha: string };

/** The forge credential, resolved by the CALLER — this module reads no env. */
export type BumpCredential = { token: string; user: string };

/** The script's exit-1 vocabulary, plus the catch-all for anything unrecognized. */
export type BumpRefusal =
	| "ALREADY_AT_TAG"
	| "REGISTRY_MISSING"
	| "MIXED_TAGS"
	| "NO_IMAGE_LINES"
	| "BAD_TARGET"
	| "OLDER_TAG"
	| "unknown refusal";

/** The known refusal tokens, as a runtime set for classification. */
const REFUSALS: readonly string[] = [
	"ALREADY_AT_TAG",
	"REGISTRY_MISSING",
	"MIXED_TAGS",
	"NO_IMAGE_LINES",
	"BAD_TARGET",
	"OLDER_TAG",
];

/**
 * The script's HARNESS vocabulary — every exit that is neither success nor a
 * refusal — plus the catch-all (`_DOCS/BUILD_BUMP_ENVIRONMENTS.md` §8).
 *
 * A BOUNDED UNION, never the literal exit code. The row used to record `exit N`,
 * which names the number the script happened to leave and nothing about WHY: one
 * `3` covers a pattern that no longer matches, a push the forge rejected, an
 * unreachable registry, and an argument the DEPLOYED script does not know. Those
 * are different faults with different fixes, and the last is the specific trap §7
 * names — a factory passing `--allow-older` to a checkout that predates it dies
 * on every bump, which is diagnosable by name and invisible as a number.
 */
export type HarnessReason =
	| "PATTERN_DRIFT"
	| "PUSH_FAILED"
	| "PR_CREATE_FAILED"
	| "MERGE_QUEUE_FAILED"
	| "REGISTRY_UNREACHABLE"
	| "CLONE_FAILED"
	| "UNKNOWN_ARGUMENT"
	| "unknown harness";

/** The known harness tokens, as a runtime set for classification. */
const HARNESS_REASONS: readonly string[] = [
	"PATTERN_DRIFT",
	"PUSH_FAILED",
	"PR_CREATE_FAILED",
	"MERGE_QUEUE_FAILED",
	"REGISTRY_UNREACHABLE",
	"CLONE_FAILED",
	"UNKNOWN_ARGUMENT",
];

/**
 * One invocation's result. `refused` is TERMINAL per (candidate, app); `harness`
 * is the caller's single retry. Nothing here carries script text.
 */
export type BumpOutcome =
	| {
			kind: "opened";
			pr: number;
			url: string;
			repository: "rtech/k3s-deploy";
			branch: string;
			app: string;
			oldTag: string;
			newTag: string;
	  }
	| { kind: "refused"; reason: BumpRefusal }
	| { kind: "harness"; reason: string };

/** The only deploy repository this lane may comment on. */
export const BUMP_RECEIPT_REPOSITORY = "rtech/k3s-deploy" as const;

/** The script's stdout receipt. Unknown keys are ignored, not refused. */
const receiptSchema = z.object({
	pr: z.number().int().positive(),
	url: z.url().refine((value) => value.startsWith("https://")),
	branch: z.string(),
	app: z.string(),
	old_tag: z.string(),
	new_tag: z.string(),
});

/** The parse result: the validated receipt, or a fixed reason it was unusable. */
export type BumpParse =
	| { ok: true; value: z.infer<typeof receiptSchema> }
	| { ok: false; reason: "no output" | "last line not json" | "shape mismatch" };

/** The injectable process seam. Tests pass a recorder; production spawns. */
export type BumpSpawn = (
	argv: string[],
	env: Record<string, string>,
) => Promise<{ code: number | null; stdout: string; stderr: string }>;

/** Refuse anything that fails the boundary, with a message that echoes no input. */
function assertArg(condition: boolean, field: string): void {
	if (!condition) throw new Error(`invalid bump argument: ${field}`);
}

/**
 * Build the script argv for one (candidate, app_dir, target) pair. Pure.
 *
 * Every argument is validated before a single element is emitted, and `target`
 * is held to the same anchored class as `--app` so no target-shaped input can
 * become a flag. `--allow-older` is appended ONLY when `allowOlder` is true, so
 * the default argv is unchanged from the pre-marker shape and the marker is
 * visible in a diff rather than implied by a default.
 *
 * The credential is never an argv element; it reaches the child through the
 * constructed environment alone.
 *
 * @param scriptPath - path to `open-bump-pr.sh` on the watcher's own disk
 * @param candidate - the observed tag being bumped
 * @param appDir - one `manifests/apps/<name>` directory name
 * @param workdir - a scratch directory the script may clone into
 * @param target - the environment name, rendered by the wrapper into the PR
 * @param allowOlder - skip the wrapper's `OLDER_TAG` guard, explicitly
 */
export const buildBumpArgv = traced(
	"imagebuild.bump.buildBumpArgv",
	// Six positional arguments over one options object: the wrapper's CLI is
	// positional-flag shaped and the call sites read as the command they build.
	// eslint-disable-next-line max-params
	function buildBumpArgv(
		scriptPath: string,
		candidate: BumpCandidate,
		appDir: string,
		workdir: string,
		target: string,
		allowOlder: boolean,
	): string[] {
		assertArg(COMMIT_SHA.test(candidate.sha), "sha");
		assertArg(appDir.length <= MAX_ARG_LENGTH && PLAIN_NAME.test(appDir), "app");
		assertArg(candidate.tag.length <= MAX_ARG_LENGTH && PLAIN_NAME.test(candidate.tag), "tag");
		assertArg(REPOSITORY.test(candidate.repository), "repo");
		assertArg(target.length <= MAX_TARGET_LENGTH && PLAIN_NAME.test(target), "target");
		const argv = [
			scriptPath,
			"--app",
			appDir,
			"--tag",
			candidate.tag,
			"--repo",
			candidate.repository,
			"--sha",
			candidate.sha,
			"--target",
			target,
			"--workdir",
			workdir,
		];
		if (allowOlder) argv.push("--allow-older");
		return argv;
	},
);

/**
 * Parse the script's receipt: the LAST non-empty stdout line, as JSON. Pure.
 *
 * The script prints progress above its receipt, so only the last line is a
 * candidate; a parse or shape failure is a fixed reason, never zod's issue list,
 * which quotes the received value.
 */
export const parseBumpStdout = traced(
	"imagebuild.bump.parseBumpStdout",
	function parseBumpStdout(stdout: string): BumpParse {
		const lines = stdout.split("\n").filter((line) => line.trim() !== "");
		if (lines.length === 0) return { ok: false, reason: "no output" };
		let sawJson = false;
		for (let index = lines.length - 1; index >= 0; index -= 1) {
			const line = lines[index];
			if (line === undefined) continue;
			let payload: unknown;
			try {
				payload = JSON.parse(line);
			} catch {
				continue;
			}
			sawJson = true;
			const parsed = receiptSchema.safeParse(payload);
			if (!parsed.success) continue;
			const expectedPath = `/${BUMP_RECEIPT_REPOSITORY}/pulls/${parsed.data.pr}`;
			if (new URL(parsed.data.url).pathname !== expectedPath) continue;
			return { ok: true, value: parsed.data };
		}
		return { ok: false, reason: sawJson ? "shape mismatch" : "last line not json" };
	},
);

/** Map stderr's first leading token to a fixed refusal. */
export const classifyRefusal = traced(
	"imagebuild.bump.classifyRefusal",
	function classifyRefusal(stderr: string): BumpRefusal {
		const first = stderr.split("\n").find((line) => line.trim() !== "") ?? "";
		const token = first.trim().split(/\s+/)[0] ?? "";
		return REFUSALS.includes(token) ? (token as BumpRefusal) : "unknown refusal";
	},
);

/**
 * Map stderr's first leading token to a fixed HARNESS reason.
 *
 * Deliberately the same SHAPE as {@link classifyRefusal} rather than one
 * parameterised classifier the two share: the vocabularies are read by different
 * consumers — a refusal is terminal for the pair, a harness reason is retried and
 * counted — and a shared function taking the list as an argument would let a
 * refusal token pass as a harness reason the first time a caller handed it the
 * wrong one. Unrecognised, which INCLUDES empty stderr (the ordinary case for a
 * child killed by a signal), is `unknown harness`, and that string is the only
 * value a reader has to treat as "go and look at the log".
 */
export const classifyHarness = traced(
	"imagebuild.bump.classifyHarness",
	function classifyHarness(stderr: string): HarnessReason {
		const first = stderr.split("\n").find((line) => line.trim() !== "") ?? "";
		const token = first.trim().split(/\s+/)[0] ?? "";
		return HARNESS_REASONS.includes(token) ? (token as HarnessReason) : "unknown harness";
	},
);

/** Clamp a captured stream to a bounded size, marking that it was cut. */
function clampStream(text: string): string {
	if (text.length <= MAX_STREAM_BYTES) return text;
	return `${text.slice(0, MAX_STREAM_BYTES)}\n[truncated]`;
}

/**
 * The production seam: spawn the script with a CONSTRUCTED environment and a
 * deadline, capturing both streams bounded. `env` is passed whole and is the
 * child's entire environment — never `process.env`.
 */
export const spawnBumpScript: BumpSpawn = traced(
	"imagebuild.bump.spawnBumpScript",
	async function spawnBumpScript(argv: string[], env: Record<string, string>) {
		const child = Bun.spawn(argv, {
			env,
			stdout: "pipe",
			stderr: "pipe",
			signal: AbortSignal.timeout(SPAWN_TIMEOUT_MS),
		});
		const [stdout, stderr] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
		]);
		const code = await child.exited;
		return { code, stdout: clampStream(stdout), stderr: clampStream(stderr) };
	},
	{ redact: { args: [1] } },
);

/** The fixed child environment. Nothing else from this process crosses over. */
function childEnv(cred: BumpCredential): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "",
		HOME: process.env.HOME ?? "",
		FORGE_TOKEN: cred.token,
		FORGE_USER: cred.user,
	};
}

/** Turn a completed exit-0 run into `opened`, or a fixed harness reason. */
function outcomeForSuccess(stdout: string): BumpOutcome {
	const parsed = parseBumpStdout(stdout);
	if (!parsed.ok) return { kind: "harness", reason: "exit 0 without json" };
	const receipt = parsed.value;
	return {
		kind: "opened",
		pr: receipt.pr,
		url: receipt.url,
		repository: BUMP_RECEIPT_REPOSITORY,
		branch: receipt.branch,
		app: receipt.app,
		oldTag: receipt.old_tag,
		newTag: receipt.new_tag,
	};
}

/**
 * One invocation's inputs, grouped so `runBump` stays at three parameters.
 * `target` names the environment and `allowOlder` is the explicit backwards-move
 * marker; both are the caller's decision, from operator-controlled enrolment.
 */
export type BumpInput = {
	scriptPath: string;
	candidate: BumpCandidate;
	appDir: string;
	workdir: string;
	target: string;
	allowOlder: boolean;
};

/** Log the outcome with identifiers only — no env, no token, no script text. */
function logOutcome(input: BumpInput, code: number | null, outcome: BumpOutcome): void {
	const base = {
		app: input.appDir,
		tag: input.candidate.tag,
		repository: input.candidate.repository,
		sha: input.candidate.sha,
		exit_code: code,
		kind: outcome.kind,
	};
	if (outcome.kind === "opened") {
		log("info", "imagebuild.bump.opened", { ...base, pr: outcome.pr, url: outcome.url });
		return;
	}
	log("warn", `imagebuild.bump.${outcome.kind}`, { ...base, reason: outcome.reason });
}

/**
 * Invoke the bump script once and return one bounded outcome. Never retries.
 *
 * @param input - script path, candidate, app dir, workdir, target, allowOlder
 * @param cred - the caller-resolved forge credential (never read from env here)
 * @param spawn - the process seam; tests pass a fake
 */
async function runBumpWith(
	input: BumpInput,
	cred: BumpCredential,
	spawn: BumpSpawn,
): Promise<BumpOutcome> {
	let argv: string[];
	try {
		argv = buildBumpArgv(
			input.scriptPath,
			input.candidate,
			input.appDir,
			input.workdir,
			input.target,
			input.allowOlder,
		);
	} catch (err) {
		const outcome: BumpOutcome = { kind: "harness", reason: errorClass(err) };
		logOutcome(input, null, outcome);
		return outcome;
	}
	let result: { code: number | null; stdout: string; stderr: string };
	try {
		result = await spawn(argv, childEnv(cred));
	} catch (err) {
		// The caught value is discarded unread: a spawn error interpolates the
		// argv and, through some runtimes, the environment it was handed.
		const outcome: BumpOutcome = { kind: "harness", reason: "spawn error" };
		log("warn", "imagebuild.bump.spawn_failed", {
			app: input.appDir,
			error_class: errorClass(err),
		});
		logOutcome(input, null, outcome);
		return outcome;
	}
	const outcome = outcomeFor(result);
	logOutcome(input, result.code, outcome);
	return outcome;
}

export const runBump = traced(
	"imagebuild.bump.runBump",
	async function runBump(
		input: BumpInput,
		cred: BumpCredential,
		spawn: BumpSpawn = spawnBumpScript,
	): Promise<BumpOutcome> {
		return runBumpWith(input, cred, spawn);
	},
	{ redact: { args: [1] } },
);

/** Map one completed run to its outcome. Exit 1 is terminal; everything else retryable. */
function outcomeFor(result: { code: number | null; stdout: string; stderr: string }): BumpOutcome {
	if (result.code === 0) return outcomeForSuccess(result.stdout);
	if (result.code === 1) return { kind: "refused", reason: classifyRefusal(result.stderr) };
	// The CODE selects the branch; the REASON comes from stderr's leading token and
	// never from the code itself (§8). `timeout` stays code-derived because the
	// deadline kills the child before it can name anything.
	if (result.code === null) return { kind: "harness", reason: "timeout" };
	return { kind: "harness", reason: classifyHarness(result.stderr) };
}
