/**
 * @module runner/bands
 * @description The runner box inventory: every VMID the fleet can place, with a
 *   STATED MAC and IP. This module is the seed data and the in-process resolver;
 *   `runner_boxes` in the database is the durable authority and is populated from
 *   here.
 *
 *   Addressing is NOT derived at use. The fleet's numbers happen to satisfy
 *   `NN = vmid % 100`, but that is how they were chosen, not how they are read:
 *   `9001` and `9101` both yield `NN=01`, so every consumer that recomputes an
 *   address has to correctly carry the band in the MAC's 4th octet (`90` vs `91`)
 *   AND apply the +100 IP offset for the forge band. A stated row cannot get that
 *   wrong. The one generator below runs ONCE, here, to write the rows down.
 *
 *   A VMID absent from the inventory is UNKNOWN, which is a loud rejection —
 *   never silently "not a box". Conflating those answers is what strands a
 *   running container nothing can name.
 *
 * @outputs
 *   - `RUNNER_BOXES` -- the full stated inventory, frozen
 *   - `lookupBox` / `isAllocatableVmid` -- resolve a VMID to its box
 *   - `BAND_CEILING` -- 99, the deliberate wall
 *
 * @dependencies
 *   - ../log -- the shared traced() wrapper on the exported resolvers
 */
import { traced } from "../log";

/** A single placeable box. `ip` is null only for templates, which never serve one. */
export interface RunnerBoxSpec {
	readonly vmid: number;
	readonly band: "pool" | "forge" | "template" | "service";
	readonly mac: string;
	readonly ip: string | null;
	readonly allocatable: boolean;
}

/**
 * Hard ceiling per band. A band may hold at most 99 boxes.
 *
 * This is a WALL, not a limit to engineer around: needing more than 99 boxes of
 * one kind means the workload has outgrown self-hosted Proxmox. Widening a band
 * into the next hundred-block would collide the MAC and IP schemes, which stay
 * distinguishable only because each band owns its own hundred.
 */
export const BAND_CEILING = 99;

/**
 * Write the stated rows for one contiguous band.
 *
 * Deliberately used ONLY at module load to produce the frozen inventory below. It
 * is not exported and nothing resolves an address through it at runtime — the
 * whole point of the table is that reads are literal.
 */
type StatedBandArgs = {
	band: RunnerBoxSpec["band"];
	vmidMin: number;
	vmidMax: number;
	macPrefix: string;
	ipPrefix: string | null;
	/** Added to `NN` for the address octet. 0 for the pool, 100 for the forge band. */
	ipOffset: number;
	allocatable: boolean;
};

function statedBand({
	band,
	vmidMin,
	vmidMax,
	macPrefix,
	ipPrefix,
	ipOffset,
	allocatable,
}: StatedBandArgs): RunnerBoxSpec[] {
	const count = vmidMax - vmidMin + 1;
	if (count > BAND_CEILING) {
		throw new Error(
			`band ${band} spans ${count} vmids (${vmidMin}-${vmidMax}), exceeding the ${BAND_CEILING} ceiling`,
		);
	}
	const rows: RunnerBoxSpec[] = [];
	for (let vmid = vmidMin; vmid <= vmidMax; vmid += 1) {
		const nn = vmid % 100;
		rows.push({
			vmid,
			band,
			mac: `${macPrefix}:${String(nn).padStart(2, "0")}`,
			ip: ipPrefix === null ? null : `${ipPrefix}.${nn + ipOffset}`,
			allocatable,
		});
	}
	return rows;
}

/**
 * The inventory, verified against the live fleet 2026-07-30.
 *
 * - service `9000` -> `10.0.21.0` -- the orchestrator; not spawned, not allocatable
 * - pool `9001-9050` -> `10.0.21.1-.50`, MAC `BC:24:11:90:00:NN` -- ephemeral, reaped
 * - forge `9101-9150` -> `10.0.21.101-.150`, MAC `BC:24:11:91:00:NN` -- persistent CI
 * - templates `9900-9950` -> no address, ever -- golden images
 *
 * Templates are PRESENT and flagged rather than omitted, so a template VMID
 * reports "template, not allocatable" instead of "unknown". `9900` is the base
 * golden image; `9901`/`9902` are per-host staged copies.
 */
export const RUNNER_BOXES: readonly RunnerBoxSpec[] = Object.freeze([
	{
		vmid: 9000,
		band: "service" as const,
		mac: "BC:24:11:90:00:00",
		ip: "10.0.21.0",
		allocatable: false,
	},
	...statedBand({
		band: "pool",
		vmidMin: 9001,
		vmidMax: 9050,
		macPrefix: "BC:24:11:90:00",
		ipPrefix: "10.0.21",
		ipOffset: 0,
		allocatable: true,
	}),
	// The Forgejo CI/CD runner fleet (an owner ruling, superseding
	// the sf#457 retire reading). Members are PERSISTENT: the scaling pass STARTS
	// and STOPS them, so they are never handed out as ephemeral pool slots and
	// `allocatable` is false for every row. The +100 IP offset is what keeps
	// 9101 (`.101`) apart from 9001 (`.1`) despite both reducing to NN=01.
	...statedBand({
		band: "forge",
		vmidMin: 9101,
		vmidMax: 9150,
		macPrefix: "BC:24:11:91:00",
		ipPrefix: "10.0.21",
		ipOffset: 100,
		allocatable: false,
	}),
	...statedBand({
		band: "template",
		vmidMin: 9900,
		vmidMax: 9950,
		macPrefix: "BC:24:11:99:00",
		ipPrefix: null,
		ipOffset: 0,
		allocatable: false,
	}),
]);

/** Index built once at load; a lookup is a map hit, never arithmetic. */
const BY_VMID: ReadonlyMap<number, RunnerBoxSpec> = new Map(
	RUNNER_BOXES.map((box) => [box.vmid, box]),
);

/**
 * Resolve a VMID to its box, or `undefined` when the inventory does not know it.
 *
 * `undefined` means UNKNOWN and callers must treat it as an error worth logging
 * with the id — it is never interchangeable with "there is no box".
 */
export const lookupBox = traced("runner.lookupBox", function lookupBox(vmid: number):
	| RunnerBoxSpec
	| undefined {
	if (!Number.isInteger(vmid)) {
		return undefined;
	}
	return BY_VMID.get(vmid);
});

/**
 * True only for a VMID the inventory knows AND marks allocatable. A template or
 * the service box is known but never allocatable.
 */
export const isAllocatableVmid = traced(
	"runner.isAllocatableVmid",
	function isAllocatableVmid(vmid: number): boolean {
		return lookupBox(vmid)?.allocatable === true;
	},
);
