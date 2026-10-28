# Requestable Durable Pi pilot H

H is an explicit bounded operator pilot on the three existing sandboxes
the pilot hosts. Paperclip remains paused and production unchanged.
F and G are exhausted; their entrypoints and seals are unchanged. H permits
six consumed provider admissions per explicit batch, including failures and
ambiguous outcomes, with no automatic quota replenishment or paid fallback.
The H acceptance batch is capped at six model calls total; no model retries.

Use one active batch and execute requests serially: submit one PR review, drain
its notification, launch the bound worker, and collect its terminal result before
submitting the next. Concurrent batches and routing around an unavailable target
host are outside this pilot. Invalid notifications are terminated without spending
a model attempt. The 256-message stream cap is intentional backpressure; reaching
it leaves publication pending and requires operator intervention, never a reset
of consumed admissions.

The Mac intake accepts only canonical Forge PR URLs for
`rodaddy/software-factory`. Its explicit local `repoPath` must have exactly
`https://forge.example.internal/rodaddy/software-factory.git` as origin. Both
40-character commits must already exist locally: intake does not fetch or
check out repository content. It uses `merge-base` followed by git diff with
external drivers and text conversion disabled, and reads PR metadata again
to refuse base/head movement. It admits only complete ordinary text changes:
at most 20 paths, 400 changed lines and 6144 canonical packet bytes. Binary,
rename, copy, file additions/deletions and mode-only changes are refused.
There is no silent truncation. The provider additionally enforces 8192 actual
serialized message bytes and 512 requested output tokens.

A root/operator-owned private JSON config contains exactly these references:

```json
{
  "trancheId": "DURABLE-PI-REQUEST-20261012-H",
  "natsUrl": "nats://DEDICATED_NATS_HOST:4222",
  "natsCredsFile": "/ABSOLUTE/PRIVATE/nats.seed",
  "postgresUrlFile": "/ABSOLUTE/PRIVATE/postgres-url",
  "stream": "DURABLE_PI_REQUEST_H",
  "consumer": "request-H-workers",
  "subject": "durable.pi.request.H.jobs",
  "stateRoot": "/opt/_tmp/software-factory/_validation-runs/request-H/operator",
  "repoPath": "/opt/dev/software-factory"
}
```

`natsCredsFile` holds a static NKey user seed (or JWT credentials); the isolated
broker must recognize that identity. The initializer uses a separate config
pointing to the database owner credential. Submit, drain, status, result and
workers use the runtime role with schema usage and table SELECT/INSERT/UPDATE.

The config and referenced credentials must be private regular files, without
symlinks or group/world permissions. The Postgres URL is stored only in its
private file and must name `durable_pi_request_h` (or a dedicated
`durable_pi_request_h_test...` database). No production database/stream is
accepted. Sandbox parent configs use a state root below
`/var/lib/durable-pi-pilot/request-H/`; model children inherit none of these
references, credentials or Forge access.

Infra must provision the existing sandbox identities, dedicated database,
the exact H JetStream stream/consumer configuration, private references,
source installation and bounded one-shot process supervision before running
this sequence. No autonomous service is claimed by these sources.

Run from the Mac, using the installed Node 24 runtime and an actual config:

```text
node fleet/durable-pilot/request-cli.mjs --config /ABSOLUTE/PRIVATE/H.json init
node fleet/durable-pilot/request-cli.mjs --config /ABSOLUTE/PRIVATE/H.json submit https://forge.example.internal/rodaddy/software-factory/pulls/123 --family claude --request-key H-claude-1 --target-host 107
node fleet/durable-pilot/request-cli.mjs --config /ABSOLUTE/PRIVATE/H.json drain
```

`init` is an explicit admin initialization of the fixed six-admission batch;
it is never called by submit or worker. `submit` commits the frozen job and
outbox; it does not publish to Forge or start a model. Omitting target host
allows one of the three existing sandboxes to claim the job. After Infra setup,
use the exact Node 24 executable on the selected sandbox:

```text
/ABSOLUTE/NODE24 fleet/durable-pilot/request-run.mjs --config /ABSOLUTE/PRIVATE/H-worker.json --once --job JOB_UUID --family claude
```

Infra's immutable root admission binds both `JOB_UUID` and the exact family.
The worker validates these required arguments before connections and checks the
received notification and stored family before claiming any job. An unexpected
job, wrong family or missing row is NAKed without changing job state, reserving
an attempt or starting inference; an idle pull stops without execution. Each
launch handles only one notification. The root admission remains consumed even
when launch fails or stops without execution. Expiry/outbox reconciliation is
explicitly owned by `drain`, never by a bound worker launch.

`drain` performs one bounded expiry/outbox pass; repeat only for transport
reconciliation, never to rerun a provider attempt. JetStream may redeliver an
unacknowledged notification until the job is terminal. Postgres prevents that
transport redelivery from authorizing another model call. A dead worker can
lose an unspent lease; after an attempt was reserved, expiry is terminal
`uncertain` and does not resume inference on another machine. Pi session
checkpoints remain local SQLite; Postgres stores the job and result.
Inspect the returned job ID:

```text
node fleet/durable-pilot/request-cli.mjs --config /ABSOLUTE/PRIVATE/H.json status JOB_ID
node fleet/durable-pilot/request-cli.mjs --config /ABSOLUTE/PRIVATE/H.json result JOB_ID
```

Results remain advisory JSON with a summary and at most three scoped findings.
Empty findings is valid. The pilot emits no Forge review, approval, merge or
commit status. `result` is an explicit local retrieval of stored output;
operational error output contains a stable failure category only.

Offline intake verification: `node --test fleet/durable-pilot/request-check.mjs`.
It injects Forge/git reads and exercises packet/result limits without network,
credentials, sandbox hosts or provider inference.
