---
name: triage-issue
description: "Classify one Forge issue the same way every time (what is asked, type, priority when there is evidence, labels only from the repo own list, spec gaps), publish it on Forge, wait for the author on open questions, and hand an implementable issue to the right employee as a build task."
---

# triage-issue

Classify one Forge issue the same way every time, then move it on. Inputs: a
Forge repo (`<owner/repo>`) and an issue number. Every triage is published on
Forge. An issue never stops at
triage: it waits on its author or it becomes a build task.

## Spec-ready before implementation dispatch

Before creating, assigning, reopening, or handing back implementation or repair
work, follow `delegate-work`, "Spec-ready before implementation dispatch".
Use `spec-ready` and `task-new`; a hold queues one unassigned spec-writing step
instead of sending the work to a seat. Diagnosis and review keep their own paths.

## Steps

1. Read the issue and its comments:
   `curl -fsS -H "Authorization: token $FORGEJO_TOKEN" "$FORGEJO_API_URL/repos/<owner/repo>/issues/<n>"`
   and `.../issues/<n>/comments`. If it is a pull request, stop: this skill is
   for issues. Say so on the board issue and set it `blocked`.
2. Read the labels the repo actually has:
   `curl -fsS -H "Authorization: token $FORGEJO_TOKEN" "$FORGEJO_API_URL/repos/<owner/repo>/labels?limit=100"`.
   You may choose ONLY from that list.
3. Decide, in this order, and write each decision down before the next:
   - **Read**: one sentence saying what the author is asking for.
   - **Type**: exactly one of the repo's type labels (bug, enhancement,
     documentation, question, or the repo's own equivalents).
   - **Priority**: one of the repo's priority labels, only when the issue
     gives evidence for it (an outage, data loss, a blocked user). No evidence
     means no priority label.
   - **Spec gaps**: each thing a person would have to ask the author before
     work could start. None is a valid answer.
4. Refuse these labels always: any workflow-state label (`in-progress`,
   `blocked`, `needs-review`, anything starting `watcher:` or `factory-`), and
   any label not in the list from step 2. Never remove a label.
5. Compose the verdict in exactly this shape. It goes into a quoted heredoc
   in step 6, never into a file:

   ```
   ## Triage of <owner/repo>#<n>

   **Read:** <one sentence>

   **Labels:** <comma-separated, or "none">

   **Spec gaps:**
   - <gap>            (or "none")

   **Why:** <one or two sentences tying the labels to what the issue says>
   ```

6. **Publish.** Apply the labels on Forge
   (`POST $FORGEJO_API_URL/repos/<owner/repo>/issues/<n>/labels` with the label
   ids), then post the verdict once, straight from a quoted heredoc, as ONE
   block in ONE shell call (the quotes on `'VERDICT'` keep backticks and `$`
   as written; `-` makes forge-post read stdin):

   ```
   body=$(cat <<'VERDICT'
   ## Triage of <owner/repo>#<n>
   ...
   VERDICT
   )
   printf '%s' "$body" | PAPERCLIP_RUN_ID=<Run ID> forge-post comment <owner/repo> <n> -
   ```

   Run it dedented: the closing `VERDICT` must start at column zero. Then
   put the comment URL on the board issue. Never write the verdict to a
   file: a run may write only inside its cwd, and the run scratch dir under
   `/tmp` is refused.
7. **Spec gaps: wait on the author.** If the gaps list is not "none", end the
   Forge comment with one direct question per gap, addressed to the author by
   login. Set your board issue `blocked` with the comment
   `waiting on the author: <gaps>`. Do NOT set it done. The hourly board sweep
   (`board-sweep`) sets it back to `todo` when the author replies on Forge;
   then you run again.
8. **Run again after a reply.** Read the author's answers. Re-decide the spec
   gaps with them. Still a gap: post ONE short Forge comment naming only what
   is still open, and block again (step 7). No gaps left: step 9.
9. **Implementable: hand it on.** Create one board task, then set your board
   issue done:
   - title `Build <owner/repo>#<n>: <issue title>`;
   - assignee: Nagatha for infrastructure (hosts, boxes, k3s, DNS, network,
     Proxmox); Bishop (CTO) for everything else (code, tests, CI, docs);
   - description: the issue link, your **Read**, and the author's answers to
     each gap, quoted, so the builder needs nothing else;
   - priority: `high` when the issue has a priority label of p0/p1 or
     priority/0-1, `low` for p3+ or priority/4-5, otherwise `medium`;
   - then `board-link <new task id> <issue url>` so the task carries the
     issue's labels.
   Comment the new task's identifier on your board issue.
10. Finish per `company-conduct`.

## What a good run looks like

The same issue triaged twice gives the same labels and the same shape. One
triage comment, never two. No label the repo does not have. No triage ends
`done` while a question to the author is open, and no implementable issue
ends without a build task.
