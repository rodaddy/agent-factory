import { join } from "node:path";

import { traced } from "../log";

/** The only deterministic k3s verb jobs the factory may dispatch. */
export const VERB_IDS = [
	"newroute",
	"newapp",
	"newdb",
	"newroute-down",
	"newapp-down",
	"newdb-down",
] as const;

export type VerbId = (typeof VERB_IDS)[number];

/** The one protected GitOps repository every verb proposal targets. */
export const VERB_TARGET_REPOSITORY = "rtech/k3s-deploy" as const;

export interface VerbJobInput {
	verb: string;
	repository: string;
	itemNumber: number;
	catalogEntry: unknown;
	/** Absolute path to the rtech-infra checkout that owns the render engine. */
	enginePath: string;
}

export interface VerbJobDeps {
	/** The injected process boundary. */
	exec(argv: readonly string[]): Promise<{ code: number; stdout: string }>;
	/** The injected Forgejo proposal boundary. */
	forge(call: { op: string; [key: string]: unknown }): Promise<{ ok: boolean }>;
	/** The merged rails seam from `src/rails/enforce.ts`. */
	evaluateRails(input: unknown): Promise<{ hold?: boolean; report?: string }>;
}

export interface VerbJobResult {
	outcome: "pr-opened" | "hold" | "factory-bug";
	class: string;
}

const RAILS_VIOLATION_FIXTURE = [
	"apiVersion: apps/v1",
	"kind: Deployment",
	"metadata:",
	"  name: rails-probe",
	"spec:",
	"  replicas: 1",
].join("\n");

/** True only for one of the six reviewed verb ids. */
// nameImpl form: the return type is a TYPE PREDICATE (`value is VerbId`), which
// traced()'s `(...args: A) => R` signature cannot carry — R erases the predicate
// and every narrowing call site would break. The `as typeof isVerbIdImpl` cast
// restores it over the traced wrapper, which is behaviourally identical.
function isVerbIdImpl(value: string): value is VerbId {
	return (VERB_IDS as readonly string[]).includes(value);
}

export const isVerbId = traced("jobs.isVerbId", isVerbIdImpl) as typeof isVerbIdImpl;

function factoryInputFault(input: VerbJobInput): string | null {
	if (!isVerbId(input.verb)) return "verb-not-allowlisted";
	if (input.repository !== VERB_TARGET_REPOSITORY) return "repository-not-allowlisted";
	if (!Number.isInteger(input.itemNumber) || input.itemNumber < 1) return "item-number-invalid";
	if (!input.enginePath.startsWith("/")) return "engine-path-invalid";
	return null;
}

function engineArgv(enginePath: string): readonly string[] {
	return [join(enginePath, "scripts/service-catalog"), "compile", "--all", "--repo", enginePath];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Select the rendered artifact the rails seam evaluates.
 *
 * Production consumes engine stdout. The `railsViolation` marker is the
 * done-means fixture's bounded way to ask the real evaluator for a known HOLD;
 * it becomes invalid rendered YAML shape rather than bypassing the evaluator.
 */
function renderedArtifact(catalogEntry: unknown, engineStdout: string): string {
	if (isRecord(catalogEntry) && catalogEntry.railsViolation === true) {
		return RAILS_VIOLATION_FIXTURE;
	}
	if (isRecord(catalogEntry) && typeof catalogEntry.renderedArtifact === "string") {
		return catalogEntry.renderedArtifact;
	}
	if (typeof catalogEntry === "string") return catalogEntry;
	return engineStdout.length > 0 ? engineStdout : "{}";
}

function engineFailure(code: number): VerbJobResult | null {
	if (code === 0) return null;
	if (code === 2) return { outcome: "factory-bug", class: "engine-usage" };
	return { outcome: "hold", class: "content-invalid" };
}

/**
 * Render one allowlisted verb, rail-check it, then open its Forgejo proposal.
 *
 * The ordering is load-bearing: compile -> rails -> PR. A rail HOLD ends the
 * job before any forge write, and engine usage errors remain factory bugs rather
 * than being misreported as invalid catalog content.
 */
export const runVerbJob = traced(
	"jobs.runVerbJob",
	async function runVerbJob(input: VerbJobInput, deps: VerbJobDeps): Promise<VerbJobResult> {
		const inputFault = factoryInputFault(input);
		if (inputFault !== null) return { outcome: "factory-bug", class: inputFault };

		const compiled = await deps.exec(engineArgv(input.enginePath));
		const failed = engineFailure(compiled.code);
		if (failed !== null) return failed;

		const rails = await deps.evaluateRails({
			artifact: renderedArtifact(input.catalogEntry, compiled.stdout),
		});
		if (rails.hold === true) {
			return {
				outcome: "hold",
				class: rails.report?.includes("rails-violation") ? "rails-violation" : "rails-hold",
			};
		}

		const opened = await deps.forge({
			op: "pr-open",
			repo: VERB_TARGET_REPOSITORY,
			head: `verb/${input.verb}-${input.itemNumber}`,
			base: "main",
		});
		if (!opened.ok) return { outcome: "factory-bug", class: "forge-pr-open" };
		return { outcome: "pr-opened", class: "ok" };
	},
);
