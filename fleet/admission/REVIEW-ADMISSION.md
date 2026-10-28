# forge-pr admission

The worker now calls the protected admission executable before it creates a paid
review task, on webhook, settled-check replay, sweep, and partial-pair paths.
Missing executable, lineage, reconciled history, receipt, or collector completion
holds the review. There is no author-controlled enable/disable switch.

## Protected installation contract — not deployed by this change

Compile `fleet/admission/review-admission-cli.ts` with `bun build --compile` for the
host and install it as root-owned `/usr/local/bin/factory-review-admission`.
The plugin invokes only `admit`, passing a JSON object on stdin, with a 10-second
timeout and 16-KiB output bound. The object contains `companyId`, numeric
`repositoryId`, `repositoryFullName`, numeric `pr`, and full `headSha`/`baseSha`.
These identities are freshly read from Forge, not copied from receipt prose.

`/etc/software-factory/review-admission.json` is a root-owned, non-world-readable
configuration containing `companyId`, `databaseUrl`, and `publicKeys` (issuer
key IDs mapped to Ed25519 public PEM strings). Give its read permission only to
the trusted service identity. The existing `operation_admissions` migration is
required. The CLI uses its actual versioned PostgreSQL CAS adapter; plugin state
is not used as a substitute for atomic receipt consumption.

Root-owned, non-group/world-writable directories under
`/var/lib/software-factory/review-admission` contain bounded JSON files:

- `receipts/<receiptId>.json`: the existing signed swarm-receipt envelope.
- `executions/<runId>.json`: `{ "collectorComplete": true, "execution": ... }`,
  with the existing verifier execution record. `false`, absent completion,
  unknown termination and null exit codes cannot authorize a start.
- `evidence/<digest>.json`: a JSON string containing the exact UTF-8 adjudication
  record bytes whose digest the receipt names.
- `ready/<repositoryId>-<pr>-<headSha>.json`: `{ "receiptId": ..., "expected": ...,
  "latest": ... }`. `expected` is the existing `SwarmReceiptExpected` without
  `nowMs`; the CLI supplies its clock. `latest` is null for the initial unused
  heads, otherwise the exact ledger `{round, runId, findingsRevision, finishedAt}`.
  The trusted issuer must publish the full latest findings in `expected`.

The collector/issuer owns producing these protected artifacts; this source change
neither mints signatures nor installs a service or activates the fleet.

## Assign lineage and import history

The `register` subcommand is restricted to effective host root. Its stdin is:

```json
{
  "target": { "companyId": "company-uuid", "repositoryId": 160,
    "repositoryFullName": "rodaddy/software-factory", "pr": 123,
    "headSha": "<40-hex>", "baseSha": "<40-hex>" },
  "workItemId": "<existing-protected-id-for-a-replacement>",
  "patchSha256": "<64-hex>", "treeSha": "<40-hex>",
  "historyComplete": true,
  "history": []
}
```

Omitting `workItemId` is an explicit privileged declaration of new independent
work; the command generates a UUID. A replacement/re-cut uses the existing ID
and original complete history snapshot. Ordinary PR events never assign IDs.
Unknown/ambiguous source work remains held until this trusted association exists.
PR aliases and exact original patch/tree metadata persist in the same CAS store.

History contains each **admitted** prior parent round in order: `runId`, `pr`,
`headSha`, `baseSha`, `issuedAt` (its historical admission timestamp), and, when
known, `completion` (`result`, `highestSeverity`, `findingsRevision`, `finishedAt`).
Unadmitted cancelled tasks are excluded by the trusted reconciliation. Missing
completion becomes `uncertain` and holds subsequent work. Missing history is not
an empty history. Historical rows explicitly have `receiptId: null` and
`legacy: true`; no receipt is fabricated. Import inserts once, stores the snapshot
digest and refuses a different snapshot even after additional rounds have run.

The `complete` subcommand is also root-only. It takes `companyId`, the returned
`reservation`, and trusted `completion` (or `{ "uncertain": true }`). Reconciling
an uncertain attempt requires `reconciled: true`. The protected executor/controller,
not a model's verdict text or ordinary board edit, owns these terminal facts.

An attached reservation never dispatches another pair: board creation lacks an
idempotency key. A lost response or partial pair holds for trusted reconciliation.
This deliberately favors stopping over duplicating paid tasks. Backout pauses
admissions and reverts the caller; it never deletes aliases or round history.

## Protected collection and completion commands (source only)

Install `fleet/bin/factory-review-controller` root-owned beside the compiled
admission executable. The existing trusted supervisor invokes:

```
factory-review-controller collect <capture-uuid>
factory-review-controller complete <admitted-run-id>
```

Output directories must inherit the trusted admission reader group (setgid or an
equivalent managed ACL); published files are root-owned `0640`. Readers need
traverse/read, never write. This preserves non-root `admit` access without giving
seats artifact publication authority.

Both controller verbs require root. They accept opaque IDs only, use fixed roots,
launch no model, and never read an ordinary board verdict or plugin state as
execution evidence. Infra owns installing and connecting these commands to the
supervisor; this change does not claim that connection is deployed.

Before collection, the trusted preparation/controller stage seals these files
under the admission root (root-owned, not group/world writable):

- `prepared/<capture-uuid>.json`: `{target, expected, latest, context, identities}`.
  `target` is the registered company/repository/PR/base/head identity. `expected`
  contains the existing required checks, author, latest findings and source/work
  binding. `latest` is the exact ledger release binding, not an inferred empty
  history. `context` is the bridge's independent attestation context. `identities`
  has `claude` and `gpt` entries with the protected launcher nonce, attempt ID,
  child run ID, provider, API, fixed model and effort. These facts must be saved
  from the actual dispatch, never reconstructed from reviewer text.
- `manifests/<capture-uuid>.json`: exact root-sealed `manifest.json` bytes produced
  by the existing preparer. Collection checks their digest and repository/PR/
  base/head binding through `parsePreparationManifest`.
- Check execution and adjudication evidence retain their existing protected
  `executions/` and `evidence/` contracts. The collector cannot invent checks,
  accepted dispositions, lineage, or trusted author identity.

Collection reads the issuer's original envelope from
`/var/lib/review-issuer/issued/<capture-uuid>.json` and actual root captures from
`/var/lib/review-jobs/captures/<capture-uuid>/{claude,gpt}/`. It requires explicit
collector completion and successful process termination, parses the complete Pi
stream with `parseReviewCapture`, then verifies signature, captured digests,
resolved identities, source/work bindings, required checks and dispositions.
Only after verification does it publish execution/context/receipt artifacts,
then `ready/` **last**. Evidence publication is immutable, fsynced and atomic; unequal existing evidence
bytes refuse. `ready/` is an atomically replaced current pointer so a new verified
receipt can release a completed same-head round. Admission still checks the
current ledger release binding and consumed receipt, so a concurrent stale pointer
holds rather than reopening a spent round. An interrupted publication leaves no
new ready marker. Published file mode is set explicitly on its owned descriptor
before publication, including when the root process uses umask `077`.

After an admitted factory round terminates, the trusted executor/controller
seals `terminals/<admitted-run-id>.json` with `{target, workItemId, runId,
reservationVersion, completion}`. `completion` has the existing root-only
completion contract, including explicit uncertainty/reconciliation. The
controller reads the authoritative PostgreSQL round, checks all saved source
and reservation bindings, and calls `finishForgeReview` with its stored token.
Stale tokens and repeated completions cannot terminalize another round. No
attempt is reset or credited back. Creating this protected terminal record is
an executor responsibility; an ordinary `done` task is not sufficient.
