#!/usr/bin/env bash
# Deterministic k3s verb — RENDER AND RETURN ONLY (sf#301).
# The box holds no forge credential; rails eval, branch push, and the
# proposal are watcher-owned. Nothing below contacts a forge.
set -euo pipefail

verb=newapp
repository=rodaddy/rtech-infra
item_number=795
app=hello
dispatch_sha=0605d25a3dc37a901e65365cf15ba74e82bffc8577995e3b559fe2cd4088f0f7
k3s_base_sha=9c1e951a53008664a85656cd47c5dbe4ea2a6c1c
engine_src=/mnt/share/checkouts/rtech-infra
k3s_src=/mnt/share/checkouts/k3s-deploy
manifest_sha256=0605d25a3dc37a901e65365cf15ba74e82bffc8577995e3b559fe2cd4088f0f7

# The share path is RECONSTRUCTED, never inherited: the wrapper's $SHARE is
# not exported, so this child process does not have it. RUNNER_JOB_ID is
# inherited, and the host directory comes from the hostname COMMAND — never
# a $HOSTNAME expansion, which a live agent twice expanded to a guess (#125).
share_root="${SF_SHARE_ROOT:-/mnt/share}"
work_root="${SF_WORK_ROOT:-/work}"

# exit 0 inside the trap is DELIBERATE: the wrapper refuses a non-zero status
# before the result is read, so a non-zero exit here would discard the very
# error result that must reach the watcher.
result_written=0
on_exit() {
  if [ "$result_written" = 0 ]; then
    mkdir -p "${work_root}/out"
    cat > "${work_root}/out/.watcher-result.json.tmp" <<JSON
{
  "result_version": 2,
  "repository": "${repository}",
  "job_type": "${verb}",
  "item_number": ${item_number},
  "sha": "${dispatch_sha}",
  "status": "error",
  "checks": [
    {"name": "verb preamble", "status": "error", "summary": "verb body failed before its result was written"}
  ],
  "findings": []
}
JSON
    mv -f "${work_root}/out/.watcher-result.json.tmp" "${work_root}/out/watcher-result.json"
    exit 0
  fi
}
trap on_exit EXIT

host="$(hostname)"
out_dir="${share_root}/runners/jobs/${RUNNER_JOB_ID}/${host}"
mkdir -p "$out_dir"

# --- the rails manifest, as DATA -------------------------------------------
# A QUOTED heredoc: no parameter expansion, no command substitution, no
# arithmetic. Manifest bytes cannot reach the shell. Written to a file and
# integrity-bound before render work; nothing on-box consumes its semantics.
manifest_file="${work_root}/rails-manifest.yaml"
cat > "$manifest_file" <<'SF_RAILS_MANIFEST_EOF'
# FACTORY RAILS MANIFEST — the k3s CI/CD rails as machine-readable constraints.
#
# STATUS: WRITTEN (this file). Every rail it DESCRIBES carries its own state tag
# in the `state:` field of its entry, sourced from the ledger row or done-means
# check named in `source:`. A rail's state here is a claim about the rail, not
# about this file.
#
# ---------------------------------------------------------------------------
# WHAT THIS IS FOR
# ---------------------------------------------------------------------------
#
# rtech-infra#754: the software factory (CT101 `rodaddy-watcher`) must operate
# these rails from its JOB DEFINITIONS, not from prose it is trusted to have
# read. A deterministic machine operator has no discipline; whatever rule is not
# encoded in its jobs does not exist for it.
#
# This file is that encoding. It is the single machine-readable source the
# factory's render/validate jobs consume before a PR is opened. Each `rails:`
# entry answers four questions and nothing else:
#
#   endpoint      WHERE the mutation lands (repo, API, declared file)
#   mutation      HOW it is allowed to land — the ONE sanctioned mechanism
#   verification  WHAT signal proves it landed (a live object's own answer)
#   forbidden     WHAT paths must never be taken, each with its failure mode
#
# The prose that EXPLAINS each rail stays in _DOCS/. This file is deliberately
# thin: it carries the checkable facts and points at the document that owns the
# reasoning. Duplicating the explanation here would create a second source that
# drifts against the first.
#
# ---------------------------------------------------------------------------
# HOW A CONSUMER READS IT
# ---------------------------------------------------------------------------
#
# `scripts/done-means/factory-rails.sh` validates this file's shape and proves
# every `source:` reference resolves to a real path or ledger row in THIS repo.
# That is a staleness guard, not a deployment check: a rail described here whose
# source document has been deleted or renamed goes RED, so a fact restated in
# this manifest cannot decay silently while still reading as authoritative.
#
# The factory copy is checked against HEAD by `factory_copy:` below — the
# manifest_sha256 clause. #754 clause 4: staleness is COMPUTED, not assumed.
#
# ---------------------------------------------------------------------------
# WHAT THIS FILE IS NOT
# ---------------------------------------------------------------------------
#
# It is NOT a deployment description and NOT an inventory. It does not say what
# is deployed, only what constrains a deployment. It carries no secret values
# and no credentials — only the NAMES of the secrets a rail requires, per the
# fleet rule that a key never enters git.
#
# It also does not encode every GOTCHAS.md entry. Clause 3 of #754 requires the
# un-encodable ones be NAMED so the gap is visible; they are, at the end, under
# `not_encoded:`. An entry there is an admission, not an omission.

manifest_version: 1
generated_for: rodaddy/rtech-infra#754
owning_repo: rodaddy/rtech-infra

# ---------------------------------------------------------------------------
# THE RAILS
# ---------------------------------------------------------------------------

rails:

  # -------------------------------------------------------------------------
  - id: k3s-deploy-gitops
    title: GitOps is the only deploy path into the cluster
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §6; _DOCS/k3s-interface.md; ledger rows 12, 81
    endpoint:
      forge: http://10.0.20.58:3000
      human_url: https://forge.example.internal
      repo: rtech/k3s-deploy
      branch: main
      authored_in: gitops/k3s-deploy/
      argo_watches: apps/
    mutation:
      mechanism: forgejo-pr-merge-api
      # Row 148 (2026-08-14): the routing fix landed in k3s-deploy PR #45 "via
      # the Forgejo PR-merge API (no protected-branch push)". A protected branch
      # refuses a direct push; the sanctioned shape is open-PR then merge-by-API.
      # A job that tries to push to main gets a refusal it cannot interpret,
      # which is how a deterministic operator wedges.
      steps:
        - POST /api/v1/repos/rtech/k3s-deploy/pulls        # open the PR
        - POST /api/v1/repos/rtech/k3s-deploy/pulls/{n}/merge
      credential_name: FORGEJO_TOKEN
    verification:
      # Ask the STORE what it has, never the writer what it did.
      - argo Application is Synced AND Healthy at the exact commit SHA
      - pod Running+Ready with the exact pinned image tag
      - a real request through the Service or LB returns real data
    forbidden:
      - path: kubectl apply / kubectl edit / kubectl scale on an Argo-managed object
        failure: "selfHeal: true reverts the change within seconds AFTER APPEARING TO WORK"
      - path: git push to rtech/k3s-deploy@main
        failure: protected branch refuses the push; use the PR-merge API
      - path: an Argo Application filed in a subdirectory of apps/
        failure: the root Application does not recurse; the child is silently never created
      - path: referencing an image tag before it is built
        failure: ImagePullBackOff that selfHeal retries forever

  # -------------------------------------------------------------------------
  - id: image-build-registry
    title: Images are built IN THE CLUSTER and pulled from the Forgejo registry
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §4-5; scripts/k3s-image-builds.env; issue #526 (closed); ledger row 69
    endpoint:
      registry: 10.0.20.58:3000
      image_ref: 10.0.20.58:3000/rtech/<app>:<tag>
      builder: kaniko
      build_context: git://10.0.20.58:3000/rtech/<app>.git#<40-char-sha>
      template: gitops/k3s-deploy/manifests/image-builds/kaniko-job.template.yaml
    mutation:
      mechanism: in-cluster-kaniko-job
      pinned_by: 40-character git SHA, never a branch name
    verification:
      - registry tags API lists the tag BEFORE the manifest referencing it merges
      - "GET /v2/rtech/<app>/tags/list returns the tag (authenticated; anonymous pulls are denied)"
    forbidden:
      - path: docker build / podman build / buildah on the operator workstation
        failure: "no docker on the Mac (Rico ruling 2026-08-11); the build rail is in the cluster"
      - path: omitting imagePullSecrets
        failure: the registry denies anonymous pulls; ImagePullBackOff with a misleading auth error
      - path: a Dockerfile with no USER line
        failure: runs as root; rejected by the rail's own constraints

  # -------------------------------------------------------------------------
  - id: dns
    title: Fleet DNS records are DECLARED in Ansible, applied per-record
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §12b; GOTCHAS.md 2026-08-05 (per-record PUT); GOTCHAS.md 2026-08-12
    endpoint:
      declared_in: projects/ansible/inventory/group_vars/all.yml
      key: pihole_dns_records
      resolvers:
        - 10.0.1.220
        - 10.0.1.222
      in_cluster_target: 10.0.20.150      # Traefik LB, NOT 10.0.20.55 (CT117)
    mutation:
      mechanism: declare-in-ansible-then-per-record-PUT
      # pihole-dns.yml currently applies DELETIONS but not ADDITIONS: its apply
      # task is gated `when: reconcile_result.rc != 0` and rc=0 when there is
      # nothing to remove, so a pure addition is skipped while the play still
      # reports success (issue filed 2026-08-12). Until that is fixed a record
      # must be declared in all.yml AND landed with the per-record PUT.
      steps:
        - declare the record in pihole_dns_records
        - land it with the per-record PUT
        - compute the declared-vs-live diff offline first
    verification:
      - dig against BOTH survival Pi-holes returns the expected address with aa set
    forbidden:
      - path: "pihole --config dns.hosts '[...]' (the config write)"
        failure: REPLACES the whole array — wipes every other record on the box
      - path: creating a record live only, without declaring it in all.yml
        failure: one gravity rebuild or one reconcile run from gone
      - path: pointing a -temp twin at CT117
        failure: the migration exists to REDUCE dependence on that box

  # -------------------------------------------------------------------------
  - id: edge-caddy
    title: Public hostnames terminate on CT117 Caddy; three layers must all agree
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §9; GOTCHAS.md 2026-08-12 (cloudflared config no-op); ledger row 86
    endpoint:
      caddy_vhosts: projects/ansible/templates/Caddyfile.j2
      tunnel_ingress_declared_in: projects/ansible/files/cloudflared-tunnel-ingress.yml
      acme: "acme_dns cloudflare (Caddyfile.j2:3) — Let's Encrypt via DNS-01"
      lb_band: 10.0.20.150-179
    mutation:
      mechanism: ansible-render-then-apply
      tunnel_ingress: API only (--apply PUTs the declared file)
    verification:
      - scripts/done-means/public-urls.sh from OUTSIDE, resolving via DoH 1.1.1.1
      - "all three layers present: zone DNS record, tunnel ingress rule, Caddy vhost"
    forbidden:
      - path: editing /etc/cloudflared/config.yml on CT117
        failure: "the unit has NO --config flag — the file is not the source at all; the edit is a silent no-op whose own validator reports OK"
      - path: an internal CA on a user-facing route
        failure: "Rico ruling 2026-08-10; the root must then be installed on every device that opens the page"
      - path: publishing a -temp hostname (CF record, tunnel rule, or Caddy vhost)
        failure: LAN-only is enforced by ABSENCE; adding any of the three publishes an unverified build
      - path: probing a public URL through a fleet-internal resolver
        failure: measures the wrong network; a local miss reads as a public outage

  # -------------------------------------------------------------------------
  - id: monitoring
    title: Collectors in-cluster, data OUT of the cluster failure domain
    state: RUNNING
    source: _DOCS/monitoring-incluster-collector.md; ledger row 14 (RATIFIED 2026-08-09); issue #530
    endpoint:
      collector_manifests: rtech/k3s-deploy → manifests/apps/monitoring
      scrape_config: projects/ansible/templates/prometheus.yml.j2
      store_of_record: outside the cluster (CT106)
    mutation:
      mechanism: forgejo-pr-merge-api      # the monitoring ConfigMap rides the same GitOps rail
    verification:
      - the scrape target answers, AND the target is the LIVE box
      - an alert rule is loaded AND proven able to fire by a negative control
    forbidden:
      - path: a scrape target left pointing at a box the service has MOVED off
        failure: "the old box still answers :9100, so node_up stays GREEN forever and no liveness alert can ever fire — a green light wired to nothing (GOTCHAS 2026-08-14)"
      - path: alerting on a backup-healthy CONDITION rather than on ARRIVAL
        failure: an unconfigured backup is a SUCCESSFUL no-op (GOTCHAS 2026-08-12)

  # -------------------------------------------------------------------------
  - id: secrets
    title: Secrets are applied OUT OF BAND from Vaultwarden, never in git
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §5, §11.7; _DOCS/k3s-bifrost.md; ledger row 152
    endpoint:
      store: vaultwarden
      applied_to: the app's own namespace, as a Secret
      manifests_carry: env.NAME references only
    mutation:
      mechanism: out-of-band-kubectl-secret-apply
      # This is the ONE sanctioned kubectl use on this fleet: a Secret is not an
      # Argo-managed object and must never be in git. Row 152 records the same
      # shape for Bifrost — provider config lives in the manifests so it replays
      # on rebuild, EXCEPT secret values, which are hand-reapplied and are
      # documented as such.
    verification:
      - the pod reaches Running+Ready (not CreateContainerConfigError)
      - a live call through the credential succeeds, independently re-verified
    forbidden:
      - path: any key value in a manifest, PR, issue, or ConfigMap
        failure: a secret in git is a secret published
      - path: a secretKeyRef to a key that has not been minted
        failure: holds the pod in CreateContainerConfigError FOREVER; referencing a credential "ready for later" is strictly worse than omitting the block
      - path: supplying a credential pair to satisfy a config flag
        failure: "press: the app fetches every DECLARED secret and a declared-but-unfetchable secret RAISES — supplying the pair is what hard-failed startup"

# ---------------------------------------------------------------------------
# CONSTRAINTS — checkable properties every rendered manifest must satisfy
# ---------------------------------------------------------------------------
#
# These are #754 clause 1's list. Each is a property of the RENDER, so the
# factory can check it before a PR is opened rather than after Argo applies it.

constraints:

  - id: replicas-default
    rule: stateless workloads default to replicas >= 2 behind the LB
    state: RATIFIED
    source: ledger row 60 (Rico ruling 2026-08-10)
    exception_grammar: >
      A single-instance workload must DECLARE the exception with a stated reason
      in its own manifest — a visible decision, never a silent default. press is
      the worked example: replicas 1 with Recreate, because alembic runs
      in-process on every start and the publisher is a single writer performing
      irreversible external posts (ledger row 81).
    check: manifest declares replicas >= 2, OR carries an exception reason

  - id: replicas-spread
    rule: replicas >= 2 must carry topologySpreadConstraints
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §11.14
    detail: >
      `replicas: 2` satisfies the manifest and fails the operator's stated test —
      "any single host is down, all pages still render" — when both land on one
      node. Use ScheduleAnyway, never DoNotSchedule: a hard constraint makes a
      rollout unschedulable during a node drain, turning maintenance into an
      outage.
    check: a Deployment with replicas >= 2 declares topologySpreadConstraints with ScheduleAnyway

  - id: cnpg-implies-backup
    rule: a new CNPG cluster implies a backup CronJob in the same change
    state: RUNNING
    source: ledger rows 80, 81
    detail: >
      press's authored set shipped NO backup CronJob for its new CNPG cluster,
      which would have taken the estate from 4/4 backed to 4/5 with nothing
      alerting. Invisible to kustomize build, kubeconform -strict and a
      server-side dry-run — all three were green throughout.
    check: a Cluster kind in the change implies a matching backup CronJob in the same change

  - id: no-unbounded-ephemeral
    rule: no /tmp and no unbounded emptyDir
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §11.10; issue #414
    detail: >
      An unbounded emptyDir (or the container's own /tmp) is backed by NODE
      ephemeral storage; filling it evicts UNRELATED pods. Mount a BOUNDED
      emptyDir with sizeLimit. The LXC sibling (#414): /tmp tmpfs is sized from
      host RAM, not the container limit, so overflow OOM-kills instead of
      returning ENOSPC.
    check: every emptyDir declares sizeLimit; no writable path resolves to /tmp

  - id: storageclass-explicit
    rule: every PVC names its StorageClass explicitly
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §11.15; GOTCHAS.md 2026-08-14 (local-path default flip)
    detail: >
      TWO StorageClasses are marked default. An unnamed class may get node-local
      `local-path`, which is not replicated — a rescheduled pod finds an empty
      volume. The dual-default hazard re-arms on every k3s server restart because
      the flip is an OVERRIDE, not a setting.
    check: every PersistentVolumeClaim declares storageClassName

  - id: pvc-prune-guard
    rule: durable PVCs are annotated Prune=false
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §11.16
    detail: >
      prune true plus Longhorn's Delete reclaim policy means removing the
      manifest DESTROYS the volume.
    check: every PVC intended to outlive its manifest carries the Prune=false annotation

  - id: port-bands
    rule: humans never get ip:port; port 3000 is banned fleet-wide
    state: RATIFIED
    source: ledger row 74; _DOCS/app-delivery-rail.md §11.19; memory no-port-3000
    detail: >
      Named edge vhosts only. The SOLE grandfathered exception is Forgejo's own
      10.0.20.58:3000, and only for rail-internal references — never a URL
      handed to a human. Local development servers on the operator workstation
      use 7100-7199.
    check: no user-facing route exposes a bare ip:port; no new service claims 3000

  - id: no-new-lxc
    rule: a new non-client LXC is a DEFECT, not a deployment
    state: RATIFIED
    source: ledger row 83 (Rico ruling 2026-08-12); _DOCS/app-delivery-rail.md §11.20
    detail: >
      Measured end state is 58 -> 23 running LXC. Stateless app workloads go in
      k3s. Proposing an LXC means naming which slot it takes and which occupant
      it evicts. Governed keepers at steady state land on six: PBS 102,
      Pi-hole 206, garage 230, Forgejo 277, loki 284, software-factory 9000.
    check: the change creates no new non-client LXC

  - id: runner-label
    rule: Forgejo Actions jobs use a label the CT103 runner actually advertises
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §3, §11.18
    detail: >
      `runs-on: ubuntu-latest` names no label on this forge. The job QUEUES
      FOREVER with no error — there is nothing to read as a failure.
    check: every workflow job's runs-on is in the runner's advertised label set

  - id: probe-shape
    rule: liveness checks the process; readiness checks dependencies
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §11.12-13
    detail: >
      A liveness probe that checks the database restarts the app when the
      database blips, which is strictly worse. Its inverse — readiness pointed at
      a static /healthz — reports Ready with a dead database, so the Service
      keeps sending traffic to a pod that cannot serve. No readinessProbe is
      better than a lying one. Size startupProbe from the FIRST deploy against an
      empty database, not a warm restart: a tight probe killed a legitimately
      migrating litellm pod at minute five.
    check: livenessProbe does not reach a dependency; startupProbe budget is stated

  - id: bind-all-interfaces
    rule: a container process binds 0.0.0.0, never 127.0.0.1
    state: RUNNING
    source: _DOCS/app-delivery-rail.md §11.8
    detail: >
      Binding loopback passes every local test, builds, pushes, pulls — and
      serves nobody, because the probe and the Service both dial the pod IP.
    check: no declared listen address is 127.0.0.1 or localhost

# ---------------------------------------------------------------------------
# THE FACTORY'S COPY — staleness is COMPUTED, not assumed (#754 clause 4)
# ---------------------------------------------------------------------------

factory_copy:
  consumer: CT101 software-factory (rodaddy-watcher)
  # CT101 is deliberately Ansible-exempt (ledger row 114): the box hands scoped
  # credential shares to other guests, so a standing fleet management key on it
  # is a strictly larger blast radius than the drift it fixes. Its access route
  # is `ssh root@10.0.1.4 'pct exec 9000 -- <cmd>'` (node07).
  access_route: pct exec 9000 via node07 10.0.1.4
  staleness_rule: >
    The factory's copy of this manifest must match this file at HEAD. The
    comparison is a sha256 of THIS file, computed at check time on both sides —
    never a version string either side asserts about itself. A version field is
    a claim; a hash is a measurement.
  # This is the row-114 clause-0 precedent from removeipc-fleet.sh: the
  # exclusion and its route are DATA printed on every run, not a comment. A
  # comment is silent; the lesson of row 114 was exactly that.

# ---------------------------------------------------------------------------
# NOT ENCODED — the visible gap (#754 clause 3)
# ---------------------------------------------------------------------------
#
# GOTCHAS.md entries that are real and load-bearing but that a render-time job
# CANNOT check, each with WHY. This list existing is the point: an unencodable
# rule that is not named here reads as encoded, which is the failure #754 is
# trying to end.

not_encoded:

  - gotcha: A service that MOVED leaves its old box answering :9100 (2026-08-14)
    why_not: >
      Requires probing two live boxes and deciding which one the service is
      genuinely on. Partially covered by the monitoring rail's forbidden path,
      but the DETECTION is a live probe, not a render check.

  - gotcha: A container Running with ZERO logs is a wedged entrypoint (2026-08-14)
    why_not: A runtime symptom. No property of a manifest predicts it.

  - gotcha: The local-path default-class flip re-arms on k3s server restart (2026-08-14)
    why_not: >
      The storageclass-explicit constraint DEFENDS against it at render time,
      but the flip itself is cluster state that only a live query can see.

  - gotcha: An all-digit git SHA is a YAML NUMBER — quote every templated value (2026-08-11)
    why_not: >
      Checkable in principle by a strict YAML round-trip, but the failure is in
      the TEMPLATE render, not the rendered artifact, so it needs the renderer's
      own input. Candidate for encoding once the factory owns the render step.

  - gotcha: Argo's default resource.exclusions silently drops whole KINDS (2026-08-11)
    why_not: Argo cluster config, not manifest content.

  - gotcha: A rail nothing has driven end to end is not a rail (2026-07-27)
    why_not: >
      The governing rule of this whole file and the one thing it structurally
      cannot enforce. Every constraint here was proven by a defect that reached
      production; the check is a ratchet behind reality, never ahead of it.
SF_RAILS_MANIFEST_EOF

observed_sha256="$(sha256sum "$manifest_file" | cut -d" " -f1)"
if [ "$observed_sha256" != "$manifest_sha256" ]; then
  echo "verb: rails manifest digest mismatch" >&2
  exit 1
fi

# --- validate the DISPATCHED base -------------------------------------------
# Base objects come from the read-only share checkout, never from a forge.
# A dispatched commit absent from this share clone is TERMINAL for this job:
# the infra-requeue sweep deliberately skips verb rows (sf#302) and the verb
# lane never re-runs a terminal tuple, so nothing retries it (sf#596). The body
# writes a phase-named error result naming the recovery signal instead of
# dying with no artifact: the operator refreshes the share checkout
# (pull --ff-only) and re-runs with the one-shot redeploy:<app> label.
repo_dir="${work_root}/k3s-deploy-${RUNNER_JOB_ID}"
git config --global --add safe.directory "$k3s_src"
git config --global --add safe.directory "$k3s_src/.git"
git clone --quiet --no-checkout "$k3s_src" "$repo_dir"
if ! git -C "$repo_dir" cat-file -e "${k3s_base_sha}^{commit}" 2>/dev/null; then
  echo "verb ${verb}: k3s-deploy base ${k3s_base_sha} not present in share checkout clone — share refresh required (pull --ff-only)" >&2
  cat > "$out_dir/.watcher-result.json.tmp" <<JSON
{
  "result_version": 2,
  "repository": "${repository}",
  "job_type": "${verb}",
  "item_number": ${item_number},
  "sha": "${dispatch_sha}",
  "status": "error",
  "checks": [
    {"name": "k3s-deploy base", "status": "error", "summary": "dispatched base ${k3s_base_sha} is absent from the share checkout clone; refresh the share (pull --ff-only), then re-run with redeploy:${app}"}
  ],
  "findings": []
}
JSON
  mv -f "$out_dir/.watcher-result.json.tmp" "$out_dir/watcher-result.json"
  result_written=1
  exit 0
fi
git -C "$repo_dir" checkout --quiet --detach "$k3s_base_sha"

# --- render, box-local ------------------------------------------------------
# The shared checkout is read-only by design and compile WRITES generated
# files, so it is copied box-local first. The venv must also be box-local:
# on the NFS share it took 11m59s and then SIGPIPEd (rtech-infra#801).
# bash only — the golden image ships no zsh (B4 run 1, exit 127).
# A FRESH directory per attempt rather than clearing a reused one: the body
# issues no recursive delete (AGENTS.md), and a per-attempt path cannot
# inherit a half-built tree from a failed run.
engine_dir="${work_root}/engine-${RUNNER_JOB_ID}"
mkdir -p "$engine_dir"
# `-R`, NOT `-a`: the /work filesystem REFUSES mode preservation, so every
# file logs `cp: preserving permissions ...: Operation not supported` and cp
# exits 1 — which under `set -euo pipefail` killed the body before compile
# ever ran (sf#311, live on rw-newapp-676470d8). The tree content copies
# fine; only the chmod is refused, and nothing below reads a mode.
cp -R "$engine_src/." "$engine_dir/"
# Invoked through an EXPLICIT interpreter because `-R` does not guarantee the
# x-bit survives the copy off the share. `scripts/service-catalog` carries
# `#!/usr/bin/env bash`, so `bash <path>` IS its own shebang and the call no
# longer depends on an executable bit the copy may or may not have kept.
bash "$engine_dir/scripts/service-catalog" compile --all --repo "$engine_dir"

# --- assemble the change ----------------------------------------------------
mkdir -p "$repo_dir/apps" "$repo_dir/manifests/apps/${app}"
cp "$engine_dir/gitops/k3s-deploy/apps/${app}.yaml" "$repo_dir/apps/${app}.yaml"
# `-R` for the same reason as the engine copy above (sf#311): the
# destination is the box-local clone, and git records no mode beyond the
# x-bit, which no rendered manifest carries.
cp -R "$engine_dir/gitops/k3s-deploy/manifests/apps/${app}/." "$repo_dir/manifests/apps/${app}/"

git -C "$repo_dir" -c user.email=factory@example.internal -c user.name="software-factory" \
  add -- "apps/${app}.yaml" "manifests/apps/${app}"
if git -C "$repo_dir" diff --cached --quiet; then
  cat > "$out_dir/.watcher-result.json.tmp" <<JSON
{
  "result_version": 2,
  "repository": "${repository}",
  "job_type": "${verb}",
  "item_number": ${item_number},
  "sha": "${dispatch_sha}",
  "status": "passed",
  "checks": [
    {"name": "service-catalog compile", "status": "pass"},
    {"name": "service-catalog render", "status": "pass", "summary": "render produced no changes"},
    {"name": "secrets", "status": "skip"},
    {"name": "test", "status": "skip"}
  ],
  "findings": []
}
JSON
  mv -f "$out_dir/.watcher-result.json.tmp" "$out_dir/watcher-result.json"
  result_written=1
  echo "verb ${verb} rendered ${app} for item ${item_number}: no changes"
  exit 0
fi
git -C "$repo_dir" -c user.email=factory@example.internal -c user.name="software-factory" \
  commit --quiet -m "${verb}: render ${app} (item ${item_number})"
head_sha="$(git -C "$repo_dir" rev-parse HEAD)"

# HEAD is REQUIRED in the bundle: the watcher's inspector runs
# `git fetch ... HEAD:<ref>` against it, and a bundle carrying only a branch
# ref is rejected changed_paths_error.
bundle_tmp="${work_root}/changes.bundle"
git -C "$repo_dir" bundle create "$bundle_tmp" "^${k3s_base_sha}" HEAD

# --- hand back --------------------------------------------------------------
# Both writes are ATOMIC (temp file in the same directory, then rename), and
# the bundle is FIRST. See this function's docblock for why the order matters.
cp "$bundle_tmp" "$out_dir/.changes.bundle.tmp"
mv -f "$out_dir/.changes.bundle.tmp" "$out_dir/changes.bundle"

cat > "$out_dir/.watcher-result.json.tmp" <<JSON
{
  "result_version": 2,
  "repository": "${repository}",
  "job_type": "${verb}",
  "item_number": ${item_number},
  "sha": "${dispatch_sha}",
  "status": "passed",
  "checks": [
    {"name": "service-catalog compile", "status": "pass"},
    {"name": "secrets", "status": "skip"},
    {"name": "test", "status": "skip"}
  ],
  "findings": [],
  "change": {
    "base_sha": "${k3s_base_sha}",
    "head_sha": "${head_sha}",
    "bundle_path": "changes.bundle"
  }
}
JSON
mv -f "$out_dir/.watcher-result.json.tmp" "$out_dir/watcher-result.json"
result_written=1

echo "verb ${verb} rendered ${app} for item ${item_number} at ${head_sha}"

