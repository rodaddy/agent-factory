/**
 * The PRODUCER half of the event-stream contract.
 *
 * `EVENT_STREAM_PATH` was declared, documented, and consumed — and referenced by
 * no template body, so no lane agent was ever told to write the stream. Zero
 * `events.jsonl` files across 214 attempt dirs in two days, zero Langfuse traces,
 * and an empty `observed_model` on every attempt.
 *
 * THE #211 LESSON IS WHAT SHAPES THIS FILE. A schema-only assertion proves the
 * instruction is present, never that it is CORRECT. So the fixtures below are
 * derived from the INSTRUCTION TEXT the template renders, and are parsed by the
 * REAL reader (`src/observability/event-stream.ts`) — the same function ingest
 * calls. A drift between what the template tells an agent to write and what the
 * reader can parse reddens here rather than on a runner box.
 *
 * Rule 18: `parsesThroughRealReader` is exercised on TWO fixtures with different
 * derivations — one built field-by-field from the instruction's stated shape, and
 * one built by extracting the literal JSON example the template renders. A test
 * that only drove the hand-built fixture would survive the template's example
 * being wrong, which is precisely the byte an agent copies.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEventStream } from "../../src/observability/event-stream";
import { EVENT_STREAM_NAME, EVENT_STREAM_PATH } from "../../src/templates/agent-lane";
import {
	eventStreamInstruction,
	IMPLEMENT_TEMPLATE_ID,
	renderJobBody,
} from "../../src/templates/registry";

/** The three agent lanes, each of which must instruct the producer. */
const AGENT_LANES = ["pr-review", "issue-triage", IMPLEMENT_TEMPLATE_ID] as const;

/** Bounded metadata every lane body renders from. */
const CTX = { repository: "rodaddy/x", itemNumber: 42, sha: "cafebabe" } as const;

/** The rendered body for one lane, failing loudly rather than yielding null. */
function bodyOf(lane: string): string {
	const body = renderJobBody(lane, CTX);
	if (body === null) throw new Error(`lane ${lane} rendered no body`);
	return body;
}

/**
 * The fenced JSON example the template renders for the event stream, extracted
 * from the body as an agent would copy it. Returns every fenced-block line that
 * parses as a JSON object carrying a `type`, so the extraction follows the
 * template's own rendering rather than a fixed line offset.
 */
function instructedExampleLines(body: string): string[] {
	const lines: string[] = [];
	for (const line of body.split("\n")) {
		const trimmed = line.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (typeof parsed === "object" && parsed !== null && "type" in parsed) lines.push(trimmed);
		} catch {
			// Not a JSON line: ordinary prose. The template renders both.
		}
	}
	return lines;
}

describe("every agent-lane body instructs the event-stream producer", () => {
	test("names EVENT_STREAM_PATH verbatim, from the constant", () => {
		// VERBATIM from the constant, not a re-spelled literal: this is the #211
		// lesson. A body that says `/work/out/events.json` or `$SHARE/events.jsonl`
		// reads as correct and produces a stream the reconciler never copies out.
		for (const lane of AGENT_LANES) {
			expect(bodyOf(lane)).toContain(EVENT_STREAM_PATH);
		}
	});

	test("instructs JSONL append semantics, not a single JSON document", () => {
		// The reader splits on newlines and parses each line independently. An agent
		// told to "write a JSON file" produces one array — `readEvents` finds no
		// object carrying `type` and the whole stream is a null summary.
		for (const lane of AGENT_LANES) {
			const body = bodyOf(lane);
			expect(body).toContain("one JSON object per line");
			expect(body).toContain("APPEND");
		}
	});

	test("names the message_end attestation event the ticket requires", () => {
		// `observed_model` comes ONLY from `message_end.message.model` on an
		// assistant turn. An instruction that omits this event stamps nothing, which
		// is the empty-attestation half of the defect.
		//
		// Asserted as the KEY PATH the reader walks, not as free prose: the reader
		// reads `message.role === "assistant"` and `message.model`, so an example
		// naming `message_end` while nesting the model anywhere else attests nothing.
		for (const lane of AGENT_LANES) {
			const body = bodyOf(lane);
			expect(body).toContain('"type":"message_end"');
			expect(body).toContain('"role":"assistant"');
			expect(body).toContain('"model":');
			// And the two tool events, whose pairing is what produces a span.
			expect(body).toContain('"type":"tool_execution_start"');
			expect(body).toContain('"type":"tool_execution_end"');
		}
	});

	test("does not tell the lane the stream is a control input", () => {
		// Runner output stays UNTRUSTED. The instruction must not imply that writing
		// (or not writing) the stream changes ingest, publication, or job state — an
		// agent that believes the stream gates its result has an incentive to shape
		// it, and nothing downstream reads it as a control.
		for (const lane of AGENT_LANES) {
			const body = bodyOf(lane);
			expect(body).toContain("never a control input");
		}
	});
});

describe("the instructed shape parses through the REAL reader", () => {
	/**
	 * DERIVATION 1 — built field-by-field from the instruction's stated shape.
	 * Every key here is one the template names in prose; nothing is copied from
	 * the reader's source, so the reader disagreeing with the instruction reddens.
	 */
	function handBuiltStream(): string {
		const at = Date.parse("2026-08-05T01:00:00.000Z");
		return [
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					model: "gpt-5.6-sol",
					provider: "cliproxy",
					api: "openai-completions",
					stopReason: "toolUse",
					usage: { input: 1527, output: 82, totalTokens: 1609 },
					content: [{ type: "text", text: "planning the change" }],
					timestamp: at,
				},
			}),
			JSON.stringify({
				type: "tool_execution_start",
				toolName: "read",
				toolCallId: "call_1",
				args: { path: "/work/repo/src/index.ts" },
			}),
			JSON.stringify({
				type: "tool_execution_end",
				toolName: "read",
				toolCallId: "call_1",
				result: { content: [{ type: "text", text: "file contents" }] },
			}),
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					model: "gpt-5.6-sol",
					provider: "cliproxy",
					usage: { input: 1600, output: 40, totalTokens: 1640 },
					content: [{ type: "text", text: "done" }],
					timestamp: at + 4000,
				},
			}),
		].join("\n");
	}

	test("derivation 1: a hand-built stream yields the attestation ingest stamps", () => {
		const trace = parseEventStream(handBuiltStream(), Date.parse("2026-08-05T02:00:00.000Z"));
		expect(trace).not.toBeNull();
		if (trace === null) return;
		// The attestation input — the thing `observed_model` is stamped from.
		expect(trace.observedModel).toBe("gpt-5.6-sol");
		expect(trace.provider).toBe("cliproxy");
		// The trace inputs — two assistant turns and one folded tool span.
		expect(trace.generations.length).toBe(2);
		expect(trace.toolSpans.length).toBe(1);
		expect(trace.eventCount).toBe(4);
		// The pair MATCHED: an instructed shape whose ids do not round-trip leaves
		// the span open, which is how a wrong `toolCallId` spelling would show.
		expect(trace.unclosedToolSpans).toBe(0);
	});

	test("derivation 2: the template's own rendered JSON example parses too", () => {
		// A DIFFERENT DERIVATION (rule 18): these bytes are extracted from the
		// rendered body, so this clause survives the hand-built fixture being right
		// while the example an agent actually copies is wrong.
		for (const lane of AGENT_LANES) {
			const lines = instructedExampleLines(bodyOf(lane));
			expect(lines.length).toBeGreaterThan(0);
			const trace = parseEventStream(lines.join("\n"), Date.parse("2030-01-01T00:00:00.000Z"));
			expect(trace).not.toBeNull();
			if (trace === null) continue;
			// The example must carry a real attestation, not a shape with no model:
			// an example an agent copies verbatim that attests nothing reproduces the
			// exact empty-`observed_model` defect this ticket exists to fix.
			expect(trace.observedModel).not.toBeNull();
			expect(trace.generations.length).toBeGreaterThan(0);
		}
	});

	test("the packet lane's AUTHORED copy is drift-pinned to the TS instruction", () => {
		// issue-triage owns its whole body in `packets/issue-triage.md`, so
		// its producer clause is AUTHORED text, not rendered from the TS builder.
		// Two copies of one contract drift silently — and the drift is invisible,
		// because both lanes still render a plausible-looking instruction. The pin
		// is the mechanism: the packet must contain the TS clause byte-for-byte.
		const packet = readFileSync(
			join(import.meta.dir, "..", "..", "packets", "issue-triage.md"),
			"utf8",
		);
		// The builder's leading "" is a body separator, not clause content.
		const clause = eventStreamInstruction().slice(1).join("\n");
		expect(clause.length).toBeGreaterThan(0);
		expect(packet).toContain(clause);
	});

	test("the artifact name in the instruction is the one reconcile copies out", () => {
		// The consumer half is unchanged by #219 and is keyed on EVENT_STREAM_NAME
		// (`src/results/reconcile.ts`). The path the template states must end in
		// exactly that name or the produced file is never read.
		expect(EVENT_STREAM_PATH.endsWith(`/${EVENT_STREAM_NAME}`)).toBe(true);
		for (const lane of AGENT_LANES) {
			expect(bodyOf(lane)).toContain(EVENT_STREAM_NAME);
		}
	});
});
