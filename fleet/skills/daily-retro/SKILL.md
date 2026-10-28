---
name: daily-retro
description: "Once a day, read the day's report, keep or revert each change the last retro shipped by whether its metric moved, then ship 1 to 3 new changes (a skill, a rule, a routine, a model or effort) as PRs, each naming the metric it should move."
---

# daily-retro

The self-improving loop: the report measures, the
retro changes one small thing at a time and proves it worked. Run by the
daily routine `Daily retro`, which creates the board issue
`Daily retro <YYYY-MM-DD>` and assigns it to you after the report is done.

## Steps

1. Read today's report issue (`Daily report <YYYY-MM-DD>`): its comment holds
   the totals, the per-employee table and the retro-change table. No report
   comment yet: set your issue blocked on it and stop.
2. **Keep or revert.** For each row in the retro-change table:
   - the metric reached its target or moved toward it: keep; say so on your
     issue;
   - it did not move, or moved the wrong way: open a revert PR per `open-pr`
     titled `revert: <original title> (metric did not move)`, with the
     before, now and target numbers in the body.
   A merged change is judged once, the day after it merged.
3. **Pick 1 to 3 changes**, never more. Each must:
   - target a cause the report shows with a number (a failure `errorCode`
     with its count, a cost per finished task, a blocked count, a kicked-back
     PR count);
   - change the employee, not their output: a skill, a rule in
     `company-conduct`, a routine, or a model or effort setting;
   - name one metric it should move, measured the same way the report does.
   A mistake one employee repeats (the same kind twice in a week) becomes a
   lesson in `fleet/agents/<key>/LESSONS.md`: two lists, keep
   doing and stop doing, one dated line each with the link to the task or PR
   that taught it, at most 20 entries. Prune entries that have not recurred
   in two weeks and merge duplicates. A mistake several employees make is a
   skill or rule change instead, not one lesson each.
4. Ship each change as its own PR per `open-pr`. The PR body carries the line
   `Metric: <name> <before> -> <target>` on its own line, plus the report
   numbers that justify it. A PR with no metric line is not a retro change:
   do not open it.
5. Comment on your retro issue: the keep/revert decisions with numbers, and
   each new PR with its metric line. Set the issue done.

## Never

Ship more than 3 changes in one day. Change something no number in the
report points at. Merge your own PR: the normal review and merge rules apply.
Fix an employee's work product by hand instead of changing what they are
taught.
