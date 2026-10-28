#!/usr/bin/env bash
# Build the review-jobs bundle: the Pi wrapper, the review
# extensions, zod, the Linux review-prepare and review-issue binaries and the
# fixed prompt, as one root-owned tarball whose member paths are relative to
# /opt/review-jobs.
#
# Usage: OUT=<dir> fleet/review/bundle/build.sh
#   MAIN_REF      ref for the wrapper, fleet-proxy-models, read-roots and the
#                 review-issue issuer (default HEAD; resolved and recorded)
#   SCOPE_REF     ref for review-scope (default 74212a5d...)
#   PREPARER_REF  ref for runtime-capture, prepare-cli, fixed prompt (default 5c219ca9...)
# Needs network: `npm pack zod@4.4.3` and bun's linux-x64 compile target.
# Writes OUT/review-jobs-<sha12>.tar.gz and OUT/review-jobs-<sha12>.tar.gz.sha256.
# Exit 0 built, 1 refused (one line naming why).
set -euo pipefail

die() {
	printf 'build.sh: refused: %s\n' "$*" >&2
	exit 1
}

[[ -n "${OUT:-}" ]] || die "OUT is required"
MAIN_REF="${MAIN_REF:-HEAD}"
SCOPE_REF="${SCOPE_REF:-74212a5d6f03955b10b80ff84b8c6a798639a43d}"
PREPARER_REF="${PREPARER_REF:-5c219ca9168f739a8a6e4c573d137c427ab339b7}"
ZOD_VERSION="4.4.3"
ZOD_INTEGRITY="sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ=="
# The host's system Pi, which pi/bin/pi execs; install.sh refuses any other.
PI_VERSION="1.1.0"
# The bun the runner image and every workflow pin (.forgejo/runner-image/Dockerfile).
BUN_VERSION="1.3.14"

for tool in git bun node npm tar gzip touch openssl file; do
	command -v "$tool" >/dev/null || die "missing tool: $tool"
done
have_bun="$(bun --version)"
[[ "$have_bun" == "$BUN_VERSION" ]] || die "bun is $have_bun, the build needs exactly $BUN_VERSION"

sha256() {
	if command -v sha256sum >/dev/null; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(git -C "$HERE" rev-parse --show-toplevel)"
resolve() { git -C "$REPO" rev-parse --verify --quiet "$1^{commit}" || die "unknown ref: $1"; }
MAIN_SHA="$(resolve "$MAIN_REF")"
SCOPE_SHA="$(resolve "$SCOPE_REF")"
PREPARER_SHA="$(resolve "$PREPARER_REF")"

SCRATCH_ROOT="${RTECH_SCRATCH_ROOT:-/opt/_tmp/rodaddy/software-factory}"
WORK="$SCRATCH_ROOT/review-bundle-build.$(date +%Y%m%d%H%M%S).$$"
case "$WORK" in /tmp/* | /private/tmp/*) die "scratch under /tmp: $WORK" ;; esac
S="$WORK/stage"
mkdir -p "$S/pi/bin" "$S/factory/bin" "$S/issuer/bin" "$S/extensions/node_modules" "$WORK/zod" \
	"$WORK/preparer-src" "$WORK/issuer-src"
for ext in fleet-proxy-models review-scope read-roots runtime-capture; do
	mkdir -p "$S/extensions/$ext"
done
printf 'build.sh: scratch %s\n' "$WORK"

# from_ref <sha> <path in repo> <dest>
from_ref() { git -C "$REPO" show "$1:$2" >"$3" || die "missing $2 at $1"; }
from_ref "$MAIN_SHA" fleet/review/bundle/pi-wrapper.sh "$S/pi/bin/pi"
from_ref "$MAIN_SHA" fleet/pi-extensions/fleet-proxy-models/index.ts "$S/extensions/fleet-proxy-models/index.ts"
from_ref "$MAIN_SHA" fleet/pi-extensions/read-roots/paths.ts "$S/extensions/read-roots/paths.ts"
from_ref "$SCOPE_SHA" fleet/pi-extensions/review-scope/index.ts "$S/extensions/review-scope/index.ts"
from_ref "$PREPARER_SHA" fleet/review/runtime-capture.ts "$S/extensions/runtime-capture/index.ts"
from_ref "$PREPARER_SHA" fleet/review/contracts/fixed-review-prompt.txt "$S/factory/fixed-review-prompt.txt"

# zod: npm pack, then verify the tarball bytes against bun.lock's integrity.
(cd "$WORK/zod" && npm pack "zod@$ZOD_VERSION" --json --pack-destination "$WORK/zod" >"$WORK/zod/pack.json") ||
	die "npm pack zod@$ZOD_VERSION failed"
ZOD_TGZ="$WORK/zod/zod-$ZOD_VERSION.tgz"
[[ -f "$ZOD_TGZ" ]] || die "npm pack wrote no $ZOD_TGZ"
actual="sha512-$(openssl dgst -sha512 -binary "$ZOD_TGZ" | openssl base64 -A)"
[[ "$actual" == "$ZOD_INTEGRITY" ]] || die "zod integrity mismatch: $actual"
[[ "$(<"$WORK/zod/pack.json")" == *"\"integrity\": \"$ZOD_INTEGRITY\""* ]] ||
	die "npm pack reported a different zod integrity"
while IFS= read -r line; do
	case "${line:0:1}" in -| d) ;; *) die "zod tarball has a non-regular member: $line" ;; esac
done < <(tar -tvzf "$ZOD_TGZ")
tar -xzf "$ZOD_TGZ" -C "$WORK/zod"
mv "$WORK/zod/package" "$S/extensions/node_modules/zod"

# review-prepare: compile prepare-cli.ts at PREPARER_REF in a clean export.
git -C "$REPO" archive "$PREPARER_SHA" | tar -x -C "$WORK/preparer-src"
(cd "$WORK/preparer-src" && bun install --frozen-lockfile >"$WORK/preparer-install.log" 2>&1) ||
	die "bun install at $PREPARER_SHA failed; see $WORK/preparer-install.log"
(cd "$WORK/preparer-src" && bun build --compile --target=bun-linux-x64 fleet/review/prepare-cli.ts \
	--outfile "$S/factory/bin/review-prepare" >"$WORK/preparer-build.log" 2>&1) ||
	die "bun build --compile failed; see $WORK/preparer-build.log"
kind="$(file -b "$S/factory/bin/review-prepare")"
[[ "$kind" == *ELF*x86-64* ]] || die "review-prepare is not ELF x86-64: $kind"

# review-issue: compile the issuer at MAIN_REF in its own clean export.
git -C "$REPO" archive "$MAIN_SHA" | tar -x -C "$WORK/issuer-src"
(cd "$WORK/issuer-src" && bun install --frozen-lockfile >"$WORK/issuer-install.log" 2>&1) ||
	die "bun install at $MAIN_SHA failed; see $WORK/issuer-install.log"
(cd "$WORK/issuer-src" && bun build --compile --target=bun-linux-x64 fleet/review/issuer/review-issue.ts \
	--outfile "$S/issuer/bin/review-issue" >"$WORK/issuer-build.log" 2>&1) ||
	die "bun build --compile of review-issue failed; see $WORK/issuer-build.log"
issuer_kind="$(file -b "$S/issuer/bin/review-issue")"
[[ "$issuer_kind" == *ELF*x86-64* ]] || die "review-issue is not ELF x86-64: $issuer_kind"

# Modes, then refuse anything that is not a plain directory or single-link file.
find "$S" -type d -exec chmod 0755 {} +
find "$S" -type f -exec chmod 0644 {} +
chmod 0755 "$S/pi/bin/pi" "$S/factory/bin/review-prepare" "$S/issuer/bin/review-issue"
odd="$(find "$S" ! -type f ! -type d)"
[[ -z "$odd" ]] || die "non-regular entry in stage: ${odd%%$'\n'*}"
linked="$(find "$S" -type f -links +1)"
[[ -z "$linked" ]] || die "hardlinked file in stage: ${linked%%$'\n'*}"

# MANIFEST.json: refs, tool versions, zod, and sha256 + mode of every file.
files_json=""
while IFS= read -r rel; do
	[[ "$rel" =~ ^[A-Za-z0-9._@+/-]+$ ]] || die "unexpected path characters: $rel"
	[[ "$rel" != */._* && "$rel" != ._* ]] || die "AppleDouble file in stage: $rel"
	mode="0644"
	[[ -x "$S/$rel" ]] && mode="0755"
	files_json+="${files_json:+,}"$'\n'"    {\"path\": \"$rel\", \"sha256\": \"$(sha256 "$S/$rel")\", \"mode\": \"$mode\"}"
done < <(cd "$S" && find . -type f | sed 's|^\./||' | LC_ALL=C sort)
cat >"$S/MANIFEST.json" <<EOF
{
  "schemaVersion": 1,
  "refs": {"main": "$MAIN_SHA", "scope": "$SCOPE_SHA", "preparer": "$PREPARER_SHA"},
  "tools": {"bun": "$have_bun", "node": "$(node --version)", "npm": "$(npm --version)"},
  "zod": {"version": "$ZOD_VERSION", "integrity": "$ZOD_INTEGRITY"},
  "pi": {"version": "$PI_VERSION"},
  "files": [$files_json
  ]
}
EOF
chmod 0644 "$S/MANIFEST.json"

# Tarball, reproducible: one fixed mtime on every entry, members from an
# LC_ALL=C-sorted explicit list with no recursion, numeric root ownership, no
# xattrs or AppleDouble members, and gzip -n (no name or time in the header).
# bsdtar and GNU tar both accept these flags.
find "$S" -exec env TZ=UTC touch -h -t 200001010000 {} +
(cd "$S" && find . -mindepth 1 | sed 's|^\./||' | LC_ALL=C sort) >"$WORK/members"
TGZ="$WORK/bundle.tar.gz"
COPYFILE_DISABLE=1 tar --owner=0 --group=0 --numeric-owner --no-xattrs --no-recursion \
	-cf - -C "$S" -T "$WORK/members" | gzip -n -9 >"$TGZ"
while IFS= read -r line; do
	case "${line:0:1}" in -| d) ;; *) die "tarball has a link or special member: $line" ;; esac
done < <(tar -tvzf "$TGZ")
while IFS= read -r name; do
	case "$name" in ._* | */._*) die "tarball has an AppleDouble member: $name" ;; esac
done < <(tar -tzf "$TGZ")

SHA="$(sha256 "$TGZ")"
NAME="review-jobs-${SHA:0:12}.tar.gz"
mkdir -p "$OUT"
cp "$TGZ" "$OUT/$NAME"
printf '%s  %s\n' "$SHA" "$NAME" >"$OUT/$NAME.sha256"
printf 'build.sh: built %s/%s\nsha256=%s\nmanifest_sha256=%s\nreview-prepare: %s\nreview-issue: %s\n' \
	"$OUT" "$NAME" "$SHA" "$(sha256 "$S/MANIFEST.json")" "$kind" "$issuer_kind"
