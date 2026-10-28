/**
 * @module github/publication-terminal
 * @description The fixed terminal-notice builder and its durable enqueue seam.
 *   Dispatch-time terminalization has no validated runner result to publish, so
 *   it uses this separate neutral check shape rather than manufacturing a pass or
 *   fail result. The caller supplies only the watcher-authored terminal reason;
 *   the job identity and SHA remain authoritative database values.
 */
import { traced } from "../log";
import { redactSecrets } from "../results/ingest";
import { capText } from "./publication-text";
import {
	CAPS,
	type JobIdentity,
	TERMINAL_CHECK_NAME,
	TERMINAL_CHECK_TARGET,
	TERMINAL_CHECK_TITLE,
	type TerminalCheckPlan,
	terminalCheckDedupeKey,
	terminalCheckSummaryPrefix,
} from "./publication-types";
import { type PublicationPlanTx, persistPublicationPlan } from "./publish-plan";

/** Build the one fixed neutral notice for a terminalized job with a SHA. */
export const buildTerminalCheck = traced(
	"github.buildTerminalCheck",
	function buildTerminalCheck(
		identity: Pick<JobIdentity, "jobId" | "sha">,
		reason: string,
	): TerminalCheckPlan | null {
		if (identity.sha === "") {
			return null;
		}
		const boundedReason = capText(redactSecrets(reason), CAPS.checkSummary);
		return {
			kind: "check",
			action: "upsert",
			target: TERMINAL_CHECK_TARGET,
			name: TERMINAL_CHECK_NAME,
			sha: identity.sha,
			conclusion: "neutral",
			title: TERMINAL_CHECK_TITLE,
			summary: capText(
				`${terminalCheckSummaryPrefix(identity.jobId)}${boundedReason}`,
				CAPS.checkSummary,
			),
			dedupeKey: terminalCheckDedupeKey(identity),
		};
	},
	// arg 1 `reason` is a bare positional string that lands in a forge check
	// summary and is only redacted INSIDE the body via redactSecrets(); the
	// trace would log the pre-redaction text verbatim.
	{ redact: { args: [1] } },
);

/** Persist one terminal notice through the existing durable posting boundary. */
export const persistTerminalCheck = traced(
	"github.persistTerminalCheck",
	async function persistTerminalCheck(
		tx: PublicationPlanTx,
		identity: Pick<JobIdentity, "jobId" | "sha">,
		reason: string,
		now: Date,
	): Promise<boolean> {
		const plan = buildTerminalCheck(identity, reason);
		if (plan === null) {
			return false;
		}
		return await persistPublicationPlan(tx, identity.jobId, plan, now);
	},
	// arg 2 `reason` -- same bare positional forge-body text as above.
	{ redact: { args: [2] } },
);
