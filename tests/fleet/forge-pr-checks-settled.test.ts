// A head is reviewed the moment its checks finish (realtime): the
// pull_request webhook files a ready head in the same delivery, an Actions-run
// webhook files a waiting head when its run ends, and the 5-minute sweep is
// only the backstop. Driven through the real worker (onWebhook) with Forge and
// the board faked; nothing reaches the network.
import { describe, expect, mock, test } from "bun:test";
import crypto from "node:crypto";
import * as sweep from "../../fleet/plugins/forge-pr/sweep.js";
import { reviewPrOnce, runSweep } from "../../fleet/plugins/forge-pr/sweep.js";

// A literal, never the module's constant: a fixture sized from the constant measures itself.
const FALLBACK_MS = 2 * 60 * 1000;

import { prFromApi } from "../../fleet/plugins/forge-pr/logic.js";

const SECRET = "s3cret";
const REPO = "rodaddy/demo";
const BASE = "https://forge.example.internal/api/v1";
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const sign = (raw: string, secret = SECRET) =>
	`sha256=${crypto.createHmac("sha256", secret).update(raw, "utf8").digest("hex")}`;

const pr = (sha: string) => ({
	number: 7,
	state: "open",
	title: "Add thing",
	html_url: `https://forge.example.internal/${REPO}/pulls/7`,
	user: { login: "rico" },
	head: { sha },
});
const prBody = (action: string, sha: string) => ({
	action,
	number: 7,
	repository: { full_name: REPO },
	pull_request: pr(sha),
});
const status = (state: string, total = 3) => ({ state, total_count: total, statuses: [] });

async function harness() {
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
	const state = new Map<string, unknown>();
	const created: Array<Record<string, unknown>> = [];
	const decided: Array<{ id: string; note: unknown }> = [];
	const approvals: unknown[] = [];
	// Forge answers by path; a missing path is a 404.
	const forge: Record<string, unknown> = { [`/repos/${REPO}/topics`]: { topics: [] } };
	const reads: string[] = [];
	await mod.default.setup({
		companies: { list: async () => [{ id: "co-rt" }] },
		events: { on: () => {} },
		config: {
			get: async () => ({
				repos: [REPO],
				webhookSecret: "ref",
				forgeToken: "ref",
				reviewerAgentId: "dispatcher",
				triageAgentId: "tri",
				boardUserId: "rico-user",
			}),
		},
		secrets: { resolve: async () => SECRET },
		projects: { list: async () => [{ id: "p-demo", name: REPO }] },
		agents: { list: async () => [] },
		issues: {
			list: async () => [],
			get: async () => null,
			create: async (t: Record<string, unknown>) => {
				created.push(t);
				return { id: `new-${created.length}` };
			},
		},
		approvals: {
			list: async () => approvals,
			decide: async (id: string, input: { decisionNote?: unknown }) =>
				void decided.push({ id, note: input.decisionNote }),
		},
		state: {
			get: async (k: { stateKey: string }) => state.get(k.stateKey) ?? null,
			set: async (k: { stateKey: string }, v: unknown) => void state.set(k.stateKey, v),
		},
		jobs: { register: () => {} },
		logger: { info: () => {}, warn: () => {} },
	});
	const deliver = async (kind: string, payload: unknown, signature?: string) => {
		const raw = JSON.stringify(payload);
		const realFetch = globalThis.fetch;
		globalThis.fetch = (async (url: string | URL | Request) => {
			const path = String(url).replace(BASE, "");
			reads.push(path);
			const answer = forge[path];
			return answer === undefined
				? new Response("{}", { status: 404 })
				: new Response(JSON.stringify(answer), { status: 200 });
		}) as typeof fetch;
		try {
			return await mod.default.onWebhook({
				endpointKey: "forge",
				headers: { "x-forgejo-event": kind, "x-hub-signature-256": signature ?? sign(raw) },
				rawBody: raw,
			});
		} finally {
			globalThis.fetch = realFetch;
		}
	};
	const reviews = () => created.map((t) => String(t.title)).filter((t) => t.startsWith("Review "));
	return { state, created, decided, approvals, forge, reads, deliver, reviews };
}

const runPayload = (over: Record<string, unknown> = {}) => ({
	action: "success",
	repository: { full_name: REPO },
	...over,
});

describe("forge-pr: a head is reviewed when its checks finish, not on a clock", () => {
	test("(a) synchronized with combined status success creates the task in the same delivery", async () => {
		const h = await harness();
		h.forge[`/repos/${REPO}/commits/${SHA_A}/status`] = status("success");
		await h.deliver("pull_request", prBody("synchronized", SHA_A));
		expect(h.reviews()).toEqual([`Review ${REPO}#7 @ ${SHA_A.slice(0, 7)}`]);
		expect(h.reads).toContain(`/repos/${REPO}/commits/${SHA_A}/status`);
		expect(h.state.get(`settle:${REPO}#7`)).toMatchObject({ sha: SHA_A, reviewed: true });
	});

	test("(b) pending checks: settling, nothing filed; the action_run_success for that sha files it", async () => {
		const h = await harness();
		h.forge[`/repos/${REPO}/commits/${SHA_A}/status`] = status("pending");
		await h.deliver("pull_request", prBody("synchronized", SHA_A));
		expect(h.reviews()).toEqual([]);
		expect(h.state.get(`settle:${REPO}#7`)).toMatchObject({ sha: SHA_A });
		expect(h.state.get(`head:${REPO}@${SHA_A}`)).toEqual({ number: 7 });
		h.forge[`/repos/${REPO}/commits/${SHA_A}/status`] = status("success");
		h.forge[`/repos/${REPO}/pulls/7`] = pr(SHA_A);
		await h.deliver("action_run_success", runPayload({ run: { commit_sha: SHA_A } }));
		expect(h.reviews()).toEqual([`Review ${REPO}#7 @ ${SHA_A.slice(0, 7)}`]);
		// The sha mapped to the PR: one PR read, no open-PR listing.
		expect(h.reads.filter((p) => p.startsWith(`/repos/${REPO}/pulls?`))).toEqual([]);
	});

	test("(c) action_run_failure with combined failure also files it: a red head is still reviewed", async () => {
		const h = await harness();
		h.forge[`/repos/${REPO}/commits/${SHA_A}/status`] = status("pending");
		await h.deliver("pull_request", prBody("opened", SHA_A));
		expect(h.reviews()).toEqual([]);
		h.forge[`/repos/${REPO}/commits/${SHA_A}/status`] = status("failure");
		h.forge[`/repos/${REPO}/pulls/7`] = pr(SHA_A);
		await h.deliver(
			"action_run_failure",
			runPayload({ action: "failure", run: { head_sha: SHA_A } }),
		);
		expect(h.reviews()).toEqual([`Review ${REPO}#7 @ ${SHA_A.slice(0, 7)}`]);
	});

	test("(d) an action-run delivery with no usable sha re-checks the repo's waiting heads", async () => {
		const h = await harness();
		h.forge[`/repos/${REPO}/commits/${SHA_A}/status`] = status("pending");
		await h.deliver("pull_request", prBody("opened", SHA_A));
		expect(h.reviews()).toEqual([]);
		h.forge[`/repos/${REPO}/commits/${SHA_A}/status`] = status("success");
		h.forge[`/repos/${REPO}/pulls?state=open&limit=50&page=1`] = [pr(SHA_A)];
		await h.deliver("action_run_recover", runPayload({ action: "recover", run: { id: 9 } }));
		expect(h.reviews()).toEqual([`Review ${REPO}#7 @ ${SHA_A.slice(0, 7)}`]);
		expect(h.reads).toContain(`/repos/${REPO}/pulls?state=open&limit=50&page=1`);
	});

	test("(f) a newer head replaces the waiting record; the older head is never filed", async () => {
		const h = await harness();
		h.forge[`/repos/${REPO}/commits/${SHA_A}/status`] = status("pending");
		h.forge[`/repos/${REPO}/commits/${SHA_B}/status`] = status("pending");
		await h.deliver("pull_request", prBody("opened", SHA_A));
		await h.deliver("pull_request", prBody("synchronized", SHA_B));
		expect(h.state.get(`settle:${REPO}#7`)).toMatchObject({ sha: SHA_B });
		// The older head's run ends green; the PR's head is B, still pending.
		h.forge[`/repos/${REPO}/commits/${SHA_A}/status`] = status("success");
		h.forge[`/repos/${REPO}/pulls/7`] = pr(SHA_B);
		await h.deliver("action_run_success", runPayload({ run: { commit_sha: SHA_A } }));
		expect(h.reviews()).toEqual([]);
		h.forge[`/repos/${REPO}/commits/${SHA_B}/status`] = status("success");
		await h.deliver("action_run_success", runPayload({ run: { commit_sha: SHA_B } }));
		expect(h.reviews()).toEqual([`Review ${REPO}#7 @ ${SHA_B.slice(0, 7)}`]);
	});

	test("(g) synchronized rejects that PR's stale merge approvals in the same delivery, and no other PR's", async () => {
		const h = await harness();
		h.forge[`/repos/${REPO}/commits/${SHA_B}/status`] = status("pending");
		h.forge[`/repos/${REPO}/pulls/7`] = pr(SHA_B);
		h.forge[`/repos/${REPO}/pulls/8`] = pr(SHA_A);
		h.approvals.push(
			{
				id: "ap-7",
				type: "request_board_approval",
				payload: { title: `Go on ${REPO}#7 at ${SHA_A.slice(0, 7)}` },
			},
			{
				id: "ap-8",
				type: "request_board_approval",
				payload: { title: `Go on ${REPO}#8 at 1111111` },
			},
		);
		await h.deliver("pull_request", prBody("synchronized", SHA_B));
		expect(h.decided.map((d) => d.id)).toEqual(["ap-7"]);
		expect(String(h.decided[0]?.note)).toContain("Superseded");
		expect(h.reads).not.toContain(`/repos/${REPO}/pulls/8`);
	});

	test("(g') opened does not run the stale-approval rejection", async () => {
		const h = await harness();
		h.forge[`/repos/${REPO}/commits/${SHA_B}/status`] = status("pending");
		h.forge[`/repos/${REPO}/pulls/7`] = pr(SHA_B);
		h.approvals.push({
			id: "ap-7",
			type: "request_board_approval",
			payload: { title: `Go on ${REPO}#7 at ${SHA_A.slice(0, 7)}` },
		});
		await h.deliver("pull_request", prBody("opened", SHA_B));
		expect(h.decided).toEqual([]);
	});

	test("(h) a bad HMAC on an action_run delivery is refused and files nothing", async () => {
		const h = await harness();
		h.forge[`/repos/${REPO}/commits/${SHA_A}/status`] = status("pending");
		await h.deliver("pull_request", prBody("opened", SHA_A));
		h.forge[`/repos/${REPO}/commits/${SHA_A}/status`] = status("success");
		h.forge[`/repos/${REPO}/pulls/7`] = pr(SHA_A);
		const payload = runPayload({ run: { commit_sha: SHA_A } });
		const bad = sign(JSON.stringify(payload), "wrong");
		const readsBefore = h.reads.length;
		await expect(h.deliver("action_run_success", payload, bad)).rejects.toThrow(
			"forge-pr: signature check failed",
		);
		expect(h.reviews()).toEqual([]);
		expect(h.reads.length).toBe(readsBefore);
	});
});

describe("forge-pr: a head with no checks files after the fallback, via the sweep", () => {
	test("(e) total_count 0 is not filed before 2 minutes and is filed by the sweep after them", async () => {
		expect((sweep as Record<string, unknown>).CHECKS_FALLBACK_MS).toBe(FALLBACK_MS);
		const state = new Map<string, unknown>();
		const created: Array<{ title: string }> = [];
		let t = Date.parse("2026-10-08T00:00:00Z");
		const fetch = async (url: string) => {
			const path = url.slice(BASE.length);
			let body: unknown = [];
			if (path.startsWith("/repos/issues/search?") && path.includes("type=pulls"))
				body = [{ number: 7, updated_at: "u1", repository: { full_name: REPO } }];
			else if (path === `/repos/${REPO}/pulls/7`) body = pr(SHA_A);
			return new Response(JSON.stringify(body), { status: 200 });
		};
		const deps = {
			fetch,
			baseUrl: BASE,
			token: "t",
			repos: [REPO],
			now: () => t,
			stateGet: async (k: string) => state.get(k) ?? null,
			stateSet: async (k: string, v: unknown) => void state.set(k, v),
			createTask: async (task: { title: string }) => {
				created.push(task);
				return { id: `id-${created.length}` };
			},
			listTitles: async () => [],
			repoTier: async () => 5,
			cfg: { reviewerAgentId: "r", triageAgentId: "t" },
			log: () => {},
			checksOf: async () => ({ state: "", total_count: 0, statuses: [] }),
		};
		const ev = prFromApi(REPO, pr(SHA_A));
		if (!ev) throw new Error("fixture must parse");
		// The webhook records the head: no checks yet, so it waits.
		expect((await reviewPrOnce({ ...deps, postComment: async () => {} }, ev)).outcome).toBe(
			"settling",
		);
		t += FALLBACK_MS - 1000;
		await runSweep(deps);
		expect(created).toEqual([]);
		t += 1000;
		await runSweep(deps);
		expect(created.map((c) => c.title)).toEqual([`Review ${REPO}#7 @ ${SHA_A.slice(0, 7)}`]);
	});
});
