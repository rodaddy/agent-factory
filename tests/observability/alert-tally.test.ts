/**
 * @module tests/observability/alert-tally
 * @description Proves every `raiseCriticalAlert` outcome lands in the
 *   process-local tally behind `factory_alert_deliveries_total`: a
 *   delivered result bumps `delivered`, an undelivered one bumps `undelivered`.
 *   The tally is process-global and only grows, so each test asserts a DELTA.
 *
 * @dependencies
 *   - ../../src/observability/critical-alert -- the egress that records
 *   - ../../src/observability/alert-tally -- the tally under test
 */
import { describe, expect, test } from "bun:test";
import type { ForgeClient } from "../../src/forge/boundary";
import { alertDeliveryTally } from "../../src/observability/alert-tally";
import { raiseCriticalAlert } from "../../src/observability/critical-alert";

/** A forge that proves absence on the scan and accepts the issue POST. */
const openingClient = {
	getPage: () => Promise.resolve({ body: [], next: null }),
	write: () =>
		Promise.resolve({ status: 201, data: { number: 1 }, link: null, rateRemaining: null }),
} as unknown as ForgeClient;

describe("alertDeliveryTally", () => {
	test("an undelivered alert increments undelivered only", async () => {
		const before = alertDeliveryTally();
		const d = await raiseCriticalAlert(undefined, { alertClass: "x", cause: "y" });
		expect(d.delivered).toBe(false);
		const after = alertDeliveryTally();
		expect(after.undelivered - before.undelivered).toBe(1);
		expect(after.delivered - before.delivered).toBe(0);
	});

	test("a delivered alert increments delivered only", async () => {
		const before = alertDeliveryTally();
		const d = await raiseCriticalAlert(
			{ repository: "rodaddy/software-factory", client: () => Promise.resolve(openingClient) },
			{ alertClass: "x", cause: "y" },
		);
		expect(d.delivered).toBe(true);
		const after = alertDeliveryTally();
		expect(after.delivered - before.delivered).toBe(1);
		expect(after.undelivered - before.undelivered).toBe(0);
	});

	test("the getter returns a copy the caller cannot mutate into the tally", () => {
		const snap = alertDeliveryTally();
		snap.delivered += 100;
		expect(alertDeliveryTally().delivered).toBe(snap.delivered - 100);
	});
});
