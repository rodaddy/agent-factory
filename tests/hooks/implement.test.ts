import { describe, expect, test } from "bun:test";
import type { DispatchGuardRead, DispatchGuardWrite } from "../../src/hooks/dispatch-guard";
import type { DispatchQuery, DispatchRecord } from "../../src/forge/actions-store";
import { createImplementTrigger } from "../../src/hooks/implement";

const REPO = "rtech/some-app";
const LABEL = "factory-implement";
const BASE = "a".repeat(40);
const CONFIG = [
	{
		name: REPO,
		provider: "forgejo" as const,
		implement_label: LABEL,
		implement_runtime: "actions" as const,
	},
	{ name: "rtech/box-runtime", provider: "forgejo" as const, implement_label: LABEL },
	{
		name: "rtech/box-explicit",
		provider: "forgejo" as const,
		implement_label: LABEL,
		implement_runtime: "box" as const,
	},
	{ name: "rtech/no-label", provider: "forgejo" as const, implement_runtime: "actions" as const },
	{
		name: "rodaddy/on-github",
		provider: "github" as const,
		implement_label: LABEL,
		implement_runtime: "actions" as const,
	},
	{
		name: "rodaddy/software-factory",
		provider: "forgejo" as const,
		implement_label: LABEL,
		implement_runtime: "actions" as const,
	},
];
const DISPATCH =
	"https://forge.example.internal/api/v1/repos/rodaddy/software-factory/actions/workflows/implement.yml/dispatches";

/** A fake Forge: records writes; answers the default-branch reads; lists no runs. */
function fakeForge(baseSha = BASE) {
	const posts: { path: string; body: unknown }[] = [];
	const reads: string[] = [];
	const read: DispatchGuardRead = async (path) => {
		reads.push(path);
		if (path.endsWith(`/repos/${REPO}`)) {
			return { status: 200, data: { default_branch: "trunk" }, link: null, rateRemaining: null };
		}
		if (path.endsWith(`/repos/${REPO}/branches/trunk`)) {
			return { status: 200, data: { commit: { id: baseSha } }, link: null, rateRemaining: null };
		}
		return { status: 200, data: { workflow_runs: [] }, link: null, rateRemaining: null };
	};
	const write: DispatchGuardWrite = async (_method, path, body) => {
		posts.push({ path, body });
		return { status: 204, data: null, link: null, rateRemaining: null };
	};
	return { read, write, posts, reads };
}

function issueDelivery(
	overrides: {
		repository?: string;
		action?: string;
		labels?: string[];
		event?: string;
		state?: string;
	} = {},
) {
	return {
		repository: overrides.repository ?? REPO,
		event: overrides.event ?? "issues",
		payload: {
			action: overrides.action ?? "labeled",
			issue: {
				number: 7,
				state: overrides.state ?? "open",
				labels: (overrides.labels ?? [LABEL]).map((name) => ({ name })),
			},
			// A payload-supplied sha must never become base_sha.
			after: "b".repeat(40),
		},
	};
}

describe("implement dispatch", () => {
	test("an actions-runtime Forgejo repo's labelled issue dispatches implement.yml with the read-seam base and records it on the host repo", async () => {
		for (const action of ["opened", "labeled"]) {
			const forge = fakeForge();
			const records: unknown[] = [];
			const trigger = createImplementTrigger(forge.write, forge.read, CONFIG, {
				record: async (rec) => {
					records.push(rec);
				},
			});
			await trigger(issueDelivery({ action }));
			const inputs = { repo: REPO, number: "7", base_sha: BASE, log_level: "info" };
			expect(forge.posts).toEqual([{ path: DISPATCH, body: { ref: "main", inputs } }]);
			expect(forge.reads).toContain(
				`https://forge.example.internal/api/v1/repos/${REPO}/branches/trunk`,
			);
			expect(records).toEqual([
				{
					repo: "rodaddy/software-factory",
					workflow: "implement.yml",
					runId: null,
					targetSha: BASE,
					inputs,
				},
			]);
		}
	});

	test("nothing dispatches for box/absent runtime, no label, a github repo, or software-factory itself", async () => {
		const forge = fakeForge();
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG);
		await trigger(issueDelivery({ repository: "rtech/box-runtime" }));
		await trigger(issueDelivery({ repository: "rtech/box-explicit" }));
		await trigger(issueDelivery({ repository: "rtech/no-label" }));
		await trigger(issueDelivery({ repository: "rodaddy/on-github" }));
		await trigger(issueDelivery({ repository: "rodaddy/software-factory" }));
		await trigger(issueDelivery({ labels: ["bug", "factory-implement-x"] }));
		await trigger(issueDelivery({ action: "closed" }));
		await trigger(issueDelivery({ event: "pull_request" }));
		expect(forge.posts).toEqual([]);
	});

	test("an unresolvable base sha dispatches nothing and never rejects", async () => {
		const forge = fakeForge("not-a-sha");
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG);
		await trigger(issueDelivery());
		expect(forge.posts).toEqual([]);
	});

	test("a repeated label_updated delivery at the same base dispatches once; a new base dispatches again (826b34)", async () => {
		const records: DispatchRecord[] = [];
		const options = {
			record: async (rec: DispatchRecord) => {
				records.push(rec);
			},
			find: async (query: DispatchQuery) =>
				records.some(
					(rec) =>
						rec.repo === query.repo &&
						rec.workflow === query.workflow &&
						rec.targetSha === query.targetSha &&
						rec.inputs.repo === query.inputs.repo &&
						rec.inputs.number === query.inputs.number,
				)
					? 1
					: null,
		};
		const first = fakeForge();
		const trigger = createImplementTrigger(first.write, first.read, CONFIG, options);
		await trigger(issueDelivery({ action: "label_updated" }));
		await trigger(issueDelivery({ action: "label_updated" }));
		expect(first.posts).toHaveLength(1);

		const moved = fakeForge("c".repeat(40));
		const again = createImplementTrigger(moved.write, moved.read, CONFIG, options);
		await again(issueDelivery({ action: "label_updated" }));
		expect(moved.posts).toHaveLength(1);
		expect(records.map((rec) => rec.targetSha)).toEqual([BASE, "c".repeat(40)]);
	});

	test("a closed labelled issue dispatches nothing (826b34)", async () => {
		const forge = fakeForge();
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG);
		for (const action of ["opened", "labeled", "label_updated"]) {
			await trigger(issueDelivery({ action, state: "closed" }));
		}
		expect(forge.posts).toEqual([]);
	});
});

describe("implement atomic claim", () => {
	const failingForge = () => {
		const forge = fakeForge();
		const write: DispatchGuardWrite = async (_m, path, body) => {
			forge.posts.push({ path, body });
			throw new Error("forge down");
		};
		return { ...forge, write };
	};
	/** The first `failures` dispatch POSTs throw; later ones succeed. */
	const flakyForge = (failures: number) => {
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
	};
	/** An in-memory claim that is atomic in JS: one holder per key until released. */
	const heldClaim = () => {
		const held = new Map<number, string>();
		const released: number[] = [];
		let next = 1;
		return {
			held,
			released,
			claim: async (rec: DispatchRecord, match: Record<string, string>) => {
				const key = `${rec.targetSha}:${match.repo}:${match.number}`;
				if ([...held.values()].includes(key)) {
					return null;
				}
				const id = next++;
				held.set(id, key);
				return id;
			},
			release: async (id: number) => {
				released.push(id);
				held.delete(id);
			},
		};
	};

	test("two concurrent deliveries, winner's first POST fails: the head still gets exactly one dispatch", async () => {
		const forge = flakyForge(1);
		const c = heldClaim();
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG, {
			claim: c.claim,
			release: c.release,
		});
		await Promise.all([
			trigger(issueDelivery({ action: "opened" })),
			trigger(issueDelivery({ event: "issue_label", action: "label_updated" })),
		]);
		expect(forge.posts.filter((p) => p.path === DISPATCH)).toHaveLength(1);
		expect(forge.attempts).toHaveLength(2);
		expect(c.released).toEqual([]);
		expect(c.held.size).toBe(1);
	});

	test("POST throws twice: two attempts, then release(id) once", async () => {
		const forge = flakyForge(2);
		const released: number[] = [];
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG, {
			claim: async () => 42,
			release: async (id) => {
				released.push(id);
			},
		});
		await trigger(issueDelivery());
		expect(forge.attempts).toHaveLength(2);
		expect(forge.posts.filter((p) => p.path === DISPATCH)).toHaveLength(0);
		expect(released).toEqual([42]);
	});

	/**
	 * sf#1054: a forge whose first dispatch POST may record a run and THEN throw
	 * (response lost), and whose runs listing returns the recorded runs.
	 */
	const landingForge = (opts: {
		record?: { status: string; number?: string };
		older?: boolean;
		readThrows?: boolean;
		/** The first POST throws before recording; the retry records a run, then throws. */
		retryLands?: boolean;
	}) => {
		const forge = fakeForge();
		const attempts: string[] = [];
		const runs: Record<string, unknown>[] = [];
		const run = (inputs: unknown, status: string, created: string) => ({
			id: runs.length + 1,
			workflow_id: "implement.yml",
			status,
			created,
			event_payload: JSON.stringify({ inputs }),
		});
		if (opts.older) {
			const created = new Date(Date.now() - 60_000).toISOString();
			runs.push(run({ repo: REPO, number: "7", base_sha: BASE }, "success", created));
		}
		const write: DispatchGuardWrite = async (_m, path, body) => {
			if (path === DISPATCH) {
				attempts.push(path);
				if (attempts.length === 1) {
					if (opts.record) {
						const inputs = (body as { inputs: Record<string, string> }).inputs;
						const recorded = { ...inputs, number: opts.record.number ?? inputs.number };
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
	};
	const runLanding = async (forge: ReturnType<typeof landingForge>) => {
		const released: number[] = [];
		await createImplementTrigger(forge.write, forge.read, CONFIG, {
			claim: async () => 42,
			release: async (id) => {
				released.push(id);
			},
		})(issueDelivery());
		return released;
	};

	test("first POST lands a waiting run then throws: one attempt, no release", async () => {
		const forge = landingForge({ record: { status: "waiting" } });
		expect(await runLanding(forge)).toEqual([]);
		expect(forge.attempts).toHaveLength(1);
	});

	test("first POST lands a run that already finished then throws: one attempt, no release", async () => {
		const forge = landingForge({ record: { status: "success" } });
		expect(await runLanding(forge)).toEqual([]);
		expect(forge.attempts).toHaveLength(1);
	});

	test("an older matching run from before the first POST does not stop the retry", async () => {
		const forge = landingForge({ older: true });
		expect(await runLanding(forge)).toEqual([]);
		expect(forge.attempts).toHaveLength(2);
	});

	test("a run landed for a different issue number does not stop the retry", async () => {
		const forge = landingForge({ record: { status: "waiting", number: "8" } });
		expect(await runLanding(forge)).toEqual([]);
		expect(forge.attempts).toHaveLength(2);
	});

	test("the retry lands a run then throws: two attempts, no release (PR 1073 review)", async () => {
		const forge = landingForge({ retryLands: true });
		expect(await runLanding(forge)).toEqual([]);
		expect(forge.attempts).toHaveLength(2);
	});

	test("a failed landed read still retries, and the retry succeeds", async () => {
		const forge = landingForge({ readThrows: true });
		expect(await runLanding(forge)).toEqual([]);
		expect(forge.attempts).toHaveLength(2);
		expect(forge.posts.filter((p) => p.path === DISPATCH)).toHaveLength(1);
	});

	test("claim -> null dispatches nothing", async () => {
		const forge = fakeForge();
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG, {
			claim: async () => null,
			release: async () => undefined,
		});
		await trigger(issueDelivery());
		expect(forge.posts).toHaveLength(0);
	});

	test("claim -> id and POST ok: one POST, no record; match keys are repo and number", async () => {
		const forge = fakeForge();
		const records: unknown[] = [];
		const claims: [DispatchRecord, Record<string, string>][] = [];
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG, {
			record: async (rec) => {
				records.push(rec);
			},
			claim: async (rec, match) => {
				claims.push([rec, match]);
				return 11;
			},
		});
		await trigger(issueDelivery());
		expect(forge.posts).toHaveLength(1);
		expect(records).toHaveLength(0);
		expect(claims[0]?.[1]).toEqual({ repo: REPO, number: "7" });
		expect(claims[0]?.[0].workflow).toBe("implement.yml");
		expect(claims[0]?.[0].targetSha).toBe(BASE);
	});

	test("a failed POST releases the claim once", async () => {
		const forge = failingForge();
		const released: number[] = [];
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG, {
			claim: async () => 42,
			release: async (id) => {
				released.push(id);
			},
		});
		await trigger(issueDelivery());
		expect(forge.posts.filter((p) => p.path === DISPATCH)).toHaveLength(2);
		expect(released).toEqual([42]);
	});

	test("a thrown claim falls back to POST and record", async () => {
		const forge = fakeForge();
		const records: unknown[] = [];
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG, {
			record: async (rec) => {
				records.push(rec);
			},
			claim: async () => {
				throw new Error("db down");
			},
		});
		await trigger(issueDelivery());
		expect(forge.posts).toHaveLength(1);
		expect(records).toHaveLength(1);
	});

	test("claim throws and find reports a live dispatch: no POST (PR 1037 review)", async () => {
		const forge = fakeForge();
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG, {
			find: async () => 11,
			claim: async () => {
				throw new Error("db down");
			},
		});
		await trigger(issueDelivery());
		expect(forge.posts).toHaveLength(0);
	});

	test("opened then label_updated for one issue dispatches exactly once", async () => {
		const forge = fakeForge();
		const held = new Set<string>();
		const claims: Array<number | null> = [];
		const released: number[] = [];
		let next = 1;
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG, {
			claim: async (rec, match) => {
				const key = `${rec.targetSha}:${match.repo}:${match.number}`;
				const id = held.has(key) ? null : next++;
				held.add(key);
				claims.push(id);
				return id;
			},
			release: async (id) => {
				released.push(id);
			},
		});
		await Promise.all([
			trigger(issueDelivery({ action: "opened" })),
			trigger(issueDelivery({ event: "issue_label", action: "label_updated" })),
		]);
		// Both deliveries reached the claim (PR 1040 review): one won, one lost,
		// in either order; the winner's claim is kept after its POST succeeds.
		expect(claims).toHaveLength(2);
		expect(claims).toContain(1);
		expect(claims).toContain(null);
		expect(released).toEqual([]);
		expect(forge.posts).toHaveLength(1);
	});

	test("label_updated alone claims and dispatches", async () => {
		const forge = fakeForge();
		const claims: Array<Record<string, string>> = [];
		const trigger = createImplementTrigger(forge.write, forge.read, CONFIG, {
			claim: async (_rec, match) => {
				claims.push(match);
				return 7;
			},
			release: async () => undefined,
		});
		await trigger(issueDelivery({ event: "issue_label", action: "label_updated" }));
		expect(claims).toHaveLength(1);
		expect(forge.posts).toHaveLength(1);
	});
});
