---
name: repo-steward
description: "Check every Forge repo's papers the same way every time: run steward-check, hand wikis to Scribe and milestones to Chang, report everything else (description and topics included, with a proposed value) as one Steward issue per repo, and file the result as the steward document on the repo's Project knowledge board issue."
---

# repo-steward

Check the setup of Forge repos, 15 per run. Inputs: either one
`<owner/repo>`, or nothing, which means the next batch of the fleet.

## Never

Move or cut a tag, deploy, or edit deploy config (`.software-factory.yaml`,
`.forgejo/workflows/*`, k3s-deploy, `config/repos.yml`). Never touch branch
protection, repo settings (description and topics included: Forge needs admin
to write them), webhooks, or secrets. Never merge, close, or delete a PR or a
branch. Those are reports, never fixes.

## Steps

1. **Pick the batch.** One repo if the task names one. Otherwise run
   `steward-check --all` and order the repos by the timestamp of their
   `steward` board document, oldest first; a repo with no document goes first.
   Take the first 15. That ordering is the resume point; no other state is kept.
2. **Check.** For each repo:
   `bin/steward-check <owner/repo> > <workdir>/<owner>-<repo>.json`.
   Exit 1 is a harness error: say so on the board issue and move to the next
   repo. Exit 0 with fails is a normal result.
3. **Fix what is yours (`fix: self`).** As your own login, never another's:
   - `wiki-home` or `wiki-pages` fail: open ONE board task for **Scribe**
     ("Wiki for <owner/repo>: Home, Deploy, Roadmap") unless one is open.
   - open issues without a milestone: open ONE board task for **Chang**
     (milestone-engineer) for the repo unless one is open.
4. **Report the rest (`fix: report`).** If any report check failed, find the
   open Forge issue titled `Steward: setup gaps` on that repo. Compose the
   body in a quoted heredoc, never in a file, and post it as ONE block in ONE
   shell call. If the issue exists, replace its body:

   ```
   body=$(cat <<'BODY'
   - **<rule>** (<id>): <evidence>
   BODY
   )
   printf '%s' "$body" | PAPERCLIP_RUN_ID=<Run ID> forge-post issue-edit <owner/repo> <index> -
   ```

   If not, end the same block with
   `title=$(cat <<'TITLE'`, `Steward: setup gaps`, `TITLE`, `)` (four lines)
   and `printf '%s' "$body" | PAPERCLIP_RUN_ID=<Run ID> forge-post issue <owner/repo> "$title" -`
   instead. Run it dedented: the closing `BODY` must start at column zero.
   The body lists each failed check as `- **<rule>** (<id>): <evidence>`.
   For a failed `description` or `topics` check, also list the proposed value
   so an admin can apply it in one call: for `description`, one sentence from
   the README; for `topics`, 1 to 5 lowercase topics from the README. Write
   them as `  - proposed: <value>`, and add this line once to the body: "These
   two are reports because Forge needs admin for both writes (description
   PATCH, topics PUT) and the steward has push, not admin." An admin applies
   them with `PATCH $FORGEJO_API_URL/repos/<owner/repo>` `{"description":"..."}`
   and `PUT $FORGEJO_API_URL/repos/<owner/repo>/topics` `{"topics":[...]}`.
   You never apply them yourself.
   One issue per repo, never two. If nothing failed and the issue is open,
   say so in a comment; do not close it.
5. **File the record.** Find the board issue `Project knowledge: <owner/repo>`;
   create it if missing. Write the JSON from step 2 as its `steward` document:
   `PUT /api/issues/{id}/documents/steward`. Its `checkedAt` is the resume
   timestamp for step 1.
6. **Roll up.** End with one comment on your board task: for each check id,
   how many repos passed, failed, and were n/a; plus what you fixed and which
   tasks and issues you opened or updated.
7. Finish per `company-conduct`.

## What a good run looks like

Fifteen repos checked, each with a fresh `steward` document. A missing
description or topics listed in the repo's gaps issue with a proposed value,
never written. One Scribe task and one Chang task per repo that needs
them, never duplicates. One `Steward: setup gaps` issue per repo with gaps,
updated in place. No tag, deploy file, or setting touched.
