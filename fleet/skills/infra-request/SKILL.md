---
name: infra-request
description: "How Nagatha takes any infra request (a PR, an issue, or a board task from Rico or another agent): read current canon, match exactly one rtech-infra procedure, check every input it needs plus size and fit, then do it through a PR or bounce it back on the request with what is wrong and the corrected request."
---

# infra-request

Someone asked for an infra change: Rico, or another agent. It arrives as a
pull request, a Forge issue, or a board task. You decide it from what is
written down, never from what seems likely.

## Spec-ready before implementation dispatch

Before creating, assigning, reopening, or handing back implementation or repair
work, follow `delegate-work`, "Spec-ready before implementation dispatch".
Use `spec-ready` and `task-new`; a hold queues one unassigned spec-writing step
instead of sending the work to a seat. Diagnosis and review keep their own paths.

## Juniors first

- Combot A (Anthropic) or Combot C (GPT), Nagatha's juniors, take a request
  first and run this skill end to end, except that they never apply a change.
- Nagatha takes only escalations: applying a merged PR, a request no SOP
  covers, or a repeat failure (the same request failed twice).
- A requester picks the assignee with `fleet/bin/task-route --skill
  infra-request`, adding `--needs-opus` only for those escalations. Where
  `task-route` is absent, stop; never assign around the readiness gate.

## 0. Be current

Before anything else, every task:

```
git -C ~/src/rtech/rtech-infra pull -q --ff-only
git -C ~/src/rtech/k3s-deploy pull -q --ff-only
```

A stale checkout read as absence is a known failure (rail NEVER 3). Your
canon, in `~/src/rtech/rtech-infra`: `AGENTS.md`, the gotchas in
`gotchas/<domain>.md` (`GOTCHAS.md` is only a generated index of them),
`GLOSSARY.md`, `HOSTMAP.md` / `HOSTMAP.json`, `NETWORK.md`,
`inventory-live.yml`, `_DOCS/sops/k3s/` (`README.md`, `index.json`,
`_TEMPLATE.md`, every `k3s.*.md`), `_DOCS/forgejo-native-rail.md`,
`_DOCS/edge-routing.md`, `_DOCS/app-delivery-rail.md`,
`_DOCS/decisions/k3s.md`, `_DOCS/ask-infra.md`. Read what the request
touches; read the SOP you follow in full, including its Gotchas.

**Facts come from the Jev harness, not from your reasoning** (Rico,
2026-10-02). From `~/src/rtech/rtech-infra`:

- `scripts/jev brief --packet "<the change, in words>"` before ANY change or
  merge: the target, everything recorded as depending on it, and the full text
  of the gotcha entries and decisions that apply. It is your gotcha check:
  quote the entries it returns as `gotchas/<domain>.md:<line>`, never a
  `GOTCHAS.md` line, in the plan or PR, or state it returned none. No packet,
  no change. By hand: `rg -n -A3 '<keyword>' gotchas/`.
- `scripts/jev health [app-or-host]`, `scripts/jev alerts`, `scripts/jev argo`,
  `scripts/jev logs <app-or-host>`, `scripts/jev disk <host>`,
  `scripts/jev audit`, `scripts/jev ready <proxmoxNN>` for state and diagnosis.
  Use them instead of writing PromQL, LogQL or ssh surveys by hand.
- Exit 3 means "no signal" (provider or key unavailable), never "nothing
  found": say so and stop that step.
- When the harness is wrong or missing a fact, fix canon (a gotcha, HOSTMAP,
  an SOP) by PR in rtech-infra, which is yours, so the next packet is right.
  A new gotcha is an entry in its `gotchas/<domain>.md` (Applies when / Rule
  / Why / Ref), then `scripts/gotchas/index.py` to regenerate `GOTCHAS.md`;
  a push with a stale index is refused.

## 1. Classify

- **k3s or DNS change** (a hostname, route, app, image, config, database,
  storage, Bifrost model, DNS record): the `_DOCS/sops/k3s/` path, steps 2-5.
- **New or retired LXC service**: rtech-infra's `ask-infra` path. Check the
  request carries every field `_DOCS/ask-infra.md` "What to send" lists. Missing
  any: bounce (step 6). Complete: write the desired-state PR, and after it merges
  run the playbook per your box manual's "Create or retire an LXC service" row.
- **Anything no procedure covers**: a request that should not be done at all
  is a bounce (step 6). One that should be done gets its procedure: say which
  existing SOP is nearest and why it does not fit, write the missing SOP as an
  rtech-infra pull request (`company-conduct`, "Changing a rule"), link it on
  the request, and set your task `blocked` with the CTO as owner
  (`{"owner":{"agentId":"<id>"}}`), action "decided per company-conduct: <PR link>". When
  Chang comments that it merged, start again at step 0.

## 2. Match exactly one SOP

Score the request against each SOP's `intents` and `title` in `index.json`.
Exactly one match: follow it. None: step 1's last line. Two or more: bounce,
listing the candidates with what distinguishes them. Never blend two SOPs; never take the
closest. A request that needs two SOPs in sequence (an edge route AND a DNS
record) is two changes: name both and do them as two PRs, each matching one.

## 3. Check every input

The SOP's front matter `inputs:` is the checklist, and its `## Preconditions`
are the gates. Each input must be settled by the request or by canon
(HOSTMAP, NETWORK, inventory), never assumed. Typical gaps:

- "this box": which host? Resolve it in `HOSTMAP.md` by name; if it is not
  there or the name matches two hosts, ask.
- protocol (`http`/`https`/`tcp`), health path, LAN-only or public, who
  authenticates callers (backend's own auth or Authentik forward-auth);
- a name that already exists: `rg -n '<host>'` across `k3s-deploy` and the
  rtech-infra DNS declarations; a collision is a bounce.
- for a new workload: CPU and memory requests, replicas, storage class and
  size. No size given: bounce asking for it.

## 4. Size and fit (new workloads, bigger requests)

```
infra-health fit --cpu <millicores> --memory <MiB> --replicas <n>
```

`fits: false`: bounce with the per-node free numbers and the largest size that
would fit today. `fits: true`: placement still follows what is written
(node selectors, taints, storage classes and pinned apps in `k3s-deploy`
manifests), not the emptiest node.

## 5. Do it

- The SOP's pre-check. If it needs the cluster, run it with your read-only
  kubeconfig; if read access cannot observe it, ask the requester for the
  `pre:` result (step 6 with the exact command to run); never write a `pre:`
  line you did not observe.
- Make the change in a branch of the SOP's repo, only in the SOP's `files`,
  copying an existing block the way the SOP says. PR body: the
  `sop: k3s.<x>.<y>` line, the `pre:` line, what and why, and the requester.
- Then `k3s-review` from its step 1: gate, judgment, merge, `sop-verify`,
  receipt. Your own PR gets the same review as anyone's.

## 6. Bounce back (never a bare no)

Post ONE comment on the request itself (the PR or issue; on a board-only
request, on the board issue), and edit the same comment on a later round
rather than adding another. Mention the requester: `@rico` for Rico (`rodaddy` is an organization), or the
calling agent's Forge login, plus a comment on its board task if there is one.
Shape:

```
**Nagatha, infra:** this cannot go through yet.

**Asked:** <one line, in their words>
**Procedure:** <sop id> (<title>) | none covers this | two could: <a> vs <b>

**What is wrong**
1. <specific: missing input / ambiguous value / collision / no fit / gate check N red>

**How to make it valid**
1. <exact fix, with an example value: `backend: 10.0.20.87:7004 (node03 a fleet host)`>

**Corrected request** (copy, fill the blanks, post it back):
<the full request rewritten with every input, blanks marked ___>
```

Then set your board task `blocked` with owner `board` or the
calling agent (`{"owner":{"agentId":"<id>"}}`), action "answer Nagatha's
questions on <link>". When they answer, start again at step 0.

## 7. Hand up

`NEEDS RICO:` on the request, assigned to `rico`, task `blocked` with
owner `board`, only for: a change that would break something (`k3s-review`
step 5), anything a guard refuses (quote the refusal), or a destroy (deleting
a box, a volume or data): destroys stay with Rico (`company-conduct`, "Rico only").

## Worked example

A PR says: "create foo.example.internal, point it at this box at port 7004".

- Two procedures: the in-cluster route (`k3s.app.external-backend-relay`, or
  `k3s.edge.add-hostname` if it must be public) and the LAN name
  (`k3s.dns.pihole-record`). Public or LAN-only is not stated: ask.
- Inputs missing: which host "this box" is (address), protocol and health
  path, who authenticates callers; check `foo` is free in both repos.
- Bounce with those four, an example value for each, and the corrected
  request. Once answered: two PRs, two receipts.

## Never

`kubectl`/`helm`/`argocd` writes; Ansible or Proxmox actions outside your box
manual's rails; editing an SOP or the gate except by your own PR the decision ladder
decides (`company-conduct`, "Changing a rule"); editing branch protection or a secret; inventing an address, size or
`pre:` result.
