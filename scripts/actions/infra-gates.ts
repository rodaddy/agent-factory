/**
 * @module scripts/actions/infra-gates
 * @description The gate half of the infra-static Actions lane (827b).
 *   Three steps of `.forgejo/workflows/infra-static.yml` call it, and only the
 *   TRUSTED jobs do (`pending`, `verdict`); the credential-free `check` job
 *   runs the shell script this module writes and nothing else of the factory.
 *
 *   plan     trusted. The Forge compare response for base_sha...head_sha goes
 *            through the reviewed reader (`src/infra/changed-files.ts`) and the
 *            pure selector (`src/infra/gates.ts`) — the same composition as
 *            `src/infra/select.ts`, minus its PR-object read: the base sha is
 *            the watcher's dispatch input, never a fresh read. The selected
 *            gates map to the FIXED command literals of `src/infra/body.ts`
 *            (`INFRA_STATIC_COMMANDS`), and a run script is rendered from those
 *            literals only. Nothing in a path, a file, or a PR reaches a command.
 *            NOTE: a PR dispatch proves completeness via the PR count and paginated
 *            files, with head SHA checks before and after the read. Without a PR,
 *            the reader returns `indeterminate` for every Forgejo compare
 *            (completeness unproven), so today every run escalates to all four
 *            gates. That is the reviewed fail-closed stance, not a defect here.
 *            With PR_READ_DIR set, the PR reads replay a curl recording
 *            (`src/infra/recorded-forge.ts`) and no FORGE_TOKEN or API
 *            is read; without it the PR reads go live through FORGE_TOKEN.
 *   verdict  trusted. Reads the plan it wrote and the check job's report, and
 *            decides `success` (every selected command exited 0), `failure`
 *            (any non-zero, missing, or unreadable line), or `error` (no report
 *            at all: the check job broke before running a gate). A failed
 *            `tool` probe line for a planned gate is `error` (the tool never
 *            started). The report is
 *            UNTRUSTED input: only strict `gate<TAB>index<TAB>exit` lines for
 *            planned commands count, and none of its bytes reach the comment.
 *   comment  trusted. Posts the bounded verdict comment through `postForge`
 *            (scripts/actions/forge-write.ts), with the did-it-land probe.
 *
 * @outputs
 *   - `planInfraGates` -- compare body + shas -> the gate plan
 *   - `renderGateScript` -- plan -> the fixed bash the check job runs
 *   - `decideInfraVerdict` -- plan + report text -> state, description, rows
 *   - `readVerdictInputs` -- plan dir + report dir -> trusted plan, report text
 *   - `renderVerdictComment` -- the bounded, signed PR comment
 *   - `INFRA_GATE_COMMENT_MAX` -- the comment bound
 *   - `GATE_TOOL_PROBES` -- the fixed per-gate tool probe the run script runs first
 *   - `gitTreeReader` / `TargetTreeReader` -- the target read seam: git
 *     objects only (`ls-tree` mode, `show` text), never a checked-out tree
 */

import {
	type LintrcKey,
	REGULAR_BLOB_MODE,
	readFactoryStaticPolicy,
} from "../../src/config/factory-yml";
import type { ForgeClient } from "../../src/forge/boundary";
import { createForgejoClient } from "../../src/forgejo/client";
import { readChangedFilesForSha } from "../../src/infra/changed-files";
import { INFRA_STATIC_COMMANDS } from "../../src/infra/body";
import { recordedForgeClient } from "../../src/infra/recorded-forge";
import { type GateId, STATIC_GATES, selectGates } from "../../src/infra/gates";
import { INFRA_RUNNER_LINTRC_ROOT } from "../../src/infra/sandbox-section";
import { ACTIONS_AGENT, actionsLaneSeat, signatureLine } from "../../src/github/signature";
import { traced } from "../../src/log";
import { type CommentRow, hasIdenticalComment, listProbe, postForge } from "./forge-write";

const LANE = "infra-static";

/** The hard bound on the PR comment body. */
export const INFRA_GATE_COMMENT_MAX = 4000;

/** Fixed per-gate tool probes: a probe that fails means the gate's tool
 * never started, so its exit codes are not findings. */
export const GATE_TOOL_PROBES: Record<GateId, string> = {
	ansible: "ansible-lint --version && yamllint --version",
	workflows: "actionlint -version",
	scripts: "shellcheck --version",
	config: "yamllint --version && yq --version",
};

/** The report is untrusted; anything past this is not read. */
const REPORT_MAX_BYTES = 8192;

export interface GatePlanEntry {
	gate: GateId;
	label: string;
	commands: readonly string[];
}

export interface GatePlan {
	gates: GatePlanEntry[];
	fullEscalation: boolean;
	reason: string;
	changedReason: string;
	/** Which static policy applied: the target repo's factory.yml, or the default (827c). */
	policy: "default" | "factory.yml";
	/** A present but invalid factory.yml: the verdict is `error`, naming the field. */
	policyError?: string;
	/** Bounded plan notes (a policy lintrc path absent from the checkout). */
	notes: string[];
	/** Path-selected gates the factory.yml policy switched off (827c repair). */
	excludedByPolicy?: GateId[];
}

/**
 * How the trusted job reads the TARGET: git objects at the target sha, never a
 * working tree (a checkout inside the factory tree let target files shadow the
 * factory's own modules). `mode` is the `git ls-tree` mode of exactly that
 * path, or null when absent; `show` is its `git show` text.
 */
export interface TargetTreeReader {
	mode(path: string): Promise<string | null>;
	show(path: string): Promise<string>;
}

async function git(gitDir: string, args: string[]): Promise<string> {
	const proc = Bun.spawn(["git", "-C", gitDir, ...args], { stdout: "pipe", stderr: "pipe" });
	const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
	if (code !== 0) throw new Error(`git ${args[0]} exited ${code}`);
	return out;
}

function gitTreeReaderImpl(gitDir: string, sha: string): TargetTreeReader {
	return {
		mode: async (path) => {
			const out = await git(gitDir, ["ls-tree", "--full-tree", sha, "--", path]);
			// "<mode> <type> <object>\t<path>": only an exact path match counts
			// (a path under a symlinked dir lists nothing; a dir path lists its children).
			for (const line of out.split("\n")) {
				const tab = line.indexOf("\t");
				if (tab > 0 && line.slice(tab + 1) === path) return line.split(" ")[0] ?? null;
			}
			return null;
		},
		show: (path) => git(gitDir, ["show", `${sha}:${path}`]),
	};
}

/** The target read seam over a git dir that holds the target sha, no checkout. */
export const gitTreeReader = traced("actions.gitTreeReader", gitTreeReaderImpl);

export type InfraVerdictState = "success" | "failure" | "error";

export interface InfraVerdictRow {
	gate: GateId;
	index: number;
	exit: number | null;
}

export interface InfraVerdict {
	state: InfraVerdictState;
	description: string;
	rows: InfraVerdictRow[];
	/** Planned gates whose tool probe exited non-zero. */
	toolFailed?: GateId[];
}

function isGateId(value: unknown): value is GateId {
	return typeof value === "string" && (STATIC_GATES as readonly string[]).includes(value);
}

async function planInfraGatesImpl(
	compareBody: unknown,
	repository: string,
	base: string,
	sha: string,
	tree?: TargetTreeReader,
	prRead?: { client: ForgeClient; pullNumber: number },
): Promise<GatePlan> {
	// The compare body was read in the trusted job; this client only serves it.
	const client = {
		provider: "forgejo",
		getPage: async () => ({ body: compareBody, next: null }),
	} as unknown as ForgeClient;
	const changed = await readChangedFilesForSha({
		client: prRead?.client ?? client,
		repository,
		base,
		sha,
		provider: "forgejo",
		pullNumber: prRead?.pullNumber,
	});
	const selection = selectGates(changed.paths, changed.indeterminate);
	const common = {
		fullEscalation: selection.fullEscalation,
		reason: selection.reason,
		changedReason: changed.reason,
	};
	// The policy is read from the target's git objects (827c), never an input.
	const read =
		tree === undefined ? { ok: true as const, policy: null } : await readPolicyFrom(tree);
	if (!read.ok) {
		return { ...common, gates: [], policy: "factory.yml", policyError: read.error, notes: [] };
	}
	const allowed = read.policy?.gates ?? selection.gates;
	const notes: string[] = [];
	const present: Partial<Record<LintrcKey, string>> = {};
	for (const [key, path] of Object.entries(read.policy?.lintrc ?? {}) as [LintrcKey, string][]) {
		if ((await tree?.mode(path)) === REGULAR_BLOB_MODE) present[key] = path;
		else notes.push(`${key} ${path} is not in the checkout: the default config is used`);
	}
	return {
		...common,
		gates: selection.gates
			.filter((gate) => allowed.includes(gate))
			.map((gate) => ({
				gate,
				label: INFRA_STATIC_COMMANDS[gate].label,
				commands: INFRA_STATIC_COMMANDS[gate].commands.map((c) => withLintrc(c, present)),
			})),
		policy: read.policy?.source ?? "default",
		notes,
		excludedByPolicy: selection.gates.filter((gate) => !allowed.includes(gate)),
	};
}

async function readPolicyFrom(tree: TargetTreeReader) {
	const mode = await tree.mode("factory.yml");
	if (mode === null) return readFactoryStaticPolicy(null);
	// A non-regular mode is refused on the mode alone: its object is never read.
	const text = mode === REGULAR_BLOB_MODE ? await tree.show("factory.yml") : "";
	return readFactoryStaticPolicy({ mode, text });
}

/**
 * Thread a policy lintrc path into a FIXED command literal, in each tool's own
 * config-flag style. The path passed factory-yml's shell-inert charset and is
 * single-quoted as well; a key not present leaves the literal untouched.
 */
function withLintrc(command: string, present: Partial<Record<LintrcKey, string>>): string {
	const q = (p: string) => `'${p}'`;
	const root = INFRA_RUNNER_LINTRC_ROOT;
	let out = command;
	const yl = present.yamllint_config;
	if (yl) {
		out = out
			.replace(`YAMLLINT_CONFIG_FILE=${root}/yamllint.yml `, `YAMLLINT_CONFIG_FILE=${q(yl)} `)
			.replace(`yamllint -f parsable -c ${root}/yamllint.yml`, `yamllint -f parsable -c ${q(yl)}`);
	}
	const al = present.ansible_lint_config;
	if (al) out = out.replace(`-c ${root}/ansible-lint.yml`, `-c ${q(al)}`);
	const sc = present.shellcheck_rc;
	if (sc) out = out.replace("shellcheck --norc ", `shellcheck --rcfile ${q(sc)} `);
	const ac = present.actionlint_config;
	if (ac) out = out.replace("then actionlint;", `then actionlint -config-file ${q(ac)};`);
	return out;
}

export const planInfraGates = traced("actions.planInfraGates", planInfraGatesImpl, {
	redact: { args: [0] },
});

function renderGateScriptImpl(plan: GatePlan): string {
	const lines = [
		"#!/usr/bin/env bash",
		"# GENERATED by scripts/actions/infra-gates.ts in the trusted `pending` job",
		"# from the fixed INFRA_STATIC_COMMANDS literals. Usage: run-gates.sh <src> <out>",
		"set -u",
		'SRC="$1"; OUT="$2"',
		`mkdir -p ${INFRA_RUNNER_LINTRC_ROOT} "$OUT/logs"`,
		`printf 'extends: default\\n' > ${INFRA_RUNNER_LINTRC_ROOT}/yamllint.yml`,
		`printf 'profile: basic\\n' > ${INFRA_RUNNER_LINTRC_ROOT}/ansible-lint.yml`,
		': > "$OUT/report.tsv"',
		'cd "$SRC" || exit 3',
	];
	for (const entry of plan.gates) {
		if (isGateId(entry.gate)) {
			lines.push(
				`( ${GATE_TOOL_PROBES[entry.gate]} ) > "$OUT/logs/${entry.gate}-tool.log" 2>&1 < /dev/null`,
			);
			lines.push(`printf 'tool\\t${entry.gate}\\t%s\\n' "$?" >> "$OUT/report.tsv"`);
		}
		entry.commands.forEach((command, index) => {
			lines.push(`( ${command} ) > "$OUT/logs/${entry.gate}-${index}.log" 2>&1 < /dev/null`);
			lines.push(`printf '${entry.gate}\\t${index}\\t%s\\n' "$?" >> "$OUT/report.tsv"`);
		});
	}
	lines.push(
		'for f in "$OUT"/logs/*.log; do [ -f "$f" ] && tail -c 65536 "$f" > "$f.t" && mv "$f.t" "$f"; done',
		"exit 0",
		"",
	);
	return lines.join("\n");
}

export const renderGateScript = traced("actions.renderGateScript", renderGateScriptImpl);

/** The planned (gate, index) pairs, from the plan's gate ids and the fixed literals. */
function plannedRows(plan: GatePlan): InfraVerdictRow[] {
	const rows: InfraVerdictRow[] = [];
	for (const entry of plan.gates) {
		if (!isGateId(entry.gate)) continue;
		INFRA_STATIC_COMMANDS[entry.gate].commands.forEach((_c, index) => {
			rows.push({ gate: entry.gate, index, exit: null });
		});
	}
	return rows;
}

function decideInfraVerdictImpl(plan: GatePlan | null, report: string | null): InfraVerdict {
	if (plan === null) {
		return {
			state: "error",
			description: "infra-static: no gate plan arrived from the pending job",
			rows: [],
		};
	}
	const rows = plannedRows(plan);
	if (plan.policyError) {
		return { state: "error", description: `infra-static: ${plan.policyError}`, rows };
	}
	if (rows.length === 0 && (plan.excludedByPolicy ?? []).length > 0) {
		const off = (plan.excludedByPolicy ?? []).join(", ");
		return {
			state: "success",
			description: `infra-static: nothing run, every selected gate excluded by policy (${off})`,
			rows,
		};
	}
	if (rows.length === 0) {
		return { state: "error", description: "infra-static: the gate plan selected no gate", rows };
	}
	if (report === null) {
		return {
			state: "error",
			description: "infra-static: the check job produced no gate report",
			rows,
		};
	}
	const deadTools = new Set<GateId>();
	for (const line of report.slice(0, REPORT_MAX_BYTES).split("\n")) {
		const t = /^tool\t([a-z]+)\t(\d{1,3})$/.exec(line);
		if (t) {
			const gate = rows.find((r) => r.gate === t[1])?.gate;
			if (gate !== undefined && Number(t[2]) !== 0) deadTools.add(gate);
			continue;
		}
		const m = /^([a-z]+)\t(\d)\t(\d{1,3})$/.exec(line);
		if (!m) continue;
		const row = rows.find((r) => r.gate === m[1] && r.index === Number(m[2]));
		if (!row) continue;
		const exit = Number(m[3]);
		// A duplicated line can only make a row worse, never better.
		row.exit = row.exit === null || row.exit === 0 ? exit : row.exit;
	}
	if (deadTools.size > 0) {
		const dead = [...new Set(rows.map((r) => r.gate))].filter((g) => deadTools.has(g));
		return {
			state: "error",
			description: `infra-static: gate tool(s) did not start: ${dead.join(", ")}`,
			rows,
			toolFailed: dead,
		};
	}
	const failed = rows.filter((r) => r.exit !== 0);
	const gates = [...new Set(rows.map((r) => r.gate))].join(", ");
	if (failed.length === 0) {
		return { state: "success", description: `infra-static: all gates passed (${gates})`, rows };
	}
	const names = [...new Set(failed.map((r) => r.gate))].join(", ");
	return { state: "failure", description: `infra-static: gate(s) failed: ${names}`, rows };
}

export const decideInfraVerdict = traced("actions.decideInfraVerdict", decideInfraVerdictImpl);

function renderVerdictCommentImpl(
	plan: GatePlan | null,
	verdict: InfraVerdict,
	sha: string,
	runUrl: string,
): string {
	if (plan === null) {
		return [
			signatureLine({ agent: ACTIONS_AGENT, seat: actionsLaneSeat(LANE), model: "" }),
			"",
			`## factory/infra-static: ${verdict.state}`,
			"",
			`Head \`${sha}\`. ${verdict.description}.`,
			"",
			`Logs: the \`infra-static-report\` artifact of ${runUrl}`,
		]
			.join("\n")
			.slice(0, INFRA_GATE_COMMENT_MAX);
	}
	const lines = [
		signatureLine({ agent: ACTIONS_AGENT, seat: actionsLaneSeat(LANE), model: "" }),
		"",
		`## factory/infra-static: ${verdict.state} (policy: ${plan.policy ?? "default"})`,
		"",
		`Head \`${sha}\`. ${plan.reason}. ${plan.changedReason}.`,
		...(plan.policyError ? ["", verdict.description] : []),
		...(plan.notes ?? []).map((n) => `- ${n}`),
		...((plan.excludedByPolicy ?? []).length > 0
			? [
					`- excluded by factory.yml policy: ${(plan.excludedByPolicy ?? []).filter(isGateId).join(", ")}`,
				]
			: []),
		...((verdict.toolFailed ?? []).filter(isGateId).length > 0
			? [
					`- tool did not start: ${(verdict.toolFailed ?? []).filter(isGateId).join(", ")} (see ${(
						verdict.toolFailed ?? []
					)
						.filter(isGateId)
						.map((g) => `${g}-tool.log`)
						.join(", ")} in the report artifact)`,
				]
			: []),
		"",
		"| gate | command | exit |",
		"|---|---|---|",
		...verdict.rows.map(
			(r) =>
				`| ${r.gate} | ${INFRA_STATIC_COMMANDS[r.gate].label} #${r.index + 1} | ${r.exit === null ? "no report" : r.exit} |`,
		),
		"",
		`Logs: the \`infra-static-report\` artifact of ${runUrl}`,
	];
	return lines.join("\n").slice(0, INFRA_GATE_COMMENT_MAX);
}

export const renderVerdictComment = traced(
	"actions.renderVerdictComment",
	renderVerdictCommentImpl,
);

async function readJsonOr(path: string, fallback: unknown): Promise<unknown> {
	try {
		return JSON.parse(await Bun.file(path).text());
	} catch {
		return fallback;
	}
}

/**
 * The verdict's two inputs, from two DIFFERENT directories: the trusted plan
 * from `planDir` (the pending job's artifact) and ONLY `report.tsv` from
 * `reportDir` (the untrusted check job's artifact). Nothing else is read from
 * the report dir, so a forged plan.json there never replaces the trusted plan.
 */
async function readVerdictInputsImpl(
	planDir: string,
	reportDir: string,
): Promise<{ plan: GatePlan | null; report: string | null }> {
	const raw = await readJsonOr(`${planDir}/plan.json`, null);
	const plan =
		typeof raw === "object" && raw !== null && Array.isArray((raw as { gates?: unknown }).gates)
			? (raw as GatePlan)
			: null;
	const reportFile = Bun.file(`${reportDir}/report.tsv`);
	const report = (await reportFile.exists()) ? await reportFile.text() : null;
	return { plan, report };
}

export const readVerdictInputs = traced("actions.readVerdictInputs", readVerdictInputsImpl);

function need(name: string): string {
	const value = process.env[name] ?? "";
	if (value === "") throw new Error(`infra-gates: ${name} is not set`);
	return value;
}

if (import.meta.main) {
	const [cmd, a, b, c] = process.argv.slice(2);
	if (cmd === "plan" && a && b && c) {
		// plan <compare.json> <outdir> <target-git-dir>: an unreadable compare is
		// `{}`, which the reader calls indeterminate, which escalates to every gate.
		// The static policy is read from the target's git OBJECTS at HEAD_SHA
		// (ls-tree + show, 827c): the target tree is never checked out here.
		// PR_READ_DIR: the PR reads replay a curl recording, and no
		// token is read; a broken recording is indeterminate, so every gate runs.
		const recording = process.env.PR_READ_DIR;
		const compare = await readJsonOr(a, {});
		const head = need("HEAD_SHA");
		const plan = await planInfraGates(
			compare,
			need("REPO"),
			need("BASE_SHA"),
			head,
			gitTreeReader(c, head),
			process.env.PR
				? {
						client: recording
							? recordedForgeClient(recording)
							: createForgejoClient(need("FORGE_TOKEN"), { baseUrl: need("API") }),
						pullNumber: Number(process.env.PR),
					}
				: undefined,
		);
		await Bun.write(`${b}/plan.json`, `${JSON.stringify(plan, null, 2)}\n`);
		await Bun.write(`${b}/run-gates.sh`, renderGateScript(plan));
		console.log(`plan: ${plan.gates.map((g) => g.gate).join(", ")} (${plan.reason})`);
	} else if (cmd === "verdict" && a && b && c) {
		// verdict <plandir> <reportdir> <outdir>: the trusted plan and the
		// untrusted report arrive in separate directories (readVerdictInputs).
		const { plan, report } = await readVerdictInputs(a, b);
		const verdict = decideInfraVerdict(plan, report);
		await Bun.write(`${c}/verdict.txt`, verdict.state);
		await Bun.write(`${c}/desc.txt`, verdict.description.slice(0, 120));
		await Bun.write(
			`${c}/comment.md`,
			renderVerdictComment(plan, verdict, need("HEAD_SHA"), need("RUN_URL")),
		);
		console.log(`verdict: ${verdict.state} (${verdict.description})`);
	} else if (cmd === "comment" && a) {
		const api = need("API");
		const repo = need("REPO");
		const pr = need("PR");
		const body = await Bun.file(a).text();
		const headers = {
			Authorization: `token ${need("FORGE_TOKEN")}`,
			"Content-Type": "application/json",
		};
		const since = new Date(Date.now() - 60_000).toISOString();
		const result = await postForge(
			`${api}/repos/${repo}/issues/${pr}/comments`,
			{ method: "POST", headers, body: JSON.stringify({ body }) },
			{
				alreadyApplied: listProbe<CommentRow>(
					`${api}/repos/${repo}/issues/${pr}/comments?since=${encodeURIComponent(since)}`,
					{ headers },
					(rows) => hasIdenticalComment(rows, body),
				),
			},
		);
		console.log(`comment POST -> ${result.status}`);
		if (!result.ok) process.exitCode = 1;
	} else {
		process.stderr.write(
			"usage: [PR=<n> [PR_READ_DIR=<dir>]] infra-gates.ts plan <compare.json> <out> <target-git-dir> | verdict <plandir> <reportdir> <out> | comment <file>\n",
		);
		process.exitCode = 3;
	}
}
