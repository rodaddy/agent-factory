import { describe, expect, test } from "bun:test";

// PAPERCLIP_OTEL_PG_UNDER_TEST points the suite at a mutated copy (RED proof).
const target =
	process.env.PAPERCLIP_OTEL_PG_UNDER_TEST ?? "../../fleet/paperclip-otel/postgres.mjs";

interface Span {
	name: string;
	options: { kind?: number; startTime?: number; attributes?: Record<string, unknown> };
	ctx: unknown;
	exceptions: unknown[];
	status?: { code: number };
	endTime?: number;
}
interface Wrapped {
	unsafe: (q: string, params?: unknown[]) => FakeQuery;
	begin: (fn: (tx: Wrapped) => Promise<unknown>) => Promise<unknown>;
}
interface Opts {
	tracer: unknown;
	api: unknown;
	slowMs?: number;
	now?: () => number;
}
const { wrapSql, slowMsFromEnv } = (await import(target)) as {
	wrapSql: (sql: unknown, opts: Opts) => Wrapped;
	slowMsFromEnv: (v: string | undefined) => number;
};

const api = {
	SpanKind: { CLIENT: 2 },
	SpanStatusCode: { ERROR: 2 },
	context: { active: () => "ctx" },
};

function fakeTracer() {
	const spans: Span[] = [];
	return {
		spans,
		startSpan(name: string, options: Span["options"], ctx: unknown) {
			const span: Span = { name, options, ctx, exceptions: [] };
			spans.push(span);
			return {
				recordException: (e: unknown) => span.exceptions.push(e),
				setStatus: (s: { code: number }) => {
					span.status = s;
				},
				end: (t: number) => {
					span.endTime = t;
				},
			};
		},
	};
}

// Mirrors postgres 3.4.9 src/query.js: a Promise subclass whose then/catch/finally
// start execution lazily, once, with species Promise and .values() returning this.
class FakeQuery extends Promise<unknown> {
	static override get [Symbol.species]() {
		return Promise;
	}
	executed = false;
	isRaw: string | boolean = false;
	declare resolve: (x: unknown) => void;
	declare reject: (x: unknown) => void;
	constructor(
		readonly sql: string,
		readonly params: unknown[],
		readonly handler: (q: FakeQuery) => void,
	) {
		let res: (x: unknown) => void = () => {};
		let rej: (x: unknown) => void = () => {};
		super((a, b) => {
			res = a;
			rej = b;
		});
		this.resolve = res;
		this.reject = rej;
	}
	values() {
		this.isRaw = "values";
		return this;
	}
	async handle() {
		if (this.executed) return;
		this.executed = true;
		await Promise.resolve();
		this.handler(this);
	}
	// biome-ignore lint/suspicious/noThenProperty: mirrors the real postgres.js Query
	override then<A, B>(...args: Parameters<Promise<unknown>["then"]>) {
		this.handle();
		return super.then(...args) as Promise<A | B>;
	}
	override catch(...args: Parameters<Promise<unknown>["catch"]>) {
		this.handle();
		return super.catch(...args);
	}
	override finally(...args: Parameters<Promise<unknown>["finally"]>) {
		this.handle();
		return super.finally(...args);
	}
}

// A fake sql: each query takes `durations[sql]` ms on the fake clock; "FAIL" rejects.
function fakeSql(clock: { t: number }, durations: Record<string, number> = {}) {
	const counts: Record<string, number> = {};
	const handler = (q: FakeQuery) => {
		counts[q.sql] = (counts[q.sql] ?? 0) + 1;
		clock.t += durations[q.sql] ?? 0;
		if (q.sql.includes("FAIL")) q.reject(new Error("boom"));
		else q.resolve(q.isRaw === "values" ? [[1]] : [{ id: 1 }]);
	};
	const make = (): Record<string, unknown> => ({
		unsafe: (s: string, p: unknown[] = []) => new FakeQuery(s, p, handler),
		begin: async (fn: (tx: unknown) => Promise<unknown>) => fn(make()),
	});
	return { sql: make(), counts };
}

function setup(slowMs: number | undefined, durations: Record<string, number>) {
	const clock = { t: 1_000_000 };
	const tracer = fakeTracer();
	const { sql, counts } = fakeSql(clock, durations);
	const db = wrapSql(sql, { tracer, api, slowMs, now: () => clock.t });
	return { db, tracer, counts };
}

describe("paperclip-otel postgres.js wrapper", () => {
	test("a slow query emits one CLIENT span with its real timing", async () => {
		const { db, tracer } = setup(undefined, { "select * from issues": 250 });
		expect(await db.unsafe("select * from issues", [7])).toEqual([{ id: 1 }]);
		expect(tracer.spans).toHaveLength(1);
		const [s] = tracer.spans;
		expect(s?.name).toBe("db SELECT");
		expect(s?.options.kind).toBe(2);
		expect(s?.options.startTime).toBe(1_000_000);
		expect(s?.endTime).toBe(1_000_250);
		expect(s?.ctx).toBe("ctx");
		expect(s?.options.attributes).toEqual({
			"db.system.name": "postgresql",
			"db.query.text": "select * from issues",
		});
	});

	test("a fast query emits nothing; 0 traces every query", async () => {
		const fast = setup(100, { "update x": 5 });
		await fast.db.unsafe("update x");
		expect(fast.tracer.spans).toHaveLength(0);
		const all = setup(0, { "update x": 0 });
		await all.db.unsafe("update x");
		expect(all.tracer.spans.map((s) => s.name)).toEqual(["db UPDATE"]);
	});

	test("a failing query emits an error span and still rejects", async () => {
		const { db, tracer } = setup(100, {});
		// Not expect().rejects: bun reads the promise state without calling then, so a lazy query never runs.
		const outcome = await db.unsafe("insert FAIL").then(
			() => "resolved",
			(e: Error) => e.message,
		);
		expect(outcome).toBe("boom");
		expect(tracer.spans).toHaveLength(1);
		expect(tracer.spans[0]?.status?.code).toBe(2);
		expect(tracer.spans[0]?.exceptions).toHaveLength(1);
		const caught = await db.unsafe("delete FAIL").catch((e: Error) => e.message);
		expect(caught).toBe("boom");
	});

	test(".values() keeps its result; two awaits execute the query once", async () => {
		const { db, tracer, counts } = setup(0, {});
		const q = db.unsafe("select 1").values();
		expect(await q).toEqual([[1]]);
		expect(await q).toEqual([[1]]);
		expect(counts["select 1"]).toBe(1);
		expect(tracer.spans).toHaveLength(1);
	});

	test("a query is never started before the caller awaits it", async () => {
		const { db, counts } = setup(0, {});
		db.unsafe("select 2");
		await Promise.resolve();
		await Promise.resolve();
		expect(counts["select 2"]).toBeUndefined();
	});

	test("the tx inside begin is traced", async () => {
		const { db, tracer } = setup(0, {});
		await db.begin(async (tx) => tx.unsafe("delete from y"));
		expect(tracer.spans.map((s) => s.name)).toEqual(["db DELETE"]);
	});

	test("params never reach attributes; query text truncates at 2000", async () => {
		const { db, tracer } = setup(0, {});
		const long = `select '${"a".repeat(2500)}'`;
		await db.unsafe(long, ["secret-param-value"]);
		const attrs = tracer.spans[0]?.options.attributes ?? {};
		expect(String(attrs["db.query.text"])).toHaveLength(2000);
		expect(JSON.stringify(tracer.spans)).not.toContain("secret-param-value");
	});

	test("a real postgres.js 3.x instance: refused connect is one error span, query still rejects", async () => {
		const { default: postgres } = await import("postgres");
		const tracer = fakeTracer();
		const real = postgres({ host: "127.0.0.1", port: 1, max: 1, connect_timeout: 2 });
		const db = wrapSql(real, { tracer, api, slowMs: 100 });
		const q = db.unsafe("select 1", []).values();
		expect(q).toBeInstanceOf(Promise);
		const outcome = await q.then(
			() => "resolved",
			() => "rejected",
		);
		expect(outcome).toBe("rejected");
		expect(tracer.spans.map((s) => [s.name, s.status?.code])).toEqual([["db SELECT", 2]]);
		await real.end({ timeout: 0 });
	});

	test("PAPERCLIP_OTEL_PG_SLOW_MS: default 100, 0 kept, junk falls back", () => {
		expect(slowMsFromEnv(undefined)).toBe(100);
		expect(slowMsFromEnv("0")).toBe(0);
		expect(slowMsFromEnv("250")).toBe(250);
		expect(slowMsFromEnv("nope")).toBe(100);
	});
});
