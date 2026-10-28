body=$(cat <<'VERDICT'
## Review of [rtech/rtech-infra#2617](https://forge.example.internal/rtech/rtech-infra/pulls/2617) at 10177d7

**Ran:** `uv run --no-project --python ~/.local/share/uv/tools/ansible-core/bin/python python -` (load this play into Ansible's real batch planner and task iterator, synthetic inventory only) -> exit 0.
**Checks:** Ansible syntax check through `PlaybookCLI`, retaining repository config except the unavailable vault-password file, with `--syntax-check --check -i review_host, -e target=review_host` -> exit 0; evaluation of the play's actual verification expressions for forward/backout success, `pg_up 0`, and bgwriter still present -> exit 0; `git diff --check origin/main...10177d7027f4da1adcda98ef462841b8fe3555b4` -> exit 0; head re-read immediately before publication -> unchanged.

### Findings
1. **P2 — The first failed verification does not contain a multi-host rollout** — `projects/ansible/playbooks/postgres-exporter.yml:33-35`
   The default target selects multiple hosts, but the play has neither `serial: 1` nor `any_errors_fatal: true`. The PR body says its post-restart assert makes a failure stop at the first host. In fact, the default linear strategy advances all selected hosts through writing the drop-in and flushing restart handlers before any host reaches verification. A bad restart/health result therefore cannot protect the remaining exporters in a multi-host invocation. This is a failure-path defect; the explicitly documented deployment procedure of limiting each apply to one host mitigates it, so it is not a P1 blocker.

   Reproduction used ansible-core 2.21.5 and the unchanged play. Five synthetic hosts in group `postgres` produced `strategy=linear`, `serial=[]`, `any_errors_fatal=False`, and one batch containing all five. Ansible's actual `PlayIterator` over two synthetic hosts then produced:
   ```text
   review_a Disable the bgwriter collector through a drop-in
   review_b Disable the bgwriter collector through a drop-in
   review_a Flush handlers before verification
   review_b Flush handlers before verification
   review_a Verify pg_up is 1 and bgwriter is in the expected state
   Injected verify failure on review_a
   review_b Verify pg_up is 1 and bgwriter is in the expected state
   ```
   This ran no connections, modules, or infrastructure operations. The single-host rehearsal cannot disprove the multi-host behavior. Minimal batch reproduction, from `projects/ansible` in the pinned clone:
   ```python
   from ansible.plugins.loader import init_plugin_loader
   init_plugin_loader()
   from ansible.parsing.dataloader import DataLoader
   from ansible.inventory.manager import InventoryManager
   from ansible.playbook.play import Play
   from ansible.template import Templar
   from ansible.executor.playbook_executor import PlaybookExecutor
   loader = DataLoader()
   data = loader.load_from_file('playbooks/postgres-exporter.yml', trusted_as_template=True)[0]
   play = Play.load(data, loader=loader)
   play.hosts = Templar(loader=loader).template(play.hosts)
   inventory = InventoryManager(loader=loader, sources=[])
   for group in ('postgres', 'king_market_data', 'cc_cluster'):
       inventory.add_group(group)
   for name in ('review_a', 'review_b'):
       inventory.add_host(name, group='postgres')
   executor = object.__new__(PlaybookExecutor)
   executor._inventory = inventory
   print(play.strategy, play.serial, play.any_errors_fatal)
   print([[host.name for host in batch] for batch in executor._get_serialized_batches(play)])
   ```
   **Fix:** Add `serial: 1` and `any_errors_fatal: true`, so each exporter is verified before starting the next batch and a failed verification prevents subsequent batches.

### Suggestions (not defects)
- None.

The current body contains both required sections. I fetched the exact [rehearsal receipt](https://forge.example.internal/rtech/rtech-infra/issues/2616#issuecomment-106948), authored by sf-nagatha and bound to `10177d70`: it records real forward/backout/re-apply/idempotence runs with rc=0 against a twin of the packaged unit, including the actual pg_up/bgwriter asserts and independent database-log probes. The written backout removes the drop-in and restarts before reverting. This resolves the earlier missing-rehearsal gate. These are checked documentary execution results, not live operations independently re-run by me; no production apply is claimed.

Verification limitations: the ordinary repository-config syntax command initially exited 1 because `~/.ansible/rtech-infra-vault-pass` is absent. Two vault-override experiments also exited 1, a `/dev/null` config experiment exited 5, and preliminary Python API probes exited 1 while adapting to this installed Ansible version. The final syntax/batching/iterator/predicate checks above all exited 0. No dedicated tests for this new play are present; ansible-lint is not installed locally (the head's CI lint and syntax statuses are green). The macOS `/opt/dev/AGENTS.md` reference is absent on this box; repository `AGENTS.md` and `_AGENTS.md` were read. No live Ansible execution, source edits, pushes, merges, or Forge approval action. Own per-PR clone is clean. Scope reviewed: the sole added 141-line playbook, at the full pinned SHA above.

verdict: approve
blast radius: confirmed
VERDICT
)
paperclipai issue comment "$PAPERCLIP_TASK_ID" --run-id "$PAPERCLIP_RUN_ID" --body "$body"
printf '%s' "$body" | PAPERCLIP_RUN_ID="$PAPERCLIP_RUN_ID" forge-post comment rtech/rtech-infra 2617 -