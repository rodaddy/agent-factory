# How agent-factory was built

agent-factory is a partial export of a private service (internally
`software-factory`). Its public history is a single commit, so this account
comes from the private source repository's git log (2,542 commits on main
from 2026-07-19 to the export on 2026-10-13), its merged pull requests and
issues, and the docs and tests kept in this export (`_DOCS/`, `tests/`,
`config/jev/`). Issue numbers below refer to the private tracker.

## The problem

AI coding sessions produce more pull requests than one person can review.
The bottleneck moved from writing code to deciding what may land. The first
version, written on 2026-07-19, was a "watcher": one process that read a set
of repositories, reconciled their state every 15 minutes, and sent fixed
validation jobs to disposable runner boxes. It grew into a service where a
small company of AI agent seats reviews pull requests, triages issues and
lands code, while scripts and gates, not the agents, decide what is allowed.

## Timeline

| Dates | Phase | What changed |
|---|---|---|
| 2026-07-19 to 07-24 | Watcher | Bootstrap, PostgreSQL schema and migration runner, config validation, a GitHub read client with incremental cursors, the 15-minute reconciliation loop, a status page, runner-box dispatch with fixed job templates, bounded result publishing, and exact-SHA pre-push validation. Pilots on four real repositories. Forgejo support added on 07-23. |
| 2026-07-28 to 08-04 | The implement lane | A code-producing lane with a result schema and a trust boundary for ingesting changes, wired end to end (verify, push, propose) and enabled for one infrastructure repository behind a label. Job transitions guarded by owning attempt, pushes bound to the result that completed the job. |
| August 2026 | Observability and the event bus | An agentless runtime for fixed-command lanes, a raw event stream persisted at ingest, a durable bus consumer for runner results, and traced logging on every exported function, closed module by module. |
| Late August to September 2026 | Forgejo Actions | Pull-request review and issue triage moved from runner boxes to Forgejo Actions workflows; the runner-box band was retired. Landing moved to Forgejo end to end. A deploy rail: a version tag drives the first environment, a movable tag the rest, with no agent in the deploy path. Hosted-app validation and enrolment. |
| Late September 2026 | Decision models | Jev classifiers stored as data with a calibration script, starting with a lane-input injection classifier; large diffs split across parallel review calls; an adversarial second pass inside the review lane. |
| October 2026 | The agent company | Agent seats on a Paperclip board with roles, avatars and per-seat forge accounts; a reviewer pair per round; merge rules by repository tier; daily board sweep, report and retro skills; an audit seat; a cost router that picks the cheapest qualified, least-loaded seat. |

## Key design decisions

- **The agent produces, a script judges, a gate enforces.** Runners execute
  only allowlisted job templates. They never choose a command from
  repository content and never touch live infrastructure.
- **The sweep is authoritative.** A webhook only wakes the same single-flight
  pass the 15-minute sweep runs; its payload is never the input, so a lost
  delivery costs latency, not correctness (`_DOCS/architecture.md`).
- **Repository content is untrusted.** Early fixes closed dependency-install
  network access for untrusted candidates before the sandbox and sealed
  credentials out of error messages.
- **Exact-SHA receipts.** Validation results bind to one commit, and receipts
  were made deterministic so the same commit yields the same receipt.
- **Classifiers for judgment calls, calibrated before they gate.** Issue
  type, implementability, review depth, model route and prompt-injection
  checks are Jev classifiers defined as data in `config/jev/classifiers/`,
  with thresholds calibrated on a labelled corpus. Review findings from fix
  rounds are harvested as new labels.
- **Ship big changes as small, reversible slices.** The history shows long
  numbered stacks ("part 1a of 5") and backouts rehearsed before landing.

## How AI was used to build and check it

The service was built mostly by AI coding agents (Claude and Codex models)
directed by one operator, and from October it was also reviewed by its own
agent seats. Review runs in rounds: a faster reviewer pair first and a
senior pair second, with a round limit that warns rather than stops, and an
adversarial pass inside the lane. Merge decisions moved from agents to code over time: a
merge-check refuses a PR with no backout or test plan, and a Jev "merge-go"
model gates a lead's approval, with human overrides recorded as precedents.
A random 1-in-5 audit re-checks accepted reports as a backstop, never as a
gate. A standing report tracks each seat's speed, queue, failure rate and
quality.

## Testing

- This export carries 356 test files with about 5,400 test cases (Bun's
  test runner), covering the database, forge clients, reconciliation,
  admission, gates, hooks, the fleet tools and the Jev client.
- CI ran only the tests affected by a change on pull requests and the full
  suite on main (`scripts/affected-tests.ts`, `scripts/test-shard.ts`).
- "Done-means" scripts turn acceptance claims into executable checks with a
  fixed exit-code grammar; one probe and its library are kept in
  `scripts/done-means/`.

## What did not work

- **Runner boxes for every lane.** The original design ran review and
  validation on a band of disposable boxes. Actions workflows proved simpler
  to operate; the band was retired in August and the pre-push validate and
  wait commands were removed in October.
- **A review council.** A multi-seat council ladder for rule changes was
  added on 2026-10-03 and removed on 2026-10-06. Escalation became one named
  step and the approval gate became a calibrated model.
- **Clock-based review.** Reviews first started on a ten-minute timer; they
  now start when a head's checks settle, and newer heads retire older
  reviews.
- **A Kubernetes-era plan** was charted and audited in August, then dropped
  from this export as private planning.
- About 640 of the 2,542 commits are fixes. Many came from running the
  service against real repositories: stale jobs, dispatch starvation,
  unbounded database waits.

## Current state

Experimental and specific to one operator's fleet. `_DOCS/export-notes.md`
lists what was left out and the known residue (runner pool ids, original
repository names in tests, old service prefixes). Read it before adapting
the code.
