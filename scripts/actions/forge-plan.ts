/**
 * @module scripts/actions/forge-plan
 * @description Typed builders for the Forge write plan a credential job performs (D25:
 *   a job that holds a credential runs no repository code). A code job computes its writes with
 *   these builders and hands `renderPlan(...)` to the credential job, where
 *   `scripts/actions/forge-exec.mjs` is the ONLY performer: it validates the plan, posts each
 *   write, and probes the forge back before a retry. This module sends nothing and takes no env
 *   or token (only the shared `traced` debug log); it exists so every lane (pr-review,
 *   issue-triage, infra-gates) builds the SAME shapes the executor's allowlist and `PROBES` accept.
 *
 * @inputs repo `owner/name`, issue numbers, a commit sha, bodies.
 * @outputs `PlannedWrite` objects and the plan's JSON line.
 */

import { traced } from "../../src/log";

/** The executor's probe kinds and fields, exactly (forge-exec.mjs `PROBES`). */
export type ForgeProbe =
	| { kind: "comment"; issue: number; marker: string }
	| { kind: "identical_comment"; issue: number; body: string }
	| { kind: "status"; sha: string; context: string; target_url: string; state: string }
	| { kind: "labels"; issue: number; names: string[] }
	| { kind: "pull"; head: string };

/** One write the executor performs: a path under `/repos/<repo>/`, a JSON body, a probe. */
export type PlannedWrite = {
	path: string;
	body: Record<string, unknown>;
	probe: ForgeProbe | null;
};

/** The executor refuses a plan with more writes than this (forge-exec.mjs `MAX_WRITES`). */
export const MAX_PLAN_WRITES = 50;

/** A commit status as Forgejo's POST takes it; `state`/`context`/`target_url` are also its probe. */
export interface PlannedStatus {
	state: string;
	context: string;
	description: string;
	target_url: string;
}

/** An issue or PR comment. Its probe is `identical_comment`: it lands only on a comment whose
 * trimmed body equals this one, so a comment that merely contains it never suppresses a retry. */
function commentWriteImpl(repo: string, issue: number, body: string): PlannedWrite {
	return {
		path: `/repos/${repo}/issues/${issue}/comments`,
		body: { body },
		probe: { kind: "identical_comment", issue, body },
	};
}

/** A commit status on a full 40-hex sha. */
function statusWriteImpl(repo: string, sha: string, status: PlannedStatus): PlannedWrite {
	const { state, context, description, target_url } = status;
	return {
		path: `/repos/${repo}/statuses/${sha}`,
		body: { state, context, description, target_url },
		probe: { kind: "status", sha, context, target_url, state },
	};
}

/** Add label names to an issue or PR (Forgejo takes names or ids in `labels`). */
function labelsWriteImpl(repo: string, issue: number, names: readonly string[]): PlannedWrite {
	return {
		path: `/repos/${repo}/issues/${issue}/labels`,
		body: { labels: [...names] },
		probe: { kind: "labels", issue, names: [...names] },
	};
}

/** Open a pull request; an open PR from the same head branch means it landed. */
function pullWriteImpl(
	repo: string,
	body: { head: string } & Record<string, unknown>,
): PlannedWrite {
	return {
		path: `/repos/${repo}/pulls`,
		body: { ...body },
		probe: { kind: "pull", head: body.head },
	};
}

/** The plan as the one JSON line `PLAN_FILE` holds; 1 to MAX_PLAN_WRITES writes, else it throws. */
function renderPlanImpl(writes: readonly PlannedWrite[]): string {
	if (writes.length === 0 || writes.length > MAX_PLAN_WRITES) {
		throw new Error(`a Forge plan holds 1 to ${MAX_PLAN_WRITES} writes, got ${writes.length}`);
	}
	return JSON.stringify({ v: 1, writes });
}

export const commentWrite = traced("actions.forgePlan.commentWrite", commentWriteImpl);

export const statusWrite = traced("actions.forgePlan.statusWrite", statusWriteImpl);

export const labelsWrite = traced("actions.forgePlan.labelsWrite", labelsWriteImpl);

export const pullWrite = traced("actions.forgePlan.pullWrite", pullWriteImpl);

export const renderPlan = traced("actions.forgePlan.renderPlan", renderPlanImpl);
