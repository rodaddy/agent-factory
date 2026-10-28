# hosted-app

Validates the two documents of the hosted-app rail: a product repo's
`hosted-app.yaml` **declaration** (`hosted-app/v1`) and the registry repo's
**entry** (`hosted-app-registry/v1`). Schema shape is
`_DOCS/proposals/hosted-app-registry-schema.md`.

```
software-factory hosted-app validate <declaration.yaml> [--registry <entry.yaml>]
software-factory hosted-app validate --registry-only <entry.yaml>
software-factory hosted-app schema
```

`--registry` additionally checks that the two documents agree on identity: same
`name`, same repo owner, every entry target declared, an accepted image per
target, and each accepted tag matching the declaration's `tag_pattern`.
`--registry-only` validates the entry alone (what the registry repo's CI runs).
`schema` prints the declaration's JSON Schema on stdout.

## Exit grammar

| Code | Meaning |
|---|---|
| `0` | valid — `RESULT PASS -- <name> ...` on stdout |
| `1` | invalid — one `<yaml.path> -- <message>` line per problem, then `RESULT FAIL -- <n> problem(s)` |
| `3` | harness error — file missing or unreadable, not YAML at the CLI boundary, bad usage |

Validation is offline by default. `--referential` adds three checks:
every `secrets[].vaultwarden_item` + `keys[]` and `database.password_item`
resolves in Vaultwarden (key names only, never values); with `--registry`,
each accepted build image's tag exists in the registry at the accepted digest
(reads `FORGE_TOKEN`, or `FORGEJO_TOKEN`; empty is exit 3); and with
`--k3s-deploy-dir <dir>`, each declared host (top level and per-target
overrides) is unclaimed or claimed only by this app's own `<name>-<target>`
directory in that checkout's IngressRoute `Host()` matches and Certificate
`dnsNames` -- a host another app claims is exit 1 naming both. Without
`--k3s-deploy-dir` the hostname check is skipped with a `NOTE` on stderr.

## render

```
software-factory hosted-app render <declaration.yaml> --registry <entry.yaml> \
    --target <target> --out <dir> [--source-dir <path>]
```

Renders ONE target into the k3s-deploy files it deploys as: the Argo
Application flat at `<out>/apps/<name>-<target>.yaml`, and the manifest set at
`<out>/manifests/apps/<name>-<target>/` — `namespace.yaml`, `deployment.yaml`,
`service.yaml`, `kustomization.yaml`, `MANIFEST-NOTES.md`, plus `route.yaml`,
`pvc.yaml`, `cronjob.yaml` and `configmap.yaml` when the declaration asks for
them. The target's `overrides` are merged and re-validated first, so a render
can never emit a shape the validator rejects.

Rendering is offline and deterministic: the image comes from the registry
entry's `accepted.images.<target>.image`, digest included, so the same inputs
always render the same bytes. A target the registry entry has not accepted
exits 1 rather than rendering an unaccepted image.

`--source-dir` is where `config_files` paths are read from; it defaults to the
directory holding the declaration. Content lives in the product repo, so a
declaration that mounts a config file whose content cannot be read exits 1 with
`config_files needs --source-dir`.

Secrets are NEVER rendered. `MANIFEST-NOTES.md` names each Secret the namespace
needs and the Vaultwarden item it comes from; applying them is out of band. The
Namespace is the only cluster-scoped object emitted, and no object is placed in
a namespace other than `<name>-<target>`.

A `paused` or `retired` registry entry renders `replicas: 0` and `suspend: true`
on every CronJob, so the namespace, its claims and its Secrets survive the
pause rather than being deleted.

## land

```
software-factory hosted-app land --registry-dir <hosted-apps checkout> \
    --k3s-deploy-dir <k3s-deploy checkout> [--app <name>] [--forge-api <url>]
```

The step between the registry (what is accepted) and the deploy repo (what Argo
applies). For every `apps/*.yaml` in the registry checkout — or only the one
named by `--app` — it validates the entry, fetches that app's declaration from
its product repo **at the accepted ref**, proves the fetched bytes hash to
`accepted.declaration_sha256`, and renders every registry target into the
k3s-deploy checkout through the same `renderTarget` the `render` subcommand
uses.

The declaration is fetched rather than read from disk because the accepted ref
is the only authority on what was reviewed; a working copy could have drifted.
The sha256 gate is what makes that fetch trustworthy — bytes that do not match
are refused before anything is rendered, so a moved or rewritten ref cannot
reach the deploy repo. `config_files` content is fetched the same way, from the
declaration's directory at the same ref.

`--forge-api` defaults to `https://forge.example.net/api/v1`. The token comes
from `FORGE_TOKEN` in the environment and is sent as `Authorization: token
<t>`; a missing token with a non-empty registry is a harness error. Reads go
through an injected seam, so the tests serve a URL map and never touch the
network.

One bad app never stops the run: a failing entry, a drifted declaration, or a
404 is one `FAIL` row and the loop continues, so a registry of ten apps lands
the nine that are good. A `state: retired` entry is skipped and never fetched —
removing its directory belongs to a later step, so nothing is ever deleted.
Writes are confined to `apps/<name>-<target>.yaml` and
`manifests/apps/<name>-<target>/` for the apps processed, and no git command is
ever run.

Each app prints one row: `PASS -- <name>: rendered <t1>(new), <t2>(update)`,
`FAIL -- <name>: not landed` under its `<path> -- <message>` lines, or
`SKIP -- <name>: retired`. A target is `new` when its manifest directory did
not exist and `update` when it did.

### The summary file

`<k3s-deploy-dir>/.hosted-app-land.json` records the run for the step that
follows: one object per app with `name`, `repo`, `ref`, `targets[{name, kind,
dir}]`, `verdict`, and `problems[]`.

### Exit grammar

| Code | Meaning |
|---|---|
| `0` | every app landed — `RESULT PASS -- <n> app(s) rendered, 0 failed, <k> skipped` |
| `1` | one or more apps failed; the rest still landed and the summary is written |
| `3` | harness error — unreadable directory, missing `FORGE_TOKEN`, fetch transport failure, bad usage |

A 404 is a per-app `FAIL`, never a harness error: the server answered. A
transport failure (no HTTP reply at all) is a harness error, because a run that
cannot reach Forge proves nothing about the apps it did not check.

## `hosted-app map`

```
software-factory hosted-app map --registry-dir <dir> --k3s-deploy-dir <dir> \
    [--argo <applications.json>] --out <file.html>
```

Renders one self-contained HTML page — inline CSS, no scripts, every value
escaped — putting three facts side by side, one row per (app, target):

- **Declared** — from the registry checkout's `apps/*.yaml`, each validated with
  the same `validateRegistryEntry` the CLI uses: repo, accepted ref, who
  accepted it and when, state, the target's merge policy, and the accepted
  image. An entry that fails validation is a row with `verdict: invalid`
  carrying its first problem, so a broken file is visible rather than missing.
- **Rendered** — whether `apps/<name>-<target>.yaml` and
  `manifests/apps/<name>-<target>/` exist in the k3s-deploy checkout, and the
  first container image in that directory's `deployment.yaml`. Absent reads
  `not rendered`.
- **Running** — from `--argo`, a file the operator produced with
  `kubectl get applications.argoproj.io -n argocd -o json`: sync status, health,
  short revision, and the images Argo reports. WITHOUT that file every Running
  cell reads `unknown (no cluster snapshot)`, which is deliberately not the same
  claim as `not running` — the page says which facts it actually has.

The disagreements are COMPUTED, not left for an operator to spot across three
tabs: `rendered image != accepted image`, `running image != rendered image`,
`rendered but not running`, and `running but not in registry` (an Argo
Application named `<app>-<target>` for a registry app that no longer lists that
target, in a trailing Unregistered table). Each one badges its row and is
counted at the top, next to apps, targets, rendered, running-healthy and invalid
counts, the generation time, and the two checkout shas — read out of `.git`,
because this command runs neither `git` nor `kubectl`.

Disagreements are CONTENT, not failure: a page reporting six mismatches still
exits 0, because the command's job is to produce the page. Exit 3 is reserved
for the harness errors that mean no page exists — an unreadable checkout, an
unparsable snapshot, an unwritable `--out`.
