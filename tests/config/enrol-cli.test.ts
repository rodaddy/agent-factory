/**
 * @file Tests for the `enrol` CLI.
 *
 * `planEnrolBatch` is tested in `enrol-batch.test.ts` without a filesystem.
 * These tests cover the half that file cannot: that a refusal leaves the config
 * file BYTE-IDENTICAL on disk. "Never a partial silent apply" is a claim about
 * the file, so the assertion has to read the file back.
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runEnrolCommand } from "../../src/config/enrol-cli";

/** A minimal valid config on disk, with one repository already enrolled. */
const BASE_CONFIG = `poll_interval_minutes: 15
repositories:
  - name: rodaddy/web-ops
    provider: forgejo
    checks: static-only
    build_bump:
      images:
        - name: web-ops
          environments:
            - { name: live, app_dirs: [ops] }
      tag_pattern: "v*"
`;

/**
 * A scratch directory for one test.
 *
 * `tmpdir()` is used deliberately and is NOT a temp-policy violation: this
 * repo's own test harness points `TMPDIR` at the repo temp workspace, which is
 * the same mechanism `tests/config/load.test.ts` already relies on.
 */
function scratch(): string {
	return mkdtempSync(join(tmpdir(), "sf-enrol-"));
}

describe("runEnrolCommand", () => {
	test("enrols every declaration and appends them to the config", async () => {
		const dir = scratch();
		const configPath = join(dir, "repos.yml");
		const declPath = join(dir, "decls.yml");
		writeFileSync(configPath, BASE_CONFIG);
		writeFileSync(
			declPath,
			`- repository: rodaddy/web-alpha
  image: web-alpha
  app_dirs: [alpha]
- repository: rodaddy/web-beta
  image: web-beta
  app_dirs: [beta]
`,
		);

		const code = await runEnrolCommand([declPath, "--config", configPath]);
		expect(code).toBe(0);
		const after = readFileSync(configPath, "utf8");
		expect(after).toContain("rodaddy/web-alpha");
		expect(after).toContain("rodaddy/web-beta");
		// The pre-existing content survives: this appends, it does not rewrite.
		expect(after.startsWith(BASE_CONFIG)).toBe(true);
	});

	test("one bad declaration leaves the config file byte-identical", async () => {
		const dir = scratch();
		const configPath = join(dir, "repos.yml");
		const declPath = join(dir, "decls.yml");
		writeFileSync(configPath, BASE_CONFIG);
		writeFileSync(
			declPath,
			`- repository: rodaddy/web-alpha
  image: web-alpha
  app_dirs: [alpha]
- repository: rodaddy/web-evil
  image: web-evil
  app_dirs: ["../../etc/passwd"]
- repository: rodaddy/web-gamma
  image: web-gamma
  app_dirs: [gamma]
`,
		);

		const code = await runEnrolCommand([declPath, "--config", configPath]);
		// Exit 1, not 0: the run did not do what it was asked.
		expect(code).toBe(1);
		// THE ACCEPTANCE CLAUSE. Two declarations were fine; none of them landed.
		expect(readFileSync(configPath, "utf8")).toBe(BASE_CONFIG);
	});

	test("a dry run reports success without touching the config", async () => {
		const dir = scratch();
		const configPath = join(dir, "repos.yml");
		const declPath = join(dir, "decls.yml");
		writeFileSync(configPath, BASE_CONFIG);
		writeFileSync(
			declPath,
			"- repository: rodaddy/web-alpha\n  image: web-alpha\n  app_dirs: [alpha]\n",
		);

		const code = await runEnrolCommand([declPath, "--config", configPath, "--dry-run"]);
		expect(code).toBe(0);
		expect(readFileSync(configPath, "utf8")).toBe(BASE_CONFIG);
	});

	test("a declaration with no repository key is a usage refusal, not a silent skip", async () => {
		const dir = scratch();
		const configPath = join(dir, "repos.yml");
		const declPath = join(dir, "decls.yml");
		writeFileSync(configPath, BASE_CONFIG);
		writeFileSync(declPath, "- image: web-alpha\n  app_dirs: [alpha]\n");

		const code = await runEnrolCommand([declPath, "--config", configPath]);
		// Exit 2: the file itself is unusable, because a refusal could not name
		// which app it was about.
		expect(code).toBe(2);
		expect(readFileSync(configPath, "utf8")).toBe(BASE_CONFIG);
	});

	test("a missing declarations file refuses before reading the config", async () => {
		const dir = scratch();
		const configPath = join(dir, "repos.yml");
		writeFileSync(configPath, BASE_CONFIG);
		const code = await runEnrolCommand([join(dir, "absent.yml"), "--config", configPath]);
		expect(code).toBe(2);
		expect(readFileSync(configPath, "utf8")).toBe(BASE_CONFIG);
	});

	test("no declarations path at all is a usage error", async () => {
		expect(await runEnrolCommand([])).toBe(2);
		expect(await runEnrolCommand(["--dry-run"])).toBe(2);
	});
});
