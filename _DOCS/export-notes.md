# Export notes

This export is PARTIAL. It holds the service (`src/`), its tests, the
migrations, the Actions lane scripts, and the agent-company code under `fleet/`
that the architecture depends on. Everything below was left out, with the
reason.

## Left out of the export

| Path in the private source | Why |
| --- | --- |
| `_reports/`, `_tasks/`, `planning/`, `.prd/`, `k3s-era/`, `specs/` | Session reports, plans and verification specs; thousands of internal host, issue and client references. Not needed to run the service. |
| `_DOCS/` (all but five files) | Operating manuals for one fleet. Kept: `architecture.md`, `model-resolver.md`, `runner-contract.md`, `db-protocol.md`, `schema-ownership.md`. Code comments still name some of the dropped docs. |
| `AGENTS.md`, `.claude/`, `.agents/` | Agent session rules for the private development tree. |
| `.forgejo/`, `.github/` | CI workflows name private runners and deploy targets. The Actions lane scripts they call are kept in `scripts/actions/`. |
| `bin/` | Secret-store fetch scripts and a host deploy script. Replaced by a stub `bin/forgejo-token` that reads `$FORGEJO_TOKEN`. |
| `config/repos.yml` | The live repository list. Use `config/repos.example.yml`. |
| `scripts/done-means/` (all but `lib/` and one probe), other `scripts/` | Verification scripts bound to the private fleet. |
| `fleet/paperclip-patches/`, `fleet/paperclip-migrations/` | Patches against a third-party agent board, applied on private hosts. |
| `fleet/board/` | Seat roster, avatars and workspace policy with account identities. |
| `fleet/agents/` client seat | A seat for a client organisation. |
| Two key fetchers in `fleet/bin/` and the per-seat account creator in `fleet/forge/` | They name secret-store items and create per-seat forge accounts. |
| `fleet/deploy`, `fleet/*.sh` identity and install scripts, `fleet/harness-versions` | Host install and per-seat identity checks. |
| `tests/scripts/ct9000-deploy.test.ts` | Tests the dropped host deploy script. |

## Known residue (judgment, not yet generalised)

- Runner box ids (`vmid 9001`, band `9101-9150`, `src/runner/bands.ts`) are
  disposable runner pool numbers from the original fleet, kept because the
  band logic depends on them. Move them to config before calling this generic.
- Repository names of the original operator (`rodaddy/open-brain`,
  `rtech/rtech-infra`, ...) remain in `config/repos.example.yml` and tests;
  tests assert on them.
- Service and env names keep the old `rodaddy-watcher` /
  `RODADDY_WATCHER_*` prefix.
- The examples in `config/jev/classifiers/issue-type.json`,
  `issue-implementable.json`, `pr-review-depth.json` and the benign examples
  in `lane-input-injection.json` are short synthetic texts that keep the
  original labels and counts. The confidence thresholds were calibrated on the
  original private corpus; recalibrate (`scripts/jev/calibrate.ts`) before
  relying on them.
- Comments and test names still carry private-tracker numbers (`sf#NNN`,
  `#NNN`) and the original operator's name where they sit mid-sentence or in
  string literals; parenthetical references were removed.
- `tests/fixtures/verb/` holds byte-pinned rendered bodies from a real run
  (with their manifest digest), including a placeholder host route.
- Hostname placeholders are `*.example.internal`, except `src/hostedapp/` and
  its tests, which use `*.example.net` because that code rejects public
  hostnames on a private zone.

## Removed tests

These test files tested code or files that are not in this export, so they
were deleted rather than left failing.

| Test file | Reason |
| --- | --- |
| `tests/actions/assert-enrolled.test.ts` | reads `config/repos.yml` (not shipped) |
| `tests/actions/finalize-status-shape.test.ts` | reads `.forgejo/workflows/pr-review.yml` (not shipped) |
| `tests/actions/implement-agent-codex.test.ts` | reads `.forgejo/workflows/implement.yml` (not shipped) |
| `tests/actions/pr-review-chunks-shell.test.ts` | reads `.forgejo/workflows/pr-review.yml` (not shipped) |
| `tests/actions/prepush-trace-close.test.ts` | reads `.forgejo/workflows/prepush.yml` (not shipped) |
| `tests/actions/sop-post-check.test.ts` | reads `.forgejo/workflows/sop-verify.yml` (not shipped) |
| `tests/actions/workflow-shared-constants.test.ts` | scans `.forgejo/workflows/` (not shipped) |
| `tests/done-means/factory-recovery-canary.test.ts` | runs `specs/factory-recovery-canary.verify.sh` (not shipped) |
| `tests/done-means/macos-runs-on.probe.test.ts` | runs `scripts/done-means/macos-runs-on.probe.ts` (not shipped) |
| `tests/done-means/redact-check-rg-exit.test.ts` | runs a `scripts/done-means/` gate that is not shipped |
| `tests/done-means/report-job-gates.test.ts` | runs `scripts/done-means/` gates that are not shipped |
| `tests/done-means/test-fixed-sleeps.test.ts` | runs `scripts/done-means/test-fixed-sleeps.sh` (not shipped) |
| `tests/fleet/agent-capacity-check.test.ts` | runs `fleet/bin/agent-capacity-check` against `fleet/board/` (not shipped) |
| `tests/fleet/apply-agents.test.ts` | runs `fleet/board/apply-agents.sh` (not shipped) |
| `tests/fleet/apply-workspace-policy.test.ts` | runs `fleet/board/apply-workspace-policy.sh` (not shipped) |
| `tests/fleet/bridge-routes-patch.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/company-budget.test.ts` | reads `fleet/paperclip-migrations/` (not shipped) |
| `tests/fleet/costs-page-estimate-patch.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/crew-plugin.test.ts` | reads `fleet/board/crew.json` (not shipped) |
| `tests/fleet/crew.test.ts` | reads `fleet/board/agents.json` (not shipped) |
| `tests/fleet/deploy.test.ts` | runs `fleet/deploy` (not shipped) |
| `tests/fleet/forge-pr-merge-verdict.test.ts` | reads `fleet/board/crew.json` (not shipped) |
| `tests/fleet/forge-pr-pair-intake.test.ts` | reads `fleet/board/agents.json` (not shipped) |
| `tests/fleet/git-credential-helper.test.ts` | reads `fleet/install.sh` (not shipped) |
| `tests/fleet/install-worktrunk.test.ts` | runs `fleet/install-worktrunk.sh` (not shipped) |
| `tests/fleet/install.test.ts` | reads `fleet/harness-versions` (not shipped) |
| `tests/fleet/operation-admission-patch.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/operation-admission-reconciler.test.ts` | needs `fleet/paperclip-migrations/` (not shipped) |
| `tests/fleet/operation-admission-refresh.test.ts` | reads a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/operation-admission-store.test.ts` | reads `fleet/paperclip-migrations/` (not shipped) |
| `tests/fleet/operation-admission-wiring-closure.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/operation-admission-wiring-diagnostic.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/operation-admission-wiring-reentry.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/operation-admission-wiring-refusal.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/operation-admission-wiring-settle.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/operation-producer-schema.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/org-caps-backout.test.ts` | runs `fleet/board/` scripts (not shipped) |
| `tests/fleet/pi-abort-setup-patch.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/pi-process-cancellation-patch.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/pi-seams-probe.test.ts` | runs `scripts/done-means/pi-seams-probe.sh` (not shipped) |
| `tests/fleet/policy-drift.test.ts` | reads `.forgejo/workflows/prepush.yml` (not shipped) |
| `tests/fleet/queue-sort-patch.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/recovery-wake-guard-patch.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/review-dispatch-seats.test.ts` | reads `fleet/board/agents.json` (not shipped) |
| `tests/fleet/review-round-ledger.test.ts` | reads `fleet/paperclip-migrations/` (not shipped) |
| `tests/fleet/skip-workspace-inheritance-patch.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/ssh-env-stdin-patch.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/task-new.test.ts` | reads `.forgejo/ISSUE_TEMPLATE/ticket.md` (not shipped) |
| `tests/fleet/terminal-run-writes-patch.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/fleet/usage-accounting-patch.test.ts` | applies a `fleet/paperclip-patches/` patch (not shipped) |
| `tests/reconcile/forge-runner-scale-real-config.test.ts` | reads `config/repos.yml` (not shipped) |
| `tests/scripts/bootstrap-repo-files.test.ts` | runs `scripts/bootstrap-repo-files.ts` (not shipped) |
| `tests/scripts/bootstrap-repo.test.ts` | runs `scripts/bootstrap-repo.ts` (not shipped) |
| `tests/scripts/check-harvest-binding.test.ts` | runs `scripts/check-harvest-binding.ts` (not shipped) |
| `tests/scripts/check-lane-report.test.ts` | runs `scripts/check-lane-report.ts` (not shipped) |
| `tests/scripts/check-tightenings-budget.test.ts` | runs `scripts/check-tightenings-budget.ts` (not shipped) |
| `tests/scripts/doc-sibling-contradictions.test.ts` | runs a `scripts/done-means/` gate that is not shipped |
| `tests/scripts/pi-sre-signal-floor.test.ts` | runs `scripts/done-means/pi-sre-signal-floor.sh` (not shipped) |
| `tests/scripts/v1-receipt-critical.test.ts` | runs `scripts/done-means/v1-receipt-critical.sh` (not shipped) |
| `tests/scripts/v1-receipt-deploy.test.ts` | runs `scripts/done-means/v1-receipt-deploy.sh` (not shipped) |
| `tests/scripts/v1-receipt-review.test.ts` | runs `scripts/done-means/v1-receipt-review.sh` (not shipped) |
| `tests/scripts/v1-receipt-triage.test.ts` | runs `scripts/done-means/v1-receipt-triage.sh` (not shipped) |
| `tests/specs/verify-assertions.test.ts` | runs `specs/software-factory.verify.sh` (not shipped) |

Single tests removed from files that are otherwise kept, for the same reason:
two in `tests/config/load.test.ts` (load `config/repos.yml`), one in
`tests/scripts/audit-roll.test.ts` (reads the committed `_reports/lane-reports/`),
one in `tests/fleet/pi-check-profiles.test.ts` (reads `fleet/board/agents.json`).

## Test and code fixes after the scrub

- `tests/runner/transport*.test.ts`: slot row names now match their scrubbed
  box ids.
- `tests/jobs/verb-bootstrap.test.ts`: digest and lengths pinned to the scrubbed
  fixture.
- `tests/fleet/alerts-ops-guard.test.ts`, `tests/prepush/body.test.ts`:
  expectations that collided with a replaced hostname or mount path.
- `tests/fleet/review-prepare.test.ts`: scratch root follows the shared test
  temp base.
- `tests/fleet/forge-pr-factoryignore.test.ts`: the no-`ignore` load test skips
  when the temp base has an ancestor `node_modules` that resolves `ignore`.
- `tests/bus/side-channels-wake.test.ts`: timeout covers one empty fetch window.
- `fleet/forge/forge-op-pages.mjs`: the token scope list is inlined; the module
  that defined it is not shipped.
- `scripts/install-hooks.sh`: makes `specs/software-factory.verify.sh`
  executable only if it exists.
- Forge host regexes in `fleet/` use the `forge.example.internal` placeholder.

`bun test` with no `DATABASE_URL` passes in this export.
