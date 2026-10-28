import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { and, eq } from "drizzle-orm";
import { createNatsBus } from "../../src/bus/nats";
import { startResultsConsumer } from "../../src/bus/results-consumer";
import { busResults } from "../../src/db/schema";
import { withTestDb } from "../db/helpers";
import { until } from "../support/wait-until";

/**
 * Live probe against the real `fleet` cluster's `FACTORY_JOBS` stream. SKIPPED
 * unless both `NATS_TEST_URL` and `NATS_TEST_NKEY_FILE` are set, because the
 * seed is an operator-held credential that never lives in this repo.
 *
 * It creates a TEST-ONLY durable (`watcher-ingest-test-<random>`) and deletes it
 * in the finally block, so it can never disturb the production `watcher-ingest`
 * consumer's position on the stream. It never creates or reconfigures the stream.
 */
const url = process.env.NATS_TEST_URL;
const seedFile = process.env.NATS_TEST_NKEY_FILE;
// The `watcher` user may not publish `factory.jobs.>`; the runner identity publishes.
// Falls back to the consumer seed for a cluster without per-user scoping.
const publishSeedFile = process.env.NATS_TEST_PUBLISH_NKEY_FILE ?? seedFile;
const live = Boolean(url && seedFile);

describe("startResultsConsumer against the live cluster", () => {
	test.skipIf(!live)(
		"drains one contract-shaped runner artifact into bus_results",
		async () => {
			await withTestDb(async (db) => {
				const durable = `watcher-ingest-test-${crypto.randomUUID().slice(0, 8)}`;
				const job = `rj-live-${crypto.randomUUID().slice(0, 8)}`;
				const hostname = "runner-live";
				const artifact = "result.json";
				const body = `{"result_version":1,"probe":"${job}"}`;

				const bus = await createNatsBus({
					url: url as string,
					nkeySeed: new TextEncoder().encode(readFileSync(seedFile as string, "utf8").trim()),
				});
				let handle: { stop(): Promise<void> } | undefined;
				try {
					handle = await startResultsConsumer({
						bus,
						db: db as never,
						durable,
						expiresMs: 1_000,
					});

					const publisher = await createNatsBus({
						url: url as string,
						nkeySeed: new TextEncoder().encode(
							readFileSync(publishSeedFile as string, "utf8").trim(),
						),
					});
					const js = publisher.connection.jetstream();
					const hdrs = (await import("nats")).headers();
					hdrs.set("Nats-Msg-Id", `${job}:${hostname}:${artifact}`);
					hdrs.set("Factory-Job", job);
					hdrs.set("Factory-Hostname", hostname);
					hdrs.set("Factory-Artifact", artifact);
					await js.publish(`factory.jobs.${job}.result`, new TextEncoder().encode(body), {
						headers: hdrs,
						timeout: 5_000,
					});
					await publisher.close();

					let rows: Array<{ body: string }> = [];
					await until(
						async () => {
							rows = await db
								.select({ body: busResults.body })
								.from(busResults)
								.where(and(eq(busResults.jobRunnerId, job), eq(busResults.hostname, hostname)));
							return rows.length > 0;
						},
						5_000,
						"result row stored",
					);
					expect(rows.length).toBe(1);
					expect(rows[0]?.body).toBe(body);
				} finally {
					if (handle !== undefined) await handle.stop();
					try {
						const jsm = await bus.connection.jetstreamManager({ checkAPI: false });
						await jsm.consumers.delete("FACTORY_JOBS", durable);
					} finally {
						await bus.close();
					}
				}
			});
		},
		60_000,
	);
});
