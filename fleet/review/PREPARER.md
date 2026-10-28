# Review source preparer

Source implementation on the contract branch; not installed or accepted on the
launcher host. The manifest wire, example and prompt remain pinned at b9880c1.
This executable consumes the existing launcher packet version 1 and emits the
existing manifest schemaVersion 1. Those version fields are independent.

Build with the repository's Bun toolchain into the configured temp build bucket:

```sh
bun build --compile fleet/review/prepare-cli.ts --outfile /opt/_tmp/software-factory/_builds/review-prepare/review-prepare
```

For the Linux launcher build with `--target=bun-linux-x64` (or the actual target
architecture). The deployment owner installs the reviewed binary at
`/opt/review-jobs/factory/bin/review-prepare`. Compilation packages Zod and all
TypeScript dependencies; `/usr/bin/git` and its helpers remain required protected
host dependencies. A Mac binary/test receipt does not prove Linux execution.
No installer, service configuration or host mutation is part of this source change.

The exact argv remains `[executable, packet, bundle, src]`. All paths must be
absolute. Inputs must be launcher-frozen, regular, single-link files within
64 KiB packet / 512 MiB bundle caps. The output must be a newly created empty,
exclusive directory with canonical parent paths. Launcher isolation, no network,
no credentials, the 120-second deadline, process/memory/disk limits and quiescence
are still required. This program does not replace those boundaries.

Preparation verifies a self-contained bundle in an empty bare object store,
unbundles and runs strict Git object checks, then verifies both exact commit
objects. Fixed Git argv and a fresh environment disable inherited configuration,
replacement objects, hooks, protocols, lazy fetch, external diff and textconv.
No checkout, filters, submodule fetch or repository executable is used.
Symlink blobs are ordinary files; unchanged gitlinks remain metadata only.
The output byte/file/entry limits are checked before completion. A filesystem
that cannot represent distinct paths refuses creation rather than overwriting.

The common context is `{repo,pr,baseSha,headSha,review}`. `review` is the packet's
optional object (default `{}`), with recursively sorted UTF-8 keys; it is untrusted
data. Producer authorization and exclusion of credentials remain upstream duties.
Lane/model/nonce/run identifiers are omitted from context and manifest. The diff
uses full object IDs, binary patches, Myers, no renames, fixed prefixes and no
color. Neither reviewer receives `.git` or preparer scratch on success.

Exit 0 emits `review_prepare_completed` with manifest SHA-256 and file count.
Exit 2 emits `review_prepare_hold` with a bounded reason, never Git stderr or
packet contents. `manifest.json` is written last, only after scratch removal.
A refused attempt may retain partial output/scratch for diagnosis: it MUST NOT
be reused, sealed or exposed to a reviewer. Launcher cleanup owns that attempt.
The output is not authoritative until root independently validates it and seals
fresh inodes after all preparer descendants are quiescent.

Checks (run from the repository root):

```sh
/opt/homebrew/opt/node@24/bin/node --experimental-strip-types --test tests/fleet/review-prepare.test.ts tests/fleet/review-preparation-contract.test.ts
bunx tsc --ignoreConfig --noEmit --strict --skipLibCheck --target es2022 --module nodenext --moduleResolution nodenext --allowImportingTsExtensions --types bun fleet/review/prepare.ts fleet/review/prepare-cli.ts fleet/review/preparation-git.ts tests/fleet/review-prepare.test.ts
bunx biome check fleet/review/prepare.ts fleet/review/prepare-cli.ts fleet/review/preparation-git.ts tests/fleet/review-prepare.test.ts
```

Tests compile and invoke the executable against actual Git bundles, never model
calls. Set `REVIEW_PREPARE_TEST_ROOT` to the configured shared scratch directory
on other hosts. The Mac default is under an external data volume. Test fixtures are retained
there as receipts. Root sealing, incomplete-collector ingestion refusal,
signalling/systemd and protected receipt issuance require separate integration
acceptance. Missing executable or seal continues to hold launch.
