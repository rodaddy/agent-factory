---
name: daily-report
description: "Once a day, post the company's numbers on the day's report board issue: agent-matrix plus per-employee outcomes, cost, cache hit and blocked count, and whether each change the last retro shipped moved its metric. Facts only, no recommendations."
---

# daily-report

The company improves only if someone measures it every day (Rico, 2026-10-03,
sf#1343). This skill produces the numbers; `daily-retro` decides what to
change. Run by the daily routine `Daily report`, which creates the board issue
`Daily report <YYYY-MM-DD>` and assigns it to you.

## Steps

1. Run the matrix with no pipe, so its exit code is real:
   `~/fleet/bin/agent-matrix > report.md; echo "exit $?"`
   (`PAPERCLIP_API_URL`, `PAPERCLIP_API_KEY` and `PAPERCLIP_COMPANY_ID` are
   already in your environment). Exit 1 or 2: set the issue blocked with the
   message and stop.
2. Add, per employee, for the last 24 hours, from the board API
   (`GET $PAPERCLIP_API_URL/api/companies/$PAPERCLIP_COMPANY_ID/heartbeat-runs?limit=1000`,
   filtered to the window):
   - runs ok / failed, and the top failure `errorCode` with its count;
   - tokens in and out, and cost from the run's `usageJson`;
   - cache hit: `cachedInputTokens / inputTokens` where `usageJson` has both,
     else `n/a`.
3. Add the company totals: blocked board issues
   (`GET .../issues?status=blocked&limit=500&offset=N`, counted across pages),
   PRs merged and PRs sent back by `fix-first` in the window.
4. Find yesterday's retro issue (`Daily retro <YYYY-MM-DD of yesterday>`).
   For each change it shipped, read the metric line in its PR body
   (`Metric: <name> <before> -> <target>`), measure that metric now the same
   way, and add a row: PR, metric, before, now, target.
5. Add PR size against review speed (Rico, 2026-10-08: watch that PRs do not
   all grow to the 1200-line bar, and compare one big PR with a stack of small
   ones). Pass one `--repo` for each repo that had a PR merged or sent back in
   step 3, with no pipe, so its exit code is real:
   `~/fleet/bin/pr-review-stats --repo <owner/repo> ... > stats.md; echo "exit $?"`
   It reads the last 14 days, so one day's few PRs still have something to
   compare against. On exit 2 or 3, write `n/a` and the message instead.
6. Post everything as ONE comment on your report issue, in this order: totals,
   the per-employee table, the retro-change table, the PR size tables, then
   the matrix. Set the issue done.

## Never

Recommend, rank, or blame: the report is facts with their numbers. Leave out
an employee because its numbers are bad. Estimate a number you could not
read; write `n/a` and say why.
