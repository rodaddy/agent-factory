import crypto from "node:crypto";
import { allowWorkTask } from "../spec-dispatch.js";

// Every comment this plugin writes carries this marker, so a later delivery can
// tell its own comments from Nagatha's or a human's.
export const MARKER = "<!-- rodaddy.alerts -->";
export const REPEAT_QUIET_MS = 30 * 60 * 1000;
const CLOSED = new Set(["done", "cancelled"]);

export function headerValue(headers, name) {
	if (!headers) return undefined;
	const want = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
	}
	return undefined;
}

// The shared secret travels in its own header, X-Alerts-Token (Alertmanager
// http_config.http_headers, read from a mounted file). Not Authorization:
// Paperclip's auth layer treats any `Authorization: Bearer` as a board key
// and answers 401 before the plugin sees the delivery (probed 2026-10-02).
export const TOKEN_HEADER = "x-alerts-token";

// Constant-time: both sides are hashed first, so length leaks nothing either.
export function verifyToken(headerToken, secret) {
	if (typeof headerToken !== "string" || typeof secret !== "string" || !secret) return false;
	const digest = (s) => crypto.createHash("sha256").update(s, "utf8").digest();
	return crypto.timingSafeEqual(digest(headerToken), digest(secret));
}

// The same key Nagatha's hourly infra-health check uses, so both land on one issue.
function alertWhere(labels) {
	const l = labels ?? {};
	return l.namespace || l.instance || l.job || "-";
}

export function alertKey(labels) {
	return `alert:${labels?.alertname || "?"}:${alertWhere(labels)}`;
}

export function alertTitle(labels) {
	return `Infra: ${alertKey(labels)}`;
}

// Alertmanager webhook v4 to one entry per board key. Watchdog (the always-firing
// heartbeat) is skipped. Several alerts on one key collapse: firing if any fires.
export function parseAlerts(body) {
	const alerts = Array.isArray(body?.alerts) ? body.alerts : [];
	const byKey = new Map();
	for (const a of alerts) {
		if (!a || typeof a !== "object") continue;
		const labels = a.labels && typeof a.labels === "object" ? a.labels : {};
		if (labels.alertname === "Watchdog") continue;
		const status = a.status === "resolved" ? "resolved" : "firing";
		const entry = {
			key: alertKey(labels),
			title: alertTitle(labels),
			status,
			labels,
			annotations: a.annotations && typeof a.annotations === "object" ? a.annotations : {},
			startsAt: a.startsAt ?? "",
			endsAt: a.endsAt ?? "",
			generatorURL: a.generatorURL ?? "",
		};
		const prev = byKey.get(entry.key);
		if (!prev || (prev.status === "resolved" && status === "firing")) byKey.set(entry.key, entry);
	}
	return [...byKey.values()];
}

export function summaryOf(alert) {
	return alert.annotations.summary || alert.labels.alertname || alert.key;
}

export function issueDescription(alert) {
	const labels = Object.keys(alert.labels)
		.sort()
		.map((k) => `- ${k}: ${alert.labels[k]}`);
	return [
		`Summary: ${summaryOf(alert)}`,
		`Description: ${alert.annotations.description ?? ""}`,
		"",
		"Labels:",
		...labels,
		"",
		`Started: ${alert.startsAt}`,
		`Source: ${alert.generatorURL}`,
		"",
		"Raised by Alertmanager through the alerts plugin.",
	].join("\n");
}

export function issueTask(alert, { assigneeAgentId }) {
	return {
		title: alert.title,
		description: issueDescription(alert),
		assigneeAgentId,
		status: "todo",
		priority: alert.labels.severity === "critical" ? "high" : "medium",
	};
}

// Who an alert's issue goes to. `cfg.routes` is an optional list of
// { match, assigneeAgentId }: `match` is a regex tested on the alertname and on
// the key, and the first route that matches wins. No match, or a route that is
// malformed or carries a bad regex, falls back to cfg.assigneeAgentId: a throw
// here would 502 the whole delivery at the host.
export function assigneeFor(alert, cfg) {
	const routes = Array.isArray(cfg?.routes) ? cfg.routes : [];
	for (const r of routes) {
		if (
			typeof r?.match !== "string" ||
			typeof r?.assigneeAgentId !== "string" ||
			!r.assigneeAgentId
		)
			continue;
		let re;
		try {
			re = new RegExp(r.match);
		} catch {
			continue;
		}
		if (re.test(alert.labels.alertname ?? "") || re.test(alert.key)) return r.assigneeAgentId;
	}
	return cfg?.assigneeAgentId;
}

export function findOpen(issues, title) {
	return (Array.isArray(issues) ? issues : []).find(
		(i) => i?.title === title && !CLOSED.has(i.status),
	);
}

function newest(comments) {
	let best;
	for (const c of Array.isArray(comments) ? comments : []) {
		const t = Date.parse(c?.createdAt ?? "");
		if (Number.isNaN(t)) continue;
		if (!best || t > best.t) best = { t, c };
	}
	return best;
}

/** create | comment | resolve-close | resolve-comment | skip */
export function decide(alert, openIssue, comments, nowMs) {
	if (alert.status === "resolved") {
		if (!openIssue) return "skip";
		return openIssue.status === "todo" || openIssue.status === "backlog"
			? "resolve-close"
			: "resolve-comment";
	}
	if (!openIssue) return "create";
	const last = newest(comments);
	if (
		last &&
		typeof last.c.body === "string" &&
		last.c.body.includes(MARKER) &&
		nowMs - last.t < REPEAT_QUIET_MS
	)
		return "skip";
	return "comment";
}

export function firingComment(alert, nowIso) {
	return `still firing at ${nowIso}: ${summaryOf(alert)}\n\n${MARKER}`;
}

export function resolvedComment(alert) {
	return `RESOLVED at ${alert.endsAt} (Alertmanager)\n\n${MARKER}`;
}

// Fold by root cause: one task per alert rule plus host group.
// fleet-verify: the check, the first path segment of its where (one task per
// check, not per finding). PiholeWrongAnswer: one group, `pihole`: the three
// Pi-holes serve one record set, and the 02Z burst had the same names wrong on
// each. Any other rule: the host without port and trailing node number
// (node01 and node07 are `proxmox`); an IP or a namespace stays as is.
export function hostGroup(alertname, where) {
	if (alertname === "fleet-verify") return where.split("/")[0] || where;
	if (alertname === "PiholeWrongAnswer") return "pihole";
	const host = where.replace(/:\d+$/, "");
	return /^[\d.]+$/.test(host) ? host : host.replace(/-?\d+$/, "") || host;
}

export function foldTitle(alert) {
	const name = alert.labels.alertname || "?";
	return `Infra: alert:${name}:${hostGroup(name, alertWhere(alert.labels))}`;
}

// The per-instance state of a folded task, `{ <where>: "firing" | "resolved" }`,
// lives on the task itself: the description at creation, then every comment
// this plugin writes carries the whole map. The newest one wins, so a resolve
// is invalidated the moment that instance fires again.
const STATE = "alerts-state: ";
function stateLine(state) {
	return `${STATE}${JSON.stringify(state)}`;
}
function stateIn(text) {
	const line = String(text ?? "")
		.split("\n")
		.find((l) => l.startsWith(STATE));
	try {
		const s = line ? JSON.parse(line.slice(STATE.length)) : null;
		return s && typeof s === "object" && !Array.isArray(s) ? s : null;
	} catch {
		return null;
	}
}
function currentState(issue, comments) {
	let best;
	for (const c of Array.isArray(comments) ? comments : []) {
		if (typeof c?.body !== "string" || !c.body.includes(MARKER)) continue;
		const t = Date.parse(c.createdAt ?? "");
		const s = stateIn(c.body);
		if (s && !Number.isNaN(t) && (!best || t >= best.t)) best = { t, s };
	}
	return best?.s ?? stateIn(issue.description) ?? {};
}
function instanceLines(state) {
	return [
		"Instances:",
		...Object.keys(state)
			.sort()
			.map((w) => `- ${w}: ${state[w]}`),
		"",
		stateLine(state),
	].join("\n");
}

// One delivery, start to finish. `board` is injected (the worker wires it to
// the Paperclip SDK), so this stays testable without the host.
export async function handleDelivery({ headers, body, secret, cfg, board, now }) {
	if (!verifyToken(headerValue(headers, TOKEN_HEADER), secret))
		throw new Error("alerts: token check failed");
	const nowMs = now();
	const nowIso = new Date(nowMs).toISOString();
	const folds = new Map();
	for (const alert of parseAlerts(body)) {
		const assigneeAgentId = assigneeFor(alert, cfg);
		const id = `${assigneeAgentId}\n${foldTitle(alert)}`;
		if (!folds.has(id)) folds.set(id, { assigneeAgentId, title: foldTitle(alert), alerts: [] });
		folds.get(id).alerts.push(alert);
	}
	const results = [];
	for (const [id, fold] of folds)
		results.push(await withFoldLock(id, () => deliverFold(fold, board, nowMs, nowIso)));
	return results;
}

// One fold's read-merge-persist-status cycle runs one at a time in this plugin
// process: two overlapping deliveries would read one state snapshot and the
// newer comment would drop the other's instances (forge-pr withKeyLock).
const inflight = new Map();
async function withFoldLock(key, fn) {
	const prev = inflight.get(key) ?? Promise.resolve();
	let release;
	const mine = new Promise((r) => {
		release = r;
	});
	const tail = prev.then(() => mine);
	inflight.set(key, tail);
	await prev;
	try {
		return await fn();
	} finally {
		release();
		if (inflight.get(key) === tail) inflight.delete(key);
	}
}

async function deliverFold({ assigneeAgentId, title, alerts }, board, nowMs, nowIso) {
	const seen = Object.fromEntries(alerts.map((a) => [alertWhere(a.labels), a.status]));
	const lead = alerts.find((a) => a.status === "firing") ?? alerts[0];
	const issues = await board.listIssues(assigneeAgentId);
	const open = findOpen(issues, title);
	const done = open ? undefined : issues.find((i) => i?.title === title && i.status === "done");
	const target = open ?? done;
	const comments = target ? await board.listComments(target.id) : [];
	const prev = target ? currentState(target, comments) : {};
	const state = { ...prev, ...seen };
	const changed = Object.keys(seen).some((w) => prev[w] !== seen[w]);
	const firing = Object.values(state).includes("firing");
	let action;
	if (!target) action = lead.status === "firing" ? "create" : "skip";
	else if (done) action = lead.status === "firing" ? "reopen" : "skip";
	else if (!firing) {
		const closable = open.status === "todo" || open.status === "backlog";
		// Unchanged but still open: the resolved state was persisted and the
		// status update failed (SOF-10340). Retry the close alone.
		if (!changed) action = closable ? "close" : "skip";
		else action = closable ? "resolve-close" : "resolve-comment";
	}
	// A delivery that changes an instance's state is news, never a quiet repeat.
	else if (changed) action = "comment";
	// An unchanged resolve while another instance fires: decide() would close.
	else action = lead.status === "firing" ? decide(lead, open, comments, nowMs) : "skip";
	const tail = `\n\n${instanceLines(state)}\n\n${MARKER}`;
	if (action === "create") {
		const task = issueTask({ ...lead, title }, { assigneeAgentId });
		if (alerts.some((a) => a.labels.severity === "critical")) task.priority = "high";
		task.description += `\n\n${instanceLines(state)}`;
		await board.createIssue(task);
	} else if (action === "reopen") {
		await board.updateIssue(target.id, { status: "todo" });
		await board.addComment(target.id, `firing again at ${nowIso}: ${summaryOf(lead)}${tail}`);
	} else if (action === "comment") {
		await board.addComment(target.id, `${firingComment(lead, nowIso).split("\n")[0]}${tail}`);
	} else if (action === "resolve-comment" || action === "resolve-close") {
		await board.addComment(target.id, `${resolvedComment(lead).split("\n")[0]}${tail}`);
		if (action === "resolve-close") await board.updateIssue(target.id, { status: "done" });
	} else if (action === "close") {
		await board.updateIssue(target.id, { status: "done" });
	}
	return { key: title.slice("Infra: ".length), action };
}

// A webhook carries no company and the worker may not call companies.list
// there (no invocation scope), so the company comes from the request.
export const COMPANY_HEADER = "x-alerts-company";
const COMPANY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// The project every alert issue is created in: cfg.projectId, else
// the board project named INFRA_PROJECT. Neither, or a failed read, answers
// undefined with one project-missing line: the issue is still created.
export const INFRA_PROJECT = "rtech/rtech-infra";
const PROJECT_PAGE = 100;
async function alertProject(ctx, companyId, cfg) {
	if (typeof cfg.projectId === "string" && cfg.projectId) return cfg.projectId;
	try {
		for (let offset = 0; ; offset += PROJECT_PAGE) {
			const page = await ctx.projects.list({ companyId, limit: PROJECT_PAGE, offset });
			const hit = (Array.isArray(page) ? page : []).find((p) => p?.name === INFRA_PROJECT);
			if (typeof hit?.id === "string") return hit.id;
			if (!Array.isArray(page) || page.length < PROJECT_PAGE) break;
		}
	} catch {
		// Logged below; an alert is never dropped for a project.
	}
	ctx.logger?.warn("alerts: project-missing", { repo: INFRA_PROJECT });
	return undefined;
}

// One webhook, start to finish, against the Paperclip ctx.
export async function handleWebhook(ctx, input, now) {
	if (input.endpointKey !== "alertmanager")
		throw new Error(`alerts: unknown endpoint ${input.endpointKey}`);
	const companyId = headerValue(input.headers, COMPANY_HEADER);
	if (typeof companyId !== "string" || !COMPANY_ID.test(companyId))
		throw new Error("alerts: x-alerts-company header missing or not a company id");
	const cfg = await ctx.config.get(companyId);
	if (!cfg?.bearer || !cfg?.assigneeAgentId)
		throw new Error("alerts: not configured for this company");
	const secret = await ctx.secrets.resolve(cfg.bearer, { companyId, configPath: "bearer" });
	// Read at most once per delivery, and only when an issue is created.
	let project;
	return handleDelivery({
		headers: input.headers,
		body: input.parsedBody ?? JSON.parse(input.rawBody),
		secret,
		cfg,
		now,
		board: {
			// The host caps a list at 100 rows and the company has far more
			// issues, so read only the open issues of the assignee this alert
			// routes to, one status at a time and through every page.
			// `done` too: a fold that fires again re-opens its done task.
			listIssues: (assigneeAgentId) =>
				issuesOf(ctx, companyId, assigneeAgentId, [...OPEN_STATUSES, "done"]),
			listComments: (issueId) => ctx.issues.listComments(issueId, companyId),
			createIssue: async (task) => {
				project ??= alertProject(ctx, companyId, cfg);
				const projectId = await project;
				return ctx.issues.create({ companyId, ...task, ...(projectId ? { projectId } : {}) });
			},
			addComment: (issueId, body) => ctx.issues.createComment(issueId, body, companyId),
			updateIssue: (issueId, patch) => ctx.issues.update(issueId, patch, companyId),
		},
	});
}

const OPEN_STATUSES = ["backlog", "todo", "in_progress", "in_review", "blocked"];
// An assignee's issues, one status at a time: the host caps a list at 100.
async function issuesOf(ctx, companyId, assigneeAgentId, statuses = OPEN_STATUSES) {
	const pages = await Promise.all(
		statuses.map(async (status) => {
			const issues = [];
			const seen = new Set();
			for (let page = 0; page < 50; page++) {
				const rows = await ctx.issues.list({
					companyId,
					assigneeAgentId,
					status,
					limit: 100,
					offset: page * 100,
				});
				const fresh = rows.filter((issue) => {
					if (seen.has(issue.id)) return false;
					seen.add(issue.id);
					return true;
				});
				if (rows.length && !fresh.length) {
					ctx.logger?.warn("alerts: repeated issue page, stopping", {
						companyId,
						assigneeAgentId,
						status,
					});
					return issues;
				}
				issues.push(...fresh);
				if (rows.length < 100) return issues;
			}
			ctx.logger?.warn("alerts: issue page limit reached", { companyId, assigneeAgentId, status });
			return issues;
		}),
	);
	return pages.flat();
}

// The Nagatha Ops guard: Ops keeps one slot for Nagatha's routines,
// so any open issue on Ops that is not routine work goes back to Nagatha.
export const OPS_GUARD_CAP = 20;
export const ALERTS_ORIGIN = "plugin:rodaddy.alerts";

// Routing uses the original webhook labels, never the folded display title.
// Older or edited issues without recoverable labels stay with their current owner.
export function alertOwner(issue, cfg) {
	// issueDescription writes its own labels just before this terminal footer.
	// Take the last header before that footer: annotations can contain Labels:.
	const description = String(issue?.description ?? "");
	const footer =
		/\n\nStarted: [^\n]*\nSource: [^\n]*\n\nRaised by Alertmanager through the alerts plugin\.$/.exec(
			description,
		);
	const prefix = footer ? description.slice(0, footer.index) : "";
	const header = prefix.lastIndexOf("\n\nLabels:\n");
	const block = header < 0 ? undefined : prefix.slice(header + "\n\nLabels:\n".length);
	if (block === undefined) return undefined;
	const labels = {};
	for (const line of block.split("\n")) {
		const m = /^- ([^:]+): (.*)$/.exec(line);
		if (!m) return undefined;
		labels[m[1]] = m[2];
	}
	if (!labels.alertname) return undefined;
	return assigneeFor({ key: alertKey(labels), labels }, cfg);
}

/** keep | hand-back */
export function opsGuardDecision(issue, cfg) {
	if (CLOSED.has(issue?.status)) return "keep";
	if (issue?.originKind === "routine_execution") return "keep";
	if (issue?.originKind === ALERTS_ORIGIN) {
		// An alert issue must sit where the webhook's dedupe and resolve look for
		// it, so it moves only when its alert now routes away from Ops; an
		// unknown owner stays put (PR 1741 review).
		const owner = alertOwner(issue, cfg);
		return owner === undefined || owner === cfg?.opsGuard?.opsAgentId ? "keep" : "hand-back";
	}
	return "hand-back";
}

// Who a handed-back issue goes to: an alert issue to its alert's owner, so the
// webhook still finds it; anything else to the home agent.
export function handBackTo(issue, cfg) {
	return (
		(issue?.originKind === ALERTS_ORIGIN && alertOwner(issue, cfg)) || cfg.opsGuard.homeAgentId
	);
}

// One guard tick across every company. No comment is ever posted.
export async function runOpsGuard(ctx) {
	let handed = 0;
	for (const company of await ctx.companies.list()) {
		const cfg = await ctx.config.get(company.id);
		const g = cfg?.opsGuard;
		if (
			typeof g?.opsAgentId !== "string" ||
			!g.opsAgentId ||
			typeof g?.homeAgentId !== "string" ||
			!g.homeAgentId
		) {
			ctx.logger.info("ops-guard: off, no opsGuard config", { companyId: company.id });
			continue;
		}
		for (const issue of await issuesOf(ctx, company.id, g.opsAgentId)) {
			if (handed >= OPS_GUARD_CAP) return;
			if (opsGuardDecision(issue, cfg) !== "hand-back") continue;
			// One refused update must not stop the tick for every other issue.
			try {
				const current = await ctx.issues.get(issue.id, company.id);
				if (
					!current ||
					CLOSED.has(current.status) ||
					current.status !== issue.status ||
					current.assigneeAgentId !== issue.assigneeAgentId ||
					opsGuardDecision(current, cfg) !== "hand-back"
				)
					continue;
				if (!(await allowWorkTask(ctx, company.id, current))) continue;
				const previousAssignee = current.assigneeAgentId;
				const assigneeAgentId = handBackTo(current, cfg);
				await ctx.issues.update(issue.id, { assigneeAgentId }, company.id);
				// The host API has no compare-and-swap; the read/write window remains.
				// Observe later reassignment without retrying or overwriting its owner.
				const after = await ctx.issues.get(issue.id, company.id);
				if (
					after &&
					after.assigneeAgentId !== assigneeAgentId &&
					after.assigneeAgentId !== previousAssignee
				) {
					ctx.logger.warn("ops-guard: concurrent reassignment", {
						issue: issue.identifier ?? issue.id,
					});
					handed += 1;
					continue;
				}
			} catch (err) {
				ctx.logger.warn("ops-guard: hand-back failed", {
					issue: issue.identifier ?? issue.id,
					reason: err instanceof Error ? err.message : String(err),
				});
				continue;
			}
			handed += 1;
			ctx.logger.info("ops-guard: handed back", { issue: issue.identifier ?? issue.id });
		}
	}
}
