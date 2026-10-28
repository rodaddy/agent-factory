/**
 * @module results/schema
 * @description Versioned, strict Zod schema for a runner's `result.json`. Runner
 *   output is untrusted (see _DOCS/architecture.md): this is the boundary that
 *   validates and bounds it before any state write or GitHub posting. Every
 *   string and array is length-capped so a malformed or oversized result is
 *   rejected rather than propagated. `result_version` is explicit so the shape
 *   can evolve without silently mis-reading old results.
 *
 * @outputs
 *   - `resultSchema` -- the strict, bounded result schema
 *   - `resultChangeSchema` -- the bounded implement-lane change claim
 *   - `resultTriageSchema` -- the bounded issue-triage label claim plus
 *     the acknowledgment fields it carries
 *   - `RunnerResult` / `ResultCheck` / `ResultFinding` / `ResultChange`
 *     / `ResultTriage` -- types
 *   - `RESULT_VERSION` -- the current result schema version
 *   - `SUPPORTED_RESULT_VERSIONS` -- every version still accepted
 *   - `MAX_RESULT_BYTES` -- the hard cap on a raw result document
 *
 * @dependencies
 *   - zod -- boundary validation
 */
import { z } from "zod";

/**
 * Current result schema version. Bump when the shape changes.
 *
 * v2 adds the OPTIONAL `change` block for the implement lane. It is a
 * purely additive change, so v1 stays ACCEPTED rather than being retired: every
 * report-only lane's fixed body still instructs the runner to emit
 * `result_version: 1` (see `src/prepush/body.ts`, `src/compat/body.ts`,
 * `src/infra/body.ts`), and those bodies are what deployed
 * runners already follow. Rejecting v1 here would break every existing lane the
 * moment this landed, for no gain — a v1 result is simply a v2 result with no
 * change block.
 */
export const RESULT_VERSION = 2 as const;

/** Every result version the watcher still accepts, newest first. */
export const SUPPORTED_RESULT_VERSIONS = [2, 1] as const;

/** Hard cap on a raw result.json document, before parsing. */
export const MAX_RESULT_BYTES = 256 * 1024;

/**
 * The only `job_type` whose result may carry a `change` block. Held here as the
 * wire contract rather than imported from `templates/registry`, so the accepted
 * result shape does not shift when the local template list is edited; the two
 * are pinned to each other by test.
 */
export const IMPLEMENT_JOB_TYPE = "implement-issue" as const;

/**
 * The deterministic k3s verb job types whose results may ALSO carry a `change`
 * block.
 *
 * A verb job renders a change for `rtech/k3s-deploy` and hands it back as a git
 * bundle for the same `change-ingest` gates the implement lane uses — path
 * confinement, bundle verification against the dispatched base, workflow-path
 * refusal. It is a change-producing lane, so its result has to be able to
 * declare one.
 *
 * The set stays a CLOSED ALLOWLIST rather than becoming "any job type": the
 * refine below is the boundary that stops a report-only lane presenting itself
 * as a proposal, and widening it to a predicate would retire that property.
 * Spelled literally rather than imported from `jobs/verb-dispatch` for the same
 * wire-contract reason `IMPLEMENT_JOB_TYPE` is — this is what a runner may SEND,
 * and it must not shift because the local template list was edited.
 * `tests/results/schema.test.ts` pins the two lists to each other.
 */
export const CHANGE_CAPABLE_VERB_JOB_TYPES = [
	"newroute",
	"newapp",
	"newdb",
	"newroute-down",
	"newapp-down",
	"newdb-down",
] as const;

/** Every job type whose result may declare a `change` block. */
export const CHANGE_CAPABLE_JOB_TYPES = [
	IMPLEMENT_JOB_TYPE,
	...CHANGE_CAPABLE_VERB_JOB_TYPES,
] as const;

/**
 * The only `job_type` whose result may carry a `triage` block. Held here
 * as the wire contract, like `IMPLEMENT_JOB_TYPE`, so the accepted result shape
 * does not drift when the local template list is edited; the two are pinned to
 * each other by test.
 */
export const TRIAGE_JOB_TYPE = "issue-triage" as const;

/** Bounded free-text field. */
const boundedText = (max: number) => z.string().max(max);

/** `owner/repo`, the only shape a repository field may take. */
const repoFullName = z
	.string()
	.regex(/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/, "must be in 'owner/repo' form");

/** One named check the runner performed, with a bounded outcome summary. */
export const resultCheckSchema = z
	.object({
		name: boundedText(120),
		status: z.enum(["pass", "fail", "skip", "error"]),
		summary: boundedText(2000).optional(),
	})
	.strict();

/** One bounded finding the runner surfaced. */
export const resultFindingSchema = z
	.object({
		severity: z.enum(["info", "low", "medium", "high", "critical"]),
		title: boundedText(200),
		detail: boundedText(4000).optional(),
		location: boundedText(400).optional(),
	})
	.strict();

/** A hex object id (short or full). Never a ref name, never a path. */
const hexSha = z.string().regex(/^[0-9a-f]{7,64}$/i, "must be a hex sha");

/**
 * The change a runner PROPOSES. Present only for the implement lane; every
 * report-only lane omits it entirely.
 *
 * This block is a CLAIM, not a fact. The runner is untrusted, so nothing here is
 * acted on until the ingest boundary independently verifies it: that the
 * bundle resolves inside the job's own output directory, that it applies onto
 * the exact `base_sha` the watcher dispatched, and that it touches no CI
 * workflow path. The fields are bounded here so a malformed or oversized claim
 * is rejected before any of that work begins.
 *
 * `bundle_path` (mode `patch`) and `branch` (mode `push`) are MUTUALLY
 * EXCLUSIVE: a result declaring both is ambiguous about where the change
 * actually lives, and the watcher must never have to guess which one to trust.
 */
export const resultChangeSchema = z
	.object({
		/**
		 * The commit the work started from. REQUIRED: without it the watcher
		 * cannot prove the change applies to what it dispatched, so a change
		 * lacking a base is unverifiable by construction.
		 */
		base_sha: hexSha,
		/** The produced commit, when the runner recorded one. */
		head_sha: hexSha.optional(),
		/**
		 * The git bundle's BARE FILENAME inside the job's own output directory
		 * (mode `patch`) — `changes.bundle` as the template pins it, never a
		 * path. Bounded here only; CONFINEMENT is enforced at ingest,
		 * where `confine()` accepts one segment (`/^[A-Za-z0-9._-]+$/`) and
		 * refuses anything carrying a directory separator. A bounded length is
		 * not a safe path, so this stays a wide string and the gate stays narrow.
		 */
		bundle_path: boundedText(1024).optional(),
		/**
		 * The branch the runner pushed (mode `push`). Recorded for correlation
		 * only: the watcher derives the branch name it trusts from its own `rw/`
		 * naming and never adopts this value as the ref it acts on.
		 */
		branch: boundedText(255).optional(),
		/** How many files the runner reports changing. Advisory, bounded. */
		files_changed: z.number().int().nonnegative().max(10_000).optional(),
	})
	.strict()
	// Structural presence, NOT truthiness. `Boolean("")` is false, so a truthiness
	// test reads `bundle_path: ""` as absent and accepts a change carrying BOTH
	// keys — the exact ambiguity about where the change lives that this refine
	// exists to prevent. An empty string is also not a usable path, so it is
	// refused rather than silently treated as omission.
	.refine(
		(c) =>
			(c.bundle_path === undefined) !== (c.branch === undefined) &&
			(c.bundle_path ?? c.branch ?? "").length > 0,
		{ message: "change must carry exactly one non-empty bundle_path or branch" },
	);

/**
 * The triage a runner PROPOSES. Present only for the issue-triage lane;
 * every other lane omits it entirely.
 *
 * This block is a CLAIM, not a fact. The runner is untrusted, so nothing here
 * becomes a forge mutation on its own word: `labels` is filtered FACTORY-SIDE
 * against the repository's config-declared triage allowlist at the publication
 * boundary — a name outside the allowlist yields NO label plan and instead
 * demotes to a structured request block inside the bounded comment. `requests`
 * is never a mutation at all: it is the runner asking a human to CREATE a label
 * the allowlist lacks, rendered into the comment and recorded here, never
 * applied. The classification/rationale the runner surfaces still rides in
 * `findings`; this block carries the label decisions plus the two acknowledgment
 * fields — `read` and `spec_gaps` — which are display-only and become no
 * mutation of any kind.
 *
 * The fields are bounded here so a malformed or oversized claim is rejected
 * before any publication work begins. `labels` are plain label names the runner
 * selected; the factory decides which of them are allowlisted. Duplicate or
 * non-allowlisted names are handled at the publication boundary, not rejected
 * here — this schema bounds shape and size, not policy.
 */
export const resultTriageSchema = z
	.object({
		/**
		 * The labels the runner chose to apply. Advisory and UNTRUSTED: the factory
		 * intersects these with the repository's config allowlist, so a name outside
		 * it never becomes a label plan. Bounded in count and per-name length.
		 */
		labels: z.array(boundedText(50)).max(50).optional(),
		/**
		 * Labels the runner REQUESTS the operator create because the allowlist lacks
		 * them and a known label plus comment would not capture the triage. Each is
		 * rendered as a bounded request line in the comment and recorded here; label
		 * CREATION stays human. `reason` is bounded free text.
		 */
		requests: z
			.array(
				z
					.object({
						name: boundedText(50),
						reason: boundedText(500).optional(),
					})
					.strict(),
			)
			.max(50)
			.optional(),
		/**
		 * The runner's one-line restatement of what it understood the ask to be.
		 * Rendered into the acknowledgment header as THE FACTORY'S READ —
		 * never as an assertion about the issue — because it is worker output and
		 * therefore PROPOSED. Bounded here and escaped inert at the publication
		 * boundary like every other runner string.
		 */
		read: boundedText(500).optional(),
		/**
		 * The parts of the implement lane's spec contract this issue does not supply
		 * — acceptance criteria, files, scope. REPORT ONLY: naming a gap
		 * blocks nothing, and the lane proceeds with what the issue has. Bounded in
		 * count and per-entry length so a pathological claim cannot fan out the
		 * comment.
		 */
		spec_gaps: z.array(boundedText(200)).max(10).optional(),
	})
	.strict();

/**
 * A single runner result. The runner reports the job it ran, an overall status,
 * per-check outcomes, bounded findings, and the path to its full output on the
 * share (never the output contents inline). An implement-lane result may also
 * declare the bounded `change` it proposes; an issue-triage result may declare
 * the bounded `triage` label decisions it proposes.
 */
export const resultSchema = z
	.object({
		// Accept every supported version, not just the newest: deployed runners
		// still emit v1 from the fixed report-only bodies (see RESULT_VERSION).
		// Bounded type-normalization of self-describing envelope fields only, never content fields.
		result_version: z.preprocess(
			(v) => (v === "1" ? 1 : v === "2" ? 2 : v),
			z.union([z.literal(2), z.literal(1)]),
		),
		repository: repoFullName,
		job_type: z.string().regex(/^[a-z0-9-]+$/, "job type must be kebab-case"),
		item_number: z.number().int().positive().optional(),
		sha: z
			.string()
			.regex(/^[0-9a-f]{7,64}$/i, "sha must be hex")
			.optional(),
		status: z.enum(["passed", "failed", "error", "skipped"]),
		checks: z.array(resultCheckSchema).max(100).default([]),
		findings: z.array(resultFindingSchema).max(500).default([]),
		/** Path to the full output artifact on the share (bounded, not contents). */
		output_path: boundedText(1024).optional(),
		/**
		 * The proposed change, for the implement lane only. Absent on every
		 * report-only lane, which is why a v1 result parses unchanged.
		 */
		change: resultChangeSchema.optional(),
		/**
		 * The proposed triage label decisions, for the issue-triage lane only.
		 * Absent on every other lane, which is why a result carrying no
		 * triage block parses unchanged.
		 */
		triage: resultTriageSchema.optional(),
	})
	.strict()
	// A change block is implement-lane-only, and the schema is the boundary that
	// says so. Without this a `result_version: 1`, `job_type: "pr-review"` result
	// can carry one and be ingested, letting a report-only job present itself as a
	// proposal — a lane the operator never dispatched producing a change the
	// operator never asked for.
	//
	// The template id is spelled literally rather than imported from
	// `templates/registry`: this is the wire contract for what a runner may send,
	// and it should not change shape because the local template list was edited.
	// `tests/results/schema.test.ts` pins the two to each other.
	.refine(
		(r) =>
			r.change === undefined ||
			(r.result_version === 2 &&
				(CHANGE_CAPABLE_JOB_TYPES as readonly string[]).includes(r.job_type)),
		{
			message: "a change block requires result_version 2 and a change-producing job type",
		},
	)
	// A triage block is issue-triage-lane-only, and the schema is the boundary that
	// says so. Without this a `pr-review` or `infra-static` result could carry one
	// and be ingested, letting a lane the operator dispatched for review present
	// label decisions the triage lane was never asked to make. Unlike the change
	// block, triage rides at the lane's own version (the issue-triage body emits
	// result_version 1), so only the job type is constrained here — not the
	// version. The literal is spelled rather than imported from
	// `templates/registry` for the same wire-contract reason `IMPLEMENT_JOB_TYPE`
	// is; `tests/results/schema.test.ts` pins the two together.
	.refine((r) => r.triage === undefined || r.job_type === TRIAGE_JOB_TYPE, {
		message: "a triage block requires the issue-triage job type",
	});

export type ResultCheck = z.infer<typeof resultCheckSchema>;
export type ResultFinding = z.infer<typeof resultFindingSchema>;
export type ResultChange = z.infer<typeof resultChangeSchema>;
export type ResultTriage = z.infer<typeof resultTriageSchema>;
export type RunnerResult = z.infer<typeof resultSchema>;
