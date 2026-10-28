# review-jobs bundle

State: WRITTEN. Nothing here has been installed on a host.

The Factory's half of the live review jobs on a fleet host: everything the rtech-infra
`review-jobs.yml` play expects under `/opt/review-jobs` but does not install
itself. The bundle ships the issuer binary as `issuer/bin/review-issue`; the play
owns `issuer/` itself and anything else it puts there, and `install.sh` never touches
any of those. The signing key, public key and issued store live outside this prefix
(`/etc/review-jobs`, `/var/lib/review-issuer`; see `fleet/review/issuer/ATTESTATION.md`).

## Files

| File | What it is |
|---|---|
| `pi-wrapper.sh` | Shipped as `pi/bin/pi`, mode 0755. A regular file, because the launcher refuses a symlink anywhere on an installed path. It execs the host's system Pi 1.1.0 (`/usr/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js`) with `/usr/bin/node`. The bundle ships no second Pi. |
| `build.sh` | Builds the tarball on a build host (macOS or Linux, needs network). |
| `install.sh` | Installs a tarball on the target, as root. |

## Bundle contents (paths relative to `/opt/review-jobs`)

- `pi/bin/pi` -- the wrapper above.
- `extensions/fleet-proxy-models/index.ts` and `extensions/read-roots/paths.ts` -- from `MAIN_REF`.
- `extensions/review-scope/index.ts` -- from `SCOPE_REF` (default `74212a5d`).
- `extensions/runtime-capture/index.ts` -- `fleet/review/runtime-capture.ts` at `PREPARER_REF` (default `5c219ca9`).
- `extensions/node_modules/zod/` -- zod 4.4.3 from `npm pack`, checked against bun.lock's sha512 integrity.
  Pi's loader aliases only the pi packages and typebox, so zod must resolve from the extension directory upward.
- `factory/bin/review-prepare` -- `bun build --compile --target=bun-linux-x64` of `fleet/review/prepare-cli.ts` at `PREPARER_REF`.
- `issuer/bin/review-issue` -- `bun build --compile --target=bun-linux-x64` of `fleet/review/issuer/review-issue.ts` at `MAIN_REF`,
  from its own clean `git archive` export. The only path under `issuer/` the bundle carries.
- `factory/fixed-review-prompt.txt` -- for infra to load into `rv_review_prompt`; the launcher does not read this path.
- `MANIFEST.json` -- refs, bun/node/npm versions, zod version and integrity, the host Pi version the
  bundle needs (`"pi": {"version": "1.1.0"}`), sha256 and mode of every file. Installed as
  `/opt/review-jobs/MANIFEST.json`.

Members are root-owned (numeric 0:0), directories 0755, files 0644, the three executables 0755.
No symlinks or hardlinks: `build.sh` refuses to emit one, and `install.sh` refuses to install one.

## Build

```sh
OUT=/opt/_tmp/rodaddy/software-factory/bundle fleet/review/bundle/build.sh
```

Writes `$OUT/review-jobs-<sha12>.tar.gz` and its `.sha256`. Scratch goes under
`$RTECH_SCRATCH_ROOT` (default `/opt/_tmp/rodaddy/software-factory`) and is
left there for inspection. Do not commit the tarball.

It refuses unless `bun --version` is exactly 1.3.14, the version `.forgejo/runner-image/Dockerfile`
and every workflow pin. The tarball is reproducible: every entry carries one fixed mtime, members are
emitted from a sorted explicit list, and gzip writes no name or time, so two builds of the same refs
on the same build host give the same sha256.

## Install (infra, as root on a fleet host)

Install only with no review running; the seats are paused during an install.

```sh
install.sh review-jobs-<sha12>.tar.gz <sha256>
```

It creates a private (0700) `/opt/review-jobs/.staging-<UTC stamp>-<pid>`, copies the tarball into it
once, and from then on hashes, lists and extracts only that copy. It verifies the sha256, refuses any
link, device, absolute or `..` member or one outside the layout (under `issuer/`, only `issuer/bin/*`),
requires `pi/bin/pi`, `factory/bin/review-prepare` and `issuer/bin/review-issue` to be regular files,
refuses unless `factory/` and `issuer/` already exist as real directories (the play creates both),
chowns root:root, sets directories 0755, files 0644 and the three executables 0755 (no setuid,
setgid or sticky bit), and refuses unless the tree equals
`MANIFEST.json` both ways (every file listed with an equal sha256 and mode, every listed file present)
and the host Pi's `package.json` version equals the manifest's `pi.version`. It refuses if an
existing `INSTALLED` is not a regular file, then writes the receipt (`sha256=`, `manifest_sha256=`,
root:root 0644) inside the private staging dir and refuses if it cannot, with nothing swapped. Then
it renames `pi/`, `extensions/`, `factory/bin/`, `issuer/bin/`, `factory/fixed-review-prompt.txt`
and `MANIFEST.json` into place one at a time, keeping each previous one as
`.prev-<UTC YYYYmmddTHHMMSSZ>-<sha12>-<name>` (`factory/bin` becomes `factory-bin`, `issuer/bin`
becomes `issuer-bin`), and last renames the staged receipt over `INSTALLED`. If any rename fails, the receipt's included, every path already
swapped is put back, `INSTALLED` is left alone, and it exits 3.
Exit 0 installed, 1 refused, 3 harness error. It refuses only on an exact backup
name collision (the same tarball installed twice in one second).

## Backout

Run `install.sh` with the previous tarball and its sha256 (the timestamped backup names never collide
with a roll-forward), or rename each `.prev-<stamp>-<sha12>-<name>` from the install being backed out
over the installed path (`.prev-<stamp>-<sha12>-factory-bin` to `factory/bin`,
`.prev-<stamp>-<sha12>-issuer-bin` to `issuer/bin`,
`.prev-<stamp>-<sha12>-MANIFEST.json` to `MANIFEST.json`) and restore `INSTALLED` to the previous
tarball's `sha256=` and `manifest_sha256=`.
