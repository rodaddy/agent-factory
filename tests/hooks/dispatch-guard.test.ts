import { describe, expect, test } from "bun:test";
import {
	DISPATCH_BUSY_MAX_MS,
	DISPATCH_POLL_MS,
	DISPATCH_WAIT_MS,
	type DispatchGuardRead,
	type DispatchGuardWrite,
	type DispatchWatch,
	watchDispatch,
} from "../../src/hooks/dispatch-guard";
import { createSopGateTrigger, SOP_GATE_GATED_REPO } from "../../src/hooks/sop-gate";

const SHA = "0123456789abcdef0123456789abcdef01234567";
const SHA_B = "fedcba9876543210fedcba9876543210fedcba98";
const T0 = Date.parse("2026-09-24T12:00:00Z");

/** A waiting run as the live API returns it: `event_payload` is a JSON STRING. */
function waitingRun(sha: string, workflow = "sop-gate.yml") {
	return {
		workflow_id: workflow,
		status: "waiting",
		created: new Date(T0 + 1000).toISOString(),
		event_payload: JSON.stringify({ inputs: { head_sha: sha } }),
	};
}

/** A fake Forge whose waiting list is scripted per poll, on a fake clock. */
function fakeForge(waitingForPolls: number, script?: (poll: number) => unknown[]) {
	let clock = T0;
	let polls = 0;
	const reads: string[] = [];
	const posts: { path: string; body: unknown }[] = [];
	const read: DispatchGuardRead = async (path) => {
		reads.push(path);
		const poll = polls++;
		const runs = !path.includes("/actions/runs")
			? []
			: script
				? script(poll)
				: poll < waitingForPolls
					? [waitingRun(SHA)]
					: [];
		return {
			status: 200,
			data: { workflow_runs: runs, statuses: [] },
			link: null,
			rateRemaining: null,
		};
	};
	const write: DispatchGuardWrite = async (_method, path, body) => {
		posts.push({ path, body });
		return { status: 201, data: null, link: null, rateRemaining: null };
	};
	const sleep = async (ms: number) => {
		clock += ms;
	};
	return { read, write, sleep, now: () => clock, reads, posts };
}

function watch(): DispatchWatch {
	return {
		dispatchRepo: "rodaddy/software-factory",
		workflowFile: "sop-gate.yml",
		statusRepo: "rtech/k3s-deploy",
		sha: SHA,
		shaInput: "head_sha",
		context: "sop-gate",
		targetUrl: "https://forge.example.internal/rodaddy/software-factory/actions",
		dispatchedAt: T0,
	};
}

describe("watchDispatch", () => {
	test("a run left waiting with no runner posts an error status naming the workflow", async () => {
		const forge = fakeForge(1_000);
		const outcome = await watchDispatch(forge, watch());
		expect(outcome).toBe("no_runner");
		expect(forge.posts).toHaveLength(1);
		expect(forge.posts[0]?.path).toBe(
			`https://forge.example.internal/api/v1/repos/rtech/k3s-deploy/statuses/${SHA}`,
		);
		expect(forge.posts[0]?.body).toMatchObject({
			context: "sop-gate",
			state: "error",
			description: "no runner picked up sop-gate.yml within 120s",
		});
		expect(forge.reads[0]).toContain("status=waiting");
	});

	test("a run a runner picks up posts nothing", async () => {
		const forge = fakeForge(2);
		expect(await watchDispatch(forge, watch())).toBe("picked_up");
		expect(forge.posts).toHaveLength(0);
	});

	test("a run never seen waiting stops after the appear window and posts nothing", async () => {
		const forge = fakeForge(0);
		expect(await watchDispatch(forge, watch())).toBe("not_observed");
		expect(forge.posts).toHaveLength(0);
		expect(forge.reads.length).toBe(60_000 / DISPATCH_POLL_MS);
	});

	test("a waiting run of ANOTHER workflow or ANOTHER sha is not ours", async () => {
		const forge = fakeForge(1_000);
		const other = { ...watch(), workflowFile: "sop-verify.yml" };
		expect(await watchDispatch(forge, other)).toBe("not_observed");
		const otherSha = { ...watch(), sha: SHA_B };
		expect(await watchDispatch(forge, otherSha)).toBe("not_observed");
		expect(forge.posts).toHaveLength(0);
	});

	test("two same-workflow dispatches in flight: only the one left waiting fails", async () => {
		// Poll 0 (A's first) sees both waiting; after that a runner has taken A and B still waits.
		const script = (poll: number) =>
			poll === 0 ? [waitingRun(SHA), waitingRun(SHA_B)] : [waitingRun(SHA_B)];
		const forgeA = fakeForge(0, script);
		const forgeB = fakeForge(0, script);
		expect(await watchDispatch(forgeA, watch())).toBe("picked_up");
		expect(forgeA.posts).toHaveLength(0);
		expect(await watchDispatch(forgeB, { ...watch(), sha: SHA_B })).toBe("no_runner");
		expect(forgeB.posts).toHaveLength(1);
		expect(forgeB.posts[0]?.path).toBe(
			`https://forge.example.internal/api/v1/repos/rtech/k3s-deploy/statuses/${SHA_B}`,
		);
	});

	test("up to three consecutive read failures are tolerated", async () => {
		const forge = fakeForge(2);
		let calls = 0;
		const read: DispatchGuardRead = async (path) => {
			calls++;
			if (calls >= 2 && calls <= 4) {
				throw new Error("forge blip");
			}
			return forge.read(path);
		};
		expect(await watchDispatch({ ...forge, read }, watch())).toBe("picked_up");
		expect(forge.posts).toHaveLength(0);
	});

	test("an unreadable run list resolves without posting", async () => {
		const forge = fakeForge(0);
		const read: DispatchGuardRead = async () => {
			throw new Error("forge unreachable");
		};
		expect(await watchDispatch({ ...forge, read }, watch())).toBe("unreadable");
		expect(forge.posts).toHaveLength(0);
	});
});

describe("watchDispatch waits while runners are busy", () => {
	/** Waiting list scripted by clock; running list holds `running(clock)` runs. */
	function busyForge(waitingUntil: number, running: (clock: number) => number) {
		const forge = fakeForge(0);
		const read: DispatchGuardRead = async (path) => {
			forge.reads.push(path);
			const t = forge.now();
			const runs = path.includes("status=running")
				? Array.from({ length: running(t) }, () => ({ ...waitingRun(SHA_B), status: "running" }))
				: t < waitingUntil
					? [waitingRun(SHA)]
					: [];
			return { status: 200, data: { workflow_runs: runs }, link: null, rateRemaining: null };
		};
		return { ...forge, read };
	}

	test("waiting at 120 s with a running run posts nothing, then a pickup is picked_up_after_busy", async () => {
		const forge = busyForge(T0 + 10 * 60_000, () => 1);
		expect(await watchDispatch(forge, watch())).toBe("picked_up_after_busy");
		expect(forge.posts).toHaveLength(0);
		expect(forge.reads.some((r) => r.endsWith("/actions/runs?status=running"))).toBe(true);
	});

	test("waiting at 120 s with nothing running fails as before", async () => {
		const forge = busyForge(Number.POSITIVE_INFINITY, () => 0);
		expect(await watchDispatch(forge, watch())).toBe("no_runner");
		expect(forge.posts).toHaveLength(1);
		expect(forge.posts[0]?.body).toMatchObject({
			description: "no runner picked up sop-gate.yml within 120s",
		});
	});

	test("busy past DISPATCH_BUSY_MAX_MS posts one error naming busy runners", async () => {
		const forge = busyForge(Number.POSITIVE_INFINITY, () => 2);
		expect(await watchDispatch(forge, watch())).toBe("no_runner");
		expect(forge.posts).toHaveLength(1);
		expect(forge.posts[0]?.body).toMatchObject({
			state: "error",
			description: "no runner picked up sop-gate.yml within 45m (runners busy)",
		});
		expect(forge.now() - T0).toBeGreaterThanOrEqual(DISPATCH_BUSY_MAX_MS);
	});

	test("a failing running list ends unreadable, probed at most once per DISPATCH_WAIT_MS", async () => {
		const forge = fakeForge(0);
		const runningAt: number[] = [];
		let reads = 0;
		const read: DispatchGuardRead = async (path) => {
			if (++reads > 500) throw new Error("guard loops");
			if (path.includes("status=running")) {
				runningAt.push(forge.now());
				throw new Error("running list down");
			}
			return {
				status: 200,
				data: { workflow_runs: [waitingRun(SHA)] },
				link: null,
				rateRemaining: null,
			};
		};
		expect(await watchDispatch({ ...forge, read }, watch())).toBe("unreadable");
		expect(forge.posts).toHaveLength(0);
		expect(runningAt).toHaveLength(4);
		for (let i = 1; i < runningAt.length; i++) {
			expect((runningAt[i] ?? 0) - (runningAt[i - 1] ?? 0)).toBeGreaterThanOrEqual(
				DISPATCH_WAIT_MS,
			);
		}
	});
});

describe("sop-gate dispatch runs the guard", () => {
	test("a pull_request dispatch whose run never gets a runner fails the head sha", async () => {
		const forge = fakeForge(1_000);
		const guarded: Promise<unknown>[] = [];
		const trigger = createSopGateTrigger(forge.write, forge.read, {
			now: forge.now,
			sleep: forge.sleep,
			onWatch: (p) => guarded.push(p),
		});
		await trigger({
			repository: SOP_GATE_GATED_REPO,
			event: "pull_request",
			payload: { action: "opened", pull_request: { number: 7, head: { sha: SHA } } },
		});
		expect(guarded).toHaveLength(1);
		expect(await guarded[0]).toBe("no_runner");
		const failure = forge.posts.find((post) => (post.body as { state?: string }).state === "error");
		expect(failure?.path).toBe(
			`https://forge.example.internal/api/v1/repos/rtech/k3s-deploy/statuses/${SHA}`,
		);
		expect(failure?.body).toMatchObject({
			context: "sop-gate",
			description: "no runner picked up sop-gate.yml within 120s",
		});
	});
});
