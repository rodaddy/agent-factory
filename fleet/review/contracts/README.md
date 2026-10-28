# Preparation manifest v1 — proposed consumer contract

Status: source contract and validator only. Not a Git preparer, root seal,
installed executable, launcher integration or runtime acceptance receipt.
Owner: Codex software-factory. Infra owns isolation, collection and sealing.

`manifest-v1.schema.json` is the structural JSON Schema generated from
`manifestWireSchema` in `../preparation-contract.ts`. `manifest-v1.example.json`
is a synthetic wire example, not a receipt for existing commits. Its two
README files contain `hello\n`, context contains `{}\n`, and diff is empty;
its commit IDs are placeholders. Production context must contain the protected
repo/PR/base/head binding and common review context. Packet schema and Git
preparation remain unimplemented by this change.

`fixed-review-prompt.txt` contains the exact single argv string (no final
newline), exported as FIXED_REVIEW_PROMPT. Use these literal bytes identically
for both lanes; never substitute packet text or a shell expression into it.
The report shape follows the existing capture parser, not a new report format.

## Wire rules beyond JSON Schema

All objects reject unknown properties. All IDs are lowercase hexadecimal;
Git object IDs are SHA-1 only in v1. Changed gitlinks are unsupported.
`files` inventories every materialized regular file except `manifest.json`.
It requires exactly one `context.json` and one `diff.patch` artifact.
`base/` and `head/` are directories even when their tracked tree is empty.
The root sealer must allow precisely those two empty directories plus the
parent directories implied by inventory paths; reject unlisted files/directories.
Gitlinks have no materialized output inode.

Sort `files` by UTF-8 bytes of `path`; sort `gitlinks` by UTF-8 bytes of
`side + '/' + repoPath`. Reject duplicates and NFC-normalized path collisions;
retain original path bytes (no normalization or renaming). Reject invalid UTF-8,
unpaired surrogates, control characters, backslash, absolute paths, empty or
`.`/`..` components, or paths over 512 UTF-16 code units (a conservative character limit). A tracked output path
must equal `side + '/' + repoPath`. A file cannot also be a directory prefix.
Symlinks have kind `symlink`/mode `120000` but are ordinary output files holding
the exact Git link-target blob. Regular files have mode `100644` or `100755`
as metadata only. gitlinks have mode `160000` and identical path/OID on both sides.

Producer serialization: UTF-8 without BOM, compact JSON, one trailing LF.
Emit keys in schema order; arrays follow the sort above. No clocks, lane/model,
nonce or host fields. Consumer hashes the actual received manifest bytes, never
a reconstructed JSON value. Both lanes must produce the same bytes/digest.

Root independently validates protected repo/PR/base/head binding, actual complete
inventory, sizes and SHA-256, then seals fresh inodes with no-follow descriptors.
The schema is not evidence of Git provenance or filesystem confinement.
All 113450 limits still apply: 100,000 entries including directories, 20,000
regular files including manifest.json, 256 MiB output including manifest,
16 MiB/file, 2 MiB diff, 1 MiB context, 16 MiB manifest. The pure validator checks
listed sizes and manifest bytes; root must independently count actual entries
and bytes and reject special files, symlinks and nlink != 1.

Protected executable ABI is unchanged:
`["/opt/review-jobs/factory/bin/review-prepare", "{packet}", "{bundle}", "{src}"]`.
No executable is supplied here; absent executable or incomplete preparation is
a launch hold. Factory still owes Git/bundle verification and extraction,
context production, executable packaging and issuer/ingestion integration.
Infra still owes target-system sealing/collector acceptance. No host apply,
restart, seat activation or merge is authorized by this source contract.
