import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { definePlugin, runWorker } from "@paperclipai/plugin-sdk";
import { allowWorkTask } from "../spec-dispatch.js";
import { wakeIdleSeats, wakeOnRunEnd } from "./idle-wake.js";
import {
	headerValue,
	issueDedupeKey,
	parseIssueEvent,
	parsePullRequestEvent,
	pickLinkedTask,
	REVIEWER_FAMILIES,
	taskStatusFor,
	tierOf,
	triageIssue,
	verifySignature,
	WORK_LABEL,
	withTier,
} from "./logic.js";
import { pullFiles } from "./preflight.js";
import {
	hasPriorityLabel,
	priorityLabelId,
	priorityStateKey,
	syncPriority,
	taskPrKey,
} from "./priority-label.js";
import { routeQuestions } from "./question-route.js";
import { reviewAdmissionFor } from "./review-admission-client.js";
import {
	actionRunSha,
	baseMergeHead,
	forgeAssign,
	forgeLabel,
	recheckWaiting,
	rejectStaleApprovalsFor,
	reviewPrOnce,
	runSweep,
} from "./sweep.js";
import { OPEN_STATUSES, retagTiers, tierLabelIds, tierTaskRepo } from "./tier-tags.js";

const FORGE_API = "https://forge.example.internal/api/v1";
const CLOSED = new Set(["done", "cancelled"]);
const TIER_TTL_MS = 10 * 60 * 1000;
// <fleet root>/plugins/forge-pr/worker.js -> <fleet root>/skills/merge-pr/bin/merge-check
const MERGE_CHECK = join(
	dirname(realpathSync(fileURLToPath(import.meta.url))),
	"../../skills/merge-pr/bin/merge-check",
);
const run = promisify(execFile);
let ctx;

// A repo's tier from its Forge topics, cached per repo for 10 minutes. A
// failed read is tier 5 (failTier; the re-tag passes null) with one log line
// (fail toward less work), and is not cached, so the next call reads again.
const tierCache = new Map();
async function repoTier(getToken, repo, failTier = 5) {
	const hit = tierCache.get(repo);
	if (hit && Date.now() - hit.at < TIER_TTL_MS) return hit.tier;
	let topics;
	try {
		const res = await fetch(`${FORGE_API}/repos/${repo}/topics`, {
			headers: { authorization: `token ${await getToken()}`, accept: "application/json" },
		});
		if (!res.ok) throw Object.assign(new Error("topics"), { reason: String(res.status) });
		topics = (await res.json())?.topics;
	} catch (err) {
		const reason = typeof err?.reason === "string" ? err.reason : err?.name || "Error";
		ctx.logger.warn(`forge-pr: topic read failed, tier ${failTier ?? "unread"}`, { repo, reason });
		return failTier;
	}
	const tier = tierOf(repo, topics);
	tierCache.set(repo, { tier, at: Date.now() });
	return tier;
}

// merge-check's class for a live merge go. The plugin config holds no
// board API key or URL, so those come from the worker's own environment; with
// any value missing it answers null (the approval stays pending) and logs the
// missing names, never a value.
function mergeClassifier(token, companyId, log) {
	const env = {
		FORGEJO_TOKEN: token,
		FORGEJO_API_URL: FORGE_API,
		PAPERCLIP_API_URL: process.env.PAPERCLIP_API_URL,
		PAPERCLIP_API_KEY: process.env.PAPERCLIP_API_KEY,
		PAPERCLIP_COMPANY_ID: companyId,
	};
	const missing = Object.keys(env).filter((k) => !env[k]);
	let told = false;
	return async (repo, number, sha) => {
		if (missing.length > 0) {
			if (!told) log(`forge-sweep classify off: missing ${missing.join(", ")}`);
			told = true;
			return null;
		}
		const { stdout } = await run(MERGE_CHECK, [repo, String(number), sha], {
			env: { PATH: process.env.PATH, ...env },
			timeout: 60_000,
		});
		return JSON.parse(stdout.trim().split("\n").at(-1));
	};
}

const stateKey = (companyId, k) => ({
	scopeKind: "company",
	scopeId: companyId,
	namespace: "forge-pr",
	stateKey: k,
});

// A webhook carries no company. Config is per company, so use the company
// whose configured repos include the event's repository.
async function configFor(repo) {
	if (typeof repo !== "string") return null;
	for (const company of await ctx.companies.list()) {
		const cfg = await ctx.config.get(company.id);
		if (Array.isArray(cfg?.repos) && cfg.repos.includes(repo))
			return { ...cfg, companyId: company.id };
	}
	return null;
}

// True when an open board task (not done or cancelled) carries the task's title.
async function openTaskExists(companyId, task) {
	const open = await ctx.issues.list({ companyId, assigneeAgentId: task.assigneeAgentId });
	return open.some((i) => i.title === task.title && !CLOSED.has(i.status));
}

// True while the recorded review issue is open, whoever holds it now:
// review-dispatch reassigns the parent review to a lead (PR 1598 review).
// A recorded reviewer pair is open while either task is. No
// recorded issue id: fall back to the title check.
export async function reviewOpen(companyId, task, recorded) {
	const isOpen = async (id) => {
		const issue = await ctx.issues.get(id, companyId);
		return issue != null && !CLOSED.has(issue.status);
	};
	const pair = recorded?.issueIds;
	if (pair && typeof pair === "object") {
		const ids = Object.values(pair).filter((id) => typeof id === "string");
		return (await Promise.all(ids.map(isOpen))).some(Boolean);
	}
	if (typeof recorded?.issueId !== "string") return openTaskExists(companyId, task);
	return isOpen(recorded.issueId);
}

// The reviewer pair's seats: each REVIEWER_FAMILIES login mapped to
// its board agent by the findAgent rule (sf-<name, lowercased>); a login with
// no agent is left out. seatLoad counts each seat's todo and in_progress tasks;
// the plugin holds no board token, so it reads tasks, not live runs. A failed
// read counts 0 and logs, so pickSeat falls back to login order.
const OPEN_WORK = new Set(["todo", "in_progress"]);
const SEAT_PAGE = 100;
export function seatDeps(companyId) {
	const seatsOf = async () => {
		const agents = await ctx.agents.list({ companyId });
		const byName = new Map();
		for (const a of Array.isArray(agents) ? agents : [])
			if (typeof a?.name === "string") byName.set(a.name.toLowerCase(), a);
		const seats = new Map();
		for (const login of Object.values(REVIEWER_FAMILIES).flat()) {
			const agent = byName.get(login.slice(3).toLowerCase());
			if (agent) seats.set(login, agent);
		}
		return seats;
	};
	const seatLoad = async () => {
		const load = new Map();
		for (const agent of (await seatsOf()).values()) {
			let n = 0;
			try {
				// The host caps a list at 100 rows, so read one open status at a
				// time, page by page until a short page.
				for (const status of OPEN_WORK) {
					for (let offset = 0; ; offset += SEAT_PAGE) {
						const tasks = await ctx.issues.list({
							companyId,
							assigneeAgentId: agent.id,
							status,
							limit: SEAT_PAGE,
							offset,
						});
						const page = Array.isArray(tasks) ? tasks : [];
						n += page.filter((t) => t?.status === status).length;
						if (page.length < SEAT_PAGE) break;
					}
				}
			} catch (err) {
				n = 0;
				ctx.logger.warn("forge-pr: seat load read failed, counts 0", {
					agentId: agent.id,
					reason: err?.name || "Error",
				});
			}
			load.set(agent.id, n);
		}
		return load;
	};
	return { seatsOf, seatLoad };
}

// The assignee's hold, read once per create or reopen: a seat that is
// not invokable gets its task in backlog, where recovery does not park it
// blocked. A failed read keeps todo and logs; the task is never dropped.
async function holdFor(companyId, agentId) {
	let agent;
	try {
		const agents = await ctx.agents.list({ companyId });
		agent = (Array.isArray(agents) ? agents : []).find((a) => a?.id === agentId);
	} catch (err) {
		ctx.logger.warn("forge-pr: agent read failed, task stays todo", {
			agentId,
			reason: err?.name || "Error",
		});
		return { status: "todo" };
	}
	const status = taskStatusFor(agent);
	if (status === "todo") return { status };
	return { status, line: `Held in backlog: ${agent.name ?? agentId} is ${agent.status}.` };
}

// The origin kind of forge-pr's PR tasks. The host allows a plugin only
// plugin:<manifest id> (plugin-host-services normalizePluginOriginKind;
// pluginKey is manifest.id, plugin-registry.js).
const PR_ORIGIN_KIND = "plugin:rodaddy.forge-pr";

// The id of the board project named exactly <owner>/<repo>. The list
// is read once per finder, so once per delivery or sweep. No such project, or a
// failed read, answers undefined.
const PROJECT_PAGE = 100;
function projectFinder(companyId) {
	let byName;
	const read = async () => {
		const map = new Map();
		try {
			for (let offset = 0; ; offset += PROJECT_PAGE) {
				const page = await ctx.projects.list({ companyId, limit: PROJECT_PAGE, offset });
				for (const p of Array.isArray(page) ? page : []) map.set(p?.name, p?.id);
				if (!Array.isArray(page) || page.length < PROJECT_PAGE) break;
			}
		} catch (err) {
			ctx.logger.warn("forge-pr: project read failed", { reason: err?.name || "Error" });
		}
		return map;
	};
	return async (repo) => {
		byName ??= read();
		const id = (await byName).get(repo);
		return typeof id === "string" ? id : undefined;
	};
}

// Without tierLabels config, tier tagging is a no-op logged once per setup.
let toldNoTierLabels = false;
function tierIdsOf(cfg) {
	const ids = tierLabelIds(cfg?.tierLabels);
	if (!ids && !toldNoTierLabels) {
		toldNoTierLabels = true;
		ctx.logger.info("forge-pr: tier labels off, no tierLabels in config (fleet/bin/ensure-labels)");
	}
	return ids;
}

// A Review, Merge or Rework task's tier label ids, else undefined.
async function tierLabelFor(task, repo, cfg, tierFor) {
	if (!tierFor || tierTaskRepo(task.title) !== repo) return undefined;
	const id = tierIdsOf(cfg)?.get(await tierFor(repo));
	return id ? [id] : undefined;
}

// Without tierLabels.priority, the PR priority label is a no-op logged once per setup.
let toldNoPriority = false;
function priorityIdOf(cfg) {
	const id = priorityLabelId(cfg?.tierLabels);
	if (!id && !toldNoPriority) {
		toldNoPriority = true;
		ctx.logger.info("forge-pr: priority label off, no tierLabels.priority in config");
	}
	return id;
}

// [priority id] when the task's PR carries the Forge priority label (by the
// last sync's record), else [].
async function priorityLabelFor(companyId, task, cfg) {
	const prKey = taskPrKey(task.title);
	const id = prKey && priorityIdOf(cfg);
	if (!id) return [];
	const rec = await ctx.state.get(stateKey(companyId, priorityStateKey(prKey)));
	return rec?.on === true ? [id] : [];
}

// The PR priority sync for open Forge PR objects (sweep items or a webhook's
// pull_request); at most PRIORITY_CAP label updates per call.
function prioritySync(companyId, cfg) {
	return async (items) => {
		const id = priorityIdOf(cfg);
		if (!id) return;
		await syncPriority({
			prs: items
				.filter((i) => Number.isInteger(i?.number))
				.map((i) => ({ repo: i.repository.full_name, number: i.number, on: hasPriorityLabel(i) })),
			id,
			// One unwindowed list of the company's open issues, as the tier re-tag:
			// the SDK client drops `q` and the host windows limit/offset twice.
			listOpen: async () => {
				const found = await ctx.issues.list({ companyId, status: OPEN_STATUSES.join(",") });
				return Array.isArray(found) ? found : [];
			},
			update: (issueId, labelIds) => ctx.issues.update(issueId, { labelIds }, companyId),
			stateGet: (k) => ctx.state.get(stateKey(companyId, k)),
			stateSet: (k, v) => ctx.state.set(stateKey(companyId, k), v),
			log: (line) => ctx.logger.info(line),
			counter: { n: 0 },
		});
	};
}

// Every board task the plugin creates goes through one of these: (task, repo).
// A task with a repo carries that repo's project; an owner ask has no repo. A
// repo task whose project is missing is not filed (sf#1250: without one it
// would run in the shared checkout): the answer is null, the caller records
// nothing, and the next pass retries. Projects are made by fleet/bin/ensure-project.
// tierFor(repo), when given, puts the repo's tier label on a tier task, and
// the priority label when its PR carries it.
function taskCreator(companyId, cfg, tierFor) {
	const projectOf = projectFinder(companyId);
	return async (task, repo) => {
		if (!(await allowWorkTask(ctx, companyId, task))) return null;
		const projectId = typeof repo === "string" ? await projectOf(repo) : undefined;
		if (typeof repo === "string" && !projectId) {
			ctx.logger.warn(`forge-pr: no project for ${repo}; task not filed (sf#1250)`);
			return null;
		}
		const hold = await holdFor(companyId, task.assigneeAgentId);
		const held = hold.line
			? { ...task, status: hold.status, description: `${task.description}\n\n${hold.line}` }
			: task;
		const tier = (await tierLabelFor(task, repo, cfg, tierFor)) ?? [];
		const labelIds = tierFor ? [...tier, ...(await priorityLabelFor(companyId, task, cfg))] : [];
		// A Review, Merge or Rework task carries its PR as origin, the key prTasks reads.
		const prKey = taskPrKey(task.title);
		return ctx.issues.create({
			companyId,
			...held,
			...(projectId ? { projectId } : {}),
			...(labelIds.length > 0 ? { labelIds } : {}),
			...(prKey ? { originKind: PR_ORIGIN_KIND, originId: prKey } : {}),
		});
	};
}

async function createOnce(cfg, k, task, repo, { recheckOpenTitle = false } = {}) {
	const key = stateKey(cfg.companyId, k);
	if (await ctx.state.get(key)) {
		if (!recheckOpenTitle) {
			ctx.logger.info("forge-pr: duplicate", { key: k });
			return;
		}
		// A reopen after close: new task only if no open board task carries the title.
		if (await openTaskExists(cfg.companyId, task)) {
			ctx.logger.info("forge-pr: reopen, open task exists", { key: k });
			return;
		}
	}
	const issue = await taskCreator(cfg.companyId)(task, repo);
	if (!issue) return;
	await ctx.state.set(key, { issueId: issue.id });
	ctx.logger.info("forge-pr: board issue created", { key: k, issueId: issue.id });
}

// The PR's board tasks whose title starts with query. The SDK client
// drops `q` (plugin-sdk worker-rpc-host.js issues.list), so the lookup is by
// fields the host filters on exactly: the forge-pr origin with originId
// <repo>#<n> (tasks filed since sf#1850), the repo's project (older tasks,
// which carry no origin), and every open task (older still: no project
// either, filed before sf#1690). The lists are unwindowed: the host
// (2026.916.1) applies offset twice, so a paged read skips rows. Merged by id.
function prTasks(companyId) {
	const projectOf = projectFinder(companyId);
	return async (query, repo, number) => {
		if (typeof repo !== "string" || !Number.isInteger(number)) return [];
		const projectId = await projectOf(repo);
		const lists = await Promise.all([
			ctx.issues.list({ companyId, originKind: PR_ORIGIN_KIND, originId: `${repo}#${number}` }),
			projectId ? ctx.issues.list({ companyId, projectId }) : [],
			ctx.issues.list({ companyId, status: OPEN_STATUSES.join(",") }),
		]);
		const byId = new Map();
		for (const found of lists)
			for (const i of Array.isArray(found) ? found : [])
				if (typeof i?.title === "string" && i.title.startsWith(query)) byId.set(i.id, i);
		return [...byId.values()];
	};
}

// The PR's board tasks matching the query as { title, status, description };
// the caller filters by exact prefix, and status and description say whether
// a review used a round.
function titleLister(companyId) {
	const tasksOf = prTasks(companyId);
	return async (query, repo, number) =>
		(await tasksOf(query, repo, number)).map((i) => ({
			title: i?.title,
			status: i?.status,
			description: i?.description,
		}));
}

// Open Review, Merge and Rework tasks for the settle pass, deduped
// by id. One unwindowed read: the SDK drops q and the host (2026.916.1)
// windows limit/offset twice, so search and paging cannot reach all tasks.
async function listOpenPrTasks(companyId) {
	const found = await ctx.issues.list({ companyId, status: OPEN_STATUSES.join(",") });
	const byId = new Map();
	for (const i of Array.isArray(found) ? found : [])
		if (
			typeof i?.id === "string" &&
			typeof i?.title === "string" &&
			["Review ", "Merge ", "Rework "].some((prefix) => i.title.startsWith(prefix))
		)
			byId.set(i.id, i);
	return [...byId.values()];
}

// The board side of the round-limit kick-back.
function kickBackDeps(companyId) {
	return {
		// An employee's Forge login is sf-<board name, lowercased> (fleet/board/crew.json).
		findAgent: async (login) => {
			const name = login.slice(3).toLowerCase();
			const agents = await ctx.agents.list({ companyId });
			const hit = (Array.isArray(agents) ? agents : []).find(
				(a) => typeof a?.name === "string" && a.name.toLowerCase() === name,
			);
			return hit?.id ?? null;
		},
		// The author's own task that carries the PR (board-link), never a review task.
		findLinkedTask: async (ev, agentId) => {
			// The SDK's issues.list has no text search (plugin-sdk PluginIssuesClient.list),
			// so match the PR link in the description here; never reopen an unrelated task.
			const found = await ctx.issues.list({ companyId, assigneeAgentId: agentId, limit: 200 });
			return pickLinkedTask(found, ev.url);
		},
		// The requesting agent's board name for an owner-ask issue.
		agentName: async (id) => {
			const agents = await ctx.agents.list({ companyId });
			const hit = (Array.isArray(agents) ? agents : []).find((a) => a?.id === id);
			return typeof hit?.name === "string" ? hit.name : null;
		},
		reopenTask: async (id, { comment, ...patch }) => {
			const task = await ctx.issues.get(id, companyId);
			if (
				!task ||
				!(await allowWorkTask(ctx, companyId, {
					...task,
					title: `Rework ${task.title}`,
					description: `${task.description ?? ""}\n${comment}`,
				}))
			)
				return false;
			const hold = await holdFor(companyId, patch.assigneeAgentId);
			const status = hold.line ? hold.status : patch.status;
			await ctx.issues.update(id, { ...patch, status }, companyId);
			await ctx.issues.createComment(
				id,
				hold.line ? `${comment}\n\n${hold.line}` : comment,
				companyId,
			);
			return true;
		},
	};
}

// The board API on the box. ctx.issues.update to cancelled leaves the issue's
// live run going; the board route PATCH /api/issues/:id stops it too.
const BOARD_API = "http://127.0.0.1:3100/api";
let toldNoRunStop = false;
function noRunStop(reason) {
	if (toldNoRunStop) return;
	toldNoRunStop = true;
	ctx.logger.warn("forge-pr: superseded review runs are not being stopped", { reason });
}

// Cancels a task through the board route when boardApiKey is configured, so its
// live run stops; true when the board accepted it. Never logs the key.
async function boardCancel(companyId, id) {
	const cfg = await ctx.config.get(companyId);
	if (!cfg?.boardApiKey) {
		noRunStop("no boardApiKey in config");
		return false;
	}
	try {
		const key = await ctx.secrets.resolve(cfg.boardApiKey, {
			companyId,
			configPath: "boardApiKey",
		});
		// Global fetch: ctx.http drops private and loopback addresses.
		const res = await fetch(`${BOARD_API}/issues/${encodeURIComponent(id)}`, {
			method: "PATCH",
			headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
			body: JSON.stringify({ status: "cancelled" }),
		});
		if (res.ok) return true;
		noRunStop(`board PATCH ${res.status}`);
	} catch (err) {
		noRunStop(`board PATCH ${err?.name || "Error"}`);
	}
	return false;
}

// A head is reviewed once its checks settle (forgeWrites' checksOf), and its
// review retires the open reviews of older heads. Same list and
// update calls as above.
export function settleDeps(companyId) {
	const tasksOf = prTasks(companyId);
	return {
		now: () => Date.now(),
		listIssues: (q, repo, number) => tasksOf(q, repo, number),
		// The review task's comments: the lead verdict the Merge task routes on.
		listComments: async (id) => {
			const found = await ctx.issues.listComments(id, companyId);
			return Array.isArray(found) ? found : [];
		},
		cancelTask: async (id, comment) => {
			if (!(await boardCancel(companyId, id)))
				await ctx.issues.update(id, { status: "cancelled" }, companyId);
			await ctx.issues.createComment(id, comment, companyId);
		},
	};
}

// The plugin's Forge call: (method, path, body) answers the parsed JSON. A
// non-2xx throws with .reason (the status) so the caller quarantines it.
// getToken resolves the forge token per call. ctx.http blocks private IPs.
function forgeCall(getToken) {
	return async (method, path, body) => {
		const token = await getToken();
		const res = await fetch(`${FORGE_API}${path}`, {
			method,
			headers: {
				authorization: `token ${token}`,
				accept: "application/json",
				...(body === undefined ? {} : { "content-type": "application/json" }),
			},
			body: body === undefined ? undefined : JSON.stringify(body),
		});
		if (!res.ok)
			throw Object.assign(new Error(`forge-pr: ${method} ${path} failed ${res.status}`), {
				reason: String(res.status),
			});
		return res.json().catch(() => null);
	};
}

// The round-limit Forge writes (the limit comment, the author assignment and
// the round-limit label) and the review path's reads.
function forgeWrites(getToken) {
	const call = forgeCall(getToken);
	return {
		// The head's combined commit status: its checks settle.
		checksOf: (repo, sha) => call("GET", `/repos/${repo}/commits/${sha}/status`),
		postComment: async (repo, number, body) => {
			await call("POST", `/repos/${repo}/issues/${number}/comments`, { body });
		},
		// The preflight's one read, on the same call.
		listFiles: (repo, number) => pullFiles((path) => call("GET", path), repo, number),
		// The non-code fast path's reads.
		forgeGet: (path) => call("GET", path),
		assignPr: (repo, number, login) => forgeAssign(call, repo, number, login),
		addLabel: (repo, number, name) => forgeLabel(call, repo, number, name),
		// Read-only: is this head a base merge onto a reviewed head.
		isBaseMerge: (ev, reviewed) => baseMergeHead(call, ev, reviewed),
	};
}

const tokenOf = (cfg) => () =>
	ctx.secrets.resolve(cfg.forgeToken, { companyId: cfg.companyId, configPath: "forgeToken" });

// reviewPrOnce's deps for one webhook delivery.
function reviewDeps(cfg, getToken, log) {
	const forge = forgeWrites(getToken);
	return {
		admitReview: reviewAdmissionFor(cfg.companyId, forge.forgeGet),
		...kickBackDeps(cfg.companyId),
		...settleDeps(cfg.companyId),
		...seatDeps(cfg.companyId),
		companyId: cfg.companyId,
		cfg,
		createTask: taskCreator(cfg.companyId, cfg, (repo) => repoTier(getToken, repo)),
		listTitles: titleLister(cfg.companyId),
		// A reopen at a reviewed head gets a new review when none is open.
		openTaskExists: (task, recorded) => reviewOpen(cfg.companyId, task, recorded),
		...forge,
		stateGet: (k) => ctx.state.get(stateKey(cfg.companyId, k)),
		stateSet: (k, v) => ctx.state.set(stateKey(cfg.companyId, k), v),
		log,
	};
}

// A new head moves the PR's merge approvals out at once (the sweep's cleanup,
// for this PR only). Logged, never thrown: the review still goes on.
async function rejectStaleNow(cfg, getToken, repo, number) {
	try {
		const token = await getToken();
		await rejectStaleApprovalsFor(
			{
				fetch: (url, init) => fetch(url, init),
				baseUrl: FORGE_API,
				token,
				repos: cfg.repos,
				now: () => Date.now(),
				stateGet: (k) => ctx.state.get(stateKey(cfg.companyId, k)),
				stateSet: (k, v) => ctx.state.set(stateKey(cfg.companyId, k), v),
				approvals: ctx.approvals,
				companyId: cfg.companyId,
				cfg,
				classify: mergeClassifier(token, cfg.companyId, (line) => ctx.logger.info(line)),
				log: (line) => ctx.logger.info(line, { pr: `${repo}#${number}` }),
			},
			repo,
			number,
		);
	} catch (err) {
		ctx.logger.warn("forge-pr: stale approvals failed", {
			pr: `${repo}#${number}`,
			reason: err?.name || "Error",
		});
	}
}

// An Actions run ended on a configured repo: file the heads that waited on
// their checks and are now ready (the checks settle).
async function recheckFromWebhook(cfg, body) {
	const repo = body.repository.full_name;
	const getToken = tokenOf(cfg);
	const deps = reviewDeps(cfg, getToken, (line) => ctx.logger.info(line, { repo }));
	const outs = await recheckWaiting(
		{ ...deps, repoTier: (r) => repoTier(getToken, r) },
		repo,
		actionRunSha(body),
	);
	for (const r of outs) logOutcome(r);
}

function logOutcome(r) {
	if (r.outcome === "settling") ctx.logger.info("forge-pr: head settling", { key: r.key });
	else if (r.outcome === "admission_hold")
		ctx.logger.info("forge-pr: protected review admission held", { key: r.key });
	else if (r.outcome === "preflight") ctx.logger.info("forge-pr: preflight failed", { key: r.key });
	else if (r.outcome === "duplicate") ctx.logger.info("forge-pr: duplicate", { key: r.key });
	else if (r.outcome === "created")
		ctx.logger.info("forge-pr: board issue created", { key: r.key, issueId: r.issueId });
	else if (r.outcome === "scripted")
		ctx.logger.info("forge-pr: non-code, Merge task created", { key: r.key, issueId: r.issueId });
}

// A PR head becomes a review task through the same locked path as the sweep
// (reviewPrOnce): duplicate check, checks settle, two-round limit, create,
// record. A ready head is filed in this delivery; a new head (synchronized)
// also rejects the PR's stale merge approvals now.
async function reviewFromWebhook(cfg, raw) {
	const getToken = tokenOf(cfg);
	if (raw.action === "synchronized") await rejectStaleNow(cfg, getToken, raw.repo, raw.number);
	const event = withTier(raw, await repoTier(getToken, raw.repo));
	const log = (line) => ctx.logger.info(line, { pr: `${event.repo}#${event.number}` });
	logOutcome(await reviewPrOnce(reviewDeps(cfg, getToken, log), event));
}

async function sweepCompany(company) {
	const raw = await ctx.config.get(company.id);
	if (!raw?.forgeToken || !Array.isArray(raw.repos) || raw.repos.length === 0) return;
	const token = await ctx.secrets.resolve(raw.forgeToken, {
		companyId: company.id,
		configPath: "forgeToken",
	});
	await runSweep({
		admitReview: reviewAdmissionFor(company.id, forgeWrites(async () => token).forgeGet),
		...kickBackDeps(company.id),
		...settleDeps(company.id),
		...seatDeps(company.id),
		// assignPr and addLabel; runSweep posts the comment and, with preflight,
		// reads the PR files on its own counter.
		...forgeWrites(async () => token),
		preflight: true,
		// ctx.http blocks private IPs; forge.example.internal resolves private on the box.
		fetch: (url, init) => fetch(url, init),
		baseUrl: FORGE_API,
		token,
		repos: raw.repos,
		now: () => Date.now(),
		stateGet: (k) => ctx.state.get(stateKey(company.id, k)),
		stateSet: (k, v) => ctx.state.set(stateKey(company.id, k), v),
		createTask: taskCreator(company.id, raw, (repo) => repoTier(async () => token, repo)),
		listTitles: titleLister(company.id),
		repoTier: (repo) => repoTier(async () => token, repo),
		syncPriority: prioritySync(company.id, raw),
		cfg: raw,
		approvals: ctx.approvals,
		companyId: company.id,
		// Settle the tasks of merged or closed PRs, the reopenTask call shape.
		listOpenTasks: () => listOpenPrTasks(company.id),
		settleTask: async (id, { comment, ...patch }) => {
			const cancelled = patch.status === "cancelled" && (await boardCancel(company.id, id));
			const { status, ...other } = patch;
			const update = cancelled ? other : patch;
			if (Object.keys(update).length) await ctx.issues.update(id, update, company.id);
			try {
				await ctx.issues.createComment(id, comment, company.id);
			} catch (err) {
				ctx.logger.warn("forge-pr: settle comment failed", { id, error: err?.name });
			}
		},
		classify: mergeClassifier(token, company.id, (line) => ctx.logger.info(line)),
		log: (line) => ctx.logger.info(line),
	});
}

// The hourly tier re-tag (PRD US-005): one tier read per repo, then
// each open Review/Merge/Rework task gets that tier's label, replacing any other.
async function retagCompany(company) {
	const raw = await ctx.config.get(company.id);
	if (!raw?.forgeToken || !Array.isArray(raw.repos) || raw.repos.length === 0) return;
	const ids = tierIdsOf(raw);
	if (!ids) return;
	const token = await ctx.secrets.resolve(raw.forgeToken, {
		companyId: company.id,
		configPath: "forgeToken",
	});
	await retagTiers({
		repos: raw.repos,
		ids,
		repoTier: (repo) => repoTier(async () => token, repo, null),
		// One unwindowed list of the company's open issues. The SDK client drops
		// `q`, and the host (2026.916.1) applies limit/offset twice, so any page
		// past the first comes back empty: no search, no paging.
		listOpen: async () => {
			const found = await ctx.issues.list({
				companyId: company.id,
				status: OPEN_STATUSES.join(","),
			});
			return Array.isArray(found) ? found : [];
		},
		update: (id, labelIds) => ctx.issues.update(id, { labelIds }, company.id),
		log: (line) => ctx.logger.info(line),
	});
}

// Seat question cards to Smythe, for each company this plugin is configured on.
async function routeCompanyQuestions(company) {
	if (!(await ctx.config.get(company.id))) return;
	const companyId = company.id;
	const { findAgent, agentName } = kickBackDeps(companyId);
	await routeQuestions({
		listIssues: ({ status, limit }) => ctx.issues.list({ companyId, status, limit }),
		listInteractions: (id) => ctx.issues.listInteractions(id, companyId),
		now: () => Date.now(),
		stateGet: (k) => ctx.state.get(stateKey(companyId, k)),
		stateSet: (k, v) => ctx.state.set(stateKey(companyId, k), v),
		findAgent,
		agentName,
		createTask: taskCreator(companyId),
		comment: (id, body) => ctx.issues.createComment(id, body, companyId),
		log: (line) => ctx.logger.info(line),
	});
}

const eachCompany = (name, fn) => async () => {
	for (const company of await ctx.companies.list()) {
		try {
			await fn(company);
		} catch (err) {
			ctx.logger.warn(`${name}: company failed`, { companyId: company.id, error: String(err) });
		}
	}
};

// Issue-scoped wake (SOF-11432): agents.invoke starts a run with no
// issue, and the board refuses every cross-issue write from such a run
// (cross_issue_influence_run_context_required). requestWakeup binds the
// run to the task; a skipped wake throws so no cooldown is recorded.
function issueWake(companyId, contextSource) {
	return async (_agentId, opts) => {
		const res = await ctx.issues.requestWakeup(opts.issueId, companyId, {
			reason: opts.reason,
			contextSource,
		});
		if (!res?.queued) throw new Error("wake not queued");
		return res;
	};
}

// Wakes idle seats that hold work. Runs for every company, Forge
// config or not: the board is the input.
async function wakeCompany(company) {
	const companyId = company.id;
	const woken = await wakeIdleSeats({
		listAgents: () => ctx.agents.list({ companyId }),
		listIssues: (assigneeAgentId, status) =>
			ctx.issues.list({ companyId, assigneeAgentId, status, limit: 200 }),
		invoke: issueWake(companyId, "forge-pr.idle-wake"),
		stateGet: (k) => ctx.state.get(stateKey(companyId, k)),
		stateSet: (k, v) => ctx.state.set(stateKey(companyId, k), v),
		now: () => Date.now(),
		log: (line) => ctx.logger.info(line, { companyId }),
	});
	if (woken > 0) ctx.logger.info("forge-sweep: idle seats woken", { companyId, woken });
}

// A seat's run ended: wake that seat now if it is idle and holds work, instead
// of waiting for the sweep. Delivery is fire-and-forget, so the sweep stays as
// the backstop. Errors are logged by name, never thrown.
export const RUN_END_EVENTS = ["agent.run.finished", "agent.run.failed", "agent.run.cancelled"];
export async function onRunEnd(event) {
	const p = event?.payload ?? {};
	try {
		// Some event paths carry no company scope (GOTCHAS): fall back to the
		// sole configured company.
		let companyId = p.companyId ?? event?.companyId;
		if (typeof companyId !== "string") {
			const companies = await ctx.companies.list();
			if (companies.length === 1) companyId = companies[0].id;
		}
		if (typeof companyId !== "string" || typeof p.agentId !== "string") return;
		await wakeOnRunEnd(
			{ agentId: p.agentId, runId: p.runId ?? event?.entityId },
			{
				getAgent: (agentId) => ctx.agents.get(agentId, companyId),
				listIssues: (assigneeAgentId, status) =>
					ctx.issues.list({ companyId, assigneeAgentId, status, limit: 200 }),
				invoke: issueWake(companyId, "forge-pr.run-end-wake"),
				stateGet: (k) => ctx.state.get(stateKey(companyId, k)),
				stateSet: (k, v) => ctx.state.set(stateKey(companyId, k), v),
				now: () => Date.now(),
				log: (line) => ctx.logger.info(line, { companyId }),
			},
		);
	} catch (err) {
		ctx.logger.warn(`forge-pr: run-end wake failed: ${err?.name || "Error"}`);
	}
}

const plugin = definePlugin({
	async setup(c) {
		ctx = c;
		toldNoTierLabels = false;
		toldNoPriority = false;
		for (const name of RUN_END_EVENTS) ctx.events.on(name, onRunEnd);
		ctx.jobs.register("forge-sweep", async () => {
			for (const company of await ctx.companies.list()) {
				try {
					await sweepCompany(company);
				} catch (err) {
					ctx.logger.warn("forge-sweep: company failed", {
						companyId: company.id,
						error: String(err),
					});
				}
				try {
					await wakeCompany(company);
				} catch (err) {
					ctx.logger.warn("forge-sweep: idle wake failed", {
						companyId: company.id,
						error: String(err),
					});
				}
			}
		});
		ctx.jobs.register("tier-retag", eachCompany("tier-retag", retagCompany));
		ctx.jobs.register("question-route", eachCompany("question-route", routeCompanyQuestions));
	},
	async onHealth() {
		return { status: "ok", message: "forge-pr ready" };
	},
	async onWebhook(input) {
		if (input.endpointKey !== "forge")
			throw new Error(`forge-pr: unknown endpoint ${input.endpointKey}`);
		const body = input.parsedBody ?? JSON.parse(input.rawBody);
		const cfg = await configFor(body?.repository?.full_name);
		if (!cfg) {
			ctx.logger.info("forge-pr: ignored, repo not configured", {
				repo: body?.repository?.full_name,
			});
			return;
		}
		const secret = await ctx.secrets.resolve(cfg.webhookSecret, {
			companyId: cfg.companyId,
			configPath: "webhookSecret",
		});
		if (!verifySignature(input.rawBody, headerValue(input.headers, "x-hub-signature-256"), secret))
			throw new Error("forge-pr: signature check failed");
		const kind =
			headerValue(input.headers, "x-forgejo-event") ?? headerValue(input.headers, "x-gitea-event");
		// A PR label change syncs that PR's priority label; a closed PR is left alone.
		const labelChange = body?.action === "label_updated" || body?.action === "label_cleared";
		if (kind === "pull_request" && labelChange && body?.pull_request?.state === "open")
			return prioritySync(
				cfg.companyId,
				cfg,
			)([{ ...body.pull_request, number: body.number, repository: body.repository }]);
		// An Actions run ended (Forgejo has no commit-status hook): waiting heads
		// whose checks are now done are filed.
		if (typeof kind === "string" && kind.startsWith("action_run"))
			return recheckFromWebhook(cfg, body);
		if (kind === "pull_request") {
			const event = parsePullRequestEvent(input.headers, body, cfg.repos);
			if (event) return reviewFromWebhook(cfg, event);
		} else if (kind === "issues") {
			const event = parseIssueEvent(input.headers, body, cfg.repos);
			const labels = Array.isArray(body?.issue?.labels) ? body.issue.labels : [];
			if (!event && !labels.some((l) => l?.name === WORK_LABEL)) {
				ctx.logger.info("forge-pr: issue skipped, no factory-work label", {
					issue: `${body?.repository?.full_name}#${body?.issue?.number}`,
				});
				return;
			}
			if (event)
				return createOnce(cfg, issueDedupeKey(event), triageIssue(event, cfg), event.repo, {
					recheckOpenTitle: event.action === "reopened",
				});
		}
		ctx.logger.info("forge-pr: ignored", { event: kind, action: body?.action });
	},
});
export default plugin;
runWorker(plugin, import.meta.url);
