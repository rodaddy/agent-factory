/**
 * `validateBinding` and an ABSENT `repo_provider`.
 *
 * sf#812 removed the silent `github` default: `parseProvider` now fails closed to
 * null on an absent label, so a board task row with no `repo_provider` is refused
 * instead of binding as GitHub. The refusal must be NAMED — a WARN line carrying
 * the task id — so a row that used to bind and now does not is visible in the log.
 */

import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import type { WatcherConfig } from "../../src/config/schema";
import type { KboardTask } from "../../src/kboard/client";
import { validateBinding } from "../../src/kboard/ready-gate";

function config(): WatcherConfig {
	return {
		poll_interval_minutes: 15,
		repositories: [{ name: "rodaddy/x", provider: "forgejo", checks: "standard" }],
		job_templates: [],
	} as unknown as WatcherConfig;
}

function task(over: Record<string, unknown> = {}): KboardTask {
	return {
		task_id: "t_812",
		title: "Implement the thing",
		status: "ready",
		sync_version: 1,
		assignee: null,
		repo_full_name: "rodaddy/x",
		repo_item_number: 42,
		...over,
	} as unknown as KboardTask;
}

/** Capture the NDJSON log lines `log()` writes to stderr while `run` executes. */
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
		.flatMap((line) => {
			try {
				return [JSON.parse(line) as Record<string, unknown>];
			} catch {
				return [];
			}
		});
}

describe("validateBinding: repo_provider absent", () => {
	test("a task with no repo_provider is refused and the refusal is logged at warn", () => {
		let result: ReturnType<typeof validateBinding> | undefined;
		const lines = captureLogs(() => {
			result = validateBinding(task(), config());
		});

		expect(result).toBeNull();
		const warn = lines.find((l) => l.msg === "kboard.binding_refused");
		expect(warn).toBeDefined();
		expect(warn?.level).toBe("warn");
		expect(warn?.task_id).toBe("t_812");
		expect(warn?.reason).toBe("repo_provider absent; refusing to bind (sf#812)");
	});

	test("a task with repo_provider forgejo on a managed repository binds", () => {
		let result: ReturnType<typeof validateBinding> | undefined;
		const lines = captureLogs(() => {
			result = validateBinding(task({ repo_provider: "forgejo" }), config());
		});

		expect(result).not.toBeNull();
		expect(result?.repository).toBe("rodaddy/x");
		expect(result?.itemNumber).toBe(42);
		expect(lines.find((l) => l.msg === "kboard.binding_refused")).toBeUndefined();
	});
});
