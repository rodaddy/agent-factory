#!/usr/bin/env bash
#
# Install the reviewed standalone pre-push receipt gate into the Git COMMON hooks
# directory. It deliberately does NOT set `core.hooksPath` to the mutable
# `_githooks/` checkout: that would let any commit that edits `_githooks/pre-push`
# change what the operator's push hook executes, and the previous hook ran
# candidate code (`bun run check`, `src/index.ts`) directly from the checkout.
#
# Instead we copy the reviewed, self-contained hook into the common hooks
# directory (`<git-common-dir>/hooks/pre-push`). Installing under the common dir
# means the hook also fires from linked worktrees. The installed hook runs only
# fixed git reads and consumes the bounded receipt; it executes no checkout code.
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
source_hook="$repo_root/_githooks/pre-push"

if [[ ! -f "$source_hook" ]]; then
  echo "install-hooks: reviewed hook not found at $source_hook" >&2
  exit 1
fi
# The source hook must be a real regular file, never a symlink: following a link
# would let a crafted checkout point the install at arbitrary content.
if [[ -L "$source_hook" ]]; then
  echo "install-hooks: reviewed hook source is a symlink, refusing to follow it: $source_hook" >&2
  exit 1
fi

# Resolve the Git common hooks directory (shared across linked worktrees).
git_common_dir="$(git -C "$repo_root" rev-parse --git-common-dir)"
case "$git_common_dir" in
  /*) : ;;
  *) git_common_dir="$repo_root/$git_common_dir" ;;
esac
hooks_dir="$git_common_dir/hooks"
mkdir -p "$hooks_dir"

installed_hook="$hooks_dir/pre-push"

# The shared local config that `git --local` resolves to. It is the file every
# `--local` write actually lands in, so we mutate and verify it directly through
# `git config --file` after proving it is the real file (see the trust checks
# below) rather than trusting `git --local` to resolve to something safe.
common_config="$git_common_dir/config"

fail_config() {
  printf 'install-hooks: %s\n' "$1" >&2
  exit 1
}

# A config file that Git will mutate MUST be a real, writable regular file. Git's
# own exit codes do not enforce this: an unreadable `--file` reads back as
# "missing" (warning, exit 1), and a symlink is silently followed. So before any
# mutation, prove the target is a readable, writable, non-symlink regular file.
# `require_present` controls whether absence is itself an error (true for the
# shared common config a normal repo must have; false for optional worktree
# configs that need not exist).
assert_regular_rw_file() {
  local config_file="$1"
  local require_present="$2"

  if [[ -L "$config_file" ]]; then
    fail_config "config path is a symlink, refusing to follow it: $config_file"
  fi
  if [[ ! -e "$config_file" ]]; then
    if [[ "$require_present" == "true" ]]; then
      fail_config "expected Git config is missing: $config_file"
    fi
    return 1
  fi
  if [[ ! -f "$config_file" ]]; then
    fail_config "config path is not a regular file: $config_file"
  fi
  if [[ ! -r "$config_file" ]]; then
    fail_config "config file is not readable: $config_file"
  fi
  if [[ ! -w "$config_file" ]]; then
    fail_config "config file is not writable: $config_file"
  fi
  return 0
}

# Strictly read `core.hooksPath`, echoing the value when present.
#   - status 0: key present -> capture value on stdout, return 0
#   - status 1: key absent  -> return 1, no output
#   - any other status: FATAL (malformed/unreadable/other Git config error)
# Only status 1 is a benign "absent"; every other nonzero status is surfaced
# with the captured Git error rather than suppressed.
read_effective_hooks_path() {
  local dir="$1"
  local out
  local status=0

  # Capture the exit status directly: an `if cmd; then` guard would reset `$?`
  # to the `if` construct's own success, masking the git status we must inspect.
  out="$(git -C "$dir" config --get core.hooksPath 2>&1)" || status=$?
  if [[ "$status" -eq 0 ]]; then
    printf '%s' "$out"
    return 0
  fi
  if [[ "$status" -eq 1 ]]; then
    return 1
  fi
  fail_config "reading effective core.hooksPath from $dir failed (git exit $status): $out"
}

# Same strict contract as read_effective_hooks_path but scoped to a single
# config file via `--file`, so the file already proven safe is the one read.
read_file_hooks_path() {
  local config_file="$1"
  local out
  local status=0

  out="$(git config --file "$config_file" --get-all core.hooksPath 2>&1)" || status=$?
  if [[ "$status" -eq 0 ]]; then
    printf '%s' "$out"
    return 0
  fi
  if [[ "$status" -eq 1 ]]; then
    return 1
  fi
  fail_config "reading core.hooksPath from $config_file failed (git exit $status): $out"
}

# A worktree-scoped configuration lives under the common Git directory even
# after its checkout has been moved or become prunable. Clear it by that
# administrative path instead of relying on `git -C <checkout>` to reach it.
# The file need not exist; if it does it must be a real writable regular file
# and we mutate/verify it through `--file` so the validated file is the one we
# change.
clear_worktree_config_hooks_path() {
  local config_file="$1"
  local config_output
  local config_status

  # Absent worktree config: nothing to clear. Present: must be safe to mutate.
  if ! assert_regular_rw_file "$config_file" "false"; then
    return
  fi

  config_status=0
  config_output="$(git config --file "$config_file" --unset-all core.hooksPath 2>&1)" \
    || config_status=$?
  # 0 == removed, 5 == key already absent. Anything else is a real failure.
  if [[ "$config_status" -ne 0 && "$config_status" -ne 5 ]]; then
    fail_config "could not clear core.hooksPath in $config_file: $config_output"
  fi

  # `--unset-all` reports 5 when the key was already absent. Verify separately
  # so a malformed config or an unremoved duplicate fails closed. A present key
  # after --unset-all means the removal did not take; strict absence is required.
  if read_file_hooks_path "$config_file" >/dev/null; then
    fail_config "worktree config still contains core.hooksPath: $config_file"
  fi
}

# Clear any `core.hooksPath` from the SHARED local (common-dir) config. Mutate
# and verify the already-validated `$common_config` directly through `--file`
# so a symlinked or write-resistant local config cannot masquerade as safe.
clear_local_hooks_path() {
  local config_output
  local config_status=0

  config_output="$(git config --file "$common_config" --unset-all core.hooksPath 2>&1)" \
    || config_status=$?
  if [[ "$config_status" -ne 0 && "$config_status" -ne 5 ]]; then
    fail_config "could not clear local core.hooksPath: $config_output"
  fi

  if read_file_hooks_path "$common_config" >/dev/null; then
    fail_config "local config still contains core.hooksPath: $common_config"
  fi
}

# The shared local config a `--local` write lands in must be a real writable
# regular file before we touch it. A normal Git repository always has this file,
# so its absence is an error, not a benign skip.
assert_regular_rw_file "$common_config" "true"

# Never install through a symlink. The hooks directory itself, and any existing
# installed pre-push, must be real (non-symlink) paths: a symlinked hooks dir or
# destination would let git run a hook body outside the common dir, or let a
# `cp`/`mv` follow the link and overwrite an arbitrary target.
if [[ -L "$hooks_dir" ]]; then
  fail_config "hooks directory is a symlink, refusing to install through it: $hooks_dir"
fi
if [[ -L "$installed_hook" ]]; then
  fail_config "installed pre-push is a symlink, refusing to overwrite it: $installed_hook"
fi

# Install atomically: write the reviewed hook to a temp file INSIDE the hooks dir
# (so the final rename is same-filesystem and atomic), make the temp executable,
# then mv -f it over the destination. A partially written or non-executable hook
# can never be observed at $installed_hook.
hook_tmp="$(mktemp "$hooks_dir/.pre-push.install.XXXXXX")" \
  || fail_config "could not create an exclusive hook install temp file in $hooks_dir"
cleanup_hook_tmp() {
  rm -f -- "$hook_tmp"
}
trap cleanup_hook_tmp EXIT
cp "$source_hook" "$hook_tmp"
chmod +x "$hook_tmp"
mv -f "$hook_tmp" "$installed_hook"
trap - EXIT
if [ -f "$repo_root/specs/software-factory.verify.sh" ]; then chmod +x "$repo_root/specs/software-factory.verify.sh"; fi

# Ensure the common-dir hook is the ACTUAL pre-push hook git runs.
#
# A prior insecure install may have set a LOCAL or WORKTREE core.hooksPath
# pointing at a mutable checkout. The worktree configs belong to the common Git
# directory, including entries for missing/prunable linked checkouts, so clear
# them there rather than only through accessible checkout paths.
clear_local_hooks_path
clear_worktree_config_hooks_path "$git_common_dir/config.worktree"
for worktree_config in "$git_common_dir"/worktrees/*/config.worktree; do
  # Guard against a literal no-match glob (nullglob is not set): skip a path
  # that does not correspond to an existing file.
  [[ -e "$worktree_config" || -L "$worktree_config" ]] || continue
  clear_worktree_config_hooks_path "$worktree_config"
done

# But if ANY effective core.hooksPath still resolves (from global or system
# config), git would ignore `<git-common-dir>/hooks/` entirely and our reviewed
# hook would never fire. Detect that with a STRICT lookup — a malformed or
# unreadable global/system config is fatal, never mistaken for "absent" — and,
# if present, pin the SHARED local config to the common-dir hooks directory so
# the reviewed hook runs regardless of the operator's global setting. When no
# effective core.hooksPath remains, leave local unset so git uses the common-dir
# hooks directory by default.
pinned_local_hooks_path=false
if read_effective_hooks_path "$repo_root" >/dev/null; then
  # Mutate the already-validated shared local config through `--file` so the
  # validated file is exactly the one changed.
  git config --file "$common_config" core.hooksPath "$hooks_dir"

  # Read the pin back from the same validated file and require exact equality,
  # so a partial write or a competing duplicate key fails closed.
  pinned="$(read_file_hooks_path "$common_config")" \
    || fail_config "pinned local core.hooksPath disappeared from $common_config"
  if [[ "$pinned" != "$hooks_dir" ]]; then
    fail_config "pinned local core.hooksPath is $pinned, expected $hooks_dir in $common_config"
  fi
  pinned_local_hooks_path=true
fi

# Fail closed if any administrative Git directory still resolves a diverted hook
# path. Direct `git config --file` cleanup above deliberately does not follow
# includes: it must never mutate an included external file. Verify the effective
# configuration instead, from each admin dir, so include/includeIf is evaluated
# even when a linked checkout is missing or prunable.
#
# Resolve core.hooksPath strictly:
#   - absent (git exit 1) -> Git defaults to `<git-common-dir>/hooks`
#     (== hooks_dir): valid, nothing to check.
#   - present (git exit 0) -> must equal the absolute common hooks directory.
#   - any other git status -> FATAL.
verify_effective_admin_hooks_path() {
  local admin_dir="$1"
  local hooks_path
  local status=0

  hooks_path="$(git --git-dir="$admin_dir" config --get core.hooksPath 2>&1)" \
    || status=$?
  case "$status" in
    0)
      if [[ "$hooks_path" != "$hooks_dir" ]]; then
        fail_config "administrative git dir $admin_dir resolves core.hooksPath to $hooks_path, expected $hooks_dir"
      fi
      ;;
    1)
      : # absent -> common-dir default -> valid
      ;;
    *)
      fail_config "resolving effective core.hooksPath from administrative git dir $admin_dir failed (git exit $status): $hooks_path"
      ;;
  esac
}

# Capture the porcelain listing in this shell before parsing it. Process
# substitution would hide a failing producer's exit code behind the while loop.
worktree_listing_status=0
worktree_listing="$(git -C "$repo_root" worktree list --porcelain 2>&1)" \
  || worktree_listing_status=$?
if [[ "$worktree_listing_status" -ne 0 ]]; then
  fail_config "listing Git worktrees failed (git exit $worktree_listing_status): $worktree_listing"
fi

# Parse only successful porcelain output. Preserve literal paths (including
# spaces) and fail closed if Git did not report the primary worktree record.
listed_worktree_count=0
while IFS= read -r line; do
  case "$line" in
    "worktree "*)
      listed_worktree_count=$((listed_worktree_count + 1))
      ;;
  esac
done <<< "$worktree_listing"
if [[ "$listed_worktree_count" -eq 0 ]]; then
  fail_config "listing Git worktrees returned no worktree records"
fi

verify_effective_admin_hooks_path "$git_common_dir"
for worktree_admin_dir in "$git_common_dir"/worktrees/*; do
  [[ -d "$worktree_admin_dir" ]] || continue
  verify_effective_admin_hooks_path "$worktree_admin_dir"
done

if [[ "$pinned_local_hooks_path" == "true" ]]; then
  printf 'Pinned local core.hooksPath to %s (a global core.hooksPath was present)\n' "$hooks_dir"
fi
printf 'Installed standalone pre-push hook into %s\n' "$installed_hook"
