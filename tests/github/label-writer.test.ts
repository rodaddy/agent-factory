import { describe, expect, test } from "bun:test";
import { createGitHubControlSurface } from "../../src/control-surface";
import type { ForgeClient, ForgeResponse } from "../../src/forge/boundary";
import { addIssueLabels, isAbsentLabelError, removeIssueLabel } from "../../src/forge/labels";
import { publishLabel } from "../../src/github/publish-writers";

/**
 * sf#816: ONE label writer, keyed by NAME. The fixtures are the recorded live
 * Forgejo 16 responses from the T6 probe (forge.example.internal, scratch issue #842,
 * 2026-09-23): POST `{"labels":["bug"]}` -> 200 with the label set, DELETE
 * `/labels/bug` -> 204, and DELETE of a name the repo does not define -> 422
 * "label does not exist". GitHub accepts names only, so name is the one keying
 * both hosts take.
 */
const PROBE_POST_BY_NAME = [
	{
		id: 229,
		name: "bug",
		exclusive: false,
		is_archived: false,
		color: "d73a4a",
		description: "Something isn't working",
		url: "https://forge.example.internal/api/v1/repos/rodaddy/software-factory/labels/229",
	},
];

type Write = { method: string; path: string; body?: unknown };

/** A client that answers like the probed Forgejo and records every call. */
function probedForgejo(opts: { unknownLabels?: string[] } = {}): {
	client: ForgeClient;
	writes: Write[];
	reads: string[];
} {
	const writes: Write[] = [];
	const reads: string[] = [];
	const unknown = new Set(opts.unknownLabels ?? []);
	const ok = <T>(status: number, data: unknown): ForgeResponse<T> => ({
		status,
		data: data as T,
		link: null,
		rateRemaining: null,
	});
	const client = {
		provider: "forgejo",
		get: async (path: string) => {
			reads.push(path);
			return ok(200, {});
		},
		getPage: async (path: string) => {
			reads.push(path);
			return { body: [], next: null };
		},
		paginate: async () => [],
		write: async (method: string, path: string, body?: unknown) => {
			writes.push({ method, path, body });
			if (method === "POST") {
				const names = (body as { labels: string[] }).labels;
				return ok(
					200,
					names.filter((n) => !unknown.has(n)).map((n) => ({ ...PROBE_POST_BY_NAME[0], name: n })),
				);
			}
			const name = decodeURIComponent(path.split("/labels/")[1] ?? "");
			if (unknown.has(name))
				throw new Error("Forgejo request failed: HTTP 422: label does not exist");
			return ok(204, null);
		},
		postCommitCheck: async () => undefined,
		findCommitCheck: async () => ({ status: "absent" }),
	} as unknown as ForgeClient;
	return { client, writes, reads };
}

const TARGET = {
	provider: "forgejo" as const,
	repository: "rodaddy/software-factory",
	itemNumber: 842,
	sha: "a".repeat(40),
	jobType: "pr-review",
	itemKind: "pull",
	itemState: "open",
	itemHeadSha: "a".repeat(40),
};

function ctx(client: ForgeClient) {
	return { client, shadow: false, recordShadow: async () => ({ status: "posted" as const }) };
}

describe("forge/labels — the one label writer", () => {
	test("adds by NAME in one batch POST, returning the probed label set", async () => {
		const { client, writes } = probedForgejo();
		const data = await addIssueLabels(client, "rodaddy/software-factory", 842, ["bug"]);
		expect(writes).toEqual([
			{
				method: "POST",
				path: "/repos/rodaddy/software-factory/issues/842/labels",
				body: { labels: ["bug"] },
			},
		]);
		expect(data).toEqual(PROBE_POST_BY_NAME);
	});

	test("removes one label by percent-encoded NAME", async () => {
		const { client, writes } = probedForgejo();
		await removeIssueLabel(client, "rodaddy/software-factory", 842, "redeploy:app/x");
		expect(writes).toEqual([
			{
				method: "DELETE",
				path: "/repos/rodaddy/software-factory/issues/842/labels/redeploy%3Aapp%2Fx",
				body: undefined,
			},
		]);
	});

	test("classifies 404 (GitHub) and 422 (Forgejo unknown label) as an absent label", () => {
		expect(isAbsentLabelError(new Error("GitHub API DELETE failed: HTTP 404"))).toBe(true);
		expect(
			isAbsentLabelError(new Error("Forgejo request failed: HTTP 422: label does not exist")),
		).toBe(true);
		// sf#851: a 422 for any OTHER reason is a real refusal, not an absent label.
		expect(isAbsentLabelError(new Error("Forgejo request failed: HTTP 422"))).toBe(false);
		expect(isAbsentLabelError(new Error("Forgejo request failed: HTTP 500"))).toBe(false);
		expect(isAbsentLabelError("HTTP 404")).toBe(false);
	});
});

describe("both call sites write the same wire shape", () => {
	test("publisher adds on Forgejo by NAME with no label-id lookup", async () => {
		const { client, writes, reads } = probedForgejo();
		const outcome = await publishLabel(
			ctx(client),
			{ kind: "label", action: "add", target: "bug", label: "bug", itemNumber: 842 },
			TARGET,
		);
		expect(outcome).toEqual({ status: "posted" });
		expect(reads).toEqual([]);
		expect(writes).toEqual([
			{
				method: "POST",
				path: "/repos/rodaddy/software-factory/issues/842/labels",
				body: { labels: ["bug"] },
			},
		]);
	});

	test("publisher add of a label the repo lacks fails retryably (Forgejo drops it silently)", async () => {
		const { client } = probedForgejo({ unknownLabels: ["watcher:skipped"] });
		const outcome = await publishLabel(
			ctx(client),
			{
				kind: "label",
				action: "add",
				target: "watcher:skipped",
				label: "watcher:skipped",
				itemNumber: 842,
			},
			TARGET,
		);
		expect(outcome).toEqual({
			status: "failed",
			reason: "add-label response did not confirm the label",
		});
	});

	test("publisher removes on Forgejo by NAME; a repo-unknown label (422) is a posted no-op", async () => {
		const { client, writes } = probedForgejo({ unknownLabels: ["watcher:skipped"] });
		const outcome = await publishLabel(
			ctx(client),
			{
				kind: "label",
				action: "remove",
				target: "watcher:skipped",
				label: "watcher:skipped",
				itemNumber: 842,
			},
			TARGET,
		);
		expect(outcome).toEqual({ status: "posted" });
		expect(writes).toEqual([
			{
				method: "DELETE",
				path: "/repos/rodaddy/software-factory/issues/842/labels/watcher%3Askipped",
				body: undefined,
			},
		]);
	});

	test("control surface sends the identical add and remove shape", async () => {
		const { client, writes } = probedForgejo();
		const surface = createGitHubControlSurface({ client, apply: true });
		const result = await surface.proposeLabelWrite({
			repository: "rodaddy/software-factory",
			item: 842,
			addLabels: ["bug"],
			removeLabels: ["redeploy:app/x"],
		});
		expect(result.applied).toBe(true);
		expect(writes).toEqual([
			{
				method: "DELETE",
				path: "/repos/rodaddy/software-factory/issues/842/labels/redeploy%3Aapp%2Fx",
				body: undefined,
			},
			{
				method: "POST",
				path: "/repos/rodaddy/software-factory/issues/842/labels",
				body: { labels: ["bug"] },
			},
		]);
	});
});
