---
name: merge-pr
description: "How Chang works a `Merge <repo>#<n> @ <sha7>` board task: re-check the merge rules with merge-check, merge class A as himself and close done only when Forge says merged; every refusal is blocked, assigned to rico with a NEEDS RICO comment, except a `smythe review:` wait or a kickback, which goes back to Smythe or the originator."
---

# merge-pr

You hold a board task titled `Merge <owner/repo>#<n> @ <sha7>`. Smythe opened
it because both reviewers of the pair approved the head (`review-dispatch` step 5). You do not
trust that: you re-check every rule on the live PR before anything merges.

## Steps

1. Read the PR's full head sha
   (`pr-facts <owner/repo> <n>`, `.head.sha`). If it does not start with
   the task's `<sha7>`, the class is stale (step 3); do not re-check a newer head.
2. Run `merge-check <owner/repo> <n> <sha40>`. It prints
   `{class, mergeable, checks, smythe, jev, reasons}`. The verdict it uses is the
   reviewer pair's (below), or Smythe's own on the board review issue for this
   exact head. On a legacy review issue from before 2026-10-08 with no pair
   tasks, the reviewer Smythe dispatched it to (his
   `Dispatched to <name> (<k> open) per review-dispatch.` line, SOF-8387)
   still counts. A comment by anyone else, on Forge or on the board, is
   ignored. When a verdict
   comment carries an `escalate: <why>` line it is class C
   `smythe review: <why>` until Smythe answers (his verdict, `smythe: approve`,
   or `smythe: kickback: <why>`, class C `kickback: <why>`).

   When the head has reviewer pair tasks, `Review <owner/repo>#<n> @ <sha7>
   (<Name>)` whose description names the full head sha, filed by Smythe or the
   forge-pr plugin (Rico, 2026-10-07 and 2026-10-08: no leads), the pair decides instead of a lead: the newest
   verdict from the Anthropic family (Adams, Kapoor, Giraud) and from the GPT
   family (Czajka, Colter, Kong), counted by the board's author stamp only, never the PR
   author's own seat, both `approve`. A `fix-first` (or `approve-with-fixes`)
   from either is class C `review verdict fix-first`; a family with no verdict
   is class C `pair verdict pending (<family>) on <sha7>`; a reviewer's
   `escalate: <why>` is class C `smythe review: <why>` until Smythe answers.
   Smythe's own verdict on this head, newer than the pair's, still wins, and a
   pair approve still asks Jev merge-go as a lead's did.
   - `stale`: PR merged or closed, or the head moved.
   - `C`: the lead's verdict for this head is `fix-first` (or there is none),
     or one of `factory/prepush`, `factory/pr-review` is not
     `success` on the head (for `rtech/k3s-deploy`, its own CI's
     `factory/k3s-ci / check (pull_request)` and `sop-gate` instead):
     `checks` is `red` (failed) or `pending` (missing or still running). Or
     the PR body fails the backout/test-plan gate (Rico, 2026-10-05,
     sf#1413), with one of these gate reasons:
     `missing backout plan`, `missing test plan`, or
     `big change without a rehearsed backout`. A head with no `factory/*`
     status is checked by the repo's own CI (`checks: repo-ci`): a failing or
     pending status there is `red` or `pending` the same way. A head with no
     status at all is `checks: none`, class C `smythe review: <why>`:
     Smythe decides it, never Rico.
   - `B`: Rico's class, and only: the label `needs-rico` (only Rico applies
     it), or a diff that removes or edits a line carrying a Rico ruling
     (`Rico, 20..` or `, reason `changes a Rico ruling: <file>:<line>`.
    A diff merge-check cannot read is class C `could not read the
     diff for the ruling check`.
   - `A`: everything else: a lead's approve with green checks and a Jev
     `merge-go` GO (p >= 0.5, confident at 0.6), or `smythe: approve`, or a
     `just do it` on the Forge PR by the PR author or rodaddy after a
     kickback. Only class A is `mergeable: true`.
   - `smythe` is `null` unless Smythe decided this head: `approve`,
     `kickback` (with his reason) or `pending`. Jev below the bar or with no
     signal, a `SMYTHE_REPOS` repo (k3s-deploy, whisper) or an
     `escalate: <why>` line in the lead's verdict comment is class C `smythe review: <why>`. A kickback
     goes back to the originator with the reason, never to Rico (step 4).
3. Act on the class:
   - **A and mergeable**: merge as yourself (`forge` reads `FORGE_LOGIN` and
     `FORGEJO_TOKEN` from your run env), bound to the sha:

     ```
     node ~/fleet/forge/forge pr merge <owner/repo> <n> --sha <sha40> --style merge
     ```

     Then re-read the PR. Only when Forge returns `"merged": true` is the task
     done: any P2s listed in the review verdict go into ONE follow-up issue on
     the repo, linking the PR, and you close the task `done` with the merge
     link (and the follow-up link, if any). If the merge call failed or
     `merged` is still false, it is a refusal (below). Do not remove any
     worktree: Paperclip's reaper removes the task worktree when the task is
     done.

     **When `smythe` was `approve` or the class came from a `just do it`**,
     Rico is told after the fact: ONE comment on the PR with `forge-post
     comment`:

     ```
     MERGED WITHOUT YOU: @rico this change merged without you.
     **Changed:** <the PR body's `rule-change:` line, or the PR title>
     **Decided by:** <Smythe's `smythe: approve` comment, or the `just do it` comment> (<board review issue link>)
     **Merged:** <merge commit link>
     **Veto:** say so here and it is reverted; backout: <the PR body's `backout:` line>.
     ```

     Then ONE comment on the board review issue, so the page Rico reads has a
     direct link:

     ```
     TELL RICO: merged <owner/repo>#<n>: <title> <merge commit link>
     ```

     Then post one comment on the board task the PR body's `task:` line names:
     `Rule change merged: <PR link>. Continue.` (the comment wakes its
     assignee). Put the links in your closing comment.
   - **B**: do not merge. Request the board approval exactly as
     `review-dispatch` ("Class B: the board approval") does (`request_board_approval`, payload title
     `Go on <owner/repo>#<n> at <sha7>`, `headSha`, `verdict`, `round`), put the
     approval id on the task, and tell Rico (below).
   - **C with `checks: pending`** and an approving verdict: do not merge. Run
     `merge-check` again after 10 minutes, at most 3 times. Still pending:
     tell Rico (below).
   - **Any other C, or a merge that did not land**: do not merge. Tell Rico
     (below), except a `smythe review:` or kickback reason or a gate
     reason, which go back (step 4).
   - **stale**: the PR is already merged or closed, or its head moved. This is
     the only quiet close: close the task `done` with the `reasons`.
4. **Waiting on Smythe or kicked back** (class C `smythe review: <why>`, or
   `smythe` is `kickback`): do not merge and do not tell Rico. Comment the
   `reasons` on the task. `smythe review:` is Smythe's (`review-dispatch`,
   "Deciding a `smythe review:` PR"): set the task `blocked` with him as
   owner. A kickback goes back to the originator with Smythe's reason: chase
   it there, and merge only when `just do it` makes it class A.
   **Backout/test-plan gate** (class C whose `reasons` include
   `missing backout plan`, `missing test plan` or
   `big change without a rehearsed backout`): not a Tell Rico case. Do not
   merge. Comment the `reasons` on the PR with `forge-post comment` (the
   author must add the section, or rehearse the backout, and re-push), then
   set the task `blocked` with Smythe, who holds the review issue, as owner.
   **Tell Rico** (every other case except a landed merge and stale). On the
   PR, assign `rico` and post ONE comment, then set the board task
   `blocked` with the comment link. Never close a refusal `done`: a `done`
   merge task means the PR is merged.

   ```
   curl -s -X PATCH -H "Authorization: token $FORGEJO_TOKEN" \
     -H "Content-Type: application/json" \
     "$FORGEJO_API_URL/repos/<owner/repo>/issues/<n>" \
     -d '{"assignees":["rico"]}'
   ```

   The comment starts `NEEDS RICO:` followed by the class and every `reasons`
   line from merge-check (or the merge call's error), then the board task
   link. Post it from a quoted heredoc, never a file (a run may write only
   inside its cwd; the run scratch dir under `/tmp` is refused), as ONE
   block in ONE shell call:

   ```
   body=$(cat <<'BODY'
   NEEDS RICO: <class>
   ...
   BODY
   )
   printf '%s' "$body" | PAPERCLIP_RUN_ID=<Run ID> forge-post comment <owner/repo> <n> -
   ```

   Run it dedented: the closing `BODY` must start at column zero.

   Paperclip refuses `blocked` without an owner, so block the task with the
   board as owner and the comment link in the action:

   ```
   curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     -H "Content-Type: application/json" \
     "$PAPERCLIP_API_URL/api/issues/<task id>" \
     -d '{"status":"blocked","unblockDescriptor":{"owner":"board","action":"NEEDS RICO on <owner/repo>#<n>: <comment url>"}}'
   ```

## Never

Close a merge task `done` while Forge says the PR is not merged.
Merge anything merge-check did not call class A on the exact sha. Merge with
Forge's review button, force, or another account's token. Approve or reject a
board approval: that is Rico's (stale ones are cleared by the forge-pr sweep).
