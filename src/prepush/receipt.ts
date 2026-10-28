/**
 * @module prepush/receipt
 * @description The fixed repo-validate command contract the runner body
 *   (`./body.ts`) and the script runtime still render. The receipt FILE, its
 *   schema, store, and gate are retired (L-114): the full check runs
 *   once per head as the `factory/prepush` commit status.
 *
 * @outputs
 *   - `PREPUSH_TEMPLATE_ID` / `PREPUSH_COMMANDS` -- the fixed repo-validate job
 *   - `PREPUSH_RESULT_NAME` -- the author-owned result artifact filename
 */

export const PREPUSH_TEMPLATE_ID = "repo-validate" as const;
export const PREPUSH_COMMANDS = ["bun run check", "./specs/software-factory.verify.sh"] as const;

/**
 * The distinct, fixed artifact filename the pre-push job writes its
 * watcher-schema result to. It deliberately differs from the runner wrapper's
 * mechanical `result.json` envelope, which the wrapper owns and overwrites.
 * Fixed and author-controlled: never sourced from repository or config input.
 */
export const PREPUSH_RESULT_NAME = "validation-result.json" as const;
