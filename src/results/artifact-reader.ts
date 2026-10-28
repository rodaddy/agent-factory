/**
 * @module results/artifact-reader
 * @description The reading surface `ResultReconciler` requires of whatever holds
 *   a runner's artifacts. Historically that was always the collab share
 *   (`ShareResultReader`), and the reconciler named that class directly. sf#465
 *   R4 adds a second source — artifacts published on the NATS `FACTORY_JOBS`
 *   stream and drained into `bus_results` — so the reconciler now depends on
 *   this interface and a composite can put one source ahead of the other.
 *
 *   This is EXACTLY the surface the reconciler uses today, no wider: `listHosts`
 *   from its per-attempt loop, and `isDone` / `readResult` / `readNamedResult`
 *   from the adapters `readerFor` builds. It is deliberately NOT `ResultReader`
 *   (`./ingest`), which is the narrower per-attempt contract ingest consumes and
 *   carries the optional `classifyMissing` / `readEventStream` / `resultName`
 *   fields the reconciler SUPPLIES rather than requires.
 *
 *   `ShareResultReader` satisfies this structurally, unchanged.
 *
 * @outputs
 *   - `ArtifactReader` -- the source-agnostic artifact reading surface
 *
 * @dependencies
 *   - none (type-only module; no I/O, no imports)
 */

/** A source of one runner job's artifacts, keyed per (job, host, artifact). */
export interface ArtifactReader {
	/** Bounded list of hosts that produced output for this runner job. */
	listHosts(jobRunnerId: string, maxHosts: number): Promise<string[]>;
	/** True when this host's output is complete and readable. */
	isDone(jobRunnerId: string, hostname: string): Promise<boolean>;
	/** The wrapper-owned `result.json` bytes, or null when absent. */
	readResult(jobRunnerId: string, hostname: string, maxBytes: number): Promise<string | null>;
	/**
	 * A distinct fixed artifact by exact filename, or null when absent. The name
	 * is always a FIXED author literal chosen by the caller (never a
	 * caller/config-selected value), and implementations validate it as a single
	 * safe segment regardless.
	 */
	readNamedResult(
		jobRunnerId: string,
		hostname: string,
		fileName: string,
		maxBytes: number,
	): Promise<string | null>;
	/**
	 * A fixed artifact from this attempt's `out/` SUBDIRECTORY, or null when
	 * absent.
	 *
	 * REQUIRED, NOT OPTIONAL, deliberately. The runner wrapper flattens most
	 * artifacts to the job/host directory but leaves the agent event stream
	 * nested at `out/events.jsonl`, so a reader without this method cannot reach
	 * it at all — the defect that produced 133 streams on the share and zero
	 * parsed traces. An optional method would need a null guard at the call site,
	 * and that guard is exactly how the silent no-op comes back.
	 *
	 * Same contract as `readNamedResult` for the NAME: always a fixed author
	 * literal, validated as a single safe segment by the implementation. The
	 * `out` segment is the implementation's own literal and is never
	 * caller-supplied.
	 */
	readOutArtifact(
		jobRunnerId: string,
		hostname: string,
		fileName: string,
		maxBytes: number,
	): Promise<string | null>;
}
