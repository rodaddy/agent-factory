---
name: board-sweep
description: "Every hour, clear the blocked inbox by rule with the board-sweep script: stale reviews and duplicate routine instances cancelled with a comment, red-check reviews kicked back, stalled reviews kickstarted by priority within each reviewer's free run slots, the live review and finished parents unblocked, Nagatha's tasks handed to her, the rest decided one by one. Dry run first, counts posted before and after."
---

# board-sweep

Nobody clears the blocked inbox by hand (Rico, 2026-10-03, sf#1338: 615
tasks blocked that night). Run by the hourly routine `Board sweep`, which
creates the board issue `Board sweep <YYYY-MM-DD HH>` and assigns it to you.

## Steps

0. Publish the failed-runs feed (SOF-12351). Nagatha's seat cannot read
   the board's heartbeat runs through its bridge; it reads them from the
   standing issue [SOF-12407](/SOF/issues/SOF-12407):
   `~/fleet/skills/infra-health/bin/infra-health runs --publish SOF-12407; echo "exit $?"`
   It posts at most one comment an hour and prints `published: false` when
   this hour's comment is already there. Exit 1: post its one stderr line on
   your issue and go on. The sweep never waits on the feed. That comment is
   one cross-issue write, so steps 1 and 3 run with
   `BOARD_SWEEP_MAX_WRITES=17` (see step 3).
1. Dry run, no pipe, so the exit code is real:
   `BOARD_SWEEP_MAX_WRITES=17 ~/fleet/skills/board-sweep/bin/board-sweep > plan.json; echo "exit $?"`
   Exit 3: your environment is missing a variable; set the issue blocked with
   the message and stop.
2. Read the plan. Comment on your issue: `blocked_before` and the count per
   action. Check it against the rules below; if a planned cancel breaks a
   rule, set the issue blocked with the item and the rule, and stop. That is
   a bug in the script, not something to work around.
3. Apply: `BOARD_SWEEP_MAX_WRITES=17 ~/fleet/skills/board-sweep/bin/board-sweep --apply > done.json; echo "exit $?"`.
   Comment `blocked_before`, `blocked_after`, the counts and `errors`.
   Each `errors` item now carries the HTTP status and reason of the failed
   write, so post `error_codes` with its counts too.
   The board allows one run 20 cross-issue comments plus status updates
   (SOF-10747). The script spends at most `BOARD_SWEEP_MAX_WRITES` (default
   18; 17 here, because step 0 spent one), most important items first, and stops at once on the board's cap
   429. A retry never spends the room its item's status write needs
   (SOF-10912). What it did not reach is `next-pass` (with `planned`, and
   `partial` when its comment went out, naming the cap or the write
   budget): not an error, exit 0. Post `writes` and
   `stopped`, and leave those items alone; the next hourly pass takes them.
4. Work the items the script leaves to you:
   - `nagatha`: one board task for Nagatha listing them, unless an open
     `Blocked infra tasks` task for her already exists; then comment on it.
   - `merge-check`: run `merge-check <owner/repo> <n> <head-sha40>` for each;
     act per `review-dispatch` step 5, or comment the result on the item.
   - `waiting-author`: a triage waiting on its author's answers.
     Leave it; the script sets it back to todo when the author replies.
   - `other`: decide each one: unblock it (status todo) with a comment saying
     what unblocked it, cancel it with a comment saying why, or file a Forge
     issue and link it. Leave one blocked only with a comment naming who it
     waits on.
5. Set your issue done.

## The rules the script applies

- A review task is cancelled when its PR is closed or merged, or its head
  moved. Of the reviews with the same exact title for the live head, the
  newest is a todo candidate (see the queue below) and the older ones are
  cancelled.
- A routine keeps at most one open instance: the newest. Older blocked
  instances are cancelled.
- A merge follow-up for a closed or merged PR is cancelled.
- A blocked parent whose children are all done or cancelled is set todo.
- A blocked `Triage <owner/repo>#<n>` goes back to todo when the issue's
  author has commented since the task last changed; it is cancelled when the
  issue is closed.
- Nagatha's tasks are never touched.
- Every status change carries a comment saying why, posted first.

## Stalled reviews and the queue

Every open review task -- `todo`, `in_progress` or `blocked`, the lead's
`Review <repo>#<n> @ <sha>` and the reviewer sub-tasks -- is checked:

1. `kickback`: a required check (`factory/smoke`, `factory/prepush`) is
   `failure` or `error` at the reviewed sha. The PR gets one
   `REVIEW KICKBACK:` comment per sha; the task is cancelled with the same
   reason. The author fixes and pushes; the new head gets a new review.
2. `kickstart`: a `todo` or `in_progress` review untouched for 30 minutes
   (`BOARD_SWEEP_STALL_MIN`) with no queued or running run of its own is
   commented and set todo, which wakes its assignee. A blocked review waits
   on its children; the children are checked instead.
3. `escalate`: stalled again after two kickstarts the board accepted (a
   refused todo leaves a `kickstart-refused` comment and does not count). The task gets one comment
   and Bishop gets one high-priority `Stalled review: <title>` issue (never
   Rico); while that issue is open the task is listed, not touched.
4. The queue: kickstarts and blocked-review releases go out by priority
   (critical, high, medium, low; then the lowest `pri:N` label; then oldest).
   Each assignee takes at most its free run slots (`maxConcurrentRuns` minus
   its queued and running runs, read from live-runs; a full 50-row page
   counts as 50); one with no free slot still takes its first kickstart. If
   a run read fails, nothing is kickstarted or released that pass. The rest show as `review-next-pass` with
   `queued: priority <p>, position <k>`, and `queue` lists the first 20.
   Leave them alone: the next pass takes them as slots free up.

The procedure does not change: dry run first, read it, then `--apply`.

## Never

Cancel without a comment. Cancel or unblock Nagatha's tasks. Run `--apply`
before reading the dry run. Make Rico go through the list.
