/**
 * @module tests/fleet/forge-pr-board-lookup
 * @description sf#1850. The plugin SDK drops `issues.list` `q`, so forge-pr finds
 *   a PR's own tasks by the PR's origin (tasks filed since sf#1850) and by the
 *   repo's project (older tasks), never by an unfiltered first page. The fake
 *   host below answers as Paperclip 2026.916.1 does: `q` ignored, originKind,
 *   originId and projectId exact, limit/offset applied in SQL and again in
 *   plugin-host-services applyWindow.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";

const SECRET = "s3cret";
const SHA = "b".repeat(40);
const OLD7 = "1111111";
const REPO = "rodaddy/lookup";
const ORIGIN = "plugin:rodaddy.forge-pr";
const sign = (raw: string) =>
	`sha256=${crypto.createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

type Row = {
	id: string;
	title: string;
	status: string;
	projectId?: string | null;
	originKind?: string | null;
	originId?: string | null;
};
type ListQuery = {
	q?: string;
	projectId?: string;
	originKind?: string;
	originId?: string;
	status?: string;
	limit?: number;
	offset?: number;
};

// 120 newer company issues in another project, ahead of anything under test.
const newer: Row[] = Array.from({ length: 120 }, (_, i) => ({
	id: `n${i}`,
	title: `Chore ${i}`,
	status: "todo",
	projectId: "elsewhere",
}));

async function worker(board: Row[]) {
	globalThis.fetch = (async () =>
		new Response("not found", { status: 404 })) as unknown as typeof fetch;
	// Scheduling fixture: the protected host admits this task. Real receipt/refusal
	// behavior is exercised separately in review-round-ledger.test.ts.
	mock.module("../../fleet/plugins/forge-pr/review-admission-client.js", () => ({
		reviewAdmissionFor: () => async () => ({ action: "start" }),
	}));
	mock.module("@paperclipai/plugin-sdk", () => ({
		definePlugin: (p: unknown) => p,
		runWorker: () => {},
	}));
	const workerPath: string = "../../fleet/plugins/forge-pr/worker.js";
	const mod = (await import(workerPath)) as {
		default: {
			setup: (c: unknown) => Promise<void>;
			onWebhook: (i: unknown) => Promise<unknown>;
		};
	};
	const created: Array<Record<string, unknown>> = [];
	const updates: Array<[string, unknown]> = [];
	const ctx = {
		companies: { list: async () => [{ id: "co-lookup" }] },
		config: {
			get: async () => ({
				repos: [REPO],
				webhookSecret: "ref",
				forgeToken: "ref",
				reviewerAgentId: "dispatcher",
				triageAgentId: "tri",
			}),
		},
		secrets: { resolve: async () => SECRET },
		agents: { list: async () => [] },
		projects: { list: async () => [{ id: "proj", name: REPO }] },
		issues: {
			list: async (q: ListQuery) => {
				const win = (rows: Row[]) => {
					const from = q.offset ?? 0;
					return rows.slice(from, q.limit === undefined ? undefined : from + q.limit);
				};
				const rows = board.filter(
					(i) =>
						(!q.projectId || i.projectId === q.projectId) &&
						(!q.originKind || i.originKind === q.originKind) &&
						(!q.originId || i.originId === q.originId) &&
						// The host splits a comma list (issues.js parseStatusFilter).
						(!q.status || q.status.split(",").includes(i.status)),
				);
				return win(win(rows));
			},
			create: async (t: Record<string, unknown>) => {
				created.push(t);
				return { id: `new-${created.length}` };
			},
			update: async (id: string, patch: unknown) => {
				updates.push([id, patch]);
				return { id };
			},
			createComment: async () => ({}),
		},
		state: {
			get: async (k: { stateKey: string }) =>
				k.stateKey.startsWith("settle:") ? { sha: SHA, at: 0 } : null,
			set: async () => {},
		},
		jobs: { register: () => {} },
		events: { on: () => {} },
		logger: { info: () => {}, warn: () => {} },
	};
	await mod.default.setup(ctx);
	const review = async () => {
		const raw = JSON.stringify({
			action: "opened",
			number: 41,
			repository: { full_name: REPO },
			pull_request: {
				head: { sha: SHA },
				html_url: `https://forge.example.internal/${REPO}/pulls/41`,
				title: "Add thing",
				user: { login: "rico" },
			},
		});
		await mod.default.onWebhook({
			endpointKey: "forge",
			headers: { "x-forgejo-event": "pull_request", "x-hub-signature-256": sign(raw) },
			rawBody: raw,
		});
	};
	return { created, updates, review };
}

const oldReview = (over: Partial<Row>): Row => ({
	id: "old",
	title: `Review ${REPO}#41 @ ${OLD7}`,
	status: "todo",
	...over,
});

describe("forge-pr finds a PR's tasks without `q`", () => {
	test("a new head retires an older open review filed before the change (project, no origin)", async () => {
		const w = await worker([...newer, oldReview({ projectId: "proj" })]);
		await w.review();
		expect(w.updates).toEqual([["old", { status: "cancelled" }]]);
	});
	test("a new head retires an older open review found only by its origin", async () => {
		const w = await worker([
			...newer,
			oldReview({ projectId: "moved", originKind: ORIGIN, originId: `${REPO}#41` }),
		]);
		await w.review();
		expect(w.updates).toEqual([["old", { status: "cancelled" }]]);
	});
	test("an open review with neither project nor origin (filed before sf#1690) is still found", async () => {
		const w = await worker([...newer, oldReview({ status: "blocked", projectId: null })]);
		await w.review();
		expect(w.updates).toEqual([["old", { status: "cancelled" }]]);
	});
	test("another PR's review in the same project is left alone", async () => {
		const other = oldReview({ title: `Review ${REPO}#42 @ ${OLD7}`, projectId: "proj" });
		const w = await worker([...newer, other]);
		await w.review();
		expect(w.updates).toEqual([]);
	});
	test("a Review task is filed with the forge-pr origin and the PR as its origin id", async () => {
		const w = await worker([...newer]);
		await w.review();
		expect(w.created.map((t) => [t.title, t.originKind, t.originId])).toEqual([
			[`Review ${REPO}#41 @ ${SHA.slice(0, 7)}`, ORIGIN, `${REPO}#41`],
		]);
	});
});
