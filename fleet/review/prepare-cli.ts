#!/usr/bin/env bun
import { PreparationHold } from "./preparation-git.ts";
/** Compile this entrypoint to the root-protected review-prepare executable. */
import { prepareReview } from "./prepare.ts";

const [packet, bundle, output, extra] = process.argv.slice(2);
try {
	if (!packet || !bundle || !output || extra !== undefined) throw new PreparationHold("usage");
	const result = prepareReview(packet, bundle, output);
	process.stdout.write(`${JSON.stringify({ event: "review_prepare_completed", ...result })}\n`);
} catch (error) {
	process.stderr.write(
		`${JSON.stringify({ event: "review_prepare_hold", reason: error instanceof PreparationHold ? error.reason : "invalid_input" })}\n`,
	);
	process.exitCode = 2;
}
