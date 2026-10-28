// Tier labels on the board: a Review, Merge or Rework
// task carries its repo's tier-N label, at most one. Label ids come from the
// plugin config `tierLabels` ({ "tier-0": "<id>", ... "tier-5": "<id>" }); the plugin SDK cannot
// list labels, and fleet/bin/ensure-labels prints the ids to paste.

const TIER_TASK = /^(?:Review|Merge|Rework) ([\w.-]+\/[\w.-]+)#\d+\b/;
export const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
const OPEN = new Set(OPEN_STATUSES);
export const RETAG_CAP = 50;

// The <owner>/<repo> a tier-tagged task title names, else null.
export function tierTaskRepo(title) {
	return (typeof title === "string" && TIER_TASK.exec(title)?.[1]) || null;
}

// tierLabels config -> Map(tier -> label id), or null when no id is set.
export function tierLabelIds(raw) {
	const ids = new Map();
	for (let t = 0; t <= 5; t++) {
		const id = raw?.[`tier-${t}`];
		if (typeof id === "string" && id) ids.set(t, id);
	}
	return ids.size > 0 ? ids : null;
}

// labelIds with every tier label replaced by tier's; other labels kept. A tier
// with no configured id leaves the labels unchanged.
export function withTierLabel(labelIds, ids, tier) {
	const want = ids.get(tier);
	if (!want) return labelIds;
	const tierIds = new Set(ids.values());
	return [...labelIds.filter((id) => !tierIds.has(id)), want];
}

const sameSet = (a, b) => a.length === b.length && a.every((id) => b.includes(id));

// The hourly re-tag: the company's open issues are listed once (the plugin
// SDK's issues.list has no text search, so titles are matched here), then per
// allowed repo with a task, one tier read (null = failed, the repo is skipped)
// and each open Review/Merge/Rework task whose tier label differs is updated.
// At most RETAG_CAP updates per run; one log line per change. No ids: nothing.
// deps: repos, ids, repoTier(repo) -> tier | null, listOpen() -> issues,
// update(id, labelIds), log
export async function retagTiers(deps) {
	if (!deps.ids) return 0;
	const byRepo = new Map();
	const seen = new Set();
	for (const i of await deps.listOpen()) {
		const repo = tierTaskRepo(i?.title);
		if (!repo || !deps.repos.includes(repo) || !OPEN.has(i.status) || seen.has(i.id)) continue;
		seen.add(i.id);
		byRepo.set(repo, [...(byRepo.get(repo) ?? []), i]);
	}
	let updated = 0;
	for (const [repo, tasks] of byRepo) {
		const tier = await deps.repoTier(repo);
		if (tier == null) continue;
		for (const i of tasks) {
			// No labelIds in the answer: replacing would drop labels never seen.
			if (!Array.isArray(i.labelIds)) continue;
			const next = withTierLabel(i.labelIds, deps.ids, tier);
			if (sameSet(next, i.labelIds)) continue;
			if (updated >= RETAG_CAP) {
				deps.log(`forge-pr: tier retag cap ${RETAG_CAP} reached`);
				return updated;
			}
			try {
				await deps.update(i.id, next);
				updated++;
				deps.log(`forge-pr: tier retag ${i.identifier ?? i.id} ${repo} -> tier-${tier}`);
			} catch (err) {
				deps.log(`forge-pr: tier retag ${i.id} failed: ${err?.name || "Error"}`);
			}
		}
	}
	return updated;
}
