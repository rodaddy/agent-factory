/**
 * @module actions/validate-inputs
 * @description Validate `workflow_dispatch` inputs before a workflow uses them
 *   (P3 input-validation decision). A trusted caller is not a validated
 *   value: every input builds a URL, a git ref or a status path downstream.
 *
 *   Usage (values arrive through `env:`, never `${{ }}` in `run:`):
 *     bun scripts/actions/validate-inputs.ts repo "$REPO" int "$PR" sha "$HEAD_SHA"
 *   Pairs of <kind> <value>; kinds: `repo` (owner/name), `int` (positive
 *   integer), `sha` (40 lowercase hex), `level` (`info` or `debug`),
 *   `verb` (one of `VERB_IDS`, the regex generated from that list),
 *   `label` (a DNS label, the verb's app) and `sha256` (64 lowercase hex).
 *   Exit 0 when all pass, 1 naming the first bad pair (by position and kind,
 *   never echoing the value), 2 on usage.
 *
 * @outputs
 *   - `validateInput` -- one (kind, value) check
 */
import { VERB_IDS } from "../../src/jobs/verb-dispatch";
import { traced } from "../../src/log";

const RULES: Readonly<Record<string, RegExp>> = {
	repo: /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}\/[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/,
	int: /^[1-9][0-9]{0,15}$/,
	sha: /^[0-9a-f]{40}$/,
	level: /^(info|debug)$/,
	// Generated from the one allowlist, so a seventh verb cannot drift in here.
	// Every id is [a-z-] only, so no regex escaping is needed.
	verb: new RegExp(`^(${VERB_IDS.join("|")})$`),
	label: /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/,
	sha256: /^[0-9a-f]{64}$/,
};

function validateInputImpl(kind: string, value: string): boolean {
	const rule = RULES[kind];
	return rule !== undefined && rule.test(value);
}

export const validateInput = traced("actions.validateInput", validateInputImpl);

if (import.meta.main) {
	const args = process.argv.slice(2);
	if (args.length === 0 || args.length % 2 !== 0) {
		process.stderr.write("usage: validate-inputs.ts <repo|int|sha|level> <value> [...]\n");
		process.exit(2);
	}
	for (let i = 0; i < args.length; i += 2) {
		const kind = args[i] ?? "";
		if (RULES[kind] === undefined) {
			process.stderr.write(`unknown kind at pair ${i / 2 + 1}\n`);
			process.exit(2);
		}
		if (!validateInput(kind, args[i + 1] ?? "")) {
			process.stderr.write(`input pair ${i / 2 + 1} is not a valid ${kind}\n`);
			process.exit(1);
		}
	}
	process.stdout.write("inputs ok\n");
}
