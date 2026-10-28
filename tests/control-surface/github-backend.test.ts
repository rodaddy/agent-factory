import { describe, expect, test } from "bun:test";
import { createGitHubControlSurface } from "../../src/control-surface";
import type { ForgeClient } from "../../src/forge/boundary";

/** A ForgeClient recording the host-specific calls the backend makes. */
function makeClient(labels: Array<{ name?: unknown }> = []): {
	client: ForgeClient;
	writes: Array<{ method: string; path: string; body: unknown }>;
} {
	const writes: Array<{ method: string; path: string; body: unknown }> = [];
	const client = {
		get: async () => ({ status: 200, data: { labels }, link: null, rateRemaining: null }),
		getPage: async () => ({ body: [], next: null }),
		paginate: async () => [],
		write: async (method: string, path: string, body?: unknown) => {
			writes.push({ method, path, body });
			return { status: 200, data: {}, link: null, rateRemaining: null };
		},
		postCommitCheck: async () => undefined,
		findCommitCheck: async () => ({ outcome: "absent" }),
		provider: "github",
	} as unknown as ForgeClient;
	return { client, writes };
}

const REF = { repository: "rodaddy/software-factory", item: 253 };

describe("createGitHubControlSurface — readLabels", () => {
	test("returns the item's label names from a semantic ref alone", async () => {
		const { client } = makeClient([{ name: "factory-implement" }, { name: "priority:p1" }]);
		const surface = createGitHubControlSurface({ client });
		// The caller supplies no URL, no verb, and no GraphQL document.
		expect(await surface.readLabels(REF)).toEqual(["factory-implement", "priority:p1"]);
	});

	test("drops malformed label entries rather than emitting empty names", async () => {
		const { client } = makeClient([{ name: "ok" }, { name: 42 }, {}]);
		const surface = createGitHubControlSurface({ client });
		expect(await surface.readLabels(REF)).toEqual(["ok"]);
	});

	test("returns no labels for a repository string that is not owner/repo", async () => {
		const { client } = makeClient([{ name: "factory-implement" }]);
		const surface = createGitHubControlSurface({ client });
		expect(await surface.readLabels({ repository: "not-a-repo", item: 1 })).toEqual([]);
	});
});

describe("createGitHubControlSurface — readColumn", () => {
	test("fails soft to null when no project reader is wired", async () => {
		const { client } = makeClient();
		const surface = createGitHubControlSurface({ client });
		// A missing board must never crash a pass whose subject is the labels.
		expect(await surface.readColumn(REF)).toBeNull();
	});

	test("returns the column name the injected project reader answers", async () => {
		const { client } = makeClient();
		const surface = createGitHubControlSurface({
			client,
			readProjectColumn: async () => "In Progress",
		});
		expect(await surface.readColumn(REF)).toBe("In Progress");
	});

	test("passes only the semantic ref to the project reader", async () => {
		const { client } = makeClient();
		const seen: unknown[] = [];
		const surface = createGitHubControlSurface({
			client,
			readProjectColumn: async (ref) => {
				seen.push(ref);
				return null;
			},
		});
		await surface.readColumn(REF);
		expect(seen[0]).toEqual(REF);
	});
});

describe("createGitHubControlSurface — proposeLabelWrite", () => {
	test("records intent and mutates nothing by default", async () => {
		const { client, writes } = makeClient();
		const surface = createGitHubControlSurface({ client });
		const result = await surface.proposeLabelWrite({ ...REF, addLabels: ["factory-triage"] });
		// apply defaults to FALSE: a backend that mutates unless told not to is one
		// forgotten argument away from writing during a dry run.
		expect(result.applied).toBe(false);
		expect(writes).toHaveLength(0);
		expect(result.intent).toContain("factory-triage");
	});

	test("writes only when apply is explicitly enabled", async () => {
		const { client, writes } = makeClient();
		const surface = createGitHubControlSurface({ client, apply: true });
		const result = await surface.proposeLabelWrite({ ...REF, addLabels: ["factory-triage"] });
		expect(result.applied).toBe(true);
		expect(writes).toHaveLength(1);
		expect(writes[0]?.method).toBe("POST");
	});

	test("reports a bounded error instead of throwing when a write fails", async () => {
		const client = {
			get: async () => ({ status: 200, data: {}, link: null, rateRemaining: null }),
			write: async () => {
				throw new Error("forge rejected the write");
			},
		} as unknown as ForgeClient;
		const surface = createGitHubControlSurface({ client, apply: true });
		const result = await surface.proposeLabelWrite({ ...REF, addLabels: ["x"] });
		expect(result.applied).toBe(false);
		expect(result.error).toContain("forge rejected");
	});

	test("treats an empty proposal as a no-op intent", async () => {
		const { client, writes } = makeClient();
		const surface = createGitHubControlSurface({ client, apply: true });
		const result = await surface.proposeLabelWrite(REF);
		expect(result.applied).toBe(false);
		expect(writes).toHaveLength(0);
		expect(result.intent).toContain("no-op");
	});
});
