---
name: repo-wiki
description: "Write one repo's Forge wiki from what the repo actually says: Home, How-to, Gotchas. Every command cites the file it came from; nothing invented; unknowns marked. Pages go up with wiki-put under your own login."
---

# repo-wiki

Write or refresh the Forge wiki for one repo. Inputs: a Forge repo
(`<owner/repo>`) and the steward board issue for it. When the task names
several repos, do them in order of most open issues first:
`curl -fsS -H "Authorization: token $FORGEJO_TOKEN" "$FORGEJO_API_URL/repos/search?limit=50"`
and sort by `open_issues_count`, highest first.

## Rules

- **Never invent a command.** Every command on a page cites the file and line
  it came from, like `bun run check` (package.json:22). If you cannot find it,
  write `Unknown: <what>` instead. An honest Unknown is a correct page.
- **Read only.** You never change the repo's code, branches, or issues.
- **Your own login.** Pages are written with your own token, never a shared one.

## Steps

1. Check the wiki is on:
   `curl -fsS -H "Authorization: token $FORGEJO_TOKEN" "$FORGEJO_API_URL/repos/<owner/repo>"`
   and read `has_wiki`. If it is `false`, stop: say so on the steward board
   issue ("wiki disabled on `<owner/repo>`; pages not written") and finish.
2. Read the sources, by clone (`git clone --depth 1` into your work
   directory) or through the API (`.../contents/<path>`). Read each that exists:
   `README.md`, `AGENTS.md`, the `_DOCS/` index, `package.json` scripts or
   `pyproject.toml` scripts, `Dockerfile`, `.forgejo/workflows/*`,
   `.software-factory.yaml`. Then the closed bug issues:
   `.../issues?state=closed&type=issues&labels=bug&limit=50`.
3. Write three files in your work directory:
   - `Home.md`: what the repo is, who uses it, where it runs. One short section
     each, with the source of each claim.
   - `How-to.md`: build, test, run locally, deploy. Only the exact commands
     found in the repo, each with its citation. Missing one is
     `Unknown: how to deploy` (or whichever it is).
   - `Gotchas.md`: one line per trap, from the AGENTS.md traps section and from
     closed bug issues (cite `#<n>`), each followed by `Check:` saying what
     catches it.
4. Put each page, one call per page:
   `fleet/skills/repo-wiki/bin/wiki-put <owner/repo> Home Home.md` (then
   `How-to`, then `Gotchas`). It creates a missing page and updates an existing
   one. Exit 0 written; 1 Forge refused; 3 your input or the network. On 1 or
   3, quote its stderr on the board issue and stop.
5. On the steward board issue, post the three page URLs
   (`https://forge.example.internal/<owner/repo>/wiki/<Page>`) and the list of every
   `Unknown:` you wrote. Finish per `company-conduct`.

## What a good run looks like

Run twice on an unchanged repo, the pages come out the same. Every command has
a citation. Nothing on a page that the repo does not say.
