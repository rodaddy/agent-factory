/**
 * @module tests/done-means/credential-split
 * @description Fixture tests for the D25 credential-split ratchet probe.
 *  Each case writes one workflow and one legacy file into a fresh
 *   temp dir, spawns the probe, and pins its exit code and finding.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMarkers } from "../../scripts/done-means/credential-split.probe";
import { testTmpBase } from "../support/test-temp";

const PROBE = join(import.meta.dir, "../../scripts/done-means/credential-split.probe.ts");

let dirs: string[] = [];

afterEach(() => {
	for (const d of dirs) rmSync(d, { recursive: true, force: true });
	dirs = [];
});

function run(workflow: string, legacy: string): { out: string; code: number } {
	const dir = mkdtempSync(join(testTmpBase(), "credential-split-"));
	dirs.push(dir);
	const wf = join(dir, "workflows");
	mkdirSync(wf);
	writeFileSync(join(wf, "w.yml"), workflow);
	writeFileSync(join(dir, "legacy"), legacy);
	const r = Bun.spawnSync(["bun", PROBE, wf, join(dir, "legacy")]);
	return { out: r.stdout.toString() + r.stderr.toString(), code: r.exitCode };
}

const MIXED = `jobs:
  j:
    runs-on: x
    steps:
      - uses: actions/checkout@v4
      - run: bun install --frozen-lockfile
        env:
          TOKEN: \${{ secrets.FORGE_TOKEN }}
`;

describe("credential-split probe", () => {
	test("an interpolated printf env-file value makes a credential job MIXED", () => {
		const r = run(
			`jobs:
  j:
    env:
      TOKEN: \${{ secrets.FORGE_TOKEN }}
    steps:
      - run: |
          printf 'SAFE=%s\\n' "$PAYLOAD" >> "$GITHUB_ENV"
          bun install --frozen-lockfile
`,
			"",
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("FAIL w.yml:j: credential and code in one job");
		expect(r.out).toContain("runner env: GITHUB_ENV");
	});

	test("a delimiter inside a string leaves the later needs reference MIXED", () => {
		const r = run(
			`jobs:
  auth:
    env:
      TOKEN: \${{ secrets.FORGE_TOKEN }}
    outputs:
      jwt: \${{ steps.mint.outputs.jwt }}
    steps:
      - run: echo ok
  consumer:
    env:
      TOKEN: >-
        \${{ format('{{"token":"{0}"}}', needs.auth.outputs.jwt) }}
    steps:
      - run: bun install --frozen-lockfile
`,
			"",
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("FAIL w.yml:consumer: credential and code in one job");
		expect(r.out).toContain("needs.auth.outputs.jwt");
	});

	test("needs text inside a string leaves the consumer clean", () => {
		const r = run(
			`jobs:
  auth:
    env:
      TOKEN: \${{ secrets.FORGE_TOKEN }}
    outputs:
      jwt: \${{ steps.mint.outputs.jwt }}
    steps:
      - run: echo ok
  consumer:
    env:
      MESSAGE: >-
        \${{ format('This needs attention: {0}', github.ref) }}
    steps:
      - run: bun install --frozen-lockfile
`,
			"",
		);
		expect(r).toEqual({ out: expect.stringContaining("0 mixed"), code: 0 });
	});

	test("a credential passed through job outputs makes the consumer MIXED", () => {
		const r = run(
			`jobs:
  auth:
    env:
      TOKEN: \${{ secrets.FORGE_TOKEN }}
    outputs:
      jwt: \${{ steps.mint.outputs.jwt }}
    steps:
      - run: echo ok
  consumer:
    env:
      TOKEN: \${{ needs.auth.outputs.jwt }}
    steps:
      - run: bun install --frozen-lockfile
`,
			"",
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("FAIL w.yml:consumer: credential and code in one job");
		expect(r.out).toContain("needs.auth.outputs.jwt");
	});

	test("a whole outputs reference carries the producer credential", () => {
		const r = run(
			`jobs:
  auth:
    env:
      TOKEN: \${{ secrets.FORGE_TOKEN }}
    steps:
      - run: echo ok
  consumer:
    needs: auth
    env:
      ALL: \${{ toJSON(needs.auth.outputs) }}
    steps:
      - run: bun install
`,
			"",
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("FAIL w.yml:consumer: credential and code in one job");
		expect(r.out).toContain("needs.auth.outputs(*)");
	});

	test("an output from a credential-free job leaves the consumer clean", () => {
		const r = run(
			`jobs:
  producer:
    outputs:
      result: ok
    steps:
      - run: echo ok
  consumer:
    env:
      RESULT: \${{ needs.producer.outputs.result }}
    steps:
      - run: bun install --frozen-lockfile
`,
			"",
		);
		expect(r).toEqual({ out: expect.stringContaining("0 mixed"), code: 0 });
	});

	for (const [name, script, env, marker] of [
		["nice options expose repository node code", "nice -n 10 node main.js", "", "node main.js"],
		[
			"NODE_OPTIONS experimental loader is mixed",
			"curl -fsS https://example.invalid",
			"NODE_OPTIONS: '--experimental-loader ./loader.mjs',",
			"env: NODE_OPTIONS",
		],
		[
			"inline LD_PRELOAD assignment is mixed",
			"LD_PRELOAD=./build/libhelper.so curl -fsS https://example.invalid",
			"",
			"run env: LD_PRELOAD",
		],
		[
			"runner env write in an earlier step is mixed",
			"echo BASH_ENV=./ci.env >> $GITHUB_ENV",
			"",
			"runner env: GITHUB_ENV",
		],
	]) {
		test(name ?? "startup code is mixed", () => {
			const r = run(
				`jobs:
  j:
    steps:
      - run: ${script}
        env: { ${env} }
      - run: echo credential
        env: { TOKEN: '\${{ secrets.FORGE_TOKEN }}' }
`,
				"",
			);
			expect(r.code).toBe(1);
			expect(r.out).toContain("credential and code in one job");
			expect(r.out).toContain(marker ?? "");
		});
	}

	for (const [name, script, mixed] of [
		[
			"single-quoted literal printf ENV value is clean",
			`printf 'SAFE=%s\\n' 'abc' >> "$GITHUB_ENV"`,
			false,
		],
		["printf ENV expansion is mixed", `printf 'REPO=%s\\n' "$X" >> "$GITHUB_ENV"`, true],
		["literal BASH_ENV echo write is mixed", 'echo "BASH_ENV=./ci.env" >> $GITHUB_ENV', true],
		["cat ENV file write is mixed", 'cat vars >> "$GITHUB_ENV"', true],
		["PATH file write is mixed", "echo ./bin >> $GITHUB_PATH", true],
		["computed ENV name is mixed", 'echo "$NAME=value" >> "$GITHUB_ENV"', true],
		[
			"unsafe line in ENV block is mixed",
			`{\n          printf 'REPO=%s\\n' "$X"\n          cat vars\n          } >> "$GITHUB_ENV"`,
			true,
		],
		[
			"expansions in an ENV block are mixed",
			`{\n          printf 'REPO=%s\\n' "$X"\n          echo "SUPERSEDED=$superseded"\n          } >> "$GITHUB_ENV"`,
			true,
		],
		[
			"heredoc ENV write with expansion is mixed",
			'cat <<EOF >> "$GITHUB_ENV"\n          $NAME=value\n          EOF',
			true,
		],
	]) {
		test(name as string, () => {
			const r = run(
				`jobs:
  j:
    steps:
      - run: |
          ${script}
        env: { TOKEN: '\${{ secrets.FORGE_TOKEN }}' }
`,
				"",
			);
			expect(r.code).toBe(mixed ? 1 : 0);
			expect(r.out.includes("credential and code in one job")).toBe(mixed as boolean);
			if (name === "literal BASH_ENV echo write is mixed")
				expect(r.out).toContain("runner env: GITHUB_ENV");
		});
	}

	test("unknown exec wrapper options fail closed", () => {
		for (const wrapper of [
			"nice",
			"ionice",
			"chrt",
			"taskset",
			"setsid",
			"flock",
			"stdbuf",
			"timeout",
			"env",
			"xargs",
			"sudo",
			"nohup",
			"unshare",
			"nsenter",
			"strace",
			"script",
			"watch",
			"parallel",
		])
			expect(runMarkers(`${wrapper} --unknown value curl https://example.invalid`)).toEqual([
				`${wrapper} (unparsed)`,
			]);
	});

	test("custom bash shell with a script argument is a finding", () => {
		for (const scope of ["workflow", "job", "step"]) {
			const defaults = "defaults: { run: { shell: 'bash ./tools/wrapper.sh {0}' } }";
			const r = run(
				`${scope === "workflow" ? `${defaults}\n` : ""}jobs:
  j:
    ${scope === "job" ? defaults : "runs-on: x"}
    env: { TOKEN: '\${{ secrets.FORGE_TOKEN }}' }
    steps:
      - run: echo ok
        ${scope === "step" ? "shell: 'bash ./tools/wrapper.sh {0}'" : "name: echo"}
`,
				"",
			);
			expect(r.code).toBe(1);
			expect(r.out).toContain("code: shell: bash ./tools/wrapper.sh {0}");
		}
	});

	for (const [name, value] of [
		["NODE_OPTIONS", "--require ./bootstrap.cjs"],
		["BASH_ENV", "./startup.sh"],
	]) {
		test(`${name} startup env is a finding at every scope`, () => {
			for (const scope of ["workflow", "job", "step"]) {
				const env = `env: { ${name}: '${value}' }`;
				const r = run(
					`${scope === "workflow" ? `${env}\n` : ""}jobs:
  j:
    ${scope === "job" ? env : "runs-on: x"}
    steps:
      - run: echo ok
        ${scope === "step" ? env : "name: echo"}
      - run: echo credential
        env: { TOKEN: '\${{ secrets.FORGE_TOKEN }}' }
`,
					"",
				);
				expect(r.code).toBe(1);
				expect(r.out).toContain(`code: env: ${name}`);
			}
		});
	}

	test("flock lock-file wrapper exposes node main.js as a finding", () => {
		expect(runMarkers("flock /x node main.js")).toEqual(["node main.js"]);
		const r = run(
			`jobs:
  j:
    env: { TOKEN: '\${{ secrets.FORGE_TOKEN }}' }
    steps:
      - run: flock /x node main.js
`,
			"",
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("node main.js");
	});

	test("forgejo.token with bun install is a finding", () => {
		const r = run(
			`jobs:
  j:
    env: { TOKEN: '\${{ forgejo.token }}' }
    steps:
      - run: bun install
`,
			"",
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("credential: forgejo.token");
	});

	test("a MIXED job not in legacy fails", () => {
		const r = run(MIXED, "");
		expect(r.code).toBe(1);
		expect(r.out).toContain("FAIL w.yml:j: credential and code in one job: split it, sf#1680");
	});

	test("a legacy entry whose job is clean fails", () => {
		const r = run(
			`jobs:
  j:
    steps:
      - run: curl -fsS https://example.invalid
`,
			"# seed\nw.yml:j\n",
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("FAIL w.yml:j: remove it from credential-split.legacy");
	});

	test("an engine-key-only job running bun passes", () => {
		const r = run(
			`jobs:
  j:
    steps:
      - uses: actions/checkout@v4
      - run: bun install && bun run engine
        env:
          K: \${{ secrets.CLIPROXY_API_KEY }}
          T: \${{ secrets.TYPESAFE_API_KEY }}
`,
			"",
		);
		expect(r).toEqual({ out: expect.stringContaining("0 mixed"), code: 0 });
	});

	test("a credential job running only curl and node -e passes", () => {
		const r = run(
			`jobs:
  j:
    steps:
      - run: |
          # ./scripts/x.ts is a comment, not code
          curl -fsS -H "Authorization: token $TOKEN" https://example.invalid
          node -e 'process.stdout.write("ok")'
        env:
          TOKEN: \${{ secrets.FORGE_TOKEN }}
`,
			"",
		);
		expect(r).toEqual({ out: expect.stringContaining("0 mixed"), code: 0 });
	});

	test("workflow-level OIDC with a job-level false is clean", () => {
		const r = run(
			`enable-openid-connect: true
jobs:
  j:
    enable-openid-connect: false
    steps:
      - uses: actions/checkout@v4
      - run: bun install
`,
			"",
		);
		expect(r).toEqual({ out: expect.stringContaining("0 mixed"), code: 0 });
	});

	test("job-level OIDC with no workflow flag is MIXED and fails", () => {
		const r = run(
			`jobs:
  j:
    enable-openid-connect: true
    steps:
      - uses: actions/checkout@v4
`,
			"",
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("FAIL w.yml:j: credential and code in one job");
	});

	const withBun = (expr: string): string => `jobs:
  j:
    steps:
      - run: bun install
        env:
          T: \${{ ${expr} }}
`;

	test("bracket-notation secrets['FORGE_TOKEN'] with bun fails", () => {
		const r = run(withBun("secrets['FORGE_TOKEN']"), "");
		expect(r.code).toBe(1);
		expect(r.out).toContain("credential: secrets.FORGE_TOKEN");
	});

	test('github["token"] with checkout fails', () => {
		const r = run(
			`jobs:
  j:
    steps:
      - uses: actions/checkout@v4
        with:
          token: \${{ github["token"] }}
`,
			"",
		);
		expect(r.code).toBe(1);
		expect(r.out).toContain("credential: github.token");
	});

	test("toJSON(secrets) with bun fails closed", () => {
		const r = run(withBun("toJSON(secrets)"), "");
		expect(r.code).toBe(1);
		expect(r.out).toContain("secrets(unknown shape)");
	});

	test("bracket-notation engine key secrets['CLIPROXY_API_KEY'] with bun passes", () => {
		const r = run(withBun("secrets['CLIPROXY_API_KEY']"), "");
		expect(r).toEqual({ out: expect.stringContaining("0 mixed"), code: 0 });
	});

	/** One job: `step` is the YAML of extra step keys, then a FORGE_TOKEN env. */
	const job = (steps: string): string => `jobs:
  j:
    steps:
${steps}`;
	const credRun = (cmd: string): string =>
		job(`      - run: ${cmd}
        env:
          T: \${{ secrets.FORGE_TOKEN }}
`);
	const mixed = (r: { out: string; code: number }): void => {
		expect(r.code).toBe(1);
		expect(r.out).toContain("FAIL w.yml:j: credential and code in one job");
	};
	const clean = (r: { out: string; code: number }): void =>
		expect(r).toEqual({ out: expect.stringContaining("0 mixed"), code: 0 });

	test("a credential expression inside a shell comment still counts (runner expands it)", () => {
		mixed(
			run(
				job(`      - run: |
          # \${{ secrets.PUSH_TOKEN }}
          bun run check
`),
				"",
			),
		);
	});

	test("a credential only in a step if: counts", () => {
		mixed(
			run(
				job(`      - if: \${{ secrets.PUSH_TOKEN != '' }}
        run: bun run check
`),
				"",
			),
		);
	});

	test("node with a runtime option before a file is code", () => {
		mixed(run(credRun("node --enable-source-maps ./deploy.js"), ""));
	});

	test("node --require before -e is code", () => {
		mixed(run(credRun("node --require ./x.js -e '1'"), ""));
	});

	test("bash with a file argument is code", () => {
		mixed(run(credRun("bash ./deploy.sh"), ""));
	});

	test("bash -euo pipefail -c with an inline program is code (vocabulary: bash)", () => {
		mixed(run(credRun(`bash -euo pipefail -c 'curl -fsS https://example.invalid'`), ""));
	});

	test("node --no-warnings -e is not code", () => {
		clean(run(credRun(`node --no-warnings -e 'process.stdout.write("ok")'`), ""));
	});

	/** A credential job whose one step is a literal block `run: |` of `lines`. */
	const credBlock = (lines: string[]): string =>
		job(`      - run: |
${lines.map((l) => `          ${l}`).join("\n")}
        env:
          T: \${{ secrets.FORGE_TOKEN }}
`);

	// Review round 3 (PR 1683): parser findings, plus the quote-agnostic vocabulary layer.
	test("(a) an unquoted heredoc body runs its $( ) substitution: code", () => {
		mixed(run(credBlock(["cat <<EOF", "$(python main.py)", "EOF"]), ""));
	});

	test("(b) the parser runs an unquoted heredoc body's $( ) and treats a quoted one as literal", () => {
		// The parser layer alone, so the vocabulary layer cannot mask the result.
		const body = (delim: string): string => `cat <<${delim}\n$(./tools/x.sh)\nEOF\n`;
		expect(runMarkers(body("'EOF'"))).toEqual([]);
		expect(runMarkers(body("EOF"))).toEqual(["./tools/x.sh"]);
	});

	test("(c) a substitution nested in ${x:-...} is code", () => {
		mixed(run(credRun(`echo "\${u:-$(python main.py)}"`), ""));
	});

	test("(d) a substitution nested in $(( )) is code", () => {
		mixed(run(credRun("echo $(( $(./x) ))"), ""));
	});

	test("(e) node --require after the inline program is code", () => {
		mixed(run(credRun("node -e '0' --require ./p.js"), ""));
	});

	test("(f) node -e loading child_process is code", () => {
		mixed(run(credRun(`node -e 'require("child_process").execSync("id")'`), ""));
	});

	test("(g) node -e with a static node:fs import is not code", () => {
		clean(
			run(
				credRun(
					`node --input-type=module -e 'import { readFileSync } from "node:fs"; process.stdout.write(typeof readFileSync)'`,
				),
				"",
			),
		);
	});

	test("a node built-in is allowed through require and import alike; any other module argument is code", () => {
		clean(run(credRun(`node -e 'require("node:crypto").randomUUID()'`), ""));
		mixed(run(credRun(`node -e 'require("./x")'`), ""));
		mixed(run(credRun(`node -e 'require(m)'`), ""));
		mixed(run(credRun(`node -e 'import("node:vm")'`), ""));
	});

	// PR 2074 review rounds: the program must be one single-quoted word.
	test("a node -e program that is not one single-quoted word is code", () => {
		mixed(run(credRun(`node -e "$P"`), ""));
		mixed(run(credRun(`node -e '\${{ env.P }}'`), ""));
		mixed(run(credRun("node -e {1,-r,./p.cjs}"), ""));
	});

	test("an argument that can expand into a node option is code", () => {
		mixed(run(credRun("node -e '0' $FLAGS"), ""));
		mixed(run(credRun("node --input-type=$FLAGS -e '0'"), ""));
	});

	test("a single-quoted program with a JS $name and braces is not code", () => {
		clean(
			run(credRun(`node -e 'const $a={b:1,c:2};process.stdout.write(String($a.b))' 'lit[0]'`), ""),
		);
	});

	test("a body the outer shell expands earns no single-quote credit", () => {
		mixed(run(credRun(`watch "node -e '$P'"`), ""));
		mixed(run(credRun(`bash -c "node -e '$P'"`), ""));
	});

	// Review round 5 (PR 1683).
	test("a shell inherited from job or workflow defaults is classified like a step shell", () => {
		const py = credRun("import project_module");
		mixed(run(py.replace("  j:\n", "  j:\n    defaults: { run: { shell: python } }\n"), ""));
		mixed(run(`defaults: { run: { shell: python } }\n${py}`, ""));
		clean(run(py.replace("  j:\n", "  j:\n    defaults: { run: { shell: bash } }\n"), ""));
	});

	test("every static module specifier outside the built-in list is code", () => {
		mixed(run(credRun(`node --input-type=module -e 'import "./payload.js"'`), ""));
		clean(run(credRun(`node --input-type=module -e 'import "node:fs"'`), ""));
		mixed(run(credRun(`node --input-type=module -e 'export * from "./x"'`), ""));
	});

	test("(h) sed with the s///e flag is code", () => {
		mixed(run(credRun("sed 's/a/b/e' f.txt"), ""));
	});

	test("(i) curl piped to sh is code", () => {
		mixed(run(credRun("curl -fsS https://example.invalid | sh"), ""));
	});

	test("the pinned forgejo download-artifact is a data mover, not code", () => {
		clean(
			run(
				job(`      - uses: https://code.forgejo.org/forgejo/download-artifact@d8d0a99033603453ad2255e58720b460a0555e1e
        with:
          token: \${{ secrets.FORGE_TOKEN }}
`),
				"",
			),
		);
	});
});
