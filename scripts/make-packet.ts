/**
 * @module scripts/make-packet
 * @description Scaffold `packets/<lane>.md` for a lane a human is adding.
 *
 *   Usage: `bun run scripts/make-packet.ts <lane-id> [--force]`
 *
 *   The generated file carries every frontmatter key and all five fixed body
 *   sections, so it is STRUCTURALLY complete the moment it lands — and it is
 *   deliberately schema-INVALID until an author edits it. Two independent
 *   refusals hold that: every section is stamped with the scaffold marker the
 *   loader rejects, and `runtime:` holds the marker rather than a runtime, which
 *   the frontmatter enum refuses by name. So the file is the right shape
 *   immediately and provably not yet a prompt: a fresh scaffold is a named boot
 *   failure, never placeholder prose a runner reads as its system prompt.
 *   Choosing the runtime is the FIRST edit the authoring cookbook asks for.
 *
 *   It REFUSES to overwrite an existing packet unless `--force` — a packet is a
 *   reviewed, receipt-gated config artifact, and silently replacing an authored
 *   prompt with a stub is the one way this script could do real damage. For a
 *   lane already in `PACKET_LANE_IDS` the refusal is UNCONDITIONAL: `--force`
 *   covers a half-written stub, never a live dispatch target's system prompt.
 *
 *   It does NOT wire the lane into `PACKET_LANE_IDS`. Lanes are a fixed reviewed
 *   allowlist; a scaffolder that invents lanes would be a regression. Adding the
 *   id is the human's edit in the same PR, and `bun run check` fails until both
 *   halves agree (`scripts/check-lane-packets.ts`).
 *
 * @outputs
 *   - (side effect) `packets/<lane>.md` -- the scaffolded packet
 *   - exit 0 on write; exit 1 on a bad lane id, an existing file, or an I/O fault
 */
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { PACKET_LANE_IDS, packetsDir } from "../src/packets/registry";
import { renderPacketScaffold } from "../src/packets/scaffold";

/** The lane-id shape the frontmatter schema enforces; checked here so a bad id fails before any write. */
const LANE_ID = /^[a-z0-9][a-z0-9-]*$/;

const USAGE = "usage: bun run scripts/make-packet.ts <lane-id> [--force]";

/**
 * Author-owned override for the output directory, so the WRITE path is testable
 * without scaffolding into the repo's real `packets/`. Never carries a
 * repository- or config-selected value: this is a developer/test env var read
 * only by this script, and the service never invokes it.
 */
const OUT_DIR_ENV = "MAKE_PACKET_OUT_DIR" as const;

/** The directory the scaffold is written to: the repo's `packets/` unless overridden. */
function outDir(): string {
	const override = process.env[OUT_DIR_ENV]?.trim();
	return override && override.length > 0 ? override : packetsDir();
}

function fail(message: string): never {
	console.error(`make-packet: ${message}`);
	process.exit(1);
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	if (args.includes("--help") || args.includes("-h")) {
		console.log(USAGE);
		console.log("  <lane-id>  kebab-case lane id; doubles as the packet id and filename");
		console.log("  --force    replace an existing packet file with a fresh stub");
		console.log("A lane already in PACKET_LANE_IDS is never scaffolded over, --force included.");
		return;
	}

	const force = args.includes("--force");
	const positional = args.filter((a) => a !== "--force");
	const [laneId] = positional;

	if (laneId === undefined) {
		fail(USAGE);
	}
	// Extra positionals are a named refusal, not a silent ignore: `make-packet a b`
	// previously wrote `a.md` and dropped `b` without a word, which reads to the
	// caller as both lanes having been scaffolded.
	if (positional.length > 1) {
		fail(
			`expected exactly one lane id, got ${positional.length} (${positional.join(", ")}); ${USAGE}`,
		);
	}
	if (!LANE_ID.test(laneId) || laneId.length > 64) {
		fail(`lane id '${laneId}' must be kebab-case and at most 64 characters`);
	}

	// A DECLARED lane is never scaffolded over, and --force does not open this
	// door. `--force` exists to replace a half-written stub; a lane already in
	// PACKET_LANE_IDS is a live dispatch target, so overwriting its packet
	// replaces a running agent's entire system prompt with placeholder text that
	// the loader then refuses — turning one careless argument into a boot failure
	// for a lane the operator never meant to touch. Deleting the packet by hand is
	// the deliberate act that re-opens it.
	if ((PACKET_LANE_IDS as readonly string[]).includes(laneId)) {
		fail(
			`lane '${laneId}' is a declared PACKET_LANE_IDS lane; refusing to scaffold over a live lane's packet even with --force (remove packets/${laneId}.md by hand if you really mean to re-scaffold it)`,
		);
	}

	const target = join(outDir(), `${laneId}.md`);
	if (existsSync(target) && !force) {
		fail(
			`packets/${laneId}.md already exists; refusing to overwrite an authored packet (pass --force to replace it with a stub)`,
		);
	}

	try {
		await writeFile(target, renderPacketScaffold(laneId), "utf8");
	} catch (err) {
		fail(err instanceof Error ? err.message : "packet could not be written");
	}

	// The written path, not a hardcoded `packets/`: under MAKE_PACKET_OUT_DIR the
	// old message named a file the run never wrote.
	console.log(`make-packet: wrote ${target}`);
	console.log("make-packet: it will NOT boot until every TODO(make-packet) stub is replaced, and");
	console.log(`make-packet: '${laneId}' is added to PACKET_LANE_IDS in src/packets/registry.ts.`);
}

await main();
