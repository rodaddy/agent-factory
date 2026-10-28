#!/usr/bin/env bash
# install-hooks.sh: install the one fleet guard for the
# current user ($HOME) on a fleet box, in all three runtimes. Run after fleet/ is
# copied to ~/fleet/. The rules live only in bash-guard; each runtime gets a
# thin adapter:
#   Claude Code  PreToolUse hook in the Claude settings file -> bash-guard
#   Pi           ~/.pi/agent/extensions/fleet-guard -> ~/fleet/pi-extensions/fleet-guard
#   Codex        PreToolUse hook in ~/.codex/hooks.json -> codex-guard.sh, trusted
#                through Codex's own app-server API (Codex runs no untrusted hook)
# Idempotent: replaces any existing entry pointing at the same command.
set -euo pipefail
export PATH="$HOME/.local/bin:$PATH"

HOOK="$HOME/fleet/hooks/bash-guard"
CODEX_HOOK="$HOME/fleet/hooks/codex-guard.sh"
PI_EXT="$HOME/fleet/pi-extensions/fleet-guard"
CLAUDE_DIR="$HOME/.claude"
SETTINGS="$CLAUDE_DIR/settings.json"

command -v jq >/dev/null || { echo "install-hooks: jq is required" >&2; exit 1; }
[ -f "$HOOK" ] || { echo "install-hooks: $HOOK missing" >&2; exit 1; }
chmod 755 "$HOOK"

mkdir -p "$CLAUDE_DIR"
[ -s "$SETTINGS" ] || echo '{}' >"$SETTINGS"

TMP="$CLAUDE_DIR/.settings.json.bash-guard.$$"
trap 'rm -f -- "$TMP"' EXIT

jq --arg cmd "$HOOK" '
  .hooks = (.hooks // {})
  | .hooks.PreToolUse = (
      ((.hooks.PreToolUse // [])
        | map(.hooks = ((.hooks // []) | map(select(.command != $cmd))))
        | map(select((.hooks | length) > 0)))
      + [{"matcher": "Bash|Write|Edit|MultiEdit|NotebookEdit|Read|Grep|Glob",
          "hooks": [{"type": "command", "command": $cmd}]}]
    )
' "$SETTINGS" >"$TMP"
cat -- "$TMP" >"$SETTINGS" && rm -f -- "$TMP" # write through: keeps mode and symlink
trap - EXIT

echo "bash-guard: installed"
echo "PreToolUse entries: $(jq '.hooks.PreToolUse | length' "$SETTINGS")"

# Pi: link the adapter. Pi discovers ~/.pi/agent/extensions with a sorted
# readdir, so fleet-guard loads before jev-guard; the first block ends the chain.
[ -f "$PI_EXT/index.ts" ] || { echo "install-hooks: $PI_EXT/index.ts missing" >&2; exit 1; }
mkdir -p "$HOME/.pi/agent/extensions"
ln -sfn "$PI_EXT" "$HOME/.pi/agent/extensions/fleet-guard"
echo "fleet-guard (pi): linked $(readlink "$HOME/.pi/agent/extensions/fleet-guard")"

# Codex: merge the hook into hooks.json, then trust it. Codex records trust as
# hooks.state."<hooks.json>:pre_tool_use:<i>:<j>".trusted_hash in config.toml;
# the hash is read from Codex itself (hooks/list) and written through its own
# config/batchWrite, so no other key in config.toml is touched.
[ -f "$CODEX_HOOK" ] || { echo "install-hooks: $CODEX_HOOK missing" >&2; exit 1; }
chmod 755 "$CODEX_HOOK"
if ! command -v codex >/dev/null; then
	echo "codex-guard: codex is not installed; skipped"
	exit 0
fi
CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"
HOOKS_JSON="$CODEX_DIR/hooks.json"
mkdir -p "$CODEX_DIR"
[ -s "$HOOKS_JSON" ] || echo '{}' >"$HOOKS_JSON"
TMP="$CODEX_DIR/.hooks.json.codex-guard.$$"
trap 'rm -f -- "$TMP"' EXIT
jq --arg cmd "$CODEX_HOOK" '
  .hooks = (.hooks // {})
  | .hooks.PreToolUse = (
      ((.hooks.PreToolUse // [])
        | map(.hooks = ((.hooks // []) | map(select(.command != $cmd))))
        | map(select((.hooks | length) > 0)))
      + [{"matcher": "*", "hooks": [{"type": "command", "command": $cmd, "timeout": 10}]}]
    )
' "$HOOKS_JSON" >"$TMP"
cat -- "$TMP" >"$HOOKS_JSON" && rm -f -- "$TMP"
trap - EXIT

(cd "$HOME" && CODEX_GUARD_CMD="$CODEX_HOOK" node - <<'NODE')
const { spawn } = require("node:child_process");
const cmd = process.env.CODEX_GUARD_CMD;
const srv = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
const fail = (m) => { console.error(`codex-guard: ${m}`); srv.kill(); process.exit(1); };
const timer = setTimeout(() => fail("app-server did not answer in 30s"), 30000);
const send = (o) => srv.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...o })}\n`);
const ours = (r) => (r?.data ?? []).flatMap((d) => d.hooks ?? []).filter((h) => h.command === cmd);
let buf = "";
srv.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    let m;
    try { m = JSON.parse(line); } catch { continue; }
    if (m.error) fail(`app-server error: ${JSON.stringify(m.error)}`);
    if (m.id === 1) {
      send({ method: "initialized" });
      send({ id: 2, method: "hooks/list", params: {} });
    } else if (m.id === 2) {
      const hooks = ours(m.result);
      if (hooks.length === 0) fail("hooks/list does not show the hook");
      const edits = hooks.filter((h) => h.trustStatus !== "trusted" || !h.enabled).map((h) => ({
        keyPath: `hooks.state.${JSON.stringify(h.key)}`,
        value: { trusted_hash: h.currentHash, enabled: true },
        mergeStrategy: "upsert",
      }));
      if (edits.length) send({ id: 3, method: "config/batchWrite", params: { edits } });
      else send({ id: 4, method: "hooks/list", params: {} });
    } else if (m.id === 3) {
      send({ id: 4, method: "hooks/list", params: {} });
    } else if (m.id === 4) {
      const hooks = ours(m.result);
      const bad = hooks.filter((h) => h.trustStatus !== "trusted" || !h.enabled);
      if (hooks.length === 0 || bad.length) fail(`not trusted: ${JSON.stringify(bad)}`);
      for (const h of hooks) console.log(`codex-guard: trusted ${h.key}`);
      clearTimeout(timer);
      srv.kill();
      process.exit(0);
    }
  }
});
srv.on("error", (e) => fail(`could not start codex app-server: ${e.message}`));
send({ id: 1, method: "initialize", params: { clientInfo: { name: "fleet-install-hooks", version: "1" } } });
NODE
echo "codex-guard: installed in $HOOKS_JSON"
