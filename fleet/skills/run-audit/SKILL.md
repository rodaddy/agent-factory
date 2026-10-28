---
name: run-audit
description: "Reed's fleet audit, daily (last 24h) and weekly (last 7d), per _DOCS/FLEET_AUDIT_SOP.md: run the audit applications, read their output plus a per-seat run table, post one `Fleet audit <date>` issue to Bishop, and file one `Script it: <pattern>` issue per deterministic candidate. Reads only; never edits a skill or a seat."
---

# run-audit

The fleet audit (`_DOCS/FLEET_AUDIT_SOP.md`). Applications collect
and analyze every seat's runs; you read what they wrote and hand each finding
to Bishop as a board issue. You do not redo by hand what an application
already did. Your only writes are board issues and comments.

Run by two routines that create a board issue and assign it to you:
`Fleet audit daily` and `Fleet audit weekly`. Until the operator creates them,
Bishop assigns the task by hand.

## Spec-ready before implementation dispatch

Before creating, assigning, reopening, or handing back implementation or repair
work, follow `delegate-work`, "Spec-ready before implementation dispatch".
Use `spec-ready` and `task-new`; a hold queues one unassigned spec-writing step
instead of sending the work to a seat. Diagnosis and review keep their own paths.

## Steps

0. **Pick the window from your task title.** `daily`: `KIND=daily WINDOW=24h
   HOURS=24 DAYS=1`. `weekly`: `KIND=weekly WINDOW=7d HOURS=168 DAYS=7`. Set
   these at the top of every shell call below. Neither word in the title:
   comment that on your task, set it `blocked`, and stop.

1. **Check the keys are there, without printing them.** In your task's cwd:

   ```
   for v in PAPERCLIP_API_URL PAPERCLIP_API_KEY PAPERCLIP_COMPANY_ID \
     LANGFUSE_BASE_URL LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY; do
     [ -n "${!v}" ] && echo "$v set" || echo "$v MISSING"
   done
   ```

   Any `MISSING`: comment the list of missing names on your task, set it
   `blocked`, and stop. Never echo a value.

2. **Run the audit applications.** Each runs with no pipe, so its exit code is
   real. A missing file means its PR has not merged yet: write
   `<file>: not merged yet` into `apps.md` and go on.
   - Once sf#1709
     and sf#1708
     merge: collect, then analyze.

     ```
     python3 ~/fleet/audit/collect.py --window "$WINDOW" --out snapshot.json
     python3 ~/fleet/audit/analyze.py snapshot.json --json findings.json --md apps.md
     ```

   - Once branch `feat/1690-fleet-tool-patterns` merges: tool-call patterns.
     Append its report to `apps.md`; it lists the DETERMINISTIC CANDIDATES.

     ```
     python3 ~/fleet/audit/tool-patterns.py --hours "$HOURS" >> apps.md
     ```

   Exit not 0: comment the error line on your task, set it `blocked`, and stop.

3. **Pull, join and tabulate per seat.** One node script, run with no pipe so the exit
   code is real. It reads, per seat, the runs of the last `$DAYS` days (the board GET
   `daily-report` uses, with `agentId`), each run's task
   (`contextSnapshot.issueId`), and the Langfuse trace of every run that did
   not succeed or whose task ended `blocked` or `cancelled` (trace id = run
   id, basic auth from the two keys). It writes `run-audit.md` in your cwd.
   Run the block dedented: `JS` must start at column zero.

   ```
   AUDIT_DAYS="$DAYS" node --input-type=module - > run-audit.md <<'JS'
   const B = (process.env.PAPERCLIP_API_URL ?? "http://127.0.0.1:3100").replace(/\/+$/, "");
   const L = process.env.LANGFUSE_BASE_URL.replace(/\/+$/, "");
   const co = process.env.PAPERCLIP_COMPANY_ID;
   const lfAuth = "Basic " + Buffer.from(`${process.env.LANGFUSE_PUBLIC_KEY}:${process.env.LANGFUSE_SECRET_KEY}`).toString("base64");
   const get = async (url, auth, miss) => {
     const r = await fetch(url, { headers: { Authorization: auth }, signal: AbortSignal.timeout(20000) });
     if (r.status === 404 && miss) return null;
     if (!r.ok) throw new Error(`GET ${url.replace(/\?.*/, "")} -> ${r.status}`);
     return r.json();
   };
   const board = (p, miss) => get(`${B}/api${p}`, `Bearer ${process.env.PAPERCLIP_API_KEY}`, miss);
   const pool = async (keys, fn) => {
     const out = new Map(); let i = 0;
     await Promise.all(Array.from({ length: 8 }, async () => {
       while (i < keys.length) { const k = keys[i++]; out.set(k, await fn(k)); }
     }));
     return out;
   };
   const DAYS = Number(process.env.AUDIT_DAYS), LIMIT = 5000, since = Date.now() - DAYS * 864e5;
   if (!(DAYS > 0)) throw new Error("AUDIT_DAYS unset");
   const BAD = ["failed", "cancelled", "timed_out"], UNFINISHED = ["blocked", "cancelled"];
   const tok = (r) => (r.usageJson?.inputTokens ?? 0) + (r.usageJson?.outputTokens ?? 0);
   const agents = await board(`/companies/${co}/agents`);
   const runs = [], cut = [];
   for (const a of agents) {
     const rs = await board(`/companies/${co}/heartbeat-runs?agentId=${a.id}&limit=${LIMIT}`);
     const mine = rs.filter((r) => r.agentId === a.id && Date.parse(r.createdAt) >= since);
     if (rs.length >= LIMIT && mine.length === rs.filter((r) => r.agentId === a.id).length) cut.push(a.name);
     for (const r of mine) runs.push({ ...r, seat: a.name });
   }
   const ids = [...new Set(runs.map((r) => r.contextSnapshot?.issueId).filter(Boolean))];
   const issues = await pool(ids, (id) => board(`/issues/${id}`, true));
   const st = (r) => issues.get(r.contextSnapshot?.issueId)?.status ?? "none";
   const probe = runs.filter((r) => BAD.includes(r.status) || UNFINISHED.includes(st(r)));
   const traces = await pool(probe.map((r) => r.id), (id) => get(`${L}/api/public/traces/${id}`, lfAuth, true));
   const out = [`# Runs per seat, ${DAYS} day(s) to ${new Date().toISOString().slice(0, 10)}`, "",
     "| seat | runs | failed/cancelled | tokens on blocked/cancelled tasks | traces found | top repeated error (count) |",
     "|---|---|---|---|---|---|"];
   for (const seat of [...new Set(runs.map((r) => r.seat))].sort()) {
     const rs = runs.filter((r) => r.seat === seat), ps = probe.filter((r) => r.seat === seat);
     const bad = rs.filter((r) => BAD.includes(r.status)).length;
     const errs = new Map();
     for (const r of ps) for (const o of traces.get(r.id)?.observations ?? [])
       if (o.level === "ERROR") { const k = `${o.name}: ${(o.statusMessage ?? "").slice(0, 80)}`; errs.set(k, (errs.get(k) ?? 0) + 1); }
     const top = [...errs].sort((x, y) => y[1] - x[1])[0];
     out.push(`| ${seat} | ${rs.length} | ${bad} (${Math.round((100 * bad) / rs.length)}%) | ${rs.filter((r) => UNFINISHED.includes(st(r))).reduce((s, r) => s + tok(r), 0)} | ${ps.filter((r) => traces.get(r.id)).length} of ${ps.length} | ${top ? `${top[0].replaceAll("|", "/")} (${top[1]})` : "none"} |`);
   }
   const cost = new Map();
   for (const r of runs.filter((r) => UNFINISHED.includes(st(r)))) {
     const c = cost.get(r.contextSnapshot.issueId) ?? { tokens: 0, runs: [] };
     c.tokens += tok(r); c.runs.push(r.id); cost.set(r.contextSnapshot.issueId, c);
   }
   out.push("", "## Top 5 most expensive unfinished tasks", "", "| task | status | runs | tokens | run ids |", "|---|---|---|---|---|");
   for (const [id, c] of [...cost].sort((x, y) => y[1].tokens - x[1].tokens).slice(0, 5)) {
     const i = issues.get(id);
     out.push(`| ${i.identifier ?? id} ${(i.title ?? "").replaceAll("|", "/").slice(0, 60)} | ${i.status} | ${c.runs.length} | ${c.tokens} | ${c.runs.slice(0, 3).join(", ")} |`);
   }
   out.push("", `Sources: board heartbeat-runs per seat (limit ${LIMIT}), ${ids.length} tasks, ${traces.size} Langfuse traces looked up for ${probe.length} runs that failed or sit on a blocked or cancelled task.`,
     "Tokens are the board's usageJson input plus output. Errors are Langfuse observations at level ERROR.",
     cut.length ? `TRUNCATED: ${cut.join(", ")} hit the ${LIMIT}-run limit inside the window; their counts are low.` : "No seat hit the run limit.");
   console.log(out.join("\n"));
   JS
   echo "exit $?"
   ```

   Exit not 0: the board or Langfuse refused or was unreachable. Comment the
   error line on your task, set it `blocked`, and stop. Never print a key to
   debug it. A `TRUNCATED` line is a fact for the report, not a failure.

4. **Read the output and pick the findings.** Read `apps.md` first, then
   `run-audit.md`. Two kinds:
   - A finding: a number that points at a cause a skill, a rule, a routine or
     a model setting could fix. Every `act` row in `findings.json`, plus these
     lines in the per-seat table: one error repeated 5 or more times on one
     seat; a seat with 10 or more runs and more than 25% failed or cancelled; a
     task in the top 5 that took 3 or more runs and is still unfinished.
   - The `## RSS benchmark` capacity line in `apps.md`: when `capacity at
     measured p95: <N>` is below `hand-set constant: <C>`, file one
     `Fleet audit finding: run capacity constant <C> vs measured <N>` (step 6
     shape, with a `backout:` line). At or above the constant, or with no
     capacity line, it is informational. You never change the constant.
   - A DETERMINISTIC CANDIDATE: a pattern over the SOP threshold (seen in 10 or
     more distinct runs in 24h, or in 3 or more seats; or a task family that
     recurs 10 or more times a day with the same steps).
   At most 5 findings and 5 candidates per report. A run you cannot explain
   from its numbers is not a finding.

5. **Post the report as ONE board issue to Bishop.** In one shell call:

   ```
   bishop=$(paperclipai agent list -C "$PAPERCLIP_COMPANY_ID" --json | jq -r '.[] | select(.name == "Bishop") | .id')
   body=$(cat apps.md run-audit.md)
   paperclipai issue create -C "$PAPERCLIP_COMPANY_ID" --title "Fleet audit $(date -u +%F) $KIND" \
     --description "$body" --status todo --assignee-agent-id "$bishop" --json
   ```

   Empty `$bishop` or `$body`: stop and say so on your task; never create an
   issue with an empty body.

6. **File one board issue per finding and per candidate**, assigned to Bishop
   the same way. A finding is titled `Fleet audit finding: <one line>`; a
   candidate is titled `Script it: <pattern>`. The description carries the
   numbers (runs, seats, calls), the run ids and task ids that show it, the
   change you think it points at, and a `backout:` line. For a candidate, the
   change is the application that replaces the tool calls (a script, a plugin
   rule, a CLI helper or preloaded context). Before filing, search open board
   issues for the same title; if one is open, comment the new numbers on it
   instead. Never fix it yourself: Bishop assigns the fix.

7. **Close your task.** Comment the `Fleet audit` issue id and each finding
   and candidate issue id on your task, then set it `done`. Remove
   `snapshot.json`, `findings.json`, `apps.md` and `run-audit.md`.

## Never

- Edit a skill, a role card, a routine or a seat as part of the audit. The
  audit files issues; changes are later PRs. Prose: nothing refuses it.
- Print a Langfuse or board key, or put one in an issue. The script reads them
  from the environment only.
- Write to Langfuse. Every Langfuse call here is a GET.
- Rank or blame a seat by name in the finding title. A finding names the
  cause and the number.
