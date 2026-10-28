import { describe, expect, test } from "bun:test";
import type { DispatchGuardRead, DispatchGuardWrite } from "../../src/hooks/dispatch-guard";
import { createIssueTriageTrigger } from "../../src/hooks/issue-triage";
import { DISPATCH_TARGETS } from "../../src/hooks/sop-gate";

const REPO = "rtech/some-app";
const CONFIG = [
	{ name: REPO, provider: "forgejo" as const, triage: true, triage_runtime: "actions" as const },
	{ name: "rtech/box-runtime", provider: "forgejo" as const, triage: true },
	{
		name: "rtech/box-explicit",
		provider: "forgejo" as const,
		triage: true,
		triage_runtime: "box" as const,
	},
	{ name: "rtech/triage-off", provider: "forgejo" as const, triage_runtime: "actions" as const },
	{
		name: "rodaddy/on-github",
		provider: "github" as const,
		triage: true,
		triage_runtime: "actions" as const,
	},
	{
		name: "rodaddy/software-factory",
		provider: "forgejo" as const,
		triage: true,
		triage_runtime: "actions" as const,
	},
];
const DISPATCH =
	"https://forge.example.internal/api/v1/repos/rodaddy/software-factory/actions/workflows/issue-triage.yml/dispatches";

/** A fake Forge: records writes, lists no runs. */
function fakeForge(failWrites = false) {
	const posts: { path: string; body: unknown }[] = [];
	const read: DispatchGuardRead = async () => ({
		status: 200,
		data: { workflow_runs: [] },
		link: null,
		rateRemaining: null,
	});
	const write: DispatchGuardWrite = async (_method, path, body) => {
		if (failWrites) {
			throw new Error("forge down");
		}
		posts.push({ path, body });
		return { status: 204, data: null, link: null, rateRemaining: null };
	};
	return { read, write, posts };
}

function issueDelivery(overrides: { repository?: string; action?: string; number?: unknown } = {}) {
	return {
		repository: overrides.repository ?? REPO,
		event: "issues",
		payload: {
			action: overrides.action ?? "opened",
			issue: { number: "number" in overrides ? overrides.number : 7 },
		},
	};
}

describe("issue-triage dispatch for foreign repos", () => {
	test("an actions-runtime Forgejo repo's issue dispatches issue-triage.yml and records it on the host repo", async () => {
		const forge = fakeForge();
		const records: unknown[] = [];
		const trigger = createIssueTriageTrigger(forge.write, forge.read, CONFIG, {
			record: async (rec) => {
				records.push(rec);
			},
		});
		for (const action of ["opened", "reopened"]) {
			forge.posts.length = 0;
			records.length = 0;
			await trigger(issueDelivery({ action }));
			const inputs = { repo: REPO, number: "7", log_level: "info" };
			expect(forge.posts).toEqual([{ path: DISPATCH, body: { ref: "main", inputs } }]);
			expect(records).toEqual([
				// repo is the workflow HOST (forge_runs schema); the target is inputs.repo.
				// An issue has no sha, so target_sha is empty.
				{
					repo: "rodaddy/software-factory",
					workflow: "issue-triage.yml",
					runId: null,
					targetSha: "",
					inputs,
				},
			]);
		}
	});

	test("the dispatch target is registered for the #808 guard", () => {
		expect(DISPATCH_TARGETS["issue-triage.yml"]).toEqual({
			statusRepo: "",
			repoInput: "repo",
			context: "factory/issue-triage",
			shaInput: "head_sha",
		});
	});

	test("no-op: box runtime (absent or explicit), triage off, GitHub, software-factory itself, unenrolled, other action/event, malformed number", async () => {
		const forge = fakeForge();
		const records: unknown[] = [];
		const trigger = createIssueTriageTrigger(forge.write, forge.read, CONFIG, {
			record: async (rec) => {
				records.push(rec);
			},
		});
		await trigger(issueDelivery({ repository: "rtech/box-runtime" }));
		await trigger(issueDelivery({ repository: "rtech/box-explicit" }));
		await trigger(issueDelivery({ repository: "rtech/triage-off" }));
		await trigger(issueDelivery({ repository: "rodaddy/on-github" }));
		await trigger(issueDelivery({ repository: "rodaddy/software-factory" }));
		await trigger(issueDelivery({ repository: "rtech/not-enrolled" }));
		await trigger(issueDelivery({ action: "closed" }));
		for (const number of ["7", 0, -1, 1.5, null, undefined]) {
			await trigger(issueDelivery({ number }));
		}
		await trigger({ repository: REPO, event: "pull_request", payload: { action: "opened" } });
		expect(forge.posts).toEqual([]);
		expect(records).toEqual([]);
	});

	// A repo's own hook and the system hook each deliver the same event under a
	// different delivery id (hub issues 110 and 111, 2026-10-01: two runs each).
	test("the same issue event delivered twice dispatches once; a later one dispatches again", async () => {
		const forge = fakeForge();
		let clock = 1_000_000;
		const trigger = createIssueTriageTrigger(forge.write, forge.read, CONFIG, {
			now: () => clock,
		});
		await Promise.all([trigger(issueDelivery()), trigger(issueDelivery())]);
		expect(forge.posts).toHaveLength(1);
		// A different issue, and a different action on the same issue, are not twins.
		await trigger(issueDelivery({ number: 8 }));
		await trigger(issueDelivery({ action: "reopened" }));
		expect(forge.posts).toHaveLength(3);
		// Past the window the same event is a new one (a real second reopen).
		clock += 60_001;
		await trigger(issueDelivery());
		expect(forge.posts).toHaveLength(4);
	});

	test("a failed dispatch does not swallow the twin delivery that follows it", async () => {
		const forge = fakeForge();
		let failNext = true;
		const flaky: DispatchGuardWrite = async (method, path, body) => {
			if (failNext) {
				failNext = false;
				throw new Error("forge down");
			}
			return forge.write(method, path, body);
		};
		const trigger = createIssueTriageTrigger(flaky, forge.read, CONFIG, { now: () => 5 });
		await trigger(issueDelivery());
		expect(forge.posts).toHaveLength(0);
		await trigger(issueDelivery());
		expect(forge.posts).toHaveLength(1);
	});

	// PR 1113 review P1: the twin arrives while the first write is still in flight.
	test("twins in flight together: when the first dispatch fails, exactly one twin delivers it", async () => {
		const forge = fakeForge();
		let failNext = true;
		const flaky: DispatchGuardWrite = async (method, path, body) => {
			const fail = failNext;
			failNext = false;
			await Promise.resolve();
			if (fail) throw new Error("forge down");
			return forge.write(method, path, body);
		};
		const trigger = createIssueTriageTrigger(flaky, forge.read, CONFIG, { now: () => 5 });
		await Promise.all([
			trigger(issueDelivery()),
			trigger(issueDelivery()),
			trigger(issueDelivery()),
		]);
		expect(forge.posts).toHaveLength(1);
	});

	test("a failing forge write or a failing record never rejects", async () => {
		const down = fakeForge(true);
		await expect(
			createIssueTriageTrigger(down.write, down.read, CONFIG)(issueDelivery()),
		).resolves.toBeUndefined();
		const up = fakeForge();
		const trigger = createIssueTriageTrigger(up.write, up.read, CONFIG, {
			record: async () => {
				throw new Error("db down");
			},
		});
		await expect(trigger(issueDelivery())).resolves.toBeUndefined();
		expect(up.posts.map((p) => p.path)).toEqual([DISPATCH]);
	});
});
