import {
	BASE_MERGE_LINE,
	dedupeKey,
	headVerdict,
	issueDedupeKey,
	issueFromApi,
	MERGER_LOGIN,
	mergeTask,
	mergeTitle,
	pairTitle,
	pickSeat,
	prFromApi,
	REVIEW_ROUND_LIMIT,
	REVIEWER_FAMILIES,
	reviewedHeads,
	reviewerTask,
	reviewRounds,
	reviewTitlePrefix,
	reworkTask,
	roundLimitComment,
	roundLimitKey,
	roundLimitText,
	taskFor,
	VERDICT_LOGINS,
	withTier,
} from "./logic.js";
import {
	addedLines,
	BIG_CHANGE_LINES,
	markedPaths,
	preflight,
	preflightComment,
	pullFiles,
} from "./preflight.js";
import { fileRicoAsks } from "./rico-asks.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_TASK = new Set(["done", "cancelled"]);
const PAGE = 50;

class SweepStop extends Error {
	constructor(path, reason) {
		super(`forge-sweep stopped: ${path} ${reason}`);
		this.path = path;
		this.reason = reason;
	}
}

// Serial; the first failed call (thrown fetch or non-2xx) stops the whole sweep.
// Exported for factoryignore-cli, which reads with it outside a sweep.
export async function getJson(deps, counter, path) {
	counter.calls++;
	let res;
	try {
		res = await deps.fetch(`${deps.baseUrl}${path}`, {
			headers: { authorization: `token ${deps.token}`, accept: "application/json" },
		});
	} catch (err) {
		throw new SweepStop(path, err?.name || "Error");
	}
	if (!res.ok) throw new SweepStop(path, String(res.status));
	try {
		return await res.json();
	} catch (err) {
		throw new SweepStop(path, err?.name || "Error");
	}
}

async function searchAll(deps, counter, query) {
	const out = [];
	for (let page = 1; ; page++) {
		const data = await getJson(
			deps,
			counter,
			`/repos/issues/search?${query}&limit=${PAGE}&page=${page}`,
		);
		const items = Array.isArray(data) ? data : [];
		out.push(...items);
		if (items.length < PAGE) return out;
	}
}

// Logged by status or error name only, never the message.
const failReason = (err) => (typeof err?.reason === "string" ? err.reason : err?.name || "Error");

// Hands the work back to the PR author ("just kick it
// back"). An employee (sf-*) gets its linked board task reopened and assigned
// to it, or one new Rework task; a session or human author is reached by the
// @-mention in the limit comment alone. Returns what it did.
async function kickBack(deps, ev, rounds) {
	if (!deps.findAgent || !ev.author.startsWith("sf-")) return "mention";
	const agentId = await deps.findAgent(ev.author);
	if (!agentId) return "mention";
	const linked = await deps.findLinkedTask(ev, agentId);
	if (linked) {
		const comment = `${roundLimitText(rounds)}\n\nPR: [${ev.repo}#${ev.number}](${ev.url}). Back to you.`;
		const allowed = await deps.reopenTask(linked.id, {
			status: "todo",
			assigneeAgentId: agentId,
			comment,
		});
		return allowed === false ? "spec-held" : "reopened";
	}
	// null: no project for the repo; the @-mention still reaches the author.
	return (await deps.createTask(reworkTask(ev, agentId, rounds), ev.repo)) ? "created" : "unfiled";
}

export const ROUND_LIMIT_LABEL = "round-limit";

// The Forge calls behind assignPr and addLabel: call(method, path, body)
// answers the parsed JSON and throws (with .reason) on a non-2xx.

// Adds login to the PR's assignees, keeping the ones already there; a no-op
// when it is already assigned. The issue PATCH replaces the whole list.
export async function forgeAssign(call, repo, number, login) {
	const path = `/repos/${repo}/issues/${number}`;
	const issue = await call("GET", path);
	const current = (Array.isArray(issue?.assignees) ? issue.assignees : [])
		.map((a) => a?.login)
		.filter((l) => typeof l === "string");
	if (current.includes(login)) return;
	await call("PATCH", path, { assignees: [...current, login] });
}

// Adds a label by name. A name the repo does not define can be skipped
// without an error, so the answer is checked: a missing label is a failure.
export async function forgeLabel(call, repo, number, name) {
	const labels = await call("POST", `/repos/${repo}/issues/${number}/labels`, { labels: [name] });
	if (!(Array.isArray(labels) ? labels : []).some((l) => l?.name === name))
		throw Object.assign(new Error(`forge-pr: label ${name} missing on ${repo}`), {
			reason: "label-missing",
		});
}

// True when the head commit only merges the base branch into a reviewed head:
// exactly two parents, the first a head the PR had a review task
// for, the second reachable from the base tip (base...p2 holds no commits).
// Any failed or unexpected read answers false, so the review counts as a round.
export async function baseMergeHead(call, ev, reviewed) {
	try {
		const commit = await call("GET", `/repos/${ev.repo}/git/commits/${ev.headSha}`);
		const parents = (Array.isArray(commit?.parents) ? commit.parents : []).map((p) => p?.sha);
		if (
			parents.length !== 2 ||
			!parents.every((s) => typeof s === "string" && /^[0-9a-f]{40}$/.test(s))
		)
			return false;
		if (!(Array.isArray(reviewed) ? reviewed : []).includes(parents[0].slice(0, 7))) return false;
		const base = (await call("GET", `/repos/${ev.repo}/pulls/${ev.number}`))?.base?.ref;
		if (typeof base !== "string" || !/^[\w./-]+$/.test(base) || base.includes("..")) return false;
		const cmp = await call("GET", `/repos/${ev.repo}/compare/${base}...${parents[1]}`);
		return cmp?.total_commits === 0;
	} catch {
		return false;
	}
}

// One Forge write in the once-per-head block: recorded, never thrown.
async function quarantined(deps, record, what, pr, fn) {
	const field = what === "label" ? "labelled" : "assigned";
	try {
		await fn();
		record[field] = true;
	} catch (err) {
		record[field] = false;
		const reason = failReason(err);
		record[`${what}Reason`] = reason;
		deps.log(`forge-pr: round-limit ${what} failed ${pr}: ${reason} (quarantined)`);
	}
}

// Warns a PR that has had its two review rounds: the
// review task is still created by the caller, on every new head.
// Once per head (state key roundlimit:<key>) it posts the ROUND LIMIT comment,
// assigns the PR to its author, labels it round-limit, and kicks the work back
// to its author. A refused Forge write (403, locked conversation, token without
// issue-write) or a failed board call is quarantined like approvalbad: recorded
// under the same key and never thrown, so one PR cannot stop the sweep for
// every repo of the company.
// deps: listTitles(prefix), postComment(repo, number, body), stateGet, stateSet,
// log; optional assignPr(repo, number, login), addLabel(repo, number, name);
// kick-back: findAgent(login), findLinkedTask(ev, agentId),
// reopenTask(id, patch), createTask(task, repo)
// entries: the board entries listTitles already answered, else it is called.
// The record carries `rounds`; one without it is the old stop's memo (before
// 2026-10-08), whose comment said "open a new pull request". That head gets
// the current comment once and its memo gains `rounds`; the assign, label and
// kick-back it already had are not repeated (SOF-11517).
export async function warnRoundLimit(deps, ev, entries) {
	const titles =
		entries ?? (await deps.listTitles(reviewTitlePrefix(ev.repo, ev.number), ev.repo, ev.number));
	const rounds = reviewRounds(titles, ev.repo, ev.number);
	if (rounds < REVIEW_ROUND_LIMIT) return;
	const pr = `${ev.repo}#${ev.number} @ ${ev.headSha.slice(0, 7)}`;
	deps.log(`forge-pr: round limit ${pr}`);
	const key = roundLimitKey(ev);
	const prior = await deps.stateGet(key);
	if (prior && prior.rounds !== undefined) return;
	const legacy = Boolean(prior);
	const record = legacy ? { ...prior, commented: true, rounds } : { commented: true, rounds };
	delete record.reason;
	try {
		await deps.postComment(ev.repo, ev.number, roundLimitComment(ev.author, rounds));
	} catch (err) {
		Object.assign(record, { commented: false, reason: failReason(err) });
		deps.log(`forge-pr: round-limit comment failed ${pr}: ${record.reason} (quarantined)`);
	}
	if (legacy) return deps.stateSet(key, record);
	// A session or human author is not on the board: the Forge assignment and
	// label put the PR in their queue and in PR lists, not only the mention.
	if (deps.assignPr && /^[\w.-]+$/.test(ev.author))
		await quarantined(deps, record, "assign", pr, () =>
			deps.assignPr(ev.repo, ev.number, ev.author),
		);
	if (deps.addLabel)
		await quarantined(deps, record, "label", pr, () =>
			deps.addLabel(ev.repo, ev.number, ROUND_LIMIT_LABEL),
		);
	try {
		record.kickedBack = await kickBack(deps, ev, rounds);
	} catch (err) {
		Object.assign(record, { kickedBack: false, kickBackReason: failReason(err) });
		deps.log(
			`forge-pr: round-limit kick-back failed ${pr}: ${record.kickBackReason} (quarantined)`,
		);
	}
	await deps.stateSet(key, record);
}

// Work on one key runs one at a time inside this worker process. The webhook
// and the sweep share this module, so a head both see gets one review task.
const inflight = new Map();
export async function withKeyLock(key, fn) {
	const prev = inflight.get(key) ?? Promise.resolve();
	let release;
	const mine = new Promise((resolve) => {
		release = resolve;
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

// The one path that turns a PR head into a review task, for webhook and sweep.
// The board RPC carries no idempotency key this repo can show reaching the
// server, so the dedupe is here: state check, round limit, create, record,
// all under the per-head lock.
// A reopen at a reviewed head (a body-only fix) is reviewed again when
// its review is no longer open; that needs deps.openTaskExists(task, recorded),
// where recorded is the dedupe state ({ issueId }) of the earlier review.
// deps: companyId, stateGet, stateSet, createTask, listTitles, postComment, cfg, log;
// optional openTaskExists(task, recorded); isBaseMerge(ev, reviewedSha7s);
// checksOf(repo, sha) with now (the checks settle); listIssues(query) with cancelTask(id, comment)
// (retire older heads).
export async function reviewPrOnce(deps, ev) {
	const key = dedupeKey(ev);
	return withKeyLock(`${deps.companyId ?? ""}|${key}`, async () => {
		const review = taskFor({ kind: "pr", key, event: ev }, deps.cfg);
		const seen = await deps.stateGet(key);
		const pair = deps.cfg?.pairReview === true && typeof deps.seatsOf === "function";
		// A pair with a family missing (its create failed) is completed, nothing else.
		if (pair && seen?.issueIds && FAMILIES.some((f) => !seen.issueIds[f])) {
			const admitted = await admittedReviewDeps(deps, ev, key, seen);
			if (!admitted) return { key, outcome: "admission_hold" };
			return filePair(admitted, ev, key, seen);
		}
		// A head that failed the preflight is checked again on every visit, and a
		// body edit re-qualifies only such a head.
		const failed = seen?.preflight === "failed";
		if (ev.bodyEdit && !failed) return { key, outcome: "duplicate" };
		if (seen && !failed) {
			const recheck = ev.action === "reopened" && deps.openTaskExists;
			if (!recheck || (await deps.openTaskExists(review, seen)))
				return { key, outcome: "duplicate" };
		} else if (!seen && !(await settled(deps, ev))) return { key, outcome: "settling" };
		const entries = await deps.listTitles(
			reviewTitlePrefix(ev.repo, ev.number),
			ev.repo,
			ev.number,
		);
		// A base-merge head is still reviewed (the lead's delta-check), marked so
		// it does not count as a round. It is classified before the round
		// limit: a base merge after two real rounds is not a third round. Past the
		// limit the head is warned once and still reviewed.
		const baseMerge =
			deps.isBaseMerge && (await deps.isBaseMerge(ev, reviewedHeads(entries, ev.repo, ev.number)));
		if (!baseMerge) await warnRoundLimit(deps, ev, entries);
		const pf = deps.listFiles ? await preflightFails(deps, ev, key, seen) : { files: null };
		if (pf.failed) return { key, outcome: "preflight" };
		const scripted =
			pf.files &&
			deps.forgeGet &&
			deps.cfg?.scriptedNonCode === true &&
			(await scriptedNonCode(deps, ev, key, pf.files));
		if (!scripted) {
			const admitted = await admittedReviewDeps(deps, ev, key, seen);
			if (!admitted) return { key, outcome: "admission_hold" };
			deps = admitted;
		}
		// A base-merge head's review tasks, pair tasks included, carry the marker line.
		const mark = (t) =>
			baseMerge ? { ...t, description: `${t.description}\n${BASE_MERGE_LINE}` } : t;
		let out;
		if (scripted) out = { key, outcome: "scripted", issueId: scripted };
		else if (pair)
			out = await filePair(deps, ev, key, null, mark, await docsToSkip(deps, ev, pf.files));
		else {
			const task = await deps.createTask(mark(review), ev.repo);
			// Not filed (no project): nothing recorded, the next pass retries.
			if (!task) return { key, outcome: "unfiled" };
			await deps.stateSet(key, { issueId: task.id });
			out = { key, outcome: "created", issueId: task.id };
		}
		if (out.outcome === "unfiled") return out;
		if (typeof deps.checksOf === "function")
			await deps.stateSet(settleKey(ev), { sha: ev.headSha, at: deps.now(), reviewed: true });
		await supersede(deps, ev);
		return out;
	});
}

// Worker installs this dependency for both webhook and sweep. The testable
// scheduling policy retains its legacy dependency shape for other consumers.
async function admittedReviewDeps(deps, ev, key, seen) {
	if (!deps.admitReview) return deps;
	let admission;
	try {
		admission = await deps.admitReview(ev, seen?.admission);
	} catch {
		return null;
	}
	if (!admission || !["start", "attach"].includes(admission.action)) return null;
	return {
		...deps,
		stateSet: (k, value) => deps.stateSet(k, k === key ? { ...value, admission } : value),
	};
}

// The no-lead pair: one reviewer task per family, on that
// family's least-loaded seat. A family whose task for this head exists (open
// or done) is skipped; a family with no seat is logged and gets nothing (never
// Smythe) and is retried on the next visit.
// State { issueId: first id, issueIds: { claude, gpt } }; a failed
// create leaves its family absent, and the next visit files only that family.
// mark adds the base-merge line to a task.
const FAMILIES = Object.keys(REVIEWER_FAMILIES);
const seatName = (login) => login.charAt(3).toUpperCase() + login.slice(4);
// The seat map (Map or object keyed by Forge login) without one login.
function withoutLogin(agents, login) {
	if (agents instanceof Map) return new Map([...agents].filter(([l]) => l !== login));
	if (!agents || typeof agents !== "object") return agents;
	const { [login]: _drop, ...rest } = agents;
	return rest;
}
async function filePair(deps, ev, key, seen, mark = (t) => t, docs = []) {
	const pr = `${ev.repo}#${ev.number} @ ${ev.headSha.slice(0, 7)}`;
	const issueIds = { ...(seen?.issueIds ?? {}) };
	// A board entry is a title string or a board issue { title, ... }.
	const entries = await deps.listTitles(reviewTitlePrefix(ev.repo, ev.number), ev.repo, ev.number);
	const titles = new Set(entries.map((e) => (typeof e === "string" ? e : e?.title)));
	let failure = null;
	let unfiled = false;
	for (const family of FAMILIES) {
		if (issueIds[family]) continue;
		if (REVIEWER_FAMILIES[family].some((l) => titles.has(pairTitle(ev, seatName(l))))) continue;
		// The PR author never reviews its own PR (logic.js pairVerdict rule 2).
		const seat = pickSeat(
			family,
			await deps.seatLoad(),
			withoutLogin(await deps.seatsOf(), ev.author),
		);
		if (!seat) {
			deps.log(`forge-pr: no ${family} reviewer seat ${pr} (none filed)`);
			unfiled = true;
			continue;
		}
		try {
			const task = await deps.createTask(
				mark(reviewerTask(ev, seat.agentId, seat.name, docs)),
				ev.repo,
			);
			// Not filed (no project): the family stays absent and is retried.
			if (task) issueIds[family] = task.id;
			else unfiled = true;
		} catch (err) {
			failure = err;
			deps.log(`forge-pr: ${family} reviewer create failed ${pr}: ${failReason(err)}`);
		}
	}
	const issueId = seen?.issueId ?? issueIds[FAMILIES.find((f) => issueIds[f])];
	if (!issueId) {
		if (failure) throw failure;
		return { key, outcome: unfiled ? "unfiled" : "duplicate" };
	}
	await deps.stateSet(key, { issueId, issueIds });
	return { key, outcome: "created", issueId, ...(failure || unfiled ? { partial: true } : {}) };
}

// Code-only review: with codeOnlyReview on, the doc paths a
// mixed PR's reviewers skip; [] (a full review) when off or on a read error.
// factoryignore.js loads lazily, as in scriptedNonCode.
async function docsToSkip(deps, ev, files) {
	if (deps.cfg?.codeOnlyReview !== true || !files || !deps.forgeGet || !ev.baseRef) return [];
	try {
		const { docPaths } = await import("./factoryignore.js");
		return await docPaths(deps.forgeGet, ev.repo, ev, files);
	} catch (err) {
		const pr = `${ev.repo}#${ev.number} @ ${ev.headSha.slice(0, 7)}`;
		deps.log(`forge-pr: docs list failed ${pr}: ${failReason(err)} (full review)`);
		return [];
	}
}

// The non-code fast path: an all-non-code head gets the
// scripted verdict comment and a Merge task for Chang, no review task, state
// { scripted: "non-code", issueId }. Answers the Merge task id, or null to go
// the normal path: no base branch, a code or refused path, a failed read or
// comment, or no Chang seat. The file list must be whole: under the 1000-file
// read cap and equal to the PR's own changed_files. factoryignore.js (and its
// `ignore` package) loads here, lazily, so a plugin dir without `ignore` still
// loads and every PR gets the normal review.
async function scriptedNonCode(deps, ev, key, files) {
	if (!ev.baseRef || !deps.findAgent) return null;
	const pr = `${ev.repo}#${ev.number} @ ${ev.headSha.slice(0, 7)}`;
	if (files.truncated || files.length >= 1000 || files.length !== ev.changedFiles) {
		deps.log(`forge-pr: non-code ${pr}: file list not whole (normal review)`);
		return null;
	}
	let merger;
	let scriptedMergeTask;
	try {
		const fi = await import("./factoryignore.js");
		scriptedMergeTask = fi.scriptedMergeTask;
		const { nonCodeVerdict, scriptedComment } = fi;
		const v = await nonCodeVerdict(deps.forgeGet, ev.repo, ev, files);
		if (v.patterns.length > 0)
			deps.log(
				`forge-pr: .factoryignore lines match refused paths ${pr}: ${v.patterns.join(", ")}`,
			);
		if (!v.nonCode) return null;
		merger = await deps.findAgent(MERGER_LOGIN);
		if (!merger) {
			deps.log(`forge-pr: non-code ${pr}: no ${MERGER_LOGIN} seat (normal review)`);
			return null;
		}
		await deps.postComment(
			ev.repo,
			ev.number,
			scriptedComment(
				ev,
				files.map((f) => f.filename),
			),
		);
	} catch (err) {
		deps.log(`forge-pr: non-code check failed ${pr}: ${failReason(err)} (normal review)`);
		return null;
	}
	const task = await deps.createTask(scriptedMergeTask(ev, merger), ev.repo);
	if (!task) return null; // not filed (sf#1250): the normal path, retried next pass
	await deps.stateSet(key, { scripted: "non-code", issueId: task.id });
	// The merge sweep's own record for this head, so it files no second Merge task.
	await deps.stateSet(`merge:${key}`, { issueId: task.id, existed: false });
	deps.log(`forge-pr: non-code ${pr}: scripted approve, Merge task ${task.id}`);
	return task.id;
}

// The head paths a VENDORED or GENERATED marker exempts from the preflight's
// line count (as forge-pr-open counts): one recursive head-tree
// listing, then one contents read per GENERATED marker, through deps.forgeGet.
// Read only when the count without them is over BIG_CHANGE_LINES, the lowest
// bar they could change. Any failed read, a marker whose decoded bytes differ
// from its size, a marker line that is not a bare name, or a tree past 30
// pages answers an empty Set: every file counts (fail closed), one line logged.
// Forgejo marks every page of a tree over per_page truncated, the last one
// too, so the read is complete when the entries read equal total_count, and a
// read past it (a repeated page, a bad count) fails closed. An entry
// path read twice (a repeated page that lands exactly on total_count) fails
// closed too.
const stop = (reason) => Object.assign(new Error(reason), { reason });

async function headMarked(deps, ev, files, pr) {
	if (!deps.forgeGet || addedLines(files).counted <= BIG_CHANGE_LINES) return new Set();
	const sha = encodeURIComponent(ev.headSha);
	try {
		const paths = [];
		const seen = new Set();
		let complete = false;
		let read = 0;
		for (let page = 1; page <= 30 && !complete; page++) {
			const t = await deps.forgeGet(
				`/repos/${ev.repo}/git/trees/${sha}?recursive=true&per_page=1000&page=${page}`,
			);
			if (!Array.isArray(t?.tree)) throw stop("tree read: no tree");
			for (const e of t.tree) {
				if (seen.has(e?.path)) throw stop("tree read: repeated entry");
				seen.add(e?.path);
				if (e?.type === "blob") paths.push(e.path);
			}
			read += t.tree.length;
			if (t.truncated === true && read > t.total_count) throw stop("tree read: past total_count");
			complete = t.truncated !== true || read === t.total_count;
		}
		if (!complete) throw stop("tree read: over 30 pages");
		return await markedPaths(paths, async (p) => {
			const item = await deps.forgeGet(
				`/repos/${ev.repo}/contents/${p.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`,
			);
			if (item?.encoding !== "base64" || typeof item?.content !== "string") {
				throw stop(`marker read: ${p} has no base64 content`);
			}
			const bytes = Buffer.from(item.content, "base64");
			if (bytes.length !== item.size) throw stop(`marker read: ${p} is incomplete`);
			return bytes.toString("utf8");
		});
	} catch (err) {
		deps.log(`forge-pr: preflight marker read failed ${pr}: ${failReason(err)} (all lines count)`);
		return new Set();
	}
}

// { failed: true } when the head fails the preflight: one fix-first
// comment per distinct failure, no board task (no review round), state
// { preflight: "failed", reasons }. Else { files }, null when the files read
// failed: that skips the preflight (review-dispatch step 2 still checks). A failed
// comment is recorded and retried next visit, never thrown.
async function preflightFails(deps, ev, key, seen) {
	const pr = `${ev.repo}#${ev.number} @ ${ev.headSha.slice(0, 7)}`;
	let files;
	try {
		files = await deps.listFiles(ev.repo, ev.number);
	} catch (err) {
		deps.log(`forge-pr: preflight files read failed ${pr}: ${failReason(err)} (skipped)`);
		return { files: null };
	}
	const marked = await headMarked(deps, ev, files, pr);
	const verdict = preflight({ body: ev.body ?? "", files, marked });
	if (verdict.ok) return { files };
	const told =
		seen?.preflight === "failed" &&
		seen.commented === true &&
		JSON.stringify(seen.reasons) === JSON.stringify(verdict.reasons);
	if (told) return { failed: true };
	const record = { preflight: "failed", reasons: verdict.reasons, commented: true };
	try {
		await deps.postComment(ev.repo, ev.number, preflightComment(verdict.reasons));
	} catch (err) {
		Object.assign(record, { commented: false, reason: failReason(err) });
		deps.log(`forge-pr: preflight comment failed ${pr}: ${record.reason} (quarantined)`);
	}
	await deps.stateSet(key, record);
	deps.log(`forge-pr: preflight failed ${pr}: ${verdict.reasons.join("; ")}`);
	return { failed: true };
}

// A head is reviewed once its checks settle (PR 912 got 15 heads in 8
// hours and 70 of 105 tasks finished on stale heads): its Forge combined status
// is not pending and counts at least one check. A red head is reviewed too; the
// lead reads the red. A head with no checks (total_count 0), or whose status
// read failed, is ready once it has been the head for CHECKS_FALLBACK_MS.
// One record per PR (settle:<repo>#<n>, { sha, at, reviewed }), so a new head
// restarts it; head:<repo>@<sha> maps a head back to its PR for the Actions-run
// webhook. The pull_request webhook files a ready head at once, an Actions-run
// webhook files a waiting head when its checks finish, and the 5-minute sweep
// is the backstop for a lost delivery.
// deps.checksOf(repo, sha) answers the combined status; absent means no settle.
export const CHECKS_FALLBACK_MS = 2 * 60 * 1000;
const settleKey = (ev) => `settle:${ev.repo}#${ev.number}`;
const headKey = (repo, sha) => `head:${repo}@${sha}`;

// { state, total } from a Forge combined status, or null when it is not one.
export function checksSummary(status) {
	const total = status?.total_count;
	const state = status?.state;
	if (!Number.isInteger(total) || total < 0) return null;
	return { state: typeof state === "string" ? state : "", total };
}

async function settled(deps, ev) {
	if (typeof deps.checksOf !== "function") return true;
	const now = deps.now();
	let rec = await deps.stateGet(settleKey(ev));
	if (rec?.sha !== ev.headSha || typeof rec.at !== "number") {
		rec = { sha: ev.headSha, at: now };
		await deps.stateSet(settleKey(ev), rec);
		await deps.stateSet(headKey(ev.repo, ev.headSha), { number: ev.number });
	}
	let checks = null;
	try {
		checks = checksSummary(await deps.checksOf(ev.repo, ev.headSha));
	} catch (err) {
		deps.log(
			`forge-pr: checks read failed ${ev.repo}#${ev.number} @ ${ev.headSha.slice(0, 7)}: ${failReason(err)}`,
		);
	}
	if (checks && checks.total > 0) return checks.state !== "pending";
	return now - rec.at >= CHECKS_FALLBACK_MS;
}
// True while a PR's newest head waits to settle: the sweep visits it even when
// its repo is tier 5, so a head the webhook recorded is still created.
async function settlePending(deps, repo, number) {
	const rec = await deps.stateGet(settleKey({ repo, number }));
	return rec != null && rec.reviewed !== true;
}

// An Actions run ended (Forgejo action_run_*): file the repo's heads that were
// waiting on their checks and are now ready. sha is the run's commit when the
// payload names one; a sha with no recorded head, or none, re-checks every
// waiting head of the repo. Each head goes through reviewPrOnce, so a head
// already filed is a duplicate and a head still pending stays waiting.
// deps: reviewPrOnce's deps (with checksOf), forgeGet(path), optional repoTier(repo).
export async function recheckWaiting(deps, repo, sha) {
	const n = typeof sha === "string" ? (await deps.stateGet(headKey(repo, sha)))?.number : undefined;
	let pulls;
	if (Number.isInteger(n)) pulls = [await deps.forgeGet(`/repos/${repo}/pulls/${n}`)];
	else {
		pulls = [];
		for (let page = 1; ; page++) {
			const data = await deps.forgeGet(
				`/repos/${repo}/pulls?state=open&limit=${PAGE}&page=${page}`,
			);
			const items = Array.isArray(data) ? data : [];
			pulls.push(...items);
			if (items.length < PAGE) break;
		}
	}
	const out = [];
	for (const pr of pulls) {
		if (pr?.state === "closed" || pr?.merged === true) continue;
		const api = prFromApi(repo, pr);
		if (!api) continue;
		// Only the head the PR record waits on: an older head is never filed.
		const rec = await deps.stateGet(settleKey(api));
		if (rec?.sha !== api.headSha || rec.reviewed === true) continue;
		const ev = withTier(api, deps.repoTier ? await deps.repoTier(repo) : 5);
		out.push(await reviewPrOnce(deps, ev));
	}
	return out;
}

// The Actions-run payload's commit sha, from the fields Forgejo may carry it in.
export function actionRunSha(body) {
	const run = body?.run;
	for (const v of [run?.commit_sha, run?.head_sha, body?.commit_sha, body?.head_sha, body?.sha])
		if (typeof v === "string" && /^[0-9a-f]{40}$/.test(v)) return v;
	return null;
}

// A new head's review cancels the open review parents of the PR's older heads.
// and their reviewer pair tasks (`<sha7> (Name)`); a lead's old per-reviewer
// child (`<sha7> — Name`) is the lead's to retire.
const OPEN = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
async function supersede(deps, ev) {
	if (!deps.listIssues || !deps.cancelTask) return;
	const prefix = reviewTitlePrefix(ev.repo, ev.number);
	const sha7 = ev.headSha.slice(0, 7);
	try {
		for (const i of await deps.listIssues(prefix, ev.repo, ev.number)) {
			const rest =
				typeof i?.title === "string" && i.title.startsWith(prefix)
					? i.title.slice(prefix.length)
					: "";
			const head = /^([0-9a-f]{7})(?: \([A-Za-z]+\))?$/.exec(rest)?.[1];
			if (!head || head === sha7 || !OPEN.has(i.status)) continue;
			await deps.cancelTask(i.id, `Superseded: head moved to ${sha7}.`);
		}
	} catch (err) {
		deps.log(`forge-pr: supersede failed ${ev.repo}#${ev.number}: ${failReason(err)}`);
	}
}

async function postComment(deps, counter, repo, number, body) {
	const path = `/repos/${repo}/issues/${number}/comments`;
	counter.calls++;
	let res;
	try {
		res = await deps.fetch(`${deps.baseUrl}${path}`, {
			method: "POST",
			headers: {
				authorization: `token ${deps.token}`,
				accept: "application/json",
				"content-type": "application/json",
			},
			body: JSON.stringify({ body }),
		});
	} catch (err) {
		throw new SweepStop(path, err?.name || "Error");
	}
	if (!res.ok) throw new SweepStop(path, String(res.status));
}

// The sweep reviews PR heads of tier 0-4 repos only; a tier 5 repo is
// reviewed from its webhook PR events. No tier reader means tier 5.
const SWEEP_TIERS = new Set([0, 1, 2, 3, 4]);
async function sweepTier(deps, repo) {
	return deps.repoTier ? deps.repoTier(repo) : 5;
}

// deps: fetch, baseUrl, token, repos, now, stateGet, stateSet, createTask, listTitles, cfg, log;
// repoTier(repo) -> 0 | 1 | 2 | 3 | 4 | 5
// optional classify(repo, number, sha40) -> {class, reasons} | null (merge-check)
// optional syncPriority(openPrItems): the PR priority label (priority-label.js)
export async function runSweep(deps) {
	const start = deps.now();
	const since = new Date(start - DAY_MS).toISOString();
	const allowed = new Set(deps.repos);
	const counter = { calls: 0, stale: 0 };
	let prs = 0;
	let issues = 0;
	let created = 0;
	let stopped = false;
	const heads = [];
	try {
		const prItems = await searchAll(deps, counter, "state=open&type=pulls");
		// Before the reviews, so a task created below sees the PR's priority.
		if (deps.syncPriority) {
			try {
				await deps.syncPriority(prItems.filter((i) => allowed.has(i?.repository?.full_name)));
			} catch (err) {
				deps.log(`forge-pr: priority sync failed ${failReason(err)}`);
			}
		}
		for (const item of prItems) {
			const repo = item?.repository?.full_name;
			if (!allowed.has(repo) || !Number.isInteger(item.number)) continue;
			const seenKey = `prseen:${repo}#${item.number}@${item.updated_at}`;
			const seen = await deps.stateGet(seenKey);
			// A `limited` record is the old round-limit stop: that head was never
			// reviewed, so it takes the review path and its memo is rewritten below.
			if (seen && !seen.limited) {
				// A seen head is still a merge candidate: its key carries the sha.
				const k = String(seen.key ?? "");
				const sha = k.startsWith(`${repo}#${item.number}@`) ? k.slice(k.indexOf("@") + 1) : "";
				if (/^[0-9a-f]{40}$/.test(sha))
					heads.push({ repo, number: item.number, headSha: sha, url: item.html_url });
				continue;
			}
			const tier = await sweepTier(deps, repo);
			if (!SWEEP_TIERS.has(tier) && !(await settlePending(deps, repo, item.number))) continue;
			const pr = await getJson(deps, counter, `/repos/${repo}/pulls/${item.number}`);
			const api = prFromApi(repo, pr);
			const ev = api && withTier(api, tier);
			if (!ev) {
				await deps.stateSet(seenKey, { skipped: true });
				continue;
			}
			prs++;
			const r = await reviewPrOnce(
				{
					...deps,
					postComment: (rp, n, b) => postComment(deps, counter, rp, n, b),
					// The preflight reads files on the sweep's own counted path.
					...(deps.preflight
						? {
								listFiles: (rp, n) => pullFiles((p) => getJson(deps, counter, p), rp, n),
								// The non-code fast path reads on the same counter.
								forgeGet: (p) => getJson(deps, counter, p),
							}
						: {}),
					// The checks read is counted on the sweep's path too.
					...(deps.checksOf
						? {
								checksOf: (rp, sha) => {
									counter.calls++;
									return deps.checksOf(rp, sha);
								},
							}
						: {}),
				},
				ev,
			);
			// A settling or unfiled head is not marked seen, so the next pass reads it again.
			// So is a pair with a failed create or a missing seat: the next
			// pass files the missing family.
			if (
				r.outcome === "settling" ||
				r.outcome === "unfiled" ||
				r.outcome === "admission_hold" ||
				r.partial
			)
				continue;
			await deps.stateSet(seenKey, { key: r.key });
			if (r.outcome === "created" || r.outcome === "scripted") created++;
			heads.push(ev);
		}
		try {
			created += await fileMergeTasks(deps, heads);
		} catch (err) {
			deps.log(`forge-pr: merge tasks failed: ${failReason(err)}`);
		}
		const issueItems = await searchAll(
			deps,
			counter,
			`state=open&type=issues&since=${encodeURIComponent(since)}`,
		);
		for (const item of issueItems) {
			const repo = item?.repository?.full_name;
			if (!allowed.has(repo)) continue;
			// New issues only: `since` filters on UPDATED, and a milestone or label
			// change touches hundreds of old issues (2026-10-01: 665 triage tasks).
			const createdAt = Date.parse(item?.created_at ?? "");
			if (!(createdAt >= start - DAY_MS)) continue;
			const ev = issueFromApi(repo, item);
			if (!ev) continue;
			issues++;
			const key = issueDedupeKey(ev);
			if (await deps.stateGet(key)) continue;
			const task = await deps.createTask(
				taskFor({ kind: "issue", key, event: ev }, deps.cfg),
				ev.repo,
			);
			if (!task) continue;
			await deps.stateSet(key, { issueId: task.id });
			created++;
		}
		await rejectStaleApprovals(deps, counter);
	} catch (err) {
		if (!(err instanceof SweepStop)) throw err;
		deps.log(err.message);
		stopped = true;
	}
	// Its own Forge reads, so a stop above does not skip it; a failure is logged by name.
	if (deps.listOpenTasks && deps.settleTask) {
		try {
			await settleFinishedTasks(deps, counter);
		} catch (err) {
			deps.log(`forge-sweep settle failed ${err?.name || "Error"}`);
		}
	}
	// Board-only, so a Forge stop above does not skip it.
	if (deps.approvals && deps.companyId && deps.findAgent) {
		try {
			await fileRicoAsks(deps);
		} catch (err) {
			deps.log(`rico_asks failed ${err?.name || "Error"}`);
		}
	}
	const took = deps.now() - start;
	const stale = counter.stale;
	deps.log(
		`forge-sweep repos=${deps.repos.length} prs=${prs} issues=${issues} created=${created} calls=${counter.calls} stale=${stale} took=${took}`,
	);
	return {
		repos: deps.repos.length,
		prs,
		issues,
		created,
		calls: counter.calls,
		stale,
		stopped,
		took,
	};
}

// The board seats the merge routing names, by Forge login (findAgent).
async function seats(deps) {
	const ids = await Promise.all(VERDICT_LOGINS.map((l) => deps.findAgent(l)));
	return { merger: await deps.findAgent(MERGER_LOGIN), authors: new Set(ids.filter(Boolean)) };
}

// The newest authorized verdict on the review tasks of exactly this head.
async function boardVerdict(deps, ev, authors) {
	let best = null;
	const prefix = `${reviewTitlePrefix(ev.repo, ev.number)}${ev.headSha.slice(0, 7)}`;
	for (const i of await deps.listIssues(prefix, ev.repo, ev.number)) {
		// The lookup is by PR, not by title: this head's reviews only.
		if (typeof i?.title !== "string" || !i.title.startsWith(prefix)) continue;
		const v = headVerdict(i, await deps.listComments(i.id), authors, ev);
		if (v && (!best || v.at > best.at)) best = v;
	}
	return best;
}

// The sweep files the Merge task a lead's approve left unfiled: at
// most MERGE_CAP per tick, once per head under reviewPrOnce's key lock. It
// routes only; Chang's merge-pr runs merge-check (D3). Returns how many it filed.
export const MERGE_CAP = 10;
export async function fileMergeTasks(deps, heads) {
	if (!deps.listIssues || !deps.listComments || !deps.findAgent) return 0;
	let filed = 0;
	let s;
	for (const ev of heads) {
		if (filed >= MERGE_CAP) break;
		const key = dedupeKey(ev);
		// One head failing logs and moves on; it is retried next tick.
		const made = await withKeyLock(`${deps.companyId ?? ""}|${key}`, async () => {
			if (await deps.stateGet(`merge:${key}`)) return false;
			s ??= await seats(deps);
			const v = await boardVerdict(deps, ev, s.authors);
			if (v?.verdict !== "approve" && v?.verdict !== "approve-with-fixes") return false;
			const title = mergeTitle(ev);
			const exists = (await deps.listIssues(title, ev.repo, ev.number)).some(
				(i) => i?.title === title,
			);
			if (!exists && !s.merger) {
				deps.log(`forge-pr: merge task skipped ${key}: no ${MERGER_LOGIN} seat`);
				return false;
			}
			const issue = exists ? null : await deps.createTask(mergeTask(ev, v, s.merger), ev.repo);
			await deps.stateSet(`merge:${key}`, { issueId: issue?.id ?? null, existed: exists });
			return !exists;
		}).catch((err) => {
			deps.log(`forge-pr: merge task failed ${key}: ${failReason(err)}`);
			return false;
		});
		if (made) filed++;
	}
	return filed;
}

// At most this many PR reads per sweep pass, so a backlog of hundreds of
// settled tasks clears over several passes, never in one burst.
export const MAX_SETTLE_READS = 50;
const SETTLE_TITLE =
	/^(?:(?:Review|Merge) ([\w.-]+\/[\w.-]+)#(\d+) @ |Rework ([\w.-]+\/[\w.-]+)#(\d+):)/;

// The PR a Review, Merge or Rework task names, or null for any other title.
export function settleTarget(title) {
	const m = typeof title === "string" ? title.match(SETTLE_TITLE) : null;
	if (!m) return null;
	return { repo: m[1] ?? m[3], number: Number(m[2] ?? m[4]) };
}

// Closes the open board tasks of a PR that has finished: merged ->
// done, closed unmerged -> cancelled, open -> left. Each PR is read once per
// pass, at most MAX_SETTLE_READS reads; a failed read leaves its tasks. With
// stateGet/stateSet the next pass starts where this one stopped, so open PRs
// at the head of the list cannot starve a finished one behind them.
// deps: listOpenTasks() -> [{id, title, status}], settleTask(id, {status, comment}),
// fetch, baseUrl, token, repos, log, stateGet?, stateSet?. Returns the number of tasks settled.
const SETTLE_CURSOR = "forge-sweep:settle-cursor";
export async function settleFinishedTasks(deps, counter = { calls: 0 }) {
	const allowed = new Set(deps.repos);
	const byPr = new Map();
	const tasks = await deps.listOpenTasks();
	for (const task of Array.isArray(tasks) ? tasks : []) {
		if (CLOSED_TASK.has(task?.status)) continue;
		const t = settleTarget(task?.title);
		if (!t || !allowed.has(t.repo)) continue;
		const pr = `${t.repo}#${t.number}`;
		if (!byPr.has(pr)) byPr.set(pr, { t, ids: [] });
		byPr.get(pr).ids.push(task.id);
	}
	const order = [...byPr.keys()];
	const cursor = deps.stateGet ? Number(await deps.stateGet(SETTLE_CURSOR)) : 0;
	const start = Number.isInteger(cursor) && cursor > 0 && order.length ? cursor % order.length : 0;
	let reads = 0;
	let settled = 0;
	for (; reads < Math.min(order.length, MAX_SETTLE_READS); reads++) {
		const pr = order[(start + reads) % order.length];
		const { t, ids } = byPr.get(pr);
		let end = null;
		try {
			const body = await getJson(deps, counter, `/repos/${t.repo}/pulls/${t.number}`);
			end = body?.merged === true ? "merged" : body?.state === "closed" ? "closed" : null;
		} catch (err) {
			if (!(err instanceof SweepStop)) throw err;
			deps.log(`forge-sweep settle read failed ${pr}: ${err.reason}`);
		}
		if (!end) continue;
		for (const id of ids) {
			await deps.settleTask(id, {
				status: end === "merged" ? "done" : "cancelled",
				comment: `Settled: ${pr} ${end}.`,
			});
			settled++;
		}
	}
	if (deps.stateSet && order.length) {
		await deps.stateSet(SETTLE_CURSOR, (start + reads) % order.length);
	}
	if (reads > 0) deps.log(`forge-sweep settle reads=${reads} settled=${settled}`);
	return settled;
}

const MAX_DECISIONS = 20;
const SUPERSEDED = "Superseded: PR merged/closed or head moved (sf#1207)";

// The PR an approval names: payload.repo/number/headSha if present, else the
// title "<owner>/<repo>#<n> ... at <sha7>" (review-dispatch step 5 shape).
export function approvalTarget(approval) {
	const p = approval?.payload ?? {};
	const title = typeof p.title === "string" ? p.title : "";
	const m = title.match(/([\w.-]+\/[\w.-]+)(?:#| PR )(\d+)\b.*?\bat ([0-9a-f]{7,40})\b/);
	const repo = typeof p.repo === "string" ? p.repo : m?.[1];
	const number = Number.isInteger(p.number) ? p.number : m ? Number(m[2]) : undefined;
	const sha = typeof p.headSha === "string" ? p.headSha : m?.[3];
	if (!repo || !Number.isInteger(number) || !sha || !/^[0-9a-f]{7,40}$/.test(sha)) return null;
	return { repo, number, sha };
}

// A merge go and nothing else: review-dispatch step 5 files it as a
// request_board_approval titled exactly "Go on <owner>/<repo>#<n> at <sha>"
// (older ones: "Go on <owner>/<repo> PR <n> at <sha>"). Any other approval that happens to name a PR is not this sweep's to decide.
const MERGE_GO = /^Go on [\w.-]+\/[\w.-]+(?:#| PR )\d+ at [0-9a-f]{7,40}$/;
export function isMergeApproval(approval) {
	const title = approval?.payload?.title;
	return (
		approval?.type === "request_board_approval" && typeof title === "string" && MERGE_GO.test(title)
	);
}

// A live merge go that merge-check does not put in class B was never
// the owner's to decide: the reject note names the class so the lead acts on it
// (review-dispatch step 5). Class B, no classify, a null answer or a classify
// error leave it pending; the error is logged by name only.
async function notRicos(deps, id, t, head) {
	if (!deps.classify) return null;
	let c;
	try {
		c = await deps.classify(t.repo, t.number, head);
	} catch (err) {
		deps.log(`forge-sweep approval ${id} classify failed: ${err?.name || "Error"}`);
		return null;
	}
	if (!c || typeof c.class !== "string" || c.class === "B") return null;
	const reasons = Array.isArray(c.reasons) ? c.reasons : [];
	return `Not Rico's: merge-check class ${c.class} (${reasons.join("; ")})`;
}

// Board-side cleanup: reject pending merge approvals whose PR is merged/closed,
// whose head moved, or that merge-check says are not the owner's (class B). Forge calls stay serial; at most MAX_DECISIONS per run.
// A target Forge answers 403/404 for still stops this run, and is recorded so
// the next run skips it instead of stopping on it again.
// only { repo, number } limits it to that PR's approvals (a new head, at once).
async function rejectStaleApprovals(deps, counter, only) {
	if (!deps.approvals || !deps.companyId || !deps.cfg?.boardUserId) return;
	const allowed = new Set(deps.repos);
	// A board failure is logged by call and error name only, never its message.
	let pending;
	try {
		pending = await deps.approvals.list({ companyId: deps.companyId, status: "pending" });
	} catch (err) {
		throw new SweepStop("approvals.list", err?.name || "Error");
	}
	let quarantined = 0;
	try {
		for (const approval of Array.isArray(pending) ? pending : []) {
			if (counter.stale >= MAX_DECISIONS) break;
			if (!isMergeApproval(approval)) continue;
			const t = approvalTarget(approval);
			if (!t || !allowed.has(t.repo)) continue;
			if (only && (t.repo !== only.repo || t.number !== only.number)) continue;
			const badKey = `approvalbad:${approval.id}`;
			if (await deps.stateGet(badKey)) {
				quarantined++;
				continue;
			}
			let pr;
			try {
				pr = await getJson(deps, counter, `/repos/${t.repo}/pulls/${t.number}`);
			} catch (err) {
				if (err instanceof SweepStop && (err.reason === "403" || err.reason === "404")) {
					await deps.stateSet(badKey, { path: err.path, reason: err.reason, at: deps.now() });
					deps.log(`forge-sweep approval ${approval.id} quarantined: ${err.path} ${err.reason}`);
				}
				throw err;
			}
			const head = pr?.head?.sha ?? "";
			const gone = pr?.merged === true || pr?.state === "closed";
			let decisionNote = SUPERSEDED;
			if (!gone && head.startsWith(t.sha)) {
				decisionNote = await notRicos(deps, approval.id, t, head);
				if (!decisionNote) continue;
			}
			try {
				await deps.approvals.decide(
					approval.id,
					{ action: "reject", actorUserId: deps.cfg.boardUserId, decisionNote },
					deps.companyId,
				);
			} catch (err) {
				throw new SweepStop(`approvals.decide ${approval.id}`, err?.name || "Error");
			}
			counter.stale++;
		}
	} finally {
		if (quarantined > 0)
			deps.log(`forge-sweep approvals quarantined=${quarantined} (inaccessible PR, left pending)`);
	}
}

// A new head on one PR (pull_request synchronized): that PR's stale merge
// approvals are rejected in the same delivery, not at the next sweep. A Forge
// or board stop is logged, never thrown. deps: as runSweep's approvals cleanup.
export async function rejectStaleApprovalsFor(deps, repo, number) {
	const counter = { calls: 0, stale: 0 };
	try {
		await rejectStaleApprovals(deps, counter, { repo, number });
	} catch (err) {
		if (!(err instanceof SweepStop)) throw err;
		deps.log(err.message);
	}
	return counter.stale;
}
