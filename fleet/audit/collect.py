#!/usr/bin/env python3
"""collect (sf#1690): one fleet-audit-snapshot/1 JSON for the deterministic audit.
Usage: collect.py --window 4h|24h|7d [--out FILE] [--no-langfuse] [--now ISO]
--now pins the window end (default: the real clock), so a test owns the cutoff.
Env: PAPERCLIP_API_URL, PAPERCLIP_API_KEY (header only), PAPERCLIP_COMPANY_ID;
  LANGFUSE_BASE_URL, LANGFUSE_PUBLIC_KEY, LANGFUSE_SECRET_KEY (basic auth, header only).
All reads are GET. A failed read is an `errors` entry, never an abort. runs = created in
the window plus every queued or running run; issues = issues those runs name plus every
open issue assigned to an agent. The board returns at most RUN_PAGE runs and ignores
offset, so a full company page is re-read per agent; a full agent page is recorded capped.
"""
import argparse
import base64
import json
import math
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

WINDOWS = {"4h": timedelta(hours=4), "24h": timedelta(hours=24), "7d": timedelta(days=7)}
RUN_PAGE = ISSUE_PAGE = 1000  # the board caps a heartbeat-runs page at 1000
OPEN_STATUSES = ["todo", "in_progress", "in_review", "blocked", "backlog"]
LIVE = {"queued", "running"}
MAX_ISSUE_LOOKUPS, MAX_TRACE_LOOKUPS = 1500, 300
MAX_RSS_PAGES = 300  # Langfuse observations pages of 100 `pi-run` spans
WORKERS, TIMEOUT = 8, 20  # parallel GETs; seconds per GET
ISSUE_KEYS = ["id", "identifier", "title", "status", "assigneeAgentId", "createdAt", "updatedAt", "originKind"]

def iso(dt):
    return dt.isoformat(timespec="milliseconds").replace("+00:00", "Z")

def at_or_after(ts, since):
    """True when the ISO timestamp ts is at or after since; a missing or bad ts is False."""
    try:
        at = datetime.fromisoformat(str(ts).replace("Z", "+00:00"))
    except ValueError:
        return False
    return (at if at.tzinfo else at.replace(tzinfo=timezone.utc)) >= since

def origin(url):
    s = urllib.parse.urlsplit(url)
    return s.scheme, s.hostname, s.port

class SameOriginAuth(urllib.request.HTTPRedirectHandler):
    """Follow a redirect, but never carry the Authorization header to another origin."""
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        new = super().redirect_request(req, fp, code, msg, headers, newurl)
        if new is not None and origin(new.full_url) != origin(req.full_url):
            new.remove_header("Authorization")
        return new

OPENER = urllib.request.build_opener(SameOriginAuth)

def fetch(url, auth):
    """GET url as JSON: (body, None) or (None, why). why names a status, never the key or body."""
    req = urllib.request.Request(url, headers={"Authorization": auth, "Accept": "application/json"})
    try:
        with OPENER.open(req, timeout=TIMEOUT) as r:
            return json.loads(r.read().decode()), None
    except urllib.error.HTTPError as e:
        return None, f"HTTP {e.code}"
    except Exception as e:  # never echo the key or the body
        return None, type(e).__name__

class Board:
    def __init__(self, url, key, company):
        self.url, self.auth, self.co = url, f"Bearer {key}", company
        self.errors = []

    def err(self, message, source="board"):
        self.errors.append({"source": source, "message": message})

    def get(self, path, want=list):
        """The JSON at path when it is a `want` (a list keeps its objects only), else an errors entry and want()."""
        body, why = fetch(self.url + path, self.auth)
        if why or not isinstance(body, want):
            self.err(f"GET {path.split('?')[0]} failed: {why or 'unexpected shape'}")
            return want()
        return [x for x in body if isinstance(x, dict)] if want is list else body

    def agents(self):
        out = []
        for a in self.get(f"/api/companies/{self.co}/agents"):
            beat = (a.get("runtimeConfig") or {}).get("heartbeat") or {}
            out.append({"id": a.get("id"), "name": a.get("name"), "status": a.get("status"),
                        "pauseReason": a.get("pauseReason"),
                        "maxConcurrentRuns": beat.get("maxConcurrentRuns", a.get("maxConcurrentRuns"))})
        return out

    def runs(self, agents):
        base = f"/api/companies/{self.co}/heartbeat-runs?limit={RUN_PAGE}"
        page = self.get(base)
        runs = {r.get("id"): r for r in page}
        if len(page) >= RUN_PAGE:
            for a in agents:
                mine = self.get(f"{base}&agentId={urllib.parse.quote(str(a['id']), safe='')}")
                runs.update({r.get("id"): r for r in mine})
                if len(mine) >= RUN_PAGE:
                    self.err(f"runs capped for {a['name']}")
        return list(runs.values())

    def issues(self, ids):
        found = {}
        for status in OPEN_STATUSES:
            page = self.get(f"/api/companies/{self.co}/issues?status={status}&limit={ISSUE_PAGE}")
            if len(page) >= ISSUE_PAGE:
                self.err(f"issues capped for status {status}")
            found.update({i.get("id"): i for i in page
                          if i.get("status") not in ("done", "cancelled") and i.get("assigneeAgentId")})
        todo = [i for i in ids if i not in found]
        if len(todo) > MAX_ISSUE_LOOKUPS:
            self.err(f"issue lookups capped at {MAX_ISSUE_LOOKUPS} of {len(todo)}")
            todo = todo[:MAX_ISSUE_LOOKUPS]
        one = lambda i: self.get(f"/api/issues/{urllib.parse.quote(str(i), safe='')}", dict)  # noqa: E731
        with ThreadPoolExecutor(WORKERS) as pool:
            found.update({got.get("id"): got for got in pool.map(one, todo) if got})
        return [{k: i.get(k) for k in ISSUE_KEYS} for i in found.values()]

    def recovery(self):
        counts = {}
        rows = self.get(f"/api/companies/{self.co}/recovery-observability", dict).get("byCause")
        for n, row in enumerate(rows if isinstance(rows, list) else []):
            try:
                cause, active = str(row.get("cause")), int(row.get("activeCount") or 0)
            except (TypeError, ValueError, AttributeError):
                self.err(f"recovery row {n} malformed, skipped")
                continue
            counts[cause] = counts.get(cause, 0) + active
        return {"activeByCause": counts}

def shape_run(r):
    ctx, use = r.get("contextSnapshot") or {}, r.get("usageJson") or {}
    return {"id": r.get("id"), "agentId": r.get("agentId"), "status": r.get("status"),
            "errorCode": r.get("errorCode"), "wakeReason": ctx.get("wakeReason"), "issueId": ctx.get("issueId"),
            "createdAt": r.get("createdAt"), "startedAt": r.get("startedAt"), "finishedAt": r.get("finishedAt"),
            "inputTokens": use.get("inputTokens"), "outputTokens": use.get("outputTokens"), "traced": None,
            "peakRssKb": None}

def langfuse_auth():
    """(base, Basic auth header) from the env, or None when the URL or a key is unset."""
    base = os.environ.get("LANGFUSE_BASE_URL", "").rstrip("/")
    pub, sec = os.environ.get("LANGFUSE_PUBLIC_KEY", ""), os.environ.get("LANGFUSE_SECRET_KEY", "")
    if not (base and pub and sec):
        return None
    return base, "Basic " + base64.b64encode(f"{pub}:{sec}".encode()).decode()

def trace(runs, since, board):
    """traced on runs finished since `since`: 200 true, 404 false, any other failure an error and null."""
    if (lf := langfuse_auth()) is None:
        return board.err("LANGFUSE_BASE_URL or keys not set", "langfuse")
    base, auth = lf
    done =[r for r in runs if at_or_after(r["finishedAt"], since)]
    if len(done) > MAX_TRACE_LOOKUPS:
        board.err(f"trace lookups capped at {MAX_TRACE_LOOKUPS} of {len(done)}", "langfuse")
        done = done[:MAX_TRACE_LOOKUPS]
    one = lambda r: fetch(f"{base}/api/public/traces/{urllib.parse.quote(str(r['id']), safe='')}", auth)[1]  # noqa: E731
    failed = {}
    with ThreadPoolExecutor(WORKERS) as pool:
        for run, why in zip(done, pool.map(one, done)):
            run["traced"] = True if why is None else False if why == "HTTP 404" else None
            if run["traced"] is None:
                failed[why] = failed.get(why, 0) + 1
    for why, n in sorted(failed.items()):
        board.err(f"trace lookup failed for {n} runs: {why}", "langfuse")

def rss(runs, since, board):
    """peakRssKb from each run's Langfuse `pi-run` span (trace id = run id), paged since `since`.
    UNVERIFIED shape: data[].traceId, data[].metadata.peak_rss_kb_pi_process and meta.totalPages are
    from the Langfuse public API, not probed live; PR 1900, which writes the span, is not deployed.
    A value that is not a finite number >= 0 (bool excluded) stays None: missing is not 0.
    A failed page is one errors entry and stops paging; what was read is kept."""
    if (lf := langfuse_auth()) is None:
        return  # trace() already recorded the missing-keys error
    base, auth = lf
    by_id = {r["id"]: r for r in runs}
    page = 1
    while True:
        q = urllib.parse.urlencode({"name": "pi-run", "fromStartTime": iso(since), "limit": 100, "page": page})
        body, why = fetch(f"{base}/api/public/observations?{q}", auth)
        if why or not isinstance(body, dict) or not isinstance(body.get("data"), list):
            return board.err(f"rss page {page} failed: {why or 'unexpected shape'}", "langfuse")
        for row in (x for x in body["data"] if isinstance(x, dict) and isinstance(x.get("traceId"), str)):
            md = row.get("metadata")
            value = md.get("peak_rss_kb_pi_process") if isinstance(md, dict) else None
            run = by_id.get(row["traceId"])
            if (run is not None and isinstance(value, (int, float)) and not isinstance(value, bool)
                    and math.isfinite(value) and value >= 0):
                run["peakRssKb"] = int(value)
        paging = body.get("meta")
        total = paging.get("totalPages") if isinstance(paging, dict) else None
        if not isinstance(total, int) or page >= total:
            return
        if page >= MAX_RSS_PAGES:
            return board.err(f"rss pages capped at {MAX_RSS_PAGES}", "langfuse")
        page += 1

def main():
    ap = argparse.ArgumentParser(prog="collect.py")
    ap.add_argument("--window", required=True, choices=sorted(WINDOWS))
    ap.add_argument("--out")
    ap.add_argument("--no-langfuse", action="store_true")
    ap.add_argument("--now", type=lambda t: datetime.fromisoformat(t.replace("Z", "+00:00")),
                    help="window end, ISO-8601 with an offset (default: the real clock)")
    args = ap.parse_args()
    if args.now is not None and args.now.tzinfo is None:
        ap.error("--now needs a UTC offset or Z")
    url = os.environ.get("PAPERCLIP_API_URL", "").rstrip("/")
    key, company = os.environ.get("PAPERCLIP_API_KEY", ""), os.environ.get("PAPERCLIP_COMPANY_ID", "")
    if not (url and key and company):
        sys.stderr.write("collect: PAPERCLIP_API_URL, PAPERCLIP_API_KEY and PAPERCLIP_COMPANY_ID are required\n")
        return 2
    since = (now := args.now or datetime.now(timezone.utc)) - WINDOWS[args.window]
    board = Board(url, key, company)
    agents = board.agents()
    runs = [shape_run(r) for r in board.runs(agents)]
    runs = sorted((r for r in runs if r["status"] in LIVE or at_or_after(r["createdAt"], since)),
                  key=lambda r: str(r["createdAt"]))
    issues = board.issues(list(dict.fromkeys(r["issueId"] for r in runs if r["issueId"])))
    recovery = board.recovery()
    if not args.no_langfuse:
        trace(runs, since, board)
        rss(runs, since, board)
    text = json.dumps({"schema": "fleet-audit-snapshot/1",
                       "window": {"label": args.window, "from": iso(since), "to": iso(now)},
                       "collectedAt": iso(datetime.now(timezone.utc)), "agents": agents, "runs": runs,
                       "issues": issues, "recovery": recovery, "errors": board.errors}, indent=1) + "\n"
    if args.out:
        with open(args.out, "w") as f:
            f.write(text)
    else:
        sys.stdout.write(text)
    return 0

if __name__ == "__main__":
    sys.exit(main())
