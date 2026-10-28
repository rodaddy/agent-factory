/**
 * @module infra/sandbox-section
 * @description The SANDBOX half of the fixed rtech-infra static-validation
 *   contract: the runner-side paths it names, the bwrap launcher whose
 *   flag order is load-bearing, the run-order rule, and the capture form.
 *
 *   Extracted from `infra/body.ts` at that section boundary when the file
 *   crossed its 500-line `lint:size` ceiling. The seam is a real one
 *   rather than a line-count dodge: this module owns WHERE the sandbox puts
 *   things and HOW it is launched and captured, while `body.ts` keeps setup,
 *   the verdict rules, the result schema, and body assembly. Every string here
 *   is FIXED reviewed text; no repository-derived value reaches any of it.
 */
import { RUNNER_COLLAB_ROOT } from "../prepush/paths";

/** The read-only checkout of the exact candidate the static linters read. */
export const INFRA_RUNNER_CHECKOUT = "/work/checkout";

/**
 * The read-only checkout of the PR's IMMUTABLE base commit — the comparison
 * point, never a thing to lint on its own. Present only when the selection
 * carried a usable base SHA; the same fixed commands run against it a second
 * time so the verdict is relative to the base rather than absolute.
 */
export const INFRA_RUNNER_BASE_CHECKOUT = "/work/base";

/** The job-local, portable test-temp / HOME root the fixed setup exports. Fixed. */
export const INFRA_RUNNER_TEST_TMP = "/work/out/test-tmp";

/**
 * The sandbox-internal parent directories the fixed bwrap launcher must
 * pre-create with `--dir` (mode 0755) BEFORE any bind under them, or bwrap
 * auto-creates the parent at 0700 root and the dropped uid 65534 cannot
 * traverse it. Order matters: `--dir` lines precede the binds.
 */
export const INFRA_RUNNER_WORK_ROOT = "/work";
export const INFRA_RUNNER_OUT_ROOT = "/work/out";

/**
 * The trusted outer coordinator writes one fixed per-command script here, then
 * binds only that file read-only into the sandbox. The candidate never sees the
 * surrounding `/work/out` directory or gains write access to the script.
 */
export const INFRA_RUNNER_SCRIPT_SOURCE = "/work/out/static-command.sh";
export const INFRA_RUNNER_SCRIPT = "/work/static-command.sh";

/**
 * The author-owned PINNED LINTER CONFIG root, OUTSIDE both checkouts and bound
 * read-only. Linter policy must not be candidate-controlled, and this is a
 * SECURITY boundary rather than a style choice. Probed against yamllint 1.38.0:
 * a repository `.yamllint` carrying `extends: relaxed` plus
 * `key-duplicates: disable` made a real duplicate-key violation exit 0, while
 * `-c` at a pinned config outside the checkout reported it and exited 1 (F1,
 * sf#592). Probed against ansible-lint 26.6.0: a repository `.ansible-lint`
 * naming `rulesdir` IMPORTED AND EXECUTED candidate Python during the lint —
 * the rule module's import side effect wrote a file on disk — while the same
 * run with `-c` at a pinned config executed nothing (F9). That probe
 * also shows why `--clearenv` matters here: `ANSIBLE_LINT_CUSTOM_RULESDIR` is a
 * second rule-loading path, and the fixed launcher re-sets no such variable.
 */
export const INFRA_RUNNER_LINTRC_ROOT = "/work/lintrc";

/**
 * Author-owned, coordinator-written capture paths for each run's combined
 * output, under `/work/out` — which is never bound wholesale into the sandbox,
 * so a candidate command cannot read or forge either file. `<n>` is the
 * command's 1-based position in the fixed numbered list, so it is derived from
 * the reviewed literal command set and never from repository content.
 */
export const INFRA_RUNNER_CANDIDATE_LOG_TEMPLATE = `${INFRA_RUNNER_OUT_ROOT}/check-<n>.candidate.txt`;
/** Per-check captured output for the base run, same index. See above. */
export const INFRA_RUNNER_BASE_LOG_TEMPLATE = `${INFRA_RUNNER_OUT_ROOT}/check-<n>.base.txt`;
/**
 * The fixed bwrap launcher block. Kept as its own intact literal because the
 * flag ORDER is load-bearing: the `--dir` lines must precede any bind under
 * them or bwrap auto-creates the parent at 0700 root and the dropped uid 65534
 * cannot traverse it. `dir` is the ONE checkout this launch binds and
 * chdirs into — the candidate or, for the base run, the base. Each run binds
 * exactly one checkout; the two are never bound together. `NO_COLOR` is set so
 * captured diagnostics are plain text and comparable: ansible-lint colours its
 * output even when stdout is redirected to a file, and `--clearenv` re-sets no
 * variable that would otherwise suppress it.
 */
function sandboxLauncherBlock(dir: string): string[] {
	return [
		"   ```",
		"   sudo bwrap \\",
		"     --unshare-ipc --unshare-pid --unshare-uts --unshare-cgroup --unshare-net \\",
		"     --die-with-parent --new-session \\",
		"     --clearenv \\",
		"     --ro-bind /usr /usr --ro-bind /bin /bin --ro-bind /sbin /sbin \\",
		"     --ro-bind /lib /lib --ro-bind /lib64 /lib64 \\",
		"     --tmpfs /etc \\",
		"     --ro-bind /etc/passwd /etc/passwd --ro-bind /etc/group /etc/group \\",
		"     --ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf \\",
		"     --ro-bind-try /etc/localtime /etc/localtime \\",
		"     --proc /proc --dev /dev --perms 1777 --tmpfs /tmp \\",
		`     --dir ${INFRA_RUNNER_WORK_ROOT} \\`,
		`     --dir ${INFRA_RUNNER_OUT_ROOT} \\`,
		`     --ro-bind ${dir} ${dir} \\`,
		`     --ro-bind ${INFRA_RUNNER_SCRIPT_SOURCE} ${INFRA_RUNNER_SCRIPT} \\`,
		`     --ro-bind ${INFRA_RUNNER_LINTRC_ROOT} ${INFRA_RUNNER_LINTRC_ROOT} \\`,
		`     --chdir ${dir} \\`,
		`     --bind ${INFRA_RUNNER_TEST_TMP} ${INFRA_RUNNER_TEST_TMP} \\`,
		`     --setenv HOME ${INFRA_RUNNER_TEST_TMP}/home \\`,
		"     --setenv PATH /usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin \\",
		"     --setenv NO_COLOR 1 \\",
		`     --setenv RODADDY_WATCHER_TEST_TMP ${INFRA_RUNNER_TEST_TMP} \\`,
		"     -- setpriv --reuid 65534 --regid 65534 --clear-groups \\",
		"       --inh-caps=-all --ambient-caps=-all --no-new-privs -- \\",
		`       /bin/sh ${INFRA_RUNNER_SCRIPT}`,
		"   ```",
	];
}

/**
 * Section 2 of the contract: the sandboxed static checks. This is the ONLY
 * section under which candidate content is read, and it is the sandbox
 * description plus the fixed per-gate command list.
 */
/**
 * One launcher is rendered, for the candidate. The base run is the SAME launcher
 * with the one checkout path swapped — stated as a sentence rather than a second
 * block, so the reviewed flag order exists in exactly one place.
 */
function baseLauncherNote(hasBase: boolean): string[] {
	return hasBase
		? [
				"",
				`   For the base run, the same launcher with ${INFRA_RUNNER_BASE_CHECKOUT} in place of`,
				`   ${INFRA_RUNNER_CHECKOUT} on the \`--ro-bind\` and \`--chdir\` lines and nothing`,
				"   else changed. Each run binds exactly one checkout; never both.",
			]
		: [];
}

/** The fixed run-order sentence: twice against both checkouts, or once. */
function runOrderLines(hasBase: boolean): string[] {
	return hasBase
		? [
				"   Run each fixed command TWICE, in this order and each in its own sandbox:",
				`   first against ${INFRA_RUNNER_CHECKOUT} (the candidate), then against`,
				`   ${INFRA_RUNNER_BASE_CHECKOUT} (the base). Record both exit codes.`,
			]
		: ["   Run ONLY these fixed static commands, in order, each in its own sandbox:"];
}

/**
 * The fixed per-check capture paths. The base sentence exists only when a base
 * was read, so a no-base body names no `.base.txt` file.
 */
function captureLines(hasBase: boolean): string[] {
	return [
		`   combined output of command \`<n>\` to ${INFRA_RUNNER_CANDIDATE_LOG_TEMPLATE}`,
		...(hasBase
			? [`   for the candidate run and ${INFRA_RUNNER_BASE_LOG_TEMPLATE} for the base run,`]
			: []),
		"   using the command's position in the numbered list below as `<n>`. Use this",
	];
}

/**
 * The EXACT capture form, stated because the natural one is wrong. `bwrap ...
 * 2>&1 | tee <capture>; rc=$?` records TEE's status, which is always 0, so
 * every candidate run reads as `pass` and a real regression is accepted while
 * sitting in the captured file (F8). This repo's own AGENTS.md carries
 * the same trap for verification commands; the runner agent needs it here.
 */
function captureFormLines(hasBase: boolean): string[] {
	return [
		"",
		"   Capture with the exit code taken DIRECTLY from bwrap, like this — redirect",
		"   both streams to the file, then read `$?` on the very next command:",
		"",
		"   ```",
		`   sudo bwrap ... > ${INFRA_RUNNER_CANDIDATE_LOG_TEMPLATE} 2>&1`,
		"   rc=$?",
		"   ```",
		"",
		"   The exit code MUST come from bwrap itself, and NEVER from a pipeline whose",
		"   last stage is `tee`, `head`, or `tail`: a shell reports the LAST stage's",
		"   status, so `bwrap ... 2>&1 | tee <file>; rc=$?` yields tee's 0 no matter",
		"   what the check found, and every candidate run would read as a pass. Do not",
		"   pipe the run through any filter. If you want to see the output, read the",
		"   captured file afterwards.",
		"",
		"   Do NOT wrap the run in `if ! ...` and read `$?` inside the branch. `$?`",
		"   there is the status of the NEGATION, not of bwrap. Measured in `/bin/sh`,",
		"   bash and zsh alike — including the `/bin/sh` this sandbox runs the script",
		"   with: `if ! (exit 7); then echo $?; fi` prints 0 in all three. A failing",
		"   check captured as a success, the same wrong answer the `tee` form gives,",
		"   and there is no shell where the form is safe. If you must branch,",
		"   capture first and test the variable: `rc=0; bwrap ... > <file> 2>&1 ||",
		"   rc=$?` and then branch on `$rc`.",
		...(hasBase
			? [
					`   Capture the base run the same way, to ${INFRA_RUNNER_BASE_LOG_TEMPLATE},`,
					"   with its own exit code read the same way.",
				]
			: []),
	];
}

export function sandboxSection(commands: string, hasBase: boolean): string[] {
	const baseLauncherLine = baseLauncherNote(hasBase);
	const runOrder = runOrderLines(hasBase);
	return [
		"### 2. Sandboxed static checks (the linters run ONLY here)",
		"   Require `bwrap` (Bubblewrap). If it is absent, or the sandbox launch fails",
		'   for any reason, STOP and report overall status "error"; NEVER run a linter',
		`   unsandboxed. Before each launch, write ${INFRA_RUNNER_SCRIPT_SOURCE} as this`,
		"   exact author-owned script, substituting only the named fixed command.",
		"   Candidate code does not run while creating it and cannot modify it inside",
		"   the sandbox. Make it world-readable so the dropped process can open it: run",
		`   exactly \`chmod 0444 ${INFRA_RUNNER_SCRIPT_SOURCE}\` after writing it:`,
		"",
		"   ```",
		"   #!/bin/sh",
		"   set -eu",
		'   test "$(id -u)" = 65534 && test "$(id -g)" = 65534',
		`   git config --global --add safe.directory ${INFRA_RUNNER_CHECKOUT}`,
		...(hasBase
			? [`   git config --global --add safe.directory ${INFRA_RUNNER_BASE_CHECKOUT}`]
			: []),
		"   <the fixed command>",
		"   ```",
		"",
		"   Run that script in its OWN sandbox through this EXACT bwrap invocation,",
		"   capturing its exit code and combined output OUTSIDE the sandbox under",
		"   `/work/out/` (which is never bound wholesale into the sandbox). Write the",
		...captureLines(hasBase),
		"   fixed launcher verbatim:",
		"",
		...sandboxLauncherBlock(INFRA_RUNNER_CHECKOUT),
		...baseLauncherLine,
		...captureFormLines(hasBase),
		"",
		"   The sandbox unshares IPC, PID, UTS, cgroup, and network (with NO",
		"   CAP_NET_ADMIN and lo left down — a static linter needs no network), and",
		"   grants no user namespace. setpriv --reuid/--regid sets real uid/gid 65534",
		"   in the host namespace, so DAC sees 65534 and root-owned bound files are",
		"   unreadable; --clear-groups drops groups; setpriv clears caps and sets",
		"   no-new-privs. The script asserts both IDs before any candidate content.",
		`   The sandbox binds the checkout READ-ONLY, NEVER binds ${RUNNER_COLLAB_ROOT},`,
		"   credentials, or the result artifact, and writes ONLY to the job-local temp.",
		"   /etc is a fresh tmpfs; only /etc/passwd and /etc/group are bound (so uid",
		"   65534 resolves), plus /etc/nsswitch.conf and /etc/localtime when present.",
		"   --clearenv re-sets ONLY the fixed variables, so no host secret survives.",
		"",
		...runOrder,
		commands,
	];
}
