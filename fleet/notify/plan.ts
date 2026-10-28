/**
 * @module fleet/notify/plan
 * @description What to send this pass: each item once, at most 6
 *   texts per rolling hour, a burst as one summary. Pure: no I/O, no imports,
 *   and no function changes the state it is given. Runs under Node 24 type
 *   stripping and under bun.
 */

export interface State {
	v: 1;
	/** False until the first pass has sent its one summary. */
	primed: boolean;
	/** Item key to the ISO time it was sent. */
	sent: Record<string, string>;
	/** ISO time of each text in the last hour. */
	sends: string[];
	/** Agent id to passes in a row with status `error`. */
	errorPasses: Record<string, number>;
	/** Passes in a row the board did not answer. */
	boardFails: number;
	/** TELL items found but not sent yet, kept until sent: their issue may leave the scan window. */
	pending: Record<string, { line: string; link: string | null; at: string }>;
	/** Sent agent key to the ISO time it was first seen recovered. */
	recovered: Record<string, string>;
}

export interface Planned {
	key: string;
	line: string;
	link: string | null;
}

export interface Message {
	text: string;
	keys: string[];
}

const HOUR_MS = 60 * 60_000;
const HOURLY_CAP = 6;
const EACH_MAX = 3;
const SUMMARY_LINES = 5;
const TEXT_MAX = 700;
const SUMMARY_LINE_MAX = 120;
const SENT_KEEP_MS = 30 * 24 * HOUR_MS;
const AGENT_QUIET_MS = HOUR_MS;
const BOARD_DOWN_PASSES = 3;
const BOARD_DOWN_KEY = "board:down";

export function emptyState(): State {
	return {
		v: 1,
		primed: false,
		sent: {},
		sends: [],
		errorPasses: {},
		boardFails: 0,
		pending: {},
		recovered: {},
	};
}

/** No control characters but newline. */
function strip(text: string): string {
	let out = "";
	for (const ch of text) {
		const code = ch.codePointAt(0) ?? 0;
		const control = (code < 0x20 && code !== 0x0a) || (code >= 0x7f && code <= 0x9f);
		if (!control) out += ch;
	}
	return out;
}

/** Agent-written text reaches a phone: no control characters but newline, bounded length. */
function clean(text: string): string {
	return strip(text).slice(0, TEXT_MAX);
}

function within(iso: string, nowMs: number, windowMs: number): boolean {
	return nowMs - Date.parse(iso) < windowMs;
}

/** Texts still allowed in the rolling hour; every send (item, heartbeat, outage) spends one. */
export function budget(state: State, nowMs: number): number {
	return HOURLY_CAP - state.sends.filter((at) => within(at, nowMs, HOUR_MS)).length;
}

/** The pending TELL items not already among `items`, so they are planned again. */
export function withPending(state: State, items: Planned[]): Planned[] {
	const have = new Set(items.map((item) => item.key));
	const carried: Planned[] = [];
	for (const [key, held] of Object.entries(state.pending)) {
		if (!have.has(key) && !(key in state.sent))
			carried.push({ key, line: held.line, link: held.link });
	}
	return [...items, ...carried];
}

/** Holds every unsent TELL item in the state until a text carries it. */
export function remember(state: State, items: Planned[], nowMs: number): State {
	const now = new Date(nowMs).toISOString();
	const pending: State["pending"] = {};
	for (const item of items) {
		if (!item.key.startsWith("tell:") || item.key in state.sent) continue;
		const at = state.pending[item.key]?.at ?? now;
		if (within(at, nowMs, SENT_KEEP_MS))
			pending[item.key] = { line: item.line, link: item.link, at };
	}
	return { ...state, pending };
}

/** The burst summary: the count and the board link always fit, each shown line is bounded. */
function summary(fresh: Planned[], boardLink: string): string {
	const head = `${fresh.length} things need you:`;
	const link = strip(boardLink);
	const more = (left: number) => (left > 0 ? `\nand ${left} more`.length : 0);
	let room = TEXT_MAX - head.length - 1 - link.length;
	const shown: string[] = [];
	for (const item of fresh.slice(0, SUMMARY_LINES)) {
		const line = `- ${strip(item.line).replace(/\n/g, " ")}`.slice(0, SUMMARY_LINE_MAX);
		if (1 + line.length + more(fresh.length - shown.length - 1) > room) break;
		shown.push(line);
		room -= 1 + line.length;
	}
	const left = fresh.length - shown.length;
	const lines = [head, ...shown];
	if (left > 0) lines.push(`and ${left} more`);
	lines.push(link);
	return lines.join("\n");
}

export function plan(
	items: Planned[],
	state: State,
	nowMs: number,
	boardLink: string,
): { messages: Message[] } {
	// A budget stop must appear in the text, including first startup and busy hours.
	// It consumes the normal send accounting but is never hidden in a burst summary.
	const stops = items.filter(
		(item) => item.key.startsWith("company-budget:") && !(item.key in state.sent),
	);
	if (stops.length)
		return {
			messages: stops.map((item) => ({
				text: clean(`${item.line}\n${item.link ?? boardLink}`),
				keys: [item.key],
			})),
		};
	if (!state.primed) {
		return {
			messages: [
				{
					text: clean(
						`Factory notifier is on. ${items.length} already waiting on you.\n${boardLink}`,
					),
					keys: items.map((item) => item.key),
				},
			],
		};
	}
	const fresh = items.filter((item) => !(item.key in state.sent));
	const left = budget(state, nowMs);
	if (fresh.length === 0 || left <= 0) return { messages: [] };
	if (fresh.length <= EACH_MAX && fresh.length <= left) {
		return {
			messages: fresh.map((item) => ({
				text: clean(`${item.line}\n${item.link ?? boardLink}`),
				keys: [item.key],
			})),
		};
	}
	return {
		messages: [{ text: summary(fresh, boardLink), keys: fresh.map((item) => item.key) }],
	};
}

/** One text went out carrying `keys`. */
export function markSent(state: State, keys: string[], nowMs: number): State {
	const now = new Date(nowMs).toISOString();
	const sent: Record<string, string> = {};
	for (const [key, at] of Object.entries(state.sent)) {
		// Company stops remain latched until an operator acts; their dedupe never ages out.
		if (key.startsWith("company-budget:") || within(at, nowMs, SENT_KEEP_MS)) sent[key] = at;
	}
	const pending = { ...state.pending };
	for (const key of keys) {
		sent[key] = now;
		delete pending[key];
	}
	const sends = state.sends.filter((at) => within(at, nowMs, HOUR_MS));
	sends.push(now);
	return { ...state, primed: true, sent, sends, pending };
}

/**
 * A failing agent that recovered may be told again 60 minutes after it was
 * first seen recovered, so a new failure episode is told even if it starts
 * inside those 60 minutes.
 */
export function forget(state: State, liveKeys: string[], nowMs: number): State {
	const now = new Date(nowMs).toISOString();
	const sent: Record<string, string> = {};
	const recovered: Record<string, string> = {};
	for (const [key, at] of Object.entries(state.sent)) {
		if (!key.startsWith("agent:")) {
			sent[key] = at;
			continue;
		}
		const since = state.recovered[key] ?? (liveKeys.includes(key) ? undefined : now);
		if (since !== undefined && !within(since, nowMs, AGENT_QUIET_MS)) continue;
		sent[key] = at;
		if (since !== undefined) recovered[key] = since;
	}
	return { ...state, sent, recovered };
}

/** Counts board failures; `down` is true on exactly the 3rd in a row. */
export function boardPass(state: State, ok: boolean): { state: State; down: boolean } {
	if (ok) {
		const sent = { ...state.sent };
		delete sent[BOARD_DOWN_KEY];
		return { state: { ...state, boardFails: 0, sent }, down: false };
	}
	const boardFails = state.boardFails + 1;
	return {
		state: { ...state, boardFails },
		down: boardFails === BOARD_DOWN_PASSES,
	};
}

/** Replaces every non-empty secret in the text before it is logged. */
export function scrub(text: string, secrets: string[]): string {
	let out = text;
	for (const secret of secrets) {
		if (secret !== "") out = out.split(secret).join("<redacted>");
	}
	return out;
}
