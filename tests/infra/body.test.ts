/**
 * @module tests/infra/body
 * @description Literal contract tests for the fixed rtech-infra static-validation
 *   runner body, mirroring tests/prepush/body.test.ts. They assert the
 *   STATIC + least-privilege contract (static-only, no PostgreSQL, no candidate
 *   install), the enforceable sandbox properties (isolated bwrap netns, real
 *   --clearenv, no collab/credential bind, --dir-before-bind DAC fix), the fixed
 *   per-gate commands keyed on the gate booleans, that NO live-infrastructure
 *   authority is granted, the distinct result artifact, fail-closed null on
 *   oversize, and the digest-bound bootstrap under the transport cap.
 */
import { describe, expect, test } from "bun:test";
import {
	checkNameForCommand,
	INFRA_BODY_FINAL_LINE,
	INFRA_RESULT_NAME,
	INFRA_STATIC_COMMANDS,
	MAX_INFRA_JOB_BODY_CHARS,
	renderInfraStaticBootstrapJob,
	renderInfraStaticJobBody,
} from "../../src/infra/body";
import { type GateId, type GateSelection, STATIC_GATES } from "../../src/infra/gates";
import { RUNNER_JOB_TRANSPORT_CAP } from "../../src/prepush/body";
import { resultCheckSchema, resultSchema } from "../../src/results/schema";

const REPO = "rtech/rtech-infra";
const SHA = "a".repeat(40);
const JOB_ID = "rw-infra-static-body-test";

function full(): GateSelection {
	return { gates: [...STATIC_GATES], fullEscalation: true, reason: "full" };
}
function narrow(gates: GateSelection["gates"]): GateSelection {
	return { gates, fullEscalation: false, reason: "narrow" };
}
function render(selection: GateSelection = full()): string {
	const body = renderInfraStaticJobBody({
		repository: REPO,
		provider: "github",
		sha: SHA,
		jobId: JOB_ID,
		selection,
	});
	if (body === null) throw new Error("expected a non-null body");
	return body;
}

describe("fixed infra static-validation body — static + least-privilege contract", () => {
	test("is static-only and runs no runtime, deploy, or PostgreSQL", () => {
		const body = render();
		// The static lane declares no runtime/deploy/mutation step in its fixed body.
		expect(body).toContain("no runtime");
		expect(body).toContain("Run ONLY fixed static checks");
		// No PostgreSQL machinery leaks in from the pre-push mirror.
		expect(body).not.toContain("initdb");
		expect(body).not.toContain("pg_ctl");
		expect(body).not.toContain("PGDATA");
		// No candidate dependency install for a static lane.
		expect(body).not.toContain("bun install");
	});

	test("grants NO live-infrastructure authority anywhere", () => {
		const body = render();
		// The contract explicitly DENIES every live-infra authority by name.
		expect(body).toContain(
			"no Proxmox, DNS, Caddy,\nservice-control, SSH, deploy, or lifecycle authority",
		);
		expect(body).toContain("this lane has no such authority");
		// It names no live-infra action verb as an instruction to perform.
		for (const forbidden of [
			"caddy reload",
			"systemctl restart",
			"terraform apply",
			"pct start",
			"qm start",
		]) {
			expect(body.toLowerCase()).not.toContain(forbidden);
		}
	});

	test("fills the host directory by running `hostname`, not by expanding $HOSTNAME", () => {
		const body = render();
		// The share result path and its host directory filled by RUNNING `hostname`,
		// never by expanding a $HOSTNAME env reference an agent can guess.
		expect(body).toContain(`/mnt/share/runners/jobs/${JOB_ID}/<host>/`);
		expect(body).toContain("`hostname`");
		expect(body).toContain("REFUSED at the read boundary");
		expect(body).not.toContain("$HOSTNAME");
		expect(body).not.toContain("system-provided HOSTNAME only");
	});

	test("uses an isolated network namespace and real --clearenv with no collab/credential bind", () => {
		const body = render();
		expect(body).toContain("--unshare-net");
		expect(body).toContain("--clearenv");
		// The DAC --dir-before-bind fix and read-only checkout are present.
		expect(body).toContain("--dir /work");
		expect(body).toContain("--ro-bind /work/checkout /work/checkout");
		// The collab share is never bound into the sandbox.
		expect(body).not.toContain("--bind /mnt/share");
		expect(body).not.toContain("--ro-bind /mnt/share");
	});
});

describe("fixed infra static-validation body — fixed per-gate commands", () => {
	test("full escalation enumerates every fixed gate command", () => {
		const body = render(full());
		for (const gate of STATIC_GATES) {
			for (const command of INFRA_STATIC_COMMANDS[gate].commands) {
				expect(body).toContain(command);
			}
		}
	});

	test("a narrow selection enumerates ONLY the selected gate commands", () => {
		const body = render(narrow(["scripts"]));
		expect(body).toContain("shellcheck");
		expect(body).not.toContain("actionlint");
		// The unselected gate's COMMAND is absent. Asserted on the invocation, not
		// the bare tool name: since sf#592 the fixed setup writes the pinned
		// `/work/lintrc/ansible-lint.yml` config for every selection (it is
		// author-owned text, not a gate command), so a bare-substring assertion
		// would now match that filename and stop testing what it names.
		expect(body).not.toContain("ansible-lint -f pep8");
	});

	test("the commands are fixed reviewed text, not derived from a changed path", () => {
		// The body is rendered from booleans only; no path appears in it.
		const body = renderInfraStaticJobBody({
			repository: REPO,
			provider: "github",
			sha: SHA,
			jobId: JOB_ID,
			selection: narrow(["ansible"]),
		});
		expect(body).not.toBeNull();
		expect(body as string).toContain("ansible-lint");
	});

	test("ties the result to the exact SHA and the distinct result artifact", () => {
		const body = render();
		expect(body).toContain(`sha: ${SHA}`);
		expect(body).toContain(INFRA_RESULT_NAME);
		// The distinct artifact is explicitly disambiguated from the wrapper envelope.
		expect(body).toContain("this named artifact, NOT");
		expect(body).toContain("result.json, which the wrapper owns");
	});

	test("uses the fixed Forgejo clone base without changing GitHub output", () => {
		const github = render();
		const forgejo = renderInfraStaticJobBody({
			repository: REPO,
			provider: "forgejo",
			sha: SHA,
			jobId: JOB_ID,
			selection: full(),
		});
		expect(github).toContain(`https://github.com/${REPO}.git ${SHA}`);
		expect(forgejo).not.toBeNull();
		expect(forgejo as string).toContain(`https://forge.example.internal/${REPO}.git ${SHA}`);
	});
});

describe("fixed infra static-validation body — fail-closed", () => {
	test("an empty gate selection renders null (never an unbounded/gateless body)", () => {
		const body = renderInfraStaticJobBody({
			repository: REPO,
			provider: "github",
			sha: SHA,
			jobId: JOB_ID,
			selection: narrow([]),
		});
		expect(body).toBeNull();
	});

	test("an unsafe job id renders null", () => {
		const body = renderInfraStaticJobBody({
			repository: REPO,
			provider: "github",
			sha: SHA,
			jobId: "../escape",
			selection: full(),
		});
		expect(body).toBeNull();
	});

	test("a malformed (non-hex) SHA renders null — validated, never sanitized", () => {
		// The SHA is VALIDATED (strict lowercase hex, exact-SHA length), never
		// transformed: a malformed value fails closed to null so the dispatch
		// releases + skips, rather than binding an altered, valid-looking commit into
		// the depth-1 fetch target or the HEAD==sha guard.
		for (const bad of [
			"not-a-sha",
			`${"a".repeat(39)}`, // too short
			`${"a".repeat(65)}`, // too long
			`${"A".repeat(40)}`, // uppercase is not the strict lowercase-hex shape
			`${"a".repeat(39)}g`, // non-hex character
			`${"a".repeat(40)}; rm -rf /`, // injection attempt
		]) {
			expect(
				renderInfraStaticJobBody({
					repository: REPO,
					provider: "github",
					sha: bad,
					jobId: JOB_ID,
					selection: full(),
				}),
			).toBeNull();
		}
	});

	test("a valid 64-hex SHA renders and binds the exact commit unchanged", () => {
		const sha64 = "a".repeat(64);
		const body = renderInfraStaticJobBody({
			repository: REPO,
			provider: "github",
			sha: sha64,
			jobId: JOB_ID,
			selection: full(),
		});
		expect(body).not.toBeNull();
		// The exact commit is bound verbatim into the fetch + HEAD guard, untransformed.
		expect(body as string).toContain(`sha: ${sha64}`);
		expect(body as string).toContain(`checkout -q ${sha64}`);
	});

	test("returns null rather than truncate past the file budget", () => {
		const tiny = renderInfraStaticJobBody({
			repository: REPO,
			provider: "github",
			sha: SHA,
			jobId: JOB_ID,
			selection: full(),
			maxBodyChars: 10,
		});
		expect(tiny).toBeNull();
	});

	test("a complete body ends with the fixed final prohibition and is bounded", () => {
		const body = render();
		expect(body.endsWith(INFRA_BODY_FINAL_LINE)).toBe(true);
		expect(body.length).toBeLessThanOrEqual(MAX_INFRA_JOB_BODY_CHARS);
	});

	test("the digest-bound bootstrap fits the transport cap and rejects a bad digest", () => {
		const boot = renderInfraStaticBootstrapJob(JOB_ID, "a".repeat(64));
		expect(boot).not.toBeNull();
		expect((boot as string).length).toBeLessThanOrEqual(RUNNER_JOB_TRANSPORT_CAP);
		expect(renderInfraStaticBootstrapJob(JOB_ID, "nothex")).toBeNull();
	});
});

describe("fixed infra static-validation body — authenticated forgejo fetch", () => {
	function forgejo(itemNumber?: number | null): string {
		const body = renderInfraStaticJobBody({
			repository: REPO,
			provider: "forgejo",
			sha: SHA,
			jobId: JOB_ID,
			selection: full(),
			itemNumber,
		});
		expect(body).not.toBeNull();
		return body as string;
	}

	test("the forgejo fetch authenticates through the credential helper, token never in argv or URL", () => {
		const body = forgejo();
		// The helper is rendered inline on the fetch command itself.
		expect(body).toContain(
			"git -C /work/checkout -c credential.helper='!f(){ echo username=token; echo password=$FORGEJO_TOKEN; }; f' -c protocol.version=2 fetch --depth 1 --no-tags",
		);
		// Exactly one token reference in the whole body.
		expect(body.split("password=$FORGEJO_TOKEN").length - 1).toBe(1);
		// The fetch URL itself carries no credential.
		expect(body).toContain(`https://forge.example.internal/${REPO}.git ${SHA}`);
		expect(body).not.toContain("@forge.example.internal");
		// The helper never appears inside the bwrap launcher block (--clearenv anchor).
		const launcherStart = body.indexOf("sudo bwrap");
		expect(launcherStart).toBeGreaterThan(-1);
		expect(body.indexOf("--clearenv")).toBeGreaterThan(launcherStart);
		expect(body.indexOf("FORGEJO_TOKEN")).toBeLessThan(launcherStart);
	});

	test("the github fetch is unchanged", () => {
		const body = render();
		expect(body).toContain(
			[
				"     mkdir -p /work/checkout",
				"     git -C /work/checkout init -q",
				"     git -C /work/checkout -c protocol.version=2 fetch --depth 1 --no-tags \\",
				`       https://github.com/${REPO}.git ${SHA}`,
				`     git -C /work/checkout checkout -q ${SHA}`,
			].join("\n"),
		);
		expect(body).not.toContain("FORGEJO_TOKEN");
	});

	test("the result spec names item_number when the job has an item, and omits it when it does not", () => {
		expect(forgejo(914)).toContain(`   - \`sha\`: ${SHA}\n   - \`item_number\`: 914`);
		expect(forgejo(null)).not.toContain("item_number");
		expect(forgejo(undefined)).not.toContain("item_number");
		// A non-positive / non-integer item number fails closed to null, never sanitized.
		expect(
			renderInfraStaticJobBody({
				repository: REPO,
				provider: "forgejo",
				sha: SHA,
				jobId: JOB_ID,
				selection: full(),
				itemNumber: 0,
			}),
		).toBeNull();
	});

	test("a result built EXACTLY as the body instructs passes the result schema", () => {
		const parsed = resultSchema.safeParse({
			result_version: 1,
			repository: REPO,
			job_type: "infra-static",
			sha: SHA,
			item_number: 914,
			checks: [{ name: "shellcheck", status: "pass", summary: "ok" }],
			status: "passed",
			output_path: `/mnt/share/runners/jobs/${JOB_ID}/runner-1/validation.log`,
		});
		expect(parsed.success).toBe(true);
	});
});

describe("base-relative verdict", () => {
	const BASE = "b".repeat(40);
	function withBase(baseSha: string): GateSelection {
		return { ...full(), baseSha } as GateSelection;
	}

	test("renders the base checkout, the twice rule, and the base-relative verdict", () => {
		const body = render(withBase(BASE));
		expect(body).toContain("/work/base");
		expect(body).toContain(`git -C /work/base checkout -q ${BASE}`);
		expect(body).toContain("sudo chmod -R a+rX /work/base");
		// The launcher is rendered ONCE, for the candidate; the base run is the same
		// launcher with the one checkout path swapped, stated as a sentence.
		expect(body).toContain("For the base run, the same launcher with /work/base in place of");
		expect(body).toContain("`--ro-bind` and `--chdir` lines and nothing");
		expect(body.match(/--chdir /g)).toHaveLength(1);
		expect(body).toContain("--chdir /work/checkout");
		expect(body).toContain("Run each fixed command TWICE");
		expect(body).toContain("pre-existing on base");
		// PR #591 factory review (job 11842, high): two exit-127 runs are a missing
		// tool, not a pre-existing finding, and must never become `skip` + `passed`.
		expect(body).toContain("if either run exited 126");
		expect(body).toContain("two exit-127 runs are a");
		expect(body).toContain("`skip`");
	});

	test("no base, an equal base, or a non-hex base renders today's body byte-for-byte", () => {
		const baseline = render(full());
		for (const bad of [SHA, "not-a-sha", "", "B".repeat(40)]) {
			const got = render(withBase(bad));
			expect(got).toBe(baseline);
			expect(got).not.toContain("/work/base");
		}
	});

	test("actionlint is the guarded literal, never bare actionlint", () => {
		expect(INFRA_STATIC_COMMANDS.workflows.commands).toEqual([
			"if [ -d .github/workflows ]; then actionlint; else echo 'no .github/workflows: nothing to lint'; fi",
		]);
		expect(INFRA_STATIC_COMMANDS.workflows.commands).not.toContain("actionlint");
	});

	test("renders the per-check candidate and base capture paths when a base is read", () => {
		const body = render(withBase(BASE));
		expect(body).toContain("/work/out/check-<n>.candidate.txt");
		expect(body).toContain("/work/out/check-<n>.base.txt");
	});

	test("omits the base capture path when no base was read", () => {
		expect(render(full())).not.toContain(".base.txt");
	});

	test("skip requires no added diagnostic, not equal exit codes", () => {
		const body = render(withBase(BASE));
		expect(body).toContain("DIAGNOSTIC TALLIES");
		expect(body).toContain("`<path>:<line>:<col>:`");
		expect(body).toContain("at least one ADDED diagnostic as counted above");
		expect(body).toContain("the candidate has NO added diagnostic");
		expect(body).not.toContain("`skip` if BOTH runs exited non-zero");
	});

	// The set-vs-multiset distinction is the whole defect here: a candidate that
	// adds a SECOND instance of a violation the base already carries repeats a key
	// the base has, so a deduplicating comparison reports a real regression as
	// pre-existing. Probed against ansible-lint 26.6.0: adding one offending task
	// to a file that already has one yields a second `no-changed-when` at a new
	// line, identical in path and message to the first.
	test("added diagnostics are counted, so a duplicated violation is not deduplicated away", () => {
		const body = render(withBase(BASE));
		expect(body).toContain("COUNT each key, do not deduplicate");
		expect(body).toContain("occurring MORE times in the candidate");
		expect(body).toContain("one per extra occurrence");
		// The line-independence property must survive the counting rule.
		expect(body).toContain("A pure line shift changes no");
	});

	test("the sandbox launcher sets NO_COLOR so captured diagnostics are plain text", () => {
		expect(render(withBase(BASE))).toContain("--setenv NO_COLOR 1");
	});

	test("the diagnostic shape accepts an omitted column", () => {
		expect(render(withBase(BASE))).toContain("the column is OPTIONAL");
	});

	test("the comparison key excludes line and column numbers", () => {
		expect(render(withBase(BASE))).toContain(
			"line and column numbers are DELIBERATELY NOT part of the key",
		);
	});

	test("the ansible gate passes no --yamllint-file (ansible-lint has no such flag)", () => {
		const cmd = INFRA_STATIC_COMMANDS.ansible.commands[0];
		expect(cmd).not.toContain("--yamllint-file");
		expect(cmd?.startsWith("YAMLLINT_CONFIG_FILE=/work/lintrc/yamllint.yml ansible-lint ")).toBe(
			true,
		);
	});

	test("pins the parsable output formats", () => {
		// The parsable formats are unchanged; the configs are now PINNED outside the
		// checkout (F1/F9), so the literals carry a `-c` the candidate
		// cannot influence.
		expect(INFRA_STATIC_COMMANDS.config.commands[0]).toBe(
			"yamllint -f parsable -c /work/lintrc/yamllint.yml .",
		);
		expect(INFRA_STATIC_COMMANDS.scripts.commands[0]).toContain("shellcheck --norc -f gcc");
		expect(INFRA_STATIC_COMMANDS.ansible.commands[0]).toBe(
			"YAMLLINT_CONFIG_FILE=/work/lintrc/yamllint.yml ansible-lint -f pep8 -c /work/lintrc/ansible-lint.yml --project-dir .",
		);
	});

	test("the full-escalation body with a base stays well under the cap", () => {
		const body = render(withBase(BASE));
		// Headroom margin, not the contract: MAX_INFRA_JOB_BODY_CHARS (20_000) is the
		// real fail-closed cap and is UNCHANGED. The margin moved 14_000 -> 17_000
		// because the sf#592 P1 fixes add ~2.1k of required instruction text (pinned
		// lint configs, the fresh-per-check temp rule, and the explicit capture form).
		// 17_000 -> 18_000 for the sf#607 key-normalization rules (~550 chars): the
		// locality filter and the strip list are the fix, not prose around it, so
		// this is the same trade the previous move made.
		// 18_000 -> 18_500 for sf#665 (~300 chars): the three exact fresh-tree lines
		// and the path+errno reporting rule ARE the fix (the described-not-spelled
		// version produced the job 14938 outage). Still 1.5k under the cap.
		expect(body.length).toBeLessThan(18_500);
		expect(body.length).toBeLessThan(MAX_INFRA_JOB_BODY_CHARS);
	});
});

/**
 * The four P1 findings of the sf#592 cross-family review of PR #597. Each test
 * pins the fixed instruction TEXT that closes one finding: this body is a
 * contract SPECIFICATION a runner agent reads, so the fix is what the body
 * TELLS the agent, and the assertion is on that text.
 */
describe("sf#592 review P1 findings — the body must close each hole", () => {
	const BASE = "b".repeat(40);
	function withBase(baseSha: string): GateSelection {
		return { ...full(), baseSha } as GateSelection;
	}

	// F8: the capture instruction admitted a pipe-exit-code bug. A literal
	// `bwrap ... 2>&1 | tee <capture>` records tee's status, ALWAYS 0, so every
	// candidate run reads as `pass`. Probed: `zsh -c 'exit 3' | tail -1; echo $?`
	// prints 0. The body must name the redirect-and-read form explicitly.
	test("F8 — the capture form preserves the producer's exit status", () => {
		const body = render(withBase(BASE));
		// The explicit capture form: redirect to the file, read $? directly.
		expect(body).toContain("> /work/out/check-<n>.candidate.txt 2>&1");
		expect(body).toContain("rc=$?");
		// And the prohibition, named by the tools that swallow the status.
		expect(body).toContain("NEVER from a pipeline");
		expect(body).toContain("tee");
	});

	test("F8 — the `if !` form is prohibited too, not just the pipeline", () => {
		// A second way to lose the producer's status, same wrong answer. `$?` read
		// inside an `if ! cmd` branch is the status of the NEGATION. Measured in zsh
		// while reviewing this body: `if ! (exit 7); then echo $?; fi` prints 0, so a
		// FAILING check is captured as a success — worse than the documented `tee`
		// case, which at least fails loudly when the filter itself errors.
		//
		// Found by the rtech-infra session hitting it in their own wrapper:
		// every failure logged as the wrong code while the
		// attribution message looked correct. The body warned about pipelines and
		// said nothing about this, so an agent avoiding `tee` could still land here.
		const body = render(withBase(BASE));
		expect(body).toContain("Do NOT wrap the run in `if ! ...`");
		expect(body).toContain("status of the NEGATION");
		// The remedy must be stated, not just the prohibition: capture, then branch.
		expect(body).toContain("capture first and test the variable");
		// The warning must NOT read as shell-specific. It was first written as
		// "measured in zsh", which invites exactly the carve-out that lets the trap
		// back in — an agent reasoning "this sandbox runs /bin/sh, so that is a zsh
		// quirk and does not apply to me". Re-measured across all three: /bin/sh,
		// bash and zsh each print 0. /bin/sh is the one that matters most, because
		// it is what the launcher above actually executes the script with.
		expect(body).toContain("`/bin/sh`");
		expect(body).toContain("no shell where the form is safe");
	});

	// F9: ansible-lint honours `rulesdir` in a candidate-supplied `.ansible-lint`,
	// importing and RUNNING candidate Python. Probed against ansible-lint 26.6.0:
	// a rule module's import side effect wrote a file on disk; with `-c` pointing
	// at a pinned config outside the checkout it did not.
	test("F9 — candidate rule loading is neutralized and the shared-HOME claim is corrected", () => {
		const body = render(withBase(BASE));
		// (a) the pinned config lives OUTSIDE the checkout, so `rulesdir` in a
		// candidate `.ansible-lint` is never read.
		expect(INFRA_STATIC_COMMANDS.ansible.commands[0]).toContain("-c /work/lintrc/ansible-lint.yml");
		// (b) a FRESH writable temp/HOME per check, never shared.
		expect(body).toContain("FRESH /work/out/test-tmp");
		expect(body).toContain("never one shared across");
		expect(body).toContain("checks or between the candidate and base runs");
		// (c) the body must not claim candidate code cannot run when it can.
		expect(body).not.toContain("candidate code does NOT run here");
	});

	// sf#665: job 14938 errored "required fresh HOME directory could not be
	// created" because the body DESCRIBED the fresh tree ("delete that tree and
	// re-create it") instead of spelling it. The agent's natural translation was
	// `rm -rf`, which the harness refuses; its recovery emptied the tree with
	// `find -delete` and then ran an UNPRIVILEGED mkdir into a directory chown'd
	// to 65534 — EACCES. Job 14925 hit the same refusal and happened to recover.
	test("sf#665 — the fresh-tree refresh is three exact privileged lines, none of them rm", () => {
		const body = render(withBase(BASE));
		expect(body).toContain("sudo find /work/out/test-tmp -mindepth 1 -delete");
		expect(body).toContain("sudo mkdir -p /work/out/test-tmp/home");
		expect(body).toContain("sudo chown -R 65534:65534 /work/out/test-tmp");
		// The setup create is privileged too: an unprivileged mkdir into a tree
		// already owned by 65534 is the EACCES that produced the outage.
		expect(body).not.toMatch(/(?<!sudo )mkdir -p \/work\/out\/test-tmp/);
		// Nothing in the body asks for an rm of the tree; the harness refuses it.
		expect(body).not.toMatch(/rm -rf? \/work\/out\/test-tmp/);
		expect(body).not.toContain("delete that tree and re-create it");
	});

	// PR #685 review P1: on a CLEAN runner the tree does not exist yet, and
	// `find <missing> -mindepth 1 -delete` exits 1 ("No such file or directory"),
	// which the stop-on-failure rule below then turns into an aborted run. The
	// sequence must create the tree before it empties it, and every line must be
	// safe to repeat, so the same four lines serve the first launch and the rest.
	test("PR #685 — the tree is created (privileged) BEFORE it is emptied, so a clean runner's first launch works", () => {
		const body = render(withBase(BASE));
		const create = body.indexOf("sudo mkdir -p /work/out/test-tmp\n");
		const empty = body.indexOf("sudo find /work/out/test-tmp -mindepth 1 -delete");
		expect(create).toBeGreaterThan(-1);
		expect(empty).toBeGreaterThan(-1);
		expect(create).toBeLessThan(empty);
		expect(body).toContain("exactly these four lines");
		expect(body).not.toContain("exactly these three lines");
	});

	test("sf#665 — a fresh-tree failure is published WITH the path and the errno line", () => {
		const body = render(withBase(BASE));
		expect(body).toContain("exact path and the failing command's stderr line");
		expect(body).toContain("Permission denied");
	});

	test("F9 — pinning the config does not silently relocate the project root", () => {
		// `-c` outside the checkout closes the rulesdir hole, but ansible-lint
		// autodetects `project_dir` from the CONFIG FILE'S LOCATION, so `-c` alone
		// moves the project root to the lintrc directory. Measured on rtech-infra
		// (2026-09-03): 233 files processed fell to 125 while the
		// run still printed a green `Passed ... profile production`. The failure is
		// invisible precisely because the exit code and the summary both look right.
		//
		// This pin is the reason the two flags may never be separated: whoever
		// removes `--project-dir` gets a passing suite and half the coverage.
		const ansible = INFRA_STATIC_COMMANDS.ansible.commands[0] ?? "";
		expect(ansible).toContain("--project-dir .");
		// The order matters for readability, not correctness, but a `-c` without a
		// `--project-dir` anywhere after it is the exact defect shape.
		expect(ansible.indexOf("--project-dir .")).toBeGreaterThan(ansible.indexOf("-c /work/lintrc/"));
	});

	// F1: the linter CONFIG was candidate-controlled — flipping `.yamllint` to
	// `extends: relaxed` in the same PR that adds a violation returns exit 0.
	// Probed against yamllint 1.38.0: repo config exit 0, pinned `-c` exit 1.
	test("F1 — linter configuration is pinned outside the checkout", () => {
		const body = render(withBase(BASE));
		expect(INFRA_STATIC_COMMANDS.config.commands[0]).toContain("-c /work/lintrc/yamllint.yml");
		expect(INFRA_STATIC_COMMANDS.ansible.commands[0]).toContain("-c /work/lintrc/ansible-lint.yml");
		// shellcheck's own rc discovery is refused outright (`--norc` covers both a
		// repo `.shellcheckrc` and the `$HOME` one F9's shared-HOME attack writes).
		expect(INFRA_STATIC_COMMANDS.scripts.commands[0]).toContain("--norc");
		// The pinned configs are author-owned and bound read-only.
		expect(body).toContain("/work/lintrc");
	});

	// F2: `shellcheck -f gcc $(git ls-files ...)` is unquoted, so a tracked
	// `--help.sh` becomes an OPTION — probed: exit 3, usage text, zero
	// diagnostics, both runs non-zero, verdict `skip`. F3's empty-list case
	// exits 3 too, so the guard has to be part of the same fix.
	test("F2 — the file list cannot become an option, and an empty list is guarded", () => {
		const command = INFRA_STATIC_COMMANDS.scripts.commands[0] ?? "";
		// The options end before the file list.
		expect(command).toContain('-- "$@"');
		// The list is set positionally and quoted, so no word splitting.
		expect(command).toContain("set --");
		expect(command).not.toContain("gcc $(git ls-files");
		// The empty-list case is handled explicitly rather than exiting 3.
		expect(command).toContain('"$#" -eq 0');
		expect(command).toContain("nothing to lint");
	});
});

describe("check names the body instructs the runner to emit", () => {
	// The body tells the runner to set each check `name` to the exact command
	// string. `resultCheckSchema.name` is `boundedText(120)`, so a fixed command
	// longer than that makes the runner's ONLY compliant answer unparseable and
	// the whole result is refused at ingest -- every check in it, including the
	// verdict the job existed to produce. Observed job 12566 (PR rtech-infra
	// #1461): `too_big at checks.3.name`, zero postings, 759s of runner work
	// discarded. The instruction and the schema disagreed and nothing compared
	// them.
	test("every fixed static command can be a schema-valid check name", () => {
		const rejected: string[] = [];
		let ordinal = 0;
		for (const gate of Object.keys(INFRA_STATIC_COMMANDS) as GateId[]) {
			for (const command of INFRA_STATIC_COMMANDS[gate].commands) {
				ordinal++;
				const name = checkNameForCommand(command, ordinal);
				const parsed = resultCheckSchema.safeParse({ name, status: "pass" });
				if (!parsed.success) {
					rejected.push(`${gate}: name ${name.length} chars`);
				}
			}
		}
		expect(rejected).toEqual([]);
		// Guard the mutation: the raw command IS over the bound, so a future
		// change that reverts to echoing it fails this file rather than a job.
		expect(
			resultCheckSchema.safeParse({
				name: INFRA_STATIC_COMMANDS.scripts.commands[0],
				status: "pass",
			}).success,
		).toBe(false);
	});
});

describe("sf#607 — the comparison key must not carry run-specific state", () => {
	// Every string below is verbatim from the captured tallies of job 12640,
	// runner-2, at /mnt/share/runners/jobs/rw-infra-static-8338db4f-.../out/.
	// Read independently by two sessions with matching counts (305 paths, 3230
	// diagnostics, 3279 lines on BOTH sides) before being pinned here.
	const BASE_ROLE =
		"projects/ansible/playbooks/agent-browser.yml:22:7: syntax-check[specific][/]: The role 'agent_browser' was not found in: /work/base/projects/ansible/playbooks/roles:/tmp/.ansible-7914/roles:/work/out/test-tmp/home/.ansible/roles:/";
	const CANDIDATE_ROLE =
		"projects/ansible/playbooks/agent-browser.yml:22:7: syntax-check[specific][/]: The role 'agent_browser' was not found in: /work/checkout/projects/ansible/playbooks/roles:/tmp/.ansible-bf29/roles:/work/out/test-tmp/home/.ansible/rol";
	const SITE_PACKAGES =
		"/usr/local/lib/uv-tools/ansible-lint/lib/python3.13/site-packages/ansible_compat/runtime.py:243: UserWarning: Project directory /work/checkout/.ansible cannot be used for caching as it is not writable.";
	const EPILOGUE = "Read documentation for instructions on how to ignore specific rule violations.";

	function withBase(baseSha: string): GateSelection {
		return { ...full(), baseSha } as GateSelection;
	}
	const body = render(withBase("b".repeat(40)));

	test("the two runs' checkout roots are named, so an identical finding keys equal", () => {
		// This is the DETERMINISTIC manifestation: the roots differ by
		// construction on every run, so without this rule the agent_browser
		// diagnostic is reported as added every single time (job 12659).
		expect(BASE_ROLE).toContain("/work/base");
		expect(CANDIDATE_ROLE).toContain("/work/checkout");
		// Assert the STRIP instruction, not the bare paths: both appear elsewhere
		// in the body legitimately, so a bare-substring check survives reverting
		// this fix and pins nothing.
		expect(body).toContain("strip the checkout");
		expect(body).toContain("differing on EVERY run");
	});

	test("the random per-run ansible cache directory is stripped", () => {
		expect(BASE_ROLE).toContain("/tmp/.ansible-7914");
		expect(CANDIDATE_ROLE).toContain("/tmp/.ansible-bf29");
		expect(body).toContain("/tmp/.ansible-");
	});

	test("the ansible-lint epilogue is stripped, not left to glue onto a line", () => {
		// The NON-DETERMINISTIC manifestation: written with no separator, so it
		// attaches to whichever diagnostic flushed last (base line 3224,
		// candidate line 2285 in the same job) and manufactures two false keys.
		// The bullet wraps, so assert both halves rather than the joined string.
		expect(EPILOGUE).toContain("Read documentation for instructions");
		expect(body).toContain("a trailing `Read");
		expect(body).toContain("rule violations.` epilogue");
		expect(body).toContain("glues");
	});

	test("a diagnostic outside the checkout root is discarded by locality", () => {
		// No normalization can remove this one: the path is real and absolute.
		// It matches `<path>:<line>: <message>`, which is the whole shape test,
		// so it is counted as a finding about the repository under test.
		expect(SITE_PACKAGES).toMatch(/^\/usr\/local\/.*:\d+: /);
		expect(body).toContain("the linter's own installation");
		expect(body).toContain("under that");
	});

	test("locality is keyed on the checkout root, NEVER on absoluteness alone", () => {
		// Self-review catch. "absolute or not under the checkout root" reads as one
		// test but is two, and they disagree in the base run: EVERY base path is
		// under /work/base and therefore absolute. A literal agent following the
		// absoluteness half empties the base tally, which makes the candidate's
		// whole output look added and fails every PR — worse than the bug fixed.
		//
		// Today's real output is relative (2863 relative vs 2 absolute per side,
		// measured in the job 12640 tallies), so the ambiguity is latent, not
		// firing. It stops being latent the moment a linter emits absolute paths.
		expect(body).toContain("Do NOT discard on absoluteness");
		expect(body).toContain("empty the base tally");
		// The keep-rule is stated positively, so the discard is the exception.
		expect(body).toContain("keep a");
		expect(body).toContain("under that");
	});

	test("normalization is instructed for BOTH files, not just the candidate", () => {
		expect(body).toContain("NORMALIZE both files by the SAME rules");
	});
});
