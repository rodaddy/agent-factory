---
name: fix-flaky-test
description: "A required check failed on a test the pull request never touched. Greene (CI Engineer) owns and fixes flaky tests: he reproduces the failure, decides whether the test or the code is wrong, and fixes the test in its own pull request or files the product bug. Hand off only for a reason named in this skill. Never skip, loosen, retry, or waive."
---

# fix-flaky-test

A flaky test blocks every pull request that meets it, not only the one that
found it. This skill finds out why and fixes the right thing.

## Spec-ready before implementation dispatch

Before creating, assigning, reopening, or handing back implementation or repair
work, follow `delegate-work`, "Spec-ready before implementation dispatch".
Use `spec-ready` and `task-new`; a hold queues one unassigned spec-writing step
instead of sending the work to a seat. Diagnosis and review keep their own paths.

## Who does what

- **Greene (CI Engineer) owns and fixes flaky tests**, per `ci-red-check`
  and his agent card. Work on the existing repair task; never duplicate it.
- A reviewer or test author already assigned by `review-dispatch` step 5 may keep the
  repair when their knowledge of the test is needed. Record that reason on
  the task; otherwise take ownership as Greene and follow the steps below.
- A real product bug belongs to Bishop, per "The code is wrong" below.
- Greene checks a handed-off fix against "Checking the fix"; his own fix
  goes through `open-pr` and its reviewer pair.

## When

A required check failed on a pull request and any one of these holds:

- the failing test is outside the pull request's diff: neither the test file
  nor the code it exercises is touched by the pull request;
- the same test failed on another pull request's head too;
- a re-run of the same head passes.

## Repair task (Greene)

1. Name the test (file and test name) and link the failed run and job.
2. Find the existing board task `Flaky test: <owner/repo> <test name>` on
   Smythe's review issue. Link it on the `Checks not green:` task; do not
   create another repair task. Missing link: ask Smythe and keep the
   classification task blocked until the existing task is linked.
3. If the repair is assigned to a reviewer or test author, Greene comments
   on the existing task asking whether the assignee will keep it for the
   knowledge reason above; he reassigns it to himself only after the assignee
   agrees or does not answer by the next sweep.
   Record ownership or the handoff reason on the existing task, then follow
   the steps below.

## Steps (Greene, or the assignee for a named handoff)

1. `ensure-project <owner/repo>` and work in its checkout on a clean default
   branch. Reproduce:
   - run that one test 20 times and record passes and failures;
   - run it 20 more times under load on Forgejo Actions and record passes
     and failures. Never run a full suite or full build on the employee box.
   Run each with no pipe so the exit code is real. Keep the counts.
2. Read the test and the code it exercises, and decide which one is wrong.
3. Cannot reproduce or cannot decide after both runs: set the task blocked
   with what you ran and the counts. Ask Simms (Git Lead, Greene's manager)
   for the unresolved decision; do not pass the repair to an arbitrary seat.

### The test is wrong

Typical causes: a fixed sleep waiting for background work, wall-clock timing,
order dependence, state shared between tests, a real network call, unseeded
randomness. Fix the TEST per the testing rule (`_DOCS/STANDARDS-testing.md`,
rodaddy/development PR 891):

- wait on the event itself, not on time: use `until()` from
  `tests/support/wait-until.ts` where the repo has it;
- drive time from a clock the test owns;
- give each test its own state.

Prove it: in a temporary copy, slow the fake or step 20 to 50 ms so the old
test fails, and show the new test passing 20 runs in a row. Open the fix as
its own pull request per `open-pr`, on a branch `test/flaky-<slug>`, titled
like `test: <test name> waits on <event>`, with the reproduction counts and
the proof in the body. Link it on the task.

### The code is wrong

The test caught a real race or bug in product code, so the test is right. Do
NOT change the test. File a Forge issue with the reproduction counts and the
evidence, create a board task for Bishop (CTO) linking it, and link both on
the task.

## Checking the fix (Greene)

Accept the fix pull request only when all hold, else send it back on the task
with the exact rule it breaks:

- it waits on the event or a test-owned clock; no fixed sleep remains;
- no assertion is weakened, removed, or widened;
- the slow-down proof and the 20-run counts are in the body.

## Never

Skip the test, mark it `.todo`, quarantine it, delete it, or loosen its
assertion. Raise a timeout as the fix. Add retries. Re-run until green and
call it fixed. Touch the pull request that hit the flake. Waive the check.
