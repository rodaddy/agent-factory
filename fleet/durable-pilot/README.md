# Durable proxy restart pilot

Factory-owned integration for Infra pilot issue
2780, tranche
`DURABLE-PI-PROXY-RESTART-20261012-F`. Uses the shipped Pi Durable **1.1.0**
`Harness`, Pi AI provider API and SQLite adapter. Reuses the Factory catalog
mapping. This is a bounded harness fixture; the disler demo web application
at `37165c6` is unchanged. Production entrypoints and installers are unchanged.

Infra installs this directory and `../pi-extensions/fleet-proxy-models/index.ts`
together on the pilot hosts only. Runtime dependencies must resolve to
the exact versions in `package.json` (including overrides); the committed
`bun.lock` supports a frozen standalone install. Existing matching pilot
dependencies may be reused. Node 24.21.0 runs the `.mjs` files and strips types
from the shared catalog mapper. No coding-agent CLI or ordinary Pi extension
executes the proof.

## Execution contract

Infra creates `/var/lib/durable-pi-pilot/proxy-restart-F` for the existing
dedicated pilot user. The live command is `node <install>/fleet/durable-pilot/run.mjs
claude` or `gpt`, with exactly those two cases on each existing sandbox.
The CLI fixes the endpoint to `https://subs.example.internal`, checks host/UID,
and exclusively creates the case directory. Never remove a case directory or
claim to retry it. Failed cases consume their admission. Infra supplies an
additional root-owned claim, `Restart=no`, a 200-second systemd deadline and
`KillMode=control-group`, and verifies the cgroup is empty afterward.

- Six case admissions; **two outgoing inference attempts per case**, twelve
  maximum in this tranche, including failures. SQLite request admission is
  committed with synchronous FULL before egress and survives worker restart.
- At most 512 requested output tokens per request and 8192 serialized message
  bytes per request. The byte cap is not a tokenizer or billing estimate.
- 60 seconds per provider request; 180 seconds for the whole case.
- No tools, retries, compaction, paid fallback, credential changes, production
  writes, board mutations, or external reviews.

The first generation remembers a random word. The second submission reaches
a persisted `pi.generation` request checkpoint and blocks **before** network
egress. The controller SIGKILLs and reaps the worker, reads SQLite independently,
then opens the same database in a new process. That process retrieves the
existing submission, calls `Harness.resume()` and produces the remembered word.
It never submits a new prompt. Assertions require the same provider session,
same task/submission, unchanged first answer hash, exactly two assistant
messages and exactly one HTTP attempt in each process.

This proves process recovery at a committed request boundary. It does not
prove recovery of an already dispatched remote request, power-loss durability,
PostgreSQL storage, cross-host failover, or a production factory replacement.

## Evidence and offline checks

Each case preserves `receipt.json`, requested catalog metadata, before/after
SQLite records, checkpoint and resumed output, process kill/exit records, and
the persistent request ledger. Usage is provider-reported; model identity is
the requested catalog/Pi identity, not independent upstream attestation.
Infra owns deployed version/source hashes and final cgroup/paused-board receipts.

The six live F cases passed on 2026-10-12 at execution commit
`c61eca8bc7706bbb40f5bdc957c08bbb3e3554d6`: one Claude and one GPT case on
each of the pilot hosts. Exactly 12 outgoing requests consumed all
six admissions, reporting 3,138 tokens. All test processes were stopped;
the final GET-only board read confirmed all 21 Paperclip agents paused.
F is exhausted: these receipts do not authorize another run.

- Factory independent SQLite, source and cleanup verification
- Infra deployment and canonical six-case JSON receipts

Focused offline checks passed. The original full repository check reported
6,537 passes, three skips and one failure in an unchanged deployment test;
the exact isolated rerun passed. That historical run is not a green full-suite
receipt. The live proof remains limited to the process-restart boundary above.

For offline verification, copy the source and shared catalog mapper to an
approved temp bucket preserving their relative paths, install dependencies
with `bun install --frozen-lockfile`, then run:

```
PILOT_TEST_ROOT=<fresh /opt/_tmp/... case root> node --test offline-check.mjs
```

The checks use a loopback HTTP endpoint with real Pi streaming, SQLite and
SIGKILL/restart. They also exercise persisted request caps, duplicate-case
refusal, catalog route refusal, oversized-context refusal, actual output limits
on the wire and HTTP500 without retry. No external inference occurs.
