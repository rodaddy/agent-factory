/**
 * @module reconcile/forge-runner-scale-resolve
 * @description Compose the real dependencies of the Forge runner band pass:
 *  the Forgejo admin API on one side, the
 *   runner-boxes gateway on the other. `forge-runner-scale.ts` owns the policy
 *   and knows nothing about either wire; this module is the only place they meet.
 *
 *   FORGE READS ARE THE ADMIN API, through the ForgeClient of the FIRST managed
 *   Forgejo repository (the token is the watcher's own):
 *     `GET /admin/runners/jobs`     -> jobs; only `status == "waiting"` is kept
 *     `GET /admin/actions/runners`  -> runners: `name`, `status`, `labels`
 *   Labels arrive as strings or `{ name }` objects and are normalised to BARE
 *   strings: the schema suffix after the first `:` is dropped
 *   (`forgejo-mvp:docker://node:20-bookworm` -> `forgejo-mvp`), because job
 *   `runs_on` uses bare names and a suffixed label never matched.
 *   A missing client, a non-200, or a body that fails validation THROWS, and the
 *   pass turns that throw into `skipped` — an unreadable queue is never read as
 *   an empty one.
 *
 *   THE GATEWAY SEAMS ARE PASSED IN (`listBand`, `startMember`, `stopMember`),
 *   backed by the `runner_list` and `runner_forge_up`/`runner_forge_down` (clone
 *   and destroy) verbs for the forge band. This module adds no transport logic of its own.
 *
 *   IDLE-SINCE AND OFFLINE-SINCE LIVE HERE, in process: one `Map<vmid, epochMs>`
 *   each, shared by every pass this process runs. A restart empties it, which only delays a stop by
 *   one `idle_minutes` window — never causes one.
 *
 * @outputs
 *   - `ListedVmid` -- re-exported gateway listing shape
 *   - `resolveForgeRunnerScaleDeps` -- the composed deps the cycle passes in
 *   - `runForgeRunnerScaleStep` -- the cycle's step 9b: compose, run one pass, route a throw to onError;
 *     every band listing also re-runs OOM-killed lane tasks once on the large runner
 *
 * @dependencies
 *   - ../config/schema -- the managed repositories (first Forgejo one is used)
 *   - ../forge/boundary -- the narrow forge client contract
 *   - ../log -- the shared traced() wrapper
 */
import { z } from "zod";
import type { WatcherConfig } from "../config/schema";
import type { ForgeClient } from "../forge/boundary";
import { traced } from "../log";
import { noteForgeBandBusy } from "./band-busy";
import {
	type ForgeRunner,
	type ForgeRunnerScaleDeps,
	type ForgeSnapshot,
	type ListedVmid,
	runForgeRunnerScale,
} from "./forge-runner-scale";
import { type OomRetryWiring, withOomRetry } from "./oom-retry";

export type { ListedVmid };

/** In-process idle-since state, shared by every pass in this process. */
const IDLE_SINCE = new Map<number, number>();

/** In-process first-seen running-but-offline state, shared the same way. */
const OFFLINE_SINCE = new Map<number, number>();

/** Admin jobs response. Only the fields the policy reads are required. */
const jobsSchema = z.array(
	z.object({ status: z.string(), runs_on: z.array(z.string()).nullish() }),
);

/** Admin runners response. Labels may be plain strings or `{ name }` objects. */
const runnersSchema = z.array(
	z.object({
		name: z.string(),
		status: z.string(),
		labels: z.array(z.union([z.string(), z.object({ name: z.string() })])).nullish(),
	}),
);

/** GET one admin path and validate it, throwing on anything but a 200 that parses. */
async function adminGet<T>(client: ForgeClient, path: string, schema: z.ZodType<T>): Promise<T> {
	const response = await client.get<unknown>(path);
	if (response.status !== 200) {
		throw new Error(`GET ${path} -> ${response.status}`);
	}
	const parsed = schema.safeParse(response.data);
	if (!parsed.success) {
		throw new Error(`GET ${path} returned an unexpected shape`);
	}
	return parsed.data;
}

/**
 * A runner label with its schema suffix dropped: `forgejo-mvp:docker://node:20`
 * -> `forgejo-mvp`. Jobs ask for bare names, so grouping and matching must too.
 */
function bareLabel(label: string): string {
	return label.split(":")[0] ?? label;
}

/** Read the registered runners with labels normalised to bare strings. */
async function readRunners(client: ForgeClient): Promise<ForgeRunner[]> {
	const runners = await adminGet(client, "/admin/actions/runners", runnersSchema);
	return runners.map((r) => ({
		name: r.name,
		status: r.status,
		labels: (r.labels ?? []).map((l) => bareLabel(typeof l === "string" ? l : l.name)),
	}));
}

/**
 * Compose the pass's real dependencies.
 *
 * @param config - loaded watcher configuration (the managed repository set)
 * @param seams - the forge client lookup, the gateway band seams, and an optional clock
 */
export const resolveForgeRunnerScaleDeps = traced(
	"reconcile.resolveForgeRunnerScaleDeps",
	function resolveForgeRunnerScaleDeps(
		config: WatcherConfig,
		seams: {
			clientFor: (repository: string) => Promise<ForgeClient | null>;
			listBand: () => Promise<ListedVmid[]>;
			startMember: (vmid: number) => Promise<void>;
			stopMember: (vmid: number) => Promise<void>;
			now?: () => number;
			/** sf#1090: when set, every band listing also re-runs OOM-killed lane tasks once, large. */
			oom?: OomRetryWiring;
			/** SOF-10517: each pass's band-busy answer; the cycle step wires the follow-through flag. */
			onBusy?: (busy: boolean) => void;
		},
	): ForgeRunnerScaleDeps {
		const client = async (): Promise<ForgeClient> => {
			const repo = config.repositories.find((r) => r.provider === "forgejo");
			const c = repo ? await seams.clientFor(repo.name) : null;
			if (c === null) {
				throw new Error("no Forgejo client for the admin reads");
			}
			return c;
		};
		return {
			readForge: async (): Promise<ForgeSnapshot> => {
				const c = await client();
				const jobs = await adminGet(c, "/admin/runners/jobs", jobsSchema);
				return {
					waiting: jobs
						.filter((j) => j.status === "waiting")
						.map((j) => ({ runs_on: j.runs_on ?? [] })),
					runners: await readRunners(c),
				};
			},
			listBand: seams.oom ? withOomRetry(seams.listBand, seams.oom) : seams.listBand,
			readRunnerStatus: async (vmid: number) => {
				const runners = await readRunners(await client());
				return runners.find((r) => r.name === `forge-runner-${vmid}`)?.status ?? null;
			},
			startMember: seams.startMember,
			stopMember: seams.stopMember,
			...(seams.onBusy ? { onBusy: seams.onBusy } : {}),
			idleSince: IDLE_SINCE,
			offlineSince: OFFLINE_SINCE,
			now: seams.now ?? Date.now,
		};
	},
);

/** What the cycle's scale step reads from the reconcile deps. */
export interface ForgeRunnerScaleStepDeps extends OomRetryWiring {
	config: WatcherConfig;
	transport: {
		listBand(band: "forge"): Promise<ListedVmid[]>;
		startBandMember(vmid: number): Promise<void>;
		stopBandMember(vmid: number): Promise<void>;
	};
}

/**
 * Step 9b — hold the Forge runner fleet at the size the Actions queue needs.
 * Immediately after the build-bump pair: a bump's own PR check IS a
 * Forge Actions job, so sizing here saves it a poll interval waiting for a warm
 * box. Absent `forge_runner_fleet` config returns before any gateway or forge
 * read, so this costs an un-opted-in deployment nothing. Isolated like every
 * other sweep step — the pass already swallows a per-member start/stop failure,
 * so reaching this catch means the listing or the queue read itself failed.
 * Every band listing also re-runs OOM-killed lane tasks once, large.
 *
 * @param deps - the composed cycle collaborators
 */
export const runForgeRunnerScaleStep = traced(
	"reconcile.runForgeRunnerScaleStep",
	async function runForgeRunnerScaleStep(deps: ForgeRunnerScaleStepDeps): Promise<void> {
		try {
			const scale = resolveForgeRunnerScaleDeps(deps.config, {
				clientFor: deps.clientFor,
				listBand: () => deps.transport.listBand("forge"),
				startMember: (v) => deps.transport.startBandMember(v),
				stopMember: (v) => deps.transport.stopBandMember(v),
				oom: deps,
				// SOF-10517: the follow-through keeps the 20 s cadence while the band is busy.
				onBusy: noteForgeBandBusy,
			});
			await runForgeRunnerScale(deps.config, scale);
		} catch (e) {
			deps.onError(e);
		}
	},
	{ redact: { args: [0] } },
);
