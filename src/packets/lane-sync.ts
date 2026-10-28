/**
 * @module packets/lane-sync
 * @description The lane/packet drift check: `PACKET_LANE_IDS` (the lanes
 *   the service renders from a packet) and `packets/*.md` on disk must agree.
 *
 *   WHY THIS IS A CHECK AND NOT A BOOT GATE. `assertPacketsBootable` already
 *   fails the BOOT when a converted lane has no packet file — that is the
 *   safety property and it stays. But boot is the WRONG place to learn that a
 *   lane id and a filename drifted apart, because by then the change is merged
 *   and deployed. This check runs in `bun run check`, so drift is a red local
 *   command before the receipt gate ever sees the commit.
 *
 *   It is deliberately BIDIRECTIONAL. A lane with no file is the boot failure
 *   the gate already catches. A FILE with no lane is the one the boot gate
 *   cannot catch at all: `loadPackets` validates every `.md` in the directory
 *   and is perfectly happy with an extra one, so an orphan packet — a lane
 *   someone started converting and never wired into `PACKET_LANE_IDS` — boots
 *   green and never renders. That is a packet nobody dispatches sitting in the
 *   reviewed, receipt-gated config surface, which is exactly the kind of thing
 *   that gets read later as if it were live.
 *
 *   It also PARSES each packet file, because a name-only check is honest about
 *   the wrong thing: `ok packets/issue-triage.md` next to a file whose body still
 *   carries a scaffold stub is a green line about a packet that fails the boot.
 *   The content fault belongs in the same red command as the drift.
 *
 *   Reported as a `GateReport`: one check per lane, per file, and per
 *   file's content, with a note on the passing ones, so a green run says which
 *   lanes it matched rather than printing nothing.
 *
 * @outputs
 *   - `checkLanePacketSync` -- compare declared lanes against packet files
 *
 * @dependencies
 *   - ../gates/report -- the shared gate accumulator
 *   - ./loader -- `parsePacket`, the per-file content validation
 *   - ./registry -- `PACKET_LANE_IDS`, `packetsDir`
 */
import { readdir } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { GateReport } from "../gates/report";
import { traced } from "../log";
import { parsePacket } from "./loader";
import { PACKET_LANE_IDS, packetsDir } from "./registry";

/**
 * Record both file-direction checks for ONE packet file: that it is a declared
 * lane, and that its content parses.
 *
 * Extracted from `checkLanePacketSync` because wrapping that function in
 * `traced()` pushed it past the 50-line bound `lint:size` enforces. The bound is
 * pointing at something real — this loop body is its own idea ("judge one file")
 * and reads better named than inlined — so it is extracted rather than
 * suppressed. Behaviour is unchanged: the same two `report.check` calls, in the
 * same order, with the same keys.
 *
 * @param report - the accumulator both checks are recorded into
 * @param dir - the packets directory being judged
 * @param stem - the packet filename stem (no extension)
 * @param declared - the declared lane ids, for the membership check
 */
async function checkOnePacketFile(
	report: GateReport,
	dir: string,
	stem: string,
	declared: ReadonlySet<string>,
): Promise<void> {
	report.check(
		`file:${stem}.md`,
		declared.has(stem),
		declared.has(stem)
			? `packets/${stem}.md is the declared lane '${stem}'`
			: `packets/${stem}.md is not a declared lane — add '${stem}' to PACKET_LANE_IDS or remove the file; an orphan packet boots green and never renders`,
	);

	let raw: string;
	try {
		raw = await Bun.file(join(dir, `${stem}.md`)).text();
	} catch (err) {
		const reason = err instanceof Error ? err.message : "unreadable";
		report.check(`content:${stem}.md`, false, `packets/${stem}.md could not be read: ${reason}`);
		return;
	}
	const parsed = parsePacket(raw, stem);
	report.check(
		`content:${stem}.md`,
		parsed.ok,
		parsed.ok
			? `packets/${stem}.md parses: valid frontmatter and all fixed sections authored`
			: parsed.error,
	);
}

/**
 * Compare the declared packet lanes against the packet files on disk. Every
 * declared lane must have `<lane>.md`, and every `<name>.md` must be a declared
 * lane. Returns a `GateReport`; an unreadable directory is itself a recorded
 * failure rather than a throw, so the caller reports it like any other fault.
 *
 * @param dir - the packets directory (defaults to the repo's `packets/`)
 * @param laneIds - the declared lanes (defaults to `PACKET_LANE_IDS`)
 */
export const checkLanePacketSync = traced(
	"packets.checkLanePacketSync",
	async function checkLanePacketSync(
		dir: string = packetsDir(),
		laneIds: readonly string[] = PACKET_LANE_IDS,
	): Promise<GateReport> {
		const report = new GateReport();

		let entries: string[];
		try {
			entries = await readdir(dir);
		} catch (err) {
			const reason = err instanceof Error ? err.message : "unreadable";
			return report.check("packets_dir", false, `packets directory could not be read: ${reason}`);
		}

		const stems = new Set(
			entries.filter((e) => extname(e) === ".md").map((e) => basename(e, ".md")),
		);

		// Every declared lane needs its file. Checked for EVERY lane, not stopping at
		// the first miss, so one red run names all the drift.
		for (const lane of laneIds) {
			report.check(
				`lane:${lane}`,
				stems.has(lane),
				stems.has(lane)
					? `declared lane '${lane}' has packets/${lane}.md`
					: `declared lane '${lane}' has no packets/${lane}.md — add the file (scripts/make-packet.ts) or drop the lane from PACKET_LANE_IDS`,
			);
		}

		// Every file needs its lane — the direction the boot gate cannot see — and
		// every file must PARSE. A filename-only check reports `ok packets/x.md` for a
		// packet whose frontmatter is invalid or whose body still carries a scaffold
		// stub, so the one command an author runs before pushing says green about a
		// file that fails the boot. Parsing here moves that from a deploy-time failure
		// to a red local command, which is the whole reason this check exists.
		const declared = new Set(laneIds);
		// Sequential on purpose: the checks land in the report in filename order, so
		// a red run reads deterministically rather than in completion order.
		for (const stem of [...stems].sort()) {
			await checkOnePacketFile(report, dir, stem, declared);
		}

		return report;
	},
);
