/**
 * @module control-surface/github-backend
 * @description The GitHub backend: the ONE place GitHub's host vocabulary is
 *   allowed to appear. It composes the two providers #253 clause 2 names — REST
 *   for an item's labels, and Project v2 GraphQL for its board column — behind a
 *   single `ControlSurface`, so job logic sees three semantic operations and
 *   never learns that the column came from a different API than the labels.
 *
 *   The REST half rides the EXISTING reviewed `ForgeClient` transport rather
 *   than opening a second HTTP path, so credentials, rate handling, and bounded
 *   responses are unchanged. The GraphQL half is injected as a narrow
 *   `runProjectQuery` seam: Project 11's ids live in rtech-infra
 *   `_DOCS/project-board.md` (another seat's repo, read-only to this one), and
 *   this repo must not grow a second forge credential path to reach them. When
 *   no query seam is injected the column read fails SOFT to `null` — "not on a
 *   board I can see" — because a missing board must never crash a reconciler
 *   pass whose real subject is the labels.
 *
 *   `proposeLabelWrite` honours an `apply` flag that DEFAULTS TO FALSE. A
 *   backend that mutates unless told not to is one forgotten argument away from
 *   dispatching during a dry run; defaulting to propose-only makes the safe
 *   behavior the one you get by omission.
 *
 *   Both halves of the proposal are honoured: additions POST as one batch, and
 *   removals DELETE one label at a time because that is the shape both GitHub and
 *   Forgejo expose. Removals run FIRST — see `applyLabelWrite` for why the order
 *   is load-bearing for sf#305's one-shot `redeploy:<app>` signal.
 *
 * @outputs
 *   - `GitHubControlSurfaceDeps` -- the injectable client/query/apply seams
 *   - `createGitHubControlSurface` -- build the GitHub-backed surface
 *
 * @dependencies
 *   - ./boundary -- the semantic control-surface contract
 *   - ../forge/boundary -- the existing reviewed transport client
 *   - ../forge/labels -- the one label writer, shared with the publisher
 */
import type { ForgeClient } from "../forge/boundary";
import { addIssueLabels, removeIssueLabel } from "../forge/labels";
import { traced } from "../log";
import type {
	ControlSurface,
	ControlSurfaceRef,
	LabelWriteProposal,
	LabelWriteResult,
} from "./boundary";

/**
 * The Project v2 column lookup, injected. It takes the same semantic ref the
 * surface does and returns a column NAME, so the caller never handles a node id
 * or a GraphQL document. Production wiring supplies the recorded Project 11 ids
 * (rtech-infra `_DOCS/project-board.md`); tests supply a fake.
 */
export type ProjectColumnReader = (ref: ControlSurfaceRef) => Promise<string | null>;

export interface GitHubControlSurfaceDeps {
	/** The reviewed REST transport used for the label read/write. */
	readonly client: ForgeClient;
	/** Project v2 column reader; absent means "no board visible" (null column). */
	readonly readProjectColumn?: ProjectColumnReader;
	/**
	 * When false (the DEFAULT), `proposeLabelWrite` records intent and mutates
	 * nothing. The dry-run pass never sets it; only an authorized applying caller
	 * does.
	 */
	readonly apply?: boolean;
}

/** Split `owner/repo` into its parts, or null when the string is not one. */
function splitRepository(repository: string): { owner: string; repo: string } | null {
	const parts = repository.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) {
		return null;
	}
	return { owner: parts[0], repo: parts[1] };
}

/** A bounded, secret-free one-line summary of a proposed write. */
function describeIntent(proposal: LabelWriteProposal): string {
	const add = (proposal.addLabels ?? []).map((l) => `+${l}`);
	const remove = (proposal.removeLabels ?? []).map((l) => `-${l}`);
	const changes = [...add, ...remove];
	const what = changes.length > 0 ? changes.join(",") : "no-op";
	return `${proposal.repository}#${proposal.item} ${what}`;
}

/** Read an item's label names over REST. The only place the path/verb appears. */
async function readLabelsOverRest(client: ForgeClient, ref: ControlSurfaceRef): Promise<string[]> {
	const parts = splitRepository(ref.repository);
	if (!parts) {
		return [];
	}
	const response = await client.get<{ labels?: Array<{ name?: unknown }> }>(
		`/repos/${parts.owner}/${parts.repo}/issues/${ref.item}`,
	);
	const labels = response.data?.labels;
	if (!Array.isArray(labels)) {
		return [];
	}
	return labels
		.map((label) => (typeof label?.name === "string" ? label.name : ""))
		.filter((name) => name.length > 0);
}

/**
 * Apply a label write over REST, translating any failure into a bounded,
 * secret-free result. Reached ONLY when the surface was built with `apply: true`.
 *
 * REMOVALS RUN BEFORE ADDITIONS. sf#305's consume-before-dispatch ordering is the
 * reason: the one caller that does both is consuming a one-shot signal, and a
 * failure partway through must leave the signal CONSUMED rather than re-armed. An
 * add that failed is re-proposed harmlessly next pass; a remove that never ran
 * re-fires the run it was supposed to make one-shot.
 */
async function applyLabelWrite(
	client: ForgeClient,
	proposal: LabelWriteProposal,
	intent: string,
): Promise<LabelWriteResult> {
	const parts = splitRepository(proposal.repository);
	if (!parts) {
		return { applied: false, intent, error: "repository is not owner/repo" };
	}
	const add = proposal.addLabels ?? [];
	const remove = proposal.removeLabels ?? [];
	if (add.length === 0 && remove.length === 0) {
		return { applied: false, intent };
	}
	try {
		// sf#816: the one label writer shared with the publisher, keyed by NAME.
		const repository = `${parts.owner}/${parts.repo}`;
		for (const label of remove) {
			await removeIssueLabel(client, repository, proposal.item, label);
		}
		if (add.length > 0) {
			await addIssueLabels(client, repository, proposal.item, add);
		}
		return { applied: true, intent };
	} catch (err) {
		return {
			applied: false,
			intent,
			error: err instanceof Error ? err.message : "label write failed",
		};
	}
}

/**
 * Build the GitHub-backed control surface. Every host-specific detail — the REST
 * path, the verb, the payload shape, the Projects API — is confined to this
 * module; callers hold only the semantic `ControlSurface`.
 */
export const createGitHubControlSurface = traced(
	"control-surface.createGitHubControlSurface",
	function createGitHubControlSurface(deps: GitHubControlSurfaceDeps): ControlSurface {
		const { client, readProjectColumn, apply = false } = deps;

		return {
			async readLabels(ref: ControlSurfaceRef): Promise<string[]> {
				return await readLabelsOverRest(client, ref);
			},

			async readColumn(ref: ControlSurfaceRef): Promise<string | null> {
				if (!readProjectColumn) {
					// Fail SOFT: no board reader wired is "no column visible", never an
					// exception that would take down a pass whose subject is the labels.
					return null;
				}
				return await readProjectColumn(ref);
			},

			async proposeLabelWrite(proposal: LabelWriteProposal): Promise<LabelWriteResult> {
				const intent = describeIntent(proposal);
				if (!apply) {
					// The dry-run contract: intent recorded, nothing mutated.
					return { applied: false, intent };
				}
				return await applyLabelWrite(client, proposal, intent);
			},
		};
	},
);
