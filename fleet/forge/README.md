# fleet/forge: Development's `forge` CLI, vendored for the boxes
Source: Development commit 5b9605ef5020439f06eec92f6200657893877694, `_ob/bin/` (byte-exact copies; `forge-harness-accounts` is imported by `forge-op-pages.mjs`).
Run: `node ~/fleet/forge/forge <verb>`. Node comes from PATH (/usr/bin/node on the Linux boxes, Homebrew node on host01); the file's own shebang is the Mac path, so always call it through `node`.
Identity: `FORGE_LOGIN` + `FORGEJO_TOKEN` in the run env, no `--as`; it acts as that employee.
`VENDORED`: the marker `forge pr create` reads to print this dir's lines beside the 1200-added-line bar instead of counting them.
Refresh: re-copy each file with `git -C <Development> show <sha>:_ob/bin/<name>`, update the sha above and in `VENDORED`; tests/fleet/forge-vendored.test.ts checks it.
