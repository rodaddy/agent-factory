import { describe, expect, test } from "bun:test";
import type { RepoStatus, StatusSnapshot, TracedAttemptStatus } from "../../src/status/query";
import { escapeHtml, renderStatusHtml, repoHealth } from "../../src/status/render";
import { createStatusHandler } from "../../src/status/server";

const NOW = "2026-07-19T18:00:00Z";

function repo(overrides: Partial<RepoStatus> = {}): RepoStatus {
	return {
		repository: "rodaddy/x",
		provider: "forgejo",
		checks: "standard",
		lastSweep: "2026-07-19T17:55:00Z",
		issueCount: 0,
		pullCount: 0,
		jobsPending: 0,
		jobsRunning: 0,
		jobsCompleted: 0,
		jobsFailed: 0,
		lastError: null,
		...overrides,
	};
}

describe("escapeHtml", () => {
	test("escapes markup characters", () => {
		expect(escapeHtml("<script>\"&'")).toBe("&lt;script&gt;&quot;&amp;&#39;");
	});
});

describe("repoHealth", () => {
	test("idle when never swept", () => {
		expect(repoHealth(repo({ lastSweep: null }), 15, NOW)).toBe("idle");
	});
	test("ok when swept recently, no failures", () => {
		expect(repoHealth(repo(), 15, NOW)).toBe("ok");
	});
	test("degraded when jobs failed", () => {
		expect(repoHealth(repo({ jobsFailed: 2 }), 15, NOW)).toBe("degraded");
	});
	test("degraded when a last error is present", () => {
		expect(repoHealth(repo({ lastError: "boom" }), 15, NOW)).toBe("degraded");
	});
	test("stale when the last sweep is older than 2x the interval", () => {
		expect(repoHealth(repo({ lastSweep: "2026-07-19T17:00:00Z" }), 15, NOW)).toBe("stale");
	});

	// #252: an old cursor is TWO different facts depending on whether the
	// reconciliation loop itself is live. Both cases below hold the cursor FIXED
	// and vary only `watcherLive`, so a classifier that ignores the new argument
	// fails one of them whichever way it is hardwired.
	test("quiet — not stale — when the cursor is old but the WATCHER is live", () => {
		expect(repoHealth(repo({ lastSweep: "2026-07-19T17:00:00Z" }), 15, NOW, true)).toBe("quiet");
	});
	test("stale when the cursor is old and the watcher is NOT live", () => {
		expect(repoHealth(repo({ lastSweep: "2026-07-19T17:00:00Z" }), 15, NOW, false)).toBe("stale");
	});
	test("a live watcher does not excuse a FRESH cursor's failures", () => {
		// The split must not swallow the degraded reading: liveness only reclassifies
		// the cursor-age branch.
		expect(repoHealth(repo({ jobsFailed: 2 }), 15, NOW, true)).toBe("degraded");
	});
	test("a live watcher does not turn a never-swept repo into quiet", () => {
		expect(repoHealth(repo({ lastSweep: null }), 15, NOW, true)).toBe("idle");
	});
	test("defaults to the previous behaviour when liveness is unknown", () => {
		// Absent evidence is not evidence of a live loop — the old call signature
		// keeps its old answer.
		expect(repoHealth(repo({ lastSweep: "2026-07-19T17:00:00Z" }), 15, NOW)).toBe("stale");
	});
});

describe("renderStatusHtml", () => {
	test("renders an empty state message", () => {
		const snapshot: StatusSnapshot = {
			generatedAt: NOW,
			repositories: [],
			heldBoxes: [],
			unconfirmedAllocations: [],
			tracedAttempts: [],
		};
		const html = renderStatusHtml(snapshot, 15);
		expect(html).toContain("No repositories reconciled yet");
		expect(html).toContain("<!doctype html>");
	});

	test("renders a repository row with escaped content", () => {
		const snapshot: StatusSnapshot = {
			generatedAt: NOW,
			repositories: [repo({ repository: "rodaddy/<x>", lastError: "<b>bad</b>" })],
			heldBoxes: [],
			unconfirmedAllocations: [],
			tracedAttempts: [],
		};
		const html = renderStatusHtml(snapshot, 15);
		expect(html).toContain("rodaddy/&lt;x&gt;");
		expect(html).toContain("&lt;b&gt;bad&lt;/b&gt;");
		expect(html).not.toContain("<b>bad</b>");
	});
});

describe("createStatusHandler", () => {
	const snapshot: StatusSnapshot = {
		generatedAt: NOW,
		repositories: [repo({ issueCount: 3 })],
		heldBoxes: [],
		unconfirmedAllocations: [],
		tracedAttempts: [],
	};
	const handler = createStatusHandler({
		source: async () => snapshot,
		pollIntervalMinutes: 15,
	});

	test("GET / returns HTML", async () => {
		const res = await handler(new Request("http://localhost/"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("software-factory status");
	});

	test("GET /status.json returns the bounded snapshot", async () => {
		const res = await handler(new Request("http://localhost/status.json"));
		expect(res.status).toBe(200);
		const body = (await res.json()) as StatusSnapshot;
		expect(body.repositories[0]?.issueCount).toBe(3);
	});

	test("unknown path is 404", async () => {
		const res = await handler(new Request("http://localhost/nope"));
		expect(res.status).toBe(404);
	});

	test("non-GET is 405", async () => {
		const res = await handler(new Request("http://localhost/", { method: "POST" }));
		expect(res.status).toBe(405);
	});
});

describe("the Watcher section — process liveness on the page", () => {
	function withLiveness(overrides: Partial<StatusSnapshot>): StatusSnapshot {
		return {
			generatedAt: NOW,
			repositories: [],
			heldBoxes: [],
			unconfirmedAllocations: [],
			tracedAttempts: [],
			...overrides,
		};
	}

	test("omitted entirely when the snapshot carries no liveness record", () => {
		// A caller that drives no scheduler (the doctor probe) shows nothing rather
		// than a false "no pass has ever started".
		const html = renderStatusHtml(withLiveness({}), 15);
		expect(html).not.toContain("<h2>Watcher</h2>");
	});

	test("reports the loop ok when the last pass started recently", () => {
		const html = renderStatusHtml(
			withLiveness({ lastPassStartedAt: "2026-07-19T17:59:00Z", lastPassOk: 6 }),
			15,
		);
		expect(html).toContain("<h2>Watcher</h2>");
		expect(html).toContain("2026-07-19T17:59:00Z");
		expect(html).toContain('<span class="badge ok">ok</span>');
	});

	test("reports the loop stale when the last pass is older than 2x the interval", () => {
		// Differs from the case above in EXACTLY the injected timestamp.
		const html = renderStatusHtml(withLiveness({ lastPassStartedAt: "2026-07-19T17:00:00Z" }), 15);
		expect(html).toContain('<span class="badge stale">stale</span>');
	});

	test("reports the loop stale when no pass has ever started", () => {
		const html = renderStatusHtml(withLiveness({ lastPassStartedAt: null }), 15);
		expect(html).toContain("<h2>Watcher</h2>");
		expect(html).toContain('<span class="badge stale">stale</span>');
	});

	test("NAMES the failed repositories behind the fail count", () => {
		const html = renderStatusHtml(
			withLiveness({
				lastPassStartedAt: NOW,
				lastPassFailCount: 1,
				lastPassRepoErrors: [{ repository: "rodaddy/broken", error: "credential missing" }],
			}),
			15,
		);
		expect(html).toContain("rodaddy/broken");
		expect(html).toContain("credential missing");
	});

	test("escapes repository names and error text in the failures cell", () => {
		const html = renderStatusHtml(
			withLiveness({
				lastPassStartedAt: NOW,
				lastPassRepoErrors: [{ repository: "<script>x</script>", error: "<img onerror=1>" }],
			}),
			15,
		);
		expect(html).not.toContain("<script>x</script>");
		expect(html).toContain("&lt;script&gt;");
		expect(html).toContain("&lt;img onerror=1&gt;");
	});

	test("a LIVE loop reclassifies an old-cursor repository from stale to quiet on the page", () => {
		// The end-to-end split: the same repository row reads differently depending
		// on the process-level fact, and the page computes that fact once.
		const oldCursor = repo({ lastSweep: "2026-07-19T17:00:00Z" });
		const live = renderStatusHtml(
			withLiveness({ repositories: [oldCursor], lastPassStartedAt: "2026-07-19T17:59:00Z" }),
			15,
		);
		expect(live).toContain('<span class="badge quiet">quiet</span>');

		const dead = renderStatusHtml(
			withLiveness({ repositories: [oldCursor], lastPassStartedAt: "2026-07-19T16:00:00Z" }),
			15,
		);
		expect(dead).toContain('<span class="badge stale">stale</span>');
		expect(dead).not.toContain('<span class="badge quiet">quiet</span>');
	});
});

describe("the traced-attempts section — the trace link lives HERE", () => {
	const LANGFUSE = "http://langfuse.example.internal:3000";

	function traced(overrides: Partial<TracedAttemptStatus> = {}): TracedAttemptStatus {
		return {
			attemptId: 455,
			jobId: 1877,
			jobType: "issue-triage",
			repository: "rodaddy/x",
			traceId: "attempt-455-runner-1",
			startedAt: "2026-08-03T21:20:39Z",
			...overrides,
		};
	}

	function snapshot(tracedAttempts: TracedAttemptStatus[]): StatusSnapshot {
		return {
			generatedAt: NOW,
			repositories: [],
			heldBoxes: [],
			unconfirmedAllocations: [],
			tracedAttempts,
		};
	}

	test("THE IMPORTANT ONE: with a base URL the trace id becomes a link", () => {
		// This is the surface the ids-only forge comment points at: the operator
		// reads `Run: job 1877, attempt 455` on the issue and clicks through here.
		const html = renderStatusHtml(snapshot([traced()]), 15, LANGFUSE);
		expect(html).toContain(
			'<a href="http://langfuse.example.internal:3000/trace/attempt-455-runner-1">attempt-455-runner-1</a>',
		);
		expect(html).toContain("Recent traced attempts");
	});

	test("with NO base URL the id renders as PLAIN TEXT, and no anchor at all", () => {
		// The absent-env case is a working page, not a degraded one: the id is what
		// the operator resolves by hand. Asserting the anchor is ABSENT is the half
		// that matters — a link built from an empty base would be a broken relative
		// href that looks clickable.
		const html = renderStatusHtml(snapshot([traced()]), 15);
		expect(html).toContain("attempt-455-runner-1");
		expect(html).not.toContain("<a href=");
		expect(html).not.toContain("langfuse.example.internal");
	});

	test("a non-http base URL yields NO link — an env var cannot inject a scheme", () => {
		// `LANGFUSE_BASE_URL` is operator-supplied environment reaching an `href`, so
		// the scheme is CHECKED, not assumed.
		//
		// THE BASES HERE ALL PARSE, DELIBERATELY. `javascript:alert(1)` was the
		// obvious choice and is WORTHLESS as a probe: `new URL` throws on it, so the
		// catch returns null and the test passes with the scheme check DELETED
		// (verified by mutation). `javascript://evil.com` parses cleanly and yields
		// `javascript://evil.com/trace/...` — a real anchor with a real script
		// scheme — so it exercises the check itself. `file:` and `ftp:` parse too.
		for (const base of ["javascript://evil.com", "file:///etc", "ftp://host/x"]) {
			const html = renderStatusHtml(snapshot([traced()]), 15, base);
			expect(html).not.toContain("<a href=");
			expect(html).not.toContain("javascript:");
			expect(html).not.toContain("file://");
			expect(html).not.toContain("ftp://");
		}
	});

	test("a malformed base URL renders plain ids rather than failing the page", () => {
		const html = renderStatusHtml(snapshot([traced()]), 15, ":::not a url:::");
		expect(html).toContain("attempt-455-runner-1");
		expect(html).not.toContain("<a href=");
	});

	test("no traced attempts omits the section entirely", () => {
		// Guards the assertions above from passing for the wrong reason: a section
		// rendered unconditionally would show an empty table on every fresh watcher.
		const html = renderStatusHtml(snapshot([]), 15, LANGFUSE);
		expect(html).not.toContain("Recent traced attempts");
	});

	test("the trace id is ESCAPED into both the href and the text", () => {
		// Watcher-derived, but it reaches an HTML attribute; the page is the boundary.
		const html = renderStatusHtml(
			snapshot([traced({ traceId: 'attempt-1-"><script>x</script>' })]),
			15,
			LANGFUSE,
		);
		expect(html).not.toContain("<script>x</script>");
		expect(html).toContain("&lt;script&gt;");
	});
});

describe("the Queue health section — reaper gauges on the page", () => {
	function withGauges(overrides: Partial<StatusSnapshot>): StatusSnapshot {
		return {
			generatedAt: NOW,
			repositories: [],
			heldBoxes: [],
			unconfirmedAllocations: [],
			tracedAttempts: [],
			...overrides,
		};
	}

	test("THE IMPORTANT ONE: all three gauges appear on the page", async () => {
		const html = renderStatusHtml(
			withGauges({ zombiePending: 41, oldestDuePendingMinutes: 37, reapedLastSweep: 3 }),
			15,
		);
		expect(html).toContain("<h2>Queue health</h2>");
		expect(html).toContain("41");
		expect(html).toContain("37m");
		expect(html).toContain("3");
	});

	test("a starved queue is badged degraded, a clean one ok", () => {
		// The whole point of the section is that a non-zero zombie count LOOKS
		// different from a zero one; a section that badges both the same trains the
		// operator to skip it.
		const bad = renderStatusHtml(
			withGauges({ zombiePending: 41, oldestDuePendingMinutes: 37, reapedLastSweep: 0 }),
			15,
		);
		expect(bad).toContain('<span class="badge degraded">41</span>');
		const good = renderStatusHtml(
			withGauges({ zombiePending: 0, oldestDuePendingMinutes: null, reapedLastSweep: 0 }),
			15,
		);
		expect(good).toContain('<span class="badge ok">0</span>');
	});

	test("an empty queue renders an em dash for the age, not 0m", () => {
		const html = renderStatusHtml(
			withGauges({ zombiePending: 0, oldestDuePendingMinutes: null, reapedLastSweep: 0 }),
			15,
		);
		expect(html).toContain("<h2>Queue health</h2>");
		// The CELL, not the page: the section copy legitimately says "last 20m".
		expect(html).toContain('<td><span class="muted">—</span></td>');
		expect(html).not.toContain("<td>0m</td>");
	});

	test("omitted entirely for a snapshot that carries no gauges", () => {
		// A `/status.json` captured before sf#482, or the doctor probe's own
		// assembled snapshot, must not take the page down or show false zeros.
		const html = renderStatusHtml(withGauges({}), 15);
		expect(html).not.toContain("<h2>Queue health</h2>");
	});
});
