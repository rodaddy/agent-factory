// Every board approval that reaches the owner is a defect (the owner ruling
// 2026-10-06: at most ~0.0001% of decisions reach him). The sweep counts them
// and files one Bishop issue per ask so the rule that sent it gets fixed.

const DAY_MS = 24 * 60 * 60 * 1000;
// First sweep with no mark looks back two sweep intervals, not a backlog.
const FIRST_LOOKBACK_MS = 10 * 60 * 1000;
const SINCE_KEY = "ricoasks:since";
const BISHOP_LOGIN = "sf-bishop";
export const RICO_ASK_RULING =
	"Ask: find the rule that sent this to Rico and open the PR that makes agents decide it; operator ruling 2026-10-06: at most ~0.0001% of decisions reach him.";

export const isRicoAsk = (a) => a?.type === "request_board_approval";

// Paperclip answers camelCase; the table is snake_case. Accept either.
function createdMs(a) {
	const v = a?.createdAt ?? a?.created_at;
	const ms = v instanceof Date ? v.getTime() : Date.parse(String(v ?? ""));
	return Number.isFinite(ms) ? ms : null;
}
const requester = (a) => a?.requestedByAgentId ?? a?.requested_by_agent_id ?? null;
const titleOf = (a) => (typeof a?.payload?.title === "string" ? a.payload.title : "(untitled)");

// merge-check reasons when the payload carries them, as a list of strings.
function reasonsOf(a) {
	const r = a?.payload?.reasons;
	if (typeof r === "string" && r.trim()) return [r.trim()];
	return Array.isArray(r) ? r.filter((x) => typeof x === "string" && x.trim()) : [];
}

// Pure: asks to the owner per UTC day with their reasons (merge-check reasons, else
// the title), plus the count created in the 24 h before now.
export function ricoAskCounts(approvals, now) {
	const byDay = new Map();
	let last24h = 0;
	for (const a of Array.isArray(approvals) ? approvals : []) {
		if (!isRicoAsk(a)) continue;
		const ms = createdMs(a);
		if (ms === null) continue;
		if (ms <= now && ms > now - DAY_MS) last24h++;
		const day = new Date(ms).toISOString().slice(0, 10);
		const entry = byDay.get(day) ?? { day, count: 0, reasons: [] };
		entry.count++;
		const rs = reasonsOf(a);
		entry.reasons.push(...(rs.length ? rs : [titleOf(a)]));
		byDay.set(day, entry);
	}
	const days = [...byDay.values()].sort((x, y) => x.day.localeCompare(y.day));
	return { last24h, days };
}

export function ricoAskIssue(a, agentName, bishopId) {
	const rs = reasonsOf(a);
	const lines = [
		`Approval: ${a.id}`,
		`Requested by: ${agentName ?? requester(a) ?? "unknown"}`,
		`Title: ${titleOf(a)}`,
	];
	if (rs.length) lines.push("", "merge-check reasons:", ...rs.map((r) => `- ${r}`));
	lines.push("", RICO_ASK_RULING);
	return {
		title: `Rico was asked: ${titleOf(a)}`,
		description: lines.join("\n"),
		assigneeAgentId: bishopId,
		status: "todo",
		priority: "high",
	};
}

// One Bishop issue per request_board_approval created since the last sweep,
// idempotent per approval id (state ricoask:<id>), and one rico_asks log line.
// deps: approvals.list, companyId, now, stateGet, stateSet, createTask, log,
// findAgent(login), optional agentName(id).
export async function fileRicoAsks(deps) {
	const start = deps.now();
	const all = await deps.approvals.list({ companyId: deps.companyId });
	const list = Array.isArray(all) ? all : [];
	const mark = await deps.stateGet(SINCE_KEY);
	const since = Number.isFinite(mark?.at) ? mark.at : start - FIRST_LOOKBACK_MS;
	let filed = 0;
	// One minute of overlap covers board/worker clock skew; ids dedupe it.
	const fresh = list.filter((a) => isRicoAsk(a) && (createdMs(a) ?? -1) >= since - 60_000);
	let bishopId = null;
	let blocked = false;
	for (const a of fresh) {
		const key = `ricoask:${a.id}`;
		if (await deps.stateGet(key)) continue;
		bishopId ??= await deps.findAgent(BISHOP_LOGIN);
		if (!bishopId) {
			deps.log("rico_asks: Bishop not on the board, asks left unfiled");
			blocked = true;
			break;
		}
		const name = deps.agentName ? await deps.agentName(requester(a)) : null;
		const task = await deps.createTask(ricoAskIssue(a, name, bishopId));
		await deps.stateSet(key, { issueId: task.id });
		filed++;
	}
	// A missing Bishop leaves the mark so the next sweep files these asks.
	if (!blocked) await deps.stateSet(SINCE_KEY, { at: start });
	const counts = ricoAskCounts(list, start);
	deps.log(`rico_asks count24h=${counts.last24h} filed=${filed}`);
	return { ...counts, filed };
}
