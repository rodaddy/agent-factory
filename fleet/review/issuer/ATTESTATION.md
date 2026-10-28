# review-issue: the execution attestation

State: WRITTEN (F5 cut 1). Not installed, not run on a host.
Source: `fleet/review/issuer/review-issue.ts`. Tests: `tests/fleet/review-issue.test.ts`.

The issuer ATTESTS; the factory BINDS. review-issue signs only what root captured
for one review run. It knows nothing about a repository, a head, a work item or a
check, and it holds no credential besides its signing key.

## Invocation

`sudo -u review-issuer /opt/review-jobs/issuer/bin/review-issue attest <capture-id>`

- `<capture-id>` matches `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`.
  Any other value, a missing argument or an extra one exits 3.
- No environment variable is read. Paths are constants: captures
  `/var/lib/review-jobs/captures`, key `/etc/review-jobs/issuer/signing.key`,
  public key `/etc/review-jobs/signing.pub`, store `/var/lib/review-issuer/issued`.
- stdout on success: one line, the envelope JSON. stderr on refusal: one line
  `refused: <reason>`; on a harness error: one line `error: <reason>`.
- Exit 0 signed or re-emitted, 1 refused, 3 harness error (bad args, unreadable or
  mismatched key, invalid stored record, store or I/O failure).

## What is checked before signing (any failure refuses, exit 1)

`<captures>/<capture-id>/` holds exactly `claude/` and `gpt/`, nothing else. The capture
directory and both lane directories are real directories (lstat, never a symlink). Every
file read (`run.json`, `collector.json`, `prepare.json`, `events.jsonl`, `stderr.txt`) is
opened `O_RDONLY|O_NOFOLLOW|O_NONBLOCK` (a FIFO cannot hang the open), checked on that fd with fstat as a regular file, and read
and hashed from that same fd. The directories and every file are owned by root (uid 0)
and not group- or other-writable. `events.jsonl` and `stderr.txt` are hashed by streaming
and refused above 256 MiB. Per lane:

- `run.json.lane` equals the directory name.
- `run.json.result` is `success` and `run.json.exitStatus` is 0 (the launcher's systemd
  `Result` and `ExecMainStatus`). The top-level `exitCode` is systemd's `ExecMainCode`
  string and is not checked; `termination.exitCode` below is the process exit code.
- `startedAt`/`finishedAt` are positive epoch seconds and `finishedAt >= startedAt`.
- `requestedModel`/`requestedThinking` are gpt `gpt-6.1-sol`/`low`, claude `claude-sonnet-5-5`/`medium`.
- `cancelled`, `unitLost`, `timedOut` are false; `collectorComplete` is true and `collector.json.complete` is true.
- `preparationStatus` is `ok` and `prepare.json.status` is `ok`; `prepare.json.preparedManifestSha256` equals run.json's.
- `termination.exitCode` is 0, `termination.signal` null, `termination.timedOut`/`truncated` false.
- Every `captures[]` entry has `truncated` false. `events.jsonl` and `stderr.txt` are each
  recorded exactly once, and the sha256 and byte count RECOMPUTED from the files on disk
  equal the record.
- When `declared.packetSha256` / `declared.manifestSha256` is set, it equals
  `packetFileSha256` / `preparedManifestSha256`.
- `declared.nonce` is 64 lowercase hex.

Across the lanes, `declared.nonce`, `bundleSha256` and `preparedManifestSha256` are equal.
`packetFileSha256` is per lane and never compared: the launcher requires each lane's
packet to name its own lane, model and thinking, so the two packets always differ
(capture 3fcd8a2e).

## Payload: `review-attestation/v1`

Canonical JSON (object keys sorted at every depth, no whitespace):

```
{ schema: "review-attestation/v1", id: <fresh uuid v4>, captureId,
  issuedAt, expiresAt (issuedAt + 24h; ISO-8601 UTC, "Z"),
  nonce, bundleSha256, preparedManifestSha256,
  lanes: [ { lane, principal, model, thinking, packetFileSha256, startedAt, finishedAt,
             exitCode: 0, eventsSha256, stderrSha256, eventsBytes } ] }
```

`lanes` is sorted by lane (claude, gpt). `principal` is a constant (`review-work-claude`,
`review-work-gpt`, the play's `rv_lanes`), never input. `startedAt`/`finishedAt` are
run.json's epoch seconds as ISO-8601 UTC.

## Envelope and keyId

`{ keyId, payload, signature }`, the shape of `fleet/lib/swarm-receipt.ts`:

- `payload`: the canonical JSON string, at most 131072 bytes.
- `signature`: base64 of the 64-byte Ed25519 signature over the UTF-8 payload (88 chars).
- `keyId`: `ed25519:` + lowercase hex sha256 of the public key's SPKI DER, derived from the
  private key. When `/etc/review-jobs/signing.pub` exists and differs, the issuer exits 3.

## Once per capture

The issuer looks for `<store>/<capture-id>.json` first. If it exists, it is validated
and re-emitted, and nothing is signed. Otherwise the envelope is written to a unique temp
file in the store (O_EXCL, mode 0400), fsynced, and published with `link(2)` to
`<capture-id>.json`; link fails with EEXIST atomically, so the record is never seen empty
or partial and is never replaced. The temp is always removed. Before any exit 0, a new
record, a re-emitted one or a race loser's, the store directory is fsynced so the link
survives a crash; a failed sync exits 3, and the next call re-emits the record.

Two concurrent calls may both sign. At most one attestation is published per capture; a
concurrent loser's signature is discarded, never printed. The loser re-emits the winner's
record. There is no lock file.

A stored record is re-emitted only when it parses as exactly `{keyId, payload, signature}`,
`keyId` is the current key's, the Ed25519 signature verifies, `payload.schema` is
`review-attestation/v1` and `payload.captureId` is the requested id. Anything else exits 3
with `error: stored record invalid`, never 0.

A stored attestation is re-emitted as is, even after its `expiresAt`. The issuer never
re-signs a capture; an expired attestation means a new review run.

One attestation per capture; consume-once on review rounds is the consumer's, not
the issuer's.

## What the CONSUMER must do (the trusted side)

An attestation alone binds nothing. The factory's trusted Actions job must:

1. Verify `signature` over `payload` with the published public key whose SPKI sha256 is `keyId`,
   and check `schema`, `expiresAt` and the fixed lane models.
2. Recompute `preparedManifestSha256` from the PR's head and base through the same preparer
   at the pinned build, and compare. This is how the attestation binds to a head. Match
   `nonce` and each lane's `packetFileSha256` to the packets it dispatched for this review.
3. Bind the repository ID, work item and required checks from Forge itself, never from the
   attestation or the caller.
4. Parse the `events.jsonl` it ingests and match it to `eventsSha256`/`eventsBytes` per lane
   before trusting any report in it.

Items 2-4 are consumer work owned by Codex on #2014/#2015. NOT BUILT.
