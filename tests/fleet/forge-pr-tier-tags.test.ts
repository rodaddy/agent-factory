/**
 * @module tests/fleet/forge-pr-tier-tags
 * @description forge-pr puts the repo's tier-N label on the Review, Merge and
 *   Rework tasks it files, and an hourly job keeps it current (queue
 *   contract).
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";
import { retagTiers, tierLabelIds, tierTaskRepo } from "../../fleet/plugins/forge-pr/tier-tags.js";

const SECRET = "s3cret";
const SHA = "b".repeat(40);
const LABELS = { "tier-1": "L1", "tier-2": "L2", "tier-3": "L3", "tier-4": "L4", "tier-5": "L5" };
const sign = (raw: string) =>
	`sha256=${crypto.createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});
// Forge answers every topics read with these topics for the worker under test.
// The preflight's PR files read gets a 404, so the preflight is skipped (its
// own tests live in forge-pr-preflight) and these tests stay on the tier label.
function forgeTopics(topics: string[]) {
	globalThis.fetch = (async (url: string | URL) =>
		String(url).includes("/files")
			? new Response("not found", { status: 404 })
			: Response.json({ topics })) as unknown as typeof fetch;
}

type Job = () => Promise<void>;
async function worker(repo: string, cfg: Record<string, unknown>, board: unknown[] = []) {
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
	const logs: string[] = [];
	const jobs = new Map<string, Job>();
	const ctx = {
		companies: { list: async () => [{ id: "co-tier" }] },
		config: {
			get: async () => ({
				repos: [repo],
				webhookSecret: "ref",
				forgeToken: "ref",
				reviewerAgentId: "dispatcher",
				triageAgentId: "tri",
				...cfg,
			}),
		},
		secrets: { resolve: async () => SECRET },
		agents: { list: async () => [] },
		// A repo task is filed only into its project.
		projects: { list: async () => [{ id: "proj", name: repo }] },
		issues: {
			// As the installed host answers (2026.916.1): the SDK client drops `q`;
			// status is a comma list; limit/offset window the rows in SQL and then
			// again in plugin-host-services applyWindow.
			list: async (q: { q?: string; status?: string; limit?: number; offset?: number }) => {
				const want = q.status?.split(",");
				const win = (rows: unknown[]) => {
					const from = q.offset ?? 0;
					return rows.slice(from, q.limit === undefined ? undefined : from + q.limit);
				};
				return win(
					win(
						(board as Array<{ status?: string }>).filter(
							(i) => !want || want.includes(i.status ?? ""),
						),
					),
				);
			},
			create: async (t: Record<string, unknown>) => {
				created.push(t);
				return { id: `new-${created.length}` };
			},
			update: async (id: string, patch: unknown) => {
				updates.push([id, patch]);
				return { id };
			},
		},
		state: {
			get: async (k: { stateKey: string }) =>
				k.stateKey.startsWith("settle:") ? { sha: SHA, at: 0 } : null,
			set: async () => {},
		},
		jobs: { register: (key: string, fn: Job) => void jobs.set(key, fn) },
		events: { on: () => {} },
		logger: {
			info: (m: string) => void logs.push(m),
			warn: (m: string) => void logs.push(m),
		},
	};
	await mod.default.setup(ctx);
	const review = async () => {
		const raw = JSON.stringify({
			action: "opened",
			number: 41,
			repository: { full_name: repo },
			pull_request: {
				head: { sha: SHA },
				html_url: `https://forge.example.internal/${repo}/pulls/41`,
				title: "Add thing",
				user: { login: "operator" },
			},
		});
		await mod.default.onWebhook({
			endpointKey: "forge",
			headers: { "x-forgejo-event": "pull_request", "x-hub-signature-256": sign(raw) },
			rawBody: raw,
		});
	};
	return { created, updates, logs, jobs, review };
}

describe("forge-pr files its tasks with the repo's tier label", () => {
	test("a new Review task carries the repo's tier label", async () => {
		forgeTopics(["tier-2"]);
		const w = await worker("rodaddy/tier-two", { tierLabels: LABELS });
		await w.review();
		expect(w.created.map((t) => [t.title, t.labelIds])).toEqual([
			[`Review rodaddy/tier-two#41 @ ${SHA.slice(0, 7)}`, ["L2"]],
		]);
	});
	test("tierLabels reads tier-0 through tier-5 (tier-0 is infra, the operator 2026-10-07)", () => {
		const ids = tierLabelIds({ "tier-0": "L0", ...LABELS });
		expect(ids?.get(0)).toBe("L0");
		expect(ids?.get(5)).toBe("L5");
		expect(tierLabelIds({ "tier-6": "L6" })).toBeNull();
	});
	test("a Merge and a Rework title name their repo; a Triage title does not", () => {
		expect(tierTaskRepo("Merge rodaddy/demo#6 @ def5678")).toBe("rodaddy/demo");
		expect(tierTaskRepo("Rework rodaddy/demo#6: review round limit")).toBe("rodaddy/demo");
		expect(tierTaskRepo("Triage rodaddy/demo#6")).toBeNull();
	});
	test("no tierLabels config: no labelIds on create, the re-tag job writes nothing, one log line", async () => {
		forgeTopics(["tier-1"]);
		const board = [
			{ id: "m1", title: "Merge rodaddy/tier-none#3 @ 1234567", status: "todo", labelIds: [] },
		];
		const w = await worker("rodaddy/tier-none", {}, board);
		await w.review();
		await w.jobs.get("tier-retag")?.();
		await w.jobs.get("tier-retag")?.();
		expect(w.created.length).toBe(1);
		expect("labelIds" in (w.created[0] ?? {})).toBe(false);
		expect(w.updates).toEqual([]);
		expect(w.logs.filter((l) => l.includes("tier labels off")).length).toBe(1);
	});
});

describe("the hourly re-tag job", () => {
	const merge = {
		id: "m1",
		identifier: "SOF-9",
		title: "Merge rodaddy/tier-retag#3 @ 1234567",
		status: "todo",
		labelIds: ["P", "L4"],
	};
	test("replaces a stale tier label on a Merge task and keeps priority", async () => {
		forgeTopics(["tier-1"]);
		const done = { ...merge, id: "m2", status: "done" };
		const current = {
			...merge,
			id: "m3",
			title: "Review rodaddy/tier-retag#4 @ 7654321",
			labelIds: ["L1"],
		};
		const w = await worker("rodaddy/tier-retag", { tierLabels: LABELS }, [merge, done, current]);
		await w.jobs.get("tier-retag")?.();
		expect(w.updates).toEqual([["m1", { labelIds: ["P", "L1"] }]]);
		expect(w.logs.filter((l) => l.includes("tier retag SOF-9"))).toHaveLength(1);
	});
	test("finds a task behind more than 100 newer board issues (the host ignores q)", async () => {
		forgeTopics(["tier-1"]);
		const newer = Array.from({ length: 120 }, (_, i) => ({
			id: `n${i}`,
			title: `Chore ${i}`,
			status: "todo",
			labelIds: [],
		}));
		const w = await worker("rodaddy/tier-retag", { tierLabels: LABELS }, [...newer, merge]);
		await w.jobs.get("tier-retag")?.();
		expect(w.updates).toEqual([["m1", { labelIds: ["P", "L1"] }]]);
	});
	test("no ids: the re-tag writes nothing", async () => {
		const updates: unknown[] = [];
		const n = await retagTiers({
			repos: ["o/r"],
			ids: null,
			repoTier: async () => 1,
			listOpen: async () => [{ ...merge, title: "Merge o/r#3 @ 1234567" }],
			update: async (id: string) => void updates.push(id),
			log: () => {},
		});
		expect([n, updates]).toEqual([0, []]);
	});
	test("a failed tier read leaves the repo's tasks alone", async () => {
		const updates: unknown[] = [];
		const n = await retagTiers({
			repos: ["o/r"],
			ids: tierLabelIds(LABELS),
			repoTier: async () => null,
			listOpen: async () => [{ ...merge, title: "Merge o/r#3 @ 1234567" }],
			update: async (id: string, ids: string[]) => void updates.push([id, ids]),
			log: () => {},
		});
		expect([n, updates]).toEqual([0, []]);
	});
	test("at most 50 updates per run", async () => {
		const many = Array.from({ length: 60 }, (_, i) => ({
			...merge,
			id: `m${i}`,
			title: `Review o/r#${i} @ 1234567`,
		}));
		const updates: unknown[] = [];
		const n = await retagTiers({
			repos: ["o/r"],
			ids: tierLabelIds(LABELS),
			repoTier: async () => 2,
			listOpen: async () => many,
			update: async (id: string) => void updates.push(id),
			log: () => {},
		});
		expect([n, updates.length]).toEqual([50, 50]);
	});
});
