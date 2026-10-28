/**
 * @module fleet/pi-extensions/submit-draft/lint
 * @description The deterministic part of rTech Inbox's guard, and the
 *   comment shape the relay reads. Policy: no prices beyond the site, no
 *   promises, no legal or tax advice, anything unsure is handed to a human.
 *   Only the parts a regex can judge live here; the rest is the seat's
 *   instructions, and a human reads every draft before anything is sent.
 *
 *   `lint` refuses, before anything is written:
 *   - a dollar figure other than the published $2,000 (`$`, fullwidth `＄`,
 *     small `﹩`, any spacing, leading-decimal cents, "dollars"/"bucks"/USD,
 *     a bare "2.5k");
 *   - an hourly rate (a number then `/h`, `/hr(s)`, `per hour(s)`, `an hour`;
 *     or "hourly");
 *   - a personal cell number (`SUBMIT_DRAFT_BLOCKED_PHONE`, ten digits), in
 *     any separator spelling up to six characters, fullwidth digits included;
 *     the refusal names `SUBMIT_DRAFT_CONTACT_PHONE` when that is set. With
 *     no blocked number configured, this check is off;
 *   - an empty draft without a hand-off reason, a draft over 4000
 *     characters, a ``` fence in the draft, a multi-line hand-off.
 *
 *   Inert: nothing imports this module until the submit-draft tool does.
 */

export const MARKER = "<!-- rtech-inbox:draft v1 -->";
export const MAX_DRAFT = 4000;
const PUBLISHED_PRICES = new Set(["$2,000", "$2000"]);
/** The phone numbers the cell check uses; both default from the environment. */
export interface PhoneConfig {
	/** The personal cell a draft must never carry (any ten-digit spelling); unset turns the check off. */
	blocked?: string;
	/** The number a draft should use instead, named in the refusal when set. */
	contact?: string;
}

/** Phone config from SUBMIT_DRAFT_BLOCKED_PHONE and SUBMIT_DRAFT_CONTACT_PHONE. */
export function phoneConfigFromEnv(
	env: Record<string, string | undefined> = process.env,
): PhoneConfig {
	return {
		blocked: env.SUBMIT_DRAFT_BLOCKED_PHONE?.trim() || undefined,
		contact: env.SUBMIT_DRAFT_CONTACT_PHONE?.trim() || undefined,
	};
}

/**
 * The blocked cell as a pattern, read after NFKC (fullwidth digits count) with
 * up to six non-digit characters between the 3-3-4 groups on one line, so
 * "(555) - 555-0100" is caught. Undefined unless the number has ten digits.
 */
function cellPattern(blocked: string | undefined): RegExp | undefined {
	const d = (blocked ?? "").normalize("NFKC").replace(/\D/g, "").slice(-10);
	if (d.length !== 10) return undefined;
	const sep = "[^\\d\\n]{0,6}";
	return new RegExp(`${d.slice(0, 3)}${sep}${d.slice(3, 6)}${sep}${d.slice(6)}`);
}
/**
 * A number then a per-hour unit ("150/hr", "150/h", "150/hrs", "150 per hours",
 * "200 an hour"), or the word "hourly".
 */
const HOURLY =
	/(\d[^\n]{0,12}?(\/\s*(h|hrs?|hours?)\b|\b(per|an|a)\s+(h|hrs?|hours?)\b)|\bhourly\b)/i;
/**
 * `$` (ASCII, fullwidth, small) then any spaces, then digits or a leading-decimal
 * amount, then any multiplier (`k`, `m`, `bn`, or a word such as "million"), so
 * "$2,000 million" is never read as the published "$2,000".
 */
const DOLLAR =
	/[$\uFF04\uFE69]\s*(\d[\d,]*(\.\d+)?|\.\d+)(\s*([kKmMbB]|bn|mm|thousand|grand|million|billion|trillion)\b)?/gi;
/** A figure in words or a currency code: "2,500 dollars", "3k bucks", "USD 2500", "US$2500", "2500 USD", "2.5k". */
const WORDY = [
	/\d[\d,.]*\s*[kKmM]?\s*(dollars?|bucks|usd)\b/i,
	/\b(usd|us\$)\s*\d/i,
	/\b\d+(\.\d+)?\s*[kK]\b/,
];

const PRICE = "only the published $2,000 AI Assessment price may appear";

/** The first problem with a draft and its hand-off, or undefined when it may be posted. */
export function lint(
	draft: string,
	handoff: string,
	phones: PhoneConfig = phoneConfigFromEnv(),
): string | undefined {
	const h = handoff.trim().toLowerCase();
	if (!draft.trim() && (!h || h === "none")) return "an empty draft needs a HANDOFF reason";
	if (draft.length > MAX_DRAFT) return `the draft is over ${MAX_DRAFT} characters`;
	if (cellPattern(phones.blocked)?.test(draft.normalize("NFKC")))
		return phones.contact
			? `the draft carries a personal cell number; use the configured contact number ${phones.contact}`
			: "the draft carries a personal cell number; use the configured contact number";
	for (const m of draft.match(DOLLAR) ?? []) {
		if (!PUBLISHED_PRICES.has(m.replace(/\s/g, "").replace(/,+$/, ""))) {
			return `the draft states ${m}; ${PRICE}`;
		}
	}
	for (const re of WORDY) {
		const m = draft.match(re);
		if (m) return `the draft states ${m[0]}; ${PRICE}`;
	}
	if (HOURLY.test(draft)) return "the draft mentions an hourly rate; rTech never quotes one";
	if (draft.includes("```")) return "the draft may not contain ``` fences";
	if (/[\r\n]/.test(handoff)) return "HANDOFF is one line";
	return undefined;
}

/**
 * The comment the relay reads (its contract):
 *   <!-- rtech-inbox:draft v1 -->
 *   ```text
 *   <draft>
 *   ```
 *   HANDOFF: none | <reason>
 */
export function render(draft: string, handoff: string): string {
	return `${MARKER}\n\`\`\`text\n${draft.trim()}\n\`\`\`\nHANDOFF: ${handoff.trim() || "none"}\n`;
}
