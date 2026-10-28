State: WRITTEN, not installed. Nothing here runs until the install below is done on host01.

# fleet/notify: text Rico when the board needs him

A per-user LaunchAgent on host01 runs `rico-notify.ts` every 300 s. Each pass
makes read-only GETs to the fleet board and sends each new thing ONCE through
`imsg send --to <handle> --service imessage --text <text> --json`. It never
writes to the board or to Forge.

## What it sends

1. An issue `blocked` with `unblockDescriptor.owner == "board"`.
2. A pending `request_board_approval`.
3. An agent whose last 3 finished runs all failed, or in `error` 3 passes in a row.
4. An agent's board comment whose first line starts `TELL RICO:`.
5. The board not answering 3 passes in a row.

Every text carries a direct link to the one thing it is about: the Forge link
in the action or approval, else that issue's, approval's or agent's own board
page. Limits: the first pass is one summary; at most 6 texts per rolling hour;
more than 3 new at once is one summary; a failing agent is re-told no sooner
than 60 minutes after it recovers. A summary can only carry the board link.

It is NOT the criticals path. It never reads Alertmanager, Prometheus or
`[monitoring-critical]` issues; those go to the factory and Nagatha.

## The env file

`/opt/factory-notify/env`, mode 600, on host01 only, never in
git. The job refuses a file others can read. `KEY=VALUE` lines:

- `PAPERCLIP_API_URL`, `PAPERCLIP_COMPANY_ID`, `PAPERCLIP_BOARD_TOKEN`, `RICO_NOTIFY_TO`: required.
- `RICO_NOTIFY_DIR`: where the job's files live (default `/opt/factory-notify`).
- `RICO_NOTIFY_STATE` (default `<dir>/state.json`), `RICO_NOTIFY_SEND` (default `/opt/homebrew/bin/imsg`).
- `RICO_NOTIFY_BOARD_LINK`: the board address his phone can open (default the API URL).
- `RICO_NOTIFY_BOARD_PREFIX`: the company's URL prefix, if board pages need one. The
  page paths `/issues/<identifier>`, `/approvals/<id>`, `/agents/<id>` are NOT yet
  checked against the live board: open one link from the dry run before the install.
- `RICO_NOTIFY_HEARTBEAT=1`: one "alive" text a day from `RICO_NOTIFY_HEARTBEAT_HOUR`
  (default 8). OFF by default.

## Install (one Nagatha board task, through `ssh host01`)

1. Check: `ls /opt/homebrew/bin/imsg /opt/homebrew/opt/node@24/bin/node`,
   `imsg --version`, `imsg send --help` (shows `--to --text --service --json`),
   `launchctl print gui/$(id -u) >/dev/null && echo gui-session-present`.
   Anything missing: stop and hand up. Node keg missing: `brew install node@24`.
2. Copy `rules.ts`, `plan.ts`, `rico-notify.ts` to `/opt/factory-notify/`
   and write the commit sha to `DEPLOYED` there.
3. Create `env` there, mode 600. The token is piped over stdin, never on a
   command line. `stat -f %Lp env` prints `600`.
4. Dry run: `cd /opt/factory-notify && RICO_NOTIFY_ENV_FILE=$PWD/env
   RICO_NOTIFY_STATE=$PWD/state.json /opt/homebrew/opt/node@24/bin/node rico-notify.ts --dry-run`
   prints one `Factory notifier is on. <n> already waiting` text, exit 0, no
   `state.json`. `<n>` must match the board.
5. Copy the plist to `~/Library/LaunchAgents/`, then
   `launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.rico.factory-notify.plist`
   and `launchctl print gui/$(id -u)/com.rico.factory-notify`.
6. RUNNING means Rico's phone got the text and `notify.log` shows `rico-notify: sent`.

By hand, by a person: the first run may show `"node" wants access to control
"Messages"` on host01's screen. Only someone at that screen can allow it.

Stop it: `launchctl bootout gui/$(id -u)/com.rico.factory-notify`.

## Traps

- `brew upgrade node@24` changes the binary and can void that consent: `brew pin node@24`.
- The agent runs only while rico is logged in at host01's screen.
- Exit 0 and status `sent` mean handed to Messages, not delivered. Only his phone proves it.
- A consent failure reads `send failed` with `Not authorized` or `-1743` in `notify.log`.
- Fallback sender, documented only, not wired: `/usr/bin/osascript -e 'on run argv'
  -e 'tell application "Messages" to send (item 2 of argv) to participant (item 1 of argv) of (1st account whose service type = iMessage)'
  -e 'end run' "<handle>" "<text>"`.
