/**
 * @module tests/actions/lane-trace
 * @description Functional tests for the lane-side live tracer.
 *
 *   The load-bearing properties: an untrusted `usage` block cannot put a
 *   nonsense token count into Langfuse, an unconfigured environment produces a
 *   LOUD no-op rather than a silent one, and neither a credential nor a reply
 *   body can reach a trace field.
 *
 *   PROCESS NOTE, stated rather than hidden: this module's implementation was
 *   written before these tests, inverting the repo's red-first rule. The token
 *   guard below is therefore MUTATION-TESTED in
 *   `scripts/done-means/lane-trace-usage-699.sh` — a clause that has only ever
 *   been observed green is unproven, and that is exactly what writing the test
 *   second produces.
 */
import { describe, expect, test } from "bun:test";
import {
	laneAttemptMetadata,
	laneTokenUsage,
	loadLaneTraceSettings,
} from "../../scripts/actions/lane-trace";

const KEY = "sk-lf-do-not-log-me-4d21";

describe("laneTokenUsage", () => {
	test("reads both OpenAI spellings of the usage block", () => {
		const openai = laneTokenUsage(
			JSON.stringify({
				model: "gpt-5.6-luna",
				usage: { prompt_tokens: 41_234, completion_tokens: 777, total_tokens: 42_011 },
			}),
			// The attestation is a comparison against what the lane asked for, so
			// the requested model has to be supplied for it to attest.
			"gpt-5.6-luna",
		);
		expect(openai.usage).toEqual({ input: 41_234, output: 777, total: 42_011 });
		expect(openai.attestedModel).toBe("gpt-5.6-luna");

		// The responses-API spelling, which the proxy does not normalize.
		const responses = laneTokenUsage(
			JSON.stringify({ usage: { input_tokens: 12, output_tokens: 3, total_tokens: 15 } }),
		);
		expect(responses.usage).toEqual({ input: 12, output: 3, total: 15 });
	});

	// PR #176, Sol gauntlet P2: a bare finite check let `-7` and `1e300` pass
	// straight into Langfuse usage. A token count is a CARDINALITY — negative,
	// fractional, and beyond-safe-integer are nonsense, and the honest reading of
	// nonsense is "unknown", never a clamped number read as measured.
	test("a nonsense token count reads as unknown, never as a number", () => {
		for (const bad of [-7, 1e300, 3.5, Number.NaN, "41234", null]) {
			const got = laneTokenUsage(JSON.stringify({ usage: { prompt_tokens: bad } }));
			expect(got.usage?.input).toBeNull();
		}
		// The control: a legitimate count in the same position IS read, so the
		// clause above cannot be passing merely because nothing is ever read.
		expect(laneTokenUsage(JSON.stringify({ usage: { prompt_tokens: 0 } })).usage?.input).toBe(0);
		expect(laneTokenUsage(JSON.stringify({ usage: { prompt_tokens: 9 } })).usage?.input).toBe(9);
	});

	test("an unparseable or foreign body yields nothing rather than a guess", () => {
		expect(laneTokenUsage("<html>not json</html>")).toEqual({});
		expect(laneTokenUsage("[1,2,3]")).toEqual({});
		expect(laneTokenUsage(JSON.stringify({ choices: [] }))).toEqual({});
	});

	test("the attested model is a COMPARISON, so no proxy string can reach a log", () => {
		// It was bounded, then character-allowlisted. Neither works: `sk-proj-…`,
		// `AKIA…` and `ghp_…` are letters, digits and dashes, so every credential
		// shape passes a shape test (rounds 7 and 8). The value
		// reaches the lane trace AND Langfuse as `attested_model`.
		//
		// So the only string that can ever be emitted is the one this repo asked
		// for. Everything else collapses to the FACT of a mismatch.
		const asked = "gpt-5.6-luna";
		const shape = (model: unknown, requested: string | undefined = asked) =>
			laneTokenUsage(JSON.stringify({ model, usage: { prompt_tokens: 1 } }), requested);

		// The proxy served what was asked: attested, and the string is our own.
		expect(shape(asked).attestedModel).toBe(asked);

		// Anything else is a mismatch, whatever it looks like. Each of these
		// would have passed the character allowlist verbatim.
		for (const hostile of [
			"sk-proj-abc123XYZ",
			"AKIAIOSFODNN7EXAMPLE",
			"ghp_16CharsHere",
			"gpt-4o-mini",
			"tok Bearer sk-SUPERSECRETVALUE",
			"a\nAWS_SECRET_ACCESS_KEY=AKIA",
		]) {
			expect(shape(hostile).attestedModel).toBe("<unattested>");
			expect(JSON.stringify(shape(hostile))).not.toContain(hostile);
		}

		// Absent or unusable attests nothing at all, which callers already read
		// as "the proxy attested nothing".
		expect(shape(undefined).attestedModel).toBeUndefined();
		expect(shape("").attestedModel).toBeUndefined();
		expect(shape(42).attestedModel).toBeUndefined();

		// The token counts are the point of the call and survive every case.
		expect(shape("sk-proj-abc123XYZ").usage?.input).toBe(1);
	});
});

describe("loadLaneTraceSettings", () => {
	test("all three credential fields are required; any blank disables emission", () => {
		const full = {
			LANGFUSE_BASE_URL: "http://langfuse",
			LANGFUSE_PUBLIC_KEY: "pk",
			LANGFUSE_SECRET_KEY: KEY,
		};
		expect(loadLaneTraceSettings(full as NodeJS.ProcessEnv)).not.toBeNull();
		for (const field of Object.keys(full)) {
			const partial = { ...full, [field]: "   " };
			expect(loadLaneTraceSettings(partial as NodeJS.ProcessEnv)).toBeNull();
		}
		expect(loadLaneTraceSettings({} as NodeJS.ProcessEnv)).toBeNull();
	});

	test("the lane identity comes from the environment the step names", () => {
		const settings = loadLaneTraceSettings({
			LANGFUSE_BASE_URL: "http://langfuse",
			LANGFUSE_PUBLIC_KEY: "pk",
			LANGFUSE_SECRET_KEY: KEY,
			LANE: "pr-review",
			REPO: "rodaddy/software-factory",
			PR: "690",
			HEAD_SHA: "abc123",
			RUN_URL: "https://forge.example.internal/run/1",
		} as NodeJS.ProcessEnv);
		expect(settings?.lane).toBe("pr-review");
		expect(settings?.repository).toBe("rodaddy/software-factory");
		expect(settings?.itemNumber).toBe("690");
		expect(settings?.sha).toBe("abc123");
	});

	test("an absent item number is undefined, not the empty string", () => {
		// A `PR=` with nothing after it is what an issue-triage lane passes, and an
		// empty-string tag would render as `item:` in the Langfuse UI.
		const settings = loadLaneTraceSettings({
			LANGFUSE_BASE_URL: "http://langfuse",
			LANGFUSE_PUBLIC_KEY: "pk",
			LANGFUSE_SECRET_KEY: KEY,
			PR: "",
		} as NodeJS.ProcessEnv);
		expect(settings?.itemNumber).toBeUndefined();
	});
});

describe("log level (708c)", () => {
	const creds = {
		LANGFUSE_BASE_URL: "http://langfuse",
		LANGFUSE_PUBLIC_KEY: "pk",
		LANGFUSE_SECRET_KEY: KEY,
	};

	test("the settings carry FACTORY_LOG_LEVEL, absent or unknown = info", () => {
		expect(loadLaneTraceSettings(creds as NodeJS.ProcessEnv)?.logLevel).toBe("info");
		const at = (v: string) =>
			loadLaneTraceSettings({ ...creds, FACTORY_LOG_LEVEL: v } as NodeJS.ProcessEnv)?.logLevel;
		expect(at("debug")).toBe("debug");
		expect(at("verbose")).toBe("info");
	});

	const attempt = {
		attempt: 1,
		attempts: 3,
		requestedModel: "gpt-x",
		requestBytes: 4096,
		startedAt: new Date("2026-09-24T00:00:00.000Z"),
		endedAt: new Date("2026-09-24T00:00:02.500Z"),
		outcome: "ok",
		ok: true,
	};

	test("the attempt metadata names its log level; debug adds size, model and timing detail", () => {
		const info = laneAttemptMetadata(attempt, "info");
		expect(info.log_level).toBe("info");
		expect(info.debug).toBeUndefined();
		const debug = laneAttemptMetadata(attempt, "debug");
		expect(debug.log_level).toBe("debug");
		expect(debug.debug).toEqual({
			request_bytes: 4096,
			requested_model: "gpt-x",
			started_at: "2026-09-24T00:00:00.000Z",
			ended_at: "2026-09-24T00:00:02.500Z",
			duration_ms: 2500,
		});
	});
});
