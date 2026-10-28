---
name: apple-build-review
description: "Review, build and test a Swift, Xcode, macOS or iOS pull request or branch on host01: detect the project, build and test with CODE_SIGNING_ALLOWED=NO, post ONE bounded comment with the exact commands, exit codes and failing test names, and turn a red build on the default branch into one issue. Builds only on host01; never signs, uploads or tags."
---

# apple-build-review

You hold a board task that names a pull request, a branch, or a red build on
a repo with a `*.xcodeproj`, `*.xcworkspace`, `Package.swift` or XcodeGen
`project.yml`.

"Reviews could probably be done anywhere, but builds and all that stuff are
available on host01, and that's where that should happen." (Rico,
2026-10-07). Reading the diff may happen on any host. Steps 2 to 4 run on
host01 (10.0.1.21) and nowhere else. Step 0 checks that.

State: WRITTEN, not run. The commands below follow the repo's own host01 gate
(`rtech/rtech-whisper-ios` `.forgejo/workflows/ios-ci.yml` and the
Development `_ob/bin/host01-check.remote.zsh`). None has been run by this
seat on host01 yet; the first run is the proof.

## Steps

0. **Be on host01.** `hostname` and `uname -m` must name host01 and `arm64`,
   and `xcodebuild -version` must answer. Anything else: stop, set the board
   task `blocked` with `not on host01: <hostname>`. Never build elsewhere.
1. **Pin the head.** With a PR number:
   `node ~/fleet/forge/forge pr view <owner/repo> <n>`; keep the full head
   sha and the base branch. With only a branch or a red build:
   `node ~/fleet/forge/forge branch view <owner/repo> <branch>`; keep its
   full head sha. No branch named: use the repo's default branch. Every
   receipt below is for that sha. If the head moves while you work, start again.
2. **Your own clone.** Make it exactly as `review-pr` step 1 says:
   `ensure-project <owner/repo>`, then a per-PR clone at
   `~/fleet-work/$FLEET_EMPLOYEE/review/<owner>/<repo>-pr<n>` (a branch:
   `<repo>-<branch>` with `/` as `-`), cloned from `~/src/<owner>/<repo>`,
   `origin` set to the HTTPS `clone_url`. With a PR number:
   `git fetch origin <base> refs/pull/<n>/head`. With only a branch:
   `git fetch origin <branch>`; never fetch a PR ref. In either case,
   `git checkout --detach <head-sha>`. Never build in
   `~/src/<owner>/<repo>`, in an operator checkout under
   `/opt/dev/`, or in another run's clone. Derived
   data and SwiftPM scratch go inside the clone (`.dd`, `.spm`); never
   delete the clone yourself.
3. **Detect the project.** Read the repo's `README.md` and `AGENTS.md` first:
   if they name a build or test command for host01, use that command and say
   so in the comment. Otherwise, in this order:
   - `project.yml` with no committed `*.xcodeproj`: XcodeGen. Run
     `scripts/bootstrap.sh` if the repo has it, else
     `/opt/homebrew/bin/xcodegen generate`. Then treat it as an Xcode project.
   - `*.xcworkspace`: `xcodebuild -list -workspace <name>.xcworkspace`.
   - `*.xcodeproj`: `xcodebuild -list -project <name>.xcodeproj`.
   - `Package.swift` (at the root or under `Packages/<name>/`):
     `swift package --package-path <dir> describe`.

   Pick the scheme the README names, or the one named like the app. More
   than one app scheme and nothing names one: build each.
4. **Build and test.** Each command alone, its exit code kept with
   `echo "exit $?"`. Never pipe a build through `tail` or `head`: the pipe
   replaces the exit code. Send output to a log in the clone and read the log.
   - Swift package:
     `swift test --package-path <dir> --scratch-path "$PWD/.spm" > swift.log 2>&1; echo "exit $?"`
   - Xcode scheme: run `xcodebuild -showdestinations -scheme <scheme>`
     with the project's `-project` or `-workspace` option. Pick an available
     destination matching the scheme's platform: `iOS Simulator` for iOS or
     iPadOS, `watchOS Simulator`, `tvOS Simulator`, `visionOS Simulator`,
     or `macOS` for a macOS scheme. For a simulator, pick its matching
     available device, then

     ```
     xcodebuild -project <name>.xcodeproj -scheme <scheme> \
       -destination 'platform=<scheme platform>,name=<device>' \
       -derivedDataPath "$PWD/.dd" CODE_SIGNING_ALLOWED=NO test > xcb.log 2>&1; echo "exit $?"
     ```

     A scheme with no test action fails `test`: run the same command with
     `build` with the same destination. If it succeeds, record
     `test: none (no test action), build: ok`.
   - macOS: the same command with `-destination 'platform=macOS'`.
   - A workspace: `-workspace <name>.xcworkspace` in place of `-project`.
   - A Mac app that is not Swift (for example `rtech/rtech-whisper`,
     Electron): the repo's own commands from its README, on host01.

   Failing tests: `rg -n "error:|failed|\*\* (BUILD|TEST) FAILED \*\*" xcb.log`
   (or `swift.log`). Keep at most 20 failing test names and the first
   compiler error lines. Never paste a whole log.
5. **Read the diff.** With a PR number:
   `node ~/fleet/forge/forge pr files <owner/repo> <n>` and the diff.
   With only a branch, read the pinned head's Apple code; no PR files call.
   Judge the Swift: crashes (force unwraps on input, `try!`),
   main-thread UI work, retain cycles in closures, missing tests for new
   logic. A part that is not Apple code (server, schema, security boundary)
   is not yours: say "needs a non-Apple reviewer: Smythe's queue" and give
   no verdict on it.
6. **Post ONE comment** on your board task. With a PR number, post the
   same text on that PR. With only a branch, post it on the Forge issue the
   task links, if any; never on a PR. For a branch, use
   `Apple build review of <owner/repo> branch <branch> at <sha7>` as the
   heading. Run it dedented, as ONE block in ONE shell call; the closing
   `RECEIPT` starts at column zero:

   ```
   body=$(cat <<'RECEIPT'
   ## Apple build review of <owner/repo>#<n> at <sha7>

   Built on host01 (`<hostname>`, `<xcodebuild -version first line>`), signing off.

   | Command | Exit |
   |---|---|
   | `<exact command>` | <code> |

   Failing tests (at most 20): <names, or none>
   First errors: <at most 10 lines, or none>

   Findings: <P0/P1/P2 lines with path:line, or none>
   Not reviewed here: <non-Apple parts for Smythe's queue, or none>

   verdict: approve | fix-first
   RECEIPT
   )
   paperclipai issue comment <your board issue id> --run-id "$PAPERCLIP_RUN_ID" --body "$body"
   printf '%s' "$body" | PAPERCLIP_RUN_ID=<Run ID> forge-post comment <owner/repo> <n> -
   ```

   `<n>` is the pull request number for PR input; for branch input, use the
   linked Forge issue number, if any.

   `fix-first` when the LAST attempt of any step exited non-zero or there
   is a P0 or P1. A documented fallback that succeeds makes that step a
   pass; keep both attempts and their exit codes in the receipt. For a
   successful no-test-action fallback, record
   `test: none (no test action), build: ok`. A later push gets a new comment
   for the new sha, never an edit of the old.
7. **A red build on the default branch** becomes ONE issue, not a comment
   storm. First look for one:
   `node ~/fleet/forge/forge issue list <owner/repo> --state open --limit 50`.
   An open issue whose title starts `Red build on` is the one: add a comment
   with the new sha and receipt only if the failure changed. None open: open
   it, as ONE block:

   ```
   body=$(cat <<'REDBUILD'
   ## Red build on <default> at <sha7>

   Built on host01, signing off. First failing command:

   `<exact command>` exited <code>.

   Failing tests (at most 20): <names>
   First errors: <at most 10 lines>
   REDBUILD
   )
   title=$(cat <<'TITLE'
   Red build on <default>
   TITLE
   )
   printf '%s' "$body" | PAPERCLIP_RUN_ID=<Run ID> forge-post issue <owner/repo> "$title" -
   ```

   Then fix it per `open-pr` if the fix is in Swift code, link the pull
   request on the issue, and leave the issue for the merge to close.
8. Finish per `company-conduct`, with the comment or issue link on your board
   issue.

## Proposing a release

`release-propose` lists apps from `rtech/k3s-deploy`, and an Apple app is not
there. For an Apple app, follow `release-propose` steps 3 to 8 on its repo,
with the tag names from the repo's README or CHANGELOG. An Apple app has no
`enroll-app` release and no `<app>_<stage>` tags: in step 7's body, replace
everything from `The owner runs` through `Never \`git push --tags\`.` with the
tag command the README or CHANGELOG gives. A repo with no tag convention: say
so in the proposal and propose none. You never push the tag.

## Never

- Build, test or run a simulator off host01 (step 0; prose otherwise).
- Sign, archive for distribution, notarize, or upload: no
  `xcodebuild -exportArchive`, `xcrun altool`, `xcrun notarytool`, no
  TestFlight or App Store Connect. Prose: no agent in the deploy path, ever.
- Edit certificates, provisioning profiles, keychains or signing settings.
  Prose; every build passes `CODE_SIGNING_ALLOWED=NO`.
- Push a tag or merge. Prose for the tag; merge-check refuses the merge.
- Edit a repo's CI workflows. Prose: open a board issue instead.
