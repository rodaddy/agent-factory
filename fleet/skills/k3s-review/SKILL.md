---
name: k3s-review
description: "How Nagatha decides a pull request on rtech/k3s-deploy: match its sop: line to exactly one rtech-infra SOP, confirm the diff stays inside that SOP and sop-gate is green on the head, judge whether it would break k3s, then merge it and link the lane's receipt, or send it to Rico with NEEDS RICO."
---

# k3s-review

You hold a board task for a pull request on `rtech/k3s-deploy`. Rico does not
review k3s changes; you do. You merge what is valid, viable and safe, and send
up only what would break k3s or that no procedure covers.

**Only `rtech/k3s-deploy`.** The SOPs, `sop-gate`, `sop-verify` and the branch
protection this skill relies on exist on that one repo
(`forgejo-native-rail.md` section 5.1). A task that names a pull request on
any other repo is not covered: do not decide it, do not comment on it. Set
your board task `blocked` with the board as owner (the `curl` in step 6) and
the action `k3s-review covers rtech/k3s-deploy only: <pull request url>`.

The rules come from rtech-infra, not from you:
`rtech/rtech-infra/_DOCS/forgejo-native-rail.md` sections 3 to 5 and 7, and
the SOPs in `rtech/rtech-infra/_DOCS/sops/k3s/` (`index.json` is the index).
Read them over the Forge API (`/repos/rtech/rtech-infra/contents/...`).

## Steps

0. **Be current:** `infra-request` step 0 (fast-forward both checkouts, read
   the SOP in full).
1. **Pin the head.** Read the PR (`pr-facts rtech/k3s-deploy <n>`) and
   keep its full head sha and its `totals.changed_files` count. Every check below is
   on that sha. If the head moves while you work, start again.
2. **Match the SOP.** The PR body must carry exactly one
   `sop: k3s.<x>.<y>` line and a `pre:` receipt line. Resolve the id in
   `index.json`. No line, an id that does not exist, or a change that two
   SOPs could both claim: not viable (step 6).
3. **Stay inside it.**
   - **List every file.** `/pulls/<n>/files?limit=50&page=<p>`, from page 1
     until a page comes back with fewer than 50. One request returns at most
     50 and 30 by default, so a single call is not the list. Take `filename`
     and `previous_filename` of each. The number of distinct `filename`
     values must equal the PR's `changed_files`; if it does not, you have not
     seen the whole change: not viable.
   - **Never, whatever the SOP says:** anything under secrets, RBAC, the
     `sop-gate` app, or Argo's own config: not viable.
   - **One target.** The SOP's `files` entries that start `k3s-deploy:` carry
     placeholders (`<app>`, `<site>`, `<host>`, `<companion>`). Each stands
     for one path segment, and the whole PR must fit one value of it. Two
     apps in one PR is two changes: not viable.
   - **Every file, old name and new, must be one of these three:**
     1. a path the SOP declares in `files` (its `k3s-deploy:` entries);
     2. a path the SOP's own body names for this change: a `k3s-deploy:` row
        of `## Where it lives` for the same target, or a path that
        `## What this changes`, `## Preconditions` or `## Change` tells the
        author to edit (for example `manifests/apps/ops/content/` in
        `k3s.site.update-content`);
     3. a file of the same target (`apps/<app>.yaml` or under
        `manifests/apps/<app>/`) where every added and removed line in
        `/pulls/<n>.diff` is a `#` comment. That is the provenance header the
        deploy lane re-renders on every tag; it changes no object.
   - Anything else is not viable, even on a green gate. In the step 6 comment
     name each such file as `SOP gap: <sop id> does not name <path>`, so the
     answer can be a change to the SOP in rtech-infra rather than a one-off.

   Why this rule: rtech-infra does not define `files` as a complete list
   (`_DOCS/sops/k3s/_TEMPLATE.md` only requires the key) and `sop-gate` does
   not check paths (its six checks, `forgejo-native-rail.md` section 5.2), so
   real, green changes touch paths `files` leaves out. The SOP's own text is
   the only source for what else is in scope. You never add a path on your
   own judgment. An SOP gap is yours to close: open the rtech-infra pull
   request that names the path (`company-conduct`, "Changing a rule"), say so
   in the step 6 bounce with its link, and decide this PR again once it
   has merged.
4. **Gate green.** `/repos/rtech/k3s-deploy/commits/<sha>/status`: context
   `sop-gate` must be `success`. `pending`: check again in 10 minutes, at
   most 3 times. `failure` or `error`, or still pending: step 6 with the
   `target_url`. A green gate proves shape only, never truth; the next step
   is yours.
5. **Judge.** Read the diff against the SOP's sections. Is the `pre:` receipt
   a real probe result for this change? Would this change break anything
   already running: a hostname, port or route another app uses, a removed
   resource, an image tag that does not exist, a namespace or selector
   change? If you are not sure it is safe, it is not safe: step 6.
6. **Fixable by the author** (no `sop:` line, a missing input, a file outside
   the SOP, a red gate check, a size that does not fit): do not merge. Bounce
   it back on the PR exactly as `infra-request` step 6 says: what is wrong,
   how to make it valid, the corrected request, the author mentioned. A new
   push starts again at step 0.
   **Would break k3s, or needs what you cannot do:** do not merge. On the PR
   assign `rico` (Rico's
   own login, and the one that watches this repo; `rodaddy` is an
   organization and cannot be assigned):

   ```
   curl -s -o /dev/null -w '%{http_code}\n' -X PATCH \
     -H "Authorization: token $FORGEJO_TOKEN_RTECH" \
     -H "Content-Type: application/json" \
     "$FORGEJO_API_URL/repos/rtech/k3s-deploy/issues/<n>" \
     -d '{"assignees":["rico"]}'
   ```

   Anything outside `2xx` means he was not assigned: say so in the comment
   and go on, do not try another login. Post ONE comment starting `NEEDS RICO:`
   with what you found (the SOP id or its absence, the files, the gate
   result, and the risk in one paragraph). Set your board task `blocked` with
   the board as owner:

   ```
   curl -s -X PATCH -H "Authorization: Bearer $PAPERCLIP_API_KEY" \
     -H "Content-Type: application/json" \
     "$PAPERCLIP_API_URL/api/issues/<task id>" \
     -d '{"status":"blocked","unblockDescriptor":{"owner":"board","action":"NEEDS RICO on <owner/repo>#<n>: <comment url>"}}'
   ```

7. **Valid, viable and safe:** merge as yourself, bound to the head:

   ```
   curl -s -X POST -H "Authorization: token $FORGEJO_TOKEN_RTECH" \
     -H "Content-Type: application/json" \
     "$FORGEJO_API_URL/repos/rtech/k3s-deploy/pulls/<n>/merge" \
     -d '{"Do":"merge","head_commit_id":"<sha40>"}'
   ```

   Re-read the PR; only `"merged": true` counts. Otherwise step 6.
8. **After the merge.** Wait for `sop-verify` on the merge sha (check every 5
   minutes, at most 30 minutes). `success`: the `sop-verify` lane has posted
   the receipt on the PR itself. Find it in `/issues/<n>/comments`: one
   comment carrying the four lines the SOP's `## Receipt` section fixes,
   `pre:`, `pr:`, `argo:` and `post:`, with the merge sha on the `pr:` line.
   Do not post a receipt of your own: the `argo:` line is the lane's
   observation of the cluster, and you have none. Close your task `done` with
   the merge link and that comment's link. `success` with no such comment, or
   one missing a line or naming another sha: step 6.
   `failure` (the job opens a revert PR, never merged automatically), or no
   `sop-verify` at all after 30 minutes: step 6, naming the merge sha and the
   revert PR if there is one.

## Never

- Run `kubectl`, `helm` or `argocd` against the cluster, or change anything
  outside a pull request. Argo self-heals and prunes; a pull request is the
  only way in.
- Edit an SOP, `index.json` or the `sop-gate` scripts except by your own
  rtech-infra pull request the decision ladder decides (`company-conduct`,
  "Changing a rule"). Edit branch protection or a secret: a PR that needs one of those
  is Rico's (step 6).
- Merge a change no SOP covers, merge on a red or missing gate, or merge a
  head you did not check.
- Decide a pull request on any repo but `rtech/k3s-deploy`, or widen what an
  SOP covers because the gate was green.
- Close a task `done` while the PR is unmerged or `sop-verify` has not
  passed.
