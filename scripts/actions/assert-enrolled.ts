/**
 * @module actions/assert-enrolled
 * @description Refuse a `workflow_dispatch` whose `repo` input is not a repo
 *   the watcher itself would dispatch this lane for (verdict sweep group A:
 *   factory pr-review verdicts on PRs 889, 896, 903). `validate-inputs.ts`
 *   checks syntax only, so any `owner/name` reached FORGE_TOKEN. The rule is
 *   read from `config/repos.yml` in the TRUSTED checkout (the workflow's own
 *   ref) and mirrors the hook predicates in src/hooks/{pr-review,
 *   issue-triage,implement}.ts: an enrolled Forgejo repo with the lane's
 *   runtime flag set to `actions`, never software-factory itself (except
 *   prepush and pr-review, which D23 runs on software-factory too: sf#828,
 *   sf#927).
 *
 *   Usage (values arrive through `env:`, never `${{ }}` in `run:`):
 *     bun scripts/actions/assert-enrolled.ts <pr-review|issue-triage|implement|prepush> "$REPO" [config]
 *   Exit 0 when enrolled, 1 when not (never echoing the value), 2 on usage or
 *   an unreadable config.
 *
 * @outputs
 *   - `isEnrolledFor` -- the (config, lane, repo) predicate
 */
import { loadConfig } from "../../src/config/load";
import type { WatcherConfig } from "../../src/config/schema";
import { SOP_GATE_DISPATCH_REPO } from "../../src/hooks/sop-gate";
import { traced } from "../../src/log";

type Repo = WatcherConfig["repositories"][number];

const LANES: Readonly<Record<string, (repo: Repo) => boolean>> = {
	"pr-review": (r) =>
		r.pr_review !== false && r.pr_review_runtime === "actions" && r.checks !== "static-only",
	"issue-triage": (r) => r.triage === true && r.triage_runtime === "actions",
	implement: (r) => r.implement_runtime === "actions" && r.implement_label !== undefined,
	// sf#828 D23: prepush.yml posts factory/prepush on every PR head of a
	// repo on the Actions prepush runtime, software-factory itself included.
	prepush: (r) => r.prepush_runtime === "actions",
};

/** Lanes whose workflow also runs for software-factory itself. */
const SELF_LANES: ReadonlySet<string> = new Set(["prepush", "pr-review"]);

function isEnrolledForImpl(config: WatcherConfig, lane: string, repo: string): boolean {
	const laneOn = LANES[lane];
	if (laneOn === undefined || (repo === SOP_GATE_DISPATCH_REPO && !SELF_LANES.has(lane))) {
		return false;
	}
	return config.repositories.some((r) => r.name === repo && r.provider === "forgejo" && laneOn(r));
}

export const isEnrolledFor = traced("actions.isEnrolledFor", isEnrolledForImpl);

if (import.meta.main) {
	const [lane = "", repo = "", path = "config/repos.yml", ...rest] = process.argv.slice(2);
	if (LANES[lane] === undefined || repo === "" || rest.length > 0) {
		process.stderr.write(
			"usage: assert-enrolled.ts <pr-review|issue-triage|implement|prepush> <repo> [config]\n",
		);
		process.exit(2);
	}
	const loaded = await loadConfig(path);
	if (!loaded.ok) {
		process.stderr.write(`config unreadable: ${loaded.error}\n`);
		process.exit(2);
	}
	if (!isEnrolledFor(loaded.config, lane, repo)) {
		process.stderr.write(`repo input is not enrolled for the ${lane} actions lane\n`);
		process.exit(1);
	}
	process.stdout.write("repo enrolled\n");
}
