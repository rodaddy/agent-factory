/**
 * @module jobs/verb-redeploy
 * @description The operator RE-RUN signal for an already-terminal verb tuple
 *   — the mechanism PR #302 paid four review rounds to learn it needed,
 *   and deliberately none of the mechanisms those rounds tried.
 *
 *   **The problem.** A verb's dedup tuple is
 *   `(repositoryId, itemId, manifest.sha256, verb)`. Once a row on that tuple goes
 *   terminal the verb cannot run again for the same manifest, which is CORRECT for
 *   a re-observation and WRONG for an operator who fixed the cause and wants the
 *   deploy re-run. Rounds 9-12 each tried to infer that intent from ambient state
 *   — the row's sha, an attempt budget, a forge timestamp — and each was either
 *   too eager (box churn) or too strict (the item stranded forever). The
 *   root cause is that `ControlSurfaceDecision` carries NO flip-vs-refire
 *   distinguisher: `observedLabels` is the CURRENT label set, byte-identical
 *   whether the operator just re-applied a label or the watcher is re-firing an
 *   unchanged one (`_DOCS/decisions-ledger.md` L-017).
 *
 *   **The signal.** A DISTINCT one-shot label, `redeploy:<app>`, settled with
 *   rtech-infra 2026-08-16 (they own the forge-label surface). PRESENCE IS INTENT:
 *   a terminal tuple never legitimately carries the label, so observing it IS the
 *   operator asking for a new run. Nothing is inferred.
 *
 *   **CONSUME BEFORE DISPATCH.** The label is removed from the forge FIRST, and
 *   only then does the verb path run. The ordering is the whole safety property
 *   and it is asymmetric on purpose:
 *
 *     - consume-then-dispatch: a crash between the two loses AT MOST ONE re-run.
 *       The operator re-applies the label. Annoying; bounded; safe.
 *     - dispatch-then-consume: a crash between the two leaves the label standing,
 *       so the next sweep observes it again and re-runs again — an unbounded loop
 *       that reopens the #210 box-churn failure the owner ruled on 2026-08-01.
 *
 *   A failed removal is therefore NOT a re-run. `consumeRedeployRequests` returns
 *   only the apps whose label the forge confirmed removed, so a forge that refuses
 *   the write produces no dispatch at all rather than a run whose signal is still
 *   armed.
 *
 *   **The re-run does not touch the terminal row.** `jobs.sha` is also the
 *   identity anchor `results/store.ts matchesExpectedIdentity` checks a runner's
 *   self-reported `dispatch_sha` against, and mutating it corrupts the verdict for
 *   a late result from a box still running (round 10 P2). Instead the FRESH row
 *   gets its own run-scoped sha derived from the manifest digest and the consumed
 *   label — see `redeployRunSha`. The historical row keeps its sha, its status and
 *   its `terminalReason`; nothing is rekeyed and nothing is deleted.
 *
 * @outputs
 *   - `RedeployConsumption` -- one consumed signal: the app and its run sha
 *   - `redeployRunSha` -- the run-scoped dedup sha a consumed signal dispatches on
 *   - `consumeRedeployRequests` -- remove the labels on the forge, then report
 *
 * @dependencies
 *   - ../control-surface/boundary -- the semantic label read/write surface
 *   - ../control-surface/vocabulary -- the `redeploy:` stem and its parser
 */
import { createHash } from "node:crypto";
import type { ControlSurface } from "../control-surface/boundary";
import { redeployRequests } from "../control-surface/vocabulary";
import { errorMessage, log, traced } from "../log";

/** One consumed `redeploy:<app>` signal and the dedup sha its re-run dispatches on. */
export interface RedeployConsumption {
	/** The app suffix the operator named. */
	readonly app: string;
	/** The exact label token that was removed from the forge. */
	readonly label: string;
	/** The run-scoped dedup sha the fresh job row takes. */
	readonly runSha: string;
}

/**
 * The dedup sha a consumed re-run dispatches on.
 *
 * A re-run is genuinely NEW WORK for the same manifest, so it needs its own point
 * in the `(repository, item, sha, verb)` key space rather than the one the
 * terminal row already holds. This derives that point from the manifest digest,
 * the consumed label, and the instant of consumption.
 *
 * WHY THE INSTANT IS IN THE DIGEST. Without it a second re-run of the same app on
 * the same manifest would land on the SAME derived sha as the first, hit the very
 * terminal row the first re-run left behind, and be refused — so the label would
 * work exactly once per manifest and then silently stop. The instant is what makes
 * each consumption its own run. It is safe here in a way it was NOT in round 12:
 * the timestamp is not being read as evidence of operator intent (the label
 * already IS that evidence), it is only making a consumed signal unique.
 *
 * The result is still a 64-hex digest, so every existing consumer — the identity
 * check, the body's `dispatch_sha`, the schema's text column — sees the shape it
 * already handles.
 */
export const redeployRunSha = traced(
	"jobs.redeployRunSha",
	function redeployRunSha(manifestSha: string, label: string, at: Date): string {
		return createHash("sha256")
			.update(`redeploy:${manifestSha}:${label}:${at.toISOString()}`)
			.digest("hex");
	},
);

/** A bounded, secret-free consumption receipt body. */
function receiptBody(app: string, runSha: string): string {
	return [
		`### software-factory: \`redeploy:${app}\` consumed`,
		"",
		`The one-shot re-run label was REMOVED before any dispatch (sf#305), so this`,
		`signal fires exactly once. Re-apply it to ask for another run.`,
		"",
		`Run key: \`${runSha.slice(0, 12)}\``,
	].join("\n");
}

/**
 * Post the consumption receipt, best effort.
 *
 * rtech-infra asked for this because Forgejo's timeline shows label events less
 * reliably than GitHub's, so an operator watching the issue can otherwise see the
 * label vanish with no record of why. It is a RECEIPT, never a gate: a comment
 * that fails to post must not undo a consumption that already happened, because
 * the alternative is a signal that reads as un-consumed and re-fires.
 */
async function postConsumptionReceipt(
	deps: ConsumeRedeployDeps,
	item: number,
	consumed: RedeployConsumption,
): Promise<void> {
	if (deps.comment === undefined) return;
	try {
		await deps.comment({
			repository: deps.repository,
			item,
			body: receiptBody(consumed.app, consumed.runSha),
		});
	} catch (error) {
		log("warn", "verb.redeploy.receipt_failed", {
			repository: deps.repository,
			item,
			app: consumed.app,
			cause: errorMessage(error),
		});
	}
}

/** The bounded comment writer the consumption receipt uses. */
export type RedeployCommenter = (args: {
	repository: string;
	item: number;
	body: string;
}) => Promise<unknown>;

export interface ConsumeRedeployDeps {
	/** The semantic surface the label removal goes through. Must be APPLYING. */
	readonly surface: ControlSurface;
	/** The managed repository, as it appears in the watcher's own config. */
	readonly repository: string;
	/** The rails-manifest digest the re-run's run-scoped sha is derived from. */
	readonly manifestSha: string;
	/** The consumption receipt writer; absent means no receipt is posted. */
	readonly comment?: RedeployCommenter;
	/** Clock seam, shared with the cycle so a run sha and its log agree. */
	readonly now: Date;
}

/**
 * Remove one `redeploy:<app>` label on the forge and report whether it is gone.
 *
 * The surface's `applied` flag is the ONLY evidence accepted. A dry-run surface
 * answers `applied: false` and so does a failed write, and BOTH must mean "not
 * consumed" — treating an unapplied proposal as a consumption is precisely how a
 * dispatch would happen with the signal still armed on the forge.
 */
async function removeRedeployLabel(
	deps: ConsumeRedeployDeps,
	item: number,
	label: string,
): Promise<boolean> {
	try {
		const result = await deps.surface.proposeLabelWrite({
			repository: deps.repository,
			item,
			removeLabels: [label],
		});
		if (result.applied) return true;
		log("warn", "verb.redeploy.consume_failed", {
			repository: deps.repository,
			item,
			label,
			intent: result.intent,
			...(result.error === undefined ? {} : { cause: result.error }),
		});
		return false;
	} catch (error) {
		log("warn", "verb.redeploy.consume_failed", {
			repository: deps.repository,
			item,
			label,
			cause: errorMessage(error),
		});
		return false;
	}
}

/**
 * CONSUME every `redeploy:<app>` signal on one item, BEFORE anything dispatches.
 *
 * Returns one entry per label the forge confirmed removed. A label whose removal
 * failed is absent from the result, so its caller dispatches nothing for that app
 * and the still-standing label is simply re-observed next pass — the retry is the
 * operator's original request, unchanged, rather than a second run.
 */
export const consumeRedeployRequests = traced(
	"jobs.consumeRedeployRequests",
	async function consumeRedeployRequests(
		deps: ConsumeRedeployDeps,
		item: number,
		labels: readonly string[],
	): Promise<RedeployConsumption[]> {
		const requested = redeployRequests(labels);
		if (requested.length === 0) return [];

		const consumed: RedeployConsumption[] = [];
		for (const { label, app } of requested) {
			if (!(await removeRedeployLabel(deps, item, label))) continue;
			const entry: RedeployConsumption = {
				app,
				label,
				runSha: redeployRunSha(deps.manifestSha, label, deps.now),
			};
			log("info", "verb.redeploy.consumed", {
				repository: deps.repository,
				item,
				app,
				run_sha: entry.runSha,
			});
			await postConsumptionReceipt(deps, item, entry);
			consumed.push(entry);
		}
		return consumed;
	},
	// `deps.surface` is the injected credentialed forge boundary; its concrete
	// shape is an interface, so a plain-object implementation would be recursed
	// into by summarize(). Redacted positionally rather than trusting key match.
	{ redact: { args: [0] } },
);
