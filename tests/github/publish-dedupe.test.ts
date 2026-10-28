import { describe, expect, test } from "bun:test";
import type { ForgeClient } from "../../src/forge/boundary";
import { findMarkedIssue } from "../../src/github/publish-dedupe";
import { raiseCriticalAlert } from "../../src/observability/critical-alert";

/**
 * sf#811: Forgejo returns `pull_request: null` on EVERY issue from `/issues`.
 * Only a non-null `pull_request` object marks a PR; null and absent both mean
 * "an issue" whose body must be scanned for the marker.
 */
const KEY = "sf-audit:abc123";
const MARKER = `<!-- ${KEY} -->`;

function fakeForgejo(page: unknown[]): ForgeClient {
	return {
		provider: "forgejo",
		async getPage<T>(): Promise<{ body: T; next: string | null }> {
			return { body: page as unknown as T, next: null };
		},
	} as unknown as ForgeClient;
}

/** A forge that honors `state=open` by dropping closed issues, recording each path. */
function stateAwareForge(issues: Array<{ number: number; body: string; state: string }>): {
	client: ForgeClient;
	paths: string[];
} {
	const paths: string[] = [];
	const client = {
		provider: "forgejo",
		async getPage<T>(path: string): Promise<{ body: T; next: string | null }> {
			paths.push(path);
			const open = path.includes("state=open");
			const body = issues.filter((i) => !open || i.state === "open");
			return { body: body as unknown as T, next: null };
		},
	} as unknown as ForgeClient;
	return { client, paths };
}

describe("critical-alert dedupe scope", () => {
	/** Open an alert for `cls`, then close its issue: the operator handled it. */
	async function closedIncident(cls: string) {
		const issues: Array<{ number: number; body: string; state: string }> = [];
		const forge = stateAwareForge(issues);
		const client = Object.assign(forge.client, {
			write: async (_m: string, _p: string, body?: unknown) => {
				const n = issues.length + 1;
				issues.push({ number: n, body: (body as { body: string }).body, state: "open" });
				return { status: 201, data: { number: n }, link: null, rateRemaining: null };
			},
		});
		const target = { repository: "rodaddy/software-factory", client: async () => client };
		await raiseCriticalAlert(target, { alertClass: cls, cause: "first" });
		for (const i of issues) i.state = "closed";
		return { target, issues };
	}

	test("a postings-absence class with only a CLOSED marked issue opens a new issue", async () => {
		const cls = "postings-absence:pr-review";
		const { target, issues } = await closedIncident(cls);
		const delivery = await raiseCriticalAlert(target, { alertClass: cls, cause: "second" });
		expect(delivery).toEqual({ delivered: true, how: "opened" });
		expect(issues).toHaveLength(2);
	});

	test("another class with a CLOSED marked issue dedupes onto it as before", async () => {
		const cls = "build-bump:x";
		const { target, issues } = await closedIncident(cls);
		const delivery = await raiseCriticalAlert(target, { alertClass: cls, cause: "second" });
		expect(delivery).toEqual({ delivered: true, how: "deduped" });
		expect(issues).toHaveLength(1);
	});

	test("findMarkedIssue openOnly asks for state=open; the default asks for state=all", async () => {
		const forge = stateAwareForge([]);
		await findMarkedIssue(forge.client, "o/r", KEY, { openOnly: true });
		await findMarkedIssue(forge.client, "o/r", KEY);
		expect(forge.paths[0]).toContain("state=open");
		expect(forge.paths[1]).toContain("state=all");
	});
});

describe("findMarkedIssue pull_request predicate", () => {
	test("an issue with pull_request: null whose body carries the marker is found", async () => {
		const client = fakeForgejo([{ number: 42, body: `${MARKER}\nfinding`, pull_request: null }]);
		expect(await findMarkedIssue(client, "rodaddy/software-factory", KEY)).toEqual({
			status: "found",
			id: 42,
		});
	});

	test("an entry with a non-null pull_request object is still skipped", async () => {
		const client = fakeForgejo([
			{
				number: 7,
				body: MARKER,
				pull_request: { url: "https://forge.example.internal/x/y/pulls/7" },
			},
		]);
		expect(await findMarkedIssue(client, "rodaddy/software-factory", KEY)).toEqual({
			status: "absent",
		});
	});

	test("an issue with pull_request: null and no marker is absent", async () => {
		const client = fakeForgejo([{ number: 9, body: "unrelated", pull_request: null }]);
		expect(await findMarkedIssue(client, "rodaddy/software-factory", KEY)).toEqual({
			status: "absent",
		});
	});
});
