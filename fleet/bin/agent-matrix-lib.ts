/**
 * @module fleet/bin/agent-matrix-lib
 * @description Pure logic for `fleet/bin/agent-matrix`: task
 *   classification, lead-verdict credit parsing, stats, bottleneck selection,
 *   and report rendering. No I/O.
 */

export interface Agent {
	id: string;
	name: string;
	title: string;
	harness: string;
	model: string;
	effort: string;
	maxConc: number | string;
}

export interface Run {
	id?: string;
	agentId: string;
	status?: string;
	createdAt?: string;
	startedAt?: string | null;
	finishedAt?: string | null;
	contextSnapshot?: { issueId?: string } | null;
	usageJson?: { inputTokens?: number; outputTokens?: number; costUsd?: number } | null;
}

export interface Issue {
	id: string;
	title: string;
	parentId?: string | null;
	assigneeAgentId?: string | null;
	createdAt?: string;
}

export interface Verdict {
	body: string;
	verdict: string;
	createdAt: string;
}

export interface Comment {
	body?: string;
	createdAt?: string;
}

export interface Credit {
	upheld: number;
	p01: number;
	rejected: number;
}

export interface AgentStatsRow {
	agent: string;
	n: number;
	failed: number;
	failPct: number;
	queueMed: number | null;
	queueP90: number | null;
	runMed: number | null;
	runP90: number | null;
}

export const LEAD_RE = /^Review [^ ]+#[0-9]+ @ /;

export function median(xs: number[]): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	const m = s.length >> 1;
	return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
}

export function percentile(xs: number[], p: number): number | null {
	if (!xs.length) return null;
	const s = [...xs].sort((a, b) => a - b);
	return s[Math.max(0, Math.min(s.length - 1, Math.ceil(p * s.length) - 1))] as number;
}

export const p90 = (xs: number[]): number | null => percentile(xs, 0.9);

export function percent(part: number, whole: number): number {
	return whole ? +((100 * part) / whole).toFixed(1) : 0;
}

export function minutesBetween(a?: string | null, b?: string | null): number | null {
	return a && b ? (Date.parse(b) - Date.parse(a)) / 60000 : null;
}

/** Last comment carrying a `verdict:` line, or null. */
export function lastVerdict(comments: Comment[]): Verdict | null {
	const cs = [...comments].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
	let last: Verdict | null = null;
	for (const c of cs) {
		const m = /^verdict:\s*(approve-with-fixes|approve|fix-first)/m.exec(c.body ?? "");
		if (m) last = { body: c.body ?? "", verdict: m[1] as string, createdAt: String(c.createdAt) };
	}
	return last;
}

/** First-name (lowercased) to agent id. */
export function firstNameIndex(agents: Iterable<Agent>): Map<string, string> {
	const out = new Map<string, string>();
	for (const a of agents) out.set((String(a.name).split(/\s+/)[0] ?? "").toLowerCase(), a.id);
	return out;
}

function matchNames(s: string, names: Map<string, string>): string[] {
	const out: string[] = [];
	for (const w of s.split(/[^A-Za-z]+/)) {
		const id = names.get(w.toLowerCase());
		if (id && !out.includes(id)) out.push(id);
	}
	return out;
}

function section(body: string, head: string): string {
	const i = body.indexOf(head);
	if (i < 0) return "";
	const rest = body.slice(i + head.length);
	const j = rest.search(/\n#{2,3} /);
	return j < 0 ? rest : rest.slice(0, j);
}

/** Credits from one lead verdict body. Unmatched credits go to `unknown` as samples. */
export function parseVerdictCredits(
	body: string,
	names: Map<string, string>,
): {
	credits: Map<string, Credit>;
	unknownUpheld: number;
	unknownRejected: number;
	unknown: string[];
} {
	const credits = new Map<string, Credit>();
	const c = (k: string): Credit => {
		let v = credits.get(k);
		if (!v) {
			v = { upheld: 0, p01: 0, rejected: 0 };
			credits.set(k, v);
		}
		return v;
	};
	const unknown: string[] = [];
	let unknownUpheld = 0;
	let unknownRejected = 0;
	for (const item of section(body, "### Upheld").split(/\n(?=\d+\.\s)/)) {
		const pm = /\*\*P(\d)\s*[—-]/.exec(item);
		if (!pm) continue;
		const fm = /found by ([^\n.;]*)/i.exec(item);
		let ids = fm ? matchNames(fm[1] as string, names) : [];
		if (fm && /\bboth\b/i.test(fm[1] as string) && ids.length < 2) {
			const rv = matchNames(
				(/\*\*Reviewers:\*\*([^\n]*)/.exec(body) ?? ["", ""])[1] as string,
				names,
			);
			ids = [...new Set([...ids, ...rv])];
		}
		if (!ids.length) {
			unknownUpheld++;
			unknown.push((fm?.[1] ?? "(no 'found by')").trim().slice(0, 40));
			continue;
		}
		for (const id of ids) {
			c(id).upheld++;
			if (Number(pm[1]) <= 1) c(id).p01++;
		}
	}
	for (const line of section(body, "### Not reproduced or refuted").split("\n")) {
		if (!/^- /.test(line)) continue;
		const parts = line.split(" — ");
		if (parts.length < 2) continue;
		const ids = matchNames(parts[1] as string, names);
		if (!ids.length) {
			unknownRejected++;
			unknown.push((parts[1] as string).trim().slice(0, 40));
			continue;
		}
		for (const id of ids) c(id).rejected++;
	}
	return { credits, unknownUpheld, unknownRejected, unknown };
}

function byTitle(a?: Agent): string {
	const t = a?.title ?? "";
	if (/Issue Triage/i.test(t)) return "triage";
	if (/Forge Scribe/i.test(t)) return "scribe";
	if (/Infra Rep/i.test(t)) return "infra";
	if (/Milestone Engineer|CTO/i.test(t)) return "implement";
	return "other";
}

/** Task type from the run's issue title, else the agent title. */
export function classifyRun(issue: Issue | undefined, agent: Agent | undefined): string {
	if (!issue) return byTitle(agent);
	const smythe = /smythe/i.test(agent?.name ?? "");
	if (smythe && LEAD_RE.test(issue.title)) return "lead";
	if (/review/i.test(issue.title) && !smythe) return "review";
	if (/^Merge /.test(issue.title)) return "merge";
	return byTitle(agent);
}

export function runStats(rs: Run[]) {
	const failed = rs.filter((r) => r.status === "failed" || r.status === "timed_out").length;
	const num = (xs: (number | null | undefined)[]) =>
		xs.filter((x): x is number => typeof x === "number");
	const qm = num(rs.map((r) => minutesBetween(r.createdAt, r.startedAt)));
	const rm = num(rs.map((r) => minutesBetween(r.startedAt, r.finishedAt)));
	return {
		n: rs.length,
		failed,
		failPct: percent(failed, rs.length),
		queueMed: median(qm),
		queueP90: p90(qm),
		runMed: median(rm),
		runP90: p90(rm),
		inMed: median(num(rs.map((r) => r.usageJson?.inputTokens))),
		outMed: median(num(rs.map((r) => r.usageJson?.outputTokens))),
		costMed: median(num(rs.map((r) => r.usageJson?.costUsd))),
	};
}

export function selectBottlenecks<T extends AgentStatsRow>(rows: T[]) {
	return {
		topQueueP90: rows
			.filter((r) => r.queueP90 != null)
			.sort((a, b) => (b.queueP90 as number) - (a.queueP90 as number))
			.slice(0, 5),
		queueOverRun: rows.filter(
			(r) => r.queueMed != null && r.runMed != null && r.queueMed > r.runMed,
		),
		highFail: rows.filter((r) => r.failPct >= 10 && r.n >= 5),
	};
}

export interface BoardData {
	agents: Agent[];
	runs: Run[];
	issues: Issue[];
	verdicts: Map<string, Verdict | null>;
	/** Keep only runs with createdAt >= sinceMs (epoch ms). */
	sinceMs?: number;
}

type Row = Record<string, unknown> & AgentStatsRow;
type Col = [string, (r: Row) => string];

const f = (x: unknown, d = 1): string =>
	x == null
		? ""
		: typeof x === "number"
			? Number.isInteger(x)
				? String(x)
				: x.toFixed(d)
			: String(x);

const table = (cols: Col[], rs: Row[]): string =>
	[
		`| ${cols.map((c) => c[0]).join(" | ")} |`,
		`|${cols.map(() => "---").join("|")}|`,
		...rs.map((r) => `| ${cols.map((c) => c[1](r)).join(" | ")} |`),
	].join("\n");

/** Build all tables from fetched board data. */
export function buildMatrix(data: BoardData) {
	const { issues, verdicts, sinceMs } = data;
	const agents = new Map(data.agents.map((a) => [a.id, a]));
	const gaps: string[] = [];
	if (data.runs.length === 1000)
		gaps.push(
			"Runs API returned exactly 1000 rows for limit=5000 (server cap; no working offset/page param found), so the window is the newest 1000 runs only.",
		);
	if (issues.length === 1000)
		gaps.push(
			"Issues API returned exactly 1000 rows for limit=5000 (server cap), so older issues are absent.",
		);
	let runs = data.runs;
	if (sinceMs != null) {
		const oldest = data.runs
			.map((r) => Date.parse(String(r.createdAt)))
			.filter((t) => !Number.isNaN(t))
			.sort((a, b) => a - b)[0];
		if (oldest != null && oldest > sinceMs)
			gaps.push(
				`window truncated: oldest run ${new Date(oldest).toISOString()} is after the cutoff ${new Date(sinceMs).toISOString()}; runs before it are not in this report`,
			);
		runs = data.runs.filter((r) => Date.parse(String(r.createdAt)) >= sinceMs);
	}
	const times = runs.map((r) => String(r.createdAt)).sort();
	const window = `${times[0] ?? ""} .. ${times.at(-1) ?? ""}`;
	const issueById = new Map(issues.map((i) => [i.id, i]));
	const leadIssues = issues.filter((i) => LEAD_RE.test(i.title));

	const names = firstNameIndex(agents.values());
	const quality = new Map<string, Credit>();
	let unknownUpheld = 0;
	let unknownRejected = 0;
	const unknownSamples = new Set<string>();
	let verdictsMissing = 0;
	for (const li of leadIssues) {
		const v = verdicts.get(li.id);
		if (!v) {
			verdictsMissing++;
			continue;
		}
		const p = parseVerdictCredits(v.body, names);
		for (const [id, cr] of p.credits) {
			const q = quality.get(id) ?? { upheld: 0, p01: 0, rejected: 0 };
			q.upheld += cr.upheld;
			q.p01 += cr.p01;
			q.rejected += cr.rejected;
			quality.set(id, q);
		}
		unknownUpheld += p.unknownUpheld;
		unknownRejected += p.unknownRejected;
		for (const s of p.unknown) unknownSamples.add(s);
	}
	if (verdictsMissing)
		gaps.push(
			`${verdictsMissing} of ${leadIssues.length} lead review issues had no comment with a \`verdict:\` line (open or abandoned rounds); excluded from quality.`,
		);
	if (unknownUpheld + unknownRejected)
		gaps.push(
			`${unknownUpheld + unknownRejected} finding credits named no matchable agent (counted under \`unknown\`); samples: ${[
				...unknownSamples,
			]
				.slice(0, 6)
				.map((s) => JSON.stringify(s))
				.join(", ")}.`,
		);

	const rounds = new Map<string, number>();
	for (const li of leadIssues) {
		const who = new Set(
			issues
				.filter((c) => c.parentId === li.id && c.assigneeAgentId)
				.map((c) => c.assigneeAgentId as string),
		);
		for (const id of who) rounds.set(id, (rounds.get(id) ?? 0) + 1);
	}

	let noIssue = 0;
	let issueNotInWindow = 0;
	const tagged = runs.map((r) => {
		const iid = r.contextSnapshot?.issueId;
		const iss = iid ? issueById.get(iid) : undefined;
		if (!iid) noIssue++;
		else if (!iss) issueNotInWindow++;
		const a = agents.get(r.agentId);
		return { r, a, task: classifyRun(iss, a) };
	});
	const unknownAgentRuns = runs.filter((r) => !agents.has(r.agentId)).length;
	if (unknownAgentRuns)
		gaps.push(`${unknownAgentRuns} runs belong to agentIds not in the agent list.`);
	gaps.push(
		`${noIssue} runs carried no contextSnapshot.issueId; ${issueNotInWindow} named an issue not in the fetched issues (older than the issue cap); both classified by agent title alone.`,
	);
	gaps.push(
		`${tagged.filter((t) => t.task === "other").length} runs fell into task type \`other\` (agent title maps to no listed type).`,
	);
	gaps.push(
		`${runs.filter((r) => !r.finishedAt).length} runs unfinished at fetch time (no run minutes); ${runs.filter((r) => !r.startedAt).length} never started (no queue minutes).`,
	);
	gaps.push(
		`${runs.filter((r) => r.finishedAt && r.usageJson?.costUsd == null).length} finished runs had no usageJson.costUsd (cost blank for those).`,
	);
	const zero = runs.filter((r) => r.usageJson?.costUsd === 0).length;
	if (zero)
		gaps.push(
			`${zero} runs report costUsd = 0 (pi_local/bifrost-routed); their USD/run shows 0, which is not an API-equivalent price.`,
		);
	gaps.push(
		"Not measured: correctness of non-review work (implement/triage/infra/scribe/merge outcomes), and reviewer findings never surfaced in a lead verdict.",
	);

	const rows: Row[] = [];
	const taskRows: Row[] = [];
	for (const a of [...agents.values()].sort((x, y) => x.name.localeCompare(y.name))) {
		const mine = tagged.filter((t) => t.r.agentId === a.id);
		const qq = quality.get(a.id);
		const isRev = mine.some((t) => t.task === "review") || quality.has(a.id);
		const base = {
			agent: a.name,
			harness: a.harness,
			model: a.model,
			effort: a.effort,
			maxConcurrentRuns: a.maxConc,
		};
		rows.push({
			...base,
			task: "all",
			...runStats(mine.map((t) => t.r)),
			upheld: isRev ? (qq?.upheld ?? 0) : null,
			p01: isRev ? (qq?.p01 ?? 0) : null,
			rejected: isRev ? (qq?.rejected ?? 0) : null,
			upheldRate:
				isRev && qq && qq.upheld + qq.rejected
					? +(qq.upheld / (qq.upheld + qq.rejected)).toFixed(2)
					: null,
			rounds: rounds.get(a.id) ?? 0,
		});
		for (const tk of [...new Set(mine.map((t) => t.task))].sort()) {
			const sub = mine.filter((t) => t.task === tk);
			if (sub.length >= 3) taskRows.push({ ...base, task: tk, ...runStats(sub.map((t) => t.r)) });
		}
	}

	const byPr = new Map<string, Issue[]>();
	for (const li of leadIssues) {
		const k = /^Review ([^ ]+#[0-9]+) @ /.exec(li.title)?.[1] ?? li.title;
		byPr.set(k, [...(byPr.get(k) ?? []), li]);
	}
	const leadRunMins = tagged
		.filter((t) => t.task === "lead")
		.map((t) => minutesBetween(t.r.startedAt, t.r.finishedAt))
		.filter((x): x is number => x != null);
	const prRows = [...byPr].map(([pr, lis]) => {
		const first = lis.map((l) => String(l.createdAt)).sort()[0] as string;
		const lastV = lis
			.map((l) => verdicts.get(l.id)?.createdAt)
			.filter((x): x is string => !!x)
			.sort()
			.at(-1);
		const reviewerTasks = issues.filter((c) => lis.some((l) => l.id === c.parentId)).length;
		const ids = new Set(lis.map((l) => l.id));
		for (const c of issues) if (c.parentId && ids.has(c.parentId)) ids.add(c.id);
		const prRuns = runs.filter((r) => ids.has(r.contextSnapshot?.issueId ?? ""));
		const tokens = prRuns.reduce(
			(s, r) => s + (r.usageJson?.inputTokens ?? 0) + (r.usageJson?.outputTokens ?? 0),
			0,
		);
		const usd = prRuns.reduce((s, r) => s + Math.max(0, r.usageJson?.costUsd ?? 0), 0);
		const zeroCostRuns = prRuns.filter((r) => r.usageJson?.costUsd === 0).length;
		return {
			pr,
			rounds: lis.length,
			reviewerTasks,
			hours: lastV ? +((Date.parse(lastV) - Date.parse(first)) / 3600000).toFixed(2) : null,
			tokens,
			usd: +usd.toFixed(3),
			zeroCostRuns,
		};
	});
	const rc = prRows.map((p) => p.rounds);
	const hrs = prRows.map((p) => p.hours).filter((x): x is number => x != null);
	const loop = {
		prs: prRows.length,
		roundsMed: median(rc),
		roundsMax: rc.length ? Math.max(...rc) : null,
		prs3plus: prRows.filter((p) => p.rounds >= 3).length,
		leadRoundMinMed: median(leadRunMins),
		leadRoundMinP90: p90(leadRunMins),
		hoursMed: median(hrs),
		hoursMax: hrs.length ? Math.max(...hrs) : null,
	};
	const top10 = [...prRows]
		.sort((a, b) => b.rounds - a.rounds || (b.hours ?? 0) - (a.hours ?? 0))
		.slice(0, 10);
	const noVerdictPrs = prRows.filter((p) => p.hours == null).length;
	if (noVerdictPrs)
		gaps.push(
			`${noVerdictPrs} PRs have no verdict yet, so first-round-to-last-verdict hours is blank for them.`,
		);
	gaps.push(
		"Lead round minutes are lead (Smythe on a Review issue) run durations; a round can span several runs, so this is per-run, not per-round wall time.",
	);
	const unknownCredits =
		unknownUpheld + unknownRejected ? { upheld: unknownUpheld, rejected: unknownRejected } : null;
	return {
		window,
		counts: { runs: runs.length, issues: issues.length, leadIssues: leadIssues.length },
		agents: rows,
		byTask: taskRows,
		bottlenecks: selectBottlenecks(rows),
		reviewLoop: loop,
		top10,
		prRows,
		unknownCredits,
		gaps,
	};
}

export type Matrix = ReturnType<typeof buildMatrix>;

export function renderMarkdown(m: Matrix): string {
	const common: Col[] = [
		["agent", (r) => f(r.agent)],
		["harness", (r) => f(r.harness)],
		["model", (r) => f(r.model)],
		["effort", (r) => f(r.effort)],
		["task", (r) => f(r.task)],
		["runs", (r) => f(r.n)],
		["failed", (r) => f(r.failed)],
		["fail %", (r) => f(r.failPct)],
		["queue min med", (r) => f(r.queueMed)],
		["queue min p90", (r) => f(r.queueP90)],
		["run min med", (r) => f(r.runMed)],
		["run min p90", (r) => f(r.runP90)],
		["in tok med", (r) => f(r.inMed, 0)],
		["out tok med", (r) => f(r.outMed, 0)],
		["USD/run med", (r) => f(r.costMed, 3)],
	];
	const agentCols: Col[] = [
		...common,
		["upheld", (r) => f(r.upheld)],
		["P0/P1 upheld", (r) => f(r.p01)],
		["rejected", (r) => f(r.rejected)],
		["upheld rate", (r) => f(r.upheldRate, 2)],
		["review rounds", (r) => f(r.rounds)],
	];
	const b = m.bottlenecks;
	const list = (rs: Row[], fmt: (r: Row) => string) =>
		rs.length ? rs.map((r) => `- ${fmt(r)}`).join("\n") : "- none";
	const uq = m.unknownCredits;
	const asRow = (x: object) => x as Row;
	return `# Agent matrix (${m.window})

## Bottlenecks
Top 5 by queue min p90:
${list(b.topQueueP90, (r) => `${r.agent}: queue p90 ${f(r.queueP90)} min, median ${f(r.queueMed)} min, runs ${r.n}`)}

Median queue wait above median run time:
${list(b.queueOverRun, (r) => `${r.agent}: queue med ${f(r.queueMed)} min > run med ${f(r.runMed)} min`)}

Fail % >= 10 with n >= 5:
${list(b.highFail, (r) => `${r.agent}: ${r.failed}/${r.n} failed (${f(r.failPct)}%)`)}

## How it was measured
- Sources: Paperclip board API (GET only): agents, heartbeat-runs (limit=5000, server returned ${m.counts.runs}), issues (returned ${m.counts.issues}), comments on ${m.counts.leadIssues} lead review issues.
- Window: run createdAt ${m.window}.
- Task type: from the title of run.contextSnapshot.issueId's issue (review / lead / merge), else from the agent title (triage, scribe, infra, implement, other).
- Quality: last \`verdict:\` comment per lead issue; \`### Upheld\` items credit "found by" names, \`### Not reproduced or refuted\` bullets credit the raiser.
- Not measured: outcome quality of non-review work; findings that never reached a lead verdict; anything older than the API row cap.

## Agents
${table(agentCols, m.agents)}
${uq ? `\nUnmatched credits (\`unknown\`): upheld ${uq.upheld}, rejected ${uq.rejected}.\n` : ""}
## By task type
${table(common, m.byTask)}

## Review loop
${table(
	[
		["PRs reviewed", (r) => f(r.prs)],
		["rounds/PR med", (r) => f(r.roundsMed)],
		["rounds/PR max", (r) => f(r.roundsMax)],
		["PRs 3+ rounds", (r) => f(r.prs3plus)],
		["lead round min med", (r) => f(r.leadRoundMinMed)],
		["lead round min p90", (r) => f(r.leadRoundMinP90)],
		["first round to last verdict h med", (r) => f(r.hoursMed, 2)],
		["... h max", (r) => f(r.hoursMax, 2)],
	],
	[asRow(m.reviewLoop)],
)}

Top 10 PRs by rounds:

${table(
	[
		["PR", (r) => f(r.pr)],
		["rounds", (r) => f(r.rounds)],
		["reviewer tasks", (r) => f(r.reviewerTasks)],
		["hours", (r) => f(r.hours, 2)],
		["tokens", (r) => f(r.tokens, 0)],
		["USD (non-zero)", (r) => f(r.usd, 3)],
		["runs at $0", (r) => f(r.zeroCostRuns)],
	],
	m.top10.map(asRow),
)}

## Gaps in the data
${m.gaps.map((g) => `- ${g}`).join("\n")}
`;
}
