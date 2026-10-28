import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEventStream } from "../../src/observability/event-stream";
import { MAX_EVENT_STREAM_BYTES } from "../../src/results/ingest";

/**
 * The REAL #110 pilot event stream, captured from a pi runner box on 2026-08-01
 * and replayed into Langfuse by hand before this code existed. It is the
 * specification for the mapping: 5 assistant turns, 4 tool calls, and — the
 * point of the whole attestation feature — a stream that attests `gpt-5.6-sol`
 * while the agent wrote `"observed_model": "ChatGPT"` into its own result.
 */
const PILOT = readFileSync(
	join(import.meta.dir, "..", "fixtures", "observability", "pilot-events.jsonl"),
	"utf8",
);

/** One synthetic assistant turn, for the shape tests that need exact control. */
function assistantTurn(over: Record<string, unknown> = {}): string {
	return JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			model: "gpt-5.6-sol",
			provider: "cliproxy",
			api: "openai-completions",
			stopReason: "stop",
			usage: { input: 10, output: 5, totalTokens: 15, reasoning: 2, cacheRead: 1 },
			content: [{ type: "text", text: "done" }],
			timestamp: 1785615593072,
			...over,
		},
	});
}

describe("parseEventStream: the #110 pilot fixture", () => {
	test("maps the real stream to 5 generations and 4 folded tool spans", () => {
		const trace = parseEventStream(PILOT);
		expect(trace).not.toBeNull();
		// 10 message_end events in the stream; only the 5 ASSISTANT ones become
		// generations. The user turn and the four toolResult turns must not.
		expect(trace?.generations).toHaveLength(5);
		// 4 tool_execution_start + 4 tool_execution_end folded 3-events-to-1.
		expect(trace?.toolSpans).toHaveLength(4);
		expect(trace?.generations.map((g) => g.name)).toEqual([
			"turn-1",
			"turn-2",
			"turn-3",
			"turn-4",
			"turn-5",
		]);
	});

	test("attests the model the PROVIDER stamped, not the one the agent claimed", () => {
		const trace = parseEventStream(PILOT);
		// The server attested this. The agent, in the same run, wrote
		// "observed_model": "ChatGPT" into its own result document.
		expect(trace?.observedModel).toBe("gpt-5.6-sol");
		expect(trace?.provider).toBe("cliproxy");
		// The agent's self-report appears in the stream only as tool ARGUMENTS (it
		// wrote that JSON to a file), and must never be mistaken for attestation.
		expect(PILOT).toContain("ChatGPT");
		expect(trace?.observedModel).not.toBe("ChatGPT");
		for (const generation of trace?.generations ?? []) {
			expect(generation.model).toBe("gpt-5.6-sol");
		}
	});

	test("carries the per-turn token usage off the provider envelope", () => {
		const trace = parseEventStream(PILOT);
		const first = trace?.generations[0];
		expect(first?.input).toBe(1527);
		expect(first?.output).toBe(82);
		expect(first?.total).toBe(1609);
		expect(first?.reasoning).toBe(48);
		expect(first?.cacheRead).toBe(0);
		// A later turn read from cache; that is metadata, not a token total.
		expect(trace?.generations[3]?.cacheRead).toBe(1536);
	});

	test("names each tool span `<tool>: <label>` and marks its timing approximate", () => {
		const trace = parseEventStream(PILOT);
		expect(trace?.toolSpans.map((s) => s.name)).toEqual([
			"write: /work/pilot/hello.txt",
			"read: /work/pilot/hello.txt",
			"write: /work/pilot/pilot-result.json",
			"read: /work/pilot/pilot-result.json",
		]);
		for (const span of trace?.toolSpans ?? []) {
			expect(span.ok).toBe(true);
			// pi tool events carry NO timestamps of their own. Anything that reads a
			// duration off these spans must be told it is inferred, not measured.
			expect(span.approxTiming).toBe(true);
			// Placed between neighbouring stamped events, so never inverted.
			expect(span.endTime.getTime()).toBeGreaterThanOrEqual(span.startTime.getTime());
		}
		// The tool result text is carried, clipped and redacted.
		expect(trace?.toolSpans[1]?.output).toContain("factory-pilot-110");
	});

	test("timestamps come off the stream and stay ordered", () => {
		const trace = parseEventStream(PILOT);
		expect(trace?.startTime.toISOString()).toBe("2026-08-01T20:19:53.026Z");
		expect(trace?.endTime.getTime()).toBeGreaterThan(trace?.startTime.getTime() ?? 0);
		expect(trace?.eventCount).toBe(149);
	});
});

describe("parseEventStream: bounds and garbage", () => {
	test("an oversized stream is refused WHOLE, never truncated", () => {
		const oversized = `${"x".repeat(MAX_EVENT_STREAM_BYTES + 1)}\n${assistantTurn()}`;
		expect(parseEventStream(oversized)).toBeNull();
	});

	test("a stream of pure garbage yields no trace", () => {
		expect(parseEventStream("not json at all\n{{{\n")).toBeNull();
		expect(parseEventStream("")).toBeNull();
	});

	test("a malformed line is skipped without condemning the stream", () => {
		const trace = parseEventStream(`{{{ broken\n${assistantTurn()}\nalso broken`);
		expect(trace?.generations).toHaveLength(1);
		expect(trace?.observedModel).toBe("gpt-5.6-sol");
	});

	test("a stream with no assistant turn is not a trace", () => {
		const userOnly = JSON.stringify({
			type: "message_end",
			message: { role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 },
		});
		expect(parseEventStream(userOnly)).toBeNull();
	});

	test("secret-shaped text in an assistant turn is redacted before it leaves", () => {
		const leak = assistantTurn({
			content: [{ type: "text", text: "token: ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
		});
		const trace = parseEventStream(leak);
		expect(trace?.generations[0]?.text).not.toContain("ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
		expect(trace?.generations[0]?.text).toContain("[REDACTED]");
	});

	test("a missing usage block degrades to nulls rather than throwing", () => {
		const trace = parseEventStream(assistantTurn({ usage: undefined, model: undefined }));
		expect(trace?.generations[0]?.input).toBeNull();
		expect(trace?.generations[0]?.model).toBeNull();
		expect(trace?.observedModel).toBeNull();
	});

	test("a tool_execution_end with no matching start still folds to one span", () => {
		const orphan = JSON.stringify({
			type: "tool_execution_end",
			toolCallId: "gone",
			toolName: "bash",
			isError: true,
		});
		const trace = parseEventStream(`${assistantTurn()}\n${orphan}`);
		expect(trace?.toolSpans).toHaveLength(1);
		expect(trace?.toolSpans[0]?.name).toBe("bash:");
		expect(trace?.toolSpans[0]?.ok).toBe(false);
	});
});

describe("identifier fields are UNTRUSTED too", () => {
	test("THE IMPORTANT ONE: a secret-shaped `provider` is redacted, not shipped verbatim", () => {
		// THE REGRESSION: `model`/`provider`/`api`/`stopReason` were read with a bare
		// string accessor while `clip` covered only the text/tool fields. A
		// secret-shaped `provider` reached Langfuse verbatim as a `runtime:` tag
		// (probe receipt, PR #176 review).
		const leak = assistantTurn({
			provider: "aws_secret_access_key=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
		});
		const trace = parseEventStream(leak);
		expect(trace?.generations[0]?.provider).toBe("[REDACTED]");
		expect(trace?.provider).toBe("[REDACTED]");
		expect(JSON.stringify(trace)).not.toContain("AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA");
	});

	test("a 50k-char `model` is BOUNDED, not shipped whole", () => {
		const huge = "m".repeat(50_000);
		const trace = parseEventStream(assistantTurn({ model: huge }));
		const model = trace?.generations[0]?.model ?? "";
		// 200 chars plus the clip marker — never the 50k the box chose.
		expect(model.length).toBeLessThan(300);
		expect(model).toContain("[clipped]");
		// The attestation reads the same bounded value, so the DB column cannot be
		// handed 50k either.
		expect(trace?.observedModel).toBe(model);
		// `api` and `stopReason` are bounded on the same rule.
		const other = parseEventStream(
			assistantTurn({ api: "a".repeat(1_000), stopReason: "s".repeat(1_000) }),
		);
		expect(other?.generations[0]?.api?.length).toBeLessThan(300);
		expect(other?.generations[0]?.stopReason?.length).toBeLessThan(300);
	});

	test("an ABSENT identifier stays null rather than becoming an empty string", () => {
		// "absent" and "empty" are different facts in an attestation.
		const trace = parseEventStream(assistantTurn({ model: undefined, provider: undefined }));
		expect(trace?.generations[0]?.model).toBeNull();
		expect(trace?.generations[0]?.provider).toBeNull();
	});
});

describe("the attestation survives the observation cap", () => {
	test("THE IMPORTANT ONE: with >500 turns the LAST turn's model is attested", () => {
		// THE REGRESSION: `foldGeneration` early-returned at the cap and the
		// attestation was then read back off `generations[499]`, so a 520-turn run
		// stamped `model-499` while the real last turn was `model-519` (executed
		// probe, PR #176 review). A model switch — or a spoofer padding the stream
		// with 500 junk turns — defeated the attestation this module exists for.
		const base = 1_785_615_593_072;
		const lines: string[] = [];
		for (let i = 0; i < 520; i++) {
			lines.push(assistantTurn({ model: `model-${i}`, timestamp: base + i }));
		}
		const trace = parseEventStream(lines.join("\n"));
		expect(trace?.observedModel).toBe("model-519");
		// The CAP still bounds what is SENT.
		expect(trace?.generations).toHaveLength(500);
		expect(trace?.generations[499]?.model).toBe("model-499");
		// ...and says so, so a prefix is never read as the whole run.
		expect(trace?.truncated).toBe(true);
	});

	test("an untruncated stream records truncated: false", () => {
		expect(parseEventStream(PILOT)?.truncated).toBe(false);
	});
});

describe("runner timestamps are clamped to a plausible window", () => {
	test("THE IMPORTANT ONE: `999999999999` does not become the year 33658", () => {
		// Executed probe, PR #176 review: this value is below the ms threshold, so
		// the seconds-promotion heuristic multiplied it by 1000 and landed the trace
		// in the year 33658.
		const trace = parseEventStream(assistantTurn({ timestamp: 999_999_999_999 }));
		expect(trace).not.toBeNull();
		const year = trace?.startTime.getUTCFullYear() ?? 0;
		expect(year).toBeLessThan(3000);
		expect(year).toBeGreaterThan(2000);
		// ...while a legitimate seconds-scale stamp is still promoted to ms.
		const seconds = 1_785_615_593;
		expect(parseEventStream(assistantTurn({ timestamp: seconds }))?.startTime.getTime()).toBe(
			seconds * 1000,
		);
	});

	test("THE IMPORTANT ONE: a huge negative timestamp never yields an Invalid Date", () => {
		// Executed probe: `new Date(-8.64e15 * 1000)` is Invalid, and `toISOString()`
		// THROWS a RangeError on it — which silently dropped the WHOLE trace.
		const trace = parseEventStream(assistantTurn({ timestamp: -8_640_000_000_000_000 }));
		expect(trace).not.toBeNull();
		expect(Number.isFinite(trace?.startTime.getTime())).toBe(true);
		expect(Number.isFinite(trace?.endTime.getTime())).toBe(true);
		// The guard is that the date is USABLE, which is what the emitter needs.
		expect(() => trace?.startTime.toISOString()).not.toThrow();
	});

	test("a far-future timestamp is rejected rather than trusted", () => {
		const nowMs = Date.UTC(2026, 7, 3);
		const trace = parseEventStream(
			assistantTurn({ timestamp: nowMs + 400 * 24 * 60 * 60 * 1000 }),
			nowMs,
		);
		// Out of range => unstamped => falls back to the observed now.
		expect(trace?.startTime.getTime()).toBe(nowMs);
	});

	test("a stream with NO usable stamp anywhere lands at now, not 1970", () => {
		// A trace at 1970-01-01 hides behind the Langfuse UI's default Past-1-day
		// filter exactly the way a backdated trace does.
		const nowMs = Date.UTC(2026, 7, 3);
		const trace = parseEventStream(assistantTurn({ timestamp: undefined }), nowMs);
		expect(trace?.startTime.getTime()).toBe(nowMs);
		expect(trace?.startTime.getUTCFullYear()).toBe(2026);
	});
});

describe("a model-less turn does not wipe the attestation (P1)", () => {
	test("THE IMPORTANT ONE: 500 good turns + one model-less turn keeps gpt-5.6-sol", () => {
		// The defect: `lastModel` was assigned unconditionally on every assistant
		// turn, so ONE trailing `message_end` carrying no `model` — which a runner
		// writes for free, and which the stream format permits — nulled out an
		// attestation gathered from 500 good turns. "The provider said gpt-5.6-sol"
		// became "unknown", which is exactly the attestation this module exists for.
		const base = 1_785_615_593_072;
		const lines: string[] = [];
		for (let i = 0; i < 500; i++) {
			lines.push(assistantTurn({ model: "gpt-5.6-sol", timestamp: base + i }));
		}
		// The 501st turn: assistant, well-formed, and simply carries no model.
		lines.push(assistantTurn({ model: undefined, provider: undefined, timestamp: base + 500 }));
		const trace = parseEventStream(lines.join("\n"));
		// ABSENT IS NOT A CORRECTION: the last ATTESTED model still stands.
		expect(trace?.observedModel).toBe("gpt-5.6-sol");
		expect(trace?.provider).toBe("cliproxy");
		// And the cap still reports that the observation list is a prefix.
		expect(trace?.truncated).toBe(true);
	});

	test("a LATER turn that DOES carry a model still wins", () => {
		// The guard must not freeze the attestation at the first value seen: a real
		// model switch mid-run is the case the unconditional assignment got right.
		const base = 1_785_615_593_072;
		const trace = parseEventStream(
			[
				assistantTurn({ model: "model-a", provider: "prov-a", timestamp: base }),
				assistantTurn({ model: undefined, provider: undefined, timestamp: base + 1 }),
				assistantTurn({ model: "model-b", provider: "prov-b", timestamp: base + 2 }),
			].join("\n"),
		);
		expect(trace?.observedModel).toBe("model-b");
		expect(trace?.provider).toBe("prov-b");
	});

	test("provider moves WITH model, so the two always describe the same turn", () => {
		// A model-less turn carrying a provider must not relabel the earlier turn's
		// model with a later turn's provider.
		const base = 1_785_615_593_072;
		const trace = parseEventStream(
			[
				assistantTurn({ model: "model-a", provider: "prov-a", timestamp: base }),
				assistantTurn({ model: undefined, provider: "prov-late", timestamp: base + 1 }),
			].join("\n"),
		);
		expect(trace?.observedModel).toBe("model-a");
		expect(trace?.provider).toBe("prov-a");
	});
});

describe("the open tool-span map is retired past the cap (P2)", () => {
	test("THE IMPORTANT ONE: 1200 start/end pairs leave no open span resident", () => {
		// The defect: `foldToolEnd` returned early on the cap BEFORE deleting the
		// map entry, so every start event past `MAX_OBSERVATIONS` — and the whole
		// raw event object it holds — stayed resident for the rest of the parse,
		// defeating the very cap that was supposed to bound what this module holds.
		//
		// `unclosedToolSpans` is the map's size at end of parse, exposed for exactly
		// this assertion: every one of these 1200 pairs is MATCHED, so a correct
		// parse retires all 1200 and ends with an empty map. With the delete below
		// the cap return, 700 entries survive.
		const base = 1_785_615_593_072;
		const lines: string[] = [assistantTurn({ timestamp: base })];
		for (let i = 0; i < 1200; i++) {
			lines.push(
				JSON.stringify({
					type: "tool_execution_start",
					toolCallId: `call-${i}`,
					toolName: "Read",
					args: { path: `/f/${i}` },
				}),
			);
			lines.push(
				JSON.stringify({
					type: "tool_execution_end",
					toolCallId: `call-${i}`,
					result: { content: [{ type: "text", text: "ok" }] },
				}),
			);
		}
		const trace = parseEventStream(lines.join("\n"));
		expect(trace).not.toBeNull();
		// THE LEAK ASSERTION: every pair matched, so the map is EMPTY at end of
		// parse. With the delete below the cap return this is 700.
		expect(trace?.unclosedToolSpans).toBe(0);
		// The cap still bounds what is SENT, and says so.
		expect(trace?.toolSpans).toHaveLength(500);
		expect(trace?.truncated).toBe(true);
	});

	test("a genuinely unterminated tool call is still counted, so the field is not vacuous", () => {
		// Guards the assertion above from passing for the wrong reason: if
		// `unclosedToolSpans` were hardcoded to 0 the leak test would be worthless.
		const base = 1_785_615_593_072;
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				JSON.stringify({
					type: "tool_execution_start",
					toolCallId: "never-ends",
					toolName: "Bash",
				}),
			].join("\n"),
		);
		expect(trace?.unclosedToolSpans).toBe(1);
	});
});

describe("a backwards runner clock never yields a negative duration (P3)", () => {
	test("THE IMPORTANT ONE: out-of-order stamps produce no end before its start", () => {
		// UNTRUSTED CLOCK: nothing orders these stamps. A clock step or a runner
		// simply writing descending timestamps produced an observation whose end
		// preceded its start, which Langfuse renders as a NEGATIVE duration.
		const base = 1_785_615_593_072;
		const trace = parseEventStream(
			[
				assistantTurn({ model: "model-a", timestamp: base + 10_000 }),
				// Second turn stamped 5s EARLIER than the first.
				assistantTurn({ model: "model-b", timestamp: base + 5_000 }),
				assistantTurn({ model: "model-c", timestamp: base + 1_000 }),
			].join("\n"),
		);
		expect(trace).not.toBeNull();
		for (const generation of trace?.generations ?? []) {
			expect(generation.endTime.getTime()).toBeGreaterThanOrEqual(generation.startTime.getTime());
		}
		// And the TRACE itself: last stamp is the earliest, so the raw end would
		// have been 9s before the start.
		expect(trace?.endTime.getTime()).toBeGreaterThanOrEqual(trace?.startTime.getTime() ?? 0);
	});

	test("a tool span whose end stamp precedes its start collapses to zero, not negative", () => {
		const base = 1_785_615_593_072;
		const trace = parseEventStream(
			[
				assistantTurn({ model: "model-a", timestamp: base + 10_000 }),
				JSON.stringify({ type: "tool_execution_start", toolCallId: "c1", toolName: "Read" }),
				// A stamped event between start and end drags the end BACKWARDS.
				assistantTurn({ model: "model-b", timestamp: base + 1_000 }),
				JSON.stringify({ type: "tool_execution_end", toolCallId: "c1" }),
			].join("\n"),
		);
		const span = trace?.toolSpans[0];
		expect(span).toBeDefined();
		expect(span?.endTime.getTime()).toBeGreaterThanOrEqual(span?.startTime.getTime() ?? 0);
	});

	test("a normally-ordered stream keeps its real measured duration", () => {
		// The clamp must not flatten legitimate durations to zero.
		const base = 1_785_615_593_072;
		const trace = parseEventStream(
			[
				assistantTurn({ model: "model-a", timestamp: base }),
				assistantTurn({ model: "model-b", timestamp: base + 7_000 }),
			].join("\n"),
		);
		expect(trace?.endTime.getTime()).toBe(base + 7_000);
		expect((trace?.generations[1]?.endTime.getTime() ?? 0) - base).toBe(7_000);
	});
});

describe("a blank-string model does not wipe the attestation (P1)", () => {
	// Round 2 closed the absent-key door and left the blank-string one open:
	// `ident()` returns `""` for `"model": ""`, which is NOT null, so the round-2
	// guard `model !== null` let it through and wiped the attestation. Because
	// `provider` moves with `model`, the trace could then be relabeled with a
	// runner-chosen provider.
	const base = 1_785_615_593_072;

	function attestedThenBlank(blank: string): ReturnType<typeof parseEventStream> {
		const lines: string[] = [];
		for (let i = 0; i < 500; i++) {
			lines.push(assistantTurn({ model: "gpt-5.6-sol", timestamp: base + i }));
		}
		lines.push(assistantTurn({ model: blank, provider: "attacker-chosen", timestamp: base + 500 }));
		return parseEventStream(lines.join("\n"));
	}

	test("THE IMPORTANT ONE: an empty-string model leaves the prior attestation standing", () => {
		const trace = attestedThenBlank("");
		expect(trace?.observedModel).toBe("gpt-5.6-sol");
		// And the provider must not have moved to the blank turn's.
		expect(trace?.provider).toBe("cliproxy");
	});

	test("a whitespace-only model is the same non-attestation", () => {
		const trace = attestedThenBlank("   ");
		expect(trace?.observedModel).toBe("gpt-5.6-sol");
		expect(trace?.provider).toBe("cliproxy");
	});

	test("a blank model on the FIRST turn attests nothing rather than empty string", () => {
		// Guards against the guard being satisfied by a `""` that simply survives:
		// with no prior attestation the result is null (unknown), never `""`.
		const trace = parseEventStream(assistantTurn({ model: "", provider: "prov" }));
		expect(trace?.observedModel).toBeNull();
		expect(trace?.provider).toBeNull();
	});
});

describe("the clock-skew clamp is counted, not silent", () => {
	const base = 1_785_615_593_072;

	test("THE IMPORTANT ONE: descending stamps report a non-zero clamp count", () => {
		// Without the counter a clamped interval and a genuinely instantaneous one
		// both render as zero duration, so broken NTP on a runner is
		// indistinguishable from a fast turn.
		const trace = parseEventStream(
			[
				assistantTurn({ model: "model-a", timestamp: base + 10_000 }),
				assistantTurn({ model: "model-b", timestamp: base + 5_000 }),
				assistantTurn({ model: "model-c", timestamp: base + 1_000 }),
			].join("\n"),
		);
		expect(trace?.clampedTimestamps).toBeGreaterThan(0);
	});

	test("a normally-ordered stream reports zero, so the count is not vacuous", () => {
		const trace = parseEventStream(
			[
				assistantTurn({ model: "model-a", timestamp: base }),
				assistantTurn({ model: "model-b", timestamp: base + 7_000 }),
				assistantTurn({ model: "model-c", timestamp: base + 9_000 }),
			].join("\n"),
		);
		expect(trace?.clampedTimestamps).toBe(0);
	});

	test("the real pilot stream is cleanly ordered", () => {
		expect(parseEventStream(PILOT)?.clampedTimestamps).toBe(0);
	});
});

/**
 * TOKEN COUNTS ARE CARDINALITIES, and a runner writes them.
 *
 * The old finite-only check let `-7` and `1e300` pass straight into Langfuse's
 * usage fields (Sol gauntlet P2, head d0dd7de). A negative count corrupts every
 * aggregate it lands in; a magnitude past `Number.MAX_SAFE_INTEGER` is not even
 * representable as the integer it claims to be. Both are nonsense rather than
 * extreme, so the honest answer is "unknown" — null — not a number an operator
 * would read as measured.
 */
describe("usage token counts are bounded, not merely finite", () => {
	test("THE IMPORTANT ONE: a NEGATIVE count is dropped, not reported", () => {
		const trace = parseEventStream(
			assistantTurn({ usage: { input: -7, output: 5, totalTokens: 15 } }),
		);
		const generation = trace?.generations[0];
		expect(generation).toBeDefined();
		// -7 tokens were not consumed by anything. Null says so; -7 poisons a sum.
		expect(generation?.input).toBeNull();
		// ...and the SIBLING fields on the same turn are untouched, so the guard is
		// per-value and does not discard a whole usage block over one bad number.
		expect(generation?.output).toBe(5);
		expect(generation?.total).toBe(15);
	});

	test("a past-safe-integer magnitude (1e300) is dropped", () => {
		const trace = parseEventStream(
			assistantTurn({ usage: { input: 1e300, output: 1e300, totalTokens: 1e300 } }),
		);
		const generation = trace?.generations[0];
		// Finite, so the old check accepted all three; none is a token count.
		expect(generation?.input).toBeNull();
		expect(generation?.output).toBeNull();
		expect(generation?.total).toBeNull();
	});

	test("NaN-shaped and non-integer values are dropped", () => {
		// JSON has no NaN literal, so a runner reaches the same place with a
		// string, a null, or a fraction — every one a non-count.
		const trace = parseEventStream(
			assistantTurn({
				usage: { input: "NaN", output: null, totalTokens: 12.5, reasoning: 1 / 0 },
			}),
		);
		const generation = trace?.generations[0];
		expect(generation?.input).toBeNull();
		expect(generation?.output).toBeNull();
		expect(generation?.total).toBeNull();
		expect(generation?.reasoning).toBeNull();
	});

	test("ordinary counts, including zero, still pass through unchanged", () => {
		// The anti-vacuity half: a guard that dropped everything would pass all
		// three tests above and report nothing at all.
		const trace = parseEventStream(
			assistantTurn({
				usage: { input: 0, output: 5, totalTokens: 15, reasoning: 2, cacheRead: 1 },
			}),
		);
		const generation = trace?.generations[0];
		expect(generation?.input).toBe(0);
		expect(generation?.output).toBe(5);
		expect(generation?.total).toBe(15);
		expect(generation?.reasoning).toBe(2);
		expect(generation?.cacheRead).toBe(1);
	});
});

/**
 * THE TRACE ENDS WHEN ITS LATEST OBSERVATION DID.
 *
 * The end used to be the LAST stamp written, which on a jittering runner clock
 * is not the latest moment that happened. Stamps of 0s/2s/1s ended the trace at
 * 1s — inside its own observations — so a generation the trace CONTAINS
 * outlived the trace itself and the Langfuse UI drew a run shorter than the
 * work in it (Sol gauntlet P3, head d0dd7de). The `notBefore` clamp did not
 * catch this: 1s is after the 0s start, so nothing looked wrong.
 */
describe("the trace ends at the MAXIMUM stamp, not the last one", () => {
	test("THE IMPORTANT ONE: stamps 0s/2s/1s end the trace at 2s", () => {
		const base = 1_785_615_593_072;
		const trace = parseEventStream(
			[
				assistantTurn({ model: "model-a", timestamp: base }),
				assistantTurn({ model: "model-b", timestamp: base + 2_000 }),
				// LAST written, but not latest. Under the old rule the trace ended here.
				assistantTurn({ model: "model-c", timestamp: base + 1_000 }),
			].join("\n"),
		);
		expect(trace?.startTime.getTime()).toBe(base);
		expect(trace?.endTime.getTime()).toBe(base + 2_000);
	});

	test("the trace contains every observation it holds", () => {
		const base = 1_785_615_593_072;
		const trace = parseEventStream(
			[
				assistantTurn({ model: "model-a", timestamp: base }),
				assistantTurn({ model: "model-b", timestamp: base + 2_000 }),
				assistantTurn({ model: "model-c", timestamp: base + 1_000 }),
			].join("\n"),
		);
		const end = trace?.endTime.getTime() ?? 0;
		// The property the max buys: no child observation may end after its parent.
		for (const generation of trace?.generations ?? []) {
			expect(generation.endTime.getTime()).toBeLessThanOrEqual(end);
		}
	});

	test("the clamp still runs, and the max is what it clamps (both, on one stream)", () => {
		// A stream whose stamps descend BELOW the start, so the round-2 clamp is
		// genuinely load-bearing here rather than dormant: without it the trace end
		// would precede its own start. The max and the clamp must therefore both
		// hold on the same trace — the max picks the latest real moment, the clamp
		// keeps the invariant when there is no such moment after the start.
		const base = 1_785_615_593_072;
		const trace = parseEventStream(
			[
				assistantTurn({ model: "model-a", timestamp: base + 9_000 }),
				assistantTurn({ model: "model-b", timestamp: base + 4_000 }),
				assistantTurn({ model: "model-c", timestamp: base + 1_000 }),
			].join("\n"),
		);
		// The start IS the max here (stamps only descend), so the trace collapses to
		// zero duration rather than going negative...
		expect(trace?.startTime.getTime()).toBe(base + 9_000);
		expect(trace?.endTime.getTime()).toBe(base + 9_000);
		// ...and the clamp is still counted for the two generation ends it caught,
		// so switching the trace end to a max did not quietly stop reporting skew.
		expect(trace?.clampedTimestamps).toBe(2);
	});

	test("an ascending stream is unaffected — the max IS the last stamp", () => {
		const base = 1_785_615_593_072;
		const trace = parseEventStream(
			[
				assistantTurn({ model: "model-a", timestamp: base }),
				assistantTurn({ model: "model-b", timestamp: base + 7_000 }),
			].join("\n"),
		);
		expect(trace?.endTime.getTime()).toBe(base + 7_000);
		expect(trace?.clampedTimestamps).toBe(0);
	});
});

describe("id-less and duplicate tool spans do not collide on one key", () => {
	const base = 1_785_615_593_072;

	/** A tool start/end pair; `id` omitted means the event carries no toolCallId. */
	function toolStart(toolName: string, id?: string, path = "/f"): string {
		return JSON.stringify({
			type: "tool_execution_start",
			...(id === undefined ? {} : { toolCallId: id }),
			toolName,
			args: { path },
		});
	}
	function toolEnd(toolName: string, id?: string): string {
		return JSON.stringify({
			type: "tool_execution_end",
			...(id === undefined ? {} : { toolCallId: id }),
			toolName,
			result: { content: [{ type: "text", text: "ok" }] },
		});
	}

	test("THE IMPORTANT ONE: two id-less spans of the same tool get distinct durations", () => {
		// The defect: both starts keyed on `""`, so the second OVERWROTE the first
		// and the first end closed the survivor. Two concurrent calls reported as
		// one span, and the earlier call's duration was lost outright.
		//
		// Stamps: tool events carry none, so each inherits the preceding assistant
		// turn's stamp. Start A at +0, start B at +1s, end A (closing the MOST
		// RECENT open id-less Read — B) at +5s, end B (closing A) at +9s. So the
		// two spans are 1s->5s and 0s->9s: 4s and 9s, distinct and non-zero.
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Read", undefined, "/a"),
				assistantTurn({ timestamp: base + 1_000 }),
				toolStart("Read", undefined, "/b"),
				assistantTurn({ timestamp: base + 5_000 }),
				toolEnd("Read"),
				assistantTurn({ timestamp: base + 9_000 }),
				toolEnd("Read"),
			].join("\n"),
		);
		expect(trace).not.toBeNull();
		// TWO spans, not one: the second start no longer overwrites the first.
		expect(trace?.toolSpans).toHaveLength(2);
		const durations = trace?.toolSpans
			.map((s) => s.endTime.getTime() - s.startTime.getTime())
			.sort((a, b) => a - b);
		expect(durations).toEqual([4_000, 9_000]);
		// Both starts were matched, so nothing is left resident.
		expect(trace?.unclosedToolSpans).toBe(0);
		// Each span kept its OWN start event's args — the overwrite used to make
		// both spans describe whichever start survived.
		const inputs = trace?.toolSpans.map((s) => s.input).sort();
		expect(inputs?.[0]).toContain("/a");
		expect(inputs?.[1]).toContain("/b");

		// Two UNTERMINATED id-less calls of one tool count as TWO, not one: under
		// the `""` key they collapsed to one entry and the retention signal
		// underreported concurrent unterminated calls.
		const open = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Grep", undefined, "/x"),
				toolStart("Grep", undefined, "/y"),
			].join("\n"),
		);
		expect(open?.unclosedToolSpans).toBe(2);
		expect(open?.toolSpans).toHaveLength(0);
	});

	test("a duplicate toolCallId start does not lose the first span, closed or unclosed", () => {
		// The defect: the second start wrote the SAME map key, dropping the open
		// entry for the first call with no trace of it anywhere.
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Bash", "dup-1", "/first"),
				assistantTurn({ timestamp: base + 2_000 }),
				toolStart("Bash", "dup-1", "/second"),
				assistantTurn({ timestamp: base + 6_000 }),
				toolEnd("Bash", "dup-1"),
				assistantTurn({ timestamp: base + 10_000 }),
				toolEnd("Bash", "dup-1"),
			].join("\n"),
		);
		expect(trace?.toolSpans).toHaveLength(2);
		// BOTH starts survived as their own span, each carrying its own args.
		const inputs = trace?.toolSpans.map((s) => s.input).sort();
		expect(inputs?.[0]).toContain("/first");
		expect(inputs?.[1]).toContain("/second");
		expect(trace?.unclosedToolSpans).toBe(0);

		// The unclosed one is COUNTED, not silently dropped: the overwrite used to
		// hide the first call so `unclosedToolSpans` could not attribute it. Two
		// starts on one id, one end: exactly one span emitted and one left open.
		const unclosed = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Bash", "dup-2", "/first"),
				assistantTurn({ timestamp: base + 2_000 }),
				toolStart("Bash", "dup-2", "/second"),
				assistantTurn({ timestamp: base + 6_000 }),
				toolEnd("Bash", "dup-2"),
			].join("\n"),
		);
		expect(unclosed?.toolSpans).toHaveLength(1);
		expect(unclosed?.unclosedToolSpans).toBe(1);
	});

	test("id-less spans of DIFFERENT tools close against their own tool", () => {
		// The fallback matches on toolName, so an interleaved Read/Bash pair does
		// not cross-close.
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Read", undefined, "/r"),
				assistantTurn({ timestamp: base + 1_000 }),
				toolStart("Bash", undefined, "/b"),
				assistantTurn({ timestamp: base + 4_000 }),
				toolEnd("Read"),
				assistantTurn({ timestamp: base + 8_000 }),
				toolEnd("Bash"),
			].join("\n"),
		);
		expect(trace?.toolSpans).toHaveLength(2);
		const byTool = new Map(
			trace?.toolSpans.map((s) => [
				s.name.split(":")[0],
				s.endTime.getTime() - s.startTime.getTime(),
			]),
		);
		// Read: 0s -> 4s. Bash: 1s -> 8s. Cross-closing would give 3s and 8s.
		expect(byTool.get("Read")).toBe(4_000);
		expect(byTool.get("Bash")).toBe(7_000);
		expect(trace?.unclosedToolSpans).toBe(0);
	});
});

describe("an end resolves only what it identifies", () => {
	const base = 1_785_615_593_072;

	/** A tool start; `id` omitted means the event carries no toolCallId. */
	function toolStart(toolName: string, id?: string, path = "/f"): string {
		return JSON.stringify({
			type: "tool_execution_start",
			...(id === undefined ? {} : { toolCallId: id }),
			toolName,
			args: { path },
		});
	}
	/** A tool end; either field omitted means the event carries it not at all. */
	function toolEnd(toolName?: string, id?: string): string {
		return JSON.stringify({
			type: "tool_execution_end",
			...(id === undefined ? {} : { toolCallId: id }),
			...(toolName === undefined ? {} : { toolName }),
			result: { content: [{ type: "text", text: "ok" }] },
		});
	}

	test("THE IMPORTANT ONE: a duplicate end does not steal a live span of the same tool", () => {
		// The #192 defect: the tool-name fallback ran on any `open.has(id)` miss,
		// which includes an end whose span ALREADY closed — an ordinary retry or a
		// replayed end. The stale duplicate then closed the newest open span of
		// that tool, reporting its own moment against another call's start.
		//
		// SAME TOOL NAME IS LOAD-BEARING. With two different tools the old
		// fallback never crossed and this passes on the broken code, proving
		// nothing. Executed pre-fix: `/b` closed at 6000ms and its real end became
		// a start-less span. Post-fix `/b` keeps its own 7000ms.
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Bash", "call-a", "/a"),
				assistantTurn({ timestamp: base + 1_000 }),
				toolEnd("Bash", "call-a"),
				assistantTurn({ timestamp: base + 1_000 }),
				toolStart("Bash", "call-b", "/b"),
				assistantTurn({ timestamp: base + 7_000 }),
				// The theft: `call-a` is long closed, and `call-b` is open.
				toolEnd("Bash", "call-a"),
				assistantTurn({ timestamp: base + 8_000 }),
				toolEnd("Bash", "call-b"),
			].join("\n"),
		);
		const byPath = new Map(
			trace?.toolSpans.map((s) => [s.name, s.endTime.getTime() - s.startTime.getTime()]),
		);
		// `/b` ran 1s -> 8s. The duplicate closing it reported 6s against `/a`'s end.
		expect(byPath.get("Bash: /b")).toBe(7_000);
		expect(byPath.get("Bash: /a")).toBe(1_000);
		// The stale duplicate identifies nothing, so it reports as start-less.
		expect(trace?.toolSpans).toHaveLength(3);
		expect(byPath.get("Bash:")).toBe(0);
	});

	test("an id-carrying end whose id never started leaves the open spans untouched", () => {
		// A start lost to truncation used to close a live span AND zero the
		// `unclosedToolSpans` retention signal — the one number that says a start
		// went unmatched.
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Bash", "live", "/live"),
				assistantTurn({ timestamp: base + 3_000 }),
				toolEnd("Bash", "never-started"),
			].join("\n"),
		);
		// The live span is STILL OPEN and still counted.
		expect(trace?.unclosedToolSpans).toBe(1);
		// The unmatched end reports start-less, carrying no `/live` args.
		expect(trace?.toolSpans).toHaveLength(1);
		const unmatched = trace?.toolSpans[0];
		expect(unmatched?.name).toBe("Bash:");
		expect((unmatched?.endTime.getTime() ?? 0) - (unmatched?.startTime.getTime() ?? 0)).toBe(0);
	});

	test("a name-less, id-less end closes NOTHING — absent attests nothing", () => {
		// `toolName === null` was a wildcard in the fallback's `||`, matching every
		// open entry, so a name-less end cross-closed the newest span of any tool.
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Bash", undefined, "/b"),
				assistantTurn({ timestamp: base + 3_000 }),
				toolEnd(),
			].join("\n"),
		);
		expect(trace?.unclosedToolSpans).toBe(1);
		expect(trace?.toolSpans).toHaveLength(1);
		// Named "tool", not "Bash": it matched nothing and read no start event.
		expect(trace?.toolSpans[0]?.name).toBe("tool:");
	});

	test("an id-less end still closes the most recent open span of its own tool", () => {
		// The #192 behavior the gate must PRESERVE: absent an id, the tool-name
		// fallback is the only thing that can resolve the end at all.
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Read", undefined, "/a"),
				assistantTurn({ timestamp: base + 1_000 }),
				toolStart("Read", undefined, "/b"),
				assistantTurn({ timestamp: base + 5_000 }),
				toolEnd("Read"),
			].join("\n"),
		);
		// Closed `/b`, the most recent — 1s -> 5s. `/a` stays open.
		expect(trace?.toolSpans).toHaveLength(1);
		const closed = trace?.toolSpans[0];
		expect(closed?.name).toBe("Read: /b");
		expect((closed?.endTime.getTime() ?? 0) - (closed?.startTime.getTime() ?? 0)).toBe(4_000);
		expect(trace?.unclosedToolSpans).toBe(1);
	});

	test("PERF: 20k id-less pairs parse in under 2s, not the quadratic scan", () => {
		// The full-map scan per fallback end is O(open) — id-less pairs inside the
		// 4MB byte cap measured a 4.78s synchronous block in the ingest path (PR
		// #199 review). The stack makes the same shape O(1) per end.
		//
		// 20k PAIRS, NOT MORE. The fixture must stay UNDER `MAX_EVENT_STREAM_BYTES`
		// or `readEvents` refuses the document and returns null — the parse then
		// "passes" in microseconds having done nothing, which is a test that proves
		// the opposite of its name. 20k pairs is ~3.5MB; 25k is over the cap.
		//
		// The bound is deliberately loose: this asserts the COMPLEXITY CLASS
		// changed, not a wall-clock target, so it does not go red on a slow box.
		const lines: string[] = [assistantTurn({ timestamp: base })];
		for (let i = 0; i < 20_000; i += 1) lines.push(toolStart("Bash", undefined, `/p${i}`));
		for (let i = 0; i < 20_000; i += 1) lines.push(toolEnd("Bash"));
		const raw = lines.join("\n");
		// Guard the guard: if this ever crosses the cap the parse becomes a no-op.
		expect(Buffer.byteLength(raw, "utf8")).toBeLessThan(MAX_EVENT_STREAM_BYTES);
		const startedAt = performance.now();
		const trace = parseEventStream(raw);
		const elapsedMs = performance.now() - startedAt;
		expect(trace).not.toBeNull();
		// Every start was matched by exactly one end.
		expect(trace?.unclosedToolSpans).toBe(0);
		expect(elapsedMs).toBeLessThan(2_000);
	});
});

describe("a crafted toolCallId is not key material", () => {
	const base = 1_785_615_593_072;

	/**
	 * A NUL byte, written as an ESCAPE and never as a literal byte in this source.
	 *
	 * A literal NUL in a test file is invisible in every diff and review surface
	 * that renders it, and it does not survive several of the tools that move this
	 * text around — the defect it encodes would be silently deleted from the
	 * regression. The escape is the durable form.
	 */
	const NUL = "\u0000";

	function toolStart(toolName: string, id?: string, path = "/f"): string {
		return JSON.stringify({
			type: "tool_execution_start",
			...(id === undefined ? {} : { toolCallId: id }),
			toolName,
			args: { path },
		});
	}
	function toolEnd(toolName?: string, id?: string): string {
		return JSON.stringify({
			type: "tool_execution_end",
			...(id === undefined ? {} : { toolCallId: id }),
			...(toolName === undefined ? {} : { toolName }),
			result: { content: [{ type: "text", text: "ok" }] },
		});
	}

	test("THE IMPORTANT ONE: a NUL-shaped toolCallId cannot close an id-less span", () => {
		// The round-2 P1. The key for an id-LESS start was the synthetic
		// `<NUL><toolName>#<n>`, namespaced on the claim that "no toolCallId can
		// contain a NUL". That claim was never enforced: NUL is legal inside a JSON
		// string and `str()` does no charset validation, so an end carrying exactly
		// `<NUL>Bash#1` landed on the victim's key and closed a span it never had.
		//
		// Executed pre-fix: the id-less victim reported
		// 6000ms against a forged end, and its own real end degraded to a 0ms
		// start-less span. Post-redesign the forged id names only its own (empty)
		// `byId` chain, so it closes nothing.
		const forged = `${NUL}Bash#1`;
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				// The victim: id-less, so under the old scheme it took key `<NUL>Bash#1`.
				toolStart("Bash", undefined, "/victim"),
				assistantTurn({ timestamp: base + 6_000 }),
				// The forgery: an id-carrying end whose id IS the victim's old key.
				toolEnd("Bash", forged),
				assistantTurn({ timestamp: base + 9_000 }),
				// The victim's own end, id-less, which must be the one that closes it.
				toolEnd("Bash"),
			].join("\n"),
		);
		expect(trace).not.toBeNull();
		const spans = trace?.toolSpans ?? [];
		expect(spans).toHaveLength(2);
		const byName = new Map(spans.map((s) => [s.name, s]));
		// The victim is closed by ITS OWN end: 0s -> 9s, not 6s stolen by the forgery.
		const victim = byName.get("Bash: /victim");
		expect(victim).toBeDefined();
		expect((victim?.endTime.getTime() ?? 0) - (victim?.startTime.getTime() ?? 0)).toBe(9_000);
		// The forged end identifies nothing and reports start-less, exactly like any
		// other end naming an id this stream never started.
		const forgedSpan = byName.get("Bash:");
		expect(forgedSpan).toBeDefined();
		expect((forgedSpan?.endTime.getTime() ?? 0) - (forgedSpan?.startTime.getTime() ?? 0)).toBe(0);
		// Nothing left resident: the victim really was closed, by its own end.
		expect(trace?.unclosedToolSpans).toBe(0);
	});

	test("a NUL-shaped id does not steal an id-less span of ANOTHER tool either", () => {
		// The synthetic keyspace was per tool NAME, so the forgery generalizes: the
		// crafted id spells out whichever tool it wants to reach. A Read victim is
		// reached by `<NUL>Read#1` from an end labelled Bash — the old code read the
		// key off the id alone and never consulted the end's own toolName.
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Read", undefined, "/r"),
				assistantTurn({ timestamp: base + 4_000 }),
				toolEnd("Bash", `${NUL}Read#1`),
			].join("\n"),
		);
		// The Read span is untouched and still counted.
		expect(trace?.unclosedToolSpans).toBe(1);
		expect(trace?.toolSpans).toHaveLength(1);
		expect(trace?.toolSpans[0]?.name).toBe("Bash:");
	});

	test("THE OTHER ONE: five unterminated starts on a `#dup`-shaped id count FIVE", () => {
		// The round-2 P1 collision. A second start on a LIVE id took the key
		// `<id>#dup<n>` and never checked that key was free, so a stream whose ids
		// are literally shaped `Y#dup1` walked onto keys the scheme was about to
		// mint for a start on `Y`.
		//
		// ORDER IS LOAD-BEARING — GET IT WRONG AND THIS PASSES ON THE BROKEN CODE.
		// The crafted ids must arrive FIRST, while `open` does not hold them, so
		// each takes the PLAIN-key branch and parks on `Y#dup1`/`Y#dup2`. Only then
		// do the starts on `Y` mint those same two keys and overwrite them. Feed the
		// crafted id after `Y` is already duplicated and it takes the `#dup` branch
		// instead (`Y#dup1#dup1`), nothing collides, and the test proves nothing.
		// Probed against the 495b891 scheme directly:
		//   /1 Y#dup1 -> "Y#dup1"   /2 Y#dup2 -> "Y#dup2"   /3 Y -> "Y"
		//   /4 Y      -> "Y#dup1" COLLISION
		//   /5 Y      -> "Y#dup2" COLLISION      open.size 3, byName chain 5
		//
		// Two starts vanished with no span AND no unclosed count, and `open` desynced
		// from both indexes. FIVE STARTS, NO ENDS: every one is genuinely
		// unterminated, so the honest count is 5 and no span is emitted at all.
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Bash", "Y#dup1", "/1"),
				toolStart("Bash", "Y#dup2", "/2"),
				toolStart("Bash", "Y", "/3"),
				toolStart("Bash", "Y", "/4"),
				toolStart("Bash", "Y", "/5"),
			].join("\n"),
		);
		expect(trace).not.toBeNull();
		expect(trace?.unclosedToolSpans).toBe(5);
		expect(trace?.toolSpans).toHaveLength(0);

		// A `#dup`-shaped id also closes only its own chain, in strict FIFO. The
		// collision mis-ROUTED closes, not just the count: an end on `Y` could reach
		// a span started under `Y#dup1` and vice versa. Ordinal keying makes each id
		// its own FIFO chain, so `Y`'s ends retire `/1` then `/2` and `Y#dup1`'s end
		// retires `/3` — never across.
		const routed = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Bash", "Y", "/1"),
				assistantTurn({ timestamp: base + 1_000 }),
				toolStart("Bash", "Y", "/2"),
				assistantTurn({ timestamp: base + 2_000 }),
				toolStart("Bash", "Y#dup1", "/3"),
				assistantTurn({ timestamp: base + 5_000 }),
				toolEnd("Bash", "Y#dup1"),
				assistantTurn({ timestamp: base + 7_000 }),
				toolEnd("Bash", "Y"),
				assistantTurn({ timestamp: base + 11_000 }),
				toolEnd("Bash", "Y"),
			].join("\n"),
		);
		expect(routed?.toolSpans).toHaveLength(3);
		const byName = new Map(
			routed?.toolSpans.map((s) => [s.name, s.endTime.getTime() - s.startTime.getTime()]),
		);
		// `/3` started at 2s and closed at 5s on its own id.
		expect(byName.get("Bash: /3")).toBe(3_000);
		// STRICT FIFO on the reused id: 0s->7s for `/1`, then 1s->11s for `/2`. The
		// retired "plain key first" preference gave the same order by accident here;
		// the point is that it is now the rule rather than an artifact of key shape.
		expect(byName.get("Bash: /1")).toBe(7_000);
		expect(byName.get("Bash: /2")).toBe(10_000);
		expect(routed?.unclosedToolSpans).toBe(0);
	});
});

describe("an id-less end cannot drain an id-owned span", () => {
	const base = 1_785_615_593_072;

	function toolStart(toolName: string, id?: string, path = "/f"): string {
		return JSON.stringify({
			type: "tool_execution_start",
			...(id === undefined ? {} : { toolCallId: id }),
			toolName,
			args: { path },
		});
	}
	function toolEnd(toolName?: string, id?: string): string {
		return JSON.stringify({
			type: "tool_execution_end",
			...(id === undefined ? {} : { toolCallId: id }),
			...(toolName === undefined ? {} : { toolName }),
			result: { content: [{ type: "text", text: "ok" }] },
		});
	}

	test("THE IMPORTANT ONE: a MIXED stream keeps id-less and id-owned spans apart", () => {
		// The round-3 P2. `openSpan` indexed EVERY start under its tool name and
		// additionally under its id, so `byName` held a mixed population. An id-less
		// end reads the TAIL of that chain — the most recent open call of the tool —
		// and the most recent one was the ID-CARRYING start. So an end that asserts
		// no identity whatsoever drained a span that had identified itself.
		//
		// MIXED POPULATION ON ONE TOOL NAME IS LOAD-BEARING. Every pre-round-3 test
		// used a purely id-less or purely id-carrying population, where the two
		// indexes never overlap, so all of them pass on the broken code.
		//
		// Executed pre-fix: the id-less end at 6s took `/owned` (the newer entry) and
		// reported 5000ms against it; `call-x`'s own end at 9s then found its own
		// byId chain still populated with... nothing usable, and `/idless-real`
		// closed against the wrong end. Both spans still closed and unclosed stayed
		// 0, so NO SIGNAL IN THE REPORT said the durations had been swapped — which
		// is what makes it a silent-corruption defect rather than a loud one.
		//
		// Post-fix the routing is exclusive: `/idless-real` is the ONLY thing on the
		// name chain, so the id-less end closes it at 0s -> 6s = 6000ms, and
		// `call-x` closes `/owned` on its own chain at 1s -> 9s = 8000ms.
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Bash", undefined, "/idless-real"),
				assistantTurn({ timestamp: base + 1_000 }),
				toolStart("Bash", "call-x", "/owned"),
				assistantTurn({ timestamp: base + 6_000 }),
				// Asserts no identity: it must reach only the id-less start.
				toolEnd("Bash"),
				assistantTurn({ timestamp: base + 9_000 }),
				toolEnd("Bash", "call-x"),
			].join("\n"),
		);
		expect(trace).not.toBeNull();
		expect(trace?.toolSpans).toHaveLength(2);
		const byName = new Map(
			trace?.toolSpans.map((s) => [s.name, s.endTime.getTime() - s.startTime.getTime()]),
		);
		// Pre-fix these were 8000/5000 — the same two numbers, swapped onto the wrong
		// spans. Asserting the PAIRING, not just the multiset, is the whole point.
		expect(byName.get("Bash: /idless-real")).toBe(6_000);
		expect(byName.get("Bash: /owned")).toBe(8_000);
		expect(trace?.unclosedToolSpans).toBe(0);

		// Guard against over-correcting: the exclusive routing must not strand
		// id-owned spans. Same mixed population, every end present.
		const all = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Bash", undefined, "/idless"),
				assistantTurn({ timestamp: base + 1_000 }),
				toolStart("Bash", "call-p", "/p"),
				assistantTurn({ timestamp: base + 2_000 }),
				toolStart("Bash", "call-q", "/q"),
				assistantTurn({ timestamp: base + 6_000 }),
				toolEnd("Bash", "call-q"),
				assistantTurn({ timestamp: base + 7_000 }),
				toolEnd("Bash"),
				assistantTurn({ timestamp: base + 9_000 }),
				toolEnd("Bash", "call-p"),
			].join("\n"),
		);
		expect(all?.toolSpans).toHaveLength(3);
		const allByName = new Map(
			all?.toolSpans.map((s) => [s.name, s.endTime.getTime() - s.startTime.getTime()]),
		);
		expect(allByName.get("Bash: /idless")).toBe(7_000);
		expect(allByName.get("Bash: /p")).toBe(8_000);
		expect(allByName.get("Bash: /q")).toBe(4_000);
		expect(all?.unclosedToolSpans).toBe(0);

		// SCALING SHAPE: pre-fix each id-less end popped the tail of the SHARED name
		// chain, so a burst walked backwards through the id-owned spans. 3 id-less
		// starts, 20 id-owned starts, and 3 id-less ends must close exactly the 3
		// id-less starts (pre-fix: `/owned19`, `/owned18`, `/owned17`).
		const lines: string[] = [assistantTurn({ timestamp: base })];
		for (let i = 0; i < 3; i += 1) lines.push(toolStart("Bash", undefined, `/idless${i}`));
		for (let i = 0; i < 20; i += 1) lines.push(toolStart("Bash", `owned-${i}`, `/owned${i}`));
		lines.push(assistantTurn({ timestamp: base + 5_000 }));
		for (let i = 0; i < 3; i += 1) lines.push(toolEnd("Bash"));
		const burst = parseEventStream(lines.join("\n"));
		expect(burst?.toolSpans).toHaveLength(3);
		expect(burst?.unclosedToolSpans).toBe(20);
		const closed = (burst?.toolSpans.map((s) => s.name) ?? []).sort();
		expect(closed).toEqual(["Bash: /idless0", "Bash: /idless1", "Bash: /idless2"]);
	});

	test("an id-less end finds NOTHING when every open span of that tool carries an id", () => {
		// The confinement stated as its own property, with no id-less start present
		// at all. Pre-fix the id-owned start sat on the name chain too, so the
		// id-less end closed it and `unclosedToolSpans` fell to 0. Post-fix the name
		// chain is empty, the end resolves nothing and reports start-less, and the
		// id-owned span is correctly still counted as unterminated.
		const trace = parseEventStream(
			[
				assistantTurn({ timestamp: base }),
				toolStart("Bash", "call-y", "/owned"),
				assistantTurn({ timestamp: base + 4_000 }),
				toolEnd("Bash"),
			].join("\n"),
		);
		expect(trace?.unclosedToolSpans).toBe(1);
		expect(trace?.toolSpans).toHaveLength(1);
		// Start-less: it read no start event, so it carries no `/owned` args.
		expect(trace?.toolSpans[0]?.name).toBe("Bash:");
		expect(
			(trace?.toolSpans[0]?.endTime.getTime() ?? 0) -
				(trace?.toolSpans[0]?.startTime.getTime() ?? 0),
		).toBe(0);
	});
});
