# Architecture

```text
Forgejo webhook                 15-minute sweep
(POST /hooks/forgejo, HMAC)     (authoritative backstop)
      |                               |
      +---------------+---------------+
                      v
Forgejo read API ---> single Bun process -----> existing local PostgreSQL
 (untrusted data)       |       |                 (state and job ledger)
                        |       +----> status server :8787
                        |              /, /status.json, /healthz, /metrics
                        |              (0.0.0.0 bind when the webhook secret is
                        |               set; non-webhook routes refuse
                        |               off-loopback peers)
                        v
                 runner-box MCP
                 fixed templates only
                        |
                        v
                 bounded result -----> Forgejo write API
```

The `runner-box MCP` hop in the diagram is the retiring path;
lanes
now run on Forgejo Actions (see "Lane runtime" below).

A webhook delivery only wakes the same single-flight pass the sweep runs; the
payload is never the input, and the sweep stays authoritative when a delivery
is lost. The GitHub provider is dormant (map D8).

The Bun process is the policy boundary. It validates configured repositories,
selects a fixed job template, records state before and after dispatch, and caps
and sanitizes results before any forge write. Repository content and runner
output are untrusted. Credentials remain outside the repository and are scoped
to the minimum required Forgejo, PostgreSQL, and MCP operations.

This paragraph describes the retiring runner-box path.
Runner boxes are an execution boundary: jobs are isolated, never arbitrary
repository-provided commands, and never live infrastructure changes. Most lanes
are report-only. The implement lane is the one that produces code, and it
PROPOSES a change rather than applying one — the change is verified at the
ingest boundary before it can become a branch, and no lane may merge or
force-push. For `rtech-infra`, only static validation is permitted. The status
page is read-only and loopback-only by peer check; it shares the service rather
than adding another stack.

## Lane runtime: Forgejo Actions

Lanes run as Forgejo Actions workflows under `.forgejo/workflows/`:
`factory-smoke.yml`, `hosted-app-render.yml`, `implement.yml`,
`infra-static.yml`, `issue-triage.yml`, `main-full-suite.yml`, `pr-review.yml`, `prepush.yml`,
`site-publish.yml`, `sop-gate.yml`, `sop-verify.yml`, and `verb.yml`. Jobs
declare `runs-on: forgejo-mvp`, the docker `node:20-bookworm` label, served by
runners forge-runner-9104 and forge-runner-9105 at capacity 1 each. State:
RUNNING.

Under D4 (`_DOCS/decisions.md`), runner boxes retire lane by lane under
sf#830. The
prepush receipt (`prepush validate`, job `rw-repo-validate-*`) still runs on a
box until sf#828
moves it to Actions. State: MERGED design, RUNNING box path.

Which tests run where.
A PR is checked with `bun run check:affected`: the full `check` chain (format,
lint, typecheck, every `check:*`, secrets), but only the tests the change can
reach, as `scripts/affected-tests.ts` selects them from `git diff <fork
point>...HEAD`: changed tests, tests importing a changed module directly or
transitively, and tests naming a changed file's basename. A toolchain or
shared-harness path (`package.json`, lockfile, `tsconfig*`, `tests/support/`,
`src/db/`, `drizzle/`, `specs/`, the selector itself, `prepush.yml`), more
than 200 changed files, or any doubt runs the whole suite, sharded four ways.
`prepush.yml` runs it against the PR's fork point, so a docs-only or
unrelated change no longer waits about five minutes for 5,500 tests. The safety
net is `main-full-suite.yml`: every push to main runs the unchanged
`bun run check` (suite sharded four ways) plus `verify.sh` with no credential,
and Forgejo's own job status on the main commit is the verdict, so a selection
miss shows as a red main commit. The box receipt sandbox already exports `SF_AFFECTED_BASE`, but
its `PREPUSH_COMMANDS` still names `bun run check`: the installed pre-push hook
pins that tuple, and changing the hook blocks every checkout whose tracked
hook differs until it merges main, so that flip is scheduled separately.
State: WRITTEN, not deployed.

A lane that runs an agent or repository content splits into two jobs: an
untrusted job with OIDC off that holds at most the engine key and never a forge
token, and a trusted job that is the only writer (status, comment, push, PR).
Source: `AGENTS.md`, "Engineering decisions and safety".

## Responsibility split

Three systems, each owning exactly one thing, so no two can disagree about
state:

- **k-board** (`fleet.tasks`, `rodaddy/fleet-board`) — the WORK-STATE authority.
  Status, claim, assignment, and the event log. The watcher reads and writes it
  through the k-board HTTP API and never touches `fleet.tasks` directly:
  `legacy/k-board/server.py` is the sole mutation authority, and it enforces CAS
  by database trigger.
- **Forgejo** (`forge.example.internal`) — CODE, review, and merge. Branches, issues,
  pull requests. Its labels and milestones are API-driven and remain useful as
  forge-side signals; its kanban board is not usable, because Forgejo 16.0.1
  exposes zero project/board endpoints.
- **The watcher** — the POLICY boundary between them. It decides what may be
  dispatched, verifies what comes back, and is the only component that writes to
  both sides.

A tracker is never modelled as a code host. That is why `openChangeProposal` is
optional on `ForgeClient`: a provider that cannot host a branch simply omits it,
rather than pretending to satisfy the contract.

## Stranded commit statuses

`src/reconcile/stale-pending.ts` is the single owner of stranded factory statuses.
Once per cycle it reads every watched sha (recent `forge_runs` plus open PR heads;
the fixed status repos of sop-gate, sop-verify, site-publish and hosted-app-render
are watched by name: their open PR heads and newest 30 commits on main)
and posts `error` over any factory context whose newest status is still `pending`
after its run ended. Jobs are matched to the run by URL path, because the lane
posts an absolute run URL while Forgejo's job statuses carry a relative
`/<owner>/<repo>/actions/runs/<N>/jobs/<k>`. A run with job statuses on the sha
has ended when all of them are terminal. A run with NO job statuses on the sha
(a foreign-repo lane, whose jobs report on the host repo's commit) falls back to
age: it is swept once older than `stale_pending_minutes` (default 120, room for
two 30 min engine attempts plus queue). Such a run still working past the
threshold is swept to `error`, and its later verdict overwrites that `error`;
the false `error` is visible on the PR in between. Do not add per-workflow
finalize jobs for this; a lane's own steps post its verdict, this pass owns the rest.
