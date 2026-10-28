/**
 * @module results/bus-reader
 * @description `ArtifactReader` over `bus_results` — the table the watcher's
 *   NATS consumer drains the `FACTORY_JOBS` stream into. A runner
 *   publishes each artifact it produced to
 *   `factory.jobs.<job_runner_id>.result`; the consumer stores it; this reader
 *   serves it to the reconciler in place of a share read.
 *
 *   It answers the SAME questions as `ShareResultReader` against a different
 *   store, and it must answer them identically — the reconciler and ingest are
 *   unchanged, so any divergence in the byte cap or the null/absent contract
 *   would change ingest's verdict for a bus-delivered result. Two properties are
 *   therefore copied deliberately rather than reinvented:
 *
 *   - The BYTE CAP. The share reader reads at most `maxBytes`+1 BYTES, so an
 *     oversized artifact is detectable without loading it whole and ingest's
 *     refusal path sees a body of exactly `maxBytes`+1. This reader slices the
 *     stored text in the same units (via a Buffer, not `String.slice`, so a
 *     multi-byte character cannot make the two disagree on length).
 *   - The SAFE-SEGMENT guard. `jobRunnerId`, `hostname`, and `fileName` are
 *     validated with the share reader's own `isSafeSegment`, imported rather
 *     than duplicated. There is no path to traverse here, but the guard also
 *     bounds these values and keeps the two readers answering the same way for
 *     the same input — a crafted job id must not read as absent on one source
 *     and present on the other.
 *
 *   - The DONE MARKER. The share writes a `DONE` file AFTER every artifact, so a
 *     host is never read half-arrived. The bus carries the same ordering as one
 *     final message per (job, host) with `Factory-Artifact: DONE` (empty body
 *     allowed), published after every artifact, stored as the row whose
 *     `artifact` is `DONE`. `isDone` keys on THAT ROW and nothing else. Treating
 *     any stored artifact as the attestation loses the ordering guarantee: a
 *     host whose `result.json` is drained before its named artifact would read
 *     as done-with-the-artifact-missing, and `reconcile.ts` never re-selects the
 *     attempt it then fails, so a race becomes a permanent failure.
 *
 *   Every query carries `hostname`. Results are per (job, host): keying on
 *   `jobRunnerId` alone would serve one host's artifact for another host's
 *   attempt, the shape PR #86 fixed.
 *
 *   Stored bodies are UNTRUSTED runner output. Nothing here validates, parses,
 *   or decides — ingest remains the only judge.
 *
 * @outputs
 *   - `BusResultReader` -- bus-backed ArtifactReader over `bus_results`
 *
 * @dependencies
 *   - drizzle-orm -- and/asc/eq query builders
 *   - ../db/client -- the WatcherDb handle
 *   - ../db/schema -- the `bus_results` table
 *   - ./artifact-reader -- the ArtifactReader contract
 *   - ./share-reader -- the shared `isSafeSegment` guard
 */
import { and, asc, eq } from "drizzle-orm";
import type { WatcherDb } from "../db/client";
import { busResults } from "../db/schema";
import type { ArtifactReader } from "./artifact-reader";
import { isSafeSegment } from "./share-reader";

/** The wrapper-owned default artifact, as on the share. */
const DEFAULT_RESULT_NAME = "result.json";

/**
 * The `artifact` value of the completion marker row — the bus equivalent of the
 * share's `DONE` file. The runner publishes it as its LAST message for a
 * (job, host), after every artifact; its body may be empty.
 */
export const DONE_ARTIFACT = "DONE";

/** `ArtifactReader` served from rows the NATS consumer drained into `bus_results`. */
export class BusResultReader implements ArtifactReader {
	private readonly db: WatcherDb;

	constructor(db: WatcherDb) {
		this.db = db;
	}

	/**
	 * Hosts that published at least one artifact for this job, in the order their
	 * first row was stored (ascending id), bounded by `maxHosts`.
	 *
	 * The bound is applied AFTER deduplication rather than as a SQL `LIMIT`: one
	 * host writing several artifacts would otherwise consume the whole budget and
	 * hide the other hosts of the same job.
	 *
	 * A row whose stored hostname is not a safe segment is SKIPPED before it is
	 * deduped or counted, matching the share reader, which filters host
	 * directories with the same guard while enumerating. Hostnames come from
	 * untrusted runner output: counting an unsafe one against `maxHosts` would let
	 * a handful of crafted rows fill the budget and hide every real host of the
	 * job.
	 */
	async listHosts(jobRunnerId: string, maxHosts: number): Promise<string[]> {
		const limit = Math.max(0, Math.floor(maxHosts));
		if (!isSafeSegment(jobRunnerId) || limit === 0) {
			return [];
		}
		const rows = await this.db
			.select({ hostname: busResults.hostname })
			.from(busResults)
			.where(eq(busResults.jobRunnerId, jobRunnerId))
			.orderBy(asc(busResults.id));
		const hosts: string[] = [];
		for (const row of rows) {
			if (!isSafeSegment(row.hostname)) {
				continue;
			}
			if (!hosts.includes(row.hostname)) {
				hosts.push(row.hostname);
				if (hosts.length >= limit) break;
			}
		}
		return hosts;
	}

	/**
	 * True when this (job, host) published its `DONE` marker, and ONLY then.
	 *
	 * The marker is the runner's last message for the pair, published after every
	 * artifact, so it carries the share's ordering guarantee onto the bus. An
	 * artifact row is not a substitute: artifacts are drained one message at a
	 * time and their order is not guaranteed, so a host read as done on the
	 * strength of an early `result.json` can be missing the named artifact the
	 * reconciler then asks for — and `reconcile.ts` never re-selects the attempt
	 * it fails for that, turning a delivery race into a permanent failure.
	 *
	 * The marker ALONE — no artifact rows at all — is still done, exactly as a
	 * `DONE` file beside an empty directory is on the share: `classifyMissing`
	 * gets its chance to name the cause instead of the attempt sitting pending
	 * forever. `readNamedResult` is independent of this and serves every stored
	 * artifact whether or not the marker exists; the reconciler asks `isDone`
	 * first.
	 */
	async isDone(jobRunnerId: string, hostname: string): Promise<boolean> {
		if (!isSafeSegment(jobRunnerId) || !isSafeSegment(hostname)) {
			return false;
		}
		const rows = await this.db
			.select({ id: busResults.id })
			.from(busResults)
			.where(
				and(
					eq(busResults.jobRunnerId, jobRunnerId),
					eq(busResults.hostname, hostname),
					eq(busResults.artifact, DONE_ARTIFACT),
				),
			)
			.limit(1);
		return rows.length > 0;
	}

	async readResult(
		jobRunnerId: string,
		hostname: string,
		maxBytes: number,
	): Promise<string | null> {
		return this.readNamedResult(jobRunnerId, hostname, DEFAULT_RESULT_NAME, maxBytes);
	}

	/**
	 * The stored body for one (job, host, artifact), bounded to `maxBytes`+1 BYTES
	 * so an oversized artifact stays detectable — byte-for-byte what
	 * `ShareResultReader.readNamedResult` returns for the same content.
	 */
	async readNamedResult(
		jobRunnerId: string,
		hostname: string,
		fileName: string,
		maxBytes: number,
	): Promise<string | null> {
		if (!isSafeSegment(jobRunnerId) || !isSafeSegment(hostname) || !isSafeSegment(fileName)) {
			return null;
		}
		const rows = await this.db
			.select({ body: busResults.body })
			.from(busResults)
			.where(
				and(
					eq(busResults.jobRunnerId, jobRunnerId),
					eq(busResults.hostname, hostname),
					eq(busResults.artifact, fileName),
				),
			)
			.limit(1);
		const body = rows[0]?.body;
		if (body === undefined) {
			return null;
		}
		// Slice in BYTES, matching the share reader's fixed-size read: a body whose
		// characters are multi-byte would otherwise cap at a different length here
		// than on the share, and ingest's over-cap refusal keys on that length.
		const buffer = Buffer.from(body, "utf8");
		if (buffer.byteLength <= maxBytes + 1) {
			return body;
		}
		return buffer.toString("utf8", 0, maxBytes + 1);
	}

	/**
	 * The bus has NO DIRECTORY STRUCTURE, so `out/` does not exist here.
	 *
	 * `bus_results` is keyed by `(job_runner_id, hostname, artifact)` and the
	 * producer publishes each artifact under its bare name — the share's
	 * flat-versus-nested split is a filesystem layout the bus never reproduces.
	 * An `events.jsonl` published to the bus is therefore the SAME row whether the
	 * caller asks through `readNamedResult` or this method, and delegating is the
	 * truthful implementation rather than a convenience.
	 *
	 * Deliberately not a `return null` stub: the bus is a real source for lanes
	 * that publish through it, and stubbing this would silently drop their event
	 * streams — the exact failure this whole change exists to close, moved one
	 * reader over.
	 */
	async readOutArtifact(
		jobRunnerId: string,
		hostname: string,
		fileName: string,
		maxBytes: number,
	): Promise<string | null> {
		return this.readNamedResult(jobRunnerId, hostname, fileName, maxBytes);
	}
}
