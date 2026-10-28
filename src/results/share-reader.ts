/**
 * @module results/share-reader
 * @description Default `ResultReader` over the shared filesystem where runner
 *   boxes write their output: `collab/runners/jobs/<job-id>/<hostname>/` holds
 *   `DONE`, `result.json`, and `agent.log`. The share root differs by host
 *   (`/mnt/share` on macOS, `/mnt/share` on an LXC), so it is injected.
 *   The result read is byte-capped: it reads at most `maxBytes`+1 so an
 *   oversized file is detected without loading it whole. Path segments are
 *   validated to stay within the job directory (no traversal from a crafted
 *   job id or hostname).
 *
 * @outputs
 *   - `ShareResultReader` -- filesystem-backed ResultReader
 *   - `ShareResultReader.readNamedResult` -- read a distinct fixed artifact by
 *     safe filename (the pre-push `validation-result.json`, not `result.json`)
 *   - `ShareResultReader.hasOutput` -- whether a job/host directory holds any
 *     regular file yet (the pre-push "runner started the job" signal)
 *
 * @dependencies
 *   - node:fs (constants) -- O_NOFOLLOW open flag
 *   - node:fs/promises -- lstat + no-follow open/read
 *   - node:path -- safe path joining
 *   - ./ingest -- the ResultReader contract
 */
import { constants } from "node:fs";
import { lstat, open, opendir } from "node:fs/promises";
import { join, normalize, sep } from "node:path";
import { traced } from "../log";
import type { ResultReader } from "./ingest";

/**
 * A path segment that is safe to embed in a share path (no traversal).
 *
 * Exported for the bus-backed reader, which applies the SAME guard to
 * the same three caller-supplied values. It is exported rather than duplicated
 * so the two readers cannot drift on what counts as safe — a second copy would
 * be a second thing to keep in step.
 */
/**
 * The runner wrapper's output subdirectory under `<job>/<host>/`.
 *
 * A FIXED LITERAL, spelled once, and deliberately NOT a parameter: it is what
 * lets `readOutArtifact` reach a nested artifact while every caller still passes
 * a bare `isSafeSegment` filename. Making it caller-supplied would reintroduce
 * exactly the path-selection the segment guard exists to prevent.
 */
const OUT_DIR_NAME = "out" as const;

export const isSafeSegment = traced(
	"results.isSafeSegment",
	function isSafeSegment(segment: string): boolean {
		return (
			segment.length <= 255 &&
			/^[A-Za-z0-9._-]+$/.test(segment) &&
			segment !== "." &&
			segment !== ".."
		);
	},
);

/** Filesystem `ResultReader` rooted at the share's `runners/jobs` directory. */
export class ShareResultReader implements ResultReader {
	private readonly jobsRoot: string;

	/**
	 * @param shareRoot - the collab share root (e.g. `/mnt/share` or
	 *   `/mnt/share`). The reader resolves `runners/jobs` beneath it.
	 */
	constructor(shareRoot: string) {
		this.jobsRoot = join(shareRoot, "runners", "jobs");
	}

	/**
	 * True only when `path` is a REAL directory: it lstat's the path (never
	 * following a link) and requires `isDirectory()`, so a symlinked path component
	 * — even one resolving to a real directory — is refused. O_NOFOLLOW only guards
	 * the leaf artifact, so every PARENT component (`<job-id>`, `<hostname>`) must be
	 * proven a real directory before any leaf open/read/stat, or a crafted job could
	 * plant a symlinked parent that traverses off the jobs root.
	 */
	private async isRealDir(path: string): Promise<boolean> {
		try {
			return (await lstat(path)).isDirectory();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	/**
	 * Resolve `<jobsRoot>/<jobId>/<host>` and require BOTH parent components to be
	 * real directories (no symlinked `<job-id>` or `<hostname>` parent), on top of
	 * the existing safe-segment and containment guards. Returns the contained dir,
	 * or null if any segment is unsafe, escapes the jobs root, or is a symlinked
	 * (non-real-directory) parent.
	 */
	private async realDirFor(jobRunnerId: string, hostname: string): Promise<string | null> {
		const dir = this.dirFor(jobRunnerId, hostname);
		if (dir === null) {
			return null;
		}
		if (!(await this.isRealDir(join(this.jobsRoot, jobRunnerId)))) {
			return null;
		}
		if (!(await this.isRealDir(dir))) {
			return null;
		}
		return dir;
	}

	/** Discover bounded, safe host directories for one runner job. */
	async listHosts(jobRunnerId: string, maxHosts: number): Promise<string[]> {
		const limit = Math.max(0, Math.floor(maxHosts));
		if (!isSafeSegment(jobRunnerId) || limit === 0) {
			return [];
		}
		const jobDir = join(this.jobsRoot, jobRunnerId);
		// Reject a symlinked <job-id> parent before enumerating hosts: opendir would
		// otherwise traverse the link off the jobs root.
		if (!(await this.isRealDir(jobDir))) {
			return [];
		}
		try {
			const hosts: string[] = [];
			const entries = await opendir(jobDir);
			for await (const entry of entries) {
				if (entry.isDirectory() && isSafeSegment(entry.name)) {
					hosts.push(entry.name);
					if (hosts.length >= limit) {
						break;
					}
				}
			}
			return hosts.sort();
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (code === "ENOENT") {
				return [];
			}
			throw error;
		}
	}

	private dirFor(jobRunnerId: string, hostname: string): string | null {
		if (!isSafeSegment(jobRunnerId) || !isSafeSegment(hostname)) {
			return null;
		}
		const dir = join(this.jobsRoot, jobRunnerId, hostname);
		// Defence-in-depth: the resolved path must stay strictly under jobsRoot.
		// Compare against a trailing-separator prefix so a sibling like
		// `<root>-evil` cannot satisfy the check.
		const rootPrefix = normalize(this.jobsRoot) + sep;
		if (!normalize(dir).startsWith(rootPrefix)) {
			return null;
		}
		return dir;
	}

	async isDone(jobRunnerId: string, hostname: string): Promise<boolean> {
		const dir = await this.realDirFor(jobRunnerId, hostname);
		if (dir === null) {
			return false;
		}
		// lstat (never stat) so a symlinked DONE — even one pointing at a real file —
		// is not accepted: completion must be attested by a regular file the runner
		// wrote in place, never a link a crafted job could plant.
		try {
			const stats = await lstat(join(dir, "DONE"));
			return stats.isFile();
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	/**
	 * True when the job/host directory holds at least one regular file: the runner
	 * STARTED the job. The wrapper writes `agent.log` within about a
	 * minute of start; a box that never runs the job leaves no host directory, or an
	 * empty one. Same guards as `isDone` (safe segments, real-directory parents), a
	 * symlink is not a file (`Dirent` never follows one), and at most
	 * `maxEntries` entries are read so a crafted directory cannot make this unbounded.
	 */
	async hasOutput(jobRunnerId: string, hostname: string, maxEntries = 64): Promise<boolean> {
		const dir = await this.realDirFor(jobRunnerId, hostname);
		if (dir === null) {
			return false;
		}
		try {
			let seen = 0;
			for await (const entry of await opendir(dir)) {
				if (entry.isFile()) return true;
				seen += 1;
				if (seen >= maxEntries) return false;
			}
			return false;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
			throw error;
		}
	}

	async readResult(
		jobRunnerId: string,
		hostname: string,
		maxBytes: number,
	): Promise<string | null> {
		return this.readNamedResult(jobRunnerId, hostname, "result.json", maxBytes);
	}

	/**
	 * Read a fixed artifact out of the job/host `out/` SUBDIRECTORY.
	 *
	 * THE DEFECT THIS CLOSES. The runner wrapper flattens most artifacts to the
	 * job/host directory — `result.json`, `watcher-result.json`, `changes.bundle`,
	 * `DONE` — but leaves the agent event stream nested at `out/events.jsonl`.
	 * `readNamedResult` joins the job/host directory to a name `isSafeSegment`
	 * forbids from carrying a separator, so the reader could not reach it BY
	 * CONSTRUCTION. Measured 2026-09-10: 133 streams on the share, zero where the
	 * reader looked, and therefore zero parsed traces, zero `trace_id` stamps and
	 * zero Langfuse emissions across 29 attempts — every downstream stage working
	 * correctly on an input that never arrived.
	 *
	 * WHY A SEPARATE METHOD RATHER THAN A RELAXED FILENAME. Passing
	 * `"out/events.jsonl"` would require loosening `isSafeSegment`, which is a real
	 * containment control: it guarantees only a fixed author literal — never a
	 * caller- or config-selected path — can be read. The `out` segment is a fixed
	 * literal HERE, in the reader, so the caller still supplies only a bare name
	 * and the guarantee is unchanged.
	 *
	 * Every guard `readNamedResult` applies still applies: safe job/host segments,
	 * the normalized trailing-separator containment check against `jobsRoot`, and a
	 * real-directory requirement on both parents. The `out` directory itself gets
	 * the SAME real-directory check, so a symlinked `out` is refused exactly as a
	 * symlinked `<hostname>` already is — otherwise this method would be the one
	 * hole in a reader whose every other door is locked.
	 */
	async readOutArtifact(
		jobRunnerId: string,
		hostname: string,
		fileName: string,
		maxBytes: number,
	): Promise<string | null> {
		if (!isSafeSegment(fileName)) {
			return null;
		}
		const hostDir = await this.realDirFor(jobRunnerId, hostname);
		if (hostDir === null) {
			return null;
		}
		const outDir = join(hostDir, OUT_DIR_NAME);
		// A symlinked `out` would traverse off the job/host directory; refuse it
		// before opening anything inside.
		if (!(await this.isRealDir(outDir))) {
			return null;
		}
		return this.readContained(outDir, fileName, maxBytes);
	}

	/**
	 * Read a distinct, fixed result artifact by exact `fileName` under the job/host
	 * directory. This exists for the pre-push lane, which reads its own author-owned
	 * `validation-result.json` rather than the wrapper-owned `result.json`. The name
	 * is validated as a single safe path segment (no traversal, no separators), so
	 * only a fixed author literal — never a caller/config-selected name — can be
	 * read; the same containment guards and byte cap as `readResult` apply.
	 */
	async readNamedResult(
		jobRunnerId: string,
		hostname: string,
		fileName: string,
		maxBytes: number,
	): Promise<string | null> {
		if (!isSafeSegment(fileName)) {
			return null;
		}
		const dir = await this.realDirFor(jobRunnerId, hostname);
		if (dir === null) {
			return null;
		}
		return this.readContained(dir, fileName, maxBytes);
	}

	/**
	 * Read `fileName` out of an ALREADY-VALIDATED directory, with the file-level
	 * guards every artifact read in this class shares.
	 *
	 * `dir` must already have passed `realDirFor` (and, for a subdirectory, its own
	 * `isRealDir` check) — this helper validates the FILE, never the directory, and
	 * is private so no caller can hand it an unvalidated path.
	 *
	 * Open with O_NOFOLLOW so a symlinked artifact is refused at open time (ELOOP),
	 * never followed off the job/host directory. Then fstat the opened descriptor
	 * and require a regular file, so the read cannot resolve to a device, FIFO, or
	 * directory a crafted job planted. Read at most maxBytes+1 so an oversized file
	 * stays detectable without loading it whole.
	 */
	private async readContained(
		dir: string,
		fileName: string,
		maxBytes: number,
	): Promise<string | null> {
		let handle: Awaited<ReturnType<typeof open>> | null = null;
		try {
			handle = await open(join(dir, fileName), constants.O_RDONLY | constants.O_NOFOLLOW);
			const stats = await handle.stat();
			if (!stats.isFile()) {
				return null;
			}
			const buffer = Buffer.alloc(maxBytes + 1);
			const { bytesRead } = await handle.read(buffer, 0, maxBytes + 1, 0);
			return buffer.toString("utf8", 0, bytesRead);
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			// A symlink (ELOOP) or an absent file (ENOENT) both read as "no artifact".
			if (code === "ELOOP" || code === "ENOENT") return null;
			throw error;
		} finally {
			await handle?.close();
		}
	}
}
