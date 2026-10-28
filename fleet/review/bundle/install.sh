#!/usr/bin/env bash
# Install a review-jobs bundle under /opt/review-jobs, as root.
# Invoked by the rtech-infra review-jobs play; never by a lane. Install only
# with no review running: the seats are paused during an install.
#
# Usage: install.sh <tarball> <expected-sha256>
#   REVIEW_JOBS_PREFIX      test seam; a non-root run is honored only when it
#                           names a prefix other than /opt/review-jobs.
#   REVIEW_JOBS_PI_PACKAGE  test seam for the host Pi package.json; honored only
#                           on the same non-root terms.
# The tarball is copied once into a 0700 staging dir; only that copy is hashed,
# listed and extracted. Replaces pi/, extensions/, factory/bin/, issuer/bin/,
# factory/fixed-review-prompt.txt and MANIFEST.json one at a time with
# rename(2), keeping each previous one as .prev-<UTC stamp>-<sha12>-<name>, then
# renames the pre-written receipt over INSTALLED. A failed rename, that last one
# included, rolls every swapped path back. Never touches factory/ or issuer/
# themselves, nor anything else under issuer/: the play owns all of those. The
# signing key, public key and issued store live outside the prefix (ATTESTATION.md).
# Exit 0 installed, 1 refused (one line naming why), 3 harness error.
set -Eeuo pipefail

REAL_PREFIX="/opt/review-jobs"
REAL_PI_PACKAGE="/usr/lib/node_modules/@earendil-works/pi-coding-agent/package.json"
STAGE=""
KEEP_STAGE=0

refuse() {
	printf 'install.sh: refused: %s\n' "$*" >&2
	exit 1
}
harness() {
	printf 'install.sh: error: %s\n' "$*" >&2
	exit 3
}
cleanup() {
	if [[ "$KEEP_STAGE" == 0 && -n "$STAGE" && -d "$STAGE" ]]; then rm -rf -- "$STAGE"; fi
}
trap 'harness "unexpected failure at line $LINENO"' ERR
trap cleanup EXIT

[[ $# -eq 2 ]] || harness "usage: install.sh <tarball> <expected-sha256>"
TARBALL="$1"
EXPECTED="$2"
for tool in tar id chown chmod mv cp find date python3; do
	command -v "$tool" >/dev/null || harness "missing tool: $tool"
done
sha256() {
	if command -v sha256sum >/dev/null; then
		sha256sum "$1" | cut -d' ' -f1
	else
		shasum -a 256 "$1" | cut -d' ' -f1
	fi
}

# 1. Root, unless the test seam names a prefix away from the real one.
PREFIX="${REVIEW_JOBS_PREFIX:-$REAL_PREFIX}"
[[ "$PREFIX" == /* ]] || refuse "prefix is not absolute: $PREFIX"
[[ -d "$PREFIX" ]] || refuse "prefix does not exist: $PREFIX"
PREFIX="$(cd "$PREFIX" && pwd -P)"
AS_ROOT=0
[[ "$(id -u)" == 0 ]] && AS_ROOT=1
PI_PACKAGE="$REAL_PI_PACKAGE"
if [[ "$AS_ROOT" == 0 ]]; then
	real="$REAL_PREFIX"
	[[ -d "$REAL_PREFIX" ]] && real="$(cd "$REAL_PREFIX" && pwd -P)"
	[[ "$PREFIX" != "$real" && "$PREFIX" != "$REAL_PREFIX" ]] || refuse "must run as root for $REAL_PREFIX"
	PI_PACKAGE="${REVIEW_JOBS_PI_PACKAGE:-$REAL_PI_PACKAGE}"
elif [[ -n "${REVIEW_JOBS_PI_PACKAGE:-}" ]]; then
	refuse "REVIEW_JOBS_PI_PACKAGE is a non-root test seam"
fi
[[ -d "$PREFIX/factory" && ! -L "$PREFIX/factory" ]] || refuse "missing $PREFIX/factory (the play creates it)"
[[ -d "$PREFIX/issuer" && ! -L "$PREFIX/issuer" ]] || refuse "missing $PREFIX/issuer (the play creates it)"

# 2. Copy the tarball once into a private staging dir; nothing after the copy
#    reads "$TARBALL".
[[ "$EXPECTED" =~ ^[0-9a-f]{64}$ ]] || refuse "expected sha256 is not 64 lowercase hex characters"
[[ -f "$TARBALL" && ! -L "$TARBALL" ]] || refuse "tarball is not a regular file: $TARBALL"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
stage_path="$PREFIX/.staging-$STAMP-$$"
mkdir -m 0700 "$stage_path" 2>/dev/null || refuse "cannot create staging: $stage_path"
STAGE="$stage_path"
TGZ="$STAGE/bundle.tar.gz"
cp -- "$TARBALL" "$TGZ"
ACTUAL="$(sha256 "$TGZ")"
[[ "$ACTUAL" == "$EXPECTED" ]] || refuse "sha256 mismatch: expected $EXPECTED, got $ACTUAL"
SHA12="${ACTUAL:0:12}"

# 3. Every member is a plain file or directory at an allowed relative path.
verbose_count=0
while IFS= read -r line; do
	case "${line:0:1}" in
	- | d) verbose_count=$((verbose_count + 1)) ;;
	*) refuse "link, device or special member: $line" ;;
	esac
done < <(tar -tvzf "$TGZ")
name_count=0
seen=" "
while IFS= read -r name; do
	name_count=$((name_count + 1))
	[[ "$name" != /* ]] || refuse "absolute member path: $name"
	[[ ! "$name" =~ (^|/)\.\.(/|$) ]] || refuse "member path contains ..: $name"
	case "${name%/}" in
	MANIFEST.json | pi | pi/* | extensions | extensions/* | factory | factory/bin | factory/bin/* | factory/fixed-review-prompt.txt | issuer | issuer/bin | issuer/bin/*) ;;
	*) refuse "member outside the bundle layout: $name" ;;
	esac
	seen+="${name%/} "
done < <(tar -tzf "$TGZ")
[[ "$verbose_count" -eq "$name_count" && "$name_count" -gt 0 ]] || refuse "member listing is inconsistent"
for need in MANIFEST.json pi/bin/pi extensions factory/bin/review-prepare factory/fixed-review-prompt.txt \
	issuer/bin/review-issue; do
	[[ "$seen" == *" $need "* ]] || refuse "bundle lacks $need"
done

REPLACED=(pi extensions factory/bin issuer/bin factory/fixed-review-prompt.txt MANIFEST.json)
backup() { printf '%s/.prev-%s-%s-%s' "$PREFIX" "$STAMP" "$SHA12" "${1//\//-}"; }
for name in "${REPLACED[@]}"; do
	prev="$(backup "$name")"
	[[ ! -e "$prev" && ! -L "$prev" ]] || refuse "backup already exists: $prev"
done

TREE="$STAGE/tree"
mkdir -m 0700 "$TREE"
tar -xzf "$TGZ" -C "$TREE" --no-same-owner
odd="$(find "$TREE" ! -type f ! -type d)"
[[ -z "$odd" ]] || refuse "non-regular entry after extraction: ${odd%%$'\n'*}"
linked="$(find "$TREE" -type f -links +1)"
[[ -z "$linked" ]] || refuse "hardlinked file after extraction: ${linked%%$'\n'*}"
for exe in pi/bin/pi factory/bin/review-prepare issuer/bin/review-issue; do
	[[ -f "$TREE/$exe" && ! -L "$TREE/$exe" ]] || refuse "$exe is not a regular file"
done

# 4. root:root; directories 0755, files 0644, the three executables 0755; no
#    setuid, setgid or sticky bit survives (GNU chmod keeps a directory's
#    setgid under a numeric mode, so the bits are cleared symbolically).
if [[ "$AS_ROOT" == 1 ]]; then chown -R 0:0 "$TREE"; fi
find "$TREE" -type d -exec chmod a-st,u=rwx,go=rx {} +
find "$TREE" -type f -exec chmod a-st,u=rw,go=r {} +
chmod u=rwx,go=rx "$TREE/pi/bin/pi" "$TREE/factory/bin/review-prepare" "$TREE/issuer/bin/review-issue"
special="$(find "$TREE" \( -perm -4000 -o -perm -2000 -o -perm -1000 \))"
[[ -z "$special" ]] || refuse "setuid, setgid or sticky bit after normalizing: ${special%%$'\n'*}"

# 5. The tree equals MANIFEST.json both ways, and the host Pi is the version
#    the bundle was built for (the bundle ships no Pi of its own).
read -r -d '' VERIFY_PY <<'PY' || true
import hashlib, json, os, stat, sys
tree, pi_package = sys.argv[1], sys.argv[2]
def fail(why):
    print(why)
    sys.exit(1)
try:
    with open(os.path.join(tree, "MANIFEST.json"), encoding="utf-8") as f:
        manifest = json.load(f)
    entries = manifest["files"]
    want_pi = manifest["pi"]["version"]
    listed = {}
    for e in entries:
        path, digest, mode = e["path"], e["sha256"], e["mode"]
        if not all(isinstance(v, str) for v in (path, digest, mode)) or path in listed:
            fail("MANIFEST.json has a malformed or duplicate entry: %r" % (e,))
        listed[path] = (digest, mode)
except (OSError, ValueError, KeyError, TypeError) as exc:
    fail("MANIFEST.json is unreadable or malformed: %s" % exc)
actual = {}
for dirpath, _dirs, files in os.walk(tree):
    for n in files:
        full = os.path.join(dirpath, n)
        rel = os.path.relpath(full, tree)
        if rel == "MANIFEST.json":
            continue
        with open(full, "rb") as f:
            digest = hashlib.sha256(f.read()).hexdigest()
        actual[rel] = (digest, "%04o" % stat.S_IMODE(os.lstat(full).st_mode))
for rel in sorted(actual):
    if rel not in listed:
        fail("file not in MANIFEST.json: " + rel)
    if actual[rel] != listed[rel]:
        fail("file differs from MANIFEST.json: %s (sha256 %s mode %s, listed %s mode %s)"
             % (rel, actual[rel][0], actual[rel][1], listed[rel][0], listed[rel][1]))
for rel in sorted(listed):
    if rel not in actual:
        fail("MANIFEST.json lists a missing file: " + rel)
try:
    with open(pi_package, encoding="utf-8") as f:
        have_pi = json.load(f)["version"]
except (OSError, ValueError, KeyError, TypeError) as exc:
    fail("host Pi package.json is unreadable: %s: %s" % (pi_package, exc))
if have_pi != want_pi:
    fail("host Pi is %s, the bundle was built for %s (%s)" % (have_pi, want_pi, pi_package))
PY
if ! why="$(python3 -I -c "$VERIFY_PY" "$TREE" "$PI_PACKAGE" 2>&1)"; then
	refuse "${why%%$'\n'*}"
fi
MANIFEST_SHA="$(sha256 "$TREE/MANIFEST.json")"

# 6. Write the receipt before anything is swapped, inside the private staging
#    dir (never a predictable path in the prefix), so a failure here leaves the
#    prefix untouched; it is renamed over INSTALLED as the last swap. An
#    INSTALLED that is not a plain file would turn that rename into a move
#    into a directory, so it refuses here.
INSTALLED_PATH="$PREFIX/INSTALLED"
if [[ -e "$INSTALLED_PATH" || -L "$INSTALLED_PATH" ]]; then
	[[ -f "$INSTALLED_PATH" && ! -L "$INSTALLED_PATH" ]] || refuse "$INSTALLED_PATH is not a regular file"
fi
RECEIPT_TMP="$STAGE/INSTALLED"
write_receipt() {
	printf 'sha256=%s\nmanifest_sha256=%s\n' "$ACTUAL" "$MANIFEST_SHA" >"$RECEIPT_TMP" || return 1
	if [[ "$AS_ROOT" == 1 ]]; then chown 0:0 "$RECEIPT_TMP" || return 1; fi
	chmod 0644 "$RECEIPT_TMP"
}
write_receipt 2>/dev/null || refuse "cannot write the receipt in $STAGE"

# 7. One rename(2) per replaced path; the previous one is kept beside it. Any
#    failed rename, the receipt's included, puts every path already swapped
#    back, newest first.
STARTED=()
OLD_MOVED=" "
NEW_PLACED=" "
rollback() {
	local i name dst prev failed=""
	for ((i = ${#STARTED[@]} - 1; i >= 0; i--)); do
		name="${STARTED[i]}"
		dst="$PREFIX/$name"
		prev="$(backup "$name")"
		if [[ "$NEW_PLACED" == *" $name "* ]]; then
			mv -- "$dst" "$STAGE/rolled-back-${name//\//-}" 2>/dev/null || failed+=" $name"
		fi
		if [[ "$OLD_MOVED" == *" $name "* ]]; then
			mv -- "$prev" "$dst" 2>/dev/null || failed+=" $name"
		fi
	done
	printf '%s' "$failed"
}
swap_fail() {
	local failed
	failed="$(rollback)"
	if [[ -n "$failed" ]]; then
		KEEP_STAGE=1
		harness "rename failed for $1 ($2); rollback INCOMPLETE for:$failed; staging kept at $STAGE"
	fi
	harness "rename failed for $1 ($2); every swapped path rolled back"
}
for name in "${REPLACED[@]}"; do
	dst="$PREFIX/$name"
	prev="$(backup "$name")"
	STARTED+=("$name")
	if [[ -e "$dst" || -L "$dst" ]]; then
		if ! err="$(mv -- "$dst" "$prev" 2>&1)"; then swap_fail "$name" "${err%%$'\n'*}"; fi
		OLD_MOVED+="$name "
	fi
	if ! err="$(mv -- "$TREE/$name" "$dst" 2>&1)"; then swap_fail "$name" "${err%%$'\n'*}"; fi
	NEW_PLACED+="$name "
done
if ! err="$(mv -- "$RECEIPT_TMP" "$INSTALLED_PATH" 2>&1)"; then swap_fail INSTALLED "${err%%$'\n'*}"; fi
printf 'sha256=%s\nmanifest_sha256=%s\n' "$ACTUAL" "$MANIFEST_SHA"
