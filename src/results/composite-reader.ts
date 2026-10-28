/**
 * @module results/composite-reader
 * @description An `ArtifactReader` that consults two sources in a fixed order.
 *  The factory reads the NATS-fed `bus_results` table FIRST and
 *   the collab share second, so a runner that publishes to the bus and a runner
 *   that still writes to the share both reconcile through one unchanged
 *   reconciler.
 *
 *   The ordering is the whole contract, and it is deliberately not a merge: for
 *   a body read, the FIRST reader's non-null answer wins outright and the second
 *   is never consulted. A `null` — and only a null — falls through. An EMPTY
 *   STRING is a real artifact (a zero-byte result the runner wrote), so it wins
 *   like any other body; treating it as absent would silently hand ingest the
 *   share's stale copy of a job the bus already answered.
 *
 *   `isDone` is an OR: either source attesting completion is completion.
 *   `listHosts` is a union in the first reader's order, then the second's hosts
 *   that the first did not already name, capped at `maxHosts` — a host reporting
 *   through both sources is one host, not two attempts.
 *
 *   Nothing here reads, validates, or bounds content: both members already
 *   applied their own byte cap and safety guards, and ingest remains the judge.
 *
 * @outputs
 *   - `CompositeResultReader` -- ordered two-source ArtifactReader
 *
 * @dependencies
 *   - ./artifact-reader -- the ArtifactReader contract
 */
import type { ArtifactReader } from "./artifact-reader";

export interface CompositeResultReaderOptions {
	/** Consulted first; its non-null answer wins. */
	first: ArtifactReader;
	/** Consulted only when the first returns null / false / fewer than `maxHosts`. */
	second: ArtifactReader;
}

/** Reads two artifact sources in a fixed order, first winning. */
export class CompositeResultReader implements ArtifactReader {
	private readonly first: ArtifactReader;
	private readonly second: ArtifactReader;

	constructor(options: CompositeResultReaderOptions) {
		this.first = options.first;
		this.second = options.second;
	}

	async listHosts(jobRunnerId: string, maxHosts: number): Promise<string[]> {
		const limit = Math.max(0, Math.floor(maxHosts));
		if (limit === 0) {
			return [];
		}
		const hosts = await this.first.listHosts(jobRunnerId, limit);
		const union = hosts.slice(0, limit);
		if (union.length >= limit) {
			return union;
		}
		for (const host of await this.second.listHosts(jobRunnerId, limit)) {
			if (union.includes(host)) continue;
			union.push(host);
			if (union.length >= limit) break;
		}
		return union;
	}

	async isDone(jobRunnerId: string, hostname: string): Promise<boolean> {
		return (
			(await this.first.isDone(jobRunnerId, hostname)) ||
			(await this.second.isDone(jobRunnerId, hostname))
		);
	}

	async readResult(
		jobRunnerId: string,
		hostname: string,
		maxBytes: number,
	): Promise<string | null> {
		const body = await this.first.readResult(jobRunnerId, hostname, maxBytes);
		// Strict null check: an empty body is a real artifact, not an absent one.
		if (body !== null) {
			return body;
		}
		return this.second.readResult(jobRunnerId, hostname, maxBytes);
	}

	async readNamedResult(
		jobRunnerId: string,
		hostname: string,
		fileName: string,
		maxBytes: number,
	): Promise<string | null> {
		const body = await this.first.readNamedResult(jobRunnerId, hostname, fileName, maxBytes);
		if (body !== null) {
			return body;
		}
		return this.second.readNamedResult(jobRunnerId, hostname, fileName, maxBytes);
	}

	/**
	 * The `out/` artifact from whichever source has it, first source winning.
	 * Same strict null check as its siblings: an empty body is a real
	 * artifact, not an absent one, and falling through on `""` would consult the
	 * second source for something the first already answered.
	 */
	async readOutArtifact(
		jobRunnerId: string,
		hostname: string,
		fileName: string,
		maxBytes: number,
	): Promise<string | null> {
		const body = await this.first.readOutArtifact(jobRunnerId, hostname, fileName, maxBytes);
		if (body !== null) {
			return body;
		}
		return this.second.readOutArtifact(jobRunnerId, hostname, fileName, maxBytes);
	}
}
