import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import type { WatcherConfig } from "../../src/config/schema";
import { forgeDeliveries } from "../../src/db/schema";
import { handleForgejoHook, verifyForgejoSignature } from "../../src/hooks/forgejo";
import { withTestDb } from "../db/helpers";

const SECRET = "s3cr3t-hook-key";

/** Config carrying one managed Forgejo repo plus one GitHub repo. */
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
			{
				name: "rodaddy/open-brain",
				provider: "github",
				checks: "standard",
				gate_selection: "full",
			},
		],
		job_templates: [],
		doorbell_enabled: true,
		shadow_publish: false,
	};
}

function sign(body: string, secret = SECRET): string {
	return createHmac("sha256", secret).update(body).digest("hex");
}

function payload(fullName = "rodaddy/software-factory"): string {
	return JSON.stringify({ action: "opened", repository: { full_name: fullName } });
}

function hookRequest(body: string, headers: Record<string, string>, method = "POST"): Request {
	return new Request("http://10.0.21.0:8787/hooks/forgejo", { method, headers, body });
}

/** Standard Forgejo headers for a signed delivery. */
function forgejoHeaders(body: string, deliveryId: string): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-forgejo-signature": sign(body),
		"x-forgejo-event": "issues",
		"x-forgejo-delivery": deliveryId,
	};
}

describe("verifyForgejoSignature", () => {
	const raw = new TextEncoder().encode(payload());

	test("accepts the correct lowercase hex digest", () => {
		expect(verifyForgejoSignature(raw, sign(payload()), SECRET)).toBe(true);
	});

	test("rejects uppercase hex", () => {
		expect(verifyForgejoSignature(raw, sign(payload()).toUpperCase(), SECRET)).toBe(false);
	});

	test("rejects a wrong-length header", () => {
		expect(verifyForgejoSignature(raw, "abc", SECRET)).toBe(false);
		expect(verifyForgejoSignature(raw, "", SECRET)).toBe(false);
		expect(verifyForgejoSignature(raw, null, SECRET)).toBe(false);
	});

	test("rejects a digest computed with the wrong secret", () => {
		expect(verifyForgejoSignature(raw, sign(payload(), "wrong"), SECRET)).toBe(false);
	});

	/**
	 * sf#704 P0. The webhook secret is argument 2, a BARE positional string, and
	 * `traced()` masks on object KEYS only — so without an explicit
	 * `redact: { args: [2] }` the secret is summarized verbatim onto the
	 * `.enter` line. the watcher host runs `LOG_LEVEL=debug` and ships stderr to Loki via
	 * Alloy, so that line is the production leak, not a hypothetical one.
	 *
	 * `rootLogger` is module-private and pino writes straight to fd 2, so this
	 * SPAWNS a child `bun -e` at debug and parses its stderr NDJSON — the same
	 * mechanism as `tests/log-traced.test.ts`, and the only way to observe what
	 * actually reaches the wire.
	 */
	test("never emits the webhook secret on the traced enter line", async () => {
		const repoRoot = new URL("../..", import.meta.url).pathname;
		const proc = Bun.spawn(
			[
				"bun",
				"-e",
				`
					const { verifyForgejoSignature } = await import("./src/hooks/forgejo.ts");
					const raw = new TextEncoder().encode("{}");
					verifyForgejoSignature(raw, null, "s3cr3t-hook-key-LEAKCANARY");
				`,
			],
			{
				cwd: repoRoot,
				env: { ...process.env, LOG_LEVEL: "debug" },
				stderr: "pipe",
				stdout: "pipe",
			},
		);
		const stderr = await new Response(proc.stderr).text();
		await proc.exited;
		const lines = stderr
			.split("\n")
			.filter((line) => line.trim().startsWith("{"))
			.map((line) => JSON.parse(line) as Record<string, unknown>);

		const enter = lines.find((line) => line.msg === "hooks.verifyForgejoSignature.enter");
		expect(enter).toBeDefined();
		expect(JSON.stringify(enter)).not.toContain("s3cr3t-hook-key-LEAKCANARY");
		expect((enter?.args as unknown[])?.[2]).toBe("[REDACTED]");
	});
});

describe("handleForgejoHook", () => {
	test("stores a new delivery for a configured forgejo repo and wakes", async () => {
		await withTestDb(async (db) => {
			let wakes = 0;
			const body = payload();
			const res = await handleForgejoHook(hookRequest(body, forgejoHeaders(body, "d-1")), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {
					wakes += 1;
				},
			});
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ accepted: true, woken: true });
			const rows = await db.select().from(forgeDeliveries);
			expect(rows.length).toBe(1);
			expect(rows[0]?.provider).toBe("forgejo");
			expect(rows[0]?.deliveryId).toBe("d-1");
			expect(rows[0]?.event).toBe("issues");
			expect(rows[0]?.repository).toBe("rodaddy/software-factory");
			expect(wakes).toBe(1);
		});
	});

	test("answers a repeated delivery id 200 duplicate and does not wake again", async () => {
		await withTestDb(async (db) => {
			let wakes = 0;
			const body = payload();
			const wiring = {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {
					wakes += 1;
				},
			};
			const first = await handleForgejoHook(
				hookRequest(body, forgejoHeaders(body, "dup-1")),
				wiring,
			);
			expect(first.status).toBe(202);
			const second = await handleForgejoHook(
				hookRequest(body, forgejoHeaders(body, "dup-1")),
				wiring,
			);
			expect(second.status).toBe(200);
			expect(await second.json()).toEqual({ accepted: true, duplicate: true });
			const rows = await db
				.select()
				.from(forgeDeliveries)
				.where(eq(forgeDeliveries.deliveryId, "dup-1"));
			expect(rows.length).toBe(1);
			expect(wakes).toBe(1);
		});
	});

	test("refuses a wrong signature with 401 and stores nothing", async () => {
		await withTestDb(async (db) => {
			let wakes = 0;
			const body = payload();
			const headers = forgejoHeaders(body, "bad-1");
			headers["x-forgejo-signature"] = sign(body, "not-the-secret");
			const res = await handleForgejoHook(hookRequest(body, headers), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {
					wakes += 1;
				},
			});
			expect(res.status).toBe(401);
			expect(await res.json()).toEqual({ accepted: false, error: "bad signature" });
			expect((await db.select().from(forgeDeliveries)).length).toBe(0);
			expect(wakes).toBe(0);
		});
	});

	test("refuses a missing signature header with 401", async () => {
		await withTestDb(async (db) => {
			const body = payload();
			const res = await handleForgejoHook(
				hookRequest(body, {
					"content-type": "application/json",
					"x-forgejo-event": "issues",
					"x-forgejo-delivery": "nosig-1",
				}),
				{ secret: SECRET, db, config: config(), wake: () => {} },
			);
			expect(res.status).toBe(401);
			expect((await db.select().from(forgeDeliveries)).length).toBe(0);
		});
	});

	test("accepts the x-gitea-* header spellings equivalently", async () => {
		await withTestDb(async (db) => {
			let wakes = 0;
			const body = payload();
			const res = await handleForgejoHook(
				hookRequest(body, {
					"content-type": "application/json",
					"x-gitea-signature": sign(body),
					"x-gitea-event": "issues",
					"x-gitea-delivery": "gitea-1",
				}),
				{
					secret: SECRET,
					db,
					config: config(),
					wake: () => {
						wakes += 1;
					},
				},
			);
			expect(res.status).toBe(202);
			const rows = await db.select().from(forgeDeliveries);
			expect(rows.length).toBe(1);
			expect(rows[0]?.deliveryId).toBe("gitea-1");
			expect(wakes).toBe(1);
		});
	});

	test("refuses a missing delivery id with 400", async () => {
		await withTestDb(async (db) => {
			const body = payload();
			const res = await handleForgejoHook(
				hookRequest(body, {
					"content-type": "application/json",
					"x-forgejo-signature": sign(body),
					"x-forgejo-event": "issues",
				}),
				{ secret: SECRET, db, config: config(), wake: () => {} },
			);
			expect(res.status).toBe(400);
			expect((await db.select().from(forgeDeliveries)).length).toBe(0);
		});
	});

	test("refuses a body with no repository.full_name with 400", async () => {
		await withTestDb(async (db) => {
			const body = JSON.stringify({ action: "opened" });
			const res = await handleForgejoHook(hookRequest(body, forgejoHeaders(body, "norepo-1")), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
			});
			expect(res.status).toBe(400);
			expect((await db.select().from(forgeDeliveries)).length).toBe(0);
		});
	});

	test("refuses a malformed repository full name with 400", async () => {
		await withTestDb(async (db) => {
			const body = payload("not a repo name");
			const res = await handleForgejoHook(hookRequest(body, forgejoHeaders(body, "badname-1")), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
			});
			expect(res.status).toBe(400);
			expect((await db.select().from(forgeDeliveries)).length).toBe(0);
		});
	});

	test("refuses an oversize declared content-length with 413", async () => {
		await withTestDb(async (db) => {
			const body = payload();
			const headers = forgejoHeaders(body, "big-1");
			headers["content-length"] = String(1_048_577);
			const res = await handleForgejoHook(hookRequest(body, headers), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
			});
			expect(res.status).toBe(413);
			expect((await db.select().from(forgeDeliveries)).length).toBe(0);
		});
	});

	test("refuses a non-POST method with 405", async () => {
		await withTestDb(async (db) => {
			const res = await handleForgejoHook(
				new Request("http://10.0.21.0:8787/hooks/forgejo", { method: "GET" }),
				{ secret: SECRET, db, config: config(), wake: () => {} },
			);
			expect(res.status).toBe(405);
			expect((await db.select().from(forgeDeliveries)).length).toBe(0);
		});
	});

	test("stores but does not wake for an unconfigured repository", async () => {
		await withTestDb(async (db) => {
			let wakes = 0;
			const body = payload("someone/unmanaged");
			const res = await handleForgejoHook(hookRequest(body, forgejoHeaders(body, "unman-1")), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {
					wakes += 1;
				},
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ accepted: true, woken: false });
			expect((await db.select().from(forgeDeliveries)).length).toBe(1);
			expect(wakes).toBe(0);
		});
	});

	test("stores but does not wake when the repo is configured on github only", async () => {
		await withTestDb(async (db) => {
			let wakes = 0;
			const body = payload("rodaddy/open-brain");
			const res = await handleForgejoHook(hookRequest(body, forgejoHeaders(body, "gh-1")), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {
					wakes += 1;
				},
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ accepted: true, woken: false });
			expect((await db.select().from(forgeDeliveries)).length).toBe(1);
			expect(wakes).toBe(0);
		});
	});
});

/**
 * Bus publication. A delivery that produced a NEW row is republished
 * onto NATS; a duplicate and a refusal are not. The bus is a best-effort side
 * channel — a stored delivery must never fail the webhook because the bus is
 * down — so a rejecting publisher changes no status code.
 */
describe("handleForgejoHook bus publication", () => {
	type Published = {
		repository: string;
		event: string;
		deliveryId: string;
		rowId: number;
		rawBody: Uint8Array;
		signature: string | null;
	};

	/** Records every publish. Resolves, as the real publisher contracts to. */
	function fakeBus(): {
		calls: Published[];
		publishForgeDelivery: (i: Published) => Promise<void>;
	} {
		const calls: Published[] = [];
		return {
			calls,
			publishForgeDelivery: async (input: Published) => {
				calls.push(input);
			},
		};
	}

	test("publishes exactly once for a new delivery, carrying the row id and raw bytes", async () => {
		await withTestDb(async (db) => {
			const bus = fakeBus();
			// PRETTY-PRINTED, and with a key the receiver never reads. A compact
			// fixture round-trips through JSON.parse/stringify byte-identically, so
			// re-encoding the parsed payload instead of forwarding the received bytes
			// would pass unnoticed (observed: mutation M7 stayed green). The HMAC is
			// over the RAW bytes, so a consumer re-verifying it needs exactly these.
			const body = JSON.stringify(
				{ action: "opened", repository: { full_name: "rodaddy/software-factory" }, zz: 1 },
				null,
				2,
			);
			const res = await handleForgejoHook(hookRequest(body, forgejoHeaders(body, "bus-1")), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
				bus,
			});
			expect(res.status).toBe(202);
			expect(bus.calls.length).toBe(1);
			const call = bus.calls[0];
			expect(call?.deliveryId).toBe("bus-1");
			expect(call?.event).toBe("issues");
			expect(call?.repository).toBe("rodaddy/software-factory");
			expect(call?.signature).toBe(sign(body));
			// The row id the insert actually returned, not a guess.
			const rows = await db
				.select()
				.from(forgeDeliveries)
				.where(eq(forgeDeliveries.deliveryId, "bus-1"));
			expect(call?.rowId).toBe(rows[0]?.id as number);
			// Byte-identical to what was posted.
			expect(Array.from(call?.rawBody as Uint8Array)).toEqual(
				Array.from(new TextEncoder().encode(body)),
			);
		});
	});

	test("publishes for an unmanaged repository too, because the row was still new", async () => {
		await withTestDb(async (db) => {
			const bus = fakeBus();
			const body = payload("someone/unmanaged");
			const res = await handleForgejoHook(hookRequest(body, forgejoHeaders(body, "bus-un-1")), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
				bus,
			});
			expect(res.status).toBe(200);
			expect(await res.json()).toEqual({ accepted: true, woken: false });
			expect(bus.calls.length).toBe(1);
		});
	});

	test("does not publish a duplicate delivery", async () => {
		await withTestDb(async (db) => {
			const bus = fakeBus();
			const body = payload();
			const wiring = { secret: SECRET, db, config: config(), wake: () => {}, bus };
			await handleForgejoHook(hookRequest(body, forgejoHeaders(body, "bus-dup")), wiring);
			expect(bus.calls.length).toBe(1);
			const second = await handleForgejoHook(
				hookRequest(body, forgejoHeaders(body, "bus-dup")),
				wiring,
			);
			expect(second.status).toBe(200);
			expect(await second.json()).toEqual({ accepted: true, duplicate: true });
			expect(bus.calls.length).toBe(1);
		});
	});

	test("does not publish a 401 refusal", async () => {
		await withTestDb(async (db) => {
			const bus = fakeBus();
			const body = payload();
			const headers = forgejoHeaders(body, "bus-401");
			headers["x-forgejo-signature"] = sign(body, "not-the-secret");
			const res = await handleForgejoHook(hookRequest(body, headers), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
				bus,
			});
			expect(res.status).toBe(401);
			expect(bus.calls.length).toBe(0);
		});
	});

	test("a rejecting publisher still yields the same 202 and still wakes", async () => {
		await withTestDb(async (db) => {
			let wakes = 0;
			const body = payload();
			const res = await handleForgejoHook(hookRequest(body, forgejoHeaders(body, "bus-throw")), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {
					wakes += 1;
				},
				bus: {
					publishForgeDelivery: () => Promise.reject(new Error("bus down")),
				},
			});
			expect(res.status).toBe(202);
			expect(await res.json()).toEqual({ accepted: true, woken: true });
			expect(wakes).toBe(1);
			// The delivery is still durably stored — the bus is a side channel.
			expect((await db.select().from(forgeDeliveries)).length).toBe(1);
		});
	});

	test("a delivery with no bus wired behaves exactly as before", async () => {
		await withTestDb(async (db) => {
			const body = payload();
			const res = await handleForgejoHook(hookRequest(body, forgejoHeaders(body, "bus-none")), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
			});
			expect(res.status).toBe(202);
			expect((await db.select().from(forgeDeliveries)).length).toBe(1);
		});
	});
});

describe("forge_deliveries.payload storage", () => {
	test("stores the payload as a jsonb object, queryable by field", async () => {
		await withTestDb(async (db) => {
			const body = payload();
			const res = await handleForgejoHook(hookRequest(body, forgejoHeaders(body, "obj-1")), {
				secret: SECRET,
				db,
				config: config(),
				wake: () => {},
			});
			expect(res.status).toBe(202);
			const rows = (await db.execute(
				sql`SELECT jsonb_typeof(payload) AS t, payload->>'action' AS action FROM forge_deliveries WHERE delivery_id = 'obj-1'`,
			)) as unknown as Array<{ t: string; action: string | null }>;
			expect(rows[0]?.t).toBe("object");
			expect(rows[0]?.action).toBe("opened");
		});
	});
});
