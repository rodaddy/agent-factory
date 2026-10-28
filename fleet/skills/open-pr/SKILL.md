---
name: open-pr
description: "Change code in a Forge repo and propose it as a pull request: a branch named for the work, the failing evidence first, the smallest fix, the repo gate, a real commit, and forge to open it. Never merge."
---

# open-pr

Change code in a Forge repo and propose it as a pull request. Inputs: a Forge
repo and what the change must do.

## Steps

1. `ensure-project <owner/repo>`.
   Read that repo's `AGENTS.md` first; its rules override this skill where they
   are stricter.
2. Start clean in your task worktree (cwd), never in the project checkout:
   follow `company-conduct`, "Changing code", to check the working directory
   and branch, rename the task branch to `<type>/<issue>-<slug>` if needed,
   or cut a lane branch from the task's named target when another run owns
   that branch. Never commit on the default branch.
3. Prove the problem before you fix it. For a behavior change, write the test
   or the command that fails now, run it, and keep the failing output.
4. Make the smallest change that corrects it, at the place that owns the
   behavior. No cleanup, renames, or refactors the task did not ask for.
5. Run the repo's own gate (its `AGENTS.md` names it; in software-factory it
   is `bun run check`). Run it with no pipe so the exit code is real. A red
   gate is fixed before you go on, not explained.
6. For every new test: break the code it covers, see it go red, restore.
7. Commit with a real message: a subject in the repo's style, then what
   changed and why. Stage files by name, never `git add -A`. No co-author
   line, no tool credit. The message's last line is required and is exactly
   `Agent: paperclip · <model> · <FORGE_LOGIN>`, where `<model>` is the board
   model id and `<FORGE_LOGIN>` is your session's `FORGE_LOGIN` value.
   bash-guard refuses a commit without that line, and refuses any commit when
   `FORGE_LOGIN` is unset. This line is the required identity record, not the
   tool credit this step forbids. The Paperclip install's own `paperclip`
   skill asks for a `Co-Authored-By: Paperclip` line; never write it here
   (`company-conduct`, "Changing code").
8. Push the branch: `git push -u origin <branch>`. Your credential is your own
   login; if the push is refused, report the refusal, do not look for another
   credential.
9. Compose the pull request body in a quoted heredoc, never in a file: what
   it does, the evidence (the failing output from step 3, the passing gate
   from step 5), what it does not do, and the issue it belongs to as a link. The body MUST also carry these
   two sections, exactly in this shape:

   ```
   ## Backout
   <exactly how to undo it: the revert, the config flip or the restore, and what to check afterwards>
   rehearsed: <link to where the backout was executed once>   (big changes only)

   ## Test plan
   <what was run, what proves it works, how to verify it after merge or deploy>
   spin-up: <the first real test after spin-up>   (brand-new things only, instead of a passing run)
   ```

   The test plan names real tests that passed; the only exception is a
   brand-new thing that must be spun up first, which says so on a `spin-up:`
   line. A big change (live infra, data, deploys, credentials, a shared gate,
   anything with a blast radius beyond one repo) has executed its backout
   once and links the result on `rehearsed:`; a small change needs only the
   written backout ("revert and reinstall the last version" is enough). A PR
   without both sections is refused: `merge-check` returns class C
   (`missing backout plan` / `missing test plan` /
   `big change without a rehearsed backout`) and the reviewer pair posts
   `fix-first` with `**P1 — no backout/test plan**`.

   **Is it big? Decide before you open, by merge-check's own floor**
   (2026-10-06: 29 of 33 PRs sent back for this P1 were big
   changes with no `rehearsed:` link). It is big when the repo is
   `rtech/k3s-deploy` or `rtech/rtech-whisper*`, when any changed path
   matches `auth|secret|credential|token` or `deploy/`, `k8s/`, `manifests/`,
   `.forgejo/workflows/`, or when it is `rtech/rtech-infra` and any changed
   file is not `.md`. List the paths with `git diff --name-only origin/<default>...HEAD`.
   Big, with no rehearsal yet: rehearse the backout first (a disposable
   branch, a staging slot or a disposable box; on infra, ask Nagatha, per
   `company-conduct`) and put the link on `rehearsed:`. If it cannot be
   rehearsed before review, open the PR with a `WIP: ` title prefix. A
   draft gets no review task, so it uses up no review round. Drop the prefix
   when the `rehearsed:` link is in the body. A link to a dry run is not a
   rehearsal: the backout must have been executed.

   Open it with `forge`, the same command the Development sessions
   use. It acts as you (`FORGE_LOGIN` + `FORGEJO_TOKEN` from your run env;
   never pass `--as` or `--elevated`) and refuses a PR below the bar before
   it opens: the first line is the signature, then non-empty `## Summary`,
   `## Evidence`, `## Merge danger` (`one-way door` or `two-way door`, and a
   line starting `Blast radius:`), `## Backout`, `## Test plan` (with a
   command in backticks), a link to the issue (`/issues/<n>`), and a diff
   of at most 400 changed lines. Print the skeleton, signature included,
   from the worktree:
   `node ~/fleet/forge/forge pr body --issue <issue url> --seat "$FORGE_LOGIN" --model <board model id>`.
   Fill it in, then open it from the worktree as ONE block in ONE shell
   call (`/dev/stdin` makes it read the heredoc):

   ```
   title=$(cat <<'TITLE'
   <title>
   TITLE
   )
   body=$(cat <<'BODY'
   **agent:** paperclip · model <id> · seat <FORGE_LOGIN> · <YYYY-MM-DD>
   ## Summary
   ...
   BODY
   )
   printf '%s' "$body" | node ~/fleet/forge/forge pr create --repo <owner/repo> --head <branch> --base <default> --title "$title" --body-file /dev/stdin
   ```

   A refusal prints one missing item per line and opens nothing: fix the
   body and run it again. Run it dedented: the closing `BODY` must start at
   column zero, and a variable does not survive into the next shell call;
   `printf '%s'` sends a lost `$body` as zero bytes. If the body quotes a
   heredoc that ends in `BODY`, pick another delimiter; a line reading `BODY`
   ends yours early. A run may write only inside its cwd, and the run
   scratch dir under `/tmp` is refused.

10. Put the pull request on the board issue, then finish per `company-conduct`:

    ```
    PAPERCLIP_RUN_ID=<Run ID> board-link <issue-id> <pull-request-url> kind:fix
    ```

## Never

Force-push, push to someone else's branch, merge, or mark your own pull
request as reviewed. Open a pull request without both the `## Backout` and
`## Test plan` sections. Review belongs to the reviewers and the go belongs to
whoever asked.
