/**
 * @module control-surface/boundary
 * @description The BACKEND-AGNOSTIC control-surface contract.
 *   This is deliberately NOT the existing `forge/boundary` `ForgeClient`, and the
 *   distinction is the whole content of the clause. `ForgeClient` is a TRANSPORT
 *   seam: `write("POST", "/repos/o/r/issues/1/labels", ...)` leaves the endpoint,
 *   the verb, and the payload shape at the CALL SITE, so swapping GitHub for
 *   Forgejo would mean editing every caller — precisely what "no host-specific
 *   calls scattered through job logic" forbids.
 *
 *   A `ControlSurface` operation is SEMANTIC: its signature contains no URL, no
 *   REST verb, and no GraphQL document, only `{ repository, item }` and label
 *   names. The same call is therefore correct against GitHub REST, Project 11
 *   GraphQL, and a Forgejo backend later, without the caller knowing which one
 *   answered. Job logic depends on this file; only the backend implementations
 *   depend on a host.
 *
 *   `proposeLabelWrite` is named PROPOSE rather than `setLabels` on purpose. In
 *   dry-run mode it must be able to return an unapplied intent, and the return
 *   type carries `applied` so a caller can never mistake a proposal for a
 *   mutation. k-board remains the work-state authority: this surface reads
 *   labels/columns and proposes, it does not own state.
 *
 * @outputs
 *   - `ControlSurfaceRef` -- the semantic {repository, item} address
 *   - `LabelWriteProposal` / `LabelWriteResult` -- the propose-a-write seam
 *   - `ControlSurface` -- the three named semantic operations
 *
 * @dependencies
 *   - (none) -- a pure contract over plain data
 */

/**
 * The semantic address of a control-surface item. This is the ENTIRE host
 * vocabulary a caller supplies: an `owner/repo` string and an item number. No
 * endpoint, no node id, no GraphQL document — translating this into whatever the
 * backend needs is the backend's job.
 */
export interface ControlSurfaceRef {
	/** `owner/repo`, as it appears in the watcher's own config. */
	readonly repository: string;
	/** The issue or pull-request number. */
	readonly item: number;
}

/**
 * A proposed label mutation. Both lists are optional so a caller can add without
 * removing; an empty proposal is valid and resolves to a no-op intent.
 */
export interface LabelWriteProposal extends ControlSurfaceRef {
	readonly addLabels?: readonly string[];
	readonly removeLabels?: readonly string[];
}

/**
 * The outcome of a proposed label write. `applied: false` means the intent was
 * recorded and NOTHING was mutated — the dry-run contract. `intent` is a bounded
 * human-readable summary safe to log.
 */
export interface LabelWriteResult {
	readonly applied: boolean;
	readonly intent: string;
	/** Present only when a real write failed; bounded and secret-free. */
	readonly error?: string;
}

/**
 * The three NAMED semantic operations that make the surface backend-agnostic.
 * Every argument is semantic; no implementation detail of any host appears here.
 */
export interface ControlSurface {
	/** The labels currently on the item. */
	readLabels(ref: ControlSurfaceRef): Promise<string[]>;
	/** The board column the item sits in, or null when it is on no board. */
	readColumn(ref: ControlSurfaceRef): Promise<string | null>;
	/** Record a label-write INTENT; applies it only outside dry run. */
	proposeLabelWrite(proposal: LabelWriteProposal): Promise<LabelWriteResult>;
}
