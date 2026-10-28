#!/usr/bin/env python3
"""tool-patterns (sf#1690): the tool calls every Paperclip seat repeats, as candidates for a
deterministic application instead of a token-burning agent step.
Usage: tool-patterns.py [--hours N] [--root DIR] [--min-runs N] [--min-seats N] [--out FILE] [--md FILE]
Runs ON the board box as the box user. Reads <root>/<companyId>/<agentId>/<runId>.ndjson changed
in the window; each line is {"ts","stream","chunk","seq"}. stdout chunks join in seq order, split
on newline, and every `tool_execution_start` event becomes one call keyed `<tool>: <normalized>`.
Env (optional, seat names): PAPERCLIP_API_URL, PAPERCLIP_API_KEY (header only), PAPERCLIP_COMPANY_ID.
Only the allowlisted pattern key is ever printed or stored; full args can hold secrets.
"""
import argparse
import json
import os
import re
import sys
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone

SCHEMA = "fleet-tool-patterns/1"
DEFAULT_ROOT = "~/.paperclip/instances/default/data/run-logs"
MD_TOP = 40
TIMEOUT = 20

# Tokenization only identifies word boundaries; emitted names come from fixed sets.
WORDS = re.compile(r"""(?:[^\s'"; &|<>\\]+|\\.|"(?:\\.|[^"\\])*"|'[^']*')+|[;&|<>]+""")
PROGRAMS = frozenset({
    "git", "bun", "node", "npm", "npx", "python3", "uv", "jq", "rg", "fd",
    "ls", "cat", "sed", "awk", "curl", "gh", "forge", "tea", "wt", "paperclipai",
    "pi", "codex", "claude", "make", "bash", "sh", "cd", "echo", "printf", "test",
    "mkdir", "cp", "mv", "rm", "find", "grep", "head", "tail", "wc", "sort",
    "xargs", "env", "timeout", "pwd", "whoami", "uptime",
})
SUBCOMMANDS = {
    "git": frozenset({"status", "diff", "log", "show", "add", "commit", "push", "fetch",
                      "pull", "switch", "checkout", "branch", "rebase", "merge",
                      "cherry-pick", "stash", "reset", "rev-parse", "worktree"}),
    "bun": frozenset({"test", "run", "install", "x"}),
    "npm": frozenset({"test", "run", "install", "ci"}),
    "forge": frozenset({"pr", "issue", "api", "repo"}),
    "gh": frozenset({"pr", "issue", "api", "repo"}),
    "tea": frozenset({"pr", "issue", "api", "repo"}),
    "paperclipai": frozenset({"issue", "agent", "run"}),
    "wt": frozenset({"switch", "list", "remove"}),
}
TOOLS = frozenset({"read", "write", "edit", "bash", "grep", "find", "ls", "glob", "webfetch", "task"})

def key_of(tool, args):
    """Emit only fixed allowlisted names, never argument keys or values."""
    if tool != "bash":
        return tool if tool in TOOLS else "<tool>"
    command = args.get("command", "") if isinstance(args, dict) else args
    tokens = WORDS.findall(str(command))
    program = os.path.basename(tokens[0]) if tokens else ""
    program = program if program in PROGRAMS else "<prog>"
    parts = [program]
    kept = 1
    if len(tokens) > 1 and tokens[1] in SUBCOMMANDS.get(program, ()):
        parts.append(tokens[1])
        kept += 1
    if len(tokens) > kept:
        parts.append("…")
    return "bash: " + " ".join(parts)

def skipped_log(skipped):
    skipped[0] += 1
    print("tool-patterns: skipped unreadable or vanished run log", file=sys.stderr)

def calls_in(path, bad):
    """(tool, arg) per tool_execution_start in one run log; bad[0] counts lines that do not parse."""
    chunks = []
    with open(path, encoding="utf-8", errors="replace") as f:
        for n, line in enumerate(f):
            if not line.strip():
                continue
            try:
                o = json.loads(line)
            except ValueError:
                bad[0] += 1
                continue
            if isinstance(o, dict) and o.get("stream") == "stdout" and isinstance(o.get("chunk"), str):
                seq = o.get("seq")
                chunks.append((seq if isinstance(seq, (int, float)) else float("inf"), n, o["chunk"]))
    chunks.sort(key=lambda c: (c[0], c[1]))
    for ev in "".join(c[2] for c in chunks).split("\n"):
        if not ev.strip():
            continue
        try:
            e = json.loads(ev)
        except ValueError:
            bad[0] += 1
            continue
        if isinstance(e, dict) and e.get("type") == "tool_execution_start":
            yield str(e.get("toolName")), e.get("args") or {}

def agent_names():
    """{agentId: name} from the board when its env is set; {} on any failure (never echo the key)."""
    url, key, co = (os.environ.get(k) for k in ("PAPERCLIP_API_URL", "PAPERCLIP_API_KEY", "PAPERCLIP_COMPANY_ID"))
    if not (url and key and co):
        return {}
    req = urllib.request.Request(f"{url.rstrip('/')}/api/companies/{urllib.parse.quote(co, safe='')}/agents",
                                 headers={"Authorization": f"Bearer {key}", "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as r:
            body = json.loads(r.read().decode())
    except Exception as e:  # never echo the key or the body
        print(f"tool-patterns: agent names unavailable ({type(e).__name__}); using agent ids", file=sys.stderr)
        return {}
    if isinstance(body, dict):
        body = body.get("agents", body.get("data"))
    if not isinstance(body, list):
        print("tool-patterns: unexpected agent names shape; using agent ids", file=sys.stderr)
        return {}
    return {a.get("id"): a.get("name") for a in body if isinstance(a, dict)}

def run_logs(root, since, skipped):
    for co in sorted(os.listdir(root)):
        cdir = os.path.join(root, co)
        if not os.path.isdir(cdir):
            continue
        for agent in sorted(os.listdir(cdir)):
            adir = os.path.join(cdir, agent)
            if not os.path.isdir(adir):
                continue
            for f in sorted(os.listdir(adir)):
                p = os.path.join(adir, f)
                if not f.endswith(".ndjson"):
                    continue
                try:
                    recent = os.path.getmtime(p) >= since
                except OSError:
                    skipped_log(skipped)
                    continue
                if recent:
                    yield agent, f[: -len(".ndjson")], p

def collect(root, hours, min_runs, min_seats, names):
    now = time.time()
    since = now - hours * 3600
    bad, skipped = [0], [0]
    groups, seats, runs, calls = {}, {}, set(), 0
    for agent, run, path in run_logs(root, since, skipped):
        try:
            run_calls = list(calls_in(path, bad))
        except OSError:
            skipped_log(skipped)
            continue
        seat = agent
        runs.add(run)
        s = seats.setdefault(seat, {"calls": 0, "runs": set()})
        for tool, arg in run_calls:
            calls += 1
            s["calls"] += 1
            s["runs"].add(run)
            k = key_of(tool, arg)
            g = groups.setdefault(k, {"tool": tool if tool in TOOLS else "<tool>", "calls": 0, "runs": set(), "seats": set()})
            g["calls"] += 1
            g["runs"].add(run)
            g["seats"].add(seat)
    patterns = [{"key": k, "tool": g["tool"], "runs": len(g["runs"]), "calls": g["calls"],
                 "seats": sorted(names.get(agent) or agent for agent in g["seats"]),
                 "candidate": len(g["runs"]) >= min_runs or len(g["seats"]) >= min_seats}
                for k, g in groups.items()]
    patterns.sort(key=lambda p: (-p["runs"], -p["calls"], p["key"]))
    iso = lambda t: datetime.fromtimestamp(t, timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")  # noqa: E731
    return {"schema": SCHEMA,
            "window": {"hours": hours, "since": iso(since), "until": iso(now), "minRuns": min_runs, "minSeats": min_seats},
            "totals": {"calls": calls, "runs": len(runs), "patterns": len(patterns), "badLines": bad[0], "skippedLogs": skipped[0]},
            "seats": sorted(({"name": names.get(n) or n, "calls": v["calls"], "runs": len(v["runs"])} for n, v in seats.items()),
                            key=lambda s: (-s["calls"], s["name"])),
            "patterns": patterns}

def cell(s):
    return str(s).replace("|", "\\|").replace("`", "'").replace("\n", " ")

def markdown(r):
    t, w = r["totals"], r["window"]
    out = [f"# Tool patterns, last {w['hours']}h", "",
           f"{t['calls']} calls, {t['runs']} runs, {t['patterns']} patterns, {t['badLines']} bad lines, {t['skippedLogs']} skipped logs. "
           f"Candidate (*) = runs >= {w['minRuns']} or seats >= {w['minSeats']}.", "",
           "| seat | calls | runs |", "|---|---:|---:|"]
    out += [f"| {cell(s['name'])} | {s['calls']} | {s['runs']} |" for s in r["seats"]]
    out += ["", f"## Top {MD_TOP} patterns by distinct runs", "",
            "| cand | runs | calls | seats | pattern |", "|---|---:|---:|---|---|"]
    out += [f"| {'*' if p['candidate'] else ' '} | {p['runs']} | {p['calls']} | {cell(', '.join(p['seats']))} "
            f"| `{cell(p['key'])}` |" for p in r["patterns"][:MD_TOP]]
    return "\n".join(out) + "\n"

def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--hours", type=float, default=24)
    ap.add_argument("--root", default=DEFAULT_ROOT)
    ap.add_argument("--min-runs", type=int, default=10)
    ap.add_argument("--min-seats", type=int, default=3)
    ap.add_argument("--out", help="JSON report file (default stdout)")
    ap.add_argument("--md", help="markdown table file")
    a = ap.parse_args()
    root = os.path.expanduser(a.root)
    if not os.path.isdir(root):
        print(f"tool-patterns: run-log root not found: {root}", file=sys.stderr)
        return 2
    report = collect(root, a.hours, a.min_runs, a.min_seats, agent_names())
    text = json.dumps(report, indent=2) + "\n"
    if a.out:
        with open(a.out, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        sys.stdout.write(text)
    if a.md:
        with open(a.md, "w", encoding="utf-8") as f:
            f.write(markdown(report))
    t = report["totals"]
    print(f"tool-patterns: {t['calls']} calls, {t['runs']} runs, {t['patterns']} patterns, "
          f"{t['badLines']} bad lines, {t['skippedLogs']} skipped logs", file=sys.stderr)
    return 0

if __name__ == "__main__":
    sys.exit(main())
