import { describe, expect, test } from "bun:test";
import type { WatcherConfig } from "../src/config/schema";
import type { WatcherDb } from "../src/db/client";
import { busResults } from "../src/db/schema";
import type { ForgeRegistry } from "../src/forge/registry";
import type { GitRunner } from "../src/results/branch-publisher";
import { BusResultReader } from "../src/results/bus-reader";
import { CompositeResultReader } from "../src/results/composite-reader";
import { createIngestAndPublish } from "../src/service-ingest";
import { withTestDb } from "./db/helpers";
import { testTmpBase } from "./support/test-temp";

function config(): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [],
		job_templates: [],
		doorbell_enabled: false,
		shadow_publish: false,
	};
}

function inputs(db: WatcherDb, busReader?: BusResultReader) {
	const shareRoot = testTmpBase();
	return {
		db,
		config: config(),
		registry: {} as ForgeRegistry,
		shadow: false,
		collabRoot: shareRoot,
		changeWorkRoot: `${shareRoot}/change-work`,
		shareRootOverride: shareRoot,
		git: {} as GitRunner,
		remoteFor: () => null,
		credentialFor: async () => null,
		triageAllowlistFor: () => [],
		clientFor: async () => null,
		onError: () => {},
		...(busReader === undefined ? {} : { busReader }),
	};
}

/** Reach the reconciler's injected reader — the seam this wiring owns. */
function readerOf(reconciler: unknown): unknown {
	return (reconciler as { reader: unknown }).reader;
}

describe("createIngestAndPublish bus reader wiring", () => {
	test("without a busReader the reconciler keeps its default share reader", async () => {
		await withTestDb(async (db) => {
			const wiring = createIngestAndPublish(inputs(db as never));
			expect(readerOf(wiring.resultReconciler)).not.toBeInstanceOf(CompositeResultReader);
		});
	});

	test("with a busReader the reconciler reads the bus FIRST, share second", async () => {
		await withTestDb(async (db) => {
			const wiring = createIngestAndPublish(inputs(db as never, new BusResultReader(db as never)));
			const reader = readerOf(wiring.resultReconciler);
			expect(reader).toBeInstanceOf(CompositeResultReader);

			// Drive the production reader: a bus row with no share directory at all
			// must still read as present, and done ONLY once the runner's final
			// `DONE` message has landed (the bus reader's completion rule).
			const body = '{"result_version":1,"status":"passed"}';
			await db.insert(busResults).values({
				jobRunnerId: "rj-wire",
				hostname: "runner-a",
				artifact: "result.json",
				body,
				msgId: "rj-wire:runner-a:result.json",
				subject: "factory.jobs.rj-wire.result",
			});
			const composite = reader as CompositeResultReader;
			expect(await composite.isDone("rj-wire", "runner-a")).toBe(false);
			await db.insert(busResults).values({
				jobRunnerId: "rj-wire",
				hostname: "runner-a",
				artifact: "DONE",
				body: "",
				msgId: "rj-wire:runner-a:DONE",
				subject: "factory.jobs.rj-wire.result",
			});
			expect(await composite.isDone("rj-wire", "runner-a")).toBe(true);
			expect(await composite.listHosts("rj-wire", 8)).toEqual(["runner-a"]);
			expect(await composite.readResult("rj-wire", "runner-a", 4096)).toBe(body);
		});
	});
});
