/**
 * @module tests/hooks/mount
 * @description Routing and bind contract for the Forgejo webhook mount.
 *   `src/hooks/forgejo.ts` owns the receiver's own decision order and is tested
 *   in `tests/hooks/forgejo.test.ts`; this file pins the two things MOUNTING it
 *   changed about the status server:
 *
 *     1. `POST /hooks/forgejo` reaches the receiver only when `forgeHook` wiring
 *        is present, and only for POST — the route must not become a second
 *        readable surface, and an unwired server must not answer it at all.
 *     2. The doorbell's "localhost only" property was previously the BIND
 *        (127.0.0.1). The webhook route makes the server bindable on 0.0.0.0, so
 *        that property is now a remote-address check, and it is tested here
 *        rather than assumed from the hostname.
 */

import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import type { StatusSnapshot } from "../../src/status/query";
import { createStatusHandler, startStatusServer } from "../../src/status/server";
import { withTestDb } from "../db/helpers";

const SECRET = "s3cr3t-hook-key";

const SNAPSHOT: StatusSnapshot = {
	generatedAt: "2026-08-29T00:00:00Z",
	repositories: [],
	heldBoxes: [],
	unconfirmedAllocations: [],
	tracedAttempts: [],
};

/** Config carrying the one managed Forgejo repository the fixtures deliver for. */
function config(): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [
			{
				name: "rodaddy/software-factory",
				provider: "forgejo",
				checks: "standard",
				gate_selection: "full",
			},
		],
		job_templates: [],
		doorbell_enabled: true,
		shadow_publish: false,
	};
}

function sign(body: string): string {
	return createHmac("sha256", SECRET).update(body).digest("hex");
}

function payload(): string {
	return JSON.stringify({
		action: "opened",
		repository: { full_name: "rodaddy/software-factory" },
	});
}

/** A correctly signed Forgejo delivery aimed at the mounted path. */
function hookRequest(body: string): Request {
	return new Request("http://10.0.21.0:8787/hooks/forgejo", {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-forgejo-signature": sign(body),
			"x-forgejo-event": "issues",
			"x-forgejo-delivery": crypto.randomUUID(),
		},
		body,
	});
}

/** A doorbell ring whose Host authority is loopback — the header guard passes. */
function doorbellReq(): Request {
	return new Request("http://localhost/doorbell", {
		method: "POST",
		headers: { "content-type": "application/json", host: "localhost" },
		body: JSON.stringify({ repository: "rodaddy/software-factory" }),
	});
}

/**
 * Bun hands `fetch` the server as its second argument. Fake just the one method
 * the handler uses, so a remote address can be stated rather than produced by
 * binding a socket to a non-loopback interface.
 */
function fakeServer(address: string) {
	return { requestIP: (_req: Request) => ({ address }) };
}

describe("POST /hooks/forgejo mount", () => {
	test("a signed delivery for a managed forgejo repo is accepted and wakes", async () => {
		await withTestDb(async (db) => {
			let wakes = 0;
			const handler = createStatusHandler({
				source: async () => SNAPSHOT,
				pollIntervalMinutes: 15,
				forgeHook: {
					secret: SECRET,
					db,
					config: config(),
					wake: () => {
						wakes += 1;
					},
				},
			});

			const res = await handler(hookRequest(payload()));
			expect(res.status).toBe(202);
			expect(wakes).toBe(1);
		});
	});

	test("without forgeHook wiring the path is not a route: POST falls to the GET-only guard", async () => {
		const handler = createStatusHandler({
			source: async () => SNAPSHOT,
			pollIntervalMinutes: 15,
		});
		const res = await handler(hookRequest(payload()));
		expect(res.status).toBe(405);
	});

	test("the route is POST-only: GET /hooks/forgejo is 404 even when wired", async () => {
		await withTestDb(async (db) => {
			let wakes = 0;
			const handler = createStatusHandler({
				source: async () => SNAPSHOT,
				pollIntervalMinutes: 15,
				forgeHook: {
					secret: SECRET,
					db,
					config: config(),
					wake: () => {
						wakes += 1;
					},
				},
			});
			const res = await handler(new Request("http://10.0.21.0:8787/hooks/forgejo"));
			expect(res.status).toBe(404);
			expect(wakes).toBe(0);
		});
	});
});

describe("doorbell remote-address guard", () => {
	/** A handler whose doorbell counts wakes, so a refusal can be proved silent. */
	function wired(): {
		handler: (
			req: Request,
			server?: { requestIP(req: Request): { address: string } | null },
		) => Promise<Response>;
		wakes: () => number;
	} {
		let wakes = 0;
		const handler = createStatusHandler({
			source: async () => SNAPSHOT,
			pollIntervalMinutes: 15,
			doorbell: {
				config: config(),
				wake: () => {
					wakes += 1;
				},
			},
		});
		return { handler, wakes: () => wakes };
	}

	test("a non-loopback remote address is refused 403 and never wakes", async () => {
		const { handler, wakes } = wired();
		const res = await handler(doorbellReq(), fakeServer("10.0.20.58"));
		expect(res.status).toBe(403);
		expect(wakes()).toBe(0);
	});

	test("an IPv4 loopback remote address is accepted", async () => {
		const { handler, wakes } = wired();
		const res = await handler(doorbellReq(), fakeServer("127.0.0.1"));
		expect(res.status).toBe(202);
		expect(wakes()).toBe(1);
	});

	test("an IPv4-mapped IPv6 loopback remote address is accepted", async () => {
		const { handler, wakes } = wired();
		const res = await handler(doorbellReq(), fakeServer("::ffff:127.0.0.1"));
		expect(res.status).toBe(202);
		expect(wakes()).toBe(1);
	});

	test("an omitted server skips the check, preserving direct-call behaviour", async () => {
		const { handler, wakes } = wired();
		const res = await handler(doorbellReq());
		expect(res.status).toBe(202);
		expect(wakes()).toBe(1);
	});
});

describe("startStatusServer bind", () => {
	test("honours an explicit hostname while carrying forgeHook wiring", async () => {
		await withTestDb(async (db) => {
			const server = startStatusServer({
				db,
				pollIntervalMinutes: 15,
				hostname: "127.0.0.1",
				port: 0,
				forgeHook: {
					secret: SECRET,
					db,
					config: config(),
					wake: () => {},
				},
			});
			try {
				expect(server.hostname).toBe("127.0.0.1");
			} finally {
				await server.stop(true);
			}
		});
	});
});

describe("off-machine peers reach only the webhook (sf#424 review F1/F3/F4)", () => {
	/** Every read route, with the peer address stated. */
	function statusHandler(accepting?: () => boolean) {
		return createStatusHandler({
			source: async () => SNAPSHOT,
			pollIntervalMinutes: 15,
			accepting,
			doorbell: { config: config(), wake: () => {} },
		});
	}

	test("a non-loopback peer is refused 403 on every read route and the doorbell", async () => {
		const handler = statusHandler();
		const peer = fakeServer("10.0.20.58");
		for (const path of ["/", "/index.html", "/status.json", "/healthz", "/nope"]) {
			const res = await handler(new Request(`http://10.0.21.0:8787${path}`), peer);
			expect([path, res.status]).toEqual([path, 403]);
		}
		const bell = await handler(doorbellReq(), peer);
		expect(bell.status).toBe(403);
	});

	test("a loopback peer still reads the page, the JSON, and the health probe", async () => {
		const handler = statusHandler();
		const peer = fakeServer("127.0.0.1");
		expect((await handler(new Request("http://localhost:8787/"), peer)).status).toBe(200);
		expect((await handler(new Request("http://localhost:8787/status.json"), peer)).status).toBe(
			200,
		);
		expect((await handler(new Request("http://localhost:8787/nope"), peer)).status).toBe(404);
	});

	test("a non-loopback peer can still deliver a signed webhook", async () => {
		await withTestDb(async (db) => {
			let wakes = 0;
			const handler = createStatusHandler({
				source: async () => SNAPSHOT,
				pollIntervalMinutes: 15,
				forgeHook: {
					secret: SECRET,
					db,
					config: config(),
					wake: () => {
						wakes += 1;
					},
				},
			});
			const res = await handler(hookRequest(payload()), fakeServer("10.0.20.58"));
			expect(res.status).toBe(202);
			expect(wakes).toBe(1);
		});
	});

	test("a delivery arriving during shutdown is refused 503 before anything is stored", async () => {
		await withTestDb(async (db) => {
			let wakes = 0;
			const handler = createStatusHandler({
				source: async () => SNAPSHOT,
				pollIntervalMinutes: 15,
				accepting: () => false,
				forgeHook: {
					secret: SECRET,
					db,
					config: config(),
					wake: () => {
						wakes += 1;
					},
				},
			});
			const res = await handler(hookRequest(payload()));
			expect(res.status).toBe(503);
			expect(wakes).toBe(0);
			const rows = await db.execute<{ n: string }>(
				sql`SELECT count(*)::text AS n FROM forge_deliveries`,
			);
			expect(rows[0]?.n).toBe("0");
		});
	});

	test("the transport body cap applies only when the webhook is wired", async () => {
		await withTestDb(async (db) => {
			const big = "x".repeat(2 * 1024 * 1024);
			const bare = startStatusServer({
				db,
				pollIntervalMinutes: 15,
				hostname: "127.0.0.1",
				port: 0,
			});
			try {
				const res = await fetch(`http://127.0.0.1:${bare.port}/unknown`, {
					method: "POST",
					body: big,
				});
				expect(res.status).toBe(405);
			} finally {
				await bare.stop(true);
			}
			const wired = startStatusServer({
				db,
				pollIntervalMinutes: 15,
				hostname: "127.0.0.1",
				port: 0,
				forgeHook: { secret: SECRET, db, config: config(), wake: () => {} },
			});
			try {
				const res = await fetch(`http://127.0.0.1:${wired.port}/hooks/forgejo`, {
					method: "POST",
					body: big,
				});
				expect(res.status).toBe(413);
			} finally {
				await wired.stop(true);
			}
		});
	});
});
