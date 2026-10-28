---
name: fleet-verify
description: "Nagatha's reconcile loop for a fleet-verify finding: host01's hourly deterministic verify posts each open finding to the board as an Infra: alert:fleet-verify:* issue; she diagnoses read-only, runs a rail only when rails-validate resolves the key to an active rail her seat can run and check_first shows what expect says, and turns everything else into a PR or NEEDS RICO; per-surface handling for forge CI, firing alerts and log volume and signatures, and the Sunday weekly trend digest (rtech-infra _DOCS/fleet-verify.md)."
---

# fleet-verify

host01 runs `scripts/fleet-verify/fleet-verify run` every hour (LaunchDaemon,
user `fleet`, code at `/opt/fleet/verify/repo`, state at
`/opt/fleet/verify/state/latest.json`). Detection is the
script's, not yours. Each open finding reaches the board alerts plugin as
`alertname=fleet-verify`, `key=<surface>/<check>/<subject>`; the plugin folds
the findings of one surface into one issue, `Infra: alert:fleet-verify:<surface>`.
Its `Instances:` block lists every finding key of that surface with
its current state (`firing` or `resolved`), and each later plugin comment
carries the updated list. The plugin re-opens the issue when a key fires again,
and closes it only when every key is resolved and nobody touched it (status
still `todo`/`backlog`). You reconcile. Design: rtech-infra `_DOCS/fleet-verify.md`.

Work from `~/src/rtech/rtech-infra` after `git pull --ff-only`.

## Steps

1. **Read the findings.** The newest plugin comment's `Instances:` list (or
   the body's, if there is no comment yet) names each finding key; work every
   `firing` key through the steps below, one at a time. `summary` and
   `evidence` are in the body. On host01, the full row is in
   `latest.json`, printed by
   `/opt/fleet/verify/repo/scripts/fleet-verify/fleet-verify show`.
   Search closed issues for the same key: a finding that keeps coming back
   is a different diagnosis from a new one.
2. **Diagnose, read-only, and write it on the issue.** `infra-health check`,
   `scripts/jev argo`, `scripts/jev logs <app-or-host>`, `scripts/jev alerts`
   (exit 3 = no signal, say so; do not guess), `kubectl get/describe` with your
   read kubeconfig, Prometheus. Name the cause from canon (`gotchas/<domain>.md`,
   `HOSTMAP.md`, the manifests) or say it is not written down. A key under
   `forge/`, `alerts/` or `logs/` has its own handling in "Per surface"
   below: resolve the key in step 3 all the same, and use that handling in
   place of step 3's no-rail branch.
3. **Resolve the key:** `scripts/fleet-verify/rails-validate --resolve <key>`.
   Copy the key from the label; never retype or paraphrase it.
   - **Exit 1 (`NO RAIL`, or a refused value):** no rail. Propose the fix as a
     PR on the owning repo (rtech-infra, or `rtech/k3s-deploy` through
     `infra-request` and its SOP), or `NEEDS RICO:` per `infra-request`
     step 7 with the evidence and what you think should happen.
   - **`"status": "proposed"`:** never run it, whatever it says. Treat as no
     rail and name the rail id and its blocker on the issue.
   - **`"status": "active"` but a `requires` capability your seat lacks:**
     do not run it. Report on the issue: rail id, the missing capability, the
     bound `rail` argv, so Rico or the owning seat can act. You hold a
     capability only when your box manual grants it on this seat; you never
     hold `kube-write`.
   - **Active, requires met:**
     1. Count your receipts on this issue for the current UTC day. At
        `limit_per_day`, stop and report; do not run.
     2. `scripts/jev brief --packet "<rail id> on <key>"` and quote the
        gotchas it returns as `gotchas/<domain>.md:<line>`, or state it
        returned none.
     3. Run `check_first` exactly as the JSON prints it (argv, in order).
        Compare its output with `expect`. No match: do not run the rail;
        post the output and treat the finding as no rail.
     4. Match: run `rail` exactly as printed. Post the receipt on the issue:
        rail id, the argv, exit code, and the last 20 lines of output.
     5. On host01, `scripts/fleet-verify/fleet-verify run --only <check>`; elsewhere, wait for the
        next hourly run. Record on the issue whether the key cleared.
4. **`unverified` findings** (`<surface>/<check>/unverified`: the check could
   not run). Fix the reach problem only by PR to rtech-infra
   `projects/ansible/playbooks/host01-fleet-verify.yml` (credential, tool,
   network). Never fix it by hand on host01. SSH-based checks stay unverified
   until Rico rules on a read path;
   say that and leave it open.
5. **Close or leave open.** Cleared on a fresh run: close with
   `cleared at <time>` and the run time. If you moved the issue out of
   `todo`, the plugin will not close it for you. Not settled: leave it open
   with the reason and what would settle it. One comment per hour at most.

## Per surface

The key is `<surface>/<check>/<subject>`; each check's docstring in
`scripts/fleet-verify/checks/` is the authority for its subjects. Quote the
finding's `summary` and `evidence` on every issue or PR you write; never write
a number the finding did not carry.

- **`forge/forge-ci-duration/ci/slow-job/*` and `ci/slow-baseline/*`**
  (`<owner>/<repo>/<workflow>/<job>`): the repo's CI is what needs fixing,
  not the runner. Keep ONE board issue per repo/workflow/job, titled
  `CI: <owner>/<repo> <workflow>/<job> needs to be fixed`; search before
  creating, and link it from both alert issues when both kinds fire for the
  same job. Body: the repo that needs to be fixed, the p50/p90/n evidence
  (slow-baseline) or the run's duration against its p90 (slow-job), and what
  in the workflow takes the time when the run log shows it. A one-off
  slow-job on a job whose baseline is fine is a comment, not an issue.
- **`forge/forge-ci-duration/ci/queue-wait/<labels>`:** a runner capacity
  note for the infra seat (you): one comment on the alert issue naming the
  label set, its p90 wait, and the runners that carry those labels from
  rtech-infra's forge-runners canon. A capacity change is a PR there, never
  a hand edit on a runner.
- **`forge/forge-ci-duration/ci/dead-queue/*`:** no online runner carries the
  job's `runs-on` labels. List, on the alert issue, every workflow waiting on
  that label set (repo, workflow file, job, labels). The fix is the
  workflow's `runs-on` (a PR or issue on that repo) or a runner that should
  carry the label (a PR in rtech-infra); say which.
- **`alerts/alerts-firing/*`:** classify with `scripts/jev alerts` (from
  `~/src/rtech/rtech-infra`) and quote its verdict for this alertname.
  PAGE or TICKET: diagnose the cause like any other finding. TUNE, or
  `stale: true` in the evidence: open a PR against
  `projects/ansible/templates/alert-rules.yml.j2` changing the rule
  (threshold, `for:`, severity, or removal with the reason). DIGEST or
  REVIEW: write the verdict on the issue and leave it open. PAGE or TICKET
  wins over `stale: true`: `stale` only says the alert has fired for more
  than 24h, and a condition that is still true live (query the alert's
  expression in Prometheus) is a cause to fix, not a rule to tune. Never
  silence an alert in Alertmanager; the rule file is the only place an alert
  changes.
- **`logs/logs-volume/volume/<host>/<unit>`:** name the unit and host and
  the multiple (today's bytes over the 7-day median, from the evidence) on
  the issue, then `scripts/jev logs <host>` for what the unit is writing. A
  fix is the unit's log level or the shipper's filter, by PR.
- **`logs/logs-volume/requests/<ip>`:** identify the client: the evidence
  names the HOSTMAP host when the IP is in it; otherwise look it up in
  `/mnt/share/hostmap.json` and `HOSTMAP.md`. Not there: say the client
  is unknown and give the IP; never guess a host. Name what on that client
  polls Forge, and the fix (a poll interval, a cache) on its owning repo.
- **`logs/logs-signatures/*`: downtime work only.** Act on these only when
  every other open finding in `latest.json` is under `logs/logs-signatures/`
  (all other surfaces green). Then read the top 5 by count. For each, either
  file ONE board issue titled
  `Logs: <host>/<unit>: <normalized signature, short>` (search first) with
  the count and a sample line, or open a PR adding it to
  `scripts/fleet-verify/log-allowlist.yml` in rtech-infra with the reason it
  is harmless. Budget: at most 5 issues plus allowlist PRs in any hour;
  count yours from the last 60 minutes before you start. A signature you
  cannot classify stays on its alert issue with what you read.

## Weekly digest

The routine `Fleet weekly` (Sundays 13:00 UTC, `0 13 * * 0`, timezone `UTC`,
assigned to you, concurrency `coalesce_if_active`) creates the board issue
`Fleet weekly: <ISO week>` (e.g. `Fleet weekly: 2026-W41`). Read-only: it
files nothing but its own issue's report.

1. On host01, read the last 7 days of runs. Each hourly run writes
   `/opt/fleet/verify/state/runs/<YYYY-MM-DDTHHMMSSZ>.json`
   (same shape as `latest.json`: `run`, `only`, `checks[]` with `id` and
   `status`, `findings[]` with `key`, `state`, `severity`, `evidence`).
   Runs with `only` set are partial (`--only` reruns) and are left out.

   ```bash
   S=/opt/fleet/verify/state/runs
   since="$(jq -nr 'now - 7*86400 | strftime("%Y-%m-%dT%H%M%SZ")')"
   ls -1 "$S" | awk -v s="$since.json" '$0 >= s && /\.json$/' | sed "s|^|$S/|" > week.txt
   if [ ! -s week.txt ]; then echo "unverified: no runs in $S since $since"; else
   xargs jq -s '
     map(select(.only == null)) as $r
     | ($r | map(.findings[] | select(.state != "resolved"))) as $open
     | {runs: ($r | length), first: $r[0].run, last: $r[-1].run,
        checks_by_day: ($r | group_by(.run[0:10]) | map({day: .[0].run[0:10],
          status: (map(.checks[].status // "?") | group_by(.) | map({(.[0]): length}) | add)})),
        top_keys: ($open | group_by(.key) | map({key: .[0].key, runs: length})
          | sort_by(-.runs) | .[:10]),
        new: ($r | map(.findings[] | select(.state == "new") | .key) | unique),
        resolved: ($r | map(.findings[] | select(.state == "resolved") | .key) | unique),
        open_at_end: ($r[-1].findings | map(select(.state != "resolved") | .key)),
        slowest_ci_baselines: ($r[-1].findings
          | map(select(.state != "resolved" and (.key | test("/ci/slow-baseline/"))))
          | map({key, p50: ((.evidence | tostring | capture("p50=(?<p>[0-9.]+)s").p) | tonumber)})
          | sort_by(-.p50) | .[:10]),
        noisiest_log_units: ($open | map(select(.key | test("^logs/logs-volume/volume/")))
          | group_by(.key) | map({key: .[0].key, runs: length}) | sort_by(-.runs) | .[:10])}
   ' < week.txt; echo "exit $?"; fi
   ```

   No runs in the window, a jq error, or the state dir not readable from your
   seat: post `unverified: <the reason>` on the issue and stop. Never fill a
   number in from memory or an older digest.
2. Post on the routine's issue, from that JSON only: the window (first and
   last run, run count, against 168 expected); checks by status per day; the
   10 most frequent open finding keys with their run counts; keys new this
   week and keys resolved this week (a key in both came and went); the
   slowest CI baselines with p50; the noisiest log units. Link each key's
   `Infra: alert:fleet-verify:*` issue where one exists.
3. Close the issue. It opens no other issue: a trend that needs work is
   already its own finding, worked under the steps above.

## Never

Run a rail from memory, a paraphrase, or an older resolve. Widen, edit or
append to a bound argv. Run a `proposed` rail. `kubectl` writes, `helm` or
`argocd` outside a rail. Touch a secret or print one in a receipt. Close a
finding you could not settle. Hand-edit host01 or `rails.yml`: adding or
widening a rail is a reviewed PR to `scripts/fleet-verify/rails.yml`.
