import crypto from "node:crypto";

export function headerValue(headers, name) {
	if (!headers) return undefined;
	const want = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
	}
	return undefined;
}

export function verifySignature(rawBody, signatureHeader, secret) {
	if (typeof signatureHeader !== "string" || !secret || typeof rawBody !== "string") return false;
	const m = /^sha256=([0-9a-f]{64})$/i.exec(signatureHeader);
	if (!m) return false;
	const expected = Buffer.from(
		crypto.createHmac("sha256", secret).update(rawBody, "utf8").digest("hex"),
		"utf8",
	);
	const given = Buffer.from(m[1].toLowerCase(), "utf8");
	if (expected.length !== given.length) return false;
	return crypto.timingSafeEqual(expected, given);
}

const PRIORITIES = ["critical", "high", "medium", "low"];

// Priority and the reason for it, from a Forge pull request or issue object.
function priorityFields(item) {
	const names = new Set();
	for (const l of Array.isArray(item?.labels) ? item.labels : []) {
		if (l && typeof l === "object" && typeof l.name === "string") names.add(l.name);
	}
	const labelled = PRIORITIES.find((p) => names.has(`priority/${p}`));
	if (labelled) return { priority: labelled, priorityWhy: `label priority/${labelled}` };
	const marked = [item?.title, item?.body].some(
		(t) => typeof t === "string" && t.toLowerCase().includes("[blocker]"),
	);
	if (marked) return { priority: "critical", priorityWhy: "[blocker] marker" };
	return { priority: "medium", priorityWhy: "default" };
}

// A priority/<x> label wins (the highest of several), then a [blocker] marker
// in the title or body, then medium. Priority is read when the task is created.
export function priorityOf({ labels, title, body } = {}) {
	return priorityFields({ labels, title, body }).priority;
}

// Repo tiers 0-5: Forge topics tier-0 ..
// tier-5 are the config, the lowest number wins. Tier 0 is infra, always
// first. No tier topic: a client/* repo is tier 2, anything else tier 5. Tier 5
// is reviewed from webhook PR events only (sweep.js).
export const TIERS = [0, 1, 2, 3, 4, 5];
const TIER_PRIORITY = { 0: "critical", 1: "critical", 2: "high", 3: "medium", 4: "low", 5: "low" };

export function tierOf(repo, topics) {
	const nums = (Array.isArray(topics) ? topics : [])
		.map((t) => /^tier-([0-5])$/.exec(typeof t === "string" ? t : "")?.[1])
		.filter(Boolean)
		.map(Number);
	if (nums.length) return Math.min(...nums);
	return offLimits(repo) ? 2 : 5;
}

// The event with its repo tier; a default priority becomes the tier's, a
// priority/<x> label or a [blocker] marker still wins. An unknown tier is 5.
export function withTier(event, tier) {
	const known = TIERS.includes(tier) ? tier : 5;
	if (event.priorityWhy !== "default") return { ...event, tier: known };
	return { ...event, tier: known, priority: TIER_PRIORITY[known], priorityWhy: `tier ${known}` };
}

// Issues are worked only when the owner asks: the issue carries this label.
export const WORK_LABEL = "factory-work";

function hasLabel(item, name) {
	return (Array.isArray(item?.labels) ? item.labels : []).some((l) => l?.name === name);
}

function priorityLine(event) {
	return `Priority: ${event.priority ?? "medium"} (${event.priorityWhy ?? "default"})`;
}

const ACTIONS = new Set(["opened", "reopened", "synchronized"]);

// A client/* repo. Its pull requests are reviewed (lead: Skippy); its
// issues stay off the board.
export function offLimits(repo) {
	return typeof repo === "string" && repo.split("/")[0].toLowerCase() === "client";
}

export function parsePullRequestEvent(headers, body, allowedRepos) {
	const ev =
		headerValue(headers, "x-forgejo-event") ??
		headerValue(headers, "x-gitea-event") ??
		headerValue(headers, "x-github-event");
	if (ev !== "pull_request" || !body || typeof body !== "object") return null;
	// A title edit qualifies: leaving WIP (Forgejo's draft) arrives as "edited".
	// The head dedupe (repo#n@sha) makes it a no-op on an already-tasked head.
	const titleEdit = body.action === "edited" && body.changes?.title !== undefined;
	// A body-only edit qualifies too; reviewPrOnce acts on it only for a head
	// whose recorded state is a preflight fail.
	const bodyEdit = body.action === "edited" && !titleEdit && body.changes?.body !== undefined;
	if (!ACTIONS.has(body.action) && !titleEdit && !bodyEdit) return null;
	const repo = body.repository?.full_name;
	if (typeof repo !== "string" || !Array.isArray(allowedRepos) || !allowedRepos.includes(repo))
		return null;
	if (!Number.isInteger(body.number) || body.number <= 0) return null;
	const pr = body.pull_request;
	// A draft (Forgejo: a "WIP:" title) is not ready for review; the title
	// edit that leaves draft is reviewed.
	if (pr?.draft === true) return null;
	const headSha = pr?.head?.sha;
	if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) return null;
	if (typeof pr.html_url !== "string") return null;
	return {
		repo,
		number: body.number,
		action: body.action,
		headSha,
		url: pr.html_url,
		title: typeof pr.title === "string" ? pr.title : "",
		author: typeof pr.user?.login === "string" ? pr.user.login : "",
		body: typeof pr.body === "string" ? pr.body : "",
		...baseRefOf(pr),
		...(bodyEdit ? { bodyEdit: true } : {}),
		...priorityFields(pr),
	};
}

export function dedupeKey(event) {
	return `${event.repo}#${event.number}@${event.headSha}`;
}

export function reviewIssue(event, { reviewerAgentId }) {
	const description = [
		`PR: [${event.repo}#${event.number}](${event.url})`,
		`Title: ${event.title}`,
		`Author: ${event.author}`,
		`Action: ${event.action}`,
		`Head SHA: \`${event.headSha}\``,
		priorityLine(event),
		...(offLimits(event.repo) ? ["Lead: Skippy"] : []),
		"",
		"Publish: post the combined verdict on the Forge PR as well as the board (sf#1365).",
	].join("\n");
	return {
		title: `Review ${event.repo}#${event.number} @ ${event.headSha.slice(0, 7)}`,
		description,
		assigneeAgentId: reviewerAgentId,
		status: "todo",
		priority: event.priority ?? "medium",
	};
}

// One reviewer's task in the no-lead pair: the head and the
// reviewer's name, `Review <repo>#<n> @ <sha7> (<Name>)`.
export function pairTitle(event, name) {
	return `${reviewTitlePrefix(event.repo, event.number)}${event.headSha.slice(0, 7)} (${name})`;
}

// The task one reviewer of the pair works. `Head SHA:` is what pairVerdict
// and merge-check bind the verdict to. docs: the changed paths that are
// non-code, which the reviewer skips; empty or over DOCS_LIST_MAX is a full review.
const DOCS_LIST_MAX = 200;
export function reviewerTask(event, agentId, name, docs = []) {
	const skip = docs.length > 0 && docs.length <= DOCS_LIST_MAX;
	const description = [
		`PR: [${event.repo}#${event.number}](${event.url})`,
		`Title: ${event.title}`,
		`Author: ${event.author}`,
		`Action: ${event.action}`,
		`Head SHA: \`${event.headSha}\``,
		priorityLine(event),
		...(skip
			? [
					"",
					"Docs, not reviewed (The operator 2026-10-07): review only the other changed paths. These are non-code:",
					...docs.map((p) => `- \`${p}\``),
				]
			: []),
		"",
		"Publish: post your review on the Forge PR as well as the board (sf#1365).",
		"Run review-pr on this head; post on the PR and here; end with `verdict: approve` or `verdict: fix-first`.",
	].join("\n");
	return {
		title: pairTitle(event, name),
		description,
		assigneeAgentId: agentId,
		status: "todo",
		priority: event.priority ?? "medium",
	};
}

const ISSUE_ACTIONS = new Set(["opened", "reopened"]);

export function parseIssueEvent(headers, body, allowedRepos) {
	const ev =
		headerValue(headers, "x-forgejo-event") ??
		headerValue(headers, "x-gitea-event") ??
		headerValue(headers, "x-github-event");
	if (ev !== "issues" || !body || typeof body !== "object") return null;
	if (!ISSUE_ACTIONS.has(body.action)) return null;
	const repo = body.repository?.full_name;
	if (typeof repo !== "string" || !Array.isArray(allowedRepos) || !allowedRepos.includes(repo))
		return null;
	return issueFromApi(repo, body.issue, body.action);
}

// A Forge issue object (webhook or API) to an intake event; PR-backed issues
// are pull requests and take the review path instead.
export function issueFromApi(repo, issue, action = "opened") {
	if (offLimits(repo) || !issue || typeof issue !== "object" || issue.pull_request) return null;
	// No issue work unless the owner asks for it (the factory-work label).
	if (!hasLabel(issue, WORK_LABEL)) return null;
	if (!Number.isInteger(issue.number) || issue.number <= 0) return null;
	if (typeof issue.html_url !== "string") return null;
	// The crew (sf-*) opens roadmap maps and steward reports; it does not triage its own issues.
	if (typeof issue.user?.login === "string" && issue.user.login.startsWith("sf-")) return null;
	return {
		repo,
		number: issue.number,
		title: typeof issue.title === "string" ? issue.title : "",
		url: issue.html_url,
		action,
		...priorityFields(issue),
	};
}

export function issueDedupeKey(event) {
	return `issue:${event.repo}#${event.number}`;
}

export function triageIssue(event, { triageAgentId }) {
	return {
		title: `Triage ${event.repo}#${event.number}`,
		description: [
			event.url,
			"",
			`Title: ${event.title}`,
			`Action: ${event.action}`,
			priorityLine(event),
		].join("\n"),
		assigneeAgentId: triageAgentId,
		status: "todo",
		priority: event.priority ?? "medium",
	};
}

// A Forge API pull object to the same event the webhook yields; drafts skipped.
export function prFromApi(repo, pr) {
	if (!pr || typeof pr !== "object" || pr.draft === true) return null;
	const headSha = pr.head?.sha;
	if (!Number.isInteger(pr.number) || pr.number <= 0) return null;
	if (typeof headSha !== "string" || !/^[0-9a-f]{40}$/.test(headSha)) return null;
	if (typeof pr.html_url !== "string") return null;
	return {
		repo,
		number: pr.number,
		action: "opened",
		headSha,
		url: pr.html_url,
		title: typeof pr.title === "string" ? pr.title : "",
		author: typeof pr.user?.login === "string" ? pr.user.login : "",
		body: typeof pr.body === "string" ? pr.body : "",
		...baseRefOf(pr),
		...priorityFields(pr),
	};
}

// The base branch, for the non-code fast path's .factoryignore.
// changedFiles, the PR's own count, tells the fast path its file list is whole.
const baseRefOf = (pr) => ({
	...(typeof pr.base?.ref === "string" ? { baseRef: pr.base.ref } : {}),
	...(Number.isInteger(pr.changed_files) ? { changedFiles: pr.changed_files } : {}),
});

// Every sweep item with the key the webhook would use for it.
export function sweepCandidates(repo, pulls, issues) {
	const out = [];
	for (const p of Array.isArray(pulls) ? pulls : []) {
		const ev = prFromApi(repo, p);
		if (ev) out.push({ kind: "pr", key: dedupeKey(ev), event: ev });
	}
	for (const i of Array.isArray(issues) ? issues : []) {
		const ev = issueFromApi(repo, i);
		if (ev) out.push({ kind: "issue", key: issueDedupeKey(ev), event: ev });
	}
	return out;
}

export function taskFor(candidate, cfg) {
	return candidate.kind === "pr"
		? reviewIssue(candidate.event, cfg)
		: triageIssue(candidate.event, cfg);
}

// After two rounds a PR is warned, not stopped: every new
// head is still reviewed, and each head past the limit gets one warning.
export const REVIEW_ROUND_LIMIT = 2;
// The warning for a PR that has had `rounds` review rounds. The board sweep
// and the tests match the "ROUND LIMIT:" prefix.
export function roundLimitText(rounds) {
	return `ROUND LIMIT: this pull request has had ${rounds} review rounds. Fix any open P0 or P1 findings before you push again. Review continues on every new head (The operator, 2026-10-08).`;
}

// The title prefix every review task of this PR carries; the trailing " @ "
// keeps #13 from matching #131.
export function reviewTitlePrefix(repo, number) {
	return `Review ${repo}#${number} @ `;
}

// The description line of a review task whose head only merges the base
// branch into a reviewed head: the lead delta-checks it, and it is not a
// round.
export const BASE_MERGE_LINE = "Base merge: delta review, not a round.";

// A board entry is a title string, or a board issue { title, status, description }.
const titleOf = (e) => (typeof e === "string" ? e : e?.title);

// A review task's title after the prefix: the legacy parent `<sha7>`, a pair
// task `<sha7> (Name)`, or a lead's old child `<sha7> — Name`.
const ROUND_TITLE = /^([0-9a-f]{7})(?: \([A-Za-z]+\)| — \S+)?$/;

// The sha7 a review title names, or null when it is not this PR's review.
function reviewHead(t, prefix) {
	if (typeof t !== "string" || !t.startsWith(prefix)) return null;
	return ROUND_TITLE.exec(t.slice(prefix.length))?.[1] ?? null;
}

// A cancelled review, or one marked as a base merge, did not use a round.
// A bare title carries neither, so it counts.
function notARound(e) {
	if (!e || typeof e !== "object") return false;
	if (e.status === "cancelled") return true;
	return typeof e.description === "string" && e.description.split("\n").includes(BASE_MERGE_LINE);
}

// The PR's review rounds so far. A round is one head: the distinct sha7s among
// the PR's counted review tasks, so a reviewer pair, or a parent with its
// children, is one round.
export function reviewRounds(entries, repo, number) {
	const prefix = reviewTitlePrefix(repo, number);
	const heads = new Set();
	for (const e of Array.isArray(entries) ? entries : []) {
		const head = reviewHead(titleOf(e), prefix);
		if (head && !notARound(e)) heads.add(head);
	}
	return heads.size;
}

// "create" while fewer than two review rounds exist for the PR, else "limit".
// "limit" means warn: the review task is still created.
export function roundDecision(entries, repo, number) {
	return reviewRounds(entries, repo, number) >= REVIEW_ROUND_LIMIT ? "limit" : "create";
}

// The sha7 of every head the PR has had a review task for, any status.
export function reviewedHeads(entries, repo, number) {
	const prefix = reviewTitlePrefix(repo, number);
	const heads = (Array.isArray(entries) ? entries : []).map((e) => reviewHead(titleOf(e), prefix));
	return [...new Set(heads.filter(Boolean))];
}

export function roundLimitKey(event) {
	return `roundlimit:${dedupeKey(event)}`;
}

// The limit comment, @-mentioning the PR author: for a session or a human,
// who cannot be assigned on the board, the mention is the kick-back.
export function roundLimitComment(author, rounds) {
	const text = roundLimitText(rounds);
	return typeof author === "string" && /^[\w.-]+$/.test(author)
		? `${text}\n\n@${author}: this goes back to you.`
		: text;
}

// True when text holds url followed by the end of text or a non-digit, so
// .../pulls/14 never matches .../pulls/146.
function holdsLink(text, url) {
	for (let at = text.indexOf(url); at !== -1; at = text.indexOf(url, at + 1)) {
		if (!/[0-9]/.test(text.charAt(at + url.length))) return true;
	}
	return false;
}

/** The author's own task that carries this PR: never a review task, and its description holds the PR link. */
export function pickLinkedTask(issues, prUrl) {
	return (
		(Array.isArray(issues) ? issues : []).find(
			(i) =>
				typeof i?.title === "string" &&
				!i.title.startsWith("Review ") &&
				typeof i?.description === "string" &&
				holdsLink(i.description, prUrl),
		) ?? null
	);
}

// Who merges (fleet/board/crew.json key milestone-engineer) and whose verdict
// counts: Smythe and the Review Leads, merge-check:120,123.
export const MERGER_LOGIN = "sf-chang";
export const VERDICT_LOGINS = ["sf-smythe", "sf-adams", "sf-czajka"];
// Ported from merge-check:116 (VERDICT) and :398 (the review heading): the
// plugin never runs merge-check, Chang's merge-pr does (D3). Coarser than
// merge-check on authorship: any VERDICT_LOGINS seat, no dispatch window.
const VERDICT = /^verdict:\s*(approve-with-fixes|approve|fix-first)\s*$/gm;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
export function verdictOf(body, repo, number, sha7) {
	const ref = escapeRe(`${repo}#${number}`);
	const heading = new RegExp(
		`^## Review of (?:${ref}|\\[${ref}\\]\\([^)\\s]*\\)) at ${sha7}\\s*$`,
		"m",
	);
	if (typeof body !== "string" || !heading.test(body)) return null;
	return [...body.matchAll(VERDICT)].at(-1)?.[1] ?? null;
}

// The newest verdict by an author in authorIds on one review task, bound to
// the head as merge-check:403 binds it: exact title, full sha in the description.
export function headVerdict(issue, comments, authorIds, ev) {
	const sha7 = ev.headSha.slice(0, 7);
	if (issue?.title !== `${reviewTitlePrefix(ev.repo, ev.number)}${sha7}`) return null;
	if (!String(issue.description ?? "").includes(ev.headSha)) return null;
	let best = null;
	for (const c of Array.isArray(comments) ? comments : []) {
		if (!authorIds.has(c?.authorAgentId)) continue;
		const verdict = verdictOf(c.body, ev.repo, ev.number, sha7);
		const at = String(c.createdAt ?? "");
		if (verdict && (!best || at > best.at))
			best = { verdict, by: c.authorAgentId, at, commentId: c.id, issue };
	}
	return best;
}

export const boardRef = (i) =>
	i?.identifier
		? `[${i.identifier}](/${i.identifier.split("-")[0]}/issues/${i.identifier})`
		: `board task ${i?.id}`;
export const mergeTitle = (ev) => `Merge ${ev.repo}#${ev.number} @ ${ev.headSha.slice(0, 7)}`;
export function mergeTask(ev, v, assigneeAgentId) {
	return {
		title: mergeTitle(ev),
		description: [
			`PR: [${ev.repo}#${ev.number}](${ev.url})`,
			`Head SHA: \`${ev.headSha}\``,
			`Verdict: \`verdict: ${v.verdict}\` on ${boardRef(v.issue)}, comment ${v.commentId}`,
			"",
			"Run merge-pr: merge-check re-checks everything first; filed by the forge-pr sweep (sf#1730).",
		].join("\n"),
		assigneeAgentId,
		status: "todo",
		priority: "high",
	};
}

// The board task that hands a PR past the round limit back to an employee author.
export function reworkTask(event, assigneeAgentId, rounds) {
	return {
		title: `Rework ${event.repo}#${event.number}: review round limit`,
		description: `${roundLimitText(rounds)}\n\nPR: [${event.repo}#${event.number}](${event.url})`,
		assigneeAgentId,
		status: "todo",
		priority: event.priority ?? "medium",
	};
}

// A seat Paperclip will not invoke: a todo task assigned to it is
// parked blocked by recovery, so it is created or reopened in backlog instead.
const NOT_INVOKABLE = new Set(["paused", "error", "terminated", "archived"]);

// "backlog" for an agent whose status is not invokable, else "todo" (no agent
// or no status included: the lookup gave nothing to hold on).
export function taskStatusFor(agent) {
	return NOT_INVOKABLE.has(agent?.status) ? "backlog" : "todo";
}

// The two reviewer families of the no-lead pair. A head is
// mergeable when the newest verdict from each family is approve (D3).
export const REVIEWER_FAMILIES = {
	claude: ["sf-kapoor", "sf-giraud", "sf-adams"],
	gpt: ["sf-colter", "sf-kong", "sf-czajka"],
};
const FAMILIES = Object.keys(REVIEWER_FAMILIES);

const REVIEWER_PROFILES = {
	claude: { models: ["claude-sonnet-5-5"], thinking: "medium" },
	gpt: { models: ["gpt-6.1-sol"], thinking: "low" },
};

// The family seat to file a pair task for. A seat qualifies by its board
// configuration only: pi_local, an adapterConfig.model whose leaf after the
// last "/" is one of the family profile's models, and adapterConfig.thinking equal to
// the profile's level (runtime invocation still needs dispatcher enforcement).
// Of the qualified seats, the invokable one (idle or running) with the fewest
// queued+running runs, ties by login order. No invokable qualified seat: still
// the least loaded qualified one, even paused (the caller holds it in backlog).
// No qualified seat at all: null, and nothing is filed.
export function pickSeat(family, load, agents) {
	if (!Object.hasOwn(REVIEWER_FAMILIES, family)) return null;
	const profile = REVIEWER_PROFILES[family];
	const agentOf = (login) => (agents instanceof Map ? agents.get(login) : agents?.[login]);
	const on = REVIEWER_FAMILIES[family]
		.map((login) => ({ login, agent: agentOf(login) }))
		.filter(
			(s) =>
				typeof s.agent?.id === "string" &&
				s.agent.id !== "" &&
				s.agent.adapterType === "pi_local" &&
				typeof s.agent.adapterConfig?.model === "string" &&
				profile.models.includes(s.agent.adapterConfig.model.split("/").at(-1)) &&
				s.agent.adapterConfig.thinking === profile.thinking,
		);
	const live = on.filter((s) => !NOT_INVOKABLE.has(s.agent.status));
	const runs = (s) => (load instanceof Map ? Number(load.get(s.agent.id)) || 0 : 0);
	let best = null;
	for (const s of live.length ? live : on) if (!best || runs(s) < runs(best)) best = s;
	if (!best) return null;
	return { agentId: best.agent.id, name: best.login.charAt(3).toUpperCase() + best.login.slice(4) };
}

// Ported from merge-check:116 (VERDICT), :148 (ESCALATE) and :398 (the review
// heading), as PR 1751's verdictOf is; L4 folds the two into one reader.
// VERDICT and escapeRe are verdictOf's, above.
const ESCALATE = /^(?:escalate|council call):[ \t]*(\S.*?)\s*$/gm;
// The verdict counts only inside this head's `## Review of` section, which ends
// at the next `## Review of` heading; the last such verdict in the body wins.
const ANY_REVIEW = /^## Review of /m;
function headingVerdict(body, repo, number, sha7) {
	const ref = escapeRe(`${repo}#${number}`);
	const heading = new RegExp(
		`^## Review of (?:${ref}|\\[${ref}\\]\\([^)\\s]*\\)) at ${sha7}\\s*$`,
		"m",
	);
	let said = null;
	for (const section of body.split(/^(?=## Review of )/m)) {
		const line = section.split("\n", 1)[0];
		if (!ANY_REVIEW.test(line) || !heading.test(line)) continue;
		said = [...section.matchAll(VERDICT)].at(-1)?.[1] ?? said;
	}
	return said;
}
// A comment's instant, NaN when createdAt does not parse.
const instant = (at) => Date.parse(String(at ?? ""));
// 1 when a is later than b, -1 when earlier; 0 on a tie or when either does not
// parse, so an unordered pair fails closed the way a tie does.
const later = (a, b) => {
	const d = a - b;
	return Number.isNaN(d) || d === 0 ? 0 : Math.sign(d);
};
const asSet = (x) => (x instanceof Set ? x : new Set(Array.isArray(x) ? x : []));
const PAIR_SUFFIX = /^ \([A-Za-z]+\)$/;

// The pair's verdict on head ev.headSha (sf#1730 plan section 2, rules 1-8).
// tasks: [{issue, comments}] for the PR's pair tasks; seats: {claude, gpt}
// agent-id sets and an optional authorSeat. Pure and total: bad input is pending.
export function pairVerdict(tasks, ev, seats) {
	const out = { state: "pending", claude: null, gpt: null, missing: [...FAMILIES], escalate: null };
	const sha = ev?.headSha;
	if (!Array.isArray(tasks) || typeof sha !== "string" || !/^[0-9a-f]{40}$/.test(sha)) return out;
	if (typeof ev.repo !== "string" || !Number.isInteger(ev.number)) return out;
	const sha7 = sha.slice(0, 7);
	const head = `${reviewTitlePrefix(ev.repo, ev.number)}${sha7}`;
	const sets = FAMILIES.map((f) => [f, asSet(seats?.[f])]);
	// Families with any verdict at an unparseable time: fix-first, whatever follows.
	const unordered = new Set();
	const familyOf = (id) => {
		const hits = sets.filter(([, s]) => s.has(id));
		return hits.length === 1 ? hits[0][0] : null;
	};
	for (const task of tasks) {
		const issue = task?.issue;
		// Rule 1: exact pair title for this head and the full sha in the description.
		if (typeof issue?.title !== "string" || !issue.title.startsWith(head)) continue;
		if (!PAIR_SUFFIX.test(issue.title.slice(head.length))) continue;
		if (!String(issue.description ?? "").includes(sha)) continue;
		for (const c of Array.isArray(task.comments) ? task.comments : []) {
			const by = c?.authorAgentId;
			const family = familyOf(by);
			// Rule 2: one family's seat, never the PR author's own seat.
			if (!family || by === seats?.authorSeat || typeof c.body !== "string") continue;
			const at = String(c.createdAt ?? "");
			const t = instant(at);
			const why = [...c.body.matchAll(ESCALATE)].at(-1)?.[1];
			if (why && (!out.escalate || later(t, instant(out.escalate.at)) > 0))
				out.escalate = { by, at, why };
			const said = headingVerdict(c.body, ev.repo, ev.number, sha7);
			if (!said) continue;
			// Rule 3: newest per family by instant; a tie, an unparseable time, and
			// approve-with-fixes are fix-first. An unparseable time marks the family
			// fix-first for good, so no later comment or order can erase it.
			if (Number.isNaN(t)) unordered.add(family);
			const verdict = said === "approve" ? "approve" : "fix-first";
			const best = out[family];
			const order = best ? later(t, instant(best.at)) : 1;
			if (order > 0 || (order === 0 && verdict === "fix-first"))
				out[family] = { verdict, by, at, commentId: c.id, issue };
		}
	}
	for (const f of unordered) out[f] = { ...out[f], verdict: "fix-first" };
	out.missing = FAMILIES.filter((f) => !out[f]);
	if (out.escalate) out.state = "escalated";
	else if (FAMILIES.some((f) => out[f]?.verdict === "fix-first")) out.state = "fix-first";
	else if (out.missing.length === 0) out.state = "approve";
	return out;
}
