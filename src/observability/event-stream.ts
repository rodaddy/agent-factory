/**
 * @module observability/event-stream
 * @description Parse a runner agent's per-attempt `events.jsonl` into the bounded,
 *   trace-shaped summary the Langfuse emitter sends. PURE: no network, no clock,
 *   no filesystem — the whole mapping is a function of the raw text, so the
 *   fixture test is the specification.
 *
 *   UNTRUSTED INPUT. The stream is written by an agent on a runner box, so every
 *   value here is attacker-influenceable: tool names, tool arguments, tool
 *   results, assistant text, even the `model` string. Nothing is trusted for a
 *   control decision (issue #170 non-goal: observability is never a control
 *   input) and every STRING that leaves this module is clipped and passed
 *   through `redactSecrets` before it can reach a log line or an HTTP body —
 *   including the four short identifier fields (`model`, `provider`, `api`,
 *   `stopReason`), which read as enum-ish tokens and are not. Bypassing `clip`
 *   for those four put a secret-shaped `provider` verbatim into a Langfuse tag
 *   and shipped a 50k-char `model` whole (PR #176 review, probe receipts). The
 *   numeric fields are bounded by `Number.isFinite`, and timestamps by a
 *   plausible-window clamp. A parse
 *   failure is a `null` summary, never a throw — the ingest boundary that calls
 *   this must be unaffected by anything the box wrote.
 *
 *   ATTESTATION. `observedModel` comes ONLY from the
 *   provider-stamped `message_end.message.model` on the last assistant turn that
 *   CARRIED ONE — tracked past the `MAX_OBSERVATIONS` cap, because the cap bounds
 *   what is SENT, not what is attested, and not overwritten by a later turn with
 *   no model, because absent is not a correction. It is
 *   never read from any agent-authored field: in the #110 pilot the agent wrote
 *   `"observed_model": "ChatGPT"` into its own result while the server attested
 *   `gpt-5.6-sol`. The stream field is what the runtime recorded from the API
 *   response; the result field is what the model claimed about itself.
 *
 *   TOOL SPAN TIMING. pi tool events carry NO timestamps. A tool span is folded
 *   3-events-to-1 (`tool_execution_start` + result + `tool_execution_end`) and
 *   placed between the neighbouring stamped events, marked `approx_timing` so a
 *   reader is never misled into treating the duration as measured. Capture-time
 *   stamping is the real fix and is wrapper-side, out of scope here.
 *
 * @outputs
 *   - `AttemptTrace` -- the bounded, trace-shaped summary
 *   - `TraceGeneration` / `TraceToolSpan` -- its two observation shapes
 *   - `parseEventStream` -- raw text -> summary, or null when unusable
 *
 * @dependencies
 *   - ../results/ingest -- `redactSecrets` and the shared `MAX_EVENT_STREAM_BYTES`
 *     cap, so the read boundary and the parse boundary cannot disagree on size
 */
import { traced } from "../log";
import { MAX_EVENT_STREAM_BYTES, redactSecrets } from "../results/ingest";

/** Max characters of clipped untrusted text in a generation output field. */
const CLIP_OUTPUT = 2_000;

/** Max characters of clipped untrusted text in a tool span input/output field. */
const CLIP_TOOL = 500;

/**
 * Max characters of a clipped untrusted IDENTIFIER field — `model`, `provider`,
 * `api`, `stopReason`. These read as short enum-ish tokens, but they came off a
 * runner box like everything else: a 50k-char `model` and a secret-shaped
 * `provider` were both demonstrated reaching Langfuse verbatim (PR #176 review,
 * probe receipts) because they used a bare string read instead of `clip`.
 */
const CLIP_IDENT = 200;

/** Max observations of each kind carried out of one stream. */
const MAX_OBSERVATIONS = 500;

/**
 * The plausible window for an event timestamp, in epoch ms. A runner-supplied
 * number outside it is REJECTED (null) rather than coerced: `999999999999` was
 * promoted to the year 33658 and a huge negative produced an `Invalid Date`
 * whose `toISOString()` throws a `RangeError`, silently dropping the whole
 * trace (PR #176 review, executed probes). Lower bound 2001-09-09 (1e12 ms) is
 * the same threshold the seconds-promotion heuristic keys on; upper bound is
 * one day of clock skew past the caller's own now.
 */
const MIN_STAMP_MS = 1_000_000_000_000;
const MAX_SKEW_MS = 24 * 60 * 60 * 1000;

/** One assistant turn, with the attested model and its token usage. */
export interface TraceGeneration {
	/** Stable within a trace: `turn-1`, `turn-2`, ... */
	name: string;
	/** The PROVIDER-attested model, never an agent-authored self-report. */
	model: string | null;
	provider: string | null;
	api: string | null;
	stopReason: string | null;
	startTime: Date;
	endTime: Date;
	input: number | null;
	output: number | null;
	total: number | null;
	reasoning: number | null;
	cacheRead: number | null;
	/** Clipped, redacted assistant text. */
	text: string;
}

/** One folded tool call: start + end collapsed into a single span. */
export interface TraceToolSpan {
	/** `<toolName>: <label>`, clipped — the label is a path or command argument. */
	name: string;
	startTime: Date;
	endTime: Date;
	/** Clipped, redacted JSON of the tool arguments. */
	input: string;
	/** Clipped, redacted tool result text. */
	output: string;
	ok: boolean;
	/** Always true for a pi stream: tool events carry no timestamps of their own. */
	approxTiming: boolean;
}

/** The bounded, trace-shaped summary of one attempt's event stream. */
export interface AttemptTrace {
	/** The provider-attested model of the last assistant turn that carried one. */
	observedModel: string | null;
	provider: string | null;
	generations: TraceGeneration[];
	toolSpans: TraceToolSpan[];
	startTime: Date;
	endTime: Date;
	/** Total events read out of the stream (including ones not mapped). */
	eventCount: number;
	/**
	 * True when `MAX_OBSERVATIONS` dropped generations or tool spans, so a reader
	 * knows the observation list is a PREFIX of the run rather than the whole of
	 * it. The attestation is unaffected — it is tracked past the cap.
	 */
	truncated: boolean;
	/**
	 * Tool calls that started and never ended in this stream — the entries still
	 * resident in the fold's open-span map when the parse finished.
	 *
	 * EXPOSED SO THE RETENTION BOUND IS ASSERTABLE. A genuinely unterminated tool
	 * call is real and expected (a killed run ends mid-tool), so a non-zero value
	 * is not an error. What is NOT expected is a MATCHED pair leaving an entry
	 * behind: `foldToolEnd` used to return on the cap before deleting, so every
	 * start past the observation cap stayed resident with its whole raw event for
	 * the rest of the parse. Without this field the map
	 * is module-private and a test for that leak can only assert things the leak
	 * does not change — it would pass either way, proving the opposite of its
	 * name.
	 *
	 * COUNTS EVERY OPEN SPAN SINCE #192. The map used to be keyed by raw
	 * `toolCallId`, so id-less events collided on the `""` key and a duplicate id
	 * overwrote the span already open under it — either way concurrent
	 * unterminated calls UNDERREPORTED as one. The key is now an internal
	 * monotonic ordinal, unique per start and derived from nothing the runner
	 * wrote, so a stream with N unterminated calls holds N entries regardless of
	 * whether it carries ids at all — and regardless of how those ids are shaped.
	 * A crafted id previously reached the same undercount by colliding with the
	 * synthetic keyspace it was supposed to be namespaced away from (#199 round
	 * 2): 5 unterminated starts on an id shaped `Y#dup1` counted 3.
	 *
	 * NOTHING BUT AN ID-LESS END DECREMENTS IT SPECULATIVELY. An end
	 * carrying an id retires that id's span or none at all, so a start lost to
	 * truncation, and a duplicate end replayed after its own span closed, both
	 * leave the count alone. #192 ran the tool-name fallback on any lookup miss,
	 * which let either shape close an unrelated live span — reporting its
	 * duration against the wrong call AND zeroing the very signal that says a
	 * start went unmatched. The number is only load-bearing if the paths that
	 * lower it are the paths that genuinely closed something.
	 */
	unclosedToolSpans: number;
	/**
	 * How many times a backwards stamp was clamped forward by `notBefore` —
	 * across generations, tool spans, and the trace end.
	 *
	 * The clamp is otherwise INVISIBLE: a clamped interval and a genuinely
	 * instantaneous one both render as zero duration, so a runner with broken NTP
	 * was indistinguishable from a fast turn. Zero means
	 * every stamp arrived ordered; non-zero means the box's clock, not the
	 * workload, is what the durations are describing.
	 */
	clampedTimestamps: number;
}

/** A JSON value shaped like an object, for narrow property reads. */
type Rec = Record<string, unknown>;

/** Narrow an unknown to an object without asserting any property. */
function asRecord(value: unknown): Rec | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Rec)
		: null;
}

/** A string property, or null when absent/not a string. */
function str(rec: Rec | null, key: string): string | null {
	const value = rec?.[key];
	return typeof value === "string" ? value : null;
}

/**
 * A TOKEN COUNT property: a non-negative safe integer, or null.
 *
 * A bare finite check is too weak for usage numbers. It accepts anything
 * finite, so a runner
 * writing `"input": -7` or `"input": 1e300` had it pass straight through into
 * Langfuse's usage fields (PR #176, Sol gauntlet P2) — a negative count corrupts
 * every aggregate it lands in, and a value past `Number.MAX_SAFE_INTEGER` is not
 * even faithfully representable as the integer it claims to be. A token count is
 * a cardinality: negative, fractional, and beyond-safe-integer are all
 * NONSENSE rather than extreme, and the honest reading of nonsense is "unknown",
 * not a clamped number the operator would read as measured.
 */
function tokens(rec: Rec | null, key: string): number | null {
	const value = rec?.[key];
	return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

/** Clip and redact one untrusted string to a bounded field. */
function clip(value: unknown, max: number): string {
	const text = typeof value === "string" ? value : JSON.stringify(value ?? "");
	const safe = redactSecrets(text ?? "");
	return safe.length <= max ? safe : `${safe.slice(0, max)}…[clipped]`;
}

/**
 * A clipped, redacted IDENTIFIER property, preserving null for "absent".
 *
 * `model`, `provider`, `api`, and `stopReason` are runner-authored strings that
 * reach a Langfuse tag, a generation field, and (for `model`) a durable DB
 * column. Reading them with a bare `str()` shipped a secret-shaped `provider`
 * verbatim as a `runtime:` tag and a 50k-char `model` whole (PR #176 review,
 * probe receipts). Null-preserving because "absent" and "empty" are different
 * facts in an attestation.
 */
function ident(rec: Rec | null, key: string): string | null {
	const value = str(rec, key);
	return value === null ? null : clip(value, CLIP_IDENT);
}

/**
 * Reject a timestamp outside the plausible window. UNTRUSTED INPUT: a runner
 * picks these numbers, so the only safe posture is to accept a window and drop
 * everything else — coercion is what produced a year-33658 trace and an
 * `Invalid Date` that threw out of `toISOString()`.
 */
function plausibleMs(ms: number, nowMs: number): number | null {
	if (!Number.isFinite(ms)) return null;
	return ms >= MIN_STAMP_MS && ms <= nowMs + MAX_SKEW_MS ? ms : null;
}

/**
 * The timestamp of one event, as epoch milliseconds, or null.
 *
 * pi stamps assistant/user messages inside `message.timestamp` as epoch ms, and
 * the session header at the top level as an ISO string. Both are accepted; a
 * seconds-scale number is promoted to ms so an older stream does not land the
 * whole trace in 1970. The promoted value is then CLAMPED to a plausible
 * window: out of range is null (the event is left unstamped and backfills from
 * its neighbours), never a bogus date and never an `Invalid Date`.
 */
function eventTimeMs(event: Rec, nowMs: number): number | null {
	const raw = event.timestamp ?? asRecord(event.message)?.timestamp;
	if (typeof raw === "number" && Number.isFinite(raw)) {
		// Promote a seconds-scale value, then clamp. `999999999999` is below the ms
		// threshold, so it promotes to the year 33658 and is REJECTED here.
		return plausibleMs(raw > MIN_STAMP_MS ? raw : raw * 1000, nowMs);
	}
	if (typeof raw === "string") {
		const parsed = Date.parse(raw);
		return Number.isNaN(parsed) ? null : plausibleMs(parsed, nowMs);
	}
	return null;
}

/**
 * Backfill each event's timestamp from the nearest PRIOR stamped event, so an
 * unstamped event (every tool event, in a pi stream) still has a monotone place
 * on the timeline. Leading unstamped events inherit the first stamp found.
 */
function backfillStamps(events: Rec[], nowMs: number): number[] {
	const stamps = events.map((event) => eventTimeMs(event, nowMs));
	let last: number | null = null;
	for (let i = 0; i < stamps.length; i++) {
		const value = stamps[i];
		if (value === null || value === undefined) stamps[i] = last;
		else last = value;
	}
	// Leading nulls: inherit the first real stamp rather than staying null.
	const first = stamps.find((s) => s !== null && s !== undefined) ?? null;
	// A stream with NO usable stamp anywhere falls back to the observed now, not
	// to epoch 0 — a trace placed at 1970-01-01 hides behind the Langfuse UI's
	// default Past-1-day filter exactly the way a backdated trace does.
	return stamps.map((s) => s ?? first ?? nowMs);
}

/**
 * The latest stamp in the backfilled list, or `fallback` when the list is empty.
 *
 * Iterative on purpose: `Math.max(...stamps)` spreads one argument per event,
 * and this list is bounded only by the 4MB stream cap, so a large stream would
 * blow the call stack rather than return a number.
 */
function maxStamp(stamps: number[], fallback: number): number {
	let max = fallback;
	for (const stamp of stamps) {
		if (stamp > max) max = stamp;
	}
	return max;
}

/**
 * Parse the raw stream text into events, refusing an oversized document whole
 * and skipping any individual line that is not a JSON object. A stream that
 * yields no events at all is unusable and returns null.
 */
function readEvents(raw: string): Rec[] | null {
	// Re-checked here even though the reader already capped its read: this module
	// is callable with any text, and an oversized stream is refused WHOLE rather
	// than truncated — a half-read JSONL silently drops the terminal turns, and a
	// trace missing its final generation reads as a run that ended early.
	if (Buffer.byteLength(raw, "utf8") > MAX_EVENT_STREAM_BYTES) {
		return null;
	}
	const events: Rec[] = [];
	for (const line of raw.split("\n")) {
		const trimmed = line.trim();
		if (trimmed === "") continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			// One malformed line does not condemn the stream; the agent's stdout can
			// interleave. Skip it and keep the events that ARE well-formed.
			continue;
		}
		const record = asRecord(parsed);
		if (record !== null && typeof record.type === "string") events.push(record);
	}
	return events.length === 0 ? null : events;
}

/**
 * An end stamp that can never precede its own start.
 *
 * UNTRUSTED CLOCK. The stamps come off a runner box and nothing orders them: a
 * clock step, an NTP correction, or a runner simply writing descending
 * timestamps produces an observation whose end is before its start, which
 * Langfuse renders as a NEGATIVE duration and which poisons any latency
 * aggregate computed over the trace. Every stamp is
 * already inside the plausible window by the time it reaches here, so the only
 * remaining defect is ORDER, and collapsing a backwards interval to zero
 * duration is the honest reading — the events did happen, we just cannot say
 * how far apart.
 *
 * COUNTED, NOT SILENT. The clamp is invisible in the output — a clamped span and
 * a genuinely instantaneous one both render as zero duration — so broken NTP on
 * a runner looked identical to a fast turn. `counter`
 * is incremented only when the clamp ACTUALLY fired, and surfaces as
 * `clampedTimestamps`.
 */
function notBefore(endMs: number, startMs: number, counter?: { clamped: number }): number {
	if (endMs < startMs) {
		if (counter !== undefined) counter.clamped++;
		return startMs;
	}
	return endMs;
}

/**
 * Map one assistant `message_end` into a generation.
 *
 * @param span - the turn's interval plus the clamp counter `notBefore` reports
 *   a backwards end stamp into
 */
function toGeneration(
	message: Rec,
	turn: number,
	span: { startMs: number; endMs: number; counter: { clamped: number } },
): TraceGeneration {
	const { startMs, endMs, counter } = span;
	const usage = asRecord(message.usage);
	const content = Array.isArray(message.content) ? message.content : [];
	const text = content
		.map((part) => str(asRecord(part), "text"))
		.filter((part): part is string => part !== null)
		.join("\n");
	return {
		name: `turn-${turn}`,
		// ATTESTED, never agent-authored: this is what the runtime recorded from the
		// provider's own response envelope. Attested is not the same as TRUSTED —
		// the bytes still came off a runner box, so all four are clipped+redacted.
		model: ident(message, "model"),
		provider: ident(message, "provider"),
		api: ident(message, "api"),
		stopReason: ident(message, "stopReason"),
		startTime: new Date(startMs),
		endTime: new Date(notBefore(endMs, startMs, counter)),
		// `tokens`, not `num`: these are UNTRUSTED cardinalities bound for Langfuse's
		// usage fields, so negatives, fractions, and past-safe-integer magnitudes are
		// dropped as unknown rather than reported as measured.
		input: tokens(usage, "input"),
		output: tokens(usage, "output"),
		total: tokens(usage, "totalTokens"),
		reasoning: tokens(usage, "reasoning"),
		cacheRead: tokens(usage, "cacheRead"),
		text: clip(text, CLIP_OUTPUT),
	};
}

/** The `<toolName>: <label>` span name; the label is a path or command argument. */
function toolSpanName(toolName: string, args: Rec | null): string {
	const label = str(args, "path") ?? str(args, "command") ?? "";
	return clip(`${toolName}: ${label}`.trim(), 80);
}

/** The text of a tool result, which pi nests as `{content:[{type,text}]}`. */
function toolResultText(event: Rec): string {
	const result = event.result ?? event.output;
	const content = asRecord(result)?.content;
	if (Array.isArray(content)) {
		return content
			.map((part) => str(asRecord(part), "text"))
			.filter((part): part is string => part !== null)
			.join("\n");
	}
	return typeof result === "string" ? result : JSON.stringify(result ?? "");
}

/** Accumulator threaded through the single pass over the stream. */
interface Fold {
	generations: TraceGeneration[];
	toolSpans: TraceToolSpan[];
	/**
	 * Open tool spans, keyed by an INTERNAL MONOTONIC ORDINAL.
	 *
	 * NO ATTACKER STRING IS EVER KEY MATERIAL. The key was the raw `toolCallId`
	 * until #192, then a string mixing the id, the tool name, a `#dup` suffix and
	 * a NUL namespace byte. Both shapes were broken by a crafted id, twice, for
	 * the same root reason: a runner writes the strings the keyspace is built out
	 * of. NUL is legal inside a JSON string and nothing validated the
	 * charset, so an id could be shaped to land on the synthetic keyspace and
	 * close an id-less victim's span; and the `#dup` suffix was never checked to
	 * be free, so an id shaped `Y#dup1` collided with the suffixed key of a start
	 * on id `Y` — a start vanished with no span and no unclosed count, and the
	 * indexes desynced from `open`.
	 *
	 * A number the parse alone chooses is inert by construction: no id can equal
	 * it, no name can collide with it, and the whole class of crafted-key defects
	 * is gone rather than patched a third time.
	 *
	 * `toolName`/`callId` are carried on the entry so a close needs no re-parse of
	 * the held start event and can prune both indexes.
	 */
	open: Map<number, { event: Rec; startMs: number; toolName: string; callId: string | null }>;
	/**
	 * Open ordinals of ID-LESS starts per tool name — a LIFO STACK, drained
	 * most-recent-first.
	 *
	 * ONLY ID-LESS STARTS ARE HERE. A start that carries an id goes
	 * to `byId` INSTEAD, not as well, so an id-less end — which asserts no
	 * identity — can never drain a span that identified itself.
	 *
	 * Only an id-LESS end reads it, and it POPS THE TAIL: the most recent
	 * still-open id-less call of that tool. That is the opposite discipline from
	 * `byId`, which is a FIFO queue drained oldest-first, and the difference is
	 * deliberate. An id names one specific call, so a reused id must retire its
	 * calls in the order they started. An id-less end names nothing but a tool, so
	 * the newest open call is the only defensible guess — and it is the behavior
	 * #192 established for concurrent id-less calls.
	 *
	 * LOOKUP is O(1) off the tail; RETIREMENT IS NOT. `dropIndex` is an `indexOf`
	 * plus a `splice`, both linear in the chain, so a close is O(1) only in the
	 * common case where the entry being retired is at or near the tail. The honest
	 * bound is that a chain can hold at most as many starts as
	 * `MAX_EVENT_STREAM_BYTES` admits — and THAT CAP IS WHAT MAKES IT ACCEPTABLE,
	 * not any property of the data structure. Measured worst case (executed, round
	 * 3): 30k starts on ONE reused id, 3.78MB, just inside the 4MB cap — every end
	 * pops position 0 and shifts the whole chain — parses in 64ms, against 30ms at
	 * 19k. Tolerable in the ingest path. Without the byte cap the same shape is
	 * unbounded and this index would need a different structure.
	 *
	 * Scanning `open` per end instead was O(open) with a much larger constant, and
	 * `MAX_EVENT_STREAM_BYTES` allows enough starts to make that quadratic, on
	 * runner output that is UNTRUSTED and therefore adversarially shaped by
	 * assumption. PR #199 review measured 4.78s at 35k pairs; reverting to the scan
	 * against this repo's own regression fixture — 20k pairs, ~3.5MB, inside the
	 * cap — measured 6.8s of synchronous block in the ingest path, against 24ms
	 * with the stack.
	 *
	 * Kept exactly in step with `open`: every insert pushes, every delete removes.
	 * A stale ordinal here would close a span that is no longer open.
	 */
	byName: Map<string, number[]>;
	/**
	 * Open ORDINALS per `toolCallId` — a FIFO QUEUE, drained oldest-first.
	 *
	 * This is the ONLY thing an id-carrying end consults, and it pops the OLDEST
	 * ordinal of ITS OWN id, so a reused id closes strictly first-in-first-out and
	 * an end can never reach a span started under a different id. The id is a MAP
	 * KEY here and not part of the `open` keyspace, so an adversarial id can only
	 * ever name its own chain — the worst it can do is collide with itself, which
	 * is precisely the reused-id case this chain exists to handle.
	 */
	byId: Map<string, number[]>;
	/**
	 * The next span ordinal. Monotonic per parse and never reset, so an ordinal is
	 * unique for the whole stream even after its span closes and its map entry is
	 * deleted — a new span can never land on a retired key.
	 */
	nextOrdinal: number;
	prevMs: number;
	/** Count of assistant turns SEEN, which is not the count RECORDED past the cap. */
	assistantTurns: number;
	/** The attestation: last assistant turn's model, tracked past the cap. */
	lastModel: string | null;
	lastProvider: string | null;
	/** True once the cap dropped a generation or a tool span. */
	truncated: boolean;
	/** How many times the `notBefore` clamp actually fired. */
	clamped: number;
}

/**
 * Fold one assistant `message_end` into the accumulator.
 *
 * THE CAP BOUNDS WHAT IS SENT, NOT WHAT IS ATTESTED. `lastModel`/`lastProvider`
 * are updated for EVERY assistant turn, before the cap's early return: reading
 * the attestation off `generations[MAX_OBSERVATIONS - 1]` stamped turn 500's
 * model on a 520-turn run (PR #176 review, executed probe), so a model switch
 * — or a spoofer padding the stream — past the cap defeated the attestation
 * this module exists for.
 *
 * A TURN CARRYING NO `model` DOES NOT WIPE THE ATTESTATION. Assigning
 * unconditionally let one trailing model-less `message_end` — which a runner
 * writes for free, and which the stream format permits — null out an
 * attestation gathered from 500 good turns, turning "the provider said
 * gpt-5.6-sol" into "unknown". Absent is not a
 * correction: the LAST ATTESTED model is the fact worth keeping, so an absent
 * value leaves the prior one standing. `provider` moves with `model` so the two
 * always describe the SAME turn; splitting them would let a later provider-only
 * turn label an earlier turn's model.
 *
 * NEITHER IS A BLANK STRING. Round 2 closed the absent-key door and left the
 * blank-string one open: `ident()` returns `""` for `"model": ""`, which is not
 * null, so `""` and `"   "` still wiped a 500-turn attestation and — because
 * `provider` moves with `model` — let the trace be relabeled with a
 * runner-chosen provider (PR #176 review round 3, executed probe). An empty or
 * whitespace-only model attests nothing, so it is treated exactly like absent,
 * matching what `safeObservedModel` already does one layer down.
 */
function foldGeneration(fold: Fold, event: Rec, atMs: number): void {
	const message = asRecord(event.message);
	if (message === null || str(message, "role") !== "assistant") return;
	fold.assistantTurns++;
	const model = ident(message, "model");
	if (model !== null && model.trim() !== "") {
		fold.lastModel = model;
		fold.lastProvider = ident(message, "provider");
	}
	if (fold.generations.length >= MAX_OBSERVATIONS) {
		fold.truncated = true;
		return;
	}
	fold.generations.push(
		toGeneration(message, fold.generations.length + 1, {
			startMs: fold.prevMs,
			endMs: atMs,
			counter: fold,
		}),
	);
	fold.prevMs = atMs;
}

/** Push `ordinal` onto the `bucket` chain of `index`, creating it if absent. */
function pushIndex(index: Map<string, number[]>, bucket: string, ordinal: number): void {
	const chain = index.get(bucket);
	if (chain === undefined) index.set(bucket, [ordinal]);
	else chain.push(ordinal);
}

/** Drop `ordinal` from the `bucket` chain of `index`, retiring an emptied chain. */
function dropIndex(index: Map<string, number[]>, bucket: string, ordinal: number): void {
	const chain = index.get(bucket);
	if (chain === undefined) return;
	const at = chain.indexOf(ordinal);
	if (at !== -1) chain.splice(at, 1);
	if (chain.length === 0) index.delete(bucket);
}

/**
 * Record an open span under a FRESH ordinal, and index it for the ONE lookup
 * that may reach it.
 *
 * THE ORDINAL IS CHOSEN HERE AND NOWHERE ELSE, from a counter this parse owns,
 * so no code path derives a span key from runner-supplied text.
 *
 * THE TWO INDEXES ARE EXCLUSIVE, NOT OVERLAPPING. A start goes
 * into `byId` when it carries an id and into `byName` when it does not — never
 * both. Indexing an id-carrying start under its NAME as well left it reachable
 * by an id-less end, which asserts no identity at all, so an end that
 * identified nothing could still drain a span that had identified itself.
 * Executed repro: id-less start `/idless-real` at 0s, start `call-x`
 * `/owned` at 1s on the same tool, id-less end at 6s, end `call-x` at 9s — the
 * id-less end took the tail of the shared name chain and closed `/owned` at
 * 5000ms, and `/idless-real` was then closed by `call-x`'s end. Both spans
 * survived and `unclosedToolSpans` stayed 0, so nothing in the report said the
 * durations had been swapped.
 *
 * The confinement is now symmetric with `matchOpen`: an id-carrying end reaches
 * only its own id's chain, and an id-less end reaches only spans that likewise
 * asserted no identity. An id-carrying span is reachable solely through its own
 * `byId` chain, which is the only thing it ever claimed to be.
 */
function openSpan(
	fold: Fold,
	entry: { event: Rec; startMs: number; toolName: string; callId: string | null },
): void {
	const ordinal = fold.nextOrdinal;
	fold.nextOrdinal += 1;
	fold.open.set(ordinal, entry);
	if (entry.callId !== null && entry.callId !== "") pushIndex(fold.byId, entry.callId, ordinal);
	else pushIndex(fold.byName, entry.toolName, ordinal);
}

/**
 * Retire `ordinal` from the open map and from every index that points at it.
 *
 * A span sits in exactly ONE index — `byId` if it carried an id, `byName` if it
 * did not (see `openSpan`) — so one of these two `dropIndex` calls is always a
 * no-op. Both are issued anyway rather than re-deriving which index owns the
 * entry: `dropIndex` returns silently on a missing bucket, and a retirement that
 * skipped the owning index would leave a stale ordinal behind. Cheap, and it
 * cannot desync.
 *
 * Index removal is a splice, not a pop: on a reused id the entry being retired
 * is the OLDEST of its chain, not the newest. Leaving it behind would let a
 * later end resolve to a span that already closed — the same class of theft this
 * fix exists to remove.
 */
function closeSpan(fold: Fold, ordinal: number): { event: Rec; startMs: number } | undefined {
	const entry = fold.open.get(ordinal);
	if (entry === undefined) return undefined;
	fold.open.delete(ordinal);
	dropIndex(fold.byName, entry.toolName, ordinal);
	if (entry.callId !== null && entry.callId !== "") dropIndex(fold.byId, entry.callId, ordinal);
	return entry;
}

/**
 * The ordinal of the open span a `tool_execution_end` closes, or null.
 *
 * LOOKUP INDEXES ONLY. The strings an end carries are keys into `byId` and
 * `byName` — never keys of `open` itself, which is keyed by an internal ordinal.
 * An id can therefore name its OWN chain and nothing else, whatever bytes it
 * contains. Both shipped defects here came from mixing attacker strings into the
 * keyspace: a crafted id containing a NUL landed on the synthetic
 * `<NUL><name>#<n>` keyspace and closed an id-less victim's span, and an id
 * shaped `Y#dup1` collided with the unchecked `#dup` suffix of a start on id `Y`
 * — losing a start with no span and no unclosed count, and desyncing the indexes
 * from `open`. This is the redesign that removes the class rather than patching
 * it a third time.
 *
 * - An id-carrying end pops the OLDEST ordinal on its OWN id's chain — strict
 *   FIFO across a reused id, with no preference for whichever start happened to
 *   hold a "plain" key. There is no tool-name fallback for it at all.
 * - An id-LESS, NAMED end takes the most recent still-open ID-LESS span of that
 *   tool name, read in O(1) off the tail of that name's chain. It cannot reach a
 *   span that carried an id: those live only on their own `byId` chain, so an
 *   end asserting no identity can only resolve a start that asserted none
 *   either. (Retiring the entry afterwards is a linear `indexOf`+`splice`, not
 *   O(1) — see `byName`; the byte cap is what bounds it.)
 * - A name-less AND id-less end matches NOTHING. It identifies no call, and
 *   absent attests nothing — the same rule this module applies to a blank model
 *   on an assistant turn. `toolName === null` used to be a wildcard in the
 *   fallback's `||`, closing the newest span of ANY tool.
 *
 * THE ID PATH IS GATED ON THE ABSENCE OF AN ID, NOT ON A LOOKUP MISS. #192 ran
 * the name fallback whenever the id missed, which is also true for the two
 * commonest shapes on an untrusted stream: an ORDINARY DUPLICATE end (a retry,
 * or an end replayed after its span already closed) and an end whose start was
 * lost to truncation. Both then closed an unrelated live span. Executed repro:
 * start `call-a`, end `call-a`, start `call-b` on the SAME
 * tool, stale duplicate end `call-a`, end `call-b` — the duplicate closed the
 * live `call-b` at 6000ms and `call-b`'s real end degraded to a start-less span.
 * The shared tool NAME is what makes it bite; two different tools never crossed,
 * so a repro built that way passes on the broken code. Against a truncated start
 * it silently zeroed the `unclosedToolSpans` retention signal, the one number
 * that says a start went unmatched.
 *
 * Returns null when nothing matches; the caller then emits a start-less span,
 * the honest report for an end that identifies nothing.
 */
function matchOpen(fold: Fold, callId: string | null, toolName: string | null): number | null {
	if (callId !== null && callId !== "") {
		const chain = fold.byId.get(callId);
		return chain === undefined || chain.length === 0 ? null : (chain[0] ?? null);
	}
	if (toolName === null) return null;
	const chain = fold.byName.get(toolName);
	return chain === undefined || chain.length === 0 ? null : (chain[chain.length - 1] ?? null);
}

/**
 * Fold a `tool_execution_end` against its recorded start into one span.
 *
 * THE OPEN-SPAN MAP IS RETIRED BEFORE THE CAP RETURNS. Returning early left the
 * matching `open` entry — and the whole raw start event it holds — resident for
 * the rest of the parse, so a stream with more than `MAX_OBSERVATIONS` tool
 * calls retained every start event past the cap even though none of them could
 * ever produce a span. The cap exists to bound what
 * this module holds; the early return was defeating it.
 *
 * `MAX_OBSERVATIONS` DOES NOT BOUND THE MAP. It bounds `toolSpans`, the list
 * that is SENT. Unmatched starts accumulate in `open` without ever reaching that
 * list, so the only bound on the map is the one upstream:
 * `MAX_EVENT_STREAM_BYTES` refuses the whole document at 4MB, which is what
 * caps how many start events can exist to be held at once.
 */
function foldToolEnd(fold: Fold, event: Rec, atMs: number): void {
	const ordinal = matchOpen(fold, str(event, "toolCallId"), str(event, "toolName"));
	const started = ordinal === null ? undefined : closeSpan(fold, ordinal);
	if (fold.toolSpans.length >= MAX_OBSERVATIONS) {
		fold.truncated = true;
		return;
	}
	const startEvent = started?.event ?? null;
	const args = asRecord(startEvent?.args);
	const toolName = str(startEvent, "toolName") ?? str(event, "toolName") ?? "tool";
	const spanStartMs = started?.startMs ?? atMs;
	fold.toolSpans.push({
		name: toolSpanName(toolName, args),
		startTime: new Date(spanStartMs),
		endTime: new Date(notBefore(atMs, spanStartMs, fold)),
		input: clip(args ?? {}, CLIP_TOOL),
		output: clip(toolResultText(event), CLIP_TOOL),
		ok: event.isError !== true,
		// pi tool events carry no timestamps of their own; the span is placed between
		// the neighbouring stamped events, so its duration is inferred, not measured.
		approxTiming: true,
	});
}

/**
 * Parse one attempt's raw `events.jsonl` into the bounded trace summary.
 *
 * @param raw - the raw stream text, exactly as read from the share (UNTRUSTED)
 * @param nowMs - the observed now, in epoch ms; bounds the plausible-timestamp
 *   window and is the fallback for a stream carrying no usable stamp. Injected
 *   so the module stays PURE and the fixture test stays the specification.
 * @returns the summary, or null when the stream is oversized, unparseable, or
 *   carries no assistant turn worth tracing
 */
export const parseEventStream = traced(
	"observability.parseEventStream",
	function parseEventStream(raw: string, nowMs: number = Date.now()): AttemptTrace | null {
		const events = readEvents(raw);
		if (events === null) return null;
		const stamps = backfillStamps(events, nowMs);
		const startMs = stamps[0] ?? nowMs;

		const fold: Fold = {
			generations: [],
			toolSpans: [],
			open: new Map(),
			byName: new Map(),
			byId: new Map(),
			nextOrdinal: 1,
			prevMs: startMs,
			assistantTurns: 0,
			lastModel: null,
			lastProvider: null,
			truncated: false,
			clamped: 0,
		};
		for (const [index, event] of events.entries()) {
			const atMs = stamps[index] ?? startMs;
			if (event.type === "message_end") foldGeneration(fold, event, atMs);
			else if (event.type === "tool_execution_start") {
				const toolName = str(event, "toolName") ?? "tool";
				const callId = str(event, "toolCallId");
				openSpan(fold, { event, startMs: atMs, toolName, callId });
			} else if (event.type === "tool_execution_end") foldToolEnd(fold, event, atMs);
		}

		if (fold.generations.length === 0) return null;
		return {
			// The attestation is the provider-stamped model on the LAST assistant turn of
			// the whole stream — tracked past the observation cap, never read back off the
			// (possibly truncated) generation list.
			observedModel: fold.lastModel,
			provider: fold.lastProvider,
			generations: fold.generations,
			toolSpans: fold.toolSpans,
			startTime: new Date(startMs),
			// The trace end is the LATEST stamp seen, held at or after the trace start.
			//
			// MAX, NOT LAST. The last stamp is the last one WRITTEN, which on a runner
			// with a jittering clock is not the latest one that happened: stamps of
			// 0s/2s/1s ended the trace at 1s, inside its own observations, so a
			// generation the trace contains outlived the trace itself and the Langfuse
			// UI drew a run shorter than the work in it (PR #176, Sol gauntlet P3).
			// Every stamp here already survived `plausibleMs`, so the maximum is the
			// latest DEFENSIBLE moment, not an unbounded one a runner can inflate.
			//
			// A LOOP, NOT `Math.max(...stamps)`: spreading an array that
			// `MAX_EVENT_STREAM_BYTES` allows to hold hundreds of thousands of entries
			// into an argument list is a stack overflow waiting for a big stream.
			//
			// `notBefore` STILL RUNS. The max cannot precede the start in practice —
			// `startMs` is `stamps[0]` — but the clamp is what keeps the invariant true
			// for the empty-stamps fallback and keeps `clampedTimestamps` counting the
			// same thing on every path.
			endTime: new Date(notBefore(maxStamp(stamps, startMs), startMs, fold)),
			eventCount: events.length,
			truncated: fold.truncated,
			unclosedToolSpans: fold.open.size,
			clampedTimestamps: fold.clamped,
		};
	},
	// sf#704: arg 0 is UNTRUSTED runner output, and 200 characters of it entered
	// the span verbatim. `scrubUrlUserinfo` catches a connection-string password
	// but a bare token in agent prose matches nothing (probed: a `ghp_`-shaped
	// token passed through while an adjacent `postgresql://` URL was masked).
	// The raw stream is never worth tracing; the parsed summary is the output.
	{ redact: { args: [0] } },
);
