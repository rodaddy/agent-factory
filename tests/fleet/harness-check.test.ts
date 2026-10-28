/**
 * @module tests/fleet/harness-check
 * @description `fleet/skills/harness-check/bin/harness-check`, run as a
 *   real child process against fake `claude`, `pi` and `npm` scripts.
 *   `HARNESS_CHECK_UNDER_TEST` points the suite at a mutated copy of the script.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const SCRIPT =
	process.env.HARNESS_CHECK_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/skills/harness-check/bin/harness-check");

let dir = "";

beforeAll(() => {
	// The OS temp dir, as tests/fleet/forge-post.test.ts does: the receipt sandbox mounts the checkout read-only.
	dir = mkdtempSync(join(tmpdir(), "harness-check-"));
	writeFileSync(join(dir, "pins"), "# pins\nCLAUDE_CODE_VERSION=2.1.287\nPI_VERSION=1.0.0\n");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fake(name: string, body: string): string {
	const p = join(dir, name);
	writeFileSync(p, `#!/bin/bash\n${body}\n`);
	chmodSync(p, 0o755);
	return p;
}

function npm(claude: string, pi: string): string {
	return fake(
		`npm-${claude}-${pi}`,
		`[ "$1" = view ] || exit 9
case "$2" in
@anthropic-ai/claude-code) echo ${claude} ;;
@earendil-works/pi-coding-agent) echo ${pi} ;;
*) exit 9 ;;
esac`,
	);
}

interface Tool {
	tool: string;
	pinned: string;
	installed: string;
	latest: string;
	status: string;
}

function run(env: Record<string, string>) {
	const r = Bun.spawnSync(["bash", SCRIPT, "--pins", join(dir, "pins")], {
		env: { ...process.env, ...env },
	});
	const out = r.stdout.toString();
	const json = JSON.parse(out) as { checkedAt: string; tools: Tool[] };
	return { code: r.exitCode, json, byTool: Object.fromEntries(json.tools.map((t) => [t.tool, t])) };
}

describe("harness-check", () => {
	test("all ok exits 0", () => {
		const r = run({
			HARNESS_CLAUDE: fake("claude-ok", 'echo "2.1.287 (Claude Code)"'),
			HARNESS_PI: fake("pi-ok", "echo 1.0.0"),
			HARNESS_NPM: npm("2.1.287", "1.0.0"),
		});
		expect(r.code).toBe(0);
		expect(r.json.checkedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
		expect(r.byTool.claude).toEqual({
			tool: "claude",
			pinned: "2.1.287",
			installed: "2.1.287",
			latest: "2.1.287",
			status: "ok",
		});
		expect(r.byTool.pi?.status).toBe("ok");
	});

	test("installed != pinned is drift and exits 2", () => {
		const r = run({
			HARNESS_CLAUDE: fake("claude-old", 'echo "2.1.200 (Claude Code)"'),
			HARNESS_PI: fake("pi-ok2", "echo 1.0.0"),
			HARNESS_NPM: npm("2.1.287", "1.0.0"),
		});
		expect(r.code).toBe(2);
		expect(r.byTool.claude?.status).toBe("drift");
		expect(r.byTool.claude?.installed).toBe("2.1.200");
		expect(r.byTool.pi?.status).toBe("ok");
	});

	test("latest newer than pinned is behind and exits 0", () => {
		const r = run({
			HARNESS_CLAUDE: fake("claude-ok3", 'echo "2.1.287 (Claude Code)"'),
			HARNESS_PI: fake("pi-ok3", "echo 1.0.0"),
			HARNESS_NPM: npm("2.1.300", "1.0.0"),
		});
		expect(r.code).toBe(0);
		expect(r.byTool.claude?.status).toBe("behind");
		expect(r.byTool.claude?.latest).toBe("2.1.300");
	});

	test("missing binary is missing and exits 2", () => {
		const r = run({
			HARNESS_CLAUDE: fake("claude-ok4", 'echo "2.1.287 (Claude Code)"'),
			HARNESS_PI: join(dir, "no-such-pi"),
			HARNESS_NPM: npm("2.1.287", "1.0.0"),
		});
		expect(r.code).toBe(2);
		expect(r.byTool.pi?.status).toBe("missing");
		expect(r.byTool.pi?.installed).toBe("");
	});
});
