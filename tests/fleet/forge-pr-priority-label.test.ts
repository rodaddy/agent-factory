/**
 * @module tests/fleet/forge-pr-priority-label
 * @description A Forge PR labelled exactly `priority` puts the board `priority`
 *   label on its open Review, Merge and Rework tasks; the label leaving the PR
 *   takes it off them. Other labels (tier labels included) are kept.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";

const SECRET = "s3cret";
const SHA = "c".repeat(40);
const REPO = "rodaddy/prio";
const LABELS = { "tier-2": "L2", priority: "P" };
const sign = (raw: string) =>
	`sha256=${crypto.createHmac("sha256", SECRET).update(raw, "utf8").digest("hex")}`;

const realFetch = globalThis.fetch;
afterEach(() => {
	globalThis.fetch = realFetch;
});

type Pr = { number: number; labels: string[]; state?: string };
const prJson = (p: Pr) => ({
	number: p.number,
	state: p.state ?? "open",
	repository: { full_name: REPO },
	updated_at: "2026-10-07T00:00:00Z",
	head: { sha: SHA },
	html_url: `https://forge.example.internal/${REPO}/pulls/${p.number}`,
	title: "Thing",
	user: { login: "rico" },
	labels: p.labels.map((name) => ({ name })),
});

// Forge: the open-PR search answers the open PRs; topics answer tier-2.
function forge(prs: Pr[]) {
	const open = prs.filter((p) => (p.state ?? "open") === "open");
	globalThis.fetch = (async (url: string) => {
		const u = String(url);
		if (u.includes("/topics")) return Response.json({ topics: ["tier-2"] });
		if (u.includes("type=pulls"))
			return Response.json(u.includes("page=1") ? open.map(prJson) : []);
		if (u.includes("/issues/search")) return Response.json([]);
		const m = /\/pulls\/(\d+)$/.exec(u);
		const hit = m && prs.find((p) => p.number === Number(m[1]));
		return hit ? Response.json(prJson(hit)) : Response.json({}, { status: 404 });
	}) as unknown as typeof fetch;
}

type Job = () => Promise<void>;
type Task = { id: string; title: string; status: string; labelIds?: string[] };
async function worker(
	cfg: Record<string, unknown>,
	board: Task[],
	state: Record<string, unknown>,
	failComment = false,
) {
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
	const queries: Array<Record<string, unknown>> = [];
	const comments: string[] = [];
	const jobs = new Map<string, Job>();
	const store = new Map(Object.entries(state));
	const ctx = {
		companies: { list: async () => [{ id: "co-prio" }] },
		config: {
			get: async () => ({
				repos: [REPO],
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
		projects: { list: async () => [{ id: "proj", name: REPO }] },
		issues: {
			// As the installed host answers (2026.916.1): the SDK client drops `q`;
			// status is a comma list; limit/offset window the rows in SQL and then
			// again in plugin-host-services applyWindow.
			list: async (q: { status?: string; limit?: number; offset?: number }) => {
				queries.push(q);
				const want = q.status?.split(",");
				const win = (rows: Task[]) => {
					const from = q.offset ?? 0;
					return rows.slice(from, q.limit === undefined ? undefined : from + q.limit);
				};
				return win(win(board.filter((i) => !want || want.includes(i.status))));
			},
			create: async (t: Record<string, unknown>) => {
				created.push(t);
				return { id: `new-${created.length}` };
			},
			update: async (id: string, patch: unknown) => {
				updates.push([id, patch]);
				return { id };
			},
			createComment: async (id: string) => {
				comments.push(id);
				if (failComment) throw new TypeError("comment unavailable");
			},
		},
		state: {
			get: async (k: { stateKey: string }) =>
				k.stateKey.startsWith("settle:") ? { sha: SHA, at: 0 } : (store.get(k.stateKey) ?? null),
			set: async (k: { stateKey: string }, v: unknown) => void store.set(k.stateKey, v),
		},
		jobs: { register: (key: string, fn: Job) => void jobs.set(key, fn) },
		events: { on: () => {} },
		logger: {
			info: (m: string) => void logs.push(m),
			warn: (m: string) => void logs.push(m),
		},
	};
	await mod.default.setup(ctx);
	const sweep = async () => jobs.get("forge-sweep")?.();
	const labelEvent = async (p: Pr) => {
		const raw = JSON.stringify({
			action: "label_updated",
			number: p.number,
			repository: { full_name: REPO },
			pull_request: prJson(p),
		});
		await mod.default.onWebhook({
			endpointKey: "forge",
			headers: { "x-forgejo-event": "pull_request", "x-hub-signature-256": sign(raw) },
			rawBody: raw,
		});
	};
	return { created, updates, logs, queries, comments, sweep, labelEvent };
}

const reviewed = {
	[`${REPO}#41@${SHA}`]: { issueId: "old" },
	[`${REPO}#43@${SHA}`]: { issueId: "o" },
};
const task = (id: string, title: string, labelIds?: string[]): Task => ({
	id,
	title,
	status: "todo",
	...(labelIds ? { labelIds } : {}),
});

describe("the PR priority label reaches the board tasks", () => {
	test("PR label added: its Review and Merge tasks get priority, the tier label is kept", async () => {
		forge([
			{ number: 41, labels: ["priority"] },
			{ number: 43, labels: ["priority-x"] },
		]);
		const board = [
			task("r41", `Review ${REPO}#41 @ ${SHA.slice(0, 7)}`, ["L2"]),
			task("m41", `Merge ${REPO}#41 @ ${SHA.slice(0, 7)}`, ["L2"]),
			task("r410", `Review ${REPO}#410 @ ${SHA.slice(0, 7)}`, ["L2"]),
			task("r43", `Review ${REPO}#43 @ ${SHA.slice(0, 7)}`, ["L2"]),
		];
		const w = await worker({ tierLabels: LABELS }, board, reviewed);
		await w.sweep();
		expect(w.updates).toEqual([
			["r41", { labelIds: ["L2", "P"] }],
			["m41", { labelIds: ["L2", "P"] }],
		]);
		expect(w.logs.filter((l) => l.includes("priority label"))).toHaveLength(2);
	});

	test("PR label removed: priority comes off its tasks, the tier label stays", async () => {
		forge([{ number: 41, labels: [] }]);
		const board = [task("r41", `Review ${REPO}#41 @ ${SHA.slice(0, 7)}`, ["P", "L2"])];
		const w = await worker({ tierLabels: LABELS }, board, {
			...reviewed,
			[`prio:${REPO}#41`]: { on: true },
		});
		await w.sweep();
		expect(w.updates).toEqual([["r41", { labelIds: ["L2"] }]]);
		// Off and recorded: the next tick does not list or write again.
		await w.sweep();
		expect(w.updates).toHaveLength(1);
	});

	test("finds a task behind more than 100 newer board issues (the host ignores q)", async () => {
		forge([{ number: 41, labels: ["priority"] }]);
		const newer = Array.from({ length: 120 }, (_, i) => task(`n${i}`, `Chore ${i}`, []));
		const board = [...newer, task("m41", `Merge ${REPO}#41 @ ${SHA.slice(0, 7)}`, ["L2"])];
		const w = await worker({ tierLabels: LABELS }, board, reviewed);
		await w.sweep();
		expect(w.updates).toEqual([["m41", { labelIds: ["L2", "P"] }]]);
	});

	test("a Review task created while the PR carries the label is created with it", async () => {
		forge([{ number: 41, labels: ["priority"] }]);
		const w = await worker({ tierLabels: LABELS }, [], {});
		await w.sweep();
		expect(w.created.map((t) => [t.title, t.labelIds])).toEqual([
			[`Review ${REPO}#41 @ ${SHA.slice(0, 7)}`, ["L2", "P"]],
		]);
	});

	test("no priority id in tierLabels: no writes, one log line per setup", async () => {
		forge([{ number: 41, labels: ["priority"] }]);
		const board = [task("r41", `Review ${REPO}#41 @ ${SHA.slice(0, 7)}`, ["L2"])];
		const w = await worker({ tierLabels: { "tier-2": "L2" } }, board, reviewed);
		await w.sweep();
		await w.sweep();
		expect(w.updates).toEqual([]);
		expect(w.logs.filter((l) => l.includes("priority label off"))).toHaveLength(1);
	});

	test("a task the board lists without labelIds is skipped", async () => {
		forge([{ number: 41, labels: ["priority"] }]);
		const board = [
			task("r41", `Review ${REPO}#41 @ ${SHA.slice(0, 7)}`),
			task("w41", `Rework ${REPO}#41: review round limit`, []),
		];
		const w = await worker({ tierLabels: LABELS }, board, reviewed);
		await w.sweep();
		expect(w.updates).toEqual([["w41", { labelIds: ["P"] }]]);
	});

	test("a closed PR is settled without changing its priority labels", async () => {
		const closed = { number: 41, labels: [], state: "closed" };
		forge([closed]);
		const board = [task("r41", `Review ${REPO}#41 @ ${SHA.slice(0, 7)}`, ["P", "L2"])];
		const w = await worker({ tierLabels: LABELS }, board, { [`prio:${REPO}#41`]: { on: true } });
		await w.sweep();
		await w.labelEvent(closed);
		expect(w.updates).toEqual([["r41", { status: "cancelled" }]]);
	});

	test("a label event on an open PR syncs it at once", async () => {
		forge([]);
		const board = [task("r41", `Review ${REPO}#41 @ ${SHA.slice(0, 7)}`, ["L2"])];
		const w = await worker({ tierLabels: LABELS }, board, {});
		await w.labelEvent({ number: 41, labels: ["priority"] });
		expect(w.updates).toEqual([["r41", { labelIds: ["L2", "P"] }]]);
	});
});

// Mutations verified: restore windowed listing, bypass boardCancel, remove the
// comment catch. Each makes its corresponding settlement regression fail.
describe("worker sweep settlement", () => {
	test("one unwindowed read settles a Review beyond row 100, deduped by id", async () => {
		forge([{ number: 41, labels: [], state: "closed" }]);
		const newer = Array.from({ length: 120 }, (_, i) => task(`n${i}`, `Chore ${i}`));
		const review = task("r41", `Review ${REPO}#41 @ ${SHA.slice(0, 7)}`);
		const w = await worker({}, [...newer, review, review], {});
		await w.sweep();
		expect(w.queries).toEqual([
			{ companyId: "co-prio", status: "backlog,todo,in_progress,in_review,blocked" },
		]);
		expect(w.updates).toEqual([["r41", { status: "cancelled" }]]);
	});
	test("cancel uses the board PATCH with a key and SDK fallback without it", async () => {
		const board = [task("r41", `Review ${REPO}#41 @ ${SHA.slice(0, 7)}`)];
		forge([{ number: 41, labels: [], state: "closed" }]);
		const forgeFetch = globalThis.fetch;
		const patches: Array<[string, string | undefined, unknown]> = [];
		globalThis.fetch = (async (url, init) => {
			if (String(url).includes("/api/issues/")) {
				patches.push([new URL(String(url)).pathname, init?.method, JSON.parse(String(init?.body))]);
				return Response.json({});
			}
			return forgeFetch(url, init);
		}) as typeof fetch;
		const keyed = await worker({ boardApiKey: "ref" }, board, {});
		await keyed.sweep();
		expect(patches).toEqual([["/api/issues/r41", "PATCH", { status: "cancelled" }]]);
		expect(keyed.updates).toEqual([]);
		const fallback = await worker({}, board, {});
		await fallback.sweep();
		expect(fallback.updates).toEqual([["r41", { status: "cancelled" }]]);
		expect(patches).toHaveLength(1);
	});
	test("a comment failure warns and still settles the next task", async () => {
		forge([{ number: 41, labels: [], state: "closed" }]);
		const w = await worker(
			{},
			[
				task("r41", `Review ${REPO}#41 @ ${SHA.slice(0, 7)}`),
				task("m41", `Merge ${REPO}#41 @ ${SHA.slice(0, 7)}`),
			],
			{},
			true,
		);
		await w.sweep();
		expect(w.updates).toEqual([
			["r41", { status: "cancelled" }],
			["m41", { status: "cancelled" }],
		]);
		expect(w.comments).toEqual(["r41", "m41"]);
		expect(w.logs.filter((m) => m === "forge-pr: settle comment failed")).toHaveLength(2);
	});
});
