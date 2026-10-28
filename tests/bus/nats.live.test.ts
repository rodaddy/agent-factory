import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createNatsBus } from "../../src/bus/nats";

/**
 * Live probe against the real `fleet` cluster. SKIPPED unless both
 * `NATS_TEST_URL` and `NATS_TEST_NKEY_FILE` are set, because the seed is an
 * operator-held credential that never lives in this repo. The subject sits
 * under `forge.events.>` so the existing gitops-owned `FORGE_EVENTS` stream
 * accepts it — this test never creates a stream.
 */
const url = process.env.NATS_TEST_URL;
const seedFile = process.env.NATS_TEST_NKEY_FILE;
const live = Boolean(url && seedFile);

describe("createNatsBus against the live cluster", () => {
	test.skipIf(!live)(
		"publishes a delivery and reports the replay of the same Nats-Msg-Id as a duplicate",
		async () => {
			const lines: Array<{ level: string; message: string }> = [];
			const bus = await createNatsBus({
				url: url as string,
				nkeySeed: new TextEncoder().encode(readFileSync(seedFile as string, "utf8").trim()),
				log: ((level: string, message: string) => {
					lines.push({ level, message });
				}) as never,
			});
			try {
				const delivery = {
					repository: "rodaddy/software-factory",
					event: "lane_a_probe",
					deliveryId: `lane-a-${crypto.randomUUID()}`,
					rowId: 1,
					rawBody: new TextEncoder().encode('{"probe":"sf465 lane A"}'),
					signature: null,
				};

				await bus.publishForgeDelivery(delivery);
				expect(lines.filter((l) => l.message === "bus.nats.publish_failed")).toEqual([]);
				expect(lines.filter((l) => l.message === "bus.nats.duplicate")).toEqual([]);

				// Same Nats-Msg-Id inside the stream's 2-minute dedupe window.
				await bus.publishForgeDelivery(delivery);
				expect(lines.filter((l) => l.message === "bus.nats.duplicate").length).toBe(1);
			} finally {
				await bus.close();
			}
		},
		30_000,
	);
});
