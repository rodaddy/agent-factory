/**
 * @module tests/fleet/rico-notify-plan
 * @description Pure send planning of the notifier: once each, at
 *   most 6 texts an hour, bursts summarised. Fixture objects only, no I/O.
 */
import { describe, expect, test } from "bun:test";
import {
	boardPass,
	emptyState,
	forget,
	markSent,
	plan,
	type State,
	scrub,
} from "../../fleet/notify/plan";

const NOW = Date.parse("2026-10-03T12:00:00.000Z");
const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const BOARD = "http://board.example.invalid:3100";
const ago = (ms: number): string => new Date(NOW - ms).toISOString();

const item = (n: number, link: string | null = null) => ({
	key: `blocked:i${n}:`,
	line: `RIC-${n}: thing ${n}`,
	link,
});
const items = (count: number) => Array.from({ length: count }, (_, i) => item(i + 1));
const primed = (over: Partial<State> = {}): State => ({
	...emptyState(),
	primed: true,
	...over,
});

describe("plan", () => {
	test("an unprimed state with 12 items gives one message naming 12 and all keys", () => {
		const all = items(12);
		const { messages } = plan(all, emptyState(), NOW, BOARD);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text).toBe(`Factory notifier is on. 12 already waiting on you.\n${BOARD}`);
		expect(messages[0]?.keys).toEqual(all.map((i) => i.key));
	});

	test("after markSent the same items give none", () => {
		const all = items(12);
		const first = plan(all, emptyState(), NOW, BOARD).messages[0];
		const state = markSent(emptyState(), first?.keys ?? [], NOW);
		expect(state.primed).toBe(true);
		expect(plan(all, state, NOW + MIN, BOARD).messages).toEqual([]);
	});

	test("1 new item gives one message with its link", () => {
		const one = item(1, "https://forge.example.internal/rodaddy/x/pulls/12");
		const { messages } = plan([one], primed(), NOW, BOARD);
		expect(messages).toEqual([
			{
				text: "RIC-1: thing 1\nhttps://forge.example.internal/rodaddy/x/pulls/12",
				keys: [one.key],
			},
		]);
	});

	test("an item with link null uses boardLink", () => {
		const { messages } = plan([item(1)], primed(), NOW, BOARD);
		expect(messages[0]?.text).toBe(`RIC-1: thing 1\n${BOARD}`);
	});

	test("3 new give one message each", () => {
		const { messages } = plan(items(3), primed(), NOW, BOARD);
		expect(messages).toHaveLength(3);
		expect(messages.map((m) => m.keys)).toEqual(items(3).map((i) => [i.key]));
	});

	test("5 new give one message starting 5 things need you:", () => {
		const { messages } = plan(items(5), primed(), NOW, BOARD);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text.startsWith("5 things need you:\n")).toBe(true);
		expect(messages[0]?.text.includes("and ")).toBe(false);
		expect(messages[0]?.text.endsWith(`\n${BOARD}`)).toBe(true);
		expect(messages[0]?.keys).toHaveLength(5);
	});

	test("7 new list 5 lines and `and 2 more`", () => {
		const { messages } = plan(items(7), primed(), NOW, BOARD);
		expect(messages).toHaveLength(1);
		const lines = messages[0]?.text.split("\n") ?? [];
		expect(lines[0]).toBe("7 things need you:");
		expect(lines.filter((l) => l.startsWith("- "))).toHaveLength(5);
		expect(lines).toContain("and 2 more");
		expect(messages[0]?.keys).toHaveLength(7);
	});

	test("6 sends in the last hour gives none; a 61-minute-old send does not count", () => {
		const full = primed({
			sends: [1, 5, 10, 20, 40, 59].map((m) => ago(m * MIN)),
		});
		expect(plan([item(1)], full, NOW, BOARD).messages).toEqual([]);
		const aged = primed({
			sends: [1, 5, 10, 20, 40, 61].map((m) => ago(m * MIN)),
		});
		expect(plan([item(1)], aged, NOW, BOARD).messages).toHaveLength(1);
	});

	test("2 new with budget 1 gives one summary", () => {
		const state = primed({
			sends: [1, 5, 10, 20, 40].map((m) => ago(m * MIN)),
		});
		const { messages } = plan(items(2), state, NOW, BOARD);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.text.startsWith("2 things need you:\n")).toBe(true);
		expect(messages[0]?.keys).toHaveLength(2);
	});

	test("already sent keys are not new", () => {
		const state = primed({ sent: { [item(1).key]: ago(MIN) } });
		const { messages } = plan(items(2), state, NOW, BOARD);
		expect(messages).toHaveLength(1);
		expect(messages[0]?.keys).toEqual([item(2).key]);
	});

	test("a 5000-char line is cut to 700", () => {
		const long = { key: "tell:c1", line: "x".repeat(5000), link: null };
		const { messages } = plan([long], primed(), NOW, BOARD);
		expect(messages[0]?.text).toHaveLength(700);
	});

	test("a burst of 200-char lines keeps its board link and counts every omitted item (PR 1316)", () => {
		const long = Array.from({ length: 7 }, (_, i) => ({
			key: `blocked:l${i}:`,
			line: `RIC-${i}: ${"y".repeat(200)}`,
			link: null,
		}));
		const { messages } = plan(long, primed(), NOW, BOARD);
		expect(messages).toHaveLength(1);
		const text = messages[0]?.text ?? "";
		expect(text.length).toBeLessThanOrEqual(700);
		expect(text.endsWith(`\n${BOARD}`)).toBe(true);
		const lines = text.split("\n");
		const shown = lines.filter((l) => l.startsWith("- ")).length;
		expect(shown).toBeGreaterThan(0);
		expect(lines).toContain(`and ${7 - shown} more`);
		expect(messages[0]?.keys).toHaveLength(7);
	});

	test("a carriage return or escape byte is removed, a newline is kept", () => {
		const dirty = {
			key: "tell:c2",
			line: "RIC-2: a\rb\u001b[31mc\u0000d\u007fe",
			link: null,
		};
		const { messages } = plan([dirty], primed(), NOW, BOARD);
		expect(messages[0]?.text).toBe(`RIC-2: ab[31mcde\n${BOARD}`);
	});
});

describe("markSent", () => {
	test("a persistent company stop is not sent again after ordinary 30-day pruning", () => {
		const stop = {
			key: "company-budget:approval-id",
			line: "Company daily budget STOP",
			link: null,
		};
		const first = plan([stop], emptyState(), NOW, BOARD).messages;
		expect(first).toHaveLength(1);
		const told = markSent(emptyState(), first[0]?.keys ?? [], NOW);
		const later = markSent(told, [item(1).key], NOW + 31 * DAY);
		expect(plan([stop], later, NOW + 31 * DAY + MIN, BOARD).messages).toEqual([]);
	});

	test("records the keys and one send, and does not change its input", () => {
		const before = primed();
		const after = markSent(before, ["a", "b"], NOW);
		expect(after.sent).toEqual({ a: ago(0), b: ago(0) });
		expect(after.sends).toEqual([ago(0)]);
		expect(before.sent).toEqual({});
		expect(before.sends).toEqual([]);
	});

	test("drops a sent entry 31 days old and a send 61 minutes old", () => {
		const state = primed({
			sent: { old: ago(31 * DAY), recent: ago(29 * DAY) },
			sends: [ago(61 * MIN), ago(30 * MIN)],
		});
		const after = markSent(state, ["k"], NOW);
		expect(Object.keys(after.sent).sort()).toEqual(["k", "recent"]);
		expect(after.sends).toEqual([ago(30 * MIN), ago(0)]);
	});
});

describe("forget", () => {
	test("drops an agent key 60 minutes after it was first seen recovered", () => {
		const state = primed({
			sent: {
				"agent:gone": ago(61 * MIN),
				"agent:live": ago(61 * MIN),
				"blocked:i1:": ago(61 * MIN),
			},
		});
		const seen = forget(state, ["agent:live"], NOW);
		expect(Object.keys(seen.sent).sort()).toEqual(["agent:gone", "agent:live", "blocked:i1:"]);
		const later = forget(seen, ["agent:live"], NOW + 60 * MIN);
		expect(Object.keys(later.sent).sort()).toEqual(["agent:live", "blocked:i1:"]);
		expect(Object.keys(state.sent)).toHaveLength(3);
	});

	test("a recovery inside the cooldown lets the next failure episode be told (PR 1316)", () => {
		const told = primed({ sent: { "agent:a": ago(10 * MIN) } });
		const recovered = forget(told, [], NOW);
		const failingAgain = forget(recovered, ["agent:a"], NOW + 5 * MIN);
		expect("agent:a" in failingAgain.sent).toBe(true);
		const afterCooldown = forget(failingAgain, ["agent:a"], NOW + 61 * MIN);
		expect("agent:a" in afterCooldown.sent).toBe(false);
		expect(
			plan(
				[{ key: "agent:a", line: "A is failing", link: null }],
				afterCooldown,
				NOW + 61 * MIN,
				BOARD,
			).messages,
		).toHaveLength(1);
	});
});

describe("boardPass", () => {
	const fail = (state: State) => boardPass(state, false);

	test("is down on the 3rd failure only, not on the 4th", () => {
		const f1 = fail(primed());
		const f2 = fail(f1.state);
		const f3 = fail(f2.state);
		const f4 = fail(f3.state);
		expect([f1.down, f2.down, f3.down, f4.down]).toEqual([false, false, true, false]);
		expect(f4.state.boardFails).toBe(4);
	});

	test("a success then 3 more failures is down again", () => {
		let state = primed({
			boardFails: 4,
			sent: { "board:down": ago(MIN), "blocked:i1:": ago(MIN) },
		});
		const ok = boardPass(state, true);
		expect(ok.down).toBe(false);
		expect(ok.state.boardFails).toBe(0);
		expect(Object.keys(ok.state.sent)).toEqual(["blocked:i1:"]);
		state = ok.state;
		const downs: boolean[] = [];
		for (let i = 0; i < 3; i++) {
			const next = fail(state);
			downs.push(next.down);
			state = next.state;
		}
		expect(downs).toEqual([false, false, true]);
	});
});

describe("scrub", () => {
	const token = ["fake", "board", "value"].join("-");
	const handle = "someone@example.invalid";

	test("removes a token and a handle", () => {
		expect(scrub(`send to ${handle} failed with ${token} and ${token}`, [token, handle])).toBe(
			"send to <redacted> failed with <redacted> and <redacted>",
		);
	});

	test("leaves the text unchanged for an empty secret", () => {
		expect(scrub("nothing to hide", [""])).toBe("nothing to hide");
	});
});
