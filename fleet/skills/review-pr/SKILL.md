---
name: review-pr
description: "Review one pull request for real defects and prove each one by running the code. Grades P0, P1, P2 with suggestions kept apart, in one fixed output shape with a verdict line, posted on the board issue and the Forge PR."
---

# review-pr

Review one pull request for real defects, the same way every time. Inputs: a
Forge repo and a pull request number. Every review is published on the PR
(Rico 2026-10-03, sf#1365: shadow mode is gone; a review nobody sees protects
nothing).

You are one of a pair: one reviewer on an Anthropic model and one on a GPT
model. There is no lead: your own verdict is the review of
record for your family, and the PR merges when both of the pair approve the
same head. You comment; the author fixes. You work alone and you do not read
the other reviewer's findings before you post yours.

## Steps

1. `ensure-project <owner/repo>`. Read the pull request
   (`pr-facts <owner/repo> <n>`): its head sha, base, title
   and body. Review in YOUR OWN task worktree, which is your cwd (the task
   carries the repo's project, so the run starts in its own Paperclip worktree
   under `/home/operator/fleet-work/.worktrees/<owner>/<repo>/<branch>`). Never
   edit the project's primary checkout, `~/src/<owner>/<repo>`. Make sure
   `origin` is the repo's HTTPS `clone_url` from Forge
   (`$FORGEJO_API_URL/repos/<owner/repo>`, `.clone_url`), even when the repo's
   own docs name an `ssh://` URL: git over ssh is refused by bash-guard
   (`ssh-infra-only`), and git's credential helper gives HTTPS your own token.
  Then `git fetch origin <base> refs/pull/<n>/head`, where
   `<base>` is the PR's `.base.ref` read above (not always `main`), and
   `git checkout --detach <head-sha>`.
   Never remove the worktree yourself: Paperclip removes it when the task is
   done or cancelled. Two reviews never share a worktree, so you can run more
   than one at once.
   When your task names files, review only those files; read others only to
   understand them, and report findings only in the named files.
2. Read the whole diff against the base: `git diff <base>...<head-sha>`. Read
   every changed file in full where the diff alone does not show the caller or
   the invariant. If the task description carries the `Docs, not reviewed`
   list, read the diff without those paths
   (`git diff <base>...<head-sha> -- . ':(exclude)<path>' ...`) and review only
   the rest. With no such list, review everything. Read the
   PR body's `Blast radius:` line (under `## Merge danger`) and check it
   against the diff: your comment ends with `blast radius: confirmed`, or
   `blast radius: wrong: <why>` when the diff does not match it, beside the
   `verdict:` line. `wrong` counts as fix-first.
   **A PR that changes the guard itself** (bash-guard's `guard-files` list):
   no command may spell a guard path, even a read in your task worktree. Do not
   name the file at all. Diff the whole PR (`git diff <base>...<head-sha>`, no
   path; add `-U100000` to see the whole file) and read the guard's part of
   that output, at the `pr-facts` position your task names. Run the tests
   the same way: their command lines name only test files. Mutation runs
   use the test suite's `BASH_GUARD_UNDER_TEST` hook on a copy you made in
   your task worktree from that diff output, never from the installed guard. That is
   the sanctioned route, not a bypass (SOF-12799); never put the path in a
   variable, glob or script to get past the refusal.
   **A head that only merges main.** When the task description
   carries `Base merge: delta review, not a round.`, or the previous head's
   pair both approved at `<P>`, run `delta-check <your worktree> <P> <head-sha>`
   after `git fetch origin`. `clean`: post `verdict: approve` with
   `**Delta of:** <P7>: a clean merge of main, nothing to review`.
   `resolved`: review only its `files`. `not-a-main-merge`: review normally.
3. Run the tests that cover what changed, not the whole suite: the test files
   in the diff, plus the tests for each changed source file. Record each command
   and its real exit code. Do not pipe it through `tail` or `head`: that
   replaces the exit code. The repo full gate already runs on every push (the
   receipt); running it again here, next to another reviewer doing the same,
   ran the box out of memory on 2026-10-01 and killed every employee.
   A reviewer never applies an infra change: any ansible run is `--check` only
   and never targets the box it runs on. bash-guard refuses any apply without
   `--check` and any local connection (Rico, 2026-10-05,
   sf#1427).
   A task with `check_mode: false` runs for real even under `--check`, so a
   reviewer never runs a playbook against its own box, and reads such tasks
   instead.
4. For each thing you suspect:
   - **Prove it by running the code.** Write the smallest input or test that
     shows the failure, inside your task worktree: never in the run scratch
     dir under `/tmp` (refused) or the project's primary checkout. If a write
     in your worktree is refused, stop and report it; do not write anywhere
     else. A finding you could not
     reproduce is reported as "suspected, not reproduced", never as a defect.
   - **Check the tests prove what they claim.** For a new test, break the code
     it covers in your worktree and confirm the test goes red. A test that
     stays green is a finding.
   - **Flag tests that prove nothing**: a test that
     proves no useful input to output is a P2 finding; its fix is to delete it.
   - **Try to refute yourself** before you write it down. Look for the guard,
     the caller, or the earlier check that already handles it.
5. Grade each finding:
   - **P0**: data loss, a secret exposed, a security boundary broken.
   - **P1**: wrong behavior a user or caller will hit, or a regression against
     the base.
   - **P2**: a real defect on a rare or failure path; a test that proves
     nothing.
   - **Not a defect**: a hardening idea, a style preference, or a wider scope
     than the PR. List these separately under "Suggestions". They never block.
   - **Credentials inside Rico's own infrastructure never get a rotation ask**.
    A LAN address, an internal hostname, or a
     disabled TLS check on an internal host is not a finding. Never recommend
     rotating or revoking anything: rotation happens in bulk, through the
     Vaultwarden process, when Rico schedules it. The no-secrets-in-git floor
     still stands: a live secret value this PR commits to any repo is a P0
     "secret exposed" (Forge repos push-mirror to GitHub), and it is reported
     to Bishop as company-conduct requires. Name the file and line, never the
     value, and ask for the value to be taken out of the change, not rotated.
     "A secret exposed" also covers a secret this PR sends outside the
     infrastructure: a public or mirrored repo, a third-party service, a log
     anyone outside can read.
   - **Only what this PR introduces can block.** A defect that is already on
     the base and that this change neither adds nor makes reachable is a
     follow-up, listed under "Pre-existing", never graded P0/P1 for this PR.
     Prove it is pre-existing by showing it on the base commit.
6. The review has exactly this shape; `post-verdict` (step 7) writes it from
   your facts, never a file:

   ```
   ## Review of <owner/repo>#<n> at <head-sha, 7 chars>

   **Ran:** `<command>` -> exit <code>
   **Checks:** <commands you ran with exit codes> | none run

   ### Findings
   1. **P1 — <title>** — `<file>:<line>`
      <what is wrong, and the input or command that shows it>
      **Fix:** <the smallest change that corrects it>

   ### Suggestions (not defects)
   - <idea>

   **Round:** <N>
   escalate: <why> (only when you cannot decide)
   verdict: approve | fix-first
   blast radius: confirmed | wrong: <why>
   ```

   `fix-first` if there is any P0 or P1. Otherwise `approve`. "No findings" is
   a valid review; do not invent one. Say plainly when you ran nothing; never
   imply a check ran: leave out `ran` and it prints `nothing`.
   When you cannot judge auth, secrets, a destructive migration, deploy
   security, the review rules, or anything your AGENTS.md names, supply the
   optional one-line JSON field `"escalate": "<why>"`. `post-verdict` renders
   `escalate: <why>` immediately before `verdict:`; merge-check holds it for
   Smythe. Supply `"round": <N>` from your task (default 1).
7. Post it with `post-verdict`, the facts as JSON on stdin, in ONE command.
   Never type the body yourself: `post-verdict` checks every field (a finding
   needs `severity`, `title`, `at` as `path:line`, `evidence` and `fix`; every
   value is one line; a P0 or P1 needs `fix-first`), renders the shape above,
   and posts the same text on your board issue and, through `forge-post`, on
   the PR. It prints the Forge URL; put it on the board issue. Exit 2 names
   the field it refused. `--dry-run` prints the body and posts nothing.

   ```
   PAPERCLIP_RUN_ID=<Run ID> post-verdict - <<'JSON'
   {"kind": "review", "repo": "<owner/repo>", "pr": <n>, "sha": "<head-sha40>",
    "board_issue": "<your board issue id>",
    "ran": {"command": "bun test", "exit": 0}, "checks": "none run",
    "findings": [{"severity": "P2", "title": "empty input crashes", "at": "src/a.ts:12",
      "evidence": "parse('') throws", "fix": "return [] on empty input"}],
    "suggestions": [], "round": 1, "verdict": "approve", "blast_radius": "confirmed"}
   JSON
   ```

   Run it dedented: the closing `JSON` must start at column zero.
   Never write the review to a file: a run may write only inside its cwd,
   and the run scratch dir under `/tmp` is refused.
8. Leave your worktree clean (`git status --short` prints nothing; undo any
   mutation you made by restoring the file from the commit, with
   `git checkout <head-sha> -- <file>`). Do not delete the worktree or anything
   in it: the guard blocks deletions, and it is right to. Finish per
   `company-conduct`.

## Never

Merge, push to the PR's branch, approve on Forge's review button, or fix what
you found. The PR's author fixes. You find, prove and comment.
