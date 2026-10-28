// A seat's question card goes to Smythe, not to the owner's Decisions page (
// the factory answers seat questions). Paperclip's own wake
// prompt tells every adapter to post ask_user_questions; the conduct text says
// not to, and this pass is the safety net. The card itself stays pending: the
// host refuses reject on ask_user_questions (issue-thread-interactions.ts
// rejectInteraction, "cannot be rejected"), so nothing here resolves it.
import { boardRef } from "./logic.js";

// The host caps a list at 100 rows, so one status at a time.
export const QUESTION_STATUSES = ["in_review", "blocked", "todo", "in_progress"];
// An unbounded fan-out exhausted local ports on the proxy host (2026-10-07).
export const MAX_IN_FLIGHT = 4;
const SMYTHE_LOGIN = "sf-smythe";
export const ROUTE_ASK =
	"Decide and post the decision as a comment on the origin task. A question that only Rico may decide goes to him with TELL RICO:.";

// Pending, a question, and asked by an agent; a board user's own card is theirs.
export const isSeatQuestion = (i) =>
	i?.kind === "ask_user_questions" && i?.status === "pending" && !!i?.createdByAgentId;

const titleOf = (i) => i?.title || i?.payload?.title || "(untitled)";

// fn over items, at most `limit` calls in flight; results in input order.
export async function mapLimit(items, limit, fn) {
	const out = new Array(items.length);
	let next = 0;
	const worker = async () => {
		while (next < items.length) {
			const at = next++;
			out[at] = await fn(items[at]);
		}
	};
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return out;
}

export function smytheTask(origin, card, askerName, smytheId) {
	const lines = [`Origin: ${boardRef(origin)}`, `Asked by: ${askerName ?? card.createdByAgentId}`];
	for (const q of Array.isArray(card?.payload?.questions) ? card.payload.questions : []) {
		lines.push("", `Q: ${q?.prompt ?? ""}`);
		for (const o of Array.isArray(q?.options) ? q.options : []) lines.push(`- ${o?.label ?? ""}`);
	}
	lines.push("", ROUTE_ASK);
	return {
		title: `Decision: ${titleOf(card)}`,
		description: lines.join("\n"),
		assigneeAgentId: smytheId,
		status: "todo",
		priority: "high",
	};
}

export const routedComment = (identifier) =>
	`Routed to Smythe in ${identifier} (Rico 2026-10-07: the factory answers seat questions).`;

// deps: listIssues({status, limit}), listInteractions(issueId), stateGet,
// stateSet, findAgent(login), optional agentName(id), createTask(task),
// comment(issueId, body), log.
export async function routeQuestions(deps) {
	const byId = new Map();
	for (const status of QUESTION_STATUSES) {
		const page = await deps.listIssues({ status, limit: 100 });
		for (const i of Array.isArray(page) ? page : []) byId.set(i.id, i);
	}
	const issues = [...byId.values()];
	const cards = await mapLimit(issues, MAX_IN_FLIGHT, async (i) => {
		try {
			const list = await deps.listInteractions(i.id);
			return Array.isArray(list) ? list : [];
		} catch (err) {
			deps.log(`question_route: read failed ${i.id} ${err?.name || "Error"}`);
			return [];
		}
	});
	let pending = 0;
	let routed = 0;
	let smytheId = null;
	for (const [n, origin] of issues.entries()) {
		for (const card of cards[n]) {
			if (!isSeatQuestion(card)) continue;
			pending++;
			const key = `question:${card.id}`;
			if (await deps.stateGet(key)) continue;
			smytheId ??= await deps.findAgent(SMYTHE_LOGIN);
			if (!smytheId) {
				deps.log("question_route: Smythe not on the board, questions left unrouted");
				return { pending, routed };
			}
			const name = deps.agentName ? await deps.agentName(card.createdByAgentId) : null;
			const task = await deps.createTask(smytheTask(origin, card, name, smytheId));
			// Recorded before the comment: a failed comment never files a second task.
			await deps.stateSet(key, { issueId: task.id });
			await deps.comment(origin.id, routedComment(task.identifier ?? task.id));
			routed++;
		}
	}
	deps.log(`question_route issues=${issues.length} pending=${pending} routed=${routed}`);
	return { pending, routed };
}
