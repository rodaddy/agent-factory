/**
 * @module templates/ids
 * @description The allowlisted job-template ids and their fixed receipt specs.
 *   Split out of `src/templates/registry.ts` when the #255 verb templates pushed
 *   that module past its 500-line ceiling (the #193 precedent: the split is
 *   mechanical, the logic is unchanged, and this content is pure DATA — no
 *   rendering, database, or transport involvement). `registry.ts` re-exports
 *   everything here, so every existing consumer keeps its import path.
 *
 * @outputs
 *   - `IMPLEMENT_TEMPLATE_ID` / `TRIAGE_TEMPLATE_ID` /
 *     `INFRA_STATIC_AGENTLESS_TEMPLATE_ID` -- fixed template ids
 *   - `JOB_TEMPLATE_IDS` / `JobTemplateId` -- the dispatch allowlist
 *   - `ReceiptSpec` / `RECEIPT_SPECS` / `receiptSpecFor` -- fixed receipt specs
 */

import { VERB_IDS } from "../jobs/verb-dispatch";
import { traced } from "../log";

/**
 * The fixed implement-lane template id. This is the ONLY template whose
 * runner output is a PROPOSED CHANGE rather than a report, so it is the only one
 * that reads `returnMode` in the registry. It still cannot merge, cannot
 * force-push, and cannot modify CI workflow files — those are enforced at the
 * ingest boundary, not by the body text, because a prompt is not a
 * security control.
 */
export const IMPLEMENT_TEMPLATE_ID = "implement-issue" as const;

/**
 * The fixed issue-triage template id (lane C of #108). Its runner output
 * is a REPORT — proposed classification plus proposed labels — never a change or
 * a forge mutation. The chosen labels are filtered FACTORY-SIDE against the
 * repository's config allowlist at the publication boundary; this template only
 * spells the result fields and renders the repository's allowlist into the body
 * so the runner picks from the fixed set instead of inventing one.
 */
export const TRIAGE_TEMPLATE_ID = "issue-triage" as const;

/**
 * The AGENTLESS infra-static variant. Same reviewed static command set as
 * `infra-static`, executed by the box with no agent binary and therefore no
 * agent credential — the failure class that accounted for 173 of 291 observed
 * job failures, and the one the 2026-08-14 fleet OAuth outage was made of.
 *
 * It is a SEPARATE id rather than a flag on `infra-static` so the conversion is
 * additive: existing `infra-static` dispatches are untouched, and an operator
 * opts in per repository by naming this id in the config `job_templates`
 * allowlist. Registration here alone dispatches nothing.
 */
export const INFRA_STATIC_AGENTLESS_TEMPLATE_ID = "infra-static-agentless" as const;

/**
 * The repository-validation template id, named as a constant so the proposal
 * pass can enqueue one against a pushed head without spelling the
 * string a second time. This is a NAME for the id that was already in the
 * allowlist below — no new template, no registration change, nothing dispatched
 * that was not dispatchable before.
 */
export const VALIDATE_TEMPLATE_ID = "repo-validate" as const;

/** The allowlisted job-template ids. Dispatch is impossible for any other id. */
export const JOB_TEMPLATE_IDS = [
	VALIDATE_TEMPLATE_ID,
	"pr-review",
	"issue-triage",
	"infra-static",
	INFRA_STATIC_AGENTLESS_TEMPLATE_ID,
	IMPLEMENT_TEMPLATE_ID,
	...VERB_IDS,
] as const;

export type JobTemplateId = (typeof JOB_TEMPLATE_IDS)[number];

/**
 * ONE allowlisted job definition's receipt spec.
 *
 * The spec lives beside the dispatch allowlist so the real dispatch renderer can
 * consume it without a publication -> template import cycle. Publication re-exports
 * this same object; there is one producer, not a copied contract.
 */
export interface ReceiptSpec {
	kind: "command-exit" | "http-probe" | "workload-ready" | "none-required";
	describes: string;
}

/** The fixed receipt requirement for every allowlisted dispatch definition. */
export const RECEIPT_SPECS: Record<JobTemplateId, ReceiptSpec> = {
	"repo-validate": {
		kind: "command-exit",
		describes: "the repository's own validation commands exited 0",
	},
	"pr-review": {
		kind: "none-required",
		describes: "review is a report; it mutates nothing and has nothing live to probe",
	},
	"issue-triage": {
		kind: "none-required",
		describes: "triage is a report; it proposes labels and mutates nothing live",
	},
	"infra-static": {
		kind: "command-exit",
		describes: "the static infrastructure checks exited 0 and wrote their artifact",
	},
	[INFRA_STATIC_AGENTLESS_TEMPLATE_ID]: {
		kind: "command-exit",
		describes: "the agentless static infrastructure command exited 0 and wrote its artifact",
	},
	[IMPLEMENT_TEMPLATE_ID]: {
		kind: "command-exit",
		describes: "the proposed change's verification commands exited 0 against the dispatched base",
	},
	newroute: {
		kind: "http-probe",
		describes:
			"the rendered route answered its expected live HTTP probe after PR merge and Argo reconciliation",
	},
	newapp: {
		kind: "workload-ready",
		describes: "the rendered application reported ready after PR merge and Argo reconciliation",
	},
	newdb: {
		kind: "workload-ready",
		describes:
			"the rendered database cluster reported ready after PR merge and Argo reconciliation",
	},
	"newroute-down": {
		kind: "http-probe",
		describes: "the removed route failed its former live HTTP probe after PR merge and Argo prune",
	},
	"newapp-down": {
		kind: "workload-ready",
		describes: "the application resources were absent after PR merge and Argo prune",
	},
	"newdb-down": {
		kind: "workload-ready",
		describes: "the database resources were absent after PR merge and Argo prune",
	},
};

/** This job type's fixed receipt spec, or null when it is not allowlisted. */
export const receiptSpecFor = traced(
	"templates.receiptSpecFor",
	function receiptSpecFor(jobType: string): ReceiptSpec | null {
		return (RECEIPT_SPECS as Record<string, ReceiptSpec>)[jobType] ?? null;
	},
);
