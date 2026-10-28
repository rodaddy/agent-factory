/**
 * @module tests/fleet/pi-stdout-filter
 * @description `fleet/bin/pi-stdout-filter`, run as a real child
 *   process. The fixture `tests/fixtures/pi-stream/pi-run.jsonl` is a real Pi
 *   `--mode json` stream from a fleet host run log (strings capped, secrets
 *   scrubbed, agent_end rebuilt from the run's message_end events because the
 *   run log truncates it). Parity is checked against vendored copies of both
 *   Paperclip parsers that read this stream: the server `parsePiJsonl`
 *   (summary, errors, usage, cost) and the UI `parsePiStdoutLine` (the board
 *   transcript, read from the run-log file). `PI_STDOUT_FILTER_UNDER_TEST`
 *   points the suite at a mutated copy of the script.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SCRIPT =
	process.env.PI_STDOUT_FILTER_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/bin/pi-stdout-filter");
const FIXTURES = resolve(import.meta.dir, "../fixtures/pi-stream");

type ServerParser = { parsePiJsonl: (stdout: string) => unknown };
type UiParser = {
	parsePiStdoutLine: (line: string, ts: string) => unknown[];
	resetParserState: () => void;
};

let server: ServerParser;
let ui: UiParser;
let full = "";
let filtered = "";

function runFilter(input: string | Uint8Array): { out: Buffer; code: number | null } {
	const proc = Bun.spawnSync([SCRIPT], {
		stdin: Buffer.from(input),
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: Buffer.from(proc.stdout), code: proc.exitCode };
}

function uiEntries(stdout: string): unknown[] {
	ui.resetParserState();
	return stdout
		.split("\n")
		.filter((line) => line.length > 0)
		.flatMap((line) => ui.parsePiStdoutLine(line, "ts"));
}

beforeAll(async () => {
	server = (await import(resolve(FIXTURES, "paperclip-parse.js"))) as ServerParser;
	ui = (await import(resolve(FIXTURES, "paperclip-parse-stdout.js"))) as UiParser;
	full = readFileSync(resolve(FIXTURES, "pi-run.jsonl"), "utf8");
	const run = runFilter(full);
	expect(run.code).toBe(0);
	filtered = run.out.toString("utf8");
});

describe("pi-stdout-filter on a real Pi stream", () => {
	test("Paperclip's server parser reads the same result from the filtered stream", () => {
		expect(server.parsePiJsonl(filtered)).toEqual(server.parsePiJsonl(full));
	});

	test("the board transcript parser yields the same entries", () => {
		expect(uiEntries(filtered)).toEqual(uiEntries(full));
	});

	test("the filtered stream is smaller", () => {
		expect(Buffer.byteLength(filtered)).toBeLessThan(Buffer.byteLength(full));
	});

	test("every kept line is byte-identical and in order", () => {
		const fullLines = full.split("\n");
		let i = 0;
		for (const line of filtered.split("\n")) {
			while (i < fullLines.length && fullLines[i] !== line) i++;
			expect(i).toBeLessThan(fullLines.length);
			i++;
		}
	});
});

describe("pi-stdout-filter line rules", () => {
	test("drops the never-read types and update events, keeps the rest", () => {
		const lines = [
			'{"type":"turn_start"}',
			'{"type":"message_start","message":{"role":"user","content":"x"}}',
			'{"type":"tool_execution_update","toolCallId":"t1","partialResult":"y"}',
			'{"type":"message_update","assistantMessageEvent":{"type":"toolcall_delta","delta":"{"}}',
			'{"type":"message_update","assistantMessageEvent":{"type":"text_start"}}',
		];
		const kept = [
			'{"type":"message_update","assistantMessageEvent":{"type":"text_delta","delta":"hi"}}',
			'{"type":"message_update","assistantMessageEvent":{"type":"thinking_end","content":"z"}}',
			'{"type":"message_start","usage":{"input":1}}',
			'{"type":"turn_end","message":{"role":"assistant","content":"hi"}}',
			'{"type":"message_end","message":{"role":"assistant","content":"hi"}}',
			'{"type":"session","id":"s"}',
			'{"type":"some_future_event"}',
			'["message_start"]',
		];
		const run = runFilter(`${[...lines, ...kept].join("\n")}\n`);
		expect(run.code).toBe(0);
		expect(run.out.toString("utf8")).toBe(`${kept.join("\n")}\n`);
	});

	test("non-JSON and a partial last line pass through unchanged", () => {
		const input = 'hello, not json\n{"type":"turn_start"}\n{"type":"turn_e';
		const run = runFilter(input);
		expect(run.code).toBe(0);
		expect(run.out.toString("utf8")).toBe('hello, not json\n{"type":"turn_e');
	});

	test("invalid UTF-8 passes through byte for byte", () => {
		const bad = Uint8Array.from([0x7b, 0xff, 0xfe, 0x7d, 0x0a]);
		const run = runFilter(bad);
		expect(run.code).toBe(0);
		expect([...run.out]).toEqual([...bad]);
	});

	test.each([
		['{"type":[]}'],
		['{"type":{}}'],
		['{"type":"message_update","assistantMessageEvent":{"type":[]}}'],
		['{"type":"message_update","assistantMessageEvent":{"type":{}}}'],
	])("a non-string discriminator passes through, then the next line: %s", (malformed) => {
		const input = `${malformed}\n{"type":"session","id":"s"}\n`;
		const run = runFilter(input);
		expect(run.code).toBe(0);
		expect(run.out.toString("utf8")).toBe(input);
	});

	test("empty input exits 0 with no output", () => {
		const run = runFilter("");
		expect(run.code).toBe(0);
		expect(run.out.length).toBe(0);
	});

	test("a kept line written to a pipe whose reader has exited: exit 141", () => {
		// The line arrives 0.5 s in, long after `true` closed the pipe's read end.
		const proc = Bun.spawnSync([
			"/bin/sh",
			"-c",
			`{ /bin/sleep 0.5; echo '{"type":"session","id":"s"}'; } | { "$0"; echo "exit $?" >&2; } | true`,
			SCRIPT,
		]);
		expect(proc.stderr.toString()).toBe("exit 141\n");
	});
});
