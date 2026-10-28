/**
 * SOF-10517 (2026-10-07): the band scaler runs only when a reconcile pass runs,
 * and a pass ran early only for a MANAGED-repo webhook or the build-bump / OOM
 * follow-through. From 15:02 to 16:00Z only unmanaged repos (rtech-consulting,
 * social-media-pipeline, ...) queued self-hosted CI, every delivery logged
 * `woken=false`, the passes fell back to the 15-minute sweep, and
 * ForgeCIQueueWait [self-hosted] fired at a p90 of 97 s.
 *
 * The fix is a third follow-through predicate: while the band has demand it can
 * serve, or a slot beyond the standing one is up, the next pass runs 20 s out.
 */
import { afterEach, describe, expect, test } from "bun:test";
import type { WatcherConfig } from "../../src/config/schema";
import { forgeBandBusy, noteForgeBandBusy } from "../../src/reconcile/band-busy";
import { passFollowThroughDelay } from "../../src/reconcile/follow-through";
import {
	type ForgeRunnerScaleDeps,
	runForgeRunnerScale,
} from "../../src/reconcile/forge-runner-scale";
import { runForgeRunnerScaleStep } from "../../src/reconcile/forge-runner-scale-resolve";
import { withTestDb } from "../db/helpers";

const NOW = new Date("2026-10-07T15:10:42.000Z");
const GEN = ["docker", "self-hosted"];
const GATE = ["forgejo-mvp", "forgejo-triage"];
const BOTH = [...GEN, ...GATE];

/** The live shape (config/repos.yml): standing 9101, floor 0. */
function config(): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [],
		job_templates: [],
		doorbell_enabled: false,
		shadow_publish: false,
		forge_runner_fleet: {
			floor: 0,
			standby_label: "forgejo-mvp",
			cap: 10,
			idle_minutes: 3,
			standing: 9101,
		},
	} as unknown as WatcherConfig;
}

type Slot = { vmid: number; running: boolean; forge: string; labels: string[] };

/** One pass over fixed slots and waiting jobs; returns every `onBusy` answer. */
async function busyAnswers(args: {
	slots: Slot[];
	waiting?: string[][];
	readThrows?: boolean;
}): Promise<boolean[]> {
	const answers: boolean[] = [];
	const deps: ForgeRunnerScaleDeps = {
		readForge: async () => {
			if (args.readThrows === true) throw new Error("GET /admin/runners/jobs -> 503");
			return {
				waiting: (args.waiting ?? []).map((runs_on) => ({ runs_on })),
				runners: args.slots.map((s) => ({
					name: `forge-runner-${s.vmid}`,
					status: s.forge,
					labels: s.labels,
				})),
			};
		},
		listBand: async () =>
			args.slots.map((s) => ({ vmid: s.vmid, status: s.running ? "running" : "absent" })),
		readRunnerStatus: async () => "active",
		startMember: async () => undefined,
		stopMember: async () => undefined,
		onBusy: (busy) => answers.push(busy),
		idleSince: new Map(),
		offlineSince: new Map(),
		now: () => NOW.getTime(),
	};
	await runForgeRunnerScale(config(), deps);
	return answers;
}

afterEach(() => noteForgeBandBusy(false));

describe("band busy, as the scaler pass reports it (SOF-10517)", () => {
	test("a waiting self-hosted job a band group covers is busy", async () => {
		const answers = await busyAnswers({
			slots: [
				{ vmid: 9101, running: true, forge: "active", labels: BOTH },
				{ vmid: 9102, running: false, forge: "offline", labels: GEN },
			],
			waiting: [["self-hosted"]],
		});
		expect(answers).toEqual([true]);
	});

	test("a running slot beyond the standing one is busy, with nothing waiting", async () => {
		const answers = await busyAnswers({
			slots: [
				{ vmid: 9101, running: true, forge: "idle", labels: BOTH },
				{ vmid: 9102, running: true, forge: "idle", labels: GEN },
			],
		});
		expect(answers).toEqual([true]);
	});

	test("only the standing slot up and nothing waiting is idle", async () => {
		const answers = await busyAnswers({
			slots: [
				{ vmid: 9101, running: true, forge: "idle", labels: BOTH },
				{ vmid: 9102, running: false, forge: "offline", labels: GEN },
			],
		});
		expect(answers).toEqual([false]);
	});

	test("a waiting job no band group can run is not band demand", async () => {
		// The army's large label and hosted labels are served outside this band;
		// counting them would pin the 20 s cadence on work the scaler cannot place.
		const answers = await busyAnswers({
			slots: [{ vmid: 9101, running: true, forge: "idle", labels: BOTH }],
			waiting: [["forgejo-mvp-large"], ["ubuntu-latest"]],
		});
		expect(answers).toEqual([false]);
	});

	test("an unreadable queue is not busy: the sweep stays the fallback", async () => {
		const answers = await busyAnswers({
			slots: [{ vmid: 9101, running: true, forge: "idle", labels: BOTH }],
			readThrows: true,
		});
		expect(answers).toEqual([false]);
	});
});

describe("the cycle's scale step feeds the follow-through flag (SOF-10517)", () => {
	function stepDeps(waiting: string[][], onError: (e: unknown) => void) {
		const routes: Record<string, unknown> = {
			"/admin/runners/jobs": waiting.map((runs_on) => ({ status: "waiting", runs_on })),
			"/admin/actions/runners": [{ name: "forge-runner-9101", status: "active", labels: BOTH }],
		};
		const cfg = config();
		return {
			config: {
				...cfg,
				repositories: [{ name: "rodaddy/x", provider: "forgejo" }],
			} as unknown as WatcherConfig,
			clientFor: async () =>
				({
					get: async (path: string) => ({ status: 200, data: routes[path], link: null }),
				}) as never,
			db: {} as never,
			onError,
			transport: {
				listBand: async () => [{ vmid: 9101, status: "running" }],
				startBandMember: async () => undefined,
				stopBandMember: async () => undefined,
			},
		};
	}

	test("a covered waiting job sets the flag, and an empty queue clears it", async () => {
		const errors: unknown[] = [];
		await runForgeRunnerScaleStep(stepDeps([["self-hosted"]], (e) => errors.push(e)));
		expect(forgeBandBusy()).toBe(true);
		await runForgeRunnerScaleStep(stepDeps([], (e) => errors.push(e)));
		expect(forgeBandBusy()).toBe(false);
		expect(errors).toEqual([]);
	});
});

describe("passFollowThroughDelay with the band predicate (SOF-10517)", () => {
	test("a busy band arms the 20 s follow-through with nothing else in flight", async () => {
		await withTestDb(async (db) => {
			expect(await passFollowThroughDelay(db, NOW, false)).toBeNull();
			noteForgeBandBusy(true);
			expect(forgeBandBusy()).toBe(true);
			expect(await passFollowThroughDelay(db, NOW, false)).toBe(20_000);
		});
	});

	test("an idle band falls back to the sweep", async () => {
		await withTestDb(async (db) => {
			noteForgeBandBusy(true);
			noteForgeBandBusy(false);
			expect(await passFollowThroughDelay(db, NOW, false)).toBeNull();
		});
	});
});
