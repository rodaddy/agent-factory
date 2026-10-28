/**
 * @module packets/schema
 * @description The typed contract carried by a packet's YAML frontmatter, and the
 *   fixed body sections every packet body MUST carry, validated by the loader at
 *   STARTUP (see `./loader`). A packet is the agent's ENTIRE system prompt — pi
 *   replaces its scaffold wholesale with the packet body — so a packet is
 *   factory-authored config in the same trust class as a job template (
 *   ratified 2026-08-01): reviewed in PRs, receipt-gated, deployed with the
 *   service. The frontmatter is the machine-checkable half of that contract; the
 *   body sections are the fixed shape a well-formed packet renders from.
 *
 *   The three-tier trust model is expressed structurally here even though
 *   ingest remains the real security boundary: tier-1 is the packet-owned body,
 *   tier-2 is the declared caller-extras slot (`accepts_extras`), and tier-3 is
 *   the untrusted target-repo task input, confined to a delimited block the body
 *   never treats as instructions.
 *
 * @outputs
 *   - `packetFrontmatterSchema` -- the strict Zod schema for a packet's frontmatter
 *   - `PacketFrontmatter` -- the validated frontmatter type
 *   - `PACKET_BODY_SECTIONS` -- the fixed section headings every body must carry
 *   - `PacketBodySection` -- one fixed section heading
 *
 * @dependencies
 *   - zod -- frontmatter boundary validation
 *   - ../runner/transport -- the runtime/effort unions a packet DECLARES
 */
import { z } from "zod";
import { RUNNER_EFFORTS, RUNNER_RUNTIMES } from "../runner/transport";

/**
 * The fixed body sections every packet renders, in order. A body missing
 * any one of these is a BOOT failure, not a job failure — a malformed packet must
 * never reach a runner. These are the ratified section headings from the #110
 * pilot packet (`pilot-hello.md`): Identity, Goals, Tools & How To Use Them,
 * Task Structure, Expected Output.
 */
export const PACKET_BODY_SECTIONS = [
	"Identity",
	"Goals",
	"Tools & How To Use Them",
	"Task Structure",
	"Expected Output",
] as const;

export type PacketBodySection = (typeof PACKET_BODY_SECTIONS)[number];

/**
 * The marker `scripts/make-packet.ts` stamps into every scaffolded section, and
 * which the loader REJECTS. A packet is the agent's entire system prompt,
 * so generated placeholder text must never be able to reach a runner wearing the
 * authority of authored intent: an unfilled stub is a BOOT failure with the same
 * force as a missing section.
 *
 * It is a distinctive fixed string rather than a bare `TODO` so a packet may
 * legitimately discuss the word "todo" in its prose without failing to boot.
 */
export const PACKET_SCAFFOLD_MARKER = "TODO(make-packet)" as const;

/**
 * The pattern the loader scans for. Deliberately WIDER than the literal
 * `PACKET_SCAFFOLD_MARKER` string, because a stub that is edited-but-not-authored
 * is exactly the shape that reaches a runner wearing authored authority: an
 * author who retypes the marker by hand, lowercases it, or swaps the parens for
 * brackets has still shipped a placeholder. The variants are tolerated on
 * DETECTION only — the scaffolder always emits the canonical literal.
 *
 * Matches `TODO(make-packet)`, `TODO(make_packet)`, `TODO[make-packet]`,
 * `todo (make-packet)`, and the spacing/case permutations of those. It does NOT
 * match a bare `TODO`, so a packet may still discuss the word in prose.
 *
 * ANCHORED TO LINE START (`^\s*` with `m`), because the widened pattern
 * otherwise bricks a packet that legitimately DOCUMENTS the marker: authored
 * prose quoting `TODO(make-packet)` mid-sentence, or a markdown link like
 * `todo [make-packet](…)`, was refused at boot with a misleading "unfilled
 * stub" error. The scaffolder emits every marker at the start of its own line,
 * so the anchor costs no detection — all the edited-but-not-authored variants
 * this pattern was widened for are still red.
 */
export const PACKET_SCAFFOLD_MARKER_PATTERN = /^\s*TODO\s*[([]make[-_]packet[)\]]/im;

/**
 * The declared caller-extras posture (tier-2). `none` locks the packet to
 * tier-1-only — the known CI/CD and k-board packets (issue-triage included)
 * declare this and reject any caller extras outright. `allowed` opens the
 * declared, delimited extras slot a trusted caller (a chain executor driving
 * packets as a workforce) may fill; when it does, the extras are recorded into
 * the job record so they stay auditable. Ingest validation remains the real
 * security boundary regardless.
 */
export const ACCEPTS_EXTRAS = ["none", "allowed"] as const;

/**
 * The typed frontmatter contract, zod-validated at load. `.strict()` so an
 * unknown frontmatter key fails the BOOT rather than being silently ignored —
 * a typo'd `accept_extras` must not read as the default. Every field is bounded.
 *
 * `output` is the result-schema reference (e.g. `pilot-result/v1`) the packet's
 * result binds to; it is carried as the declared contract and pinned to a real
 * result shape by the consuming lane, not resolved here (this ticket's only
 * consumer, issue-triage, binds to the existing watcher result substrate).
 */
export const packetFrontmatterSchema = z
	.object({
		/** The packet id, kebab-case; doubles as the packet filename stem. */
		id: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]*$/, "packet id must be kebab-case")
			.max(64),
		/** The packet contract version. A positive integer, bumped on shape change. */
		version: z.number().int().positive(),
		/** The lane the packet drives (e.g. `issue-triage`, `pilot`). Kebab-case. */
		lane: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]*$/, "lane must be kebab-case")
			.max(64),
		/**
		 * The runtime the lane dispatches under, DECLARED here rather than derived
		 * from the lane being packet-backed. Derivation made adding a
		 * lane id to `PACKET_LANE_IDS` silently swap that lane's runtime with no
		 * test going red; a declaration makes the runtime a reviewed, boot-validated
		 * property of the packet itself. The enum is the transport's own closed
		 * union, so the two can never drift.
		 */
		runtime: z.enum(RUNNER_RUNTIMES),
		/**
		 * The routed model id (e.g. `gpt-5.6-sol`). Bounded; never a command.
		 * Constrained to a model-id grammar — letters, digits, dot, underscore,
		 * hyphen — because the pi wrapper composes the route as
		 * `cliproxy/<model>:<effort>`: whitespace, `/`, or `:` inside the model id
		 * would silently corrupt that route rather than fail loudly.
		 */
		model: z
			.string()
			.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "model must be a bare model id")
			.max(120),
		/**
		 * The routed effort tier. The pi model pattern is `provider/id:effort`.
		 * Sourced from the transport's `RUNNER_EFFORTS` so the packet contract and
		 * the wire contract cannot drift in EITHER direction (#175 review: the
		 * duplicated literal enum only caught drift one way).
		 */
		effort: z.enum(RUNNER_EFFORTS),
		/** The declared tier-2 caller-extras posture. */
		accepts_extras: z.enum(ACCEPTS_EXTRAS),
		/** The result-schema reference the packet's result binds to. Bounded. */
		output: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]*\/v[0-9]+$/, "output must be a `name/vN` schema ref")
			.max(64),
	})
	.strict();

export type PacketFrontmatter = z.infer<typeof packetFrontmatterSchema>;
