import { describe, expect, test } from "bun:test";
import type { ForgeClient, ForgePage, ForgeResponse } from "../../src/forge/boundary";
import type { JevResult } from "../../src/jev/client";
import {
	CRITICAL_ALERT_TITLE_PREFIX,
	type CriticalAlertTarget,
	raiseCriticalAlert,
} from "../../src/observability/critical-alert";

/**
 * A counting fake forge client. Only `getPage` (the marker dedupe scan) and
 * `write` (the issue POST) are exercised; every other verb on the boundary
 * throws, so a path that reaches for one fails the test loudly rather than
 * silently widening the alert's forge surface.
 */
function fakeClient(
	opts: { existingBodies?: string[]; throwOnWrite?: boolean; pullRequestNull?: boolean } = {},
): {
	client: ForgeClient;
	writes: Array<{ method: string; path: string; body: unknown }>;
	reads: string[];
} {
	const writes: Array<{ method: string; path: string; body: unknown }> = [];
	const reads: string[] = [];
	const bodies = opts.existingBodies ?? [];
	const client = {
		provider: "forgejo",
		get: () => {
			throw new Error("get() must not be called by the alert path");
		},
		getPage: <T>(pathOrUrl: string): Promise<ForgePage<T>> => {
			reads.push(pathOrUrl);
			return Promise.resolve({
				body: bodies.map((body, i) => ({
					id: i + 1,
					number: i + 1,
					body,
					// Forgejo's shape for a plain issue: the field present, null.
					...(opts.pullRequestNull === true ? { pull_request: null } : {}),
				})) as unknown as T,
				next: null,
			});
		},
		paginate: () => {
			throw new Error("paginate() must not be called by the alert path");
		},
		write: <T>(method: string, path: string, body?: unknown): Promise<ForgeResponse<T>> => {
			writes.push({ method, path, body });
			if (opts.throwOnWrite === true) throw new Error("forge exploded");
			const number = writes.length;
			// Record the created issue so a later scan in the same fake dedupes on it.
			bodies.push(String((body as { body?: string }).body ?? ""));
			return Promise.resolve({
				status: 201,
				data: { number, id: number } as unknown as T,
				link: null,
				rateRemaining: null,
			});
		},
		postCommitCheck: () => {
			throw new Error("postCommitCheck() must not be called by the alert path");
		},
		findCommitCheck: () => {
			throw new Error("findCommitCheck() must not be called by the alert path");
		},
	} as unknown as ForgeClient;
	return { client, writes, reads };
}

/** Every target carries an offline Jev ask so no test reaches the network. */
function target(client: ForgeClient): CriticalAlertTarget {
	return {
		repository: "rodaddy/software-factory",
		client: () => Promise.resolve(client),
		ask: () => Promise.resolve({ ok: false, error: "offline test", ms: 0 }),
	};
}

describe("raiseCriticalAlert", () => {
	test("opens an issue titled [monitoring-critical] <class> when alerting is configured", async () => {
		const fake = fakeClient();
		await raiseCriticalAlert(target(fake.client), {
			alertClass: "reconcile pass error",
			cause: "boom: the widget fell off",
		});
		expect(fake.writes).toHaveLength(1);
		expect(fake.writes[0]?.method).toBe("POST");
		expect(fake.writes[0]?.path).toBe("/repos/rodaddy/software-factory/issues");
		const body = fake.writes[0]?.body as { title: string; body: string };
		expect(body.title.startsWith(CRITICAL_ALERT_TITLE_PREFIX)).toBe(true);
		expect(body.title).toContain("reconcile pass error");
		expect(body.body).toContain("boom: the widget fell off");
	});

	test("the SAME failure twice opens exactly ONE issue", async () => {
		const fake = fakeClient();
		const failure = { alertClass: "reconcile pass error", cause: "boom: the widget fell off" };
		await raiseCriticalAlert(target(fake.client), failure);
		await raiseCriticalAlert(target(fake.client), failure);
		expect(fake.writes).toHaveLength(1);
	});

	test("an existing alert issue carrying pull_request: null dedupes", async () => {
		const fake = fakeClient({ pullRequestNull: true });
		const failure = { alertClass: "reconcile pass error", cause: "boom" };
		await raiseCriticalAlert(target(fake.client), failure);
		const second = await raiseCriticalAlert(target(fake.client), failure);
		expect(second).toEqual({ delivered: true, how: "deduped" });
		expect(fake.writes).toHaveLength(1);
	});

	test("an undefined target makes ZERO forge calls (off by default) and reports unconfigured", async () => {
		const fake = fakeClient();
		const delivery = await raiseCriticalAlert(undefined, {
			alertClass: "reconcile pass error",
			cause: "boom",
		});
		expect(fake.writes).toHaveLength(0);
		expect(fake.reads).toHaveLength(0);
		// Each undelivered shape names its own cause: a caller deciding whether to
		// retry needs the cause, not just the verdict (`failed` is pinned below).
		expect(delivery).toEqual({ delivered: false, why: "unconfigured" });
	});

	test("a throwing forge call does not propagate, and REPORTS it never landed", async () => {
		// It still must not throw — the caller is an error sink mid-pass. What it
		// additionally must do is SAY the alert was not delivered, because a caller
		// that latches on having alerted would otherwise latch on a forge outage
		// and go permanently silent.
		const fake = fakeClient({ throwOnWrite: true });
		const delivery = await raiseCriticalAlert(target(fake.client), {
			alertClass: "reconcile pass error",
			cause: "boom",
		});
		expect(delivery).toEqual({ delivered: false, why: "failed" });
	});

	test("a throwing client resolver does not propagate, and REPORTS it never landed", async () => {
		const delivery = await raiseCriticalAlert(
			{
				repository: "rodaddy/software-factory",
				client: () => Promise.reject(new Error("no credential")),
			},
			{ alertClass: "reconcile pass error", cause: "boom" },
		);
		expect(delivery).toEqual({ delivered: false, why: "failed" });
	});

	test("a successful post reports delivered/opened", async () => {
		const fake = fakeClient();
		const delivery = await raiseCriticalAlert(target(fake.client), {
			alertClass: "reconcile pass error",
			cause: "boom",
		});
		expect(delivery).toEqual({ delivered: true, how: "opened" });
		expect(fake.writes).toHaveLength(1);
	});

	test("the two dedupe outcomes do NOT report the same delivery", async () => {
		// This is the distinction the drought latch turns on, and collapsing it is
		// how the original bug reads as correct.
		//
		// `found` -- an issue for this class is open on the forge RIGHT NOW. Nothing
		//   was posted, but the operator can see it, so this IS delivered.
		// `indeterminate` -- the scan could not prove absence and deliberately
		//   posted NOTHING. Nobody has been shown anything, so it is NOT delivered,
		//   however much it resembles the case above from the outside.
		const seeded = fakeClient();
		await raiseCriticalAlert(target(seeded.client), {
			alertClass: "reconcile pass error",
			cause: "first",
		});
		const second = await raiseCriticalAlert(target(seeded.client), {
			alertClass: "reconcile pass error",
			cause: "second, same class",
		});
		expect(second).toEqual({ delivered: true, how: "deduped" });
		// Deduped means exactly one issue exists, not two.
		expect(seeded.writes).toHaveLength(1);

		// A scan that cannot prove absence: the page body is not an array.
		const unprovable = {
			provider: "forgejo",
			getPage: () => Promise.resolve({ body: { not: "an array" }, next: null }),
			write: () => {
				throw new Error("must not post when absence is unproven");
			},
		} as unknown as ForgeClient;
		const indeterminate = await raiseCriticalAlert(target(unprovable), {
			alertClass: "reconcile pass error",
			cause: "boom",
		});
		expect(indeterminate).toEqual({ delivered: false, why: "indeterminate" });
	});

	test("the issue body carries the bounded cause only — no config, no token", async () => {
		const fake = fakeClient();
		await raiseCriticalAlert(target(fake.client), {
			alertClass: "reconcile pass error",
			cause: "bounded cause text",
		});
		const posted = fake.writes[0]?.body as { body: string } | undefined;
		expect(posted).toBeDefined();
		const body = posted?.body ?? "";
		expect(body).toContain("bounded cause text");
		expect(body.length).toBeLessThan(2_000);
	});

	test("a cause carrying a code fence cannot break out of the block", async () => {
		// The cause is NOT trusted text: `errorMessage()` returns a thrown value's
		// message verbatim and the reconcile pass handles repository content, so a
		// managed repository can put a fence in front of this. Unescaped, it would
		// close the block early and render the remainder as issue markup.
		const fake = fakeClient();
		await raiseCriticalAlert(target(fake.client), {
			alertClass: "reconcile pass error",
			cause: "```\n### injected heading\n[link](https://evil.example)\n```",
		});
		const body = (fake.writes[0]?.body as { body: string } | undefined)?.body ?? "";
		// Exactly the two fences this module opens and closes itself.
		expect(body.match(/^```/gm)?.length).toBe(2);
		expect(body).not.toContain("```\n### injected heading");
	});
});

/** Let the un-awaited alert promise inside `defaultOnError` settle. */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 5));
}

/**
 * Wait until `done()` holds, polling every 5 ms, failing after `ms`. A fixed
 * sleep is not enough to know the un-awaited alert reached the forge: under
 * a loaded runner the first alert had not written yet when the second one
 * scanned, so the test saw the wrong issue count (flaky on PRs 1321, 1326).
 */
async function until(done: () => boolean, ms = 2_000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!done()) {
		if (Date.now() > deadline) throw new Error(`condition not met within ${ms} ms`);
		await settle();
	}
}

describe("defaultOnError wiring", () => {
	test("with NO alert target configured, the error sink makes zero forge calls", async () => {
		const { defaultOnError, setCriticalAlertTarget } = await import(
			"../../src/observability/critical-alert"
		);
		const fake = fakeClient();
		setCriticalAlertTarget(undefined);
		defaultOnError(new Error("repo dispatch blew up"));
		await settle();
		expect(fake.writes).toHaveLength(0);
		expect(fake.reads).toHaveLength(0);
	});

	test("with a target configured, the error sink opens ONE issue for repeated failures", async () => {
		const { defaultOnError, setCriticalAlertTarget } = await import(
			"../../src/observability/critical-alert"
		);
		const fake = fakeClient();
		setCriticalAlertTarget(target(fake.client));
		try {
			defaultOnError(new Error("repo dispatch blew up"));
			await until(() => fake.writes.length >= 1);
			defaultOnError(new Error("a DIFFERENT message, same failure class"));
			// The second alert's dedupe scan is the second read; a wrong second
			// write would follow it, so give it the old settle window after that.
			await until(() => fake.reads.length >= 2);
			await settle();
			expect(fake.writes).toHaveLength(1);
			const body = fake.writes[0]?.body as { title: string; body: string };
			expect(body.title).toBe(`${CRITICAL_ALERT_TITLE_PREFIX}reconcile pass error`);
			expect(body.body).toContain("repo dispatch blew up");
		} finally {
			setCriticalAlertTarget(undefined);
		}
	});

	test("the error sink never throws, even when the forge does", async () => {
		const { defaultOnError, setCriticalAlertTarget } = await import(
			"../../src/observability/critical-alert"
		);
		const fake = fakeClient({ throwOnWrite: true });
		setCriticalAlertTarget(target(fake.client));
		try {
			expect(() => defaultOnError(new Error("boom"))).not.toThrow();
			await settle();
		} finally {
			setCriticalAlertTarget(undefined);
		}
	});
});

describe("critical alert D4 triage line", () => {
	type AskFields = Record<string, string>;
	function fakeAsk(result: JevResult | "throw"): {
		ask: NonNullable<CriticalAlertTarget["ask"]>;
		calls: AskFields[];
	} {
		const calls: AskFields[] = [];
		const ask = (state: unknown): Promise<JevResult> => {
			calls.push(state as AskFields);
			if (result === "throw") return Promise.reject(new Error("jev exploded"));
			return Promise.resolve(result);
		};
		return { ask, calls };
	}
	const noul = (value: number): JevResult => ({
		ok: true,
		answers: { "monitoring-triage": { type: "noul", noul: value } },
		ms: 1,
		inputTokens: 10,
	});
	function triageTarget(
		client: ForgeClient,
		ask: NonNullable<CriticalAlertTarget["ask"]>,
		now?: () => Date,
	): CriticalAlertTarget {
		return { ...target(client), ask, ...(now === undefined ? {} : { now }) };
	}
	const postedBody = (fake: ReturnType<typeof fakeClient>): string =>
		String((fake.writes[0]?.body as { body?: string } | undefined)?.body);
	const failure = { alertClass: "reconcile pass error", cause: "The operation timed out." };

	test("reconcile pass error opened with a yes answer carries the EXPECTED line", async () => {
		const fake = fakeClient();
		await raiseCriticalAlert(triageTarget(fake.client, fakeAsk(noul(0.95)).ask), failure);
		expect(postedBody(fake)).toContain(
			"jev monitoring-triage v1 (advisory): EXPECTED 0.95 (known maintenance or transient outage)",
		);
	});

	test("a no answer carries INVESTIGATE", async () => {
		const fake = fakeClient();
		await raiseCriticalAlert(triageTarget(fake.client, fakeAsk(noul(0.05)).ask), failure);
		expect(postedBody(fake)).toContain(
			"jev monitoring-triage v1 (advisory): INVESTIGATE 0.95 (a real stall or defect)",
		);
	});

	test("a failed ask carries NO_SIGNAL and the issue still opens", async () => {
		const fake = fakeClient();
		const ask = fakeAsk({ ok: false, error: "no TYPESAFE_API_KEY", ms: 0 }).ask;
		const delivery = await raiseCriticalAlert(triageTarget(fake.client, ask), failure);
		expect(delivery).toEqual({ delivered: true, how: "opened" });
		expect(postedBody(fake)).toContain(
			"jev monitoring-triage v1 (advisory): NO_SIGNAL (no Jev signal)",
		);
	});

	test("an ask that throws still opens the issue", async () => {
		const fake = fakeClient();
		const delivery = await raiseCriticalAlert(
			triageTarget(fake.client, fakeAsk("throw").ask),
			failure,
		);
		expect(delivery).toEqual({ delivered: true, how: "opened" });
		expect(postedBody(fake)).toContain(
			"jev monitoring-triage v1 (advisory): NO_SIGNAL (no Jev signal)",
		);
	});

	test("a deduped class makes no Jev call", async () => {
		const fake = fakeClient({
			existingBodies: ["<!-- software-factory:critical-alert:reconcile-pass-error -->"],
		});
		const spy = fakeAsk(noul(0.95));
		const delivery = await raiseCriticalAlert(triageTarget(fake.client, spy.ask), failure);
		expect(delivery).toEqual({ delivered: true, how: "deduped" });
		expect(spy.calls).toHaveLength(0);
	});

	test("another alert class gets no line and no Jev call", async () => {
		const fake = fakeClient();
		const spy = fakeAsk(noul(0.95));
		await raiseCriticalAlert(triageTarget(fake.client, spy.ask), {
			alertClass: "scale drought",
			cause: "runner scale-up skipped",
		});
		expect(spy.calls).toHaveLength(0);
		expect(postedBody(fake)).not.toContain("jev ");
	});

	test("the utc_time field is HH:MM UTC from the injected clock", async () => {
		const fake = fakeClient();
		const spy = fakeAsk(noul(0.95));
		await raiseCriticalAlert(
			triageTarget(fake.client, spy.ask, () => new Date("2026-09-26T03:23:37Z")),
			failure,
		);
		expect(spy.calls).toHaveLength(1);
		expect(spy.calls[0]?.utc_time).toBe("03:23 UTC");
		expect(spy.calls[0]?.alert_class).toBe("reconcile pass error");
		expect(spy.calls[0]?.cause).toBe("The operation timed out.");
	});

	test("an invalid clock still opens the issue, with no triage line (PR 1098 review)", async () => {
		const fake = fakeClient();
		const delivery = await raiseCriticalAlert(
			triageTarget(fake.client, fakeAsk(noul(0.95)).ask, () => new Date(Number.NaN)),
			failure,
		);
		expect(delivery).toEqual({ delivered: true, how: "opened" });
		expect(postedBody(fake)).not.toContain("jev ");
	});
});
