/**
 * @module tests/prepush/body
 * @description Literal contract tests for the fixed exact-SHA runner body. These
 *   assert the ENFORCEABLE sandbox properties of the rendered instruction set:
 *   an isolated Bubblewrap network namespace (no --share-net, no reachable
 *   infrastructure), a read-only candidate checkout, a real --clearenv (never the
 *   non-existent --clearenv-except), an isolated in-sandbox PostgreSQL on the
 *   sandbox's own loopback, and the trusted outer coordinator keeping sole
 *   custody of the collab share, credentials, and the result artifact. The body
 *   must also fail closed (return null) when it cannot render a complete, bounded
 *   contract.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	MAX_JOB_BODY_CHARS,
	PREPUSH_BODY_FINAL_LINE,
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
	RUNNER_JOB_TRANSPORT_CAP,
	renderPrepushBootstrapJob,
	renderPrepushJobBody,
} from "../../src/prepush/body";
import { PREPUSH_COMMANDS, PREPUSH_RESULT_NAME } from "../../src/prepush/receipt";
import { scratchPostgresLines } from "../../src/templates/scratch-postgres";
import { testTmpBase } from "../support/test-temp";

const REPO = "rodaddy/software-factory";
const SHA = "a".repeat(40);
const COMPARISON_BASE = "b".repeat(40);
const JOB_ID = "rw-repo-validate-body-test";

function render(): string {
	const body = renderPrepushJobBody(REPO, SHA, JOB_ID);
	if (body === null) throw new Error("expected a non-null body");
	return body;
}

function renderedPgPaths(body: string): { data: string; sock: string } {
	const data = body.match(/--setenv PGDATA (\S+)/)?.[1];
	const sock = body.match(/-k (\S+)/)?.[1];
	if (data === undefined || sock === undefined)
		throw new Error("expected rendered PostgreSQL paths");
	return { data, sock };
}

describe("fixed pre-push runner body — enforceable sandbox contract", () => {
	test("uses an isolated network namespace without a user namespace or --share-net", () => {
		const body = render();
		// Bookworm bwrap --unshare-all includes --unshare-user-try. The launcher must
		// isolate every required namespace explicitly while keeping the real user
		// namespace, so setpriv can make a real (DAC-enforced) identity transition.
		expect(body).toContain(
			"--unshare-ipc --unshare-pid --unshare-uts --unshare-cgroup --unshare-net",
		);
		expect(body).not.toContain("--unshare-all");
		expect(body).not.toContain("--unshare-user");
		expect(body).not.toContain("--share-net");
	});

	test("uses a real --clearenv, never the non-existent --clearenv-except", () => {
		const body = render();
		expect(body).toContain("--clearenv");
		// --clearenv-except is NOT a bwrap option; it would silently no-op or fail.
		expect(body).not.toContain("--clearenv-except");
		// Every allowed variable is re-set explicitly after the clear.
		expect(body).toContain(`--setenv HOME ${PREPUSH_RUNNER_TEST_TMP}/home`);
		expect(body).toContain("--setenv TEST_ADMIN_DATABASE_URL");
		expect(body).toContain("--setenv DATABASE_URL");
		expect(body).toContain("--setenv RODADDY_WATCHER_TEST_TMP");
	});

	test("hands the comparison base to check:affected, or an unresolvable one", () => {
		expect(renderPrepushJobBody(REPO, SHA, JOB_ID, MAX_JOB_BODY_CHARS, COMPARISON_BASE)).toContain(
			`--setenv SF_AFFECTED_BASE ${COMPARISON_BASE} \\`,
		);
		expect(render()).toContain(`--setenv SF_AFFECTED_BASE ${"0".repeat(40)} \\`);
	});

	test("binds the candidate checkout READ-ONLY, never writable", () => {
		const body = render();
		expect(body).toContain(`--ro-bind ${PREPUSH_RUNNER_CHECKOUT} ${PREPUSH_RUNNER_CHECKOUT}`);
		// The checkout must never be a writable --bind, which would let untrusted
		// candidate code mutate the checked-out tree it runs from.
		expect(body).not.toContain(`--bind ${PREPUSH_RUNNER_CHECKOUT} ${PREPUSH_RUNNER_CHECKOUT}`);
	});

	test("hides the collab share and credentials from the sandbox", () => {
		const body = render();
		// The candidate sandbox never binds the collab mount or a HOME with real
		// credentials — HOME is a throwaway tmpfs, and only the checkout, fixed read-only
		// command script, job temp, and isolated PG dirs are bound. The ONLY /mnt/share mentions are the
		// author-owned bundle input and the outer result copy, never a bind INTO the
		// sandbox.
		expect(body).not.toContain("--ro-bind /mnt/share");
		expect(body).not.toContain("--bind /mnt/share");
		expect(body).toContain(`--setenv HOME ${PREPUSH_RUNNER_TEST_TMP}/home`);
	});

	test("renders different PostgreSQL data and socket paths for different jobs", () => {
		const firstJobId = "rw-repo-validate-first-job";
		const secondJobId = "rw-repo-validate-second-job";
		const firstBody = renderPrepushJobBody(REPO, SHA, firstJobId);
		const secondBody = renderPrepushJobBody(REPO, SHA, secondJobId);
		if (firstBody === null || secondBody === null) throw new Error("expected non-null bodies");

		const firstPaths = renderedPgPaths(firstBody);
		const secondPaths = renderedPgPaths(secondBody);
		expect(firstPaths.data).toBe(`${PREPUSH_RUNNER_PG_DATA}-${firstJobId}`);
		expect(secondPaths.data).toBe(`${PREPUSH_RUNNER_PG_DATA}-${secondJobId}`);
		expect(firstPaths.data).not.toBe(secondPaths.data);
		expect(firstPaths.sock).toBe(`${PREPUSH_RUNNER_PG_SOCK}-${firstJobId}`);
		expect(secondPaths.sock).toBe(`${PREPUSH_RUNNER_PG_SOCK}-${secondJobId}`);
		expect(firstPaths.sock).not.toBe(secondPaths.sock);
	});

	test("grants write access ONLY to the job-local temp and isolated PG dirs", () => {
		const body = render();
		const pgData = `${PREPUSH_RUNNER_PG_DATA}-${JOB_ID}`;
		const pgSock = `${PREPUSH_RUNNER_PG_SOCK}-${JOB_ID}`;
		expect(body).toContain(`--bind ${PREPUSH_RUNNER_TEST_TMP} ${PREPUSH_RUNNER_TEST_TMP}`);
		expect(body).toContain(`--bind ${pgData} ${pgData}`);
		expect(body).toContain(`--bind ${pgSock} ${pgSock}`);
		// The sandbox runs as real uid/gid 65534, so the writable job-local trees must
		// be OWNED by 65534 (initdb refuses a data dir it does not own).
		expect(body).toContain(
			`sudo chown -R 65534:65534 ${PREPUSH_RUNNER_TEST_TMP} ${pgData} ${pgSock}`,
		);
		// Only those three trees are chowned to 65534 — never the checkout or share.
		expect(body).not.toContain(`sudo chown -R 65534:65534 ${PREPUSH_RUNNER_CHECKOUT}`);
		expect(body).not.toContain("chown -R 65534:65534 /mnt/share");
	});

	test("makes the read-only script and checkout readable by the dropped uid", () => {
		const body = render();
		// The dropped uid 65534 is a REAL DAC-enforced identity, so the fixed script
		// and the read-only checkout must be world-readable or the checks cannot open
		// them. Both are bound READ-ONLY, so a readable mode grants no extra capability.
		expect(body).toContain(`chmod 0444 ${PREPUSH_RUNNER_SCRIPT_SOURCE}`);
		expect(body).toContain(`sudo chmod -R a+rX ${PREPUSH_RUNNER_CHECKOUT}`);
	});

	test("binds only the trusted command script read-only", () => {
		const body = render();
		expect(body).toContain(`--ro-bind ${PREPUSH_RUNNER_SCRIPT_SOURCE} ${PREPUSH_RUNNER_SCRIPT}`);
		expect(body).not.toContain(`--bind ${PREPUSH_RUNNER_SCRIPT_SOURCE} ${PREPUSH_RUNNER_SCRIPT}`);
		expect(body).toContain(`/bin/sh ${PREPUSH_RUNNER_SCRIPT}`);
	});

	test("pre-creates the bind parents with --dir so uid 65534 can traverse them", () => {
		const body = render();
		// bwrap auto-creates a bind's missing parent at 0700 root, which the dropped
		// uid 65534 cannot traverse. The launcher must declare each parent
		// as an explicit `--dir` (0755) BEFORE the bind that lives under it, or the
		// otherwise world-readable script/PG/test-temp trees are unreachable.
		expect(body).toContain(`--dir ${PREPUSH_RUNNER_WORK_ROOT}`);
		expect(body).toContain(`--dir ${PREPUSH_RUNNER_OUT_ROOT}`);
		expect(body).toContain(`--dir ${PREPUSH_RUNNER_PG_ROOT}`);
		// Ordering is load-bearing: the `--dir` for each parent must appear before the
		// first bind under it, otherwise bwrap has already auto-created it at 0700.
		const workDir = body.indexOf(`--dir ${PREPUSH_RUNNER_WORK_ROOT}`);
		const outDir = body.indexOf(`--dir ${PREPUSH_RUNNER_OUT_ROOT}`);
		const pgDir = body.indexOf(`--dir ${PREPUSH_RUNNER_PG_ROOT}`);
		const scriptBind = body.indexOf(
			`--ro-bind ${PREPUSH_RUNNER_SCRIPT_SOURCE} ${PREPUSH_RUNNER_SCRIPT}`,
		);
		const pgData = `${PREPUSH_RUNNER_PG_DATA}-${JOB_ID}`;
		const pgSock = `${PREPUSH_RUNNER_PG_SOCK}-${JOB_ID}`;
		const pgDataBind = body.indexOf(`--bind ${pgData} ${pgData}`);
		const pgSockBind = body.indexOf(`--bind ${pgSock} ${pgSock}`);
		const testTmpBind = body.indexOf(
			`--bind ${PREPUSH_RUNNER_TEST_TMP} ${PREPUSH_RUNNER_TEST_TMP}`,
		);
		expect(workDir).toBeGreaterThanOrEqual(0);
		expect(outDir).toBeGreaterThan(workDir);
		expect(pgDir).toBeGreaterThan(outDir);
		// Every bind under a parent comes after that parent's --dir.
		expect(scriptBind).toBeGreaterThan(workDir);
		expect(testTmpBind).toBeGreaterThan(outDir);
		expect(pgDataBind).toBeGreaterThan(pgDir);
		expect(pgSockBind).toBeGreaterThan(pgDir);
	});

	test("brings up loopback and runs an isolated in-sandbox PostgreSQL cluster", () => {
		const body = render();
		// Loopback is brought up inside the netns; the fixed PG binaries are bound and
		// the cluster is initialized/started/stopped INSIDE the sandbox on loopback.
		expect(body).toContain("ip link set lo up");
		expect(body).toContain(`--ro-bind ${PREPUSH_RUNNER_PG_BINDIR} ${PREPUSH_RUNNER_PG_BINDIR}`);
		expect(body).toContain(`${PREPUSH_RUNNER_PG_DATA}-${JOB_ID}/PG_VERSION`);
		expect(body).toContain(`${PREPUSH_RUNNER_PG_BINDIR}/initdb`);
		expect(body).toContain(`${PREPUSH_RUNNER_PG_BINDIR}/pg_ctl`);
		// The fixed root-only preamble has only enough capability to enable loopback
		// in the new netns, then immediately drops to a REAL uid/gid (subject to DAC).
		expect(body).toContain("--cap-add CAP_NET_ADMIN");
		expect(body).not.toContain("--cap-add ALL");
		expect(body).toContain(
			"ip link set lo up;\n      exec setpriv --reuid 65534 --regid 65534 --clear-groups",
		);
		expect(body).toContain("setpriv --reuid 65534 --regid 65534 --clear-groups");
		expect(body).not.toContain("unshare --user --map-user");
		expect(body).not.toContain("--map-group");
		expect(body).not.toContain("--setgroups");
		expect(body).toContain("--inh-caps=-all --ambient-caps=-all --no-new-privs");
		expect(body).not.toContain("--bounding-set");
		// The uid assertion is written into an UNQUOTED heredoc, so each literal `$`
		// that must survive into the in-sandbox script is escaped in the outer body.
		expect(body).toContain('test "\\$(id -u)" = 65534 && test "\\$(id -g)" = 65534');
		expect(body).toContain(`postgres://postgres@127.0.0.1:${PREPUSH_RUNNER_PG_PORT}/postgres`);
		// The cluster is trapped and stopped so it never leaks past the command.
		expect(body).toContain("trap");
		expect(body).toContain("stop");
	});

	test("drops to real host-namespace uid/gid 65534 (no mapping user namespace)", () => {
		const body = render();
		// No bwrap user namespace means setpriv's setresuid/setresgid reaches real
		// host-namespace IDs; it must not be replaced by bwrap --uid/--gid (which
		// requires a user namespace in bwrap 0.8) or the old mapped-userns path.
		expect(body).toContain("setpriv --reuid 65534 --regid 65534 --clear-groups");
		expect(body).not.toContain("unshare --user --map-user");
		expect(body).not.toContain("--uid 65534");
		expect(body).not.toContain("--gid 65534");
		// The sandbox-local PostgreSQL contract still asserts both numeric ids.
		expect(body).toContain('test "\\$(id -u)" = 65534 && test "\\$(id -g)" = 65534');
	});

	test("binds only the single system CA bundle, never the whole /etc/ssl tree", () => {
		const body = render();
		expect(body).toContain(
			"--ro-bind-try /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt",
		);
		expect(body).not.toContain("--ro-bind-try /etc/ssl /etc/ssl");
	});

	test("binds /sbin so loopback tooling is available", () => {
		const body = render();
		expect(body).toContain("--ro-bind /sbin /sbin");
	});

	test("does NOT bind host /etc wholesale; uses a tmpfs plus minimal file binds", () => {
		const body = render();
		// The whole-/etc bind is gone — it contradicted the contract's claim that host
		// config is never bound. /etc is a fresh tmpfs with only the minimal files.
		expect(body).not.toContain("--ro-bind /etc /etc");
		expect(body).toContain("--tmpfs /etc");
		// passwd/group are required for PostgreSQL initdb's UID/GID 65534 lookup.
		expect(body).toContain("--ro-bind /etc/passwd /etc/passwd");
		expect(body).toContain("--ro-bind /etc/group /etc/group");
		// The optional resolver/time/TLS files are best-effort (-try) so a missing one
		// does not fail the launch.
		expect(body).toContain("--ro-bind-try /etc/nsswitch.conf /etc/nsswitch.conf");
		expect(body).toContain("--ro-bind-try /etc/hosts /etc/hosts");
		expect(body).toContain("--ro-bind-try /etc/localtime /etc/localtime");
		// Only the single system CA bundle file is bound under /etc/ssl — never the
		// whole /etc/ssl tree, which bun/postgres do not need for these checks.
		expect(body).toContain(
			"--ro-bind-try /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt",
		);
		expect(body).not.toContain("--ro-bind-try /etc/ssl /etc/ssl");
		// node/openssl reads /etc/ssl/openssl.cnf on startup (e.g. biome via node);
		// under the fresh /etc tmpfs it must be bound or `bun run check` dies with
		// "BIO_new_file: Permission denied" opening /etc/ssl/openssl.cnf.
		expect(body).toContain("--ro-bind-try /etc/ssl/openssl.cnf /etc/ssl/openssl.cnf");
		// Same parent-traversal trap as /work: bwrap auto-creates /etc/ssl (and
		// /etc/ssl/certs) at 0700 root under the /etc tmpfs, so uid 65534 cannot
		// traverse them to open the bound openssl.cnf/CA bundle. --dir makes each
		// 0755. Both --dir entries must precede their binds.
		const sslDir = body.indexOf("--dir /etc/ssl ");
		const certsDir = body.indexOf("--dir /etc/ssl/certs");
		const caBind = body.indexOf(
			"--ro-bind-try /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt",
		);
		const cnfBind = body.indexOf("--ro-bind-try /etc/ssl/openssl.cnf /etc/ssl/openssl.cnf");
		expect(sslDir).toBeGreaterThanOrEqual(0);
		expect(certsDir).toBeGreaterThan(sslDir);
		expect(caBind).toBeGreaterThan(certsDir);
		expect(cnfBind).toBeGreaterThan(sslDir);
	});

	test("marks the read-only checkout as a git safe.directory before the checks", () => {
		const body = render();
		// The checkout is owned by 65534 but git under the dropped uid still flags
		// "dubious ownership" and aborts (exit 128), which fails verify.sh. The fixed
		// script must allowlist the checkout as a safe.directory before any command.
		expect(body).toContain(`git config --global --add safe.directory ${PREPUSH_RUNNER_CHECKOUT}`);
	});

	test("mounts /tmp as a sticky world-writable tmpfs so the dropped uid can create temp dirs", () => {
		const body = render();
		// A bare `--tmpfs /tmp` mounts 0755 root-owned, so uid 65534 cannot create
		// e.g. /tmp/tsx-65534 (drizzle-kit via tsx) and `bun run check` dies with
		// EACCES. `--perms 1777` gives /tmp standard sticky world-writable semantics.
		expect(body).toContain("--perms 1777 --tmpfs /tmp");
		expect(body).not.toContain("--dev /dev --tmpfs /tmp");
	});

	test("contract prose truthfully describes the /etc binds instead of claiming it is unbound", () => {
		const body = render();
		// The prose must not claim host config is entirely unbound while binding /etc
		// files. It enumerates the tmpfs + the passwd/group requirement.
		expect(body).not.toContain("credentials, host config, or the result artifact");
		expect(body).toContain("/etc is a fresh tmpfs");
		expect(body).toMatch(/initdb resolves 65534/i);
	});

	test("keeps result custody with the trusted outer coordinator", () => {
		const body = render();
		// The result artifact is written by the coordinator, distinct from the
		// wrapper-owned result.json, and copied to the exact job/host share path. The
		// sandbox never binds or writes the result artifact.
		expect(body).toContain(`/work/out/${PREPUSH_RESULT_NAME}`);
		// The share path is computed IN the script from RUNNER_JOB_ID and `hostname`,
		// so the rendered body carries the derivation rather than a `<host>` literal.
		expect(body).toContain('out_dir="${share_root}/runners/jobs/${RUNNER_JOB_ID}/${host}"');
		expect(body).toContain(
			'"output_path":"${share_root}/runners/jobs/${RUNNER_JOB_ID}/${host}/validation.log"',
		);
		expect(body).not.toContain("/work/out/result.json");
		// Both share writes are atomic: temp file then `mv -f`, so a reader sees
		// either nothing or the complete bytes.
		expect(body).toContain('mv -f "$out_dir/.validation.log.tmp" "$out_dir/validation.log"');
		expect(body).toContain(
			`mv -f "$out_dir/.${PREPUSH_RESULT_NAME}.tmp" "$out_dir/${PREPUSH_RESULT_NAME}"`,
		);
		expect(body).toContain("result_written=1");
		expect(body).toContain("trap on_exit EXIT");
		// A written result always exits 0: a non-zero wrapper status is refused before
		// the result is ever read.
		const writeCall = body.indexOf('write_result "$overall" "$checks_json" ""');
		expect(writeCall).toBeGreaterThan(0);
		expect(body.indexOf("\nexit 0")).toBeGreaterThan(writeCall);
	});

	test("is an executable bash script, not prose an agent reads", () => {
		const body = render();
		expect(body.startsWith("#!/usr/bin/env bash\n")).toBe(true);
		expect(body).toContain("set -euo pipefail");
	});

	test("fills the host directory by running `hostname`, never by expanding a $HOSTNAME env ref", () => {
		const body = render();
		// The host directory is filled by RUNNING the command, so nothing can expand a
		// $HOSTNAME env reference to a guessed number (twice "1" in #125).
		expect(body).toContain('host="$(hostname)"');
		expect(body).not.toContain("$HOSTNAME");
		expect(body).not.toContain("system-provided HOSTNAME only");
	});

	test("requires the sandbox and never runs the commands unsandboxed", () => {
		const body = render();
		expect(body).toContain("sudo bwrap");
		// Every fixed command reaches the box ONLY as an argument to the sandboxed
		// script writer — there is no unsandboxed invocation of either.
		for (const command of PREPUSH_COMMANDS) {
			expect(body).toContain(`write_command_script '${command}'`);
		}
	});

	test("installs dependencies from the pinned registry for the runner's own platform", () => {
		const body = render();
		// The runner installs for its OWN platform (#59 retired the staged store, which
		// only ever held the macOS watcher's os/cpu-gated binaries). Versions stay
		// pinned by the lockfile and the fetch host stays author-pinned, so a candidate
		// .npmrc/bunfig cannot redirect the install.
		// The cwd is STATED, not inferred: a runner agent ran this install from /work
		// on 2026-08-17, so the command carries its own `cd` into the checkout.
		expect(body).toContain(
			"cd /work/checkout && bun install --frozen-lockfile --ignore-scripts --registry https://registry.npmjs.org/",
		);
		// The retired offline-store mechanism must not come back.
		expect(body).not.toContain("--prefer-offline");
		expect(body).not.toContain("candidate-node_modules.tar");
		// The registry appears exactly once: there is no second install line for a
		// different endpoint to be reached from.
		expect(body.match(/--registry /g)?.length).toBe(1);
		// Lifecycle scripts stay blocked and the pinned/frozen semantics are preserved.
		expect(body).toContain("--ignore-scripts");
		expect(body).toContain("--frozen-lockfile");
	});

	test("ends with the fixed prohibition line (never truncated)", () => {
		const body = render();
		// The script emits it as a trailing comment; the sentence is unchanged.
		expect(body.endsWith(`# ${PREPUSH_BODY_FINAL_LINE}`)).toBe(true);
	});

	test("fails closed (returns null) for an unsafe job id", () => {
		expect(renderPrepushJobBody(REPO, SHA, "../escape")).toBeNull();
		expect(renderPrepushJobBody(REPO, SHA, "")).toBeNull();
	});

	test("embeds the validated comparison base after the exact HEAD checkout", () => {
		const body = renderPrepushJobBody(REPO, SHA, JOB_ID, MAX_JOB_BODY_CHARS, COMPARISON_BASE);
		expect(body).not.toBeNull();
		const rendered = body as string;
		const checkout = rendered.indexOf(`test "$(git -C "$checkout" rev-parse HEAD)" = ${SHA}`);
		const catFile = rendered.indexOf(`git -C "$checkout" cat-file commit ${COMPARISON_BASE}`);
		const ancestor = rendered.indexOf(
			`git -C "$checkout" merge-base --is-ancestor ${COMPARISON_BASE} ${SHA}`,
		);
		const updateRef = rendered.indexOf(
			`git -C "$checkout" update-ref refs/remotes/origin/main ${COMPARISON_BASE}`,
		);
		expect(checkout).toBeGreaterThan(-1);
		expect(catFile).toBeGreaterThan(checkout);
		expect(ancestor).toBeGreaterThan(catFile);
		expect(updateRef).toBeGreaterThan(ancestor);
	});

	test("rejects an abbreviated or shell-shaped comparison base", () => {
		expect(renderPrepushJobBody(REPO, SHA, JOB_ID, MAX_JOB_BODY_CHARS, "b".repeat(39))).toBeNull();
		expect(
			renderPrepushJobBody(REPO, SHA, JOB_ID, MAX_JOB_BODY_CHARS, `${COMPARISON_BASE};touch pwned`),
		).toBeNull();
	});

	test("keeps a generic consumer body unchanged when no comparison base is supplied", () => {
		const body = renderPrepushJobBody("example/other-repository", SHA, JOB_ID);
		expect(body).not.toBeNull();
		expect(body as string).not.toContain("refs/remotes/origin/main");
		expect(body as string).not.toContain("merge-base --is-ancestor");
	});

	test("stays under the job.md file budget (fail-closed on oversize)", () => {
		// The render returns null rather than truncating past MAX_JOB_BODY_CHARS.
		// This is the LANDED job.md file budget, NOT the params.job transport cap: the
		// full contract travels as a collab file, so it may exceed 10000 chars while
		// still being bounded and fail-closed. A truncated body would drop the trailing
		// prohibition. Lock the complete contract under the file budget.
		const body = render();
		expect(body.length).toBeLessThanOrEqual(MAX_JOB_BODY_CHARS);
	});

	test("fails closed rather than truncating when the configured cap is too small", () => {
		expect(renderPrepushJobBody(REPO, SHA, JOB_ID, 100)).toBeNull();
	});

	test("a realistic body fits under the job.md file budget", () => {
		// The full contract is landed as a collab job.md file, so the body-size limit
		// is the file budget (MAX_JOB_BODY_CHARS), decoupled from the 10000-char
		// params.job transport cap. Assert a realistic repo/sha/jobId renders a
		// non-null body within the file budget (the default cap already enforces this,
		// but pin it against a future cap bump).
		// Use a full-length production jobId (`rw-repo-validate-<uuid>` = 53 chars),
		// which appears several times in the body — a short test jobId would hide a
		// real overflow.
		const body = renderPrepushJobBody(
			"rodaddy/software-factory",
			"a".repeat(40),
			"rw-repo-validate-00000000-0000-0000-0000-000000000000",
		);
		expect(body).not.toBeNull();
		expect((body as string).length).toBeLessThanOrEqual(MAX_JOB_BODY_CHARS);
	});
});

describe("tiny inline bootstrap params.job", () => {
	// The full-length production jobId form (`rw-repo-validate-<uuid>` = 53 chars).
	const PROD_JOB_ID = "rw-repo-validate-00000000-0000-0000-0000-000000000000";
	// A representative 64-char lowercase-hex SHA-256 digest of a landed job.md body.
	const BODY_SHA = "b".repeat(64);

	test("points the runner at the runner-visible job.md for its exact job id", () => {
		const bootstrap = renderPrepushBootstrapJob(JOB_ID, BODY_SHA);
		expect(bootstrap).not.toBeNull();
		// The inline job names the runner-side job.md path, never a caller-supplied path.
		expect(bootstrap as string).toContain(`/mnt/share/runners/jobs/${JOB_ID}/input/job.md`);
		// It is an EXECUTABLE bootstrap, not prose an agent reads: the
		// `script` runtime execs it, so an English instruction line would die under
		// `set -e` on its first word.
		expect((bootstrap as string).startsWith("#!/usr/bin/env bash\n")).toBe(true);
		expect(bootstrap as string).toContain("set -euo pipefail");
		expect(bootstrap as string).not.toContain("Follow that file");
	});

	test("embeds the exact digest and a verify-before-follow instruction over raw bytes", () => {
		// The integrity binding: the bootstrap carries the EXACT provided digest and
		// instructs the runner to recompute SHA-256 over the RAW file bytes, follow the
		// file ONLY on an exact match, and STOP with status "error" on any mismatch or
		// missing file — so an attacker overwriting the shared, writable job.md between
		// staging and the box reading it cannot get the runner to execute a swapped
		// (sudo-normalizing) contract.
		const bootstrap = renderPrepushBootstrapJob(JOB_ID, BODY_SHA);
		expect(bootstrap).not.toBeNull();
		const text = bootstrap as string;
		// The exact provided digest is bound as the expected value.
		expect(text).toContain(`expected_sha256=${BODY_SHA}`);
		// The runner recomputes SHA-256 over the raw bytes of THIS job's job.md.
		expect(text).toContain("sha256sum");
		expect(text).toContain(`staged_job=/mnt/share/runners/jobs/${JOB_ID}/input/job.md`);
		// Verify-before-exec: the contract is exec'd ONLY after the digest compare.
		const compare = text.indexOf('if [ "$observed_sha256" != "$expected_sha256" ]');
		const execLine = text.indexOf('exec /bin/bash "$staged_job"');
		expect(compare).toBeGreaterThan(0);
		expect(execLine).toBeGreaterThan(compare);
		// Fail closed on a missing file or a mismatch, executing nothing.
		expect(text).toContain('if [ ! -f "$staged_job" ]; then');
		expect(text).toContain("prepush bootstrap: staged job body digest mismatch");
	});

	test("stays well under the 10000-char params.job transport cap", () => {
		// The regression this slice fixes: mcp2cli rejects a params.job over 10000
		// chars. The inline bootstrap is fixed and tiny (a 64-char digest is trivial),
		// so it always fits.
		const bootstrap = renderPrepushBootstrapJob(PROD_JOB_ID, BODY_SHA);
		expect(bootstrap).not.toBeNull();
		expect((bootstrap as string).length).toBeLessThan(RUNNER_JOB_TRANSPORT_CAP);
		expect(RUNNER_JOB_TRANSPORT_CAP).toBe(10_000);
	});

	test("is size-independent of the contract body", () => {
		// The bootstrap length depends only on the (fixed-form) job id and the fixed
		// 64-char digest, never on the body. Two different repos/SHAs with the same job
		// id and digest yield an identical bootstrap, and it is far smaller than the
		// rendered body.
		const bootstrap = renderPrepushBootstrapJob(JOB_ID, BODY_SHA) ?? "";
		const bodyA = renderPrepushJobBody("rodaddy/software-factory", "a".repeat(40), JOB_ID) ?? "";
		const bodyB = renderPrepushJobBody("some-owner/some-other-repo", "f".repeat(64), JOB_ID) ?? "";
		expect(bodyA.length).toBeGreaterThan(0);
		expect(bodyB.length).toBeGreaterThan(0);
		// Bootstrap is the same regardless of body content, and much shorter.
		expect(bootstrap.length).toBeLessThan(bodyA.length);
		expect(bootstrap.length).toBeLessThan(RUNNER_JOB_TRANSPORT_CAP);
	});

	test("fails closed (returns null) for an unsafe job id", () => {
		expect(renderPrepushBootstrapJob("../escape", BODY_SHA)).toBeNull();
		expect(renderPrepushBootstrapJob("", BODY_SHA)).toBeNull();
	});

	test("fails closed (returns null) for a non-SHA-256-hex digest", () => {
		// A digest that is not exactly 64 lowercase-hex chars cannot bind the runner to
		// the landed bytes, so the render fails closed rather than emitting an
		// unenforceable integrity check.
		expect(renderPrepushBootstrapJob(JOB_ID, "")).toBeNull();
		expect(renderPrepushBootstrapJob(JOB_ID, "abc")).toBeNull();
		expect(renderPrepushBootstrapJob(JOB_ID, "g".repeat(64))).toBeNull();
		expect(renderPrepushBootstrapJob(JOB_ID, "A".repeat(64))).toBeNull();
		expect(renderPrepushBootstrapJob(JOB_ID, "b".repeat(63))).toBeNull();
		expect(renderPrepushBootstrapJob(JOB_ID, "b".repeat(65))).toBeNull();
	});
});

describe("the rendered body is a real bash program", () => {
	const PROD_JOB_ID = "rw-repo-validate-00000000-0000-0000-0000-000000000000";

	function renderProd(): string {
		const body = renderPrepushJobBody(REPO, SHA, PROD_JOB_ID);
		if (body === null) throw new Error("expected a non-null body");
		return body;
	}

	function scratchDir(): string {
		return mkdtempSync(join(testTmpBase(), "sf573-body-"));
	}

	// A MODERN bash, wherever this suite runs. On macOS /bin/bash is the frozen
	// 3.2 and off-limits (Development AGENTS.md), so Homebrew comes first; on the
	// runner box (Debian trixie) there is no Homebrew and /usr/bin/bash IS modern
	// — the first receipt of this suite on a box died ENOENT on the Homebrew path.
	const BASH =
		["/opt/homebrew/bin/bash", "/usr/bin/bash", "/bin/bash"].find((p) => existsSync(p)) ?? "bash";

	test("passes `bash -n` — the body the box execs actually parses", async () => {
		// The wrapper runs `/bin/bash /work/job/job.md`. A syntax error there means the
		// job dies before the first command with no result written at all, so the parse
		// is the floor this render has to clear.
		const path = join(scratchDir(), "job.md");
		writeFileSync(path, renderProd());
		const proc = Bun.spawn([BASH, "-n", path], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const stderr = await new Response(proc.stderr).text();
		expect(stderr).toBe("");
		expect(await proc.exited).toBe(0);
	});

	test("the shared PostgreSQL block carries no `$`, so the unquoted heredoc is safe", () => {
		// `write_command_script` uses an UNQUOTED heredoc so `$1` (the fixed command)
		// expands. Any `$` in the shared block would expand there too, silently
		// emptying a path. Every literal `$` that must survive is escaped by hand
		// (`\$(id -u)`); this pins that the shared block needs no such escaping.
		expect(scratchPostgresLines().join("\n")).not.toContain("$");
	});

	test("classify_check maps rc and the cluster marker to pass/error/error/fail", async () => {
		// Extract only the classifier so the assertion runs the REAL rendered bash
		// rather than a paraphrase of it.
		const body = renderProd();
		const start = body.indexOf("classify_check() {");
		const end = body.indexOf("\n}\n", start);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const dir = scratchDir();
		const fnPath = join(dir, "classify.sh");
		writeFileSync(fnPath, `${body.slice(start, end + 3)}\n`);
		// The classifier reads ONE marker: pg_ctl's own `server started` line, which
		// proves the sandbox reached the candidate command. Content heuristics were
		// dropped after the second live run: the suite's own output quotes strings
		// like "pg_ctl: could not start server" (a test fixture echoed in a failure),
		// which turned a real candidate `fail` into an infrastructure `error`.
		const noCluster = join(dir, "no-cluster.log");
		writeFileSync(
			noCluster,
			"waiting for server to start.... stopped waiting\npg_ctl: could not start server\n",
		);
		const ran = join(dir, "ran.log");
		writeFileSync(ran, 'server started\nerror: script "check" exited with code 1\n');
		const proc = Bun.spawn(
			[
				BASH,
				"-c",
				`source ${fnPath}; classify_check 0 ${ran}; classify_check 143 ${ran}; classify_check 1 ${noCluster}; classify_check 1 ${ran}`,
			],
			{ stdout: "pipe", stderr: "pipe" },
		);
		const stdout = await new Response(proc.stdout).text();
		expect(await proc.exited).toBe(0);
		expect(stdout.trim().split("\n")).toEqual(["pass", "error", "error", "fail"]);
	});
});

describe("the preamble fails closed before anything can fail", () => {
	const PROD_JOB_ID = "rw-repo-validate-0123abcd-0123-4567-89ab-0123456789ab";

	function renderProd(): string {
		const body = renderPrepushJobBody(REPO, SHA, PROD_JOB_ID);
		if (body === null) throw new Error("expected a non-null body");
		return body;
	}

	const BASH =
		["/opt/homebrew/bin/bash", "/usr/bin/bash", "/bin/bash"].find((p) => existsSync(p)) ?? "bash";

	test("the EXIT trap is armed before the first command that can fail", () => {
		// `host="$(hostname)"` and the mkdir are the first lines that can fail. If the
		// trap is armed after them, a missing hostname or an unwritable share exits 1
		// with NO result artifact — and the watcher refuses a non-zero wrapper status
		// before it ever reads a result.
		const body = renderProd();
		expect(body.indexOf("trap on_exit EXIT")).toBeGreaterThan(0);
		expect(body.indexOf("trap on_exit EXIT")).toBeLessThan(body.indexOf('host="$(hostname)"'));
	});

	test("preamble trap writes the error result and exits 0 when RUNNER_JOB_ID is unset", async () => {
		const body = renderProd();
		const start = body.indexOf("# --- 0. preamble");
		const end = body.indexOf("\n# --- 1.", start);
		expect(start).toBeGreaterThan(0);
		expect(end).toBeGreaterThan(start);
		const dir = mkdtempSync(join(testTmpBase(), "sf579-preamble-"));
		const outRoot = join(dir, "out");
		// Test-side path substitution ONLY: production keeps the fixed /work/out.
		const preamble = body.slice(start, end).split(PREPUSH_RUNNER_OUT_ROOT).join(outRoot);
		const scriptPath = join(dir, "preamble.sh");
		writeFileSync(scriptPath, `${preamble}\n`);
		const proc = Bun.spawn([BASH, "-c", `unset RUNNER_JOB_ID; source ${scriptPath}`], {
			stdout: "pipe",
			stderr: "pipe",
		});
		expect(await proc.exited).toBe(0);
		const resultPath = join(outRoot, PREPUSH_RESULT_NAME);
		expect(existsSync(resultPath)).toBe(true);
		const parsed = JSON.parse(readFileSync(resultPath, "utf8"));
		expect(parsed.status).toBe("error");
		expect(Array.isArray(parsed.checks)).toBe(true);
		expect(parsed.checks.length).toBeGreaterThan(0);
		for (const check of parsed.checks) {
			expect(check.status).toBe("error");
			expect(check.summary).toContain("setup failed during phase");
		}
	});
});
