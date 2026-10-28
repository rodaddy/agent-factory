/**
 * @module tests/reconcile/forge-runner-scale
 * @description Hermetic tests for the label-aware Forge runner band pass,
 *  driven entirely through faked deps -- no
 *   database, no gateway, no host. The policy under test is the retired
 *   `forge-runner-scaler.sh`, ported: members are grouped by identical label
 *   set, a waiting job counts only for a group holding every label it asks for,
 *   a group with no free member starts its lowest stopped member, and an idle
 *   member past `idle_minutes` is stopped highest-vmid-first after a fresh
 *   re-read of its Forge status.
 *
 *   The live shape that motivated the rewrite (2026-09-29): every waiting job
 *   carried labels no band runner had, and the old label-blind clamp would have
 *   scaled to cap on work no member could run.
 */
import { describe, expect, test } from "bun:test";
import { forgeRunnerFleetConfigSchema, type WatcherConfig } from "../../src/config/schema";
import type { ForgeClient } from "../../src/forge/boundary";
import {
	type ForgeRunnerScaleDeps,
	runForgeRunnerScale,
} from "../../src/reconcile/forge-runner-scale";
import { resolveForgeRunnerScaleDeps } from "../../src/reconcile/forge-runner-scale-resolve";
import { RunnerBandRefusedError } from "../../src/runner/transport";

const MINUTE = 60_000;
const T0 = 1_800_000_000_000;

/** A config carrying the fleet block, or omitting it entirely (the disabled case). */
function config(fleet?: Record<string, unknown>): WatcherConfig {
	const cfg: Record<string, unknown> = {
		poll_interval_minutes: 15,
		repositories: [
			{ name: "rodaddy/x", provider: "forgejo", checks: "standard", gate_selection: "full" },
		],
		job_templates: [],
		doorbell_enabled: false,
		shadow_publish: false,
	};
	if (fleet) {
		cfg.forge_runner_fleet = fleet;
	}
	return cfg as unknown as WatcherConfig;
}

const FLEET = { floor: 1, standby_label: "docker", cap: 10, idle_minutes: 20 };

/** One simulated band member: container power plus its Forge runner. */
type Sim = { vmid: number; running: boolean; forge: string; labels: string[]; status?: string };

const X = ["docker", "self-hosted"];
const Y = ["gpu", "self-hosted"];

/** A recording harness over the deps; start/stop mutate `sims`. */
function harness(args: {
	sims: Sim[];
	waiting?: string[][];
	now?: number;
	idleSince?: Map<number, number>;
	offlineSince?: Map<number, number>;
	readThrows?: boolean;
	reread?: Record<number, string>;
	unregistered?: number[];
	failStart?: number;
	failStop?: Error;
}) {
	const started: number[] = [];
	const stopped: number[] = [];
	const warns: string[] = [];
	const clock = { now: args.now ?? T0 };
	let calls = 0;
	const find = (vmid: number) => args.sims.find((s) => s.vmid === vmid);
	const deps: ForgeRunnerScaleDeps = {
		readForge: async () => {
			calls += 1;
			if (args.readThrows === true) {
				throw new Error("GET /admin/actions/runners -> 503");
			}
			return {
				waiting: (args.waiting ?? []).map((runs_on) => ({ runs_on })),
				runners: args.sims.map((s) => ({
					name: `forge-runner-${s.vmid}`,
					status: s.forge,
					labels: s.labels,
				})),
			};
		},
		listBand: async () => {
			calls += 1;
			return [
				...args.sims.map((s) => ({
					vmid: s.vmid,
					status: s.status ?? (s.running ? "running" : "absent"),
				})),
				...(args.unregistered ?? []).map((vmid) => ({ vmid, status: "absent" })),
			];
		},
		readRunnerStatus: async (vmid: number) => args.reread?.[vmid] ?? find(vmid)?.forge ?? null,
		startMember: async (vmid: number) => {
			if (args.failStart === vmid) {
				throw new Error("gateway refused");
			}
			started.push(vmid);
			const s = find(vmid);
			if (s) {
				s.running = true;
				s.forge = "offline";
			}
		},
		stopMember: async (vmid: number) => {
			if (args.failStop) {
				throw args.failStop;
			}
			stopped.push(vmid);
			const s = find(vmid);
			if (s) {
				s.running = false;
				s.forge = "offline";
			}
		},
		onWarn: (m: string) => warns.push(m),
		idleSince: args.idleSince ?? new Map(),
		offlineSince: args.offlineSince ?? new Map(),
		now: () => clock.now,
	};
	return {
		deps,
		started,
		stopped,
		warns,
		clock,
		get calls() {
			return calls;
		},
	};
}

describe("runForgeRunnerScale (label-aware)", () => {
	test("jobs whose labels no group satisfies start nothing", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "idle", labels: X },
				{ vmid: 9102, running: false, forge: "offline", labels: X },
			],
			waiting: [["ubuntu-latest"], ["ubuntu-24.04"], ["client-runner"]],
		});
		const outcome = await runForgeRunnerScale(config(FLEET), h.deps);
		expect(outcome).toEqual({ status: "ran", attempted: 0, applied: 0 });
		expect(h.started).toEqual([]);
		expect(h.stopped).toEqual([]);
	});

	test("a waiting job for group X with no free X member starts the lowest stopped X", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "active", labels: X },
				{ vmid: 9103, running: false, forge: "offline", labels: X },
				{ vmid: 9102, running: false, forge: "offline", labels: X },
				{ vmid: 9104, running: true, forge: "idle", labels: Y },
				{ vmid: 9105, running: false, forge: "offline", labels: Y },
			],
			// A subset of X's labels: satisfiable by X, not by Y.
			waiting: [["docker"]],
		});
		const outcome = await runForgeRunnerScale(config(FLEET), h.deps);
		expect(h.started).toEqual([9102]);
		expect(outcome).toEqual({ status: "ran", attempted: 1, applied: 1 });
	});

	test("a free member in the group means a waiting job starts nothing", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "idle", labels: X },
				{ vmid: 9102, running: false, forge: "offline", labels: X },
			],
			waiting: [["docker"]],
		});
		await runForgeRunnerScale(config(FLEET), h.deps);
		expect(h.started).toEqual([]);
	});

	test("only the standby_label group holds a floor; other groups drain to zero", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: false, forge: "offline", labels: X },
				{ vmid: 9102, running: false, forge: "offline", labels: X },
				{ vmid: 9103, running: false, forge: "offline", labels: Y },
				{ vmid: 9104, running: true, forge: "idle", labels: ["solo"] },
			],
			idleSince: new Map([[9104, T0 - 60 * MINUTE]]),
		});
		await runForgeRunnerScale(config(FLEET), h.deps);
		// X carries the standby label: one up. Y has floor 0: nothing comes up.
		expect(h.started).toEqual([9101]);
		// "solo" has floor 0, so its long-idle lone member goes down.
		expect(h.stopped).toEqual([9104]);
	});

	test("idle shorter than idle_minutes keeps the member", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "idle", labels: X },
				{ vmid: 9102, running: true, forge: "idle", labels: X },
			],
			idleSince: new Map([
				[9101, T0 - 19 * MINUTE],
				[9102, T0 - 19 * MINUTE],
			]),
		});
		await runForgeRunnerScale(config(FLEET), h.deps);
		expect(h.stopped).toEqual([]);
	});

	test("idle >= idle_minutes and re-read idle stops ONE member, highest vmid first", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "idle", labels: X },
				{ vmid: 9102, running: true, forge: "idle", labels: X },
				{ vmid: 9103, running: true, forge: "idle", labels: X },
			],
			idleSince: new Map([
				[9101, T0 - 25 * MINUTE],
				[9102, T0 - 25 * MINUTE],
				[9103, T0 - 25 * MINUTE],
			]),
		});
		const outcome = await runForgeRunnerScale(config(FLEET), h.deps);
		expect(h.stopped).toEqual([9103]);
		expect(outcome).toEqual({ status: "ran", attempted: 1, applied: 1 });
	});

	test("a member re-read as active right before the stop is skipped", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "idle", labels: X },
				{ vmid: 9102, running: true, forge: "idle", labels: X },
				{ vmid: 9103, running: true, forge: "idle", labels: X },
			],
			idleSince: new Map([
				[9102, T0 - 25 * MINUTE],
				[9103, T0 - 25 * MINUTE],
			]),
			reread: { 9103: "active" },
		});
		await runForgeRunnerScale(config(FLEET), h.deps);
		expect(h.stopped).not.toContain(9103);
		expect(h.stopped).toEqual([9102]);
	});

	test("idle-since is recorded on first sight and a later pass stops on it", async () => {
		const idleSince = new Map<number, number>();
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "idle", labels: X },
				{ vmid: 9102, running: true, forge: "idle", labels: X },
			],
			idleSince,
		});
		await runForgeRunnerScale(config(FLEET), h.deps);
		expect(h.stopped).toEqual([]);
		expect(idleSince.get(9102)).toBe(T0);
		h.clock.now = T0 + 20 * MINUTE;
		await runForgeRunnerScale(config(FLEET), h.deps);
		expect(h.stopped).toEqual([9102]);
	});

	test("a waiting job for the group blocks every stop", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "active", labels: X },
				{ vmid: 9102, running: true, forge: "idle", labels: X },
			],
			waiting: [["docker"]],
			idleSince: new Map([[9102, T0 - 60 * MINUTE]]),
		});
		await runForgeRunnerScale(config(FLEET), h.deps);
		expect(h.stopped).toEqual([]);
	});

	test("a failed Forge admin read skips the pass with zero actions", async () => {
		const h = harness({
			sims: [{ vmid: 9101, running: false, forge: "offline", labels: X }],
			readThrows: true,
		});
		const outcome = await runForgeRunnerScale(config(FLEET), h.deps);
		expect(outcome.status).toBe("skipped");
		expect(h.started).toEqual([]);
		expect(h.warns.length).toBe(1);
	});

	test("a listed band vmid with no registered runner is ignored with one warning", async () => {
		const h = harness({
			sims: [{ vmid: 9101, running: false, forge: "offline", labels: X }],
			unregistered: [9110, 9111],
		});
		await runForgeRunnerScale(config(FLEET), h.deps);
		expect(h.started).toEqual([9101]);
		const unreg = h.warns.filter((w) => w.includes("no registered runner"));
		expect(unreg.length).toBe(1);
		expect(unreg[0]).toContain("9110");
	});

	test("total starts stop at the cap", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "active", labels: X },
				{ vmid: 9102, running: false, forge: "offline", labels: X },
				{ vmid: 9103, running: false, forge: "offline", labels: Y },
			],
			waiting: [["docker"]],
		});
		await runForgeRunnerScale(config({ ...FLEET, cap: 1 }), h.deps);
		expect(h.started).toEqual([]);
	});

	test("a start that throws is warned and counted as attempted, not applied", async () => {
		const h = harness({
			sims: [{ vmid: 9101, running: false, forge: "offline", labels: X }],
			failStart: 9101,
		});
		const outcome = await runForgeRunnerScale(config(FLEET), h.deps);
		expect(outcome).toEqual({ status: "ran", attempted: 1, applied: 0 });
		expect(h.warns.some((w) => w.includes("9101"))).toBe(true);
	});

	test("an absent config block disables the pass and calls no dependency", async () => {
		const h = harness({ sims: [{ vmid: 9101, running: false, forge: "offline", labels: X }] });
		expect(await runForgeRunnerScale(config(), h.deps)).toEqual({ status: "disabled" });
		expect(h.calls).toBe(0);
	});
});

describe("runForgeRunnerScale (ephemeral slots, one warm standby)", () => {
	const GATE = ["forgejo-mvp"];
	const GEN = ["docker-bun"];
	const EPH = {
		floor: 1,
		standby_label: "forgejo-mvp",
		cap: 10,
		idle_minutes: 3,
		slots: [9106, 9107, 9108, 9109, 9110],
	};

	test("2. standby held: one idle gate member and nothing waiting is not taken down", async () => {
		const h = harness({
			sims: [{ vmid: 9109, running: true, forge: "idle", labels: GATE }],
			idleSince: new Map([[9109, T0 - 10 * MINUTE]]),
		});
		const outcome = await runForgeRunnerScale(config(EPH), h.deps);
		expect(h.stopped).toEqual([]);
		expect(outcome).toEqual({ status: "ran", attempted: 0, applied: 0 });
	});

	test("3. standby replaced: the gate member went active, so the next slot comes up", async () => {
		const h = harness({
			sims: [
				{ vmid: 9109, running: true, forge: "active", labels: GATE },
				{ vmid: 9110, running: false, forge: "offline", labels: GATE },
			],
		});
		await runForgeRunnerScale(config(EPH), h.deps);
		expect(h.started).toEqual([9110]);
	});

	test("4. burst: two waiting gate jobs over one free member bring a slot up", async () => {
		const h = harness({
			sims: [
				{ vmid: 9109, running: true, forge: "idle", labels: GATE },
				{ vmid: 9110, running: false, forge: "offline", labels: GATE },
			],
			waiting: [["forgejo-mvp"], ["forgejo-mvp"]],
		});
		await runForgeRunnerScale(config(EPH), h.deps);
		expect(h.started).toEqual([9110]);
	});

	test("5. burst drains: the highest idle extra goes down, the lowest stays as standby", async () => {
		const h = harness({
			sims: [
				{ vmid: 9109, running: true, forge: "idle", labels: GATE },
				{ vmid: 9110, running: true, forge: "idle", labels: GATE },
			],
			idleSince: new Map([
				[9109, T0 - 5 * MINUTE],
				[9110, T0 - 5 * MINUTE],
			]),
		});
		await runForgeRunnerScale(config(EPH), h.deps);
		expect(h.stopped).toEqual([9110]);
		expect(h.started).toEqual([]);
	});

	test("6. a non-standby group has floor 0: its idle member goes down", async () => {
		const h = harness({
			sims: [{ vmid: 9106, running: true, forge: "idle", labels: GEN }],
			idleSince: new Map([[9106, T0 - 5 * MINUTE]]),
		});
		await runForgeRunnerScale(config(EPH), h.deps);
		expect(h.stopped).toEqual([9106]);
	});

	test("7. a running member offline past idle_minutes is dead and taken down", async () => {
		const h = harness({
			sims: [{ vmid: 9107, running: true, forge: "offline", labels: GEN }],
			offlineSince: new Map([[9107, T0 - 5 * MINUTE]]),
		});
		const outcome = await runForgeRunnerScale(config(EPH), h.deps);
		expect(h.stopped).toEqual([9107]);
		expect(outcome).toEqual({ status: "ran", attempted: 1, applied: 1 });
	});

	test("7c. at cap, reaping a dead standby frees room: its replacement comes up in the same pass", async () => {
		const h = harness({
			sims: [
				{ vmid: 9109, running: true, forge: "offline", labels: GATE },
				{ vmid: 9110, running: false, forge: "offline", labels: GATE },
			],
			offlineSince: new Map([[9109, T0 - 5 * MINUTE]]),
		});
		const outcome = await runForgeRunnerScale(config({ ...EPH, cap: 1 }), h.deps);
		expect(h.stopped).toEqual([9109]);
		expect(h.started).toEqual([9110]);
		expect(outcome).toEqual({ status: "ran", attempted: 2, applied: 2 });
	});

	test("7b. offline for less than idle_minutes is booting: it counts free, no action", async () => {
		const h = harness({
			sims: [
				{ vmid: 9109, running: true, forge: "offline", labels: GATE },
				{ vmid: 9110, running: false, forge: "offline", labels: GATE },
			],
			offlineSince: new Map([[9109, T0 - 1 * MINUTE]]),
		});
		const outcome = await runForgeRunnerScale(config(EPH), h.deps);
		expect(h.started).toEqual([]);
		expect(h.stopped).toEqual([]);
		expect(outcome).toEqual({ status: "ran", attempted: 0, applied: 0 });
	});

	test("7d. dead_minutes splits the graces: idle 5m is kept, offline 5m is reaped (SOF-11439)", async () => {
		const h = harness({
			sims: [
				{ vmid: 9106, running: true, forge: "idle", labels: GEN },
				{ vmid: 9107, running: true, forge: "offline", labels: GEN },
			],
			idleSince: new Map([[9106, T0 - 5 * MINUTE]]),
			offlineSince: new Map([[9107, T0 - 5 * MINUTE]]),
		});
		const outcome = await runForgeRunnerScale(
			config({ ...EPH, idle_minutes: 12, dead_minutes: 3 }),
			h.deps,
		);
		expect(h.stopped).toEqual([9107]);
		expect(outcome).toEqual({ status: "ran", attempted: 1, applied: 1 });
	});

	test("7e. without dead_minutes the dead grace is idle_minutes: offline 5m of 12 is still booting", async () => {
		const h = harness({
			sims: [{ vmid: 9107, running: true, forge: "offline", labels: GEN }],
			offlineSince: new Map([[9107, T0 - 5 * MINUTE]]),
		});
		const outcome = await runForgeRunnerScale(config({ ...EPH, idle_minutes: 12 }), h.deps);
		expect(h.stopped).toEqual([]);
		expect(outcome).toEqual({ status: "ran", attempted: 0, applied: 0 });
	});

	test("8. slots filter: a listed vmid outside fleet.slots is never acted on", async () => {
		const h = harness({
			sims: [
				{ vmid: 9104, running: false, forge: "offline", labels: GATE },
				{ vmid: 9109, running: false, forge: "offline", labels: GATE },
			],
		});
		await runForgeRunnerScale(config(EPH), h.deps);
		expect(h.started).toEqual([9109]);
		await runForgeRunnerScale(config(EPH), h.deps);
		expect(h.started).not.toContain(9104);
		expect(h.stopped).not.toContain(9104);
	});

	test("9. an unknown slot is never acted on", async () => {
		const h = harness({
			sims: [
				{ vmid: 9109, running: false, forge: "offline", labels: GATE, status: "unknown" },
				{ vmid: 9110, running: false, forge: "idle", labels: GATE, status: "unknown" },
			],
			idleSince: new Map([[9110, T0 - 60 * MINUTE]]),
		});
		const outcome = await runForgeRunnerScale(config(EPH), h.deps);
		expect(h.started).toEqual([]);
		expect(h.stopped).toEqual([]);
		expect(outcome).toEqual({ status: "ran", attempted: 0, applied: 0 });
	});

	test("10. a down refused busy is a warn and a keep, and the pass continues", async () => {
		const h = harness({
			sims: [
				{ vmid: 9106, running: true, forge: "idle", labels: GEN },
				{ vmid: 9109, running: false, forge: "offline", labels: GATE },
			],
			idleSince: new Map([[9106, T0 - 5 * MINUTE]]),
			failStop: new RunnerBandRefusedError("runner_forge_down refused -- refused: busy"),
		});
		const outcome = await runForgeRunnerScale(config(EPH), h.deps);
		expect(h.stopped).toEqual([]);
		expect(h.warns.filter((w) => w.includes("9106")).length).toBe(1);
		expect(h.started).toEqual([9109]);
		expect(outcome).toEqual({ status: "ran", attempted: 2, applied: 1 });
	});
});

/** A fake Forgejo client answering the two admin reads. */
function fakeClient(routes: Record<string, { status: number; data: unknown }>): ForgeClient {
	return {
		get: async (path: string) => {
			const r = routes[path];
			if (!r) {
				throw new Error(`unexpected GET ${path}`);
			}
			return { ...r, link: null, rateRemaining: null };
		},
	} as unknown as ForgeClient;
}

describe("resolveForgeRunnerScaleDeps", () => {
	const RUNNERS = [
		{ name: "forge-runner-9101", status: "idle", labels: [{ name: "self-hosted" }, "docker"] },
	];
	const JOBS = [
		{ status: "waiting", runs_on: ["docker"] },
		{ status: "running", runs_on: ["docker"] },
	];

	function resolved(routes: Record<string, { status: number; data: unknown }>) {
		return resolveForgeRunnerScaleDeps(config(FLEET), {
			clientFor: async () => fakeClient(routes),
			listBand: async () => [{ vmid: 9101, status: "running" }],
			startMember: async () => undefined,
			stopMember: async () => undefined,
		});
	}

	test("keeps waiting jobs only and normalises {name} labels to strings", async () => {
		const snap = await resolved({
			"/admin/runners/jobs": { status: 200, data: JOBS },
			"/admin/actions/runners": { status: 200, data: RUNNERS },
		}).readForge();
		expect(snap.waiting).toEqual([{ runs_on: ["docker"] }]);
		expect(snap.runners[0]?.labels).toEqual(["self-hosted", "docker"]);
	});

	test("a non-200 admin read makes the whole pass skipped", async () => {
		const deps = resolved({
			"/admin/runners/jobs": { status: 200, data: JOBS },
			"/admin/actions/runners": { status: 403, data: { message: "forbidden" } },
		});
		expect((await runForgeRunnerScale(config(FLEET), deps)).status).toBe("skipped");
	});

	test("1. suffixed runner labels are normalised, so a bare runs_on finds its group", async () => {
		const started: number[] = [];
		const deps = resolveForgeRunnerScaleDeps(config(FLEET), {
			clientFor: async () =>
				fakeClient({
					"/admin/runners/jobs": {
						status: 200,
						data: [{ status: "waiting", runs_on: ["forgejo-mvp"] }],
					},
					"/admin/actions/runners": {
						status: 200,
						data: [9109, 9110].map((v) => ({
							name: `forge-runner-${v}`,
							status: "offline",
							labels: ["forgejo-mvp:docker://node:20-bookworm"],
						})),
					},
				}),
			listBand: async () => [
				{ vmid: 9109, status: "absent" },
				{ vmid: 9110, status: "absent" },
			],
			startMember: async (v) => {
				started.push(v);
			},
			stopMember: async () => undefined,
		});
		const fleet = { floor: 1, standby_label: "forgejo-mvp", cap: 10, idle_minutes: 3 };
		await runForgeRunnerScale(config(fleet), deps);
		expect(started).toEqual([9109]);
		expect((await deps.readForge()).runners[0]?.labels).toEqual(["forgejo-mvp"]);
	});

	test("readRunnerStatus re-reads the runner by name", async () => {
		const deps = resolved({
			"/admin/runners/jobs": { status: 200, data: [] },
			"/admin/actions/runners": { status: 200, data: RUNNERS },
		});
		expect(await deps.readRunnerStatus(9101)).toBe("idle");
		expect(await deps.readRunnerStatus(9102)).toBeNull();
	});
});

describe("runForgeRunnerScale (standing 9101, demand counted once)", () => {
	const GEN = ["docker", "self-hosted"];
	const GATE = ["forgejo-mvp", "forgejo-triage"];
	const BOTH = [...GEN, ...GATE];
	const STANDING = {
		floor: 0,
		standby_label: "forgejo-mvp",
		cap: 10,
		idle_minutes: 3,
		standing: 9101,
	};

	test("S1. an absent standing slot is brought up with nothing waiting", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: false, forge: "offline", labels: BOTH },
				{ vmid: 9109, running: false, forge: "offline", labels: GATE },
			],
		});
		await runForgeRunnerScale(config(STANDING), h.deps);
		expect(h.started).toEqual([9101]);
	});

	test("S2. an idle standing slot past idle_minutes is never taken down", async () => {
		const h = harness({
			sims: [{ vmid: 9101, running: true, forge: "idle", labels: BOTH }],
			idleSince: new Map([[9101, T0 - 60 * MINUTE]]),
		});
		await runForgeRunnerScale(config(STANDING), h.deps);
		expect(h.stopped).toEqual([]);
	});

	test("S3. a dead standing slot is warned about and never taken down", async () => {
		const h = harness({
			sims: [{ vmid: 9101, running: true, forge: "offline", labels: BOTH }],
			offlineSince: new Map([[9101, T0 - 60 * MINUTE]]),
		});
		await runForgeRunnerScale(config(STANDING), h.deps);
		expect(h.stopped).toEqual([]);
		expect(h.started).toEqual([]);
		expect(h.warns.some((w) => w.includes("standing vmid 9101"))).toBe(true);
	});

	test("S4. an idle standing slot takes a waiting gate job: no burst slot", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "idle", labels: BOTH },
				{ vmid: 9109, running: false, forge: "offline", labels: GATE },
				{ vmid: 9110, running: false, forge: "offline", labels: GATE },
			],
			waiting: [["forgejo-mvp"]],
		});
		await runForgeRunnerScale(config(STANDING), h.deps);
		expect(h.started).toEqual([]);
	});

	test("S5. two gate jobs over an idle standing slot bring exactly one gate slot up", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "idle", labels: BOTH },
				{ vmid: 9109, running: false, forge: "offline", labels: GATE },
				{ vmid: 9110, running: false, forge: "offline", labels: GATE },
			],
			waiting: [["forgejo-mvp"], ["forgejo-mvp"]],
		});
		await runForgeRunnerScale(config(STANDING), h.deps);
		expect(h.started).toEqual([9109]);
	});

	test("S5b. the large slot comes up only for a large job, never for gate demand (PR 1103 review)", async () => {
		const LARGE = ["forgejo-mvp-large", "forgejo-triage-large"];
		const sims = () => [
			{ vmid: 9101, running: true, forge: "active" as const, labels: BOTH },
			{ vmid: 9111, running: false, forge: "offline" as const, labels: LARGE },
		];
		const gate = harness({ sims: sims(), waiting: [["forgejo-mvp"]] });
		await runForgeRunnerScale(config(STANDING), gate.deps);
		expect(gate.started).toEqual([]);
		const large = harness({ sims: sims(), waiting: [["forgejo-mvp-large"]] });
		await runForgeRunnerScale(config(STANDING), large.deps);
		expect(large.started).toEqual([9111]);
	});

	test("S6. a busy standing slot and one gate job bring a gate slot up", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "active", labels: BOTH },
				{ vmid: 9109, running: false, forge: "offline", labels: GATE },
				{ vmid: 9110, running: false, forge: "offline", labels: GATE },
			],
			waiting: [["forgejo-mvp"]],
		});
		await runForgeRunnerScale(config(STANDING), h.deps);
		expect(h.started).toEqual([9109]);
	});

	test("S7. a burst drains back to the standing slot", async () => {
		const h = harness({
			sims: [
				{ vmid: 9101, running: true, forge: "idle", labels: BOTH },
				{ vmid: 9109, running: true, forge: "idle", labels: GATE },
			],
			idleSince: new Map([
				[9101, T0 - 60 * MINUTE],
				[9109, T0 - 60 * MINUTE],
			]),
		});
		await runForgeRunnerScale(config(STANDING), h.deps);
		expect(h.stopped).toEqual([9109]);
	});

	test("S8. schema: standing with floor 1 is refused, standing outside slots is refused, a valid block parses", () => {
		expect(forgeRunnerFleetConfigSchema.safeParse({ floor: 1, standing: 9101 }).success).toBe(
			false,
		);
		expect(
			forgeRunnerFleetConfigSchema.safeParse({ floor: 0, standing: 9101, slots: [9106] }).success,
		).toBe(false);
		expect(
			forgeRunnerFleetConfigSchema.safeParse({ floor: 0, standing: 9101, slots: [9101, 9109] })
				.success,
		).toBe(true);
	});
});
