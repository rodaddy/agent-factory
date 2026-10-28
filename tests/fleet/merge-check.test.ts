/**
 * @module tests/fleet/merge-check
 * @description `fleet/skills/merge-pr/bin/merge-check`, run as a real
 *   child process against a fake Forge and a fake board on one port. The verdict
 *   is the review lead's own board comment on the review issue for the exact
 *   head: nobody else's comment, on Forge or on the board, counts. Covers each
 *   class, each status state, the path rules (renames included), and that
 *   neither token reaches the output. `MERGE_CHECK_UNDER_TEST` points the suite
 *   at a mutated copy of the script. No path, repo or opener decides the class.
 *  Since sf#1493 class B is only `needs-rico`, and client/* is class C
 *   with no Forge or board request. The council is dissolved:
 *   what a lead cannot decide waits on Smythe.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { testTmpBase } from "../support/test-temp";

const SCRIPT =
	process.env.MERGE_CHECK_UNDER_TEST ??
	resolve(import.meta.dir, "../../fleet/skills/merge-pr/bin/merge-check");
const TOKEN = ["fake", "forge", "value", "1207"].join("-");
const BOARD_KEY = ["fake", "board", "value", "1207"].join("-");
const COMPANY = "co-1";
const LEAD = "agent-lead";
const AUTHOR = "agent-author";
const SHA = "a".repeat(40);
const OTHER = "c".repeat(40);
// Same first 7 characters as SHA, a different commit.
const TWIN = `${"a".repeat(7)}${"d".repeat(33)}`;
const GREEN: Record<string, string> = {
	"factory/prepush": "success",
	"factory/pr-review": "success",
};
// rtech/k3s-deploy runs its own CI: its workflow's native status, and
// the factory's sop-gate lane. One head per k3s-deploy PR, so the head picks them.
const K3S_CI = "factory/k3s-ci / check (pull_request)";
const K3S_GREEN: Record<string, string> = { [K3S_CI]: "success", "sop-gate": "success" };
const K3S = (n: number) => n.toString(16).padStart(40, "e");
// rtech/rtech-whisper runs its own CI (rtech-whisper PR 547): workflow Tests, job
// pr-quality. One head per rtech-whisper PR, so the head picks the statuses.
const WHISPER_CI = "Tests / pr-quality (pull_request)";
const WHISPER = (n: number) => n.toString(16).padStart(40, "f");
// rodaddy/mcp2cli runs its own CI (SOF-11343): workflow CI, job check. It has no
// factory/smoke or factory/prepush lane; factory/pr-review is advisory there.
const MCP2CLI_CI = "CI / check (pull_request)";
const MCP2CLI = (n: number) => n.toString(16).padStart(40, "b");

type File = string | { filename: string; previous_filename: string };
type BoardComment = { by: string; verdict: string; tail?: string; linked?: boolean };
type Pr = {
	files?: File[];
	filesUnreadable?: "http" | "shape";
	head?: string;
	state?: string;
	merged?: boolean;
	labels?: string[];
	statuses?: Record<string, string>;
	/** Comments on the board review issue, oldest first. */
	board?: BoardComment[];
	/** The full sha the board review issue names; default the PR head. */
	reviewedSha?: string;
	/** Forge comments in the verdict shape, by login. */
	forge?: Array<{ login: string; verdict: string }>;
	/** The Forge login that opened the PR; default a non-employee. */
	author?: string;
	/** The PR body; default DEFAULT_BODY, which passes the sf#1413 gate. */
	body?: string;
	/** Decision lines on the review issue (`smythe: ...`), by default Smythe's, at 17:0i,
	 * under a review heading naming <sha> (default the PR head; "" for no heading). */
	smythe?: Array<{ line: string; by?: string; sha?: string }>;
	/** Plain Forge PR comments, with their Forgejo created_at. */
	notes?: Array<{ login: string; body: string; at: string }>;
	/** SOF-8387: board comments in order, before every `board` and `council` one. */
	thread?: Post[];
	/** SOF-8387: comments on the look-alike issue the search also returns. */
	lookalike?: Post[];
	/** SOF-8387: assignee changes in the review issue's board activity log. */
	assigned?: Assign[];
	/** sf#1730: reviewer pair tasks `Review <repo>#<n> @ <sha7> (<name>)`; sha is the
	 * full sha the description names (default the head). */
	pairs?: Array<{
		name: string;
		sha?: string;
		posts: Post[];
		origin?: string;
		creator?: string;
		status?: string;
	}>;
	/** sf#1911: the PR base branch; default "main", the repo default branch. */
	base?: string;
	/** sf#1911: the fake omits `base` from the PR entirely. */
	noBase?: boolean;
	/** sf#1690: the PR's `.diff`; default PLAIN_DIFF, null for a failed read. */
	diff?: string | null;
};
/** SOF-8387: one `issue.updated` assignee change; `by` is the board's actor stamp. */
type Assign = { by: string; to: string | null; at: string; actorType?: string };
/**
 * SOF-8387: one board comment on the review issue. `verdict` renders the lead's
 * heading (at `sha7`, default the head) and verdict line; `text` is the body or,
 * with a verdict, a tail. `at` pins createdAt; otherwise the order sets it.
 */
type Post = { by: string; verdict?: string; sha7?: string; text?: string; at?: string };
// sf#1482: Development's PR-body set, minus the Backout and Test plan above.
const NO_BLAST =
	"**agent:** claude-code · model m · seat s · 2026-10-06\n\n## Summary\n\nA change.\n\n## Evidence\n\nbun test passed.\n\n## Merge danger\n\ntwo-way door\n";
const SET = `${NO_BLAST}Blast radius: one file.\nRefs https://forge.example.internal/o/r/issues/1\n\n`;
// The set, a real Backout (rehearsed, so a big change passes too) and Test plan.
const DEFAULT_BODY = `${SET}## Backout\n\nRevert the merge commit.\nrehearsed: https://example.invalid/r/1\n\n## Test plan\n\nbun test\n`;
const approve: BoardComment[] = [{ by: LEAD, verdict: "approve" }];
// sf#1690: the default PR diff, no ruling marker on either side.
const PLAIN_DIFF =
	"diff --git a/src/util/format.ts b/src/util/format.ts\n--- a/src/util/format.ts\n+++ b/src/util/format.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n";
const PRS: Record<string, Pr> = {
	"o/r#1": { board: approve },
	"client/client-core#2": { board: approve },
	// client/client-agent has moved to Forge and is merged like any repo.
	"client/client-agent#1375": { board: approve },
	"o/r#3": { files: [".forgejo/workflows/x.yml"], board: approve },
	"o/r#4": { board: [{ by: LEAD, verdict: "fix-first" }] },
	"o/r#5": { board: approve, head: OTHER },
	"o/r#6": { board: approve, labels: ["needs-rico"] },
	// The lead said fix-first; the author then says approve, on Forge and on the board.
	"o/r#7": {
		board: [
			{ by: LEAD, verdict: "fix-first" },
			{ by: AUTHOR, verdict: "approve" },
		],
		forge: [
			{ login: "sf-smythe", verdict: "fix-first" },
			{ login: "sf-bishop", verdict: "approve" },
		],
	},
	// No lead verdict at all; only other people's.
	"o/r#8": {
		board: [{ by: AUTHOR, verdict: "approve" }],
		forge: [{ login: "sf-bishop", verdict: "approve" }],
	},
	// The lead approved a different commit with the same 7-character prefix.
	"o/r#9": { board: approve, reviewedSha: TWIN },
	"st/missing#10": {
		board: approve,
		statuses: { "factory/prepush": "success" },
	},
	"st/red#11": { board: approve, statuses: { ...GREEN, "factory/pr-review": "failure" } },
	"st/pending#12": { board: approve, statuses: { ...GREEN, "factory/prepush": "pending" } },
	"st/none#13": { board: approve, statuses: { "ci/build": "success" } },
	// The real statuses of rodaddy/closed-brain PR 11 at f2b8ffa (SOF-12237): the
	// deploy job runs only on a push to main, so a pull request skips it.
	"st/skipped#290": {
		board: approve,
		statuses: {
			"CI / python-package (pull_request)": "success",
			"PR Body / validate (pull_request)": "success",
			"CI / check (pull_request)": "success",
			"CI / deploy (pull_request)": "skipped",
		},
	},
	"st/all-skipped#291": { board: approve, statuses: { "CI / deploy (pull_request)": "skipped" } },
	"st/skipped-red#292": {
		board: approve,
		statuses: { "CI / check (pull_request)": "failure", "CI / deploy (pull_request)": "skipped" },
	},
	"st/factory-skipped#293": {
		board: approve,
		statuses: { ...GREEN, "factory/prepush": "skipped" },
	},
	"o/r#14": { files: ["src/auth/login.ts"], board: approve },
	"o/r#15": {
		files: [{ filename: "docs/build.yml", previous_filename: ".forgejo/workflows/build.yml" }],
		board: approve,
	},
	"o/r#16": { board: approve, state: "closed" },
	"o/r#17": { board: approve, state: "closed", merged: true },
	// The real shape: text after the verdict line (SOF-1353 ended with a disposition).
	"o/r#18": {
		board: [{ by: LEAD, verdict: "approve-with-fixes", tail: "\n\n**Disposition:** done." }],
	},
	// A Forge comment by the lead's login, and no board verdict: Forge is not the record.
	"o/r#19": { forge: [{ login: "sf-smythe", verdict: "approve" }] },
	// The lead links the PR in the heading, as company-conduct asks (SOF-1373).
	"o/r#20": { board: [{ by: LEAD, verdict: "approve", linked: true }] },
	"o/r#21": { board: [{ by: LEAD, verdict: "fix-first", linked: true }] },
	// sf SOF-2594: a `checks: static-only` repo's lane posts factory/infra-static only.
	"st/static#22": { board: approve, statuses: { "factory/infra-static": "success" } },
	"st/static-red#23": { board: approve, statuses: { "factory/infra-static": "failure" } },
	"st/static-std#24": { board: approve, statuses: GREEN },
	// A standard repo cannot pick the static lane by carrying its status.
	"st/plain#25": { board: approve, statuses: { "factory/infra-static": "success" } },
	// SOF-2653: a provider-first (or checks-first) static-only item must not lend its
	// lane to the name-first standard item before it, and must keep its own.
	"st/std-before-pf#26": { board: approve, statuses: { "factory/infra-static": "success" } },
	"st/static-pf#27": { board: approve, statuses: { "factory/infra-static": "success" } },
	"st/std-before-cf#28": { board: approve, statuses: { "factory/infra-static": "success" } },
	"st/static-cf#29": { board: approve, statuses: { "factory/infra-static": "success" } },
	// sf#1911: a stacked child, its base a feature branch, not the default.
	"o/r#1911": { board: approve, base: "feat/parent" },
	// sf#1911: Forge returned no base at all.
	"o/r#1912": { board: approve, noBase: true },
	// sf#1262 (D23): factory-smoke posts no factory/smoke any more.
	"st/nosmoke#30": {
		board: approve,
		statuses: { "factory/prepush": "success", "factory/pr-review": "success" },
	},
};
// The enrolment merge-check reads: config/repos.yml on the factory's main.
const REPOS_YML = `poll_interval_minutes: 15
repositories:
  - name: st/static
    provider: forgejo
    checks: static-only
    static_runtime: actions
  - name: st/static-red
    checks: static-only # sf#827
  - name: "st/static-std"
    checks: static-only
  - name: st/plain
    provider: forgejo
    # checks: static-only
    checks: standard
  - name: st/std-before-pf
    provider: forgejo
    checks: standard
  - provider: forgejo
    name: st/static-pf
    checks: static-only
  - name: st/std-before-cf
    checks: standard
  - checks: static-only
    provider: forgejo
    name: st/static-cf
  # - name: o/r
  #   checks: static-only
job_templates:
  - name: o/r
    checks: static-only
`;

// Board agents besides the lead and the author. Numbers stay unique across the
// whole fixture.
const ADAMS = "agent-adams";
const KONG = "agent-kong";
const CZAJKA = "agent-czajka";
// sf#1730: the reviewer pair's other seats (Kapoor is below, Kong above).
const GIRAUD = "agent-giraud";
const COLTER = "agent-colter";
Object.assign(PRS, {
	"rtech/k3s-deploy#85": { board: approve, head: K3S(85), statuses: K3S_GREEN },
	// sf#1400: k3s-deploy's own CI decides its checks, not the factory lanes'.
	// Smythe approves it: k3s-deploy waits on his decision (no council, the owner, 2026-10-06).
	"rtech/k3s-deploy#300": {
		board: approve,
		head: K3S(300),
		statuses: K3S_GREEN,
		smythe: [{ line: "smythe: approve" }],
	},
	"rtech/k3s-deploy#301": {
		board: approve,
		head: K3S(301),
		statuses: { [K3S_CI]: "success", "sop-gate": "pending" },
	},
	"rtech/k3s-deploy#302": {
		board: approve,
		head: K3S(302),
		statuses: { [K3S_CI]: "failure", "sop-gate": "success" },
	},
	"rtech/k3s-deploy#303": { board: approve, head: K3S(303), statuses: { "sop-gate": "success" } },
	// rtech-whisper's own CI decides its checks, not the factory lanes'.
	// Smythe approves each: rtech-whisper waits on his decision.
	"rtech/rtech-whisper#320": {
		board: approve,
		head: WHISPER(320),
		statuses: { [WHISPER_CI]: "success" },
		smythe: [{ line: "smythe: approve" }],
	},
	"rtech/rtech-whisper#321": {
		board: approve,
		head: WHISPER(321),
		statuses: { "factory/pr-review": "success" },
		smythe: [{ line: "smythe: approve" }],
	},
	"rtech/rtech-whisper#322": {
		board: approve,
		head: WHISPER(322),
		statuses: { [WHISPER_CI]: "failure" },
		smythe: [{ line: "smythe: approve" }],
	},
	// The real statuses of rodaddy/mcp2cli PR 113 at cddffb2 (SOF-11343); 343 to
	// 345 because 113 to 115 are taken by the PR-body fixtures on o/r.
	"rodaddy/mcp2cli#343": {
		board: approve,
		head: MCP2CLI(343),
		statuses: {
			"CI / check (push)": "success",
			[MCP2CLI_CI]: "success",
			"factory/pr-review": "success",
		},
	},
	"rodaddy/mcp2cli#344": {
		board: approve,
		head: MCP2CLI(344),
		statuses: { "CI / check (push)": "success", "factory/pr-review": "success" },
	},
	"rodaddy/mcp2cli#345": {
		board: approve,
		head: MCP2CLI(345),
		statuses: { [MCP2CLI_CI]: "failure", "factory/pr-review": "success" },
	},
	"rtech/k3s-deploy#304": {
		board: approve,
		head: K3S(304),
		statuses: { ...GREEN, "sop-gate": "success" },
	},
});

// The PR-body gate. Every PR here the lead approved
// with green statuses, so the gate is the only thing that can make it class C.
const BACKOUT = "## Backout\n\nRevert the merge commit.\n";
const REHEARSED_BACKOUT = `${BACKOUT}rehearsed: https://example.invalid/r/2\n`;
const TEST_PLAN = "## Test plan\n\nbun test tests/x.test.ts\n";
const WORKFLOW = [".forgejo/workflows/x.yml"];
Object.assign(PRS, {
	"o/r#101": { board: approve, body: `${SET}## Summary\n\nx\n\n${TEST_PLAN}` },
	"o/r#102": { board: approve, body: `${SET}## Summary\n\nx\n\n${BACKOUT}` },
	"o/r#103": { board: approve, body: `${SET}## Summary\n\nJust a change.\n` },
	"o/r#104": { board: approve, body: `${SET}## Backout\n\nTBD\n\n${TEST_PLAN}` },
	"o/r#105": {
		board: approve,
		body: `${SET}${BACKOUT}\n## Test plan\n\n<!-- say how you\ntested it -->\n`,
	},
	"o/r#106": {
		board: approve,
		body: `${SET}### Back out plan\n\nRevert the merge commit.\n\n${TEST_PLAN}`,
	},
	"o/r#107": { board: approve, files: WORKFLOW, body: `${SET}${BACKOUT}\n${TEST_PLAN}` },
	"o/r#108": { board: approve, files: WORKFLOW, body: `${SET}${REHEARSED_BACKOUT}\n${TEST_PLAN}` },
	"rtech/rtech-infra#109": {
		board: approve,
		files: ["docs/x.md"],
		body: `${SET}${BACKOUT}\n${TEST_PLAN}`,
	},
	"rtech/rtech-infra#110": {
		board: approve,
		files: ["projects/a.yml"],
		body: `${SET}${BACKOUT}\n${TEST_PLAN}`,
	},
	"o/r#111": { board: approve, body: `${SET}## Summary\n\nx\n\n${BACKOUT}\n${TEST_PLAN}` },
	"st/gate-red#112": {
		board: [{ by: LEAD, verdict: "fix-first" }],
		statuses: { ...GREEN, "factory/pr-review": "failure" },
		body: `${SET}${TEST_PLAN}`,
	},
	"o/r#115": {
		board: approve,
		body: `${NO_BLAST}\nRefs https://forge.example.internal/o/r/issues/1\n\n${BACKOUT}\n${TEST_PLAN}`,
	},
	// PR 1420 round 2: plans a renderer never shows are no plans.
	"o/r#113": {
		board: approve,
		body: `${SET}<!--\n${BACKOUT}\n${TEST_PLAN}-->\n## Summary\n\nA change.\n`,
	},
	"o/r#114": {
		board: approve,
		body: `${SET}## Summary\n\nA change.\n<!-- left open\n${BACKOUT}\n${TEST_PLAN}`,
	},
});
// Legacy review issues (before the 2026-10-08 flat pair): one Smythe dispatched
// to Adams or Czajka (SOF-8387; here, by assignment) still takes that seat's
// verdict (PR 1578). New reviews go to one Sol + one Sonnet pair, no lead.
const handTo = (to: string, at = "2026-10-02T12:30:00.000Z"): Assign => ({ by: LEAD, to, at });
Object.assign(PRS, {
	"o/r#150": { board: [{ by: ADAMS, verdict: "approve" }], assigned: [handTo(ADAMS)] },
	"o/r#151": { board: [{ by: CZAJKA, verdict: "approve" }], assigned: [handTo(CZAJKA)] },
	// Smythe approved, then a Review Lead said fix-first: the latest verdict decides.
	"o/r#152": {
		board: [
			{ by: LEAD, verdict: "approve" },
			{ by: CZAJKA, verdict: "fix-first" },
		],
		assigned: [handTo(CZAJKA)],
	},
	// A Code Reviewer is no Review Lead: Kong's approve is no verdict.
	"o/r#153": { board: [{ by: KONG, verdict: "approve" }] },
});

let server: ReturnType<typeof Bun.serve>;
let api = "";
// Every request the fake Forge and board serve, by path.
const seen: string[] = [];
// Fake Jev merge-go, keyed by the PR title the fake Forge serves (repo#n):
// default 0.85 (GO); "down" is a 500. Each state it was asked about is kept.
const JEV: Record<string, number | "down"> = {};
const JEV_KEY = ["fake", "jev", "value", "1375"].join("-");
const asked: Array<Record<string, string>> = [];
async function jev(req: Request): Promise<Response> {
	if (req.headers.get("authorization") !== `Bearer ${JEV_KEY}`)
		return new Response("auth", { status: 401 });
	const body = (await req.json()) as { state: Record<string, string> };
	asked.push(body.state);
	const p = JEV[body.state.title ?? ""] ?? 0.85;
	if (p === "down") return new Response("down", { status: 500 });
	return Response.json({ answers: { "merge-go": { type: "noul", noul: p } } });
}
// The precedents state dir (FLEET_STATE_DIR) every run uses unless a test sets its own.
// Every state dir a test makes is removed when the file ends.
const made: string[] = [];
const fresh = () => {
	const dir = mkdtempSync(join(testTmpBase(), "merge-check-state-"));
	made.push(dir);
	return dir;
};
const STATE = fresh();

const heading = (repo: string, n: string, pr: Pr, linked = false) =>
	linked
		? `## Review of [${repo}#${n}](https://forge.example.internal/${repo}/pulls/${n}) at ${(pr.head ?? SHA).slice(0, 7)}`
		: `## Review of ${repo}#${n} at ${(pr.head ?? SHA).slice(0, 7)}`;

// SOF-8387: the Review Leads, a junior, and a company whose "Adams" names two agents.
const KAPOOR = "agent-kapoor";
const DUP = "co-dup";
const renderPost = (repo: string, n: string, pr: Pr, p: Post, i: number) => ({
	authorAgentId: p.by,
	createdAt: p.at ?? `2026-10-02T13:${String(i).padStart(2, "0")}:00.000Z`,
	body: p.verdict
		? `## Review of ${repo}#${n} at ${p.sha7 ?? (pr.head ?? SHA).slice(0, 7)}\n\n**Round:** 1\nverdict: ${p.verdict}${p.text ? `\n${p.text}` : ""}`
		: (p.text ?? ""),
});

function board(u: URL): Response {
	const co = u.pathname.match(/^\/api\/companies\/([\w-]+)\/(agents|issues)$/);
	if (co && co[1] !== COMPANY && co[1] !== DUP) return Response.json([]);
	if (co?.[2] === "agents")
		return Response.json([
			...(co[1] === DUP ? [{ id: "agent-adams-2", name: "Adams" }] : []),
			{ id: KAPOOR, name: "Kapoor" },
			{ id: LEAD, name: "Smythe" },
			{ id: AUTHOR, name: "Bishop" },
			{ id: ADAMS, name: "Adams" },
			{ id: KONG, name: "Kong" },
			{ id: CZAJKA, name: "Czajka" },
			{ id: GIRAUD, name: "Giraud" },
			{ id: COLTER, name: "Colter" },
		]);
	if (co?.[2] === "issues") {
		const q = u.searchParams.get("q") ?? "";
		const pm = q.match(/^Review ([\w.-]+\/[\w.-]+)#(\d+) @ ([0-9a-f]{7}) \($/);
		if (pm) {
			const pr = PRS[`${pm[1]}#${pm[2]}`];
			return Response.json(
				(pr?.pairs ?? []).map((t, i) => ({
					id: `pair-${pm[2]}-${i}`,
					title: `${q}${t.name})`,
					description: `Head SHA: \`${t.sha ?? pr?.head ?? SHA}\``,
					originKind: t.origin ?? "plugin:rodaddy.forge-pr",
					...(t.creator ? { createdByAgentId: t.creator } : {}),
					...(t.status ? { status: t.status } : {}),
				})),
			);
		}
		const m = q.match(/^Review ([\w.-]+\/[\w.-]+)#(\d+) @ ([0-9a-f]{7})$/);
		const pr = m ? PRS[`${m[1]}#${m[2]}`] : undefined;
		if (!m || !(pr?.board || pr?.thread)) return Response.json([]);
		return Response.json([
			{
				id: `rev-${m[2]}`,
				title: q,
				description: `PR: x\nHead SHA: \`${pr.reviewedSha ?? pr.head ?? SHA}\``,
			},
			// A look-alike the search also returns; its title is not the review title.
			{ id: `noise-${m[2]}`, title: `Adams: ${q}`, description: `Head SHA: \`${SHA}\`` },
		]);
	}
	// PR numbers are unique across the fixture, so the number names the PR.
	const act = u.pathname.match(/^\/api\/issues\/(rev|noise)-(\d+)\/activity$/);
	if (act) {
		const pr = Object.entries(PRS).find(([k]) => k.endsWith(`#${act[2]}`))?.[1];
		const log = act[1] === "rev" ? (pr?.assigned ?? []) : [];
		// Newest first, as the board returns them; other actions are noise to skip.
		return Response.json(
			[
				{
					action: "issue.comment_added",
					actorType: "agent",
					actorId: LEAD,
					createdAt: "2026-10-02T12:00:00.000Z",
					details: {},
				},
				...log.map((a) => ({
					action: "issue.updated",
					actorType: a.actorType ?? "agent",
					actorId: a.by,
					agentId: a.by,
					createdAt: a.at,
					details: { changes: { assigneeAgentId: { from: LEAD, to: a.to } } },
				})),
			].reverse(),
		);
	}
	const pc = u.pathname.match(/^\/api\/issues\/pair-(\d+)-(\d+)\/comments$/);
	const pp = pc ? Object.entries(PRS).find(([k]) => k.endsWith(`#${pc[1]}`)) : undefined;
	if (pc && pp) {
		const [name, pr] = pp;
		const posts = pr.pairs?.[Number(pc[2])]?.posts ?? [];
		return Response.json(
			posts.map((p, i) => renderPost(name.split("#")[0] ?? "", pc[1] ?? "", pr, p, i)).reverse(),
		);
	}
	const c = u.pathname.match(/^\/api\/issues\/(rev|noise)-(\d+)\/comments$/);
	const hit = c ? Object.entries(PRS).find(([k]) => k.endsWith(`#${c[2]}`)) : undefined;
	if (!c || !hit) return new Response("nf", { status: 404 });
	const [name, pr] = hit;
	const repo = name.split("#")[0] ?? "";
	if (c[1] === "noise")
		return Response.json(
			(pr.lookalike ?? []).map((p, i) => renderPost(repo, c[2] ?? "", pr, p, i)).reverse(),
		);
	// Newest first, as the board returns them.
	return Response.json(
		[
			...(pr.thread ?? []).map((p, i) => renderPost(repo, c[2] ?? "", pr, p, i)),
			...(pr.board ?? []).map((b, i) => ({
				authorAgentId: b.by,
				createdAt: `2026-10-02T15:0${i}:00.000Z`,
				body: `${heading(repo, c[2] ?? "", pr, b.linked)}\n\n**Round:** 1\nverdict: ${b.verdict}${b.tail ?? ""}`,
			})),
			...(pr.smythe ?? []).map((d, i) => ({
				authorAgentId: d.by ?? LEAD,
				createdAt: `2026-10-02T17:0${i}:00.000Z`,
				body:
					d.sha === ""
						? `Head of Review.\n${d.line}`
						: `${heading(repo, c[2] ?? "", { head: d.sha ?? pr.head })}\n\nHead of Review.\n${d.line}`,
			})),
		].reverse(),
	);
}

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch(req) {
			const u = new URL(req.url);
			seen.push(u.pathname);
			if (u.pathname === "/jev") return jev(req);
			if (u.pathname.startsWith("/api/")) {
				if (req.headers.get("authorization") !== `Bearer ${BOARD_KEY}`)
					return new Response("auth", { status: 401 });
				return board(u);
			}
			if (req.headers.get("authorization") !== `token ${TOKEN}`)
				return new Response("auth", { status: 401 });
			if (u.pathname === "/repos/rodaddy/software-factory/contents/config/repos.yml") {
				if (u.searchParams.get("ref") !== "main") return new Response("nf", { status: 404 });
				return Response.json({
					encoding: "base64",
					content: Buffer.from(REPOS_YML).toString("base64"),
				});
			}
			const st = u.pathname.match(/^\/repos\/([\w.-]+\/[\w.-]+)\/commits\/(\w+)\/status$/);
			if (st) {
				// One PR per `st/*` repo, so the repo alone picks the statuses; a
				// repo with several PRs (rtech/k3s-deploy) gives each its own head.
				const pr = Object.entries(PRS).find(
					([k, p]) => k.startsWith(`${st[1]}#`) && (p.head ?? SHA) === st[2],
				)?.[1];
				// Forgejo's combined status carries the state in `status`.
				return Response.json({
					statuses: Object.entries(pr?.statuses ?? GREEN).map(([context, status]) => ({
						context,
						status,
					})),
				});
			}
			const d = u.pathname.match(/^\/repos\/([\w.-]+\/[\w.-]+)\/pulls\/(\d+)\.diff$/);
			if (d) {
				const diff = PRS[`${d[1]}#${d[2]}`]?.diff;
				if (diff === null) return new Response("boom", { status: 500 });
				return new Response(diff ?? PLAIN_DIFF);
			}
			const m = u.pathname.match(
				/^\/repos\/([\w.-]+\/[\w.-]+)\/(pulls|issues)\/(\d+)(\/files|\/comments)?$/,
			);
			const pr = m ? PRS[`${m[1]}#${m[3]}`] : undefined;
			if (!m || !pr) return new Response("nf", { status: 404 });
			const page = Number(u.searchParams.get("page") ?? "1");
			if (m[4] === "/files" && pr.filesUnreadable === "http")
				return new Response("boom", { status: 500 });
			if (m[4] === "/files" && pr.filesUnreadable === "shape")
				return Response.json({ message: "not a file list" });
			if (m[4] === "/files")
				return Response.json(
					page === 1
						? (pr.files ?? ["src/util/format.ts"]).map((f) =>
								typeof f === "string"
									? { filename: f, status: "changed", additions: 3, deletions: 1 }
									: { ...f, status: "renamed" },
							)
						: [],
				);
			if (m[4] === "/comments")
				return Response.json(
					page === 1
						? [
								...(pr.forge ?? []).map((f) => ({
									user: { login: f.login },
									body: `${heading(m[1] ?? "", m[3] ?? "", pr)}\n\nverdict: ${f.verdict}`,
								})),
								...(pr.notes ?? []).map((f) => ({
									user: { login: f.login },
									body: f.body,
									created_at: f.at,
								})),
							]
						: [],
				);
			return Response.json({
				number: Number(m[3]),
				title: `${m[1]}#${m[3]}`,
				state: pr.state ?? "open",
				merged: pr.merged ?? false,
				head: { sha: pr.head ?? SHA },
				labels: (pr.labels ?? []).map((name) => ({ name })),
				user: { login: pr.author ?? "rico" },
				body: pr.body ?? DEFAULT_BODY,
				...(pr.noBase
					? {}
					: { base: { ref: pr.base ?? "main", repo: { default_branch: "main" } } }),
			});
		},
	});
	api = `http://127.0.0.1:${server.port}`;
});
afterAll(() => {
	server.stop(true);
	for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

async function run(repo: string, n: number, env: Record<string, string> = {}, sha = SHA) {
	const p = Bun.spawn(["python3", SCRIPT, repo, String(n), sha, "--base-url", api], {
		env: {
			PATH: process.env.PATH ?? "",
			FORGEJO_TOKEN: TOKEN,
			PAPERCLIP_API_URL: api,
			PAPERCLIP_API_KEY: BOARD_KEY,
			PAPERCLIP_COMPANY_ID: COMPANY,
			TYPESAFE_API_KEY: JEV_KEY,
			JEV_API_URL: `${api}/jev`,
			FLEET_STATE_DIR: STATE,
			// sf#1730 US-002: every run re-derives through the fake (below), never the real CLI.
			FACTORYIGNORE_CLI: FAKE_CLI,
			...env,
		},
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(p.stdout).text(),
		new Response(p.stderr).text(),
		p.exited,
	]);
	return { code, stdout, stderr, json: code === 0 ? JSON.parse(stdout) : null };
}

describe("merge-check", () => {
	test("a routine PR the lead approved on the board is class A, with no Forge comment", async () => {
		const r = await run("o/r", 1);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
		expect(r.json.checks).toBe("green");
	});
	test("a stacked PR whose base is not the default branch is class C", async () => {
		const r = await run("o/r", 1911);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toContain(
			"stacked: base feat/parent is not the default branch main; land the parent, then retarget",
		);
	});
	test("a PR with no base on Forge is class C, base branch unknown", async () => {
		const r = await run("o/r", 1912);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toContain("base branch unknown");
	});
	test("client/* is class C off-limits, with no Forge or board request", async () => {
		for (const repo of ["client/client-core", "Client/client-core"]) {
			seen.length = 0;
			const r = await run(repo, 2);
			expect(r.json.class).toBe("C");
			expect(r.json.mergeable).toBe(false);
			expect(r.json.reasons).toEqual([
				"client repos are off-limits until they move from GitHub (sf#1375)",
			]);
			expect(seen.filter((p) => p.startsWith("/api/"))).toEqual([]);
			expect(seen).toEqual([]);
		}
	});
	test("client/client-agent is on Forge: the lead's approve makes it class A", async () => {
		const r = await run("client/client-agent", 1375);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
	});
	test("the client-agent exception is case-insensitive and exact; every other client repo stays class C", async () => {
		seen.length = 0;
		const upper = await run("Client/Client-Agent", 1375);
		expect(upper.json?.reasons ?? []).not.toContain(
			"client repos are off-limits until they move from GitHub (sf#1375)",
		);
		expect(seen.length).toBeGreaterThan(0);
		for (const repo of [
			"client/client-agent2",
			"client/client-agent-x",
			"client/skippy",
			"client/client-core",
		]) {
			seen.length = 0;
			const r = await run(repo, 1375);
			expect(r.json.class).toBe("C");
			expect(r.json.reasons).toEqual([
				"client repos are off-limits until they move from GitHub (sf#1375)",
			]);
			expect(seen).toEqual([]);
		}
	});
	test("a PR touching .forgejo/workflows is class A", async () => {
		const r = await run("o/r", 3);
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
		expect(r.json.reasons).toEqual(["verdict approve; required statuses green; jev merge-go 0.85"]);
	});
	test("rtech/k3s-deploy waits on Smythe: class C smythe review", async () => {
		const r = await run("rtech/k3s-deploy", 85, {}, K3S(85));
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["smythe review: rtech/k3s-deploy is Smythe's to review"]);
		expect(r.json.smythe).toEqual({
			decision: "pending",
			reason: "rtech/k3s-deploy is Smythe's to review",
			override: null,
		});
	});
	test("rtech/k3s-deploy with its own CI and sop-gate green and Smythe's approve is class A", async () => {
		const r = await run("rtech/k3s-deploy", 300, {}, K3S(300));
		expect(r.json.checks).toBe("green");
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
	});
	test("rtech/k3s-deploy with sop-gate pending is class C, checks pending", async () => {
		const r = await run("rtech/k3s-deploy", 301, {}, K3S(301));
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("pending");
		expect(r.json.reasons).toContain("sop-gate is pending");
	});
	test("rtech/k3s-deploy with its own CI red is class C, checks red", async () => {
		const r = await run("rtech/k3s-deploy", 302, {}, K3S(302));
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("red");
		expect(r.json.reasons).toContain(`${K3S_CI} is failure`);
	});
	test("rtech/k3s-deploy with only sop-gate is never repo-ci: class C, its own CI missing", async () => {
		const r = await run("rtech/k3s-deploy", 303, {}, K3S(303));
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("pending");
		expect(r.json.reasons).toContain(`${K3S_CI} is missing`);
	});
	test("rtech/k3s-deploy needs its own CI, not the three standard checks", async () => {
		const r = await run("rtech/k3s-deploy", 304, {}, K3S(304));
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("pending");
		expect(r.json.reasons).toContain(`${K3S_CI} is missing`);
	});
	test("rtech/rtech-whisper with its own Tests context green is class A, no factory lanes asked", async () => {
		const r = await run("rtech/rtech-whisper", 320, {}, WHISPER(320));
		expect(r.json.checks).toBe("green");
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
		const reasons = r.json.reasons.join("\n");
		expect(reasons).not.toContain("factory/smoke");
		expect(reasons).not.toContain("factory/prepush");
	});
	test("rtech/rtech-whisper with its Tests context missing is class C, checks pending", async () => {
		const r = await run("rtech/rtech-whisper", 321, {}, WHISPER(321));
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("pending");
		expect(r.json.reasons).toContain(`${WHISPER_CI} is missing`);
	});
	test("rtech/rtech-whisper with its Tests context failed is class C, checks red", async () => {
		const r = await run("rtech/rtech-whisper", 322, {}, WHISPER(322));
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("red");
		expect(r.json.reasons).toContain(`${WHISPER_CI} is failure`);
	});
	test("rodaddy/mcp2cli with its own CI green is class A, no factory lanes asked (SOF-11343)", async () => {
		const r = await run("rodaddy/mcp2cli", 343, {}, MCP2CLI(343));
		expect(r.json.checks).toBe("green");
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
		const reasons = r.json.reasons.join("\n");
		expect(reasons).not.toContain("factory/smoke");
		expect(reasons).not.toContain("factory/prepush");
	});
	test("rodaddy/mcp2cli with its pull_request CI missing is class C, checks pending (SOF-11343)", async () => {
		const r = await run("rodaddy/mcp2cli", 344, {}, MCP2CLI(344));
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("pending");
		expect(r.json.reasons).toContain(`${MCP2CLI_CI} is missing`);
	});
	test("rodaddy/mcp2cli with its pull_request CI failed is class C, checks red (SOF-11343)", async () => {
		const r = await run("rodaddy/mcp2cli", 345, {}, MCP2CLI(345));
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("red");
		expect(r.json.reasons).toContain(`${MCP2CLI_CI} is failure`);
	});
	test("needs-rico label is class B", async () => {
		const r = await run("o/r", 6);
		expect(r.json.class).toBe("B");
		expect(r.json.mergeable).toBe(false);
	});
	test("a secrets/auth path is class A", async () => {
		const r = await run("o/r", 14);
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
	});
	test("a rename OUT of a protected path is class A", async () => {
		const r = await run("o/r", 15);
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
	});
	test("a fix-first verdict is class C", async () => {
		const r = await run("o/r", 4);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
	});
	test("lead fix-first, then the author's approve on Forge and on the board: stays C", async () => {
		const r = await run("o/r", 7);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toContain("review verdict fix-first");
	});
	test("no lead verdict stays C, whoever else approved", async () => {
		const r = await run("o/r", 8);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons.join(" ")).toContain("no lead verdict");
	});
	test("a Forge comment under the lead's login is not the verdict of record", async () => {
		const r = await run("o/r", 19);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
	});
	test("a lead verdict for another commit with the same 7-character prefix stays C", async () => {
		const r = await run("o/r", 9);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
	});
	test("a lead verdict whose heading links the PR is read (SOF-1373)", async () => {
		const r = await run("o/r", 20);
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
		expect((await run("o/r", 21)).json.class).toBe("C");
	});
	test("a Senior Review Lead's verdict is the lead verdict (PR 1578)", async () => {
		for (const n of [150, 151]) {
			const r = await run("o/r", n);
			expect({ n, class: r.json.class, reasons: r.json.reasons }).toEqual({
				n,
				class: "A",
				reasons: ["verdict approve; required statuses green; jev merge-go 0.85"],
			});
		}
		const later = await run("o/r", 152);
		expect(later.json.class).toBe("C");
		expect(later.json.reasons).toContain("review verdict fix-first");
		const junior = await run("o/r", 153);
		expect(junior.json.class).toBe("C");
		expect(junior.json.reasons.join(" ")).toContain("no lead verdict");
	});
	test("a verdict line followed by more text is still read", async () => {
		const r = await run("o/r", 18);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons.join(" ")).toContain("approve-with-fixes");
	});
	test("a missing required status is class C, checks pending", async () => {
		const r = await run("st/missing", 10);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.checks).toBe("pending");
		expect(r.json.reasons).toContain("factory/pr-review is missing");
	});
	test("a head with no factory/smoke but prepush and pr-review green is mergeable", async () => {
		const r = await run("st/nosmoke", 30);
		expect(r.json.reasons.join(" ")).not.toContain("missing");
		expect(r.json.checks).toBe("green");
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
	});
	test("a pending required status is class C, checks pending", async () => {
		const r = await run("st/pending", 12);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.checks).toBe("pending");
	});
	test("a red required status is class C, checks red", async () => {
		const r = await run("st/red", 11);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.checks).toBe("red");
		expect(r.json.reasons).toContain("factory/pr-review is failure");
	});
	test("a head with no factory status but green repo CI is not Rico's: class A, checks repo-ci", async () => {
		const r = await run("st/none", 13);
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
		expect(r.json.checks).toBe("repo-ci");
	});
	test("repo CI with a skipped job beside green ones is class A, checks repo-ci (SOF-12237)", async () => {
		const r = await run("st/skipped", 290);
		expect(r.json.reasons).not.toContain("CI / deploy (pull_request) is skipped");
		expect(r.json.checks).toBe("repo-ci");
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
	});
	test("repo CI where every job was skipped proves nothing: class C, checks pending (SOF-12237)", async () => {
		const r = await run("st/all-skipped", 291);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.checks).toBe("pending");
		expect(r.json.reasons).toContain("every repo CI status is skipped");
	});
	test("repo CI with a skipped job does not hide a red one: class C, checks red (SOF-12237)", async () => {
		const r = await run("st/skipped-red", 292);
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("red");
		expect(r.json.reasons).toContain("CI / check (pull_request) is failure");
	});
	test("a skipped required factory status is still not success: class C, checks pending (SOF-12237)", async () => {
		const r = await run("st/factory-skipped", 293);
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("pending");
		expect(r.json.reasons).toContain("factory/prepush is skipped");
	});
	test("a static-only repo whose head has only factory/infra-static green is not missing (SOF-2594)", async () => {
		const r = await run("st/static", 22);
		expect(r.json.reasons.join(" ")).not.toContain("missing");
		expect(r.json.checks).toBe("green");
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
	});
	test("a static-only repo with factory/infra-static red is class C, checks red", async () => {
		const r = await run("st/static-red", 23);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.checks).toBe("red");
		expect(r.json.reasons).toContain("factory/infra-static is failure");
	});
	test("a static-only repo requires factory/infra-static, not the three standard checks", async () => {
		const r = await run("st/static-std", 24);
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("pending");
		expect(r.json.reasons).toContain("factory/infra-static is missing");
	});
	test("a standard repo carrying only factory/infra-static still needs the three checks", async () => {
		const r = await run("st/plain", 25);
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("pending");
		expect(r.json.reasons).toContain("factory/pr-review is missing");
		expect(r.json.reasons.join(" ")).not.toContain("infra-static");
	});
	for (const [std, n, stat] of [
		["st/std-before-pf", 26, "st/static-pf"],
		["st/std-before-cf", 28, "st/static-cf"],
	] as const) {
		test(`${stat} cannot hand its static-only lane to ${std} before it (SOF-2653)`, async () => {
			const r = await run(std, n);
			expect(r.json.class).toBe("C");
			expect(r.json.checks).toBe("pending");
			expect(r.json.reasons).toEqual([
				"factory/prepush is missing",
				"factory/pr-review is missing",
			]);
		});
		test(`${stat} keeps its own static-only lane whatever its key order (SOF-2653)`, async () => {
			const r = await run(stat, n + 1);
			expect(r.json.reasons.join(" ")).not.toContain("missing");
			expect(r.json.checks).toBe("green");
			expect(r.json.class).toBe("A");
		});
	}
	test("a moved head is stale", async () => {
		const r = await run("o/r", 5);
		expect(r.json.class).toBe("stale");
		expect(r.json.mergeable).toBe(false);
	});
	test("a closed PR and a merged PR are stale", async () => {
		for (const n of [16, 17]) {
			const r = await run("o/r", n);
			expect(r.json.class).toBe("stale");
			expect(r.json.mergeable).toBe(false);
		}
	});
	test("no board access is a refusal, never a class", async () => {
		const missing = await run("o/r", 1, { PAPERCLIP_API_KEY: "" });
		expect(missing.code).toBe(2);
		expect(missing.stdout).toBe("");
		const denied = await run("o/r", 1, { PAPERCLIP_API_KEY: "wrong" });
		expect(denied.code).toBe(2);
		expect(denied.stdout).toBe("");
	});
	test("neither token reaches stdout or stderr", async () => {
		for (const [repo, n] of [
			["o/r", 1],
			["client/client-core", 2],
			["o/r", 99],
		] as const) {
			const r = await run(repo, n);
			expect(r.stdout + r.stderr).not.toContain(TOKEN);
			expect(r.stdout + r.stderr).not.toContain(BOARD_KEY);
		}
	});
});

describe("merge-check PR-body gate (Rico, 2026-10-05)", () => {
	const GATE = [
		"missing backout plan",
		"missing test plan",
		"big change without a rehearsed backout",
	];
	const gateOf = (reasons: string[]) => reasons.filter((r) => GATE.includes(r));
	const denied = async (repo: string, n: number, want: string[]) => {
		const r = await run(repo, n);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.checks).toBe("green");
		expect(r.json.reasons).toEqual(want);
	};
	test("no ## Backout heading is class C, missing backout plan", async () => {
		await denied("o/r", 101, ["missing backout plan"]);
	});
	test("no ## Test plan heading is class C, missing test plan", async () => {
		await denied("o/r", 102, ["missing test plan"]);
	});
	test("both missing names both, backout first", async () => {
		await denied("o/r", 103, ["missing backout plan", "missing test plan"]);
	});
	test("a Backout that says only TBD is missing", async () => {
		await denied("o/r", 104, ["missing backout plan"]);
	});
	test("a Test plan that is only an HTML comment is missing", async () => {
		await denied("o/r", 105, ["missing test plan"]);
	});
	test("both plans inside one HTML comment, then a visible Summary, are missing", async () => {
		await denied("o/r", 113, ["missing backout plan", "missing test plan"]);
	});
	test("an unclosed HTML comment hides the plans after it", async () => {
		await denied("o/r", 114, ["missing backout plan", "missing test plan"]);
	});
	test("### Back out plan (level 3, two words) with content counts as present", async () => {
		const r = await run("o/r", 106);
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
		expect(gateOf(r.json.reasons)).toEqual([]);
	});
	test("a big change by path whose Backout has no rehearsed: link is class C", async () => {
		await denied("o/r", 107, ["big change without a rehearsed backout"]);
	});
	test("the same big change with a rehearsed: link adds no gate reason", async () => {
		const r = await run("o/r", 108);
		const same = await run("o/r", 3);
		expect(gateOf(r.json.reasons)).toEqual([]);
		expect(r.json.class).toBe(same.json.class);
		expect(r.json.reasons).toEqual(same.json.reasons);
	});
	test("rtech-infra markdown only is not big; anything else there is", async () => {
		const docs = await run("rtech/rtech-infra", 109);
		expect(docs.json.class).toBe("A");
		expect(gateOf(docs.json.reasons)).toEqual([]);
		await denied("rtech/rtech-infra", 110, ["big change without a rehearsed backout"]);
	});
	test("a body missing only Blast radius: is class C naming it", async () => {
		await denied("o/r", 115, ["missing Blast radius: line in merge danger"]);
	});
	test("an otherwise class-A PR with both sections stays class A", async () => {
		const r = await run("o/r", 111);
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
		expect(r.json.reasons).toEqual(["verdict approve; required statuses green; jev merge-go 0.85"]);
	});
	test("gate reasons come first, then the verdict and status reasons", async () => {
		const r = await run("st/gate-red", 112);
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("red");
		expect(r.json.reasons).toEqual([
			"missing backout plan",
			"review verdict fix-first",
			"factory/pr-review is failure",
		]);
	});
});

// No path, repo or opener sends a PR anywhere: a HUMAN_RULES path or an
// employee's rule-path change the lead approved is class A on Jev's merge-go.
Object.assign(PRS, {
	"o/r#120": { board: approve, files: ["src/auth/token.ts"] },
	"rodaddy/software-factory#121": {
		board: approve,
		author: "sf-bishop",
		files: ["fleet/skills/merge-pr/bin/merge-check"],
	},
});

describe("merge-check: no path decides the class", () => {
	const ROUTINE = "verdict approve; required statuses green; jev merge-go 0.85";
	test("a HUMAN_RULES path the lead approved: class A", async () => {
		const r = await run("o/r", 120);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
		expect(r.json.reasons).toEqual([ROUTINE]);
	});
	test("an employee's rule-path change: class A", async () => {
		const r = await run("rodaddy/software-factory", 121);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
		expect(r.json.reasons).toEqual([ROUTINE]);
	});
});

// "99.5% of all things should be able to be figured
// out by the agent". A head with no factory/* status is no longer the owner's class:
// the repo's own CI meets the checks requirement when every status is success,
// and a head with no status at all waits on Smythe. Class B is only the
// needs-rico label.
Object.assign(PRS, {
	"st/repo-ci#140": { board: approve, statuses: { "policy-corpus / corpus": "success" } },
	"st/bare#141": { board: approve, statuses: {} },
	"st/repo-ci-rico#142": {
		board: approve,
		labels: ["needs-rico"],
		statuses: { "policy-corpus / corpus": "success" },
	},
	"st/repo-ci-red#143": {
		board: approve,
		statuses: { "policy-corpus / corpus": "success", "ci/build": "failure" },
	},
});
describe("merge-check: no factory checks is not Rico's class", () => {
	test("only repo-CI success statuses, no factory/*: not class B, checks repo-ci, class A", async () => {
		const r = await run("st/repo-ci", 140);
		expect(r.json.class).not.toBe("B");
		expect(r.json.checks).toBe("repo-ci");
		expect(r.json.class).toBe("A");
		expect(r.json.mergeable).toBe(true);
	});
	test("a head with no status at all is class C until Smythe decides", async () => {
		const r = await run("st/bare", 141);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toEqual(["smythe review: aaaaaaa carries no status"]);
		expect(r.json.smythe.decision).toBe("pending");
	});
	test("needs-rico on a repo-CI head is class B, for the label alone", async () => {
		const r = await run("st/repo-ci-rico", 142);
		expect(r.json.class).toBe("B");
		expect(r.json.reasons).toEqual(["label needs-rico"]);
	});
	test("a failing repo-CI status is not mergeable", async () => {
		const r = await run("st/repo-ci-red", 143);
		expect(r.json.mergeable).toBe(false);
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("red");
		expect(r.json.reasons).toContain("ci/build is failure");
	});
});

// No council: Adams, Czajka and Smythe publish verdicts; what
// went to a council waits on Smythe's `smythe: approve` or `smythe: kickback:
// <why>`, and after a kickback the author's or rodaddy's `just do it` on the
// Forge PR, at or after the kickback, puts it through.
const KICK = { line: "smythe: kickback: no test for the new path" };
const kicked = (login: string, at: string, body = "Just do it, I own this"): Pr => ({
	board: approve,
	statuses: {},
	author: "sf-perkins",
	smythe: [KICK],
	notes: [{ login, body, at }],
});
Object.assign(PRS, {
	// SOF-8387: a Review Lead's verdict counts inside Smythe's dispatch to it.
	"o/r#210": { board: [{ by: ADAMS, verdict: "approve" }], assigned: [handTo(ADAMS)] },
	"o/r#211": { board: [{ by: CZAJKA, verdict: "approve" }], assigned: [handTo(CZAJKA)] },
	"o/r#212": { board: [{ by: KONG, verdict: "approve" }] },
	"st/sm-ok#213": { board: approve, statuses: {}, smythe: [{ line: "smythe: approve" }] },
	"st/sm-back#214": { board: approve, statuses: {}, smythe: [KICK] },
	// 13:30 at -04:00 is 17:30Z, after the 17:00Z kickback.
	"st/sm-author#215": kicked("sf-perkins", "2026-10-02T13:30:00-04:00"),
	"st/sm-rico#216": kicked("rodaddy", "2026-10-02T17:30:00Z", "just do it"),
	"st/sm-third#217": kicked("sf-bishop", "2026-10-02T17:30:00Z"),
	"st/sm-early#218": kicked("sf-perkins", "2026-10-02T16:59:00Z"),
	"st/sm-fake#219": {
		board: approve,
		statuses: {},
		smythe: [{ line: "smythe: approve", by: ADAMS }],
	},
	// PR 1613 review P1: a decision counts only under a heading naming this head.
	"st/sm-stale#220": {
		board: approve,
		statuses: {},
		smythe: [{ line: "smythe: approve", sha: OTHER }],
	},
	"st/sm-stalekick#221": {
		...kicked("sf-perkins", "2026-10-02T17:30:00Z"),
		smythe: [{ ...KICK, sha: OTHER }],
	},
	"st/sm-bare#222": {
		board: approve,
		statuses: {},
		smythe: [{ line: "smythe: approve", sha: "" }],
	},
});
describe("merge-check: no council, Smythe decides", () => {
	test("the dispatched Adams's verdict counts", async () => {
		expect((await run("o/r", 210)).json.class).toBe("A");
	});
	test("the dispatched Czajka's verdict counts", async () => {
		expect((await run("o/r", 211)).json.class).toBe("A");
	});
	test("a verdict by anyone outside the review leads does not", async () => {
		const r = await run("o/r", 212);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toContain("no lead verdict on the board for aaaaaaa");
	});
	test("smythe: approve is class A", async () => {
		const r = await run("st/sm-ok", 213);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual(["smythe approved"]);
		expect(r.json.smythe.decision).toBe("approve");
	});
	test("a kickback is class C, back to the author with the reason", async () => {
		const r = await run("st/sm-back", 214);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["kickback: no test for the new path"]);
		expect(r.json.smythe).toEqual({
			decision: "kickback",
			reason: "no test for the new path",
			override: null,
		});
	});
	test("the author's `just do it` after the kickback is class A", async () => {
		const r = await run("st/sm-author", 215);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual(["override by sf-perkins"]);
		expect(r.json.smythe.override).toBe("sf-perkins");
	});
	test("rodaddy's `just do it` after the kickback is class A", async () => {
		const r = await run("st/sm-rico", 216);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual(["override by rodaddy"]);
	});
	test("a third login's `just do it` is ignored: still class C", async () => {
		const r = await run("st/sm-third", 217);
		expect(r.json.class).toBe("C");
		expect(r.json.smythe.override).toBeNull();
	});
	test("`just do it` before the kickback is ignored: still class C", async () => {
		const r = await run("st/sm-early", 218);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["kickback: no test for the new path"]);
	});
	test("a `smythe: approve` line by anyone but Smythe decides nothing", async () => {
		const r = await run("st/sm-fake", 219);
		expect(r.json.class).toBe("C");
		expect(r.json.smythe.decision).toBe("pending");
	});
	test("a `smythe: approve` under another head's heading decides nothing", async () => {
		const r = await run("st/sm-stale", 220);
		expect(r.json.class).toBe("C");
		expect(r.json.smythe.decision).toBe("pending");
	});
	test("another head's kickback, then `just do it`, is not an override", async () => {
		const r = await run("st/sm-stalekick", 221);
		expect(r.json.class).toBe("C");
		expect(r.json.smythe).toEqual({
			decision: "pending",
			reason: "aaaaaaa carries no status",
			override: null,
		});
	});
	test("a `smythe: approve` with no review heading for this head decides nothing", async () => {
		const r = await run("st/sm-bare", 222);
		expect(r.json.class).toBe("C");
		expect(r.json.smythe.decision).toBe("pending");
	});
});

// Jev merge-go gates a lead's approve: GO (>= 0.60) is class
// A; no, unsure or no signal is Smythe's. An override is a precedent Jev reads.
const HARVEST = resolve(import.meta.dir, "../../fleet/skills/merge-pr/bin/precedents-harvest");
const jevCalls = () => seen.filter((p) => p === "/jev").length;
Object.assign(PRS, {
	"o/r#230": { board: approve },
	"o/r#231": { board: approve },
	"o/r#232": { board: approve },
	"o/r#233": { board: approve },
	"st/sm-jevno#234": { board: approve, statuses: GREEN, smythe: [{ line: "smythe: approve" }] },
	"o/r#235": { board: approve },
});
Object.assign(JEV, {
	"o/r#231": 0.2,
	"o/r#232": 0.55,
	"o/r#233": "down",
	"st/sm-jevno#234": 0.2,
	"o/r#235": 1.5,
});
describe("merge-check: Jev merge-go, then Smythe", () => {
	test("GO is class A with the score", async () => {
		const r = await run("o/r", 230);
		expect(r.json.class).toBe("A");
		expect(r.json.jev).toBe(0.85);
		expect(r.json.reasons).toEqual(["verdict approve; required statuses green; jev merge-go 0.85"]);
	});
	test("a Jev no is class C for Smythe", async () => {
		const r = await run("o/r", 231);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["smythe review: jev merge-go 0.20"]);
		expect(r.json.smythe).toEqual({
			decision: "pending",
			reason: "jev merge-go 0.20",
			override: null,
		});
	});
	test("unsure (0.55) is class C for Smythe, never GO", async () => {
		const r = await run("o/r", 232);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["smythe review: jev merge-go 0.55"]);
	});
	test("no signal (Jev down, or no key) is class C for Smythe", async () => {
		for (const env of [{}, { TYPESAFE_API_KEY: "" }] as Record<string, string>[]) {
			const r = await run("o/r", 233, env);
			expect(r.json.class).toBe("C");
			expect(r.json.reasons).toEqual(["smythe review: jev merge-go no signal"]);
			expect(r.stdout + r.stderr).not.toContain(JEV_KEY);
		}
	});
	test("an out-of-range Jev answer (1.5) is no signal, never GO", async () => {
		const r = await run("o/r", 235);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["smythe review: jev merge-go no signal"]);
	});
	test("smythe: approve after a Jev no is class A, with no second Jev call", async () => {
		const before = jevCalls();
		const r = await run("st/sm-jevno", 234);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual(["smythe approved"]);
		expect(jevCalls()).toBe(before);
	});
	test("an override writes exactly one precedent line, run twice", async () => {
		const dir = fresh();
		for (const _ of [1, 2]) {
			const r = await run("st/sm-author", 215, { FLEET_STATE_DIR: dir });
			expect(r.json.class).toBe("A");
		}
		const lines = readFileSync(join(dir, "merge-go-precedents.jsonl"), "utf8").trim().split("\n");
		expect(lines.length).toBe(1);
		const p = JSON.parse(lines[0] ?? "{}");
		expect(p).toMatchObject({
			repo: "st/sm-author",
			number: 215,
			head: SHA,
			title: "st/sm-author#215",
			paths: [{ path: "src/util/format.ts", add: 3, del: 1 }],
			kickback: "no test for the new path",
			override_by: "sf-perkins",
		});
		expect(typeof p.at).toBe("string");
	});
	test("an unwritable state dir leaves the class alone and names the file on stderr", async () => {
		const dir = fresh();
		writeFileSync(join(dir, "file"), "x");
		const r = await run("st/sm-author", 215, { FLEET_STATE_DIR: join(dir, "file") });
		expect(r.json.class).toBe("A");
		expect(r.stderr).toContain("merge-go-precedents.jsonl");
	});
	test("precedents for the same repo reach the Jev state; another repo's do not", async () => {
		const dir = fresh();
		const line = (repo: string, title: string) =>
			JSON.stringify({
				repo,
				number: 1,
				head: SHA,
				title,
				paths: [{ path: "a.ts", add: 1, del: 0 }],
				kickback: "why",
			});
		writeFileSync(
			join(dir, "merge-go-precedents.jsonl"),
			`${line("o/r", "same-repo change")}\n${line("x/y", "other-repo change")}\n`,
		);
		asked.length = 0;
		await run("o/r", 230, { FLEET_STATE_DIR: dir });
		const state = asked.at(-1) ?? {};
		expect(state.precedents).toContain("same-repo change");
		expect(state.precedents).toContain("a.ts +1 -0");
		expect(state.precedents).not.toContain("other-repo change");
	});
	test("only the repo's 10 newest precedents reach the Jev state", async () => {
		const dir = fresh();
		const line = (n: number) =>
			JSON.stringify({
				repo: "o/r",
				number: n,
				head: SHA,
				title: `prec-${String(n).padStart(2, "0")}-end`,
				paths: [],
			});
		writeFileSync(
			join(dir, "merge-go-precedents.jsonl"),
			`${Array.from({ length: 11 }, (_, n) => line(n)).join("\n")}\n`,
		);
		asked.length = 0;
		await run("o/r", 230, { FLEET_STATE_DIR: dir });
		const state = asked.at(-1) ?? {};
		expect(state.precedents).not.toContain("prec-00-end");
		expect(state.precedents).toContain("prec-01-end");
		expect(state.precedents).toContain("prec-10-end");
	});
	test("a torn line skips only itself: precedents still reach Jev and dedupe holds", async () => {
		const dir = fresh();
		const file = join(dir, "merge-go-precedents.jsonl");
		const good = JSON.stringify({
			repo: "o/r",
			number: 1,
			head: SHA,
			title: "kept change",
			paths: [],
		});
		writeFileSync(file, `${good}\n{"repo":"o/r","number":2,"head":"bb\n`);
		asked.length = 0;
		await run("o/r", 230, { FLEET_STATE_DIR: dir });
		expect((asked.at(-1) ?? {}).precedents).toContain("kept change");
		for (const _ of [1, 2]) await run("st/sm-author", 215, { FLEET_STATE_DIR: dir });
		const rows = readFileSync(file, "utf8")
			.trim()
			.split("\n")
			.filter((l) => l.includes('"st/sm-author"'));
		expect(rows.length).toBe(1);
	});
	test("precedents-harvest prints one classifier example per precedent", async () => {
		const dir = fresh();
		const line = (n: number) =>
			JSON.stringify({
				repo: "o/r",
				number: n,
				head: SHA,
				title: `t${n}`,
				paths: [],
				kickback: "why",
			});
		writeFileSync(join(dir, "merge-go-precedents.jsonl"), `${line(1)}\n${line(2)}\n`);
		const p = Bun.spawn(["python3", HARVEST], {
			env: { PATH: process.env.PATH ?? "", FLEET_STATE_DIR: dir },
			stdout: "pipe",
		});
		const out = await new Response(p.stdout).text();
		expect(await p.exited).toBe(0);
		const rows = out
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l));
		expect(rows.length).toBe(2);
		expect(rows[0]).toMatchObject({ expect: "yes", fields: { repo: "o/r", title: "t1" } });
	});
});

// SOF-8387: Smythe dispatches each review issue to a Review Lead (review-dispatch
// step 2, `Dispatched to <lead> (<k> open) per review-dispatch.`), and that lead's
// verdict decides. Before this, merge-check read Smythe's verdict only, so PR 1603
// at b46646b, approved by the dispatched Adams with green checks, came back class C
// `no lead verdict on the board for b46646b` until Smythe countersigned. A lead's
// verdict counts only inside its own dispatch on this exact review issue, by the
// board's author stamp; Smythe's verdict still always counts; a lead's
// `escalate: <why>` hands the decision to Smythe.
const toLead = (lead: string, open = 3): Post => ({
	by: LEAD,
	text: `Dispatched to ${lead} (${open} open) per review-dispatch.\n\n- backout: coordination only.`,
});
const says = (by: string, verdict: string, text?: string): Post => ({ by, verdict, text });
const line = (by: string, text: string): Post => ({ by, text });
const SF = "rodaddy/software-factory";
Object.assign(PRS, {
	// The PR 1603 shape: Smythe dispatches to Adams, Adams approves, checks green.
	[`${SF}#160`]: { thread: [toLead("Adams"), says(ADAMS, "approve")] },
	[`${SF}#161`]: { thread: [toLead("Czajka"), says(CZAJKA, "approve-with-fixes")] },
	[`${SF}#162`]: { thread: [toLead("Adams"), says(ADAMS, "fix-first")] },
	[`${SF}#163`]: { thread: [toLead("Czajka"), says(CZAJKA, "fix-first")] },
	// The latest verdict in the window wins, in either direction.
	[`${SF}#164`]: { thread: [toLead("Adams"), says(ADAMS, "approve"), says(ADAMS, "fix-first")] },
	[`${SF}#165`]: { thread: [toLead("Czajka"), says(CZAJKA, "fix-first"), says(CZAJKA, "approve")] },
	// Not the dispatched lead: the other lead, a junior, the author.
	[`${SF}#166`]: { thread: [toLead("Adams"), says(CZAJKA, "approve")] },
	[`${SF}#167`]: { thread: [toLead("Adams"), says(KAPOOR, "approve")] },
	[`${SF}#168`]: { thread: [toLead("Czajka"), says(AUTHOR, "approve")] },
	// A dispatch line written by anyone but Smythe authorizes nobody.
	[`${SF}#169`]: {
		thread: [
			line(ADAMS, "Dispatched to Adams (0 open) per review-dispatch."),
			says(ADAMS, "approve"),
		],
	},
	// A verdict posted before the dispatch is not the dispatched lead's verdict.
	[`${SF}#170`]: { thread: [says(ADAMS, "approve"), toLead("Adams")] },
	// Re-dispatched to Czajka: Adams's window ends; Czajka's verdict counts.
	[`${SF}#171`]: { thread: [toLead("Adams"), toLead("Czajka"), says(ADAMS, "approve")] },
	[`${SF}#172`]: { thread: [toLead("Adams"), toLead("Czajka"), says(CZAJKA, "approve")] },
	// Wrong head: the heading names another sha7, or the issue names another full sha.
	[`${SF}#173`]: { thread: [toLead("Adams"), { by: ADAMS, verdict: "approve", sha7: "bbbbbbb" }] },
	[`${SF}#174`]: { thread: [toLead("Adams"), says(ADAMS, "approve")], reviewedSha: TWIN },
	// The dispatch is on a look-alike issue, not this review issue.
	[`${SF}#175`]: { thread: [says(ADAMS, "approve")], lookalike: [toLead("Adams")] },
	// Missing dispatch, and ambiguous ones: two leads in one comment, two at one
	// instant, a lead name two agents hold (company co-dup), a non-lead.
	[`${SF}#176`]: { thread: [says(ADAMS, "approve")] },
	[`${SF}#177`]: {
		thread: [
			line(
				LEAD,
				"Dispatched to Adams (3 open) per review-dispatch.\nDispatched to Czajka (4 open) per review-dispatch.",
			),
			says(ADAMS, "approve"),
		],
	},
	[`${SF}#178`]: {
		thread: [
			{ ...toLead("Adams"), at: "2026-10-02T12:00:00.000Z" },
			{ ...toLead("Czajka"), at: "2026-10-02T12:00:00.000Z" },
			says(ADAMS, "approve"),
		],
	},
	[`${SF}#179`]: { thread: [toLead("Adams"), says(ADAMS, "approve")] },
	[`${SF}#180`]: { thread: [toLead("Kapoor"), says(KAPOOR, "approve")] },
	// Legacy: Smythe's own verdict, with no dispatch at all, and his countersign.
	[`${SF}#181`]: { thread: [says(LEAD, "approve")] },
	[`${SF}#182`]: { thread: [toLead("Adams"), says(ADAMS, "fix-first"), says(LEAD, "approve")] },
	[`${SF}#183`]: { thread: [toLead("Adams"), says(ADAMS, "approve"), says(LEAD, "fix-first")] },
	// Escalation: the lead hands it to Smythe; his answer decides.
	[`${SF}#184`]: {
		thread: [
			toLead("Adams"),
			says(ADAMS, "approve"),
			line(ADAMS, "escalate: two readings of the rule"),
		],
	},
	[`${SF}#185`]: {
		thread: [
			toLead("Adams"),
			says(ADAMS, "approve"),
			line(ADAMS, "escalate: two readings of the rule"),
			line(LEAD, "Read the precedents.\nsmythe: approve"),
		],
	},
	[`${SF}#186`]: {
		thread: [
			toLead("Czajka"),
			says(CZAJKA, "approve"),
			line(CZAJKA, "escalate: two readings of the rule"),
			line(LEAD, "smythe: kickback: needs a real test plan"),
		],
	},
	// The lead cannot take an escalation back by approving again.
	[`${SF}#187`]: {
		thread: [
			toLead("Adams"),
			says(ADAMS, "approve", "escalate: two readings of the rule"),
			says(ADAMS, "approve"),
		],
	},
	[`${SF}#188`]: {
		thread: [
			toLead("Adams"),
			says(ADAMS, "approve"),
			line(ADAMS, "escalate: two readings of the rule"),
			says(LEAD, "fix-first"),
		],
	},
	// A `smythe:` line with no escalation decides nothing; a non-dispatched
	// lead's escalate hands nothing to Smythe.
	[`${SF}#189`]: {
		thread: [toLead("Adams"), says(ADAMS, "fix-first"), line(LEAD, "smythe: approve")],
	},
	[`${SF}#190`]: {
		thread: [toLead("Adams"), says(ADAMS, "approve"), line(CZAJKA, "escalate: I disagree")],
	},
	// A Smythe answer that came before the escalation is not an answer to it.
	[`${SF}#191`]: {
		thread: [
			toLead("Adams"),
			line(LEAD, "smythe: approve"),
			says(ADAMS, "approve"),
			line(ADAMS, "escalate: two readings of the rule"),
		],
	},
	// A dispatched lead's legacy `council call: <why>` is the same escalate.
	[`${SF}#240`]: {
		thread: [
			toLead("Adams"),
			says(ADAMS, "approve"),
			line(ADAMS, "council call: two readings of the rule"),
		],
	},
	// Smythe's real dispatch lines also end with `;` or `,` and more text (SOF-8645).
	[`${SF}#193`]: {
		thread: [
			line(
				LEAD,
				"Dispatched to Czajka (32 open) per review-dispatch; lead files reviewers (over 400 changed lines).",
			),
			says(CZAJKA, "approve"),
		],
	},
	[`${SF}#194`]: {
		thread: [
			line(
				LEAD,
				"Dispatched to Czajka (32 open) per review-dispatcher.\nDispatched to Czajka per review-dispatch.",
			),
			says(CZAJKA, "approve"),
		],
	},
	// Smythe dispatches by assigning the issue, his comment free text (SOF-8593):
	// the board's activity stamp is the dispatch.
	[`${SF}#195`]: {
		thread: [
			line(LEAD, "Dispatched: lead Czajka, reviewers Giraud + Kong."),
			says(CZAJKA, "approve"),
		],
		assigned: [handTo(CZAJKA)],
	},
	// An assignment by anyone but Smythe (the lead itself, a board user) dispatches nothing.
	[`${SF}#196`]: {
		thread: [says(ADAMS, "approve")],
		assigned: [{ by: ADAMS, to: ADAMS, at: "2026-10-02T12:30:00.000Z" }],
	},
	[`${SF}#197`]: {
		thread: [says(ADAMS, "approve")],
		assigned: [{ by: "user-rico", to: ADAMS, at: "2026-10-02T12:30:00.000Z", actorType: "user" }],
	},
	// The stamp is the actor TYPE and id together: a non-agent actor carrying Smythe's id is not Smythe.
	[`${SF}#200`]: {
		thread: [says(ADAMS, "approve")],
		assigned: [{ by: LEAD, to: ADAMS, at: "2026-10-02T12:30:00.000Z", actorType: "user" }],
	},
	// Smythe moves it from Adams to a junior: Adams's later verdict is outside any window.
	[`${SF}#198`]: {
		thread: [says(ADAMS, "approve")],
		assigned: [handTo(ADAMS), handTo(KAPOOR, "2026-10-02T12:40:00.000Z")],
	},
	// Assigned to Czajka, but the verdict came before the assignment.
	[`${SF}#199`]: {
		thread: [says(CZAJKA, "approve")],
		assigned: [handTo(CZAJKA, "2026-10-02T14:00:00.000Z")],
	},
	// Smythe moves it from Adams to Czajka at the very instant of Adams's verdict
	// (factory/pr-review P2 on PR 1627): the redispatch ends Adams's window.
	[`${SF}#201`]: {
		thread: [{ ...says(ADAMS, "approve"), at: "2026-10-02T13:30:00.000Z" }],
		assigned: [handTo(ADAMS), handTo(CZAJKA, "2026-10-02T13:30:00.000Z")],
	},
	// A verdict at the dispatch's own instant is not after it.
	[`${SF}#202`]: {
		thread: [{ ...says(ADAMS, "approve"), at: "2026-10-02T12:30:00.000Z" }],
		assigned: [handTo(ADAMS)],
	},
	// Smythe's own legacy plain-comment `council call:` is an escalate.
	[`${SF}#203`]: {
		thread: [says(LEAD, "approve"), line(LEAD, "council call: two safe options, no tie-breaker")],
	},
	// The juniors-first record (PR 1620): the canonical dispatch line, the reviewers on the
	// next line, and no assignment stamp; the canonical line alone names the lead.
	[`${SF}#204`]: {
		thread: [
			line(
				LEAD,
				"Dispatched to Czajka (2 open) per review-dispatch.\nReviewers Giraud + Kong (round 1, juniors first).",
			),
			says(CZAJKA, "approve"),
		],
	},
	// The dispatched lead's verdict with a red required check stays C.
	"st/lead-red#192": {
		thread: [toLead("Adams"), says(ADAMS, "approve")],
		statuses: { ...GREEN, "factory/prepush": "failure" },
	},
});
describe("merge-check: the dispatched Review Lead's verdict decides (SOF-8387)", () => {
	const ROUTINE = "verdict approve; required statuses green; jev merge-go 0.85";
	const NONE = "no lead verdict on the board for aaaaaaa";
	const is = async (
		n: number,
		cls: string,
		reasons: string[],
		env: Record<string, string> = {},
	) => {
		const r = await run(SF, n, env);
		expect(r.code).toBe(0);
		expect(r.json.reasons).toEqual(reasons);
		expect(r.json.class).toBe(cls);
		expect(r.json.mergeable).toBe(cls === "A");
		return r;
	};
	test("PR 1603: Adams dispatched, Adams approves, checks green: class A, not `no lead verdict`", async () => {
		const r = await is(160, "A", [ROUTINE]);
		expect(r.json.checks).toBe("green");
	});
	test("Czajka dispatched, Czajka approves with fixes: class A", async () => {
		await is(161, "A", ["verdict approve-with-fixes; required statuses green; jev merge-go 0.85"]);
	});
	test("the dispatched Adams says fix-first: class C, review verdict fix-first", async () => {
		await is(162, "C", ["review verdict fix-first"]);
	});
	test("the dispatched Czajka says fix-first: class C, review verdict fix-first", async () => {
		await is(163, "C", ["review verdict fix-first"]);
	});
	test("the lead's latest verdict wins: approve then fix-first is C, fix-first then approve is A", async () => {
		await is(164, "C", ["review verdict fix-first"]);
		await is(165, "A", [ROUTINE]);
	});
	test("dispatched to Adams, the other lead approves: class C, no lead verdict", async () => {
		await is(166, "C", [NONE]);
	});
	test("dispatched to Adams, his junior approves: class C, no lead verdict", async () => {
		await is(167, "C", [NONE]);
	});
	test("dispatched to Czajka, the author approves: class C, no lead verdict", async () => {
		await is(168, "C", [NONE]);
	});
	test("a lead's own dispatch line authorizes nothing: class C", async () => {
		await is(169, "C", [NONE]);
	});
	test("a lead verdict posted before the dispatch: class C", async () => {
		await is(170, "C", [NONE]);
	});
	test("re-dispatched to Czajka: Adams's later verdict is C, Czajka's is A", async () => {
		await is(171, "C", [NONE]);
		await is(172, "A", [ROUTINE]);
	});
	test("wrong head: a heading at another sha7 is C", async () => {
		await is(173, "C", [NONE]);
	});
	test("wrong head: a review issue naming another full sha with the same sha7 is C", async () => {
		await is(174, "C", [NONE]);
	});
	test("a dispatch on a look-alike issue authorizes nothing on the review issue: class C", async () => {
		await is(175, "C", [NONE]);
	});
	test("missing dispatch: Adams's approve is C", async () => {
		await is(176, "C", [NONE]);
	});
	test("ambiguous dispatch, two leads in one comment: class C", async () => {
		await is(177, "C", [NONE]);
	});
	test("ambiguous dispatch, two leads at the same instant: class C", async () => {
		await is(178, "C", [NONE]);
	});
	test("ambiguous lead, two agents named Adams on the board: class C", async () => {
		await is(179, "A", [ROUTINE]);
		await is(179, "C", [NONE], { PAPERCLIP_COMPANY_ID: DUP });
	});
	test("dispatched to a junior who is not a Review Lead: class C", async () => {
		await is(180, "C", [NONE]);
	});
	test("legacy: Smythe's own verdict with no dispatch is still class A", async () => {
		await is(181, "A", [ROUTINE]);
	});
	test("Smythe's later verdict overrides the dispatched lead, either way", async () => {
		await is(182, "A", [ROUTINE]);
		await is(183, "C", ["review verdict fix-first"]);
	});
	test("the lead's `escalate: <why>` holds it for Smythe: class C smythe review", async () => {
		await is(184, "C", ["smythe review: two readings of the rule"]);
	});
	test("after the escalate, `smythe: approve` is class A", async () => {
		await is(185, "A", [ROUTINE]);
	});
	test("after the escalate, `smythe: kickback: <why>` is class C back to the author", async () => {
		await is(186, "C", ["kickback: needs a real test plan"]);
	});
	test("after the escalate, the lead approving again does not take it back", async () => {
		await is(187, "C", ["smythe review: two readings of the rule"]);
	});
	test("after the escalate, Smythe's own fix-first verdict decides", async () => {
		await is(188, "C", ["review verdict fix-first"]);
	});
	test("`smythe: approve` with no escalation decides nothing: the lead's fix-first stands", async () => {
		await is(189, "C", ["review verdict fix-first"]);
	});
	test("an escalate by a lead not dispatched here hands nothing to Smythe", async () => {
		await is(190, "A", [ROUTINE]);
	});
	test("a Smythe answer before the escalation is not its answer: class C smythe review", async () => {
		await is(191, "C", ["smythe review: two readings of the rule"]);
	});
	test("a dispatched lead's legacy `council call:` is read as the escalate: class C smythe review", async () => {
		await is(240, "C", ["smythe review: two readings of the rule"]);
	});
	test("a dispatch line Smythe ends with `;` and more text still names the lead: class A", async () => {
		await is(193, "A", [ROUTINE]);
	});
	test("a look-alike of the dispatch line (another word, no open count) authorizes nothing: class C", async () => {
		await is(194, "C", [NONE]);
	});
	test("Smythe's assignment of the issue to Czajka, in the board's activity log, is the dispatch: class A", async () => {
		await is(195, "A", [ROUTINE]);
	});
	test("an assignment by the lead itself or by a board user dispatches nothing: class C", async () => {
		await is(196, "C", [NONE]);
		await is(197, "C", [NONE]);
		await is(200, "C", [NONE]);
	});
	test("Smythe reassigns from Adams to a junior: Adams's later verdict is C", async () => {
		await is(198, "C", [NONE]);
	});
	test("a verdict before Smythe's assignment is not the dispatched lead's: class C", async () => {
		await is(199, "C", [NONE]);
	});
	test("a redispatch at the verdict's own instant ends the earlier lead's window: class C", async () => {
		await is(201, "C", [NONE]);
	});
	test("a lead verdict at the very instant of its own dispatch is not after it: class C", async () => {
		await is(202, "C", [NONE]);
	});
	test("a juniors-first dispatch, canonical line then a reviewers line, names the lead: class A", async () => {
		await is(204, "A", [ROUTINE]);
	});
	test("the dispatched lead's approve does not lift a red required check", async () => {
		const r = await run("st/lead-red", 192);
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("red");
		expect(r.json.reasons).toEqual(["factory/prepush is failure"]);
	});
	test("Smythe's plain-comment `council call:` is the same escalate, with no council key", async () => {
		const before = jevCalls();
		const r = await is(203, "C", ["smythe review: two safe options, no tie-breaker"]);
		expect(r.json).not.toHaveProperty("council");
		expect(jevCalls()).toBe(before);
	});
});

// SOF-8099 (the owner, 2026-10-06, SOF-8088: "the council seats are retired from the
// org chart; reviews go to the Head of Review"). A head with no status at all is
// the Head of Review's, and his `smythe: approve` lifts only that wait: it never
// clears a stale head, a red status, a missing backout or test plan, a lead's
// fix-first, or a review bound to another head. Historical seat votes on the
// review issue stay where they are and decide nothing (rtech/sub-switcher PR 46).
const HOR_OK = [{ line: "smythe: approve" }];
Object.assign(PRS, {
	"st/hor-noplan#280": {
		board: approve,
		statuses: {},
		smythe: HOR_OK,
		body: `${SET}## Summary\n\nx\n\n${TEST_PLAN}`,
	},
	"st/hor-big#281": {
		board: approve,
		statuses: {},
		smythe: HOR_OK,
		files: WORKFLOW,
		body: `${SET}${BACKOUT}\n${TEST_PLAN}`,
	},
	"st/hor-fix#282": { board: [{ by: LEAD, verdict: "fix-first" }], statuses: {}, smythe: HOR_OK },
	"st/hor-red#283": {
		board: approve,
		statuses: { ...GREEN, "factory/pr-review": "failure" },
		smythe: HOR_OK,
	},
	"st/hor-cired#284": { board: approve, statuses: { "ci/build": "failure" }, smythe: HOR_OK },
	"st/hor-moved#285": { board: approve, statuses: {}, smythe: HOR_OK, head: OTHER },
	"st/hor-merged#286": {
		board: approve,
		statuses: {},
		smythe: HOR_OK,
		merged: true,
		state: "closed",
	},
	"st/hor-twin#287": { board: approve, statuses: {}, smythe: HOR_OK, reviewedSha: TWIN },
	"st/hor-seats#288": {
		board: approve,
		statuses: {},
		smythe: [
			{ line: "council: approve", by: KONG },
			{ line: "council: approve", by: CZAJKA },
			{ line: "council: approve", by: ADAMS },
		],
	},
	"st/hor-seats-ok#289": {
		board: approve,
		statuses: {},
		smythe: [
			{ line: "council: approve", by: KONG },
			{ line: "council: approve", by: CZAJKA },
			{ line: "smythe: approve" },
		],
	},
});
describe("merge-check: the Head of Review owns a status-less head; the floors stay (SOF-8099)", () => {
	test("Head of Review approve on a status-less head is class A, checks none", async () => {
		const r = await run("st/sm-ok", 213);
		expect(r.json.checks).toBe("none");
		expect(r.json.class).toBe("A");
	});
	test("missing backout plan: still class C after the Head of Review approves", async () => {
		const r = await run("st/hor-noplan", 280);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toEqual(["missing backout plan"]);
	});
	test("big change with no rehearsed backout: still class C after the approve", async () => {
		const r = await run("st/hor-big", 281);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["big change without a rehearsed backout"]);
	});
	test("a lead fix-first: still class C after the approve", async () => {
		const r = await run("st/hor-fix", 282);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["review verdict fix-first"]);
	});
	test("a red factory status: still class C, checks red, after the approve", async () => {
		const r = await run("st/hor-red", 283);
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("red");
		expect(r.json.reasons).toEqual(["factory/pr-review is failure"]);
	});
	test("a red repo-CI status: still class C, checks red, after the approve", async () => {
		const r = await run("st/hor-cired", 284);
		expect(r.json.class).toBe("C");
		expect(r.json.checks).toBe("red");
		expect(r.json.reasons).toEqual(["ci/build is failure"]);
	});
	test("a moved head is stale whatever the Head of Review said", async () => {
		const r = await run("st/hor-moved", 285);
		expect(r.json.class).toBe("stale");
		expect(r.json.mergeable).toBe(false);
	});
	test("a merged PR is stale whatever the Head of Review said", async () => {
		const r = await run("st/hor-merged", 286);
		expect(r.json.class).toBe("stale");
	});
	test("an approve on the review issue for another head with the same sha7 decides nothing", async () => {
		const r = await run("st/hor-twin", 287);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toEqual(["no lead verdict on the board for aaaaaaa"]);
	});
	test("historical seat votes on a status-less head do not approve it: Head of Review pending", async () => {
		const r = await run("st/hor-seats", 288);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["smythe review: aaaaaaa carries no status"]);
		expect(r.json.smythe).toEqual({
			decision: "pending",
			reason: "aaaaaaa carries no status",
			override: null,
		});
		expect(r.json).not.toHaveProperty("council");
	});
	test("historical seat votes stay beside the Head of Review's approve: class A on his line", async () => {
		const r = await run("st/hor-seats-ok", 289);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual(["smythe approved"]);
	});
});

// sf#1730: no lead verdict. The go for head H is the newest
// verdict from the Claude family (Kapoor, Giraud) AND the GPT family (Colter,
// Kong) on their pair tasks `Review <repo>#<n> @ <sha7> (<Name>)`, both approve.
const task = (name: string, ...posts: Post[]) => ({ name, posts });
const ok = (by: string, at?: string): Post => ({ by, verdict: "approve", at });
const no = (by: string, at?: string): Post => ({ by, verdict: "fix-first", at });
Object.assign(PRS, {
	"p/r#1801": { pairs: [task("Kapoor", ok(KAPOOR)), task("Colter", ok(COLTER))] },
	"p/r#1802": { pairs: [task("Kapoor", ok(KAPOOR)), task("Colter")] },
	"p/r#1803": { pairs: [task("Kapoor", ok(KAPOOR)), task("Colter", no(COLTER))] },
	"p/r#1804": { pairs: [task("Kapoor", no(KAPOOR)), task("Colter", ok(COLTER))] },
	"p/r#1805": {
		pairs: [task("Kapoor", ok(KAPOOR)), task("Kong", { by: KONG, verdict: "approve-with-fixes" })],
	},
	"p/r#1806": {
		pairs: [
			task("Kapoor", ok(KAPOOR, "2026-10-02T13:00:00.000Z")),
			task("Giraud", no(GIRAUD, "2026-10-02T13:05:00.000Z")),
			task("Colter", ok(COLTER)),
		],
	},
	"p/r#1807": {
		pairs: [
			task("Giraud", no(GIRAUD, "2026-10-02T13:00:00.000Z")),
			task("Kapoor", ok(KAPOOR, "2026-10-02T13:05:00.000Z")),
			task("Colter", ok(COLTER)),
		],
	},
	"p/r#1808": { pairs: [task("Kapoor", ok(KAPOOR)), task("Colter", ok(LEAD), ok(ADAMS))] },
	"p/r#1809": {
		pairs: [task("Kapoor", ok(KAPOOR)), { name: "Colter", sha: TWIN, posts: [ok(COLTER)] }],
	},
	"p/r#1810": {
		author: "sf-colter",
		pairs: [task("Kapoor", ok(KAPOOR)), task("Colter", ok(COLTER))],
	},
	"p/r#1811": {
		pairs: [
			task("Kapoor", ok(KAPOOR)),
			task("Colter", ok(COLTER), { by: COLTER, text: "escalate: needs a schema call" }),
		],
	},
	// Smythe's verdict on the exact-title task (15:00) is newer than the pair (13:xx).
	"p/r#1812": { board: approve, pairs: [task("Kapoor", no(KAPOOR)), task("Colter", ok(COLTER))] },
	// The pair (16:00) is newer than Smythe's approve (15:00).
	"p/r#1813": {
		board: approve,
		pairs: [
			task("Kapoor", ok(KAPOOR, "2026-10-02T16:00:00.000Z")),
			task("Colter", no(COLTER, "2026-10-02T16:00:00.000Z")),
		],
	},
	// A legacy dispatched lead's approve does not beat the pair's fix-first.
	"p/r#1814": {
		board: [{ by: ADAMS, verdict: "approve" }],
		assigned: [handTo(ADAMS)],
		pairs: [task("Kapoor", no(KAPOOR)), task("Colter", ok(COLTER))],
	},
	// A Forge PR comment in the verdict shape by a reviewer's login is no verdict.
	"p/r#1815": {
		pairs: [task("Kapoor", ok(KAPOOR)), task("Colter")],
		forge: [{ login: "sf-colter", verdict: "approve" }],
	},
	// A reviewer escalates; Smythe answers on the exact-title task after it.
	"p/r#1816": {
		board: [],
		smythe: [{ line: "smythe: approve" }],
		pairs: [
			task("Kapoor", ok(KAPOOR)),
			task("Colter", ok(COLTER), { by: COLTER, text: "escalate: needs a schema call" }),
		],
	},
	// Smythe escalates (14:00); both families approve after it (16:00): still held.
	"p/r#1817": {
		thread: [{ by: LEAD, text: "escalate: a schema call", at: "2026-10-02T14:00:00.000Z" }],
		pairs: [
			task("Kapoor", ok(KAPOOR, "2026-10-02T16:00:00.000Z")),
			task("Colter", ok(COLTER, "2026-10-02T16:00:00.000Z")),
		],
	},
	// Colter escalates (13:00), Smythe answers (17:00), the pair approves after (18:00).
	"p/r#1818": {
		board: [],
		smythe: [{ line: "smythe: approve" }],
		pairs: [
			task("Kapoor", ok(KAPOOR, "2026-10-02T18:00:00.000Z")),
			task(
				"Colter",
				{ by: COLTER, text: "escalate: needs a schema call", at: "2026-10-02T13:00:00.000Z" },
				ok(COLTER, "2026-10-02T18:00:00.000Z"),
			),
		],
	},
});
describe("merge-check: two reviewer approves on the exact head are the go", () => {
	const ROUTINE = "verdict approve; required statuses green; jev merge-go 0.85";
	const FIX = ["review verdict fix-first"];
	const PENDING_GPT = ["pair verdict pending (gpt) on aaaaaaa"];
	const is = async (n: number, cls: string, reasons: string[]) => {
		const r = await run("p/r", n);
		expect(r.code).toBe(0);
		expect(r.json.reasons).toEqual(reasons);
		expect(r.json.class).toBe(cls);
		expect(r.json.mergeable).toBe(cls === "A");
		return r;
	};
	test("Kapoor and Colter approve: class A, and Jev merge-go is still asked", async () => {
		const before = jevCalls();
		await is(1801, "A", [ROUTINE]);
		expect(jevCalls()).toBe(before + 1);
	});
	test("one family approves, the other has no verdict: class C naming the missing family", async () => {
		await is(1802, "C", PENDING_GPT);
	});
	test("a fix-first from either family is class C", async () => {
		await is(1803, "C", FIX);
		await is(1804, "C", FIX);
	});
	test("a reviewer's approve-with-fixes counts as fix-first", async () => {
		await is(1805, "C", FIX);
	});
	// L-173: each task counts on its own, so Kapoor's newer approve on his own
	// task no longer hides Giraud's older fix-first on another (1807 was A).
	test("a fix-first on any task is fix-first, whichever task of the family is newer", async () => {
		await is(1806, "C", FIX);
		await is(1807, "C", FIX);
	});
	test("Smythe's approve on a pair task counts for nothing; Adams's counts only for the Claude family", async () => {
		await is(1808, "C", PENDING_GPT);
	});
	test("a pair task naming another 40-char sha with the same sha7 counts for nothing", async () => {
		await is(1809, "C", PENDING_GPT);
	});
	test("the PR author's own seat cannot approve it", async () => {
		await is(1810, "C", PENDING_GPT);
	});
	test("a reviewer's escalate line is class C for Smythe, never mergeable", async () => {
		await is(1811, "C", ["smythe review: needs a schema call"]);
	});
	test("Smythe's verdict on the head, newer than the pair, wins", async () => {
		await is(1812, "A", [ROUTINE]);
	});
	test("the pair, newer than Smythe's verdict, wins", async () => {
		await is(1813, "C", FIX);
	});
	test("a legacy lead's approve does not beat the pair", async () => {
		await is(1814, "C", FIX);
	});
	test("a Forge PR comment is never a pair verdict", async () => {
		await is(1815, "C", PENDING_GPT);
	});
	test("Smythe's answer after a reviewer's escalate decides", async () => {
		await is(1816, "A", ["smythe approved"]);
	});
	test("an unanswered Smythe escalate stays held when both families approve after it", async () => {
		await is(1817, "C", ["smythe review: a schema call"]);
	});
	test("a newer pair verdict does not reopen an escalate Smythe already answered", async () => {
		const r = await run("p/r", 1818);
		expect(r.json.reasons.some((x: string) => x.startsWith("smythe review"))).toBe(false);
		expect(r.json.class).toBe("A");
	});
	test("a legacy parent with a dispatched lead's approve and no pair tasks is class A as today", async () => {
		const r = await run("o/r", 150);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual([ROUTINE]);
	});
	// k3s-deploy#1003 @ 587bbd6 (2026-10-07): the lead's own children carry the
	// pair title shape; merge-check read them as a pending pair and refused.
	test("a lead's child tasks titled like pair tasks (origin manual) leave the lead's approve deciding", async () => {
		PRS["o/r#151"] = {
			...PRS["o/r#150"],
			pairs: [
				{ name: "Kapoor", origin: "manual", posts: [] },
				{ name: "Colter", origin: "manual", posts: [] },
			],
		};
		const r = await run("o/r", 151);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual([ROUTINE]);
	});
});

// sf#1730 R1: each reviewer proves the PR body's
// `Blast radius:` line and ends the verdict comment with `blast radius:
// confirmed` or `blast radius: wrong: <why>`. Both confirmed is the go with no
// Jev; `wrong` is fix-first; a reviewer on the old text (no line) still asks Jev.
// Adams joins the Claude family and Czajka the GPT family (R5).
const sure = (by: string, at?: string): Post => ({
	by,
	verdict: "approve",
	text: "blast radius: confirmed",
	at,
});
const wrong = (by: string): Post => ({
	by,
	verdict: "approve",
	text: "blast radius: wrong: it also moves the deploy",
});
Object.assign(PRS, {
	"p/r#1831": { pairs: [task("Kapoor", sure(KAPOOR)), task("Colter", sure(COLTER))] },
	"p/r#1832": { pairs: [task("Kapoor", sure(KAPOOR)), task("Colter", ok(COLTER))] },
	"p/r#1833": { pairs: [task("Kapoor", wrong(KAPOOR)), task("Colter", sure(COLTER))] },
	"p/r#1834": { pairs: [task("Kapoor", sure(KAPOOR)), task("Colter", wrong(COLTER))] },
	"p/r#1835": {
		pairs: [
			task("Adams", sure(ADAMS)),
			task("Czajka", { by: CZAJKA, verdict: "approve", text: "Blast Radius: confirmed" }),
		],
	},
	// SOF-10778: the value is read case-insensitively like the key; a mixed-case
	// objection is not an old-skill missing line.
	"p/r#1837": {
		pairs: [
			task("Kapoor", {
				by: KAPOOR,
				verdict: "approve",
				text: "blast radius: Wrong: also moves the deploy",
			}),
			task("Colter", sure(COLTER)),
		],
	},
	"p/r#1838": {
		pairs: [
			task("Kapoor", { by: KAPOOR, verdict: "approve", text: "blast radius: CONFIRMED" }),
			task("Colter", { by: COLTER, verdict: "approve", text: "Blast radius: Confirmed" }),
		],
	},
	// The last blast-radius line of one verdict comment wins, either way round.
	"p/r#1839": {
		pairs: [
			task("Kapoor", {
				by: KAPOOR,
				verdict: "approve",
				text: "blast radius: wrong: also moves the deploy\nblast radius: confirmed",
			}),
			task("Colter", sure(COLTER)),
		],
	},
	"p/r#1840": {
		pairs: [
			task("Kapoor", {
				by: KAPOOR,
				verdict: "approve",
				text: "blast radius: confirmed\nblast radius: WRONG: also moves the deploy",
			}),
			task("Colter", sure(COLTER)),
		],
	},
	// An unknown value is still no line: Jev is asked as for the old skill text.
	"p/r#1899": {
		pairs: [
			task("Kapoor", { by: KAPOOR, verdict: "approve", text: "blast radius: probably fine" }),
			task("Colter", sure(COLTER)),
		],
	},
	// Smythe's and the author seat's confirmed lines on Colter's task are not the GPT family's.
	"p/r#1836": {
		pairs: [
			task("Kapoor", sure(KAPOOR)),
			task(
				"Colter",
				ok(COLTER),
				sure(LEAD, "2026-10-02T14:00:00.000Z"),
				sure(AUTHOR, "2026-10-02T14:01:00.000Z"),
			),
		],
	},
});
describe("merge-check: a pair approve with both blast-radius lines confirmed merges without Jev", () => {
	const ROUTINE = "verdict approve; required statuses green; jev merge-go 0.85";
	const GO = ["pair approve; blast radius confirmed by both"];
	const is = async (n: number, cls: string, reasons: string[], jev: number) => {
		const before = jevCalls();
		const r = await run("p/r", n);
		expect(r.code).toBe(0);
		expect(r.json.reasons).toEqual(reasons);
		expect(r.json.class).toBe(cls);
		expect(r.json.mergeable).toBe(cls === "A");
		expect(jevCalls()).toBe(before + jev);
	};
	test("both families approve and confirm the blast radius: class A, Jev is not called", async () => {
		await is(1831, "A", GO, 0);
	});
	test("one family confirms, the other carries no blast line: Jev merge-go is asked as today", async () => {
		await is(1832, "A", [ROUTINE], 1);
	});
	test("a `blast radius: wrong` beside `verdict: approve` is fix-first, from either family", async () => {
		await is(1833, "C", ["review verdict fix-first"], 0);
		await is(1834, "C", ["review verdict fix-first"], 0);
	});
	test("Adams counts for the Claude family and Czajka for the GPT family on a pair task", async () => {
		await is(1835, "A", GO, 0);
	});
	test("a confirmed line from a seat outside both families counts for nothing", async () => {
		await is(1836, "A", [ROUTINE], 1);
	});
	test("a mixed-case `blast radius: Wrong:` objection is fix-first, with no Jev call (SOF-10778)", async () => {
		await is(1837, "C", ["review verdict fix-first"], 0);
	});
	test("a mixed-case `confirmed` from both families is the go, with no Jev call (SOF-10778)", async () => {
		await is(1838, "A", GO, 0);
	});
	test("the last blast-radius line of the same verdict comment wins (SOF-10778)", async () => {
		await is(1839, "A", GO, 0);
		await is(1840, "C", ["review verdict fix-first"], 0);
	});
	test("an unknown blast-radius value is no line: Jev merge-go is asked as for the old skill (SOF-10778)", async () => {
		await is(1899, "A", [ROUTINE], 1);
	});
});

// no leads. Smythe files the pair himself
// (review-dispatch step 3), so the tasks are `manual` and created by Smythe (the
// board's creator stamp). One Anthropic and one GPT reviewer approving the same
// head is class A; a fix-first from either is class C. A manual task created by
// anyone else (a reviewer, a former lead) counts for nothing.
const bySmythe = (name: string, ...posts: Post[]) => ({
	name,
	posts,
	origin: "manual",
	creator: LEAD,
});
Object.assign(PRS, {
	"p/r#1841": { pairs: [bySmythe("Adams", sure(ADAMS)), bySmythe("Czajka", sure(CZAJKA))] },
	"p/r#1842": { pairs: [bySmythe("Kapoor", sure(KAPOOR)), bySmythe("Kong", no(KONG))] },
	"p/r#1843": {
		pairs: [
			{ name: "Kapoor", posts: [sure(KAPOOR)], origin: "manual", creator: ADAMS },
			{ name: "Colter", posts: [sure(COLTER)], origin: "manual", creator: ADAMS },
		],
	},
});
describe("merge-check: a lead-less pair Smythe filed decides", () => {
	test("one Anthropic and one GPT reviewer approve the same head on Smythe's pair tasks: class A", async () => {
		const r = await run("p/r", 1841);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual(["pair approve; blast radius confirmed by both"]);
	});
	test("one fix-first in Smythe's pair is class C", async () => {
		const r = await run("p/r", 1842);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["review verdict fix-first"]);
	});
	test("manual pair tasks created by anyone but Smythe count for nothing", async () => {
		const r = await run("p/r", 1843);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["no lead verdict on the board for aaaaaaa"]);
	});
});

// L-173: Smythe files one Anthropic + one GPT reviewer PER SLICE, so two slices
// are four pair tasks. Each counted task's newest verdict decides on its own: an
// older fix-first on slice 1 is not hidden by a newer approve on slice 2, and a
// slice with no verdict yet is pending. Task status never retires exact-head evidence.
Object.assign(PRS, {
	"p/r#1851": {
		pairs: [
			bySmythe("Kapoor", sure(KAPOOR)),
			bySmythe("Colter", no(COLTER, "2026-10-08T10:00:00.000Z")),
			bySmythe("Adams", sure(ADAMS)),
			bySmythe("Czajka", sure(CZAJKA, "2026-10-08T10:05:00.000Z")),
		],
	},
	"p/r#1852": {
		pairs: [
			bySmythe("Kapoor", sure(KAPOOR)),
			bySmythe("Colter", sure(COLTER)),
			bySmythe("Adams"),
			bySmythe("Czajka", sure(CZAJKA)),
		],
	},
	"p/r#1853": {
		pairs: [
			bySmythe("Kapoor", sure(KAPOOR)),
			bySmythe("Colter", sure(COLTER)),
			bySmythe("Adams", sure(ADAMS)),
			bySmythe("Czajka", sure(CZAJKA)),
		],
	},
	"p/r#1854": {
		pairs: [
			{ ...bySmythe("Kapoor"), status: "cancelled" },
			bySmythe("Adams", sure(ADAMS)),
			bySmythe("Czajka", sure(CZAJKA)),
		],
	},
});
describe("merge-check: every pair task counts on its own (L-173, a pair per slice)", () => {
	test("slice 1's older GPT fix-first is not hidden by slice 2's newer GPT approve: class C", async () => {
		const r = await run("p/r", 1851);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["review verdict fix-first"]);
	});
	test("a slice task with no verdict yet is pending, though its family approved on another slice", async () => {
		const r = await run("p/r", 1852);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["pair verdict pending (pair-1852-2) on aaaaaaa"]);
	});
	test("two slices, all four tasks approve: class A", async () => {
		const r = await run("p/r", 1853);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual(["pair approve; blast radius confirmed by both"]);
	});
	test("a cancelled exact-head pair task with no verdict is ignored: class A", async () => {
		const r = await run("p/r", 1854);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual(["pair approve; blast radius confirmed by both"]);
		expect(r.json.mergeable).toBe(true);
	});
});

// L-173: R1's no-Jev go needs `blast radius: confirmed` on EVERY counted pair
// task's newest verdict, not only on each family's newest. Slice 1's Anthropic
// reviewer approves without the line; slice 2's approves later with it.
Object.assign(PRS, {
	"p/r#1855": {
		pairs: [
			bySmythe("Kapoor", ok(KAPOOR, "2026-10-08T10:00:00.000Z")),
			bySmythe("Adams", sure(ADAMS, "2026-10-08T10:05:00.000Z")),
			bySmythe("Czajka", sure(CZAJKA, "2026-10-08T10:06:00.000Z")),
		],
	},
});
describe("merge-check: the blast-radius proof holds on every pair task (L-173, R1)", () => {
	const ROUTINE = "verdict approve; required statuses green; jev merge-go 0.85";
	const is = async (n: number, cls: string, reasons: string[], jev: number) => {
		const before = jevCalls();
		const r = await run("p/r", n);
		expect(r.code).toBe(0);
		expect(r.json.reasons).toEqual(reasons);
		expect(r.json.class).toBe(cls);
		expect(r.json.mergeable).toBe(cls === "A");
		expect(jevCalls()).toBe(before + jev);
	};
	test("slice 1's approve without a blast line is not covered by slice 2's newer confirmed: Jev is asked", async () => {
		await is(1855, "A", [ROUTINE], 1);
	});
	test("two slices, all four tasks approve and confirm: class A, Jev is not called", async () => {
		await is(1853, "A", ["pair approve; blast radius confirmed by both"], 0);
	});
});

// sf#1690: undoing a ruling that carries the owner's name stays with the owner
// (company-conduct, "the owner only"). A removed diff line, the old side of an edit
// included, citing the owner is class B; an added one is not.
const RULE = "- Two rounds, then stop (Rico, 2026-10-02).";
const ruleDiff = (lines: string) =>
	`diff --git a/fleet/skills/x/SKILL.md b/fleet/skills/x/SKILL.md\n--- a/fleet/skills/x/SKILL.md\n+++ b/fleet/skills/x/SKILL.md\n@@ -3,3 +3,3 @@\n context\n${lines}`;
Object.assign(PRS, {
	"o/r#1690": { board: approve, diff: ruleDiff(`-${RULE}\n+- Three rounds, then stop.\n`) },
	"o/r#1691": { board: approve, diff: ruleDiff(`+${RULE}\n`) },
	"o/r#1692": { board: approve, diff: null },
	"o/r#1693": { board: approve, diff: ruleDiff("-old text\n+new text\n") },
	"o/r#1694": { board: approve, labels: ["needs-rico"], diff: ruleDiff(`-${RULE}\n`) },
	"o/r#1695": {
		board: approve,
		diff: "diff --git a/docs/rules.md b/docs/rules.md\nBinary files a/docs/rules.md and b/docs/rules.md differ\n",
	},
	"o/r#1696": {
		board: approve,
		diff: ruleDiff("-per Rico ruling 2026-10-03\n+Three rounds.\n"),
	},
});
Object.assign(PRS, {
	"o/r#1697": { board: approve, diff: ruleDiff("-2026-10-03 Rico ruled X\n+Changed policy.\n") },
	"o/r#1698": {
		board: approve,
		diff: ruleDiff("-Keep policy\u000b(Rico, 2026-10-02).\n+Changed policy.\n"),
	},
	"o/r#1699": {
		board: approve,
		files: ["_DOCS/decisions-ledger.md"],
		diff: "diff --git a/_DOCS/decisions-ledger.md b/_DOCS/decisions-ledger.md\n--- a/_DOCS/decisions-ledger.md\n+++ b/_DOCS/decisions-ledger.md\n@@ -7,1 +7,0 @@\n-| L-1 | Keep policy |\n",
	},
});
Object.assign(PRS, {
	"o/r#1700": {
		board: approve,
		diff: ruleDiff("--- Keep policy (Rico, 2026-10-02).\n+Changed policy.\n"),
	},
	"o/r#1701": {
		board: approve,
		files: [{ filename: "docs/retired.md", previous_filename: "docs/AGENTS.md" }],
		diff: "diff --git a/docs/AGENTS.md b/docs/retired.md\nsimilarity index 100%\nrename from docs/AGENTS.md\nrename to docs/retired.md\n",
	},
	"o/r#1702": {
		board: approve,
		files: ["docs/x\t/AGENTS.md"],
		diff: 'diff --git "a/docs/x\\t/AGENTS.md" "b/docs/x\\t/AGENTS.md"\n--- "a/docs/x\\t/AGENTS.md"\n+++ "b/docs/x\\t/AGENTS.md"\n@@ -1 +1 @@\n-policy\n+changed\n',
	},
	"o/r#1703": { board: approve, filesUnreadable: "http" },
	"o/r#1704": { board: approve, filesUnreadable: "shape" },
	"o/r#1705": {
		board: approve,
		diff: 'diff --git "a/docs/x\\t/rules.md" "b/docs/x\\t/rules.md"\n--- "a/docs/x\\t/rules.md"\n+++ "b/docs/x\\t/rules.md"\n@@ -7 +7 @@\n-Keep policy (Rico, 2026-10-02).\n+changed\n',
	},
});
describe("merge-check: a change to a Rico ruling is Rico's", () => {
	const ROUTINE = "verdict approve; required statuses green; jev merge-go 0.85";
	test("removing an SQL -- Rico ruling line is class B", async () => {
		const r = await run("o/r", 1700);
		expect(r.json.class).toBe("B");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toEqual([
			"changes a Rico ruling: fleet/skills/x/SKILL.md:4: -- Keep policy (Rico, 2026-10-02).",
		]);
	});
	test("a renamed AGENTS.md without a hunk is class B", async () => {
		const r = await run("o/r", 1701);
		expect(r.json.class).toBe("B");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toEqual(["change to a ruling file docs/AGENTS.md"]);
	});
	test("a git-quoted tab path ending in AGENTS.md is class B", async () => {
		const r = await run("o/r", 1702);
		expect(r.json.class).toBe("B");
		expect(r.json.reasons).toEqual(["change to a ruling file docs/x\t/AGENTS.md"]);
	});
	test("a quoted ruling citation decodes the tab in its path", async () => {
		const r = await run("o/r", 1705);
		expect(r.json.class).toBe("B");
		expect(r.json.reasons).toEqual([
			"changes a Rico ruling: docs/x\t/rules.md:7: Keep policy (Rico, 2026-10-02).",
		]);
	});
	for (const n of [1703, 1704]) {
		test(`an unreadable PR file list is class C (${n})`, async () => {
			const r = await run("o/r", n);
			expect(r.json.class).toBe("C");
			expect(r.json.mergeable).toBe(false);
			expect(r.json.reasons).toEqual(["could not read the PR file list for the ruling check"]);
		});
	}

	test("a removed date-first Rico ruled line is class B", async () => {
		const r = await run("o/r", 1697);
		expect(r.json.class).toBe("B");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toEqual([
			"changes a Rico ruling: fleet/skills/x/SKILL.md:4: 2026-10-03 Rico ruled X",
		]);
	});
	test("a removed line with a literal vertical tab before Rico is class B", async () => {
		const r = await run("o/r", 1698);
		expect(r.json.class).toBe("B");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toEqual([
			"changes a Rico ruling: fleet/skills/x/SKILL.md:4: Keep policy\u000b(Rico, 2026-10-02).",
		]);
	});
	test("deleting a decisions-ledger row is class B", async () => {
		const r = await run("o/r", 1699);
		expect(r.json.class).toBe("B");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toEqual(["change to a ruling file _DOCS/decisions-ledger.md"]);
	});
	test("a removed ruling reason carries the old line number", async () => {
		const r = await run("o/r", 1690);
		expect(r.json.class).toBe("B");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toEqual([
			`changes a Rico ruling: fleet/skills/x/SKILL.md:4: ${RULE.slice(0, 80)}`,
		]);
	});
	test("a binary entry is class B naming the file", async () => {
		const r = await run("o/r", 1695);
		expect(r.json.class).toBe("B");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toEqual([
			"binary change to docs/rules.md cannot be checked for ruling lines",
		]);
	});
	test("a removed per Rico ruling 2026-10-03 citation is class B", async () => {
		const r = await run("o/r", 1696);
		expect(r.json.class).toBe("B");
		expect(r.json.mergeable).toBe(false);
	});
	test("a diff that only adds a ruling line keeps its class", async () => {
		const r = await run("o/r", 1691);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual([ROUTINE]);
	});
	test("a diff that cannot be read is class C, never mergeable", async () => {
		const r = await run("o/r", 1692);
		expect(r.json.class).toBe("C");
		expect(r.json.mergeable).toBe(false);
		expect(r.json.reasons).toEqual(["could not read the diff for the ruling check"]);
	});
	test("a diff with no ruling line keeps its class", async () => {
		const r = await run("o/r", 1693);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual([ROUTINE]);
	});
	test("needs-rico stays the reason when the label is already on the PR", async () => {
		const r = await run("o/r", 1694);
		expect(r.json.class).toBe("B");
		expect(r.json.reasons).toEqual(["label needs-rico"]);
	});
});

Object.assign(PRS, {
	"p/r#1858": {
		pairs: [
			{ ...bySmythe("Kapoor", no(KAPOOR)), status: "cancelled" },
			bySmythe("Adams", sure(ADAMS)),
			bySmythe("Czajka", sure(CZAJKA)),
		],
	},
	"p/r#1856": {
		pairs: [
			{ ...bySmythe("Kapoor", no(KAPOOR)), status: "cancelled", sha: TWIN },
			bySmythe("Adams", sure(ADAMS)),
			bySmythe("Czajka", sure(CZAJKA)),
		],
	},
	"p/r#1857": {
		thread: [
			{
				by: LEAD,
				text: "Dispatched to Adams (0 open) per review-dispatch",
				at: "2026-10-08T09:00:00.000Z",
			},
			{ by: LEAD, verdict: "fix-first", at: "2026-10-08T12:00:00.000Z" },
			{ by: ADAMS, verdict: "approve", at: "2026-10-08T13:00:00.000Z" },
		],
		pairs: [
			{ ...bySmythe("Kapoor", sure(KAPOOR, "2026-10-08T10:00:00.000Z")), status: "cancelled" },
			{ ...bySmythe("Colter", sure(COLTER, "2026-10-08T10:00:00.000Z")), status: "cancelled" },
		],
	},
});
describe("merge-check: cancellation preserves exact-head evidence", () => {
	test("a cancelled exact-head task with a fix-first verdict still makes it fix-first", async () => {
		const r = await run("p/r", 1858);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["review verdict fix-first"]);
	});
	test("cancelled approved pairs retain authority: Smythe fix-first beats later legacy lead approve, class C", async () => {
		const r = await run("p/r", 1857);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["review verdict fix-first"]);
	});
	test("a cancelled OLD head with the same sha7 does not count for the new head", async () => {
		const r = await run("p/r", 1856);
		expect(r.code).toBe(0);
		expect(r.json.class).toBe("A");
		expect(r.json.reasons).toEqual(["pair approve; blast radius confirmed by both"]);
	});
});

// sf#1730 US-002: a fake factoryignore-cli, keyed by PR number. 1732 prints a
// non-code answer and still exits 3, so an exit code that is ignored shows.
const FAKE_CLI = join(fresh(), "factoryignore-cli");
const CLI_RAN = `${FAKE_CLI}.ran`;
writeFileSync(
	FAKE_CLI,
	`#!/usr/bin/env python3
import json, os, sys
with open(${JSON.stringify(CLI_RAN)}, "a") as f:
    f.write(" ".join(sys.argv[1:]) + " " + os.environ.get("FORGEJO_API_URL", "") + "\\n")
yes = {"nonCode": True, "refused": [], "base": "b" * 40}
n = sys.argv[2]
if n in ("1730", "1733", "1734", "1735"):
    print(json.dumps(yes))
elif n == "1731":
    print(json.dumps({"nonCode": False, "refused": [{"path": "AGENTS.md", "reason": "refused name"}], "base": "b" * 40}))
else:
    print(json.dumps(yes))
    sys.exit(3)
`,
	{ mode: 0o755 },
);
const SCRIPTED = "verdict: approve (scripted: non-code)\n\nEvery changed path is non-code.";
Object.assign(PRS, {
	"o/r#1735": {
		files: ["_DOCS/x.md"],
		board: [],
		smythe: [{ line: "smythe: kickback: needs review" }],
	},
	"o/r#1730": { files: ["_DOCS/x.md"] },
	// The Forge comment says scripted approve; the re-derivation says refused.
	"o/r#1731": {
		files: ["AGENTS.md"],
		notes: [{ login: "sf-smythe", body: SCRIPTED, at: "2026-10-07T10:00:00Z" }],
	},
	"o/r#1732": { files: ["_DOCS/x.md"] },
	"st/scripted-red#1733": {
		files: ["_DOCS/x.md"],
		statuses: { ...GREEN, "factory/prepush": "failure" },
	},
	"o/r#1734": { files: ["_DOCS/x.md"], board: [{ by: LEAD, verdict: "fix-first" }] },
});
describe("merge-check: the scripted non-code approve", () => {
	test("a non-code head with no board verdict is class A, scripted: non-code", async () => {
		writeFileSync(CLI_RAN, "");
		const r = await run("o/r", 1730);
		expect(r.json).toMatchObject({ class: "A", mergeable: true, checks: "green" });
		expect(r.json.reasons).toEqual(["scripted: non-code"]);
		// Re-derived for the exact head, on the Forge merge-check reads.
		expect(readFileSync(CLI_RAN, "utf8")).toBe(`o/r 1730 ${SHA} ${api}\n`);
	});
	test("a non-code head with a Smythe decision and no verdict keeps the non-scripted answer", async () => {
		writeFileSync(CLI_RAN, "");
		const r = await run("o/r", 1735);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).not.toContain("scripted: non-code");
		expect(readFileSync(CLI_RAN, "utf8")).toBe("");
	});
	test("a refused path keeps no lead verdict, whatever the Forge comment says", async () => {
		const r = await run("o/r", 1731);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual([`no lead verdict on the board for ${SHA.slice(0, 7)}`]);
	});
	test("a CLI exit 3 keeps no lead verdict, even with a non-code line on stdout", async () => {
		const r = await run("o/r", 1732);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual([`no lead verdict on the board for ${SHA.slice(0, 7)}`]);
	});
	test("a missing CLI keeps no lead verdict", async () => {
		const r = await run("o/r", 1730, { FACTORYIGNORE_CLI: `${FAKE_CLI}.absent` });
		expect(r.json.class).toBe("C");
	});
	test("red checks are not class A on the scripted path", async () => {
		const r = await run("st/scripted-red", 1733);
		expect(r.json).toMatchObject({ class: "C", checks: "red" });
		expect(r.json.reasons).toEqual(["factory/prepush is failure"]);
	});
	test("a board fix-first verdict on the head wins over the scripted path", async () => {
		writeFileSync(CLI_RAN, "");
		const r = await run("o/r", 1734);
		expect(r.json.class).toBe("C");
		expect(r.json.reasons).toEqual(["review verdict fix-first"]);
		expect(readFileSync(CLI_RAN, "utf8")).toBe("");
	});
});

test("post-verdict escalation holds the actual merge-check at class C", async () => {
	const p = Bun.spawnSync(
		[
			Bun.which("bash") ?? "/opt/homebrew/bin/bash",
			process.env.POST_VERDICT_UNDER_TEST ??
				resolve(import.meta.dir, "../../fleet/bin/post-verdict"),
			"--dry-run",
			"-",
		],
		{
			stdin: new Blob([
				JSON.stringify({
					kind: "review",
					repo: "p/r",
					pr: 2099,
					sha: SHA,
					findings: [],
					verdict: "approve",
					blast_radius: "confirmed",
					escalate: "cannot judge auth",
				}),
			]),
		},
	);
	expect(p.exitCode).toBe(0);
	PRS["p/r#2099"] = {
		pairs: [
			{ name: "Kapoor", posts: [{ by: KAPOOR, text: p.stdout.toString() }] },
			{ name: "Colter", posts: [sure(COLTER)] },
		],
	};
	const r = await run("p/r", 2099);
	expect(r.json.class).toBe("C");
	expect(r.json.reasons).toEqual(["smythe review: cannot judge auth"]);
});
