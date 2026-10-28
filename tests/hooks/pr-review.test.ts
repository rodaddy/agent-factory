import { describe, expect, test } from "bun:test";
import { describeStatus } from "../../scripts/actions/post-pr-review";
import type { DispatchGuardRead, DispatchGuardWrite } from "../../src/hooks/dispatch-guard";
import { createPrReviewTrigger } from "../../src/hooks/pr-review";
import { DISPATCH_TARGETS } from "../../src/hooks/sop-gate";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const REPO = "rtech/some-app";
const CONFIG = [
	{
		name: REPO,
		provider: "forgejo" as const,
		checks: "standard",
		pr_review_runtime: "actions" as const,
	},
	{ name: "rtech/box-runtime", provider: "forgejo" as const, checks: "standard" },
	{
		name: "rtech/box-explicit",
		provider: "forgejo" as const,
		checks: "standard",
		pr_review_runtime: "box" as const,
	},
	{ name: "rtech/opted-out", provider: "forgejo" as const, checks: "standard", pr_review: false },
	{ name: "rtech/rtech-infra", provider: "forgejo" as const, checks: "static-only" },
	{ name: "rodaddy/on-github", provider: "github" as const, checks: "standard" },
	{
		name: "rodaddy/software-factory",
		provider: "forgejo" as const,
		checks: "standard",
		pr_review_runtime: "actions" as const,
	},
];
const T0 = Date.parse("2026-09-24T12:00:00Z");
const DISPATCH =
	"https://forge.example.internal/api/v1/repos/rodaddy/software-factory/actions/workflows/pr-review.yml/dispatches";

/** A fake Forge: records writes; its waiting list holds our run for `waitingPolls` polls. */
function fakeForge(waitingPolls = 0, failWrites = false) {
	let clock = T0;
	let polls = 0;
	const posts: { path: string; body: unknown }[] = [];
	const read: DispatchGuardRead = async (path) => {
		const runs =
			path.includes("/actions/runs") && polls++ < waitingPolls
				? [
						{
							workflow_id: "pr-review.yml",
							status: "waiting",
							event_payload: JSON.stringify({ inputs: { repo: REPO, head_sha: HEAD } }),
						},
					]
				: [];
		return { status: 200, data: { workflow_runs: runs }, link: null, rateRemaining: null };
	};
	const write: DispatchGuardWrite = async (_method, path, body) => {
		if (failWrites) {
			throw new Error("forge down");
		}
		posts.push({ path, body });
		return { status: 204, data: null, link: null, rateRemaining: null };
	};
	return {
		read,
		write,
		posts,
		now: () => clock,
		sleep: async (ms: number) => {
			clock += ms;
		},
	};
}

function prDelivery(
	overrides: {
		repository?: string;
		action?: string;
		head?: string;
		draft?: unknown;
		changes?: unknown;
	} = {},
) {
	return {
		repository: overrides.repository ?? REPO,
		event: "pull_request",
		payload: {
			action: overrides.action ?? "opened",
			...(overrides.changes === undefined ? {} : { changes: overrides.changes }),
			pull_request: {
				number: 42,
				head: { sha: overrides.head ?? HEAD },
				base: { sha: BASE },
				...(overrides.draft === undefined ? {} : { draft: overrides.draft }),
			},
		},
	};
}

describe("pr-review skips a WIP (draft) PR and reviews it once WIP leaves the title", () => {
	const TITLE_EDIT = { title: { from: "WIP: Add thing" } };

	test("a draft PR opened dispatches nothing", async () => {
		const forge = fakeForge();
		await createPrReviewTrigger(
			forge.write,
			forge.read,
			CONFIG,
		)(prDelivery({ action: "opened", draft: true }));
		expect(forge.posts).toEqual([]);
	});

	test("a draft PR synchronized dispatches nothing", async () => {
		const forge = fakeForge();
		await createPrReviewTrigger(
			forge.write,
			forge.read,
			CONFIG,
		)(prDelivery({ action: "synchronized", draft: true }));
		expect(forge.posts).toEqual([]);
	});

	test("a non-boolean draft is not draft and dispatches", async () => {
		const forge = fakeForge();
		await createPrReviewTrigger(
			forge.write,
			forge.read,
			CONFIG,
		)(prDelivery({ action: "opened", draft: "true" }));
		expect(forge.posts.map((p) => p.path)).toEqual([DISPATCH]);
	});

	test("edited with changes.title and not draft dispatches", async () => {
		const forge = fakeForge();
		await createPrReviewTrigger(
			forge.write,
			forge.read,
			CONFIG,
		)(prDelivery({ action: "edited", changes: TITLE_EDIT, draft: false }));
		expect(forge.posts.map((p) => p.path)).toEqual([DISPATCH]);
	});

	test("edited without changes.title dispatches nothing", async () => {
		const forge = fakeForge();
		await createPrReviewTrigger(
			forge.write,
			forge.read,
			CONFIG,
		)(prDelivery({ action: "edited", changes: { body: { from: "old" } }, draft: false }));
		expect(forge.posts).toEqual([]);
	});

	test("edited with changes.title but still draft dispatches nothing", async () => {
		const forge = fakeForge();
		await createPrReviewTrigger(
			forge.write,
			forge.read,
			CONFIG,
		)(prDelivery({ action: "edited", changes: TITLE_EDIT, draft: true }));
		expect(forge.posts).toEqual([]);
	});
});

describe("pr-review dispatch for foreign repos", () => {
	test("an enrolled Forgejo repo's PR dispatches pr-review.yml with validated inputs and records it", async () => {
		const forge = fakeForge();
		const records: unknown[] = [];
		const trigger = createPrReviewTrigger(forge.write, forge.read, CONFIG, {
			record: async (rec) => {
				records.push(rec);
			},
		});
		for (const action of ["opened", "synchronized", "reopened"]) {
			forge.posts.length = 0;
			records.length = 0;
			await trigger(prDelivery({ action }));
			const inputs = {
				repo: REPO,
				number: "42",
				head_sha: HEAD,
				base_sha: BASE,
				log_level: "info",
			};
			expect(forge.posts).toEqual([{ path: DISPATCH, body: { ref: "main", inputs } }]);
			expect(records).toEqual([
				// repo is the workflow HOST (forge_runs schema); the target is inputs.repo.
				{
					repo: "rodaddy/software-factory",
					workflow: "pr-review.yml",
					runId: null,
					targetSha: HEAD,
					inputs,
				},
			]);
		}
	});

	test("the guard target reports factory/pr-review on the repo named in the repo input", () => {
		expect(DISPATCH_TARGETS["pr-review.yml"]).toEqual({
			statusRepo: "",
			repoInput: "repo",
			context: "factory/pr-review",
			shaInput: "head_sha",
		});
	});

	test("the dispatch runs through the #808 runner guard, failing factory/pr-review on the TARGET repo", async () => {
		const forge = fakeForge(1_000);
		const guarded: Promise<unknown>[] = [];
		const trigger = createPrReviewTrigger(forge.write, forge.read, CONFIG, {
			guard: { now: forge.now, sleep: forge.sleep, onWatch: (p) => guarded.push(p) },
		});
		await trigger(prDelivery());
		expect(guarded).toHaveLength(1);
		expect(await guarded[0]).toBe("no_runner");
		const failure = forge.posts.find((p) => (p.body as { state?: string }).state === "error");
		expect(failure?.path).toBe(
			`https://forge.example.internal/api/v1/repos/${REPO}/statuses/${HEAD}`,
		);
		expect(failure?.body).toMatchObject({ context: "factory/pr-review" });
	});

	test("software-factory's own PR dispatches pr-review.yml from main like any enrolled repo", async () => {
		const forge = fakeForge();
		const trigger = createPrReviewTrigger(forge.write, forge.read, CONFIG);
		await trigger(prDelivery({ repository: "rodaddy/software-factory" }));
		expect(forge.posts).toEqual([
			{
				path: DISPATCH,
				body: {
					ref: "main",
					inputs: {
						repo: "rodaddy/software-factory",
						number: "42",
						head_sha: HEAD,
						base_sha: BASE,
						log_level: "info",
					},
				},
			},
		]);
	});

	test("no-op: box runtime (absent or explicit), opted out, static-only, GitHub provider, unenrolled, other action/event, bad sha", async () => {
		const forge = fakeForge();
		const records: unknown[] = [];
		const trigger = createPrReviewTrigger(forge.write, forge.read, CONFIG, {
			record: async (rec) => {
				records.push(rec);
			},
		});
		await trigger(prDelivery({ repository: "rtech/box-runtime" }));
		await trigger(prDelivery({ repository: "rtech/box-explicit" }));
		await trigger(prDelivery({ repository: "rtech/opted-out" }));
		await trigger(prDelivery({ repository: "rtech/rtech-infra" }));
		await trigger(prDelivery({ repository: "rodaddy/on-github" }));
		await trigger(prDelivery({ repository: "rtech/not-enrolled" }));
		await trigger(prDelivery({ action: "closed" }));
		await trigger(prDelivery({ head: "not-a-sha" }));
		await trigger({ repository: REPO, event: "issues", payload: { action: "opened" } });
		expect(forge.posts).toEqual([]);
		expect(records).toEqual([]);
	});

	test("two triggers for one head dispatch one run once that head has a completed review", async () => {
		for (const [state, expected] of [
			["success", 1],
			["failure", 1],
			["warning", 1],
			["error", 2],
			["pending", 2],
		] as const) {
			const forge = fakeForge();
			let reviewed: string | null = null;
			const read: DispatchGuardRead = async (path) =>
				path === `https://forge.example.internal/api/v1/repos/${REPO}/commits/${HEAD}/status`
					? {
							status: 200,
							data: {
								statuses:
									reviewed === null ? [] : [{ context: "factory/pr-review", status: reviewed }],
							},
							link: null,
							rateRemaining: null,
						}
					: forge.read(path);
			const trigger = createPrReviewTrigger(forge.write, read, CONFIG);
			await trigger(prDelivery({ action: "opened" }));
			// The lane ran and published its result on the head.
			reviewed = state;
			await trigger(prDelivery({ action: "synchronized" }));
			expect([state, forge.posts.filter((p) => p.path === DISPATCH).length]).toEqual([
				state,
				expected,
			]);
		}
	});

	test("an advisory success that names a failure does not count as reviewed", async () => {
		for (const [description, expected] of [
			["pr-review advisory: the job failed before publishing", 2],
			["pr-review advisory: the job ended without publishing", 2],
			["pr-review advisory: the comment did not post", 2],
			[describeStatus("approve", "1", "advisory"), 1],
			[describeStatus("fix-first", undefined, "advisory"), 1],
			["pr-review: no blocking findings", 1],
		] as const) {
			const forge = fakeForge();
			let reviewed = false;
			const read: DispatchGuardRead = async (path) =>
				path === `https://forge.example.internal/api/v1/repos/${REPO}/commits/${HEAD}/status`
					? {
							status: 200,
							data: {
								statuses: reviewed
									? [{ context: "factory/pr-review", status: "success", description }]
									: [],
							},
							link: null,
							rateRemaining: null,
						}
					: forge.read(path);
			const trigger = createPrReviewTrigger(forge.write, read, CONFIG);
			await trigger(prDelivery({ action: "opened" }));
			reviewed = true;
			await trigger(prDelivery({ action: "synchronized" }));
			expect([description, forge.posts.filter((p) => p.path === DISPATCH).length]).toEqual([
				description,
				expected,
			]);
		}
	});

	test("a failing forge write or a failing record never rejects", async () => {
		const down = fakeForge(0, true);
		await expect(
			createPrReviewTrigger(down.write, down.read, CONFIG)(prDelivery()),
		).resolves.toBeUndefined();
		const up = fakeForge();
		const trigger = createPrReviewTrigger(up.write, up.read, CONFIG, {
			record: async () => {
				throw new Error("db down");
			},
		});
		await expect(trigger(prDelivery())).resolves.toBeUndefined();
		expect(up.posts.map((p) => p.path)).toEqual([DISPATCH]);
	});
});
