import { describe, expect, test } from "bun:test";
import {
	type ChangeVerifier,
	type IngestOutcome,
	ingestResult,
	type PersistedResult,
	type ResultReader,
	type ResultStore,
	redactSecrets,
} from "../../src/results/ingest";
import { MAX_RESULT_BYTES, RESULT_VERSION } from "../../src/results/schema";

/** In-memory reader over a fixed DONE flag + result payload. */
function fakeReader(opts: { done: boolean; result?: string | null }): ResultReader {
	return {
		isDone: async () => opts.done,
		readResult: async () => (opts.result === undefined ? null : opts.result),
	};
}

/** Recording store. */
function recordingStore(): ResultStore & { records: PersistedResult[] } {
	const records: PersistedResult[] = [];
	return { records, persist: async (r) => void records.push(r) };
}

/** A verifier that proves every claimed change. Stands in for a real bundle check. */
const acceptingVerifier: ChangeVerifier = { verify: async () => ({ status: "ok" }) };

const validResult = (over: Record<string, unknown> = {}) =>
	JSON.stringify({
		result_version: RESULT_VERSION,
		repository: "rodaddy/x",
		job_type: "pr-review",
		item_number: 7,
		sha: "deadbeef",
		status: "passed",
		checks: [{ name: "lint", status: "pass" }],
		findings: [],
		output_path: "runners/jobs/rw-pr-review-1/host/agent.log",
		...over,
	});

describe("ingestResult", () => {
	test("pending: no DONE yet -> no persistence", async () => {
		const store = recordingStore();
		const out = await ingestResult({
			reader: fakeReader({ done: false }),
			store,
			jobRunnerId: "rw-1",
			hostname: "host",
		});
		expect(out.status).toBe("pending");
		expect(store.records).toEqual([]);
	});

	test("missing: DONE but no result.json -> invalid, operator-visible", async () => {
		const store = recordingStore();
		const out = await ingestResult({
			reader: fakeReader({ done: true, result: null }),
			store,
			jobRunnerId: "rw-1",
			hostname: "host",
		});
		expect(out.status).toBe("missing");
		expect(store.records[0]?.status).toBe("invalid");
		expect(store.records[0]?.reason).toContain("missing");
	});

	test("missing: the reason names the artifact the reader actually sought", async () => {
		// A named-artifact reader sets `resultName`; the missing reason must name THAT
		// file, never a hardcoded result.json.
		const store = recordingStore();
		const reader: ResultReader = {
			isDone: async () => true,
			readResult: async () => null,
			resultName: "watcher-result.json",
		};
		const out = await ingestResult({ reader, store, jobRunnerId: "rw-1", hostname: "host" });
		expect(out.status).toBe("missing");
		expect(store.records[0]?.reason).toBe("DONE present but watcher-result.json is missing");
	});

	test("missing: classifyMissing overrides the generic reason when it returns one", async () => {
		// The agent-lane adapter classifies a missing named artifact from the wrapper
		// verdict; when it yields a reason, ingest records THAT (not the generic one).
		const store = recordingStore();
		const reader: ResultReader = {
			isDone: async () => true,
			readResult: async () => null,
			resultName: "watcher-result.json",
			classifyMissing: async () =>
				"runner agent failed before producing a result: no-credentials — no usable agent credentials",
		};
		const out = await ingestResult({ reader, store, jobRunnerId: "rw-1", hostname: "host" });
		expect(out.status).toBe("missing");
		expect(store.records[0]?.status).toBe("invalid");
		expect(store.records[0]?.reason).toContain("runner agent failed before producing a result");
		expect(store.records[0]?.reason).not.toContain("is missing");
	});

	test("missing: a null classifyMissing falls back to the named generic reason", async () => {
		const store = recordingStore();
		const reader: ResultReader = {
			isDone: async () => true,
			readResult: async () => null,
			resultName: "watcher-result.json",
			classifyMissing: async () => null,
		};
		const out = await ingestResult({ reader, store, jobRunnerId: "rw-1", hostname: "host" });
		expect(out.status).toBe("missing");
		expect(store.records[0]?.reason).toContain("watcher-result.json is missing");
	});

	test("ingested: a valid result validates and persists", async () => {
		const store = recordingStore();
		const out = await ingestResult({
			reader: fakeReader({ done: true, result: validResult() }),
			store,
			jobRunnerId: "rw-1",
			hostname: "host",
		});
		expect(out.status).toBe("ingested");
		if (out.status === "ingested") {
			expect(out.result.repository).toBe("rodaddy/x");
			expect(out.result.status).toBe("passed");
		}
		expect(store.records[0]?.status).toBe("ingested");
		expect(store.records[0]?.outputPath).toContain("agent.log");
	});

	test("trusted store identity rejection is returned as invalid", async () => {
		const out = await ingestResult({
			reader: fakeReader({ done: true, result: validResult() }),
			store: {
				persist: async () => ({
					status: "invalid",
					reason: "runner result identity is invalid",
				}),
			},
			jobRunnerId: "rw-1",
			hostname: "host",
		});
		expect(out).toEqual({ status: "invalid", reason: "runner result identity is invalid" });
	});

	test("malformed JSON fails safe (invalid, no throw)", async () => {
		const store = recordingStore();
		const out = await ingestResult({
			reader: fakeReader({ done: true, result: "{not json" }),
			store,
			jobRunnerId: "rw-1",
			hostname: "host",
		});
		expect(out.status).toBe("invalid");
		expect((out as { reason: string }).reason).toContain("JSON");
		expect(store.records[0]?.status).toBe("invalid");
	});

	test("schema violation fails safe with a bounded reason", async () => {
		const store = recordingStore();
		// wrong version + bad status
		const out = await ingestResult({
			reader: fakeReader({
				done: true,
				result: validResult({ result_version: 99, status: "weird" }),
			}),
			store,
			jobRunnerId: "rw-1",
			hostname: "host",
		});
		expect(out.status).toBe("invalid");
		expect((out as { reason: string }).reason.length).toBeLessThanOrEqual(300);
	});

	test("a wrapper failure envelope is classified, not reported as invalid_union", async () => {
		// When an agent lane never ran, the fleet wrapper mirrors its OWN terminal
		// envelope into result.json ({job_id,lane,status,host,state}, no
		// result_version). This is the exact document observed live on the first
		// pr-review dispatch: the operator must see WHY the agent failed, never a
		// misleading "invalid_union at result_version" that reads as a watcher bug.
		const store = recordingStore();
		const envelope = JSON.stringify({
			job_id: "rw-pr-review-afae0501",
			lane: "default",
			status: 1,
			host: "runner-1",
			state: "no-credentials",
		});
		const out = await ingestResult({
			reader: fakeReader({ done: true, result: envelope }),
			store,
			jobRunnerId: "rw-1",
			hostname: "host",
		});
		expect(out.status).toBe("invalid");
		const reason = (out as { reason: string }).reason;
		expect(reason).toContain("runner agent failed before producing a result: no-credentials");
		expect(reason).not.toContain("invalid_union");
		// Publication stays suppressed: this is classification only, still invalid.
		expect(store.records[0]?.status).toBe("invalid");
		expect(store.records[0]?.result).toBeUndefined();
	});

	test("a genuinely malformed non-envelope result still records the zod summary", async () => {
		// A real result carrying result_version but failing validation is NOT a
		// wrapper envelope, so the zod-summary behavior is unchanged byte-for-byte.
		// The doc deliberately carries a `state` field too: if the detector wrongly
		// accepted it, classifyWrapperFailure would produce a "runner agent failed…"
		// reason from that state — so this test goes red the moment the envelope
		// discrimination breaks (mutation-proven), not merely when classify returns
		// null.
		const store = recordingStore();
		const out = await ingestResult({
			reader: fakeReader({
				done: true,
				result: validResult({ result_version: 99, status: "weird", state: "no-credentials" }),
			}),
			store,
			jobRunnerId: "rw-1",
			hostname: "host",
		});
		expect(out.status).toBe("invalid");
		const reason = (out as { reason: string }).reason;
		expect(reason).not.toContain("runner agent failed before producing a result");
		expect(reason).not.toContain("no-credentials");
		// The zod summary names the issue code and a field path, never a wrapper reason.
		expect(reason).toMatch(/ at /);
	});

	test("unknown extra keys are rejected (strict schema)", async () => {
		const store = recordingStore();
		const out = await ingestResult({
			reader: fakeReader({ done: true, result: validResult({ danger: "rm -rf /" }) }),
			store,
			jobRunnerId: "rw-1",
			hostname: "host",
		});
		expect(out.status).toBe("invalid");
	});

	test("oversized result is rejected without parsing", async () => {
		const store = recordingStore();
		const huge = `{"x":"${"a".repeat(MAX_RESULT_BYTES + 10)}"}`;
		const out = await ingestResult({
			reader: fakeReader({ done: true, result: huge }),
			store,
			jobRunnerId: "rw-1",
			hostname: "host",
		});
		expect(out.status).toBe("invalid");
		expect((out as { reason: string }).reason).toContain("exceeds");
	});

	test("idempotent: re-ingesting the same DONE yields the same outcome", async () => {
		const reader = fakeReader({ done: true, result: validResult() });
		const store = recordingStore();
		const a = await ingestResult({ reader, store, jobRunnerId: "rw-1", hostname: "host" });
		const b = await ingestResult({ reader, store, jobRunnerId: "rw-1", hostname: "host" });
		expect(a.status).toBe("ingested");
		expect(b.status).toBe("ingested");
		expect((a as { result: unknown }).result).toEqual((b as { result: unknown }).result);
	});

	test("secrets in a finding are redacted before persistence", async () => {
		const store = recordingStore();
		const withSecret = validResult({
			findings: [
				{
					severity: "high",
					title: "leaked token ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
					detail: "api_key=supersecretvalue123 in config",
				},
			],
		});
		const out = (await ingestResult({
			reader: fakeReader({ done: true, result: withSecret }),
			store,
			jobRunnerId: "rw-1",
			hostname: "host",
		})) as Extract<IngestOutcome, { status: "ingested" }>;
		expect(out.status).toBe("ingested");
		expect(out.result.findings[0]?.title).toContain("[REDACTED]");
		expect(out.result.findings[0]?.title).not.toContain("ghp_");
		expect(out.result.findings[0]?.detail).toContain("[REDACTED]");
		expect(out.result.findings[0]?.detail).not.toContain("supersecretvalue");
	});

	test("secrets in the v2 change block are redacted before persistence", async () => {
		// bundle_path (1024 chars) and branch (255) are runner-chosen free text, so
		// they get the same treatment as every other persisted runner string. This
		// was the one new field set in schema v2 that redaction skipped.
		const store = recordingStore();
		// bundle_path and branch are mutually exclusive (schema.ts refine), so the
		// patch mode and the push mode are checked separately.
		const withBundle = validResult({
			job_type: "implement-issue",
			change: {
				base_sha: "cafebabecafebabecafebabecafebabecafebabe",
				bundle_path: "out/ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345.bundle",
			},
		});
		const out = (await ingestResult({
			reader: fakeReader({ done: true, result: withBundle }),
			store,
			jobRunnerId: "rw-2",
			hostname: "host",
			changeVerifier: acceptingVerifier,
		})) as Extract<IngestOutcome, { status: "ingested" }>;
		expect(out.status).toBe("ingested");
		expect(out.result.change?.bundle_path).not.toContain("ghp_");
		expect(out.result.change?.bundle_path).toContain("[REDACTED]");

		const withBranch = validResult({
			job_type: "implement-issue",
			change: {
				base_sha: "cafebabecafebabecafebabecafebabecafebabe",
				branch: "rw/issue-1-api_key=supersecretvalue123",
			},
		});
		const out2 = (await ingestResult({
			reader: fakeReader({ done: true, result: withBranch }),
			store,
			jobRunnerId: "rw-3",
			hostname: "host",
			changeVerifier: acceptingVerifier,
		})) as Extract<IngestOutcome, { status: "ingested" }>;
		expect(out2.status).toBe("ingested");
		expect(out2.result.change?.branch).not.toContain("supersecretvalue");
		expect(out2.result.change?.branch).toContain("[REDACTED]");
	});

	/**
	 * The change-verification gate (#65 -> #66). Before this, `result.change` was
	 * never read at ingest: `verifyChangeBundle` had no production caller, so a
	 * claimed change was accepted on the schema's word alone and the job was marked
	 * completed. These pin that a claim is PROVEN before its result is accepted,
	 * and that the gate fails closed in both directions.
	 *
	 * PROVEN TO FAIL: dropping the `result.change !== undefined` guard in
	 * `ingestResult` makes all three of these go green-to-red — the rejected and
	 * no-verifier cases ingest instead of rejecting.
	 */
	const changeResult = () =>
		validResult({
			job_type: "implement-issue",
			change: {
				base_sha: "cafebabecafebabecafebabecafebabecafebabe",
				bundle_path: "change.bundle",
			},
		});

	test("a change the verifier REJECTS makes the whole result invalid", async () => {
		const store = recordingStore();
		const out = await ingestResult({
			reader: fakeReader({ done: true, result: changeResult() }),
			store,
			jobRunnerId: "rw-4",
			hostname: "host",
			changeVerifier: {
				verify: async () => ({ status: "rejected", reason: "bundle is not descended" }),
			},
		});

		expect(out.status).toBe("invalid");
		// The job must NOT be recorded as an accepted result: an unproven change that
		// ingests looks exactly like a proven one to every downstream pass.
		expect(store.records.at(-1)?.status).toBe("invalid");
		expect(store.records.at(-1)?.result).toBeUndefined();
	});

	test("a claimed change with NO verifier configured is refused, never accepted unverified", async () => {
		const store = recordingStore();
		const out = await ingestResult({
			reader: fakeReader({ done: true, result: changeResult() }),
			store,
			jobRunnerId: "rw-5",
			hostname: "host",
		});

		expect(out.status).toBe("invalid");
		expect(store.records.at(-1)?.status).toBe("invalid");
	});

	test("a report-only result never reaches the verifier", async () => {
		// Every non-implement lane carries no change block, so the gate must be inert
		// for them — a verifier fault cannot break ordinary review/audit ingest.
		let called = false;
		const store = recordingStore();
		const out = await ingestResult({
			reader: fakeReader({ done: true, result: validResult() }),
			store,
			jobRunnerId: "rw-6",
			hostname: "host",
			changeVerifier: {
				verify: async () => {
					called = true;
					return { status: "rejected", reason: "should never run" };
				},
			},
		});

		expect(out.status).toBe("ingested");
		expect(called).toBe(false);
	});
});

describe("redactSecrets", () => {
	test("redacts a broad range of real secret shapes", () => {
		for (const s of [
			"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
			"github_pat_11ABCDEFG0abcdefghijkl_MNOPQRSTUVWXYZ",
			"xoxb-1234567890-abcdefghij",
			"AKIAIOSFODNN7EXAMPLE",
			"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcDEF123",
			"Authorization: Bearer abcdef0123456789ABCDEF",
			"postgres://user:s3cr3t@db.internal:5432/app",
			"token: abc123def456",
			"password = hunter2",
		]) {
			expect(redactSecrets(s)).toContain("[REDACTED]");
			expect(redactSecrets(s)).not.toContain("hunter2");
		}
	});

	test("redacts the `Authorization: token <hex>` scheme Forgejo uses", () => {
		// The SPACE-separated `token` scheme, not the `token:` assignment already
		// covered above. This is the shape the runner transport's own stderr
		// carries when a gateway quotes its credential back, and it reached a
		// public forge issue body unredacted: `Bearer` had a pattern and `token`
		// did not. Found by an adversarial review of the sf#692 commit.
		for (const s of [
			"Authorization: token 0123456789abcdef0123456789abcdef01234567",
			"connecting to http://10.0.20.44:8080/mcp Authorization: token 0123456789abcdef0123456789abcdef01234567",
			"-H 'Authorization: token abcdef0123456789ABCDEF0123'",
		]) {
			const out = redactSecrets(s);
			expect(out).toContain("[REDACTED]");
			expect(out).not.toContain("0123456789abcdef");
			expect(out).not.toContain("abcdef0123456789ABCDEF0123");
		}
	});

	test("redacts snake-cased and quoted-JSON secret assignments", () => {
		for (const s of [
			"client_secret=abc123",
			"refresh_token: xyz",
			"GITHUB_TOKEN=someval",
			'"secret": "abc"',
			"redis://:justpass@host:6379",
		]) {
			expect(redactSecrets(s)).toContain("[REDACTED]");
		}
	});

	test("redacts a token glued to a preceding word character", () => {
		// #191: a leading \b never matches when the token abuts a word character,
		// e.g. a runner echoing a concatenated id + token.
		for (const s of [
			"runid12ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
			"xgithub_pat_11ABCDEFG0abcdefghijkl_MNOPQRSTUVWXYZ",
			"prefixxoxb-1234567890-abcdefghij",
			"jobAKIAIOSFODNN7EXAMPLE",
			"abceyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcDEF123",
		]) {
			const out = redactSecrets(s);
			expect(out).toContain("[REDACTED]");
			expect(out).not.toContain("ABCDEFGHIJKLMNOPQRSTUVWXYZ012345");
			expect(out).not.toContain("abcdefghijkl");
			expect(out).not.toContain("1234567890-abcdefghij");
			expect(out).not.toContain("IOSFODNN7EXAMPLE");
			expect(out).not.toContain("abcDEF123");
		}
	});

	test("does NOT over-redact legitimate identifiers containing secret words", () => {
		// the keyword is a prefix of a larger identifier / not the key tail
		expect(redactSecrets("src/auth/token_refresh.ts:42")).toBe("src/auth/token_refresh.ts:42");
		expect(redactSecrets("see getAccessToken() in api_keys.md")).toBe(
			"see getAccessToken() in api_keys.md",
		);
		expect(redactSecrets("secretstuff: unrelated")).toBe("secretstuff: unrelated");
		expect(redactSecrets("nothing secret here")).toBe("nothing secret here");
		// #191 dropped the leading \b on the token-prefix patterns; a plain
		// snake-cased identifier must still survive intact.
		expect(redactSecrets("high_plains_drifter")).toBe("high_plains_drifter");
	});

	test("redacts a token glued to a FOLLOWING word character", () => {
		// #204: the mirror half of #191. A trailing \b plus an EXACT length is
		// defeated by one glued suffix char — the match fails outright and the
		// token is emitted whole. Each case below is `<real token><suffix>`.
		const cases: Array<{ input: string; mustNotContain: string }> = [
			// The AWS ids are the worst case and the ones that actually leaked:
			// length was fixed at 16, so there was no shorter alternative to fall
			// back to when the \b failed. Both a trailing letter and a trailing
			// digit defeat it, so both are pinned.
			{ input: "AKIAIOSFODNN7EXAMPLEz", mustNotContain: "IOSFODNN7EXAMPLE" },
			{ input: "AKIAIOSFODNN7EXAMPLE1", mustNotContain: "IOSFODNN7EXAMPLE" },
			{ input: "ASIAIOSFODNN7EXAMPLEz", mustNotContain: "IOSFODNN7EXAMPLE" },
			// The open-ended patterns absorbed the suffix already; pinned so a
			// future length re-think cannot regress them into the exact-{n} shape.
			{
				input: "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345z",
				mustNotContain: "ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
			},
			{
				input: "github_pat_11ABCDEFG0abcdefghijkl_MNOPQRSTUVWXYZz",
				mustNotContain: "abcdefghijkl",
			},
			{ input: "xoxb-1234567890-abcdefghijz", mustNotContain: "1234567890-abcdefghij" },
			{
				input: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxIn0.abcDEF123z",
				mustNotContain: "abcDEF123",
			},
		];
		for (const { input, mustNotContain } of cases) {
			const out = redactSecrets(input);
			expect(out).toContain("[REDACTED]");
			expect(out).not.toContain(mustNotContain);
		}
	});

	test("leaves no residue when a token is embedded in a longer word run", () => {
		// #204 chose the conservative span: consume the whole word-character run
		// rather than redact a 16-char prefix and leave the rest dangling next to
		// [REDACTED]. Pin that there is no leftover fragment on either side.
		expect(redactSecrets("AKIAIOSFODNN7EXAMPLEZZZZ")).toBe("[REDACTED]");
		// A word boundary still terminates the span: adjacent non-word text is
		// preserved, so redaction cannot run away across a field.
		expect(redactSecrets("key=AKIAIOSFODNN7EXAMPLEz done")).toBe("key=[REDACTED] done");
	});

	test("redacts a bare m2c_ token with no keyword prefix", () => {
		// The lane-0 probe: a bare mcp2cli token passed through unchanged because
		// only the `token `/`token=`/`Bearer` forms had a pattern.
		expect(redactSecrets("leaked m2c_AAAABBBBCCCCDDDDEEEEFFFF here")).toBe(
			"leaked [REDACTED] here",
		);
		// The prefixed form stays redacted.
		const prefixed = redactSecrets("token m2c_AAAABBBBCCCCDDDDEEEEFFFF");
		expect(prefixed).toContain("[REDACTED]");
		expect(prefixed).not.toContain("AAAABBBBCCCCDDDDEEEEFFFF");
		// #204 convention: the word-character tail is consumed, no residue.
		expect(redactSecrets("m2c_AAAABBBBCCCCDDDDEEEEFFFF_tail z")).toBe("[REDACTED] z");
		// A run below the 16-character floor is ordinary text.
		expect(redactSecrets("m2c_short")).toBe("m2c_short");
	});

	test("a bare 40-hex string passes through unchanged (residual exposure)", () => {
		// A Forgejo API token is 40 hex characters, indistinguishable from a git
		// SHA, so no pattern covers it: a regex here would redact every commit id.
		// This pins the RESIDUAL EXPOSURE: a bare Forgejo token echoed by a runner
		// is NOT redacted. The control must keep the token out of runner-visible
		// text, and that is open under T21 (see the SECRET_PATTERNS note).
		const sha = "0123456789abcdef0123456789abcdef01234567";
		expect(redactSecrets(sha)).toBe(sha);
		expect(redactSecrets(`forgejo ${sha}`)).toBe(`forgejo ${sha}`);
	});

	test("redaction is idempotent (publish-decode's isSafeText depends on it)", () => {
		// A guard in publish-decode re-runs redaction and compares; if a second
		// pass changed the text, that guard would reject already-safe output.
		for (const s of [
			"AKIAIOSFODNN7EXAMPLEz",
			"postgres://user:s3cr3t@db.internal:5432/app",
			"ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345",
			"redis://:justpass@host:6379",
		]) {
			const once = redactSecrets(s);
			expect(redactSecrets(once)).toBe(once);
		}
	});

	const timeOf = (input: string): number => {
		// Best-of-N: a scheduler preemption can only ever make a sample
		// SLOWER, so the minimum is the sample least polluted by contention.
		let best = Number.POSITIVE_INFINITY;
		for (let i = 0; i < 5; i++) {
			const start = Bun.nanoseconds();
			redactSecrets(input);
			best = Math.min(best, Bun.nanoseconds() - start);
		}
		return best;
	};
	// sf#852: an 8x step, not a doubling. A doubling predicts 2x linear and 4x
	// quadratic, so the old bound of 3 left 1.5x headroom and a loaded runner
	// failed it once with the code correct. An 8x step predicts ~8x linear and
	// ~64x quadratic; LINEAR_BOUND = 24 leaves 3x headroom for noise on the
	// linear side and still sits well under the quadratic signal.
	const GROWTH_STEP = 8;
	const LINEAR_BOUND = 24;
	const growthRatio = (build: (n: number) => string, base = 20000): number => {
		// Warm the JIT so the first measurement is not paying compile cost.
		timeOf(build(Math.floor(base / 4)));
		return timeOf(build(base * GROWTH_STEP)) / timeOf(build(base));
	};

	test("is linear-time on adversarial keyword-dense input (no catastrophic backtracking)", () => {
		// a maxed field with no delimiter must not stall. RATIO, not wall-clock:
		// the 200ms absolute bound this replaced failed under 8-lane CPU contention
		// with the code correct. Linear predicts ~8x for the 8x step;
		// quadratic ~64x (same calibration as the test below).
		const adversarialBuild = (n: number) => `${"a.b_c-".repeat(Math.ceil(n / 6))}secret`;
		// 10x sizes so samples are milliseconds, not scheduler noise (sf#317 reopen: ratio 3.53 observed on a runner at the old sizes while the same suite's check phase passed).
		expect(growthRatio(adversarialBuild, 200_000)).toBeLessThan(LINEAR_BOUND);
	});

	test("is linear-time on input that ENTERS both URL basic-auth passes", () => {
		// #205: the first fixture leads with `http://`, then presents the dotted
		// run that used to force an O(n^2) re-scan from every start position. The
		// second scales real bounded and oversized userinfo together, so both the
		// fast path and the fail-closed oversized path do proportional work.
		//
		// The assertion is a GROWTH RATIO, not wall-clock. Absolute timings are
		// unusable here: this suite runs under parallel lanes contending for CPU,
		// so any fixed millisecond budget is either flaky or so loose it proves
		// nothing. A ratio cancels a constant slowdown factor — if the whole box
		// is 5x slower, both measurements are 5x slower and the ratio holds.
		const adversarialBuild = (n: number) => `http://${"a.b-c".repeat(n / 5)}`;
		const oversizedCredential = "p".repeat(512);
		const urlPair = `http://u:shortpass@h http://u:${oversizedCredential}@h `;
		const oversizedBuild = (n: number) => urlPair.repeat(Math.ceil(n / urlPair.length));
		const oversizedOutput = redactSecrets(oversizedBuild(5000));
		expect(oversizedOutput).not.toContain("shortpass");
		expect(oversizedOutput).not.toContain(oversizedCredential);

		// Linear predicts ~8x for the 8x step; quadratic ~64x. The old pattern
		// measured 4.2x per doubling (89.1ms -> 372.2ms), ~74x over an 8x step.
		expect(growthRatio(adversarialBuild)).toBeLessThan(LINEAR_BOUND);
		expect(growthRatio(oversizedBuild)).toBeLessThan(LINEAR_BOUND);
	});

	test("redacts URL basic-auth credentials at the 256-character boundary", () => {
		const credential = "p".repeat(256);
		expect(redactSecrets(`postgres://user:${credential}@db.internal:5432/app`)).toBe(
			"[REDACTED]db.internal:5432/app",
		);
	});

	test("redacts an oversized URL basic-auth credential just past the bound and at twice it", () => {
		for (const length of [257, 512]) {
			const credential = "p".repeat(length);
			expect(redactSecrets(`postgres://user:${credential}@db.internal:5432/app`)).toBe(
				"[REDACTED]db.internal:5432/app",
			);
		}
	});

	test("redacts the whole oversized URL credential when a suffix is glued to the bound", () => {
		const credential = `${"p".repeat(256)}GLUED_SUFFIX`;
		expect(redactSecrets(`postgres://user:${credential}@db.internal:5432/app`)).toBe(
			"[REDACTED]db.internal:5432/app",
		);
	});

	test("still redacts URL basic-auth credentials after the #205 bound", () => {
		// The perf fix bounds the scheme; prove it did not narrow what matches.
		expect(redactSecrets("postgres://user:s3cr3t@db.internal:5432/app")).not.toContain("s3cr3t");
		expect(redactSecrets("redis://:justpass@host:6379")).not.toContain("justpass");
		// A `+` in the scheme is still accepted by the bounded scheme class. Only
		// the credential span is replaced — the host deliberately survives, which
		// is the pre-existing behavior this fix must not change.
		expect(redactSecrets("mongodb+srv://u:secretpw@cluster.example.net/db")).toBe(
			"[REDACTED]cluster.example.net/db",
		);
		// A URL with no credentials is untouched.
		expect(redactSecrets("http://nocreds.example.com/x")).toBe("http://nocreds.example.com/x");
	});
});
