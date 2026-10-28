/**
 * @module tests/doctor/probe
 * @description Hermetic tests for the deployed-path smoke probes. They
 *   use FAKE db/client — no real database or network. They assert: EACH probe
 *   failing independently surfaces a FAIL with a bounded reason; and CRUCIALLY
 *   that no probe detail ever contains a token
 *   value (a sentinel token is passed to the fakes and asserted absent from every
 *   detail).
 */
import { describe, expect, test } from "bun:test";
import {
	type ProbeSeams,
	probeForgeRead,
	probePostgres,
	probeStatusHealth,
} from "../../src/doctor/probe";
import { providerApiBase } from "../../src/forge/provider";

/** A recognizable secret sentinel; it must NEVER appear in any probe detail. */
const SENTINEL_TOKEN = "ghp_SENTINEL_TOKEN_DO_NOT_LEAK_0000000000";

/** A fake db whose only used method is execute(). */
function fakeDb(behavior: "ok" | "throw") {
	return {
		db: {
			execute: async () => {
				if (behavior === "throw") throw new Error("boom");
				return [{ one: 1 }];
			},
		} as never,
		client: { end: async () => undefined },
	};
}

/** A fake forge client returning a canned `/version` response. */
function fakeForge(response: { status: number; data: unknown }) {
	return {
		get: async () => ({
			status: response.status,
			data: response.data,
			link: null,
			rateRemaining: 1,
		}),
	} as never;
}

describe("probePostgres", () => {
	test("passes on a successful SELECT 1 round-trip", async () => {
		const { probe } = await probePostgres({ createDb: () => fakeDb("ok") });
		expect(probe.name).toBe("postgres");
		expect(probe.ok).toBe(true);
	});

	test("fails with a bounded reason on a driver error", async () => {
		const { probe } = await probePostgres({ createDb: () => fakeDb("throw") });
		expect(probe.ok).toBe(false);
		expect(probe.detail.length).toBeGreaterThan(0);
		expect(probe.detail).not.toContain("boom");
	});

	test("fails closed when the db client cannot be built (never leaks the URL)", async () => {
		const seams: ProbeSeams = {
			createDb: () => {
				throw new Error("DATABASE_URL=postgres://user:secret@host/db invalid");
			},
		};
		const { probe, db } = await probePostgres(seams);
		expect(probe.ok).toBe(false);
		expect(db).toBeNull();
		expect(probe.detail).not.toContain("secret");
		expect(probe.detail).not.toContain("postgres://");
	});
});

describe("probeForgeRead", () => {
	test("passes on a 200 /version carrying a non-empty version string", async () => {
		const seams: ProbeSeams = {
			resolveForgejoToken: () => ({ ok: true, token: SENTINEL_TOKEN }),
			createForgejoClient: () => fakeForge({ status: 200, data: { version: "16.0.1" } }),
		};
		const probe = await probeForgeRead(seams);
		expect(probe.ok).toBe(true);
		expect(probe.name).toBe("forge-read");
		expect(probe.detail).toBe("GET /version ok");
		expect(probe.detail).not.toContain(SENTINEL_TOKEN);
	});

	test("fails when no token is available", async () => {
		const probe = await probeForgeRead({
			resolveForgejoToken: () => ({ ok: false, error: "no token" }),
		});
		expect(probe.ok).toBe(false);
		expect(probe.name).toBe("forge-read");
		expect(probe.detail).toBe("no Forgejo token available");
	});

	test("fails on a non-200 status", async () => {
		const seams: ProbeSeams = {
			resolveForgejoToken: () => ({ ok: true, token: SENTINEL_TOKEN }),
			createForgejoClient: () => fakeForge({ status: 403, data: {} }),
		};
		const probe = await probeForgeRead(seams);
		expect(probe.ok).toBe(false);
		expect(probe.detail).toBe("GET /version did not return a parseable 200");
		expect(probe.detail).not.toContain(SENTINEL_TOKEN);
	});

	test("the version is never printed, whatever its shape, so an echoed token cannot reach the report", async () => {
		for (const version of [
			SENTINEL_TOKEN,
			`16.0.1-${SENTINEL_TOKEN}`,
			"16.0.1\nAuthorization: token SENTINEL",
			"token abc SENTINEL",
			"x".repeat(41),
			"16.0.1\u0007",
			"16.0.1+gitea-1.22.0",
		]) {
			const probe = await probeForgeRead({
				resolveForgejoToken: () => ({ ok: true, token: SENTINEL_TOKEN }),
				createForgejoClient: () => fakeForge({ status: 200, data: { version } }),
			});
			expect(probe.ok).toBe(true);
			expect(probe.detail).toBe("GET /version ok");
			expect(probe.detail).not.toContain(SENTINEL_TOKEN);
			expect(probe.detail).not.toContain("SENTINEL");
		}
	});

	test("fails when the version field is present but empty", async () => {
		const seams: ProbeSeams = {
			resolveForgejoToken: () => ({ ok: true, token: SENTINEL_TOKEN }),
			createForgejoClient: () => fakeForge({ status: 200, data: { version: "" } }),
		};
		const probe = await probeForgeRead(seams);
		expect(probe.ok).toBe(false);
		expect(probe.detail).toBe("GET /version did not return a parseable 200");
	});

	test("builds the client against the reviewed forgejo api base", async () => {
		const bases: string[] = [];
		const seams: ProbeSeams = {
			resolveForgejoToken: () => ({ ok: true, token: SENTINEL_TOKEN }),
			createForgejoClient: (_token, opts) => {
				bases.push(opts.baseUrl);
				return fakeForge({ status: 200, data: { version: "16.0.1" } });
			},
		};
		await probeForgeRead(seams);
		expect(bases).toEqual([providerApiBase("forgejo")]);
	});

	test("never leaks the token even when the client throws with it", async () => {
		const seams: ProbeSeams = {
			resolveForgejoToken: () => ({ ok: true, token: SENTINEL_TOKEN }),
			createForgejoClient: () =>
				({
					get: async () => {
						throw new Error(`request with token ${SENTINEL_TOKEN} failed`);
					},
				}) as never,
		};
		const probe = await probeForgeRead(seams);
		expect(probe.ok).toBe(false);
		expect(probe.detail).toBe("GET /version failed");
		expect(probe.detail).not.toContain(SENTINEL_TOKEN);
	});
});

describe("probeStatusHealth", () => {
	test("fails when there is no database connection", async () => {
		const probe = await probeStatusHealth(null, "2026-07-20T00:00:00Z");
		expect(probe.ok).toBe(false);
		expect(probe.name).toBe("status-health");
	});
	// A passing status-health path is covered end-to-end against a real scratch DB
	// in command.test.ts (withTestDb), keeping this unit file free of a live DB.
});

describe("no probe detail ever contains the token value", () => {
	test("across every forge detail the sentinel never appears", async () => {
		const seams: ProbeSeams = {
			resolveForgejoToken: () => ({ ok: true, token: SENTINEL_TOKEN }),
			createForgejoClient: () => fakeForge({ status: 200, data: { version: "16.0.1" } }),
		};
		const forge = await probeForgeRead(seams);
		for (const probe of [forge]) {
			expect(probe.detail).not.toContain(SENTINEL_TOKEN);
			expect(probe.detail.length).toBeLessThanOrEqual(200);
		}
	});
});
