#!/usr/bin/env bash
#
# The agent signature line a Forgejo Actions lane opens its forge body with
# (operator ruling 2026-08-18): the shell twin of `signatureLine()` in
# src/github/signature.ts, for the lanes that compose a comment or PR body in a
# run: block (factory-smoke, issue-triage's failure comment, site-publish,
# sop-verify, hosted-app-render). The bun posters import the function instead.
#
# ONE SPELLING. `tests/github/signature.test.ts` and done-means
# `scripts/done-means/actions-lane-signature-369.sh` assert this script and the
# function render identical bytes; change both or neither.
#
# usage: scripts/actions/signature-line.sh <lane>
#   ENGINE_MODEL    the lane's configured model, when it has one; blank renders
#                   `unattested` (a requested model is a workflow literal, never
#                   a value read off a reply)
#   SIGNATURE_DATE  YYYY-MM-DD override for tests; defaults to today, UTC
set -euo pipefail

LANE="${1:-}"
if [ -z "$LANE" ]; then
  echo "signature-line.sh: a lane name is required" >&2
  exit 2
fi
MODEL="${ENGINE_MODEL:-}"
# Trim like signatureLine() does: a whitespace-padded
# model literal renders the same bytes from both twins.
MODEL="${MODEL#"${MODEL%%[![:space:]]*}"}"
MODEL="${MODEL%"${MODEL##*[![:space:]]}"}"
[ -n "$MODEL" ] || MODEL="unattested"
DAY="${SIGNATURE_DATE:-$(date -u +%Y-%m-%d)}"
printf '**agent:** forgejo-actions · model %s · seat software-factory lane %s · %s UTC\n' \
  "$MODEL" "$LANE" "$DAY"
