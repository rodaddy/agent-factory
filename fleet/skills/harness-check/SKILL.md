---
name: harness-check
description: "Nightly check of the harness CLIs (Claude Code, Pi) on sf-fleet-01 against fleet/harness-versions and the latest npm release; report drift on the board. Report only; never install or upgrade anything."
---

# harness-check

Desai runs this nightly on sf-fleet-01. You report. You never
install, upgrade, or edit `fleet/harness-versions`; a bump is a reviewed change.

## Run

```
~/fleet/skills/harness-check/bin/harness-check --pins ~/fleet/harness-versions
```

It prints JSON `{checkedAt, tools:[{tool, pinned, installed, latest, status}]}`.
Status per tool: `missing` (no binary), `drift` (installed differs from the
pin), `behind` (the pin differs from the latest npm release), `ok`.
Exit 2 means a tool is `drift` or `missing`; exit 0 otherwise. Any other exit
is a broken check: say so, do not guess a status.

## Act on the result

- **drift or missing:** open one board issue titled
  `Harness drift on sf-fleet-01` with the JSON in a code block. If an open
  issue with that title already exists, comment the JSON on it instead; never
  open a second one.
- **behind:** comment the upgrade candidates (tool, pinned, latest) on the
  board mirror of sf#1175, once per new version: if an earlier comment already
  names that tool at that latest version, post nothing.
- **all ok:** post nothing.
