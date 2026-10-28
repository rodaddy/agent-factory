/**
 * @module tests/actions/forge-write
 * @description Functional tests for the Forge write hop the pr-review lane
 *   publishes through. The load-bearing property: a write that meets
 *   the forge DOWN — a 502 from the reverse proxy, a refused connection — is
 *   re-asked on a schedule that outlasts the nightly backup quiesce (Forgejo
 *   stopped 23:17:20–23:26:02 on 2026-09-09, 8m42s, and task 8195's publish and
 *   failure steps both died inside it), while a 4xx the caller caused is not
 *   re-asked at all. Neither a log line nor a reason ever carries the token or
 *   the response body.
 *
 *   `fetchImpl` and `sleep` are injected; the sleep fake RECORDS its arguments,
 *   so the schedule is an assertion rather than a comment.
 */
import { describe, expect, test } from "bun:test";
import {
	FORGE_WRITE_ATTEMPTS,
	FORGE_WRITE_BACKOFF_MS,
	hasIdenticalComment,
	hasIdenticalStatus,
	listProbe,
	postForge,
} from "../../scripts/actions/forge-write";

const TOKEN = "jwt-do-not-log-me-7c1e";

function scriptedFetch(steps: readonly (number | Error)[]) {
	const inits: RequestInit[] = [];
	let i = 0;
	const impl = (async (_url: string, init: RequestInit) => {
		const step = steps[i];
		i += 1;
		if (step === undefined) throw new Error(`unscripted fetch call ${i}`);
		inits.push(init);
		if (step instanceof Error) throw step;
		return new Response(`body-with-${TOKEN}`, { status: step });
	}) as unknown as typeof fetch;
	return { impl, inits, calls: () => i };
}

function recorder() {
	const slept: number[] = [];
	const logs: string[] = [];
	return {
		slept,
		logs,
		sleep: async (ms: number) => void slept.push(ms),
		log: (line: string) => void logs.push(line),
	};
}

const headers = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };

describe("postForge", () => {
	test("a 201 on the first try returns ok with no sleep", async () => {
		const f = scriptedFetch([201]);
		const r = recorder();
		const out = await postForge(
			"http://forge/api/v1/x",
			{ method: "POST", headers, body: "{}" },
			{
				fetchImpl: f.impl,
				sleep: r.sleep,
				log: r.log,
			},
		);
		expect(out.ok).toBe(true);
		expect(out.status).toBe(201);
		expect(out.attempt).toBe(1);
		expect(r.slept).toEqual([]);
		expect(r.logs).toEqual([]);
	});

	test("the schedule outlasts the backup quiesce: attempts x backoff > 9 minutes", () => {
		expect(FORGE_WRITE_ATTEMPTS * FORGE_WRITE_BACKOFF_MS).toBeGreaterThan(9 * 60_000);
	});

	test("502s during the quiesce are re-asked on the fixed backoff until the forge is back", async () => {
		const f = scriptedFetch([502, 502, 502, 201]);
		const r = recorder();
		const out = await postForge(
			"http://forge/api/v1/x",
			{ method: "POST", headers, body: "{}" },
			{
				fetchImpl: f.impl,
				sleep: r.sleep,
				log: r.log,
			},
		);
		expect(out.ok).toBe(true);
		expect(out.attempt).toBe(4);
		expect(r.slept).toEqual([
			FORGE_WRITE_BACKOFF_MS,
			FORGE_WRITE_BACKOFF_MS,
			FORGE_WRITE_BACKOFF_MS,
		]);
		expect(r.logs).toHaveLength(3);
		expect(r.logs[0]).toContain("attempt 1/");
		expect(r.logs[0]).toContain("http 502");
	});

	test("a refused connection (thrown fetch) is re-asked like a 5xx", async () => {
		const f = scriptedFetch([new Error("ConnectionRefused"), 200]);
		const r = recorder();
		const out = await postForge(
			"http://forge/api/v1/x",
			{ method: "POST", headers, body: "{}" },
			{
				fetchImpl: f.impl,
				sleep: r.sleep,
				log: r.log,
			},
		);
		expect(out.ok).toBe(true);
		expect(out.attempt).toBe(2);
		expect(r.slept).toEqual([FORGE_WRITE_BACKOFF_MS]);
	});

	test("a 4xx the caller caused is not re-asked", async () => {
		const f = scriptedFetch([422]);
		const r = recorder();
		const out = await postForge(
			"http://forge/api/v1/x",
			{ method: "POST", headers, body: "{}" },
			{
				fetchImpl: f.impl,
				sleep: r.sleep,
				log: r.log,
			},
		);
		expect(out.ok).toBe(false);
		expect(out.status).toBe(422);
		expect(out.attempt).toBe(1);
		expect(f.calls()).toBe(1);
		expect(r.slept).toEqual([]);
	});

	test("gives up after the last attempt and says so, without the token or the body", async () => {
		const f = scriptedFetch(Array.from({ length: FORGE_WRITE_ATTEMPTS }, () => 502));
		const r = recorder();
		const out = await postForge(
			"http://forge/api/v1/x",
			{ method: "POST", headers, body: "{}" },
			{
				fetchImpl: f.impl,
				sleep: r.sleep,
				log: r.log,
			},
		);
		expect(out.ok).toBe(false);
		expect(out.attempt).toBe(FORGE_WRITE_ATTEMPTS);
		expect(f.calls()).toBe(FORGE_WRITE_ATTEMPTS);
		expect(r.slept).toHaveLength(FORGE_WRITE_ATTEMPTS - 1);
		const last = r.logs.at(-1) ?? "";
		expect(last).toContain(`failed after ${FORGE_WRITE_ATTEMPTS} attempts`);
		for (const line of r.logs) {
			expect(line).not.toContain(TOKEN);
			expect(line).not.toContain("body-with");
		}
	});

	test("the request is sent as given: method, headers and body are not rewritten", async () => {
		const f = scriptedFetch([200]);
		const r = recorder();
		await postForge(
			"http://forge/api/v1/x",
			{ method: "POST", headers, body: '{"a":1}' },
			{
				fetchImpl: f.impl,
				sleep: r.sleep,
				log: r.log,
			},
		);
		expect(f.inits[0]?.method).toBe("POST");
		expect(f.inits[0]?.body).toBe('{"a":1}');
		const sent = f.inits[0]?.headers as Record<string, string> | undefined;
		expect(sent?.Authorization).toBe(`token ${TOKEN}`);
	});
});

describe("a retry never replays a write the forge already stored", () => {
	test("a lost response is probed before the re-ask, and a landed write is not re-POSTed", async () => {
		const f = scriptedFetch([new Error("socket hang up")]);
		const r = recorder();
		const answers = [true];
		const out = await postForge(
			"http://forge/api/v1/repos/o/r/issues/1/comments",
			{ method: "POST", headers, body: "{}" },
			{
				fetchImpl: f.impl,
				sleep: r.sleep,
				log: r.log,
				alreadyApplied: async () => answers.shift() ?? false,
			},
		);
		expect(out.ok).toBe(true);
		expect(out.reason).toBe("already applied");
		expect(out.attempt).toBe(1);
		// Exactly one POST went out.
		expect(f.calls()).toBe(1);
		expect(r.logs.some((line) => line.includes("landed on attempt 1 after all"))).toBe(true);
	});

	test("the probe is not asked before the first attempt, and a 'no' re-asks as before", async () => {
		const f = scriptedFetch([502, 201]);
		const r = recorder();
		let asked = 0;
		const out = await postForge(
			"http://forge/api/v1/x",
			{ method: "POST", headers, body: "{}" },
			{
				fetchImpl: f.impl,
				sleep: r.sleep,
				log: r.log,
				alreadyApplied: async () => {
					asked += 1;
					return false;
				},
			},
		);
		expect(out.ok).toBe(true);
		expect(out.attempt).toBe(2);
		expect(asked).toBe(1);
	});

	test("a probe that cannot answer (the forge is still down) does not stop the re-ask", async () => {
		const f = scriptedFetch([502, 201]);
		const r = recorder();
		const out = await postForge(
			"http://forge/api/v1/x",
			{ method: "POST", headers, body: "{}" },
			{
				fetchImpl: f.impl,
				sleep: r.sleep,
				log: r.log,
				alreadyApplied: async () => {
					throw new Error("probe 502");
				},
			},
		);
		expect(out.ok).toBe(true);
		expect(out.attempt).toBe(2);
		const probeLine = r.logs.find((line) => line.includes("could not ask whether it landed"));
		expect(probeLine).toBeDefined();
		expect(probeLine).not.toContain(TOKEN);
	});

	test("a lost FINAL response is probed once before the failure is reported", async () => {
		// Both attempts answer 502. The probe before attempt 2 says no; the probe
		// after the last failure says the write is there, so the outcome is ok.
		const f = scriptedFetch([502, 502]);
		const r = recorder();
		let asked = 0;
		const out = await postForge(
			"http://forge/api/v1/x",
			{ method: "POST", headers, body: "{}" },
			{
				fetchImpl: f.impl,
				sleep: r.sleep,
				log: r.log,
				attempts: 2,
				alreadyApplied: async () => {
					asked += 1;
					return asked === 2;
				},
			},
		);
		expect(out).toMatchObject({ ok: true, attempt: 2, reason: "already applied" });
		expect(asked).toBe(2);
		expect(f.calls()).toBe(2);
	});

	test("a caller abort is terminal: no probe, no sleep, no second attempt", async () => {
		const controller = new AbortController();
		let asked = 0;
		const impl = (async (_url: string, init: RequestInit) => {
			// The caller cancels while the first attempt is in flight.
			controller.abort(new Error("lane cancelled"));
			throw new DOMException(String(init.signal?.reason), "AbortError");
		}) as unknown as typeof fetch;
		const r = recorder();
		const out = await postForge(
			"http://forge/api/v1/repos/o/r/issues/1/comments",
			{ method: "POST", headers, body: "{}", signal: controller.signal },
			{
				fetchImpl: impl,
				sleep: r.sleep,
				log: r.log,
				alreadyApplied: async () => {
					asked += 1;
					return false;
				},
			},
		);
		expect(out).toMatchObject({ ok: false, attempt: 1 });
		expect(out.reason).toContain("aborted by the caller");
		expect(out.reason).toContain("lane cancelled");
		expect(asked).toBe(0);
		expect(r.slept).toEqual([]);
	});

	test("the backoff ends at the caller's abort and the loop stops there", async () => {
		const controller = new AbortController();
		const f = scriptedFetch([new Error("ECONNRESET")]);
		const r = recorder();
		// A real sleep that never ends on its own: only the abort can release it.
		const neverSleep = (ms: number) =>
			new Promise<void>(() => {
				r.slept.push(ms);
				setTimeout(() => controller.abort(new Error("cancelled during backoff")), 5);
			});
		const out = await postForge(
			"http://forge/api/v1/repos/o/r/issues/1/comments",
			{ method: "POST", headers, body: "{}", signal: controller.signal },
			{ fetchImpl: f.impl, sleep: neverSleep, log: r.log, attempts: 20, backoffMs: 30_000 },
		);
		expect(f.calls()).toBe(1);
		expect(r.slept).toEqual([30_000]);
		expect(out.ok).toBe(false);
		expect(out.reason).toContain("aborted by the caller");
	});

	test("a caller abort during the probe ends the probe and the write, with no further attempt", async () => {
		const controller = new AbortController();
		const f = scriptedFetch([new Error("ECONNRESET")]);
		const r = recorder();
		let probeSignalAborted = false;
		const probe = async (signal?: AbortSignal) => {
			// The probe hangs; the caller cancels while it is in flight, and the
			// signal handed to the probe is what ends it.
			await new Promise<void>((resolve) => {
				signal?.addEventListener("abort", () => {
					probeSignalAborted = true;
					resolve();
				});
				setTimeout(() => controller.abort(new Error("cancelled while probing")), 5);
			});
			return true; // a "landed" answer arriving AFTER the cancellation must not count
		};
		const out = await postForge(
			"http://forge/api/v1/repos/o/r/issues/1/comments",
			{ method: "POST", headers, body: "{}", signal: controller.signal },
			{ fetchImpl: f.impl, sleep: r.sleep, log: r.log, alreadyApplied: probe, attempts: 20 },
		);
		expect(probeSignalAborted).toBe(true);
		expect(f.calls()).toBe(1);
		expect(out.ok).toBe(false);
		expect(out.reason).toContain("cancelled while probing");
	});

	test("listProbe ends at the caller's signal, not only at its own deadline", async () => {
		const outer = new AbortController();
		let fetchAborted = false;
		const impl = ((_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					fetchAborted = true;
					reject(new DOMException("probe aborted", "AbortError"));
				});
				setTimeout(() => outer.abort(), 5);
			})) as unknown as typeof fetch;
		const probe = listProbe<{ body?: unknown }>(
			"http://forge/api/v1/repos/o/r/issues/1/comments",
			{ headers, timeoutMs: 10_000 },
			() => true,
			impl,
		);
		expect(await probe(outer.signal)).toBe(false);
		expect(fetchAborted).toBe(true);
	});

	test("a probe that hangs is abandoned at its deadline and counts as not proven", async () => {
		let aborted = false;
		const impl = ((_url: string, init: RequestInit) =>
			new Promise<Response>((_resolve, reject) => {
				init.signal?.addEventListener("abort", () => {
					aborted = true;
					reject(new DOMException("hung probe aborted", "AbortError"));
				});
			})) as unknown as typeof fetch;
		const probe = listProbe<{ body?: unknown }>(
			"http://forge/api/v1/repos/o/r/issues/1/comments",
			{ headers, timeoutMs: 20 },
			() => true,
			impl,
		);
		expect(await probe()).toBe(false);
		expect(aborted).toBe(true);
	});

	test("hasIdenticalComment compares the body byte for byte", () => {
		const rows = [{ body: "a" }, { body: "the body" }, { id: 3 }];
		expect(hasIdenticalComment(rows, "the body")).toBe(true);
		expect(hasIdenticalComment(rows, "the body ")).toBe(false);
		expect(hasIdenticalComment([], "x")).toBe(false);
	});

	test("hasIdenticalStatus compares context, state (the list's 'status'), description and target_url", () => {
		const want = {
			context: "factory/pr-review",
			state: "success",
			description: "pr-review: no blocking findings",
			target_url: "http://forge/run/1",
		};
		const same = { ...want, status: want.state, state: undefined };
		expect(hasIdenticalStatus([same], want)).toBe(true);
		expect(hasIdenticalStatus([{ ...same, status: "failure" }], want)).toBe(false);
		expect(hasIdenticalStatus([{ ...same, description: "other" }], want)).toBe(false);
		expect(hasIdenticalStatus([{ ...same, target_url: "http://forge/run/2" }], want)).toBe(false);
		// The POST's field name never matches the list's.
		expect(hasIdenticalStatus([{ ...want }], want)).toBe(false);
	});

	test("listProbe GETs with the caller's headers and proves only a list that contains the write", async () => {
		const seen: { url: string; init: RequestInit }[] = [];
		const replies: (Response | Error)[] = [
			new Response(JSON.stringify([{ body: "other" }]), { status: 200 }),
			new Response(JSON.stringify([{ body: "mine" }]), { status: 200 }),
			new Response("down", { status: 502 }),
			new Response(JSON.stringify({ message: "not a list" }), { status: 200 }),
		];
		const impl = (async (url: string, init: RequestInit) => {
			seen.push({ url, init });
			const next = replies.shift();
			if (next === undefined || next instanceof Error) throw next ?? new Error("unscripted");
			return next;
		}) as unknown as typeof fetch;
		const probe = listProbe<{ body?: unknown }>(
			"http://forge/api/v1/repos/o/r/issues/1/comments?since=x",
			{ headers },
			(rows) => hasIdenticalComment(rows, "mine"),
			impl,
		);
		expect(await probe()).toBe(false);
		expect(await probe()).toBe(true);
		expect(await probe()).toBe(false);
		expect(await probe()).toBe(false);
		expect(seen[0]?.init.method).toBe("GET");
		expect(seen[0]?.init.headers).toEqual(headers);
		expect(seen[0]?.init.body).toBeUndefined();
	});
});

describe("one attempt is bounded by a deadline", () => {
	test("a hung attempt is abandoned at the attempt timeout and re-asked", async () => {
		const aborted: boolean[] = [];
		let calls = 0;
		const impl = (async (_url: string, init: RequestInit) => {
			calls += 1;
			if (calls === 1) {
				// Never settles on its own: only the signal ends it.
				return await new Promise<Response>((_resolve, reject) => {
					init.signal?.addEventListener("abort", () => {
						aborted.push(true);
						reject(init.signal?.reason ?? new Error("aborted"));
					});
				});
			}
			return new Response("", { status: 201 });
		}) as unknown as typeof fetch;
		const r = recorder();
		const started = performance.now();
		const out = await postForge(
			"http://forge/api/v1/x",
			{ method: "POST", headers, body: "{}" },
			{ fetchImpl: impl, sleep: r.sleep, log: r.log, attemptTimeoutMs: 20 },
		);
		expect(out.ok).toBe(true);
		expect(out.attempt).toBe(2);
		expect(aborted).toEqual([true]);
		expect(performance.now() - started).toBeLessThan(5_000);
		expect(r.logs[0]).toContain("attempt timed out after 20 ms");
	});

	test("a signal already aborted before the write sends nothing at all", async () => {
		// Before round 5 this test pinned TWO attempts under an aborted signal —
		// the retry loop the review named. A cancelled write now sends nothing.
		const outer = new AbortController();
		outer.abort(new Error("caller cancelled"));
		const f = scriptedFetch([new Error("never reached")]);
		const r = recorder();
		const out = await postForge(
			"http://forge/api/v1/x",
			{ method: "POST", headers, body: "{}", signal: outer.signal },
			{ fetchImpl: f.impl, sleep: r.sleep, log: r.log, attempts: 2 },
		);
		expect(out).toMatchObject({ ok: false, attempt: 0 });
		expect(f.calls()).toBe(0);
		expect(r.slept).toEqual([]);
		expect(out.reason).toContain("caller cancelled");
	});
});
