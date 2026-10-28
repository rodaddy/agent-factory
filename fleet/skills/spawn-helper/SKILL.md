---
name: spawn-helper
description: "Use to hand a bounded, simple piece of your own run to a child Pi session -- a read-only investigation, a log or config read, a draft, or a single-file edit in a working copy. No board task, wake or comment per hand-off; you verify the child's output before acting on it."
---

# spawn-helper

A child Pi session runs inside your own run (The operator, 2026-10-08: helpers for
Nagatha, not new board seats). It costs no board task, no wake and no comment.
Use it to take simpler work off your own context, not to add a coordinator.

```
~/fleet/skills/spawn-helper/bin/spawn-helper --model fleet-proxy/gpt-6-luna --thinking medium \
  --access read-only --brief brief.md --scope <dir> --out <dir> [--prompt <text>] [--timeout <s>]
echo "exit $?"
```

Run it without a pipe so the exit code is real.

## When to use it

- A read-only investigation: find where something is set, summarise a file.
- Reading a log or a config and reporting what it says.
- A draft: a comment, an issue body, a short doc section.
- A single-file edit in a working copy you own (`--access write`).

Keep each piece small enough to state in one brief. Larger or riskier work
stays with you.

## What a child never does

- Mutate live infrastructure: no `pct`, `ssh`, `systemctl`, `kubectl` writes,
  no deploys.
- Call the board or Forge with write intent: no comments, status changes,
  labels, pushes or merges. You do those, after checking the output.
- Spawn its own child.

Say so in the brief. The child gets `--no-session`, no context files, and only
the `fleet-proxy-models` and `fleet-guard` extensions, so the fleet bash guard
still judges every tool call.

## Rules

- At most 2 children at once.
- Default model `fleet-proxy/gpt-6-luna` at `medium`. Once PR 1876 deploys,
  `fleet-proxy/claude-haiku-5-5` at `medium` is the cheaper Claude choice.
- `--access read-only` gives `read,grep,find,ls`; `--access write` adds
  `edit,write,bash`. Pick read-only unless the piece is an edit.
- `--timeout` defaults to 600 s and is capped at 900 s. On timeout the child
  gets TERM, then KILL after 5 s.
- The child's output is PROPOSED. Read `RESULTS.md`, check any claim against
  the source, and look at any edit before you use it.

## Output

`--out` gets `events.jsonl` (the child's JSON event stream), `stderr.txt`, and
`RESULTS.md`:

```
exit: 0
duration_s: 42
stop_reason: stop
tool_calls: 3
error: none

<the child's final text>
```

## Exit codes

- `0` the child finished cleanly.
- `1` the child failed: an error stop, a timeout, a nonzero exit, or empty
  final text. `error:` says which.
- `3` harness error: bad arguments, missing brief or scope, a missing
  extension, or no `pi` (env `PI_BIN`, else `pi` on PATH). Usage is printed.
