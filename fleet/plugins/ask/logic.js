import crypto from "node:crypto";

// Every issue this plugin files starts with this, and a comment only counts as
// her answer on an issue that does.
export const ASK_PREFIX = "Ask: ";
export const ANSWER_PREFIX = "ANSWER:";
export const TITLE_MAX = 120;
export const QUESTION_MAX = 4000;
export const ASKER_MAX = 200;
export const HITS_MAX = 20;
export const SNIPPET_MAX = 500;
// She may already have picked it up; anything past these is hers to close.
const CLOSE_FROM = new Set(["todo", "in_progress"]);

export function headerValue(headers, name) {
	if (!headers) return undefined;
	const want = name.toLowerCase();
	for (const [k, v] of Object.entries(headers)) {
		if (k.toLowerCase() === want) return Array.isArray(v) ? v[0] : v;
	}
	return undefined;
}

// The shared secret travels in its own header, X-Ask-Token. Not Authorization:
// Paperclip's auth layer treats any `Authorization: Bearer` as a board key and
// answers 401 before the plugin sees the delivery (probed for rodaddy.alerts,
// 2026-10-02).
export const TOKEN_HEADER = "x-ask-token";

// Constant-time: both sides are hashed first, so length leaks nothing either.
export function verifyToken(headerToken, secret) {
	if (typeof headerToken !== "string" || typeof secret !== "string" || !secret) return false;
	const digest = (s) => crypto.createHash("sha256").update(s, "utf8").digest();
	return crypto.timingSafeEqual(digest(headerToken), digest(secret));
}

// One line, at most TITLE_MAX code points. fleet/bin/ask-nagatha computes the
// same title to find the issue (the webhook route does not return the worker's
// result), so the two must agree: whitespace runs become one space, then slice.
export function askTitle(question) {
	const flat = String(question).split(/\s+/).filter(Boolean).join(" ");
	return ASK_PREFIX + Array.from(flat).slice(0, TITLE_MAX).join("");
}

const clip = (s, n) => Array.from(String(s)).slice(0, n).join("");

function parseHits(raw) {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error("ask: hits must be an array");
	const hits = [];
	for (const h of raw.slice(0, HITS_MAX)) {
		if (!h || typeof h !== "object" || typeof h.path !== "string" || !h.path)
			throw new Error("ask: every hit needs a path");
		const hit = { path: clip(h.path, 500) };
		if (Number.isInteger(h.line) && h.line > 0) hit.line = h.line;
		if (typeof h.snippet === "string" && h.snippet) hit.snippet = clip(h.snippet, SNIPPET_MAX);
		hits.push(hit);
	}
	return hits;
}

function parseCallback(raw, allowedHosts) {
	if (raw === undefined || raw === null || raw === "") return undefined;
	if (typeof raw !== "string") throw new Error("ask: callbackUrl must be a string");
	let url;
	try {
		url = new URL(raw);
	} catch {
		throw new Error("ask: callbackUrl is not a URL");
	}
	if (url.protocol !== "http:" && url.protocol !== "https:")
		throw new Error("ask: callbackUrl must be http or https");
	const allowed = Array.isArray(allowedHosts) ? allowedHosts : [];
	if (!allowed.includes(url.host)) throw new Error("ask: callbackUrl host is not allowlisted");
	if (url.username || url.password) throw new Error("ask: callbackUrl must not carry credentials");
	return url.toString();
}

/** Validate a delivery body; throws on anything malformed. */
export function parseAsk(body, allowedHosts) {
	if (!body || typeof body !== "object") throw new Error("ask: body must be a JSON object");
	const { question, asker } = body;
	if (typeof question !== "string" || !question.trim())
		throw new Error("ask: question is required");
	if (Array.from(question).length > QUESTION_MAX)
		throw new Error(`ask: question is longer than ${QUESTION_MAX} characters`);
	if (typeof asker !== "string" || !asker.trim()) throw new Error("ask: asker is required");
	const ask = {
		question: question.trim(),
		asker: clip(asker.trim(), ASKER_MAX),
		hits: parseHits(body.hits),
	};
	const callbackUrl = parseCallback(body.callbackUrl, allowedHosts);
	if (callbackUrl) ask.callbackUrl = callbackUrl;
	return ask;
}

function hitLine(h) {
	const where = h.line ? `${h.path}:${h.line}` : h.path;
	if (!h.snippet) return `- ${where}`;
	const quoted = h.snippet
		.split("\n")
		.map((l) => `  > ${l}`)
		.join("\n");
	return `- ${where}\n${quoted}`;
}

export function askDescription(ask) {
	return [
		"Question:",
		"",
		ask.question,
		"",
		`Asked by: ${ask.asker}`,
		"",
		"Librarian hits to start from:",
		...(ask.hits.length ? ask.hits.map(hitLine) : ["- none"]),
		"",
		"Answer from canon/Prometheus with citations in ONE comment starting `ANSWER:`; " +
			"if canon lacks it, request a separately specified implementation task through spec-ready and task-new before writing a PR.",
		"",
		"Filed by the ask plugin (rodaddy.ask).",
	].join("\n");
}

export function askTask(ask, { assigneeAgentId }) {
	return {
		title: askTitle(ask.question),
		description: askDescription(ask),
		assigneeAgentId,
		status: "todo",
		priority: "medium",
	};
}

/** One webhook delivery: check the token, file the issue, remember the callback. */
export async function handleAsk({ headers, body, secret, cfg, board, state }) {
	if (!verifyToken(headerValue(headers, TOKEN_HEADER), secret))
		throw new Error("ask: token check failed");
	const ask = parseAsk(body, cfg.callbackHosts);
	const issue = await board.createIssue(askTask(ask, cfg));
	if (ask.callbackUrl)
		await state.set(issue.id, { callbackUrl: ask.callbackUrl, question: ask.question });
	return { id: issue.id, identifier: issue.identifier ?? null };
}

export function isAnswer(text) {
	return typeof text === "string" && text.trimStart().startsWith(ANSWER_PREFIX);
}

async function postCallback(post, url, payload) {
	for (let attempt = 1; attempt <= 2; attempt++) {
		try {
			const res = await post(url, payload);
			if (res?.ok) return "sent";
		} catch {
			// best effort: one retry, then give up
		}
	}
	return "failed";
}

/**
 * One issue.comment.created event. Acts only on an `ANSWER:` comment written by
 * the assignee on an `Ask:` issue: POST the stored callback (if any, one retry)
 * and close the issue if it is still todo or in_progress.
 */
export async function handleComment({ event, cfg, board, state, post }) {
	const issueId = event?.entityId;
	const commentId = event?.payload?.commentId;
	if (!issueId || !commentId) return { action: "ignored", reason: "no issue or comment" };
	const title = event.payload?.issueTitle;
	if (typeof title === "string" && !title.startsWith(ASK_PREFIX))
		return { action: "ignored", reason: "not an ask" };
	const issue = await board.getIssue(issueId);
	if (!issue || typeof issue.title !== "string" || !issue.title.startsWith(ASK_PREFIX))
		return { action: "ignored", reason: "not an ask" };
	const comment = (await board.listComments(issueId)).find((c) => c?.id === commentId);
	if (!comment) return { action: "ignored", reason: "comment not found" };
	if (!cfg.assigneeAgentId || comment.authorAgentId !== cfg.assigneeAgentId)
		return { action: "ignored", reason: "not the assignee" };
	if (!isAnswer(comment.body)) return { action: "ignored", reason: "not an answer" };

	const stored = await state.get(issueId);
	let callback = "none";
	// Re-checked here: the URL may have been stored before the allowlist changed.
	let callbackUrl;
	try {
		callbackUrl = parseCallback(stored?.callbackUrl, cfg.callbackHosts);
	} catch {
		callbackUrl = undefined;
	}
	if (callbackUrl)
		callback = await postCallback(post, callbackUrl, {
			issueId,
			identifier: issue.identifier ?? null,
			question: stored.question ?? "",
			answer: comment.body,
		});
	let closed = false;
	if (CLOSE_FROM.has(issue.status)) {
		await board.updateIssue(issueId, { status: "done" });
		closed = true;
	}
	return { action: "answered", callback, closed };
}
