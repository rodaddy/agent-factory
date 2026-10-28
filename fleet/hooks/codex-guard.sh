#!/usr/bin/env bash
# codex-guard.sh: Codex CLI adapter for the one fleet guard.
#
# Codex (0.159.x) reads PreToolUse hooks from ~/.codex/hooks.json, sends the
# hook JSON on stdin, and blocks the tool call when the hook exits 2 with a
# reason on stderr. Its shell tool already arrives in the Claude shape
# (tool_name "Bash", tool_input.command); apply_patch arrives as
# tool_name "apply_patch" with the patch text in tool_input.command; each of its
# target paths (at most 8 per patch) is judged as a Write of its absolute path.
# Every other tool goes to the guard unchanged. The rules live only in bash-guard.
#
# Exit 2 from the guard passes its line through. Exit 0 allows. Anything else
# (guard missing, timeout, another exit) refuses: the floor fails closed.
set -uo pipefail

# Same lookup order as the Pi adapter: FLEET_GUARD, the root-owned copy, the home copy.
GUARD="${FLEET_GUARD:-/usr/local/lib/fleet/bash-guard}"
[ -n "${FLEET_GUARD:-}" ] || [ -f "$GUARD" ] || GUARD="${HOME:-/home/operator}/fleet/hooks/bash-guard"
UNAVAILABLE="fleet-guard: guard unavailable, refusing (sf#1230)"
# One guard run gets FLEET_GUARD_TIMEOUT_S, then SIGKILL FLEET_GUARD_KILL_S later
# (defaults 5 and 1; a test shortens them).
GUARD_TIMEOUT_S="${FLEET_GUARD_TIMEOUT_S:-5}"
GUARD_KILL_S="${FLEET_GUARD_KILL_S:-1}"
export GUARD_TIMEOUT_S GUARD_KILL_S

refuse() {
	echo "${1:-$UNAVAILABLE}" >&2
	exit 2
}

# Both bounds are positive decimals: `timeout 0` means no timeout at all, so a
# zero or malformed value refuses rather than letting a hung guard hang.
for v in "$GUARD_TIMEOUT_S" "$GUARD_KILL_S"; do
	[[ "$v" =~ ^[0-9]+(\.[0-9]+)?$ && ! "$v" =~ ^[0.]+$ ]] || refuse
done

command -v jq >/dev/null 2>&1 || refuse

# One guard run. Returns only on allow; refuses (exit 2) otherwise.
judge() {
	local err rc
	err="$(printf '%s' "$1" | timeout -k "$GUARD_KILL_S" "$GUARD_TIMEOUT_S" "$GUARD" 2>&1 >/dev/null)"
	rc=$?
	case "$rc" in
	0) return 0 ;;
	2) refuse "$(printf '%s\n' "$err" | head -n 1)" ;;
	*) refuse ;;
	esac
}

payload="$(cat)"
if ! tool="$(jq -er '.tool_name // ""' <<<"$payload" 2>/dev/null)"; then
	# Not JSON: the guard owns that decision (it allows, loudly).
	judge "$payload"
	exit 0
fi

# The guard resolves relative paths from cwd: the call's workdir, else the session's.
CWD='(.cwd // "") as $c | (.tool_input.workdir // "") as $w
	| if $w == "" then $c elif ($w | test("^[/~]")) or $c == "" then $w else $c + "/" + $w end'
case "$tool" in
Bash | Shell | shell | local_shell | exec_command | functions.exec_command)
	# An argv array is judged whole, shell-quoted: the guard unwraps sh/bash -c itself.
	call="$(jq -c "{tool_name: \"Bash\", cwd: ($CWD), tool_input: {command: (
		(.tool_input.command // .tool_input.cmd // \"\")
		| if type == \"array\" then map(tostring | @sh) | join(\" \") else tostring end)}}" <<<"$payload")" || refuse
	judge "$call"
	;;
apply_patch | functions.apply_patch)
	# Codex trims each patch line before matching a header, so indented headers count.
	# Each target is judged as the Write the patch performs: made absolute against cwd
	# (as Codex resolves it) and passed as file_path, never as words a shell lexer reads
	# (PR 1461 N1: `>/../.ssh/x`, `; cd sub ;`, `& hooks.json` got past a Bash call).
	# The guard takes one Write path per run, so all of a patch's checks (at most 8
	# targets, a `~` target judged twice: 16 runs) go in one parallel wave.
	patch="$(jq -r '.tool_input.command // .tool_input.input // .tool_input.patch // "" | tostring' <<<"$payload")" || refuse
	paths="$(printf '%s\n' "$patch" | sed -n -E 's/^[[:space:]]*\*\*\* (Add File|Update File|Delete File|Move to): *(.*[^[:space:]])[[:space:]]*$/\2/p')"
	[ -n "$paths" ] || refuse "fleet-guard: could not read an apply_patch target, refusing (sf#1230)"
	# Rico (PR 1461 round 3b): a patch touching more than 8 files is too big; split it.
	# At 8, every check runs in one parallel wave, so a hung guard ends at its timeout (5 s default).
	n="$(printf '%s\n' "$paths" | wc -l | tr -d ' ')"
	[ "$n" -le 8 ] || refuse "fleet-guard: apply_patch touches $n files (max 8); split it"
	cwd="$(jq -r "$CWD" <<<"$payload")" || refuse
	case "$cwd" in /* | "~" | "~/"*) ;; *) cwd="" ;; esac
	if [ -z "$cwd" ]; then
		while IFS= read -r p; do
			case "$p" in /*) ;; *) refuse "fleet-guard: apply_patch target is relative and the call has no cwd, refusing (sf#1230)" ;; esac
		done <<<"$paths"
	fi
	# A `~` target is Codex's cwd/~/... but is judged as the home path too.
	out="$(jq -nj --arg p "$paths" --arg c "$cwd" '$p | split("\n")[]
		| (if startswith("/") then [.] else [$c + "/" + .] + (if startswith("~") then [.] else [] end) end)[]
		| {tool_name: "Write", cwd: $c, tool_input: {file_path: .}} | tojson + "\u0000"' |
		xargs -0 -n 1 -P 16 bash -c 'err="$(printf "%s" "$1" | timeout -k "$GUARD_KILL_S" "$GUARD_TIMEOUT_S" "$0" 2>&1 >/dev/null)"
			case $? in 0) ;; 2) printf "2 %s\n" "$(printf "%s\n" "$err" | head -n 1)" ;; *) echo 1 ;; esac' "$GUARD")" || refuse
	case "$out" in
	"") ;;
	*$'\n'1* | 1*) refuse ;;
	*) refuse "$(printf '%s\n' "$out" | head -n 1 | cut -c 3-)" ;;
	esac
	;;
*)
	judge "$payload"
	;;
esac
exit 0
