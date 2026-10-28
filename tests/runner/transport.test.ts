import { describe, expect, test } from "bun:test";
import {
	hasErrorPayload,
	isContractRejection,
	isRefusal,
	isTransportFault,
	Mcp2cliRunnerTransport,
	parseBoxes,
	parsePlacedBoxes,
	RUNNER_FORGE_UP_TIMEOUT_MS,
	RUNNER_STOP_TIMEOUT_MS,
	RunnerAllocationUnknownError,
	RunnerBandRefusedError,
	runnerBoxArgv,
	runnerDoneArgs,
} from "../../src/runner/transport";

/**
 * A transport whose `invoke` is scripted per attempt, so the readiness-retry
 * loop can be driven deterministically without spawning a real process. Each
 * queued reply is one `runner_run` result; `sleep` is a no-op that records the
 * requested delays so a test can assert the loop waited between attempts.
 */
class ScriptedTransport extends Mcp2cliRunnerTransport {
	readonly slept: number[] = [];
	invokeCalls = 0;
	constructor(
		private readonly replies: Array<{ code: number; stdout: string; stderr?: string }>,
		attempts: number,
	) {
		super("mcp2cli", 90_000, {
			runReadyAttempts: attempts,
			runReadyDelayMs: 5,
			sleep: async (ms) => {
				this.slept.push(ms);
			},
		});
	}
	protected async invoke(): Promise<{ code: number; stdout: string; stderr: string }> {
		const reply = this.replies[this.invokeCalls] ?? { code: 1, stdout: "" };
		this.invokeCalls += 1;
		return { code: reply.code, stdout: reply.stdout, stderr: reply.stderr ?? "" };
	}
}

const OK = { code: 0, stdout: "started vmid=9001 job=j\n" };
const FAIL = { code: 1, stdout: "" };
/** The reviewed route every run() carries: the v2 server REQUIRES it. */
const ROUTE = {
	model: "gpt-5.6-luna",
	effort: "max",
	engineEndpoint: {
		baseUrl: "https://codex-proxy.example.internal",
		authHeaderName: "Authorization",
	},
} as const;
const RUN = { vmid: 9001, jobId: "j", job: "body", ...ROUTE };

describe("parseBoxes", () => {
	test("parses a JSON array of boxes", () => {
		const out = parseBoxes('[{"vmid": 9001, "host": "px05"}, {"vmid": 9002}]', "small");
		expect(out.map((b) => b.vmid)).toEqual([9001, 9002]);
		expect(out[0]?.host).toBe("px05");
		expect(out[0]?.size).toBe("small");
	});

	test("parses a single JSON object", () => {
		const out = parseBoxes('{"vmid": 9003}', "medium");
		expect(out).toEqual([{ vmid: 9003, size: "medium", host: undefined }]);
	});

	test("falls back to line parsing with pool-range vmids", () => {
		const out = parseBoxes("9004 node05 10.0.21.4 small\n9005 node04 10.0.21.5 small", "small");
		expect(out.map((b) => b.vmid)).toEqual([9004, 9005]);
	});

	test("prefers an explicit vmid label over other integers on the line", () => {
		const out = parseBoxes("template 9900 -> vmid=9001 host pve-02 port 8080", "small");
		expect(out.map((b) => b.vmid)).toEqual([9001]);
	});

	test("ignores the template id 9900 and out-of-pool integers in line form", () => {
		// 9900 is the template (not allocatable); 8080/2026 are not pool vmids.
		const out = parseBoxes("port 8080 year 2026 template 9900 box 9003", "small");
		expect(out.map((b) => b.vmid)).toEqual([9003]);
	});

	test("does not pick an IP octet as a vmid", () => {
		const out = parseBoxes("192.168.1.100 allocated 9007", "small");
		expect(out.map((b) => b.vmid)).toEqual([9007]);
	});

	test("membership-checks even a vmid-labeled token (rejects template 9900 / unknown)", () => {
		// a `vmid=` label on the non-allocatable template or an id absent from the
		// inventory must not be trusted from unstructured line output.
		expect(parseBoxes("vmid=9900 template", "small")).toEqual([]);
		expect(parseBoxes("vmid=12345 bogus", "small")).toEqual([]);
		expect(parseBoxes("vmid=9002 ok", "small").map((b) => b.vmid)).toEqual([9002]);
	});

	test("ignores an in-range count preceding the real vmid only when unlabeled-ambiguous", () => {
		// a labeled vmid is authoritative even if another in-range integer leads.
		expect(parseBoxes("9010 queued vmid=9005", "small").map((b) => b.vmid)).toEqual([9005]);
	});

	test("returns empty for blank output", () => {
		expect(parseBoxes("   ", "small")).toEqual([]);
	});

	test("drops out-of-pool vmids on the JSON path (template 9900 / above the pool)", () => {
		// The JSON path applies the SAME pool-range guard as the line fallback, so a
		// structured but out-of-pool vmid — the non-allocatable template 9900, or an
		// id above the pool ceiling — is never surfaced as a box.
		expect(parseBoxes('[{"vmid": 9900}, {"vmid": 12345}]', "small")).toEqual([]);
		// A mix keeps only the in-pool entries.
		expect(
			parseBoxes('[{"vmid": 9900}, {"vmid": 9001}, {"vmid": 99999}]', "small").map((b) => b.vmid),
		).toEqual([9001]);
		// A single out-of-pool object yields no box (and does not fall through to a
		// bogus line parse of the JSON text).
		expect(parseBoxes('{"vmid": 9900}', "small")).toEqual([]);
	});

	test("never line-parses valid JSON after all explicit vmids are filtered", () => {
		// `count` deliberately holds 9042 — a REAL pool vmid. If the JSON path ever fell
		// through to a line scan, that value would surface as a box, so this asserts the
		// raw JSON text is never line-parsed. (Previously 9001, which was outside the
		// old pool and therefore proved nothing once the band moved.)
		expect(parseBoxes('{"vmid":9900,"count":9042}', "small")).toEqual([]);
		expect(parseBoxes('[{"vmid":9900},{"vmid":9999}]', "small")).toEqual([]);
	});

	test("keeps non-JSON line-form parsing unchanged", () => {
		// Same trap on the line path: the labeled vmid must win over a following real
		// pool vmid in an unrelated field.
		expect(parseBoxes("allocated vmid=9006 count=9042", "small")).toEqual([
			{ vmid: 9006, size: "small" },
		]);
	});

	test("returns one box when destroy chatter precedes the labeled line", () => {
		// The `needed` verb's stdout carried `pct destroy` chatter naming the same CT
		// ahead of the labeled line; the bare-number fallback then emitted it twice.
		const out = parseBoxes(
			"purging CT 118 from related configurations..\nvmid=9001 host=node05 ip=10.0.21.1 mac=BC:24:11:90:00:01 size=small job=rw-repo-validate-e663dc73",
			"small",
		);
		expect(out.map((b) => b.vmid)).toEqual([9001]);
	});

	test("dedupes a vmid named on two labeled lines", () => {
		expect(parseBoxes("vmid=9002 first\nvmid=9002 again", "small").map((b) => b.vmid)).toEqual([
			9002,
		]);
	});

	test("keeps every DISTINCT labeled box for a multi-box allocation", () => {
		// `needed` accepts count > 1 and prints one labeled line per box; dedupe must
		// collapse only repeats, never distinct vmids.
		expect(
			parseBoxes("vmid=9001 host=node05\nvmid=9002 host=node06", "small").map((b) => b.vmid),
		).toEqual([9001, 9002]);
	});

	test("an out-of-pool label does not suppress the bare fallback (no in-pool labeled line)", () => {
		// Only an IN-POOL labeled line is the verb's contract; a labeled template id is
		// rejected and the bare fallback still finds the real box.
		expect(parseBoxes("vmid=9900 template\n9001 queued", "small").map((b) => b.vmid)).toEqual([
			9001,
		]);
	});

	test("does not run the pooled fallback when a labeled line is present", () => {
		expect(parseBoxes("9003 queued\nvmid=9004 host=node05", "small").map((b) => b.vmid)).toEqual([
			9004,
		]);
	});

	test("unwraps the real mcp2cli success envelope and line-parses its inner stdout", () => {
		// This is the byte format the production `mcp2cli runner-boxes runner_needed`
		// actually emits: the box line lives INSIDE result.stdout as a string. The
		// envelope must be unwrapped — not surfaced as zero boxes, and never
		// line-scanned as raw JSON text.
		const envelope = JSON.stringify({
			success: true,
			result: {
				ok: true,
				exit_code: 0,
				stdout: "vmid=9020 host=node05 ip=10.0.20.147 mac=BC:24:11:99:00:20 size=small job=rw-x\n",
				stderr: "",
				cmd: "runner-boxes needed --size small --count 1 --job-id rw-x",
			},
		});
		expect(parseBoxes(envelope, "small")).toEqual([{ vmid: 9020, size: "small" }]);
	});

	test("a failed or malformed envelope yields no boxes (no mining of failure text)", () => {
		// A transport-fault envelope: success flag absent, error true.
		expect(
			parseBoxes('{"error":true,"code":"CONNECTION_ERROR","message":"timed out 9001"}', "small"),
		).toEqual([]);
		// A verb failure: success false, inner stdout mentioning an in-range number.
		expect(
			parseBoxes('{"success":false,"result":{"ok":false,"stdout":"no slot near 9001"}}', "small"),
		).toEqual([]);
		// An inner ok=false is a failure even under success=true.
		expect(
			parseBoxes('{"success":true,"result":{"ok":false,"stdout":"vmid=9001"}}', "small"),
		).toEqual([]);
		// The inner stdout still passes through the pool-range guard.
		expect(
			parseBoxes('{"success":true,"result":{"ok":true,"stdout":"vmid=9900"}}', "small"),
		).toEqual([]);
	});
});

describe("parsePlacedBoxes", () => {
	// A capacity refusal is reported as the REAL mcp2cli envelope
	// `{success:true,result:{ok:false,stdout:"...vmid=..."}}`: the partial boxes
	// live INSIDE result.stdout even though the inner ok is false. parsePlacedBoxes
	// must unwrap that inner stdout REGARDLESS of ok and then apply the same
	// pool-range guard, or the placed boxes are stranded.
	test("mines placed in-pool vmids from the REAL ok:false refusal envelope", () => {
		const refusalEnvelope = JSON.stringify({
			success: true,
			result: { ok: false, stdout: "REFUSED: no capacity\nvmid=9001 host=px05", stderr: "" },
		});
		expect(parsePlacedBoxes(refusalEnvelope, "small")).toEqual([{ vmid: 9001, size: "small" }]);
	});

	test("excludes an out-of-pool / template 9900 id inside the refusal envelope", () => {
		const refusalEnvelope = JSON.stringify({
			success: true,
			result: {
				ok: false,
				stdout: "REFUSED\nvmid=9001 host=px05\nvmid=9900 template\nvmid=12345 bogus",
				stderr: "",
			},
		});
		expect(parsePlacedBoxes(refusalEnvelope, "small").map((b) => b.vmid)).toEqual([9001]);
	});

	test("still parses a bare (non-enveloped) refusal stdout", () => {
		expect(parsePlacedBoxes("placed vmid=9003 host=px06\n", "small").map((b) => b.vmid)).toEqual([
			9003,
		]);
	});

	test("yields nothing for a genuinely empty allocation", () => {
		expect(parsePlacedBoxes("no boxes here\n", "small")).toEqual([]);
		expect(parsePlacedBoxes("   ", "small")).toEqual([]);
		expect(
			parsePlacedBoxes(
				JSON.stringify({ success: true, result: { ok: true, stdout: "no boxes", stderr: "" } }),
				"small",
			),
		).toEqual([]);
	});

	test("the SUCCESS parse path (parseBoxes) is unchanged: ok-gated, ok:false stays empty", () => {
		// The success allocation path must NOT be loosened: parseBoxes still drops an
		// ok:false envelope so a failed verb result is never surfaced as a valid box
		// list for a SUCCESSFUL allocation.
		const refusalEnvelope = JSON.stringify({
			success: true,
			result: { ok: false, stdout: "vmid=9001", stderr: "" },
		});
		expect(parseBoxes(refusalEnvelope, "small")).toEqual([]);
		// And a real SUCCESS envelope still surfaces its box exactly as before.
		const successEnvelope = JSON.stringify({
			success: true,
			result: { ok: true, stdout: "vmid=9021 host=px05", stderr: "" },
		});
		expect(parseBoxes(successEnvelope, "small")).toEqual([{ vmid: 9021, size: "small" }]);
	});
});

describe("isRefusal", () => {
	test("matches common capacity-refusal phrasings", () => {
		for (const text of [
			"runner pool exhausted",
			"request refused: no free slot",
			"pool at capacity",
			"pool is full",
			"0 available runners",
			"all runners busy",
			"fully utilized",
		]) {
			expect(isRefusal(text)).toBe(true);
		}
	});

	test("does not misclassify a success message that mentions capacity", () => {
		expect(isRefusal("allocated box 9001; pool capacity: 24")).toBe(false);
		expect(isRefusal("runner_needed ok, 3 boxes available")).toBe(false);
	});

	test("a contract rejection is NOT a capacity refusal", () => {
		// The two are separate classifications on purpose: a capacity refusal on the
		// allocation path is reported as "runner capacity unavailable", and labelling
		// an unknown runtime that way would send an operator to check pool depth.
		expect(isRefusal("runtime must be claude|codex, got: pi")).toBe(false);
		expect(isRefusal("unknown-runtime: pi")).toBe(false);
	});
});

describe("isContractRejection", () => {
	test("matches the live verb's runtime-rejection phrasings", () => {
		for (const text of [
			"runtime must be claude|codex, got: pi",
			"ERROR: runtime must be claude|codex",
			"unknown-runtime: pi",
			"unknown runtime 'pi'",
			"unsupported runtime: pi",
			"invalid runtime pi",
		]) {
			expect(isContractRejection(text)).toBe(true);
		}
	});

	test("does not misclassify a not-ready box or a successful run", () => {
		// A bare boot-race exit carries no rejection text and MUST stay retryable —
		// misclassifying it would abandon a box that was about to become ready.
		expect(isContractRejection("")).toBe(false);
		expect(isContractRejection("pct exec failed: container not running")).toBe(false);
		expect(isContractRejection("started vmid=9001 job=j runtime=claude")).toBe(false);
	});
});

describe("hasErrorPayload", () => {
	test("detects the mcp2cli boolean-error and success:false envelopes", () => {
		expect(hasErrorPayload('{"error":true,"code":"CONNECTION_ERROR","message":"timed out"}')).toBe(
			true,
		);
		expect(hasErrorPayload('{"success":false,"result":{"ok":false}}')).toBe(true);
		expect(hasErrorPayload('{"success":true,"result":{"ok":true,"stdout":"vmid=9001"}}')).toBe(
			false,
		);
	});

	test("detects a nested verb failure under a top-level success envelope", () => {
		// mcp2cli wraps a completed tool call whose verb failed as
		// `{"success":true,"result":{"ok":false,...}}`. The nested ok:false is the
		// real failure; missing it makes run() treat a not-ready box as launched.
		expect(hasErrorPayload('{"success":true,"result":{"ok":false,"stderr":"not ready"}}')).toBe(
			true,
		);
		expect(hasErrorPayload('{"success":true,"result":{"success":false}}')).toBe(true);
		expect(hasErrorPayload('{"success":true,"result":{"error":true}}')).toBe(true);
		expect(hasErrorPayload('{"success":true,"result":{"error":"verb blew up"}}')).toBe(true);
	});

	test("detects an in-band error even with exit 0", () => {
		expect(hasErrorPayload('{"error": "vmid 9003 not running"}')).toBe(true);
		expect(hasErrorPayload('{"status": "failed"}')).toBe(true);
		expect(hasErrorPayload('{"ok": false}')).toBe(true);
	});

	test("treats a clean success payload as no error", () => {
		expect(hasErrorPayload('{"ok": true, "vmid": 9001}')).toBe(false);
		expect(hasErrorPayload('[{"vmid": 9001}]')).toBe(false);
	});

	test("treats non-JSON and blank output as no error", () => {
		expect(hasErrorPayload("9001 allocated")).toBe(false);
		expect(hasErrorPayload("   ")).toBe(false);
	});
});

describe("Mcp2cliRunnerTransport.run readiness retry", () => {
	test("submits once when the box accepts immediately", async () => {
		const t = new ScriptedTransport([OK], 6);
		await t.run(RUN);
		expect(t.invokeCalls).toBe(1);
		expect(t.slept).toEqual([]);
	});

	test("retries across the boot window and succeeds once the box is ready", async () => {
		// The box rejects the first two submissions (not exec-ready), then accepts.
		const t = new ScriptedTransport([FAIL, FAIL, OK], 6);
		await t.run(RUN);
		expect(t.invokeCalls).toBe(3);
		// It waited between the two failures and the success, but not after success.
		expect(t.slept).toEqual([5, 5]);
	});

	test("throws after exhausting every attempt, with no trailing sleep", async () => {
		const t = new ScriptedTransport([FAIL, FAIL, FAIL], 3);
		await expect(t.run(RUN)).rejects.toThrow("runner_run failed (exit 1)");
		expect(t.invokeCalls).toBe(3);
		// Slept only BETWEEN attempts (2), never after the final failure.
		expect(t.slept).toEqual([5, 5]);
	});

	test("an in-band error payload (even exit 0) is a fatal fault, not a boot race", async () => {
		// exit 0 but the mcp2cli envelope reports a verb failure. This is a structured
		// fault, not a not-ready box, so it must NOT count as a launch AND must bail
		// immediately rather than burn the retry window.
		const inBandFail = { code: 0, stdout: '{"success":false,"result":{"ok":false}}' };
		const t = new ScriptedTransport([inBandFail, OK], 6);
		await expect(t.run(RUN)).rejects.toThrow("runner_run failed (exit 0)");
		expect(t.invokeCalls).toBe(1);
		expect(t.slept).toEqual([]);
	});

	test("a single-attempt transport never retries", async () => {
		const t = new ScriptedTransport([FAIL], 1);
		await expect(t.run(RUN)).rejects.toThrow("runner_run failed (exit 1)");
		expect(t.invokeCalls).toBe(1);
		expect(t.slept).toEqual([]);
	});

	test("bails immediately on a structured transport-fault payload (not a boot race)", async () => {
		// A `{"error":true,...}` / `{"success":false,...}` envelope is a transport or
		// verb fault, not a not-ready box — retrying wastes the window, so stop at once.
		const fault = { code: 1, stdout: '{"error":true,"code":"CONNECTION_ERROR"}' };
		const t = new ScriptedTransport([fault, OK], 10);
		await expect(t.run(RUN)).rejects.toThrow("runner_run failed (exit 1)");
		expect(t.invokeCalls).toBe(1);
		expect(t.slept).toEqual([]);
	});

	test("bails immediately on a capacity refusal in stderr (not a boot race)", async () => {
		const refusal = { code: 1, stdout: "", stderr: "runner pool exhausted" };
		const t = new ScriptedTransport([refusal, OK], 10);
		await expect(t.run(RUN)).rejects.toThrow("runner_run failed (exit 1)");
		expect(t.invokeCalls).toBe(1);
		expect(t.slept).toEqual([]);
	});

	test("bails immediately on an unknown-runtime rejection (#175: 1 attempt, not 10)", async () => {
		// THE cost this classification exists to avoid. The live `scripts/runner-boxes`
		// verb dies on any runtime that is not `claude|codex`, with a bare non-JSON
		// stderr message and a non-zero exit — byte-shaped exactly like a not-ready
		// box. Unclassified, that is 10 attempts x 15s ≈ 2.5 MINUTES holding an
		// allocated box, every attempt certain to fail. It must be terminal at once.
		const rejection = {
			code: 1,
			stdout: "",
			stderr: "runtime must be claude|codex, got: pi",
		};
		const t = new ScriptedTransport([rejection, OK], 10);
		await expect(t.run(RUN)).rejects.toThrow("runner_run contract rejection: unsupported runtime");
		expect(t.invokeCalls).toBe(1);
		expect(t.slept).toEqual([]);
	});

	test("bails immediately on an 'unknown-runtime' rejection spelling", async () => {
		const rejection = { code: 1, stdout: "", stderr: "unknown-runtime: pi" };
		const t = new ScriptedTransport([rejection, OK], 10);
		await expect(t.run(RUN)).rejects.toThrow("runner_run contract rejection: unsupported runtime");
		expect(t.invokeCalls).toBe(1);
	});

	test("a contract rejection carries its own message, and never raw runner output", async () => {
		// The generic `exit N` message reads as a boot race and sends an operator to
		// check the box; the classifier already KNOWS the wrapper refused the runtime,
		// so it says so. The message is fixed prose: runner stdout/stderr is untrusted
		// and must not be spliced into a thrown error.
		const rejection = {
			code: 1,
			stdout: "",
			stderr: "unsupported runtime: pi SECRET-RUNNER-OUTPUT",
		};
		const t = new ScriptedTransport([rejection], 10);
		const err = await t.run(RUN).then(
			() => undefined,
			(e: unknown) => e as Error,
		);
		expect(err?.message).toBe("runner_run contract rejection: unsupported runtime");
		expect(err?.message).not.toContain("SECRET-RUNNER-OUTPUT");
		expect(err?.message).not.toContain("exit 1");
	});

	test("a generic (non-contract) failure keeps the exit-code message", async () => {
		// Only the contract class is renamed. A capacity refusal and an exhausted boot
		// window still report the exit code, which is the useful fact for those.
		const refusal = { code: 1, stdout: "", stderr: "runner pool exhausted" };
		await expect(new ScriptedTransport([refusal], 10).run(RUN)).rejects.toThrow(
			"runner_run failed (exit 1)",
		);
		await expect(new ScriptedTransport([FAIL, FAIL], 2).run(RUN)).rejects.toThrow(
			"runner_run failed (exit 1)",
		);
	});

	// #307: the exit code alone is not a diagnosis. On the 2026-08-16 B5 night both
	// dispatch failures persisted `runner_run failed (exit 1)` into
	// `job_attempts.failure_summary` while the stderr this transport ALREADY held
	// named the cause outright. These pin that the captured stream survives into
	// the thrown message — bounded, control-stripped, and redacted.
	test("a structured failure carries the captured stderr into the message", async () => {
		// The real B5 wording. This is the string one column read would have shown.
		const overSize = {
			code: 1,
			stdout: "",
			stderr: "params.job exceeds 10000 chars",
		};
		const t = new ScriptedTransport([overSize], 1);
		const err = await t.run(RUN).then(
			() => undefined,
			(e: unknown) => e as Error,
		);
		expect(err?.message).toContain("runner_run failed (exit 1)");
		expect(err?.message).toContain("params.job exceeds 10000 chars");
	});

	test("an EXHAUSTED boot window also carries the last stderr", async () => {
		// The other B5 path: no structured classifier matches, every attempt is a
		// bare failure, and the loop falls out the bottom. That final throw used to
		// discard the stderr entirely — it is the one an operator reads.
		const bare = { code: 1, stdout: "", stderr: "params.job exceeds 10000 chars" };
		const t = new ScriptedTransport([bare, bare], 2);
		const err = await t.run(RUN).then(
			() => undefined,
			(e: unknown) => e as Error,
		);
		expect(t.invokeCalls).toBe(2);
		expect(err?.message).toContain("params.job exceeds 10000 chars");
	});

	test("overlong stderr is truncated and control characters are stripped", async () => {
		// Built from escapes so this source file holds no literal control bytes.
		// `\s+` does NOT cover these: probed, ESC/BEL/NUL survive a collapse pass
		// unchanged, so they need an explicit strip before reaching a column an
		// operator reads back through a terminal.
		const ESC = String.fromCharCode(0x1b);
		const BEL = String.fromCharCode(0x07);
		const NUL = String.fromCharCode(0x00);
		const noisy = {
			code: 1,
			stdout: "",
			stderr: `head${ESC}[31m${BEL}${NUL}${"x".repeat(4000)}tail`,
		};
		const t = new ScriptedTransport([noisy], 1);
		const err = await t.run(RUN).then(
			() => undefined,
			(e: unknown) => e as Error,
		);
		const message = err?.message ?? "";
		expect(message).toContain("runner_run failed (exit 1)");
		// Clamped: the 4000-char body cannot reach the column in full.
		expect(message.length).toBeLessThan(600);
		expect(message).toContain("...");
		// No control byte survives. Tested by CODE POINT rather than by regex: the
		// literal form is an ERROR under `noControlCharactersInRegex`, and biome's
		// `check --write` COLLAPSES the `new RegExp("[\\x00-...]")` form back into
		// exactly that literal, so neither spelling survives both halves of
		// `biome check` (same trap fixed in `runner/transport.ts`).
		expect(Array.from(message).some((c) => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127)).toBe(
			false,
		);
		expect(message).not.toContain(ESC);
	});

	test("a secret-shaped token in stderr is redacted before it can be persisted", async () => {
		// mcp2cli is the credential-holding bridge, so its stderr is treated as
		// capable of carrying a secret. Redaction runs BEFORE truncation so a
		// half-sliced token cannot escape its own pattern.
		const leak = {
			code: 1,
			stdout: "",
			stderr: `refused: bad auth ghp_${"A".repeat(36)} while staging`,
		};
		const t = new ScriptedTransport([leak], 1);
		const err = await t.run(RUN).then(
			() => undefined,
			(e: unknown) => e as Error,
		);
		expect(err?.message).toContain("[REDACTED]");
		expect(err?.message).not.toContain("ghp_");
	});

	test("a failure with NO captured output keeps the bare exit-code message", async () => {
		// The append is additive, never a downgrade: with nothing to say, the
		// message stays exactly what it was rather than growing a "<no stdout>" tail.
		const t = new ScriptedTransport([{ code: 1, stdout: "", stderr: "" }], 1);
		const err = await t.run(RUN).then(
			() => undefined,
			(e: unknown) => e as Error,
		);
		expect(err?.message).toBe("runner_run failed (exit 1)");
	});

	test("keeps retrying a bare not-ready exit even with a wide window", async () => {
		// The box is not exec-ready for several attempts (bare exit 1, no structured
		// payload), then accepts — the wide window must ride the boot out.
		const t = new ScriptedTransport([FAIL, FAIL, FAIL, FAIL, OK], 10);
		await t.run(RUN);
		expect(t.invokeCalls).toBe(5);
		expect(t.slept).toEqual([5, 5, 5, 5]);
	});
});

class TimeoutCapturingTransport extends Mcp2cliRunnerTransport {
	readonly calls: Array<{ verb: string; timeoutMs: number | undefined }> = [];

	constructor(private readonly reply: { code: number; stdout: string; stderr?: string }) {
		super("mcp2cli", 90_000, { runReadyAttempts: 1 });
	}

	protected async invoke(
		verb: string,
		_params: Record<string, unknown>,
		timeoutMs?: number,
	): Promise<{ code: number; stdout: string; stderr: string }> {
		this.calls.push({ verb, timeoutMs });
		return {
			code: this.reply.code,
			stdout: this.reply.stdout,
			stderr: this.reply.stderr ?? "",
		};
	}
}

describe("Mcp2cliRunnerTransport per-verb timeout budgets", () => {
	test("needed invokes runner_needed with the 240s allocation budget", async () => {
		const transport = new TimeoutCapturingTransport({ code: 0, stdout: "vmid=9001" });

		await transport.needed("small", "j", 1);

		expect(transport.calls).toEqual([{ verb: "runner_needed", timeoutMs: 240_000 }]);
	});

	test("run keeps the 90s default verb budget", async () => {
		const transport = new TimeoutCapturingTransport({ code: 0, stdout: "started" });

		await transport.run(RUN);

		expect(transport.calls).toEqual([{ verb: "runner_run", timeoutMs: 90_000 }]);
	});

	test("a needed timeout stays outcome-unknown and possibly placed", async () => {
		const transport = new TimeoutCapturingTransport({
			code: 1,
			stdout:
				'{"error":true,"code":"CONNECTION_ERROR","message":"Failed to communicate with local daemon: The operation timed out."}',
		});
		const error = await transport.needed("small", "j", 1).then(
			() => undefined,
			(err: unknown) => err as Error,
		);

		expect(error).toBeInstanceOf(RunnerAllocationUnknownError);
		expect(error?.message).toContain("outcome UNKNOWN");
		expect(error?.message).toContain("a box may have been placed");
		expect(transport.calls).toEqual([{ verb: "runner_needed", timeoutMs: 240_000 }]);
	});
});

describe("Mcp2cliRunnerTransport.needed partial placement", () => {
	// A REFUSED allocation can still have powered on in-pool boxes (the README's
	// partial-placement case). needed() must surface those placed vmids — parsed
	// through the SAME pool-range guard — so a caller can reap them and strand
	// nothing. An out-of-pool / template 9900 id is NOT ours to reap and must be
	// excluded from `placed`.
	test("surfaces placed in-pool vmids on a refusal and excludes an out-of-pool/9900 id", async () => {
		const refusedWithPlaced = {
			code: 1,
			stdout:
				"placed vmid=9001 host=px05\nplaced vmid=9002\nvmid=9900 template\nvmid=12345 bogus\n",
			stderr: "runner pool exhausted, refusing further allocation",
		};
		const t = new ScriptedTransport([refusedWithPlaced], 1);
		const allocation = await t.needed("small", "j", 1);
		expect(allocation.ok).toBe(false);
		if (allocation.ok) throw new Error("expected refusal");
		expect(allocation.refused).toBe(true);
		// Only the two in-pool boxes; the template 9900 and out-of-pool 12345 dropped.
		expect((allocation.placed ?? []).map((b) => b.vmid)).toEqual([9001, 9002]);
	});

	test("surfaces placed vmids from the REAL ok:false refusal ENVELOPE (not a bare string)", async () => {
		// Production shape: mcp2cli wraps the refusal as
		// `{success:true,result:{ok:false,stdout:"...vmid=9001...",stderr}}`. The
		// placed box lives inside result.stdout even though the inner ok is false, and
		// hasErrorPayload flags the ok:false while isRefusal matches the stdout text —
		// so needed() takes the refusal path and must still mine the inner placed box.
		const refusalEnvelope = {
			code: 0,
			stdout: JSON.stringify({
				success: true,
				result: {
					ok: false,
					stdout: "REFUSED: pool at capacity\nvmid=9001 host=px05\nvmid=9900 template",
					stderr: "",
				},
			}),
			stderr: "",
		};
		const t = new ScriptedTransport([refusalEnvelope], 1);
		const allocation = await t.needed("small", "j", 1);
		expect(allocation.ok).toBe(false);
		if (allocation.ok) throw new Error("expected refusal");
		expect(allocation.refused).toBe(true);
		// The in-pool 9001 is reaped; the template 9900 inside the same stdout is not.
		expect((allocation.placed ?? []).map((b) => b.vmid)).toEqual([9001]);
	});

	test("reads the refusal phrase from stderr while parsing placed vmids from stdout", async () => {
		// The realistic partial-placement shape: a non-zero exit, the placed boxes
		// printed as vmid= lines on STDOUT, and the refusal phrasing on STDERR. The
		// refusal check reads the combined stream; parseBoxes reads stdout, so the
		// placed 9003 is surfaced even though the refusal word is only on stderr.
		const refusedOnStderr = {
			code: 1,
			stdout: "placed vmid=9003 host=px06\n",
			stderr: "no free slot: pool at capacity",
		};
		const t = new ScriptedTransport([refusedOnStderr], 1);
		const allocation = await t.needed("small", "j", 1);
		expect(allocation.ok).toBe(false);
		if (allocation.ok) throw new Error("expected refusal");
		expect((allocation.placed ?? []).map((b) => b.vmid)).toEqual([9003]);
	});

	test("a clean empty allocation refuses with no placed boxes", async () => {
		// parseBoxes finds nothing, so there is nothing placed to reap.
		const t = new ScriptedTransport([{ code: 0, stdout: "no boxes here\n" }], 1);
		const allocation = await t.needed("small", "j", 1);
		expect(allocation.ok).toBe(false);
		if (allocation.ok) throw new Error("expected refusal");
		expect(allocation.reason).toBe("no runner box allocated");
		expect(allocation.placed ?? []).toEqual([]);
	});

	test("still throws on a non-refusal hard failure (no placed leakage)", async () => {
		const t = new ScriptedTransport([{ code: 1, stdout: "vmid=9001", stderr: "disk error" }], 1);
		await expect(t.needed("small", "j", 1)).rejects.toThrow("runner_needed failed (exit 1)");
	});

	// SOF-8143: on sf-fleet-01 the mcp2cli client had no services.json and said
	// `Unknown service: "runner-boxes"` on stderr -- the whole answer -- while the
	// message read only `runner_needed failed (exit 1)`. Carry it, as runner_run does.
	test("a hard failure carries the bounded stderr in its message", async () => {
		const t = new ScriptedTransport(
			[{ code: 1, stdout: "", stderr: 'Unknown service: "runner-boxes"\n' }],
			1,
		);
		await expect(t.needed("small", "j", 1)).rejects.toThrow(
			'runner_needed failed (exit 1) -- Unknown service: "runner-boxes"',
		);
	});

	test("a hard failure with empty stderr carries the stdout envelope instead", async () => {
		const t = new ScriptedTransport([{ code: 2, stdout: '{"error":"bad size"}', stderr: "" }], 1);
		await expect(t.needed("small", "j", 1)).rejects.toThrow(
			'runner_needed failed (exit 2) -- {"error":"bad size"}',
		);
	});

	test("a hard failure with no output at all keeps the bare message", async () => {
		const t = new ScriptedTransport([{ code: 1, stdout: "", stderr: "" }], 1);
		await expect(t.needed("small", "j", 1)).rejects.toThrow(/^runner_needed failed \(exit 1\)$/);
	});

	// #79: the allocation transport fault is the leak shape. The verb generally
	// completes server-side and places a box, but the response carries no vmid, so
	// the watcher owns a container it cannot name. It must be distinguishable from
	// a verb that ran and failed, which placed nothing.
	test("a transport fault throws RunnerAllocationUnknownError, not a plain failure", async () => {
		const t = new ScriptedTransport(
			[
				{
					code: 1,
					stdout:
						'{"error":true,"code":"CONNECTION_ERROR","message":"Failed to communicate with local daemon: The operation timed out."}',
				},
			],
			1,
		);
		await expect(t.needed("small", "j", 1)).rejects.toBeInstanceOf(RunnerAllocationUnknownError);
	});

	test("a hard verb failure is NOT an unknown outcome", async () => {
		// The counterpart: this one placed nothing, so treating it as unknown would
		// send an operator hunting a box that does not exist.
		const t = new ScriptedTransport([{ code: 1, stdout: "", stderr: "disk error" }], 1);
		await expect(t.needed("small", "j", 1)).rejects.not.toBeInstanceOf(
			RunnerAllocationUnknownError,
		);
	});
});

/**
 * A transport scripted for `done`, with the transport-fault retry delay pinned
 * small and `sleep` recorded so a test can prove the loop actually waited.
 */
class ScriptedDoneTransport extends Mcp2cliRunnerTransport {
	readonly slept: number[] = [];
	invokeCalls = 0;
	constructor(private readonly replies: Array<{ code: number; stdout: string; stderr?: string }>) {
		super("mcp2cli", 90_000, {
			doneRetryDelayMs: 7,
			sleep: async (ms) => {
				this.slept.push(ms);
			},
		});
	}
	protected async invoke(): Promise<{ code: number; stdout: string; stderr: string }> {
		const reply = this.replies[this.invokeCalls] ?? { code: 1, stdout: "" };
		this.invokeCalls += 1;
		return { code: reply.code, stdout: reply.stdout, stderr: reply.stderr ?? "" };
	}
}

// The exact payload observed on 2026-07-27/28, repeatedly, on the FIRST call.
const CONNECTION_ERROR = {
	code: 1,
	stdout:
		'{"error":true,"code":"CONNECTION_ERROR","message":"Failed to communicate with local daemon: The operation timed out."}',
};
const DONE_OK = {
	code: 0,
	stdout: '{"success":true,"result":{"ok":true,"stdout":"reaped vmid=9001"}}',
};
const DONE_REFUSED_MESSAGE =
	"REFUSED: vmid 9001 is owned by job 'rw-infra-static-OTHER', not 'rw-infra-static-OURS' — the slot has been recycled; reaping it would destroy another job's box (#909). Operator force: runner-boxes done --vmid 9001";

describe("isTransportFault", () => {
	test("classifies the observed CONNECTION_ERROR payload", () => {
		expect(isTransportFault(CONNECTION_ERROR.stdout)).toBe(true);
	});

	test("matches the daemon-hop message even without the code field", () => {
		expect(
			isTransportFault('{"error":true,"message":"Failed to communicate with local daemon"}'),
		).toBe(true);
	});

	test("reads stderr too, since the fault can surface there", () => {
		expect(isTransportFault("", "CONNECTION_ERROR: daemon unreachable")).toBe(true);
	});

	test("does NOT classify a verb that genuinely ran and failed", () => {
		// This is the case that must still throw on the first attempt: retrying a
		// real failure cannot change the answer, and would only delay the report.
		expect(isTransportFault('{"success":true,"result":{"ok":false,"stdout":"no such vmid"}}')).toBe(
			false,
		);
		expect(isTransportFault("runner allocation returned unexpected box count")).toBe(false);
	});

	test("does NOT swallow an unrelated timeout as retryable", () => {
		// A verb that really did run too long is a genuine failure. Only the
		// local-daemon hop is retryable, so a bare 'timed out' must not match.
		expect(isTransportFault("runner-boxes done timed out after 90000ms")).toBe(false);
	});
});

describe("done — transport faults are retried, verb failures are not", () => {
	test("recovers when the first call is a transport fault and the second succeeds", async () => {
		// The exact observed pattern: first call fails, immediate retry works.
		const t = new ScriptedDoneTransport([CONNECTION_ERROR, DONE_OK]);
		await t.done(9001);
		expect(t.invokeCalls).toBe(2);
		expect(t.slept).toEqual([7]);
	});

	test("does not retry a genuine verb failure", async () => {
		const t = new ScriptedDoneTransport([
			{ code: 0, stdout: '{"success":true,"result":{"ok":false,"stdout":"nope"}}' },
			DONE_OK,
		]);
		await expect(t.done(9001)).rejects.toThrow("runner_done failed");
		expect(t.invokeCalls).toBe(1);
		expect(t.slept).toEqual([]);
	});

	test("reports UNKNOWN outcome — not a failed reap — when every attempt is a transport fault", async () => {
		// The distinction that matters operationally: the box may still be live and
		// holding a pool slot, so the operator must go look rather than assume it
		// is gone.
		const t = new ScriptedDoneTransport([CONNECTION_ERROR, CONNECTION_ERROR, CONNECTION_ERROR]);
		await expect(t.done(9001)).rejects.toThrow(/UNKNOWN/);
		await expect(
			new ScriptedDoneTransport([CONNECTION_ERROR, CONNECTION_ERROR, CONNECTION_ERROR]).done(9001),
		).rejects.toThrow(/may still be live/);
	});

	test("is bounded — a persistently dead daemon does not retry forever", async () => {
		const t = new ScriptedDoneTransport([
			CONNECTION_ERROR,
			CONNECTION_ERROR,
			CONNECTION_ERROR,
			DONE_OK,
		]);
		await expect(t.done(9001)).rejects.toThrow(/UNKNOWN/);
		expect(t.invokeCalls).toBe(3);
	});

	test("succeeds on the first call without sleeping", async () => {
		const t = new ScriptedDoneTransport([DONE_OK]);
		await t.done(9001);
		expect(t.invokeCalls).toBe(1);
		expect(t.slept).toEqual([]);
	});

	test("returns an ownership refusal as data without retrying", async () => {
		const t = new ScriptedDoneTransport([{ code: 1, stdout: "", stderr: DONE_REFUSED_MESSAGE }]);
		expect(await t.done(9001, "rw-infra-static-OURS")).toEqual({
			refused: true,
			ownerJobId: "rw-infra-static-OTHER",
		});
		expect(t.invokeCalls).toBe(1);
		expect(t.slept).toEqual([]);
	});
});

describe("done — exact mcp2cli argv", () => {
	test("a scoped reap reaches Bun.spawn with vmid and job_id", async () => {
		const expectedHolder = "rw-infra-static-OURS";
		const originalSpawn = Bun.spawn;
		let spawnedArgv: string[] | undefined;

		try {
			Bun.spawn = ((argv: string[]) => {
				spawnedArgv = [...argv];
				return {
					exited: Promise.resolve(0),
					stdout: new Response(DONE_OK.stdout).body,
					stderr: new Response("").body,
					kill: () => {},
				};
			}) as typeof Bun.spawn;

			await new Mcp2cliRunnerTransport("mcp2cli").done(9001, expectedHolder);
		} finally {
			Bun.spawn = originalSpawn;
		}

		expect(spawnedArgv).toEqual([
			"mcp2cli",
			"runner-boxes",
			"runner_done",
			"--params",
			`{"vmid":9001,"job_id":"${expectedHolder}"}`,
		]);
	});

	test("a scoped reap sends job_id", () => {
		expect(
			runnerBoxArgv("mcp2cli", "runner_done", runnerDoneArgs(9001, "rw-infra-static-OURS")),
		).toEqual([
			"mcp2cli",
			"runner-boxes",
			"runner_done",
			"--params",
			'{"vmid":9001,"job_id":"rw-infra-static-OURS"}',
		]);
	});

	test("an unscoped operator-force reap omits job_id entirely", () => {
		const argv = runnerBoxArgv("mcp2cli", "runner_done", runnerDoneArgs(9001));
		expect(argv).toEqual(["mcp2cli", "runner-boxes", "runner_done", "--params", '{"vmid":9001}']);
		expect(argv.join(" ")).not.toContain("job_id");
	});
});

describe("done — the failure message names which signal fired", () => {
	// The observed defect: `runner_done failed (exit 0)` is self-contradictory on
	// its face, and it discards the ONLY evidence separating a false positive from
	// a genuine in-band failure. These pin the report, never the reap behaviour.
	const IN_BAND = {
		code: 0,
		stdout: '{"success":true,"result":{"ok":false,"stdout":"destroy reported an error"}}',
	};

	/**
	 * Run `done` expecting rejection and return the error. Fails the test if the
	 * call RESOLVES — otherwise a `done` that wrongly succeeded would silently
	 * skip every assertion below instead of failing.
	 */
	async function doneError(t: ScriptedDoneTransport): Promise<Error> {
		try {
			await t.done(9001);
		} catch (err) {
			return err as Error;
		}
		throw new Error("expected done() to reject, but it resolved");
	}

	test("attributes an exit-0 failure to the in-band error payload, not the exit code", async () => {
		const t = new ScriptedDoneTransport([IN_BAND]);
		const err = await doneError(t);
		// "exit 0" alone reads as a success mislabelled as a failure. The message
		// must say the process exited 0 and the failure came from the payload.
		expect(err.message).toMatch(/in-band error payload/i);
		expect(err.message).toContain("exit 0");
	});

	test("carries the offending stdout so the next occurrence is diagnosable", async () => {
		const t = new ScriptedDoneTransport([IN_BAND]);
		const err = await doneError(t);
		expect(err.message).toContain("destroy reported an error");
	});

	test("still attributes a non-zero exit to the exit code, with no payload claim", async () => {
		// The other branch must stay honest too: exit 3 with unparseable stdout is
		// a process failure, and claiming an in-band payload there would be a new lie.
		const t = new ScriptedDoneTransport([{ code: 3, stdout: "boom", stderr: "" }]);
		const err = await doneError(t);
		expect(err.message).toContain("exit 3");
		expect(err.message).not.toMatch(/in-band error payload/i);
	});

	test("redacts secrets and bounds the captured stdout", async () => {
		const secret = `{"success":true,"result":{"ok":false,"token":"ghp_${"a".repeat(36)}","pad":"${"x".repeat(4000)}"}}`;
		const t = new ScriptedDoneTransport([{ code: 0, stdout: secret, stderr: "" }]);
		const err = await doneError(t);
		expect(err.message).not.toContain("ghp_");
		// Bounded: the message must not carry the whole 4KB payload into a log line.
		expect(err.message.length).toBeLessThan(1200);
	});

	test("leaves the UNKNOWN transport-fault branch untouched", async () => {
		// Non-goal guard: this branch is separately reasoned and must not acquire
		// the in-band wording.
		const t = new ScriptedDoneTransport([CONNECTION_ERROR, CONNECTION_ERROR, CONNECTION_ERROR]);
		const err = await doneError(t);
		expect(err.message).toMatch(/UNKNOWN/);
		expect(err.message).not.toMatch(/in-band error payload/i);
	});
});

/**
 * A transport that records the params of every verb invocation, so a test can
 * assert exactly what reaches the `mcp2cli runner-boxes` payload without
 * spawning a process.
 */
class CapturingTransport extends Mcp2cliRunnerTransport {
	readonly calls: Array<{ verb: string; params: Record<string, unknown> }> = [];
	protected async invoke(
		verb: string,
		params: Record<string, unknown>,
	): Promise<{ code: number; stdout: string; stderr: string }> {
		// The v2 server enforces `additionalProperties: false` and REQUIRES all four
		// route keys on `runner_run`, so this mock
		// refuses exactly what the server refuses. Without it a stdio fixture can pin
		// a submission the live server rejects — which is how sf#390's three stale
		// fixtures stayed green while the watcher host dispatch was refused at the schema layer.
		if (verb === "runner_run") {
			const declared = [
				"vmid",
				"job_id",
				"job",
				"runtime",
				"max_turns",
				"model",
				"effort",
				"engine_base_url",
				"engine_auth_header_name",
			];
			for (const key of Object.keys(params)) {
				if (!declared.includes(key)) {
					throw new Error(`stdio mock: undeclared argument ${key} on runner_run`);
				}
			}
			for (const key of declared) {
				if (!(key in params)) {
					throw new Error(`stdio mock: missing argument ${key} on runner_run`);
				}
			}
		}
		this.calls.push({ verb, params });
		return { code: 0, stdout: "", stderr: "" };
	}
}

describe("runner_run payload carries the pi route only when declared", () => {
	test("a pi run sends runtime, model, and effort", async () => {
		const t = new CapturingTransport();
		await t.run({
			vmid: 9001,
			jobId: "rw-issue-triage-1",
			job: "body",
			runtime: "pi",
			model: "gpt-5.6-sol",
			effort: "low",
			maxTurns: 40,
			engineEndpoint: ROUTE.engineEndpoint,
		});

		expect(t.calls.length).toBe(1);
		expect(t.calls[0]?.verb).toBe("runner_run");
		expect(t.calls[0]?.params).toEqual({
			vmid: 9001,
			job_id: "rw-issue-triage-1",
			job: "body",
			runtime: "pi",
			max_turns: 40,
			model: "gpt-5.6-sol",
			effort: "low",
			engine_base_url: "https://codex-proxy.example.internal",
			engine_auth_header_name: "Authorization",
		});
	});

	test("a claude/codex run carries the full route on the wire", async () => {
		const t = new CapturingTransport();
		await t.run({ vmid: 9001, jobId: "rw-pr-review-1", job: "body", maxTurns: 120, ...ROUTE });

		// The premise before sf#390 was that an agent lane sends NO model/effort key.
		// The v2 server now requires all four route keys on every runtime, so the
		// payload is the nine declared keys with `runtime` carrying `claude`.
		expect(t.calls[0]?.params).toEqual({
			vmid: 9001,
			job_id: "rw-pr-review-1",
			job: "body",
			runtime: "claude",
			max_turns: 120,
			model: "gpt-5.6-luna",
			effort: "max",
			engine_base_url: "https://codex-proxy.example.internal",
			engine_auth_header_name: "Authorization",
		});
	});
});

describe("the agentless script runtime on the wire", () => {
	test("a script run sends runtime=script WITH model, effort, and engine keys", async () => {
		const t = new CapturingTransport();
		await t.run({
			vmid: 9001,
			jobId: "rw-infra-static-agentless-1",
			job: "#!/usr/bin/env bash\nset -euo pipefail\nactionlint",
			runtime: "script",
			maxTurns: 60,
			model: "gpt-5.6-luna",
			effort: "max",
			engineEndpoint: {
				baseUrl: "https://codex-proxy.example.internal",
				authHeaderName: "Authorization",
			},
		});

		// The payload is deliberately the SAME five keys an agent lane sends, with
		// `runtime` carrying `script`. No new key is invented: the wrapper's
		// existing parse is unchanged, and `max_turns` is inert under a runtime
		// with no turns (the same shape `pi` already has — see the runner contract).
		expect(t.calls[0]?.params).toEqual({
			vmid: 9001,
			job_id: "rw-infra-static-agentless-1",
			job: "#!/usr/bin/env bash\nset -euo pipefail\nactionlint",
			runtime: "script",
			max_turns: 60,
			model: "gpt-5.6-luna",
			effort: "max",
			engine_base_url: "https://codex-proxy.example.internal",
			engine_auth_header_name: "Authorization",
		});
		expect(Object.keys(t.calls[0]?.params ?? {})).toContain("model");
		expect(Object.keys(t.calls[0]?.params ?? {})).toContain("effort");
	});

	test("a script run MISSING its route is refused BEFORE any invoke", async () => {
		// The refusal must land before the verb is called: an allocated box held
		// through a doomed submission is the exact cost #175 paid for an unhandled
		// runtime mismatch. Zero invocations is the assertion that matters.
		const t = new CapturingTransport();
		await expect(
			t.run({
				vmid: 9001,
				jobId: "rw-infra-static-agentless-2",
				job: "actionlint",
				runtime: "script",
			}),
		).rejects.toThrow(/missing: model and effort and engineEndpoint/);
		expect(t.calls.length).toBe(0);
	});

	test("an agent run WITHOUT engineEndpoint is refused BEFORE any invoke", async () => {
		// Same cost as the sf#384 refusal, one runtime wider: the v2 server requires
		// the engine pair on EVERY runtime, so a box held through an unrouted agent
		// submission is refused by the server after the allocation, not before it.
		const t = new CapturingTransport();
		await expect(
			t.run({
				vmid: 9001,
				jobId: "rw-pr-review-1",
				job: "body",
				model: "gpt-5.6-luna",
				effort: "max",
			}),
		).rejects.toThrow(/missing: engineEndpoint/);
		expect(t.calls.length).toBe(0);
	});

	test("an agent lane is unchanged by the script guard — the control", async () => {
		const t = new CapturingTransport();
		await t.run({
			vmid: 9001,
			jobId: "rw-issue-triage-1",
			job: "body",
			runtime: "pi",
			model: "gpt-5.6-sol",
			effort: "low",
			maxTurns: 40,
			engineEndpoint: ROUTE.engineEndpoint,
		});
		expect(t.calls.length).toBe(1);
		expect(t.calls[0]?.params).toEqual({
			vmid: 9001,
			job_id: "rw-issue-triage-1",
			job: "body",
			runtime: "pi",
			max_turns: 40,
			model: "gpt-5.6-sol",
			effort: "low",
			engine_base_url: "https://codex-proxy.example.internal",
			engine_auth_header_name: "Authorization",
		});
	});
});

describe("isContractRejection covers a wrapper that does not know `script`", () => {
	test("the live verb's rejection of an unknown runtime is terminal on attempt ONE", () => {
		// The trap restated (AGENTS.md): the wrapper `die`s to stderr with no JSON
		// payload, so an unclassified rejection reads as a boot race and burns the
		// full ~2.5min readiness window HOLDING a box. Every phrasing a wrapper
		// that predates `script` can emit must be classified here.
		for (const text of [
			"runtime must be claude|codex, got: script",
			"runtime must be claude|codex|pi, got: script",
			"ERROR: runtime must be claude|codex|pi|script",
			"unknown-runtime: script",
			"unsupported runtime: script",
			"invalid runtime script",
		]) {
			expect(isContractRejection(text)).toBe(true);
		}
	});

	test("a script run rejected by the wrapper fails in ONE attempt, not ten", async () => {
		const t = new ScriptedTransport(
			[{ code: 1, stdout: "", stderr: "runtime must be claude|codex|pi, got: script" }],
			10,
		);
		await expect(
			t.run({
				vmid: 9001,
				jobId: "rw-infra-static-agentless-3",
				job: "actionlint",
				runtime: "script",
				model: "gpt-5.6-luna",
				effort: "max",
				engineEndpoint: {
					baseUrl: "https://codex-proxy.example.internal",
					authHeaderName: "Authorization",
				},
			}),
		).rejects.toThrow(/contract rejection/);
		expect(t.invokeCalls).toBe(1);
		expect(t.slept).toEqual([]);
	});
});

const BAND_REFUSED = "refused: vmid 9001 is outside the forge band 9101-9150";

/** Records every verb + params and answers with one scripted reply. */
class BandTransport extends Mcp2cliRunnerTransport {
	readonly calls: Array<{ verb: string; params: Record<string, unknown> }> = [];
	constructor(private readonly reply: { code: number; stdout: string; stderr?: string }) {
		super();
	}
	protected async invoke(
		verb: string,
		params: Record<string, unknown>,
	): Promise<{ code: number; stdout: string; stderr: string }> {
		this.calls.push({ verb, params });
		return { code: this.reply.code, stdout: this.reply.stdout, stderr: this.reply.stderr ?? "" };
	}
}

describe("forge band verbs", () => {
	test("isRefusal matches the gateway's forge-band refusal text", () => {
		expect(isRefusal(BAND_REFUSED)).toBe(true);
	});

	test("startBandMember sends runner_forge_up {vmid}", async () => {
		const t = new BandTransport({ code: 0, stdout: "started 9101" });
		await t.startBandMember(9101);
		expect(t.calls).toEqual([{ verb: "runner_forge_up", params: { vmid: 9101 } }]);
	});

	test("stopBandMember sends runner_forge_down {vmid, force:false}", async () => {
		const t = new BandTransport({ code: 0, stdout: "stopped 9101" });
		await t.stopBandMember(9101);
		expect(t.calls).toEqual([{ verb: "runner_forge_down", params: { vmid: 9101, force: false } }]);
	});

	test("listBand sends runner_list {band:'forge'} and parses the table", async () => {
		const t = new BandTransport({ code: 0, stdout: "" });
		expect(await t.listBand("forge")).toEqual([]);
		expect(t.calls).toEqual([{ verb: "runner_list", params: { band: "forge" } }]);
	});

	for (const [name, act] of [
		["startBandMember", (t: BandTransport) => t.startBandMember(9001)],
		["stopBandMember", (t: BandTransport) => t.stopBandMember(9001)],
		["listBand", (t: BandTransport) => t.listBand("forge")],
	] as const) {
		test(`${name}: a refused answer throws RunnerBandRefusedError (exit 0 or 1)`, async () => {
			for (const code of [0, 1]) {
				const t = new BandTransport({ code, stdout: BAND_REFUSED });
				await expect(act(t)).rejects.toBeInstanceOf(RunnerBandRefusedError);
			}
		});
	}

	test("a non-refusal failure throws a plain error", async () => {
		const t = new BandTransport({ code: 1, stdout: "", stderr: "boom" });
		const err = await t.startBandMember(9101).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(Error);
		expect(err).not.toBeInstanceOf(RunnerBandRefusedError);
	});
});

describe("forge band stop budget", () => {
	test("forge_down keeps the 150s stop budget, forge_up gets its own; listBand keeps the default", async () => {
		const t = new TimeoutCapturingTransport({ code: 0, stdout: "" });
		await t.startBandMember(9101);
		await t.stopBandMember(9101);
		await t.listBand("forge");
		expect(t.calls).toEqual([
			{ verb: "runner_forge_up", timeoutMs: RUNNER_FORGE_UP_TIMEOUT_MS },
			{ verb: "runner_forge_down", timeoutMs: RUNNER_STOP_TIMEOUT_MS },
			{ verb: "runner_list", timeoutMs: 90_000 },
		]);
		expect(RUNNER_STOP_TIMEOUT_MS).toBeGreaterThan(120_000);
	});
});

const SLOT_SAMPLE = [
	"[node05] VMID       Status     Lock         Name                 JOB_ID                                       SPAWN_ISO",
	"[node05] 9102       running                 CT121               -                                            -",
	"[slot] vmid=9106 status=absent lane=general",
	"[slot] vmid=9102 node=node02 status=running lane=general",
	"[slot] vmid=9103 node=- status=unknown lane=general",
	"",
].join("\n");
const SLOT_BOXES = [
	{ vmid: 9106, status: "absent", name: "CT9106", jobId: null, spawnIso: null },
	{ vmid: 9102, status: "running", name: "CT9102", jobId: null, spawnIso: null },
	{ vmid: 9103, status: "unknown", name: "CT9103", jobId: null, spawnIso: null },
];

describe("ephemeral forge slots", () => {
	test("a refused: busy exit-1 answer from runner_forge_down throws RunnerBandRefusedError", async () => {
		for (const reply of [
			{ code: 1, stdout: "refused: busy" },
			{ code: 1, stdout: "", stderr: "refused: busy" },
		]) {
			const t = new BandTransport(reply);
			await expect(t.stopBandMember(9102)).rejects.toBeInstanceOf(RunnerBandRefusedError);
		}
	});

	test("listBand returns the [slot] rows, absent included, over the old table", async () => {
		const t = new BandTransport({ code: 0, stdout: SLOT_SAMPLE });
		expect(await t.listBand("forge")).toEqual(SLOT_BOXES);
	});

	test("listBand falls back to the table when no [slot] line is present (older gateway)", async () => {
		const t = new BandTransport({ code: 0, stdout: SLOT_SAMPLE.replace(/^\[slot\].*$/gm, "") });
		expect((await t.listBand("forge")).map((b) => b.vmid)).toEqual([9102]);
	});
});
