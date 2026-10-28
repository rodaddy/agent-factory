/**
 * @module reconcile/doorbell
 * @description Optional identifiers-only event doorbell: a bounded seam that
 *   lets a trusted local sender request an *early* reconciliation pass instead
 *   of waiting for the next 15-minute tick. It carries identifiers only — a
 *   configured repository name and an optional issue/PR item number — and can
 *   never choose a job template, command, SHA, endpoint, output, status, label,
 *   or any arbitrary payload.
 *
 *   The doorbell does NOT run its own pass or dispatch: an accepted ring simply
 *   coalesces onto the existing authoritative single-flight scheduler via
 *   `trigger()`, which the 15-minute sweep also uses. Duplicate rings therefore
 *   collapse onto the in-flight pass. A rejected or failed ring is harmless: the
 *   periodic sweep remains authoritative and is never stopped or replaced.
 *
 * @outputs
 *   - `doorbellRequestSchema` -- strict identifiers-only Zod schema
 *   - `evaluateDoorbell` -- validate a request against configured repositories
 *   - `DoorbellRing` / `DoorbellDecision` -- validated request + accept/reject result
 *
 * @dependencies
 *   - zod -- strict boundary validation
 *   - ../config/schema -- the configured managed-repository list
 */
import { z } from "zod";
import type { WatcherConfig } from "../config/schema";
import { traced } from "../log";

/**
 * The only shape a doorbell request body may take: a managed repository name
 * and, optionally, a positive bounded item number. `.strict()` rejects any
 * extra field, so a sender cannot smuggle a template, SHA, command, or payload.
 */
export const doorbellRequestSchema = z
	.object({
		repository: z
			.string()
			.regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "must be in 'owner/repo' form"),
		// Optional item number. GitHub issue/PR numbers are positive integers;
		// cap to a sane bound so the field can never carry an unbounded value.
		item: z.number().int().positive().max(1_000_000).optional(),
	})
	.strict();

/** A validated, identifiers-only doorbell request. */
export type DoorbellRing = z.infer<typeof doorbellRequestSchema>;

/** Accept/reject outcome for a doorbell ring. `reason` is bounded and secret-free. */
export type DoorbellDecision =
	| { accepted: true; ring: DoorbellRing }
	| { accepted: false; reason: string };

/** Compact rendering of Zod issues, matching config/load's diagnostics style. */
function formatIssues(error: z.ZodError): string {
	return error.issues
		.map((i) => {
			const path = i.path.length > 0 ? i.path.join(".") : "(root)";
			return `${path}: ${i.message}`;
		})
		.join("; ");
}

/**
 * Validate an untrusted doorbell body against the identifiers-only schema and
 * the configured managed repositories. This is pure and never throws: malformed
 * bodies, unknown repositories, and out-of-range/extra fields all return a
 * bounded rejection. Acceptance means only "this identifier is safe to wake an
 * early pass" — it selects no job, template, command, or output.
 *
 * @param body - the parsed-but-untrusted request body
 * @param config - the loaded watcher configuration (source of the repo allowlist)
 */
export const evaluateDoorbell = traced(
	"reconcile.evaluateDoorbell",
	function evaluateDoorbell(body: unknown, config: WatcherConfig): DoorbellDecision {
		const parsed = doorbellRequestSchema.safeParse(body);
		if (!parsed.success) {
			return { accepted: false, reason: `invalid doorbell request: ${formatIssues(parsed.error)}` };
		}

		const ring = parsed.data;
		// The name is a GATE, not a routing key: acceptance only wakes the single
		// authoritative sweep, which reconciles every managed repository across BOTH
		// providers. So a name managed on GitHub and Forgejo alike is unambiguous here
		// — either match wakes the same pass and selects no provider-specific work.
		const known = config.repositories.some((r) => r.name === ring.repository);
		if (!known) {
			return { accepted: false, reason: "unknown repository" };
		}

		return { accepted: true, ring };
	},
	// Arg 0 is an UNTRUSTED request body straight off the doorbell endpoint. It is
	// identifiers-only by schema, but it is attacker-supplied and unvalidated at
	// `.enter` time, so it never reaches the trace verbatim.
	{ redact: { args: [0] } },
);
