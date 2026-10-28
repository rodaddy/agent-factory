---
name: infra-health
description: "Nagatha's hourly check of every Proxmox node and the k3s cluster from the central Prometheus, and of every failed or timed-out employee run on the board, read-only: the infra-health script judges, she reports clean hours in one line and turns each finding into one board issue, a PR through an SOP, or NEEDS OPERATOR, and routes each failed-run cause before the operator sees it (SOF-3946)."
---

# infra-health

The routine "Infra health: Proxmox and k3s" wakes you every hour. You run the
script, you do not eyeball dashboards, and you change nothing outside a PR.
Findings from host01's fleet-verify arrive as their own `Infra: alert:fleet-verify:*` issues: work them with the `fleet-verify` skill, not here.

## Steps

1. Run `infra-health check` (Prometheus at `$PROMETHEUS_URL`, read-only).
   Exit 1 means Prometheus could not be read: that is itself a finding,
   `prometheus-unreachable`, crit.
   Then read the failed runs. On a bridged seat (host01; SOF-12351), run
   `infra-health runs --feed SOF-12407`. It prints the `runs` JSON that
   Simms' hourly `board-sweep` publishes on [SOF-12407](/SOF/issues/SOF-12407),
   plus a `source` field. When its `checkedAt` matches your last `runs since`
   line, it is the same window: say so and route nothing again. On a
   host-side seat that can read heartbeat runs directly, run
   `infra-health runs --since <checkedAt>` instead. `<checkedAt>` is the time
   on your last `runs since` line on the routine's issue. With no line yet,
   leave `--since` off and it reads the last hour. Route its `causes` per
   "Failed employee runs" below, before step 2. Exit 1 means the failed runs
   could not be read: the feed is missing or more than 120 min old, or the
   board refused. That exit is itself a finding, `board-runs-unreadable`,
   warn, with the script's one stderr line as its evidence.
   Then refresh the inventory of what runs where: from
   `~/src/rtech/rtech-infra`, after `git pull --ff-only`, run
   `scripts/whats-running build`. Exit 3 (every source failed) is a
   finding, `inventory-unbuilt`, warn; a single source FAILED is not.
2. `ok: true`: first close each open issue of yours titled `Infra: <key>`
   whose key comes from `infra-health check`, with `cleared at <time>` (no check
   finding is present, so every check key is gone). `ok: true` says nothing
   about failed runs: it never closes `Infra: runs:<cause>` or
   `Infra: board-runs-unreadable`, which open and close only on the `runs`
   result, per "Failed employee runs" below. Then
   post on the routine's issue ONE line,
   `<time> clean: <pveUp>/<pveTotal> PVE up, <k3s.ready>/<k3s.total> k3s Ready, <n> Argo apps Synced+Healthy`,
   followed by the `runs` JSON's `line` verbatim, and close your task.
   Nothing else.
   Take every count from the script's JSON; never write a count the script did not print.
3. Each finding has a stable `key`. Keep ONE board issue per key, titled
   `Infra: <key>`, assigned to you; search before creating. A key of the form
   `alert:<name>:<where>` may already sit in the alerts plugin's folded issue,
   titled `Infra: alert:<name>:<group>`: search the `Infra: alert:<name>:`
   prefix and, if an open one lists `<where>` under `Instances:`, comment there
   instead of creating; the prefix alone can match another group.
   On a folded issue, Gone is a `<where> cleared at <time>` comment only: the
   plugin closes it when every instance is resolved. Still present:
   comment with this hour's evidence on the existing issue. Gone: close it with
   `cleared at <time>`. New: create it with the `what`, the `evidence` PromQL,
   and your reading of the cause from canon (`gotchas/<domain>.md`, `HOSTMAP.md`, the
   app's manifests).
4. Decide each open finding:
   - **Fix it yourself when a power covers it**. Each power is a
     script with its own allowlist; call it, never improvise around it:
     - **Fleet box disk** (`pve-disk:node05:/px05_zfs_disk/subvol-105-disk-0`,
       sf-fleet-01, a fleet host): a CT disk filling, handled as the host fix below.
       Reviewers work and reproduce in their task worktree (cwd); review
       clones are no longer made. Paperclip manages task worktree removal.
       Never run `fleet-housekeep`: it removes `scratch*`/`mut*`/`probe*`
       folders without checking for local work (SOF-6398).
     - **Host fixes** (a CT disk filling, a stuck exporter or log shipper, a
       CT that needs more cores or memory): the matching row of your box
       manual's REQUEST -> RAIL table, `--check --diff` first, then for real,
       then `infra-health check` again; post before and after on the
       finding's issue, and the desired-state PR within the hour.
   - **Expected and written down** (a known CronJob that fails by design, a
     node marked as maintenance in canon): say where it is written, close it.
   - **Fixable through an SOP** (an image tag, a config, a resource request):
     run `infra-request` from step 0 on your own request and open the PR.
   - **Anything no rail covers** (a PVE node down, a node NotReady): diagnose
     with `scripts/jev`, write the missing rail by PR (box manual "When a rail
     is missing"), and report on the finding's issue; `NEEDS OPERATOR:` per
     `infra-request` step 7, with
     the evidence and what you think should happen. One notice per key, not
     one per hour.
5. Report the run on the routine's issue: counts, the keys opened, updated and
   closed, links, and the `runs` JSON's `line` verbatim.

## Failed employee runs (SOF-3946)

The operator should see "handled" on the routine's issue before he sees red on the
board. `infra-health runs` reads every heartbeat run that failed or timed out
after `--since`, groups them by cause, and names each cause's `route`. The
script decides the cause; you act on the route:

- **`count`** (`continuation-task-changed`: a queued continuation whose task
  was cancelled or reassigned before it started, as in the 2026-10-04 18:10Z
  sweep). Counted in the line, nothing else. Never escalated.
- **`nagatha`** (`stream-drop` for Bifrost or proxy stream drops, `ssh-mount`,
  `paperclip-server` for Paperclip server or database errors,
  `process-lost`). Yours, the same hour: fix it through your box manual's
  rails when a rail covers it, otherwise keep ONE board issue per cause titled
  `Infra: runs:<cause>`, assigned to you, with the `errors`, the `agents` and
  the `samples` run ids; search before creating, comment each hour it is still
  present, close it with `cleared at <time>` the first run it is absent.
- **`bishop`** (`harness` for adapter, model or skill errors, `run-timeout`,
  `unclassified` for an error no rule matches). Keep ONE board task per cause
  titled `Harness: failed runs <cause>`, assigned to Bishop, with the
  `errors`, the `agents` and the `samples` run ids; search before creating,
  comment each hour it is still present. An `unclassified` cause also gets
  your PR adding the rule it needs to `RUN_RULES` in the script, once you can
  name it.

`Infra: board-runs-unreadable` closes with `cleared at <time>` on the first
`runs` that exits 0.

`truncated: true` means the board returned a full page, so failures may be
missing: the counts are a lower bound. Say so in the line (the script does).
The board caps a page at 1000 and the script refuses `--limit` above it, so
never retry with a bigger page. Never write a count the script did not print.

## Thresholds

The script's, not yours: PVE memory available < 10% crit, disk free < 10%
warn / < 5% crit, load per core > 1.5 warn; k3s requests > 90% of allocatable
warn (requests of Pending, Running and Unknown pods only: a finished pod
holds no node); pods Pending/Failed/Unknown warn; CrashLoopBackOff, ImagePullBackOff,
ErrImagePull, CreateContainerConfigError crit; PVC not Bound warn; Argo app not
Synced+Healthy warn; any scrape target down warn. If a threshold is wrong, say
so on the board; do not work around it.

## Fit

`infra-health fit --cpu <m> --memory <MiB> --replicas <n>` answers "can the
cluster take this, and where", from live requests vs allocatable with 10%
headroom kept. `infra-request` step 4 uses it for every new workload.

## Already running?

The operator, 2026-10-05: before anyone builds something, it is checked
against what already runs. When an `Ask:` issue (or anyone) asks "is anything
already running that does X?", answer from the inventory, never from memory:

```
scripts/whats-running search <word> [<word> ...]
```

Search the plain words for X and their near names (`slack approval notify`).
Answer with what exists and where (kind, name, place, status, source), the
inventory's `built` time, and every `NOT SEEN` source: a miss is proof of
absence only for what was seen. Exit 3 means no signal: run
`scripts/whats-running build`, then search again. The inventory sees what
runs, not what a codebase can do; when a hit is a stack whose purpose its
name does not say, read its README or compose file before you answer.

## Never

`kubectl`/`helm`/`argocd` writes. Any host change outside your box manual's
rails. Deleting data or a box. Silencing an alert. One issue per finding per hour.
