---
name: delegate-work
description: "How a lead hands work to a report and verifies what comes back: who does what, the shape of a complete task, two reviewers working blind at the same time, and checking the result before counting it."
---

# delegate-work

How a lead hands work to a report and checks what comes back. For the CTO.
Reviews do not go through here: `review-dispatch` files one Sol reviewer and
one Sonnet reviewer, and the author fixes.

## Spec-ready before implementation dispatch

Before creating, assigning, reopening, or handing back an implement/work task,
run `~/fleet/bin/spec-ready --issue <full Forge issue URL> --queue-spec`.
Exit 0 admits work. Exit 1 holds it: the checker posts one comment per source
body naming gaps and queues one unassigned `Write spec` task in backlog. Exit 3
is a harness failure; stop without dispatch. Never pick a seat by hand to get
around a hold. The source issue needs populated `Files to read`, `Files to
change` (or `Files to read/change`), `Acceptance` with fenced shell commands and
expected outcomes, and `Non-goals`. A published Jev `issue-implementable`
`NEEDS_SPEC` verdict or label holds even when those sections exist.

Write implementation tickets with those same spec fields, the source URL, and
the nine `task-new` ticket sections. Create them through
`~/fleet/bin/task-new --file <ticket.md> --assignee <id> --project <projectId>`;
do not use direct `paperclipai issue create` for implementation. Route work with
`~/fleet/bin/task-route --skill <skill> --issue <full Forge issue URL>`.
Review, merge, triage, diagnosis/report, and spec-writing tasks retain their
own paths. Only the single spec-writing step may use higher effort to settle
the missing specification; it must rerun the gate before handing on work.

## Who does what

Resolve ids every time; never hardcode one:

```
paperclipai company list --json                 # the company named Software Factory
paperclipai agent list -C <companyId> --json    # match on name
```

| Kind of work | Goes to | Skill they follow |
|---|---|---|
| Classify a Forge issue | Triage | `triage-issue` |
| Review a pull request | Reviewer, and the second reviewer when there is one | `review-pr` |
| Follow a tag to a running pod | Release | `follow-release` |
| Write or fix code, open a pull request | you (CTO) | `open-pr` |

## Steps

1. `ensure-project <owner/repo>` for the repo the work is on, and file the
   board issue under that project, review tasks included. The run starts in
   its own Paperclip worktree for the task.
2. Write the task so the report needs nothing else. It states, in this order:
   the repo and the number; what to produce (it is published on Forge; there is no shadow mode); what
   must not be touched; what done looks like; and a `backout:` line saying
   how to undo the work the task asks for (The operator, 2026-10-05, sf#1413: every
   board task carries one). One task, one deliverable.
3. Pick the report with `~/fleet/bin/task-route --skill <the skill from the
   Who does what table>` (`fleet/bin/task-route`; call it by that full path,
   it is not on PATH and the bare name exits 127). Add `--needs-opus` only when
   the task says it needs Opus, and `--exclude <author>` for a review (a
   single reviewer is one such call, either family). It prints one JSON line;
   its `agentId` is the `--assignee-agent-id` below. It picks the cheapest
   qualified seat, then the least loaded.
   `fleet/bin/seat-load` does the board reads behind it: each live agent's
   status, model and open-issue count, one JSON line per agent. Exit 1
   means no seat holds the skill: say so, do not pick by hand. Create the task
   assigned to that report:

   ```
   ~/fleet/bin/task-new --file <ticket.md> --title "<verb> <owner/repo>#<n>" \
     --assignee <id> --project <projectId>
   ```

   The report links the Forge item to its own task when it starts
   (`board-link`, in `company-conduct`); the board refuses that write from
   anyone but the task's assignee, so put the full Forge URL in the
   description.
4. Two reviewers on one pull request get two separate issues, created one
   after the other without waiting, so they work at the same time and blind to
   each other. Pick the pair with two calls, one per model family, never one
   unconstrained call twice:

   ```
   ~/fleet/bin/task-route --skill review-pr --family anthropic --exclude <author>
   ~/fleet/bin/task-route --skill review-pr --family gpt --exclude <author> --exclude <first reviewer>
   ```

   `<first reviewer>` is the `name` the first call printed. Either call exits
   1 with `task-route: no seat holds review-pr in family <family>` (or
   `task-route: no seat holds review-pr: all paused`) when no seat of that
   family is free: stop and comment `no eligible <family> reviewer` on the
   task. Never take a same-family seat instead and never pick by hand. The
   author's own family needs no extra exclude; the pair is always one
   Anthropic and one OpenAI reviewer whatever the author ran, and the author
   is out by `--exclude <author>`.
5. Wait on the issue's status, not on a timer you invent:
   `paperclipai issue get <id> --json` until it is `done` or `blocked`.
6. **Verify before you count it.** Read the report's closing comment and open
   every link in it. A comment that says "posted" with no URL is not done.
   Check the author Forge recorded is the report's own login.
7. A report that is `blocked` or wrong gets a SMALLER task with the gap
   named. Never the same task again, and never a bigger one.

## Never

Do a report's work yourself to save time and then say the report did it.

A repaired issue with a `NEEDS_SPEC` verdict still holds: rerun triage to publish a newer `READY` advisory and clear any `NEEDS_SPEC` label before retrying implementation. The gate never invokes Jev.
