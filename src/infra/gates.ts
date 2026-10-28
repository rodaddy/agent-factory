/**
 * @module infra/gates
 * @description The PURE, fixed static-gate selector for the rtech-infra
 *   static-validation pilot. Given the bounded list of changed file paths
 *   in a candidate, it decides which of the FOUR fixed static gates apply —
 *   Ansible, GitHub workflows, shell/other scripts, and configuration — using a
 *   FIXED, author-controlled path-to-gate map and FIXED escalation rules. It
 *   performs no I/O, reads no repository content, and takes no command from any
 *   input: the gate set is derived only from where a changed path lives.
 *
 *   Fail-closed by design. Any signal the watcher cannot map to a precise,
 *   minimal gate set collapses to a FULL escalation (all four gates), because a
 *   partial gate set on an indeterminate change could silently skip the very
 *   check that would have caught a regression. Full escalation is triggered by:
 *   an indeterminate/truncated read, an empty change list, a change count over
 *   the cap, an unmapped path, or ANY cross-cutting / gate-defining path (a
 *   `.github/` change, the watcher's own gate config, or a dependency/lock/root
 *   manifest). The result is always a bounded gate set plus a fixed, log-safe
 *   reason; it never grants any capability — the gates are static-check labels
 *   only, and no gate here names a command, host, credential, or endpoint.
 *
 * @outputs
 *   - `STATIC_GATES` -- the four fixed static gate ids
 *   - `MAX_CHANGED_PATHS` -- the fail-closed change-count cap
 *   - `GateId` / `GateSelection` -- the bounded selector types
 *   - `selectGates` -- pure changed-paths -> gate selection with escalation
 *
 * @dependencies
 *   - (none) -- pure decision over bounded path strings
 */

import { traced } from "../log";

/**
 * The FOUR fixed static gates. Each is a LABEL for a fixed, reviewed static
 * check lane (the concrete commands live in `./body`, never here): `ansible`
 * (ansible-lint + yamllint), `workflows` (actionlint), `scripts` (shellcheck),
 * and `config` (yamllint + a fixed structural check). Adding a fifth gate is
 * editing this reviewed literal — never dynamic discovery from a path.
 */
export const STATIC_GATES = ["ansible", "workflows", "scripts", "config"] as const;

/** A fixed static gate id. Nothing outside `STATIC_GATES` is a gate. */
export type GateId = (typeof STATIC_GATES)[number];

/**
 * Hard cap on the number of changed paths the selector will reason about. A
 * change set larger than this is treated as too broad to map precisely, so it
 * fails closed to a full escalation rather than mapping a huge diff path by
 * path. This is defence-in-depth on top of the reader's own count cap.
 */
export const MAX_CHANGED_PATHS = 500;

/** The bounded, log-safe result of a gate selection. */
export interface GateSelection {
	/** The applicable fixed gates, a subset of `STATIC_GATES`. */
	gates: GateId[];
	/** True when every gate applies because selection failed closed. */
	fullEscalation: boolean;
	/** A fixed, bounded, secret-free reason for the decision. */
	reason: string;
	/**
	 * The immutable PR base commit the compare was bound to, strict-hex, present
	 * ONLY when it was actually read. `selectGates` never sets it — it does not
	 * know the base; `select.ts` attaches it after `selectGates` returns. The body
	 * renders a base-relative verdict from it: every fixed command runs once
	 * against the candidate and once against this base, and a failure the base
	 * already carries is reported `skip`, not `fail`.
	 */
	baseSha?: string;
}

/**
 * FIXED, author-controlled escalation triggers. A changed path matching ANY of
 * these is cross-cutting or gate-defining: it can change how EVERY other file is
 * validated (a workflow, the watcher's own gate config, or a
 * dependency/lock/root manifest), so it forces a full escalation rather than a
 * narrow gate set. Matched on the normalized path, never on file contents.
 */

/** Any `.github/` change (workflows, actions, config) is cross-cutting. */
function isGithubPath(path: string): boolean {
	return path === ".github" || path.startsWith(".github/");
}

/**
 * The watcher's own gate configuration. A change to the managed-repository /
 * gate config redefines the gating itself, so it must escalate — a narrow gate
 * set computed from a diff that ALSO edits the gate config cannot be trusted.
 */
const GATE_CONFIG_PATHS = new Set(["config/repos.yml", "config/repos.example.yml"]);

/**
 * Fixed dependency / lock / root-manifest basenames. A change to any of these
 * can alter the resolved toolchain or dependency graph the static checks run
 * against, so it is cross-cutting and escalates. Matched on the path's basename
 * only, so a nested `foo/requirements.yml` escalates exactly like a root one.
 */
const MANIFEST_BASENAMES = new Set([
	"requirements.yml",
	"galaxy.yml",
	"makefile",
	"dockerfile",
	"package.json",
	"package-lock.json",
	"bun.lock",
	"bun.lockb",
	"yarn.lock",
	"pnpm-lock.yaml",
	"go.mod",
	"go.sum",
	"pyproject.toml",
	"poetry.lock",
]);

/** The lowercased final path segment, for basename-based manifest matching. */
function basename(path: string): string {
	const segments = path.split("/");
	return (segments[segments.length - 1] ?? "").toLowerCase();
}

/** True when a path is a fixed cross-cutting / gate-defining escalation trigger. */
function isEscalationPath(path: string): boolean {
	return (
		isGithubPath(path) || GATE_CONFIG_PATHS.has(path) || MANIFEST_BASENAMES.has(basename(path))
	);
}

/**
 * The FIXED path-to-gate map. Returns the single static gate a NON-escalating
 * path maps to, or `null` when the path maps to no known gate (which itself
 * fails closed to a full escalation — an unmapped path is one the reviewed map
 * does not know how to check narrowly). Order matters: the more specific
 * workflow rule is handled by escalation above; here we map the remaining
 * lanes.
 *
 *   - Ansible: playbooks/roles/inventories and Ansible YAML lanes.
 *   - Scripts: shell and other executable script files.
 *   - Config: configuration data files (YAML/JSON/TOML/INI).
 */
function gateForPath(path: string): GateId | null {
	const lower = path.toLowerCase();
	const base = basename(path);

	// Ansible lane: conventional Ansible directories and entrypoints.
	if (
		lower.startsWith("ansible/") ||
		lower.startsWith("playbooks/") ||
		lower.startsWith("roles/") ||
		lower.startsWith("inventory/") ||
		lower.startsWith("inventories/") ||
		lower.startsWith("group_vars/") ||
		lower.startsWith("host_vars/") ||
		base === "site.yml" ||
		base === "playbook.yml" ||
		base === "ansible.cfg"
	) {
		return "ansible";
	}

	// Scripts lane: shell / other script files by extension or scripts dir.
	if (
		lower.startsWith("scripts/") ||
		lower.startsWith("bin/") ||
		lower.endsWith(".sh") ||
		lower.endsWith(".bash")
	) {
		return "scripts";
	}

	// Config lane: configuration data files. Kept last so an Ansible/scripts
	// path that also ends in `.yml`/`.yaml` maps to its more specific lane first.
	if (
		lower.endsWith(".yml") ||
		lower.endsWith(".yaml") ||
		lower.endsWith(".json") ||
		lower.endsWith(".toml") ||
		lower.endsWith(".ini") ||
		lower.endsWith(".cfg") ||
		lower.startsWith("config/")
	) {
		return "config";
	}

	return null;
}

/** A full escalation over all four gates, carrying a fixed reason. */
function fullEscalation(reason: string): GateSelection {
	return { gates: [...STATIC_GATES], fullEscalation: true, reason };
}

/**
 * Select the applicable fixed static gates for a set of changed paths.
 *
 * Pure and fail-closed: with `indeterminate` true (the reader could not enumerate
 * the change set fully — truncated, paginated beyond the cap, missing base, or an
 * API error) selection escalates to ALL gates without inspecting paths. Otherwise
 * every path is checked against the fixed escalation triggers first (a single
 * cross-cutting or gate-defining path escalates the whole set), then mapped
 * through the fixed path-to-gate map; an empty list, a count over the cap, or any
 * unmapped path also escalates. Only a fully-mapped, in-bound, non-escalating
 * change set yields a narrow gate subset — always a subset of `STATIC_GATES`.
 *
 * @param changedPaths - the bounded candidate change paths (contents never read)
 * @param indeterminate - the reader's explicit "could not determine" signal
 */
export const selectGates = traced(
	"infra.selectGates",
	function selectGates(changedPaths: readonly string[], indeterminate = false): GateSelection {
		if (indeterminate) {
			return fullEscalation("indeterminate change set: escalated to full static gates");
		}
		if (changedPaths.length === 0) {
			return fullEscalation("empty change set: escalated to full static gates");
		}
		if (changedPaths.length > MAX_CHANGED_PATHS) {
			return fullEscalation("change set exceeds path cap: escalated to full static gates");
		}

		const selected = new Set<GateId>();
		for (const raw of changedPaths) {
			// A non-string, empty, or traversal-y path is not something the fixed map
			// can narrow safely — fail closed rather than guess.
			if (typeof raw !== "string" || raw.length === 0) {
				return fullEscalation("unmapped change path: escalated to full static gates");
			}
			const path = raw.replace(/^\.\//, "");
			if (isEscalationPath(path)) {
				return fullEscalation(
					"cross-cutting or gate-defining change: escalated to full static gates",
				);
			}
			const gate = gateForPath(path);
			if (gate === null) {
				return fullEscalation("unmapped change path: escalated to full static gates");
			}
			selected.add(gate);
		}

		// Preserve the fixed gate order for a stable, log-safe result.
		const gates = STATIC_GATES.filter((g) => selected.has(g));
		return {
			gates,
			fullEscalation: false,
			reason: `narrow static gates selected: ${gates.join(", ")}`,
		};
	},
);
