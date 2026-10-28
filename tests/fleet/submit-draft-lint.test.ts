/**
 * @module tests/fleet/submit-draft-lint
 * @description rTech Inbox's deterministic guard and comment shape:
 *   every price, rate and cell-number spelling the reviewers found is
 *   refused, ordinary wording that only looks close is not, and `render`
 *   produces the relay's exact contract.
 */
import { describe, expect, test } from "bun:test";
import {
	lint,
	MARKER,
	MAX_DRAFT,
	type PhoneConfig,
	render,
} from "../../fleet/pi-extensions/submit-draft/lint";

/** Fictional 555 fixtures standing in for the configured numbers. */
const PHONES: PhoneConfig = { blocked: "555-555-0100", contact: "555-555-0123" };

const OK =
	"Hi Dana, thanks for reaching out. Happy to set up the free 15-minute first conversation.";

describe("lint refuses", () => {
	for (const [label, draft, want] of [
		["another price", "That usually runs $5,000.", "$5,000"],
		["a k figure", "Around $3k.", "$3k"],
		["published figure, word multiplier", "The fee is $2,000 million.", "$2,000 million"],
		["published figure, thousand", "It is $2000 thousand.", "$2000 thousand"],
		["published figure, grand", "Call it $2,000 grand.", "$2,000 grand"],
		["published figure, bn", "About $2,000bn.", "$2,000bn"],
		["published figure, capital K", "It is $2,000 K.", "$2,000 K"],
		["cents", "$19.99 a month", "$19.99"],
		["$ then spaces", "The fee is $  5000.", "$  5000"],
		["leading-decimal cents", "Our fee is $.99.", "$.99"],
		["fullwidth $", "\uFF042,500 flat.", "\uFF042,500"],
		["small $", "\uFE692,500 flat.", "\uFE692,500"],
		["dollars in words", "It is 2,500 dollars.", "2,500 dollars"],
		["bucks", "Maybe 3k bucks.", "3k bucks"],
		["USD first", "USD 2500 flat.", "USD 2"],
		["US$", "US$2500 flat.", "$2500"],
		["USD after", "2500 USD flat.", "2500 USD"],
		["bare k figure", "Roughly 2.5k.", "2.5k"],
		["per hour", "We bill 150 per hour.", "hourly rate"],
		["/hr", "Rates start at 200/hr.", "hourly rate"],
		["per hr", "It is 150 per hr.", "hourly rate"],
		["an hour", "About 120 an hour.", "hourly rate"],
		["hourly", "We bill hourly.", "hourly rate"],
		["/h", "Our rate is 150/h.", "hourly rate"],
		["/hrs", "Our rate is 150/hrs.", "hourly rate"],
		["/hours", "It is 150 / hours.", "hourly rate"],
		["per hours", "It is 150 per hours.", "hourly rate"],
		["per hrs", "It is 150 per hrs.", "hourly rate"],
		["cell, dashed", "Text me at 555-555-0100.", "cell number"],
		["cell, dotted", "555.555.0100", "cell number"],
		["cell, bare", "5555550100", "cell number"],
		["cell, parenthesized", "(555) 555-0100", "cell number"],
		["cell, four-character separator", "Text (555) - 555-0100.", "cell number"],
		["cell, +1 and spaced dashes", "+1 555 - 555 - 0100", "cell number"],
		[
			"cell, fullwidth digits",
			"\uFF15\uFF15\uFF15-\uFF15\uFF15\uFF15-\uFF10\uFF11\uFF10\uFF10",
			"cell number",
		],
		["fences", "```\nx\n```", "fences"],
		["over-length", "x".repeat(MAX_DRAFT + 1), `over ${MAX_DRAFT}`],
	] as const) {
		test(label, () => expect(lint(draft, "none", PHONES)).toContain(want));
	}

	test("an empty draft without a hand-off reason", () => {
		for (const [d, h] of [
			["", "none"],
			["", ""],
			["   ", "  "],
			[" ", " NONE "],
		]) {
			expect(lint(d as string, h as string)).toContain("HANDOFF");
		}
	});
	test("a multi-line hand-off", () => expect(lint(OK, "a\nb")).toContain("one line"));
	test("the cell refusal names the configured contact number", () =>
		expect(lint("Text 555-555-0100.", "none", PHONES)).toContain("555-555-0123"));
});

describe("with no blocked number configured", () => {
	test("the cell check is off", () =>
		expect(lint("Text 555-555-0100.", "none", {})).toBeUndefined());
});

describe("lint passes", () => {
	for (const draft of [
		OK,
		"The AI Assessment is $2,000 flat, as on the site.",
		"The assessment is $2,000, flat.",
		"It is $2000.",
		"The $2,000 makes sense, and $2,000 more is not needed.",
		"It is $2,000 by Monday, $2,000 billed once.",
		"We can talk for half an hour.",
		"Book an hour with me.",
		"We reply within 24 hours.",
		"We answer in 2 hours most days.",
		"Call 555-555-0123.",
		"x".repeat(MAX_DRAFT),
	]) {
		test(draft.slice(0, 50), () => expect(lint(draft, "none", PHONES)).toBeUndefined());
	}
	test("an empty draft with a reason is a hand-off", () =>
		expect(lint("", "Asks about a tax question")).toBeUndefined());
});

describe("render: the relay's contract", () => {
	test("marker, fenced draft trimmed, hand-off line", () => {
		expect(render(" hi \n", "")).toBe(`${MARKER}\n\`\`\`text\nhi\n\`\`\`\nHANDOFF: none\n`);
		expect(render("Hi Dana.", " Tax question ")).toBe(
			`${MARKER}\n\`\`\`text\nHi Dana.\n\`\`\`\nHANDOFF: Tax question\n`,
		);
	});
});
