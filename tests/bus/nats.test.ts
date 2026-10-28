import { describe, expect, test } from "bun:test";
import { buildForgeEventMessage, createNatsBus, forgeEventSubject } from "../../src/bus/nats";

/**
 * Subject tokens may not contain `.` (the separator), `*`/`>` (the wildcards),
 * or whitespace, and an empty token would collapse the subject's arity. Every
 * one of those becomes `_`, so an attacker-supplied repository name can never
 * widen or re-target the subject it is interpolated into.
 */
describe("forgeEventSubject", () => {
	test("builds the four-segment subject for a clean owner/repo/event", () => {
		expect(forgeEventSubject("rodaddy", "software-factory", "push")).toBe(
			"forge.events.rodaddy.software-factory.push",
		);
	});

	test("replaces a dot inside a segment so the arity cannot change", () => {
		expect(forgeEventSubject("rodaddy", "soft.ware", "push")).toBe(
			"forge.events.rodaddy.soft_ware.push",
		);
	});

	test("replaces whitespace", () => {
		expect(forgeEventSubject("a b", "repo", "push")).toBe("forge.events.a_b.repo.push");
		expect(forgeEventSubject("a\tb", "repo", "push")).toBe("forge.events.a_b.repo.push");
	});

	test("replaces the subject wildcards", () => {
		expect(forgeEventSubject("*", ">", "push")).toBe("forge.events._._.push");
	});

	test("replaces an empty segment rather than emitting an empty token", () => {
		expect(forgeEventSubject("", "repo", "push")).toBe("forge.events._.repo.push");
		expect(forgeEventSubject("rodaddy", "repo", "")).toBe("forge.events.rodaddy.repo._");
	});
});

describe("buildForgeEventMessage", () => {
	const rawBody = new TextEncoder().encode('{"action":"opened"}');

	function input(overrides: Record<string, unknown> = {}) {
		return {
			repository: "rodaddy/software-factory",
			event: "push",
			deliveryId: "d-1",
			rowId: 42,
			rawBody,
			signature: "abc123",
			...overrides,
		};
	}

	test("derives the subject from the repository and event", () => {
		expect(buildForgeEventMessage(input()).subject).toBe(
			"forge.events.rodaddy.software-factory.push",
		);
	});

	test("sets all five headers when a signature is present", () => {
		const built = buildForgeEventMessage(input());
		expect(built.headers).toEqual({
			"Nats-Msg-Id": "d-1",
			"X-Forgejo-Delivery": "d-1",
			"X-Forgejo-Event": "push",
			"X-Forgejo-Signature": "abc123",
			"Factory-Delivery-Row": "42",
		});
	});

	test("omits X-Forgejo-Signature when the signature is null", () => {
		const built = buildForgeEventMessage(input({ signature: null }));
		expect(built.headers["X-Forgejo-Signature"]).toBeUndefined();
		expect(Object.keys(built.headers).sort()).toEqual([
			"Factory-Delivery-Row",
			"Nats-Msg-Id",
			"X-Forgejo-Delivery",
			"X-Forgejo-Event",
		]);
	});

	test("carries the body through byte-identical", () => {
		const built = buildForgeEventMessage(input());
		expect(Array.from(built.data)).toEqual(Array.from(rawBody));
	});

	test("a repository without a slash still yields a four-segment subject", () => {
		expect(buildForgeEventMessage(input({ repository: "lonely" })).subject).toBe(
			"forge.events.lonely._.push",
		);
	});
});

/**
 * Bounded close. `nc.drain()` in nats@2.29.3 has NO timeout —
 * its flush waits on a PONG with no timer — so a connected-but-unresponsive
 * cluster stalls shutdown before the scheduler drain and the observability
 * flush ever run, and with `maxReconnectAttempts: -1` a disconnected drain can
 * leave the reconnect loop alive forever.
 *
 * `close()` therefore races the drain against `closeTimeoutMs` and, on timeout
 * OR on a drain rejection, calls `nc.close()` — which aborts reconnects — and
 * logs `bus.nats.close_forced` with the discriminating reason. The happy path
 * must NOT force-close and must NOT warn, or every clean shutdown would look
 * like a fault.
 *
 * The connection factory is injected through the `connect` seam so this runs
 * without a cluster; the live test is unchanged.
 */
describe("NatsBus.close bounding", () => {
	interface FakeCalls {
		close: number;
		drain: number;
	}

	function fakeConnection(drain: () => Promise<void>): {
		nc: unknown;
		calls: FakeCalls;
	} {
		const calls: FakeCalls = { close: 0, drain: 0 };
		const nc = {
			jetstream: () => ({
				publish: async () => ({ duplicate: false }),
			}),
			drain: () => {
				calls.drain += 1;
				return drain();
			},
			close: async () => {
				calls.close += 1;
			},
		};
		return { nc, calls };
	}

	function recorder() {
		const lines: { level: string; msg: string; fields: Record<string, unknown> }[] = [];
		const emit = ((level: string, msg: string, fields: Record<string, unknown> = {}) => {
			lines.push({ level, msg, fields });
		}) as unknown as Parameters<typeof createNatsBus>[0]["log"];
		return { lines, emit };
	}

	async function busWith(drain: () => Promise<void>, closeTimeoutMs: number) {
		const fake = fakeConnection(drain);
		const rec = recorder();
		const bus = await createNatsBus({
			url: "nats://127.0.0.1:4222",
			nkeySeed: new Uint8Array([1, 2, 3]),
			log: rec.emit,
			closeTimeoutMs,
			connect: async () => fake.nc as never,
		});
		return { bus, calls: fake.calls, lines: rec.lines };
	}

	test("a drain that never resolves is bounded, force-closed, and logged as a timeout", async () => {
		const { bus, calls, lines } = await busWith(() => new Promise<void>(() => {}), 50);
		const startedAt = Date.now();
		await bus.close();
		const elapsed = Date.now() - startedAt;

		// Resolves within closeTimeoutMs + 1s rather than hanging forever.
		expect(elapsed).toBeLessThan(50 + 1000);
		// `nc.close()` is what aborts the infinite reconnect loop.
		expect(calls.close).toBe(1);

		const forced = lines.filter((line) => line.msg === "bus.nats.close_forced");
		expect(forced.length).toBe(1);
		expect(forced[0]?.level).toBe("warn");
		expect(forced[0]?.fields.reason).toBe("timeout");
		// sf#1082 / PR #1120 P3: this test's subject is a HANG CONTRACT — its
		// elapsed assertion only runs after `close()` resolves, so if the production
		// close timer stops resolving, the only signal is a test timeout. The suite's
		// global bound went to 120 s for host-latency reasons that do not apply here
		// (this test spawns nothing and touches no database), so it keeps its own
		// budget: a broken timer surfaces in 30 s, not 120 s. Measured by mutating
		// src/bus/nats.ts's timer callback to never resolve.
	}, 30_000);

	test("a rejecting drain force-closes and discriminates the reason", async () => {
		const { bus, calls, lines } = await busWith(
			() => Promise.reject(new Error("drain exploded")),
			50,
		);
		await bus.close();

		expect(calls.close).toBe(1);
		const forced = lines.filter((line) => line.msg === "bus.nats.close_forced");
		expect(forced.length).toBe(1);
		expect(forced[0]?.fields.reason).toBe("drain_failed");
	});

	test("a clean drain neither force-closes nor warns", async () => {
		const { bus, calls, lines } = await busWith(() => Promise.resolve(), 50);
		await bus.close();

		expect(calls.drain).toBe(1);
		// The happy path must not abort the connection a second time...
		expect(calls.close).toBe(0);
		// ...nor emit a fault line every clean shutdown.
		expect(lines.filter((line) => line.msg === "bus.nats.close_forced").length).toBe(0);
		expect(lines.filter((line) => line.level === "warn").length).toBe(0);
	});
});
