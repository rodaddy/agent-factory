/**
 * @module github/signature
 * @description The agent signature line that opens EVERY factory-authored forge
 *   body — result comment, triage comment, audit issue, proposal PR (
 *   an owner ruling). One helper, one spelling, consumed by every builder:
 *   a per-surface copy is how the four bodies drift into four different
 *   attributions, which is the failure this exists to prevent.
 *
 *   THE LINE IS ENTIRELY AUTHOR-CONTROLLED. Every component is either a fixed
 *   literal from this module or a value the CALLER holds from trusted state.
 *   Runner-returned text never reaches it: there is no path from `RunnerResult`
 *   into this function, and the `model` argument is documented below as
 *   trusted-or-omitted precisely so a future caller cannot quietly pipe attested-
 *   looking runner output through it.
 *
 *   PLACEMENT is the caller's, not this module's, because the two body shapes
 *   differ. A body carrying a hidden dedupe marker keeps the marker on line 1
 *   and puts the signature on line 2 — the first VISIBLE line. A body with no
 *   marker (the proposal PR) opens with the signature outright. Either way the
 *   signature precedes all content. Moving the marker off line 1 would be safe
 *   for dedupe — the matchers are position-independent substring scans
 *   (`publish-dedupe.ts`, `c.body.includes(marker)` / `body_.includes(marker)`) —
 *   but it buys nothing and every live body already carries it there.
 *
 *   THE ACTIONS LANES ARE THE SAME LINE, A DIFFERENT SEAT. A Forgejo Actions
 *   lane (pr-review, issue-triage, sop-verify, site-publish, hosted-app-render,
 *   factory-smoke) authors bodies too, and names itself through the `agent` /
 *   `seat` overrides: harness `forgejo-actions`, seat `software-factory lane
 *   <name>`. The lanes that compose their body in shell call
 *   `scripts/actions/signature-line.sh`, which renders the SAME bytes; the test
 *   in `tests/github/signature.test.ts` and done-means
 *   `scripts/done-means/actions-lane-signature-369.sh` pin the two spellings
 *   equal, so the lanes cannot drift into a second one.
 *
 * @outputs
 *   - `signatureLine` -- the single attribution line every builder prepends
 *   - `UNATTESTED_MODEL` -- the literal used when no model was attested
 *   - `ACTIONS_AGENT` / `actionsLaneSeat` -- the Actions-lane identity
 *
 * @dependencies
 *   - ../log -- the one logger, for the traced() wrapper; otherwise fixed
 *     literals plus a caller-supplied date, deliberately I/O-free
 */
import { traced } from "../log";

/**
 * The model component when the builder has no attested model in scope.
 *
 * `job_attempts.observed_model` is the only attested model in this system, and
 * it is not in scope for ANY body builder — none of them holds an attempt row,
 * and sf#369 forbids inventing a join to reach one. So the line says
 * `unattested` rather than naming a model nobody verified. That is the honest
 * reading under LAW 0: a requested model is not an observed one, and a body
 * asserting a model it cannot attest is a guess wearing the grammar of a fact.
 */
export const UNATTESTED_MODEL = "unattested";

/** Fixed, author-controlled: the identity that authors every factory body. */
const AGENT = "rodaddy-watcher";

/** Fixed, author-controlled: where the watcher runs. */
const SEAT = "software-factory watcher (runner-01)";

/** Fixed, author-controlled: the harness that runs a Forgejo Actions lane. */
export const ACTIONS_AGENT = "forgejo-actions";

/**
 * The seat of one Forgejo Actions lane, by its workflow name. The name is a
 * literal in the calling script, never a value read off a reply.
 */
export const actionsLaneSeat = traced(
	"github.actionsLaneSeat",
	function actionsLaneSeat(lane: string): string {
		return `software-factory lane ${lane}`;
	},
);

/** Arguments for {@link signatureLine}. */
export type SignatureLineArgs = {
	/**
	 * The attested model, when the caller genuinely has one in scope. TRUSTED
	 * VALUES ONLY — never runner-returned text, never a value read off a result
	 * document. Omitted or empty renders {@link UNATTESTED_MODEL}, which is what
	 * every current caller does.
	 */
	model?: string | null;
	/**
	 * The posting date. Defaults to now. Injected so a test can pin the rendered
	 * date to a literal instead of asserting against a clock it does not control.
	 */
	date?: Date;
	/**
	 * The authoring harness, when the caller is not the watcher: an Actions lane
	 * passes {@link ACTIONS_AGENT}. Fixed literals only. Blank falls back to the
	 * watcher.
	 */
	agent?: string;
	/**
	 * Where the author runs, when the caller is not the watcher: an Actions lane
	 * passes {@link actionsLaneSeat}. Fixed literals only. Blank falls back to
	 * the watcher's seat.
	 */
	seat?: string;
};

/**
 * Render the one attribution line every factory-authored forge body opens with.
 *
 * Shape (exact, and pinned by tests on all four surfaces):
 *
 *   `**agent:** rodaddy-watcher · model <model> · seat <seat> · <YYYY-MM-DD UTC>`
 *
 * The date is rendered in UTC, not local time: the watcher's timezone is an
 * implementation detail of one box, and a reader comparing two bodies posted
 * either side of a DST shift should not have to know it.
 */
export const signatureLine = traced(
	"github.signatureLine",
	function signatureLine(args: SignatureLineArgs = {}): string {
		const model =
			typeof args.model === "string" && args.model.trim() !== ""
				? args.model.trim()
				: UNATTESTED_MODEL;
		// `toISOString` is always UTC and always `YYYY-MM-DDTHH:mm:ss.sssZ`, so the
		// date half is a fixed 10-character slice — no formatter, no locale, no drift.
		const day = (args.date ?? new Date()).toISOString().slice(0, 10);
		const agent = args.agent?.trim() ? args.agent.trim() : AGENT;
		const seat = args.seat?.trim() ? args.seat.trim() : SEAT;
		return `**agent:** ${agent} · model ${model} · seat ${seat} · ${day} UTC`;
	},
);
