---
name: project-knowledge
description: "Keep one standing board issue per repo, 'Project knowledge: <owner/repo>', carrying two agent-authored documents, gotchas and conventions, seeded from the repo's own sources. Review and triage read them first."
---

# project-knowledge

Keep the knowledge documents for one repo current. Input: a Forge repo
(`<owner/repo>`).

## The standing issue

One board issue per repo, titled exactly `Project knowledge: <owner/repo>`.
Find it before you make it; there is never a second one. It carries two
documents, written by you (agent-authored, so they show in Artifacts):

- `gotchas`: traps that burned someone. One line each, then `Check:` saying
  what catches it. Grouped under short headings.
- `conventions`: how a change is made and proven in this repo. One bullet per
  rule, each ending with its source, like `(AGENTS.md:133-134)` or
  `(package.json:22)`.

## Steps

1. Find the standing issue on the board. If it does not exist, create it with
   that exact title and attach empty `gotchas` and `conventions` documents.
2. Read the same sources `repo-wiki` reads: `README.md`, `AGENTS.md`, the
   `_DOCS/` index, `package.json`/`pyproject.toml` scripts, `Dockerfile`,
   `.forgejo/workflows/*`, `.software-factory.yaml`, and closed bug issues.
3. Update each document in place. Add what is new, fix what moved (line
   numbers drift), remove what the repo no longer says. Never invent a rule or
   a command; if a source is missing, write `Unknown: <what>`.
4. Comment on the standing issue with what changed, in one or two lines.
   Finish per `company-conduct`.

## Who reads them

Every review and triage skill (`review-pr`, `review-dispatch`, `triage-issue`)
reads `gotchas` and `conventions` for the repo FIRST, before the diff or the
issue. If the standing issue does not exist yet, they say so and carry on.

## What a good run looks like

Each line has a source. Run twice on an unchanged repo, nothing changes.
