import { allowWorkTask } from "../spec-dispatch.js";

// Board watch: jobs that read the board and undo waste the server
// does not undo itself. On only with instanceConfig boardWatch set.

import { POISON } from "./poison.js";

const NOT_INVOKABLE = new Set(["paused", "error", "terminated", "archived"]);
const CLOSED = new Set(["done", "cancelled"]);

// The stable phrase of the server's notice for a task whose seat was paused
// ("Paperclip cannot safely continue automatic recovery because the original
// assignee is not invokable. ..."). The failed-retry notice ("... still has no
// live execution path ...") is a real failure and is never reopened.
export const STRANDED_PHRASE = "original assignee is not invokable";
export const RESUME_CAP = 10;
export const RESUME_MAX_AGE_MS = 7 * 24 * 3600 * 1000;
const RESUME_TAG = "Reopened by the resume sweep";
// The plugin has no Forge read, so it cannot tell a merged PR's review task
// from a live one: Review and Merge tasks are left alone.
const FORGE_TASK = /^(Review|Merge) /;

function newestComment(comments) {
	let best;
	for (const c of Array.isArray(comments) ? comments : []) {
		const t = Date.parse(c.createdAt ?? "");
		if (!Number.isNaN(t) && (!best || t > best.t))
			best = { t, body: String(c.body ?? ""), authorType: c.authorType };
	}
	return best;
}

export function watchOn(cfg) {
	const id = cfg?.boardWatch?.bishopAgentId;
	return typeof id === "string" && id ? id : undefined;
}

// One sweep tick: a blocked issue the server stranded while its seat was
// paused goes back to todo once the seat can run, with one comment, ever.
export async function runResumeSweep(ctx, now) {
	let reopened = 0;
	for (const company of await ctx.companies.list()) {
		const companyId = company.id;
		if (!watchOn(await ctx.config.get(companyId))) {
			ctx.logger.info("resume-sweep: off, no boardWatch config", { companyId });
			continue;
		}
		const agents = new Map((await ctx.agents.list({ companyId })).map((a) => [a.id, a]));
		const blocked = await ctx.issues.list({ companyId, status: "blocked" });
		for (const issue of blocked) {
			if (reopened >= RESUME_CAP) return;
			const seat = agents.get(issue.assigneeAgentId);
			if (!seat || NOT_INVOKABLE.has(seat.status) || FORGE_TASK.test(issue.title ?? "")) continue;
			const comments = await ctx.issues.listComments(issue.id, companyId);
			if (comments.some((c) => String(c?.body ?? "").includes(RESUME_TAG))) continue;
			const notice = newestComment(comments);
			if (
				notice?.authorType !== "system" ||
				!notice.body.includes(STRANDED_PHRASE) ||
				now() - notice.t > RESUME_MAX_AGE_MS
			)
				continue;
			const { blockedBy } = await ctx.issues.relations.get(issue.id, companyId);
			if ((blockedBy ?? []).some((b) => !CLOSED.has(b?.status))) continue;
			if (!(await allowWorkTask(ctx, companyId, issue))) continue;
			await ctx.issues.update(issue.id, { status: "todo" }, companyId);
			await ctx.issues.createComment(
				issue.id,
				`${RESUME_TAG}: this task was blocked because ${seat.name ?? seat.id} was paused, not because it failed (sf#1730).`,
				companyId,
			);
			reopened += 1;
			ctx.logger.info("resume-sweep: reopened", { issue: issue.identifier ?? issue.id });
		}
	}
}

const POISON_ORIGIN = "plugin:rodaddy.alerts:poison";
let filing = Promise.resolve();

// agent.run.failed: an error on the poison list files ONE high issue for
// Bishop per seat, string and UTC day; later hits that day comment on it.
// Serialized, so two failures at once cannot both file. Never pauses or
// cancels anything.
export function onRunFailed(ctx, event, now) {
	const run = filing.then(() => fileOrComment(ctx, event, now));
	filing = run.catch(() => {});
	return run;
}

async function fileOrComment(ctx, { companyId, payload: p = {} }, now) {
	const error = String(p.error ?? "").slice(0, 500);
	const poison = POISON.find((s) => error.includes(s));
	const bishop = poison && watchOn(await ctx.config.get(companyId));
	if (!bishop) return;
	const originId = `${p.agentId}|${poison}|${new Date(now()).toISOString().slice(0, 10)}`;
	const line = `Run ${p.runId} failed: ${error}`;
	const [hit] = await ctx.issues.list({ companyId, originKind: POISON_ORIGIN, originId, limit: 1 });
	if (hit) return void (await ctx.issues.createComment(hit.id, line, companyId));
	const seat = (await ctx.agents.get(p.agentId, companyId))?.name ?? p.agentId;
	await ctx.issues.create({
		companyId,
		title: `Config: ${seat} runs fail "${poison}"`,
		description: `${line}\n\nThis error is on the poison list (fleet/plugins/alerts/poison.js): config, not transient, so a retry fails the same way. Later failures today are comments here (sf#1730).`,
		assigneeAgentId: bishop,
		status: "todo",
		priority: "high",
		originKind: POISON_ORIGIN,
		originId,
	});
}
