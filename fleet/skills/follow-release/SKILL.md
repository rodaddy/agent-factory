---
name: follow-release
description: "Follow one version tag from push to running pod and report each step with its time and link, naming the first step that is stuck. When the rollout fails, open a revert-bump pull request on rtech/k3s-deploy. Never push a tag, merge, or deploy."
---

# follow-release

Follow one version tag from push to running pod and report each step with its
time and link. You report. You never push a tag, merge, or deploy.

Inputs: a Forge repo and a tag (for example `v1.4.2`).

## Steps

1. Tag: `$FORGEJO_API_URL/repos/<owner/repo>/tags/<tag>`. Record the commit
   and the time. No such tag: say so and set the board issue `blocked`.
2. Build: the Actions runs for that commit
   (`$FORGEJO_API_URL/repos/<owner/repo>/actions/tasks?limit=20`). Record the
   run, its status, and its link.
3. Manifest bump: open and merged pull requests on `rtech/k3s-deploy` whose
   title or body names the app and the tag
   (`$FORGEJO_API_URL/repos/rtech/k3s-deploy/pulls?state=all&limit=20`). Record
   the PR, its state, and its merge commit.
4. Events, when Forge alone does not show a step: the stream `FORGE_EVENTS` on
   `$NATS_URL` (nkey `~/.config/fleet/nats.nkey`), subjects
   `forge.events.<owner>.<repo>.<event>`.
5. Anything you cannot see from Forge or the event stream (Argo sync, pod
   readiness) is reported as "not visible from here", never guessed.
6. Compose the receipt in exactly this shape. It goes into a quoted heredoc
   in step 7, never into a file:

   ```
   ## Release of <owner/repo> <tag>

   | Step | When (UTC) | State | Link |
   |---|---|---|---|
   | tag pushed | ... | ... | ... |
   | image build | ... | ... | ... |
   | manifest bump PR | ... | ... | ... |
   | bump merged | ... | ... | ... |
   | rollout | ... | not visible from here | |

   **Stuck at:** <the first step that is not done, or "nothing">
   ```

7. Post it straight from a quoted heredoc, as ONE block in ONE shell call.
   The quotes on `'RECEIPT'` keep backticks and `$` in the text as written:

   ```
   body=$(cat <<'RECEIPT'
   ## Release of <owner/repo> <tag>
   ...
   RECEIPT
   )
   paperclipai issue comment <board issue id> --run-id <Run ID> --body "$body"
   printf '%s' "$body" | PAPERCLIP_RUN_ID=<Run ID> forge-post comment <owner/repo> <n> -
   ```

   Run it dedented: the closing `RECEIPT` must start at column zero. The
   board comment always goes. Keep the `forge-post` line only when the task
   names a Forge issue or pull request; with no place named, drop it and post
   on the board issue only. Never write the receipt to a file: a run may
   write only inside its cwd, and the run scratch dir under `/tmp` is
   refused. Then step 8, then finish per `company-conduct`.

8. **Only this app's failed rollout gets a revert-bump pull request.**
   After the bump PR merged, read its sop-verify receipt:
   `$FORGEJO_API_URL/repos/rtech/k3s-deploy/issues/<bump PR number>/comments`.
   Match the receipt's `pr:` merge SHA and this app's `argo:` line. Open a
   revert only when this app failed to become Synced+Healthy at that merge
   revision (`argo:` exit 1). A combined commit status of `failure` alone
   never proves a rollout failure: another app or a fleet-wide post_check
   can make it red.
   - This app is Synced+Healthy and `post:` reports a post-check failure:
     comment with the receipt and failing check, hand it to Nagatha (the
     owner already named for `k3s-review`), and stop without opening a revert.
     A fleet-wide public-URL failure can belong to an unrelated app.
   - Missing app-specific evidence, an Argo harness error (exit 3), or
     "not visible from here": report the uncertainty and stop without a
     revert. A failed build deployed nothing; report it and stop.
   - An open `[sop-verify] revert` pull request for that merge already
     exists: link it in your board comment and stop. Never open a second
     (prose).
   - Otherwise follow `open-pr` on `rtech/k3s-deploy`, branch
     `revert/<issue>-<app>-<stage>-v<X.Y.Z>`. The change is
     `git revert -m 1 <merge sha>` when the merge commit has two parents,
     `git revert <merge sha>` when it has one
     (`git rev-list --parents -n 1 <merge sha>`). The pull request body
     carries, each on its own line, `sop: k3s.change.rollback` and
     `pre: <link to your receipt comment>`, plus the SOP's inputs: the merge
     sha, the image the bump replaced (the old value), and the app's health
     URL as its functional floor.
   - Put the pull request on your board issue and stop. Assign nothing
     further and never merge it (prose): Nagatha's `k3s-review` decides it.
