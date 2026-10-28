/**
 * @module packets/registry
 * @description The packet-backed job-body registry: it resolves the repo's
 *   `packets/` directory, validates every packet at STARTUP (the boot gate), and
 *   renders a job body from a validated packet for the lanes that have converted
 *   off their TS template literal. Today the ONE converted lane is `issue-triage`;
 *  every other lane still renders from `templates/registry`.
 *
 *   Two paths reach a packet, and they agree by construction:
 *   - `assertPacketsBootable` is the BOOT gate `composeService` awaits. It loads
 *     and validates EVERY packet in the directory, failing the boot with a named
 *     error on the first malformed one — a bad packet is a deploy-time defect an
 *     operator sees at startup, never a job discovers on a runner.
 *   - `renderPacketJobBody` is the synchronous render path `renderJobBody` calls.
 *     It reads and validates the ONE requested packet from the same directory,
 *     memoised. Because the boot gate already validated the whole directory, a
 *     packet reaching this path in a booted service is known-good; the per-render
 *     validation is defence-in-depth and what keeps the render path pure and
 *     directly unit-testable without booting the service.
 *
 *   The directory is resolved from THIS module's location, not the process cwd,
 *   so a job renders the same packet whether the service runs from the repo root,
 *   a test runner, or a deployed checkout.
 *
 * @outputs
 *   - `assertPacketsBootable` -- the async boot gate: validate every packet
 *   - `renderPacketJobBody` -- sync render of one packet's job body
 *   - `packetsDir` -- resolve the `packets/` directory from the module location
 *   - `PACKET_LANE_IDS` -- the lanes that render from a packet (converted lanes)
 *
 * @dependencies
 *   - ./loader -- parse+validate one packet, and load a whole directory
 *   - ./render -- assemble a job body from a validated packet
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { traced } from "../log";
import { type LoadedPacket, loadPackets, parsePacket } from "./loader";
import { type RenderPacketContext, type RenderPacketResult, renderPacketBody } from "./render";

/**
 * The lanes whose job body renders from a packet. Exactly `issue-triage`
 * today; converting pr-review/implement is GATED on #113 per the ratified #108
 * sequencing and is a NON-GOAL here. A lane not in this set renders from
 * `templates/registry` as before.
 */
export const PACKET_LANE_IDS = ["issue-triage"] as const;

export type PacketLaneId = (typeof PACKET_LANE_IDS)[number];

/**
 * True when a lane renders its job body from a packet rather than a TS literal.
 *
 * `traced()` returns a plain `(...args) => R`, which erases the `jobType is
 * PacketLaneId` predicate a wrapped function cannot carry. The predicate is what
 * lets a caller narrow, so it is restated on the exported binding's type rather
 * than lost — the wrapper observes the call, it does not get to weaken the
 * contract.
 */
export const isPacketLane: (jobType: string) => jobType is PacketLaneId = traced(
	"packets.isPacketLane",
	function isPacketLane(jobType: string): boolean {
		return (PACKET_LANE_IDS as readonly string[]).includes(jobType);
	},
) as (jobType: string) => jobType is PacketLaneId;

/**
 * Resolve the `packets/` directory from THIS module's location — `src/packets/` →
 * repo root → `packets/`. Independent of the process cwd so the same packet loads
 * whether the service runs from the repo root, a test, or a deployed checkout.
 */
export const packetsDir = traced("packets.packetsDir", function packetsDir(): string {
	const here = dirname(fileURLToPath(import.meta.url));
	// here == <root>/src/packets → up two → <root>, then `packets/`.
	return join(here, "..", "..", "packets");
});

/**
 * The async BOOT gate. Load and validate EVERY packet in the directory; on the
 * first malformed one, return a named error the caller turns into a boot failure.
 * Called by `composeService` so a bad packet fails startup, not a dispatched job.
 * A missing directory is a named failure too — the caller decides whether packets
 * are required for its configuration (they are for a factory that dispatches
 * packet lanes).
 */
export const assertPacketsBootable = traced(
	"packets.assertPacketsBootable",
	async function assertPacketsBootable(
		dir: string = packetsDir(),
	): Promise<{ ok: true } | { ok: false; error: string }> {
		const loaded = await loadPackets(dir);
		if (!loaded.ok) {
			return { ok: false, error: loaded.error };
		}
		// Every converted lane MUST have a packet: a lane that renders from a packet
		// with no packet on disk would fall through to a runtime failure at dispatch.
		// Catch it at boot instead.
		for (const lane of PACKET_LANE_IDS) {
			if (!loaded.packets.has(lane)) {
				return { ok: false, error: `packet ${lane}: required packet missing from ${dir}` };
			}
		}
		// SEED the render cache with the packets this gate just validated, so a booted
		// service never re-reads a packet from disk: without this, the first render is
		// a cache miss that re-reads the file, and a packet corrupted AFTER a green
		// boot would fault at dispatch time instead of never. With the seed, the boot
		// gate's validated bytes are the ONLY bytes a booted service ever renders.
		// (A caller pointing this gate at a fixture directory seeds those fixtures for
		// converted-lane ids — fine for the render-cache tests that do it on purpose,
		// and production only ever calls it on the real `packets/` dir.)
		for (const lane of PACKET_LANE_IDS) {
			const packet = loaded.packets.get(lane);
			if (packet) {
				cache.set(lane, packet);
			}
		}
		return { ok: true };
	},
);

/**
 * Test-only: clear the memoised render cache. Cache-behavior tests (miss-then-
 * seeded) need a known-empty starting state to be order-independent — without
 * this, an earlier test's render would pre-populate the cache and a seeding test
 * could never observe the miss path (a test that cannot fail proves nothing).
 */
export const resetPacketRenderCacheForTests = traced(
	"packets.resetPacketRenderCacheForTests",
	function resetPacketRenderCacheForTests(): void {
		cache.clear();
	},
);

/** The memoised per-packet parse cache for the synchronous render path. */
const cache = new Map<string, LoadedPacket>();

/**
 * Synchronously render one converted lane's job body from its packet. Reads and
 * validates the packet from the resolved directory (memoised), then assembles the
 * body from the dynamic context via `renderPacketBody`. Returns a discriminated
 * result: a missing/malformed packet or a tier-2 extras violation is a named
 * failure, never a throw — the caller (`renderJobBody`) maps a failure to a
 * skipped dispatch, exactly as an unknown job type is.
 *
 * The per-render read+validate is defence-in-depth: `assertPacketsBootable`
 * already validated the whole directory at boot, so a packet reaching here in a
 * booted service is known-good. Keeping the validation here too is what makes the
 * render path directly unit-testable without a boot.
 */
export const renderPacketJobBody = traced(
	"packets.renderPacketJobBody",
	function renderPacketJobBody(
		jobType: PacketLaneId,
		ctx: RenderPacketContext,
		dir: string = packetsDir(),
	): RenderPacketResult {
		let packet = cache.get(jobType);
		if (!packet) {
			let raw: string;
			try {
				raw = readFileSync(join(dir, `${jobType}.md`), "utf8");
			} catch (err) {
				const reason = err instanceof Error ? err.message : "unreadable";
				return { ok: false, error: `packet ${jobType}: file could not be read: ${reason}` };
			}
			const parsed = parsePacket(raw, jobType);
			if (!parsed.ok) {
				return { ok: false, error: parsed.error };
			}
			if (parsed.packet.frontmatter.id !== jobType) {
				return {
					ok: false,
					error: `packet ${jobType}: frontmatter id '${parsed.packet.frontmatter.id}' does not match lane`,
				};
			}
			packet = parsed.packet;
			cache.set(jobType, packet);
		}
		return renderPacketBody(packet, ctx);
	},
	// The RESULT is a rendered job body -- the agent's entire system prompt. A
	// debug trace is not the place to reproduce it, and `ctx` (arg 1) carries the
	// caller's dynamic context into that same body.
	{ redact: { args: [1], result: true } },
);
