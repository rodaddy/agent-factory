/**
 * @module forge/labels
 * @description The ONE issue-label writer. The publisher and the
 *   control surface both add and remove labels through here, so the wire shape
 *   is decided once.
 *
 *   Labels are keyed by NAME. The T6 probe against live Forgejo 16
 *   (forge.example.internal, 2026-09-23) proved Forgejo accepts a name AND a numeric
 *   id on both `POST /issues/{n}/labels` and `DELETE /issues/{n}/labels/{x}`;
 *   GitHub accepts names only. Name is therefore the keying both hosts take,
 *   and it needs no label-id lookup first.
 *
 *   Two Forgejo behaviors the callers must know: a POST naming a label the
 *   repository does not define returns 200 and silently drops it (so an add is
 *   proven only by the returned set), and a DELETE naming one returns 422
 *   "label does not exist" where GitHub returns 404.
 *
 * @outputs
 *   - `addIssueLabels` -- one batch POST of label names; returns the response body
 *   - `removeIssueLabel` -- one DELETE of one percent-encoded label name
 *   - `isAbsentLabelError` -- true for the 404/422 a removal of an absent label raises
 *
 * @dependencies
 *   - ./boundary -- the reviewed transport client
 *   - ../log -- traced()
 */
import { traced } from "../log";
import type { ForgeClient } from "./boundary";

/** Add label names to an issue/PR in one batch POST; the body is the host's label set. */
export const addIssueLabels = traced(
	"forge.addIssueLabels",
	async function addIssueLabels(
		client: ForgeClient,
		repository: string,
		item: number,
		names: readonly string[],
	): Promise<unknown> {
		const res = await client.write<unknown>("POST", `/repos/${repository}/issues/${item}/labels`, {
			labels: [...names],
		});
		return res.data;
	},
	{ redact: { args: [0] } },
);

/**
 * Remove ONE label by name. Both hosts take one label per DELETE. The name is
 * percent-encoded because a label may contain a path-structural character.
 */
export const removeIssueLabel = traced(
	"forge.removeIssueLabel",
	async function removeIssueLabel(
		client: ForgeClient,
		repository: string,
		item: number,
		name: string,
	): Promise<void> {
		await client.write(
			"DELETE",
			`/repos/${repository}/issues/${item}/labels/${encodeURIComponent(name)}`,
		);
	},
	{ redact: { args: [0] } },
);

/**
 * The error a removal of an absent label raises: GitHub 404, Forgejo 422 whose
 * body says "label does not exist". Any other 422 is a real refusal.
 */
export const isAbsentLabelError = traced(
	"forge.isAbsentLabelError",
	function isAbsentLabelError(error: unknown): boolean {
		return (
			error instanceof Error && /HTTP 404\b|HTTP 422: label does not exist$/.test(error.message)
		);
	},
);
