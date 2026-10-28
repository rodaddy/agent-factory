---
name: ci-red-check
description: "Work one `Checks not green: <owner/repo>#<n> @ <sha7>` task: return review/verdict reds to the author, read each failed job's log, classify CI failures as own diff, flaky, infra or check wrong, hand off every context, and close with all classes and evidence. Greene (CI Engineer) runs it. Never re-runs, skips or waives a check."
---

# ci-red-check

A required check is red on a pull request head, and Smythe has given
you the task `Checks not green: <owner/repo>#<n> @ <sha7>` (`review-dispatch` step 5).
Separate review verdicts from failed jobs, then send each context to whoever
fixes it. `forge` below is `node ~/fleet/forge/forge`.

## Spec-ready before implementation dispatch

Before creating, assigning, reopening, or handing back implementation or repair
work, follow `delegate-work`, "Spec-ready before implementation dispatch".
Use `spec-ready` and `task-new`; a hold queues one unassigned spec-writing step
instead of sending the work to a seat. Diagnosis and review keep their own paths.

## Steps

1. **Re-read the head.** `forge pr view <owner/repo> <n>`. If the PR is
   closed or merged, or its `head:` sha does not start with `<sha7>`, the task
   is stale: close it with one comment saying so and naming the current head
   (step 6). A new push gets its own review and its own task.
2. **List the failing contexts.** `forge --json status <owner/repo> <sha>`.
   Note every status whose `status` is `failure` or `error`: its `context`
   and its `description`. All green or all pending now: comment that and
   close (step 6); never wait in a loop.
3. **Separate verdict reds, then find each failed job and read its log.**
   - A red `factory/pr-review` (or any review/verdict context) is not a CI
     failure: Greene does not classify it; link the verdict comment on this
     task and hand it back to the PR's author per `review-dispatch` step 5
     ("the PR goes back to its author") and `_DOCS/KICKBACK_SOP.md`,
     "When the company kicks back" (a round-1 `fix-first` is fixed on the
     same branch). Record that handoff for step 6; skip steps 4 and 5 for
     this context.
   - The failing status's `target_url` ends in `.../actions/runs/<N>`: that
     `<N>` is the repo's run number. List runs for the head sha with
     `forge --json api GET "/repos/<owner/repo>/actions/runs?head_sha=<sha>"`
     and select the `.workflow_runs` entry whose `index` or `run_number`
     equals `<N>`; use that entry's `id`, never `.workflow_runs[0].id`
     blindly or the undocumented `run_number` query filter.
     Dispatch runs may have the default branch's sha and only carry the PR
     head in `inputs.head_sha`: if the head-sha list has no match, list runs
     with `forge --json api GET "/repos/<owner/repo>/actions/runs"`, matching
     the same run number client-side (as in `src/reconcile/oom-retry.ts`),
     or read the job from the status's `target_url`.
   - `forge run view <owner/repo> <run-id>` lists the run's jobs. Take the
     failed job's id. Only contexts backed by a failed job go through log
     classification; if no failed job or verdict explains the red, ask Simms
     on this task, set it blocked and stop.
   - `forge run log <owner/repo> <job-id> --tail 200`. Find the first error:
     the failing test name, the command that exited non-zero, or the runner
     message. Keep those lines.
4. **Classify EACH failed-job context.** Pick exactly one class per context,
   not one class for the whole task:
   - **own diff**: the failing test, or the code it exercises, is in the PR's
     diff (`forge pr files <owner/repo> <n>`), and the failure is not seen on
     other heads.
   - **flaky**: the failing test is outside the diff, and the same test is red
     on another head too, or a later run for this same head passed (find
     that run from the status's newer `target_url` as in step 3, or by
     `inputs.head_sha` for a dispatch run, never by the run's sha).
   - **infra**: the log ends in a runner, network, disk, image pull or queue
     fault, or a job was cancelled with no runner. No test ran and failed.
   - **check wrong**: the workflow itself is broken: a bad step, a wrong path,
     a missing tool in the step, a timeout set below a normal run.
   Cannot tell after reading the log: comment the log lines and the question
   on the task for Simms (Git Lead, your manager), who answers it there; set
   the task blocked and stop.
5. **Act on EACH context's class.** Complete every handoff before step 6.
   - **own diff**: comment on the PR for its author with the failing test,
     the log lines and the likely cause (the block below). The fix is the
     author's: if they are an employee, create a separate repair task assigned
     to them, naming the context and linking the PR comment; leave that
     repair task open (`todo`). Keep this classification task until all
     contexts are handed off. Otherwise the PR comment is the handoff.
     Do not fix their code.
   - **flaky**: find and link the existing `Flaky test: <owner/repo>
     <test name>` repair task from Smythe's review issue; `review-dispatch` step 5
     already created it. Follow `fix-flaky-test` on that task. Do not create
     a second repair task. If it is missing, ask Smythe for its link and
     keep this task blocked until the handoff is recorded.
   - **infra**: create a board task for Nagatha titled
     `Infra request: CI <owner/repo> <what failed>`, with the job link, the
     log lines and the run id (`company-conduct`, "Infrastructure is
     Nagatha's"). Never touch a runner, the runner image or a host yourself.
   - **check wrong**: fix the workflow under `.forgejo/workflows/` in its own
     pull request per `open-pr`, with the failing log lines as the evidence.
     A change under `.forgejo/workflows/` is a big change for `merge-check`:
    the body needs a Backout and a Test plan.
6. **Close only when EVERY failing context is handed off.** Post ONE closing
   comment listing each failed-job context, its class, job link, log lines
   and handoff link (PR comment, existing repair task, infra task or workflow
   pull request); for review/verdict reds, list the verdict comment and
   author handoff instead of a CI class or job log. Then set this
   classification task done (`company-conduct`,
   "Finishing a task"). Any unexplained or unassigned context keeps it open
   or blocked; repair tasks stay open until their work is finished.

The own-diff PR comment and its board copy, as ONE block in ONE shell call,
dedented:

```
body=$(cat <<'BODY'
CI red on <sha7>: <context>
Failing: <test file> <test name>
Log (job <job link>):
<the failing log lines>
Likely cause: <one sentence, pointing at the diff line>
BODY
)
paperclipai issue comment <issue-id> --body "$body" --run-id <Run ID>
printf '%s' "$body" | PAPERCLIP_RUN_ID=<Run ID> forge-post comment <owner/repo> <n> -
```

## Never

- Re-run, retry until green, skip, loosen or waive a check. Forge has no
  re-run verb; this is a prose rule.
- Fix the author's own-diff failure, or push to their branch. Prose rule.
- Run the full suite or a full build on this box. Run only the failing test,
  and only after the log did not explain it. Prose rule.
- ssh to a runner or host. bash-guard (`ssh-infra-only`) refuses it.
