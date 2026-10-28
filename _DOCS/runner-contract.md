# Runner contract

This contract separates what was observed on the running fleet, what this
repository implements, and what remains proposed. A lost CLI response is not
proof that a runner verb failed.

## RUNNING-observed: timeout without a VMID

`mcp2cli` can return after roughly 60 seconds with:

```json
{"error":true,"code":"CONNECTION_ERROR","message":"Failed to communicate with local daemon: The operation timed out."}
```

The runner verb can continue server-side and complete. This was observed in
both directions: a `runner_needed` reported that error but allocated box 9907,
and five `runner_done` calls reported it but reaped all five boxes. During the
2026-07-26 incident recorded in issue #75, failed attempts left six boxes
(9901–9906) running until an operator reaped them. Blind allocation retries
leaked another three boxes on 2026-07-28.

Allocation routinely exceeds the CLI window because placement includes migrate,
move-volume, start, and a DHCP wait. The repository's
`DEFAULT_VERB_TIMEOUT_MS` is already 90,000 ms
([`src/runner/transport.ts`](../src/runner/transport.ts),
`DEFAULT_VERB_TIMEOUT_MS`). Raising it can narrow the lost-response window but
cannot close it: the leak is caused by the missing VMID, not the timeout length.

## WRITTEN: transport classification and reap duty

[`Mcp2cliRunnerTransport.needed`](../src/runner/transport.ts) uses
`hasErrorPayload` to classify `error: true` as an error. `isRefusal` does not
classify the timeout text as a capacity refusal, and the transport throws
`RunnerAllocationUnknownError`. The response contains no VMID, so
[`validatePrepush`](../src/prepush/validate.ts) writes its error receipt with
`runner.vmid: null`; the watcher cannot name or reap a box that completed
placement after the response was lost.

A refusal is different: it may return boxes already placed. Callers that abandon
that allocation must reap every returned box. `validatePrepush` does this through
`bestEffortDone` for `allocation.placed`, surplus allocations, submission
failures, and its post-submission `finally` path. The watcher dispatcher does it
in [`dispatchJob`](../src/runner/dispatch.ts), which calls the exported `reap`
function for partial placements, surplus allocations, and owned submission
failures. Reap failures remain visible but do not replace the primary failure.

## Recovery after a lost allocation response

Never blind-retry `runner_needed`.

1. Run `mcp2cli runner-boxes runner_list`.
2. Reconcile what is actually running against live jobs and known allocations.
3. Reap confirmed stray boxes by VMID with `runner_done` and verify they are gone.
4. Only then retry the allocation once.

Until `runner_list` exposes the existing `job_id` attribution,
a timed-out allocation can occupy a slot that the watcher cannot identify. The
current remedy is an operator identifying and reaping the orphan by hand.

## The pi runtime handoff (factory side WRITTEN and GATED OFF; wrapper side rtech-infra's, PROPOSED)

**STATE, up front.** The factory half is WRITTEN and its emission is GATED OFF by
default. The wrapper half is PROPOSED: it does not exist on the running fleet.
Nothing in this section describes a path that has carried a real job.

A packet is the agent's entire pi system prompt, and the #110 pilot proved
the invocation end to end on vmid 9001 by hand. #171 wires the factory half: a
packet DECLARES its runtime, model, and effort in its own frontmatter, and the
dispatcher forwards that declaration to `runner_run`.

### The kill switch — `PACKET_PI_DISPATCH_ENABLED`, default OFF

Emission of the routing trio (`runtime`/`model`/`effort`) is gated on
`PACKET_PI_DISPATCH_ENABLED`
([`src/packets/dispatch-flag.ts`](../src/packets/dispatch-flag.ts)). It is OFF
unless the env var carries an exact opt-in value (`1`, `true`, `yes`, `on`); a
misspelling resolves to OFF.

**Flag OFF (today, and the only state any deployment runs in).** A packet lane
submits body + `max_turns` and NOTHING else, so the wrapper keeps its own
`claude` default and issue-triage dispatches exactly as it did before #171. This
is pinned by a key-set assertion in
[`tests/runner/dispatch.test.ts`](../tests/runner/dispatch.test.ts), not merely
by three `undefined` checks — a fourth routing key added later without re-gating
it reds that test.

**Flag ON.** The full declared trio travels.

**Why it is off.** The live `rtech-infra/scripts/runner-boxes` verb dies on any
runtime that is not `claude|codex`, and `runner-job` has no `pi` arm. The die is
a bare non-JSON stderr exit — indistinguishable, to the transport's readiness
retry, from a container that is not exec-ready yet — so an ungated
`runtime: "pi"` would burn the full boot window (10 attempts x 15s) HOLDING an
allocated box, per dispatch, every attempt certain to fail. That is strictly
worse than the pre-#171 state, where triage ran fine on the wrapper default.

**Turn it on only when the rtech-infra pi arm is RUNNING** — meaning both the
`runner-job` pi branch AND `runner_run` accepting `model`/`effort` (see the
PROPOSED note below). Merged is not deployed; verify against the live fleet, not
against a merged PR.

### What this repository sends, with the flag ON

`runner_run` receives, in addition to the params it has always sent (`vmid`,
`job_id`, `job`, `runtime`, `max_turns`):

| param | source | bound |
| --- | --- | --- |
| `runtime` | packet frontmatter `runtime`, verbatim | `claude` \| `codex` \| `pi` |
| `model` | packet frontmatter `model`, verbatim | 1–120 chars |
| `effort` | packet frontmatter `effort`, verbatim | `low` \| `medium` \| `high` |

`runtime` is DECLARED by the packet, not derived from lane membership. The
earlier shape derived it from `PACKET_LANE_IDS`, which meant appending a lane id
to that list silently swapped the lane's runtime with no test going red.

All three are reviewed factory config validated at load by
`packetFrontmatterSchema` ([`src/packets/schema.ts`](../src/packets/schema.ts)) —
never repository content, runner output, or a value a caller can set. The
`runtime` and `effort` enums are the transport's own `RUNNER_RUNTIMES` /
`RUNNER_EFFORTS`, so the packet contract and the wire contract cannot drift in
either direction. A malformed packet fails the BOOT, not a job.

A lane that sends no routing trio (every TS-literal lane, and every packet lane
while the flag is off) submits the same params the wrapper parsed before #171.
[`tests/runner/transport.test.ts`](../tests/runner/transport.test.ts) pins the
transport's own conditional spreading — that `model`/`effort` keys are absent
when unset. It does not, and cannot, prove what the wrapper receives: it
subclasses `invoke`, so it pins what this repo INTENDS to send.

### PROPOSED — the MCP server does not accept `model`/`effort` yet

`runner_run` in `mcp/servers/runner-boxes-mcp/src/runner_boxes_mcp/server.py`
declares no `model` or `effort`
parameter, and FastMCP DROPS unknown keys rather than erroring. So with the flag
on today, the two values would leave this repo and silently vanish at the server
boundary — a success-shaped no-op.

Treat the model/effort handoff as PROPOSED until the server accepts the params
and a real run is observed carrying them. Adding them is rtech-infra's half; this
repo does not edit it (standing ruling 4). The flag gate and this note are the
same fact written in two places.

### What the wrapper is expected to compose

The pilot-proven invocation, with the task input on stdin:

```
pi -p --mode json --no-session -nc -ns --approve \
   --model cliproxy/<model>:<effort> \
   --thinking <effort> \
   --system-prompt <rendered packet body>
```

The flags are the pilot's, not a guess: `--system-prompt` plus `-nc -ns` (the
short spellings) replace pi's own scaffold wholesale so the packet body is the
entire system prompt, and `--approve` is REQUIRED or the file tools cannot write.
The route is a single `provider/id:effort` string, which is why model and effort
travel together and a `pi` dispatch carrying only one of them is refused.

The working directory is the wrapper's business. This repository never sends a
`lane` parameter, so the server applies its own default (`"default"`); do not
read a `/work/<lane>` layout into anything the factory controls.

Task input is delivered on stdin as the tier-3 delimited block
(`<<<TASK_INPUT … END_TASK_INPUT>>>`), never inside the system prompt. Ingest
remains the real security boundary regardless of the prompt structure.

### `effort` is pi's `--thinking`, a deliberate 3-of-7 subset

pi's `--thinking` namespace is seven values wide (`off` through `max`). The
factory's `effort` enum is three (`low`/`medium`/`high`) and overlaps that
namespace by design: three reviewed tiers are what a packet may choose, and the
remaining pi values are deliberately not reachable from a packet. This is a
narrowing, not an accident of naming — widening it means widening
`RUNNER_EFFORTS`, which is a reviewed change to the wire contract.

### `max_turns` is INERT under pi — what actually bounds a pi run

The #96 per-template turn budget exists only on the wrapper's `claude` arm. pi
has no `--max-turns` flag at all, so `max_turns` is still SENT (the payload shape
is unchanged) and simply has no effect on a pi run.

What bounds a runaway pi run instead is the box itself: a runner box is
ephemeral, and the wall-clock ceiling before it is reaped is the real budget.
Nothing inside the pi invocation caps turns. Before the flag is turned on, that
ceiling — not `max_turns` — is the number to check, and a pi lane whose cost
matters needs a box-side bound, not a template-side one.

### Failure shape

A packet lane whose render carries NO route is a NAMED dispatch failure resolved
before any box is allocated, at EITHER flag state: `resolveRuntimeRoute`
([`src/runner/dispatch.ts`](../src/runner/dispatch.ts)) returns the same
`{ ok: false, reason }` a null body returns, so the job takes the #95
release-and-skip path — released to `pending`, retryable, no attempt row, and its
`(repo, item, sha, job_type)` dedup key NOT burned. There is deliberately no
fallback or escalation chain: a missing route is a packet defect an operator
fixes, never something a default papers over.

A runtime the wrapper rejects is classified as a CONTRACT rejection
(`isContractRejection`, [`src/runner/transport.ts`](../src/runner/transport.ts))
rather than a boot race, so it fails on the FIRST attempt and the box is reaped
at once instead of being held through the whole readiness window.

**Not this repository's half.** The `runner-job` pi branch, the `runner_run`
`model`/`effort` parameters, `models.json` synthesis on the box, and the cost
table are rtech-infra's work. pi 0.82.1 is baked into golden image v7, so no
install step is dispatched. This repo consumes the result and never blocks on it
(standing ruling 4).

## The agentless `script` runtime (factory side WRITTEN; wrapper side rtech-infra's, PROPOSED)

**STATE, up front.** The factory half is WRITTEN and MERGED-pending. The wrapper
half is PROPOSED: the live `scripts/runner-boxes` verb does not know `script`,
so no real job has run through it. Nothing below describes a path that has
carried a job.

`script` is the first runtime with NO agent in it. The box executes the
job body as a fixed command block and launches no agent binary, so the lane
holds no agent credential at all. The business case is measured, not
speculative: 173 of 291 observed job failures were agent-runtime deaths, and the
2026-08-14 fleet OAuth outage — which held infra-static at 0 green since
2026-07-28 — could not have touched an agentless lane, because there is no
credential in it to poison.

### What this repository sends

The same keys every agent lane sends (sf#384: nothing launches without naming its route, agentless included):

| param | value on a script lane |
| --- | --- |
| `job` | the fixed command block (`renderScriptCommandBlock`) |
| `runtime` | `script` |
| `max_turns` | the template budget, INERT (same as `pi`) |
| `model` / `effort` | **`gpt-5.6-luna` / `max` (`SCRIPT_ROUTE`), REQUIRED; refused if absent** |
| `engine_base_url` / `engine_auth_header_name` | `ENGINE_ENDPOINTS.cliproxyapi`, REQUIRED |

The requirement is enforced, not documented: `scriptRouteViolation`
([`src/runner/script-route.ts`](../src/runner/script-route.ts)) is checked in
`Mcp2cliRunnerTransport.run` BEFORE the first `invoke`, so a script route
MISSING model or effort throws while the box is still unheld. sf#384 inverted
that guard — it used to refuse a model on a script route, and now it refuses a
script route without one. This matters because the MCP boundary silently DROPS
params the server does not declare (probed 2026-08-03): without the guard, an
unrouted `script` submission would be a success-shaped no-op with no signal
anywhere that nobody had chosen the route.

### The body is EXECUTED, so it is capped differently

An agent body is capped by `capBody` and truncated. An agentless body is NOT: an
oversize render returns `null` and takes the #95 release-and-skip path. A
truncated instruction costs an agent some context; a truncated shell script
leaves a half-written line that still runs, which turns a length overflow into an
arbitrary command.

Commands come from `scriptCommandSet`, composed from the SAME reviewed
`INFRA_STATIC_COMMANDS` literal the agent `infra-static` lane enumerates — one
literal, no second copy, no drift. `renderScriptCommandBlock` takes NO render
context: a body with no substitution slot has nowhere for repository content to
reach.

### Not flag-gated, unlike the pi trio — and why that is not a regression

The `PACKET_PI_DISPATCH_ENABLED` flag exists because emitting a runtime the
wrapper rejects burns an ALLOCATED box through the full ~2.5-minute readiness
window. That cost is already paid down: `isContractRejection` matches the live
verb's `runtime must be claude|codex...` phrasing, so a wrapper that does not
know `script` refuses on the FIRST attempt and the box is reaped at once.

The real opt-in is the config allowlist. `infra-static-agentless` is a SEPARATE
template id from `infra-static`, and dispatch requires the id to be both
registered in `JOB_TEMPLATE_IDS` and named in that repository's config
`job_templates`. No existing deployment emits `runtime: "script"` by taking this
commit; an operator opts in per repository.

### What the wrapper is expected to do — rtech-infra's half

Execute the job body directly (bash, fail-fast — the block already carries
`set -euo pipefail`), invoke no agent binary, and write the same result shapes
the agent arm writes today. Two properties must hold, both reusing existing
states rather than inventing new ones:

- The verdict side-channel must still distinguish "script ran and
  failed" from "script never ran".
- A script failure is a VALID result — status `failed`, attempt completed — the
  same structural rule an agent lane's failure follows.

Receipts to record on #177 when the wrapper half lands: one agentless run end to
end with zero LLM tokens, the same result artifact shape, and wall-clock plus
cost against the agent-driven run.

## PROPOSED: orphan reconciliation

Issue #75 scope item 2 proposes transport-side orphan reconciliation after a
thrown `needed`: query boxes by the attempt's single-use
`rw-repo-validate-<uuid>` job ID, then reap only that attempt's boxes. That work
is deliberately not implemented because `runner_list` does not yet return the
attribution needed to make the lookup exact. Do not substitute an unscoped reap
or a blind retry.

## See also

See [deployment.md](deployment.md) for runner dispatch, the deploy lane boundary, and the operational context this contract binds.
