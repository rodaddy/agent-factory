import { describe, expect, test } from "bun:test";

const command = ["bun", "run", "src/index.ts"];

describe("software-factory CLI", () => {
	test("prints help", () => {
		const result = Bun.spawnSync([...command, "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("Usage: software-factory");
	});

	test("prints version", () => {
		const result = Bun.spawnSync([...command, "--version"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString().trim()).toBe("0.1.0");
	});

	test("advertises prepush status and not the retired gate command", () => {
		const result = Bun.spawnSync([...command, "--help"]);

		expect(result.stdout.toString()).toContain("prepush status");
		expect(result.stdout.toString()).not.toContain("prepush gate");
	});

	test("advertises the deployed-path smoke doctor command", () => {
		const result = Bun.spawnSync([...command, "--help"]);

		expect(result.stdout.toString()).toContain("doctor");
	});

	test("advertises the failed-check re-drive command", () => {
		const result = Bun.spawnSync([...command, "--help"]);

		expect(result.stdout.toString()).toContain("publish redrive-check");
	});

	test("prints doctor usage on doctor --help without crashing", () => {
		const result = Bun.spawnSync([...command, "doctor", "--help"]);

		expect(result.exitCode).toBe(0);
		expect(result.stdout.toString()).toContain("software-factory doctor");
	});

	test("rejects an invalid prepush subcommand without dispatching", () => {
		for (const sub of ["unknown", "gate"]) {
			const gone = Bun.spawnSync([...command, "prepush", sub]);
			expect(gone.exitCode).toBe(2);
		}
		const result = Bun.spawnSync([...command, "prepush", "unknown"]);

		expect(result.exitCode).toBe(2);
		expect(result.stderr.toString()).toContain("Usage: software-factory prepush status <sha>");
	});

	test("rejects unknown arguments, naming the argument as a log event", () => {
		const result = Bun.spawnSync([...command, "--unknown"]);
		const stderr = result.stderr.toString();

		expect(result.exitCode).toBe(2);
		// A rejected invocation is a log event now, not ad-hoc stderr text (issues
		// #60/#88) — an NDJSON line naming the offending argument. Parse the log
		// line and assert its fields, not a substring of the raw stream.
		const logLine = stderr
			.split("\n")
			.map((l) => l.trim())
			.find((l) => l.startsWith("{"));
		expect(logLine).toBeDefined();
		const obj = JSON.parse(logLine as string) as Record<string, unknown>;
		expect(obj.level).toBe("error");
		expect(obj.msg).toBe("cli.unknown_argument");
		expect(obj.argument).toBe("--unknown");
		// The human-facing pointer stays a plain sentence, not a log field.
		expect(stderr).toContain("Run with --help for usage.");
	});

	test("--help and --version stay on stdout in their exact form", () => {
		// These are the CLI's own output, not log events: a caller may parse
		// --version, so it must not become an NDJSON line on stderr.
		const version = Bun.spawnSync([...command, "--version"]);
		expect(version.exitCode).toBe(0);
		expect(version.stdout.toString().trim()).not.toContain('"level"');
		expect(version.stderr.toString()).toBe("");

		const help = Bun.spawnSync([...command, "--help"]);
		expect(help.exitCode).toBe(0);
		expect(help.stdout.toString()).toContain("Usage");
		expect(help.stderr.toString()).toBe("");
	});
});
