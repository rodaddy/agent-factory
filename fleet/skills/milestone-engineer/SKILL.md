---
name: milestone-engineer
description: "Turn one Forge repo's open issues into milestones and a wayfinder map: snapshot, group, create milestones, assign, wire blocking, render the Roadmap map issue, mirror it to the wiki and the project-knowledge board document. One repo per run."
---

# milestone-engineer

Give one Forge repo (`<owner/repo>`) a plan you can see: milestones in order,
every open issue in one, blocking wired natively, and one `wayfinder:map`
issue `Roadmap: <repo>` whose checkbox rows track it. One repo per run.

**Which repo next:** the one with the most open issues and no map yet. Current
order: rtech/rtech-whisper-ios, rtech/rtech-whisper, rtech/rtech-consulting,
rodaddy/open-brain, client/client-ingest, acme/acme-ai, then down the
census.

The map shape is the canonical wayfinder map
(`_ob/skills/plan/workflows/wayfinder.md`): Destination, phase headings with
completion state, a checkbox row per issue, Not yet specified, Out of scope.
Do not invent another shape; `bin/wayfinder-render` produces it.

## Steps

1. **Snapshot.** `bin/milestone-snapshot <owner/repo> > snapshot.json` in your
   work directory. It reads milestones, every open issue (all pages), and
   dependencies where the API has them. Token from `FORGEJO_TOKEN`, header
   only. Issues with no milestone are under `unassigned`.
2. **Group the unassigned issues** (your judgment, by these rules, written
   down before any write):
   - An epic's children go to the epic's milestone. Read parent links in the
     epic body ("Children", task-list rows) and `#n` references.
   - Then shared labels, then shared title prefixes (`[v1 P2]`, `ios:`).
   - Never make a milestone for one issue. A milestone has a goal and a
     done-when line a person can check.
   - Prefer adding to an existing milestone over creating one.
   - Anything that fits nowhere is a **leftover**: list it, do not force it.
     Leftovers render under "Not yet specified".
   Write the plan as `plan.md`: milestone, goal, done-when, issue numbers,
   and why each group belongs together.
3. **Create milestones** you planned and do not have:
   `POST $FORGEJO_API_URL/repos/<owner/repo>/milestones` with `title` and
   `description` (goal + done-when), as your own login. Never delete or
   rename an existing milestone.
4. **Assign issues:** `PATCH .../issues/<n>` with `{"milestone": <id>}`. Send
   only `milestone`. Never change a title, never close or reopen an issue.
5. **Blocking:** where the plan says A blocks B and the snapshot had
   `dependenciesAvailable: true`, `POST .../issues/<B>/dependencies` with
   `{"owner", "repo", "index": A}`. Skip edges that already exist. If the API
   lacks dependencies, say so in the report and skip.
6. **Render.** Re-run the snapshot, add `goal`/`doneWhen` from `plan.md`, and
   pipe it to `bin/wayfinder-render > map.md`.
7. **Map issue.** Find the open issue titled `Roadmap: <owner/repo>` labelled
   `wayfinder:map`. Present: `PATCH` its body with `map.md`. Absent: create it
   with that title, body, and label (create the label only if the repo lacks
   it).
8. **Mirror** the same bytes, never hand-edited:
   - Forge wiki page `Roadmap`: `PATCH .../wiki/page/Roadmap`, or
     `POST .../wiki/new` when missing (`title`, `content_base64`, `message`).
   - The `roadmap` document on the board issue `Project knowledge: <repo>`.
9. Report on your board issue: milestones created, issues assigned, edges
   set, leftovers, the map issue URL, the wiki URL. Finish per
   `company-conduct`.

## Never

Close, reopen, or retitle an issue. Delete a milestone. Hand-edit the map
instead of re-rendering. Work two repos in one run. Put a token in argv or a
URL.

## What a good run looks like

Every open issue is in a milestone or listed as a leftover. Rendering an
unchanged repo twice gives identical bytes. The map issue, wiki page, and
board document say the same thing.
