import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { parseAllDocuments, parse as parseYaml } from "yaml";
import { z } from "zod";
import { errorMessage, log } from "../log";

const HOLD_TOKEN = "rails-violation";
const NOT_ENCODED_TOKEN = "not-encoded";

const manifestSchema = z.object({
	constraints: z
		.array(
			z.object({ id: z.string().trim().min(1).max(100), check: z.string().max(1_000).optional() }),
		)
		.min(1)
		.max(100),
	not_encoded: z
		.array(z.object({ gotcha: z.string().trim().min(1).max(500), why_not: z.string().max(2_000) }))
		.max(100)
		.default([]),
});

type YamlRecord = Record<string, unknown>;
type RailCheck = (documents: readonly YamlRecord[]) => boolean;

export interface RailsEvaluationInput {
	/** The rtech-infra-owned factory rails manifest to consume for this check. */
	manifestPath?: string;
	/** SHA-256 expected for a copied manifest. Omit only when reading the owning file itself. */
	expectedSha?: string;
	/** Rendered YAML checked before the proposal branch is pushed. */
	artifact?: string;
}

export interface RailsEvaluation {
	examined: string[];
	violated: string[];
	hold: boolean;
	report: string;
	stale: boolean;
	notEncoded: string[];
}

interface LoadedManifest {
	constraintIds: string[];
	notEncoded: string[];
	stale: boolean;
}

interface ArtifactParseResult {
	documents: YamlRecord[];
	failure?: "artifact-absent" | "artifact-invalid";
}

/**
 * Evaluate every manifest constraint and return the bounded pre-PR HOLD report.
 *
 * There is deliberately NO compiled-in manifest path. The first live
 * verb candidate to reach rails-eval (job 5107, 2026-08-17) HELD with
 * `rails.manifest_absent` on an ENOENT for a Mac-local literal, while the SAME
 * box's verb dispatch read `config.railsManifestPath` and rendered the manifest
 * fine minutes earlier — sf#295's killed class still alive on the rails side.
 * An absent path is now the same honest `manifest-absent` hold the ENOENT arm
 * produces, plus one loud line naming the config key that is missing.
 */
export async function evaluateRails(input: RailsEvaluationInput): Promise<RailsEvaluation> {
	const manifestPath = input.manifestPath;
	if (manifestPath === undefined) {
		log("warn", "rails.manifest_absent", { cause: "railsManifestPath is not configured" });
		return failureOutcome("manifest-absent", false);
	}
	const manifest = await loadManifest(manifestPath, input.expectedSha);
	if (typeof manifest === "string") {
		return failureOutcome(manifest, manifest === "manifest-stale");
	}

	const artifact = parseArtifact(input.artifact);
	if (artifact.failure) {
		return failureOutcome(artifact.failure, false, manifest.notEncoded);
	}

	const violated = manifest.constraintIds.filter((id) => {
		const check = RAIL_CHECKS[id];
		return check === undefined || check(artifact.documents);
	});
	const gaps = renderGaps(manifest.notEncoded);
	const report = violated.length > 0 ? `${HOLD_TOKEN}: ${violated.join(",")}; ${gaps}` : gaps;
	return {
		examined: manifest.constraintIds,
		violated,
		hold: violated.length > 0,
		report,
		stale: false,
		notEncoded: manifest.notEncoded,
	};
}

async function loadManifest(
	manifestPath: string,
	expectedSha: string | undefined,
): Promise<LoadedManifest | "manifest-absent" | "manifest-invalid" | "manifest-stale"> {
	let contents: string;
	try {
		contents = await readFile(manifestPath, "utf8");
	} catch (err) {
		log("warn", "rails.manifest_absent", { cause: errorMessage(err) });
		return "manifest-absent";
	}

	const actualSha = createHash("sha256").update(contents).digest("hex");
	if (expectedSha !== undefined && actualSha !== expectedSha) {
		return "manifest-stale";
	}

	try {
		const manifest = manifestSchema.safeParse(parseYaml(contents));
		if (!manifest.success) {
			log("warn", "rails.manifest_invalid", { issues: manifest.error.issues.length });
			return "manifest-invalid";
		}
		return {
			constraintIds: manifest.data.constraints.map(({ id }) => id),
			notEncoded: manifest.data.not_encoded.map(({ gotcha }) => gotcha),
			stale: false,
		};
	} catch (err) {
		log("warn", "rails.manifest_invalid", { cause: errorMessage(err) });
		return "manifest-invalid";
	}
}

function parseArtifact(artifact: string | undefined): ArtifactParseResult {
	if (artifact === undefined) {
		return { documents: [], failure: "artifact-absent" };
	}
	const documents = parseAllDocuments(artifact);
	const errorCount = documents.reduce((count, document) => count + document.errors.length, 0);
	if (errorCount > 0) {
		log("warn", "rails.artifact_invalid", { issues: errorCount });
		return { documents: [], failure: "artifact-invalid" };
	}
	return { documents: documents.map((document) => document.toJSON()).filter(isRecord) };
}

function failureOutcome(
	failure:
		| "manifest-absent"
		| "manifest-invalid"
		| "manifest-stale"
		| "artifact-absent"
		| "artifact-invalid",
	stale: boolean,
	notEncoded: string[] = [],
): RailsEvaluation {
	return {
		examined: [],
		violated: [failure],
		hold: true,
		report: `${HOLD_TOKEN}: ${failure}; manifest rails unavailable; ${renderGaps(notEncoded)}`,
		stale,
		notEncoded,
	};
}

function renderGaps(notEncoded: readonly string[]): string {
	return `${NOT_ENCODED_TOKEN}: ${notEncoded.length === 0 ? "none" : notEncoded.join(" | ")}`;
}

function isRecord(value: unknown): value is YamlRecord {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function recordAt(record: YamlRecord, key: string): YamlRecord {
	const value = record[key];
	return isRecord(value) ? value : {};
}

function recordsAt(record: YamlRecord, key: string): YamlRecord[] {
	const value = record[key];
	return Array.isArray(value) ? value.filter(isRecord) : [];
}

function textAt(record: YamlRecord, key: string): string {
	const value = record[key];
	return typeof value === "string" ? value : "";
}

function numberAt(record: YamlRecord, key: string): number | null {
	const value = record[key];
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function kindOf(document: YamlRecord): string {
	return textAt(document, "kind").toLowerCase();
}

function metadataOf(document: YamlRecord): YamlRecord {
	return recordAt(document, "metadata");
}

function podSpecs(documents: readonly YamlRecord[]): YamlRecord[] {
	return documents.flatMap((document) => {
		const kind = kindOf(document);
		if (kind === "pod") return [recordAt(document, "spec")];
		if (kind === "cronjob") {
			return [
				recordAt(recordAt(recordAt(recordAt(document, "spec"), "jobTemplate"), "spec"), "template"),
			].map((template) => recordAt(template, "spec"));
		}
		const template = recordAt(recordAt(document, "spec"), "template");
		return Object.keys(template).length > 0 ? [recordAt(template, "spec")] : [];
	});
}

function containersOf(spec: YamlRecord): YamlRecord[] {
	return [...recordsAt(spec, "containers"), ...recordsAt(spec, "initContainers")];
}

function hasReplicaException(document: YamlRecord): boolean {
	const annotations = recordAt(metadataOf(document), "annotations");
	return Object.entries(annotations).some(([key, value]) => {
		const normalized = key.toLowerCase();
		return (
			normalized.includes("replica") &&
			(normalized.includes("exception") || normalized.includes("reason")) &&
			typeof value === "string" &&
			value.trim().length > 0
		);
	});
}

function violatesReplicasDefault(documents: readonly YamlRecord[]): boolean {
	return documents
		.filter((document) => kindOf(document) === "deployment")
		.some(
			(document) =>
				(numberAt(recordAt(document, "spec"), "replicas") ?? 1) < 2 &&
				!hasReplicaException(document),
		);
}

function violatesReplicaSpread(documents: readonly YamlRecord[]): boolean {
	return documents
		.filter((document) => kindOf(document) === "deployment")
		.filter((document) => (numberAt(recordAt(document, "spec"), "replicas") ?? 1) >= 2)
		.some((document) => {
			const podSpec = recordAt(recordAt(recordAt(document, "spec"), "template"), "spec");
			const spreads = recordsAt(podSpec, "topologySpreadConstraints");
			return (
				spreads.length === 0 ||
				spreads.some((spread) => textAt(spread, "whenUnsatisfiable") !== "ScheduleAnyway")
			);
		});
}

function violatesCnpgBackup(documents: readonly YamlRecord[]): boolean {
	const backupNames = documents
		.filter((document) => kindOf(document) === "cronjob")
		.map((document) => textAt(metadataOf(document), "name").toLowerCase());
	return documents
		.filter((document) => kindOf(document) === "cluster")
		.some((cluster) => {
			const name = textAt(metadataOf(cluster), "name").toLowerCase();
			return (
				name === "" ||
				!backupNames.some((backup) => backup.includes(name) && backup.includes("backup"))
			);
		});
}

function violatesEphemeralStorage(documents: readonly YamlRecord[]): boolean {
	return podSpecs(documents).some((spec) => {
		const unbounded = recordsAt(spec, "volumes").some((volume) => {
			const emptyDir = volume.emptyDir;
			return isRecord(emptyDir) && textAt(emptyDir, "sizeLimit") === "";
		});
		const mountsTmp = containersOf(spec).some((container) =>
			recordsAt(container, "volumeMounts").some((mount) =>
				/^\/tmp(?:\/|$)/.test(textAt(mount, "mountPath")),
			),
		);
		return unbounded || mountsTmp;
	});
}

function violatesStorageClass(documents: readonly YamlRecord[]): boolean {
	return documents
		.filter((document) => kindOf(document) === "persistentvolumeclaim")
		.some((document) => textAt(recordAt(document, "spec"), "storageClassName") === "");
}

function violatesPvcPruneGuard(documents: readonly YamlRecord[]): boolean {
	return documents
		.filter((document) => kindOf(document) === "persistentvolumeclaim")
		.some((document) => {
			const value = textAt(
				recordAt(metadataOf(document), "annotations"),
				"argocd.argoproj.io/sync-options",
			);
			return !value.split(",").some((option) => option.trim().toLowerCase() === "prune=false");
		});
}

function scalarStrings(value: unknown): string[] {
	if (typeof value === "string" || typeof value === "number") return [String(value)];
	if (Array.isArray(value)) return value.flatMap(scalarStrings);
	if (!isRecord(value)) return [];
	return Object.values(value).flatMap(scalarStrings);
}

function violatesPortBands(documents: readonly YamlRecord[]): boolean {
	const exposedKinds = new Set(["service", "ingress", "httproute", "route"]);
	return documents
		.filter((document) => exposedKinds.has(kindOf(document)))
		.some((document) =>
			scalarStrings(document).some(
				(value) => value === "3000" || /^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value),
			),
		);
}

function violatesNewLxc(documents: readonly YamlRecord[]): boolean {
	return documents.some(
		(document) => kindOf(document) === "lxc" || textAt(document, "type").toLowerCase() === "lxc",
	);
}

function violatesRunnerLabel(documents: readonly YamlRecord[]): boolean {
	return documents.some((document) =>
		Object.values(recordAt(document, "jobs"))
			.filter(isRecord)
			.some((job) => {
				const runsOn = job["runs-on"];
				if (typeof runsOn === "string") return runsOn === "ubuntu-latest";
				return Array.isArray(runsOn) && !runsOn.includes("self-hosted");
			}),
	);
}

function violatesProbeShape(documents: readonly YamlRecord[]): boolean {
	return podSpecs(documents).some((spec) =>
		containersOf(spec).some((container) => {
			const liveness = recordAt(container, "livenessProbe");
			const dependencyProbe = /ready|readiness|database|postgres|mysql/i.test(
				JSON.stringify(liveness),
			);
			const startup = recordAt(container, "startupProbe");
			const unstatedBudget =
				Object.keys(startup).length > 0 &&
				(numberAt(startup, "failureThreshold") === null ||
					numberAt(startup, "periodSeconds") === null);
			return dependencyProbe || unstatedBudget;
		}),
	);
}

function violatesBindAll(documents: readonly YamlRecord[]): boolean {
	return podSpecs(documents).some((spec) =>
		containersOf(spec).some((container) =>
			scalarStrings(container).some((value) => /(?:127\.0\.0\.1|localhost)/i.test(value)),
		),
	);
}

const RAIL_CHECKS: Readonly<Record<string, RailCheck>> = {
	"replicas-default": violatesReplicasDefault,
	"replicas-spread": violatesReplicaSpread,
	"cnpg-implies-backup": violatesCnpgBackup,
	"no-unbounded-ephemeral": violatesEphemeralStorage,
	"storageclass-explicit": violatesStorageClass,
	"pvc-prune-guard": violatesPvcPruneGuard,
	"port-bands": violatesPortBands,
	"no-new-lxc": violatesNewLxc,
	"runner-label": violatesRunnerLabel,
	"probe-shape": violatesProbeShape,
	"bind-all-interfaces": violatesBindAll,
};
