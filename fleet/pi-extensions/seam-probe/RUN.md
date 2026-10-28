# seam-probe: the run

Who: the rtech-infra seat, on sf-fleet-01, as `rico`, after Pi 1.0.3 is
installed. This lane built the probe; it did not run it.

1. Run Pi once with the argv Paperclip's `pi_local` adapter builds, plus the
   probe. Fill in `<p>`/`<m>` with the box's configured provider and model
   (on sf-fleet-01 the `pi_local` agents use `bifrost`). The provider keys in
   `~/.pi/agent/models.json` are `$VAR` references, so load the fleet env
   first or Pi stops with "No API key found".

```bash
set -a; . ~/.config/fleet/env; set +a
out=~/pi-seam-probe.jsonl; rm -f "$out"
PI_SEAM_PROBE_OUT="$out" PAPERCLIP_RUN_ID=probe-p02 \
  pi --mode json -p --provider <p> --model <m> --tools read,bash \
     --session ~/pi-seam-probe.session --tools read,grep \
     -ne -e ~/fleet/pi-extensions/seam-probe/index.ts "Reply with the word OK."
cat "$out"
```

2. Read the `tools` line. The argv carries two `--tools`, so (c) has two
   possible outcomes: `active` is `read,bash` (first wins) or `read,grep`
   (last wins). Record which one won; that finding is the deliverable.

3. Run the check with the CSV observed in the `tools` line (no pipe: the
   exit code is the verdict; 0 pass, 1 a seam failed, 3 harness error):

```bash
~/fleet/../src/rodaddy/software-factory/scripts/done-means/pi-seams-probe.sh "$out" <the tools CSV that won>
echo "rc=$?"
```

4. Post on sf#1493: the `cat "$out"` lines, the check's output and `rc`, and
   which `--tools` won (first or last). Never paste the prompt or env values.

Result 2026-10-05 (sf-fleet-01, Pi 1.0.3, provider bifrost): all four seams
PASS, `rc=0`, and the LAST `--tools` wins (`read,grep`). The JSONL is kept at
`_reports/pi-workforce/p0.2-seam-probe-sf-fleet-01-2026-10-05.jsonl`.
