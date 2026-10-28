/**
 * @module config/factory-yml
 * @description The `static:` section of a TARGET repo's `factory.yml` (
 *   827c; asked for in sf#608): which of the four fixed infra-static gates the
 *   repo runs, and which of its own lintrc files each tool reads. Read from git
 *   OBJECTS in the trusted `pending` job (`git ls-tree` for the mode, then
 *   `git show` for the text), never from a checkout and never from an input
 *   string: no target file is ever materialised in the trusted job. An absent
 *   file is the default policy (all four gates, no lintrc); a present file that
 *   is not a regular blob (mode 100644: a symlink is 120000) or is invalid is a
 *   refusal naming the field, never a silent default. Unknown keys under
 *   `static:` are rejected; other top-level keys belong to other readers.
 *
 *   Lintrc paths reach a rendered shell command, so beyond the stated rules
 *   (repo-relative, no `..`, no leading `/` or `-`, no NUL, at most 200 chars)
 *   they are held to a fixed shell-inert charset. A refusal names the field
 *   through a sanitized path ([A-Za-z0-9._-], 64 chars) and a fixed message:
 *   no byte of the target's own key names or zod's message text is echoed.
 *
 * @outputs
 *   - `readFactoryStaticPolicy` -- ls-tree mode + show text -> the static policy or a refusal
 *   - `FactoryStaticPolicy` / `FactoryStaticPolicyResult` / `PolicyBlob` -- the types
 *   - `LINTRC_KEYS` -- the four per-tool lintrc keys
 *
 * @dependencies
 *   - yaml, zod -- parse and validate at the boundary
 *   - ../infra/gates -- the fixed gate ids
 */
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { type GateId, STATIC_GATES } from "../infra/gates";
import { traced } from "../log";

/** The four per-tool lintrc keys a policy may set. */
export const LINTRC_KEYS = [
	"ansible_lint_config",
	"yamllint_config",
	"shellcheck_rc",
	"actionlint_config",
] as const;

export type LintrcKey = (typeof LINTRC_KEYS)[number];

/** The policy file is small by construction; anything larger is refused. */
const POLICY_MAX_BYTES = 16384;

/** The only git mode a policy or lintrc file may have: a regular, non-executable blob. */
export const REGULAR_BLOB_MODE = "100644";

const lintrcPath = z
	.string()
	.min(1)
	.max(200)
	.refine((p) => !p.includes("\0"), "must not contain NUL")
	.refine((p) => !p.startsWith("/"), "must be repo-relative")
	.refine((p) => !p.startsWith("-"), "must not start with -")
	.refine((p) => !p.split("/").includes(".."), "must not contain ..")
	.refine((p) => /^[A-Za-z0-9._/-]+$/.test(p), "must use only [A-Za-z0-9._/-]");

const staticSchema = z
	.object({
		gates: z
			.array(z.enum(STATIC_GATES))
			.min(1)
			.refine((g) => new Set(g).size === g.length, "must not repeat a gate")
			.optional(),
		ansible_lint_config: lintrcPath.optional(),
		yamllint_config: lintrcPath.optional(),
		shellcheck_rc: lintrcPath.optional(),
		actionlint_config: lintrcPath.optional(),
	})
	.strict();

const fileSchema = z.object({ static: staticSchema.optional() }).passthrough();

/** factory.yml as git sees it at the target sha: its ls-tree mode and its `git show` text. */
export interface PolicyBlob {
	mode: string;
	text: string;
}

export interface FactoryStaticPolicy {
	source: "default" | "factory.yml";
	gates: GateId[];
	lintrc: Partial<Record<LintrcKey, string>>;
}

export type FactoryStaticPolicyResult =
	| { ok: true; policy: FactoryStaticPolicy }
	| { ok: false; error: string };

function refuse(field: string, message: string): FactoryStaticPolicyResult {
	return { ok: false, error: `factory.yml ${field}: ${message}` };
}

/** Target-authored key names reach a comment and a status: keep them inert. */
function safeField(parts: readonly PropertyKey[]): string {
	const joined = parts.map(String).join(".");
	return joined.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 64) || "(root)";
}

async function readFactoryStaticPolicyImpl(
	blob: PolicyBlob | null,
): Promise<FactoryStaticPolicyResult> {
	if (blob === null) {
		return { ok: true, policy: { source: "default", gates: [...STATIC_GATES], lintrc: {} } };
	}
	if (blob.mode !== REGULAR_BLOB_MODE) return refuse("(file)", "is not a regular file");
	if (Buffer.byteLength(blob.text) > POLICY_MAX_BYTES) {
		return refuse("(file)", `exceeds ${POLICY_MAX_BYTES} bytes`);
	}
	let raw: unknown;
	try {
		raw = parseYaml(blob.text);
	} catch {
		return refuse("(file)", "is not valid YAML");
	}
	const parsed = fileSchema.safeParse(raw ?? {});
	if (!parsed.success) {
		const issue = parsed.error.issues[0];
		const keys = issue && "keys" in issue ? (issue.keys as string[]) : [];
		const field = safeField([...(issue?.path ?? []), ...keys]);
		// Only our own refine messages are fixed text; zod's others echo input.
		const message = issue?.code === "custom" ? issue.message : `invalid (${issue?.code ?? "?"})`;
		return refuse(field, message);
	}
	const section = parsed.data.static ?? {};
	const lintrc: Partial<Record<LintrcKey, string>> = {};
	for (const key of LINTRC_KEYS) {
		const value = section[key];
		if (value !== undefined) lintrc[key] = value;
	}
	return {
		ok: true,
		policy: {
			source: "factory.yml",
			gates: STATIC_GATES.filter((g) => (section.gates ?? STATIC_GATES).includes(g)),
			lintrc,
		},
	};
}

/** Validate factory.yml's `static:` policy from its git mode and text (null = absent = default). */
export const readFactoryStaticPolicy = traced(
	"config.readFactoryStaticPolicy",
	readFactoryStaticPolicyImpl,
);
