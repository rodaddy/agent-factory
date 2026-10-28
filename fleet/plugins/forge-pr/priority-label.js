// The PR priority label: a Forge PR
// labelled exactly `priority` puts the board `priority` label on its open
// Review, Merge and Rework tasks; the label leaving the PR takes it off them.
// The board label id is tierLabels.priority (fleet/bin/ensure-labels prints it).

export const PRIORITY_LABEL = "priority";
const OPEN = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const PR_TASK = /^(?:Review|Merge|Rework) ([\w.-]+\/[\w.-]+)#(\d+)\b/;
export const PRIORITY_CAP = 50;

// True when a Forge PR or issue object carries the label named exactly priority.
export function hasPriorityLabel(item) {
	return (Array.isArray(item?.labels) ? item.labels : []).some((l) => l?.name === PRIORITY_LABEL);
}

// tierLabels config -> the board priority label id, or null.
export function priorityLabelId(raw) {
	const id = raw?.[PRIORITY_LABEL];
	return typeof id === "string" && id ? id : null;
}

// The PR a Review/Merge/Rework title names, as "<owner>/<repo>#<n>", else null.
export function taskPrKey(title) {
	const m = typeof title === "string" ? PR_TASK.exec(title) : null;
	return m ? `${m[1]}#${m[2]}` : null;
}

export const priorityStateKey = (prKey) => `prio:${prKey}`;

// labelIds with the priority id added (on) or removed (off); others kept.
function withPriority(labelIds, id, on) {
	const rest = labelIds.filter((l) => l !== id);
	return on ? [...rest, id] : rest;
}

// Syncs each open PR's priority label to its tasks. A PR without the label is
// visited only when its recorded state says it had it, so a board label an
// agent set by hand is never removed. The record is written once every task
// of the PR is in step; a cap stop or a failed write leaves it for next tick.
// The company's open issues are listed at most once per call, and only when a
// PR needs visiting: the plugin SDK's issues.list has no text search, so the
// titles are matched here (the same read as the tier re-tag).
// deps: prs [{ repo, number, on }], id, listOpen() -> issues, update(id, labelIds),
// stateGet, stateSet, log, counter { n }
export async function syncPriority(deps) {
	let byPr = null;
	const tasksOf = async (prKey) => {
		if (!byPr) {
			byPr = new Map();
			const seen = new Set();
			for (const i of await deps.listOpen()) {
				const key = taskPrKey(i?.title);
				if (!key || !OPEN.has(i.status) || seen.has(i.id)) continue;
				seen.add(i.id);
				byPr.set(key, [...(byPr.get(key) ?? []), i]);
			}
		}
		return byPr.get(prKey) ?? [];
	};
	for (const pr of deps.prs) {
		const prKey = `${pr.repo}#${pr.number}`;
		const key = priorityStateKey(prKey);
		const rec = await deps.stateGet(key);
		if (!pr.on && rec?.on !== true) continue;
		// Set first when on, so a task created this tick is created with it.
		if (pr.on && rec?.on !== true) await deps.stateSet(key, { on: true });
		let inStep = true;
		for (const i of await tasksOf(prKey)) {
			// No labelIds in the answer: replacing would drop labels never seen.
			if (!Array.isArray(i.labelIds)) continue;
			if (i.labelIds.includes(deps.id) === pr.on) continue;
			const next = withPriority(i.labelIds, deps.id, pr.on);
			if (deps.counter.n >= PRIORITY_CAP) {
				deps.log(`forge-pr: priority label cap ${PRIORITY_CAP} reached`);
				return;
			}
			try {
				await deps.update(i.id, next);
				deps.counter.n++;
				deps.log(
					`forge-pr: priority label ${pr.on ? "added" : "removed"} ${i.identifier ?? i.id} ${prKey}`,
				);
			} catch (err) {
				inStep = false;
				deps.log(`forge-pr: priority label ${i.id} failed: ${err?.name || "Error"}`);
			}
		}
		if (!pr.on && inStep) await deps.stateSet(key, { on: false });
	}
}
