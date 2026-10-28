/**
 * @module doctor/probe
 * @description The deployed-path smoke probes. Each probe reuses an
 *   EXISTING composition seam — the same db factory, Forgejo credential/client,
 *   and status query the service wires —
 *   and returns a bounded `{name, ok, detail}` where `detail` NEVER contains a
 *   secret, token, or credential-bearing URL. The seams are injectable so tests
 *   fake the db/client with no real network or database.
 *
 *   The probes prove, end to end, that a deployed watcher can reach the
 *   things it depends on:
 *     - postgres: a bounded `SELECT 1` round-trips through the drizzle client
 *       (`createDb` builds it; `validateConnectionString` already guards the URL).
 *     - forge-read: a READ-ONLY `GET /version` against the deployed Forgejo host
 *       returns a parseable 200 carrying a non-empty version (never a write
 *       endpoint; the token is never placed in any detail/log). Forge is the
 *       factory's git provider, so the reachability the doctor proves is
 *       Forgejo's, not the read-only GitHub mirror's.
 *     - status-health: `getStatus` assembles a bounded snapshot without throwing.
 *     - gateway-reachable: the configured runner-boxes gateway answers HTTP.
 *   The runner-dispatch box probe was retired with sf#830 (D10).
 *
 * @outputs
 *   - `ProbeResult` -- the bounded per-probe outcome
 *   - `probePostgres` / `probeForgeRead` / `probeStatusHealth` / `probeGatewayReachable`
 *   - `ProbeSeams` -- the injectable composition boundary
 *
 * @dependencies
 *   - drizzle-orm -- the bounded SELECT 1
 *   - ../db/client, ../forge/provider, ../forgejo/client, ../forgejo/credentials
 *   - ../status/query -- the bounded status snapshot
 */
import { sql } from "drizzle-orm";
import type { WatcherConfig } from "../config/schema";
import { createDb, type WatcherDb } from "../db/client";
import type { ForgeClient } from "../forge/boundary";
import { providerApiBase } from "../forge/provider";
import { createForgejoClient, type ForgejoClientOptions } from "../forgejo/client";
import { type ForgejoDeploymentConfig, resolveForgejoDeployment } from "../forgejo/config";
import { resolveForgejoToken } from "../forgejo/credentials";
import { errorClass, log, traced } from "../log";
import { getStatus } from "../status/query";

/** The bounded, secret-free outcome of one probe. */
export interface ProbeResult {
	/** The fixed probe name (stable, log-safe). */
	name: string;
	/** True only when the probe proved its dependency end to end. */
	ok: boolean;
	/**
	 * A short, bounded explanation. It NEVER contains a token, secret, or
	 * credential-bearing URL — probes interpolate only fixed author text and
	 * already-bounded, non-secret counts/statuses.
	 */
	detail: string;
}

/** Injectable composition seams. Production leaves these unset; tests inject fakes. */
export interface ProbeSeams {
	/** DB factory. Defaults to the real `createDb`. */
	createDb?: () => { db: WatcherDb; client: { end?: () => Promise<void> } };
	/** Forgejo token resolver. Defaults to the environment-only resolver. */
	resolveForgejoToken?: typeof resolveForgejoToken;
	/** Forgejo client factory. */
	createForgejoClient?: (token: string, opts: ForgejoClientOptions) => ForgeClient;
	/** Validated Forgejo endpoints; production resolves the infrastructure env. */
	forgejoDeployment?: ForgejoDeploymentConfig;
	/**
	 * The runner-boxes gateway URL to probe for reachability. Absent
	 * means no HTTP gateway is configured. Tests that only need a URL set this;
	 * production sets `gatewayTarget`, which can additionally express the
	 * misconfigured "HTTP selected, no address" state.
	 */
	gatewayUrl?: string;
	/**
	 * What the dispatch configuration says about a gateway, from
	 * `resolveProbeGatewayUrl`. Takes precedence over `gatewayUrl` when both are
	 * present, because it is the richer of the two.
	 */
	gatewayTarget?: { mode: "mcp2cli" } | { mode: "http"; url: string | undefined };
	/** Fetch seam for the gateway probe. Tests inject; production uses global fetch. */
	fetch?: (url: string, init?: { signal?: AbortSignal; method?: string }) => Promise<Response>;
	/** Bound on the gateway probe's own wait. */
	gatewayTimeoutMs?: number;
}

/** Hard cap on any bounded probe detail. */
const MAX_DETAIL = 200;

/** Bound a detail string defensively before it leaves the probe. */
function bound(value: string): string {
	const trimmed = value.replace(/\s+/g, " ").trim();
	return trimmed.length > MAX_DETAIL ? `${trimmed.slice(0, MAX_DETAIL - 3)}...` : trimmed;
}

/** A fixed, secret-free failure detail. Never echoes an error message verbatim. */
function failDetail(fixed: string): string {
	return bound(fixed);
}

/**
 * Probe (a): PostgreSQL. Build the drizzle client through the SAME `createDb`
 * seam the service uses (`validateConnectionString` already guards the URL), run
 * a bounded `SELECT 1`, and require a successful round-trip. The connection
 * string is never touched here, so no credential can reach the detail.
 *
 * The db handle is returned so probe (c) can reuse the exact same connection
 * rather than opening a second one; the caller closes the underlying client once.
 */
export const probePostgres = traced(
	"doctor.probePostgres",
	async function probePostgres(
		seams: ProbeSeams,
	): Promise<{ probe: ProbeResult; db: WatcherDb | null; close: () => Promise<void> }> {
		const make = seams.createDb ?? createDb;
		let handle: { db: WatcherDb; client: { end?: () => Promise<void> } };
		try {
			handle = make();
		} catch (err) {
			// A bad/absent DATABASE_URL throws here; the message can quote the URL, so
			// NEVER surface it — emit only fixed text. The LOG line is subject to the same
			// rule: record the error's CLASS only, never its message.
			log("error", "doctor.postgres.client_build_failed", { error_class: errorClass(err) });
			return {
				probe: {
					name: "postgres",
					ok: false,
					detail: failDetail("could not build database client"),
				},
				db: null,
				close: async () => undefined,
			};
		}
		const close = async (): Promise<void> => {
			try {
				await handle.client.end?.();
			} catch (err) {
				// Closing must not mask the probe outcome, so this is ignorable — debug only.
				// CLASS only: a driver error message can quote DATABASE_URL with its password.
				log("debug", "doctor.postgres.close_failed", { error_class: errorClass(err) });
			}
		};
		try {
			await handle.db.execute(sql`SELECT 1`);
			return {
				probe: { name: "postgres", ok: true, detail: "SELECT 1 round-trip succeeded" },
				db: handle.db,
				close,
			};
		} catch (err) {
			// A driver error message can carry the connection string; emit only fixed text,
			// and log the error CLASS only for the same reason.
			log("error", "doctor.postgres.select_failed", { error_class: errorClass(err) });
			return {
				probe: { name: "postgres", ok: false, detail: failDetail("SELECT 1 round-trip failed") },
				db: handle.db,
				close,
			};
		}
	},
);

/**
 * Probe (b): forge read. Resolve `FORGEJO_TOKEN` through the SAME seam (never
 * logged), build the Forgejo client against the reviewed `providerApiBase`
 * endpoint, and perform a READ-ONLY `GET /version` — always available and
 * side-effect-free. Require a 200 whose body carries a non-empty `version`
 * string. Nothing from the response reaches the detail: the version is the
 * pass CONDITION, never printed (PR #691 review, rounds 1-2), because a server
 * or proxy that echoes the Authorization header would otherwise carry the
 * token into the report through any shape an allowlist accepts.
 */

export const probeForgeRead = traced(
	"doctor.probeForgeRead",
	async function probeForgeRead(seams: ProbeSeams): Promise<ProbeResult> {
		const resolve = seams.resolveForgejoToken ?? resolveForgejoToken;
		const token = resolve();
		if (!token.ok) {
			// `resolveForgejoToken` already returns a secret-free error, but keep the
			// detail fixed so no future change can leak a value through it.
			return { name: "forge-read", ok: false, detail: failDetail("no Forgejo token available") };
		}
		const make = seams.createForgejoClient ?? createForgejoClient;
		const client = make(token.token, { baseUrl: providerApiBase("forgejo") });
		try {
			const response = await client.get<{ version?: unknown }>("/version");
			const version = response.data?.version;
			if (response.status !== 200 || typeof version !== "string" || version.length === 0) {
				return {
					name: "forge-read",
					ok: false,
					detail: failDetail("GET /version did not return a parseable 200"),
				};
			}
			// FIXED success text: the version proved the endpoint answered, and that is
			// all the report says. A server-controlled value, whatever its shape, is
			// never interpolated.
			return { name: "forge-read", ok: true, detail: "GET /version ok" };
		} catch (err) {
			// The surfaced detail stays fixed. The LOG records the error CLASS only: the
			// comment here used to claim this error is token-free, and it is NOT — a client
			// error can echo the Authorization header, which the sentinel-token test caught
			// leaking into this very line.
			log("error", "doctor.forge_read.failed", { error_class: errorClass(err) });
			return {
				name: "forge-read",
				ok: false,
				detail: failDetail("GET /version failed"),
			};
		}
	},
);

/**
 * Probe (b'): Forgejo read. Runs ONLY when the config declares a `forgejo`
 * repository — a GitHub-only deployment neither needs nor is asked for a Forgejo
 * token. Resolve `FORGEJO_TOKEN` through the SEPARATE resolver (never the gh CLI,
 * never logged), build the Forgejo client, and perform a READ-ONLY, side-effect-
 * free `GET /user` (the authenticated identity endpoint — it proves the token
 * reaches the deployed Forgejo host without writing anything). Require a 200 with
 * a parseable object body. The token is never interpolated into any detail; only
 * fixed probe text reaches the surface.
 */
export const probeForgejoRead = traced(
	"doctor.probeForgejoRead",
	async function probeForgejoRead(seams: ProbeSeams): Promise<ProbeResult> {
		const deployment = seams.forgejoDeployment
			? { ok: true as const, config: seams.forgejoDeployment }
			: resolveForgejoDeployment();
		if (!deployment.ok) {
			return {
				name: "forgejo-read",
				ok: false,
				detail: failDetail("invalid Forgejo endpoint configuration"),
			};
		}
		const resolve = seams.resolveForgejoToken ?? resolveForgejoToken;
		const token = resolve();
		if (!token.ok) {
			// The resolver already returns a secret-free error; keep the detail fixed so
			// no future change can leak a value through it.
			return { name: "forgejo-read", ok: false, detail: failDetail("no Forgejo token available") };
		}
		const make = seams.createForgejoClient ?? createForgejoClient;
		const client = make(token.token, { baseUrl: deployment.config.apiUrl });
		try {
			const response = await client.get<unknown>("/user");
			if (response.status !== 200 || typeof response.data !== "object" || response.data === null) {
				return {
					name: "forgejo-read",
					ok: false,
					detail: failDetail("GET /user did not return a parseable 200"),
				};
			}
			return { name: "forgejo-read", ok: true, detail: "GET /user ok" };
		} catch (err) {
			// Same rule as the GitHub probe: CLASS only, never the message, which can echo
			// the Authorization header.
			log("error", "doctor.forgejo_read.failed", { error_class: errorClass(err) });
			return { name: "forgejo-read", ok: false, detail: failDetail("GET /user failed") };
		}
	},
);

/** True when the config manages at least one `forgejo` repository. */
export const configHasForgejoRepo = traced(
	"doctor.configHasForgejoRepo",
	function configHasForgejoRepo(config: WatcherConfig): boolean {
		return config.repositories.some((repo) => repo.provider === "forgejo");
	},
);

/**
 * Probe (c): status health. Assemble the bounded status snapshot through the SAME
 * `getStatus` query the status page uses, reusing the db from probe (a). Success
 * is simply that it returns without throwing (an empty snapshot is fine — the
 * probe proves the query path, not that data exists). `getStatus` already selects
 * only counts/states/bounded summaries — never bodies, prompts, or secrets.
 */
export const probeStatusHealth = traced(
	"doctor.probeStatusHealth",
	async function probeStatusHealth(db: WatcherDb | null, nowIso: string): Promise<ProbeResult> {
		if (db === null) {
			return {
				name: "status-health",
				ok: false,
				detail: failDetail("skipped: no database connection"),
			};
		}
		try {
			const snapshot = await getStatus(db, nowIso);
			return {
				name: "status-health",
				ok: true,
				detail: bound(`snapshot ok: ${snapshot.repositories.length} repositories`),
			};
		} catch (err) {
			// The surfaced detail is deliberately fixed. This reaches the query through the
			// db driver, whose message can quote DATABASE_URL with its password, so record
			// the CLASS only.
			log("error", "doctor.status_health.failed", { error_class: errorClass(err) });
			return {
				name: "status-health",
				ok: false,
				detail: failDetail("status snapshot assembly failed"),
			};
		}
	},
);

/** Default bound on the gateway reachability probe's own wait. */
const GATEWAY_PROBE_TIMEOUT_MS = 5_000;

/**
 * Probe (e): is the runner-boxes gateway ANSWERING?
 *
 * THE DISTINCTION THIS EXISTS TO MAKE. On 2026-09-08 the gateway CT was
 * stopped for 35 h. `doctor` still ran, and the (since retired) runner
 * dispatch probe reported "runner did not accept the job" — true, and misleading: it reads
 * as a runner-side rejection when in fact nothing was listening on the port.
 * This probe separates *nothing is listening* from *something is listening and
 * said no*, because those are different operator pages.
 *
 * ANY HTTP RESPONSE IS A PASS, 401 AND 5xx INCLUDED. The question asked here is
 * narrow on purpose: does a gateway answer at the configured URL? An auth
 * challenge answers it affirmatively — the socket was accepted and a server
 * spoke HTTP. Treating 401 as FAIL would make this a credential check wearing a
 * reachability name, red on a token rotation while the gateway is perfectly
 * healthy; whether the gateway WORKS is judged by real dispatches, not here.
 *
 * An ABSENT URL is a PASS. An mcp2cli deployment configures no HTTP gateway, and
 * a probe that failed there would make `doctor` red on a correct deployment.
 *
 * The URL is never echoed into the detail: it can carry credentials in userinfo,
 * and an error message from `fetch` quotes the URL it was given.
 */
export const probeGatewayReachable = traced(
	"doctor.probeGatewayReachable",
	async function probeGatewayReachable(seams: ProbeSeams): Promise<ProbeResult> {
		const name = "gateway-reachable";
		// A bare `gatewayUrl` seam means a test picked the http path explicitly; NO
		// gateway seam at all means nothing was configured, which is the mcp2cli
		// shape. Defaulting the empty case to `http` instead would fail every caller
		// that never opted into a gateway.
		const target: NonNullable<ProbeSeams["gatewayTarget"]> =
			seams.gatewayTarget ??
			(seams.gatewayUrl === undefined
				? { mode: "mcp2cli" }
				: { mode: "http", url: seams.gatewayUrl });
		if (target.mode === "mcp2cli") {
			// No gateway is in this deployment's dispatch path, so there is nothing to
			// reach and nothing wrong. This is the ONLY pass-without-probing case.
			return { name, ok: true, detail: bound("gateway not configured for this deployment") };
		}
		const url = target.url;
		if (!url) {
			// HTTP dispatch selected with no address. Previously indistinguishable
			// from the case above, and therefore a PASS: a box that would dispatch
			// nothing was reported healthy (review of 5b18e7e).
			return {
				name,
				ok: false,
				detail: failDetail("gateway dispatch is selected but no gateway URL is configured"),
			};
		}

		const doFetch = seams.fetch ?? ((u, init) => fetch(u, init));
		const timeoutMs = seams.gatewayTimeoutMs ?? GATEWAY_PROBE_TIMEOUT_MS;
		// The probe bounds its OWN wait: a gateway that accepts the connection and
		// never answers is exactly the shape that turns a smoke into a stall.
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);
		try {
			const response = await doFetch(url, { method: "GET", signal: controller.signal });
			// RELEASE THE BODY. The question this probe asks is answered by the status
			// line alone, but `/mcp` is a streaming endpoint: an unread body holds the
			// connection open, one per run. Cancelling is the discard that does not
			// buffer an unbounded stream first.
			//
			// The cancel is swallowed deliberately and the verdict is NOT conditional
			// on it: the gateway already answered, which is the entire claim. Letting
			// a cleanup failure flip `ok` to false would invent an outage out of a
			// closed socket — the precise false alarm this probe exists to prevent.
			await releaseBody(response);
			return {
				name,
				ok: true,
				detail: bound(`gateway answered HTTP ${response.status}`),
			};
		} catch (err) {
			// CLASS ONLY. `fetch` puts the URL it was handed into its message, and that
			// URL can carry a credential in userinfo.
			log("error", "doctor.gateway_reachable.failed", { error_class: errorClass(err) });
			return {
				name,
				ok: false,
				detail: failDetail("gateway did not answer at the configured URL"),
			};
		} finally {
			clearTimeout(timer);
		}
	},
	// THE ONE PROBE WHOSE SEAMS CARRY AN OPERATOR-SET STRING. The other five take
	// seams holding only closures and a db handle, so their unredacted `.enter`
	// lines expose nothing; this one receives `gatewayUrl`, read from
	// RUNNER_BOXES_HTTP_URL. Matching the peers was the wrong call in the review
	// of a25fea4: `summarize()` scrubs `://userinfo@`, but a credential in a
	// query string or fragment survives it, and probing confirmed a `?access_token=`
	// value appearing verbatim on `.enter`. The detail path was already deliberately
	// secret-safe (fixed strings, `errorClass` never `errorMessage`) — the trace was
	// the hole in it. Nothing here is worth tracing: the verdict is the return value
	// and the report prints it.
	{ redact: { args: [0] } },
);

/**
 * Discard a probe response's body without letting the discard fail the probe.
 *
 * Tests inject a `fetch` fake whose "response" is often a bare `{status}` with
 * no body at all, so every access here is optional-chained rather than assumed —
 * a cleanup helper that throws on a minimal fake would turn every fake-driven
 * test into a failure of the thing under test.
 */
async function releaseBody(response: { body?: { cancel?: () => Promise<void> } | null }) {
	try {
		await response.body?.cancel?.();
	} catch {
		// A already-closed or already-consumed stream is not a reachability fact.
	}
}
