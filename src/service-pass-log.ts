/**
 * @module service-pass-log
 * @description The reconcile pass's correlation seed and its JSON result line,
 *  split out of `service.ts`, which sits at the 500-line ceiling.
 *
 *   Every pass runs inside its own `withLogFields({ pass_id })` scope, so every
 *   line the pass emits (its `traced()` enter/exit included) carries the same
 *   `pass_id`. The scope is opened PER PASS, around the pass body only: the
 *   scheduler and its timer are created outside any scope, because a timer
 *   created inside one inherits that store for the life of the process.
 *
 *   The default result sink was a plain-text stdout line that `| json` dropped
 *   in Loki; it is now the `reconcile.pass` event. `summarize()` below
 *   stays for callers that want the one-line prose.
 *
 * @outputs
 *   - `passScoped` -- wrap a pass body so each call seeds a fresh `pass_id`
 *   - `logPassResult` -- the default result sink, one `reconcile.pass` JSON line
 *   - `summarize` -- the one-line prose pass summary, for CLI callers
 */

import { randomUUID } from "node:crypto";
import { log, traced, withLogFields } from "./log";
import type { PassResult } from "./reconcile/pass";

/** A pass body plus the fields of the pass it most recently started. */
export interface PassScope {
	/** Run one pass under a fresh `pass_id`. */
	run: () => Promise<PassResult>;
	/** The latest pass's fields, for the result sink that runs after the pass. */
	fields: () => Record<string, unknown>;
}

/**
 * Wrap a pass body so each call runs under a fresh `pass_id`.
 *
 * The scheduler invokes its result sink after `run()` settles, outside the
 * pass's async scope, so `fields()` hands the same `pass_id` to the sink;
 * passes never overlap (the scheduler coalesces), so the latest id is the
 * sink's pass.
 *
 * @param run - the unscoped pass body
 */
export const passScoped = traced(
	"service.passScoped",
	(run: () => Promise<PassResult>): PassScope => {
		let passId: string | undefined;
		return {
			run: () => {
				passId = randomUUID();
				return withLogFields({ pass_id: passId }, run);
			},
			fields: () => (passId === undefined ? {} : { pass_id: passId }),
		};
	},
);

/**
 * Emit one pass result as the `reconcile.pass` event: ok/failed counts,
 * duration, and the failed repositories with their bounded errors (the same
 * values `summarize()` interpolates, all already bounded by `runPass`).
 *
 * @param result - the completed pass
 */
export const logPassResult = traced("service.logPassResult", (result: PassResult): void => {
	const failures = passFailures(result);
	log("info", "reconcile.pass", {
		ok: result.okCount,
		failed: result.failCount,
		ms: result.durationMs,
		failures: failures.length === 0 ? undefined : failures.join("; "),
	});
});

/** The failed repositories of a pass, each with its already-bounded error. */
function passFailures(result: PassResult): string[] {
	return result.repositories.flatMap((repo) =>
		repo.error === undefined || repo.error === "" ? [] : [`${repo.repository}: ${repo.error}`],
	);
}

/**
 * One-line, secret-free summary of a completed pass, for CLI callers (moved
 * here from `service.ts` by sf#526; the service's default sink is now the
 * `reconcile.pass` event above).
 *
 * NAMES THE FAILED REPOSITORIES. `runPass` captures a bounded,
 * secret-free `error` on every failed `RepoPassResult` and this line reported
 * only the COUNT, so on the watcher host "1 failed" named no repository for ten days —
 * the pass knew exactly which repo broke and which forge call did it, and threw
 * that away one function call from the operator. Every value interpolated here
 * is one `runPass` already bounded for logging; nothing new is read.
 */
export const summarize = traced("service.summarize", (result: PassResult): string => {
	const head =
		`reconcile pass: ${result.okCount} ok, ${result.failCount} failed, ` + `${result.durationMs}ms`;
	const failures = passFailures(result);
	// A clean pass keeps the exact line it has always emitted, so nothing parsing
	// the healthy case sees a change; only a pass that actually failed grows detail.
	return failures.length === 0 ? head : `${head} — ${failures.join("; ")}`;
});
