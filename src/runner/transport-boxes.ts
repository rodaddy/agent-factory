/**
 * @module runner/transport-boxes
 * @description Box parsing for the runner-box verb output: the guarded JSON and
 *   line-form scans, the mcp2cli envelope unwrapping, and the VMID
 *   classification/reporting they share. Split out of `runner/transport.ts` as
 *   the parse region; the verb methods and the output classifiers stay there.
 *
 *   The guard the split preserves is #78: a VMID is surfaced as a box ONLY when
 *   the runner box inventory holds a row for it AND marks it allocatable. A
 *   labeled `vmid=` the inventory does not know is logged at ERROR, because it
 *   means the gateway placed a container this build cannot name or reap; a
 *   known-but-not-allocatable id (a template, the orchestrator) is the guard
 *   working and logs at debug. Bare numeric tokens are not reported at all —
 *   most are ports and octets, and logging them would be noise.
 *
 *   SURFACING IS NOT ALLOCATION, and {@link parseListedBoxes} inverts the guard's
 *   ACTION for exactly that reason. Everything above answers "may this
 *   vmid be handed out as a usable box", where an unknown id must be dropped. The
 *   `runner_list` parser answers a different question — "what is actually running
 *   out there" — and there the unknown id is the ANSWER. Dropping it would
 *   reproduce the unattributable-box harm #78 exists to end, reached from the
 *   surfacing side rather than the allocation side. So the rejection reporter
 *   still fires (the operator-visible ERROR is unchanged) and the box is
 *   RETURNED anyway. Reconcile must be able to NAME a box before anyone can act
 *   on it, and nothing downstream of a list may power a box off on its own.
 *
 * @outputs
 *   - `VmidRejection` / `classifyVmid` -- why a VMID was not surfaced
 *   - `parseBoxes` -- JSON boxes, or line-form boxes for non-JSON output
 *   - `parsePlacedBoxes` -- the boxes a REFUSED allocation had already powered on
 *   - `ListedBox` / `parseListedBoxes` -- the `runner_list` table
 *
 * @dependencies
 *   - ./bands -- the runner box inventory that decides allocatability
 *   - ../log -- structured logging for the rejection paths
 */
import { errorClass, log, traced } from "../log";
import { isAllocatableVmid, lookupBox } from "./bands";

/** One allocated runner box. */
export interface RunnerBox {
	vmid: number;
	host?: string;
	size: string;
}

/**
 * True when the inventory knows this VMID and marks it allocatable.
 *
 * A false answer is NOT interchangeable across its two causes, so callers must
 * use `classifyVmid` to distinguish them before deciding what to do. This
 * predicate exists only for the "should I surface this as a box" question.
 */
function isPoolVmid(vmid: number): boolean {
	return isAllocatableVmid(vmid);
}

/**
 * Why a VMID was not surfaced as an allocatable box. The distinction is the whole
 * point of #78: `unknown` means a container may be RUNNING that nothing can name,
 * which is an operator-visible defect, while `template`/`service` is the guard
 * working as designed.
 */
export type VmidRejection =
	| { kind: "allocatable" }
	| { kind: "unknown"; vmid: number }
	| { kind: "not-allocatable"; vmid: number; band: string };

/** Classify a VMID against the inventory so a rejection can be reported precisely. */
export const classifyVmid = traced(
	"runner.classifyVmid",
	function classifyVmid(vmid: number): VmidRejection {
		const box = lookupBox(vmid);
		if (!box) {
			return { kind: "unknown", vmid };
		}
		if (!box.allocatable) {
			return { kind: "not-allocatable", vmid, band: box.band };
		}
		return { kind: "allocatable" };
	},
);

/**
 * Log a VMID the fleet reported that we refuse to surface as a box.
 *
 * An UNKNOWN id is logged at error: the gateway placed something this build does
 * not recognise, so a container is likely running and unreapable — exactly the
 * silent-drop failure #78 exists to end. A known-but-not-allocatable id (a
 * template, the orchestrator) is the guard doing its job and logs at debug.
 */
function reportRejectedVmid(vmid: number, context: string): void {
	const verdict = classifyVmid(vmid);
	if (verdict.kind === "unknown") {
		log("error", `${context}: UNKNOWN vmid ${vmid} is absent from the runner box inventory`, {
			vmid,
			context,
			hint: "a box may be RUNNING and unattributable; check runner_list and reap by vmid",
		});
		return;
	}
	if (verdict.kind === "not-allocatable") {
		log("debug", `${context}: vmid ${vmid} is a ${verdict.band}, not an allocatable box`, {
			vmid,
			band: verdict.band,
			context,
		});
	}
}

/**
 * Parse JSON boxes, or line-form boxes only when the output is non-JSON.
 *
 * `stdout` (arg 0) is REDACTED from the trace: it is raw, untrusted stdout from
 * the credentialed gateway, and the same reasoning the `boxes_not_json` log line
 * already carries ("class only — raw mcp2cli stdout") applies to the trace. It is
 * a bare string, so `summarize()` has no key to mask on. `size` is not a secret.
 */
export const parseBoxes = traced(
	"runner.parseBoxes",
	function parseBoxes(stdout: string, size: string): RunnerBox[] {
		const trimmed = stdout.trim();
		if (!trimmed) {
			return [];
		}
		// Preferred: a JSON array/object of boxes. An explicit `vmid` field is trusted
		// only when the inventory marks it allocatable — the same guard the line
		// fallback applies — so a structured but non-allocatable id (e.g. the base
		// golden image 9900) can never be surfaced as a box. An id the inventory does
		// not know at all is LOGGED, because it means a container may be running that
		// nothing can name.
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			// The mcp2cli CLI wraps the verb module's real output in a JSON envelope:
			// `{"success":true,"result":{"ok":true,"stdout":"vmid=9921 host=...",...}}`.
			// The box line lives INSIDE `result.stdout` as a string, so the envelope is
			// unwrapped and its inner stdout parsed through the same guarded line form.
			// Valid JSON that is neither the envelope nor box objects yields NO boxes —
			// the raw JSON text is never line-scanned, so an embedded number in an
			// unrelated field can never be mistaken for a vmid.
			const inner = envelopeStdout(parsed);
			if (inner !== null) {
				return parseBoxLines(inner, size);
			}
			return parseBoxObjects(parsed, size);
		} catch (err) {
			// Line-form parsing exists only for non-JSON output, so a parse failure is the
			// expected route into the guarded line scan below, not a fault.
			// Class only — raw mcp2cli stdout; see error_payload_not_json above.
			log("debug", "runner.transport.boxes_not_json", { size, error_class: errorClass(err) });
		}
		return parseBoxLines(trimmed, size);
	},
	// Raw gateway stdout is untrusted and unkeyed; mask it rather than trace it.
	{ redact: { args: [0] } },
);

/**
 * Parse the object form: a box object, or an array of them. Each entry's explicit
 * `vmid` is surfaced only when the inventory marks it allocatable; anything else
 * is reported through the rejection classifier. Extracted from `parseBoxes`
 * purely to keep the nesting within the ceiling; the guard is unchanged.
 */
function parseBoxObjects(parsed: unknown, size: string): RunnerBox[] {
	const arr = Array.isArray(parsed) ? parsed : [parsed];
	const boxes: RunnerBox[] = [];
	for (const entry of arr) {
		if (!entry || typeof entry !== "object" || !("vmid" in entry)) {
			continue;
		}
		const vmid = Number((entry as { vmid: unknown }).vmid);
		if (isPoolVmid(vmid)) {
			const host = (entry as { host?: unknown }).host;
			boxes.push({ vmid, size, host: typeof host === "string" ? host : undefined });
		} else {
			reportRejectedVmid(vmid, "runner.transport.parse_boxes_json");
		}
	}
	return boxes;
}

/**
 * Parse the boxes a REFUSED allocation had already powered on (`placed`).
 *
 * A capacity refusal surfaces its partial `vmid=` lines inside the mcp2cli
 * envelope's inner `result.stdout`, and the envelope reports `ok:false`.
 * {@link parseBoxes} deliberately drops an `ok:false` envelope (a failed verb
 * result is never a valid box list for a SUCCESSFUL allocation), so the refusal
 * path must unwrap the inner stdout itself — via {@link unwrapEnvelopeStdout},
 * which ignores the inner `ok` flag — and only THEN apply the same guarded box
 * parsing. A bare (non-enveloped) refusal stdout is line-scanned unchanged. The
 * pool-range guard is preserved throughout, so an out-of-pool / template 9900
 * id is never surfaced as placed.
 *
 * `stdout` (arg 0) is REDACTED from the trace for the reason this function's own
 * catch arm already logs class-only: the refusal path is the likeliest to carry
 * an error string from the credentialed gateway.
 */
export const parsePlacedBoxes = traced(
	"runner.parsePlacedBoxes",
	function parsePlacedBoxes(stdout: string, size: string): RunnerBox[] {
		const trimmed = stdout.trim();
		if (!trimmed) {
			return [];
		}
		try {
			const inner = unwrapEnvelopeStdout(JSON.parse(trimmed) as unknown);
			if (inner !== null) {
				return parseBoxes(inner, size);
			}
		} catch (err) {
			// Not JSON: fall through to parse the bare stdout directly. A bare refusal
			// stdout is the normal non-enveloped shape, so this is not a fault.
			// Class only — the refusal path is the likeliest to carry an error string from
			// the credentialed gateway; see error_payload_not_json above.
			log("debug", "runner.transport.placed_not_json", { size, error_class: errorClass(err) });
		}
		return parseBoxes(trimmed, size);
	},
	// A capacity refusal's stdout can carry a credentialed-gateway error string.
	{ redact: { args: [0] } },
);

/**
 * The inner verb-module stdout of a successful mcp2cli envelope, or `null` when
 * the value is not a successful envelope carrying a string stdout. A failed
 * envelope (`success` false, or an inner `ok` false) yields `null`, so a
 * reported failure can never be mined for an incidental in-range number.
 */
function envelopeStdout(parsed: unknown): string | null {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const envelope = parsed as { success?: unknown; result?: unknown };
	if (envelope.success !== true || !envelope.result || typeof envelope.result !== "object") {
		return null;
	}
	const result = envelope.result as { ok?: unknown; stdout?: unknown };
	if (result.ok === false || typeof result.stdout !== "string") {
		return null;
	}
	return result.stdout;
}

/**
 * The inner verb-module stdout of an mcp2cli envelope REGARDLESS of the inner
 * `ok` flag, or `null` when the value is not such an envelope. Unlike
 * {@link envelopeStdout}, this does NOT reject an inner `ok:false` result: a
 * capacity refusal is reported as `ok:false` yet still carries its partial
 * `placed` `vmid=` lines inside `result.stdout`, and those boxes must be
 * mined so they can be reaped. It still requires the `success:true` envelope
 * shape and a string `stdout`. A bare (non-enveloped) stdout string is not an
 * envelope and is left for the caller to line-scan directly.
 */
function unwrapEnvelopeStdout(parsed: unknown): string | null {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return null;
	}
	const envelope = parsed as { success?: unknown; result?: unknown };
	if (envelope.success !== true || !envelope.result || typeof envelope.result !== "object") {
		return null;
	}
	const result = envelope.result as { stdout?: unknown };
	return typeof result.stdout === "string" ? result.stdout : null;
}

/**
 * One row of the `runner_list` table: a box the fleet reports as EXISTING, with
 * whatever attribution stamp it carries.
 *
 * Distinct from {@link RunnerBox}, which is a box this watcher was ALLOCATED and
 * may use. This one is an observation, carries no `size` (the verb does not
 * report one), and is deliberately reportable for a vmid the inventory does not
 * know.
 */
export interface ListedBox {
	vmid: number;
	/** `pct list` status, e.g. `running` / `stopped`. */
	status: string;
	/** Container name, e.g. `a fleet host`. */
	name: string;
	/** The attribution stamp's job id, or `null` when the column showed `-`. */
	jobId: string | null;
	/** The attribution stamp's spawn time, or `null` when the column showed `-`. */
	spawnIso: string | null;
	/** Forgejo task ids a kernel OOM kill hit in this forge slot; set only when non-empty. */
	oomTasks?: number[];
}

/** The verb prints `-` in a stamp column for a box that carries no stamp. */
const UNSTAMPED = "-";

/**
 * Parse the `runner_list` TEXT TABLE.
 *
 * The verb emits, per placement host, a `pct list` table with `JOB_ID` and
 * `SPAWN_ISO` appended, then prefixes EVERY line — header rows included — with
 * `[hostname] `. So the header repeats once per host rather than appearing once
 * at the top, and a parser that skips only a leading header surfaces a bogus
 * `VMID` row for the second host onward. Verified against a real read-only
 * capture (2026-08-17), which is the fixture `tests/runner/transport-list.test.ts`
 * pins.
 *
 * COLUMNS ARE READ FROM THE RIGHT, and that is the load-bearing decision.
 * `pct list` is FIXED-WIDTH with a frequently EMPTY `Lock` column — the verb's
 * own awk carries a comment saying positional `$1..$4` "silently shifts Name into
 * Lock on every unlocked box". Since the two stamp columns are APPENDED last and
 * neither can contain whitespace, the final two whitespace-separated tokens are
 * unambiguously `JOB_ID` and `SPAWN_ISO`, and the token before them is `Name`,
 * whether or not `Lock` was blank. Splitting left-to-right would read a running
 * (unlocked) box's job id as its name — and a running box is the only kind
 * reconcile cares about.
 *
 * The mcp2cli envelope is unwrapped exactly as {@link parseBoxes} does it, via
 * the same {@link envelopeStdout}, so a FAILED envelope yields no rows rather
 * than being mined for incidental numbers.
 *
 * THE #78 GUARD REPORTS BUT DOES NOT DROP. A vmid the inventory does not know is
 * still logged through {@link reportRejectedVmid} — the operator-visible ERROR is
 * unchanged — and is then RETURNED in the list anyway. Surfacing is not
 * allocation: reconcile exists to NAME a box nothing else can account for, so
 * withholding the unknown one defeats the purpose. Nothing downstream of this
 * function may power a box off; the operator
 * decides.
 */
export const parseListedBoxes = traced(
	"runner.parseListedBoxes",
	function parseListedBoxes(stdout: string): ListedBox[] {
		const trimmed = stdout.trim();
		if (!trimmed) {
			return [];
		}
		let table = trimmed;
		try {
			const inner = envelopeStdout(JSON.parse(trimmed) as unknown);
			// A well-formed but FAILED envelope yields null here, and returning [] is
			// correct: a verb that reported failure is not a box inventory.
			if (inner === null) {
				return [];
			}
			table = inner;
		} catch (err) {
			// Not JSON: the bare table form, which is parsed unchanged below. Expected,
			// not a fault. Class only — raw mcp2cli stdout; see `boxes_not_json`.
			log("debug", "runner.transport.list_not_json", { error_class: errorClass(err) });
		}
		const boxes: ListedBox[] = [];
		for (const raw of table.split("\n")) {
			const row = parseListedRow(raw);
			if (row) {
				boxes.push(row);
			}
		}
		return boxes;
	},
	// Raw `runner_list` stdout from the credentialed gateway; mask the input.
	{ redact: { args: [0] } },
);

/** One `[slot]` line of `runner_list {band:"forge"}`. */
const FORGE_SLOT_LINE = /^\[slot\]\s+vmid=(\d+)\b.*\bstatus=(absent|running|stopped|unknown)\b/;

/** The `oom_tasks=<id,...>` token on a forge slot line; may be empty. */
const OOM_TASKS = /\boom_tasks=([\d,]*)/;

/**
 * Parse the per-slot view of `runner_list {band:"forge"}`: one
 * `[slot] vmid=V [node=N] status=S lane=L` line per forge slot, printed alongside
 * the old per-host `pct list` table. Only this view lists `absent` slots, so a
 * caller prefers it and falls back to {@link parseListedBoxes} when it yields no
 * rows (an older gateway). The envelope is unwrapped like `parseListedBoxes`: a
 * FAILED envelope yields no rows. A slot carries no job stamp, so `jobId` and
 * `spawnIso` are `null`, and `name` follows the `CT<vmid>` convention.
 */
export const parseForgeSlots = traced(
	"runner.parseForgeSlots",
	function parseForgeSlots(stdout: string): ListedBox[] {
		let text = stdout.trim();
		try {
			const inner = envelopeStdout(JSON.parse(text) as unknown);
			if (inner === null) {
				return [];
			}
			text = inner;
		} catch (err) {
			// Not JSON: the bare verb stdout, scanned unchanged below. Class only.
			log("debug", "runner.transport.slots_not_json", { error_class: errorClass(err) });
		}
		const slots: ListedBox[] = [];
		for (const raw of text.split("\n")) {
			const match = FORGE_SLOT_LINE.exec(raw.trim());
			if (!match?.[1] || !match[2]) {
				continue;
			}
			const vmid = Number(match[1]);
			reportRejectedVmid(vmid, "runner.transport.parse_forge_slots");
			const slot: ListedBox = {
				vmid,
				status: match[2],
				name: `CT${vmid}`,
				jobId: null,
				spawnIso: null,
			};
			const oom = (OOM_TASKS.exec(raw)?.[1] ?? "").split(",").filter((id) => id !== "");
			if (oom.length > 0) slot.oomTasks = oom.map(Number);
			slots.push(slot);
		}
		return slots;
	},
	// Raw `runner_list` stdout from the credentialed gateway; mask the input.
	{ redact: { args: [0] } },
);

/**
 * Parse one prefixed table line into a {@link ListedBox}, or `null` for a header,
 * a blank line, or anything else that does not lead with a numeric VMID.
 *
 * Extracted so {@link parseListedBoxes} stays under the function ceiling; the
 * right-anchored column reasoning is documented on that function.
 */
function parseListedRow(raw: string): ListedBox | null {
	// Strip the per-host `[hostname] ` prefix the verb's trailing sed adds. Absent
	// on a hand-fed bare table, so it is optional rather than required.
	const line = raw.replace(/^\s*\[[^\]]*\]\s*/, "").trim();
	if (!line) {
		return null;
	}
	const fields = line.split(/\s+/);
	// The header row leads with the literal `VMID`, and it repeats once per host.
	// Requiring a numeric first field rejects it and any stray prose in one test.
	const vmid = Number(fields[0]);
	if (!Number.isInteger(vmid) || !/^\d+$/.test(fields[0] ?? "")) {
		return null;
	}
	// VMID, Status, [Lock], Name, JOB_ID, SPAWN_ISO -- at least 5 with Lock blank.
	if (fields.length < 5) {
		return null;
	}
	const spawnIso = fields[fields.length - 1] ?? UNSTAMPED;
	const jobId = fields[fields.length - 2] ?? UNSTAMPED;
	const name = fields[fields.length - 3] ?? "";
	const status = fields[1] ?? "";
	// Report an id the inventory cannot account for, then surface it ANYWAY: this
	// is the reconcile path, where an unnameable box is the finding rather than
	// something to hide. See the guard note on `parseListedBoxes`.
	reportRejectedVmid(vmid, "runner.transport.parse_listed_boxes");
	return {
		vmid,
		status,
		name,
		jobId: jobId === UNSTAMPED ? null : jobId,
		spawnIso: spawnIso === UNSTAMPED ? null : spawnIso,
	};
}

/**
 * Line-form box parsing. The line form is an unstructured heuristic, so every
 * candidate — whether `vmid`-labeled or a bare token — must be an allocatable box
 * in the inventory. That way a leading IP octet, a port, a year, a count, or the
 * non-allocatable base image 9900 is never mistaken for a box. A labeled token is
 * preferred; otherwise the first allocatable token is taken.
 *
 * A LABELED `vmid=` the inventory does not know is reported loudly: unlike a bare
 * token, the gateway explicitly said "this is a vmid", so failing to recognise it
 * means a real container was placed that this build cannot name or reap.
 * Bare tokens are NOT reported — most non-matching numbers on a line are ports and
 * octets, and logging those would be noise that trains operators to ignore it.
 *
 * A LABELED in-pool line anywhere in the text SUPPRESSES the bare-token fallback for
 * the whole text: the labeled line is the verb's contract, so surrounding chatter
 * (`pct destroy` output naming the same CT) must not be mined for boxes. The result
 * is deduped by vmid, first occurrence order preserved.
 */
function parseBoxLines(text: string, size: string): RunnerBox[] {
	const lines = text.split("\n");
	const labelOf = (line: string): number | null => {
		const m = line.match(/vmid[:=\s]+(\d{3,5})/i);
		return m?.[1] ? Number(m[1]) : null;
	};
	const hasLabeledPoolLine = lines.some((line) => {
		const v = labelOf(line);
		return v !== null && isPoolVmid(v);
	});
	const boxes: RunnerBox[] = [];
	const seen = new Set<number>();
	const take = (vmid: number): void => {
		if (seen.has(vmid)) {
			return;
		}
		seen.add(vmid);
		boxes.push({ vmid, size });
	};
	for (const line of lines) {
		const labeled = labelOf(line);
		if (labeled !== null && isPoolVmid(labeled)) {
			take(labeled);
			continue;
		}
		if (labeled !== null) {
			reportRejectedVmid(labeled, "runner.transport.parse_box_lines");
			continue;
		}
		if (hasLabeledPoolLine) {
			continue;
		}
		const pooled = [...line.matchAll(/\b(\d{4,5})\b/g)]
			.map((m) => Number(m[1]))
			.find((n) => isPoolVmid(n));
		if (pooled !== undefined) {
			take(pooled);
		}
	}
	return boxes;
}
