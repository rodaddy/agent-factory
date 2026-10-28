/**
 * @module packets/loader
 * @description Parse, validate, and load packet files (markdown + YAML
 *   frontmatter) at STARTUP. A packet is the agent's entire system prompt;
 *   the loader is the boundary that proves a packet is well-formed BEFORE the
 *   service boots — a malformed packet fails the BOOT with a named error, never a
 *   job. That is the whole point of loading at startup: a bad packet is a
 *   deploy-time defect an operator sees immediately, not a silent runtime failure
 *   a dispatched job discovers on a runner box.
 *
 *   Four validations run here: the frontmatter against `packetFrontmatterSchema`
 *   (typed contract), the declared `id`/`lane` against the packet's own name — so
 *   a packet can never be dispatched as a lane it does not name — the body against
 *   the fixed `PACKET_BODY_SECTIONS` — a missing section is a boot failure — and
 *   the whole body against `PACKET_SCAFFOLD_MARKER_PATTERN`, so an unfilled
 *   scaffold stub cannot boot no matter which heading it sits under. All four are
 *   in `parsePacket`, the SHARED parser, so the check, boot, and render paths
 *   cannot disagree about what a well-formed packet is (#185 review: the name
 *   binding used to live only in the boot walk, and `check:packets` was green on a
 *   packet the boot refused). Packet files are TRUSTED factory config
 *   (reviewed, receipt-gated), but a loader error still names only the packet and
 *   the fault; it NEVER echoes raw file content into a log or an error string,
 *   because an error message is not a place to leak a whole prompt.
 *
 *   The three-tier trust split is rendered structurally: tier-1 is the
 *   packet body, tier-2 is the declared caller-extras slot enforced against
 *   `accepts_extras`, and tier-3 is the untrusted target-repo task input confined
 *   to a delimited block. Ingest remains the real security boundary; the prompt
 *   structure observes the same split anyway.
 *
 * @outputs
 *   - `parsePacket` -- parse+validate one packet's raw text into a result union
 *   - `loadPackets` -- load+validate every packet in a directory (boot gate)
 *   - `LoadedPacket` -- a validated packet: frontmatter + fixed body sections
 *   - `ParsePacketResult` / `LoadPacketsResult` -- discriminated results
 *
 * @dependencies
 *   - yaml -- frontmatter parsing
 *   - ./schema -- the strict frontmatter schema and the fixed section list
 */
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { traced } from "../log";
import {
	PACKET_BODY_SECTIONS,
	PACKET_SCAFFOLD_MARKER,
	PACKET_SCAFFOLD_MARKER_PATTERN,
	type PacketBodySection,
	type PacketFrontmatter,
	packetFrontmatterSchema,
} from "./schema";

/** A validated packet: its typed frontmatter plus the text of each fixed section. */
export interface LoadedPacket {
	/** The typed, validated frontmatter contract. */
	frontmatter: PacketFrontmatter;
	/**
	 * The prose of each fixed section, keyed by heading. Trimmed of the heading
	 * line and surrounding blank lines; the fixed sections are guaranteed present
	 * because a missing one fails the parse.
	 */
	sections: Record<PacketBodySection, string>;
}

/** Discriminated result of parsing one packet: never throws for expected faults. */
export type ParsePacketResult = { ok: true; packet: LoadedPacket } | { ok: false; error: string };

/** Discriminated result of loading a packet directory: the boot gate reads this. */
export type LoadPacketsResult =
	| { ok: true; packets: Map<string, LoadedPacket> }
	| { ok: false; error: string };

/** Compact, path-qualified rendering of Zod issues for operator diagnostics. */
function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((i) => {
			const path = i.path.length > 0 ? i.path.join(".") : "(root)";
			return `${path}: ${i.message}`;
		})
		.join("; ");
}

/**
 * Split a packet file into its frontmatter block and body. The frontmatter is a
 * leading `---` fenced YAML block, exactly as the pilot packet writes it. Returns
 * a bounded named error naming only the packet — never the file content — when
 * the fence is missing or unterminated.
 */
function splitFrontmatter(
	raw: string,
	name: string,
): { ok: true; frontmatter: string; body: string } | { ok: false; error: string } {
	// Normalise CRLF so a Windows-authored packet splits identically.
	const text = raw.replace(/\r\n/g, "\n");
	if (!text.startsWith("---\n")) {
		return { ok: false, error: `packet ${name}: missing leading '---' frontmatter fence` };
	}
	const end = text.indexOf("\n---\n", 4);
	if (end === -1) {
		return { ok: false, error: `packet ${name}: unterminated frontmatter fence` };
	}
	return {
		ok: true,
		frontmatter: text.slice(4, end),
		body: text.slice(end + 5),
	};
}

/**
 * Extract every fixed section's prose from the body. Each section is an ATX
 * `# Heading` line whose text is one of `PACKET_BODY_SECTIONS`. A missing section
 * — or one that appears more than once — is a named error, so a well-formed
 * packet is the only thing that loads. The returned prose is the lines under the
 * heading up to the next heading, trimmed; it is never echoed into an error.
 */
function extractSections(
	body: string,
	name: string,
): { ok: true; sections: Record<PacketBodySection, string> } | { ok: false; error: string } {
	const lines = body.split("\n");
	// Map each fixed section heading to its line index, and record EVERY heading
	// line so a section's prose can run to the next heading (fixed or not).
	const headingAt = new Map<PacketBodySection, number>();
	const headingLines = new Set<number>();
	for (const [i, line] of lines.entries()) {
		const m = /^#\s+(.+?)\s*$/.exec(line);
		if (!m) {
			continue;
		}
		headingLines.add(i);
		const heading = m[1] as PacketBodySection;
		if ((PACKET_BODY_SECTIONS as readonly string[]).includes(heading)) {
			if (headingAt.has(heading)) {
				return { ok: false, error: `packet ${name}: duplicate '${heading}' section` };
			}
			headingAt.set(heading, i);
		}
	}
	for (const section of PACKET_BODY_SECTIONS) {
		if (!headingAt.has(section)) {
			return { ok: false, error: `packet ${name}: missing '${section}' section` };
		}
	}
	const sections = {} as Record<PacketBodySection, string>;
	for (const [section, start] of headingAt) {
		let end = lines.length;
		for (let i = start + 1; i < lines.length; i++) {
			if (headingLines.has(i)) {
				end = i;
				break;
			}
		}
		sections[section] = lines
			.slice(start + 1, end)
			.join("\n")
			.trim();
	}
	return { ok: true, sections };
}

/**
 * Parse and validate a single packet's raw text. Runs the boot checks: the
 * frontmatter against the strict typed schema, the declared `id`/`lane` against
 * the packet's own name, and the body against the fixed section list. Returns a
 * bounded named error — packet name plus the specific fault — and never throws
 * for an expected malformed packet.
 *
 * THE NAME BINDING LIVES HERE, not in `loadPackets`. It used to sit
 * in the loader's directory walk, which meant only the BOOT path enforced it: a
 * packet whose `id` disagreed with its filename passed `check:packets` and the
 * receipt gate, then failed the boot after merge, and a packet whose `lane`
 * disagreed passed EVERYTHING and loaded with a silently false lane — the lane a
 * packet declares is what the runtime/model route is reviewed against, so a false
 * one is a packet dispatching as a lane nobody reviewed it for. Binding both at
 * the shared parser closes the check, boot, and render paths in one place, because
 * every one of them arrives through `parsePacket`.
 *
 * @param raw - the packet file's raw text
 * @param name - the packet name this text must declare (its id/filename stem)
 */
export const parsePacket = traced(
	"packets.parsePacket",
	function parsePacket(raw: string, name: string): ParsePacketResult {
		const split = splitFrontmatter(raw, name);
		if (!split.ok) {
			return split;
		}

		let parsedFm: unknown;
		try {
			parsedFm = parseYaml(split.frontmatter);
		} catch (err) {
			// Only the yaml parser's own bounded message — never the frontmatter text.
			const reason = err instanceof Error ? err.message : "invalid YAML";
			return { ok: false, error: `packet ${name}: frontmatter is not valid YAML: ${reason}` };
		}

		const fm = packetFrontmatterSchema.safeParse(parsedFm);
		if (!fm.success) {
			return { ok: false, error: `packet ${name}: invalid frontmatter: ${formatIssues(fm.error)}` };
		}

		// The declared id and the packet's name must agree, so a packet cannot be
		// dispatched under a name its file does not carry.
		if (fm.data.id !== name) {
			return {
				ok: false,
				error: `packet ${name}: frontmatter id '${fm.data.id}' does not match filename`,
			};
		}
		// The declared lane must agree too. This is the one the boot gate never caught:
		// `PACKET_LANE_IDS` keys the registry by the FILENAME stem, so a packet whose
		// `lane` says something else loads green and renders as a lane it was never
		// reviewed for. Runtime, model, and effort are all reviewed against the lane.
		if (fm.data.lane !== name) {
			return {
				ok: false,
				error: `packet ${name}: frontmatter lane '${fm.data.lane}' does not match filename`,
			};
		}

		const sections = extractSections(split.body, name);
		if (!sections.ok) {
			return sections;
		}

		// An unfilled scaffold stub is a BOOT failure. `scripts/make-packet.ts` stamps
		// `PACKET_SCAFFOLD_MARKER` into every generated section precisely so generated
		// text CANNOT be dispatched as if it were authored intent — the packet is the
		// agent's whole system prompt, and a placeholder that reaches a runner is a
		// prompt nobody wrote.
		//
		// Scanned over the WHOLE body, not per-fixed-section, and against the tolerant
		// pattern rather than the literal string. Per-section substring matching had
		// two holes that are the same hole: a stub living under a NON-fixed heading
		// (which `extractSections` does not put in the section map at all) and a stub
		// whose marker was retyped by hand (`TODO[make_packet]`, lowercase, extra
		// space) both loaded green. Either one is a placeholder reaching a runner.
		// Naming the section (never its content) keeps the error bounded; when the
		// hit is outside every fixed section, the error says so at body level.
		const markerHit = PACKET_SCAFFOLD_MARKER_PATTERN.exec(split.body);
		if (markerHit) {
			const owning = PACKET_BODY_SECTIONS.find((section) =>
				PACKET_SCAFFOLD_MARKER_PATTERN.test(sections.sections[section]),
			);
			const where = owning ? `'${owning}' still carries` : "body still carries";
			return {
				ok: false,
				error: `packet ${name}: ${where} an unfilled ${PACKET_SCAFFOLD_MARKER} scaffold stub`,
			};
		}

		return { ok: true, packet: { frontmatter: fm.data, sections: sections.sections } };
	},
	// `raw` (arg 0) is a whole packet file and the RESULT carries its parsed
	// sections -- the agent's entire system prompt either way. This module's own
	// doc rule is that an error names the packet and the fault and NEVER echoes
	// file content; a debug trace is held to the same rule.
	{ redact: { args: [0], result: true } },
);

/**
 * Load and validate every `.md` packet in `dir` — the boot gate. A single
 * malformed packet fails the whole load with its named error, so the service
 * refuses to start rather than boot with a broken system prompt. The returned map
 * is keyed by packet id (which the loader also pins to the filename stem, so a
 * packet's id and filename cannot silently disagree).
 *
 * A missing or unreadable directory is itself a bounded named error, not a throw:
 * the caller decides whether packets are required for its configuration.
 *
 * @param dir - the packets directory (this repo's `packets/`)
 */
export const loadPackets = traced(
	"packets.loadPackets",
	async function loadPackets(dir: string): Promise<LoadPacketsResult> {
		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch (err) {
			const reason = err instanceof Error ? err.message : "unreadable";
			return { ok: false, error: `packets directory could not be read: ${dir}: ${reason}` };
		}

		const packets = new Map<string, LoadedPacket>();
		// Deterministic order so the FIRST malformed packet named is stable across runs.
		for (const entry of entries.filter((e) => extname(e) === ".md").sort()) {
			const stem = basename(entry, ".md");
			let raw: string;
			try {
				raw = await Bun.file(join(dir, entry)).text();
			} catch (err) {
				const reason = err instanceof Error ? err.message : "unreadable";
				return { ok: false, error: `packet ${stem}: file could not be read: ${reason}` };
			}
			// `parsePacket` binds the declared id AND lane to the stem it is handed, so
			// the boot path gets that enforcement from the shared parser rather than
			// re-implementing it here — which is what let the check and
			// render paths accept a packet the boot would refuse.
			const parsed = parsePacket(raw, stem);
			if (!parsed.ok) {
				return { ok: false, error: parsed.error };
			}
			packets.set(parsed.packet.frontmatter.id, parsed.packet);
		}

		return { ok: true, packets };
	},
	// The RESULT is every packet's parsed body -- the whole prompt surface.
	{ redact: { result: true } },
);
