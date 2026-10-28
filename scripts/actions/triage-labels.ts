/**
 * @module scripts/actions/triage-labels
 * @description The FIXED label allowlist the `issue-triage` Forgejo Actions
 *   workflow may apply to an issue, per repository (L-149). Every
 *   repository gets the same six base names the deployed watcher config
 *   declares for rodaddy/software-factory (`/etc/rodaddy-watcher/repos.yml`
 *   `triage_labels`, read 2026-08-30); a repository listed in
 *   `TRIAGE_LABEL_EXTRAS` adds its own reviewed names to those six. The
 *   renderer embeds the dispatched repository's set into the engine's
 *   instruction body; the poster intersects the engine's chosen labels with the
 *   same set and applies nothing else. A name the engine invents is dropped and
 *   surfaced as a request line — the workflow never creates a label, so every
 *   name listed here must already exist on that repository.
 *
 *   A workflow-state label (`in-progress`) is never listed: triage classifies
 *   an issue, it does not claim one.
 *
 * @outputs
 *   - `TRIAGE_LABEL_ALLOWLIST` -- the six base label names
 *   - `TRIAGE_LABEL_EXTRAS` -- per-repository additions, keyed by owner/repo
 *   - `triageLabelsFor` -- the allowlist for one repository
 *
 * @dependencies
 *   - ../../src/log -- traced
 */
import { traced } from "../../src/log";

export const TRIAGE_LABEL_ALLOWLIST: readonly string[] = [
	"bug",
	"documentation",
	"duplicate",
	"enhancement",
	"question",
	"invalid",
];

export const TRIAGE_LABEL_EXTRAS: Readonly<Record<string, readonly string[]>> = {
	// Settled with the whisper-ios session 2026-09-30 (L-149).
	"rtech/rtech-whisper-hub": ["contract"],
};

function triageLabelsForImpl(repository: string): readonly string[] {
	const extras = Object.hasOwn(TRIAGE_LABEL_EXTRAS, repository)
		? (TRIAGE_LABEL_EXTRAS[repository] ?? [])
		: [];
	return [...TRIAGE_LABEL_ALLOWLIST, ...extras];
}

/** The allowlist for `repository`: the six base names plus that repo's extras. */
export const triageLabelsFor = traced("actions.triageLabelsFor", triageLabelsForImpl);
