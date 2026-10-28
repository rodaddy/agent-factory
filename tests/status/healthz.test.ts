import { describe, expect, test } from "bun:test";
import type { StatusSnapshot } from "../../src/status/query";
import { createStatusHandler } from "../../src/status/server";

/**
 * An OBVIOUSLY-FAKE clock (done-means README rule 15). Every timestamp below
 * sits in 2099 so a value that leaked from the un-injected wall-clock default
 * would be recognisable on sight rather than looking like a plausible reading.
 */
const NOW_ISO = "2099-05-01T12:00:00.000Z";
const NOW_MS = Date.parse(NOW_ISO);
const POLL_MINUTES = 15;

function snapshot(overrides: Partial<StatusSnapshot> = {}): StatusSnapshot {
	return {
		generatedAt: NOW_ISO,
		repositories: [],
		heldBoxes: [],
		unconfirmedAllocations: [],
		tracedAttempts: [],
		...overrides,
	};
}

/**
 * Build the handler over a source whose CALL LOG is asserted (README rule 11).
 * `nowMs` is injected, so no assertion here sleeps or measures elapsed time.
 */
function harness(snap: StatusSnapshot, nowMs = NOW_MS) {
	const sourceCalls: number[] = [];
	const handler = createStatusHandler({
		source: async () => {
			sourceCalls.push(nowMs);
			return snap;
		},
		pollIntervalMinutes: POLL_MINUTES,
		nowMs: () => nowMs,
	});
	return { handler, sourceCalls: () => sourceCalls };
}

function healthzReq(): Request {
	return new Request("http://localhost/healthz", { headers: { host: "localhost:8787" } });
}

describe("GET /healthz", () => {
	test("200 while the last pass started inside 2x the poll interval", async () => {
		const { handler, sourceCalls } = harness(
			snapshot({ lastPassStartedAt: "2099-05-01T11:59:00.000Z" }),
		);
		const res = await handler(healthzReq());
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.lastPassStartedAt).toBe("2099-05-01T11:59:00.000Z");
		// The snapshot is read exactly once per probe — a health endpoint that
		// fanned out extra DB reads would be its own load problem.
		expect(sourceCalls()).toHaveLength(1);
	});

	test("503 when the last pass is older than 2x the poll interval", async () => {
		// 31 minutes against a 15-minute interval. This case and the one above
		// differ in EXACTLY the injected timestamp, so a handler that ignores it
		// fails one of them whichever way it is hardwired.
		const { handler } = harness(snapshot({ lastPassStartedAt: "2099-05-01T11:29:00.000Z" }));
		const res = await handler(healthzReq());
		expect(res.status).toBe(503);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(false);
		// The stale timestamp is still REPORTED — the operator needs to see how stale.
		expect(body.lastPassStartedAt).toBe("2099-05-01T11:29:00.000Z");
	});

	test("503 when no pass has ever started", async () => {
		const { handler } = harness(snapshot({ lastPassStartedAt: null }));
		const res = await handler(healthzReq());
		expect(res.status).toBe(503);
		expect(((await res.json()) as Record<string, unknown>).lastPassStartedAt).toBeNull();
	});

	test("503 when the snapshot carries no liveness record at all", async () => {
		// A status server nobody is driving a scheduler behind. Absent evidence is
		// not evidence of life.
		const { handler } = harness(snapshot());
		const res = await handler(healthzReq());
		expect(res.status).toBe(503);
	});

	test("the threshold DERIVES from the configured interval, not a constant 30 minutes", async () => {
		// README rule 18: a second fixture with a different derivation is what
		// distinguishes a computed threshold from a hardcoded one. The SAME
		// 90-minute-old timestamp is live at a 60-minute cadence and stale at 15.
		const ninetyAgo = "2099-05-01T10:30:00.000Z";
		const wide = createStatusHandler({
			source: async () => snapshot({ lastPassStartedAt: ninetyAgo }),
			pollIntervalMinutes: 60,
			nowMs: () => NOW_MS,
		});
		expect((await wide(healthzReq())).status).toBe(200);

		const { handler: narrow } = harness(snapshot({ lastPassStartedAt: ninetyAgo }));
		expect((await narrow(healthzReq())).status).toBe(503);
	});

	test("reports the threshold it judged against", async () => {
		const { handler } = harness(snapshot({ lastPassStartedAt: NOW_ISO }));
		const body = (await (await handler(healthzReq())).json()) as Record<string, unknown>;
		expect(body.pollIntervalMinutes).toBe(POLL_MINUTES);
		expect(body.stalenessThresholdMinutes).toBe(POLL_MINUTES * 2);
	});

	test("reports the commit stamped by the deploy path", async () => {
		const commit = "547a547a547a547a547a547a547a547a547a547a";
		const handler = createStatusHandler({
			source: async () => snapshot({ lastPassStartedAt: NOW_ISO }),
			pollIntervalMinutes: POLL_MINUTES,
			nowMs: () => NOW_MS,
			commit,
		});
		const body = (await (await handler(healthzReq())).json()) as Record<string, unknown>;
		expect(body.commit).toBe(commit);
	});

	test("carries the pass counters and NAMES the failed repositories", async () => {
		const { handler } = harness(
			snapshot({
				lastPassStartedAt: NOW_ISO,
				lastPassFinishedAt: "2099-05-01T12:00:03.000Z",
				lastPassOk: 6,
				lastPassFailCount: 1,
				lastPassRepoErrors: [{ repository: "rodaddy/broken", error: "forge credential missing" }],
				passesStarted: 42,
				passesCompleted: 41,
			}),
		);
		const body = (await (await handler(healthzReq())).json()) as Record<string, unknown>;
		expect(body.lastPassOk).toBe(6);
		expect(body.lastPassFailCount).toBe(1);
		expect(body.passesStarted).toBe(42);
		expect(body.passesCompleted).toBe(41);
		// The ten-day defect: the fail count now names its repository.
		expect(body.lastPassRepoErrors).toEqual([
			{ repository: "rodaddy/broken", error: "forge credential missing" },
		]);
	});

	test("a healthy pass reports NO repo errors — the absence control", async () => {
		const { handler } = harness(
			snapshot({ lastPassStartedAt: NOW_ISO, lastPassOk: 7, lastPassFailCount: 0 }),
		);
		const body = (await (await handler(healthzReq())).json()) as Record<string, unknown>;
		expect(body.lastPassRepoErrors).toEqual([]);
	});

	test("503, not 500, when the status source throws", async () => {
		// A health endpoint that 500s on a failed DB read tells a monitor nothing it
		// can act on differently from a wedge.
		const handler = createStatusHandler({
			source: async () => {
				throw new Error("connection refused to 10.0.0.1:5432");
			},
			pollIntervalMinutes: POLL_MINUTES,
			nowMs: () => NOW_MS,
		});
		const res = await handler(healthzReq());
		expect(res.status).toBe(503);
		const text = await res.text();
		expect(text).toContain("status source unavailable");
		// The driver message can quote connection detail; it must not reach the body.
		expect(text).not.toContain("10.0.0.1");
	});

	test("is GET-only", async () => {
		const { handler } = harness(snapshot({ lastPassStartedAt: NOW_ISO }));
		const res = await handler(
			new Request("http://localhost/healthz", {
				method: "POST",
				headers: { host: "localhost:8787" },
			}),
		);
		expect(res.status).toBe(405);
	});

	test("defaults to the WALL clock when no nowMs is injected", async () => {
		// Production judges liveness against the real present. Judging against the
		// snapshot's own generatedAt would let a frozen source report itself live
		// forever — so the default must not be the snapshot's clock.
		const handler = createStatusHandler({
			// generatedAt is a fixed 2099 instant; the pass "started" at the same
			// instant. Against the wall clock that is ~73 years stale.
			source: async () => snapshot({ lastPassStartedAt: NOW_ISO }),
			pollIntervalMinutes: POLL_MINUTES,
		});
		expect((await handler(healthzReq())).status).toBe(503);

		const live = createStatusHandler({
			source: async () => snapshot({ lastPassStartedAt: new Date().toISOString() }),
			pollIntervalMinutes: POLL_MINUTES,
		});
		expect((await live(healthzReq())).status).toBe(200);
	});
});

describe("/status.json is undisturbed by #252", () => {
	test("keeps its exact shape when no liveness is recorded", async () => {
		// sf#253 will read this surface, and it is the only machine surface
		// deployed today. Every #252 field is OPTIONAL, so a snapshot without one
		// serialises to exactly the keys it always had.
		//
		// `tracedAttempts` and `unconfirmedAllocations` are the
		// ADDITIONS since, and both are required rather than optional: they are
		// DB-derived like `heldBoxes`, so an empty array is a true statement
		// ("nothing has been traced", "no allocation is unconfirmed") while an
		// absent key would mean "this watcher cannot say", which is never the case.
		// Additive only — no existing key changed name, type, or meaning, so a
		// #253-shaped consumer reading the four original keys is unaffected.
		const { handler } = harness(snapshot());
		const res = await handler(
			new Request("http://localhost/status.json", { headers: { host: "localhost:8787" } }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Record<string, unknown>;
		expect(Object.keys(body).sort()).toEqual([
			"generatedAt",
			"heldBoxes",
			"repositories",
			"tracedAttempts",
			"unconfirmedAllocations",
		]);
		// And the addition carries NO Langfuse host: the base URL reaches the HTML
		// renderer only, so this machine surface stays ids-only.
		expect(JSON.stringify(body)).not.toContain("http://langfuse");
	});

	test("adds the liveness fields at the TOP level when they are recorded", async () => {
		const { handler } = harness(
			snapshot({ lastPassStartedAt: NOW_ISO, lastPassOk: 3, lastPassFailCount: 0 }),
		);
		const res = await handler(
			new Request("http://localhost/status.json", { headers: { host: "localhost:8787" } }),
		);
		const body = (await res.json()) as Record<string, unknown>;
		// Existing keys survive untouched — additions only.
		expect(body.generatedAt).toBe(NOW_ISO);
		expect(body.repositories).toEqual([]);
		expect(body.lastPassStartedAt).toBe(NOW_ISO);
		expect(body.lastPassOk).toBe(3);
	});
});
