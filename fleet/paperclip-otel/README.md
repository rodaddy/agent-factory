# paperclip-otel

Traces the Paperclip server on a fleet host: incoming HTTP requests, express
routes, and slow or failed postgres.js queries, exported to Langfuse over OTLP.
Paperclip's own bootstrap starts its SDK after express, `node:http` and
`postgres` are already imported, so only better-auth's spans reached Langfuse.

- `preload.mjs` runs from `node --import`, before Paperclip's ESM entry. It
  registers the `@opentelemetry/instrumentation` ESM hook, then starts one
  `NodeSDK` with the HTTP (skipping `/api/health` and better-auth's
  `/api/auth/get-session`, see `ignore.mjs`), express and postgres.js
  instrumentations. All OTel packages resolve from `PAPERCLIP_OTEL_MODULES`
  (default `/home/operator/.paperclip/cli/installs/npm/node_modules/`), so there is
  one copy of `@opentelemetry/api`. Traces only: no metrics or logs exporters.
- `postgres.mjs` wraps each `postgres(...)` instance's `unsafe`, and the `tx` in
  `begin`/`savepoint`. A query becomes a `db <OPERATION>` CLIENT span only when it
  took at least `PAPERCLIP_OTEL_PG_SLOW_MS` ms (default 100; `0` traces every
  query) or failed. `db.query.text` is the SQL cut to 2000 chars; params are
  never recorded. It hooks the module through `InstrumentationBase` and
  `InstrumentationNodeModuleDefinition('postgres', ['>=3 <4'])`, which covers
  both the ESM import (import-in-the-middle, patching the namespace's `default`)
  and a CommonJS require.

Nothing starts unless `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` is set. A startup
error prints one `[paperclip-otel]` line and the server runs untraced. SIGTERM
flushes for at most 5 s.

## On the box (rtech-infra applies this)

`fleet/` lands in `/home/operator/fleet/`. A systemd drop-in for the Paperclip unit:

```ini
[Service]
ExecStart=
ExecStart=/usr/bin/node --import /home/operator/fleet/paperclip-otel/preload.mjs /home/operator/.paperclip/cli/current/node_modules/paperclipai/dist/index.js run --instance default
```

`~/.config/paperclip-otel.env`: replace `OTEL_EXPORTER_OTLP_ENDPOINT` with

```sh
OTEL_EXPORTER_OTLP_TRACES_ENDPOINT=https://langfuse.example.internal/api/public/otel/v1/traces
```

Keep the protocol, headers and `OTEL_SERVICE_NAME` lines. Optional:
`PAPERCLIP_OTEL_PG_SLOW_MS=250`. Leave `OTEL_EXPORTER_OTLP_ENDPOINT` unset: it is
what switches on Paperclip's own SDK, and two SDKs would double-register. Do not
use `NODE_OPTIONS`; it would load the preload into every child and agent run.

## Backout

Two levels; either one returns Paperclip to its pre-sf#1690 startup.

1. Tracing off, preload still loaded: remove
   `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` from `~/.config/paperclip-otel.env` and
   restart the unit. The preload returns before importing anything.
2. Preload gone: delete the drop-in above, `systemctl daemon-reload`, restart
   the unit. `ExecStart` is Paperclip's own again, with no `node --import`.
   `systemctl cat <unit>` must show no `paperclip-otel` line.

Both are pinned by `tests/fleet/paperclip-otel-preload.test.ts`, which loads the
preload under real `node --import`: with the endpoint unset it prints nothing
and the server runs; with a startup error it prints one `[paperclip-otel]` line
and the server still runs. Reverting this directory is rehearsed: with the PR
reverted the repo carries no `node --import` startup and the remaining
`fleet/paperclip-otel` tests pass (transcript linked on the PR's `rehearsed:`
line).
