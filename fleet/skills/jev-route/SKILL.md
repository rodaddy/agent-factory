---
name: jev-route
description: "RETIRED from review dispatch; no seat holds it. Reads a PR's touched paths, size, last verdict, and senior load, plus an advisory Jev pr-review-depth reading, and names senior or junior."
---

# jev-route

**Retired from review dispatch.** Every review is one
Anthropic and one GPT reviewer (`review-dispatch`), so no seat runs this to
pick one reviewer or two, and no seat holds the skill. It does not post
anything; it only reads the PR from Forge.

```
fleet/skills/jev-route/bin/jev-route <owner/repo> <pr-number> [--last-verdict V] [--seniors-loaded]
```

Env: `FORGEJO_API_URL`, `FORGEJO_TOKEN` (sent as a header only, never printed).
`TYPESAFE_API_KEY` (the same key `src/jev/client.ts` uses) is optional; without it Jev is not asked and the deterministic answer stands.

## Rule order

1. Any senior factor -> **senior**. Senior factors: a touched path matching
   auth/secret/credential/token, migrations, deploy/k8s/manifests or
   `.forgejo/workflows/`, review rules (`skills/review-dispatch`, `skills/review-pr`,
   `scripts/actions/*review*`), or a large diff (over 20 files or 800 lines).
   Secrets and deploy paths also set `humanRequired: true`.
2. Else last verdict `approve-with-fixes` or `--seniors-loaded` -> **junior**.
3. Else -> **senior**.

Jev (the `config/jev/classifiers/pr-review-depth.json` question, same
instructions and criteria) is advisory: a confident `high` reading can raise a
junior answer to senior; it never lowers one.

**How many reviewers** (The operator, 2026-10-06: the obviously fine need one
reviewer, not two). `reviewers` is `1` when step 1 did not fire (no senior
factor, no `humanRequired`), the last verdict is not `fix-first`, and either
Jev answered `confident: true` with `level: low`, or the change is docs only
(`depth: LIGHT`) and Jev is `unavailable`. Everything else is `2`: any senior
factor, Jev `medium` or `high`, Jev not confident (docs only included: any
Jev reading other than a confident `low` is a disagreement), Jev
`unavailable` on a non-LIGHT change, or a last verdict of `fix-first`.

## Reading the output

One JSON line:

```json
{"pair":"senior","depth":"FULL","humanRequired":true,"reasons":["senior: deploy (.forgejo/workflows/x.yml)"],"jev":"unavailable","reviewers":2}
```

- `pair` -- the pair to assign.
- `depth` -- `FULL` (any senior factor), `LIGHT` (docs only), else `STANDARD`.
- `humanRequired` -- true means a human signs off as well; do not merge on the
  pair's verdict alone.
- `reasons` -- every factor that fired; quote them in the review-start comment.
- `jev` -- `{level, score, confidence, confident}` or `"unavailable"`.
  `unavailable` is NO SIGNAL, never a pass: route on the deterministic answer.
- `reviewers` -- `1` or `2`, per the rule above. Advisory only since
  2026-10-08: dispatch always files the pair.

Non-zero exit means Forge could not be read: stop and report it, do not guess
a pair. Before it exits, a failed name lookup or a refused connection is
retried twice, about 25 s apart; an HTTP status such as 401, 403 or 404 is not.
The error line names the reason (`URLError: [Errno -3] Temporary failure in
name resolution`, `HTTPError: Not Found`); quote it in the report.
