import { describe, expect, test } from "bun:test";
import type { DispatchQuery, DispatchRecord } from "../../src/forge/actions-store";
import type { DispatchGuardRead, DispatchGuardWrite } from "../../src/hooks/dispatch-guard";
import { createHookTrigger } from "../../src/hooks/infra-static";
import { createPrepushTrigger } from "../../src/hooks/prepush";
import {
	createSopGateTrigger,
	DISPATCH_TARGETS,
	PREPUSH_WORKFLOW_FILE,
	SOP_GATE_DISPATCH_REPO,
	SOP_GATE_GATED_REPO,
} from "../../src/hooks/sop-gate";

const HEAD = "0123456789abcdef0123456789abcdef01234567";
const BASE = "fedcba9876543210fedcba9876543210fedcba98";
const REPO = "rtech/some-app";
const SF = "rodaddy/software-factory";
const CONFIG = [
	{ name: REPO, provider: "forgejo" as const, prepush_runtime: "actions" as const },
	{ name: SF, provider: "forgejo" as const, prepush_runtime: "actions" as const },
	{ name: "rtech/box-runtime", provider: "forgejo" as const },
	{ name: "rtech/box-explicit", provider: "forgejo" as const, prepush_runtime: "box" as const },
	{ name: "rodaddy/on-github", provider: "github" as const, prepush_runtime: "actions" as const },
];
const DISPATCH =
	"https://forge.example.internal/api/v1/repos/rodaddy/software-factory/actions/workflows/prepush.yml/dispatches";

/** A fake Forge: records writes; no run is ever left waiting. */
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

function prDelivery(
	overrides: { repository?: string; action?: string; head?: string; base?: string } = {},
) {
	return {
		repository: overrides.repository ?? REPO,
		event: "pull_request",
		payload: {
			action: overrides.action ?? "opened",
			pull_request: {
				number: 42,
				head: { sha: overrides.head ?? HEAD },
				base: { sha: overrides.base ?? BASE },
			},
		},
	};
}

const SCRATCH = "scratch/v1-receipt-review-20260926T040312Z-f806ccac";

function refDelivery(ref: string, headRepo: string, baseRepo = REPO) {
	const d = prDelivery();
	return {
		...d,
		payload: {
			...d.payload,
			pull_request: {
				number: 42,
				head: { sha: HEAD, ref, repo: { full_name: headRepo } },
				base: { sha: BASE, repo: { full_name: baseRepo } },
			},
		},
	};
}

describe("receipt scratch PRs", () => {
	test("a same-repo PR on a scratch/v1-receipt- ref makes no dispatch", async () => {
		const forge = fakeForge();
		await createPrepushTrigger(forge.write, forge.read, CONFIG)(refDelivery(SCRATCH, REPO));
		expect(forge.posts).toEqual([]);
	});

	test("a same-repo PR on a normal branch still dispatches", async () => {
		const forge = fakeForge();
		await createPrepushTrigger(forge.write, forge.read, CONFIG)(refDelivery("fix/42-x", REPO));
		expect(forge.posts.length).toBe(1);
	});

	test("a fork PR with a scratch ref still dispatches", async () => {
		const forge = fakeForge();
		await createPrepushTrigger(forge.write, forge.read, CONFIG)(refDelivery(SCRATCH, "evil/fork"));
		expect(forge.posts.length).toBe(1);
	});
});

describe("prepush dispatch (D23)", () => {
	test("an actions-runtime Forgejo repo, software-factory included, dispatches prepush.yml and records it on the host repo", async () => {
		for (const repository of [REPO, SF]) {
			for (const action of ["opened", "synchronized", "reopened"]) {
				const forge = fakeForge();
				const records: unknown[] = [];
				const trigger = createPrepushTrigger(forge.write, forge.read, CONFIG, {
					record: async (rec) => {
						records.push(rec);
					},
				});
				await trigger(prDelivery({ repository, action }));
				const inputs = {
					repo: repository,
					number: "42",
					head_sha: HEAD,
					base_sha: BASE,
					log_level: "info",
				};
				expect(forge.posts).toEqual([{ path: DISPATCH, body: { ref: "main", inputs } }]);
				expect(records).toEqual([
					{ repo: SF, workflow: "prepush.yml", runId: null, targetSha: HEAD, inputs },
				]);
			}
		}
	});

	test("the dispatch URL names prepush.yml on SOP_GATE_DISPATCH_REPO, not the gated repo", async () => {
		const forge = fakeForge();
		await createPrepushTrigger(forge.write, forge.read, CONFIG)(prDelivery());
		expect(PREPUSH_WORKFLOW_FILE).toBe("prepush.yml");
		expect(forge.posts.map((p) => p.path)).toEqual([
			`https://forge.example.internal/api/v1/repos/${SOP_GATE_DISPATCH_REPO}/actions/workflows/prepush.yml/dispatches`,
		]);
		expect(Object.keys(DISPATCH_TARGETS)).toContain("prepush.yml");
	});

	test("the guard target reports factory/prepush on the repo named in the repo input", () => {
		expect(DISPATCH_TARGETS["prepush.yml"]).toEqual({
			statusRepo: "",
			repoInput: "repo",
			context: "factory/prepush",
			shaInput: "head_sha",
		});
	});

	test("no-op: box runtime (absent or explicit), GitHub provider, unenrolled, other action/event, malformed shas", async () => {
		const forge = fakeForge();
		const records: unknown[] = [];
		const trigger = createPrepushTrigger(forge.write, forge.read, CONFIG, {
			record: async (rec) => {
				records.push(rec);
			},
		});
		await trigger(prDelivery({ repository: "rtech/box-runtime" }));
		await trigger(prDelivery({ repository: "rtech/box-explicit" }));
		await trigger(prDelivery({ repository: "rodaddy/on-github" }));
		await trigger(prDelivery({ repository: "rtech/not-enrolled" }));
		await trigger(prDelivery({ action: "closed" }));
		await trigger(prDelivery({ head: "not-a-sha" }));
		await trigger(prDelivery({ base: HEAD.toUpperCase() }));
		await trigger({ repository: REPO, event: "issues", payload: { action: "opened" } });
		expect(forge.posts).toEqual([]);
		expect(records).toEqual([]);
	});

	test("a failing forge write or a failing record never rejects", async () => {
		const down = fakeForge(true);
		await expect(
			createPrepushTrigger(down.write, down.read, CONFIG)(prDelivery()),
		).resolves.toBeUndefined();
		const up = fakeForge();
		const trigger = createPrepushTrigger(up.write, up.read, CONFIG, {
			record: async () => {
				throw new Error("db down");
			},
		});
		await expect(trigger(prDelivery())).resolves.toBeUndefined();
		expect(up.posts.map((p) => p.path)).toEqual([DISPATCH]);
	});
});

describe("prepush dispatch dedupe per head sha", () => {
	/** A record/find pair over one in-memory forge_runs list. */
	function fakeRuns() {
		const rows: DispatchRecord[] = [];
		const record = async (rec: DispatchRecord) => {
			rows.push(rec);
		};
		const find = async (q: DispatchQuery) => {
			const i = rows.findIndex(
				(r) =>
					r.repo === q.repo &&
					r.workflow === q.workflow &&
					r.targetSha === q.targetSha &&
					Object.entries(q.inputs).every(([k, v]) => r.inputs[k] === v),
			);
			return i === -1 ? null : i + 1;
		};
		return { rows, record, find };
	}

	test("a second synchronized delivery for the same head makes no second POST", async () => {
		const forge = fakeForge();
		const runs = fakeRuns();
		const trigger = createPrepushTrigger(forge.write, forge.read, CONFIG, runs);
		await trigger(prDelivery({ action: "synchronized" }));
		await trigger(prDelivery({ action: "synchronized" }));
		await trigger(prDelivery({ action: "opened" }));
		expect(forge.posts.length).toBe(1);
		await trigger(prDelivery({ action: "synchronized", head: BASE }));
		expect(forge.posts.length).toBe(2);
	});

	test("reopened for the same head always POSTs", async () => {
		const forge = fakeForge();
		const runs = fakeRuns();
		const trigger = createPrepushTrigger(forge.write, forge.read, CONFIG, runs);
		await trigger(prDelivery({ action: "synchronized" }));
		await trigger(prDelivery({ action: "reopened" }));
		expect(forge.posts.length).toBe(2);
	});

	test("createHookTrigger wiring: a pull_request dispatches prepush with base_sha from pull_request.base.sha", async () => {
		const forge = fakeForge();
		const trigger = createHookTrigger(
			forge.write,
			forge.read,
			CONFIG.map((repo) => ({ ...repo, checks: "" })),
		);
		await trigger(prDelivery({ action: "opened" }));
		const prepush = forge.posts.filter((p) => p.path === DISPATCH);
		expect(prepush.length).toBe(1);
		const body = prepush[0]?.body as { inputs: Record<string, string> };
		expect(body.inputs.base_sha).toBe(BASE);
		expect(body.inputs.head_sha).toBe(HEAD);
	});

	test("createHookTrigger wiring: a duplicate or database-down delivery reaches no lane but the sop gate", async () => {
		for (const flag of [{ duplicate: true }, { dbUnavailable: true }]) {
			const forge = fakeForge();
			const trigger = createHookTrigger(
				forge.write,
				forge.read,
				CONFIG.map((repo) => ({ ...repo, checks: "" })),
			);
			await trigger({ ...prDelivery({ action: "opened" }), ...flag });
			expect(forge.posts.filter((p) => p.path === DISPATCH).length).toBe(0);
		}
	});
});

describe("sop gate outage and redelivery", () => {
	const API = "https://forge.example.internal/api/v1";
	const STATUS_POST = `${API}/repos/${SOP_GATE_GATED_REPO}/statuses/${HEAD}`;
	const GATE_DISPATCH = `${API}/repos/${SOP_GATE_DISPATCH_REPO}/actions/workflows/sop-gate.yml/dispatches`;
	const OUTAGE = "sop-gate database unavailable; re-run after recovery";

	/** A forge whose combined-status read answers `rows`; the runner guard never wakes. */
	function gateForge(rows: { context: string; status: string; description: string }[]) {
		const posts: { path: string; body: unknown }[] = [];
		const read: DispatchGuardRead = async (path) => ({
			status: 200,
			data: path.endsWith(`/commits/${HEAD}/status`) ? { statuses: rows } : { workflow_runs: [] },
			link: null,
			rateRemaining: null,
		});
		const write: DispatchGuardWrite = async (_method, path, body) => {
			posts.push({ path, body });
			return { status: 204, data: null, link: null, rateRemaining: null };
		};
		const trigger = createSopGateTrigger(write, read, { sleep: () => new Promise(() => {}) });
		return { trigger, posts };
	}

	const outageRow = { context: "sop-gate", status: "error", description: OUTAGE };

	test("a database-down delivery posts one error status and dispatches nothing", async () => {
		const forge = gateForge([]);
		await forge.trigger({
			...prDelivery({ repository: SOP_GATE_GATED_REPO }),
			dbUnavailable: true,
		});
		expect(forge.posts).toEqual([
			{
				path: STATUS_POST,
				body: {
					context: "sop-gate",
					state: "error",
					description: OUTAGE,
					target_url: "https://forge.example.internal/rodaddy/software-factory/actions",
				},
			},
		]);
	});

	test("a duplicate on a head carrying the outage status re-runs the gate", async () => {
		const forge = gateForge([outageRow]);
		await forge.trigger({ ...prDelivery({ repository: SOP_GATE_GATED_REPO }), duplicate: true });
		expect(forge.posts.map((p) => p.path)).toEqual([STATUS_POST, GATE_DISPATCH]);
		expect(forge.posts[0]?.body).toMatchObject({ context: "sop-gate", state: "pending" });
		expect(forge.posts[1]?.body).toEqual({
			ref: "main",
			inputs: { pr_number: "42", head_sha: HEAD },
		});
	});

	test("a duplicate with no status row does nothing", async () => {
		const forge = gateForge([]);
		await forge.trigger({ ...prDelivery({ repository: SOP_GATE_GATED_REPO }), duplicate: true });
		expect(forge.posts).toEqual([]);
	});

	test("a duplicate with a non-matching status row does nothing", async () => {
		for (const row of [
			{ context: "sop-gate", status: "success", description: OUTAGE },
			{ context: "sop-gate", status: "error", description: "something else" },
		]) {
			const forge = gateForge([row]);
			await forge.trigger({ ...prDelivery({ repository: SOP_GATE_GATED_REPO }), duplicate: true });
			expect(forge.posts).toEqual([]);
		}
	});

	test("a non-qualifying duplicate (closed) does nothing even on an outage head", async () => {
		const forge = gateForge([outageRow]);
		await forge.trigger({
			...prDelivery({ repository: SOP_GATE_GATED_REPO, action: "closed" }),
			duplicate: true,
		});
		expect(forge.posts).toEqual([]);
	});
});

describe("prepush atomic claim", () => {
	function seams(claimResult: number | null | Error) {
		const calls = { claim: 0, release: [] as number[], record: 0 };
		return {
			calls,
			claim: async (_rec: DispatchRecord, _match: Record<string, string>) => {
				calls.claim += 1;
				if (claimResult instanceof Error) {
					throw claimResult;
				}
				return claimResult;
			},
			release: async (id: number) => {
				calls.release.push(id);
			},
			record: async (_rec: DispatchRecord) => {
				calls.record += 1;
			},
		};
	}

	/** The first `failures` dispatch POSTs throw; later ones succeed. */
	function flakyForge(failures: number) {
		const forge = fakeForge();
		const attempts: string[] = [];
		const write: DispatchGuardWrite = async (_m, path, body) => {
			if (path === DISPATCH) {
				attempts.push(path);
				if (attempts.length <= failures) {
					throw new Error("forge down");
				}
			}
			forge.posts.push({ path, body });
			return { status: 204, data: null, link: null, rateRemaining: null };
		};
		return { ...forge, write, attempts };
	}

	test("two concurrent deliveries, winner's first POST fails: the head still gets exactly one dispatch", async () => {
		const forge = flakyForge(1);
		const held = new Map<number, string>();
		const released: number[] = [];
		let next = 1;
		const trigger = createPrepushTrigger(forge.write, forge.read, CONFIG, {
			claim: async (rec, match) => {
				const key = `${rec.targetSha}:${JSON.stringify(match)}`;
				if ([...held.values()].includes(key)) {
					return null;
				}
				const id = next++;
				held.set(id, key);
				return id;
			},
			release: async (id) => {
				released.push(id);
				held.delete(id);
			},
		});
		await Promise.all([
			trigger(prDelivery({ action: "opened" })),
			trigger(prDelivery({ action: "synchronized" })),
		]);
		expect(forge.posts.filter((p) => p.path === DISPATCH)).toHaveLength(1);
		expect(forge.attempts).toHaveLength(2);
		expect(released).toEqual([]);
		expect(held.size).toBe(1);
	});

	test("claim -> id, POST throws twice: two attempts, then release(id) once", async () => {
		const forge = flakyForge(2);
		const s = seams(7);
		await createPrepushTrigger(forge.write, forge.read, CONFIG, s)(prDelivery());
		expect(forge.attempts).toHaveLength(2);
		expect(forge.posts.filter((p) => p.path === DISPATCH)).toHaveLength(0);
		expect(s.calls.release).toEqual([7]);
	});

	/**
	 * sf#1054: a forge whose first dispatch POST may record a run and THEN throw
	 * (response lost), and whose runs listing returns the recorded runs.
	 */
	function landingForge(opts: {
		record?: { status: string; headSha?: string };
		older?: boolean;
		readThrows?: boolean;
		/** The first POST throws before recording; the retry records a run, then throws. */
		retryLands?: boolean;
	}) {
		const forge = fakeForge();
		const attempts: string[] = [];
		const runs: Record<string, unknown>[] = [];
		const run = (inputs: unknown, status: string, created: string) => ({
			id: runs.length + 1,
			workflow_id: PREPUSH_WORKFLOW_FILE,
			status,
			created,
			event_payload: JSON.stringify({ inputs }),
		});
		if (opts.older) {
			const created = new Date(Date.now() - 60_000).toISOString();
			runs.push(run({ repo: REPO, head_sha: HEAD }, "success", created));
		}
		const write: DispatchGuardWrite = async (_m, path, body) => {
			if (path === DISPATCH) {
				attempts.push(path);
				if (attempts.length === 1) {
					if (opts.record) {
						const inputs = (body as { inputs: Record<string, string> }).inputs;
						const recorded = { ...inputs, head_sha: opts.record.headSha ?? inputs.head_sha };
						runs.push(run(recorded, opts.record.status, new Date().toISOString()));
					}
					throw new Error("response lost");
				}
				if (opts.retryLands) {
					const inputs = (body as { inputs: Record<string, string> }).inputs;
					runs.push(run(inputs, "waiting", new Date().toISOString()));
					throw new Error("response lost");
				}
			}
			forge.posts.push({ path, body });
			return { status: 204, data: null, link: null, rateRemaining: null };
		};
		const read: DispatchGuardRead = async (url) => {
			if (url.includes("/actions/runs?event=workflow_dispatch&page=1&limit=50")) {
				if (opts.readThrows) {
					throw new Error("read down");
				}
				return { status: 200, data: { workflow_runs: runs }, link: null, rateRemaining: null };
			}
			return forge.read(url);
		};
		return { ...forge, write, read, attempts };
	}

	test("first POST lands a waiting run then throws: one attempt, no release", async () => {
		const forge = landingForge({ record: { status: "waiting" } });
		const s = seams(7);
		await createPrepushTrigger(forge.write, forge.read, CONFIG, s)(prDelivery());
		expect(forge.attempts).toHaveLength(1);
		expect(s.calls.release).toEqual([]);
	});

	test("first POST lands a run that already finished then throws: one attempt, no release", async () => {
		const forge = landingForge({ record: { status: "success" } });
		const s = seams(7);
		await createPrepushTrigger(forge.write, forge.read, CONFIG, s)(prDelivery());
		expect(forge.attempts).toHaveLength(1);
		expect(s.calls.release).toEqual([]);
	});

	test("an older matching run from before the first POST does not stop the retry", async () => {
		const forge = landingForge({ older: true });
		const s = seams(7);
		await createPrepushTrigger(forge.write, forge.read, CONFIG, s)(prDelivery());
		expect(forge.attempts).toHaveLength(2);
		expect(s.calls.release).toEqual([]);
	});

	test("a run landed for a different head sha does not stop the retry", async () => {
		const forge = landingForge({ record: { status: "waiting", headSha: "f".repeat(40) } });
		const s = seams(7);
		await createPrepushTrigger(forge.write, forge.read, CONFIG, s)(prDelivery());
		expect(forge.attempts).toHaveLength(2);
		expect(s.calls.release).toEqual([]);
	});

	test("the retry lands a run then throws: two attempts, no release (PR 1073 review)", async () => {
		const forge = landingForge({ retryLands: true });
		const s = seams(7);
		await createPrepushTrigger(forge.write, forge.read, CONFIG, s)(prDelivery());
		expect(forge.attempts).toHaveLength(2);
		expect(s.calls.release).toEqual([]);
	});

	test("a failed landed read still retries, and the retry succeeds", async () => {
		const forge = landingForge({ readThrows: true });
		const s = seams(7);
		await createPrepushTrigger(forge.write, forge.read, CONFIG, s)(prDelivery());
		expect(forge.attempts).toHaveLength(2);
		expect(forge.posts.filter((p) => p.path === DISPATCH)).toHaveLength(1);
		expect(s.calls.release).toEqual([]);
	});

	test("claim -> null: no POST", async () => {
		const forge = fakeForge();
		const s = seams(null);
		await createPrepushTrigger(forge.write, forge.read, CONFIG, s)(prDelivery());
		expect(s.calls.claim).toBe(1);
		expect(forge.posts.length).toBe(0);
	});

	test("claim -> id, POST ok: one POST and record is not called", async () => {
		const forge = fakeForge();
		const s = seams(7);
		await createPrepushTrigger(forge.write, forge.read, CONFIG, s)(prDelivery());
		expect(forge.posts.length).toBe(1);
		expect(s.calls.record).toBe(0);
		expect(s.calls.release).toEqual([]);
	});

	test("claim -> id, POST throws: release(id) once", async () => {
		const forge = flakyForge(Number.POSITIVE_INFINITY);
		const s = seams(7);
		await createPrepushTrigger(forge.write, forge.read, CONFIG, s)(prDelivery());
		expect(forge.attempts).toHaveLength(2);
		expect(s.calls.release).toEqual([7]);
		expect(s.calls.record).toBe(0);
	});

	test("claim throws: POST happens and record is called", async () => {
		const forge = fakeForge();
		const s = seams(new Error("db down"));
		await createPrepushTrigger(forge.write, forge.read, CONFIG, s)(prDelivery());
		expect(forge.posts.length).toBe(1);
		expect(s.calls.record).toBe(1);
	});

	test("claim throws and find reports a live dispatch: no POST (PR 1037 review)", async () => {
		const forge = fakeForge();
		const s = seams(new Error("db down"));
		await createPrepushTrigger(forge.write, forge.read, CONFIG, {
			...s,
			find: async () => 11,
		})(prDelivery());
		expect(forge.posts.length).toBe(0);
		expect(s.calls.record).toBe(0);
	});

	test("reopened never calls claim", async () => {
		const forge = fakeForge();
		const s = seams(null);
		await createPrepushTrigger(
			forge.write,
			forge.read,
			CONFIG,
			s,
		)(prDelivery({ action: "reopened" }));
		expect(s.calls.claim).toBe(0);
		expect(forge.posts.length).toBe(1);
		expect(s.calls.record).toBe(1);
	});
});
