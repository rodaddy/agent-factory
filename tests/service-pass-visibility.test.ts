import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import type { PassResult } from "../src/reconcile/pass";
import { logRepoFailures, summarize } from "../src/service";

/**
 * #252: `runPass` captures a bounded, secret-free `error` on every failed
 * `RepoPassResult`, and the pass summary reported only the COUNT — so on the watcher host
 * "1 failed" named no repository for ten days. The pass knew exactly which repo
 * broke and threw it away one function call from the operator.
 */
function result(overrides: Partial<PassResult> = {}): PassResult {
	return {
		startedAt: "2099-04-01T00:00:00.000Z",
		durationMs: 1234,
		repositories: [],
		okCount: 0,
		failCount: 0,
		...overrides,
	};
}

describe("summarize", () => {
	test("a clean pass keeps the EXACT line it has always emitted", () => {
		// The absence control (done-means README rule 21): a visibility change must
		// not add noise to the healthy path, which is every pass on a working
		// watcher. Anything parsing the clean case sees no change.
		expect(
			summarize(
				result({
					okCount: 6,
					failCount: 0,
					repositories: [{ repository: "rodaddy/a", ok: true, itemsSeen: 0, jobsCreated: 0 }],
				}),
			),
		).toBe("reconcile pass: 6 ok, 0 failed, 1234ms");
	});

	test("NAMES the repository behind a fail count", () => {
		const line = summarize(
			result({
				okCount: 6,
				failCount: 1,
				repositories: [
					{ repository: "rodaddy/fine", ok: true, itemsSeen: 3, jobsCreated: 0 },
					{
						repository: "rodaddy/broken",
						ok: false,
						itemsSeen: 0,
						jobsCreated: 0,
						error: "forge credential unavailable",
					},
				],
			}),
		);
		expect(line).toContain("6 ok, 1 failed");
		expect(line).toContain("rodaddy/broken");
		expect(line).toContain("forge credential unavailable");
		// A successful repository is not named — only failures earn a mention.
		expect(line).not.toContain("rodaddy/fine");
	});

	test("names EVERY failed repository, not just the first", () => {
		const line = summarize(
			result({
				okCount: 0,
				failCount: 2,
				repositories: [
					{ repository: "rodaddy/one", ok: false, itemsSeen: 0, jobsCreated: 0, error: "boom" },
					{ repository: "rodaddy/two", ok: false, itemsSeen: 0, jobsCreated: 0, error: "bang" },
				],
			}),
		);
		expect(line).toContain("rodaddy/one: boom");
		expect(line).toContain("rodaddy/two: bang");
	});

	test("a repository with an empty error string adds no dangling detail", () => {
		expect(
			summarize(
				result({
					okCount: 1,
					failCount: 0,
					repositories: [
						{ repository: "rodaddy/a", ok: true, itemsSeen: 0, jobsCreated: 0, error: "" },
					],
				}),
			),
		).toBe("reconcile pass: 1 ok, 0 failed, 1234ms");
	});
});

describe("logRepoFailures", () => {
	/**
	 * Capture the NDJSON log lines `fn` emits, at the DESCRIPTOR level — the idiom
	 * `tests/service-runonce.test.ts` and `tests/kboard/client.test.ts` already
	 * use. Post-#88 pino writes synchronously to fd 2 via `fs.writeSync`, NOT
	 * through `process.stderr.write`, so a `process.stderr` spy sees nothing and
	 * every assertion on log content passes VACUOUSLY. Observed here: the spy
	 * version of this helper reported zero lines while the events were plainly
	 * printing to the terminal.
	 */
	function captureLogs(run: () => void): Record<string, unknown>[] {
		const raw: string[] = [];
		const realWriteSync = fs.writeSync;
		(fs as { writeSync: typeof fs.writeSync }).writeSync = ((
			fd: number,
			data: string | NodeJS.ArrayBufferView,
			...rest: unknown[]
		) => {
			if (fd === 2) {
				const text = typeof data === "string" ? data : Buffer.from(data as Uint8Array).toString();
				raw.push(text);
				return typeof data === "string" ? Buffer.byteLength(text) : (data as Uint8Array).length;
			}
			return (realWriteSync as (...a: unknown[]) => number)(fd, data, ...rest);
		}) as typeof fs.writeSync;
		try {
			run();
		} finally {
			(fs as { writeSync: typeof fs.writeSync }).writeSync = realWriteSync;
		}
		return raw
			.join("")
			.split("\n")
			.filter((line) => line.trim().length > 0)
			.map((line) => JSON.parse(line) as Record<string, unknown>);
	}

	test("emits one event per failed repository, with the repository as its own field", () => {
		const lines = captureLogs(() => {
			logRepoFailures(
				result({
					okCount: 1,
					failCount: 2,
					repositories: [
						{ repository: "rodaddy/ok", ok: true, itemsSeen: 0, jobsCreated: 0 },
						{ repository: "rodaddy/one", ok: false, itemsSeen: 0, jobsCreated: 0, error: "boom" },
						{ repository: "rodaddy/two", ok: false, itemsSeen: 0, jobsCreated: 0, error: "bang" },
					],
				}),
			);
		});
		const events = lines.filter((line) => line.msg === "reconcile.pass.repo_failed");
		// EXACTLY two: the successful repository must not produce a line.
		expect(events).toHaveLength(2);
		// The repository is its OWN field, not buried in a message string, so a
		// query can group failures by repo.
		expect(events.map((e) => e.repository)).toEqual(["rodaddy/one", "rodaddy/two"]);
		expect(events.map((e) => e.cause)).toEqual(["boom", "bang"]);
	});

	test("a clean pass emits NOTHING — the absence control", () => {
		const lines = captureLogs(() => {
			logRepoFailures(
				result({
					okCount: 2,
					failCount: 0,
					repositories: [
						{ repository: "rodaddy/a", ok: true, itemsSeen: 0, jobsCreated: 0 },
						{ repository: "rodaddy/b", ok: true, itemsSeen: 0, jobsCreated: 0 },
					],
				}),
			);
		});
		expect(lines.filter((line) => line.msg === "reconcile.pass.repo_failed")).toHaveLength(0);
	});
});
