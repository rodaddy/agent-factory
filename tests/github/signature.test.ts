/**
 * @module tests/github/signature
 * @description The one attribution line every factory-authored forge body opens
 *   with. The watcher spelling is the default; a Forgejo Actions lane
 *   names itself through the `agent`/`seat` overrides, and the shell helper the
 *   shell-composed lanes call must render the SAME bytes as this function, or
 *   the lanes drift into two spellings — the #211 failure the helper exists to
 *   prevent.
 */
import { describe, expect, test } from "bun:test";
import {
	ACTIONS_AGENT,
	actionsLaneSeat,
	signatureLine,
	UNATTESTED_MODEL,
} from "../../src/github/signature";

const DATE = new Date("2026-01-02T12:34:56.000Z");
const HELPER = new URL("../../scripts/actions/signature-line.sh", import.meta.url).pathname;

function shellLine(lane: string, env: Record<string, string>): { out: string; code: number } {
	const run = Bun.spawnSync([HELPER, lane], {
		env: { PATH: process.env.PATH ?? "", ...env },
		stdout: "pipe",
		stderr: "pipe",
	});
	return { out: run.stdout.toString(), code: run.exitCode };
}

describe("signatureLine for a Forgejo Actions lane", () => {
	test("the watcher spelling is unchanged by default", () => {
		expect(signatureLine({ date: DATE })).toBe(
			"**agent:** rodaddy-watcher · model unattested · seat software-factory watcher (runner-01) · 2026-01-02 UTC",
		);
	});

	test("an Actions lane names its harness and its lane seat", () => {
		expect(
			signatureLine({
				agent: ACTIONS_AGENT,
				seat: actionsLaneSeat("pr-review"),
				model: "gpt-5.6-luna",
				date: DATE,
			}),
		).toBe(
			"**agent:** forgejo-actions · model gpt-5.6-luna · seat software-factory lane pr-review · 2026-01-02 UTC",
		);
	});

	test("a blank agent or seat override falls back to the fixed literal", () => {
		expect(signatureLine({ agent: "  ", seat: "", date: DATE })).toBe(
			signatureLine({ date: DATE }),
		);
	});
});

describe("scripts/actions/signature-line.sh renders the same bytes as signatureLine", () => {
	test("with a model in ENGINE_MODEL", () => {
		const { out, code } = shellLine("sop-verify", {
			SIGNATURE_DATE: "2026-01-02",
			ENGINE_MODEL: "gpt-5.6-luna",
		});
		expect(code).toBe(0);
		expect(out).toBe(
			`${signatureLine({ agent: ACTIONS_AGENT, seat: actionsLaneSeat("sop-verify"), model: "gpt-5.6-luna", date: DATE })}\n`,
		);
	});

	test("a whitespace-padded ENGINE_MODEL renders the same bytes as the function", () => {
		const { out, code } = shellLine("sop-verify", {
			SIGNATURE_DATE: "2026-01-02",
			ENGINE_MODEL: "  gpt-5.6-luna\t ",
		});
		expect(code).toBe(0);
		expect(out).toBe(
			`${signatureLine({ agent: ACTIONS_AGENT, seat: actionsLaneSeat("sop-verify"), model: "  gpt-5.6-luna\t ", date: DATE })}\n`,
		);
		expect(out).toContain("model gpt-5.6-luna · seat");
	});

	test("a whitespace-only ENGINE_MODEL renders unattested from both twins", () => {
		const { out, code } = shellLine("sop-verify", {
			SIGNATURE_DATE: "2026-01-02",
			ENGINE_MODEL: "   ",
		});
		expect(code).toBe(0);
		expect(out).toBe(
			`${signatureLine({ agent: ACTIONS_AGENT, seat: actionsLaneSeat("sop-verify"), model: "   ", date: DATE })}\n`,
		);
	});

	test("without a model the line says unattested, exactly as the function does", () => {
		const { out, code } = shellLine("site-publish", { SIGNATURE_DATE: "2026-01-02" });
		expect(code).toBe(0);
		expect(out).toContain(`model ${UNATTESTED_MODEL} `);
		expect(out).toBe(
			`${signatureLine({ agent: ACTIONS_AGENT, seat: actionsLaneSeat("site-publish"), date: DATE })}\n`,
		);
	});

	test("a missing lane name is refused, not rendered as an empty seat", () => {
		const run = Bun.spawnSync([HELPER], { stdout: "pipe", stderr: "pipe" });
		expect(run.exitCode).not.toBe(0);
		expect(run.stdout.toString()).toBe("");
	});
});
