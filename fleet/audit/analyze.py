#!/usr/bin/env python3
"""analyze.py (sf#1690): a fleet-audit snapshot plus rules.json -> findings JSON and report markdown.

Usage: analyze.py <snapshot.json> [--rules fleet/audit/rules.json] [--json <out>] [--md <out>]

Pure: no network and no clock. Time comes only from the snapshot (window.to). The same input
gives byte-identical output. Thresholds and severities live only in rules.json; this file
implements the rule ids. Findings JSON goes to stdout when --json is absent.
"""
import argparse
import json
import math
import re
import sys
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path

SCHEMA = "fleet-audit-findings/1"
FINISHED = ("succeeded", "failed", "cancelled", "interrupted", "timed_out")
BAD = ("failed", "cancelled", "interrupted", "timed_out")
SEVERITY_ORDER = {"act": 0, "watch": 1}
REVIEW_TITLE = re.compile(r"^Review (\S+/\S+#\d+) @ [0-9a-f]{7}")
EVIDENCE_IN_MD = 5
# rules.json "benchmark"; a key absent from the file takes this default.
BENCHMARK = {"minRuns": 20, "hostMemoryKb": 16777216, "headroom": 0.8, "capacityConstant": 20}


def ts(iso):
    return datetime.fromisoformat(iso.replace("Z", "+00:00"))


def ratio(num, den):
    return round(num / den, 4) if den else 0.0


def check_queue_depth(s, r, name):
    queued = defaultdict(list)
    for run in s["runs"]:
        if run["status"] == "queued":
            queued[run["agentId"]].append(run["id"])
    return [(name(a), len(ids), ids) for a, ids in queued.items() if len(ids) > r["threshold"]]


def check_work_on_paused(s, r, name):
    down = {a["id"] for a in s["agents"] if a["status"] in ("paused", "error")}
    open_on = defaultdict(list)
    for i in s["issues"]:
        if i.get("assigneeAgentId") in down and i["status"] not in ("done", "cancelled"):
            open_on[i["assigneeAgentId"]].append(i["identifier"])
    return [(name(a), len(ids), ids) for a, ids in open_on.items() if len(ids) > r["threshold"]]


def check_fail_rate(s, r, name):
    finished, bad = defaultdict(list), defaultdict(list)
    for run in s["runs"]:
        if run["status"] in FINISHED:
            finished[run["agentId"]].append(run["id"])
            if run["status"] in BAD:
                bad[run["agentId"]].append(run["id"])
    out = []
    for a, ids in finished.items():
        rate = ratio(len(bad[a]), len(ids))
        if len(ids) >= r["minRuns"] and rate > r["threshold"]:
            out.append((name(a), rate, bad[a]))
    return out


def check_issue_churn(s, r, name):
    by_issue = defaultdict(list)
    for run in s["runs"]:
        if run.get("issueId"):
            by_issue[run["issueId"]].append(run["id"])
    return [(name(i), len(ids), ids) for i, ids in by_issue.items() if len(ids) > r["threshold"]]


def check_review_churn(s, r, _):
    by_pr = defaultdict(list)
    for i in s["issues"]:
        m = REVIEW_TITLE.match(i.get("title") or "")
        if m:
            by_pr[m.group(1)].append(i["identifier"])
    return [(pr, len(ids), ids) for pr, ids in by_pr.items() if len(ids) > r["threshold"]]


def check_stale_blocked(s, r, name):
    now = ts(s["window"]["to"])
    stale = defaultdict(list)
    for i in s["issues"]:
        if i["status"] == "blocked" and (now - ts(i["updatedAt"])).total_seconds() / 3600 > r["threshold"]:
            stale[i.get("assigneeAgentId")].append(i["identifier"])
    return [(name(a) if a else "unassigned", len(ids), ids) for a, ids in stale.items()]


def check_unfinished_tokens(s, r, _):
    dead = {i["id"] for i in s["issues"] if i["status"] in ("blocked", "cancelled")}
    total = sum(run.get("inputTokens") or 0 for run in s["runs"])
    hit = [run for run in s["runs"] if run.get("issueId") in dead and run.get("inputTokens")]
    share = ratio(sum(run["inputTokens"] for run in hit), total)
    return [("fleet", share, [run["id"] for run in hit])] if share > r["threshold"] else []


def check_trace_gap(s, r, _):
    known = [run for run in s["runs"] if run["status"] in FINISHED and run.get("traced") is not None]
    gaps = [run["id"] for run in known if run["traced"] is False]
    share = ratio(len(gaps), len(known))
    return [("fleet", share, gaps)] if share > r["threshold"] else []


def check_recovery_active(s, r, _):
    causes = s.get("recovery", {}).get("activeByCause", {})
    total = sum(causes.values())
    return [("fleet", total, sorted(c for c, n in causes.items() if n))] if total > r["threshold"] else []


def check_collection_gap(s, r, _):
    by_source = Counter(e["source"] for e in s.get("errors", []))
    return [(src, n, [src]) for src, n in by_source.items() if n > r["threshold"]]


# The board keeps no status history, so an issue's updatedAt stands in for "todo since".
def check_idle_with_todo(s, r, name):
    now = ts(s["window"]["to"])
    live = {run["agentId"] for run in s["runs"] if run["status"] in ("queued", "running")}
    out = []
    for a in s["agents"]:
        if a["status"] in ("paused", "error") or a["id"] in live:
            continue
        todo = [i for i in s["issues"] if i["status"] == "todo" and i.get("assigneeAgentId") == a["id"]]
        if todo and (now - min(ts(i["updatedAt"]) for i in todo)).total_seconds() / 3600 > r["threshold"]:
            out.append((name(a["id"]), len(todo), [i["identifier"] for i in todo]))
    return out


# Rule id -> check, from the function names: check_queue_depth implements "queue-depth".
CHECKS = {k[6:].replace("_", "-"): f for k, f in list(globals().items()) if k.startswith("check_")}


def totals(s):
    by_agent = {}
    for run in s["runs"]:
        t = by_agent.setdefault(run["agentId"], dict.fromkeys(("runs", "succeeded", "failed", "queued", "inputTokens"), 0))
        t["runs"] += 1
        if run["status"] in ("succeeded", "failed", "queued"):
            t[run["status"]] += 1
        t["inputTokens"] += run.get("inputTokens") or 0
    by_status = Counter(run["status"] for run in s["runs"])
    return {"runs": len(s["runs"]), "byStatus": dict(sorted(by_status.items())), "byAgent": dict(sorted(by_agent.items()))}


def rss_row(values, min_runs):
    """Nearest rank on the sorted values: sorted[ceil(q*n)-1]. Under min_runs: no percentiles."""
    v, n = sorted(values), len(values)
    if n < min_runs or n == 0:
        return {"n": n, "insufficient": True}
    return {"n": n, "p50": v[math.ceil(0.5 * n) - 1], "p95": v[math.ceil(0.95 * n) - 1], "max": v[-1]}


def benchmark(s, cfg, name):
    """Peak RSS (KB) per seat and fleet-wide. A run with no int peakRssKb >= 0 is missing, never 0."""
    by_seat = defaultdict(list)
    for run in s["runs"]:
        kb = run.get("peakRssKb")
        if isinstance(kb, int) and not isinstance(kb, bool) and kb >= 0:
            by_seat[name(run["agentId"])].append(kb)
    fleet = rss_row([kb for vs in by_seat.values() for kb in vs], cfg["minRuns"])
    out = {"minRuns": cfg["minRuns"], "fleet": fleet,
           "bySeat": {seat: rss_row(vs, cfg["minRuns"]) for seat, vs in sorted(by_seat.items())}}
    if not fleet.get("insufficient") and fleet["p95"] > 0:
        out["capacity"] = {"measured": math.floor(cfg["headroom"] * cfg["hostMemoryKb"] / fleet["p95"]),
                           "constant": cfg["capacityConstant"]}
    return out


def labels(s):  # agent id -> name, issue id -> identifier (both are board UUIDs)
    out = {i["id"]: i.get("identifier") or i["id"] for i in s["issues"]}
    out.update({a["id"]: a.get("name") or a["id"] for a in s["agents"]})
    return out


def analyze(s, rules, bench_cfg=None):
    label = labels(s)
    findings = []
    for r in rules:
        if r["id"] not in CHECKS:
            raise SystemExit(f"analyze.py: unknown rule id {r['id']!r} in rules file")
        for subject, value, evidence in CHECKS[r["id"]](s, r, lambda x: label.get(x, x)):
            findings.append({"rule": r["id"], "severity": r["severity"], "subject": subject, "value": value,
                             "threshold": r["threshold"], "evidence": sorted(evidence)})
    findings.sort(key=lambda f: (SEVERITY_ORDER[f["severity"]], f["rule"], f["subject"]))
    cfg = {**BENCHMARK, **(bench_cfg or {})}
    return {"schema": SCHEMA, "window": s["window"], "totals": totals(s), "findings": findings,
            "benchmark": benchmark(s, cfg, lambda x: label.get(x, x))}


def markdown(report, label):
    w = report["window"]
    lines = [f"# Fleet audit {w['label']}: {w['from']} to {w['to']}", "",
             "| agent | runs | succeeded | failed | queued | input tokens |", "|---|---|---|---|---|---|"]
    for a, t in report["totals"]["byAgent"].items():
        cells = [label.get(a, a)] + [str(t[k]) for k in ("runs", "succeeded", "failed", "queued", "inputTokens")]
        lines.append("| " + " | ".join(cells) + " |")
    for sev, head in (("act", "Act"), ("watch", "Watch")):
        rows = [f for f in report["findings"] if f["severity"] == sev]
        lines += ["", f"## {head}", ""] + [
            f"- {f['rule']} -- {f['subject']}: {f['value']} ({f['threshold']}) -- {', '.join(f['evidence'][:EVIDENCE_IN_MD])}"
            for f in rows] + ([] if rows else ["- none"])
    b = report["benchmark"]
    lines += ["", "## RSS benchmark", "",
              "Pi process RSS only, bash children excluded; capacity is an upper bound.", "",
              "| seat | n | p50 kb | p95 kb | max kb |", "|---|---|---|---|---|"]
    for seat, row in list(b["bySeat"].items()) + [("fleet", b["fleet"])]:
        cells = ([f"insufficient data (n={row['n']})", "", ""] if row.get("insufficient")
                 else [str(row[k]) for k in ("p50", "p95", "max")])
        lines.append("| " + " | ".join([seat, str(row["n"])] + cells) + " |")
    if "capacity" in b:
        c = b["capacity"]
        lines += ["", f"capacity at measured p95: {c['measured']} | hand-set constant: {c['constant']}"]
    return "\n".join(lines) + "\n"


def main():
    p = argparse.ArgumentParser(description="Analyze a fleet-audit snapshot.")
    p.add_argument("snapshot")
    p.add_argument("--rules", default=str(Path(__file__).with_name("rules.json")))
    p.add_argument("--json", dest="json_out")
    p.add_argument("--md", dest="md_out")
    a = p.parse_args()
    s = json.loads(Path(a.snapshot).read_text())
    if s.get("schema") != "fleet-audit-snapshot/1":
        raise SystemExit(f"analyze.py: snapshot schema is {s.get('schema')!r}, want fleet-audit-snapshot/1")
    cfg = json.loads(Path(a.rules).read_text())
    report = analyze(s, cfg["rules"], cfg.get("benchmark"))
    body = json.dumps(report, indent=2, ensure_ascii=False) + "\n"
    Path(a.json_out).write_text(body) if a.json_out else sys.stdout.write(body)
    if a.md_out:
        Path(a.md_out).write_text(markdown(report, labels(s)))


if __name__ == "__main__":
    main()
