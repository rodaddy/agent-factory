/**
 * @module prepush/body-sections
 * @description The fixed, author-owned sections of the exact-SHA pre-push runner
 *   body, plus the input derivation they are built from. Since sf#573 the body is
 *   an EXECUTABLE bash script the `script` runtime execs (`/bin/bash /work/job/job.md`)
 *   — no agent reads it — so every builder here returns BASH LINES, not prose.
 *   `prepush/body.ts` derives the sanitized inputs and concatenates these builders
 *   into one bounded script. Only sanitized, already-validated metadata and fixed
 *   author constants are interpolated; no command, path, or endpoint is ever
 *   sourced from repository content.
 *
 *   `sandboxSection` carries the bwrap launcher and the in-sandbox script VERBATIM.
 *   It is a single security contract — the launcher's flag order is load-bearing
 *   (`--dir` lines must precede the binds, see issue #31) — so it stays one intact
 *   block rather than being subdivided to satisfy a line ceiling.
 *
 * @outputs
 *   - `PrepushBodyInputs` / `derivePrepushBodyInputs` -- validated, sanitized render inputs
 *   - `setupSection` -- §1 author-owned setup (bash)
 *   - `sandboxSection` -- §2 the verbatim sandboxed-validation contract (bash)
 *   - `resultSection` -- §3 author-owned classification and result write (bash)
 *
 * @dependencies
 *   - ../log -- record the fail-closed derivation refusals
 *   - ../runner/packages -- the fixed author-owned apt package names
 *   - ../runner/script-runtime -- the ONE composition of the fixed command set
 *   - ../templates/registry -- the generic fixed body, reused as context
 *   - ./paths -- the single shared job-scoped staged-bundle path derivation
 */
import { errorMessage, log, traced } from "../log";
import { RUNNER_BUBBLEWRAP_PACKAGE, RUNNER_POSTGRESQL_PACKAGE } from "../runner/packages";
import { scriptCommandSet } from "../runner/script-runtime";
import { renderJobBody } from "../templates/registry";
import { scratchPostgresLines } from "../templates/scratch-postgres";
import {
	PREPUSH_RESULT_PATH,
	PREPUSH_RUNNER_CHECKOUT,
	PREPUSH_RUNNER_OUT_ROOT,
	PREPUSH_RUNNER_PG_BINDIR,
	PREPUSH_RUNNER_PG_DATA,
	PREPUSH_RUNNER_PG_PORT,
	PREPUSH_RUNNER_PG_ROOT,
	PREPUSH_RUNNER_PG_SOCK,
	PREPUSH_RUNNER_SCRIPT,
	PREPUSH_RUNNER_SCRIPT_SOURCE,
	PREPUSH_RUNNER_TEST_TMP,
	PREPUSH_RUNNER_WORK_ROOT,
} from "./body-constants";
import { isFullSha } from "./git";
import { DEPS_REGISTRY, jobBundlePaths, RUNNER_COLLAB_ROOT } from "./paths";
import { PREPUSH_RESULT_NAME, PREPUSH_TEMPLATE_ID } from "./receipt";

/** The already-derived, re-sanitized inputs the fixed body sections are built from. */
export interface PrepushBodyInputs {
	generic: string;
	runnerBundlePath: string;
	repo: string;
	commit: string;
	comparisonBaseSha?: string;
	runnerResultPath: string;
	runnerLogPath: string;
	commands: readonly string[];
	pgData: string;
	pgSock: string;
	pgUrl: string;
}

/**
 * The base `bun run check:affected` diffs against when no comparison base was
 * computed (a repo other than software-factory). No commit has this name, so
 * scripts/affected-tests.ts answers FULL: the whole suite runs.
 */
const NO_AFFECTED_BASE = "0".repeat(40);

/** The local (in-box) path of the combined outer log the result points the watcher at. */
const PREPUSH_LOG_LOCAL = "/work/out/validation.log";

/** Conservative safe charset for the bounded metadata values embedded below. */
function sanitizeMeta(value: string): string {
	return value.replace(/[^A-Za-z0-9._/-]/g, "").slice(0, 120);
}

function validComparisonBase(
	comparisonBaseSha: string | undefined,
	jobId: string,
	repository: string,
	sha: string,
): boolean {
	if (comparisonBaseSha === undefined || isFullSha(comparisonBaseSha)) return true;
	log("warn", "prepush.body.invalid_comparison_base", { job_id: jobId, repository, sha });
	return false;
}

/**
 * Render the generic template and derive the safe staged bundle path plus the
 * sanitized metadata the body sections embed. `repository` and `sha` are already
 * validated upstream (owner/repo regex, hex SHA); they are re-sanitized here as
 * defence-in-depth so a crafted value can never introduce a new script line.
 * Returns `null` (fail-closed) if the generic template is unavailable, the job
 * id cannot derive a safe bundle path, or a fixed command contains a single
 * quote (the script splices each command inside `'...'`, so a quote would break
 * out of the literal — both fixed commands are quote-free today).
 */
export const derivePrepushBodyInputs = traced(
	"prepush.derivePrepushBodyInputs",
	function derivePrepushBodyInputs(
		repository: string,
		sha: string,
		jobId: string,
		comparisonBaseSha?: string,
	): PrepushBodyInputs | null {
		if (!validComparisonBase(comparisonBaseSha, jobId, repository, sha)) return null;
		const generic = renderJobBody(PREPUSH_TEMPLATE_ID, { repository, sha });
		if (generic === null) {
			return null;
		}
		let runnerBundlePath: string;
		try {
			runnerBundlePath = jobBundlePaths("/", jobId).runnerBundlePath;
		} catch (err) {
			log("warn", "prepush.body.unsafe_job_id", {
				job_id: jobId,
				repository,
				sha,
				cause: errorMessage(err),
			});
			return null;
		}
		const commands = scriptCommandSet(PREPUSH_TEMPLATE_ID).flatMap((group) => group.commands);
		// Each command is spliced into the script inside a single-quoted bash literal
		// and into a JSON string. Fail closed rather than emit a script whose quoting
		// a future command edit could break open.
		for (const command of commands) {
			if (command.includes("'") || command.includes('"') || command.includes("\\")) {
				log("warn", "prepush.body.unsafe_command", { job_id: jobId, repository, sha });
				return null;
			}
		}
		return {
			generic,
			runnerBundlePath,
			repo: sanitizeMeta(repository),
			commit: sanitizeMeta(sha),
			comparisonBaseSha,
			runnerResultPath: `${RUNNER_COLLAB_ROOT}/runners/jobs/${jobId}/<host>/${PREPUSH_RESULT_NAME}`,
			runnerLogPath: `${RUNNER_COLLAB_ROOT}/runners/jobs/${jobId}/<host>/validation.log`,
			commands,
			pgData: `${PREPUSH_RUNNER_PG_DATA}-${jobId}`,
			pgSock: `${PREPUSH_RUNNER_PG_SOCK}-${jobId}`,
			pgUrl: `postgres://postgres@127.0.0.1:${PREPUSH_RUNNER_PG_PORT}/postgres`,
		};
	},
);

/**
 * §1 — the author-owned setup the trusted outer coordinator runs directly. No
 * candidate code executes here, which is why the clone, the checkout, the locked
 * dependency install, and every chown/chmod live in this step: the checkout is
 * bound READ-ONLY inside the sandbox, so every write to it must complete now.
 *
 * The EXIT trap is the fail-closed half of the contract: any failure before the
 * result is written still hands the watcher a bounded `error` result naming the
 * phase, and the script exits 0 so the wrapper envelope reports a completed job
 * (a non-zero wrapper status is refused before the result is ever read).
 */
export const preambleSection = traced(
	"prepush.preambleSection",
	function preambleSection(inputs: PrepushBodyInputs): string[] {
		return [
			"# --- 0. preamble: fixed paths and the fail-closed EXIT trap --------------------",
			"set -euo pipefail",
			// Only assignments that CANNOT fail come before the trap. `hostname`, the
			// derived out_dir, and the mkdir all moved BELOW `trap on_exit EXIT`:
			// an unbound RUNNER_JOB_ID, a missing hostname, or an unwritable share used to
			// exit 1 with NO result artifact at all, and the watcher refuses a non-zero
			// wrapper status before it ever opens a result.
			`share_root=${RUNNER_COLLAB_ROOT}`,
			`checkout=${PREPUSH_RUNNER_CHECKOUT}`,
			`result_local=${PREPUSH_RESULT_PATH}`,
			`log_local=${PREPUSH_LOG_LOCAL}`,
			"result_written=0",
			"phase=preamble",
			// Self-contained by construction: it references nothing defined later and
			// nothing that can be unset. `$3` is the summary, matching write_result's
			// signature, so both share one errorChecksJson rendering.
			"write_early_error() {  # $3 = summary (signature matches write_result)",
			`  mkdir -p ${PREPUSH_RUNNER_OUT_ROOT} 2>/dev/null || true`,
			// errorChecksJson escapes its quotes for a DOUBLE-QUOTED bash assignment (that
			// is how write_result consumes it), so it is assigned here the same way rather
			// than spliced raw into the heredoc — raw, the backslashes survive into the
			// artifact and the watcher cannot parse it.
			`  checks="${errorChecksJson(inputs)}"`,
			`  cat > ${PREPUSH_RESULT_PATH}.tmp <<EOF`,
			`{"result_version":1,"repository":"${inputs.repo}","job_type":"${PREPUSH_TEMPLATE_ID}","sha":"${inputs.commit}","status":"error","checks":[$checks],"output_path":"\${share_root}/runners/jobs/\${RUNNER_JOB_ID:-}/\${host:-}/validation.log"}`,
			"EOF",
			`  mv -f ${PREPUSH_RESULT_PATH}.tmp "$result_local"`,
			'  if [ -n "${out_dir:-}" ] && [ -d "${out_dir:-}" ]; then',
			`    cp "$result_local" "$out_dir/.${PREPUSH_RESULT_NAME}.tmp" && mv -f "$out_dir/.${PREPUSH_RESULT_NAME}.tmp" "$out_dir/${PREPUSH_RESULT_NAME}"`,
			"  fi",
			"  result_written=1",
			"}",
			// `exit 0` INSIDE the EXIT trap overrides the failing status: the error result
			// (which names the phase) is what the watcher must read, and a non-zero wrapper
			// status is refused before the result is ever opened. write_result is defined in
			// §3, which a preamble-phase failure may never reach — hence the fallback.
			"on_exit() {",
			'  if [ "$result_written" = 0 ]; then',
			"    if declare -F write_result >/dev/null 2>&1; then",
			'      write_result error "" "setup failed during phase: ${phase}"',
			"    else",
			'      write_early_error "" "" "setup failed during phase: ${phase}"',
			"    fi",
			"    exit 0",
			"  fi",
			"}",
			"trap on_exit EXIT",
			// The host directory is filled by RUNNING `hostname`, never by expanding a
			// $HOSTNAME env ref — a guessed number is REFUSED at the watcher read boundary.
			'host="$(hostname)"',
			'out_dir="${share_root}/runners/jobs/${RUNNER_JOB_ID}/${host}"',
			`mkdir -p "$out_dir" ${PREPUSH_RUNNER_OUT_ROOT}`,
			"phase=setup",
		];
	},
);

export const setupSection = traced(
	"prepush.setupSection",
	function setupSection(inputs: PrepushBodyInputs): string[] {
		const comparisonBaseLines =
			inputs.comparisonBaseSha === undefined
				? []
				: [
						"# Restore the controller-observed canonical Forge main fork point from the candidate's ancestor objects.",
						`git -C "$checkout" cat-file commit ${inputs.comparisonBaseSha}`,
						`git -C "$checkout" merge-base --is-ancestor ${inputs.comparisonBaseSha} ${inputs.commit}`,
						`git -C "$checkout" update-ref refs/remotes/origin/main ${inputs.comparisonBaseSha}`,
					];
		return [
			"# --- 1. author-owned setup (runs as the trusted outer coordinator) ----------",
			"# Candidate code does NOT run in this section.",
			"# The watcher staged the exact commit as a Git bundle; clone THAT, never a remote.",
			`git clone --quiet ${inputs.runnerBundlePath} "$checkout"`,
			`git -C "$checkout" checkout --quiet --detach ${inputs.commit}`,
			`test "$(git -C "$checkout" rev-parse HEAD)" = ${inputs.commit}`,
			...comparisonBaseLines,
			"phase=install",
			// Explicit cd because a runner agent ran the install from /work on 2026-08-17
			// — the cwd is STATED, never inferred. --frozen-lockfile installs only
			// what bun.lock pins, --ignore-scripts blocks candidate lifecycle scripts, and
			// the explicit --registry fixes the fetch host so a candidate .npmrc cannot
			// redirect it. A varying install count is EXPECTED per box and is not a defect.
			`cd ${PREPUSH_RUNNER_CHECKOUT} && bun install --frozen-lockfile --ignore-scripts --registry ${DEPS_REGISTRY}`,
			"cd /work/job",
			"# The checkout is bound READ-ONLY, so a readable mode adds no candidate capability.",
			`sudo chmod -R a+rX ${PREPUSH_RUNNER_CHECKOUT}`,
			"phase=packages",
			`if ! command -v bwrap >/dev/null 2>&1 || [ ! -x ${PREPUSH_RUNNER_PG_BINDIR}/initdb ]; then`,
			"  # Authorized by NAME with no version pin (the image is the version",
			"  # authority, so an already-shipped package makes this a no-op). This is the",
			"  # only install line in the script: install no other package.",
			"  sudo apt-get update",
			`  sudo apt-get install -y ${RUNNER_BUBBLEWRAP_PACKAGE} ${RUNNER_POSTGRESQL_PACKAGE}`,
			"  # The cluster is created and started INSIDE the sandbox, never on the host.",
			"  sudo systemctl stop postgresql 2>/dev/null || true",
			"fi",
			"phase=writable-trees",
			`mkdir -p ${PREPUSH_RUNNER_TEST_TMP} ${PREPUSH_RUNNER_TEST_TMP}/home ${inputs.pgData} ${inputs.pgSock}`,
			"# The sandbox runs as REAL uid/gid 65534, so these three job-local writable",
			"# trees must be OWNED by 65534 (initdb refuses a data dir it does not own).",
			"# Chown no checkout, helper script, share path, or other host directory.",
			`sudo chown -R 65534:65534 ${PREPUSH_RUNNER_TEST_TMP} ${inputs.pgData} ${inputs.pgSock}`,
		];
	},
);

/**
 * §2a — the writer of the in-sandbox validation script, VERBATIM. One cohesive
 * contract: the 0444 chmod and the uid assertion at the top of the script are the
 * same control (the script must be readable by the dropped uid 65534 yet
 * unmodifiable by candidate code).
 *
 * The heredoc is UNQUOTED so `$1` — the fixed command — expands at write time.
 * Every literal `$` that must survive into the inner script is therefore written
 * `\$`. `scratchPostgresLines` emits no `$` today (pinned by a test).
 */
function sandboxScriptLines(inputs: PrepushBodyInputs): string[] {
	const tmp = `${PREPUSH_RUNNER_SCRIPT_SOURCE}.tmp`;
	return [
		"# --- 2. sandboxed validation (candidate code runs ONLY here) ----------------",
		"# Each command's script is written then locked read-only via a temp + mv -f:",
		`# chmod 0444 ${PREPUSH_RUNNER_SCRIPT_SOURCE}`,
		"write_command_script() {  # $1 = the fixed command",
		`  cat > ${tmp} <<EOF`,
		"#!/bin/sh",
		"set -eu",
		'test "\\$(id -u)" = 65534 && test "\\$(id -g)" = 65534',
		// sf#563: the ONE definition, shared with the implement lane so the two
		// bodies cannot drift. Rendered flush-left inside the heredoc.
		...scratchPostgresLines({ pgData: inputs.pgData, pgSock: inputs.pgSock }, ""),
		`git config --global --add safe.directory ${PREPUSH_RUNNER_CHECKOUT}`,
		"$1",
		"EOF",
		`  chmod 0444 ${tmp}`,
		`  mv -f ${tmp} ${PREPUSH_RUNNER_SCRIPT_SOURCE}`,
		"}",
	];
}

/**
 * §2b — the bwrap launcher, VERBATIM and INTACT.
 *
 * This block is a NAMED EXCEPTION to further subdivision. Its flag ORDER is
 * load-bearing: every `--dir` line must precede every bind under that path, or
 * bwrap auto-creates the parent at 0700 root-owned and the dropped uid 65534
 * cannot traverse it. Cutting it into "launcher part 1/2" builders
 * would hide that ordering from a reader and make it trivially breakable in
 * review — precisely the defect the ceiling exists to prevent. It is a single
 * contract with one reason to change, so it stays one function.
 */
function sandboxLauncherLines(inputs: PrepushBodyInputs): string[] {
	return [
		"run_sandboxed() {  # $1 = check index; writes /work/out/check-$1.log; sets rc",
		"  set +e",
		"  sudo bwrap \\",
		"    --unshare-ipc --unshare-pid --unshare-uts --unshare-cgroup --unshare-net \\",
		"    --cap-add CAP_NET_ADMIN \\",
		"    --die-with-parent --new-session \\",
		"    --clearenv \\",
		"    --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /sbin /sbin \\",
		"    --ro-bind /lib /lib --ro-bind /lib64 /lib64 \\",
		"    --tmpfs /etc \\",
		"    --ro-bind /etc/passwd /etc/passwd --ro-bind /etc/group /etc/group \\",
		"    --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf \\",
		"    --ro-bind-try /etc/hosts /etc/hosts \\",
		"    --ro-bind-try /etc/localtime /etc/localtime \\",
		"    --dir /etc/ssl --dir /etc/ssl/certs \\",
		"    --ro-bind-try /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt \\",
		"    --ro-bind-try /etc/ssl/openssl.cnf /etc/ssl/openssl.cnf \\",
		`    --ro-bind ${PREPUSH_RUNNER_PG_BINDIR} ${PREPUSH_RUNNER_PG_BINDIR} \\`,
		"    --proc /proc --dev /dev --perms 1777 --tmpfs /tmp \\",
		`    --dir ${PREPUSH_RUNNER_WORK_ROOT} \\`,
		`    --dir ${PREPUSH_RUNNER_OUT_ROOT} \\`,
		`    --dir ${PREPUSH_RUNNER_PG_ROOT} \\`,
		`    --ro-bind ${PREPUSH_RUNNER_CHECKOUT} ${PREPUSH_RUNNER_CHECKOUT} \\`,
		`    --ro-bind ${PREPUSH_RUNNER_SCRIPT_SOURCE} ${PREPUSH_RUNNER_SCRIPT} \\`,
		`    --chdir ${PREPUSH_RUNNER_CHECKOUT} \\`,
		`    --bind ${PREPUSH_RUNNER_TEST_TMP} ${PREPUSH_RUNNER_TEST_TMP} \\`,
		`    --bind ${inputs.pgData} ${inputs.pgData} \\`,
		`    --bind ${inputs.pgSock} ${inputs.pgSock} \\`,
		`    --setenv HOME ${PREPUSH_RUNNER_TEST_TMP}/home \\`,
		"    --setenv PATH /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\",
		`    --setenv TEST_ADMIN_DATABASE_URL ${inputs.pgUrl} \\`,
		`    --setenv DATABASE_URL ${inputs.pgUrl} \\`,
		`    --setenv RODADDY_WATCHER_TEST_TMP ${PREPUSH_RUNNER_TEST_TMP} \\`,
		`    --setenv SF_AFFECTED_BASE ${inputs.comparisonBaseSha ?? NO_AFFECTED_BASE} \\`,
		`    --setenv PGDATA ${inputs.pgData} \\`,
		"    -- /bin/sh -ec '",
		"      ip link set lo up;",
		"      exec setpriv --reuid 65534 --regid 65534 --clear-groups \\",
		"        --inh-caps=-all --ambient-caps=-all --no-new-privs -- \\",
		`        /bin/sh ${PREPUSH_RUNNER_SCRIPT};`,
		`    ' > "${PREPUSH_RUNNER_OUT_ROOT}/check-$1.log" 2>&1`,
		"  rc=$?",
		"  set -e",
		"}",
	];
}

/**
 * §2c — the closing rationale: what the launcher above actually guarantees. Kept
 * next to the launcher because a reader checking a flag reads this to learn what
 * that flag is for. Emitted as `#` comments — the script executes, so the
 * rationale cannot be prose lines.
 */
function sandboxRationaleLines(): string[] {
	return [
		"",
		"# The sandbox unshares IPC, PID, UTS, cgroup, and network, but not the user",
		"# namespace. The netns starts with lo down; the root-only preamble gets only",
		"# CAP_NET_ADMIN to run `ip link set lo up`, then execs setpriv. With no user",
		"# namespace, setpriv --reuid/--regid sets real uid/gid 65534 in the host",
		"# namespace, so DAC sees 65534 and root-owned bound files are unreadable.",
		"# --clear-groups drops groups; setpriv clears caps and sets no-new-privs.",
		"# The script asserts both IDs before any candidate code.",
		`# The sandbox binds the checkout READ-ONLY, NEVER binds ${RUNNER_COLLAB_ROOT},`,
		"# credentials, or the result artifact, and writes ONLY to the job-local temp",
		"# and PG directories. /etc is a fresh tmpfs; only these files are bound",
		"# read-only: /etc/passwd and /etc/group (so initdb resolves 65534), plus, when",
		"# present, /etc/nsswitch.conf, /etc/hosts, /etc/localtime, the CA bundle",
		"# /etc/ssl/certs/ca-certificates.crt, and /etc/ssl/openssl.cnf (node reads",
		"# it). --clearenv re-sets ONLY the fixed variables, so no host secret",
		"# survives into the candidate environment. bubblewrap is required: the",
		"# commands are NEVER run unsandboxed — a failed launch is an `error` result.",
	];
}

/**
 * §2 — the sandboxed validation contract: the author-owned script writer, the
 * verbatim bwrap launcher, and the rationale that explains what the launcher
 * guarantees, concatenated in contract order.
 */
export const sandboxSection = traced(
	"prepush.sandboxSection",
	function sandboxSection(inputs: PrepushBodyInputs): string[] {
		return [
			...sandboxScriptLines(inputs),
			"",
			...sandboxLauncherLines(inputs),
			...sandboxRationaleLines(),
		];
	},
);

/** The JSON check entries a setup failure reports, one per fixed command. */
function errorChecksJson(inputs: PrepushBodyInputs): string {
	return inputs.commands
		.map(
			(command) => `{\\"name\\":\\"${command}\\",\\"status\\":\\"error\\",\\"summary\\":\\"$3\\"}`,
		)
		.join(",");
}

/**
 * §3 — the author-owned classification and result write. Candidate code never
 * reaches this section, which is what makes the result trustworthy at the
 * watcher's read boundary. Every summary is composed in bash from the status, the
 * exit code, and the phase ONLY — no log content and no repository content ever
 * enters the JSON.
 */
export const resultFunctionsSection = traced(
	"prepush.resultFunctionsSection",
	function resultFunctionsSection(inputs: PrepushBodyInputs): string[] {
		return [
			"# --- 3. author-owned result (the coordinator writes it; candidate code cannot) -",
			"# An infrastructure/harness fault is `error`, never a candidate `fail`: repeated",
			"# runs of one unchanged SHA must not disagree about a property of the box.",
			"# The ONE log marker is pg_ctl's own `server started` line: present, the sandbox",
			"# reached the candidate command and a non-zero exit is the candidate's; absent,",
			"# the cluster never came up and the command never ran. Content heuristics were",
			"# dropped: the suite quotes strings like 'pg_ctl: could not start server' in its",
			"# own output, which misfiled a real candidate fail as an infra error.",
			"classify_check() {  # $1 = rc, $2 = log path -> echoes pass|fail|error",
			'  if [ "$1" = 0 ]; then echo pass; return; fi',
			'  if [ "$1" = 137 ] || [ "$1" = 143 ]; then echo error; return; fi',
			'  if ! grep -qx "server started" "$2" 2>/dev/null; then echo error; return; fi',
			"  echo fail",
			"}",
			"",
			"write_result() {  # $1 = overall status, $2 = checks json, $3 = summary when $2 empty",
			'  checks="$2"',
			'  if [ -z "$checks" ]; then',
			`    checks="${errorChecksJson(inputs)}"`,
			"  fi",
			`  cat > ${PREPUSH_RESULT_PATH}.tmp <<EOF`,
			`{"result_version":1,"repository":"${inputs.repo}","job_type":"${PREPUSH_TEMPLATE_ID}","sha":"${inputs.commit}","status":"$1","checks":[$checks],"output_path":"\${share_root}/runners/jobs/\${RUNNER_JOB_ID}/\${host}/validation.log"}`,
			"EOF",
			`  mv -f ${PREPUSH_RESULT_PATH}.tmp "$result_local"`,
			`  cat ${PREPUSH_RUNNER_OUT_ROOT}/check-*.log > "$log_local" 2>/dev/null || : > "$log_local"`,
			'  cp "$log_local" "$out_dir/.validation.log.tmp" && mv -f "$out_dir/.validation.log.tmp" "$out_dir/validation.log"',
			`  cp "$result_local" "$out_dir/.${PREPUSH_RESULT_NAME}.tmp" && mv -f "$out_dir/.${PREPUSH_RESULT_NAME}.tmp" "$out_dir/${PREPUSH_RESULT_NAME}"`,
			"  result_written=1",
			"}",
		];
	},
);

/**
 * §4 — the fixed check loop and the overall verdict. One block per fixed command,
 * emitted at RENDER time so the command literal is spliced by TypeScript and the
 * script carries no runtime substitution from anywhere.
 */
export const resultSection = traced(
	"prepush.resultSection",
	function resultSection(inputs: PrepushBodyInputs): string[] {
		const lines: string[] = [
			"# --- 4. the fixed checks, each in its own sandbox --------------------------",
			"phase=checks",
			'checks_json=""',
			"all_pass=1",
			"any_fail=0",
		];
		inputs.commands.forEach((command, index) => {
			const n = index + 1;
			const log = `${PREPUSH_RUNNER_OUT_ROOT}/check-${n}.log`;
			lines.push(
				"",
				`# check ${n}: ${command}`,
				`write_command_script '${command}'`,
				`run_sandboxed ${n}`,
				`st="$(classify_check "$rc" ${log})"`,
				'[ "$st" = pass ] || all_pass=0',
				'if [ "$st" = fail ]; then any_fail=1; fi',
				index === 0 ? 'checks_json=""' : 'checks_json="${checks_json},"',
				`checks_json="\${checks_json}{\\"name\\":\\"${command}\\",\\"status\\":\\"\${st}\\",\\"summary\\":\\"sandbox exit \${rc} (\${st})\\"}"`,
			);
		});
		lines.push(
			"",
			"phase=result",
			"# `passed` only when every sandboxed command exited 0; `failed` only when at",
			"# least one check failed on the candidate's own merits; `error` otherwise.",
			'if [ "$all_pass" = 1 ]; then',
			"  overall=passed",
			'elif [ "$any_fail" = 1 ]; then',
			"  overall=failed",
			"else",
			"  overall=error",
			"fi",
			'write_result "$overall" "$checks_json" ""',
			"# Exit 0 whenever a result was written: a non-zero wrapper status is refused",
			"# before the result is ever read.",
			"exit 0",
		);
		return lines;
	},
);
