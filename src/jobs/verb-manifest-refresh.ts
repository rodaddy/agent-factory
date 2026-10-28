/**
 * @module jobs/verb-manifest-refresh
 * @description Keep the rails-manifest SHARE CHECKOUT fresh at the moment the verb
 *   pass reads it, or -- in `external` mode -- record the on-disk HEAD when
 *   another host owns the refresh. Lives beside `verb-live` (which owns the
 *   manifest READ) rather than in `service-cycle`, so the cycle module stays under its
 *   size ceiling and the refresh has one owning boundary.
 *
 * @outputs
 *   - `ManifestRefreshMode` -- who refreshes the checkout: this watcher, or another host
 *   - `refreshManifestCheckout` -- best-effort fast-forward of the checkout holding a manifest
 *
 * @dependencies
 *   - node:path -- resolve the checkout directory from the manifest path
 *   - node:fs -- locate the checkout ROOT for the scoped `safe.directory` exception
 *   - ../log -- the service's only logger; every failure path is a bounded log line
 */
import { existsSync } from "node:fs";
import { dirname, parse } from "node:path";
import { errorMessage, log, traced } from "../log";

/**
 * Who keeps the share checkout current.
 *
 * - `pull` -- this watcher fast-forwards it itself before each read.
 * - `external` -- another host does; this pass only records the on-disk HEAD.
 */
export type ManifestRefreshMode = "pull" | "external";

/** Longest a bounded git stderr slice may reach in a refresh log line. */
const REFRESH_STDERR_LIMIT = 300;

/** Wall-clock caps for the two refresh git calls; a hung git never stalls a cycle. */
const REV_PARSE_TIMEOUT_MS = 10_000;
const PULL_TIMEOUT_MS = 30_000;

/** Collapse and clamp a git stderr slice so a log line stays bounded. */
function boundedStderr(value: string): string {
	const collapsed = value.replace(/\s+/g, " ").trim();
	return collapsed.length > REFRESH_STDERR_LIMIT
		? `${collapsed.slice(0, REFRESH_STDERR_LIMIT - 3)}...`
		: collapsed;
}

/**
 * Nearest ancestor of `from` (inclusive) that contains a `.git` entry, or `from` itself
 * when there is none.
 *
 * **Why this is a filesystem walk and not `git rev-parse --show-toplevel`.**
 * The exception below must name the repository ROOT, and the FIRST git call is the one
 * that discovers the root — so at that moment the root is not yet known. git also
 * rejects a subdirectory as the `safe.directory` value (probed against git 2.55.0: the
 * exception named on the manifest's own directory is refused while the root is
 * accepted), so passing the cwd would be a no-op. Walking for `.git` breaks the cycle
 * using only `manifestPath`, which this module already receives. A wrong guess is
 * harmless: a `safe.directory` naming a path that is not the repository root simply
 * fails to match, leaving today's skip-and-log behavior exactly as it is.
 *
 * `.git` is tested with `existsSync` rather than `isDirectory`, because in a worktree
 * or a submodule it is a FILE containing a `gitdir:` pointer.
 */
function checkoutRoot(from: string): string {
	let current = from;
	for (;;) {
		if (existsSync(`${current}/.git`)) return current;
		const parent = dirname(current);
		// `dirname` is a fixed point at the filesystem root; stop there, never loop.
		if (parent === current || current === parse(current).root) return from;
		current = parent;
	}
}

/**
 * One bounded, non-interactive git call. Never throws; a spawn failure is an exit code.
 *
 * **The scoped `safe.directory`.** RUNNING evidence, the watcher host, 2026-08-17
 * 07:32:47Z: `verb.manifest.refresh_skipped` with cause `fatal: detected dubious
 * ownership in repository at '/mnt/share/checkouts/rtech-infra'`. The service user does
 * not own the collab share checkout, so WITHOUT this exception every refresh skips and
 * sf#321 is inert in production — deployed, and doing nothing.
 *
 * The exception is named on this single invocation and is scoped to one path. It is
 * never a global `git config` write: the the watcher host box config is infra-owned and
 * `_DOCS/deployment.md` explicitly forbids a global `safe.directory`.
 */
async function runRefreshGit(
	cwd: string,
	args: readonly string[],
	timeoutMs: number,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	try {
		const proc = Bun.spawn(
			["git", "-c", `safe.directory=${checkoutRoot(cwd)}`, "-C", cwd, ...args],
			{
				stdout: "pipe",
				stderr: "pipe",
				env: {
					...process.env,
					// Refuse any interactive prompt rather than blocking on one; the cap
					// below is the backstop, this is the fast path.
					GIT_TERMINAL_PROMPT: "0",
					// Pin the locale: this module logs git's own stderr.
					LC_ALL: "C",
					LANG: "C",
				},
			},
		);
		const timer = setTimeout(() => {
			proc.kill();
		}, timeoutMs);
		try {
			const [stdout, stderr, exitCode] = await Promise.all([
				new Response(proc.stdout).text(),
				new Response(proc.stderr).text(),
				proc.exited,
			]);
			return { exitCode, stdout, stderr };
		} finally {
			clearTimeout(timer);
		}
	} catch (error) {
		return { exitCode: 1, stdout: "", stderr: errorMessage(error) };
	}
}

/**
 * Fast-forward the checkout that holds the rails manifest, immediately before the
 * manifest is read.
 *
 * **Why this exists.** `railsManifestPath` points into a SHARE checkout of
 * `rtech-infra` that nothing else pulls. A tuple reset lands as a commit on that
 * repository's `main`, and until somebody runs `git pull` by hand the verb pass keeps
 * reading the OLD manifest sha, so the reset is invisible. Reset #5 sat unseen through
 * two reconcile passes on 2026-08-17 (03:47 and 04:02Z) for exactly this reason — the
 * checkout was parked at 92212df carrying the already-terminal manifest sha 68fba995,
 * and the rail moved only once infra fast-forwarded it by hand to 5f9d9b2. Agreed
 * cross-seat 2026-08-16: the CONSUMER of the manifest owns keeping its read fresh, and
 * infra owns the checkout existing.
 *
 * **The refresh is best-effort and NEVER throws.** A stale manifest read is today's
 * behavior, not a new failure, so every failure path logs and returns:
 *
 * - Not a git checkout (or `rev-parse` fails) -> `verb.manifest.refresh_skipped`.
 * - `pull --ff-only` fails -> `verb.manifest.refresh_failed`. That covers a DIVERGED
 *   checkout, an offline forge, and index-lock contention alike, and the log line IS
 *   the divergence report. This function never merges, rebases, or resets; resolving a
 *   divergent checkout is an operator action by design.
 * - Checkout owned by another uid ("dubious ownership") -> HANDLED, no longer a skip.
 *   Both git calls carry a `safe.directory` exception scoped to the checkout root, so a
 *   share checkout the service user does not own refreshes normally. This was
 *   NOT handled between sf#321 and sf#348: on the real box every refresh skipped on it.
 *
 * Refresh-at-read is deliberate: a scheduled refresh can go stale between the refresh
 * and the read, and the pass is the reader.
 *
 * **Why `external` exists.** the watcher host holds no git credential by design, so a
 * `pull` there fails on EVERY cycle and the refresh is pure noise. rtech-infra#897
 * refreshes the share checkout from a fleet host instead. In `external` mode this function
 * therefore attempts no pull at all — it reads the on-disk HEAD and logs it, so
 * staleness stays MEASURABLE from the watcher's own log without the watcher owning the
 * refresh.
 *
 * @param manifestPath - absolute path to the manifest file inside the checkout
 * @param options.mode - who refreshes the checkout; defaults to `pull`
 */
export const refreshManifestCheckout = traced(
	"jobs.refreshManifestCheckout",
	async function refreshManifestCheckout(
		manifestPath: string,
		options: { mode?: ManifestRefreshMode } = {},
	): Promise<void> {
		const dir = dirname(manifestPath);
		const toplevel = await runRefreshGit(
			dir,
			["rev-parse", "--show-toplevel"],
			REV_PARSE_TIMEOUT_MS,
		);
		if (toplevel.exitCode !== 0) {
			log("warn", "verb.manifest.refresh_skipped", {
				path: dir,
				cause: boundedStderr(toplevel.stderr),
			});
			return;
		}
		const root = toplevel.stdout.trim();
		if (root.length === 0) {
			log("warn", "verb.manifest.refresh_skipped", { path: dir, cause: "empty toplevel" });
			return;
		}
		if ((options.mode ?? "pull") === "external") {
			const head = await runRefreshGit(root, ["rev-parse", "HEAD"], REV_PARSE_TIMEOUT_MS);
			if (head.exitCode !== 0) {
				log("warn", "verb.manifest.refresh_skipped", {
					path: root,
					cause: boundedStderr(head.stderr),
				});
				return;
			}
			log("info", "verb.manifest.refresh_external", { path: root, head: head.stdout.trim() });
			return;
		}
		const pulled = await runRefreshGit(root, ["pull", "--ff-only", "--quiet"], PULL_TIMEOUT_MS);
		if (pulled.exitCode !== 0) {
			log("warn", "verb.manifest.refresh_failed", {
				path: root,
				cause: boundedStderr(pulled.stderr),
			});
			return;
		}
		log("info", "verb.manifest.refreshed", { path: root });
	},
);
