# Pi seat profiles

One `<seat>.json` per Pi employee (lowercased `FLEET_EMPLOYEE`), read by
`fleet/bin/pi-employee`. v0 schema:

- `tools`: non-empty list of Pi tool names; replaces every adapter `--tools`.
- `extensions`: paths (absolute or relative to the fleet root), each must
  exist; passed as `-ne` then `-e <abs path>` ahead of the adapter's args.
- `agentDir`: optional, default `~/.pi/seats/<seat>`; becomes
  `PI_CODING_AGENT_DIR`.

No profile names a model. The board's `adapterConfig.model` is the one
selector; the launcher loads `pi-extensions/fleet-proxy-models` on every
invocation, which registers `fleet-proxy` from the live `/v1/models` catalog
on each Pi start. A seat `models.json` is not written or read (Pi would layer
one above the registered provider, so a stale one must not exist).

Seat temp dir: the launcher creates
`<agentDir>/tmp` (mode 700) and sets `TMPDIR`, `TMP` and `TEMP` to it,
overriding the caller's. An `agentDir` or temp dir whose realpath is, or is
under, `/tmp`, `/private/tmp` or `/var/tmp` refuses the run (exit 3) before
anything is created.

Unknown keys are ignored (P1.1 extends the schema). A missing or invalid
profile refuses the run (exit 3); there is no default seat.
