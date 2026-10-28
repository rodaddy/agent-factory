import { describe, expect, test } from "bun:test";
import {
	type DispatchGuardRead,
	type DispatchGuardWrite,
	guardDispatches,
} from "../../src/hooks/dispatch-guard";
import { createInfraStaticTrigger } from "../../src/hooks/infra-static";
import { DISPATCH_TARGETS } from "../../src/hooks/sop-gate";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const REPO = "rtech/rtech-infra";
const CONFIG = [
	{ name: REPO, checks: "static-only", static_runtime: "actions" },
	{ name: "rodaddy/software-factory", checks: "standard" },
];
const T0 = Date.parse("2026-09-24T12:00:00Z");
const DISPATCH =
	"https://forge.example.internal/api/v1/repos/rodaddy/software-factory/actions/workflows/infra-static.yml/dispatches";

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
							workflow_id: "infra-static.yml",
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

function prDelivery(overrides: { repository?: string; action?: string; head?: string } = {}) {
	return {
		repository: overrides.repository ?? REPO,
		event: "pull_request",
		payload: {
			action: overrides.action ?? "opened",
			pull_request: { number: 42, head: { sha: overrides.head ?? HEAD }, base: { sha: BASE } },
		},
	};
}

describe("infra-static dispatch", () => {
	test("a static-only repo's PR dispatches infra-static.yml with validated inputs", async () => {
		const forge = fakeForge();
		const trigger = createInfraStaticTrigger(forge.write, forge.read, CONFIG);
		for (const action of ["opened", "synchronized", "reopened"]) {
			forge.posts.length = 0;
			await trigger(prDelivery({ action }));
			expect(forge.posts).toEqual([
				{
					path: DISPATCH,
					body: {
						ref: "main",
						inputs: { repo: REPO, number: "42", head_sha: HEAD, base_sha: BASE, log_level: "info" },
					},
				},
			]);
		}
	});

	test("the dispatch runs through the #808 runner guard, failing factory/infra-static on the TARGET repo", async () => {
		const forge = fakeForge(1_000);
		const guarded: Promise<unknown>[] = [];
		const trigger = createInfraStaticTrigger(forge.write, forge.read, CONFIG, {
			now: forge.now,
			sleep: forge.sleep,
			onWatch: (p) => guarded.push(p),
		});
		await trigger(prDelivery());
		expect(guarded).toHaveLength(1);
		expect(await guarded[0]).toBe("no_runner");
		const failure = forge.posts.find((p) => (p.body as { state?: string }).state === "error");
		expect(failure?.path).toBe(
			`https://forge.example.internal/api/v1/repos/${REPO}/statuses/${HEAD}`,
		);
		expect(failure?.body).toMatchObject({ context: "factory/infra-static" });
	});

	test("nothing is dispatched for a standard repo, another action, another event, or a bad sha", async () => {
		const forge = fakeForge();
		const trigger = createInfraStaticTrigger(forge.write, forge.read, CONFIG);
		await trigger(prDelivery({ repository: "rodaddy/software-factory" }));
		await trigger(prDelivery({ action: "closed" }));
		await trigger(prDelivery({ head: "not-a-sha" }));
		await trigger({ repository: REPO, event: "push", payload: { ref: "refs/heads/main" } });
		expect(forge.posts).toEqual([]);
	});

	test("a static-only repo on the default box runtime is never dispatched (rollout gate)", async () => {
		const forge = fakeForge();
		for (const repo of [
			{ name: REPO, checks: "static-only" },
			{ name: REPO, checks: "static-only", static_runtime: "box" },
		]) {
			const trigger = createInfraStaticTrigger(forge.write, forge.read, [repo]);
			await trigger(prDelivery());
		}
		expect(forge.posts).toEqual([]);
	});

	test("a failing forge write never rejects", async () => {
		const forge = fakeForge(0, true);
		const trigger = createInfraStaticTrigger(forge.write, forge.read, CONFIG);
		await expect(trigger(prDelivery())).resolves.toBeUndefined();
	});

	test("a malformed repo dispatch input never starts the guard", async () => {
		for (const repo of ["a/b/c", "../x", "x", "", "a/../b", 42]) {
			const forge = fakeForge(1_000);
			const guarded: Promise<unknown>[] = [];
			const write = guardDispatches(forge.write, forge.read, DISPATCH_TARGETS, {
				now: forge.now,
				sleep: forge.sleep,
				onWatch: (p) => guarded.push(p),
			});
			await write("POST", DISPATCH, {
				ref: "main",
				inputs: { repo, number: "42", head_sha: HEAD, base_sha: BASE },
			});
			expect(guarded).toHaveLength(0);
			expect(forge.posts.map((p) => p.path)).toEqual([DISPATCH]);
		}
	});
});
