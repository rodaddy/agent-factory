#!/usr/bin/env bash
#
# Is <repo> enrolled for the issue-triage Actions lane? The no-bun twin of
# `assert-enrolled.ts issue-triage`: issue-triage's `finalize` job
# runs it, because a bun install there once dropped the failure comment (PR 950
# round 7), and a triage job lost before its target step leaves finalize no
# `enrolled` output to go on.
#
# Same rule as assert-enrolled.ts: an entry under `repositories:` whose
# `name:` is EXACTLY <repo> (no prefix match: owner/repo2 is not owner/repo)
# and that carries `triage: true` and `triage_runtime: actions`. It reads the
# layout config/repos.yml is written in (two-space list items, four-space
# keys); anything else reads as not enrolled, so it can only fail closed.
#
# usage: scripts/actions/triage-enrolled.sh <owner/name> [config]
#   exit 0 enrolled, 1 not enrolled, 2 usage or unreadable config.
set -euo pipefail

REPO="${1:-}"
CONFIG="${2:-config/repos.yml}"
[[ "$REPO" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,99}/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$ ]] \
  || { echo 'triage-enrolled: repo is not owner/name' >&2; exit 2; }
[ -r "$CONFIG" ] || { echo "triage-enrolled: cannot read $CONFIG" >&2; exit 2; }

awk -v want="$REPO" '
  function val(s) {
    sub(/^[^:]*:[ \t]*/, "", s); sub(/[ \t]+#.*$/, "", s); sub(/[ \t]+$/, "", s)
    if (s ~ /^".*"$/ || s ~ /^\x27.*\x27$/) s = substr(s, 2, length(s) - 2)
    return s
  }
  /^repositories:[ \t]*$/ { inrepos = 1; next }
  inrepos && /^[^ \t#]/ { inrepos = 0; cur = 0 }
  !inrepos { next }
  /^  - / { cur = 0 }
  /^  - name:/ { cur = (val($0) == want) }
  cur && /^    triage:/ && val($0) == "true" { t = 1 }
  cur && /^    triage_runtime:/ && val($0) == "actions" { r = 1 }
  END { exit (t && r) ? 0 : 1 }
' "$CONFIG"
