import { describe, expect, test } from "bun:test";
import {
	emptyPassLivenessStatus,
	isPassLive,
	PassLivenessTracker,
} from "../../src/status/pass-liveness";

/**
 * An OBVIOUSLY-FAKE clock (README rule 15): the year is not a plausible real
 * timestamp, so a value that leaks from an un-injected default is recognisable
 * on sight rather than looking like a real reading.
 */
function fakeClock(startIso: string) {
	const calls: string[] = [];
	let current = Date.parse(startIso);
	return {
		now: () => {
			calls.push(new Date(current).toISOString());
			return new Date(current);
		},
		advanceMinutes: (minutes: number) => {
			current += minutes * 60_000;
		},
		/** The CALL LOG: every timestamp the tracker actually asked for. */
		calls: () => calls,
	};
}

describe("isPassLive", () => {
	const NOW = Date.parse("2099-01-01T12:00:00.000Z");

	test("a null lastPassStartedAt is NOT live", () => {
		// The restart window is exactly where a broken boot hides; reporting it live
		// would make it indistinguishable from a healthy loop.
		expect(isPassLive(null, 15, NOW)).toBe(false);
	});

	test("a pass one minute old is live", () => {
		expect(isPassLive("2099-01-01T11:59:00.000Z", 15, NOW)).toBe(true);
	});

	test("a pass older than 2x the poll interval is not live", () => {
		// 31 minutes against a 15-minute interval: past the 30-minute threshold.
		expect(isPassLive("2099-01-01T11:29:00.000Z", 15, NOW)).toBe(false);
	});

	test("exactly 2x the poll interval is still live — the boundary is inclusive", () => {
		expect(isPassLive("2099-01-01T11:30:00.000Z", 15, NOW)).toBe(true);
	});

	test("one millisecond past 2x the interval is not live", () => {
		expect(isPassLive("2099-01-01T11:29:59.999Z", 15, NOW)).toBe(false);
	});

	test("the threshold DERIVES from the interval — a second fixture with a different derivation", () => {
		// README rule 18: a single value-assertion cannot distinguish a computed
		// threshold from a hardcoded 30 minutes. A 60-minute interval must accept a
		// 90-minute-old pass (inside 2x60) that a 15-minute interval rejects.
		const ninetyMinutesAgo = "2099-01-01T10:30:00.000Z";
		expect(isPassLive(ninetyMinutesAgo, 60, NOW)).toBe(true);
		expect(isPassLive(ninetyMinutesAgo, 15, NOW)).toBe(false);
	});

	test("a FAR-FUTURE timestamp fails closed rather than reading as maximally healthy", () => {
		// The fail-open hole: a naive `now - started <= threshold` goes NEGATIVE for a
		// future start and sails under the bound, so a clock-skewed or corrupted
		// value would report as the healthiest possible reading.
		expect(isPassLive("2099-06-01T12:00:00.000Z", 15, NOW)).toBe(false);
	});

	test("a slightly-future timestamp is tolerated — clock skew is not a wedge", () => {
		// Same slack in both directions: an NTP correction or a container clock
		// settling after boot must not flap the endpoint.
		expect(isPassLive("2099-01-01T12:20:00.000Z", 15, NOW)).toBe(true);
	});

	test("an unparseable timestamp fails CLOSED", () => {
		// A monitor reading 200 off a value nothing could interpret is worse than a
		// 503 that makes the operator look.
		expect(isPassLive("not-a-timestamp", 15, NOW)).toBe(false);
	});
});

describe("PassLivenessTracker", () => {
	test("reports the empty record before any pass has started", () => {
		const tracker = new PassLivenessTracker(() => {
			throw new Error("the clock must not be read before a pass is recorded");
		});
		expect(tracker.status()).toEqual(emptyPassLivenessStatus());
		expect(tracker.status().lastPassStartedAt).toBeNull();
	});

	test("recordStart moves lastPassStartedAt and counts the start", () => {
		const clock = fakeClock("2099-03-01T00:00:00.000Z");
		const tracker = new PassLivenessTracker(clock.now);

		tracker.recordStart();
		expect(tracker.status().lastPassStartedAt).toBe("2099-03-01T00:00:00.000Z");
		expect(tracker.status().passesStarted).toBe(1);

		clock.advanceMinutes(15);
		tracker.recordStart();
		expect(tracker.status().lastPassStartedAt).toBe("2099-03-01T00:15:00.000Z");
		expect(tracker.status().passesStarted).toBe(2);
		// THE CALL LOG (README rule 11): exactly two clock reads, one per start.
		expect(clock.calls()).toEqual(["2099-03-01T00:00:00.000Z", "2099-03-01T00:15:00.000Z"]);
	});

	test("a pass that STARTS but never completes still moves lastPassStartedAt", () => {
		// The property the whole issue turns on: liveness is about the loop, not the
		// work. A started-and-died pass is a turning loop.
		const clock = fakeClock("2099-03-01T00:00:00.000Z");
		const tracker = new PassLivenessTracker(clock.now);
		tracker.recordStart();
		const status = tracker.status();
		expect(status.lastPassStartedAt).toBe("2099-03-01T00:00:00.000Z");
		expect(status.lastPassFinishedAt).toBeNull();
		expect(status.passesStarted).toBe(1);
		expect(status.passesCompleted).toBe(0);
	});

	test("recordCompletion carries the counts and NAMES the failed repositories", () => {
		const clock = fakeClock("2099-03-01T00:00:00.000Z");
		const tracker = new PassLivenessTracker(clock.now);
		tracker.recordStart();
		clock.advanceMinutes(1);
		tracker.recordCompletion({
			okCount: 6,
			failCount: 1,
			repositories: [
				{ repository: "rodaddy/ok-one" },
				{ repository: "rodaddy/broken", error: "forge credential unavailable" },
			],
		});

		const status = tracker.status();
		expect(status.lastPassFinishedAt).toBe("2099-03-01T00:01:00.000Z");
		expect(status.lastPassOk).toBe(6);
		expect(status.lastPassFailCount).toBe(1);
		expect(status.passesCompleted).toBe(1);
		// The defect #252 names: "1 failed" identified no repository. It does now.
		expect(status.lastPassRepoErrors).toEqual([
			{ repository: "rodaddy/broken", error: "forge credential unavailable" },
		]);
	});

	test("a clean pass records NO repo errors — the absence control", () => {
		// README rule 21: a visibility change needs an absence control aimed at the
		// noise regression. A successful repo must not appear as an error row.
		const tracker = new PassLivenessTracker(() => new Date("2099-03-01T00:00:00.000Z"));
		tracker.recordCompletion({
			okCount: 2,
			failCount: 0,
			repositories: [{ repository: "rodaddy/a" }, { repository: "rodaddy/b", error: "" }],
		});
		expect(tracker.status().lastPassRepoErrors).toEqual([]);
	});

	test("a later clean pass CLEARS the previous pass's errors", () => {
		const tracker = new PassLivenessTracker(() => new Date("2099-03-01T00:00:00.000Z"));
		tracker.recordCompletion({
			okCount: 0,
			failCount: 1,
			repositories: [{ repository: "rodaddy/broken", error: "boom" }],
		});
		expect(tracker.status().lastPassRepoErrors).toHaveLength(1);
		tracker.recordCompletion({ okCount: 1, failCount: 0, repositories: [{ repository: "x" }] });
		expect(tracker.status().lastPassRepoErrors).toEqual([]);
	});

	test("bounds repository names and error text at the boundary that stores them", () => {
		const tracker = new PassLivenessTracker(() => new Date("2099-03-01T00:00:00.000Z"));
		tracker.recordCompletion({
			okCount: 0,
			failCount: 1,
			repositories: [{ repository: "r".repeat(500), error: "e".repeat(500) }],
		});
		const [entry] = tracker.status().lastPassRepoErrors;
		expect(entry?.repository).toHaveLength(200);
		expect(entry?.error).toHaveLength(200);
	});

	test("caps the number of retained repo errors", () => {
		const tracker = new PassLivenessTracker(() => new Date("2099-03-01T00:00:00.000Z"));
		tracker.recordCompletion({
			okCount: 0,
			failCount: 50,
			repositories: Array.from({ length: 50 }, (_v, i) => ({
				repository: `rodaddy/r${i}`,
				error: "boom",
			})),
		});
		expect(tracker.status().lastPassRepoErrors).toHaveLength(20);
	});

	test("status() returns a fresh object callers cannot mutate state through", () => {
		const tracker = new PassLivenessTracker(() => new Date("2099-03-01T00:00:00.000Z"));
		tracker.recordCompletion({
			okCount: 0,
			failCount: 1,
			repositories: [{ repository: "rodaddy/broken", error: "boom" }],
		});
		const first = tracker.status();
		first.lastPassRepoErrors.push({ repository: "injected", error: "injected" });
		first.lastPassRepoErrors[0] = { repository: "clobbered", error: "clobbered" };
		expect(tracker.status().lastPassRepoErrors).toEqual([
			{ repository: "rodaddy/broken", error: "boom" },
		]);
	});
});
