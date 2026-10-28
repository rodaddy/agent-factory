/**
 * @module scripts/actions/render-pr-review
 * @description Render the cliproxyapi chat-completions request that the
 *   `pr-review` Forgejo Actions workflow sends for a pull request.
 *   Reads the job's bounded metadata from the environment and the unified diff
 *   from stdin, and prints ONE JSON object on stdout. It performs no network
 *   call and writes no file: the workflow pipes stdout into `curl -d @-`, so
 *   this module's whole contract is "environment plus diff in, request body
 *   out", which is what makes it testable without an engine.
 *
 *   The system prompt is NOT authored here. It is
 *   `renderJobBody("pr-review", ...)` from `src/templates/registry.ts` — the
 *   same fixed, allowlisted body the runner-box lane dispatches — so the two
 *   runtimes review against one reviewed instruction text and cannot drift.
 *   Only one section is appended: the runner-box body ends by directing the
 *   agent to write `/work/out/watcher-result.json`, and in an Actions job no
 *   such path exists. The appended `## Output (Forgejo Actions context)`
 *   section replaces that artifact instruction with the markdown-reply and
 *   `verdict:` contract the poster parses.
 *
 *   The diff is repository content and therefore UNTRUSTED input. It is never
 *   interpolated into the system prompt; it arrives only as the user message,
 *   inside a fenced block, capped at `MAX_DIFF_BYTES`. The cap is applied in
 *   BYTES against the raw stdin buffer rather than in characters, because the
 *   thing being bounded is the request the engine receives, and a multi-byte
 *   diff would otherwise exceed a character budget silently.
 *
 *   A reviewable diff larger than one chunk budget is split into
 *   whole-file chunks (`CHUNK_MAX_BYTES` / `CHUNK_MAX_LINES`), each reviewed in
 *   its own request whose user message names the chunk and its files. A file
 *   is never split across chunks; a single oversized file sits alone. A diff
 *   inside both budgets renders exactly the single request it always did. With
 *   `CHUNK_DIR` set, the CLI writes one `request-<i>.json` per chunk plus a
 *   `manifest.json` there instead of printing to stdout.
 *
 *   Every metadata value is validated at this boundary and a bad one exits 2
 *   rather than being repaired. A renderer that coerced `PR=abc` to `NaN` would
 *   build a request around a value the forge never issued.
 *
 * @outputs
 *   - `buildRequest` -- the pure builder: environment + diff bytes -> request
 *   - `MAX_DIFF_BYTES` / `DIFF_TRUNCATION_MARKER` -- the diff bound and its marker
 *   - `CHUNK_MAX_BYTES` / `CHUNK_MAX_LINES` -- the per-request chunk budgets
 *   - `splitDiffByFile` -- diff bytes -> one section per `diff --git` file
 *   - `chunkDiff` -- greedy chunks of logical units (a test with its code)
 *     inside both budgets
 *   - `buildChunkRequests` -- one request per chunk, carrying the chunk note
 *   - CLI with `CHUNK_DIR`: writes `request-<i>.json` and `manifest.json`,
 *     prints nothing on stdout, one stderr line `render-pr-review: <N> chunk(s)`
 *   - CLI: exit 0 printing the request JSON; exit 2 with one stderr line when
 *     the environment is invalid
 *
 * @dependencies
 *   - ../../src/templates/registry -- the fixed pr-review instruction body
 */
import { traced } from "../../src/log";
import { renderJobBody } from "../../src/templates/registry";

/**
 * The byte ceiling on the diff carried in the user message. A pull request
 * larger than this is reviewed on its first 200 KB with the truncation stated
 * in-band, which is a bounded degradation; sending the whole thing is not,
 * because the engine's own context is finite and an overflow fails the job.
 */
export const MAX_DIFF_BYTES = 200_000;

/** The in-band marker appended when the diff hits `MAX_DIFF_BYTES`. */
export const DIFF_TRUNCATION_MARKER = `[diff truncated at ${MAX_DIFF_BYTES} bytes]`;

/**
 * The largest diff the lane sends to the engine at all. Run 1116 on
 * PR #690 timed out at 900 s on all three attempts with a 137,492-byte request;
 * smaller rounds of the same PR returned in ~14 min. Above this the lane posts
 * a `warning` status naming the size instead of spending the engine budget to
 * end in `error`. A judgment bound below the observed failure, not a measured
 * limit: tune it from the Langfuse duration-vs-payload spans.
 */
export const MAX_REVIEWABLE_DIFF_BYTES = 100_000;

/**
 * `null` when the diff is reviewable, else the status description naming its
 * size (lines and bytes). Stays inside Forge's 100-char description limit.
 */
function oversizeReasonImpl(diff: Uint8Array): string | null {
	if (diff.byteLength <= MAX_REVIEWABLE_DIFF_BYTES) {
		return null;
	}
	let lines = 0;
	for (const byte of diff) {
		if (byte === 0x0a) lines += 1;
	}
	return `pr-review skipped: diff too large (${lines} lines, ${diff.byteLength} bytes > ${MAX_REVIEWABLE_DIFF_BYTES})`;
}

export const oversizeReason = traced("actions.prReview.oversizeReason", oversizeReasonImpl, {
	redact: { args: [0] },
});

/**
 * Per-request chunk budgets. A ~600-line diff took 27 min in one
 * engine call and ~950-1100-line diffs timed out at 30 min, so a larger
 * reviewable diff is split into whole-file chunks inside both budgets.
 */
export const CHUNK_MAX_BYTES = 25_000;
export const CHUNK_MAX_LINES = 250;

/**
 * The most chunks one review sends, equal to the workflow's ENGINE_PARALLEL:
 * every chunk runs in the same parallel wave, so the engine hop keeps the
 * single-call time bound. A diff that would need more is repacked with both
 * budgets doubled until it fits (a reviewable diff is at most
 * MAX_REVIEWABLE_DIFF_BYTES, so the chunks stay inside one call's reach).
 */
export const MAX_CHUNKS = 4;

/** One file's section of a unified diff. */
export interface FileDiff {
	path: string;
	bytes: Uint8Array;
	lines: number;
}

/** One chunk of whole files; `index` is 1-based. */
export interface DiffChunk {
	index: number;
	files: string[];
	bytes: Uint8Array;
	lines: number;
}

const FILE_HEADER = new TextEncoder().encode("diff --git ");

function countLines(data: Uint8Array): number {
	let lines = 0;
	for (const byte of data) {
		if (byte === 0x0a) lines += 1;
	}
	return lines;
}

function headerAt(diff: Uint8Array, offset: number): boolean {
	if (offset !== 0 && diff[offset - 1] !== 0x0a) return false;
	for (let k = 0; k < FILE_HEADER.length; k += 1) {
		if (diff[offset + k] !== FILE_HEADER[k]) return false;
	}
	return true;
}

function pathOf(section: Uint8Array): string {
	const end = section.indexOf(0x0a);
	const header = new TextDecoder()
		.decode(end === -1 ? section : section.slice(0, end))
		.slice(FILE_HEADER.length);
	const marker = header.lastIndexOf(" b/");
	return marker === -1 ? header : header.slice(marker + 3);
}

/**
 * Split a unified diff into one section per `diff --git ` line, on bytes, so
 * the sections concatenate back to the input exactly. Bytes before the first
 * header join the first section; no header at all is one `(diff)` section.
 */
function splitDiffByFileImpl(diff: Uint8Array): FileDiff[] {
	const starts: number[] = [];
	for (let offset = 0; offset + FILE_HEADER.length <= diff.byteLength; offset += 1) {
		if (headerAt(diff, offset)) starts.push(offset);
	}
	if (starts.length === 0) {
		return [{ path: "(diff)", bytes: diff, lines: countLines(diff) }];
	}
	return starts.map((start, i) => {
		const from = i === 0 ? 0 : start;
		const to = starts[i + 1] ?? diff.byteLength;
		const section = diff.slice(from, to);
		return { path: pathOf(diff.slice(start, to)), bytes: section, lines: countLines(section) };
	});
}

export const splitDiffByFile = traced("actions.prReview.splitDiffByFile", splitDiffByFileImpl, {
	redact: { args: [0], result: true },
});

function concat(parts: Uint8Array[]): Uint8Array {
	const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
	let offset = 0;
	for (const part of parts) {
		out.set(part, offset);
		offset += part.byteLength;
	}
	return out;
}

/** A test path: a test-dir segment, or a `*.test.*`/`*.spec.*`/`*_test.*`/`test_*.py` name. */
function isTestPath(path: string): boolean {
	const segments = path.split("/");
	const name = segments.pop() ?? "";
	if (segments.some((segment) => ["test", "tests", "__tests__", "spec"].includes(segment)))
		return true;
	return /\.(test|spec)\./.test(name) || /_test\./.test(name) || /^test_.*\.py$/.test(name);
}

/** The file name without extension(s) and without a `.test`/`.spec`/`_test`/`test_` marker. */
function stemOf(path: string): string {
	const name = (path.split("/").pop() ?? "").replace(/^test_/, "");
	const dot = name.indexOf(".", 1);
	return (dot === -1 ? name : name.slice(0, dot)).replace(/_test$/, "");
}

function dirOf(path: string): string {
	const slash = path.lastIndexOf("/");
	return slash === -1 ? "" : path.slice(0, slash);
}

/**
 * Group files into logical units: every file joins the unit of its
 * directory, and a test file joins the unit of the first non-test file with
 * its stem instead (else its own directory's). Inside a unit, a code file and
 * its tests form one pair. Units and pairs keep the order of their first file.
 */
function unitsOf(files: FileDiff[]): FileDiff[][][] {
	const codeByStem = new Map<string, string>();
	for (const file of files) {
		const stem = stemOf(file.path);
		if (!isTestPath(file.path) && !codeByStem.has(stem)) codeByStem.set(stem, file.path);
	}
	const units = new Map<string, Map<string, FileDiff[]>>();
	for (const file of files) {
		const code = isTestPath(file.path) ? codeByStem.get(stemOf(file.path)) : undefined;
		const anchor = code ?? file.path;
		const key = dirOf(anchor);
		const unit = units.get(key) ?? new Map<string, FileDiff[]>();
		units.set(key, unit);
		unit.set(anchor, [...(unit.get(anchor) ?? []), file]);
	}
	return [...units.values()].map((unit) => [...unit.values()]);
}

/**
 * Greedy chunking over logical units, in unit order: a unit joins
 * the current chunk when it is empty or both budgets still hold, else starts a
 * new chunk, so a test lands beside the code it tests. A unit over budget on
 * its own is packed by its code-and-tests pairs, and a pair over budget file
 * by file; a file is never split, so one over budget sits alone. More than
 * MAX_CHUNKS groups repacks with both budgets doubled.
 */
function chunkDiffImpl(diff: Uint8Array): DiffChunk[] {
	const units = unitsOf(splitDiffByFile(diff));
	let scale = 1;
	let groups = packUnits(units, CHUNK_MAX_BYTES, CHUNK_MAX_LINES);
	while (groups.length > MAX_CHUNKS) {
		scale *= 2;
		groups = packUnits(units, CHUNK_MAX_BYTES * scale, CHUNK_MAX_LINES * scale);
	}
	return groups.map((group, i) => ({
		index: i + 1,
		files: group.map((file) => file.path),
		bytes: concat(group.map((file) => file.bytes)),
		lines: group.reduce((sum, file) => sum + file.lines, 0),
	}));
}

function packUnits(units: FileDiff[][][], maxBytes: number, maxLines: number): FileDiff[][] {
	const within = (files: FileDiff[]) =>
		files.reduce((sum, file) => sum + file.bytes.byteLength, 0) <= maxBytes &&
		files.reduce((sum, file) => sum + file.lines, 0) <= maxLines;
	// A block is packed whole; an over-budget unit becomes its pairs, an over-budget pair its files.
	const blocks = units.flatMap((pairs) =>
		within(pairs.flat())
			? [pairs.flat()]
			: pairs.flatMap((pair) => (within(pair) ? [pair] : pair.map((file) => [file]))),
	);
	const groups: FileDiff[][] = [];
	let current: FileDiff[] = [];
	for (const block of blocks) {
		if (current.length > 0 && !within([...current, ...block])) {
			groups.push(current);
			current = [];
		}
		current.push(...block);
	}
	groups.push(current);
	return groups;
}

export const chunkDiff = traced("actions.prReview.chunkDiff", chunkDiffImpl, {
	redact: { args: [0], result: true },
});

/** The engine model used when `ENGINE_MODEL` is unset. */
export const DEFAULT_ENGINE_MODEL = "gpt-6.1-sol";

/**
 * The Actions-context output contract appended to the fixed pr-review body.
 * It is fixed author text; nothing from the environment or the diff reaches it.
 */
export const ACTIONS_OUTPUT_SECTION = [
	"",
	"## Output (Forgejo Actions context)",
	"There is no `/work/out` here and no artifact to write. Reply in markdown",
	"only: a ranked findings list (P0/P1/P2, each with `file:line` from the diff",
	"and a one-line fix), then a final line exactly `verdict: approve` or",
	"`verdict: fix-first`. Only a P0 or P1 makes it `verdict: fix-first`; a",
	"review whose findings are all P2 ends `verdict: approve`. When there is no P0 or P1,",
	"do not write the strings P0 or P1 anywhere. No praise, facts only.",
].join("\n");

/** The bounded metadata the renderer accepts, before validation. */
export interface RenderEnv {
	REPO?: string;
	PR?: string;
	HEAD_SHA?: string;
	BASE_SHA?: string;
	ENGINE_MODEL?: string;
}

/** One chat message in the rendered request. */
export interface ChatMessage {
	role: "system" | "user";
	content: string;
}

/** The cliproxyapi chat-completions request body this module emits. */
export interface EngineRequest {
	model: string;
	reasoning_effort: "high";
	max_completion_tokens: number;
	messages: ChatMessage[];
}

/** Thrown for an invalid environment; the CLI turns it into exit 2. */
export class RenderEnvError extends Error {}

const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const SHA_PATTERN = /^[0-9a-fA-F]{7,40}$/;
const ITEM_PATTERN = /^[1-9][0-9]*$/;

/**
 * Cap `diff` at `MAX_DIFF_BYTES`, appending the marker on its own line when the
 * cap bit. Slicing the buffer can split a multi-byte sequence; the decoder is
 * non-fatal, so the tail becomes a replacement character rather than throwing —
 * the alternative, scanning back to a code-point boundary, would buy nothing
 * for a diff that is already being cut mid-hunk.
 */
function capDiffImpl(diff: Uint8Array): string {
	const decoder = new TextDecoder();
	if (diff.byteLength <= MAX_DIFF_BYTES) {
		return decoder.decode(diff);
	}
	return `${decoder.decode(diff.slice(0, MAX_DIFF_BYTES))}\n${DIFF_TRUNCATION_MARKER}`;
}

export const capDiff = traced("actions.capDiff", capDiffImpl, { redact: { result: true } });

/**
 * Build the engine request from the job's environment and the raw diff bytes.
 * Throws `RenderEnvError` naming the offending variable when any bounded value
 * fails its pattern.
 */
function buildRequestImpl(env: RenderEnv, diff: Uint8Array, chunkNote?: string): EngineRequest {
	const repository = env.REPO ?? "";
	if (!REPO_PATTERN.test(repository)) {
		throw new RenderEnvError("REPO must be owner/repo");
	}
	const item = env.PR ?? "";
	if (!ITEM_PATTERN.test(item)) {
		throw new RenderEnvError("PR must be a positive integer");
	}
	const headSha = env.HEAD_SHA ?? "";
	if (!SHA_PATTERN.test(headSha)) {
		throw new RenderEnvError("HEAD_SHA must be 7-40 hex characters");
	}
	const baseSha = env.BASE_SHA ?? "";
	if (!SHA_PATTERN.test(baseSha)) {
		throw new RenderEnvError("BASE_SHA must be 7-40 hex characters");
	}
	const model =
		env.ENGINE_MODEL && env.ENGINE_MODEL !== "" ? env.ENGINE_MODEL : DEFAULT_ENGINE_MODEL;

	const body = renderJobBody("pr-review", {
		repository,
		itemNumber: Number(item),
		sha: headSha,
	});
	if (body === null) {
		throw new RenderEnvError("the pr-review template rendered no body");
	}

	const user = [
		`Base sha: ${baseSha}`,
		`Head sha: ${headSha}`,
		...(chunkNote !== undefined && chunkNote !== "" ? [chunkNote] : []),
		"",
		"```diff",
		capDiff(diff),
		"```",
	].join("\n");

	return {
		model,
		reasoning_effort: "high",
		max_completion_tokens: 4000,
		messages: [
			{ role: "system", content: `${body}${ACTIONS_OUTPUT_SECTION}` },
			{ role: "user", content: user },
		],
	};
}

export const buildRequest: (env: RenderEnv, diff: Uint8Array, chunkNote?: string) => EngineRequest =
	traced("actions.prReview.buildRequest", buildRequestImpl, {
		redact: { args: [0], result: true },
	});

/**
 * One request per chunk. A single chunk renders exactly
 * `buildRequest(env, diff)`; N chunks each carry the chunk note naming their files.
 */
function buildChunkRequestsImpl(
	env: RenderEnv,
	diff: Uint8Array,
): { chunks: DiffChunk[]; requests: EngineRequest[] } {
	const chunks = chunkDiff(diff);
	if (chunks.length === 1) {
		return { chunks, requests: [buildRequest(env, diff)] };
	}
	const n = chunks.length;
	const requests = chunks.map((chunk) =>
		buildRequest(
			env,
			chunk.bytes,
			`Chunk ${chunk.index} of ${n}. This request carries only these files: ${chunk.files.join(", ")}. The other files of this pull request are reviewed in separate requests; review only the files below.`,
		),
	);
	return { chunks, requests };
}

export const buildChunkRequests = traced(
	"actions.prReview.buildChunkRequests",
	buildChunkRequestsImpl,
	{ redact: { args: [0, 1], result: true } },
);

if (import.meta.main) {
	const diff = new Uint8Array(await Bun.stdin.arrayBuffer());
	// sf#697: an oversized diff renders no request. The reason goes to
	// SKIP_FILE, which the workflow's engine and publish steps read.
	const skip = oversizeReason(diff);
	const skipFile = process.env.SKIP_FILE;
	if (skip !== null && skipFile !== undefined && skipFile !== "") {
		await Bun.write(skipFile, skip);
		process.stderr.write(`render-pr-review: ${skip}\n`);
		process.exit(0);
	}
	const chunkDir = process.env.CHUNK_DIR;
	try {
		if (chunkDir !== undefined && chunkDir !== "") {
			const { chunks, requests } = buildChunkRequests(process.env as RenderEnv, diff);
			for (const [i, request] of requests.entries()) {
				await Bun.write(`${chunkDir}/request-${i + 1}.json`, JSON.stringify(request));
			}
			const manifest = {
				chunks: chunks.map((chunk) => ({
					index: chunk.index,
					files: chunk.files,
					lines: chunk.lines,
					bytes: chunk.bytes.byteLength,
				})),
			};
			await Bun.write(`${chunkDir}/manifest.json`, JSON.stringify(manifest));
			process.stderr.write(`render-pr-review: ${chunks.length} chunk(s)\n`);
			process.exit(0);
		}
		process.stdout.write(JSON.stringify(buildRequest(process.env as RenderEnv, diff)));
	} catch (error) {
		if (error instanceof RenderEnvError) {
			process.stderr.write(`render-pr-review: ${error.message}\n`);
			process.exitCode = 2;
		} else {
			throw error;
		}
	}
}
