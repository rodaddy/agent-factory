/**
 * @module jobs/verb-body
 * @description The EXECUTABLE body a deterministic k3s verb job ships.
 *
 *   The verb lane dispatches `runtime: "script"`, and the box execs the body
 *   directly — `script) /bin/bash /work/job/job.md` in rtech-infra's
 *   `scripts/runner-job`. Before sf#301 the body was not shell at all: a bash
 *   shebang and `set -euo pipefail`, then the RAW rails-manifest YAML between two
 *   comment markers (only the markers were comments), then `verbDispatchBody` — a
 *   prose instruction list written for an AGENT lane. Under `set -e` the first
 *   prose line killed the job, and the failure read as a box problem rather than a
 *   watcher problem. B1–B3 could not see it because those probes used hand-shaped
 *   bodies; the real one had never been execed.
 *
 *   THE SECURITY PROPERTY, and it is the same one `renderScriptCommandBlock`
 *   established: an executed command block has NO free substitution slot
 *   for repository content. Here the block is not context-free — a verb job is
 *   per-item by nature — so the property is enforced by ALLOWLISTING what may be
 *   interpolated and validating each one before it is spliced:
 *
 *     - the six verb ids this body can represent — three UP verbs, which copy the
 *       compiled output in and stage an add, and three DOWN verbs, which stage a
 *       git-tracked removal of the same two paths instead
 *     - the managed repository full name, checked as `owner/repo`
 *     - the item number, a validated positive integer
 *     - the app name, checked against a narrow DNS-label charset
 *     - the manifest dispatch sha, checked as 64 lowercase hex characters
 *     - the k3s-deploy base sha, checked as 40 hex characters
 *     - fixed share paths, which are author literals
 *
 *   Everything else — above all the rails manifest, whose bytes come from a file
 *   the operator names — is delivered as DATA: a QUOTED heredoc (no expansion of
 *   any kind inside it) written to a file, whose sha256 the body asserts before
 *   render work begins. The assertion is integrity-binding only: nothing on the
 *   box consumes the manifest semantics. A quoted heredoc cannot execute its
 *   contents and cannot interpolate, so manifest bytes have no path to the shell.
 *
 *   THE BOX'S JOB IS RENDER + RETURN, nothing more. Rails evaluation, branch
 *   push, and the Forgejo proposal are watcher-owned (`results/proposal-pass`:
 *   rails before remote write, push before queue). The box holds no forge
 *   credential and this body fetches from no forge — the engine and the
 *   k3s-deploy base both come from the read-only collab share.
 *
 *   MECHANISMS VERIFIED AGAINST THE REAL WRAPPER, not against docs:
 *     - `$SHARE` is a plain shell variable in the wrapper and is NOT exported, so
 *       the `/bin/bash` child does not inherit it. `RUNNER_JOB_ID` IS inherited
 *       (the wrapper reads it from its own environment), so the body reconstructs
 *       the share path from that plus the `hostname` COMMAND — never a `$HOSTNAME`
 *       expansion, which a live agent twice expanded to a guessed number.
 *     - The wrapper copies back ONLY verdict.json, result.json, agent.log and
 *       DONE. Nothing under `/work/out` is copied. So the body writes its result
 *       and its bundle to the share ITSELF, and the bundle lands FIRST — the
 *       result artifact is the completion signal the reconciler acts on, so a
 *       result that lands first can be ingested while its bundle is still missing.
 *     - The bundle must carry `HEAD`: `LocalBundleInspector.changedPaths` runs
 *       `git fetch ... HEAD:<ref>` against it, and a bundle with only a branch ref
 *       dies "couldn't find remote ref HEAD" and is rejected `changed_paths_error`.
 *     - NEVER zsh. The golden image ships bash + uv and no zsh; B4 run 1 died
 *       exit 127 on `env: 'zsh': No such file or directory`.
 *     - The engine venv must be BOX-LOCAL. On the NFS share it took 11m59s and
 *       then SIGPIPEd; box-local it is 112ms.
 *
 * @outputs
 *   - `renderVerbScriptBody` -- the fixed executable body for one verb dispatch
 *   - `isSafeAppName` -- the app-name charset the body may interpolate
 *
 * @dependencies
 *   - ./verb-dispatch -- the verb allowlist
 *   - ./verb-base -- the full-sha shape a change base must take
 *   - ../templates/agent-lane -- the fixed result/bundle artifact names
 */
import { createHash } from "node:crypto";

import { traced } from "../log";
import { CHANGE_BUNDLE_NAME, WATCHER_RESULT_NAME } from "../templates/agent-lane";
import { isFullGitSha } from "./verb-base";

/** The heredoc delimiter for the manifest. Quoted at the use site, so inert. */
const MANIFEST_DELIMITER = "SF_RAILS_MANIFEST_EOF";

/**
 * A DNS-label-shaped app name: lowercase alphanumerics and interior hyphens.
 *
 * This is the charset a Kubernetes object name may take anyway, so nothing valid
 * is excluded — and it contains no shell metacharacter, no whitespace, no quote,
 * and no path separator, which is what makes the value safe to splice into the
 * command block. Bounded at 63 to match the DNS label limit.
 */
export const isSafeAppName = traced(
	"jobs.isSafeAppName",
	function isSafeAppName(value: string): boolean {
		return /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/.test(value);
	},
);

/** Everything one verb dispatch needs to render its executable body. */
export interface VerbScriptBodyInput {
	verb: string;
	/** The managed repository identity this verb was dispatched for. */
	repository: string;
	itemNumber: number;
	app: string;
	manifest: { content: string; sha256: string };
	/** The rtech/k3s-deploy commit the change must be rooted on. Full 40 hex. */
	k3sBaseSha: string;
	/** The read-only rtech-infra checkout on the share (render engine). */
	enginePath: string;
	/** The read-only rtech/k3s-deploy checkout on the share (base objects). */
	k3sCheckoutPath: string;
}

/** The up verbs, which copy compiled output IN and stage an add. */
const UP_VERBS = ["newroute", "newapp", "newdb"] as const;

/** The down verbs, which stage a git-tracked removal of the app's output. */
const DOWN_VERBS = ["newroute-down", "newapp-down", "newdb-down"] as const;

/** Every verb this body can represent. Anything else fails closed. */
const RENDERABLE_VERBS = [...UP_VERBS, ...DOWN_VERBS] as const;

/** True only for a reviewed verb id; every other value fails closed. */
function isRenderableVerb(value: string): boolean {
	return (RENDERABLE_VERBS as readonly string[]).includes(value);
}

/** True for the three removal verbs, which take the prune assemble section. */
function isDownVerb(value: string): boolean {
	return (DOWN_VERBS as readonly string[]).includes(value);
}

/** A managed repository full name with no shell or structural characters. */
function isSafeRepository(value: string): boolean {
	return /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(value);
}

/** An absolute path with no shell metacharacter, quote, or whitespace. */
function isSafeAbsolutePath(value: string): boolean {
	return /^\/[A-Za-z0-9._\-/]*$/.test(value) && !value.includes("..");
}

/**
 * Render the fixed executable command block for one verb dispatch, or `null`
 * when any input fails its validation.
 *
 * Returning `null` rather than throwing keeps this on the same contract as
 * `renderScriptCommandBlock`: an unrenderable body becomes a bounded terminal
 * dispatch skip before a job is persisted, instead of shipping something the box
 * would die on.
 *
 * @param input - the validated verb, item, app, manifest, base, and share paths
 * @returns the executable body, or `null` when an input is not allowlisted
 */
/**
 * True only when EVERY value that will be spliced into the command block has
 * been proven to match its reviewed allowlisted shape.
 *
 * This is the substitute for #177's "no substitution slot at all": a verb job is
 * per-item by nature so the slots must exist, and the security property is moved
 * from "there is nowhere for content to reach" to "nothing reaches a slot that
 * has not been validated". Kept as its own function so the gate is readable as
 * one list rather than buried above a 100-line literal.
 */
function inputsAreAllowlisted(input: VerbScriptBodyInput): boolean {
	if (!isRenderableVerb(input.verb)) return false;
	if (!isSafeRepository(input.repository)) return false;
	if (!Number.isInteger(input.itemNumber) || input.itemNumber < 1) return false;
	if (!isSafeAppName(input.app)) return false;
	if (!isFullGitSha(input.k3sBaseSha)) return false;
	if (!/^[0-9a-f]{64}$/.test(input.manifest.sha256)) return false;
	if (!isSafeAbsolutePath(input.enginePath)) return false;
	if (!isSafeAbsolutePath(input.k3sCheckoutPath)) return false;
	// Bash discards embedded NUL bytes while parsing. Without this guard, a token
	// split by NUL can become the exact heredoc delimiter before the digest check.
	if (input.manifest.content.includes("\0")) return false;
	// A manifest carrying the delimiter would end the heredoc early and the rest
	// of its bytes WOULD reach the shell. Refuse rather than escape: the operator
	// controls this file, and a manifest containing the delimiter is a mistake
	// worth surfacing, not something to silently rewrite.
	if (input.manifest.content.includes(MANIFEST_DELIMITER)) return false;
	return true;
}

/** One section's lines. Named per the body's own `# ---` boundaries. */
type Section = readonly string[];

/** Preamble: the shebang, the fail-fast mode, and the validated scalars. */
function preamble(v: {
	verb: string;
	repository: string;
	itemNumber: number;
	app: string;
	dispatchSha: string;
	k3sBaseSha: string;
	enginePath: string;
	k3sCheckoutPath: string;
	onBoxSha256: string;
}): Section {
	return [
		"#!/usr/bin/env bash",
		"# Deterministic k3s verb — RENDER AND RETURN ONLY (sf#301).",
		"# The box holds no forge credential; rails eval, branch push, and the",
		"# proposal are watcher-owned. Nothing below contacts a forge.",
		"set -euo pipefail",
		"",
		`verb=${v.verb}`,
		`repository=${v.repository}`,
		`item_number=${v.itemNumber}`,
		`app=${v.app}`,
		`dispatch_sha=${v.dispatchSha}`,
		`k3s_base_sha=${v.k3sBaseSha}`,
		`engine_src=${v.enginePath}`,
		`k3s_src=${v.k3sCheckoutPath}`,
		// The digest of the ON-BOX bytes, not of the caller's string — those differ
		// whenever the source lacks or doubles a trailing newline, and the guard
		// below compares against what is actually on disk.
		`manifest_sha256=${v.onBoxSha256}`,
		"",
		"# The share path is RECONSTRUCTED, never inherited: the wrapper's $SHARE is",
		"# not exported, so this child process does not have it. RUNNER_JOB_ID is",
		"# inherited, and the host directory comes from the hostname COMMAND — never",
		"# a $HOSTNAME expansion, which a live agent twice expanded to a guess (#125).",
		'share_root="${SF_SHARE_ROOT:-/mnt/share}"',
		'work_root="${SF_WORK_ROOT:-/work}"',
		"",
		...failsafeTrap(),
		"",
		'host="$(hostname)"',
		'out_dir="${share_root}/runners/jobs/${RUNNER_JOB_ID}/${host}"',
		'mkdir -p "$out_dir"',
	];
}

/**
 * The EXIT trap, armed BEFORE the first command that can fail.
 *
 * Without it an unbound `RUNNER_JOB_ID`, a missing `hostname`, or an unwritable
 * share exits 1 with NO artifact, and the watcher then reports a generic
 * missing-result error instead of a phase-named one.
 *
 * The error result goes under the WRAPPER's own output directory, which the
 * wrapper copies to the share — `out_dir` itself may be exactly what could not
 * be created.
 *
 * This is a floor for UNANTICIPATED failure only. Every DELIBERATE non-zero exit
 * in this body sets `result_written=1` first to suppress it, because those exit
 * statuses are contracts pinned by tests (the prune refusal exits 1 with no
 * artifact), and every deliberate ERROR result exits 0 after the write so the
 * wrapper reads it (the stale-base path).
 */
function failsafeTrap(): Section {
	return [
		"# exit 0 inside the trap is DELIBERATE: the wrapper refuses a non-zero status",
		"# before the result is read, so a non-zero exit here would discard the very",
		"# error result that must reach the watcher.",
		"result_written=0",
		"on_exit() {",
		'  if [ "$result_written" = 0 ]; then',
		'    mkdir -p "${work_root}/out"',
		`    cat > "\${work_root}/out/.${WATCHER_RESULT_NAME}.tmp" <<JSON`,
		"{",
		'  "result_version": 2,',
		'  "repository": "${repository}",',
		'  "job_type": "${verb}",',
		'  "item_number": ${item_number},',
		'  "sha": "${dispatch_sha}",',
		'  "status": "error",',
		'  "checks": [',
		'    {"name": "verb preamble", "status": "error", "summary": "verb body failed before its result was written"}',
		"  ],",
		'  "findings": []',
		"}",
		"JSON",
		`    mv -f "\${work_root}/out/.${WATCHER_RESULT_NAME}.tmp" "\${work_root}/out/${WATCHER_RESULT_NAME}"`,
		"    exit 0",
		"  fi",
		"}",
		"trap on_exit EXIT",
	];
}

/** The rails manifest, delivered as quoted-heredoc DATA and digest-asserted. */
function manifestSection(manifestBytes: string): Section {
	return [
		"",
		"# --- the rails manifest, as DATA -------------------------------------------",
		"# A QUOTED heredoc: no parameter expansion, no command substitution, no",
		"# arithmetic. Manifest bytes cannot reach the shell. Written to a file and",
		"# integrity-bound before render work; nothing on-box consumes its semantics.",
		'manifest_file="${work_root}/rails-manifest.yaml"',
		`cat > "$manifest_file" <<'${MANIFEST_DELIMITER}'`,
		// Spliced without its own trailing newline: the `join("\n")` supplies exactly
		// one before the delimiter, which is the byte the heredoc writes.
		manifestBytes.replace(/\n$/, ""),
		MANIFEST_DELIMITER,
		"",
		'observed_sha256="$(sha256sum "$manifest_file" | cut -d" " -f1)"',
		'if [ "$observed_sha256" != "$manifest_sha256" ]; then',
		'  echo "verb: rails manifest digest mismatch" >&2',
		"  exit 1",
		"fi",
	];
}

/** Exit successfully when the compiled output is identical to the dispatched base. */
function noChangeExit(): Section {
	return [
		'if git -C "$repo_dir" diff --cached --quiet; then',
		`  cat > "$out_dir/.${WATCHER_RESULT_NAME}.tmp" <<JSON`,
		"{",
		'  "result_version": 2,',
		'  "repository": "${repository}",',
		'  "job_type": "${verb}",',
		'  "item_number": ${item_number},',
		'  "sha": "${dispatch_sha}",',
		'  "status": "passed",',
		'  "checks": [',
		'    {"name": "service-catalog compile", "status": "pass"},',
		'    {"name": "service-catalog render", "status": "pass", "summary": "render produced no changes"},',
		'    {"name": "secrets", "status": "skip"},',
		'    {"name": "test", "status": "skip"}',
		"  ],",
		'  "findings": []',
		"}",
		"JSON",
		`  mv -f "$out_dir/.${WATCHER_RESULT_NAME}.tmp" "$out_dir/${WATCHER_RESULT_NAME}"`,
		"  result_written=1",
		'  echo "verb ${verb} rendered ${app} for item ${item_number}: no changes"',
		"  exit 0",
		"fi",
	];
}

/** Clone and validate the dispatched base before paying the compile cost. */
function prepareBase(): Section {
	return [
		"",
		"# --- validate the DISPATCHED base -------------------------------------------",
		"# Base objects come from the read-only share checkout, never from a forge.",
		"# A dispatched commit absent from this share clone is TERMINAL for this job:",
		"# the infra-requeue sweep deliberately skips verb rows (sf#302) and the verb",
		"# lane never re-runs a terminal tuple, so nothing retries it (sf#596). The body",
		"# writes a phase-named error result naming the recovery signal instead of",
		"# dying with no artifact: the operator refreshes the share checkout",
		"# (pull --ff-only) and re-runs with the one-shot redeploy:<app> label.",
		'repo_dir="${work_root}/k3s-deploy-${RUNNER_JOB_ID}"',
		// The share checkout is owned by a DIFFERENT uid than the box job user, so
		// git refuses it as "dubious ownership" (receipt run 1).
		//
		// GLOBAL CONFIG, NOT `-c`: git honors `safe.directory` ONLY from PROTECTED
		// config — system or global — and silently ignores the per-invocation `-c`
		// and `GIT_CONFIG_*` env forms for this one key. That is not version lore;
		// it was PROBED on the golden image itself (git 2.47.3, box run
		// sf-safedir-mechanism-probe-20260816): `-c` alone exited 128 on dubious
		// ownership, `GIT_CONFIG_COUNT/KEY/VALUE` exited 128, and
		// `git config --global --add` exited 0. The shipped `-c` form was
		// never live-proven and killed the first staged dispatch exit 128.
		//
		// Both PATHS are still required: safe.directory on the checkout path alone
		// is NOT enough, because git's local clone transport separately checks the
		// source's .git path (receipt run 2 failed with the path alone; run 3
		// passed with both).
		//
		// Writing box-global config is the accepted posture here: the box is
		// disposable, single-tenant, and destroyed after the job, so the blast
		// radius of the trust entry is the job itself. rtech-infra#807 bakes the
		// same trust into the runner user's gitconfig at the next image rebuild,
		// which makes these two lines redundant-but-harmless — they stay anyway,
		// because the body must not depend on image state it cannot verify.
		//
		// $k3s_src already passed isSafeAbsolutePath before it could reach a slot
		// (no shell metacharacters, whitespace, quotes, or ..), so these values
		// inherit that same allowlist property. No new interpolation site.
		'git config --global --add safe.directory "$k3s_src"',
		'git config --global --add safe.directory "$k3s_src/.git"',
		'git clone --quiet --no-checkout "$k3s_src" "$repo_dir"',
		'if ! git -C "$repo_dir" cat-file -e "${k3s_base_sha}^{commit}" 2>/dev/null; then',
		'  echo "verb ${verb}: k3s-deploy base ${k3s_base_sha} not present in share checkout clone — share refresh required (pull --ff-only)" >&2',
		// Until sf#596 this exited 42 with NO result on the promise that infra-requeue
		// would retry it. No component performs that retry for a verb row, so the job
		// was terminal at its first attempt and the only operator-facing text was the
		// generic "watcher-result.json is missing". Now the failure is a result: the
		// check names the phase and the summary names the recovery. Exit 0 after the
		// write for the same reason the trap does — the wrapper refuses a non-zero
		// status before the result is read. `k3s_base_sha` is 40 hex and `app` passed
		// the slot allowlist, so the summary carries no new interpolation risk.
		`  cat > "$out_dir/.${WATCHER_RESULT_NAME}.tmp" <<JSON`,
		"{",
		'  "result_version": 2,',
		'  "repository": "${repository}",',
		'  "job_type": "${verb}",',
		'  "item_number": ${item_number},',
		'  "sha": "${dispatch_sha}",',
		'  "status": "error",',
		'  "checks": [',
		'    {"name": "k3s-deploy base", "status": "error", "summary": "dispatched base ${k3s_base_sha} is absent from the share checkout clone; refresh the share (pull --ff-only), then re-run with redeploy:${app}"}',
		"  ],",
		'  "findings": []',
		"}",
		"JSON",
		`  mv -f "$out_dir/.${WATCHER_RESULT_NAME}.tmp" "$out_dir/${WATCHER_RESULT_NAME}"`,
		"  result_written=1",
		"  exit 0",
		"fi",
		'git -C "$repo_dir" checkout --quiet --detach "$k3s_base_sha"',
	];
}

/**
 * Box-local compile. SHARED by the up and down bodies verbatim — the two differ
 * only in what they do with the compiled tree afterwards, so a change here is a
 * change to both and the up-verb regression pin in the test suite says so.
 */
function compileBoxLocal(): Section {
	return [
		"",
		"# --- render, box-local ------------------------------------------------------",
		"# The shared checkout is read-only by design and compile WRITES generated",
		"# files, so it is copied box-local first. The venv must also be box-local:",
		"# on the NFS share it took 11m59s and then SIGPIPEd (rtech-infra#801).",
		"# bash only — the golden image ships no zsh (B4 run 1, exit 127).",
		"# A FRESH directory per attempt rather than clearing a reused one: the body",
		"# issues no recursive delete (AGENTS.md), and a per-attempt path cannot",
		"# inherit a half-built tree from a failed run.",
		'engine_dir="${work_root}/engine-${RUNNER_JOB_ID}"',
		'mkdir -p "$engine_dir"',
		"# `-R`, NOT `-a`: the /work filesystem REFUSES mode preservation, so every",
		"# file logs `cp: preserving permissions ...: Operation not supported` and cp",
		"# exits 1 — which under `set -euo pipefail` killed the body before compile",
		"# ever ran (sf#311, live on rw-newapp-676470d8). The tree content copies",
		"# fine; only the chmod is refused, and nothing below reads a mode.",
		'cp -R "$engine_src/." "$engine_dir/"',
		"# Invoked through an EXPLICIT interpreter because `-R` does not guarantee the",
		"# x-bit survives the copy off the share. `scripts/service-catalog` carries",
		"# `#!/usr/bin/env bash`, so `bash <path>` IS its own shebang and the call no",
		"# longer depends on an executable bit the copy may or may not have kept.",
		'bash "$engine_dir/scripts/service-catalog" compile --all --repo "$engine_dir"',
	];
}

/**
 * The commit + bundle tail, SHARED by both assemble sections.
 *
 * The message verb differs, and nothing else does: both bodies commit whatever
 * the assemble section staged onto the already-validated base and bundle it
 * against that same base. `HEAD` is required in the bundle — the watcher's
 * inspector runs `git fetch ... HEAD:<ref>` and a bundle carrying only a branch
 * ref is rejected `changed_paths_error`.
 */
function commitAndBundle(action: "render" | "prune"): Section {
	return [
		'git -C "$repo_dir" -c user.email=factory@example.internal -c user.name="software-factory" \\',
		`  commit --quiet -m "\${verb}: ${action} \${app} (item \${item_number})"`,
		'head_sha="$(git -C "$repo_dir" rev-parse HEAD)"',
		"",
		"# HEAD is REQUIRED in the bundle: the watcher's inspector runs",
		"# `git fetch ... HEAD:<ref>` against it, and a bundle carrying only a branch",
		"# ref is rejected changed_paths_error.",
		`bundle_tmp="\${work_root}/${CHANGE_BUNDLE_NAME}"`,
		'git -C "$repo_dir" bundle create "$bundle_tmp" "^${k3s_base_sha}" HEAD',
	];
}

/** Copy the compiled output IN and stage an add — the up verbs. */
function assembleAdd(): Section {
	return [
		"",
		"# --- assemble the change ----------------------------------------------------",
		'mkdir -p "$repo_dir/apps" "$repo_dir/manifests/apps/${app}"',
		'cp "$engine_dir/gitops/k3s-deploy/apps/${app}.yaml" "$repo_dir/apps/${app}.yaml"',
		"# `-R` for the same reason as the engine copy above (sf#311): the",
		"# destination is the box-local clone, and git records no mode beyond the",
		"# x-bit, which no rendered manifest carries.",
		'cp -R "$engine_dir/gitops/k3s-deploy/manifests/apps/${app}/." "$repo_dir/manifests/apps/${app}/"',
		"",
		'git -C "$repo_dir" -c user.email=factory@example.internal -c user.name="software-factory" \\',
		'  add -- "apps/${app}.yaml" "manifests/apps/${app}"',
		...noChangeExit(),
		...commitAndBundle("render"),
	];
}

/**
 * Stage a git-tracked REMOVAL of the app's output — the down verbs.
 *
 * TWO PROPERTIES, and both were the whole reason sf#302 fail-closed here instead
 * of reusing the add body:
 *
 * THE REMOVAL IS `git rm`, NEVER A RAW DELETE. AGENTS.md forbids an agent-issued
 * recursive or forced delete outright, and the shape is also the only correct
 * one: the change this body returns is a COMMIT, so a deletion that git has not
 * staged produces nothing at all. `-r` because `manifests/apps/<app>` is a
 * directory; `--ignore-unmatch` because a base that never carried the app is a
 * legitimate no-change (the `noChangeExit` guard below reports it as a passed
 * changeless result) and plain `git rm` would die exit 128 on it instead. Both
 * pathspecs sit after `--` and each is built from `$app`, which passed
 * `isSafeAppName` before it could reach a slot — no separator, no metacharacter,
 * so neither can escape the app's own subtree.
 *
 * THE FAIL-CLOSED CATALOG GUARD. `_DOCS/control-surface.md` states that
 * `spindown:<app>` runs the reverse projection AFTER the app is removed from the
 * service catalog. This body cannot see the catalog — it only ever sees the
 * compiled tree — but a still-present compiled output is exactly the observable
 * consequence of that ordering being violated. Pruning anyway would stage a
 * deletion that the very next up-verb compile re-adds, so the spin-down would
 * silently undo itself one cycle later and the operator would have no signal at
 * all. So the body refuses, naming the un-removed catalog entry, and the run
 * fails loudly with a bounded operator action.
 */
function assemblePrune(): Section {
	return [
		"",
		"# --- refuse a prune that runs BEFORE catalog removal (sf#304) ----------------",
		"# control-surface.md: spindown:<app> runs the reverse projection AFTER the app",
		"# leaves the service catalog. A compiled output that still carries the app is",
		"# the observable consequence of that ordering being violated — and a prune",
		"# staged then is re-added by the next up-verb compile, silently undoing the",
		"# spin-down. Fail here instead, naming the entry that was not removed.",
		'if [ -e "$engine_dir/gitops/k3s-deploy/apps/${app}.yaml" ]; then',
		'  echo "verb ${verb}: catalog entry gitops/k3s-deploy/apps/${app}.yaml is still present after compile — the app was not removed from the service catalog; a prune before catalog removal is re-added by the next up-verb" >&2',
		// Trap SUPPRESSED: this refusal's shipped contract is a non-zero exit with no
		// result artifact, pinned by tests/jobs/verb-body.test.ts. sf#579 adds a floor
		// for UNANTICIPATED failure; it does not restate the deliberate refusals.
		"  result_written=1",
		"  exit 1",
		"fi",
		"",
		"# --- assemble the change ----------------------------------------------------",
		"# A GIT-TRACKED removal, never a raw recursive delete (AGENTS.md, and the",
		"# change this body returns is a commit — an unstaged deletion returns nothing).",
		"# `--ignore-unmatch` so a base that never carried the app is the changeless",
		"# result the guard below reports, not an exit-128 failure.",
		"# The clone is --no-checkout + detach, so the working tree already holds the",
		"# base's files; `git rm` removes them from BOTH the index and that tree.",
		'git -C "$repo_dir" -c user.email=factory@example.internal -c user.name="software-factory" \\',
		'  rm -r --quiet --ignore-unmatch -- "apps/${app}.yaml" "manifests/apps/${app}"',
		...noChangeExit(),
		...commitAndBundle("prune"),
	];
}

/**
 * The hand-back, and the ORDER IS THE SAFETY PROPERTY: the bundle lands BEFORE
 * the result. The result artifact is the completion signal the reconciler acts
 * on, so a result that arrives first can be ingested while its bundle is still
 * missing or mid-copy — a live agent produced exactly that failure on the
 * implement lane.
 */
function handBack(): Section {
	return [
		"",
		"# --- hand back --------------------------------------------------------------",
		"# Both writes are ATOMIC (temp file in the same directory, then rename), and",
		"# the bundle is FIRST. See this function's docblock for why the order matters.",
		`cp "$bundle_tmp" "$out_dir/.${CHANGE_BUNDLE_NAME}.tmp"`,
		`mv -f "$out_dir/.${CHANGE_BUNDLE_NAME}.tmp" "$out_dir/${CHANGE_BUNDLE_NAME}"`,
		"",
		`cat > "$out_dir/.${WATCHER_RESULT_NAME}.tmp" <<JSON`,
		"{",
		'  "result_version": 2,',
		'  "repository": "${repository}",',
		'  "job_type": "${verb}",',
		'  "item_number": ${item_number},',
		'  "sha": "${dispatch_sha}",',
		'  "status": "passed",',
		'  "checks": [',
		'    {"name": "service-catalog compile", "status": "pass"},',
		'    {"name": "secrets", "status": "skip"},',
		'    {"name": "test", "status": "skip"}',
		"  ],",
		'  "findings": [],',
		'  "change": {',
		'    "base_sha": "${k3s_base_sha}",',
		'    "head_sha": "${head_sha}",',
		`    "bundle_path": "${CHANGE_BUNDLE_NAME}"`,
		"  }",
		"}",
		"JSON",
		`mv -f "$out_dir/.${WATCHER_RESULT_NAME}.tmp" "$out_dir/${WATCHER_RESULT_NAME}"`,
		"result_written=1",
		"",
		'echo "verb ${verb} rendered ${app} for item ${item_number} at ${head_sha}"',
		"",
	];
}

export const renderVerbScriptBody = traced(
	"jobs.renderVerbScriptBody",
	function renderVerbScriptBody(input: VerbScriptBodyInput): string | null {
		if (!inputsAreAllowlisted(input)) return null;
		// A HEREDOC ALWAYS TERMINATES ITS LAST LINE. So the bytes the box writes are
		// the manifest with exactly one trailing newline, whatever the source file
		// had — and the digest the body asserts must be the digest OF THOSE BYTES, not
		// of the caller's string.
		//
		// Getting this wrong is not theoretical: splicing content that already ended
		// in "\n" emitted one byte too many, and the body's own guard then refused
		// EVERY dispatch with "rails manifest digest mismatch". The done-means probe
		// missed it because its stubbed `sha256sum` returned the expected digest
		// unconditionally; the functional test running the real tool caught it at
		// once. A stub that cannot fail proves nothing.
		const manifestBytes = `${input.manifest.content.replace(/\n+$/, "")}\n`;
		const onBoxSha256 = createHash("sha256").update(manifestBytes).digest("hex");

		return [
			...preamble({ ...input, dispatchSha: input.manifest.sha256, onBoxSha256 }),
			...manifestSection(manifestBytes),
			...prepareBase(),
			...compileBoxLocal(),
			...(isDownVerb(input.verb) ? assemblePrune() : assembleAdd()),
			...handBack(),
		].join("\n");
	},
);
