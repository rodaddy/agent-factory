// Traces postgres.js (3.x) queries for Paperclip. No OTel
// instrumentation exists for postgres.js, and drizzle-orm drives it through
// sql.unsafe(query, params) (plus .values()) and sql.begin(tx => ...).
//
// Pure: the OTel api and tracer are passed in, so tests drive it with fakes.
// A postgres.js query is a Promise subclass that starts executing on its first
// then/catch/finally (catch and finally route through this.then). This module
// wraps then on the instance and never calls it before the caller does.

const WRAPPED = Symbol.for("paperclip-otel.postgres.wrapped");
const MAX_QUERY_TEXT = 2000;

export function slowMsFromEnv(value) {
	const n = Number(value);
	return value !== undefined && value !== "" && Number.isFinite(n) && n >= 0 ? n : 100;
}

function operation(text) {
	const word = /^\s*([a-z]+)/i.exec(String(text));
	return word?.[1] ? word[1].toUpperCase() : "QUERY";
}

function traceQuery(query, text, o) {
	if (!query || typeof query.then !== "function" || query[WRAPPED]) return query;
	const then = query.then;
	let started = false;
	query[WRAPPED] = true;
	// biome-ignore lint/suspicious/noThenProperty: the query already is a thenable; this wraps its own then
	query.then = function (...args) {
		if (!started) {
			started = true;
			const ctx = o.api.context.active();
			const start = o.now();
			const finish = (error) => {
				const end = o.now();
				if (!error && end - start < o.slowMs) return;
				const span = o.tracer.startSpan(
					`db ${operation(text)}`,
					{
						kind: o.api.SpanKind.CLIENT,
						startTime: start,
						attributes: {
							"db.system.name": "postgresql",
							"db.query.text": String(text).slice(0, MAX_QUERY_TEXT),
						},
					},
					ctx,
				);
				if (error) {
					span.recordException(error);
					span.setStatus({ code: o.api.SpanStatusCode.ERROR, message: String(error?.message) });
				}
				span.end(end);
			};
			then.call(
				this,
				() => finish(),
				(e) => finish(e ?? new Error("query failed")),
			);
		}
		return then.apply(this, args);
	};
	return query;
}

function wrapCallbacks(fn, o) {
	return function (...args) {
		return fn.apply(
			this,
			args.map((a) => (typeof a === "function" ? (tx, ...rest) => a(wrapSql(tx, o), ...rest) : a)),
		);
	};
}

// Wraps sql in place (postgres.js instances are plain function objects) and returns it.
export function wrapSql(sql, opts) {
	if (!sql || sql[WRAPPED]) return sql;
	const o = { now: () => Date.now(), slowMs: 100, ...opts };
	if (o.slowMs === undefined) o.slowMs = 100;
	sql[WRAPPED] = true;
	if (typeof sql.unsafe === "function") {
		const unsafe = sql.unsafe;
		sql.unsafe = function (text, ...rest) {
			return traceQuery(unsafe.call(this, text, ...rest), text, o);
		};
	}
	for (const name of ["begin", "savepoint"]) {
		if (typeof sql[name] === "function") sql[name] = wrapCallbacks(sql[name], o);
	}
	return sql;
}

// An OTel instrumentation for the `postgres` module, built from the host's own
// @opentelemetry/instrumentation classes so one api copy is used. It patches
// the default export (the factory) so every instance it returns is wrapped.
export function createPostgresInstrumentation(otel, api, slowMs) {
	const { InstrumentationBase, InstrumentationNodeModuleDefinition } = otel;
	class PostgresJsInstrumentation extends InstrumentationBase {
		constructor() {
			super("paperclip-otel-postgres", "1.0.0", {});
		}
		init() {
			const opts = () => ({ tracer: this.tracer, api, slowMs });
			const wrapFactory = (factory) => {
				if (typeof factory !== "function" || factory[WRAPPED]) return factory;
				const wrapped = function (...args) {
					return wrapSql(factory.apply(this, args), opts());
				};
				Object.assign(wrapped, factory);
				wrapped[WRAPPED] = true;
				return wrapped;
			};
			const patch = (exports) => {
				// ESM (import-in-the-middle): a namespace whose default is the factory.
				if (typeof exports === "function") return wrapFactory(exports);
				if (exports && typeof exports.default === "function") {
					exports.default = wrapFactory(exports.default);
				}
				return exports;
			};
			return [new InstrumentationNodeModuleDefinition("postgres", [">=3 <4"], patch)];
		}
	}
	return new PostgresJsInstrumentation();
}
