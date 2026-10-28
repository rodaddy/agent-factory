# Model resolver: the cheapest live model that meets the role

Status: WRITTEN, not built. Spec only; no code exists for any ticket below.
Record: sf#1047.

## Why

- "We definitely shouldn't have it hard coded in any way, shape or form, we should have it be a call and then that JSON
  becomes what they can pick from."
- "Should use the most cost-effective model at the lowest price, ideally, and then we should evaluate on a daily or
  weekly basis what works well and what sucks dick."
- "Honestly, we don't need to use Bifrost if we're putting in the logging and the tracing directly into Pi. The reason
  we were using Bifrost was to try to get the extra tracing."
- "If we want that information and it's not there, then we should tell whoever did the change, which I believe is
  development, to add the pricing based off of the known information that we can gather. We're going to use API pricing
  for what we're going to put in there, even though we know that all of these are subscriptions." (2026-10-06)
- "But I would like everything to be able to come directly from the V1 models call." (2026-10-06)
- Haiku is never used. Family rule vs Jev: either was fine; cost now leads.

Pick rule: a role names a REQUIREMENT (a capability tier and an effort, or a family floor), never an id. The resolver
takes the live list from `/v1/models` on the proxy, drops Haiku and anything the scoreboard (T6) has benched, keeps the
models that meet the requirement, and picks the CHEAPEST. Ties: newest (`created`). Nothing meets it = fail closed. One
endpoint for every consumer, Pi seats included; Bifrost is not a resolver endpoint.

## Facts checked

### 2026-10-06 (this lane; supersedes the 2026-10-05 shape and price bullets below)

- `curl -s https://subs.example.internal/v1/models` -> 200, no key. Top-level keys: `object`, `generated_at`, `provider`
  (`{"api": "openai-completions", "baseUrl": "https://subs.example.internal/v1"}`), `data` (28 entries).
- A text-model entry (checked on `gpt-6.1-sol`) carries `aliases, api, contextWindow, cost, cost_basis, created,
  deprecated, efforts, family, id, input, name, object, owned_by, price, reasoning, sources, thinkingLevelMap, tier`;
  Claude entries also carry `maxTokens`. GPT entries do not yet.
- `family` is served: `gpt-6.1-sol` -> `gpt-sol`, `claude-opus-5-5` -> `claude-opus`, `gpt-6-luna` -> `gpt-luna`,
  `claude-sonnet-5-5` -> `claude-sonnet`, `grok-4.7` -> `grok`. `deprecated` is `false` on all 28.
- `tier` today is the family short name (`sol`, `opus`, `luna`, `image`, `video`, `grok`, `other`), NOT a top/mid/fast rank.
  The catalog carries no capability rank.
- `price` is API list USD per Mtok `{input, output, cacheRead[, cacheWrite]}`, e.g. `gpt-6.1-sol` 2/10, `claude-opus-5-5`
  4/20, `claude-sonnet-5-5` 2/10, `claude-fable-5-1` 10/50, `gpt-6-luna` 0.1/0.5. `cost` is zeros (subscription).
- Price coverage (re-checked after sub-switcher #39, main 64cd77a): every frontier text model is priced, including
  `gpt-6-astra` 10/50 and `grok-4.7` 2/6. Image and video entries carry `price.unit` `image` or `second`. No public price,
  never picked: `codex-auto-review`, `gpt-image-2.5`, `grok-3-mini`, `grok-3-mini-fast`, `grok-4.7-build-fast`,
  `grok-composer-2.5-fast`, `grok-imagine-video-1.5-preview`.
- The 28 ids: `claude-fable-5-1 claude-opus-5-5 claude-sonnet-5-5 codex-auto-review gpt-6-astra gpt-6-luna gpt-6.1-sol
  gpt-image-2.5 gpt-image-2.5-flare gpt-image-2.5-sunburst grok-3-mini grok-3-mini-fast grok-4.20-0309-non-reasoning
  grok-4.20-0309-reasoning grok-4.20-multi-agent-0309 grok-4.3 grok-4.5 grok-4.6 grok-4.7 grok-4.7-build-fast
  grok-build-0.1 grok-composer-2.5-fast grok-imagine-image grok-imagine-image-2.0 grok-imagine-image-quality
  grok-imagine-video grok-imagine-video-1.5 grok-imagine-video-1.5-preview`. Haiku, `gpt-5.5` and `gpt-5.6-terra` are gone.
- SERVED 2026-10-06 (sub-switcher #39, checked live): `class` (`top | mid | fast`) — opus, fable, sol, astra and
  grok-4.7 `top`; sonnet `mid`; luna and the grok mini/fast ids `fast`; image, video and other entries carry none.
  `maxTokens` 128000 on sol, luna and astra. Prices refresh from OpenRouter's public `/api/v1/models`; field shapes stay.
- Pi's model schema (Pi docs `models.md`) uses the same names: `name, reasoning, thinkingLevelMap, input, contextWindow,
  maxTokens, cost`. Missing `reasoning` defaults to false, `contextWindow` to 128000, `maxTokens` to 16384.

### 2026-10-05

- `GET https://subs.example.internal/v1/models`, no key: 200, 31 ids.
- `GET https://codex-proxy.example.internal/v1/models` (the host every Actions lane calls as `ENGINE_URL`), no key: 200, the
  SAME 31 ids. Sorted: `claude-fable-5-1 claude-haiku-4-5-20251001 claude-opus-5-5 claude-sonnet-5-5 codex-auto-review
  gpt-5.5 gpt-5.6-terra gpt-6-astra gpt-6-luna gpt-6.1-sol gpt-image-2.5 gpt-image-2.5-flare gpt-image-2.5-sunburst
  grok-3-mini grok-3-mini-fast grok-4.20-0309-non-reasoning grok-4.20-0309-reasoning grok-4.20-multi-agent-0309 grok-4.3
  grok-4.5 grok-4.6 grok-4.7 grok-4.7-build-fast grok-build-0.1 grok-composer-2.5-fast grok-imagine-image
  grok-imagine-image-2.0 grok-imagine-image-quality grok-imagine-video grok-imagine-video-1.5
  grok-imagine-video-1.5-preview`.
- SUPERSEDED by the 2026-10-06 block: each entry carried exactly `created`, `id`, `object`, `owned_by`, NO price field.
- DEAD PINS: `gpt-5.6-sol`, `gpt-5.6-luna` and `claude-opus-5` are pinned in live code but are NOT in the proxy list.
  This is the failure mode the resolver removes: a pin goes stale silently.

## 1. Inventory of model pins

Command (scope fixed by the brief):
`rg -n -e 'gpt-[0-9]' -e 'claude-(opus|sonnet|fable|haiku)' -e 'grok-' src scripts fleet .forgejo config --glob '!**/transcripts/**'`
-> 79 matching lines in 35 files. Plus `packets/issue-triage.md:6` (`model: gpt-5.6-sol`), outside the command's scope but a
live pin. Grouped by consumer; "endpoint" is what the pinned id is sent to.

| # | Consumer | Pins (path:line) | Lines | Endpoint | Class |
|---|---|---|---|---|---|
| A | Actions lanes | `.forgejo/workflows/implement.yml:197` `MODEL: gpt-5.6-sol` (dead); `pr-review.yml:141`, `issue-triage.yml:100` `ENGINE_MODEL: gpt-6.1-sol`; comment `implement.yml:190` | 4 | proxy, `codex-proxy.example.internal` | live pin |
| B | Actions render defaults + their checks | `scripts/actions/render-pr-review.ts:240`, `render-issue-triage.ts:82` `DEFAULT_ENGINE_MODEL = "gpt-6.1-sol"`; `scripts/done-means/pr-review-actions-424.sh:144`, `issue-triage-actions-424.sh:168` assert it | 4 | proxy | live pin + check |
| C | Runner route table | `src/runner/route.ts:33-36` (4 routes: `gpt-5.6-sol` x3 dead, `gpt-5.6-terra`), `:85-90` luna-at-max rule keyed on `gpt-5.6-luna`; `src/runner/script-route.ts:47` `SCRIPT_ROUTE gpt-5.6-luna` (dead); `src/packets/scaffold.ts:59`; `packets/issue-triage.md:6` | 10 | proxy (`ENGINE_ENDPOINTS.cliproxyapi`, `src/runner/engine-endpoints.ts:20`) carried to a runner box | live pin |
| D | Route checks/fixtures | `scripts/done-means/runtime-default-283.sh` (13), `fixtures/runtime-default-283-stub.ts` (6), `runtime-default-283.probe.ts` (2, incl. dead `claude-opus-5`) | 21 | none (assert C's table) | check/fixture |
| E | Fleet seat switcher | `fleet/bin/claude-proxy:37-38,78,81` `MODELS = (5 ids)`, `BACK_MODEL claude-opus-5-5` | 4 | proxy `codex-proxy.example.internal` or Bifrost (`--via`) as Anthropic base for Claude Code seats | live allowlist |
| F | Fleet labels and prompts | `fleet/board/agents.json` (11), `crew.json:40`, `plugins/crew/roster.data.js:44`, `fleet/agents/*/AGENTS.md` (9 lines, 8 files), `fleet/skills/company-conduct/SKILL.md:160-164` | 27 | none (display/prompt text; the real model is the Paperclip adapter config, not in repo) | label |
| G | Comments and docstrings | `scripts/actions/call-engine.ts:57`, `src/reconcile/reclaim.ts:653`, `src/runner/dispatch-reap.ts:81`, `src/db/schema.ts:307`, `src/packets/schema.ts:127`, `src/observability/attempt-observer.ts:10`, `event-stream.ts:30,534`, `fleet/plugins/run-trace/logic.js:205` | 9 | none | comment |
| H | Jev fixture | `config/jev/classifiers/pr-review-depth.json:71` (a diff body quoting a session report) | 1 | none | fixture |

Pi seats carry no pin in this repo today: the box's shared `~/.pi/agent/models.json` hand-lists 4 models routed through
Bifrost (out of repo). Phase 1 P1.2c (amendment on branch `docs/p1-seat-models-ruling`, unmerged) moves each seat's
`models.json` to the proxy's live `https://subs.example.internal/v1/models`, no Bifrost. T4 makes that generator call this
resolver for the seat's default.

Login-path pins (ChatGPT-login Codex). This grep finds ZERO pins whose endpoint is a ChatGPT login. The one login-path
consumer is the runner-box Codex (its revoked login is sf#985, `config/repos.yml:46`); it receives its model from group C
in the submission. Handling: the proxy resolver does not apply to a login, and no login list is fetched. T3 resolves group
C against the proxy (the endpoint the submission names); if a box's login rejects a proxy-resolved id the dispatch fails
closed and is reported, never retried with another id. The box lane is being retired under #830, so no login-path
resolver is designed.

## 2. Design

### 2.1 Ids are opaque; the catalog says what a model is

No id is parsed, split or version-compared. Every fact the resolver needs is a field of the `/v1/models` entry:

- Family: the entry's `family` (`gpt-sol`, `claude-opus`, `gpt-luna`, ...).
- Newest in a family: the highest `created` among entries with that `family`.
- Exclusion: `deprecated: true`, or a `family` containing `haiku`. Applied inside `pick` and `--list`, no opt-out.
- A route prefix on an id (`claudex-oai/gpt-6.1-sol`) is carried as part of the opaque id, never interpreted.

A new id in a known family qualifies with no edit here; a model the catalog does not describe cannot be picked.


### 2.2 Requirement and pick (pure)

A role in `config/model-roles.yml` names a requirement and an effort, never an id. There is no `tiers:` map in this repo:

```yaml
endpoint: { base: https://subs.example.internal }      # one endpoint; workflows override with their own ENGINE_URL
roles:
  pr-review:       { tier: top,  effort: high }
  issue-triage:    { tier: mid,  effort: medium }
  implement-issue: { tier: top,  effort: high }
  infra-static:    { tier: mid,  effort: medium }
  script:          { tier: fast, effort: max }
  back:            { family_floor: [claude-opus], effort: high }   # catalog `family` values that qualify
```

The rank comes from the catalog field `class` (`top | mid | fast`, served since 2026-10-06). Classes are ordered `fast < mid < top`; a model meets `tier: mid` if its `class` is mid or top. An entry
with no `class` is ineligible (listed, never picked). The loader rejects any role naming `haiku`, any value containing a
digit-bearing id in place of a family, and a `tier: fast` role whose effort is not `max` (L-042; open question 3).

`pick(entries, requirement, scoreboard) -> id`, in this order:
1. Drop `deprecated: true` and any `family` containing `haiku`; drop every (role, `family`) the scoreboard benches.
2. Keep the entries that meet the requirement (`class` rank, or `family` in `family_floor`).
3. Within a `family` keep only the entry with the highest `created`, so an older model never competes with a newer one in
   its family.
4. Read each survivor's `.price`. No `price` = unpriced = ineligible for the automatic pick (2.3).
5. Cheapest blended price wins (blend: open question 4). Tie: higher `created`. Still tied: AMBIGUOUS, fail closed.

Worked example on the served 2026-10-06 catalog (`class`, and `.price` input/output USD per Mtok). `tier: top` keeps
`gpt-6.1-sol` 2/10, `grok-4.7` 2/6, `claude-opus-5-5` 4/20, `claude-fable-5-1` 10/50, `gpt-6-astra` 10/50; with the 3:1
blend `grok-4.7` (3.0) beats `gpt-6.1-sol` (4.0) -> `grok-4.7`, unless a role's `family_floor` or the scoreboard rules
grok out (blend = (3 x input + output) / 4). `tier: mid` adds `claude-sonnet-5-5` 2/10 (4.0) and still picks
`grok-4.7`; with grok excluded, sonnet and sol tie at 4.0 and `created` breaks it (1790640000 vs 1790553600) ->
`gpt-6.1-sol`. `tier: fast` -> `gpt-6-luna` 0.1/0.5 (the grok fast ids are unpriced, so ineligible).

Typed errors, each carrying the role, the requirement and the list size: `ModelListUnavailableError`,
`NoEligibleModelError` (lists what was dropped and why: deprecated or excluded, benched, below class or no `class`,
unpriced), `AmbiguousPickError`. No default id anywhere: an error is the only non-id outcome.

### 2.3 Price source: the catalog `.price`

Price is read from each entry's `.price`, at API list rates, USD per Mtok, even though actual spend is flat
subscriptions: the list price is a RELATIVE cost signal, which is what "cheapest" needs. An entry without `price` is
unpriced and ineligible; the fix is the catalog (the Development head fills it from known API rates), never a table in
this repo. Today every frontier text model is priced; the unpriced ids are listed in Facts checked 2026-10-06.

The 2026-10-05 candidate survey is SUPERSEDED, one line each:

- Proxy `/v1/models`: was "no price field"; superseded, it now serves `price`.
- Langfuse `GET /api/public/models` and its sf#1257 `gpt-` skip: superseded, no Langfuse price lookup in the resolver.
- rtech-infra `model-prices.json` (exact-id rate table): superseded, the catalog is the single source.
- `fleet/bin/claude-proxy`, CLIProxyAPI, Bifrost `pricing_overrides`, Langfuse server-side pricing: never usable, unchanged.

### 2.4 Modules (owning boundary: `src/models/`)

- `resolve.ts` (pure): `pick`, `EXCLUDED_FAMILY_SUBSTRINGS = ["haiku"]`, the typed errors. `parseModelId` superseded, removed
  (superseded by 2.1).
- `fetch.ts`: `fetchModels(base) -> Entry[]`; `GET <base>/v1/models`, 5 s timeout. Each entry is validated with the
  repo's existing validator as `{id, family, created, deprecated, price?, class?, ...}`; unknown keys are kept and passed
  through untouched. Non-200, timeout, bad shape or empty list -> `ModelListUnavailableError`. In-process cache per base,
  TTL per open question 2. There is no `price.ts` adapter (superseded by 2.3): price is read from the entry.
- `scoreboard.ts`: reads the T6 scoreboard file; a missing file means nothing benched; a malformed file is an error.
- `scripts/resolve-model.ts <role> [--base <url>] [--list] [--explain]`: prints exactly one id and a newline on stdout;
  `--list` prints every non-excluded id with its `family`, `class` and price or `unpriced` (what a picker offers);
  `--explain` prints the drop reasons to stderr. Exit 0 printed; 2 usage; 3 any typed error, message on stderr, NOTHING
  on stdout.

## 3. Tickets (each ≤ 400 changed lines; acceptance RED first)

Traps restated for every ticket: never pipe a check through `tail`/`head` when its exit code matters; mutation-test every
new test (break the code, watch it go red); a worker's green is PROPOSED until the head reruns the commands; verify the
endpoint by calling it, not by reading config; `job_attempts.status = 'completed'` means a result was INGESTED, not that
the job succeeded (`src/results/store.ts:98-100`).

### T1a — catalog fetch + validation (est. 200 lines). Endpoint: stub server only.
Files: create `src/models/fetch.ts`, `tests/models/fetch.test.ts`, `tests/models/fixtures/subs-2026-10-06.json` (the real
28-entry response).
Acceptance: `bun test tests/models` -> `0 fail`: the fixture validates, unknown keys pass through; stub 500 / timeout /
`{}` / empty `data` each throw `ModelListUnavailableError`; a second call within TTL makes no request.
Mutation: drop the shape check -> the `{}` test red. `bun run check` -> pass.
Non-goals: no pick, no CLI, no caller changed.

### T1b — requirement, scoreboard read, pick (est. 280 lines). Endpoint: none (pure + stubs).
Files: create `src/models/resolve.ts`, `src/models/scoreboard.ts`, `tests/models/pick.test.ts`,
`tests/models/scoreboard.test.ts`.
Acceptance: `bun test tests/models` -> `0 fail`: the 2.2 worked example reproduces from the fixture with `class` values
injected by the test; benching `gpt-sol` for `pr-review` -> `claude-opus-5-5`; adding an unpriced entry -> still
`gpt-6.1-sol`, priced cheaper -> the new entry; an entry with no `class` is never picked; a haiku-only list ->
`NoEligibleModelError` naming `excluded`; equal price and equal `created` -> `AmbiguousPickError`.
Mutation: remove `haiku` from the exclusion -> red; pick most expensive -> worked-example test red.
Non-goals: writing the scoreboard (T6); adding `class` or `price` to the catalog (Development head).

### T2 — CLI, role map, Actions wiring (est. 280 lines). Endpoint: the proxy (workflows: their `ENGINE_URL`).
Files: create `scripts/resolve-model.ts`, `config/model-roles.yml`, `tests/models/resolve-model-cli.test.ts`; change
`.forgejo/workflows/implement.yml:190-197`, `pr-review.yml:141`, `issue-triage.yml:100`,
`scripts/actions/render-pr-review.ts:240`, `render-issue-triage.ts:82` (drop `DEFAULT_ENGINE_MODEL`; a missing
`ENGINE_MODEL` is an error), `scripts/done-means/pr-review-actions-424.sh:144`, `issue-triage-actions-424.sh:168`.
Change: a step before the engine step runs `ENGINE_MODEL=$(bun scripts/resolve-model.ts pr-review --base "$ENGINE_URL")`
into `$GITHUB_ENV`; exit 3 fails the job. The 424 checks assert the model equals the CLI's output against a stub.
Acceptance: CLI test `0 fail` (one stdout line on success; exit 3 and empty stdout on stub down; `--list` never prints a
haiku id); both 424 checks exit `0`; `rg -n 'gpt-|claude-' .forgejo/workflows scripts/actions` -> no output; `bun run
check` and `./specs/software-factory.verify.sh` -> pass.
Non-goals: no `.github/workflows/` (retired); no change to the trusted/untrusted job split or which job holds the
engine key; no cache file between runs.

### T3 — route table, script route, scaffold, packet to roles (est. 330 lines). Endpoint: the proxy at dispatch time.
Files: change `src/runner/route.ts:33-36,85-90`, `src/runner/script-route.ts:47`, `src/packets/scaffold.ts:59`,
`src/packets/schema.ts` (packet `model` -> `role`), `packets/issue-triage.md:6`, the runtime-default-283 check, stub and
probe (group D), and their tests under `tests/runner/`.
Change: `AGENT_ROUTES` and `SCRIPT_ROUTE` name roles; `resolveRuntimeRoute` calls `pick` on the cached proxy list and puts
the resolved id in the submission (the submission still carries an id; only the source changes). The L-042 rule becomes
"tier fast runs only at max". Failure returns `{ok:false, reason}` naming the role; no fallback id.
Acceptance: `bash scripts/done-means/runtime-default-283.sh; echo $?` -> `0`, rewritten for roles plus a stubbed list;
stub list with nothing top-tier -> dispatch refused with the role in `reason`. Mutation: return a hardcoded id on fetch
failure -> refused-dispatch test red. `bun run check` -> pass.
Non-goals: runner credentials and least-privilege identity (#82; standing ruling 1); the runner-box retirement;
`isRefusal` except adding the resolver's refusal string if the transport surfaces it.

### T4 — Pi seats and the fleet switcher use the resolver (est. 300 lines). Endpoint: the proxy only, no Bifrost.
Cross-link: Phase 1 P1.2c (branch `docs/p1-seat-models-ruling`, unmerged) creates `fleet/pi/gen-seat-models`, which
builds each seat's `models.json` from `https://subs.example.internal/v1/models` filtered by the profile's `models.families`,
with an explicit `--default <family>` until this resolver lands. T4 lands after P1.2c.
Files: change `fleet/pi/gen-seat-models` (default = `resolve-model.ts <seat role>`; drop `--default`),
`fleet/bin/claude-proxy:37-38,78,81` (offer `resolve-model.ts --list` instead of the `MODELS` tuple; `back` by role),
group F labels (`fleet/board/agents.json`, `crew.json:40`, `fleet/plugins/crew/roster.data.js:44`,
`fleet/agents/*/AGENTS.md`, `fleet/skills/company-conduct/SKILL.md:160-164`) and their tests under `tests/fleet/`.
The Pi seat `models.json` copies `name, reasoning, thinkingLevelMap, input, contextWindow, maxTokens, cost` verbatim from
each kept catalog entry and filters by catalog `family`; nothing is typed by hand.
Labels name the role ("Code Reviewer (pr-review)"); the live id is what the run-trace plugin reports from the provider.
Acceptance: `bun test tests/fleet/pi-seat-models.test.ts tests/fleet/claude-proxy.test.ts` -> `0 fail` with a stub
`/v1/models`: haiku never written; the default is the cheapest eligible id; proxy down -> exit 3, nothing written.
Mutation: make the generator take the first listed id -> default test red.
Non-goals: running the generator on a box (rtech-infra seat); Paperclip adapter config; `fleet/deploy`; removing
`claude-proxy --via bifrost` (open question 7).

### T5 — `scripts/done-means/no-hardcoded-models.sh` + comment cleanup (est. 120 lines). Endpoint: none.
Files: create the check and `scripts/done-means/transcripts/no-hardcoded-models.red.txt`; rewrite the 9 group-G comment
lines to role names or `<id>`.
Change: the check runs the section 1 `rg` (plus `packets/`) and fails on any hit outside `tests/**/fixtures/**`,
`scripts/done-means/fixtures/**`, `**/transcripts/**`, `_DOCS/**`, `*.md` prose under `_reports/`, and
`config/jev/classifiers/**` (group H). Exit grammar: 0 none, 1 hits (each `path:line` printed), 3 `rg` missing.
Acceptance: RED transcript on today's main -> exit 1; after T1a-T4 land -> exit 0; adding `const M = "gpt-6.1-sol"` to a
`src/` file -> exit 1 naming it.
Non-goals: pre-push or CI wiring (separate decision); other repos; the scoreboard file (it holds families, not ids).

### T6 — scoreboard job: evaluate daily or weekly, bench and promote (est. 380 lines). Endpoint: factory DB, Langfuse.
Owner: the factory (D12); a scheduled Forgejo workflow `.forgejo/workflows/model-scoreboard.yml` (`schedule:`, cadence
per open question 8) runs `bun scripts/model-scoreboard.ts` and opens a PR with the new `config/model-scoreboard.json`
(a reviewed change, never a direct push to `main`).
Inputs, all already recorded, joined on `job_attempts.observed_model` (the provider-attested id, mapped to its catalog `family`):
- pr-review: the published verdict (`result_postings`), then whether the reviewed PR later needed a fix (a new commit or
  a follow-up review finding after an approve) — the exact signal is open question 9.
- implement: draft PR (`rw/issue-<n>`) merged vs closed unmerged, read from Forge.
- all lanes: job failure (the job's final state, not the attempt status), latency (attempt start to result), cost per run
  (Langfuse generation token usage x 2.3 price).
- Pi seats (Phase 2): every seat's trajectory reaches Langfuse from inside Pi under the Paperclip run id
  (`_DOCS/pi-workforce/phase-2.md`, P2.1a); T6 reads those generations by run id, so seat work scores the same way.
Output: per (role, family) `{runs, quality, cost_per_run, p50_latency, status: active|benched|trial}` plus the window.
Rule (thresholds are the owner's, open question 10): bench a family whose quality falls below the threshold over at least N
runs; put a cheaper family that meets the tier on `trial` for a share of runs, and make it `active` when it holds
quality. The resolver reads only `status`.
Files: create `scripts/model-scoreboard.ts`, `src/models/score.ts` (pure scoring), `.forgejo/workflows/model-scoreboard.yml`,
`tests/models/score.test.ts`, `scripts/done-means/model-scoreboard-T6.sh`.
Acceptance: `bun test tests/models/score.test.ts` -> `0 fail` on fixture rows: a family below threshold -> `benched`; a
cheaper family holding quality over N runs -> `active`; a family with fewer than N runs is unchanged; `completed`
attempts with an `error` verdict count as failures. `bash scripts/done-means/model-scoreboard-T6.sh; echo $?` -> `0`
(runs the script against a seeded test DB and a stub Langfuse, asserts the file validates and names no exact id).
Mutation: score attempt `completed` as success -> red. `bun run check` and `./specs/software-factory.verify.sh` -> pass.
Non-goals: choosing thresholds; changing what lanes record; Bifrost spans; auto-merging the scoreboard PR.

Order: T1a -> T1b -> T2 and T3 in parallel -> T4 (after P1.2c) and T6 -> T5 last (green only when the others merge).

## 4. Open questions (recommendation each; not decided)

1. Price source. RESOLVED 2026-10-06: the catalog `.price` on `/v1/models`, API list rates; a missing price is
   fixed in the catalog by the Development head.
2. Cache TTL. Rec: 5 min in-process for the watcher; none across processes, so every Actions run fetches once.
3. Effort per role. Rec: in `config/model-roles.yml` as shown, and the loader enforces "fast tier runs only at max".
4. Blend for "cheapest". Rec: input:output 3:1 until T6 has each role's own token mix, then the role's mix.
5. Unpriced ids. Rec: ineligible for the automatic pick, visible in `--list`, and the scoreboard flags them so a rate gets
   added. Alternative: treat as most expensive.
6. Who owns the family tiers. RESOLVED 2026-10-06: the catalog `class` field, served by the Development head;
   no tier map in this repo.
7. `claude-proxy --via bifrost`. Rec: retire it in a follow-up once Pi tracing (Phase 2) is RUNNING, per the ruling.
8. Cadence. Rec: daily scoring with a 7-day window; weekly is the fallback if daily is noisy.
9. Pr-review "later fix" signal. Rec: a commit on the PR after an approve verdict, or a revert within 7 days of merge.
10. Thresholds (bench below, promote above, minimum runs N, trial share). The owner's call; no recommendation.
11. Jev advisory layer (D2). Rec: later, advisory only; the deterministic pick still decides and a Jev outage never blocks.