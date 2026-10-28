/**
 * @module tests/actions/log
 * @description The Actions-lane logger honors FACTORY_LOG_LEVEL (708c):
 *   one JSON line per event, `debug` dropped unless the level is `debug`, and an
 *   absent or unknown level reads as `info`.
 */
import { describe, expect, test } from "bun:test";
import { createActionLog, laneLogLevel } from "../../scripts/actions/log";

function capture(env: Record<string, string | undefined>) {
	const lines: string[] = [];
	const log = createActionLog(env as NodeJS.ProcessEnv, (line) => lines.push(line));
	return { log, lines };
}

describe("actions log", () => {
	test("debug is dropped at info, and info/warn/error are kept as JSON lines", () => {
		const { log, lines } = capture({ FACTORY_LOG_LEVEL: "info" });
		log.debug("lane.detail", { request_bytes: 10 });
		log.info("lane.step", { step: "render" });
		log.warn("lane.slow");
		log.error("lane.failed");
		expect(lines).toHaveLength(3);
		const first = JSON.parse(lines[0] ?? "");
		expect(first).toMatchObject({ level: "info", msg: "lane.step", step: "render" });
		expect(lines.every((l) => l.endsWith("\n") && l.indexOf("\n") === l.length - 1)).toBe(true);
	});

	test("debug is kept at debug", () => {
		const { log, lines } = capture({ FACTORY_LOG_LEVEL: "debug" });
		log.debug("lane.detail", { request_bytes: 10 });
		expect(lines).toHaveLength(1);
		expect(JSON.parse(lines[0] ?? "")).toMatchObject({
			level: "debug",
			msg: "lane.detail",
			request_bytes: 10,
		});
	});

	test("an absent or unknown level is info", () => {
		for (const env of [
			{},
			{ FACTORY_LOG_LEVEL: "trace" },
			{ FACTORY_LOG_LEVEL: "DEBUG " },
			{ FACTORY_LOG_LEVEL: "" },
		]) {
			expect(laneLogLevel(env as NodeJS.ProcessEnv)).toBe("info");
			const { log, lines } = capture(env);
			log.debug("lane.detail");
			expect(lines).toHaveLength(0);
		}
		expect(laneLogLevel({ FACTORY_LOG_LEVEL: "debug" } as NodeJS.ProcessEnv)).toBe("debug");
	});
});
