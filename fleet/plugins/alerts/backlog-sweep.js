import { allowWorkTask } from "../spec-dispatch.js";

// Backlog sweep: Paperclip never wakes a backlog
// task, so this hourly job moves runnable ones to todo, which wakes the seat.
// On only with instanceConfig backlogSweep.triageAgentId set.

export const BACKLOG_ORIGIN = "plugin:rodaddy.alerts:backlog";
export const MOVE_CAP = 20;
const IDLE_MS = 24 * 3600 * 1000;
// The statuses forge-pr calls NOT_INVOKABLE.
const NOT_INVOKABLE = new Set(["paused", "error", "terminated", "archived"]);

function triageOf(cfg) {
	const id = cfg?.backlogSweep?.triageAgentId;
	return typeof id === "string" && id ? id : undefined;
}

const names = (issue) => (Array.isArray(issue?.labels) ? issue.labels : []).map((l) => l?.name);

// Tiers 0-5, 0 is infra. Untagged sorts as tier 3, like the queue order.
// Several tier labels: the lowest (most urgent) wins, whatever the label order.
function tierOf(issue) {
	const tiers = names(issue)
		.map((n) => /^tier-([0-5])$/.exec(n ?? "")?.[1])
		.filter(Boolean)
		.map(Number);
	return tiers.length ? Math.min(...tiers) : 3;
}

const idleMs = (issue, t) => t - (Date.parse(issue?.updatedAt ?? "") || t);

// Why the task moves now, or undefined when it waits.
function reasonFor(issue, t) {
	if (names(issue).includes("priority")) return "it carries the priority label";
	const tier = tierOf(issue);
	if (tier <= 2) return `its repo is tier-${tier}`;
	const idle = idleMs(issue, t);
	if (idle >= IDLE_MS) return `it sat in backlog ${Math.floor(idle / 3600000)} h`;
	return undefined;
}

// One call, no limit or offset: the installed host applies limit/offset in SQL
// and then again in memory (applyWindow), so a second page always came back
// empty. The whole backlog is read before anything moves.
const listBacklog = (ctx, companyId) => ctx.issues.list({ companyId, status: "backlog" });

async function fileDigest(ctx, companyId, triage, unassigned, t) {
	const originId = new Date(t).toISOString().slice(0, 10);
	const [hit] = await ctx.issues.list({
		companyId,
		originKind: BACKLOG_ORIGIN,
		originId,
		limit: 1,
	});
	if (hit) return;
	const lines = unassigned.map(
		(i) =>
			`- ${i.identifier ?? i.id} ${i.title ?? ""}, idle ${Math.floor(idleMs(i, t) / 3600000)} h`,
	);
	await ctx.issues.create({
		companyId,
		title: `Backlog: ${unassigned.length} unassigned tasks (${originId})`,
		description: `These backlog tasks have no assignee, so the backlog sweep cannot move them. Assign each one or close it (sf#1730).\n\n${lines.join("\n")}`,
		assigneeAgentId: triage,
		status: "todo",
		priority: "medium",
		originKind: BACKLOG_ORIGIN,
		originId,
	});
}

// One hourly tick. Moves at most MOVE_CAP tasks across companies, priority
// label first, then lower tier, then the longest idle.
export async function runBacklogSweep(ctx, now) {
	let left = MOVE_CAP;
	const t = now();
	for (const company of await ctx.companies.list()) {
		const companyId = company.id;
		const triage = triageOf(await ctx.config.get(companyId));
		if (!triage) {
			ctx.logger.info("backlog-sweep: off, no backlogSweep config", { companyId });
			continue;
		}
		const backlog = await listBacklog(ctx, companyId);
		const unassigned = backlog.filter((i) => !i.assigneeAgentId);
		if (unassigned.length) {
			try {
				await fileDigest(ctx, companyId, triage, unassigned, t);
			} catch (err) {
				ctx.logger.warn("backlog-sweep: digest failed", { companyId, error: String(err) });
			}
		}
		const seats = new Map((await ctx.agents.list({ companyId })).map((a) => [a.id, a]));
		const due = backlog
			.filter((i) => {
				const seat = seats.get(i.assigneeAgentId);
				return seat && !NOT_INVOKABLE.has(seat.status) && reasonFor(i, t);
			})
			.map((i) => ({
				i,
				p: names(i).includes("priority") ? 0 : 1,
				tier: tierOf(i),
				idle: idleMs(i, t),
			}))
			.sort((a, b) => a.p - b.p || a.tier - b.tier || b.idle - a.idle);
		// A failure skips that task only; only a task that moved counts against the cap.
		for (const { i } of due) {
			if (left <= 0) break;
			const issue = i.identifier ?? i.id;
			try {
				if (!(await allowWorkTask(ctx, companyId, i))) continue;
				await ctx.issues.update(i.id, { status: "todo" }, companyId);
			} catch (err) {
				ctx.logger.warn("backlog-sweep: move failed", { issue, error: String(err) });
				continue;
			}
			left -= 1;
			ctx.logger.info("backlog-sweep: moved", { issue });
			try {
				await ctx.issues.createComment(
					i.id,
					`Moved out of backlog by the backlog sweep: ${reasonFor(i, t)} (sf#1730).`,
					companyId,
				);
			} catch (err) {
				ctx.logger.warn("backlog-sweep: comment failed", { issue, error: String(err) });
			}
		}
		if (left <= 0) return;
	}
}
